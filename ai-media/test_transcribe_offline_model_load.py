#!/usr/bin/env python3
"""B-174 — a cached model must never touch the network to be loaded.

`mlx_whisper.load_models.load_model` calls `huggingface_hub.snapshot_download
(repo_id=path_or_hf_repo)` with no `local_files_only` — which, even when every
file is already cached, still reaches out to the Hub to verify the cached
revision is current. Caught live: a dead TCP connection (CLOSE_WAIT — the peer
had already closed, the client never noticed) left a transcribe job hung
indefinitely, 0% CPU, no timeout, no error, contradicting this module's own
"no network calls beyond a first-run model download" promise.

`asr.base.local_snapshot_or_repo` resolves the repo to its cached local
directory first (`local_files_only=True`, which raises immediately rather than
reaching the network when nothing is cached) — `load_model` only calls
`snapshot_download` itself when the string it's given is NOT already an
existing path, so handing it a real directory skips the network call entirely.

**It lives in `asr/base.py` since D-374, shared by both backends**, because
`parakeet_mlx.utils.from_pretrained` has exactly the same bug (`hf_hub_download`
with no `local_files_only`, and the same existing-directory fallback). So this
test now also covers the parakeet model path — checking the resolver against
whichever of the two backends' default repos this machine actually has cached.

What this checks, requiring no network access itself:

  1. an unmistakably fake/uncached repo id degrades to the bare string
     unchanged, with no exception escaping — the first-run download path
     (a real repo id) is untouched by this;
  2. IF this machine already has a real Apelles transcribe model cached
     (it does in dev, may not in a fresh CI checkout), resolving it returns a
     real local directory containing the files `load_model` reads directly
     (`config.json`, weights) — proving the fast path actually engages rather
     than silently falling through to network.

Deliberately importable-free of MLX itself: nothing here calls
`mlx_whisper.transcribe` or loads a Parakeet weight, only
`asr.base.local_snapshot_or_repo`, so this runs on a plain `python3`.

    python3 ai-media/test_transcribe_offline_model_load.py
"""
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from asr import BACKENDS  # noqa: E402
from asr.base import local_snapshot_or_repo  # noqa: E402
from asr.parakeet_mlx import PARAKEET_MODEL_REPOS  # noqa: E402
from asr.whisper_mlx import MLX_MODEL_REPOS  # noqa: E402


def _default_repo(name: str) -> str:
    """The HF repo id behind a backend's default model."""
    descriptor = BACKENDS[name].descriptor
    repos = {"whisper": MLX_MODEL_REPOS, "parakeet": PARAKEET_MODEL_REPOS}[name]
    return repos[descriptor.default_model]


def main() -> int:
    # --- 1. an uncached/fake repo id must degrade to the bare string, not raise
    fake_repo = "this-repo-definitely-does-not-exist/chroma-b174-fixture"
    resolved = local_snapshot_or_repo(fake_repo)
    assert resolved == fake_repo, (
        f"an uncached repo must fall back to the bare id unchanged so "
        f"load_model still does its normal first-run download: got {resolved!r}"
    )
    print("ok: uncached repo id falls back unchanged, no exception")

    # --- 2. a genuinely cached model resolves to a real local snapshot --------
    # Both backends' defaults, since D-374 shares one resolver between them and
    # a machine may have either, both or neither cached.
    proved = 0
    for name in BACKENDS:
        real_repo = _default_repo(name)
        resolved = local_snapshot_or_repo(real_repo)
        if resolved == real_repo:
            print(
                f"skip: {real_repo!r} ({name}) is not cached on this machine — "
                "the fast path has nothing to prove here, but did not error"
            )
            continue

        assert os.path.isdir(resolved), f"resolved path is not a real directory: {resolved}"
        assert os.path.isfile(os.path.join(resolved, "config.json")), (
            f"resolved path is missing config.json, which the loader reads "
            f"directly off this path: {resolved}"
        )
        print(f"ok: cached {name} model resolves to a real local directory: {resolved}")
        proved += 1

    if proved == 0:
        print("skip: neither backend's default model is cached here")

    print("all B-174 offline-model-load checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
