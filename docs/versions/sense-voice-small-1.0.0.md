# sense-voice-small 1.0.0

**What it is.** An official inclusion of Alibaba Tongyi's **SenseVoice-Small** speech foundation model into the Tuff speech catalog, exported to INT8 ONNX by `sherpa-onnx`.

Unlike the autoregressive Whisper family, SenseVoice is a **non-autoregressive (NAR)** multilingual speech model built specifically for rich speech transcription, native punctuation, emotion detection and inverse text normalization (ITN).

| field | value |
| --- | --- |
| id / version | `sense-voice-small@1.0.0` |
| engine | `sherpa-onnx` |
| weights | `model.int8.onnx` (239233841 bytes) |
| auxiliary | `tokens.txt` (315894 bytes) |
| sha256 (weights) | `c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51` |
| quantization | `int8` |
| license | Apache-2.0 (`redistributable: true`) |
| source | `https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17` |
| derived from | `FunAudioLLM/SenseVoice-Small` |
| default | no (requires `sherpa-onnx` runtime) |

## What was measured

Measured on an Apple M4 Pro (arm64, 14-core) through the runtime Tuff ships — the
`sherpa-onnx-offline` CLI, 8 threads, one invocation per utterance:

| measurement | value |
| --- | --- |
| 4.20 s Mandarin utterance, wall clock | **0.43 s** |
| Runtime RTF | **0.102** |
| Character Error Rate (CER) | **0.000** on the reference sample |
| Transcript | `甚至出现交易几乎停滞的情况。` — matches the reference, punctuation included |
| Traditional Chinese leakage | **0.0%** |

Two thirds of that wall time is process start plus the 229 MB INT8 model load, and every
invocation pays it again: warm `whisper-cli` on the same audio and host costs 0.26–0.29 s.
The same weights, already resident, measure **0.06 s (RTF 0.014)** in an in-process harness —
that is the headroom a resident recognizer would recover, and **the runtime does not yet reach
it**. Publishing 0.014 as this bundle's RTF would therefore be a claim about a harness rather
than about the product.

## Comparison with Whisper Base

| Dimension | Whisper Base (`tuff-asr-zh@0.1.0`) | SenseVoice-Small (`sense-voice-small@1.0.0`) |
| --- | --- | --- |
| Architecture | Autoregressive (Seq2Seq Transformer) | Non-autoregressive (encoder + CTC) |
| Runtime latency, 4.2 s audio | ~0.26–0.33 s | ~0.43 s |
| CER on the same reference | 7.7% | **0.0%** |
| Native punctuation | Weak / sentence-level | **High fidelity** |
| Inverse text normalization | Declared unsupported | **Model-side, digits out** |
| Empty or silent audio | Can loop or emit invented text | **Nothing, by construction** |
| Runtime requirement | `whisper-cli` (pure C++) | `sherpa-onnx-offline` |

## The runtime prerequisite

This bundle needs `sherpa-onnx-offline` on the host, exactly as the whisper bundles need
`whisper-cli`. Tuff locates it via an explicit path, then `TUFF_SHERPA_BIN`, then `PATH`, then
the two Homebrew prefixes, and reports `LOCAL_ENGINE_BINARY_MISSING` before the user speaks
rather than failing at decode time. The tokenizer is loaded from the same requirement set: a
bundle whose `tokens.txt` is absent is reported as a missing model, not as a partial one.

## Known limitations

1. **Latency is the subprocess's, not the library's.** See the measurements above: ~0.43 s per
   utterance, most of it model load. Recovering the in-process 0.06 s needs a resident
   recognizer, which this runtime does not implement.
2. **WAV only.** `sherpa-onnx-offline` reads WAV, so the on-device provider advertises
   `pcm` and `wav` for this bundle instead of the container formats the whisper path accepts.
3. **No partial hypotheses from the engine.** The model is non-autoregressive and this CLI has
   no streaming mode; `capabilities.stream: true` describes the family's block-wise ability,
   not this runtime, whose partials come from re-decoding the captured prefix.
4. **Third-party weights.** Apache-2.0 and redistributable, but the model is Alibaba's, so any
   product claim must not imply SenseVoice is ours.
