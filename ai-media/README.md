# `ai-media/` — Apelles media-understanding sidecar (D-189)

Local FastAPI service on **MLX** (Apple Silicon). Answers the two "understand
this footage" questions the app itself can't:

| | |
|---|---|
| **what was SAID, and when** | `transcribe.py` — word-level timings, over a swappable ASR backend seam (`asr/`, D-374): `parakeet-tdt-0.6b-v3`, the only backend since Whisper was decommissioned (D-381). 25 European languages; **Hindi/Hinglish unsupported** |
| **what CHANGED on screen, and when** | `video_understand.py` — ffmpeg scene-detect for the timing + Qwen3-VL-4B for the description |
| **where a transcript is UNSURE** | `harness/` — a pipeline of checks over the transcript contract (D-374 step 3 / D-375). No model, no backend, no audio: it annotates a transcript it is handed. Not wired to an endpoint yet — see its README |

A transcript is **deterministic**: Parakeet decodes greedily, so the same file
gives byte-identical output with no seed (D-349's Whisper seed went with
Whisper, D-381).

**A whole-file transcript is checked for speech it left unread** (B-287,
D-420). Parakeet is chunked at 40 s with 8 s of overlap (120/15 s until D-420,
which silently dropped ~1.5 min of a 9:28 voiceover); after every whole-file
pass `asr_coverage.py` finds each gap between words of 2 s or more whose audio
sounds like speech (100 ms RMS frames against the file's own loud reference),
`transcribe.check_coverage` re-reads it in isolation with 10 s of context and
splices what it hears into the transcript (segments marked `recovered`), and
the result records `coverage: {checked, recovered, unread}` — `unread` being
stretches still without a word, which the Edit tab's word view flags. A
window of 60 s or less is a re-read and is not checked; a longer one (the
Clipper's 5-minute windows) is checked over its own range. Tests: `test_asr_coverage.py` (pure + a scripted backend over real
ffmpeg audio), `test_transcribe_coverage_live.py` (opt-in, a real source and
the real model).

Nothing here touches the network (models are local; the VLM subprocess runs
with `HF_HUB_OFFLINE=1`, always — D-354), `grade.json`, or the timeline. It
returns facts about a file on disk; deciding what to *do* with a moment is the
Edit tab's job.

**The two are complementary, not interchangeable.** `transcribe` finds nothing
in silent/music-only footage; `understand_video` finds nothing in a single
continuous uncut shot (a talking head has no visual delta to key off). Pick by
what's being asked.

## Why this is a second sidecar and not more endpoints on `ai/`

**Two processes — for crash isolation and independent idle-unload.** A torch
segfault in matting must not take transcription down with it, and D-084 has each
sidecar freeing its own multi-GB model on its own timer, which is a property of
separate processes. That reasoning is unchanged and is why this directory exists.

**One environment, though, since D-314.** The original answer here was a
dependency conflict: `ai/` pinned `transformers<5` for ViTMatte, `mlx-vlm>=0.6`
needs `transformers>=5.5`, and installing both requirement files together was a
literal `ResolutionImpossible` (D-189). That `<5` turned out to be a defensive pin
that was never re-tested — ViTMatte produces a real matte on `transformers` 5.x,
and the union now installs cleanly. Both sidecars share `ai-env/.venv`, which took
3.5 GB of venvs down to 1.8 GB. Still two processes, two ports, no shared Python
state — just one `site-packages`. See D-314 and `ai-env/README.md`.

## Run

The app starts this for you (`apelles_ai::sidecar`, same supervisor as `ai/`).
Set the environment up once — the same command covers both sidecars:

```
./ai-env/setup.sh
```

Manual start still works for standalone testing — the supervisor detects an
already-running sidecar and monitors it instead of spawning a second:

```
./run.sh                 # -> http://127.0.0.1:8766  (CHROMA_AI_MEDIA_PORT to change)
```

Env vars, mirroring `ai/`'s exactly: `CHROMA_AI_MEDIA_DIR`,
`CHROMA_AI_MEDIA_PYTHON`, `CHROMA_AI_MEDIA_PORT`, `CHROMA_AI_MEDIA_NO_SPAWN`.
Lifecycle details: `docs/notes/sidecar-lifecycle.md`.

Also needs `ffmpeg` (both capabilities use it), run through `ffmpeg_bin.py`:
`CHROMA_FFMPEG` if set — the app's supervisor always sets it to the binary the
app itself resolved, normally the copy bundled in Apelles.app (D-389) — else
`ffmpeg` on `PATH` (standalone/CLI/tests; `brew install ffmpeg`). `GET /health`
reports which one, or `null`.

## Endpoints

Both capabilities are **background jobs**, not synchronous calls: a transcript
takes tens of seconds and an analysis runs at roughly 4x realtime, while
`chroma::control`'s bridge has a hard 20 s ceiling. Start, then poll — the same
shape `ai/`'s `/track` and `/depth_track` already use.

| | |
|---|---|
| `GET /health` | `{ok, sidecar, models, content_sha256, ffmpeg, jobs_running}` |
| `POST /transcribe` | `{path, language?, word_timestamps?, model?, start_secs?, duration_secs?}` → `{job_id, state, ...}`. `model` defaults to, and must be one of, the default backend's (`parakeet-tdt-0.6b-v3`); a `language` outside Parakeet's 25 is refused as a job error sentence |
| `GET /transcribe/{job_id}` | `{state, elapsed_s, result?, error?}` |
| `POST /understand_video` | `{path, question?, scene_threshold?, min_gap_s?, max_candidates?, max_tokens?}` → `{job_id, state, ...}` |
| `GET /understand_video/{job_id}` | `{state, elapsed_s, result?, error?}` |

`state` is `running` · `done` · `error` · `unknown`.

### `/transcribe` result

```jsonc
{
  "text": "...",                    // the whole transcript
  "language": "en", "model": "parakeet-tdt-0.6b-v3", "source": "/abs/path.mp4",
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

| Model | Job | Size | Fetched |
|---|---|---|---|
| `mlx-community/parakeet-tdt-0.6b-v3` | transcript | ~2.3 GB | implicitly, on first use — or ahead of time, for offline use, by `ai-env/setup.sh --fetch-models` |
| `mlx-community/Qwen3-VL-4B-Instruct-4bit` | frame-pair description | ~2.9 GB | **explicitly only** — `ai-env/setup.sh --fetch-models` |

`mlx-community/whisper-large-v3-mlx` was the transcript model until D-381. Its
weights are **not deleted** from an existing HF cache — nothing in Apelles
removes a user's cached models; delete `~/.cache/huggingface/hub/models--mlx-community--whisper-large-v3-mlx`
by hand to reclaim ~2.9 GB.

Qwen3-VL **4B, not 2B** — 2B was tested on real footage and produced garbage
(hallucinated/truncated output). 4B is the empirical floor for usable quality.

**Qwen3-VL is never pulled implicitly (B-172/D-354).** Its subprocess runs
with `HF_HUB_OFFLINE=1` unconditionally — correct per this repo's local-first
rule, since an agent calling `/understand_video` must never be the thing that
silently kicks off a ~2.9 GB download. Run `ai-env/setup.sh --fetch-models`
once (network on, on purpose, for that one command); after that every real
call stays fully offline. Calling `/understand_video` before that step fails
fast with a message naming that exact command, not an opaque subprocess dump.

**No model weights are ever resident in this process.** Every model call is a
subprocess, so the OS reclaims its multi-GB working set on exit. `ai/server.py`
had to grow a TTL idle-unloader (D-084) because its lazy singletons never
released weights; this design makes that failure mode structurally impossible
here instead of re-solving it. The cost is a model reload per call (seconds),
which is noise against a multi-minute job.

The transcribe path only started obeying that rule in **D-322** — it was an
ordinary in-process function call until then, and leaked every job's GPU
memory into the server (B-189). If you are checking this claim yourself, use
`footprint <pid>`, not `ps`/`top`: the leak was ~4 GB per job in
`IOAccelerator (graphics)` while RSS read ~35 MB.

## Known limit (real, documented, not yet mitigated)

Sustained action within one shot produces **semantically repetitive**
descriptions — the model correctly describing genuinely similar frames
similarly. Not fixable by sampling params (2026 LLM-repetition research:
n-gram/penalty fixes work on token identity, not semantic content). Mitigation,
not built: raise `min_gap_s` for action-heavy footage, or post-filter
near-duplicate descriptions by text similarity.
