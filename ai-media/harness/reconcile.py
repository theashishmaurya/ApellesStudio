#!/usr/bin/env python3
"""Check 1 — multi-pass reconciliation (D-374 step 3).

**What it is.** The check the owner's speed requirement exists for. Run the
same source N times, varying something that moves the model's own boundaries
without changing a sample of the audio, then say per word whether the passes
agreed. At 17.6× realtime three passes of a 989 s source cost ~170 s (D-374's
measurement), which is what buys this.

**The knob is the chunk offset**, and that is a measured choice, not an
aesthetic one: Parakeet's two real failures — run-on segments and dropped words
— cluster at chunk seams, so moving the seams is what makes a second pass
disagree *informatively* rather than reproduce the first. Both backends expose
it through the contract this check already reads: for `mlx-whisper` a pass
started a little earlier shifts its 30 s window grid (`transcribe()`'s
`start_secs`/`duration_secs`, D-349, whose timestamps come back in absolute
source seconds precisely so windowed passes are comparable); for
`parakeet-mlx` it is `chunk_duration`/`overlap_duration`.

**Producing the passes is NOT this check's job** — running a backend N times is
a backend's job. [`MultiPassReconcile`] is constructed *with* the other passes,
all of them contracts, so the check still only ever sees contracts and can
never reach a model. That is the harness's structural rule, and this check is
the one that would have been tempting to break it.

**What it emits.** The same contract, plus:

- `words[i]["agreement"]` — `unanimous` (every pass read this), `disagreed`
  (they read it differently; the majority reading is kept and the others are
  recorded), `partial` (only some passes have a word here at all; it is kept
  and flagged), or `outside` (it lies beyond the range every pass covered, so
  there was nothing to compare it against).
- `low_confidence` spans of kind `reconcile` over everything that was not
  unanimous. **This is the honest answer to "we can't get 100 %"**: the
  transcript says where it is unsure instead of pretending.

**What it does NOT do.** It does not transcribe, re-transcribe, repair or
re-time anything. A kept word's timings are the ones the pass it was taken from
actually produced — never an average — so the result stays a transcript some
backend really could have returned.

The alignment it stands on is [`harness.align`], a pure function with its own
tests. Everything in this file is the dozen lines of classification that
become easy once the columns exist.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

from .align import AlignParams, align_word_streams
from .contract import (
    ContractError,
    add_low_confidence,
    analysed_range,
    normalise,
    rebuild_from_reference,
    record_provenance,
    require_words,
    word_mid,
    word_text,
)
from .pipeline import CheckContext
from .profiles import BackendProfile, profile_for

__all__ = ["CHECK_NAME", "MultiPassReconcile", "reconcile_passes"]

#: The name this check records in `harness.checks`.
CHECK_NAME = "multi_pass_reconcile"

#: The states [`reconcile_passes`] can put in a word's `agreement`, worst
#: first. Ordered because the state is the *lowest* confidence that applies: a
#: column that both lost a pass and disagrees is reported as `partial`, the
#: weaker claim, rather than as a disagreement among the passes that happen to
#: be present.
AGREEMENT_STATES = ("outside", "partial", "disagreed", "unanimous")


def reconcile_passes(
    passes: Sequence[Mapping[str, Any]],
    *,
    profile: BackendProfile | None = None,
    params: AlignParams | None = None,
) -> dict:
    """One contract reconciled out of `passes`, which must all be transcripts
    of the same source.

    The first pass is the **reference**: its segment structure, language, model
    and window are what the result is shaped like, and its reading wins a tie.
    That is a deliberate asymmetry — a reconciled transcript has to be a
    contract, and segments have to come from somewhere — not an accident of
    implementation.

    **Only the range every pass covered is reconciled.** A word a wider pass
    found outside it is not adopted — reconciliation has nothing to say about
    it, and adding it would put un-cross-checked content into the reference's
    own segments (measured live: three passes 10 s apart contributed 15 such
    words before the reference's first segment).
    `harness.multi_pass_reconcile.discarded` counts them. The reference's own
    words outside the range are kept and marked `outside`.

    Raises [`ContractError`] for fewer than two passes, for a pass with no word
    timings, and for passes whose analysed ranges do not overlap at all (there
    is nothing to reconcile, and silently returning the reference would be the
    harness lying about having checked).
    """
    if len(passes) < 2:
        raise ContractError(
            f"{CHECK_NAME}: reconciliation needs at least two passes, got {len(passes)}"
        )
    streams = [require_words(p, where=f"{CHECK_NAME}: pass {i}") for i, p in enumerate(passes)]
    reference = passes[0]
    resolved = profile or profile_for(reference)

    ranges = [analysed_range(p) for p in passes]
    common = (max(r[0] for r in ranges), min(r[1] for r in ranges))
    if common[1] <= common[0]:
        raise ContractError(
            f"{CHECK_NAME}: the passes do not overlap — ranges {ranges!r}. "
            "Reconciliation compares passes over the same audio."
        )

    columns = align_word_streams(streams, params)
    stream_count = len(streams)

    words: list[dict] = []
    spans: list[dict] = []
    counts = {state: 0 for state in AGREEMENT_STATES}
    discarded = 0

    for column in columns:
        present = [(k, index) for k, index in enumerate(column) if index is not None]
        # `align_word_streams` never emits an empty column; this is the
        # assertion that keeps that an invariant rather than a hope.
        if not present:
            raise ContractError(f"{CHECK_NAME}: the alignment produced an empty column")

        # The distinct readings of this word, each remembering which passes held
        # it and in what pass order it was first seen — the whole basis of both
        # the majority choice and the recorded alternatives.
        readings: dict[str, list[int]] = {}
        first_seen: dict[str, tuple[int, int]] = {}
        for k, index in present:
            reading = normalise(word_text(streams[k][index]))
            if reading not in readings:
                readings[reading] = []
                first_seen[reading] = (k, index)
            readings[reading].append(k)

        # Majority wins; a tie goes to the pass that saw it first, which with
        # the reference at index 0 means the reference's reading wins a tie.
        chosen_reading = max(readings, key=lambda r: (len(readings[r]), -first_seen[r][0]))
        chosen_stream, chosen_index = first_seen[chosen_reading]
        word = dict(streams[chosen_stream][chosen_index])

        mid = word_mid(word)
        outside = mid is not None and not (common[0] <= mid <= common[1])
        if outside and column[0] is None:
            # A word only a WIDER pass covered, outside the range every pass
            # covered: reconciliation has no opinion on it, and adopting it
            # would put un-cross-checked content into the reference's own
            # segments — measured live, where three passes 10 s apart
            # contributed 15 such words before the reference's first segment
            # and the rebuild binned them all into it. The reference's own
            # words outside the range are kept (as `outside`); words that are
            # not the reference's are not adopted.
            discarded += 1
            continue
        if outside:
            state = "outside"
        elif len(present) < stream_count:
            state = "partial"
        elif len(readings) > 1:
            state = "disagreed"
        else:
            state = "unanimous"
        counts[state] += 1

        agreement: dict[str, Any] = {
            "state": state,
            "passes": len(present),
            "of": stream_count,
        }
        alternatives = [
            {
                "word": word_text(streams[first_seen[reading][0]][first_seen[reading][1]]),
                "passes": list(holders),
            }
            for reading, holders in readings.items()
            if reading != chosen_reading
        ]
        if alternatives:
            agreement["alternatives"] = alternatives
        word["agreement"] = agreement
        words.append(word)

        if state in {"partial", "disagreed"}:
            span = _span_for(word)
            if span is not None:
                spans.append(
                    {
                        "start": span[0],
                        "end": span[1],
                        "kind": CHECK_NAME,
                        "detail": [{"word": word_text(word), **agreement}],
                    }
                )

    out = rebuild_from_reference(reference, words)
    add_low_confidence(out, spans)
    record_provenance(
        out,
        check=CHECK_NAME,
        profile=resolved.name,
        passes=stream_count,
        words=len(words),
        range_secs=[common[0], common[1]],
        discarded=discarded,
        **{state: counts[state] for state in AGREEMENT_STATES},
    )
    return out


def _span_for(word: Mapping[str, Any]) -> tuple[float, float] | None:
    """The word's own `[start, end)`, or `None` when it has no usable timing.

    A word with no timestamps is still annotated — its `agreement` is on the
    word itself — but it cannot become a `low_confidence` span, because a span
    nobody can locate is not something a human or an agent can act on.
    """
    start, end = word.get("start"), word.get("end")
    for value in (start, end):
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            return None
    return (float(start), float(end))  # type: ignore[arg-type]


class MultiPassReconcile:
    """[`reconcile_passes`] as a pipeline check.

    Constructed with the OTHER passes — contracts, every one — so that the
    check's own call still receives nothing but a contract and a
    [`CheckContext`]. The contract flowing through the pipeline is the
    reference; `extra_passes` join it in the order given.
    """

    name = CHECK_NAME

    def __init__(
        self,
        extra_passes: Sequence[Mapping[str, Any]],
        *,
        params: AlignParams | None = None,
    ) -> None:
        self.extra_passes = list(extra_passes)
        self.params = params

    def __call__(self, contract: Mapping[str, Any], context: CheckContext) -> dict:
        return reconcile_passes(
            [contract, *self.extra_passes],
            profile=context.profile,
            params=self.params,
        )
