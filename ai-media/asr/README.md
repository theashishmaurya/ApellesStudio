# `ai-media/asr/` — the swappable speech-to-text seam (D-374, D-381)

One transcript contract, with the model behind it swappable.

| file | what it is |
|---|---|
| `base.py` | the contract: the `AsrBackend` Protocol, `BackendDescriptor` (incl. `model_repos` and `max_word_secs`, D-375), `validate_body`, `check_language`, and B-174's offline model-path resolver |
| `parakeet_mlx.py` | **the default and only backend** (D-381). `parakeet-tdt-0.6b-v3` via `parakeet-mlx` — ~25× realtime end-to-end, with its three measured defects fixed inside it (D-374, D-376) |
| `__init__.py` | the name → backend registry (`get_backend`) |

**Whisper was decommissioned on 2026-10-13 (D-381).** `whisper_mlx.py` — the
`mlx-whisper large-v3` backend that was the default from D-189 until then — is
deleted, and with it D-349's `MLX_RANDOM_SEED` (Parakeet's greedy TDT decoding
draws from no RNG; two runs of a real source are byte-identical). The seam is
kept on purpose: it is what lets the next backend be added without touching
anything above `transcribe.py`.

**Languages.** Parakeet covers 25 European languages. **Hindi and Hinglish
sources are unsupported** (D-381): a caller that names a language outside the
set is refused with a sentence; one that names none gets fluent, wrong English
on such a source, because Parakeet reports no detected language to refuse on.

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
windowing (the dark-region recovery primitive, and the harness's multi-pass
offsets) work on any backend for free, and what keeps a backend small.

Nothing above `transcribe.py` imports this package except `server.py`, which
reads the default backend's descriptor for `/health` and for `/transcribe`'s
`model` default and validation. `apelles-ai`'s sidecar client,
`editor_get_transcript`, the Recut panel and `apelles-speech` consume the
contract — `transcribe()`'s own long-standing return value — and nothing else.

## Dependencies

`parakeet_mlx` needs `parakeet-mlx` (pinned in `../requirements.txt`, locked in
`ai-env/requirements.lock.txt`, import-checked by `ai-env/verify.py`). The
import lives **inside** the backend's `transcribe`, so importing this package
pulls in nothing and every model-free test runs on a plain `python3`. A venv
that predates D-381 and has not picked up the new lock yet gets a sentence
naming the fix (`ai-env/setup.sh`, or relaunch with network), not a
`ModuleNotFoundError`.

## Adding a backend

1. A module here exposing `NAME`, `DESCRIPTOR` (a `BackendDescriptor`) and
   `BACKEND` (an instance satisfying `base.AsrBackend`), with its model import
   inside `transcribe`.
2. An entry in `__init__.py`'s `BACKENDS`.
3. A mirrored `BackendProfile` in `../harness/profiles.py` —
   `test_harness_pipeline.py` fails until it matches the descriptor.
4. Its package in `../requirements.txt`, a relock, and a `verify.py` check if it
   becomes the default.

`transcribe.py` does not learn the name, and `base.validate_body` enforces the
contract on every call.

The descriptor's `max_word_secs` (D-375) is the one field that is not about the
seam: it is the too-long-word bound `crates/apelles-speech/src/dark.rs` must use
for *this* backend, read by `ai-media/harness/`'s VAD cross-check. Set it to
the model's own anomaly threshold for a decoder that can stretch a word across
a region it did not transcribe (mlx-whisper's was 2.0 s), and to `None` — "the
bound does not apply" — for one whose timings cannot stretch (Parakeet).
Getting it wrong does not fail; it returns a plausible-looking wrong list of
dark regions.

If the new model's "words" are not words, or its own segmentation produces
utterances a retake detector cannot compare, **fix that here** — the whole
reason `parakeet_mlx.py` has two pure, unit-tested functions in it is that those
defects are the backend's to own, not the caller's to work around.

## Tests

No model required:

```
python3 ai-media/test_asr_seam.py        # the seam over a stub + Parakeet's glue against a stubbed parakeet_mlx
python3 ai-media/test_asr_parakeet.py    # the token→word merge + gap segmentation
```
