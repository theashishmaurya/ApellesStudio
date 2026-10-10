#!/usr/bin/env python3
"""D-374 step 3 — the harness end-to-end against the REAL Whisper backend.

**Why this exists, and why it is opt-in.** `test_harness_align.py` and
`test_harness_pipeline.py` cover every check as a pure function over
contract-shaped fixtures, which is where correctness lives. What they cannot
cover is the claim D-374 actually makes: that the harness composes over a real
backend's real output, and that it is **the existing Whisper backend** it was
proved against rather than the Parakeet one it was designed for. If it only
worked once Parakeet landed, it would not be backend-agnostic.

So this runs `transcribe.transcribe()` as it exists today — no backend seam, no
new model — three times over one window of a real source with the **chunk
offset varied**, and reconciles the three. Varying the offset is the measured
knob (D-374 §3.1): the failures cluster at chunk seams, so a pass whose seams
fall elsewhere disagrees informatively instead of reproducing the first.
`mlx-whisper` has no chunk-size argument, but it does not need one — its 30 s
window grid starts at the start of the audio it is handed, so a pass that
starts 10 s earlier has every seam 10 s elsewhere, and D-349 already shifts a
windowed pass's timestamps back to absolute source seconds precisely so
windowed passes are comparable. The harness reconciles only the range every
pass covered, which is what makes that sound.

**Opt-in, like `apelles-speech`'s own `dark_live`/`silero_live`.** It needs a
multi-GB model and a real source, which a clean checkout has neither of, so it
skips with a message instead of failing:

```text
APELLES_HARNESS_SOURCE=/path/to/source.wav \
  ai-env/.venv/bin/python ai-media/test_harness_live.py
```

Optionally also fold in a REAL dark-region report from the Rust detector — the
VAD cross-check, running where it already lives (D-375), not reimplemented
here:

```text
ffmpeg -i source.wav -f f32le -ac 1 -ar 16000 source.f32
ORT_DYLIB_PATH=app/src-tauri/resources/libonnxruntime.dylib \
APELLES_SILERO_MODEL="$HOME/Library/Application Support/studio.apelles.app/models/silero_vad_v6.2.1.onnx" \
APELLES_DARK_PCM=source.f32 APELLES_DARK_TRANSCRIPT=source.json \
APELLES_DARK_MAX_WORD_SECS=2.0 APELLES_DARK_REPORT_JSON=/tmp/report.json \
  cargo test -p apelles-speech --test dark_live -- --ignored --nocapture

APELLES_HARNESS_SOURCE=source.wav APELLES_HARNESS_DARK_REPORT=/tmp/report.json \
  ai-env/.venv/bin/python ai-media/test_harness_live.py
```

`APELLES_HARNESS_START` / `APELLES_HARNESS_DURATION` move and resize the
window (defaults below), and `APELLES_HARNESS_OUT` saves the reconciled
contract for inspection.
"""
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from harness import (  # noqa: E402
    MultiPassReconcile,
    VadCrossCheck,
    dark_params_for,
    profile_for,
    run_checks,
)
from harness.contract import flat_words  # noqa: E402
from harness.reconcile import AGREEMENT_STATES  # noqa: E402

#: The window reconciled by default, in absolute source seconds. 200-260 s of
#: the owner's C038 is where the measured interesting material is: the 5.48 s
#: stretched ` down.` at 217.26 s that B-216 turns on, and the `"Cut from here"`
#: at 223.8 s that Whisper dropped and Parakeet caught (D-374 §1).
DEFAULT_START = 200.0
DEFAULT_DURATION = 60.0

#: How far apart the passes' chunk grids are pushed, in seconds. Three passes,
#: 10 s apart, so no two share a 30 s window boundary anywhere in the reconciled
#: range — which is the whole point of varying the offset.
OFFSETS = (0.0, 10.0, 20.0)


def passes_over(source: str, start: float, duration: float) -> list[dict]:
    """One contract per chunk offset, each covering `[start, start + duration]`
    and each with its 30 s grid somewhere else.

    A pass with offset `d` starts `d` seconds earlier and runs `d` seconds
    longer, so every pass covers the window and the harness's range
    intersection is exactly it.
    """
    import transcribe

    out = []
    for offset in OFFSETS:
        began = time.time()
        result = transcribe.transcribe(
            source,
            start_secs=max(0.0, start - offset),
            duration_secs=duration + min(offset, start),
        )
        words = flat_words(result)
        print(
            f"  pass offset {offset:5.1f}s: {len(words):4d} words, "
            f"{len(result['segments']):3d} segments, {time.time() - began:6.1f}s"
        )
        out.append(result)
    return out


def check_reconciliation(passes: list[dict], window: tuple[float, float]) -> dict:
    checks = [MultiPassReconcile(passes[1:])]
    report_path = os.environ.get("APELLES_HARNESS_DARK_REPORT")
    profile = profile_for(passes[0])
    if report_path:
        report = json.loads(Path(report_path).read_text(encoding="utf-8"))
        checks.append(VadCrossCheck(report, dark_params_for(profile)))
        print(f"  folding a real DarkReport: {len(report['regions'])} regions")

    began = time.time()
    result = run_checks(passes[0], checks)
    print(f"  harness: {time.time() - began:.2f}s over {len(result['words'])} words")

    provenance = result["harness"]["multi_pass_reconcile"]
    print(f"  {json.dumps(provenance)}")

    # Invariants that must hold of ANY real source, whatever it contains. Every
    # one of them is silent in production if it breaks.
    assert result["harness"]["profile"] == profile.name
    assert [c for c in result["harness"]["checks"]] == [c.name for c in checks]
    assert provenance["passes"] == len(passes)
    assert provenance["words"] == len(result["words"])
    assert sum(provenance[state] for state in AGREEMENT_STATES) == len(result["words"])
    assert provenance["unanimous"] > 0, "three passes of real speech must agree somewhere"

    for i, word in enumerate(result["words"]):
        agreement = word.get("agreement")
        assert agreement, f"word {i} was not annotated: {word}"
        assert agreement["state"] in AGREEMENT_STATES, agreement
        assert agreement["of"] == len(passes), agreement
        assert 1 <= agreement["passes"] <= len(passes), agreement
        if agreement["state"] == "unanimous":
            assert "alternatives" not in agreement, agreement

    # Still a contract: every word is in exactly one segment, and the segments
    # are the reference's.
    binned = sum(len(seg["words"]) for seg in result["segments"])
    assert binned == len(result["words"]), (binned, len(result["words"]))
    assert len(result["segments"]) == len(passes[0]["segments"])
    assert result["source"] == passes[0]["source"]
    assert json.loads(json.dumps(result)) == result, "the result must be plain JSON-able data"

    # Every low-confidence span lands inside the range that was reconciled.
    for span in result["low_confidence"]:
        assert span["kind"] in {c.name for c in checks}, span
        if span["kind"] == "multi_pass_reconcile":
            assert window[0] - 1.0 <= span["start"] <= window[1] + 1.0, span

    # Determinism on real data, not only on fixtures — the crate-wide invariant.
    assert run_checks(passes[0], checks) == result, "the same passes must reconcile identically"
    return result


def main() -> int:
    source = os.environ.get("APELLES_HARNESS_SOURCE")
    if not source:
        print("skip: set APELLES_HARNESS_SOURCE to a real audio/video file — see the module doc")
        return 0
    if not Path(source).exists():
        print(f"skip: APELLES_HARNESS_SOURCE={source} does not exist")
        return 0
    try:
        import mlx_whisper  # noqa: F401
    except ImportError:
        print("skip: mlx_whisper is not importable — run this on ai-env/.venv's python")
        return 0

    start = float(os.environ.get("APELLES_HARNESS_START", DEFAULT_START))
    duration = float(os.environ.get("APELLES_HARNESS_DURATION", DEFAULT_DURATION))
    print(f"source: {source}, window {start:.1f}-{start + duration:.1f}s, offsets {OFFSETS}")

    passes = passes_over(source, start, duration)
    result = check_reconciliation(passes, (start, start + duration))

    flagged = [s for s in result["low_confidence"]]
    print(f"  {len(flagged)} low-confidence spans:")
    for span in flagged[:12]:
        words = [d.get("word", "") for d in span["detail"] if isinstance(d, dict)]
        print(
            f"    {span['start']:8.2f}-{span['end']:8.2f}  {span['kind']:22s}"
            f"  {''.join(words).strip()[:60]}"
        )
    if len(flagged) > 12:
        print(f"    … and {len(flagged) - 12} more")

    out = os.environ.get("APELLES_HARNESS_OUT")
    if out:
        Path(out).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"  reconciled contract written to {out}")

    print("the harness composes over the real Whisper backend")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
