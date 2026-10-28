#!/usr/bin/env python3
"""The whole-file transcript's coverage check — speech the ASR left unread (B-287, D-420).

**What it is.** Pure functions over a transcript's words and the source's audio
levels that answer one question: *where does the audio sound like speech while
the transcript has no words?* — and then put a re-read of each such stretch back
into the transcript. [`transcribe.transcribe`] runs it after every whole-file
pass; this module holds the arithmetic so it is testable with no model, no
ffmpeg and no audio file at all (`test_asr_coverage.py`).

**Why it exists.** B-287: a whole-file Parakeet pass silently dropped ~1.5 min of
speech in 8 places on a 9:28 voiceover (6.5-37 s each). Measured per chunk, every
hole was inside ONE chunk's own output — the model, decoding a 120 s chunk, stops
emitting tokens for a stretch and later resumes; the chunk merge did not cause
any of them. D-420 shortened the chunks (120/15 s → 40/8 s), which removed every
hole on the five sources measured. This module is the safety net under that fix:
the drops are a model behaviour, not a bug that is now gone, so a pass that still
leaves speech unread is caught here rather than handed to the retake gate, the
cut-words op and the captions as if the speaker had paused.

**The signal is ENERGY, not a VAD.** Frame RMS in dBFS, 100 ms frames, judged
against the file's own loud reference (its 90th-percentile frame): a stretch is
"speech-like" when at least [`SPEECH_FRACTION`] of its frames sit within
[`FLOOR_BELOW_REF_DB`] of that reference. Measured on the five sources D-420
used: at 120/15 s chunking it flags the owner's 8 B-287 holes and the 3 in the
2:30 intro, and every stretch D-381 §4.3.1 listed on C019/C038 that is ≥ 2 s;
at 40/8 s it flags 2 stretches in total, both on C019 and both known (a false
start D-387 recorded, and a timestamp collapse). The app's Silero dark-region
scan (D-349, `apelles-speech::dark`) is the finer, per-clip tool and stays; this
check runs inside the transcription job, where the model is a subprocess away
and the audio is already being decoded, and needs no model of its own.

**What it does NOT do.** No ffmpeg, no model, no I/O: [`transcribe`] decodes the
levels and runs the re-reads. It never deletes or moves a word the pass DID
read: a re-read only fills a hole (words whose midpoint lies strictly inside
it), and its context either side is read, never spliced — D-387's rule, for
D-387's reason (B-252: a window edge through a kept word must not delete it).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

# A gap between two read words shorter than this is never a drop. 2 s: the
# shortest hole B-287 reported was 6.5 s, D-381 §4.3.1's shortest dark stretch
# with real content was 1.1 s, and below 2 s the energy test starts flagging
# ordinary breaths and pauses on camera audio (measured: C038 33.2-35.3 s, a
# pause, flagged at 2 s with a 25 dB floor only on the 120 s run). Two seconds
# catches every multi-second drop for one extra re-read at most per file.
MIN_GAP_S = 2.0

# The level frame. 100 ms is the resolution the B-287 investigation and D-387's
# listen-level evidence were both read at.
FRAME_S = 0.1

# The file's own loud reference: its 90th-percentile frame level. A percentile,
# not the peak, so one clap or cough does not set the bar.
REF_PERCENTILE = 90.0

# A frame within this many dB of the reference counts as speech-like. Measured:
# 25 dB separates the voiceover's real holes (speech frames 64-84 % of the hole)
# from its pauses (silence frames, room tone 35-50 dB down) on every source.
FLOOR_BELOW_REF_DB = 25.0

# The fraction of a gap's frames that must be speech-like for it to count. 0.4,
# because real speech holds pauses between phrases: the owner's 8 holes measured
# 49-78 % speech-like frames, real pauses < 10 %.
SPEECH_FRACTION = 0.4

# Context read either side of a hole, and the longest hole one re-read covers.
# The SAME numbers, for the same measured reasons, as the app's dark-region
# recovery (`packages/editor/src/darkRegions.ts`'s `RECOVERY_CONTEXT_SECS` and
# `MAX_RECOVERY_HOLE_SECS`, D-387): 10 s of context is the middle of the
# measured plateau, and a hole of at most 20 s plus 10 s either side is a 40 s
# window — exactly one Parakeet chunk at D-420's 40 s chunking, so the re-read
# is decoded whole and the chunking this exists to escape is not reintroduced.
REREAD_CONTEXT_S = 10.0
REREAD_MAX_HOLE_S = 20.0

# The longest pass that counts as a RE-READ, and so is not itself checked: the
# app's longest single re-read is 60 s (`editor_retranscribe_words`'
# `MAX_REREAD_SECS`, `packages/editor/src/retakeWordView.ts`); D-387's recovery
# windows and this check's own are at most 40 s. Anything longer — the whole
# file, the Clipper's 5-minute progressive windows (D-411) — is a reading pass
# and is checked. This is also what keeps the check from recursing.
REREAD_PASS_MAX_S = 60.0

# A level for a frame of digital silence, so log10 never sees zero.
_SILENCE_DB = -120.0


@dataclass(frozen=True)
class Stretch:
    """A gap between read words that sounds like speech, in absolute seconds."""

    start: float
    end: float


@dataclass(frozen=True)
class RereadWindow:
    """One re-read: the `hole` whose words are kept, read inside `window`."""

    hole_start: float
    hole_end: float
    window_start: float
    window_end: float


def frame_levels_db(samples: object, sample_rate: int, frame_s: float = FRAME_S) -> list[float]:
    """Per-frame RMS level in dBFS of mono float samples in [-1, 1] (a numpy
    array or anything `numpy.asarray` takes). A trailing partial frame is
    dropped (it is under 100 ms of audio). numpy is imported here, not at module
    level, so `server.py` — which imports `transcribe` — does not load it."""
    import numpy as np

    hop = max(1, int(round(sample_rate * frame_s)))
    x = np.asarray(samples, dtype=np.float64)
    n = len(x) // hop
    if n == 0:
        return []
    rms = np.sqrt((x[: n * hop].reshape(n, hop) ** 2).mean(axis=1))
    db = np.full(n, _SILENCE_DB)
    loud = rms > 0
    db[loud] = 20.0 * np.log10(rms[loud])
    return [float(v) for v in db]


def _percentile(values: Sequence[float], q: float) -> float:
    """Linear-interpolated percentile, numpy's default method, without numpy."""
    ordered = sorted(values)
    if not ordered:
        return _SILENCE_DB
    pos = (len(ordered) - 1) * q / 100.0
    lo = int(pos)
    hi = min(lo + 1, len(ordered) - 1)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (pos - lo)


def find_unread_stretches(
    words: Sequence[dict],
    levels_db: Sequence[float],
    *,
    offset_s: float = 0.0,
    frame_s: float = FRAME_S,
    min_gap_s: float = MIN_GAP_S,
    floor_below_ref_db: float = FLOOR_BELOW_REF_DB,
    speech_fraction: float = SPEECH_FRACTION,
) -> list[Stretch]:
    """Every gap between read words (and before the first / after the last) at
    least `min_gap_s` long whose audio is speech-like.

    `words` are contract words (`start`/`end` in absolute seconds; an untimed
    word is ignored); `levels_db` are [`frame_levels_db`] frames whose first
    frame starts at `offset_s` (the decoded range's start). The reference level
    is taken over every frame, so one file has one bar."""
    if not levels_db:
        return []
    ref = _percentile(levels_db, REF_PERCENTILE)
    floor = ref - floor_below_ref_db
    total_end = offset_s + len(levels_db) * frame_s

    timed = sorted(
        (float(w["start"]), float(w["end"]))
        for w in words
        if isinstance(w.get("start"), (int, float)) and isinstance(w.get("end"), (int, float))
    )
    edges: list[tuple[float, float]] = [(offset_s, offset_s), *timed, (total_end, total_end)]

    out: list[Stretch] = []
    # The latest word end seen so far: words can overlap, and a gap starts where
    # the LAST-ending earlier word ends, not where the previous one does.
    reach = edges[0][1]
    for start, end in edges[1:]:
        if start - reach >= min_gap_s:
            first = max(0, int((reach - offset_s) / frame_s))
            last = min(len(levels_db), int((start - offset_s) / frame_s))
            frames = levels_db[first:last]
            if frames:
                loud = sum(1 for v in frames if v > floor)
                if loud / len(frames) >= speech_fraction:
                    out.append(Stretch(start=round(reach, 6), end=round(start, 6)))
        reach = max(reach, end)
    return out


def reread_windows(
    stretch: Stretch,
    *,
    source_start: float,
    source_end: float,
    context_s: float = REREAD_CONTEXT_S,
    max_hole_s: float = REREAD_MAX_HOLE_S,
) -> list[RereadWindow]:
    """The re-reads for one stretch: the stretch cut into equal holes of at
    most `max_hole_s`, each read with `context_s` either side, clamped to the
    decoded range `[source_start, source_end]`."""
    length = stretch.end - stretch.start
    if length <= 0:
        return []
    pieces = max(1, -int(-length // max_hole_s))  # ceil without float drift
    step = length / pieces
    out: list[RereadWindow] = []
    for i in range(pieces):
        hole_start = stretch.start + i * step
        hole_end = stretch.end if i == pieces - 1 else stretch.start + (i + 1) * step
        out.append(
            RereadWindow(
                hole_start=round(hole_start, 6),
                hole_end=round(hole_end, 6),
                window_start=round(max(source_start, hole_start - context_s), 6),
                window_end=round(min(source_end, hole_end + context_s), 6),
            )
        )
    return out


def segments_in_hole(reread_segments: Sequence[dict], hole_start: float, hole_end: float) -> list[dict]:
    """The re-read's segments cut down to the words whose midpoint lies in
    `[hole_start, hole_end)`, each marked `recovered`; segments left with no
    word are dropped. The re-read's own segmentation is kept (it is the
    backend's), so a recovered line reads as one utterance downstream."""
    out: list[dict] = []
    for seg in reread_segments:
        kept = [
            w
            for w in seg.get("words", [])
            if isinstance(w.get("start"), (int, float))
            and isinstance(w.get("end"), (int, float))
            and hole_start <= (w["start"] + w["end"]) / 2 < hole_end
        ]
        if not kept:
            continue
        out.append(
            {
                "start": kept[0]["start"],
                "end": max(w["end"] for w in kept),
                "text": "".join(w["word"] for w in kept).strip(),
                "words": kept,
                "recovered": True,
            }
        )
    return out


def splice_segments(segments: Sequence[dict], recovered: Sequence[dict]) -> list[dict]:
    """`segments` with `recovered` segments merged in by start time. Stable: a
    pass segment and a recovered one starting together keep the pass first.
    Nothing is removed — a hole holds no pass words by construction."""
    tagged = [(float(s["start"]), 0, i, s) for i, s in enumerate(segments)]
    tagged += [(float(s["start"]), 1, i, s) for i, s in enumerate(recovered)]
    tagged.sort(key=lambda t: (t[0], t[1], t[2]))
    return [t[3] for t in tagged]
