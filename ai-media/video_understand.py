#!/usr/bin/env python3
"""Video content understanding — "what changed on screen, and when" (D-189).

**What it is:** the video-understanding half of Chroma's media sidecar. Given a
video path and an open-ended question, it returns a list of
`{time_s, event}` — real content moments with EXACT, frame-accurate
timestamps and a natural-language description of what changed at each.

**What it does NOT do:** it does not touch `grade.json`, the timeline, or any
app state; it does not decide what to do with a moment (cut, mark, search) —
that is the Edit tab's job. It does not answer "what was SAID" — that is
`transcribe.py`, a genuinely different question (see below). It makes no
network calls beyond a first-run model download (`HF_HUB_OFFLINE=1` is set on
the model subprocess, so a cached model never reaches the network at all).

Ported verbatim — logic, tuning and all — from the validated prototype at
`~/my_projects/videoAgent/src/review/video_understand.py` (D-189; the scope is
`docs/notes/media-understanding-sidecar-scope.md`). Everything below this line
is that module's own hard-won design, restated because it is the reason the
code looks the way it does. Do not "simplify" any of it without re-validating
against real footage.

**Timing design — the part that actually matters.** Asking the model to
self-report `time_s` from a stack of N sampled frames does NOT work: tested
live against real screen recordings, it produced out-of-order and
implausibly-precise numbers (e.g. "12.5678943") alongside otherwise-correct
event descriptions. VLMs describe what they see well and re-derive elapsed
time from a frame's position in a stack badly. So the model is never asked for
a timestamp. Instead:
  1. ffmpeg's own scene-change filter finds candidate moments deterministically
     and frame-accurately (`detect_scene_changes`) — classical CV, not a model
     guess. This is the "when," and it is exact.
  2. Qwen3-VL is only asked to DESCRIBE what changed at each already-known
     timestamp (`describe_frames`, one batched multi-image call) — the "what,"
     which is what VLMs are actually good at.
  3. The two are zipped together; `time_s` always comes from ffmpeg.

Trade-off, stated rather than hidden: a genuine change with very little
pixel-level delta (a subtle colour shift with no motion) can fall below the
scene-change threshold and be missed. Lower `scene_threshold` if something
real is being missed.

Validated live across 4 real content types before shipping (not assumed):
  - Screen recording (clicks/spinners/toasts): works well; the designed-for case.
  - Talking-head raw take (one continuous, mostly-static shot): correctly finds
    almost nothing — there IS no scene change to key off. Use `transcribe.py`
    (word-level, what was SAID) for that content; this is the wrong tool for
    it, not a broken one.
  - Short ad, one continuous shot + subtle human motion: scene-detect picks up
    posture/gesture micro-changes reasonably, clean varied descriptions.
  - Movie trailer (sustained action): candidates stayed under the cap, but
    descriptions degenerated into SEMANTIC repetition — near-identical
    sentences alternating across ~15 consecutive candidates, because the
    underlying frames genuinely ARE visually similar during sustained motion,
    not because sampling params failed. A real, known limit (2026
    LLM-repetition research: n-gram/penalty fixes work on token identity, not
    semantic content). Mitigation, not built: raise `min_gap_s` for
    action-heavy footage, or post-filter near-duplicate descriptions.

Model: `mlx-community/Qwen3-VL-4B-Instruct-4bit` — Apache-2.0, MLX-native,
built for temporal grounding (`docs/notes/video-search.md` vetted it for
exactly this job). The 2B variant is smaller/faster but was tested and
produced garbage (hallucinated/truncated output) — 4B is the empirical floor
for usable quality.

Sampling params are Qwen's own team-recommended config for the Instruct
variant (temperature 0.7 / top_p 0.8 / top_k 20 / repetition_penalty 1.0 /
presence_penalty 1.5), not ad-hoc tuning. Greedy decoding (temperature 0 or
unset) reliably degenerates into a repeated-phrase loop on real screen
recordings — never use it.

**Why the model runs as a SUBPROCESS and not in-process** (D-189): a call
peaks around 9 GB. `ai/server.py` had to grow a whole TTL idle-unloader
(D-084) because its lazily-loaded singletons never released weights. Spawning
`python -m mlx_vlm.generate` per call means the OS reclaims every byte on
exit, so this sidecar's idle footprint stays at roughly the FastAPI process
itself — the D-084 problem cannot recur here. It also keeps the invocation
byte-for-byte identical to the validated prototype's, whose tuning is
expressed as those exact CLI flags.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

MODEL = "mlx-community/Qwen3-VL-4B-Instruct-4bit"

DEFAULT_QUESTION = "What is happening in this frame? Be specific and concrete."

# Qwen team's own recommended Instruct-variant sampling — see the module doc.
SAMPLING_ARGS = [
    "--temperature", "0.7",
    "--top-p", "0.8",
    "--top-k", "20",
    "--repetition-penalty", "1.0",
    "--presence-penalty", "1.5",
]

# Local-first (a Chroma project invariant): a cached model must never trigger a
# network round-trip just to revalidate itself.
_ENV_OFFLINE = {**os.environ, "HF_HUB_OFFLINE": "1"}

# ffmpeg's scene-diff filter needs a PRIOR frame to compare against, so it
# structurally cannot flag frame 0 as a change — no threshold fixes that, it is
# a blind spot at the boundary, not a sensitivity problem. A recording's own
# opening moment is worth checking regardless (tested live: the very first
# click in the prototype's test footage was invisible to scene-diff for exactly
# this reason), so it is always seeded as a candidate.
SEED_CANDIDATE_S = 0.5


def detect_scene_changes(
    video_path: str,
    threshold: float = 0.12,
    min_gap_s: float = 1.0,
    max_candidates: int = 15,
) -> list[float]:
    """Real, frame-accurate "when" via ffmpeg's own scene-change filter —
    classical CV, deterministic, no model guess. `showinfo` on stderr logs
    `pts_time:<seconds>` for every frame the `select` filter passes through; a
    higher `scene` score means a bigger frame-to-frame delta. `threshold=0.12`
    was tuned empirically against real screen recordings (a genuine
    click/spinner/toast clears it; sub-pixel encoder noise mostly does not) —
    lower it if a real change is being missed. `min_gap_s` merges
    near-duplicate detections (e.g. a multi-frame animated transition) into one
    candidate at its first frame."""
    cmd = [
        "ffmpeg", "-i", video_path,
        "-vf", f"select='gt(scene,{threshold})',showinfo",
        "-f", "null", "-",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    times = [float(m) for m in re.findall(r"pts_time:(\d+\.?\d*)", result.stderr)]
    times.sort()

    merged: list[float] = []
    for t in times:
        if not merged or t - merged[-1] >= min_gap_s:
            merged.append(t)
    return merged[:max_candidates]


def extract_frame_at(video_path: str, time_s: float, out_path: str) -> None:
    cmd = [
        "ffmpeg", "-y", "-ss", str(time_s), "-i", video_path,
        "-frames:v", "1", "-q:v", "3", out_path,
    ]
    subprocess.run(cmd, capture_output=True, check=True)


def describe_frames(
    video_path: str,
    times: list[float],
    question: str,
    max_tokens: int,
    pair_offset: float = 0.4,
    timeout_s: int = 900,
) -> list[str]:
    """One batched multi-image `mlx_vlm.generate` call. A SINGLE static frame at
    a detected scene-change instant does not actually show the event — it shows
    one moment's static content, and a model asked about it in isolation
    reliably answered "no UI event detected" (tested live) because there is
    nothing to compare against: a click, a spinner starting, a toast appearing
    are all DELTAS, not states. So each candidate becomes a before/after PAIR
    (`pair_offset` seconds either side of the detected timestamp) and the model
    is asked what CHANGED — the same comparison ffmpeg's own scene-diff made,
    handed to the model explicitly instead of hoped for unprompted.

    Every candidate's known timestamp is spelled out in the prompt (so the
    model never has to infer it), and it is asked for one description per PAIR,
    in order, as a JSON array of strings — `time_s` is zipped back in from
    `times` afterward, never taken from the model."""
    with tempfile.TemporaryDirectory() as tmp:
        image_paths: list[str] = []
        for i, t in enumerate(times):
            before = str(Path(tmp) / f"pair_{i:03d}_before.jpg")
            after = str(Path(tmp) / f"pair_{i:03d}_after.jpg")
            extract_frame_at(video_path, max(0.0, t - pair_offset), before)
            extract_frame_at(video_path, t + pair_offset, after)
            image_paths += [before, after]

        labeled_times = ", ".join(f"pair {i + 1} (around {t:.2f}s)" for i, t in enumerate(times))
        prompt = (
            f"You are shown {len(times)} BEFORE/AFTER image pairs from a video, in chronological order: "
            f"{labeled_times}. Each pair's two images are consecutive: image {{2k-1}} is BEFORE, image {{2k}} "
            f"is AFTER, for pair k. For EACH pair, answer: what changed between BEFORE and AFTER? {question} "
            f"Respond with a JSON array of exactly {len(times)} strings, one per pair, in the same order "
            f"— no markdown, no prose outside the JSON array."
        )

        cmd = [sys.executable, "-m", "mlx_vlm.generate", "--model", MODEL]
        for p in image_paths:
            cmd += ["--image", p]
        cmd += ["--prompt", prompt, *SAMPLING_ARGS, "--max-tokens", str(max_tokens)]

        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout_s, env=_ENV_OFFLINE
        )
        if result.returncode != 0:
            raise RuntimeError(f"mlx_vlm.generate failed: {result.stderr[-2000:]}")
        return extract_json(result.stdout)


def extract_json(raw: str):
    """`mlx_vlm.generate`'s stdout is the model's raw text, often fenced in
    ```json ... ``` and sometimes followed by trailing prose after the JSON
    (tested live: a "Note: ..." explanation after a perfectly valid array —
    `json.loads` rejects that as "Extra data" even though the JSON itself was
    fine). Strip fences, then `raw_decode` from the first `[`/`{` so trailing
    text after a complete, valid JSON value is ignored rather than failing the
    whole call. Raises with the raw text attached on failure rather than
    swallowing it — a malformed response is exactly what a caller needs to see
    in order to retry or adjust."""
    text = raw.strip()
    if "```" in text:
        for part in text.split("```"):
            part = part.strip()
            if part.startswith("json"):
                part = part[4:].strip()
            if part.startswith("[") or part.startswith("{"):
                text = part
                break

    start = next((i for i, c in enumerate(text) if c in "[{"), None)
    if start is None:
        raise ValueError(f"model output contained no JSON: {raw[:500]!r}")
    try:
        value, _ = json.JSONDecoder().raw_decode(text[start:])
        return value
    except json.JSONDecodeError as e:
        raise ValueError(f"model output wasn't valid JSON ({e}): {raw[:500]!r}") from e


def understand_video(
    video_path: str,
    question: str = DEFAULT_QUESTION,
    scene_threshold: float = 0.12,
    min_gap_s: float = 1.0,
    max_candidates: int = 15,
    max_tokens: int = 800,
) -> dict:
    """The whole pipeline: ffmpeg scene-detect → before/after pairs → one
    batched VLM call → `{video, question, events: [{time_s, event}], _meta}`.

    `scene_threshold` / `min_gap_s` / `max_candidates` are CONTENT-DEPENDENT
    and deliberately exposed rather than hardcoded: the defaults were tuned
    against a slow screen recording, and a fast-cut ad or trailer has far more
    real cuts per second than that. When `_meta.candidates == max_candidates`
    the result was silently truncated — that is the signal to raise the cap and
    re-run, which is why the count is reported."""
    if not Path(video_path).exists():
        raise FileNotFoundError(video_path)

    times = detect_scene_changes(video_path, scene_threshold, min_gap_s, max_candidates)

    if not times or times[0] - SEED_CANDIDATE_S >= min_gap_s:
        times = [SEED_CANDIDATE_S] + times

    descriptions = describe_frames(video_path, times, question, max_tokens)
    if len(descriptions) != len(times):
        raise ValueError(
            f"model returned {len(descriptions)} descriptions for {len(times)} frames "
            "— expected a 1:1 match"
        )

    events = [{"time_s": round(t, 2), "event": d} for t, d in zip(times, descriptions)]
    return {
        "video": video_path,
        "question": question,
        "events": events,
        "_meta": {
            "model": MODEL,
            "scene_threshold": scene_threshold,
            "min_gap_s": min_gap_s,
            "max_candidates": max_candidates,
            "candidates": len(times),
            "truncated": len(times) >= max_candidates,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Find real content moments in a video with reliable timestamps (Qwen3-VL, local MLX)"
    )
    parser.add_argument("--video", required=True, help="Path to the video file")
    parser.add_argument("--question", default=DEFAULT_QUESTION, help="What to ask about each detected moment")
    parser.add_argument("--scene-threshold", type=float, default=0.12, help="ffmpeg scene-change sensitivity (lower = more candidates)")
    parser.add_argument("--min-gap-s", type=float, default=1.0, help="Merge candidates closer together than this")
    parser.add_argument("--max-candidates", type=int, default=15, help="Cap on detected moments sent to the model")
    parser.add_argument("--max-tokens", type=int, default=800, help="Max output tokens")
    parser.add_argument("--output", default=None, help="Save JSON to this path")
    args = parser.parse_args()

    result = understand_video(
        args.video,
        args.question,
        args.scene_threshold,
        args.min_gap_s,
        args.max_candidates,
        args.max_tokens,
    )
    text = json.dumps(result, indent=2)
    print(text)
    if args.output:
        Path(args.output).write_text(text)


if __name__ == "__main__":
    main()
