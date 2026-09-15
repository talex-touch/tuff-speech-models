# whisper-base 1.0.0

**What it is.** Multilingual [OpenAI Whisper `base`](https://github.com/openai/whisper)
weights converted to ggml by the [whisper.cpp](https://github.com/ggerganov/whisper.cpp)
project, repackaged here as a Tuff speech bundle. No re-quantisation, no
re-export: this is `ggml-base.bin` exactly as upstream publishes it.

| field | value |
| --- | --- |
| id / version | `whisper-base@1.0.0` |
| engine | `whisper-cpp` |
| weights | `ggml-base.bin` |
| bytes | `147951465` |
| sha256 | `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe` |
| quantization | `none` |
| license | MIT (`redistributable: true`) |
| source | `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin` |
| upstream | `whisper-base` (converted from `openai/whisper-base`) |
| default | no — `tuff-asr-zh@0.1.0` is the catalog default |

## What was measured

On 2026-09-15, on an Apple M4 Pro (arm64, Metal), with whisper.cpp 1.9.1
(`/opt/homebrew/bin/whisper-cli`):

- Audio: macOS `say -v Tingting` speaking 今天天气很好我们去公园散步吧, converted to
  16 kHz mono WAV with ffmpeg — 3.44 s.
- Command: `whisper-cli -m ggml-base.bin -f x.wav -l zh -nt`.
- Output: `今天天氣很好我們去公園散步吧。` — content correct, wording identical to the
  input, script Traditional.
- RTF **0.33** (≈1.14 s wall including cold model load), `sampleCount: 1`.

One synthetic sample is a latency probe, not an accuracy benchmark. The
descriptor therefore publishes `rtf` only; no `cer` is claimed, because no
labelled corpus was run.

## Known limitations

1. **Traditional Chinese output.** For zh audio the model emits Traditional
   script with no prompt. This is the single most user-visible defect for a
   mainland user, and it is why `text.script` is `traditional` and
   `text.requiresSimplifiedConversion` is `true`. The runtime, not the model,
   must convert. (Measurement detail: prepending a Simplified primer flips the
   script for the same audio, which is a viable second mitigation.)
2. **No inverse text normalisation.** `capabilities.itn` is `false`: spoken
   numbers come back as Chinese characters, not digits.
3. **Accuracy is `base`-class.** Everything below `small` makes real word errors
   on noisy or accented speech; nothing here contradicts that.
4. **No accuracy number exists for this bundle.** RTF was measured; CER was not.
5. **Uses the whisper.cpp CLI as a subprocess** (`whisper-cli -oj`), not a linked
   library. That is the current runtime design, not a property of the weights.

## What it replaced

Nothing. This is the first version of the `whisper-base` line, and the first
bundle published by this repository.