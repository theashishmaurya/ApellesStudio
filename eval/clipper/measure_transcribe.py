"""Measure the Automatic Clipper's transcript stage on a real long source (D-411 §8).

What it is: the clipper's progressive transcription, run outside the app the way the
app runs it — `ai-media/transcribe.py`'s `transcribe_subprocess` (one OS process per
window, so each window pays its own model load, exactly as each `chroma_transcribe`
job does) over 5-minute cores read with 2 s of overlap, stitched by word midpoint
(`packages/editor/src/progressiveTranscript.ts` is the app's copy of the plan and the
stitch; the constants below must match it). It reports:

- `first_window_s` — wall time until the first window's words exist: the design's
  "first provisional candidates visible" budget (< 45 s cold for a 60-min source);
- `windowed_total_s` and the realtime factor of the whole windowed pass;
- optionally (`--whole`) the single whole-file pass, for the cost of windowing.

It writes the stitched transcript (the D-374 contract) to `--out`, so
`crates/apelles-clipper/tests/clipper_eval.rs` can analyse and gate it
(`APELLES_CLIPPER_EVAL_EXTRA=<that file>`), and `render_moment_view` can print the
view a client would read. Nothing is written into the repo: point `--out` at a scratch
folder (an owner's recording is theirs, not a fixture).

What it does NOT do: judge anything, or run the app.

    ../ai-env/.venv/bin/python -I eval/clipper/measure_transcribe.py <audio-or-video> --out <dir> [--whole]
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "ai-media"))

from transcribe import transcribe_subprocess  # noqa: E402  (path set just above)

#: Must equal `WINDOW_CORE_S` / `WINDOW_OVERLAP_S` in progressiveTranscript.ts.
WINDOW_CORE_S = 300.0
WINDOW_OVERLAP_S = 2.0


def probe_duration(path: str) -> float:
    ffprobe = shutil.which("ffprobe") or str(REPO / "app/src-tauri/binaries/ffprobe-aarch64-apple-darwin")
    out = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(out.stdout.strip())


def plan(duration: float) -> list[tuple[float, float, float, float]]:
    """(start, length, core_start, core_end) per window, as `planWindows`."""
    windows = []
    core = 0.0
    while core < duration:
        last = core + WINDOW_CORE_S >= duration
        start = max(0.0, core - WINDOW_OVERLAP_S)
        end = duration + WINDOW_OVERLAP_S if last else core + WINDOW_CORE_S + WINDOW_OVERLAP_S
        windows.append((start, end - start, core, float("inf") if last else core + WINDOW_CORE_S))
        core += WINDOW_CORE_S
    return windows


def core_segments(segments: list[dict], core_start: float, core_end: float) -> list[dict]:
    out = []
    for seg in segments:
        words = [w for w in seg.get("words", []) if core_start <= (w["start"] + w["end"]) / 2 < core_end]
        if not words:
            continue
        out.append(
            {
                "start": min(words[0]["start"], max(seg["start"], core_start)),
                "end": words[-1]["end"],
                "text": " ".join(w["word"].strip() for w in words),
                "words": [{"word": w["word"], "start": w["start"], "end": w["end"]} for w in words],
            }
        )
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("--out", required=True)
    ap.add_argument("--whole", action="store_true", help="also time one whole-file pass")
    args = ap.parse_args()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    duration = probe_duration(args.source)
    windows = plan(duration)
    t0 = time.monotonic()
    first = None
    segments: list[dict] = []
    language = None
    per_window = []
    for start, length, core_start, core_end in windows:
        w0 = time.monotonic()
        result = transcribe_subprocess(args.source, language=language, start_secs=start, duration_secs=length)
        language = language or result.get("language")
        segments += core_segments(result.get("segments", []), core_start, core_end)
        per_window.append(round(time.monotonic() - w0, 2))
        if first is None:
            first = time.monotonic() - t0
    total = time.monotonic() - t0
    transcript = {
        "text": " ".join(s["text"] for s in segments),
        "language": language or "",
        "model": "parakeet (windowed)",
        "source": args.source,
        "segments": segments,
        "words": [w for s in segments for w in s["words"]],
    }
    (out_dir / "windowed.words.json").write_text(json.dumps(transcript))
    report = {
        "source_duration_s": round(duration, 1),
        "windows": len(windows),
        "first_window_s": round(first or 0.0, 1),
        "per_window_s": per_window,
        "windowed_total_s": round(total, 1),
        "windowed_realtime_x": round(duration / total, 1) if total else None,
        "words": len(transcript["words"]),
    }
    if args.whole:
        w0 = time.monotonic()
        whole = transcribe_subprocess(args.source)
        report["whole_file_s"] = round(time.monotonic() - w0, 1)
        report["whole_file_words"] = len(whole.get("words", []))
        (out_dir / "whole.words.json").write_text(json.dumps(whole))
    print(json.dumps(report, indent=2))
    (out_dir / "report.json").write_text(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
