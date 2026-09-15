# Training a Chinese ASR model Talex-Touch owns

> **Status: executed.** The Phase 1 pipeline below has been run and its result is
> published as `tuff-asr-zh-tiny@0.1.0`
> ([notes](./versions/tuff-asr-zh-tiny-0.1.0.md)). The runnable scripts and their
> raw outputs live in [`training/`](../training): the commands written here were
> the reviewable plan and remain the shape of the pipeline, but where they differ
> from `training/`, the script is what actually ran — §4 records the three
> differences and why each one existed.
>
> The hardware and time figures in [§8](#8-hardware-and-time-estimates) are still
> engineering estimates except where a measured run is cited; measured numbers
> live in `models/*/*/model.json`, `docs/versions/`, and `training/*.json`.

The goal is a Mandarin dictation model whose weights Talex-Touch owns outright,
so that the delivered product no longer depends on a third party's license,
release cadence or script policy. `tuff-asr-zh@0.1.0` is the placeholder that
ships today: whisper-base's weights in a Tuff-owned contract
([notes](./versions/tuff-asr-zh-0.1.0.md)).

## 0. What "owned" has to mean

A bundle in this repository carries a license declared in its descriptor, and
`tools/verify-catalog.mjs` refuses to publish anything whose
`license.redistributable` is not `true`. For a model we train ourselves that
means two independent questions must both be answered `yes`:

1. **May we ship the weights?** Settled by us: our own trained weights are ours
   to license (this repository uses MIT).
2. **May we ship a model trained on these corpora?** Settled by the corpora's
   terms, not by us. This is where most of the legal risk actually lives, and
   it is why the corpus list below is short and conservative.

## 1. Corpora and their real terms

Verified against the publishers' own pages on 2026-09-15 (links inline). Terms
change; re-read them before any run, and record what you read in the dataset
manifest described in [§9](#9-dataset-manifest).

| Corpus | Terms as published | Verdict for a commercial Tuff model |
| --- | --- | --- |
| **AISHELL-1** (SLR33, [openslr.org/33](https://www.openslr.org/33/)) | License field: **Apache License v.2.0**. 400 speakers, quiet indoor, 16 kHz, manual transcription >95%. Downloads: `data_aishell.tgz` (15 GB), `resource_aishell.tgz` (1.2 MB, lexicon + speaker info). The page's prose says "free for academic use", which sits awkwardly next to the Apache-2.0 field. | **Preferred primary corpus.** Apache-2.0 is permissive. The prose/field mismatch is worth a written legal read before commercial distribution, but this is the cleanest option available. |
| **THCHS-30** (SLR18, [openslr.org/18](https://www.openslr.org/18/)) | License field: **Apache License v.2.0**. CSLT@Tsinghua, recorded 2002, "totally free to academic users". Downloads: `data_thchs30.tgz` (6.4 GB), `test-noise.tgz` (1.9 GB, 0 dB noisy test set), `resource.tgz` (24 MB). | **Safe to use**, and the noisy test set is genuinely useful for robustness evaluation. Same prose/field caveat as AISHELL-1. |
| **Mozilla Common Voice** ([datasets portal](https://commonvoice.mozilla.org/en/datasets)) | **CC0-1.0**, verified per-dataset on the portal (e.g. the zh-CN and Spontaneous Speech bundles). | **Safe and unrestricted** (CC0 waives rights). Use for read speech and for accent coverage; size is modest. |
| **WenetSpeech** ([official site](https://wenet-e2e.github.io/WenetSpeech/), [GitHub](https://github.com/wenet-e2e/WenetSpeech)) | The site says the dataset is "available to download for **non-commercial** purposes under a Creative Commons Attribution 4.0 International License", and that "WenetSpeech doesn't own the copyright of the audios, the copyright remains with the original owners". Access is password-gated behind an application form. | **Do not train the shipped model on it.** Non-commercial + third-party audio copyright means the derived weights are not ours to redistribute. Research-only, clearly separated from any published bundle. |
| **MAGICDATA** (SLR68, [openslr.org/68](https://www.openslr.org/68/)) | **CC BY-NC-ND 4.0** — NonCommercial **and NoDerivatives**. 755 h, 1080 speakers, 52 GB train set. | **Excluded.** NoDerivatives is directly at odds with training a model on it, and NonCommercial rules out the product. Do not download it for this purpose. |
| **AISHELL-2** | Application-gated at aishelltech.com; its download page was not reachable from this machine on 2026-09-15, so **its terms were not verified here**. | **Unverified.** Treat as blocked until someone reads the signed terms and records them. Do not assume the AISHELL-1 Apache-2.0 grant extends to it. |

### Explicitly out of scope: the reverse-engineered Doubao offline weights

Whatever the technical merits, Talex-Touch **cannot obtain authorization from
ByteDance** for the reverse-engineered Doubao offline speech weights. Therefore
nothing derived from them may appear here or ship with Tuff:

- no copied or extracted weights, encoder/decoder components, tokenizers or
  dictionaries from those artifacts;
- no distilled or fine-tuned outputs of those weights;
- no bundle, descriptor, or release artifact that embeds any of the above.

Published papers, public talks and open-source reimplementations of the
*architectures* are a different matter and are what [§3](#3-target-architecture)
draws on. Ideas are reusable; weights are not.

## 2. Two phases, on purpose

| | Phase 1 — own the footprint | Phase 2 — own the model |
| --- | --- | --- |
| Weights | fine-tune of whisper-base (MIT) | trained from scratch by us |
| Engine | `whisper-cpp` | `sherpa-onnx` or `onnxruntime` |
| Runtime work needed | none — Tuff's existing local whisper path loads it | **new** Tuff engine adapter (does not exist yet) |
| Ships a Tuff-owned bundle | yes, quickly | yes, later, once the adapter exists |
| Answers | "can we control quality, script and size?" | "can we stop depending on Whisper at all?" |

Phase 1 is the pragmatic one: it produces a digest-verifiable bundle that the
current runtime already knows how to execute, with no new engine adapter. Phase 2
is the real goal, and its cost is dominated by runtime work in
`packages/tuff-voice/src/local/`, not by training alone — the descriptor schema
already permits `engine: sherpa-onnx | onnxruntime` and
`runtime.kind: onnx`, but Tuff has no engine implementation for them today.
Do not publish a Phase 2 bundle as *default* while that gap exists: it would be
an install nobody can run.

## 3. Target architecture

These are the properties worth copying from the reverse-engineered design's
*observable* behaviour — streaming partials while the user is still speaking, a
low real-time factor on a laptop, and a model small enough to sit in a desktop
app. The architectural ideas come from public work (WeNet's U2/U2++ two-pass
streaming recipe, Paraformer's CIF predictor and non-autoregressive decoder,
Whisper's encoder-decoder pretraining, RNN-T/Conv-Transducer alternatives):

1. **Streaming Conformer encoder.** Causal or chunked convolutions, chunk-based
   self-attention with limited left context (the `num_decoding_left_chunks`
   knob), relative position encoding, macaron FFN. This is what makes partial
   hypotheses cheap enough to show live.
2. **CIF alignment for streaming emission.** Continuous integrate-and-fire
   converts frame-level encoder states into token-level acoustic embeddings, so
   the model emits when it is confidentrather than on a fixed cadence, and the
   decoder can be non-autoregressive (all tokens at once) or a shallow
   autoregressive decoder. This is the piece that buys low latency without a
   big decoder.
3. **Small decoder / unified two-pass.** CTC for the streaming pass, plus a
   shallow attention decoder used to rescore or refine the final hypothesis
   (the U2++ shape). Two passes, one model, no separate LM to ship.
4. **Speculative decoding / draft rescoring** as the latency lever: a tiny draft
   model proposes, the real decoder verifies. Worth adopting only after the
   base system works; it is an optimisation, not a foundation.
5. **Simplified-Chinese output by policy, not by hope.** Whisper emits
   Traditional for zh audio; a model we train should emit Simplified directly.
   Keep `text.requiresSimplifiedConversion: true` regardless, as a safety net
   for mixed input, and keep a `dict` auxiliary file if an OpenCC-style
   conversion table ships beside the weights.
6. **Auxiliary files as first-class bundle members.** A VAD (streaming
   end-pointing), an optional punctuation restorer, and a tokens file are all
   describable today as `auxiliary[]` entries with `role`, `file`, `bytes` and
   `sha256`. They are part of the bundle digest.

## 4. Phase 1 — fine-tune whisper and package it as ggml

**Executed 2026-09-15.** The plan below was followed with three deliberate
departures, each recorded because it cost time to establish:

- **Corpus: ST-CMDS (OpenSLR 38), not AISHELL-1 + THCHS-30.** One 8.2 GB download
  with no registration, and enough scope to produce a first result.
- **Base model: `openai/whisper-tiny`, not `whisper-base`.** The question this run
  had to answer was whether *our pipeline* yields a model that beats the shipped
  default. A tiny-based run answers it in 11 minutes rather than hours.
- **Conversion: `training/convert_to_ggml.py` instead of the stock converter
  call.** `transformers` 5.x writes neither `vocab.json` nor
  `added_tokens.json`, both of which whisper.cpp's converter requires; the
  wrapper re-emits them first.

Result: `tuff-asr-zh-tiny@0.1.0` — held-out CER **0.1574** against the shipped
default's **0.2018**, on identical audio with the flags Tuff uses. Caveats that
bound it are in the version notes. The commands below remain the plan they were
written as.

```bash
# --- environment ---------------------------------------------------------
python3.11 -m venv .venv && source .venv/bin/activate
pip install "torch>=2.4" "transformers>=4.44" "datasets>=2.20" \
            "evaluate>=0.4" "jiwer>=3.0" "librosa>=0.10" "soundfile>=0.12"
# Pin the toolkit revisions you actually use and record them in the run notes.

# --- data (AISHELL-1: Apache-2.0) ---------------------------------------
mkdir -p data && cd data
wget https://openslr.trmal.net/resources/33/data_aishell.tgz
tar -xzf data_aishell.tgz
cd ..   # -> data/data_aishell/wav/<speaker>/<utt>.wav + trans/aishell_transcript_v0.8.txt

# --- data (THCHS-30: Apache-2.0) ----------------------------------------
# Optional second corpus; adds a noisy test set for robustness numbers.
# wget https://openslr.trmal.net/resources/18/data_thchs30.tgz

# --- build the manifest the trainer wants (16 kHz mono, lowercase-free zh) ---
python - <<'PY'
import json, pathlib
root = pathlib.Path("data/data_aishell")
trans = {}
for line in (root / "trans/aishell_transcript_v0.8.txt").read_text().splitlines():
    utt, *chars = line.split()
    trans[utt] = "".join(chars)
rows = []
for wav in sorted((root / "wav").glob("*/*.wav")):
    utt = wav.stem
    text = trans.get(utt)
    if text:
        rows.append({"audio": str(wav), "text": text})
(pathlib.Path("data")).mkdir(exist_ok=True)
(pathlib.Path("data/train.jsonl")).write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows))
print("utterances:", len(rows))
PY

# --- fine-tune (transformers Seq2SeqTrainer example) ---------------------
# Script path and flags vary by revision: clone transformers at a pinned tag and
# confirm the path/arguments before relying on this line.
git clone --depth 1 --branch v4.44.0 https://github.com/huggingface/transformers.git
python transformers/examples/pytorch/speech-recognition/run_speech_recognition_seq2seq.py \
  --model_name_or_path openai/whisper-base \
  --language zh --task transcribe \
  --train_dataset_file data/train.jsonl --dataset_config_name null \
  --preprocessing_num_workers 8 \
  --max_steps 20000 --per_device_train_batch_size 32 --gradient_accumulation_steps 2 \
  --learning_rate 1e-5 --warmup_steps 500 --fp16 \
  --eval_strategy steps --eval_steps 1000 \
  --save_steps 1000 --save_total_limit 3 \
  --output_dir exp/tuff-asr-zh-lora

# --- merge LoRA (only if you trained adapters) and convert to ggml -------
# whisper.cpp ships the HF->ggml conversion script; the file name and argument
# order differ across revisions, so check its --help in the revision you pin.
git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git
python whisper.cpp/models/convert-h5-to-ggml.py exp/tuff-asr-zh-merged . exp/ggml

# --- smoke-test the converted weights with the engine Tuff actually uses --
say -v Tingting -o /tmp/probe.aiff "今天天气很好我们去公园散步吧"
ffmpeg -y -i /tmp/probe.aiff -ar 16000 -ac 1 -c:a pcm_s16le /tmp/probe.wav
whisper-cli -m exp/ggml/ggml-model.bin -f /tmp/probe.wav -l zh -nt
```

Acceptance for Phase 1 is not "it runs": it is that the converted bundle beats
`tuff-asr-zh@0.1.0` on a held-out set (see [§7](#7-evaluation)) on both CER and
script correctness, at an RTF no worse than the 0.33 measured for whisper-base.

## 5. Phase 2 — train the owned streaming model

Toolkit choice matters less than the recipe; WeNet (Apache-2.0) is the shortest
path to a U2/U2++ streaming Conformer, and it trains on the same kaldi-style
`wav.scp`/`text` data prepared above.

```bash
git clone https://github.com/wenet-e2e/wenet.git && cd wenet
pip install -r requirements.txt && pip install -e .

# data prep: AISHELL-1 (Apache-2.0) + THCHS-30 (+ Common Voice zh-CN)
#   -> data/{train,dev,test}/wav.scp + text, 16 kHz mono

# Train the streaming two-pass Conformer (flag names as of the revision you pin)
python wenet/bin/train.py \
  --config conf/train_u2++_conformer.yaml \
  --data_type raw \
  --train_data data/train.list --cv_data data/dev.list \
  --model_dir exp/owned-v0 --gpu 0

# Export to ONNX for onnxruntime / sherpa-onnx
#   WeNet ships an ONNX export script (name varies by revision, e.g.
#   wenet/bin/export_onnx_cpu.py); confirm with `ls wenet/bin` in your pin.
python wenet/bin/export_onnx_cpu.py \
  --config exp/owned-v0/train.yaml \
  --checkpoint exp/owned-v0/final.pt \
  --output_dir exp/owned-v0/onnx \
  --num_decoding_left_chunks -1
```

For sherpa-onnx packaging, use the export path its own documentation prescribes
for your toolkit (icefall or WeNet) and keep the `tokens.txt` it emits — that
file belongs in the bundle as an `auxiliary` entry with `role: "tokenizer"`.

Model size is a product decision, not a training artefact. Dictation on a
laptop wants roughly `base`-class capacity; a 10k-hour corpus trains a much
larger model than Tuff should ship. Train at the size you intend to ship, or
expect a distillation step afterwards.

## 6. Quantization and packaging

```bash
# 1. Dynamic int8 quantization (CPU-friendly default for ONNX),
#    after preprocessing for accuracy-sensitive graphs.
python -m onnxruntime.quantization.preprocess \
  --input exp/owned-v0/onnx/encoder.onnx --output exp/owned-v0/onnx/encoder.pre.onnx
python -m onnxruntime.quantization.quantize_dynamic \
  --input exp/owned-v0/onnx/encoder.pre.onnx \
  --output exp/owned-v0/onnx/encoder.int8.onnx \
  --op_types_to_quantize MatMul,Gemm,Conv,MatMulInteger

# 2. Sanity-check that the quantized model still transcribes the probe sentence
#    identically to the fp32 one before it goes anywhere near the catalog.
```

Two rules follow from how this repository verifies bundles:

- **Quantization changes the digest, so it changes the version.** An `int8`
  build is a new `model.json` under a new version directory and gets its own
  `docs/versions/<id>-<version>.md`; the descriptor's `quantization` field must
  name the scheme that is actually inside the file (`int8`, `q8_0`, `f16`, …).
- **Auxiliary files are part of the bundle.** VAD, tokens, and any conversion
  dictionary must be listed with their real size and SHA-256, because the
  catalog digest is computed over all of them.

## 7. Evaluation

Report, on a named host, with a named dataset and a real sample count — the same
discipline `whisper-base@1.0.0`'s descriptor follows:

- **CER** on AISHELL-1's released test set and, separately, on THCHS-30's
  `test-noise.tgz` at 0 dB. `jiwer` computes character error rate directly.
- **Script correctness**: fraction of hypotheses containing no Traditional-only
  characters — the defect whisper-base exhibits, and the one an owned model is
  supposed to fix.
- **RTF** on the target laptop, warm model, with the sample count stated.

Only measured numbers may enter a descriptor's `benchmark` object; if a metric
was not measured, omit the field and say so in the version doc, exactly as
`tuff-asr-zh@0.1.0` does.

## 8. Hardware and time estimates

**All figures below are estimates. No run has been performed.** They exist to
size a decision, not to promise a result.

| Stage | Estimate |
| --- | --- |
| Data prep (AISHELL-1 15 GB + THCHS-30 6.4 GB, manifests, filters) | hours on one machine; mostly I/O and 16 kHz re-encoding |
| Phase 1 fine-tune, AISHELL-1 (~178 h, widely cited figure) | ~8–16 h on one A100 40 GB at batch 32; days on a single Apple-silicon GPU via MPS — not recommended for the full run |
| Phase 2 train, AISHELL-1 + Common Voice zh + THCHS-30 (≈300 h) | ~1–2 days on 4×A100; a laptop-class run is infeasible |
| Phase 2 train on a 1000 h subset (e.g. a corpus of that scale) | ~1–2 weeks on 8×A100 80 GB |
| Quantization + export + smoke test | minutes to an hour on CPU |
| Runtime work for Phase 2 (Tuff engine adapter for ONNX) | days-to-weeks of engineering, and it is the actual blocker |
| Human review (data licensing, script policy, release) | the schedule risk, not the GPU time |

Target to beat: whisper-base measured RTF **0.33** on the Apple M4 Pro with
`whisper-cli`. A dictation-grade streaming model should aim for roughly half
that with live partials, on the same host — again a design target, not a
measurement.

## 9. Dataset manifest

Before publishing any trained bundle, commit (outside this repository if the
corpus terms forbid redistribution) a manifest recording, per corpus: the exact
download URL, the license you read and its date, the terms you concluded, the
hours used, and the filters applied. The descriptor's `license.spdx` and
`license.redistributable` must follow from that manifest — not from optimism. If
a corpus's terms are unclear (AISHELL-2 today), the correct state is "not used",
and the bundle cannot be published until that changes.

## 10. Publishing the result

Once a real weight file exists, packaging into a publishable version is exactly
the routine in the [README](../README.md#add-a-version). The commands that
produce a bundle this repository will accept:

```bash
# 1. Hash the real artefact — never guess these numbers.
stat -f %z exp/owned-v0/encoder.int8.onnx     # bytes   (Linux: stat -c %s)
shasum -a 256 exp/owned-v0/encoder.int8.onnx  # sha256

# 2. Create models/tuff-asr-zh/0.2.0/model.json from the 0.1.0 descriptor with:
#      version "0.2.0", engine "onnxruntime", runtime.kind "onnx",
#      runtime.file/bytes/sha256 from step 1, quantization "int8",
#      text.requiresSimplifiedConversion true, license.spdx "MIT",
#      benchmark ONLY if measured on a recorded host,
#      source.url pointing at the published release artefact (see below).

# 3. For a self-trained bundle there is no upstream download URL, but
#    fetch-model.mjs still requires one: upload the file as a signed release
#    artefact and put that URL in source.url. Otherwise the bundle ships with
#    the app and only verify-catalog.mjs applies.

# 4. Validate, verify any local digest, and regenerate the catalog.
node tools/verify-catalog.mjs

# 5. Prove the install path end to end against the published URL.
node tools/fetch-model.mjs tuff-asr-zh 0.2.0

# 6. Move the default only when the new version is genuinely better.
#    Edit defaults.json: { "defaults": { "tuff-asr-zh": "0.2.0" } } then re-run step 4.
```

Step 4 will refuse to publish a bundle whose `license.redistributable` is false,
whose weight file does not match its declared digest, or that would leave the
catalog with zero or two defaults. That is the point: the repository's only job
is to make an unverifiable model impossible to ship.