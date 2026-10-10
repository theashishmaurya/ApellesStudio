#!/usr/bin/env python3
"""The transcript contract, as the harness reads and writes it (D-374 step 3).

**What it is.** The ONE module in `harness/` that knows the contract's JSON
shape. Every check reads the contract through these helpers, so adding a check
never means re-deriving "where are the words" or "what counts as a window", and
changing the contract is one file's problem rather than every check's.

The contract is `ai-media/transcribe.py`'s return value, unchanged (D-374 §2):

```
{ text, language, model, source,
  segments: [ {start, end, text, words: [{word, start, end, probability?}]} ],
  words?:   [ ...the same words, flattened across every segment ],
  window?:  {start_secs, duration_secs} }
```

**What this module adds — the annotation vocabulary.** A check returns the
contract *plus* annotations, and there are exactly three places it may put
them, so a consumer has one place to look whatever checks ran:

| | |
|---|---|
| `words[i]["agreement"]` | per word — `{state, passes, of, alternatives?}` |
| `low_confidence` | `[{start, end, kind, detail}]`, time-ordered, merged per kind |
| `harness` | provenance — which checks ran, under which profile, and their headline numbers |

**What it does NOT do.** It does not transcribe, validate a backend, or know
that backends differ — that is [`harness.profiles`]. It does not interpret an
annotation; it only gives it a shape.
"""

from __future__ import annotations

import re
from typing import Any, Mapping, Sequence

__all__ = [
    "ContractError",
    "LOW_CONFIDENCE_MERGE_GAP_SECS",
    "add_low_confidence",
    "analysed_range",
    "check_contract",
    "flat_words",
    "normalise",
    "rebuild_from_reference",
    "record_provenance",
    "require_words",
    "word_mid",
    "word_text",
]


class ContractError(ValueError):
    """A contract that is not one — missing words, no segments, a pass that was
    run with `word_timestamps=False`.

    A distinct type because the harness's own failure mode is being handed the
    wrong thing: every check asserts the shape on the way in AND on the way out
    ([`check_contract`]), so a check that corrupts the contract fails at its own
    boundary instead of three checks later.
    """


# Two annotated spans of the same `kind` closer together than this are reported
# as one finding.
#
# 600 ms is this app's own existing answer to "how long a gap does a person read
# as *they stopped talking*" — `chroma_detect_silences`'s documented
# `min_silence_ms` default, which `apelles_speech::silence` derives its speech
# spans with. Reusing it rather than picking a new number keeps one definition
# of "the same moment in this recording" across the detectors, and it is the
# right scale: three consecutive words the passes disagreed about are one
# finding a person can act on, not three, while two findings either side of a
# real pause stay two.
LOW_CONFIDENCE_MERGE_GAP_SECS = 0.6

# Everything that is not part of a word for comparison purposes. The contract's
# words carry their leading space (`" want"`) and their trailing punctuation
# (`" down."`) exactly as the model emitted them — both are tokenisation, not
# content, and comparing them would make two passes disagree about a comma.
_NOT_WORD = re.compile(r"[^\w']+", re.UNICODE)


def normalise(text: str | None) -> str:
    """A word reduced to what two passes can meaningfully be said to agree on:
    casefolded, stripped of surrounding whitespace and punctuation.

    Apostrophes are KEPT — `"dont"` and `"don't"` are a real disagreement about
    what was said, not a spelling of the same token, and `retake.rs` downstream
    scores string similarity over exactly this kind of difference.
    """
    if not text:
        return ""
    return _NOT_WORD.sub("", text.casefold().strip())


def word_text(word: Mapping[str, Any]) -> str:
    """The word's text as the backend emitted it, or `""` when it emitted none."""
    value = word.get("word")
    return value if isinstance(value, str) else ""


def word_mid(word: Mapping[str, Any]) -> float | None:
    """The word's midpoint in absolute source seconds, or `None` when it has no
    usable timing.

    The midpoint rather than the start: two passes that both read a word but
    disagree about where it begins (which is what a shifted chunk boundary
    does) still agree about where it *is*. `None` is a real possibility — the
    contract allows a word with no timestamps — and must never become
    `None + offset`, the same care `transcribe._shift` takes.
    """
    start, end = word.get("start"), word.get("end")
    ok = (
        isinstance(start, (int, float))
        and not isinstance(start, bool)
        and isinstance(end, (int, float))
        and not isinstance(end, bool)
    )
    if not ok:
        return None
    return (float(start) + float(end)) / 2.0


def flat_words(contract: Mapping[str, Any]) -> list[dict]:
    """The contract's words, flattened across every segment, in contract order.

    Prefers the contract's own `words` list and falls back to walking the
    segments, because both are legitimate: `transcribe()` omits `words`
    entirely when the model returned no word timings at all, and a check that
    only ever read `contract["words"]` would silently see an empty transcript.
    """
    words = contract.get("words")
    if isinstance(words, list):
        return [dict(w) for w in words if isinstance(w, Mapping)]
    out: list[dict] = []
    for seg in contract.get("segments") or []:
        if not isinstance(seg, Mapping):
            continue
        for w in seg.get("words") or []:
            if isinstance(w, Mapping):
                out.append(dict(w))
    return out


def check_contract(contract: Any, *, where: str) -> dict:
    """`contract`, confirmed to be one — or [`ContractError`] naming `where`.

    Called on every check's input and output by [`harness.pipeline.run_checks`].
    The assertions are deliberately the cheap structural ones: a check that
    returns a list, drops `segments`, or hands back a transcript with no words
    at all is a bug in the check, and it should be reported against the check
    rather than against whatever reads the result afterwards.
    """
    if not isinstance(contract, dict):
        raise ContractError(f"{where}: expected a transcript contract (a dict), got {type(contract).__name__}")
    segments = contract.get("segments")
    if not isinstance(segments, list):
        raise ContractError(f"{where}: a contract has a `segments` list")
    for i, seg in enumerate(segments):
        if not isinstance(seg, dict):
            raise ContractError(f"{where}: segments[{i}] is not an object")
        if not isinstance(seg.get("words"), list):
            raise ContractError(f"{where}: segments[{i}] has no `words` list")
    return contract


def require_words(contract: Mapping[str, Any], *, where: str) -> list[dict]:
    """[`flat_words`], or [`ContractError`] when there are none.

    Separate from [`check_contract`] because a word-less contract is not
    malformed — `word_timestamps=False` produces one on purpose — it is just
    nothing a word-level check can say anything about. Refusing it by name
    beats reconciling three empty streams into an empty answer.
    """
    words = flat_words(contract)
    if not words:
        raise ContractError(
            f"{where}: this transcript has no word timings "
            "(transcribe with word_timestamps=True — the default)"
        )
    return words


def analysed_range(contract: Mapping[str, Any]) -> tuple[float, float]:
    """The absolute source seconds this transcript actually covers.

    From `window` when the pass was a windowed one (D-349 — `start_secs` /
    `duration_secs`, already shifted to absolute source seconds), and otherwise
    from the extent of its own words. Load-bearing for multi-pass
    reconciliation: without it, passes that cover slightly different ranges
    disagree about every word at their edges, and the check would report its own
    seams as findings — the exact opposite of its purpose.

    Returns `(0.0, 0.0)` for a transcript with neither a window nor a timed
    word; an empty range intersects to nothing, which is the honest answer.
    """
    window = contract.get("window")
    if isinstance(window, Mapping):
        start = window.get("start_secs")
        duration = window.get("duration_secs")
        if isinstance(start, (int, float)) and not isinstance(start, bool):
            start = float(start)
            if isinstance(duration, (int, float)) and not isinstance(duration, bool):
                return (start, start + float(duration))
            # A window with a start and no duration runs to the end of the
            # source; its words are the only evidence of where that is.
            mids = [m for m in (word_mid(w) for w in flat_words(contract)) if m is not None]
            return (start, max(mids) if mids else start)

    starts: list[float] = []
    ends: list[float] = []
    for w in flat_words(contract):
        s, e = w.get("start"), w.get("end")
        if isinstance(s, (int, float)) and not isinstance(s, bool):
            starts.append(float(s))
        if isinstance(e, (int, float)) and not isinstance(e, bool):
            ends.append(float(e))
    if not starts or not ends:
        return (0.0, 0.0)
    return (min(starts), max(ends))


def add_low_confidence(contract: dict, spans: Sequence[Mapping[str, Any]]) -> dict:
    """`contract` with `spans` folded into its `low_confidence` list.

    Spans of the same `kind` that touch or sit within
    [`LOW_CONFIDENCE_MERGE_GAP_SECS`] of each other become one, carrying the
    union of their `detail` lists; different kinds never merge, because
    "three passes disagreed here" and "the VAD hears speech nobody
    transcribed" are different findings about the same second and a consumer
    must be able to tell them apart.

    Idempotent and order-independent: re-folding the same spans gives the same
    list, which is what lets checks run in any order.
    """
    existing = contract.get("low_confidence")
    pool = list(existing) if isinstance(existing, list) else []
    pool.extend(spans)

    by_kind: dict[str, list[dict]] = {}
    for span in pool:
        kind = str(span.get("kind", "unknown"))
        by_kind.setdefault(kind, []).append(dict(span))

    merged: list[dict] = []
    for kind in sorted(by_kind):
        runs = sorted(by_kind[kind], key=lambda s: (float(s["start"]), float(s["end"])))
        current: dict | None = None
        for span in runs:
            if current is not None and float(span["start"]) - float(current["end"]) <= LOW_CONFIDENCE_MERGE_GAP_SECS:
                current["end"] = max(float(current["end"]), float(span["end"]))
                current["detail"] = list(current.get("detail") or []) + list(span.get("detail") or [])
                continue
            if current is not None:
                merged.append(current)
            current = {
                "start": float(span["start"]),
                "end": float(span["end"]),
                "kind": kind,
                "detail": list(span.get("detail") or []),
            }
        if current is not None:
            merged.append(current)

    merged.sort(key=lambda s: (s["start"], s["end"], s["kind"]))
    contract["low_confidence"] = merged
    return contract


def record_provenance(contract: dict, *, check: str, profile: str, **facts: Any) -> dict:
    """Note under `harness` that `check` ran, under which profile, and its
    headline numbers.

    Provenance rather than decoration: the whole point of the harness is to say
    where it is unsure, and "unsure" means nothing without "after which
    checks". A result that has been through reconciliation and a VAD
    cross-check is a different claim from one that has been through neither,
    and nothing else in the contract records the difference.
    """
    harness = contract.setdefault("harness", {})
    if not isinstance(harness, dict):  # a caller handed us a contract with a `harness` of its own
        raise ContractError("`harness` is reserved for check provenance and must be an object")
    harness["profile"] = profile
    ran = harness.setdefault("checks", [])
    if check not in ran:
        ran.append(check)
    if facts:
        harness[check] = dict(facts)
    return contract


def rebuild_from_reference(reference: Mapping[str, Any], words: Sequence[Mapping[str, Any]]) -> dict:
    """A contract carrying `words`, shaped like `reference`.

    The output of a word-level check has to be a *contract*, not a word list —
    everything downstream (`apelles-speech`, `editor_get_transcript`, the Recut
    panel, caption generation) consumes segments. So the reference pass's
    segment structure is kept and each segment's `words` is refilled from
    `words` by time: a word belongs to the segment whose range contains its
    start, and one that falls in no segment at all goes to the nearest, so a
    word recovered by a check can never be silently dropped on the floor.

    Segment and whole-transcript `text` are rebuilt from the words rather than
    copied, because a check that changed a reading must not leave the old
    sentence sitting above it. `language` / `model` / `source` / `window` come
    from the reference, which is where they are true of.
    """
    segments = [seg for seg in (reference.get("segments") or []) if isinstance(seg, Mapping)]
    bins: list[list[dict]] = [[] for _ in segments]

    if not segments:
        # No reference structure to preserve: one segment spanning the words is
        # a truthful contract, where dropping them would not be.
        timed = [m for m in (word_mid(w) for w in words) if m is not None]
        text = "".join(word_text(w) for w in words).strip()
        out = _carry_metadata(reference)
        out["segments"] = [
            {
                "start": min(timed) if timed else 0.0,
                "end": max(timed) if timed else 0.0,
                "text": text,
                "words": [dict(w) for w in words],
            }
        ]
        out["text"] = text
        if words:
            out["words"] = [dict(w) for w in words]
        return out

    bounds = [
        (
            float(seg.get("start") or 0.0),
            float(seg.get("end") if seg.get("end") is not None else seg.get("start") or 0.0),
        )
        for seg in segments
    ]

    for word in words:
        mid = word_mid(word)
        index = _segment_index(bounds, mid)
        bins[index].append(dict(word))

    out = _carry_metadata(reference)
    rebuilt = []
    for seg, bin_words in zip(segments, bins):
        text = "".join(word_text(w) for w in bin_words).strip()
        rebuilt.append(
            {
                **{k: v for k, v in seg.items() if k != "words"},
                "text": text,
                "words": bin_words,
            }
        )
    out["segments"] = rebuilt
    flat = [w for bin_words in bins for w in bin_words]
    out["text"] = " ".join(seg["text"] for seg in rebuilt if seg["text"]).strip()
    if flat:
        out["words"] = flat
    return out


def _segment_index(bounds: Sequence[tuple[float, float]], mid: float | None) -> int:
    """Which segment a word at `mid` belongs in — containing it if one does,
    else the nearest. A word with no timing at all goes to the first segment:
    it has to go somewhere, and the first is the only choice that does not
    depend on anything."""
    if mid is None:
        return 0
    for i, (start, end) in enumerate(bounds):
        if start <= mid < end or (i == len(bounds) - 1 and mid >= start):
            return i
    distances = [min(abs(mid - start), abs(mid - end)) for start, end in bounds]
    return distances.index(min(distances))


def _carry_metadata(reference: Mapping[str, Any]) -> dict:
    """Everything in `reference` that is not words, segments or text — the
    facts about the source and the run, which a check does not change."""
    return {k: v for k, v in reference.items() if k not in {"segments", "words", "text"}}
