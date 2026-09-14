# `apelles-speech`

**What was said, and where nobody said anything.** (D-318)

The analysis half of "clean up a talking-head recording": find the dead air, and
find the retakes.

| module | question it answers | how |
|---|---|---|
| `vad` | is anyone talking, right now? | silero-vad v6.2.1 ONNX (D-319), 16 kHz mono, one probability per 512-sample hop |
| `silence` | where are the gaps worth cutting? | hysteresis over those probabilities → spans in seconds |
| `retake` | did they say this line already? | normalised edit distance + containment over transcript text (D-320) |

## The boundary

**In:** decoded PCM (`&[f32]`, mono, 16 kHz) and transcript utterances.
**Out:** candidate spans and groups, in **seconds**.

That is the whole surface, and every exclusion below is deliberate:

- **It never cuts anything.** Both detectors are read-only. They return
  candidates; applying one is the timeline's job, through the split / remove /
  ripple ops that already existed. Apelles is not an auto-editor
  (`docs/00-vision.md`), and retake grouping has an honest false positive that
  is fine in a suggestion and unforgivable in a deletion.
- **It never reads a file.** No ffmpeg, no symphonia, no paths except the
  model's. `apelles-media::audio::decode_mono_at_rate` does the decoding and
  resampling; the frontend store owns the transcript cache.
- **It knows nothing about timelines.** No fps, no frames, no clips. Converting
  a span to a clip's source frames needs a timeline, so the op layer does it.

Taking `&[f32]` rather than a path is what makes the tests real: the hysteresis,
the grouping and every threshold are exercised against fixtures with
known-correct answers, with no model in the loop.

## Layer

L2, alongside `apelles-timeline`. Depends on `serde`, `thiserror`, `ort` +
`ndarray` (the workspace's existing ONNX stack) and `strsim`. It deliberately
does **not** depend on `apelles-media` — nothing here decodes.

## The model file

Not bundled. `MODEL_URL` / `MODEL_FILENAME` / `MODEL_SHA256` in `vad.rs` name
the exact artifact — silero-vad's own released ONNX at a pinned upstream tag —
and the app fetches and verifies it lazily on first use, by the same pattern
`ai_processing.rs` uses for the other seven ONNX models.

**The 64-sample context prefix is mandatory and getting it wrong is silent.**
v6 fed a bare 512-sample window returns probabilities pinned near 0.001, so the
entire clip reads as silence. See `vad.rs`'s module doc for the measured table,
and D-319 for why the version is pinned.

## Tests

```sh
cargo test -p apelles-speech
```

33 tests, no model required — `tests/real_model_output.rs` replays a probability
track captured from the real model over a real speech clip.

The one test that *does* drive the model is `#[ignore]`d, because it needs the
downloaded artifact and a located ONNX Runtime library (and see **B-187** for
the teardown abort that makes it unfit for an unattended run):

```sh
ORT_DYLIB_PATH=app/src-tauri/resources/libonnxruntime.dylib \
APELLES_SILERO_MODEL=/path/to/silero_vad_v6.2.1.onnx \
APELLES_SILERO_PCM=/path/to/clip.f32 \
  cargo test -p apelles-speech --test silero_live -- --ignored --nocapture
```

`ffmpeg -i clip.wav -f f32le -ac 1 -ar 16000 clip.f32` produces the PCM.
