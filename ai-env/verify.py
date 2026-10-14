#!/usr/bin/env python
"""Prove the shared venv can actually serve BOTH Apelles Python sidecars (D-314/D-315).

Run with the interpreter under test:

    ai-env/.venv/bin/python ai-env/verify.py           human-readable, exit 1 if unusable
    ai-env/.venv/bin/python ai-env/verify.py --json    one JSON object on stdout

**Why this file exists rather than an inline check in each caller.** Two things need
the same answer to "is this environment usable": `ai-env/setup.sh`, at the end of a
human install (D-314), and the Rust bootstrap in `apelles_ai::ai_env`, which decides
on every app launch whether to reuse the venv it finds or wipe and rebuild it (D-315).
Two hand-maintained copies of this list — one in bash, one in Rust — would drift, and
the failure mode of drift here is the bad one: a venv the app calls healthy and a
sidecar then dies importing from. `CLAUDE.md`: shared logic goes in one place.

**Why real imports and not "does .venv/bin/python exist".** The failure this is built
for is a *partial* install — a `pip`/`uv` run killed part-way, or a machine that ran
out of disk — which leaves an interpreter that starts fine and a `site-packages` that
is missing or half-writes the thing a sidecar needs. Only importing it finds that.

These are the imports that were the whole question in D-314 — ViTMatte (the
`transformers<5` pin that split the venvs) and the MLX top-levels — plus the
heavyweights whose absence means a torn install, and the one ASR backend
(`parakeet_mlx`, D-381).

What this does NOT do: download a model, start a server, check ffmpeg (a hard
requirement of `ai-media/` but not pip-installable, so not this file's business), or
verify versions against the lock. It answers exactly one question: can both sidecars
import what they need from this interpreter.
"""

import importlib
import json
import sys

# (sidecar, human label, module) — the module name is what actually gets imported.
CHECKS = [
    ("ai", "torch", "torch"),
    ("ai", "ultralytics (SAM 2)", "ultralytics"),
    ("ai", "cv2", "cv2"),
    ("ai", "scipy", "scipy"),
    ("ai", "utils3d_moge (MoGe-2)", "utils3d_moge"),
    ("ai-media", "mlx", "mlx"),
    ("ai-media", "mlx_vlm (Qwen3-VL)", "mlx_vlm"),
    # The ASR backend (D-381: Parakeet is the only one; `mlx_whisper` was checked
    # here until it was decommissioned). Adding this line is what makes an install
    # that predates D-381 read as Broken on its next launch, which is the point:
    # `apelles_ai::ai_env` then re-installs the lock over the top and the venv
    # gains `parakeet-mlx` without a rebuild. See D-381 for the full upgrade path.
    ("ai-media", "parakeet_mlx (Parakeet ASR)", "parakeet_mlx"),
]


def _check_vitmatte():
    """The one check that is not a bare top-level import.

    D-314 turned on whether `transformers` 5.x still exposes ViTMatte, so importing
    `transformers` alone would miss exactly the regression this guards against.
    """
    from transformers import (  # noqa: F401
        VitMatteForImageMatting,
        VitMatteImageProcessor,
    )

    import transformers

    return f"ViTMatte on transformers {transformers.__version__}"


def run():
    results = []
    for sidecar, label, module in CHECKS:
        try:
            importlib.import_module(module)
            results.append({"sidecar": sidecar, "label": label, "ok": True})
        except BaseException as e:  # noqa: BLE001 - a broken wheel can raise anything
            results.append(
                {
                    "sidecar": sidecar,
                    "label": label,
                    "ok": False,
                    "error": f"{type(e).__name__}: {e}",
                }
            )

    try:
        detail = _check_vitmatte()
        results.append({"sidecar": "ai", "label": detail, "ok": True})
    except BaseException as e:  # noqa: BLE001
        results.append(
            {
                "sidecar": "ai",
                "label": "ViTMatte",
                "ok": False,
                "error": f"{type(e).__name__}: {e}",
            }
        )

    return results


def main(argv):
    results = run()
    bad = [r for r in results if not r["ok"]]

    if "--json" in argv:
        json.dump(
            {
                "ok": not bad,
                "python": sys.executable,
                "prefix": sys.prefix,
                "checks": results,
            },
            sys.stdout,
        )
        sys.stdout.write("\n")
    else:
        for r in results:
            if r["ok"]:
                print(f"    ok   {r['sidecar']:9} {r['label']}")
            else:
                print(f"    FAIL {r['sidecar']:9} {r['label']}: {r['error']}")
        if bad:
            names = ", ".join(r["label"] for r in bad)
            print(f"\nenvironment is NOT usable: {names}", file=sys.stderr)

    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
