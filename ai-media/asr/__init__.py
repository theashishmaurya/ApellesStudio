#!/usr/bin/env python3
"""`ai-media/asr/` — the ASR backend registry (D-374).

**What it is:** the name → backend lookup `transcribe.py` resolves `backend=`
and `--backend` against. One module, no plugin machinery.

**One entry, and the registry stays anyway.** Since D-381 (2026-10-13) Parakeet
is the only backend — `mlx-whisper` was decommissioned and its module deleted.
The seam is kept on purpose: D-374 built it so a backend can be swapped or added
without touching anything above `transcribe.py`, and the owner's own framing of
that decision was that the harness must "easily take other ones". A registry of
one is the cheapest form of that promise that still runs; `README.md` says what
adding a second takes.

**What it does NOT do:** it does not transcribe and it does not import a model
library. A backend keeps its model import (`parakeet_mlx`) *inside* its
`transcribe` method, so importing this package costs nothing — which is what
lets the harness's tests, and every test that needs no model, run on a plain
`python3`.

The contract every backend produces, and why it is this contract, is in
`base.py`.
"""

from __future__ import annotations

from asr import parakeet_mlx
from asr.base import AsrBackend, BackendDescriptor, check_language, validate_body

#: The backend a caller gets when it names none — Parakeet, the only one (D-381).
DEFAULT_BACKEND = parakeet_mlx.NAME

BACKENDS: dict[str, AsrBackend] = {
    parakeet_mlx.NAME: parakeet_mlx.BACKEND,
}


def get_backend(name: str | None) -> AsrBackend:
    """The backend called `name`, or the default when `name` is `None`.

    `ValueError` for an unknown name, not a `UserFacingError`: a backend name
    comes from a caller's own argument list, and both the CLI and
    `transcribe.py`'s signature publish the valid set.
    """
    resolved = name or DEFAULT_BACKEND
    backend = BACKENDS.get(resolved)
    if backend is None:
        raise ValueError(
            f"unknown ASR backend {resolved!r}. Supported: {', '.join(BACKENDS)}"
        )
    return backend


def backend_models() -> tuple[str, ...]:
    """Every model name any registered backend accepts — what the CLI's
    `--model` help lists. Backend-relative validation is the descriptor's job
    ([`BackendDescriptor.require_model`]); this is only the union, so `--model`
    can stay one flag instead of one per backend."""
    seen: dict[str, None] = {}
    for backend in BACKENDS.values():
        for model in backend.descriptor.models:
            seen.setdefault(model, None)
    return tuple(seen)


__all__ = [
    "AsrBackend",
    "BACKENDS",
    "BackendDescriptor",
    "DEFAULT_BACKEND",
    "backend_models",
    "check_language",
    "get_backend",
    "validate_body",
]
