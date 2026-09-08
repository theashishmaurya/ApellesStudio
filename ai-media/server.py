"""Chroma media-understanding sidecar — local, MLX, Apple Silicon (D-189).

**What it is:** Chroma's *second* supervised Python sidecar. It answers the two
"understand this footage" questions the Edit tab needs and the app itself
cannot: what was SAID and when (`transcribe.py`, mlx-whisper large-v3), and
what CHANGED on screen and when (`video_understand.py`, ffmpeg scene-detect +
Qwen3-VL). Same FastAPI + supervised-subprocess shape as `ai/server.py`, one
more instance of a pattern that already works — not a new one.

**Why it is a separate process from `ai/server.py`** (D-189, and the whole
reason `docs/notes/media-understanding-sidecar-scope.md` exists): `ai/` is
PyTorch/MPS on `transformers<5`; this is MLX on `transformers>=5`. Installing
both stacks into one venv is not a matter of taste — the resolver silently
upgrades `transformers`/`tokenizers`/`numpy` out from under whichever package
got there first, which is exactly how a same-day prototype broke
`mlx-audiocraft` by installing `mlx-vlm` beside it. Two processes, two venvs,
two ports; no shared Python state at all. See D-189 for the spike evidence.

**What it does NOT do:** no `grade.json`, no timeline, no app state, no GPU
render path, no network (models are local; the VLM subprocess additionally
runs with `HF_HUB_OFFLINE=1`). It returns facts about a file on disk and
nothing else — deciding what to DO with a moment is the Edit tab's job.

**No model weights are ever resident in this process.** Every model call is a
subprocess (`transcribe.py` as a whole; `mlx_vlm.generate` from inside
`video_understand.py`), so the OS reclaims its multi-GB working set on exit.
That is deliberate: `ai/server.py` had to grow a TTL idle-unloader (D-084)
because its lazily-loaded singletons never released weights, and this design
makes that failure mode structurally impossible here rather than re-solving it.

Endpoints
  GET  /health                      -> {ok, sidecar, models, content_sha256, ffmpeg}
  POST /transcribe                  -> {job_id, state, ...}   (background job)
  GET  /transcribe/{job_id}         -> {state, result?, error?, ...}
  POST /understand_video            -> {job_id, state, ...}   (background job)
  GET  /understand_video/{job_id}   -> {state, result?, error?, ...}

**Why background jobs and not a plain synchronous POST** (D-189): the MCP
chain these results travel back through has a hard 20 s ceiling —
`chroma::control`'s `BRIDGE_TIMEOUT` (`app/src-tauri/src/chroma/control.rs`).
A transcript takes tens of seconds and a video analysis runs at roughly 4x
realtime, so a synchronous call could not reach an agent at all. Start-then-poll
is the shape `/track` and `/depth_track` in `ai/server.py` already use for the
same reason; this mirrors it, including the `{state, done, total}` status
fields.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import threading
import time
import uuid
from typing import Any, Optional

from fastapi import FastAPI
from pydantic import BaseModel

import transcribe as transcribe_mod
import video_understand as vu_mod
from errors import UserFacingError

app = FastAPI(title="chroma-ai-media")

# D-101's content-hash ownership check, applied to this sidecar too: a hash of
# this file's own bytes, so the Rust supervisor can tell "already running" from
# "already running, but a stale build" instead of trusting any 200 forever.
# Must stay byte-identical to `sha2::Sha256(..)[..8]` hex on the Rust side.
try:
    with open(__file__, "rb") as _f:
        _CONTENT_SHA256: Optional[str] = hashlib.sha256(_f.read()).hexdigest()[:16]
except OSError:
    _CONTENT_SHA256 = None

# One Apple GPU. Both capabilities are heavy MLX jobs; letting a transcript and
# a video analysis stack their working sets would page-thrash a 16 GB machine
# rather than run twice as fast. Same reasoning as `ai/server.py`'s `_GPU`,
# except here it also serialises across the two *different* model subprocesses.
_GPU = threading.Lock()

# job_id -> {kind, state, ...}. Bounded by `_MAX_JOBS` so a long-lived app
# session cannot accumulate finished job records forever (a real leak `ai/`'s
# own unbounded `_jobs` dict still has — not copied here).
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()
_MAX_JOBS = 64


def _new_job(kind: str, **fields: Any) -> str:
    job_id = kind[0] + uuid.uuid4().hex[:11]
    with _jobs_lock:
        if len(_jobs) >= _MAX_JOBS:
            # Drop the oldest FINISHED job. A running job is never evicted —
            # its poller would get "unknown" and never learn the outcome.
            finished = [
                (j["started"], jid)
                for jid, j in _jobs.items()
                if j.get("state") in ("done", "error")
            ]
            if finished:
                _jobs.pop(min(finished)[1], None)
        _jobs[job_id] = {
            "kind": kind,
            "state": "running",
            "started": time.time(),
            "elapsed_s": 0.0,
            **fields,
        }
    return job_id


def _finish(job_id: str, *, result: Any = None, error: str | None = None) -> None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None:
            return
        job["elapsed_s"] = round(time.time() - job["started"], 2)
        if error is not None:
            job["state"] = "error"
            job["error"] = error
        else:
            job["state"] = "done"
            job["result"] = result


def _snapshot(job_id: str) -> dict:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None:
            return {"state": "unknown", "error": f"no job {job_id}"}
        out = dict(job)
    if out.get("state") == "running":
        out["elapsed_s"] = round(time.time() - out["started"], 2)
    out.pop("started", None)
    return out


def _run_job(job_id: str, fn) -> None:
    """Every worker body: hold the GPU lock, run, record the outcome. A failure
    is recorded on the job (so the poller sees a real message) rather than
    raised into a daemon thread where nothing would ever read it.

    B-114 — a `UserFacingError` is recorded as its message ALONE. This string
    is what the Edit tab's own error line displays verbatim, so the class-name
    prefix below (right for an unexpected `KeyError`, where it is real
    diagnostic information) is exactly wrong for a fault we predicted and wrote
    a sentence about. See `errors.py`."""
    try:
        with _GPU:
            _finish(job_id, result=fn())
    except UserFacingError as e:
        _finish(job_id, error=str(e))
    except Exception as e:  # noqa: BLE001 — the job record IS the error channel
        _finish(job_id, error=f"{type(e).__name__}: {e}")


def _start(kind: str, fn, **fields: Any) -> dict:
    job_id = _new_job(kind, **fields)
    threading.Thread(target=_run_job, args=(job_id, fn), daemon=True).start()
    return {"job_id": job_id, **_snapshot(job_id)}


# --------------------------------------------------------------------------- #
# health
# --------------------------------------------------------------------------- #
@app.get("/health")
def health() -> dict:
    with _jobs_lock:
        running = sum(1 for j in _jobs.values() if j.get("state") == "running")
    return {
        "ok": True,
        "sidecar": "chroma-ai-media",
        "content_sha256": _CONTENT_SHA256,
        # ffmpeg is a hard requirement of BOTH capabilities (scene-detect and
        # the 16 kHz audio extract), and it is the one dependency that is not
        # in the venv — surface it here so a missing binary is visible in the
        # Settings status card instead of only as a job failure later.
        "ffmpeg": shutil.which("ffmpeg"),
        "models": {
            "transcribe": transcribe_mod.MLX_MODEL_REPOS[transcribe_mod.DEFAULT_MODEL],
            "understand_video": vu_mod.MODEL,
        },
        "jobs_running": running,
    }


# --------------------------------------------------------------------------- #
# /transcribe  — "what was said, and when"
# --------------------------------------------------------------------------- #
class TranscribeReq(BaseModel):
    path: str
    language: Optional[str] = None
    word_timestamps: bool = True
    model: str = transcribe_mod.DEFAULT_MODEL


@app.post("/transcribe")
def start_transcribe(req: TranscribeReq) -> dict:
    if not os.path.exists(req.path):
        return {"error": f"file not found: {req.path}"}
    if req.model not in transcribe_mod.MLX_MODEL_REPOS:
        return {"error": f"unknown model {req.model!r} — one of {', '.join(sorted(transcribe_mod.MLX_MODEL_REPOS))}"}

    return _start(
        "transcribe",
        lambda: transcribe_mod.transcribe(
            req.path,
            model=req.model,
            language=req.language,
            word_timestamps=req.word_timestamps,
        ),
        path=req.path,
    )


@app.get("/transcribe/{job_id}")
def transcribe_status(job_id: str) -> dict:
    return _snapshot(job_id)


# --------------------------------------------------------------------------- #
# /understand_video  — "what changed on screen, and when"
# --------------------------------------------------------------------------- #
class UnderstandReq(BaseModel):
    path: str
    question: str = vu_mod.DEFAULT_QUESTION
    scene_threshold: float = 0.12
    min_gap_s: float = 1.0
    max_candidates: int = 15
    max_tokens: int = 800


@app.post("/understand_video")
def start_understand_video(req: UnderstandReq) -> dict:
    if not os.path.exists(req.path):
        return {"error": f"file not found: {req.path}"}
    if req.max_candidates < 1:
        return {"error": "max_candidates must be >= 1"}

    return _start(
        "understand",
        lambda: vu_mod.understand_video(
            req.path,
            question=req.question,
            scene_threshold=req.scene_threshold,
            min_gap_s=req.min_gap_s,
            max_candidates=req.max_candidates,
            max_tokens=req.max_tokens,
        ),
        path=req.path,
    )


@app.get("/understand_video/{job_id}")
def understand_video_status(job_id: str) -> dict:
    return _snapshot(job_id)
