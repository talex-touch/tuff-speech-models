#!/usr/bin/env python3
"""Convert a HuggingFace whisper fine-tune to whisper.cpp ggml.

whisper.cpp's convert-h5-to-ggml.py assumes a checkpoint layout that transformers 5.x does
not produce, so this wrapper closes the gap instead of editing a vendored upstream script:

  1. it opens <model>/vocab.json and <model>/added_tokens.json unconditionally. A current
     save_pretrained writes only tokenizer.json, so both are re-emitted from the saved
     tokenizer before conversion;
  2. it loads mel filters from <whisper_repo>/whisper/assets/mel_filters.npz, so the repo
     argument must be the directory that *contains* the whisper package.

Usage: convert_to_ggml.py <model_dir> <out_dir> [--f32]
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CONVERTER = os.path.join(HERE, "convert-h5-to-ggml.py")


def site_packages_parent():
    """The directory holding the `whisper` package, which is what the converter wants."""
    import whisper
    return os.path.dirname(os.path.dirname(os.path.abspath(whisper.__file__)))


def stage_converter_layout(model_dir):
    """Return a directory carrying vocab.json/added_tokens.json, staging one if needed."""
    has_vocab = os.path.exists(os.path.join(model_dir, "vocab.json"))
    has_added = os.path.exists(os.path.join(model_dir, "added_tokens.json"))
    if has_vocab and has_added:
        return model_dir, None

    from transformers import WhisperTokenizerFast

    print("[convert] staging vocab.json/added_tokens.json from the saved tokenizer")
    staged = tempfile.mkdtemp(prefix="whisper-convert-")
    target = os.path.join(staged, "model")
    shutil.copytree(model_dir, target)

    # transformers 5.x writes neither vocab.json nor merges.txt — its tokenizer is saved in a
    # single unified format. The converter still reads the GPT-2 style token->id map, which is
    # exactly what get_vocab() returns, so it is written out here.
    tokenizer = WhisperTokenizerFast.from_pretrained(model_dir)
    vocab = tokenizer.get_vocab()
    if not vocab:
        shutil.rmtree(staged, ignore_errors=True)
        raise SystemExit("FATAL: the tokenizer exposed an empty vocabulary")
    with open(os.path.join(target, "vocab.json"), "w", encoding="utf-8") as handle:
        json.dump(vocab, handle, ensure_ascii=False)

    if not os.path.exists(os.path.join(target, "added_tokens.json")):
        with open(os.path.join(target, "added_tokens.json"), "w", encoding="utf-8") as handle:
            json.dump({}, handle)
    print(f"[convert] staged vocabulary of {len(vocab)} tokens")
    return target, staged


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2

    model_dir = os.path.abspath(sys.argv[1])
    out_dir = os.path.abspath(sys.argv[2])

    config_path = os.path.join(model_dir, "config.json")
    if not os.path.exists(config_path):
        print(f"FATAL: {config_path} is missing; this is not a whisper fine-tune directory")
        return 1

    staged_model, staged_root = stage_converter_layout(model_dir)
    try:
        os.makedirs(out_dir, exist_ok=True)
        cmd = [sys.executable, CONVERTER, staged_model, site_packages_parent(), out_dir]
        if "--f32" in sys.argv:
            cmd.append("1")
        print("[convert] " + " ".join(cmd), flush=True)
        result = subprocess.run(cmd)
        if result.returncode != 0:
            return result.returncode
    finally:
        if staged_root:
            shutil.rmtree(staged_root, ignore_errors=True)

    produced = os.path.join(out_dir, "ggml-model.bin")
    if not os.path.exists(produced):
        print(f"FATAL: converter reported success but {produced} does not exist")
        return 1
    print(f"[convert] produced {produced} ({os.path.getsize(produced)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())