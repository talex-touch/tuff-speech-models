"""Score models the way the product runs them.

The transformers-side number is not the product number: Tuff shells out to whisper-cli with
its own flags, and the Python greedy path can disagree with it. This harness runs whisper-cli
over a held-out slice and computes CER against the corpus transcript, so every model is judged
on identical audio, identical flags and identical text normalisation.
"""
import argparse
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train_whisper import load_manifest  # noqa: E402

PRIMER = "以下是普通话的句子，请使用简体中文。"


def strip_punct(text):
    """Whisper chooses its own punctuation; the corpus carries none. Count recognition only."""
    return re.sub(r"[\s，。、,.!！?？;；:：\"'“”‘’]", "", text)


def cer(reference, hypothesis):
    """Character error rate via edit distance over characters."""
    ref, hyp = list(reference), list(hypothesis)
    if not ref:
        return 0.0 if not hyp else 1.0
    previous = list(range(len(hyp) + 1))
    for i, rc in enumerate(ref, 1):
        current = [i]
        for j, hc in enumerate(hyp, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (rc != hc)))
        previous = current
    return previous[-1] / len(ref)


def transcribe(binary, model_path, wav_path, language, use_primer, threads=8):
    cmd = [binary, "-m", model_path, "-f", wav_path, "-l", language, "-t", str(threads), "-np", "-nt"]
    if use_primer:
        cmd += ["--prompt", PRIMER]
    result = subprocess.run(cmd, capture_output=True, text=True)
    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    return "".join(lines)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", required=True)
    parser.add_argument("--binary", default="whisper-cli")
    parser.add_argument("--limit", type=int, default=8300)
    parser.add_argument("--holdout", type=int, default=60)
    parser.add_argument("--language", default="zh")
    parser.add_argument("--model", action="append", required=True, help="name=path")
    parser.add_argument("--no-primer", action="store_true")
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    models = [entry.split("=", 1) for entry in args.model]
    pairs = load_manifest(args.corpus, args.limit)
    val = pairs[:300][: args.holdout]
    print(f"[eval] {len(val)} held-out utterances, primer={'no' if args.no_primer else 'yes'}", flush=True)

    summary = {}
    details = {}
    for name, path in models:
        scores, samples, blank = [], [], 0
        for wav_path, reference in val:
            hypothesis = transcribe(args.binary, path, wav_path, args.language, not args.no_primer)
            if not hypothesis:
                blank += 1
            scores.append(cer(strip_punct(reference), strip_punct(hypothesis)))
            samples.append({"reference": reference, "hypothesis": hypothesis})
        mean = sum(scores) / len(scores) if scores else float("nan")
        summary[name] = {"cer": round(mean, 4), "blank": blank, "n": len(val)}
        details[name] = samples
        print(f"[eval] {name:12s} CER={mean:.4f}  blank={blank}/{len(val)}", flush=True)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump({"summary": summary, "details": details}, handle, ensure_ascii=False, indent=2)
    print("[eval] " + json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
