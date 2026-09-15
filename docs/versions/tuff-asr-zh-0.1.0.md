# tuff-asr-zh 0.1.0

**What it is.** The first release of Talex-Touch's **own** speech-model line, and
the version a fresh Tuff install picks.

0.1.0 is honest about what it is: a *repackage*, not a newly trained model. It
ships the MIT-licensed whisper-base ggml weights byte-for-byte and wraps them in
a Tuff-owned delivery contract — a zh-first language profile and a mandatory
Simplified-Chinese conversion step the runtime must apply. Training a model we
own is planned, not done: see [`docs/training.md`](../training.md).

| field | value |
| --- | --- |
| id / version | `tuff-asr-zh@0.1.0` |
| engine | `whisper-cpp` |
| weights | `ggml-base.bin` (same file as whisper-base@1.0.0) |
| bytes | `147951465` |
| sha256 | `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe` |
| quantization | `none` |
| license | MIT (`redistributable: true`) |
| source | `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin` |
| derived from | `whisper-base@1.0.0` |
| default | **yes** — the single catalog-wide default |

## What was measured

**Nothing, for this bundle.** The descriptor deliberately has **no `benchmark`
object**, because no run has been performed on `tuff-asr-zh@0.1.0` itself. The
number that would go there — RTF, and eventually CER — must come from a real
execution of this bundle on a recorded host, exactly as
[whisper-base@1.0.0](./whisper-base-1.0.0.md) documents its own 0.33 RTF.

Inheriting whisper-base's measurements would be dishonest: this descriptor
names different languages (`zh`, `en` rather than four) and asserts a different
runtime contract, so it is a different bundle even though the weight bytes are
identical. Its SHA-256 above is therefore *observed* (the file was hashed, and
the same file was downloaded and verified through
`node tools/fetch-model.mjs`), while its performance is *unmeasured*.

## What it changes relative to whisper-base@1.0.0

| | whisper-base@1.0.0 | tuff-asr-zh@0.1.0 |
| --- | --- | --- |
| languages | `zh, en, ja, ko` | `zh, en` |
| `text.requiresSimplifiedConversion` | `true` | `true` (kept — this is the product requirement, not a beta defect) |
| `source.derivedFrom` | `openai/whisper-base` | `whisper-base@1.0.0` |
| benchmark | RTF 0.33 measured | none claimed |
| catalog default | no | yes |

## Known limitations

1. **Traditional Chinese output.** The shared weights decode zh audio to
   Traditional script (`今天天氣很好我們去公園散步吧。`). `text.requiresSimplifiedConversion`
   is a statement of the defect, not a fix: the runtime owns the conversion. If
   the runtime ignores the flag, users see Traditional text.
2. **No accuracy claim of any kind.** Not benchmarked, not CER-tested, not
   compared against whisper-base. It is the default because of its policy, not
   because of a quality win.
3. **No inverse text normalisation** (`capabilities.itn: false`).
4. **`base`-class accuracy.** Same acoustic model as whisper-base, so the same
   errors on noisy, accented, or code-switched speech.
5. **Still third-party weights.** Verified `redistributable: true` (MIT), but the
   model is Whisper's, so any product claim must not imply Whisper is ours.
6. **Subprocess engine.** Runs through `whisper-cli -oj`; there is no linked
   library path, and no streaming partials today — `capabilities.stream: true`
   describes the model family's ability, and the runtime's streaming behaviour
   is a separate, unverified matter.

## What it replaced

Nothing was removed. It takes over as the version Tuff installs **by default**:
before this release the catalog had no default at all, so the install step had
to name `whisper-base` explicitly. `whisper-base@1.0.0` and
`whisper-tiny@1.0.0` remain fully installable by explicit version.

## Upgrade path

`0.2.0` is expected to be the first bundle with weights Talex-Touch trained or
fine-tuned itself, at which point the descriptor loses its `source.derivedFrom`
link and gains a real `benchmark`. Publishing such a bundle must not weaken this
one's guarantees: `tools/verify-catalog.mjs` still demands a redistributable
license, a digest-verified weight file, and exactly one catalog default.