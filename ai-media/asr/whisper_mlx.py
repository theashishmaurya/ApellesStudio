#!/usr/bin/env python3
"""The mlx-whisper backend — Apelles' default ASR, unchanged (D-374 step 1).

**What it is:** `mlx-whisper` (Apple Silicon, local) with `large-v3`, behind
[`base.AsrBackend`]. This file is a MOVE, not a rewrite: every constant,
every kwarg and every line of reasoning below was in `transcribe.py` before
D-374 and is here verbatim, because step 1's acceptance test is that nothing
changed.

**What it does NOT do:** no ffmpeg, no windowing, no timestamp shifting, no
`words` flattening, no result assembly. It is handed one prepared audio file
and returns the contract body in **window-local** seconds;
`transcribe.py` owns everything around that. See `asr/base.py`.

Ported originally from videoAgent's own `/whisper-mlx` script
(`src/transcribe/whisper_transcribe.py`) — a mature, already-proven capability,
nothing novel to validate. Two deliberate simplifications from that source, so
this file has no unused surface (`CLAUDE.md`: no dead code):
  - Its `lightning-whisper-mlx` backend is dropped. It cannot produce
    word-level timings at all (segments only), which is the entire reason
    Apelles wants a transcript; keeping it would mean a second model dependency
    that no caller here can use.
  - Its `--quant` / `--batch-size` knobs went with that backend; `mlx-whisper`
    has neither.

`condition_on_previous_text=False` is kept from the source: a loop/hallucination
guard that matters on exactly the long single-take footage an editor works
with.
"""

from __future__ import annotations

from asr.base import BackendDescriptor, local_snapshot_or_repo

NAME = "whisper"

DEFAULT_MODEL = "large-v3"

# The fixed seed for MLX's global RNG (B-224, fixed by D-349).
#
# `mlx_whisper` falls back through `temperature=(0.0, 0.2, …, 1.0)` when a window
# trips `compression_ratio_threshold` or `logprob_threshold`, and at any
# temperature > 0 it SAMPLES — `mlx_whisper/decoding.py`'s
# `mx.random.categorical(logits / temp)`, on MLX's **global** RNG. Nothing here
# ever seeded it, so the same file through the same pipeline returned a
# different transcript every run: measured at 925 / 923 / 913 words over three
# identical runs of `A001_09122356_C040.MOV`, all three `text` fields pairwise
# unequal (`docs/notes/whisper-dark-region-research.md` §3).
#
# That breaks `CLAUDE.md`'s own determinism invariant ("no `rand()`, no
# un-seeded anything"), and it breaks every consumer downstream of a transcript:
# retake detection, silence detection, caption generation and
# `editor_get_timeline_transcript` can all legitimately disagree with a cached
# answer, and a bug report against a transcript may not reproduce — which is
# exactly what happened to B-216's five-times-confirmed dark region.
#
# The VALUE is arbitrary and only has to be fixed; 0 is MLX's own documented
# example seed. What matters is that it is set once, before every run, from a
# named constant rather than from an incidental call site.
#
# This makes runs reproducible. It does NOT make them correct: B-216's
# dropped-speech failure happens at temperature 0.0 and is untouched by it —
# see `transcribe.transcribe`'s own note and `docs/BUGS.md` B-216.
MLX_RANDOM_SEED = 0

# mlx-whisper loads weights from an HF repo, not a bare model name.
MLX_MODEL_REPOS = {
    "tiny": "mlx-community/whisper-tiny-mlx",
    "base": "mlx-community/whisper-base-mlx",
    "small": "mlx-community/whisper-small-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "large-v2": "mlx-community/whisper-large-v2-mlx",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
    "large": "mlx-community/whisper-large-v3-mlx",
    # ENGLISH ONLY (D-335). Every distil-whisper release is `language: en`
    # (https://huggingface.co/distil-whisper/distil-large-v3.5), so selecting
    # this model silently voids the Hinglish auto-detection this module's own
    # docstring and `transcribe()`'s promise below. ~2.1-3.2x faster than
    # `large-v3` and a legitimate opt-in for English-only work; never a default.
    # Measured 2026-09-16: 12.47% WER divergence from `large-v3`, and the WORST
    # segment boundaries of the three candidates tried on D-327's own B-198
    # retake region — which matters, because `apelles-speech`'s retake detector
    # reads exactly those boundaries.
    "distil-large-v3": "mlx-community/distil-whisper-large-v3",
}

# `languages=None` — "not constrained" — and that is a statement, not a shrug.
# `large-v3` is multilingual across 99 languages and **code-switched Hinglish
# auto-detects fine on it**, which is the promise `transcribe()` has made since
# D-189 and the reason D-374 keeps this backend the default for any source that
# is not plainly one of Parakeet's 25 European languages. Per-model narrowing is
# deliberately not modelled: `distil-large-v3` IS English-only (D-335), but that
# is recorded where it is selected, above, and inventing a per-model language
# map here would be a second source of truth for one entry.

# `mlx_whisper/transcribe.py`'s OWN bound for an anomalous word (`if duration >
# 2.0`), which is why the dark-region check uses it for this backend and not a
# number of our own: a word longer than this is whisper telling us its DTW
# alignment stretched one token across something it did not transcribe. Not a
# value picked to fit — adopting it moved `dark.rs`'s candidate count from 2 to
# 4 on one real source and 4 to 9 on another, and it is worth more than half the
# real cases on both (`crates/apelles-speech/src/dark.rs`'s module doc).
WHISPER_ANOMALY_WORD_SECS = 2.0

DESCRIPTOR = BackendDescriptor(
    name=NAME,
    default_model=DEFAULT_MODEL,
    models=tuple(MLX_MODEL_REPOS),
    languages=None,
    language_summary="99 languages, auto-detected, including code-switched Hinglish",
    max_word_secs=WHISPER_ANOMALY_WORD_SECS,
)


class WhisperMlxBackend:
    """mlx-whisper behind the [`base.AsrBackend`] Protocol."""

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

        `word_timestamps=False` returns segment-level timings only — faster, but
        not enough to cut to a word.

        **Deterministic since D-349** (B-224): MLX's global RNG is seeded from
        [`MLX_RANDOM_SEED`] before every run, so the same file and the same
        arguments give the same transcript. That is reproducibility, not
        correctness — see the constant's own note.
        """
        repo = MLX_MODEL_REPOS[model]

        import mlx_whisper
        import mlx.core as mx

        # B-224. Before the fallback ladder can sample, not after: this is the
        # global RNG `mlx_whisper/decoding.py`'s `mx.random.categorical` draws
        # from, and seeding it here is what makes a re-run reproduce.
        mx.random.seed(MLX_RANDOM_SEED)

        kwargs: dict = {
            "path_or_hf_repo": local_snapshot_or_repo(repo),
            "word_timestamps": word_timestamps,
            # Loop/hallucination guard on long single-take footage — kept from
            # the ported source, where it was added for exactly that reason.
            "condition_on_previous_text": False,
        }
        if language and language != "auto":
            kwargs["language"] = language
        result = mlx_whisper.transcribe(audio_path, **kwargs)

        segments: list[dict] = []
        for seg in result.get("segments") or []:
            if not isinstance(seg, dict):
                continue
            seg_words: list[dict] = []
            for w in seg.get("words") or []:
                if not isinstance(w, dict):
                    continue
                entry = {
                    "word": w.get("word"),
                    "start": w.get("start"),
                    "end": w.get("end"),
                }
                if "probability" in w:
                    entry["probability"] = round(w["probability"], 3)
                seg_words.append(entry)
            segments.append(
                {
                    "start": seg.get("start"),
                    "end": seg.get("end"),
                    "text": (seg.get("text") or "").strip(),
                    "words": seg_words,
                }
            )

        return {
            "text": (result.get("text") or "").strip(),
            "language": result.get("language", language or "unknown"),
            "segments": segments,
        }


BACKEND = WhisperMlxBackend()
