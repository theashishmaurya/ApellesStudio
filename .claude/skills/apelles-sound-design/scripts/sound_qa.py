"""Measured sound-design report for an Apelles project, ending in five moments to check by ear.

What it is: the QA step of the apelles-sound-design skill (D-406). The agent cannot hear the mix,
so it reports numbers and names five timestamps a person should listen to.
What it does: reads the saved project (`<project>.chroma/project.json`), sorts its audio tracks
into voice / music / effects, and reports clip counts and levels, effects density per minute,
music coverage and dropouts, and ducking. With `--export`, it also measures the rendered file's
integrated loudness and true peak against the -14 LUFS target and finds moments where the mix
jumps well above its running level (effects poking over the voice).
What it does NOT do: change the project or the file.

Needs Python 3 with numpy, and ffmpeg on PATH.
Usage: sound_qa.py --project DIR.chroma [--export FILE] [--voice-track N] [--target-lufs -14]
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

BED_MIN_S = 20.0           # an audio-file clip at least this long is treated as a music bed
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".aif", ".aiff"}
LEVEL_GATE = -60.0         # short-term frames quieter than this are silence, not "level"
DROPOUT_MIN_S = 1.0        # a gap in the music at least this long counts as a dropout
DENSE_WINDOW_S = 10.0      # window for "densest effects" listening moment
SPIKE_LU = 6.0             # short-term level this far above its 10 s running median is a spike
TARGET_TP = -1.0


def mmss(t: float) -> str:
    return f"{int(t // 60)}:{t % 60:04.1f}"


def load_audio_tracks(project: Path) -> tuple[float, list[dict]]:
    doc = json.loads((project / "project.json").read_text())
    fps = float(doc.get("settings", {}).get("fps") or 24.0)
    tl = doc["timelines"][doc.get("activeTimeline", 0) if isinstance(doc.get("activeTimeline"), int) else 0]
    tracks = []
    for i, tr in enumerate(tl["tracks"]):
        if tr.get("kind") != "audio":
            continue
        clips = []
        for c in tr.get("clips", []):
            src_fps = float(c.get("source_fps") or fps)
            start = c["start_frame"] / fps
            clips.append({"name": c.get("name", ""), "start": start, "end": start + c["duration"] / src_fps,
                          "volume": float(c.get("volume", 1.0)),
                          "audio_file": Path(c.get("source_path", "")).suffix.lower() in AUDIO_EXTS})
        tracks.append({"index": i, "clips": sorted(clips, key=lambda c: c["start"]),
                       "duck_from": tr.get("duck_from"), "duck_db": tr.get("duck_db", 0), "gain": tr.get("gain", 1)})
    return fps, tracks


def classify(tracks: list[dict], voice_track: int | None) -> dict[int, str]:
    roles: dict[int, str] = {}
    if voice_track is None:
        # The voice is what other tracks duck from; else the track with the most audio and no duck.
        ducked_from = [t["duck_from"] for t in tracks if t["duck_from"] is not None]
        if ducked_from:
            voice_track = max(set(ducked_from), key=ducked_from.count)
        else:
            undocked = [t for t in tracks if t["duck_from"] is None] or tracks
            voice_track = max(undocked, key=lambda t: sum(c["end"] - c["start"] for c in t["clips"]))["index"]
    for t in tracks:
        if t["index"] == voice_track:
            roles[t["index"]] = "voice"
        elif t["clips"] and not any(c["audio_file"] for c in t["clips"]):
            # Sound taken from video sources (a clip's own audio, a rendered Motion scene):
            # not a bed or an effect the sound designer placed.
            roles[t["index"]] = "picture"
        elif t["clips"] and max(c["end"] - c["start"] for c in t["clips"] if c["audio_file"]) >= BED_MIN_S:
            roles[t["index"]] = "music"
        elif t["clips"]:
            roles[t["index"]] = "effects"
    return roles


def measure_export(path: str) -> dict:
    err = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"],
        capture_output=True, text=True,
    ).stderr
    integrated = re.findall(r"^\s+I:\s+(-?[\d.]+) LUFS", err, re.M)
    peak = re.findall(r"^\s+Peak:\s+(-?[\d.]+) dBFS", err, re.M)
    # Per-100 ms frame lines: "t: 12.3  TARGET:-23 LUFS  M: -20.1 S: -18.9 ..."
    st = [(float(t), float(s)) for t, s in re.findall(r"t:\s*([\d.]+).*?S:\s*(-?[\d.]+)", err)]
    return {"integrated": float(integrated[-1]) if integrated else None,
            "true_peak": float(peak[-1]) if peak else None, "short_term": st}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--project", required=True, type=Path)
    ap.add_argument("--export")
    ap.add_argument("--voice-track", type=int)
    ap.add_argument("--target-lufs", type=float, default=-14.0)
    args = ap.parse_args()

    fps, tracks = load_audio_tracks(args.project)
    roles = classify(tracks, args.voice_track)
    end = max((c["end"] for t in tracks for c in t["clips"]), default=0.0)
    print(f"# Sound QA: {args.project.name}   ({mmss(end)} of audio, {fps:g} fps)\n")

    print("## Tracks")
    for t in tracks:
        role = roles.get(t["index"], "empty")
        vols = sorted({round(c["volume"], 3) for c in t["clips"]})
        duck = f"ducks {t['duck_db']} dB under track {t['duck_from']}" if t["duck_from"] is not None else "no duck"
        print(f"- track {t['index']:>2} {role:8} {len(t['clips']):4} clips  volumes {vols[:6]}{'…' if len(vols) > 6 else ''}  {duck}")
    print()

    effects = [c for t in tracks if roles.get(t["index"]) == "effects" for c in t["clips"]]
    music = [c for t in tracks if roles.get(t["index"]) == "music" for c in t["clips"]]
    moments: list[tuple[float, str]] = [(0.0, "the opening: is the hook clear over whatever plays under it?")]

    print("## Effects density")
    if effects and end > 0:
        per_min = np.histogram([c["start"] for c in effects], bins=np.arange(0, end + 60, 60))[0]
        print("per minute: " + " ".join(str(int(n)) for n in per_min))
        starts = np.array(sorted(c["start"] for c in effects))
        counts = [((starts >= s) & (starts < s + DENSE_WINDOW_S)).sum() for s in starts]
        k = int(np.argmax(counts))
        print(f"densest {DENSE_WINDOW_S:g} s: {counts[k]} effects from {mmss(starts[k])}")
        moments.append((float(starts[k]), f"densest effects ({counts[k]} in {DENSE_WINDOW_S:g} s): too busy?"))
        quiet = min(effects, key=lambda c: c["volume"])
        moments.append((quiet["start"], f"quietest effect ({quiet['name']}, volume {quiet['volume']}): audible at all?"))
    else:
        print("no effects tracks")
    print()

    print("## Music")
    if music:
        spans = sorted((c["start"], c["end"]) for c in music)
        merged: list[list[float]] = []
        for a, b in spans:
            if merged and a <= merged[-1][1] + 0.05:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b])
        covered = sum(b - a for a, b in merged)
        gaps = [(merged[i][1], merged[i + 1][0]) for i in range(len(merged) - 1)
                if merged[i + 1][0] - merged[i][1] >= DROPOUT_MIN_S]
        print(f"coverage {100 * covered / max(end, 1e-9):.0f}% in {len(merged)} stretch(es); first entry {mmss(merged[0][0])}")
        print("dropouts: " + (", ".join(f"{mmss(a)}-{mmss(b)}" for a, b in gaps) if gaps else
                              "none (a continuous bed: consider dropouts on punchlines, reveals and CTAs)"))
        moments.append((merged[0][0], "music entry: does it come in on a turn, under the voice?"))
        if gaps:
            moments.append((gaps[0][0], "first dropout: does the silence land the line?"))
    else:
        print("no music tracks")
    print()

    if args.export:
        print("## Rendered mix")
        m = measure_export(args.export)
        if m["integrated"] is not None:
            delta = m["integrated"] - args.target_lufs
            print(f"integrated {m['integrated']:.1f} LUFS (target {args.target_lufs:g}, {delta:+.1f} LU); "
                  f"true peak {m['true_peak']:.1f} dBTP (ceiling {TARGET_TP:g})")
            if abs(delta) > 1.0:
                print("  ! off target: export with loudness_preset=\"youtube\" (D-401)")
        st = m["short_term"]
        if len(st) > 200:
            times = np.array([t for t, _ in st]); lv = np.array([s for _, s in st])
            win = 100  # 10 s of 100 ms frames
            audible = lv > LEVEL_GATE
            med = np.array([np.median(lv[max(0, i - win):i + 1][audible[max(0, i - win):i + 1]])
                            if audible[max(0, i - win):i + 1].sum() >= win // 4 else np.nan
                            for i in range(len(lv))])
            jump = np.where(audible & ~np.isnan(med), lv - med, -np.inf)
            i = int(np.argmax(jump))
            print(f"largest jump above the running level: +{jump[i]:.1f} LU at {mmss(times[i])}")
            if jump[i] >= SPIKE_LU:
                moments.append((float(times[i]), f"level jumps +{jump[i]:.1f} LU: an effect over the voice?"))
        print()

    moments.append((max(end - 10.0, 0.0), "the ending: does the music resolve, not just stop?"))
    seen: list[float] = []
    print("## Five moments to check by ear")
    picked = 0
    for t, why in moments:
        if picked == 5 or any(abs(t - s) < 3.0 for s in seen):
            continue
        seen.append(t); picked += 1
        print(f"{picked}. {mmss(t)}  {why}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
