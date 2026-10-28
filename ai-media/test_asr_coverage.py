#!/usr/bin/env python3
"""B-287 / D-420 — the whole-file transcript's coverage check, without a model.

`asr_coverage.py` finds stretches that sound like speech but hold no word and
re-reads them; `transcribe.check_coverage` runs it after every whole-file pass.
What is checked:

  **the pure arithmetic (`asr_coverage.py`)**
  1. the B-287 failure shape — a 37.1 s hole inside continuous speech (the
     388.1 -> 425.2 s hole of the owner's 9:28 voiceover) — is found, with its
     exact edges, while an equally long real PAUSE (room tone 40 dB down) is
     not;
  2. a gap shorter than `MIN_GAP_S` is never a drop, however loud;
  3. overlapping words do not open a phantom gap (the gap starts at the
     latest end so far), and the stretches before the first word and after
     the last are checked too;
  4. the reference is the file's own 90th-percentile frame, so a quiet file's
     speech still counts and a single loud click does not set the bar;
  5. `reread_windows` cuts a 37.1 s stretch into two equal holes of at most
     `REREAD_MAX_HOLE_S`, each read with `REREAD_CONTEXT_S` either side and
     clamped to the source — every window at most 40 s, one Parakeet chunk;
  6. `segments_in_hole` keeps only words whose midpoint is inside the hole
     (context is read, never spliced — D-387/B-252) and marks them
     `recovered`; `splice_segments` is stable and removes nothing;
  7. `frame_levels_db` levels: digital silence is the floor value, a full-scale
     square wave is 0 dBFS, a sine is -3 dBFS.

  **the job (`transcribe.check_coverage`, a scripted backend, real ffmpeg)**
  8. a whole-file pass that leaves a hole over a continuous tone gets it
     re-read in two windows, the recovered words spliced into `segments`,
     `words` and `text`, and `coverage.recovered` names both holes; nothing
     read by the pass moves;
  9. a re-read that hears nothing leaves the stretch in `coverage.unread`;
 10. a window of 60 s or less (a re-read) is never checked — no recursion —
     and a longer window (the Clipper's 5-minute windows) is, over its range.

    ai-env/.venv/bin/python ai-media/test_asr_coverage.py
"""
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import asr_coverage  # noqa: E402
import transcribe as transcribe_mod  # noqa: E402
from asr import BACKENDS  # noqa: E402
from asr.base import BackendDescriptor  # noqa: E402

SPEECH_DB = -20.0
PAUSE_DB = -60.0


def _levels(spec: list[tuple[float, float, float]], total_s: float) -> list[float]:
    """100 ms frames: `PAUSE_DB` everywhere except each `(start, end, db)`."""
    n = int(round(total_s / asr_coverage.FRAME_S))
    out = [PAUSE_DB] * n
    for start, end, db in spec:
        for i in range(int(round(start / asr_coverage.FRAME_S)), int(round(end / asr_coverage.FRAME_S))):
            out[i] = db
    return out


def _w(word: str, start: float, end: float) -> dict:
    return {"word": f" {word}", "start": start, "end": end}


def check_b287_shape() -> None:
    # Continuous speech 380-440 s, words read up to 388.12 and again from
    # 425.24 — the real hole. A pause of the same length elsewhere (300-337)
    # sits between two words and must NOT be flagged.
    levels = _levels([(0.0, 300.0, SPEECH_DB), (337.12, 450.0, SPEECH_DB)], 450.0)
    words = [_w("before", 298.0, 299.9), _w("after", 337.2, 338.0), _w("x", 387.5, 388.12), _w("y", 425.24, 425.6)]
    # Everything else is "read": fill the rest with words so only the two
    # candidate gaps exist.
    words += [_w("w", t, t + 0.3) for t in [i * 0.5 for i in range(0, 596)]]
    words += [_w("w", t, t + 0.3) for t in [338.5 + i * 0.5 for i in range(0, 98)]]
    words += [_w("w", t, t + 0.3) for t in [425.7 + i * 0.5 for i in range(0, 48)]]
    got = asr_coverage.find_unread_stretches(words, levels)
    assert got == [asr_coverage.Stretch(start=388.12, end=425.24)], got
    print("ok: the B-287 hole (388.12-425.24 s) is found; an equal real pause is not")


def check_min_gap() -> None:
    levels = _levels([(0.0, 20.0, SPEECH_DB)], 20.0)
    short = asr_coverage.MIN_GAP_S - 0.1
    words = [_w("a", 0.0, 5.0), _w("b", 5.0 + short, 20.0)]
    assert asr_coverage.find_unread_stretches(words, levels) == [], "a sub-minimum gap was flagged"
    words = [_w("a", 0.0, 5.0), _w("b", 5.0 + asr_coverage.MIN_GAP_S, 20.0)]
    assert asr_coverage.find_unread_stretches(words, levels) == [asr_coverage.Stretch(5.0, 7.0)]
    print("ok: a gap under MIN_GAP_S is never a drop; one at it is")


def check_overlap_and_edges() -> None:
    levels = _levels([(0.0, 30.0, SPEECH_DB)], 30.0)
    # `long` ends at 12.0; `short` overlaps it and ends at 9.0. The gap after
    # them starts at 12.0, not 9.0. Speech before the first word (0-4) and after
    # the last (26-30) is checked too.
    words = [_w("long", 4.0, 12.0), _w("short", 8.0, 9.0), _w("z", 13.0, 26.0)]
    got = asr_coverage.find_unread_stretches(words, levels)
    assert got == [asr_coverage.Stretch(0.0, 4.0), asr_coverage.Stretch(26.0, 30.0)], got
    # An untimed word is ignored, not a crash.
    assert asr_coverage.find_unread_stretches([{"word": " u", "start": None, "end": None}], levels) == [
        asr_coverage.Stretch(0.0, 30.0)
    ]
    # `offset_s`: levels of a window starting at 100 s.
    got = asr_coverage.find_unread_stretches([_w("a", 100.0, 110.0)], levels, offset_s=100.0)
    assert got == [asr_coverage.Stretch(110.0, 130.0)], got
    print("ok: overlapping words open no phantom gap; the file's head and tail are checked")


def check_reference() -> None:
    # A QUIET file: speech at -45 dBFS, pauses at -85. Relative, so still found.
    levels = [-45.0] * 300
    for i in range(100, 160):
        levels[i] = -85.0
    words = [_w("a", 0.0, 2.0), _w("b", 18.0, 30.0)]
    got = asr_coverage.find_unread_stretches(words, levels)
    assert got == [asr_coverage.Stretch(2.0, 18.0)], got  # 2-10 speech, 10-16 pause, 16-18 speech: 10/16 loud
    # One click at 0 dBFS does not lift the bar above the speech.
    levels[5] = 0.0
    assert asr_coverage.find_unread_stretches(words, levels) == got
    print("ok: the bar is the file's own 90th percentile — quiet speech counts, a click does not move it")


def check_windows() -> None:
    wins = asr_coverage.reread_windows(
        asr_coverage.Stretch(388.12, 425.24), source_start=0.0, source_end=567.6
    )
    assert len(wins) == 2, wins
    assert wins[0].hole_start == 388.12 and wins[1].hole_end == 425.24, wins
    assert abs((wins[0].hole_end - wins[0].hole_start) - (wins[1].hole_end - wins[1].hole_start)) < 1e-6
    assert wins[0].hole_end == wins[1].hole_start, wins
    for w in wins:
        assert w.hole_end - w.hole_start <= asr_coverage.REREAD_MAX_HOLE_S
        assert w.window_start == round(w.hole_start - asr_coverage.REREAD_CONTEXT_S, 6)
        assert w.window_end == round(w.hole_end + asr_coverage.REREAD_CONTEXT_S, 6)
        assert w.window_end - w.window_start <= 40.0 + 1e-6
    # Clamped to the source at both ends.
    head = asr_coverage.reread_windows(asr_coverage.Stretch(1.0, 4.0), source_start=0.0, source_end=8.0)
    assert head == [asr_coverage.RereadWindow(1.0, 4.0, 0.0, 8.0)], head
    print("ok: a 37 s stretch is two equal holes, each read in a <= 40 s window, clamped to the source")


def check_splice() -> None:
    reread = [
        {"start": 380.0, "end": 392.0, "text": "context hole", "words": [_w("context", 380.0, 388.0), _w("hole", 389.0, 391.0)]},
        {"start": 424.9, "end": 426.0, "text": "edge", "words": [_w("edge", 424.9, 426.0)]},
    ]
    got = asr_coverage.segments_in_hole(reread, 388.12, 425.24)
    # "context" (mid 384) is context; "edge" (mid 425.45) is past the hole.
    assert got == [
        {"start": 389.0, "end": 391.0, "text": "hole", "words": [_w("hole", 389.0, 391.0)], "recovered": True}
    ], got
    kept = [{"start": 380.0, "end": 388.1, "text": "a", "words": [_w("a", 380.0, 388.1)]},
            {"start": 425.2, "end": 426.0, "text": "b", "words": [_w("b", 425.2, 426.0)]}]
    spliced = asr_coverage.splice_segments(kept, got)
    assert [s["text"] for s in spliced] == ["a", "hole", "b"], spliced
    assert spliced[0] is kept[0] and spliced[2] is kept[1], "a pass segment was copied or moved"
    print("ok: only hole words are spliced, marked recovered; context is read, never spliced")


def check_levels() -> None:
    try:
        import numpy  # noqa: F401
    except ImportError:
        print("skip: numpy not importable — run on ai-env/.venv's python")
        return
    assert asr_coverage.frame_levels_db([0.0] * 3200, 16000) == [-120.0, -120.0]
    assert asr_coverage.frame_levels_db([1.0, -1.0] * 800, 16000) == [0.0]
    import math

    sine = [math.sin(2 * math.pi * 400 * i / 16000) for i in range(1600)]
    (db,) = asr_coverage.frame_levels_db(sine, 16000)
    assert abs(db - (-3.0103)) < 0.01, db
    assert asr_coverage.frame_levels_db([0.5] * 100, 16000) == [], "a partial frame must be dropped"
    print("ok: frame levels — silence is the floor, a square wave 0 dBFS, a sine -3 dBFS")


class _HoleBackend:
    """Whole-file call: words with a hole at 5-29 s. Window calls: one word at
    every whole second of the window (window-local), or none (`heard=False`)."""

    def __init__(self, heard: bool) -> None:
        self.heard = heard
        self.calls: list[float] = []
        self._descriptor = BackendDescriptor(
            name="holes", default_model="holes-1", model_repos={"holes-1": "never/loaded"},
            languages=None, language_summary="test", max_word_secs=None,
        )

    @property
    def descriptor(self) -> BackendDescriptor:
        return self._descriptor

    def transcribe(self, audio_path, *, model, language, word_timestamps):
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", audio_path],
            capture_output=True, text=True, check=True,
        )
        duration = float(probe.stdout.strip())
        self.calls.append(round(duration, 1))
        if len(self.calls) == 1:
            words = [_w("start", 0.5, 4.5), _w("end", 29.2, 29.8)]
        elif self.heard:
            words = [_w(f"w{i}", float(i), i + 0.4) for i in range(int(duration))]
        else:
            words = []
        segs = [{"start": w["start"], "end": w["end"], "text": w["word"].strip(), "words": [w]} for w in words]
        return {"text": " ".join(s["text"] for s in segs), "language": "en", "segments": segs}


def _run_job(audio: Path, backend: _HoleBackend) -> dict:
    BACKENDS["holes"] = backend
    try:
        return transcribe_mod.transcribe(str(audio), backend="holes")
    finally:
        BACKENDS.pop("holes", None)


def check_job(tmp: Path) -> None:
    audio = tmp / "tone.wav"
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=300:duration=30", str(audio)],
        capture_output=True,
    )
    assert proc.returncode == 0, proc.stderr

    heard = _HoleBackend(heard=True)
    got = _run_job(audio, heard)
    cov = got["coverage"]
    assert cov["checked"] is True, cov
    # The 4.5-29.2 s stretch is 24.7 s: two holes of 12.35 s, each with 10 s of
    # context (the first clamped at 0 s, the second at the file's 30 s end).
    assert [(r["start"], r["end"]) for r in cov["recovered"]] == [(4.5, 16.85), (16.85, 29.2)], cov
    assert heard.calls[0] == 30.0 and len(heard.calls) == 3, heard.calls
    assert cov["unread"] == [], cov
    texts = [s["text"] for s in got["segments"]]
    assert texts[0] == "start" and texts[-1] == "end", texts
    recovered = [s for s in got["segments"] if s.get("recovered")]
    assert recovered and all(4.5 <= (s["words"][0]["start"] + s["words"][0]["end"]) / 2 < 29.2 for s in recovered)
    starts = [w["start"] for w in got["words"]]
    assert starts == sorted(starts), "the spliced words are out of order"
    assert got["words"][0] == _w("start", 0.5, 4.5) and got["words"][-1] == _w("end", 29.2, 29.8)
    assert got["text"].startswith("start ") and got["text"].endswith(" end"), got["text"]
    print(f"ok: a hole over continuous audio is re-read in 2 windows; {len(recovered)} recovered lines spliced in order")

    deaf = _HoleBackend(heard=False)
    got = _run_job(audio, deaf)
    assert got["coverage"]["recovered"] == [], got["coverage"]
    assert got["coverage"]["unread"] == [{"start": 4.5, "end": 29.2}], got["coverage"]
    assert [w["word"] for w in got["words"]] == [" start", " end"], got["words"]
    print("ok: a re-read that hears nothing leaves the stretch in coverage.unread")

    window = _HoleBackend(heard=True)
    BACKENDS["holes"] = window
    try:
        got = transcribe_mod.transcribe(str(audio), backend="holes", start_secs=1.0, duration_secs=20.0)
    finally:
        BACKENDS.pop("holes", None)
    assert "coverage" not in got and len(window.calls) == 1, (got.keys(), window.calls)
    print("ok: a short window (<= REREAD_PASS_MAX_S) is a re-read and is never itself checked")

    # A LONG window — the Clipper's 5-minute progressive windows — is a reading
    # pass and is checked, over its own range only.
    long_audio = tmp / "long.wav"
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=300:duration=90", str(long_audio)],
        capture_output=True,
    )
    assert proc.returncode == 0, proc.stderr
    long_window = _HoleBackend(heard=True)
    BACKENDS["holes"] = long_window
    try:
        got = transcribe_mod.transcribe(str(long_audio), backend="holes", start_secs=5.0, duration_secs=80.0)
    finally:
        BACKENDS.pop("holes", None)
    cov = got["coverage"]
    assert cov["checked"] is True and cov["recovered"], cov
    assert all(5.0 <= r["start"] < r["end"] <= 85.0 + 1e-6 for r in cov["recovered"]), cov
    assert long_window.calls[0] == 80.0, long_window.calls
    print(f"ok: a long window is checked over its own range ({len(cov['recovered'])} holes re-read)")


def main() -> int:
    check_b287_shape()
    check_min_gap()
    check_overlap_and_edges()
    check_reference()
    check_windows()
    check_splice()
    check_levels()
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        print("skip: ffmpeg/ffprobe not on PATH — the job checks need them")
    else:
        try:
            import numpy  # noqa: F401
        except ImportError:
            print("skip: numpy not importable — the job checks need it (ai-env/.venv's python)")
        else:
            tmp = Path(tempfile.mkdtemp(prefix="apelles_coverage_"))
            try:
                check_job(tmp)
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
    print("all B-287/D-420 coverage checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
