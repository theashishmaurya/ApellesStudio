#!/usr/bin/env python3
"""B-287 / D-420 — a whole-file transcript of a REAL source leaves no speech unread.

**Why this exists, and why it is opt-in.** `test_asr_coverage.py` proves the
coverage check's arithmetic and its splice over a scripted backend; what it
cannot prove is the property B-287 was filed for, on the real model: that a
whole-file pass of a real recording reads all of its speech. B-287's source
was the owner's own 9:28 voiceover, which is not committed (nor are the camera
originals D-381 measured on), and synthesized speech does not reproduce the
drop (macOS `say` over C038's text, 6:55: 120/15 s chunking read 1291 of 1296
words, no hole). So this needs a real source and the multi-GB model, and skips
with a message instead of failing, like `test_harness_live.py`:

```text
APELLES_COVERAGE_SOURCE=/path/to/voiceover.m4a \
  ai-env/.venv/bin/python ai-media/test_transcribe_coverage_live.py
```

It runs the real `transcribe.transcribe()` once over the whole file (D-420's
40/8 s chunking, then the coverage check), prints what the check re-read, and
fails if any speech-like stretch of at least `MAX_UNREAD_S` is still without a
word. On the B-287 voiceover before D-420 the same pass left 8 holes of 4-37 s
(`asr_coverage.find_unread_stretches` over the 120/15 s output).

`APELLES_COVERAGE_OUT` saves the transcript for inspection.
"""
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# B-287's shortest reported hole was 6.5 s; the check itself re-reads from 2 s.
# A stretch it re-read and still could not put a word on (a false start, a hum
# — D-387 lists both on C019/C038) is reported in `coverage.unread`; one this
# long is not that.
MAX_UNREAD_S = 4.0


def main() -> int:
    source = os.environ.get("APELLES_COVERAGE_SOURCE")
    if not source:
        print("skip: set APELLES_COVERAGE_SOURCE to a real audio/video file — see the module doc")
        return 0
    if not Path(source).exists():
        print(f"skip: APELLES_COVERAGE_SOURCE={source} does not exist")
        return 0
    try:
        import parakeet_mlx  # noqa: F401
    except ImportError:
        print("skip: parakeet_mlx is not importable — run this on ai-env/.venv's python")
        return 0

    import transcribe as transcribe_mod

    t0 = time.time()
    result = transcribe_mod.transcribe(source)
    elapsed = time.time() - t0
    cov = result["coverage"]
    words = len(result.get("words", []))
    print(f"{words} words in {elapsed:.1f} s; coverage: {json.dumps(cov)}")
    out = os.environ.get("APELLES_COVERAGE_OUT")
    if out:
        Path(out).write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")

    assert cov["checked"] is True, cov
    long_unread = [u for u in cov["unread"] if u["end"] - u["start"] >= MAX_UNREAD_S]
    assert not long_unread, f"speech left unread: {long_unread}"
    print(f"ok: no speech-like stretch of {MAX_UNREAD_S:.0f} s or more is left without a word")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
