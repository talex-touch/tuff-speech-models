# whisper-tiny 1.0.0

**What it is.** The small sibling of [whisper-base@1.0.0](./whisper-base-1.0.0.md):
OpenAI Whisper `tiny` weights in ggml form, repackaged here as a Tuff speech
bundle. It exists for machines and moments where latency or footprint matters
more than accuracy — first-run smoke tests, low-power laptops, and as the
reference point when comparing a future Talex-Touch model against the cheap end
of the Whisper family.

| field | value |
| --- | --- |
| id / version | `whisper-tiny@1.0.0` |
| engine | `whisper-cpp` |
| weights | `ggml-tiny.bin` |
| bytes | `77691713` |
| sha256 | `be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21` |
| quantization | `none` |
| license | MIT (`redistributable: true`) |
| source | `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin` |
| upstream | `whisper-tiny` (converted from `openai/whisper-tiny`) |
| default | **no** — it is deliberately not the catalog default; `tuff-asr-zh@0.1.0` is |

## What was measured

Same host, same single sample and same instrumentation as
whisper-base@1.0.0 (Apple M4 Pro, Metal, whisper.cpp 1.9.1, macOS `say -v
Tingting` Mandarin → 16 kHz mono WAV, 3.44 s, `-l zh -nt`):

- Content transcribed correctly, wording identical to the input.
- Script: Traditional (`今天天氣很好我們去公園散步吧。`).
- RTF **0.15** — roughly 2.2× faster than whisper-base on this sample, because
  the weights are about half the size (77.7 MB vs 148.0 MB).
- `sampleCount: 1`.

The 2.2× ratio is a latency observation on one sample, not a quality claim. No
CER was measured for this bundle, so the accuracy gap against whisper-base is
**unquantified**; the usual expectation that `tiny` is less accurate than `base`
is a property of the upstream models, and this repository has not tested it.

## Known limitations

1. **Traditional Chinese output**, identical to whisper-base: `text.script` is
   `traditional` and `text.requiresSimplifiedConversion` is `true`. The runtime
   must convert before delivery.
2. **No inverse text normalisation** (`capabilities.itn: false`).
3. **Lowest accuracy tier of the Whisper family.** Expect visibly worse results
   than whisper-base on real dictation; use it only when latency dominates.
4. **Not the default.** A fresh Tuff install must not pick this bundle.
   `node tools/fetch-model.mjs whisper-tiny` installs it explicitly.
5. **No accuracy number exists for this bundle.** Only RTF was measured.

## What it replaced

Nothing. First version of the `whisper-tiny` line. It ships alongside
whisper-base so that a latency comparison is always one command away:
`node tools/fetch-model.mjs whisper-tiny` then point the runtime at the
installed directory with `TUFF_SPEECH_MODEL_DIR`.

## Why it is not the default

The catalog publishes exactly one default — the version Talex-Touch ships on
first run — and that is `tuff-asr-zh@0.1.0`, which carries the Simplified-output
policy a Mandarin-first product needs. Marking `whisper-tiny` default would
install a more error-prone model whose script the runtime has to correct. The
choice is recorded in `defaults.json` and enforced by `tools/verify-catalog.mjs`.