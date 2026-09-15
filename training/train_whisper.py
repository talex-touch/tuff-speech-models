"""Fine-tune openai/whisper-tiny on a small Mandarin corpus with a manual loop.

Deliberately avoids Seq2SeqTrainer: the transformers 5.x Trainer surface is in flux and
a manual loop has no hidden API contract to break. Small enough to read end to end.
"""
import argparse
import json
import os
import random
import time

import soundfile as sf
import torch
from torch.utils.data import DataLoader, Dataset
from transformers import WhisperForConditionalGeneration, WhisperProcessor

SAMPLE_RATE = 16000
MAX_SECONDS = 20.0


def load_manifest(corpus_dir: str, limit: int | None):
    """Collect (wav, transcript) pairs.

    Two layouts occur in practice and both are supported, because guessing wrong is silent:
    ST-CMDS writes one <stem>.txt beside each <stem>.wav, while other corpora ship a single
    manifest with 'name<TAB>text' lines. A lone .txt whose stem has no sibling .wav is treated
    as a manifest; otherwise every wav is paired with its own text file.
    """
    entries = sorted(os.listdir(corpus_dir))
    wav_stems = {n[:-4] for n in entries if n.endswith(".wav")}
    orphan_txt = [n for n in entries if n.endswith(".txt") and n[:-4] not in wav_stems]

    pairs = []
    if orphan_txt:
        with open(os.path.join(corpus_dir, orphan_txt[0]), encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                parts = line.split("\t")
                if len(parts) < 2:
                    continue
                key, text = parts[0].strip(), parts[1].strip()
                if not text:
                    continue
                wav = key if key.endswith(".wav") else key + ".wav"
                path = os.path.join(corpus_dir, wav)
                if os.path.exists(path):
                    pairs.append((path, text))
    else:
        for name in sorted(wav_stems):
            text_path = os.path.join(corpus_dir, name + ".txt")
            if not os.path.exists(text_path):
                continue
            with open(text_path, encoding="utf-8") as handle:
                text = handle.read().strip()
            if text:
                pairs.append((os.path.join(corpus_dir, name + ".wav"), text))

    if not pairs:
        raise SystemExit(f"no (wav, transcript) pairs found in {corpus_dir}")

    # A double-decoded transcript is still valid UTF-8 but contains no CJK at all, and
    # training on it is silent garbage: the loss curve looks plausible and the model learns
    # nothing. Catch it here rather than after an hour of MPS.
    sample = "".join(text for _, text in pairs[:50])
    if sum(1 for char in sample if "\u4e00" <= char <= "\u9fff") == 0:
        raise SystemExit(
            "FATAL: the transcript contains no CJK characters. Check the file encoding; "
            "a Latin-1 reinterpretation of UTF-8 looks valid but trains on noise."
        )

    if limit:
        random.Random(0).shuffle(pairs)
        pairs = pairs[:limit]
    return pairs


class SpeechDataset(Dataset):
    def __init__(self, pairs, processor):
        self.pairs = pairs
        self.processor = processor

    def __len__(self):
        return len(self.pairs)

    def __getitem__(self, index):
        path, text = self.pairs[index]
        audio, sr = sf.read(path, dtype="float32")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        if sr != SAMPLE_RATE:
            import librosa
            audio = librosa.resample(audio, orig_sr=sr, target_sr=SAMPLE_RATE)
        audio = audio[: int(MAX_SECONDS * SAMPLE_RATE)]
        features = self.processor(audio, sampling_rate=SAMPLE_RATE, return_attention_mask=False)["input_features"][0]
        labels = self.processor.tokenizer(text, add_special_tokens=True).input_ids
        return {"input_features": features, "labels": labels}


def collate(batch, pad_token_id):
    max_len = max(item["input_features"].shape[-1] for item in batch)
    n_mels = batch[0]["input_features"].shape[0]
    features = torch.zeros(len(batch), n_mels, max_len, dtype=torch.float32)
    for row, item in enumerate(batch):
        width = item["input_features"].shape[-1]
        features[row, :, :width] = torch.from_numpy(item["input_features"])
    label_len = max(len(item["labels"]) for item in batch)
    labels = torch.full((len(batch), label_len), pad_token_id, dtype=torch.long)
    for row, item in enumerate(batch):
        labels[row, : len(item["labels"])] = torch.tensor(item["labels"], dtype=torch.long)
    return {"input_features": features, "labels": labels}


def evaluate_cer(model, processor, pairs, device, language, max_items=100):
    """Greedy-decode a held-out split and report CER. Reference text, not a proxy."""
    import jiwer
    import librosa

    model.eval()
    refs, hyps = [], []
    with torch.no_grad():
        for path, reference in pairs[:max_items]:
            audio, sr = sf.read(path, dtype="float32")
            if audio.ndim > 1:
                audio = audio.mean(axis=1)
            if sr != SAMPLE_RATE:
                audio = librosa.resample(audio, orig_sr=sr, target_sr=SAMPLE_RATE)
            audio = audio[: int(MAX_SECONDS * SAMPLE_RATE)]
            features = processor(audio, sampling_rate=SAMPLE_RATE, return_tensors="pt").input_features.to(device)
            ids = model.generate(
                features,
                language=language,
                task="transcribe",
                max_new_tokens=200,
                do_sample=False,
            )
            hyps.append(processor.batch_decode(ids, skip_special_tokens=True)[0].strip())
            refs.append(reference)

    # CER is computed with punctuation stripped: whisper decides its own punctuation and the
    # corpus carries none, so counting it would measure formatting, not recognition.
    import re
    strip = lambda s: re.sub(r"[\s，。、,.!！?？;；:：\"'“”‘’]", "", s)
    pairs_clean = [(strip(r), strip(h)) for r, h in zip(refs, hyps)]
    cer = jiwer.cer([r for r, _ in pairs_clean], [h for _, h in pairs_clean]) if pairs_clean else float("nan")
    return cer, list(zip(refs, hyps))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--base-model", default="openai/whisper-tiny")
    parser.add_argument("--limit", type=int, default=2000)
    parser.add_argument("--val-limit", type=int, default=64)
    parser.add_argument("--eval-limit", type=int, default=100)
    parser.add_argument("--epochs", type=float, default=1.0)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--lr", type=float, default=1e-5)
    parser.add_argument("--language", default="zh")
    args = parser.parse_args()

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"[train] device={device} base={args.base_model}", flush=True)

    processor = WhisperProcessor.from_pretrained(args.base_model, language=args.language, task="transcribe")
    model = WhisperForConditionalGeneration.from_pretrained(args.base_model)
    model.to(device)
    model.train()
    model.config.forced_decoder_ids = None

    pairs = load_manifest(args.corpus, args.limit + args.val_limit)
    val_pairs = pairs[: args.val_limit]
    train_pairs = pairs[args.val_limit :]
    print(f"[train] utterances: {len(train_pairs)} train / {len(val_pairs)} held out", flush=True)

    # Baseline first, on the same held-out split the fine-tune is judged on. Without this
    # number a fine-tune's CER is uninterpretable: it says nothing about whether training
    # helped or hurt.
    baseline_cer, _ = evaluate_cer(model, processor, val_pairs, device, args.language, args.eval_limit)
    print(f"[eval] baseline ({args.base_model}) held-out CER = {baseline_cer:.4f}", flush=True)
    del _

    loader = DataLoader(
        SpeechDataset(train_pairs, processor),
        batch_size=args.batch_size,
        shuffle=True,
        num_workers=0,
        collate_fn=lambda batch: collate(batch, processor.tokenizer.pad_token_id),
    )

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr)
    total_steps = max(1, int(len(loader) * args.epochs))
    scheduler = torch.optim.lr_scheduler.LinearLR(
        optimizer, start_factor=1.0, end_factor=0.1, total_iters=total_steps
    )

    step = 0
    started = time.time()
    running = 0.0
    while step < total_steps:
        for batch in loader:
            if step >= total_steps:
                break
            out = model(
                input_features=batch["input_features"].to(device),
                labels=batch["labels"].to(device),
            )
            loss = out.loss
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            scheduler.step()
            optimizer.zero_grad(set_to_none=True)
            running += float(loss.detach().cpu())
            step += 1
            if step % 20 == 0 or step == total_steps:
                elapsed = time.time() - started
                print(f"[train] step {step}/{total_steps} loss={running / 20:.4f} elapsed={elapsed:.0f}s", flush=True)
                running = 0.0

    os.makedirs(args.out, exist_ok=True)
    model.save_pretrained(args.out)
    processor.save_pretrained(args.out)

    final_cer, samples = evaluate_cer(model, processor, val_pairs, device, args.language, args.eval_limit)
    print(f"[eval] fine-tuned held-out CER = {final_cer:.4f} (baseline {baseline_cer:.4f})", flush=True)
    for reference, hypothesis in samples[:8]:
        print(f"[eval]   ref={reference}\n[eval]   hyp={hypothesis}", flush=True)

    meta = {
        "base_model": args.base_model,
        "corpus_dir": os.path.basename(args.corpus.rstrip("/")),
        "train_utterances": len(train_pairs),
        "held_out_utterances": len(val_pairs),
        "eval_sample_size": min(args.eval_limit, len(val_pairs)),
        "baseline_cer": round(baseline_cer, 4),
        "fine_tuned_cer": round(final_cer, 4),
        "steps": step,
        "batch_size": args.batch_size,
        "lr": args.lr,
        "device": device,
        "wall_seconds": round(time.time() - started, 1),
    }
    with open(os.path.join(args.out, "train_meta.json"), "w", encoding="utf-8") as handle:
        json.dump(meta, handle, ensure_ascii=False, indent=2)
    with open(os.path.join(args.out, "eval_samples.json"), "w", encoding="utf-8") as handle:
        json.dump(
            [{"reference": r, "hypothesis": h} for r, h in samples],
            handle,
            ensure_ascii=False,
            indent=2,
        )
    print("[train] done " + json.dumps(meta, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
