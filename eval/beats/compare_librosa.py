#!/usr/bin/env python3
"""Compare `apelles-beat`'s grids with librosa's on the same files (D-413).

WHAT THIS IS
    The reference half of the beat-analysis accuracy check. `apelles-beat`
    re-implements librosa's onset-strength + tempo + dynamic-programming beat
    tracker in Rust (plus downbeats, which librosa does not do). This script
    runs librosa 0.11 on the same files and reports, per file, how far the two
    agree:

    - tempo: both BPMs, and whether they agree within 4 % (or at double/half);
    - beats: F-measure at the MIREX tolerance (+/-70 ms) and at +/-25 ms, plus
      the median signed offset (Rust minus librosa) of matched beats; and the
      +/-70 ms F-measure over only the span both trackers kept (the two trim a
      quiet intro or tail differently, D-413), which is the fairer number.

WHAT IT DOES NOT DO
    Agreement with librosa is not ground truth: it says the port behaves like
    the reference algorithm, not that either is right about the music. When a
    `<audio stem>.json` list of true beat times sits beside an audio file (the
    synthetic metronomes `make_clicks.py` writes), both trackers are ALSO
    scored against it (`truth_*` fields). Downbeats are not compared (librosa
    has none); the Rust tests pin those on metronomes.

USAGE
    cargo run -p apelles-beat --example beat_eval -- FILE... > rust.jsonl
    ai-env/.venv/bin/python -I eval/beats/compare_librosa.py rust.jsonl
"""

from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path

import librosa
import numpy as np


def f_measure(found: list[float], truth: list[float], tol: float) -> tuple[float, list[float]]:
    used = [False] * len(truth)
    hits = 0
    offsets: list[float] = []
    for f in found:
        best = None
        for j, t in enumerate(truth):
            if not used[j] and abs(t - f) <= tol and (best is None or abs(t - f) < abs(truth[best] - f)):
                best = j
        if best is not None:
            used[best] = True
            hits += 1
            offsets.append(f - truth[best])
    if not found or not truth:
        return 0.0, offsets
    p, r = hits / len(found), hits / len(truth)
    return (0.0 if p + r == 0 else 2 * p * r / (p + r)), offsets


def tempo_relation(a: float, b: float) -> str:
    for name, k in (("same", 1.0), ("double", 2.0), ("half", 0.5), ("2/3", 2 / 3), ("3/2", 1.5)):
        if b > 0 and abs(a / (b * k) - 1.0) <= 0.04:
            return name
    return "different"


def main(path: str) -> int:
    rows = []
    for line in open(path, encoding="utf-8"):
        rec = json.loads(line)
        analysis = rec["result"]["analysis"]
        ours = [b["time"] for b in analysis["beats"]]
        y, sr = librosa.load(rec["file"], sr=22050, mono=True)
        env = librosa.onset.onset_strength(y=y, sr=sr)
        tempo, frames = librosa.beat.beat_track(onset_envelope=env, sr=sr)
        theirs = librosa.frames_to_time(frames, sr=sr).tolist()
        lib_bpm = float(np.atleast_1d(tempo)[0])
        f70, off70 = f_measure(ours, theirs, 0.070)
        f25, _ = f_measure(ours, theirs, 0.025)
        lo, hi = max(ours[0], theirs[0]) - 0.07, min(ours[-1], theirs[-1]) + 0.07
        f70_span, _ = f_measure([t for t in ours if lo <= t <= hi], [t for t in theirs if lo <= t <= hi], 0.070)
        rows.append(
            {
                "file": rec["file"].rsplit("/", 1)[-1],
                "secs": analysis["duration"],
                "ours_bpm": analysis["tempoBpm"],
                "librosa_bpm": round(lib_bpm, 2),
                "tempo": tempo_relation(analysis["tempoBpm"], lib_bpm),
                "ours_beats": len(ours),
                "librosa_beats": len(theirs),
                "f70": round(f70, 3),
                "f25": round(f25, 3),
                "f70_shared_span": round(f70_span, 3),
                "median_offset_ms": round(1000 * statistics.median(off70), 1) if off70 else None,
                "analysis_secs": round(rec["seconds"], 2),
            }
        )
        truth_path = Path(rec["file"]).with_suffix(".json")
        if truth_path.exists():
            truth = json.loads(truth_path.read_text(encoding="utf-8"))
            for name, found in (("ours", ours), ("librosa", theirs)):
                f, offs = f_measure(found, truth, 0.025)
                rows[-1][f"truth_{name}_f25"] = round(f, 3)
                rows[-1][f"truth_{name}_median_offset_ms"] = round(1000 * statistics.median(offs), 1) if offs else None
    for r in rows:
        print(json.dumps(r))
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
