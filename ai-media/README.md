# `ai-media/` — Apelles media-understanding sidecar (D-189)

Local FastAPI service on **MLX** (Apple Silicon). Answers the two "understand
this footage" questions the app itself can't:

| | |
|---|---|
| **what was SAID, and when** | `transcribe.py` — mlx-whisper `large-v3`, word-level timings |
| **what CHANGED on screen, and when** | `video_understand.py` — ffmpeg scene-detect for the timing + Qwen3-VL-4B for the description |

Nothing here touches the network (models are local; the VLM subprocess runs
with `HF_HUB_OFFLINE=1`), `grade.json`, or the timeline. It returns facts about
a file on disk; deciding what to *do* with a moment is the Edit tab's job.

**The two are complementary, not interchangeable.** `transcribe` finds nothing
in silent/music-only footage; `understand_video` finds nothing in a single
continuous uncut shot (a talking head has no visual delta to key off). Pick by
what's being asked.

## Why this is a second sidecar and not more endpoints on `ai/`

`ai/` is PyTorch/MPS pinned to `transformers<5` (ViTMatte). This is MLX, and
`mlx-vlm>=0.6` requires `transformers>=5.5`. `pip install -r ai/requirements.txt
-r ai-media/requirements.txt` is a literal **`ResolutionImpossible`** — verified,
not assumed (D-189). Two processes, two venvs, two ports, no shared Python
state. Same supervised-subprocess pattern, one more instance of it.

## Run

The app starts this for you (`apelles_ai::sidecar`, same supervisor as `ai/`).
Set the venv up once:

```
cd ai-media && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

Manual start still works for standalone testing — the supervisor detects an
already-running sidecar and monitors it instead of spawning a second:

```
./run.sh                 # -> http://127.0.0.1:8766  (CHROMA_AI_MEDIA_PORT to change)
```

Env vars, mirroring `ai/`'s exactly: `CHROMA_AI_MEDIA_DIR`,
`CHROMA_AI_MEDIA_PYTHON`, `CHROMA_AI_MEDIA_PORT`, `CHROMA_AI_MEDIA_NO_SPAWN`.
Lifecycle details: `docs/notes/sidecar-lifecycle.md`.

Also needs `ffmpeg` on `PATH` (both capabilities use it). `GET /health` reports
where it found it, or `null`.

## Endpoints

Both capabilities are **background jobs**, not synchronous calls: a transcript
takes tens of seconds and an analysis runs at roughly 4x realtime, while
`chroma::control`'s bridge has a hard 20 s ceiling. Start, then poll — the same
shape `ai/`'s `/track` and `/depth_track` already use.

| | |
|---|---|
| `GET /health` | `{ok, sidecar, models, content_sha256, ffmpeg, jobs_running}` |
| `POST /transcribe` | `{path, language?, word_timestamps?, model?}` → `{job_id, state, ...}` |
| `GET /transcribe/{job_id}` | `{state, elapsed_s, result?, error?}` |
| `POST /understand_video` | `{path, question?, scene_threshold?, min_gap_s?, max_candidates?, max_tokens?}` → `{job_id, state, ...}` |
| `GET /understand_video/{job_id}` | `{state, elapsed_s, result?, error?}` |

`state` is `running` · `done` · `error` · `unknown`.

### `/transcribe` result

```jsonc
{
  "text": "...",                    // the whole transcript
  "language": "en", "model": "large-v3", "source": "/abs/path.mp4",
  "segments": [{ "start": 0.0, "end": 4.2, "text": "...",
                 "words": [{ "word": " want", "start": 0.0, "end": 0.24 }] }],
  "words":    [ /* the same words, flattened across every segment */ ]
}
```

### `/understand_video` result

```jsonc
{
  "video": "/abs/path.mp4", "question": "...",
  "events": [{ "time_s": 1.33, "event": "A white fabric cutout is placed..." }],
  "_meta": { "model": "...", "scene_threshold": 0.12, "min_gap_s": 1.5,
             "max_candidates": 5, "candidates": 5, "truncated": true }
}
```

`time_s` **always** comes from ffmpeg, never the model — see
`video_understand.py`'s module doc for why that split is the whole design.
`truncated: true` means candidates were dropped at the cap: raise
`max_candidates` and re-run.

`scene_threshold` / `min_gap_s` / `max_candidates` are **content-dependent** and
deliberately exposed rather than hardcoded. The defaults were tuned against a
slow screen recording; a fast-cut ad or trailer has far more real cuts per
second than that.

## Models

| Model | Job | Size |
|---|---|---|
| `mlx-community/whisper-large-v3-mlx` | transcript | ~2.9 GB |
| `mlx-community/Qwen3-VL-4B-Instruct-4bit` | frame-pair description | ~2.9 GB |

Qwen3-VL **4B, not 2B** — 2B was tested on real footage and produced garbage
(hallucinated/truncated output). 4B is the empirical floor for usable quality.

**No model weights are ever resident in this process.** Every model call is a
subprocess, so the OS reclaims its multi-GB working set on exit. `ai/server.py`
had to grow a TTL idle-unloader (D-084) because its lazy singletons never
released weights; this design makes that failure mode structurally impossible
here instead of re-solving it. The cost is a model reload per call (seconds),
which is noise against a multi-minute job.

## Known limit (real, documented, not yet mitigated)

Sustained action within one shot produces **semantically repetitive**
descriptions — the model correctly describing genuinely similar frames
similarly. Not fixable by sampling params (2026 LLM-repetition research:
n-gram/penalty fixes work on token identity, not semantic content). Mitigation,
not built: raise `min_gap_s` for action-heavy footage, or post-filter
near-duplicate descriptions by text similarity.
