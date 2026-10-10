#!/usr/bin/env python3
"""D-374 step 2 / D-376 — the parakeet backend's two pure functions.

`parakeet-mlx` leaks three defects into its output and
[`asr.parakeet_mlx`] fixes all three before the contract ever sees them. Two of
those fixes are pure functions over a token list, which is deliberate: they are
the parts that must not regress, they need no model, and D-374's harness (step
3) can only reason about segmentation if segmentation is testable without
loading 0.6 B of weights.

What is checked, all of it over SYNTHETIC token lists so nothing here imports
`parakeet_mlx`, MLX or a weight:

  **`merge_tokens_to_words`** — the leading-space boundary
  1. the measured case: `' De' / 'cem' / 'ber'` → one `' December'`, taking its
     `start` from the first token and its `end` from the last;
  2. trailing punctuation joins the word it follows (`' ye' / 'ar' / ','` →
     `' year,'`), which is what makes a word here shaped like one of
     mlx-whisper's;
  3. the leading space SURVIVES — `retake.rs:263`'s convention;
  4. a first token with no leading space still starts a word; an empty token
     does not start one;
  5. **D-376**: a continuation token more than `WORD_TOKEN_GAP_MAX_S` after the
     word keeps its text and does NOT stretch the word's `end` — the real
     `' it' + '.'` 19.92 s case;
  6. a token can never make a word's `end` move backwards.

  **`segment_words`** — gaps and the hard cap
  7. a gap at or over `SEGMENT_GAP_S` splits; a smaller one does not (the
     boundary is `>=`, asserted on both sides of it);
  8. the hard cap splits a gapless run, and **no segment exceeds
     `SEGMENT_MAX_S`** — the fix for the measured 98.2 s run-on;
  9. a single word longer than the cap becomes its own over-long segment rather
     than being split mid-word or dropped — the one documented exception, pinned
     so it stays the only one;
 10. totality: every word appears exactly once, in order, across every
     segment, for a swept range of thresholds and a pseudo-random token stream;
 11. each segment's `text` is its words joined and stripped, and its
     `start`/`end` are its first and last word's.

    python3 ai-media/test_asr_parakeet.py
"""
import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from asr.parakeet_mlx import (  # noqa: E402
    SEGMENT_GAP_S,
    SEGMENT_MAX_S,
    WORD_TOKEN_GAP_MAX_S,
    Token,
    merge_tokens_to_words,
    segment_words,
)


def _toks(*spec) -> list[Token]:
    """`(text, start, end)` triples → tokens."""
    return [Token(text=t, start=s, end=e) for t, s, e in spec]


def _words(*spec) -> list[dict]:
    """`(word, start, end)` triples → contract word entries."""
    return [{"word": w, "start": s, "end": e} for w, s, e in spec]


# --------------------------------------------------------------------------- #
# merge_tokens_to_words
# --------------------------------------------------------------------------- #


def check_merge_measured_case() -> None:
    """The exact token stream D-374 measured, verbatim from the real source."""
    tokens = _toks(
        (" In", 2.56, 2.88),
        (" De", 3.04, 3.12),
        ("cem", 3.12, 3.36),
        ("ber", 3.36, 3.60),
        (" of", 3.60, 3.76),
        (" last", 3.76, 4.00),
        (" ye", 4.00, 4.08),
        ("ar", 4.08, 4.24),
        (",", 4.24, 4.40),
        (" N", 4.40, 4.64),
        ("vid", 4.64, 4.80),
        ("ia", 4.96, 5.12),
    )
    got = merge_tokens_to_words(tokens)
    assert got == _words(
        (" In", 2.56, 2.88),
        (" December", 3.04, 3.60),
        (" of", 3.60, 3.76),
        (" last", 3.76, 4.00),
        (" year,", 4.00, 4.40),
        (" Nvidia", 4.40, 5.12),
    ), got
    # 12 sub-word tokens → 6 words, which is the 2480→1296 ratio in miniature.
    assert len(got) == 6, len(got)
    print("ok: ' De'/'cem'/'ber' → ' December'; punctuation joins its own word")


def check_merge_keeps_leading_space() -> None:
    for word in merge_tokens_to_words(_toks((" a", 0.0, 0.1), ("b", 0.1, 0.2)))[:1]:
        assert word["word"] == " ab", word
    got = merge_tokens_to_words(_toks((" one", 0.0, 0.1), (" two", 0.2, 0.3)))
    assert [w["word"] for w in got] == [" one", " two"], got
    assert all(w["word"].startswith(" ") for w in got), got
    print("ok: the leading space survives the merge (retake.rs's own convention)")


def check_merge_edges() -> None:
    # a FIRST token with no leading space still starts a word
    got = merge_tokens_to_words(_toks(("In", 0.0, 0.2), ("deed", 0.2, 0.4)))
    assert got == _words(("Indeed", 0.0, 0.4)), got

    # an empty token does not start a word, and adds no characters
    got = merge_tokens_to_words(_toks((" a", 0.0, 0.1), ("", 0.1, 0.2), ("b", 0.2, 0.3)))
    assert got == _words((" ab", 0.0, 0.3)), got

    # a bare space starts a word (it carries the prefix), rather than vanishing
    got = merge_tokens_to_words(_toks((" a", 0.0, 0.1), (" ", 0.1, 0.2)))
    assert [w["word"] for w in got] == [" a", " "], got

    assert merge_tokens_to_words([]) == [], "empty in, empty out"
    print("ok: first/empty/bare-space tokens all behave as documented")


def check_merge_misaligned_punctuation() -> None:
    """D-376 — the real `' it' + '.'` case, 19.92 s apart."""
    tokens = _toks((" it", 250.40, 250.72), (".", 270.00, 270.32))
    got = merge_tokens_to_words(tokens)
    assert got == _words((" it.", 250.40, 250.72)), got
    assert got[0]["end"] - got[0]["start"] < 1.0, "the word is still 19.92s long"
    assert got[0]["word"] == " it.", "the full stop's TEXT must not be dropped"

    # the three other measured pairs, from the 49 found on the real source
    for word, punct, gap in ((" history", ".", 5.68), (" inference", ".", 12.16), (" models", ".", 9.44)):
        got = merge_tokens_to_words(
            _toks((word, 10.0, 10.32), (punct, 10.32 + gap, 10.64 + gap))
        )
        assert got == _words((word + punct, 10.0, 10.32)), (gap, got)

    # a gap just INSIDE the bound still counts — 0.480s was the largest
    # legitimate within-word gap measured on the real source
    got = merge_tokens_to_words(_toks((" wo", 0.0, 0.32), ("rd", 0.80, 1.12)))
    assert got == _words((" word", 0.0, 1.12)), got
    assert 0.80 - 0.32 <= WORD_TOKEN_GAP_MAX_S

    # …and just outside it does not
    got = merge_tokens_to_words(_toks((" wo", 0.0, 0.32), ("rd", 0.90, 1.22)))
    assert got == _words((" word", 0.0, 0.32)), got

    # an out-of-order token never moves `end` backwards
    got = merge_tokens_to_words(_toks((" a", 5.0, 5.4), ("b", 5.1, 5.2)))
    assert got == _words((" ab", 5.0, 5.4)), got
    print(f"ok: a token >{WORD_TOKEN_GAP_MAX_S}s adrift keeps its text, not its vote on `end`")


# --------------------------------------------------------------------------- #
# segment_words
# --------------------------------------------------------------------------- #


def check_segment_gap_boundary() -> None:
    """The split condition is `>=`, asserted on both sides."""
    just_under = _words((" a", 0.0, 1.0), (" b", 1.0 + SEGMENT_GAP_S - 0.01, 2.0))
    assert len(segment_words(just_under)) == 1, segment_words(just_under)

    exactly = _words((" a", 0.0, 1.0), (" b", 1.0 + SEGMENT_GAP_S, 2.0))
    assert len(segment_words(exactly)) == 2, segment_words(exactly)

    over = _words((" a", 0.0, 1.0), (" b", 5.0, 6.0))
    got = segment_words(over)
    assert len(got) == 2, got
    assert got[0] == {"start": 0.0, "end": 1.0, "text": "a", "words": over[:1]}, got[0]
    assert got[1] == {"start": 5.0, "end": 6.0, "text": "b", "words": over[1:]}, got[1]
    print(f"ok: a gap >= {SEGMENT_GAP_S}s splits, a smaller one does not")


def check_segment_hard_cap() -> None:
    """The fix for the measured 98.2 s run-on: a GAPLESS run still splits."""
    # 300 contiguous words with no gap at all — exactly the shape that gave
    # `result.sentences` a 98.2 s segment (223.8 → 322.0 s).
    words = [{"word": f" w{i}", "start": 223.8 + i * 0.33, "end": 223.8 + (i + 1) * 0.33}
             for i in range(300)]
    got = segment_words(words)

    spans = [s["end"] - s["start"] for s in got]
    assert max(spans) <= SEGMENT_MAX_S + 1e-9, f"a segment exceeded the cap: {max(spans)}"
    assert not any(s > 30.0 for s in spans), spans
    assert len(got) > 1, "a 99s gapless run produced one segment"
    assert 98.2 > max(spans), "the measured run-on length is still reachable"
    print(
        f"ok: a 99s gapless run becomes {len(got)} segments, longest "
        f"{max(spans):.2f}s <= {SEGMENT_MAX_S}s (was 98.2s)"
    )

    # the documented exception, pinned so it stays the ONLY one: a single word
    # longer than the cap is kept whole rather than split mid-word or dropped.
    lone = _words((" aaa", 0.0, SEGMENT_MAX_S + 5.0))
    got = segment_words(lone)
    assert got == [{"start": 0.0, "end": SEGMENT_MAX_S + 5.0, "text": "aaa", "words": lone}], got

    # and it does not contaminate its neighbours
    mixed = _words((" a", 0.0, 0.1), (" big", 0.1, SEGMENT_MAX_S + 5.0), (" c", SEGMENT_MAX_S + 5.0, SEGMENT_MAX_S + 5.1))
    got = segment_words(mixed)
    over = [s for s in got if s["end"] - s["start"] > SEGMENT_MAX_S]
    assert len(over) == 1 and len(over[0]["words"]) == 1, got
    print("ok: a single over-long word is the one exception, and stays alone")


def check_segment_shape() -> None:
    words = _words((" Hello", 0.0, 0.5), (" there.", 0.5, 1.0))
    got = segment_words(words)
    assert got == [
        {"start": 0.0, "end": 1.0, "text": "Hello there.", "words": words}
    ], got
    assert segment_words([]) == [], "no words, no segments"

    # the `words` list is a copy of the slice, so mutating the segment cannot
    # reorder the caller's own list
    assert got[0]["words"] is not words
    print("ok: a segment's text/start/end come from its own words")


def check_segment_totality() -> None:
    """Every word, exactly once, in order — swept over thresholds and inputs."""
    rng = random.Random(374)  # seeded: `CLAUDE.md` forbids an un-seeded anything
    cases = 0
    for _ in range(200):
        t = 0.0
        words = []
        for i in range(rng.randint(1, 120)):
            t += rng.choice([0.0, 0.0, 0.0, 0.08, 0.32, 0.9, 4.0, 20.0])
            dur = rng.choice([0.08, 0.24, 0.32, 1.0, 18.0])
            words.append({"word": f" w{i}", "start": round(t, 6), "end": round(t + dur, 6)})
            t += dur
        for gap in (0.08, SEGMENT_GAP_S, 1.0, 5.0):
            for cap in (1.0, SEGMENT_MAX_S, 60.0):
                got = segment_words(words, gap_s=gap, max_s=cap)
                flat = [w for s in got for w in s["words"]]
                assert flat == words, (gap, cap, len(flat), len(words))
                for s in got:
                    assert s["start"] == s["words"][0]["start"]
                    assert s["end"] == s["words"][-1]["end"]
                    assert s["end"] >= s["start"]
                    # over the cap only ever because of ONE word
                    if s["end"] - s["start"] > cap:
                        assert len(s["words"]) == 1, (gap, cap, s)
                cases += 1
    print(f"ok: {cases} swept cases — every word kept, in order, no segment over cap but a lone word")


def main() -> int:
    check_merge_measured_case()
    check_merge_keeps_leading_space()
    check_merge_edges()
    check_merge_misaligned_punctuation()
    check_segment_gap_boundary()
    check_segment_hard_cap()
    check_segment_shape()
    check_segment_totality()
    print("all D-374/D-376 parakeet merge+segmentation checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
