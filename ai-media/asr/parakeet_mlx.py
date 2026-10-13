#!/usr/bin/env python3
"""The parakeet-mlx backend — Apelles' only ASR backend, defects fixed here (D-374, D-381).

**What it is:** NVIDIA `parakeet-tdt-0.6b-v3` via `parakeet-mlx`, behind
[`base.AsrBackend`]. 0.6 B params, and measured end-to-end through the seam at
**38.3 s for the owner's own 989.5 s C038 source — 25.8× realtime**, against
`mlx-whisper large-v3`'s 369.6 s on the same machine (D-377's timing; D-374's
first, model-only measurement was 56.3 s / 17.6×; both tables are in
`docs/notes/asr-backends-and-harness.md`).

**The default, and since D-381 the only backend.** It was opt-in from D-374 until
2026-10-13, when the owner decommissioned Whisper. D-377 had kept Whisper the
default on one number from the retake detector's rules; D-378's labelled eval
did not reproduce it, and D-379's found retake proposals made from Parakeet's
word-timed transcripts losing no content at all. D-381 has the reasoning.

**What it does NOT do:** no ffmpeg, no windowing, no timestamp shifting and no
`words` flattening; `transcribe.py` owns all of that, identically for every
backend, which is what makes D-349's windowing work here for free.

**It is not more accurate than Whisper was, and this file does not pretend it
is.** Measured on the same source: it drops domain and proper nouns Whisper
caught (`KV cache` 1→0, `chaiwala` 1→0, `stenographer` 2→1, `Nvidia` 2→1) and
spells numbers out ("Twenty billion dollars" vs "$20 billion"). It is better in
two measured places: it transcribed `"Cut from here"` at 223.8 s — a spoken
instruction to the editor — which Whisper dropped entirely, and it emits nothing
on silent B-roll where Whisper hallucinated `"Thank you."` (D-377). D-374's
reasoning is that ~10× faster and ~2 % worse is a *better input to a multi-pass
harness*, not that it wins head-to-head.

**Languages: 25 European, and Hindi is not one of them.** D-381 records
Hindi/Hinglish sources as unsupported (the owner's call — it does not matter for
this product). [`PARAKEET_LANGUAGES`] is the refusal surface for a caller that
names a language; see `base.check_language`.

---

**The THREE defects this file exists to fix**, all measured on the real C038
source, and all of which it must solve rather than leak to callers. D-374 named
the first two; the third was found by re-running that source through this
backend and is recorded as **D-376**:

1. **`parakeet-mlx` token timings are SUB-WORD.** `"December"` comes back as
   three tokens — `' De' / 'cem' / 'ber'` — 2480 tokens for ~1296 words. Word
   timings are derivable but not native. [`merge_tokens_to_words`] does it on the
   **leading-space boundary**, which is also the convention
   `crates/apelles-speech/src/retake.rs`'s `normalise` already neutralises for
   mlx-whisper — so a merged word carries its leading space exactly as a
   mlx-whisper word does (`' December'`, `' year,'`), and every existing consumer
   sees the shape it already expects.

2. **`result.sentences` is unusable as segmentation.** It produced one segment
   spanning **223.8 → 322.0 s — 98.2 s** — swallowing five of Whisper's.
   `retake.rs` compares *utterances*; a 98 s utterance is not a comparison unit.
   [`segment_words`] derives segments from the gaps between consecutive words
   with a hard maximum length, so that run-on is structurally impossible. See
   [`SEGMENT_GAP_S`] and [`SEGMENT_MAX_S`] for the numbers and why they are those
   numbers.

3. **Sentence-final punctuation is timestamped at the end of the following
   silence, not at the word it punctuates** (D-376). 49 of 1184 within-word
   token gaps exceed 0.5 s and 47 of those are a bare `.` / `,` / `?` / `'` —
   `' inference' + '.'` is 12.16 s apart. Taken literally that makes ~4 % of
   words seconds too long, which is fatal for "cut to the exact spoken word",
   and it produced a 19.92 s single-word segment that defeated the cap in (2).
   [`WORD_TOKEN_GAP_MAX_S`] keeps such a token's text and denies it a vote on
   the word's `end`.

Why `result.sentences` fails is worth recording, because it looks like a library
bug and is not: `parakeet_mlx.alignment.tokens_to_sentences` splits on
sentence-final punctuation and, optionally, on `SentenceConfig`'s `silence_gap` /
`max_duration` / `max_words` — all of which default to `None`. So out of the box
the only boundary is punctuation, and the model simply emitted none for 98
seconds. Passing a populated `SentenceConfig` would fix the run-on, and is
deliberately **not** what this file does, for two reasons that are not style
preferences:

  - its `max_duration` check looks only at elapsed time, so it can fire
    *between two sub-word tokens of one word* and cut `' De' | 'cem' 'ber'` in
    half; ours runs after the merge and can only ever split between words;
  - D-374's harness (step 3) is a pipeline of checks over the contract, and a
    check may never reach for a model. Segmentation that lives inside a
    `DecodingConfig` handed to `model.transcribe` cannot be tested, swept or
    reasoned about without loading 0.6 B of weights. As two pure functions over
    a token list it needs no model at all, which is how
    `test_asr_parakeet.py` tests it.

---

**Determinism.** Greedy TDT decoding, no sampling anywhere, so no seed is needed
and none is set. That is why decommissioning Whisper also retired D-349's
`MLX_RANDOM_SEED`: the seed existed only because mlx-whisper's
temperature-fallback ladder sampled from MLX's global RNG (B-224), and nothing
in this backend draws from an RNG at all. Verified by transcribing the real
C038 WAV twice through this backend and diffing the result — byte-identical
(D-374, re-checked for D-381; `CLAUDE.md`'s "render the same frame twice,
diff").

**No per-word `probability`.** `parakeet_mlx` does expose a per-token
`confidence`, but it is `1.0 - entropy/max_entropy` over the token's frames —
an entropy-derived score, not a probability. The contract's `probability` field
is optional, nothing in this repo reads it (grepped: the only `probability`
consumers are Silero VAD's own speech probabilities), and putting a
non-probability in a field named `probability` would mislead exactly the future
harness check that might one day threshold on it. Omitted on purpose, recorded
in the note's §5.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence

from asr.base import BackendDescriptor, local_snapshot_or_repo
from errors import UserFacingError

NAME = "parakeet"

DEFAULT_MODEL = "parakeet-tdt-0.6b-v3"

# `parakeet_mlx.from_pretrained` loads from an HF repo id or a local directory.
# One entry: v3 is the multilingual (25 European languages) TDT release D-374
# measured. v2 exists and is English-only; it is not listed because nothing has
# measured it here and `CLAUDE.md` does not allow an untested option carried
# "just in case". Carried on the descriptor (`BackendDescriptor.model_repos`)
# because `server.py`'s `/health` reports it too, and one map is one source of
# truth.
MODEL_REPOS = {
    DEFAULT_MODEL: "mlx-community/parakeet-tdt-0.6b-v3",
}

# The 25 European languages `nvidia/parakeet-tdt-0.6b-v3` is trained on, as its
# own model card lists them — the 24 official EU languages minus Irish, plus
# Russian and Ukrainian.
#
# **Hindi is deliberately, verifiably absent**, which is the whole reason this
# set is encoded rather than described: `transcribe.py` has promised since D-189
# that code-switched Hinglish auto-detects fine on `large-v3`, and a Hinglish
# source handed to this model does not fail — it returns confident, fluent,
# wrong English. `base.check_language` refuses it instead.
#
# **Do NOT "fix" this list from the model's own `config.json`.** Its
# `joint.vocabulary` carries the full ISO-639-1 inventory — 190-odd `<|xx|>`
# tokens, `<|hi|>` among them — because it is NeMo's shared multilingual
# tokenizer vocabulary, not the trained language set. Checked 2026-10-09 while
# writing this file; the model card is the authority.
PARAKEET_LANGUAGES = frozenset(
    {
        "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu",
        "it", "lv", "lt", "mt", "pl", "pt", "ro", "sk", "sl", "es", "sv", "ru",
        "uk",
    }
)

# `max_word_secs=None` — the dark-region check's too-long-word bound does not
# apply to this backend, and that is a structural claim rather than a missing
# measurement. The bound exists because whisper's DTW alignment stretches one
# token across a region it dropped, so a long word is not real coverage.
# Parakeet's duration head caps a TOKEN at 0.320 s (measured exactly on C038:
# p50 0.240 s, p99 0.320 s, max 0.320 s over 2480 tokens — see
# [`WORD_TOKEN_GAP_MAX_S`]), and [`merge_tokens_into_words`] refuses to merge
# across a gap wider than that cap anyway (D-376), so no word this backend
# emits can span an untranscribed hole. Excluding long words here would only
# throw away genuine coverage. The number lives in the descriptor, not in the
# check, precisely because the two backends need different answers — D-375.
DESCRIPTOR = BackendDescriptor(
    name=NAME,
    default_model=DEFAULT_MODEL,
    model_repos=MODEL_REPOS,
    languages=PARAKEET_LANGUAGES,
    language_summary="25 European languages",
    max_word_secs=None,
)

# --------------------------------------------------------------------------- #
# chunking — the knobs the measurement was taken with
# --------------------------------------------------------------------------- #

# `parakeet-mlx` splits a long file itself and merges the chunks' token streams
# by longest-contiguous (falling back to longest-common-subsequence) match
# across the overlap. These are the values D-374's measurement used, so they are
# what reproduces 56.3 s / 1296 words / 2480 tokens on the C038 source; changing
# them changes the numbers this file's own docstring cites.
#
# D-374 §3.1 VARIES the chunk offset as the multi-pass harness's one knob,
# precisely because the measured failures (run-on segments, dropped words)
# cluster at chunk seams. The harness (D-375) does that today through
# `transcribe()`'s `start_secs` — the chunker starts from the audio it is
# handed, so a pass started 10 s earlier has every seam 10 s elsewhere — which
# needs nothing threaded through here. These stay module constants until a
# caller wants them as parameters directly (`CLAUDE.md` does not allow a
# parameter nothing passes); `docs/notes/asr-backends-and-harness.md` §5.
CHUNK_DURATION_S = 120.0
OVERLAP_DURATION_S = 15.0

# --------------------------------------------------------------------------- #
# segmentation — the fix for the measured 98.2 s run-on
# --------------------------------------------------------------------------- #

# Split a segment when the silence between two consecutive WORDS reaches this.
#
# 0.32 s is **exactly one maximum-length token** — the TDT duration head's
# ceiling, `num_tdt_durations: 5` frames x the 0.08 s subsampled frame, measured
# on the C038 source as p50 0.240 s, p99 0.320 s, **max 0.320 s** over all 2480
# tokens. So the rule is "a gap at least as long as the longest thing this model
# can call one token", which is the smallest interval it can actually represent
# as a whole token's worth of silence. A unit the model defines, rather than a
# percentile that moves with the content.
#
# Picking it needed the measurement because intuition from Whisper's numbers is
# wrong here. Parakeet's word gaps are far tighter — a duration head assigns
# every frame to a token, so it does not leave the sub-second breathing room
# whisper's attention timestamps do: post-merge the distribution on C038 is
# p50 0.000 s, **p90 0.240 s**, p95 0.880 s, p99 10.240 s. Swept over that one
# token stream, a whisper-flavoured 0.5 s splits almost nothing and leaves
# [`SEGMENT_MAX_S`] doing all the work (78 segments, median 6.2 s), while the
# p90 itself over-splits into 145 segments of median 2.96 s — **29 of them under
# the 3 words `retake.rs`'s `min_words` will even compare**, against 6 at
# 0.32 s.
#
# Measured end-to-end through `transcribe(backend="parakeet")` on the real
# 989.5 s source, this constant and the cap below give **87 segments, median
# 5.12 s, p90 12.32 s, max 14.96 s, 0 over 30 s**, from 1296 words — against the
# committed Whisper fixture's 121 / 5.36 s / 9.20 s / 15.92 s, and against raw
# `result.sentences`' 75 / 9.44 s / **98.20 s**. The medians are the statistic
# that matters for an utterance-comparing retake detector, and they agree to
# within 0.25 s.
SEGMENT_GAP_S = 0.32

# The hard ceiling on one segment's length. This is the constant that makes the
# measured 98.2 s run-on (223.8 → 322.0 s, swallowing five of Whisper's
# segments) structurally impossible rather than merely unlikely.
#
# 15.0 s because that is the envelope Whisper's output — which every downstream
# consumer was tuned against — actually occupies: on this same source Whisper's
# longest segment was **15.9 s** and **none exceeded 30 s**. It also keeps
# `apelles-speech`'s retake detector inside its own bounds, which compares spans
# of up to `max_span_utterances: 3` inside a `window_secs: 30.0` — three
# 15-second utterances is 45 s of span against a 30 s window, where three
# 20-second ones would be 60 s and three 98-second ones are not a comparison at
# all.
#
# The guarantee: a segment is closed before the word that would take it past
# this, so every segment is <= this long unless ONE WORD is longer than the cap
# on its own — kept whole rather than split mid-word.
#
# **That exception is not theoretical and this file originally claimed it had
# never been observed, which was wrong** (D-376). Parakeet's duration head caps
# one TOKEN at 0.320 s (`num_tdt_durations: 5` frames x the 0.08 s subsampled
# frame — measured exactly: p50 0.240 s, p99 0.320 s, max 0.320 s), so a word
# cannot legitimately be long; but a MIS-TIMED punctuation token made `' it.'`
# span 19.92 s on a windowed run of the real source, and that segment really did
# exceed this cap. [`WORD_TOKEN_GAP_MAX_S`] is the fix, at the merge, where the
# defect is. With it, the exception is back to needing a genuine ~47-token word
# and the cap holds on every measured run, windowed and whole-file.
#
# Measured, not settled. D-374 step 4 (D-377) re-swept the retake thresholds
# against Parakeet transcripts and did not move this: Parakeet's longest
# segment over the three speech sources was 14.96 s, inside the cap, so the cap
# was never the binding constraint (`docs/notes/asr-backends-and-harness.md`
# §4.2).
SEGMENT_MAX_S = 15.0

# A `parakeet_mlx` token whose text starts with this begins a new word. The
# convention is the model tokenizer's (SentencePiece marks word starts), and it
# is the same one `crates/apelles-speech/src/retake.rs`'s `normalise` already
# neutralises for mlx-whisper's `" word"` entries.
WORD_START_PREFIX = " "

# How far a continuation token may be from the word it belongs to before its
# timestamp is treated as MIS-ALIGNED (D-376).
#
# This is a third defect, found by re-running the real C038 source through this
# backend rather than from D-374's own measurements, and it is systematic:
# `parakeet-mlx` timestamps a **sentence-final punctuation token at the end of
# the following silence** instead of at the word it punctuates. Measured over
# the 1184 within-word token gaps on that source — p50 0.000 s, p90 0.000 s,
# p99 6.400 s, **max 12.480 s** — **49 gaps exceed 0.5 s and 47 of those are a
# bare `.` / `,` / `?` / `'`**: `' history' + '.'` 5.68 s apart, `' inference' +
# '.'` 12.16 s apart, `' models' + '.'` 9.44 s apart.
#
# Taken literally that makes ~4 % of words several seconds too long, which
# corrupts the one thing word timings exist for — cutting to an exact spoken
# word — and it is what produced a **19.92 s single-word segment** (`' it.'`,
# 250.40 → 270.32 s) on a windowed run, defeating [`SEGMENT_MAX_S`]'s own
# guarantee.
#
# So a mis-aligned token keeps its TEXT (dropping the full stop would corrupt
# the transcript, and `retake.rs` normalises punctuation away anyway) and does
# NOT extend the word's `end`. 0.5 s is measured, not chosen: the largest
# legitimate within-word gap on this source is **0.480 s** and the smallest
# anomaly is **0.560 s**, so the threshold sits in a real empty band with an
# order of magnitude of headroom either side of the two populations.
#
# The one case this is wrong about, named rather than hidden: of the 49 gaps,
# one (`'f'`) is a genuine sub-word fragment, whose word now ends slightly
# early. One under-reported word against 48 multi-second over-reported ones.
WORD_TOKEN_GAP_MAX_S = 0.5


@dataclass(frozen=True)
class Token:
    """One `parakeet_mlx.AlignedToken`, reduced to what segmentation needs.

    A plain dataclass rather than the library's own type so
    [`merge_tokens_to_words`] and [`segment_words`] are testable over synthetic
    lists with no model, no MLX and no `parakeet_mlx` import at all — which is
    exactly what `test_asr_parakeet.py` does.
    """

    text: str
    start: float
    end: float


def merge_tokens_to_words(
    tokens: Iterable[Token],
    *,
    token_gap_max_s: float = WORD_TOKEN_GAP_MAX_S,
) -> list[dict]:
    """Sub-word tokens → whole words, on the leading-space boundary.

    `' De' / 'cem' / 'ber'` → `' December'`; `' ye' / 'ar' / ','` →
    `' year,'`. A word's `start` is its FIRST token's start and its `end` is its
    last CONTIGUOUS token's end — contiguous meaning within `token_gap_max_s`,
    which is D-376's fix for `parakeet-mlx` timestamping sentence-final
    punctuation at the end of the following silence. See
    [`WORD_TOKEN_GAP_MAX_S`] for the measurement; the short version is that a
    mis-aligned token keeps its text and loses its vote on the word's `end`.

    The leading space is **kept**, not stripped: that is what makes a word from
    this backend indistinguishable in shape from one of mlx-whisper's, so
    `retake.rs`'s `normalise`, the caption renderer and the Edit tab's transcript
    view all see what they already see today.

    Three edge cases, all decided rather than accidental:
      - the FIRST token starts a word whether or not it has a leading space
        (`parakeet_mlx` does emit one for it, but a chunk-merge seam need not);
      - a token with no leading space and no text at all is folded into the
        current word, adding no characters — its frames are real audio and
        belong inside the word that contains them;
      - a mis-aligned token never SHRINKS a word either: `end` only ever moves
        forward, so an out-of-order token cannot invert a word's span.
    """
    words: list[dict] = []
    for token in tokens:
        if not words or token.text.startswith(WORD_START_PREFIX):
            words.append({"word": token.text, "start": token.start, "end": token.end})
            continue
        current = words[-1]
        current["word"] += token.text
        if token.start - current["end"] <= token_gap_max_s:
            current["end"] = max(current["end"], token.end)
    return words


def segment_words(
    words: Sequence[dict],
    *,
    gap_s: float = SEGMENT_GAP_S,
    max_s: float = SEGMENT_MAX_S,
) -> list[dict]:
    """Words → contract segments, split on silence and capped in length.

    A new segment starts when the gap from the previous word's `end` to this
    word's `start` reaches `gap_s`, OR when including this word would take the
    segment past `max_s`. The second rule is the one that makes the measured
    98.2 s run-on impossible; see [`SEGMENT_MAX_S`] for why both numbers are
    those numbers.

    Deterministic and total: a single word longer than `max_s` becomes its own
    (over-long) segment rather than being split mid-word or dropped, so there is
    no input for which this loops or loses a word. Every word appears in exactly
    one segment, in order.

    Each segment's `text` is its words joined and stripped — the same
    normalisation mlx-whisper's `segment["text"].strip()` gets — so the contract
    reads identically whichever backend produced it.
    """
    if not words:
        return []

    segments: list[dict] = []
    current: list[dict] = []
    for word in words:
        if current and (
            word["start"] - current[-1]["end"] >= gap_s
            or word["end"] - current[0]["start"] > max_s
        ):
            segments.append(_as_segment(current))
            current = []
        current.append(word)
    segments.append(_as_segment(current))
    return segments


def _as_segment(words: list[dict]) -> dict:
    return {
        "start": words[0]["start"],
        "end": words[-1]["end"],
        "text": "".join(w["word"] for w in words).strip(),
        "words": list(words),
    }


class ParakeetMlxBackend:
    """parakeet-mlx behind the [`base.AsrBackend`] Protocol."""

    @property
    def descriptor(self) -> BackendDescriptor:
        return DESCRIPTOR

    def transcribe(
        self,
        audio_path: str,
        *,
        model: str,
        language: str | None,
        word_timestamps: bool,
    ) -> dict:
        """`{text, language, segments: [{start, end, text, words: [...]}]}` in
        **window-local** seconds.

        `word_timestamps=False` drops the per-word lists from the result and
        keeps the segments. It is NOT faster here, and the docstring says so
        rather than implying a speedup it does not deliver: a TDT model emits
        token timings as part of decoding, so there is no cheaper mode to ask
        for — the words are already paid for by the time this can honour the
        flag. The flag is honoured anyway because it is part of the contract and
        a caller that asked for a smaller result should get one.

        `language` is only ever a REFUSAL input here (`base.check_language`, run
        by `transcribe.py` before this is reached). `parakeet_mlx` 0.5.3 takes no
        language argument at all — detection is internal and the detected
        language is not surfaced on `AlignedResult` — so the reported `language`
        is the one that was asked for, or `"unknown"` when the caller let the
        model decide. That is the honest value; inventing a detected language
        would not be.
        """
        repo = MODEL_REPOS[model]

        try:
            from parakeet_mlx import from_pretrained
        except ImportError as e:
            # The one predictable way this import fails is an environment built
            # before D-381 that has not picked up the new lock yet — e.g. an
            # install that has been offline since the upgrade, where
            # `apelles_ai::ai_env` cannot fetch `parakeet-mlx` and backs off.
            # Said as a sentence (B-119) rather than as a ModuleNotFoundError in
            # a subprocess's stderr tail, because the fix is the user's to make.
            raise UserFacingError(
                "the speech model's package (parakeet-mlx) is not installed in the AI "
                "environment yet. Apelles installs it automatically the next time it "
                "starts with an internet connection — or run ./ai-env/setup.sh."
            ) from e

        # B-174's fix applies here too — `from_pretrained` reaches the Hub on
        # every load unless handed a path that already exists. See
        # `base.local_snapshot_or_repo`.
        asr_model = from_pretrained(local_snapshot_or_repo(repo))
        result = asr_model.transcribe(
            audio_path,
            chunk_duration=CHUNK_DURATION_S,
            overlap_duration=OVERLAP_DURATION_S,
        )

        tokens = [
            Token(text=token.text, start=float(token.start), end=float(token.end))
            for sentence in result.sentences
            for token in sentence.tokens
        ]
        words = merge_tokens_to_words(tokens)
        segments = segment_words(words)

        # Built from the merged words rather than from `result.text`, so `text`,
        # `segments` and the flattened `words` cannot disagree with each other.
        # They are the same tokens either way — `AlignedResult.text` is just
        # `"".join(sentence.text)` over the same stream.
        text = "".join(w["word"] for w in words).strip()

        if not word_timestamps:
            for segment in segments:
                segment["words"] = []

        return {
            "text": text,
            "language": language if language and language != "auto" else "unknown",
            "segments": segments,
        }


BACKEND = ParakeetMlxBackend()
