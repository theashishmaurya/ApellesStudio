#!/usr/bin/env python3
"""D-374 step 3 — the N-stream word aligner, which is the hard part of the
harness and a pure function, so every case below has a correct answer.

`harness/align.py` is what multi-pass reconciliation stands on: align N word
streams with timestamps and differing tokenisation, and say per column which
pass had which word. Classification is easy once the columns are right and
meaningless when they are wrong, so the columns are what is tested hardest —
on synthetic streams, with no model anywhere near this file.

The scenarios are the ones that actually happen across passes of real footage
(D-374's measurement — run-on segments and dropped words clustering at chunk
seams), each reduced to its smallest form:

  1. identical passes — the boring case, and the one that must not be clever;
  2. a one-word substitution — the pair must still align, as a disagreement
     rather than as a drop plus an insertion;
  3. one pass dropping a RUN of words — the columns keep their place and only
     that pass's slots go empty;
  4. three passes disagreeing three ways — no majority, every reading kept;
  5. timestamps that DRIFT between passes — the same words, moved, still one
     column each;
  6. a word only one pass heard — a new column is spliced in, in time order;
  7. the time band — an identical word several utterances away is a different
     word, whatever it reads;
  8. determinism, the repo-wide invariant.

    python3 ai-media/test_harness_align.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from harness.align import AlignParams, align_word_streams  # noqa: E402
from harness.contract import normalise  # noqa: E402

#: One word every 0.5 s, which is a brisk but ordinary speaking rate and keeps
#: every fixture below readable as "word i sits at 0.5 i".
STEP = 0.5


def stream(words, *, start=0.0, step=STEP, drift=0.0):
    """A contract-shaped word stream: `words` laid out one per `step`, every
    timestamp shifted by `drift`.

    `None` in `words` leaves a hole in the LAYOUT rather than in the list — the
    way a dropped word really arrives, with its neighbours still where they
    were, not closed up.
    """
    out = []
    for i, text in enumerate(words):
        if text is None:
            continue
        at = start + i * step + drift
        out.append({"word": f" {text}", "start": round(at, 6), "end": round(at + 0.3, 6)})
    return out


SENTENCE = ["the", "quick", "brown", "fox", "jumps", "over", "the", "lazy", "dog"]


def texts(columns, streams):
    """Each column as the normalised readings its streams hold — the shape an
    expectation reads naturally in."""
    return [
        tuple(None if i is None else normalise(streams[k][i]["word"]) for k, i in enumerate(column))
        for column in columns
    ]


def check_identical_passes():
    a, b, c = (stream(SENTENCE) for _ in range(3))
    columns = align_word_streams([a, b, c])
    assert len(columns) == len(SENTENCE), columns
    for i, column in enumerate(columns):
        assert column == (i, i, i), f"column {i} is {column}"
    print("ok: identical passes align one-to-one, in order")


def check_one_word_substitution():
    said = list(SENTENCE)
    misheard = list(SENTENCE)
    misheard[3] = "box"  # fox -> box: one phoneme, the ordinary ASR mistake
    columns = align_word_streams([stream(said), stream(misheard)])

    assert len(columns) == len(SENTENCE), columns
    assert all(None not in column for column in columns), columns
    rows = texts(columns, [stream(said), stream(misheard)])
    assert rows[3] == ("fox", "box"), rows[3]
    assert [r[0] for r in rows] == SENTENCE, rows
    print("ok: a one-word substitution aligns as a disagreement, not a drop + an insertion")


def check_dropped_run():
    # The measured Parakeet/Whisper failure: a run of words nobody transcribed,
    # its neighbours still in place.
    dropped = list(SENTENCE)
    for i in (4, 5, 6):
        dropped[i] = None
    full, partial = stream(SENTENCE), stream(dropped)
    columns = align_word_streams([full, partial])

    assert len(columns) == len(SENTENCE), columns
    missing = [i for i, column in enumerate(columns) if column[1] is None]
    assert missing == [4, 5, 6], missing
    # Everything either side of the hole still pairs up, which is what makes
    # the hole locatable rather than smeared across the sentence.
    rows = texts(columns, [full, partial])
    assert rows[3] == ("fox", "fox"), rows[3]
    assert rows[7] == ("lazy", "lazy"), rows[7]
    print("ok: a pass that drops a run leaves exactly those columns empty for it")


def check_three_way_disagreement():
    # Groq / Gartner are D-374's own measured examples of this: a proper noun
    # every backend hears differently.
    a = stream(["we", "asked", "Gartner", "about", "it"])
    b = stream(["we", "asked", "Gutter", "about", "it"])
    c = stream(["we", "asked", "Garner", "about", "it"])
    columns = align_word_streams([a, b, c])

    assert len(columns) == 5, columns
    assert all(None not in column for column in columns), columns
    rows = texts(columns, [a, b, c])
    assert rows[2] == ("gartner", "gutter", "garner"), rows[2]
    print("ok: three passes disagreeing three ways keep one column and three readings")


def check_drifting_timestamps():
    # A pass started a little earlier moves whisper's 30 s window grid, so every
    # timestamp lands slightly elsewhere. Same words, same order, no disagreement.
    a = stream(SENTENCE)
    b = stream(SENTENCE, drift=0.18)
    c = stream(SENTENCE, drift=-0.22)
    columns = align_word_streams([a, b, c])
    assert len(columns) == len(SENTENCE), columns
    for i, column in enumerate(columns):
        assert column == (i, i, i), f"drift moved column {i} to {column}"

    # And it is the TEXT carrying this, not a coincidence of the grid: the same
    # drift with a substitution in it still gives one column per word.
    misheard = list(SENTENCE)
    misheard[4] = "jumped"
    columns = align_word_streams([a, stream(misheard, drift=0.18)])
    assert len(columns) == len(SENTENCE), columns
    print("ok: timestamps drifting between passes do not split a word into two columns")


def check_unrelated_substitution_is_a_drop_plus_an_insertion():
    """Two words that share nothing are two words, however identical their
    timing — and the result still says the harness is unsure here.

    A deliberate property of the scoring, not a shortfall: text carries 0.65 of
    a pair's score against a bar of 0.60, so a pair under ≈0.39 similarity can
    never be called the same word even at the same instant. Reporting
    `"the"` / `"elephant"` as one word read two ways would be a worse answer
    than reporting one word each pass only half of which heard — and
    reconciliation flags both shapes as low confidence either way.
    """
    said = list(SENTENCE)
    misheard = list(SENTENCE)
    misheard[6] = "elephant"
    columns = align_word_streams([stream(said), stream(misheard)])

    assert len(columns) == len(SENTENCE) + 1, columns
    halves = [column for column in columns if None in column]
    assert len(halves) == 2, halves
    assert {column.index(None) for column in halves} == {0, 1}, halves
    print("ok: an unrelated substitution is reported as a drop plus an insertion, both flagged")


def check_word_only_one_pass_heard():
    # D-374's own case in reverse: parakeet transcribed `"Cut from here"` at
    # 223.8 s, which whisper dropped entirely. A word only one pass heard must
    # survive, in the right place.
    without = ["please", "cut", "here"]
    with_extra = ["please", "cut", "from", "here"]
    a = stream(without, step=0.5)
    # Laid out so `from` really sits between `cut` and `here` in time.
    b = [
        {"word": " please", "start": 0.0, "end": 0.3},
        {"word": " cut", "start": 0.5, "end": 0.8},
        {"word": " from", "start": 0.82, "end": 0.95},
        {"word": " here", "start": 1.0, "end": 1.3},
    ]
    columns = align_word_streams([a, b])

    assert len(columns) == 4, columns
    assert columns[2] == (None, 2), columns
    rows = texts(columns, [a, b])
    assert [r[1] for r in rows] == with_extra, rows
    assert [r[0] for r in rows] == ["please", "cut", None, "here"], rows
    print("ok: a word only one pass heard becomes its own column, in time order")


def check_band_separates_repeats():
    # The same filler word twice, a long way apart. Text alone would match the
    # first `so` of one pass to the second `so` of the other; the band says two
    # utterances of a word are not one word.
    a = [
        {"word": " so", "start": 0.0, "end": 0.3},
        {"word": " so", "start": 30.0, "end": 30.3},
    ]
    b = [
        {"word": " so", "start": 30.1, "end": 30.4},
    ]
    columns = align_word_streams([a, b])
    assert len(columns) == 2, columns
    assert columns[0] == (0, None), columns
    assert columns[1] == (1, 0), columns

    # It is the band doing it: widen it past the separation and the near pair
    # still wins, because proximity is scored as well as allowed.
    wide = align_word_streams([a, b], AlignParams(band_secs=120.0))
    assert wide == [(0, None), (1, 0)], wide
    print("ok: the time band keeps two utterances of the same word apart")


def check_untimed_words_still_align():
    # The contract allows a word with no timestamps, and `transcribe._shift`
    # takes care not to arithmetic on one. The aligner must not drop them.
    a = [{"word": " alpha"}, {"word": " beta"}, {"word": " gamma"}]
    b = [{"word": " alpha"}, {"word": " beta"}, {"word": " gamma"}]
    assert align_word_streams([a, b]) == [(0, 0), (1, 1), (2, 2)]
    print("ok: words with no timestamps align on text alone")


def check_degenerate_inputs():
    assert align_word_streams([]) == []
    assert align_word_streams([stream(["one", "two"])]) == [(0,), (1,)]
    assert align_word_streams([[], []]) == []
    columns = align_word_streams([stream(["one"]), []])
    assert columns == [(0, None)], columns
    print("ok: no streams, one stream and an empty stream are all answered, not crashed")


def check_every_word_appears_exactly_once():
    # The invariant reconciliation relies on: nothing is dropped and nothing is
    # duplicated, so "this word is in two of three passes" is a fact about the
    # column and not an artefact of the merge.
    a = stream(SENTENCE)
    b = stream([w if i != 2 else None for i, w in enumerate(SENTENCE)])
    c = stream(SENTENCE + ["extra"])
    columns = align_word_streams([a, b, c])
    for k, source in enumerate((a, b, c)):
        seen = [column[k] for column in columns if column[k] is not None]
        assert sorted(seen) == list(range(len(source))), f"stream {k}: {seen}"
        assert seen == sorted(seen), f"stream {k} came back out of order: {seen}"
    print("ok: every word of every stream lands in exactly one column, in order")


def check_determinism():
    a = stream(SENTENCE)
    b = stream([w if i != 4 else "jumped" for i, w in enumerate(SENTENCE)], drift=0.1)
    c = stream([w if i != 1 else None for i, w in enumerate(SENTENCE)], drift=-0.1)
    first = align_word_streams([a, b, c])
    for _ in range(3):
        assert align_word_streams([a, b, c]) == first, "the aligner must be deterministic"
    print("ok: the aligner is deterministic across repeated runs")


def main() -> int:
    check_identical_passes()
    check_one_word_substitution()
    check_dropped_run()
    check_three_way_disagreement()
    check_drifting_timestamps()
    check_unrelated_substitution_is_a_drop_plus_an_insertion()
    check_word_only_one_pass_heard()
    check_band_separates_repeats()
    check_untimed_words_still_align()
    check_degenerate_inputs()
    check_every_word_appears_exactly_once()
    check_determinism()
    print("all harness aligner checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
