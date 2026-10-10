# `ai-media/asr/` — swappable speech-to-text backends (D-374)

One transcript contract, more than one model behind it.

| file | what it is |
|---|---|
| `base.py` | the contract: the `AsrBackend` Protocol, `BackendDescriptor` (incl. `max_word_secs`, D-375), `validate_body`, `check_language`, and B-174's shared offline model-path resolver |
| `whisper_mlx.py` | **the default.** `mlx-whisper` `large-v3` — today's implementation, moved here unchanged |
| `parakeet_mlx.py` | **opt-in.** `parakeet-tdt-0.6b-v3` via `parakeet-mlx` — 17.6× realtime, with its two measured defects fixed inside it |
| `__init__.py` | the name → backend registry (`get_backend`) |

## The boundary

A backend is handed **one already-prepared audio file** and returns the contract
body in **window-local seconds**:

```
{ text, language, segments: [ { start, end, text, words: [ {word, start, end, probability?} ] } ] }
```

It does **not** do any of: checking the path exists, cutting a window with
ffmpeg, shifting timestamps into absolute source seconds, flattening `words`,
adding `model` / `source` / `window`, or validating itself. All of that is
`../transcribe.py`, once, for every backend — which is what makes D-349's
windowing (the B-216 dark-region recovery primitive) work on a new backend for
free, and what keeps a backend small enough to be read against the one it
replaced.

Nothing above `transcribe.py` imports this package. `server.py`,
`apelles-ai`'s sidecar client, `editor_get_transcript`, the Recut panel and
`apelles-speech` all keep consuming exactly what they consume today — the
contract is `transcribe()`'s own long-standing return value, not a new one.

## Dependencies

`whisper_mlx` needs `mlx-whisper`; `parakeet_mlx` needs `parakeet-mlx`. Both
imports live **inside** the backend's `transcribe` method, so importing this
package pulls in neither, and the default path never requires `parakeet-mlx` to
be present. `ai-env/.venv` does not carry `parakeet-mlx` until
`ai-env/setup.sh --relock` is next run (see `docs/04-roadmap.md`, D-374 step 2).

## Adding a backend

1. A module here exposing `NAME`, `DESCRIPTOR` (a `BackendDescriptor`) and
   `BACKEND` (an instance satisfying `base.AsrBackend`), with its model import
   inside `transcribe`.
2. An entry in `__init__.py`'s `BACKENDS`.
3. Nothing else. `transcribe.py` does not learn the name, and
   `base.validate_body` enforces the contract on every call.

The descriptor's `max_word_secs` (D-375) is the one field that is not about the
seam: it is the too-long-word bound `crates/apelles-speech/src/dark.rs` must use
for *this* backend, read by `ai-media/harness/`'s VAD cross-check. Set it to
the model's own anomaly threshold for a decoder that can stretch a word across
a region it did not transcribe, and to `None` — "the bound does not apply" —
for one whose timings cannot stretch. Getting it wrong does not fail; it
returns a plausible-looking wrong list of dark regions.

If the new model's "words" are not words, or its own segmentation produces
utterances a retake detector cannot compare, **fix that here** — the whole
reason `parakeet_mlx.py` has two pure, unit-tested functions in it is that those
defects are the backend's to own, not the caller's to work around.

## Tests

No model required for either:

```
python3 ai-media/test_asr_seam.py        # the seam + the contract shape (step 1)
python3 ai-media/test_asr_parakeet.py    # the token→word merge + gap segmentation
```
