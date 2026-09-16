# tuff-speech-models

Model bundles for **Tuff**, the on-device speech stack inside
[Talex-Touch](https://github.com/TalexDreamSoul/talex-touch).

This repository is a *distribution point and a contract*, not a training
repository. It publishes immutable, digest-pinned descriptions of speech models
that Tuff can download, verify and run locally, plus the two small Node tools
that enforce those descriptions. There is no npm dependency anywhere in it:
`node tools/verify-catalog.mjs` is the whole build.

What it guarantees, and what the tools refuse to publish:

- every version names the exact weight file, its byte size and its SHA-256;
- weights are fetched and verified before they reach a user's disk;
- nothing whose license forbids redistribution can enter the catalog;
- exactly one version is the default Tuff installs on first run.

## Layout

```
schema/model.schema.json      descriptor format (one version = one descriptor)
schema/catalog.schema.json    generated index format
models/<id>/<version>/model.json
                              one immutable descriptor per published version
defaults.json                 hand-edited: which version is the catalog default
catalog.json                  GENERATED — never edit by hand
tools/verify-catalog.mjs      validate everything, then regenerate catalog.json
tools/fetch-model.mjs         download + verify + install one version
tools/lib/manifest.mjs        canonical bundle hashing shared by both tools
docs/versions/<id>-<version>.md
                              human-readable notes per published version
docs/training.md              recipe for training a model Talex-Touch owns
training/                     the scripts that recipe was executed with, and the
                              raw outputs of the run that published tuff-asr-zh-tiny
```

Weight files are **never committed**. `.gitignore` excludes `*.bin`, `*.onnx`
and friends; they are downloaded at install time from the URL recorded in the
descriptor, or attached to a release artifact.

## The version model

`models/<id>/<version>/model.json` describes one bundle, and one bundle only.

- `<id>` is a model family (`whisper-base`, `tuff-asr-zh`) shared across versions.
- `<version>` is `x.y.z` semver, and it must equal the descriptor's own `id` and
  `version` fields — `tools/verify-catalog.mjs` rejects any mismatch.
- Descriptors are **immutable**. Changing anything that affects what is
  installed — the weights, their digest, the language set, the text policy —
  means a new version directory, not an edit. Fixing a typo in a `description`
  is the only kind of edit that is safe, and even that changes nothing a client
  verifies, because the catalog's digest excludes prose (see below).
- Published third-party weights carry a `source` block naming the upstream repo,
  the download URL and, when relevant, the id@version they were derived from.
  Weights Talex-Touch trains itself omit `source` provenance fields that do not
  apply and still declare a `source.url` for distribution.
- Bundles that need more than one file — a recognizer plus its tokenizer, say —
  declare the extras in `auxiliary`, and **every** auxiliary entry carries its
  own `url`. This is required rather than optional because the fetcher resolves
  one URL per file: an auxiliary file with no URL makes the whole version
  uninstallable, and a bundle that cannot be installed must not be published.
  `verify-catalog.mjs` enforces it through the schema, so the mistake fails at
  publication instead of at a user's first fetch. Note that `url` is a
  distribution detail and is deliberately *not* part of the canonical bundle
  manifest, so adding or correcting one never changes a published digest.

`defaults.json` is the source of truth for the catalog's `default` flag:

```json
{ "defaults": { "tuff-asr-zh": "0.1.0" } }
```

A model id absent from that map has no recommended version — its versions remain
installable by explicit `id version`. **Exactly one entry across the whole file**
may be the catalog-wide default, because Tuff installs exactly one speech model
on first run; `whisper-tiny` is deliberately not a default.

## The catalog

`catalog.json` is generated and hand-editing it is a mistake the tool will
overwrite. Each entry carries:

| field | meaning |
| --- | --- |
| `descriptor` | repo-relative path to the version's `model.json` |
| `bytes` | total download size (weights + auxiliary files) |
| `sha256` | SHA-256 over the *canonical bundle manifest* |
| `default` | true for the single version Tuff installs by default |
| `redistributable` | always `true`; the tool refuses to publish anything else |

The **canonical bundle manifest** is the projection of the descriptor that a
client can actually verify: `{ id, version, engine, files[] }`, where `files[]`
holds the weights first and then any auxiliary files sorted by path, each as
`{ role, file, bytes, sha256 }`. It is serialised as UTF-8 JSON with every
object key sorted recursively and no whitespace, then hashed. Prose is excluded
on purpose: editing a `description` or a `benchmark.notes` must not change a
published digest.

`generatedAt` only advances when the model set actually changes. Regenerating an
unchanged catalog is a byte-identical no-op, so `git diff` stays meaningful.

## Install a model

```bash
node tools/fetch-model.mjs tuff-asr-zh            # the catalog default version of an id
node tools/fetch-model.mjs whisper-tiny 1.0.0     # an explicit version
node tools/fetch-model.mjs whisper-base --dir /tmp/scratch   # elsewhere
```

The default install directory is
`~/Library/Application Support/Tuff/speech-models/<id>/<version>/`, which is the
same layout Tuff's runtime resolves (`resolveModelStoreRoot()` in
`packages/tuff-voice/src/local/model-store.ts`) — including the
`TUFF_SPEECH_MODEL_DIR` override and the `$XDG_DATA_HOME/Tuff/speech-models`
fallback off macOS. The tool writes both the weights and a copy of the
version's `model.json` beside them, because the runtime reads
`<install>/model.json` to decide which engine runs the weights and what they
must hash to; a fetched model is therefore found with no registration step.

Before touching the network it checks the descriptor against `catalog.json`: the
catalog's `sha256` must equal the recomputed bundle manifest hash, so a stale
catalog is a hard error rather than a silent install of something else. It then
downloads each missing file to `<file>.part`, streams SHA-256 while writing, and

- keeps the file only when both byte size and digest match the descriptor;
- deletes the partial and exits non-zero on any mismatch, truncation, or non-2xx
  response — nothing is installed;
- skips a file whose on-disk size and digest already match (re-running is cheap),
  and re-downloads one that does not.

Every run re-verifies what is on disk after the fact and prints what it actually
did: bytes, seconds, source URL, and the verified digest.

## Add a version

1. **Train or obtain the weights.** For third-party weights, confirm the license
   permits redistribution — if it does not, stop: the tooling will reject the
   bundle and the weights must not be committed or published. For a
   Talex-Touch-owned model, follow [`docs/training.md`](./docs/training.md).
2. **Create the directory** `models/<id>/<new-version>/` and copy the closest
   existing descriptor into it as `model.json`.
3. **Fill in the real facts.** `id` unchanged; `version` equal to the directory
   name; `runtime.file`, `runtime.bytes` and `runtime.sha256` from the actual
   file:

   ```bash
   stat -f %z my-weights.bin          # bytes  (Linux: stat -c %s)
   shasum -a 256 my-weights.bin       # sha256
   ```

   Never guess these; a bundle without a verified digest must never load.
4. **Record `license.spdx` and `redistributable`.** `redistributable: false`
   means the bundle cannot be published here, and `tools/verify-catalog.mjs`
   will exit non-zero rather than catalogue it.
5. **Add a `benchmark` only if you measured it**, on the host you name, with the
   sample count you actually ran. Otherwise omit the object entirely and say so
   in the version doc — see `docs/versions/tuff-asr-zh-0.1.0.md` for how that is
   written.
6. **Write `docs/versions/<id>-<version>.md`**: what it is, what was measured,
   known limitations, and what it replaced.
7. **Point `defaults.json` at the new version** if it should become what a fresh
   install picks (and move the default off the previous one — never two).
8. **Regenerate and verify:**

   ```bash
   node tools/verify-catalog.mjs      # validates, verifies local digests, writes catalog.json
   node tools/fetch-model.mjs <id> <new-version>   # proves the install path end to end
   ```

   Commit the descriptor, `docs/versions/*.md` and the regenerated
   `catalog.json` together.

## Verifying

```bash
node tools/verify-catalog.mjs          # validate + regenerate catalog.json
node tools/verify-catalog.mjs --check  # validate only; writes nothing (use in CI)
```

It exits non-zero, with a message naming the file and the offending field, when:

- any descriptor violates `schema/model.schema.json` (a self-contained validator;
  no npm dependencies are installed or required);
- a descriptor's `id`/`version` contradicts its directory path;
- the same `id@version` is defined twice;
- `license.redistributable` is not `true`;
- `defaults.json` names an id@version that does not exist;
- a model id has more than one default version, or the catalog has other than
  exactly one default overall;
- a weight or auxiliary file that **is** present locally has the wrong size or
  SHA-256 (absent files are reported as unchecked, which is the normal state of
  a fresh checkout);
- the generated catalog does not satisfy `schema/catalog.schema.json`.

Proving the guards work, from a clean checkout (all four were run before this
repository's first commit):

```bash
# 1. a non-redistributable bundle is refused
sed -i '' 's/"redistributable": true/"redistributable": false/' models/whisper-tiny/1.0.0/model.json
node tools/verify-catalog.mjs; echo "exit=$?"          # exit=1, names the file and the field
git checkout models/whisper-tiny/1.0.0/model.json

# 2. a second default is refused — add "whisper-tiny": "1.0.0" to defaults.json
node tools/verify-catalog.mjs; echo "exit=$?"          # exit=1, found 2: tuff-asr-zh@0.1.0, whisper-tiny@1.0.0

# 3. a corrupted local weight file is refused — copy the weights into the
#    version directory, then flip one byte
node tools/verify-catalog.mjs                          # OK: weights verified, sha256 matches
node tools/verify-catalog.mjs; echo "exit=$?"          # exit=1, sha256 mismatch with both digests printed

# 4. a descriptor edited without republishing the catalog stops the installer
#    before it touches the network
node tools/fetch-model.mjs whisper-tiny; echo "exit=$?" # exit=1, bundle digest does not match catalog.json
```

Regenerating an unchanged catalog is a no-op: `generatedAt` keeps its previous
value, so `git diff` never shows churn from a rebuild.

## License stance

- **Code, schemas, descriptors and docs in this repository are MIT** (see
  `LICENSE`).
- **Weights are never committed here.** They keep their upstream license, which
  every descriptor records in `license.spdx`. `tools/verify-catalog.mjs` treats
  `license.redistributable === true` as a precondition for being published at
  all: a version whose terms do not allow us to host it is a validation failure,
  not a warning.
- **The reverse-engineered ByteDance Doubao offline weights are explicitly out
  of scope.** Talex-Touch cannot obtain authorization from ByteDance for them,
  so nothing derived from those weights — not the weights, not a fine-tune, not
  an extracted component — may be committed, published, or redistributed
  through this repository or shipped with Tuff. Only permissively licensed
  third-party weights (Whisper's MIT ggml files) and models Talex-Touch trains
  itself may appear here.
- Anything trained on a *restricted* corpus (for example AISHELL-2's research
  licence) inherits those restrictions: such a bundle must be marked
  `redistributable: false` and therefore cannot be published from this
  repository. `docs/training.md` spells out which corpora are safe.

## Published versions

| id | version | engine | license | default | notes |
| --- | --- | --- | --- | --- | --- |
| `tuff-asr-zh` | 0.1.0 | `whisper-cpp` | MIT | **yes** | [docs/versions/tuff-asr-zh-0.1.0.md](./docs/versions/tuff-asr-zh-0.1.0.md) |
| `tuff-asr-zh` | 0.2.0 | `whisper-cpp` | MIT | no | [docs/versions/tuff-asr-zh-0.2.0.md](./docs/versions/tuff-asr-zh-0.2.0.md) |
| `tuff-asr-zh-tiny` | 0.1.0 | `whisper-cpp` | MIT | no | [docs/versions/tuff-asr-zh-tiny-0.1.0.md](./docs/versions/tuff-asr-zh-tiny-0.1.0.md) |
| `whisper-base` | 1.0.0 | `whisper-cpp` | MIT | no | [docs/versions/whisper-base-1.0.0.md](./docs/versions/whisper-base-1.0.0.md) |
| `whisper-tiny` | 1.0.0 | `whisper-cpp` | MIT | no | [docs/versions/whisper-tiny-1.0.0.md](./docs/versions/whisper-tiny-1.0.0.md) |
| `sense-voice-small` | 1.0.0 | `sherpa-onnx` | Apache-2.0 | no | [docs/versions/sense-voice-small-1.0.0.md](./docs/versions/sense-voice-small-1.0.0.md) |

## Requirements

Node.js 18 or newer (for `fetch`, `node:fs/promises`, ESM). No dependencies, no
lockfile, no network access during `verify-catalog.mjs`.

A bundle also names the executable its engine needs on the host, exactly as a
descriptor names the weights: `whisper-cpp` bundles need `whisper-cli`, and
`sherpa-onnx` bundles need `sherpa-onnx-offline`. Tuff resolves that executable
before the user speaks and reports a missing one as unavailability rather than as
a decode failure. Publishing a bundle whose engine the runtime cannot drive is
therefore not a neutral act: it is a promise about an executable and a
recognizer family, which is why `sherpa-onnx` descriptors carry a required
`sherpa.family` and are rejected at load when this build cannot drive that family.