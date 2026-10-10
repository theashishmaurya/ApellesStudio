#!/usr/bin/env python3
"""Aligning N word streams on time and text — the hard part of the harness
(D-374 step 3).

**What it is.** A pure function. Given N word streams from N passes over the
same audio — differing tokenisation, words one pass read and another dropped,
timestamps that drift because each pass's chunk boundaries fell elsewhere —
[`align_word_streams`] returns the **columns**: one per real spoken word, each
holding that word's index in every stream, or `None` where that stream has
nothing there.

Classifying a column is then trivial (`reconcile.py` does it in a dozen lines);
*building* the columns is the whole problem, which is why it is a module of its
own with no knowledge of agreement, confidence or the contract's annotations.

**What it does NOT do.** It does not read a model, a backend, an audio file or
the contract's metadata. It takes word dicts and returns indices — nothing
else — so every answer it gives has a correct answer that can be written down
in a test.

## How

**Progressive alignment to a growing column set**, the standard shape for
multiple sequence alignment, which is the problem this is:

1. The first stream becomes the initial columns, one word each.
2. Each further stream is aligned against the columns *as they stand*, scoring
   against each column's consensus — the majority reading among the streams
   already in it, at the mean of their midpoints. A match fills that stream's
   slot; a word the columns have no room for becomes a **new column** spliced
   in at that point, which is how a word only one pass read survives.

**The pairwise step is a Needleman-Wunsch-shaped DP in its gain form.** Every
word is either matched or gapped, so the number of gaps is fixed by the
sequence lengths and the match count: maximising `Σ score − gap_penalty × gaps`
is the same problem as maximising `Σ (score − 2 × gap_penalty)` over matches
alone. That drops the gap bookkeeping entirely and leaves a monotone
non-crossing matching — the LCS recurrence with a weight — where a pair is
matched only when it strictly beats leaving both words unmatched.

**Scoring blends text and time, because either alone is wrong here.** Text
alone matches the fourth `"the"` in a sentence to the first. Time alone cannot
tell a substitution from two different words — and the drift this check is
*looking for* is precisely a timestamp that moved. So:

    score = TEXT_WEIGHT × similarity + TIME_WEIGHT × proximity

with similarity 1.0 on a normalised-equal word and `difflib`'s ratio otherwise
(`"Gartner"` vs `"Gutter"` scores 0.57, which is a disagreement about one word
rather than two unrelated ones), and proximity falling linearly to 0 across
[`AlignParams.max_drift_secs`].

**The time band is a correctness device, not an optimisation.** Two words
further apart than [`AlignParams.band_secs`] are never matched however
identical their text, because at that distance they are two utterances of the
same word, not one word read twice. It happens to also be what keeps the cost
down — the expensive text similarity is computed only inside the band — but the
DP itself is exact and full, so the band never silently prunes a better
alignment the way a Sakoe-Chiba-style banded DP would.

**Determinism.** Total and pure. Every tie in the DP and in the consensus
breaks towards the lower index, so the answer does not depend on dict order,
set order or anything else that can move between runs.
"""

from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher
from functools import lru_cache
from typing import Any, Mapping, Sequence

from .contract import normalise, word_mid, word_text

__all__ = ["AlignParams", "align_word_streams"]


@dataclass(frozen=True)
class AlignParams:
    """Tuning for [`align_word_streams`].

    Frozen and defaulted: the defaults are the harness's answer, and a caller
    that wants a different one is making a deliberate choice visible at the
    call site rather than mutating a shared object.
    """

    #: How much of a pair's score comes from what the words say. The larger
    #: share, because text is the stronger signal: two passes that read the same
    #: word agree on it exactly, while they routinely disagree about its timing
    #: by a tenth of a second for no interesting reason.
    text_weight: float = 0.65
    #: How much comes from where the words are. Small but not negligible — it
    #: is the only thing that stops the DP matching a repeated word to the wrong
    #: occurrence of itself.
    time_weight: float = 0.35
    #: What leaving a word unmatched costs. A pair is matched only when its
    #: score beats `2 × gap_penalty`, so 0.30 puts the bar at 0.60: an
    #: identical word drifted by the full `max_drift_secs` (0.65) clears it, and
    #: two unrelated words at the same instant (≈0.42) do not.
    gap_penalty: float = 0.30
    #: Timing difference, in seconds, at which two words score zero on
    #: proximity. A tenth of a second of drift between passes is ordinary; a
    #: second is a different word.
    max_drift_secs: float = 1.0
    #: Beyond this separation, two words are never the same word — whatever
    #: their text. Five seconds is several utterances at any speaking rate, and
    #: it is the bound that keeps a filler word from matching its own next
    #: occurrence.
    band_secs: float = 5.0
    #: Proximity score for a pair where either word has no usable timestamp.
    #: Neutral, not zero: a missing timing is an absence of evidence, and
    #: scoring it as *disagreement* would drop every untimed word out of the
    #: alignment entirely.
    neutral_time_score: float = 0.5


@dataclass(frozen=True)
class _Key:
    """One word reduced to the two things alignment scores on."""

    norm: str
    mid: float | None


def align_word_streams(
    streams: Sequence[Sequence[Mapping[str, Any]]],
    params: AlignParams | None = None,
) -> list[tuple[int | None, ...]]:
    """The columns of an alignment of `streams`.

    Each column is a tuple of `len(streams)` entries: the index of that
    stream's word in this column, or `None` when that stream has no word here.
    Columns come back in time order, and every word of every stream appears in
    exactly one column — nothing is dropped, which is what lets a caller say
    "this word is in two of three passes" rather than losing it.

    `streams` are expected in the contract's own order, which is time order.
    """
    p = params or AlignParams()
    stream_count = len(streams)
    if stream_count == 0:
        return []

    keys = [[_Key(normalise(word_text(w)), word_mid(w)) for w in stream] for stream in streams]
    if stream_count == 1:
        return [(i,) for i in range(len(keys[0]))]

    columns: list[list[int | None]] = [
        [i] + [None] * (stream_count - 1) for i in range(len(keys[0]))
    ]
    for k in range(1, stream_count):
        consensus = [_consensus(column, keys, k) for column in columns]
        pairs = _pair_align(consensus, keys[k], p)
        columns = _splice(columns, pairs, k, stream_count)
    return [tuple(column) for column in columns]


def _consensus(column: Sequence[int | None], keys: Sequence[Sequence[_Key]], upto: int) -> _Key:
    """What the streams already in `column` agree this word is.

    The majority normalised reading (ties to the lowest stream index, so the
    answer never depends on iteration order) at the mean of the available
    midpoints. Averaging the times rather than taking the first stream's is the
    point of aligning progressively: by the third pass the column's position is
    better known than any single pass's, which is exactly the drift this check
    is built to tolerate.
    """
    texts: list[str] = []
    mids: list[float] = []
    for stream_index in range(upto):
        word_index = column[stream_index]
        if word_index is None:
            continue
        key = keys[stream_index][word_index]
        texts.append(key.norm)
        if key.mid is not None:
            mids.append(key.mid)
    norm = max(texts, key=lambda t: (texts.count(t), -texts.index(t))) if texts else ""
    return _Key(norm, sum(mids) / len(mids) if mids else None)


@lru_cache(maxsize=1 << 16)
def _similarity(a: str, b: str) -> float:
    """How alike two normalised words are, in `[0, 1]`.

    `difflib.SequenceMatcher` rather than a hand-rolled edit distance
    (`CLAUDE.md`: check for the existing implementation first) — it is stdlib,
    so it costs no dependency, and it is the same family of ratio
    `apelles-speech`'s `retake.rs` already scores utterances with via `strsim`.
    Equality is answered before it is consulted, both because it is the common
    case and because two words that normalise to nothing are equal while
    `SequenceMatcher` scores two empty strings 0.0.
    """
    if a == b:
        return 1.0
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def _pair_align(
    a: Sequence[_Key], b: Sequence[_Key], p: AlignParams
) -> list[tuple[int | None, int | None]]:
    """One monotone, non-crossing alignment of `a` against `b`.

    Returns `(i, j)` pairs in order: both set for a match, `j is None` for a
    word of `a` that `b` has nothing for, `i is None` for the reverse. See the
    module doc for the recurrence and why the gap bookkeeping disappears from
    it.
    """
    n, m = len(a), len(b)
    if n == 0:
        return [(None, j) for j in range(m)]
    if m == 0:
        return [(i, None) for i in range(n)]

    bar = 2.0 * p.gap_penalty
    width = m + 1
    # One byte per cell: 1 = matched, 2 = `a`'s word gapped, 3 = `b`'s word
    # gapped. A bytearray rather than a list of lists keeps a 2000x2000
    # alignment at 4 MB instead of 100 MB of boxed ints.
    moves = bytearray(width * (n + 1))
    for j in range(1, width):
        moves[j] = 3

    previous = [0.0] * width
    for i in range(1, n + 1):
        key_a = a[i - 1]
        current = [0.0] * width
        moves[i * width] = 2
        for j in range(1, width):
            best = previous[j]
            move = 2
            left = current[j - 1]
            if left > best:
                best, move = left, 3
            gain = _gain(key_a, b[j - 1], p, bar)
            if gain is not None:
                diagonal = previous[j - 1] + gain
                if diagonal > best:
                    best, move = diagonal, 1
            current[j] = best
            moves[i * width + j] = move
        previous = current

    out: list[tuple[int | None, int | None]] = []
    i, j = n, m
    while i > 0 or j > 0:
        move = moves[i * width + j]
        if move == 1:
            out.append((i - 1, j - 1))
            i, j = i - 1, j - 1
        elif move == 2:
            out.append((i - 1, None))
            i -= 1
        else:
            out.append((None, j - 1))
            j -= 1
    out.reverse()
    return out


def _gain(key_a: _Key, key_b: _Key, p: AlignParams, bar: float) -> float | None:
    """What matching these two words is worth over leaving both unmatched, or
    `None` when they may not be matched at all.

    `None` for two reasons, and they are different: outside
    [`AlignParams.band_secs`] they are not the same word however they read, and
    at or below the bar matching them is not an improvement — in both cases the
    DP must not consider the diagonal. Returning `None` rather than a very
    negative number keeps that a statement about the pair instead of a number
    that happens to lose.
    """
    if key_a.mid is not None and key_b.mid is not None:
        delta = abs(key_a.mid - key_b.mid)
        if delta > p.band_secs:
            return None
        proximity = max(0.0, 1.0 - delta / p.max_drift_secs) if p.max_drift_secs > 0 else 0.0
    else:
        proximity = p.neutral_time_score
    score = p.text_weight * _similarity(key_a.norm, key_b.norm) + p.time_weight * proximity
    gain = score - bar
    return gain if gain > 0.0 else None


def _splice(
    columns: Sequence[Sequence[int | None]],
    pairs: Sequence[tuple[int | None, int | None]],
    stream_index: int,
    stream_count: int,
) -> list[list[int | None]]:
    """`columns` with stream `stream_index` filled in from `pairs`, and a new
    column spliced in wherever that stream read a word the columns had no room
    for.

    The splice is what makes "present in only some passes" a reportable state
    rather than a silent loss: a word only the third pass heard ends up in a
    column whose first two slots are `None`, in the right place in time, and
    `reconcile.py` flags it from that alone.
    """
    out: list[list[int | None]] = []
    for column_index, word_index in pairs:
        if column_index is None:
            fresh: list[int | None] = [None] * stream_count
            fresh[stream_index] = word_index
            out.append(fresh)
            continue
        column = list(columns[column_index])
        if word_index is not None:
            column[stream_index] = word_index
        out.append(column)
    return out
