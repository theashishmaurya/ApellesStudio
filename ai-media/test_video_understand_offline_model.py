#!/usr/bin/env python3
"""B-172/D-354 — an uncached model must fail with a clear, actionable message
naming the one command that fixes it, not an opaque `mlx_vlm.generate failed:
...` dump.

**Context.** `describe_frames` hardcodes `HF_HUB_OFFLINE=1` on the
`mlx_vlm.generate` subprocess (D-354: correct, local-first, not the bug).
Before this fix, that meant a machine with no cached model just failed —
nothing could ever populate the cache, since the module never offered an
explicit fetch step. D-354's decision: keep hard-offline by default, and add
`ai-env/setup.sh --fetch-models` as the explicit one-time download, PLUS make
the failure name that command.

What this checks, requiring no network access, no ffmpeg and no MLX weights
(the same "importable-free of MLX" discipline `test_transcribe_offline_model_
load.py` uses — nothing here calls `mlx_vlm.generate` or touches a real
video):

  1. huggingface_hub's real offline-guard stderr text (captured verbatim from
     the live B-172 repro in docs/BUGS.md) is recognized and turned into a
     `UserFacingError` that names `ai-env/setup.sh --fetch-models` — the exact
     fix — rather than leaking `mlx_vlm.generate failed:` / a stack trace /
     the raw stderr dump;
  2. an unrelated subprocess failure (a real crash, a bad prompt) is NOT
     misclassified as the offline case — it must return `None`, so
     `describe_frames` still raises an ordinary `RuntimeError` with the real
     stderr attached, which is what a genuinely unexpected fault needs;
  3. `describe_frames` itself, with `subprocess.run` swapped for a stub that
     returns the real offline-guard failure, actually raises that
     `UserFacingError` (not just that the helper function would) — proving the
     wiring at the real call site, not only the detection logic in isolation.

    python3 ai-media/test_video_understand_offline_model.py
"""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import video_understand as vu_mod  # noqa: E402
from errors import UserFacingError  # noqa: E402

# Captured verbatim from docs/BUGS.md B-172's live repro on a machine with no
# cached model — the exact stderr shape `mlx_vlm.generate`'s huggingface_hub
# dependency produces when `HF_HUB_OFFLINE=1` blocks a first-run fetch.
REAL_OFFLINE_STDERR = (
    "s/mlx-community/Qwen3-VL-4B-Instruct-4bit/revision/main: offline mode is "
    "enabled. To disable it, please unset the HF_HUB_OFFLINE environment "
    "variable."
)

UNRELATED_STDERR = (
    "Traceback (most recent call last):\n"
    "  File \"mlx_vlm/generate.py\", line 42, in <module>\n"
    "IndexError: list index out of range\n"
)


def main() -> int:
    # --- 1. the real offline-guard text resolves to an actionable error -----
    err = vu_mod._offline_download_error(REAL_OFFLINE_STDERR)
    assert err is not None, "the real B-172 offline-guard stderr must be recognized"
    assert isinstance(err, UserFacingError), type(err)
    message = str(err)
    assert vu_mod._FETCH_MODELS_CMD in message, (
        f"the message must name the exact fix command {vu_mod._FETCH_MODELS_CMD!r}: {message}"
    )
    assert vu_mod.MODEL in message, f"the message must name the model: {message}"
    for leak in ("mlx_vlm.generate failed", "Traceback", "s/mlx-community"):
        assert leak not in message, f"the message leaks raw subprocess text {leak!r}: {message}"
    print("ok: real offline-guard stderr ->", message)

    # --- 2. an unrelated failure must NOT be misclassified -------------------
    not_offline = vu_mod._offline_download_error(UNRELATED_STDERR)
    assert not_offline is None, (
        f"an unrelated subprocess failure must not be treated as the offline "
        f"case: got {not_offline!r}"
    )
    print("ok: an unrelated subprocess failure is left as None (-> ordinary RuntimeError)")

    # --- 3. describe_frames itself raises it, at the real call site ---------
    def fake_extract_frame_at(video_path: str, time_s: float, out_path: str) -> None:
        Path(out_path).write_bytes(b"")  # describe_frames never reads these back

    def fake_run(cmd, capture_output=True, text=True, timeout=None, env=None):
        assert env is not None and env.get("HF_HUB_OFFLINE") == "1", (
            "the generate subprocess must still run with HF_HUB_OFFLINE=1 — "
            "D-354 keeps hard-offline by default, this fix only adds the "
            "explicit escape hatch on top of it"
        )
        return SimpleNamespace(returncode=1, stdout="", stderr=REAL_OFFLINE_STDERR)

    real_extract, real_run = vu_mod.extract_frame_at, vu_mod.subprocess.run
    vu_mod.extract_frame_at = fake_extract_frame_at
    vu_mod.subprocess.run = fake_run
    try:
        try:
            vu_mod.describe_frames("fake.mp4", [1.0], vu_mod.DEFAULT_QUESTION, max_tokens=800)
        except UserFacingError as e:
            assert vu_mod._FETCH_MODELS_CMD in str(e), str(e)
            print("ok: describe_frames raises UserFacingError naming the fetch command ->", e)
        else:
            print("FAIL: describe_frames did not raise on a simulated offline failure")
            return 1
    finally:
        vu_mod.extract_frame_at = real_extract
        vu_mod.subprocess.run = real_run

    print("all B-172/D-354 offline-model checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
