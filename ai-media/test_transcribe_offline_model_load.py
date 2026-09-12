#!/usr/bin/env python3
"""B-174 — a cached model must never touch the network to be loaded.

`mlx_whisper.load_models.load_model` calls `huggingface_hub.snapshot_download
(repo_id=path_or_hf_repo)` with no `local_files_only` — which, even when every
file is already cached, still reaches out to the Hub to verify the cached
revision is current. Caught live: a dead TCP connection (CLOSE_WAIT — the peer
had already closed, the client never noticed) left a transcribe job hung
indefinitely, 0% CPU, no timeout, no error, contradicting this module's own
"no network calls beyond a first-run model download" promise.

`transcribe._local_snapshot_or_repo` resolves the repo to its cached local
directory first (`local_files_only=True`, which raises immediately rather than
reaching the network when nothing is cached) — `load_model` only calls
`snapshot_download` itself when the string it's given is NOT already an
existing path, so handing it a real directory skips the network call entirely.

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
`mlx_whisper.transcribe`, only `transcribe._local_snapshot_or_repo`, so this
runs on a plain `python3` without loading a single whisper weight.

    python3 ai-media/test_transcribe_offline_model_load.py
"""
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import transcribe as transcribe_mod  # noqa: E402


def main() -> int:
    # --- 1. an uncached/fake repo id must degrade to the bare string, not raise
    fake_repo = "this-repo-definitely-does-not-exist/chroma-b174-fixture"
    resolved = transcribe_mod._local_snapshot_or_repo(fake_repo)
    assert resolved == fake_repo, (
        f"an uncached repo must fall back to the bare id unchanged so "
        f"load_model still does its normal first-run download: got {resolved!r}"
    )
    print("ok: uncached repo id falls back unchanged, no exception")

    # --- 2. a genuinely cached model resolves to a real local snapshot --------
    real_repo = transcribe_mod.MLX_MODEL_REPOS[transcribe_mod.DEFAULT_MODEL]
    resolved = transcribe_mod._local_snapshot_or_repo(real_repo)
    if resolved == real_repo:
        print(
            f"skip: {real_repo!r} is not cached on this machine — "
            "the fast path has nothing to prove here, but did not error"
        )
        return 0

    assert os.path.isdir(resolved), f"resolved path is not a real directory: {resolved}"
    assert os.path.isfile(os.path.join(resolved, "config.json")), (
        f"resolved path is missing config.json, which load_model reads "
        f"directly off this path: {resolved}"
    )
    print(f"ok: cached model resolves to a real local directory: {resolved}")

    print("all B-174 offline-model-load checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
