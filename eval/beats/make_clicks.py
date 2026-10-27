#!/usr/bin/env python3
"""Write synthetic metronome WAVs with known beat times (D-413).

The same recipe as `crates/apelles-beat/tests/click_tracks.rs`: a quiet bright
tick on every beat, a loud low thump + tick on every downbeat (4/4, one pickup
beat), over faint deterministic noise, 30 s, 44.1 kHz. Each `clickN.wav` gets a
`clickN.json` beside it holding the true beat times, which
`compare_librosa.py` scores both trackers against.

USAGE
    ai-env/.venv/bin/python -I eval/beats/make_clicks.py OUT_DIR
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

RATE = 44100
SECS = 30.0
FIRST_BEAT = 0.37
PICKUP = 1
METER = 4


def main(out: Path) -> int:
    out.mkdir(parents=True, exist_ok=True)
    for bpm in (90, 100, 120, 128, 140):
        n = int(SECS * RATE)
        x = np.random.default_rng(42).uniform(-1, 1, n).astype(np.float32) * 0.002
        period = 60.0 / bpm
        truth: list[float] = []
        k = 0
        while (t := FIRST_BEAT + k * period) <= SECS - 0.5:
            down = k >= PICKUP and (k - PICKUP) % METER == 0
            truth.append(t)
            start = int(round(t * RATE))
            tt = np.arange(int(0.08 * RATE)) / RATE
            tick = np.sin(2 * np.pi * 2200 * tt) * np.exp(-tt * 120)
            thump = np.sin(2 * np.pi * 70 * tt) * np.exp(-tt * 30)
            seg = (0.8 * thump + 0.5 * tick) if down else 0.3 * tick
            end = min(n, start + len(seg))
            x[start:end] += seg[: end - start].astype(np.float32)
            k += 1
        sf.write(out / f"click{bpm}.wav", x, RATE, subtype="PCM_16")
        (out / f"click{bpm}.json").write_text(json.dumps(truth), encoding="utf-8")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(Path(sys.argv[1])))
