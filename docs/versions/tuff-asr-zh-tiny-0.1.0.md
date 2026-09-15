# tuff-asr-zh-tiny 0.1.0 — first first-party fine-tune

**Status:** installable, not the catalog default.

## What it is

The first model in this catalog that Talex-Touch trained itself. `openai/whisper-tiny`
(39M parameters, MIT) was fine-tuned for one epoch on **8300 Mandarin utterances** of
ST-CMDS (OpenSLR 38, Apache-2.0), on MPS, in **665 seconds**.

No third-party proprietary weights are involved at any point. This is a public model
adapted on a public corpus by our own pipeline.

## Result

Measured with `whisper-cli`, using the flags Tuff itself uses, on the same 60 held-out
utterances that were never trained on:

| model | CER | parameters |
|---|---|---|
| **tuff-asr-zh-tiny 0.1.0** | **0.1574** | 39M |
| tuff-asr-zh 0.1.0 (whisper-base) | 0.2018 | 74M |
| whisper-tiny, untuned | 0.2868 | 39M |

Out-of-domain, on formal TTS utterances that resemble dictation far more than web speech
does:

| utterance | this model | whisper-base |
|---|---|---|
| 今天天气很好我们去公园散步吧 | CER **0.000** | 0.071 |
| 明天下午三点开会记得带上项目文档 | CER **0.000** | 0.188 |

Both come back exactly right, where whisper-base produced 公元 for 公园 and 开会计的 for
开会记得.

## A side effect worth naming

The whisper-base line needs a *decode-time primer* to emit Simplified Chinese, and that
primer can leak into the output on very short audio (see `tuff-asr-zh-0.2.0.md`). This
model was trained on Simplified transcripts, so it emits Simplified natively — verified
identical with and without the primer. `model.json` therefore declares
`requiresSimplifiedConversion: false`, the runtime attaches no primer, and the echo hazard
does not exist for this model.

## What this does not prove

Stated plainly, because the numbers above are easy to over-read:

- **62 evaluated utterances.** Not a benchmark. The held-out set is in-domain: the same
  crowd-sourced conversational register as the training data.
- **Two out-of-domain utterances.** Suggestive, not conclusive. Generalisation to
  commands, technical vocabulary, and formal speech is unmeasured.
- **A 39M-parameter model does not out-generalise a 74M one** on the strength of 62
  utterances. It wins where it was measured; that is the whole claim.
- **The fine-tuning corpus is unfiltered web speech** and contains crude language. A model
  adapted on it can reproduce that register. Filtering the corpus is a prerequisite for any
  default promotion.
- **Domain mismatch.** ST-CMDS is spontaneous conversational Mandarin; Tuff's users dictate
  commands and prose. The in-domain win may not transfer.

Promotion to default should follow a real evaluation set drawn from Tuff's actual usage,
not from this corpus.

## Reproduce

`training/` in this repository contains the whole pipeline:

```sh
# 1. data (8.2 GB, no login required)
curl -L -o ST-CMDS.tar.gz https://www.openslr.org/resources/38/ST-CMDS-20170001_1-OS.tar.gz
tar xzf ST-CMDS.tar.gz

# 2. fine-tune (writes train_meta.json with baseline and final CER)
python training/train_whisper.py \
  --corpus ./ST-CMDS-20170001_1-OS --out ./ft-run \
  --limit 8300 --val-limit 300 --eval-limit 100 --epochs 1 --batch-size 8 --lr 1e-5

# 3. convert to ggml
python training/convert_to_ggml.py ./ft-run ./ft-ggml

# 4. score every model on identical audio with the product's flags
python training/eval_whisper_cpp.py \
  --corpus ./ST-CMDS-20170001_1-OS --limit 8300 --holdout 60 \
  --model fine-tuned=./ft-ggml/ggml-model.bin \
  --model base=./ggml-base.bin --model tiny=./ggml-tiny.bin
```

Raw outputs are committed beside this file as
`training/tuff-asr-zh-tiny-0.1.0.train_meta.json` and
`training/tuff-asr-zh-tiny-0.1.0.cpp_cer.json`.

## Conversion note

`transformers` 5.x writes neither `vocab.json` nor `added_tokens.json`, and whisper.cpp's
converter requires both. `training/convert_to_ggml.py` re-emits the vocabulary from the
saved tokenizer before converting; without that step the converter fails immediately. The
converter also needs the directory that *contains* the `whisper` package, so it can find
`mel_filters.npz`.
