#!/usr/bin/env python3
"""`ai-media/asr/` — the ASR backend registry (D-374).

**What it is:** the name → backend lookup `transcribe.py` resolves `backend=`
and `--backend` against. One module, two entries, no plugin machinery.

**What it does NOT do:** it does not transcribe and it does not import a model
library. Every backend here keeps its `mlx_whisper` / `parakeet_mlx` import
*inside* its `transcribe` method, so importing this package costs nothing and
asking for the whisper backend never requires `parakeet-mlx` to be installed —
which is what makes the Parakeet backend genuinely opt-in rather than a new hard
dependency of the sidecar.

The contract every backend produces, and why it is this contract, is in
`base.py`. Whisper is and stays the default (D-374: the default moves only after
step 4 re-derives `apelles-speech`'s corpus tests against a Parakeet transcript).
"""

from __future__ import annotations

from asr import parakeet_mlx, whisper_mlx
from asr.base import AsrBackend, BackendDescriptor, check_language, validate_body

#: The default, and deliberately still Whisper — see the module docstring.
DEFAULT_BACKEND = whisper_mlx.NAME

BACKENDS: dict[str, AsrBackend] = {
    whisper_mlx.NAME: whisper_mlx.BACKEND,
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
    """Every model name any backend accepts — what the CLI's `--model` help
    lists. Backend-relative validation is the descriptor's job
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
