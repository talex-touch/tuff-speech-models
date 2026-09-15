# tuff-asr-zh 0.2.0 — q5_1

**Status:** installable, not the catalog default.

## What it is

A quantization of `tuff-asr-zh@0.1.0`. The weights are the same whisper-base ggml
tensor set, put through `whisper-quantize` to `q5_1`. No training, no fine-tuning,
no dataset; no weight was altered other than by the quantizer.

| | 0.1.0 (f16) | 0.2.0 (q5_1) |
|---|---|---|
| size | 147 951 465 B | 59 707 625 B (40%) |
| sha256 | `60ed5bc3…2efe` | `80147c66…d731` |

## Why it exists

148 MB is a real first-run download for a desktop app. If a 60 MB bundle transcribes
the same audio about as well, it is the better trade. This release exists to test
that condition, and the honest answer so far is "probably, on far too little
evidence to act on".

## How the evidence was produced

Two synthetic Mandarin utterances, five repetitions per configuration, decoded with
**the runtime's own flags** (`whisper-cli -oj`, timestamps enabled). Every repetition
of every configuration was byte-identical, so the table below is the decode, not a
sample of one.

| ground truth | 0.1.0 (f16) | 0.2.0 (q5_1) |
|---|---|---|
| 今天天气很好我们去公园散步吧 | 今天天气很好我们去公**元**散步吧。 | 今天天**起**很好我们去公园散步吧。 |
| 明天下午三点开会记得带上项目文档 | 明天下午三点开会计的戴上项目文档**﹐** | 明天下午三点开会计的戴上项目文档**。** |

Utterance 1: each version misses exactly one character, and a different one — 0.1.0
loses 公园 to the homophone 公元, 0.2.0 loses 天气 to 天起 while getting 公园 right.
Utterance 2: both produce the identical wrong text (`开会记得` → `开会计的`,
`带上` → `戴上`), differing only in the closing punctuation.

**Conclusion: no quality difference is established in either direction.** The
dominant error source is whisper base itself. Two utterances cannot support a
parity claim and this document does not make one.

## The flag matters more than it looks

An earlier draft of this document compared the two versions using `whisper-cli -nt`
(no timestamps) and reported that 0.2.0 corrected the 公园 homophone. That was wrong,
and the reason is worth recording.

**In whisper.cpp, timestamps are not a presentation detail.** The decoder emits
timestamp tokens; disabling them changes the transcript. Same weights, same file,
one flag apart:

| flags | 0.2.0 (q5_1) | 0.1.0 (f16) |
|---|---|---|
| `-oj` (timestamps on — what Tuff uses) | 今天天**起**很好我们去公园散步吧。 | 今天天气很好我们去公**元**散步吧。 |
| `-nt` (timestamps off) | 今天天气很好我们去公园散步吧。 | 今天天气很好我们去公**元**散步吧。 |

So any comparison of this engine has to be made with the flags the product actually
runs, or it is measuring a different decoder. `LocalTranscribeOptions.timestamps`
exists for this reason and really does change the decode.

## Why it is not the default

`defaults.json` still points `tuff-asr-zh` at `0.1.0`. Promoting a smaller artifact on
the strength of "no measurable difference across two utterances" would be trading a
known-fidelity bundle for a smaller one on evidence that does not support the trade.
Once a real evaluation set exists, promotion is a one-line change to `defaults.json`.

## Provenance

Weights derive from `ggerganov/whisper.cpp`'s `ggml-base.bin` (MIT), via
`tuff-asr-zh@0.1.0`. Hosted on this repository's `tuff-asr-zh-0.2.0` release because a
quantized artifact has no upstream URL to fetch from; the descriptor's `source.url`
points at the release asset, which is what `tools/fetch-model.mjs` downloads.

Reproduce with:

```sh
whisper-quantize ggml-base.bin tuff-asr-zh-0.2.0-q5_1.bin q5_1
shasum -a 256 tuff-asr-zh-0.2.0-q5_1.bin   # 80147c665f9ac54ab8c3c7f55da90ac030ea40610495ba4dd0aa6304fd49d731
```