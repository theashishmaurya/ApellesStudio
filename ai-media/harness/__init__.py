#!/usr/bin/env python3
"""The transcript harness — checks over the transcript contract (D-374 step 3).

**What it is.** A pipeline of *checks*. Each check takes one transcript — the
contract `ai-media/transcribe.py` already returns — and gives back the same
contract plus annotations. Nothing in here transcribes anything.

    backend ─► [ multi-pass reconcile ] ─► [ VAD cross-check ] ─► [ … ] ─► result

**Why it exists.** D-374's premise, in the owner's words: *"we can not get 100%
thats not possible we will build the Harness arround it."* A backend that is
17× faster and 2 % worse is a better input to a harness than a slower one,
because the saved time buys passes and the harness can then say **where it is
unsure** instead of pretending. The harness is the product; the backend is a
swappable part. Design, measurements and the staged migration:
`docs/notes/asr-backends-and-harness.md`.

**What a check may NOT do — and this is enforced structurally, not by
convention.** [`pipeline.run_checks`] calls a check with exactly two things: a
contract `dict` and a [`CheckContext`], which is a frozen dataclass holding one
[`BackendProfile`] and nothing else. There is no model, no audio path, no
callable and no backend module anywhere in that signature, so a check *cannot*
reach a model — it would have to import one itself, and no module in this
package does. That is what makes the harness backend-agnostic in both senses
D-374 asked for: any backend can be harnessed, and any check can be added
without touching the others.

**Where the backend-specific numbers live.** In the [`BackendProfile`], passed
in — never in a check. `profiles.py` is the whole of this package's knowledge
that backends differ at all, and it is three fields wide.

**What is NOT here, deliberately:**

- **Producing the passes.** Running a backend N times is a backend's job, not a
  check's. [`MultiPassReconcile`] is constructed *with* the other passes — all
  of them contracts — so the check itself still only ever sees contracts.
- **The VAD cross-check's detection.** It already exists, in Rust, tuned over
  111 labelled windows: `apelles_speech::dark::detect_dark_regions`. Copying it
  into Python would be a second implementation of the same logic, which
  `CLAUDE.md` forbids outright. [`vad`] holds the two halves that genuinely are
  contract-layer — deriving that detector's backend-specific parameter from the
  profile, and folding its report into this package's annotation vocabulary.
  See D-375 and `docs/notes/asr-backends-and-harness.md` §3.2.

**Determinism.** Every function in this package is pure and total: same inputs,
same output, no wall clock, no RNG, no iteration over a set. The repo-wide
invariant, and it is pinned by a test.
"""

from .align import AlignParams, align_word_streams
from .contract import (
    ContractError,
    analysed_range,
    flat_words,
    normalise,
)
from .pipeline import CheckContext, run_checks
from .profiles import (
    BackendProfile,
    PARAKEET,
    WHISPER,
    profile_for,
)
from .reconcile import MultiPassReconcile, reconcile_passes
from .vad import VadCrossCheck, dark_params_for, fold_dark_report

__all__ = [
    "AlignParams",
    "BackendProfile",
    "CheckContext",
    "ContractError",
    "MultiPassReconcile",
    "PARAKEET",
    "VadCrossCheck",
    "WHISPER",
    "align_word_streams",
    "analysed_range",
    "dark_params_for",
    "flat_words",
    "fold_dark_report",
    "normalise",
    "profile_for",
    "reconcile_passes",
    "run_checks",
]
