"""Measure the character of candidate sound files so an agent that cannot hear can choose them.

What it is: the "choose by measured character" step of the apelles-sound-design skill (D-406).
What it does: for each file, prints duration, integrated loudness (LUFS), true peak (dBTP),
attack (time to the loudest 10 ms), tail (time from the peak until the level falls 20 dB),
brightness (spectral centroid) and a kind guess (click / whoosh / impact / riser / bed).
What it does NOT do: change any file or the project, or judge whether a sound fits; that is the
agent's call, and the person's ear.

Needs Python 3 with numpy, and ffmpeg on PATH.
Usage: sound_character.py [--json] FILE [FILE ...]
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import asdict, dataclass

import numpy as np

SAMPLE_RATE = 22050
WINDOW_S = 0.01                     # 10 ms envelope windows
TAIL_DROP_DB = 20.0                 # tail = time for the level to fall this far below its peak
SILENT_LUFS = -50.0                 # quieter than this is effectively inaudible in a mix
BRIGHT_HZ, DARK_HZ = 3000.0, 900.0  # centroid bands for "bright" / "dark"
EVENT_FLOOR_DB = 25.0               # a separate sound = a burst within this far of the file's peak
EVENT_GAP_S = 0.15                  # bursts closer than this are one sound


@dataclass
class Character:
    file: str
    duration_s: float
    lufs: float | None
    true_peak_dbtp: float | None
    attack_ms: float
    tail_ms: float
    centroid_hz: float
    brightness: str
    kind: str
    events: int
    first_event_s: float
    warnings: list[str]


def decode(path: str) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(raw, np.float32)


def loudness(path: str) -> tuple[float | None, float | None]:
    err = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-af", "ebur128=framelog=quiet:peak=true", "-f", "null", "-"],
        capture_output=True, text=True,
    ).stderr
    i = re.findall(r"^\s+I:\s+(-?[\d.]+|-inf) LUFS", err, re.M)
    p = re.findall(r"^\s+Peak:\s+(-?[\d.]+|-inf) dBFS", err, re.M)
    to_f = lambda v: None if not v or v[-1] == "-inf" else float(v[-1])
    return to_f(i), to_f(p)


def classify(duration: float, attack_ms: float, tail_ms: float, centroid: float) -> str:
    if duration >= 10.0:
        return "bed"
    if attack_ms >= 1000.0:
        return "riser"
    if duration <= 0.25 or (tail_ms <= 150.0 and centroid >= BRIGHT_HZ):
        return "click"
    if attack_ms <= 40.0 and centroid < 1500.0:
        return "impact"
    if attack_ms >= 80.0:
        return "whoosh"
    return "hit"


def measure(path: str) -> Character:
    x = decode(path)
    duration = len(x) / SAMPLE_RATE
    n = max(1, int(WINDOW_S * SAMPLE_RATE))
    frames = len(x) // n
    warnings: list[str] = []
    if frames == 0:
        return Character(path, duration, None, None, 0.0, 0.0, 0.0, "n/a", "empty", 0, 0.0, ["no audio decoded"])
    env = 20 * np.log10(np.sqrt(np.mean(x[: frames * n].reshape(frames, n) ** 2, axis=1)) + 1e-9)
    # Separate sounds: runs of windows near the peak, joined across short gaps.
    loud = env > env.max() - EVENT_FLOOR_DB
    events: list[list[int]] = []
    for i in np.where(loud)[0]:
        if events and i - events[-1][1] <= EVENT_GAP_S / WINDOW_S:
            events[-1][1] = int(i)
        else:
            events.append([int(i), int(i)])
    first_start, first_end = events[0] if events else (0, frames - 1)
    if len(events) > 1:
        # Character of the first sound only; the rest are other takes in the same file.
        env = env[first_start: first_end + 1]
        x = x[first_start * n: (first_end + 1) * n]
        duration_first = (first_end - first_start + 1) * WINDOW_S
    else:
        first_start, duration_first = 0, duration
    peak_i = int(np.argmax(env))
    after = np.where(env[peak_i:] <= env[peak_i] - TAIL_DROP_DB)[0]
    tail_ms = (after[0] if len(after) else frames - peak_i) * WINDOW_S * 1000
    spectrum = np.abs(np.fft.rfft(x[: min(len(x), SAMPLE_RATE * 5)]))
    freqs = np.fft.rfftfreq(min(len(x), SAMPLE_RATE * 5), 1 / SAMPLE_RATE)
    centroid = float((spectrum * freqs).sum() / max(spectrum.sum(), 1e-9))
    brightness = "bright" if centroid >= BRIGHT_HZ else "dark" if centroid <= DARK_HZ else "mid"
    lufs, tp = loudness(path)
    if lufs is not None and lufs < SILENT_LUFS:
        warnings.append(f"very quiet ({lufs:.1f} LUFS): likely inaudible under a voice")
    if tp is not None and tp > -0.5:
        warnings.append(f"peaks near clipping ({tp:.1f} dBTP): lower its clip volume")
    attack_ms = peak_i * WINDOW_S * 1000
    if len(events) > 1:
        warnings.append(f"{len(events)} separate sounds in one file: trim with source_start/duration "
                        f"(first at {first_start * WINDOW_S:.2f} s, {duration_first:.2f} s long; character shown is the first)")
    return Character(path, round(duration, 2), lufs, tp, round(attack_ms), round(tail_ms), round(centroid),
                     brightness, classify(duration_first, attack_ms, tail_ms, centroid), len(events),
                     round(first_start * WINDOW_S, 2), warnings)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("files", nargs="+")
    ap.add_argument("--json", action="store_true", help="print JSON instead of a table")
    args = ap.parse_args()
    rows = []
    for f in args.files:
        try:
            rows.append(measure(f))
        except subprocess.CalledProcessError as e:
            print(f"{f}: could not decode ({e})", file=sys.stderr)
    if args.json:
        print(json.dumps([asdict(r) for r in rows], indent=1))
        return 0
    print(f"{'file':40} {'dur s':>6} {'LUFS':>6} {'TP':>6} {'atk ms':>7} {'tail ms':>8} {'centroid':>9}  kind")
    for r in rows:
        name = r.file.rsplit("/", 1)[-1][:40]
        fmt = lambda v: "  -  " if v is None else f"{v:6.1f}"
        print(f"{name:40} {r.duration_s:6.2f} {fmt(r.lufs)} {fmt(r.true_peak_dbtp)} {r.attack_ms:7.0f} "
              f"{r.tail_ms:8.0f} {r.centroid_hz:7.0f}Hz  {r.kind} ({r.brightness})")
        for w in r.warnings:
            print(f"{'':40}   ! {w}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
