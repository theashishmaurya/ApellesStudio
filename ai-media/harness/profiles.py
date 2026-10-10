#!/usr/bin/env python3
"""Backend descriptors — the whole of the harness's knowledge that backends
differ (D-374 step 3, D-375).

**What it is.** A [`BackendProfile`] is the per-backend constants a *general*
check needs in order to stay general. It is passed in to every check
([`harness.pipeline.CheckContext`]); no check ever looks a backend up for
itself, and nothing in `harness/` imports a backend module.

**Why this exists at all.** `crates/apelles-speech/src/dark.rs` is the check
this file was written for. Its algorithm is general — *VAD says speech,
transcript says nothing ⇒ a dark region* — but one of its numbers is not: the
2.0 s too-long-word bound is `mlx_whisper/transcribe.py`'s own anomaly
threshold, and it exists because Whisper's DTW alignment **stretches a single
word across a hole it did not transcribe** (c038's ` down.` at 217.26-222.74 s
is 5.48 s for one word), so a word that long must contribute no coverage.
Parakeet's duration head caps a *token* at ~0.32 s and cannot produce a
stretched word at all, which makes the bound meaningless there rather than
merely differently-valued. One check, two backends, and the number is the
backend's — so it travels in the thing that gets passed in, never in the check.

**Deliberately three fields wide.** Anything a check does not read does not
belong in a profile — the same rule `asr/base.py` applies to its own
descriptor. In particular there is **no language set here**: Parakeet covers 25
European languages and not Hindi (D-374 §5), but refusing a Hinglish source is
the *seam's* job (`asr.base.check_language`) — it has to happen before a
backend runs, and a check only ever sees a transcript that already exists, by
which time refusing its language is too late to help anyone.

**Where the numbers actually live: `ai-media/asr/base.py`'s
`BackendDescriptor`** (D-374 steps 1-2, extended by D-375 to carry
`max_word_secs` now that a check consumes it). That is the single source of
truth, and [`BackendProfile.from_descriptor`] is how a caller that has one turns
it into what the checks read.

**Why there is a registry here as well, and why that is not a second source of
truth.** The harness has to run on a transcript *with no backend in the
process*: one read back off disk, one that arrived over the sidecar's HTTP
boundary, one from a project opened years later. [`profile_for`] resolving on
the contract's own `model` field is what makes that work, and it cannot reach
`asr/` to do it — importing a backend module from inside a check is the one
thing D-374 forbids, structurally, and `harness/` imports nothing. So the
registry below mirrors the descriptors, and `test_harness_pipeline.py` pins it
to them field-for-field: drift is a failing test, not a wrong answer. That is
the arrangement `CLAUDE.md`'s no-copy-pasted-logic rule asks for when two
layers genuinely cannot import each other — one definition, one derived mirror,
one test holding them together.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

__all__ = [
    "BackendProfile",
    "NO_WORD_LENGTH_BOUND_SECS",
    "PARAKEET",
    "PROFILES",
    "WHISPER",
    "WHISPER_ANOMALY_WORD_SECS",
    "profile_for",
]

# `mlx_whisper/transcribe.py`'s own bound for a too-long word (`if duration >
# 2.0`). Not a number picked to fit: taking it from "any word" to "a word under
# 2.0 s" moved `dark.rs`'s candidate count from 2 to 4 on one real source and
# from 4 to 9 on another, and it is worth more than half the real cases on both
# (`crates/apelles-speech/src/dark.rs`'s module doc; the 111-window scoring in
# `docs/notes/whisper-dark-region-research.md`).
WHISPER_ANOMALY_WORD_SECS = 2.0

# What a backend that cannot stretch a word asks the dark-region detector for:
# no word is ever excluded from coverage for being too long.
#
# Finite rather than `inf` on purpose. The detector's own guard
# (`chroma_detect_dark_regions`) requires every parameter to be finite and
# positive, and for any transcript a real backend can produce the two behave
# identically — no spoken word is a hundred thousand seconds long. A very large
# finite number is the honest encoding of "this bound does not apply"; `inf`
# would be the same statement in a form the detector refuses.
NO_WORD_LENGTH_BOUND_SECS = 1.0e6


@dataclass(frozen=True)
class BackendProfile:
    """One ASR backend, described in the terms the harness's checks read.

    Frozen, so a check cannot mutate the descriptor it was handed and change
    the next check's answer — the harness's determinism invariant starts here.
    """

    #: Human-facing name, used in `harness.profile` provenance and in errors.
    name: str
    #: The `model` values a contract from this backend carries
    #: (`transcribe()` writes its `model` argument through verbatim), used by
    #: [`profile_for`] to resolve a profile from a transcript alone.
    models: frozenset[str]
    #: The too-long-word bound for the VAD cross-check, in seconds, or `None`
    #: when this backend cannot stretch a word across an untranscribed hole and
    #: the bound therefore does not apply. See this module's doc, and
    #: [`harness.vad.dark_params_for`], which is the only reader.
    max_word_secs: float | None

    @classmethod
    def from_descriptor(cls, descriptor: Any) -> "BackendProfile":
        """A profile from an `asr.base.BackendDescriptor`.

        Duck-typed on purpose — `name`, `models`, `max_word_secs` — so that
        `harness/` still imports no backend module and a check still cannot
        reach a model. The caller that *has* a descriptor is above both layers
        (`transcribe.py`, the sidecar, a test), and this is the one line it
        needs to hand the checks what they read.
        """
        return cls(
            name=descriptor.name,
            models=frozenset(descriptor.models),
            max_word_secs=descriptor.max_word_secs,
        )


#: `mlx-whisper` — today's default backend (D-374 §5). Mirrors
#: `asr.whisper_mlx.DESCRIPTOR`. Every model listed is a key of that backend's
#: `MLX_MODEL_REPOS`, i.e. a `model` value a real contract can actually carry;
#: they share one profile because they share the decoder whose DTW alignment
#: produces the stretched word.
WHISPER = BackendProfile(
    name="whisper",
    models=frozenset(
        {
            "tiny",
            "base",
            "small",
            "medium",
            "large-v2",
            "large-v3",
            "large",
            "distil-large-v3",
        }
    ),
    max_word_secs=WHISPER_ANOMALY_WORD_SECS,
)

#: `parakeet-tdt-0.6b-v3` — 0.6 B params, measured at 17.6× realtime on the
#: owner's own 989.5 s C038 source (D-374). Mirrors
#: `asr.parakeet_mlx.DESCRIPTOR`. `max_word_secs=None`: its duration head caps
#: a token at 0.320 s, so the stretched-word failure the bound exists for cannot
#: occur, and excluding long words would only throw away real coverage.
PARAKEET = BackendProfile(
    name="parakeet",
    models=frozenset({"parakeet-tdt-0.6b-v3"}),
    max_word_secs=None,
)

#: Every profile the harness knows, in resolution order. A tuple rather than a
#: dict keyed by model so the registry reads as a list of backends rather than
#: as a flattened index, and so iteration order is fixed.
PROFILES: tuple[BackendProfile, ...] = (WHISPER, PARAKEET)


def profile_for(contract: Mapping[str, Any]) -> BackendProfile:
    """The profile for the backend that produced `contract`, from its own
    `model` field.

    Raises `KeyError` naming the known models rather than guessing. Guessing
    would mean silently running a Parakeet transcript against Whisper's 2.0 s
    word bound, which is exactly the mistake this file exists to make
    impossible — and the resulting wrong answer would be a plausible-looking
    list of dark regions, not an error anyone would notice.
    """
    model = contract.get("model")
    for profile in PROFILES:
        if model in profile.models:
            return profile
    known = ", ".join(sorted(m for p in PROFILES for m in p.models))
    raise KeyError(
        f"no backend profile for model {model!r}. Known: {known}. "
        "Add a BackendProfile in harness/profiles.py rather than letting a "
        "check assume another backend's constants."
    )
