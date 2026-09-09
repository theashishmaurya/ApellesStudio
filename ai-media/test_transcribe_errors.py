#!/usr/bin/env python3
"""B-119 — a source with no audio must fail with a SENTENCE, not a subprocess dump.

What this checks, on a real file synthesized with `ffmpeg` at run time (the same
"generate the fixture, don't commit a binary" convention `apelles-media`'s own
`synth_test_tone` and `apelles-project`'s `make_test_clip` use):

  1. `transcribe.extract_audio` on a video-only file raises `UserFacingError`
     whose message names the file and says what is wrong — and leaks none of
     `CalledProcessError` / the argv / the temp WAV path, which is exactly what
     the owner saw in the Edit tab's error line;
  2. `server._run_job` records that message VERBATIM, with no `ClassName:`
     prefix — the job record is what the Tauri bridge hands the UI;
  3. an ordinary exception still keeps its class name, so this did not trade one
     kind of unreadable failure for a silently uninformative one;
  4. `extract_audio` on a file that DOES have audio still returns a real WAV.

Deliberately importable-free of MLX: nothing here loads whisper, so it runs on a
plain `python3` without the sidecar's ~3 GB venv. Only `ffmpeg` is required, and
the whole script skips (exit 0) when it is absent — the same skip discipline
`ai/test_depth_track.py` uses.

    python3 ai-media/test_transcribe_errors.py
"""
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import transcribe as transcribe_mod  # noqa: E402
from errors import UserFacingError  # noqa: E402


def _synth(out: Path, args: list[str]) -> bool:
    """One `lavfi` synthesis. Returns False if ffmpeg refused, so a caller can
    skip rather than assert against a fixture that was never made."""
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args, str(out)],
        capture_output=True,
    )
    if proc.returncode != 0:
        print("ffmpeg synthesis failed:", proc.stderr.decode("utf-8", "replace")[-400:])
        return False
    return out.exists()


def main() -> int:
    if shutil.which("ffmpeg") is None:
        print("skip: ffmpeg not on PATH")
        return 0

    tmp = Path(tempfile.mkdtemp(prefix="chroma_b114_"))
    try:
        silent = tmp / "screen-recording-no-audio.mp4"
        if not _synth(
            silent,
            [
                "-f", "lavfi", "-i", "color=black:size=64x64:duration=1:rate=24",
                "-pix_fmt", "yuv420p", "-an",
            ],
        ):
            print("skip: could not synthesize the video-only fixture")
            return 0

        # --- 1. the refusal itself -------------------------------------------
        # `extract_audio` puts its WAV wherever `tempfile` points, so point it
        # at this test's own directory: that makes the "no half-written file
        # left behind" check below a scoped fact rather than a glob over a
        # shared /tmp that any other process can dirty.
        scratch = tmp / "scratch"
        scratch.mkdir()
        tempfile.tempdir = str(scratch)
        try:
            transcribe_mod.extract_audio(str(silent))
        except UserFacingError as e:
            message = str(e)
        else:
            print("FAIL: extracting audio from a video-only file did not raise")
            return 1

        assert "no audio to transcribe" in message, message
        assert silent.name in message, f"the message must name the file: {message}"
        for leak in ("CalledProcessError", "returned non-zero", "Traceback", ".wav"):
            assert leak not in message, f"the message leaks {leak!r}: {message}"
        print("ok: video-only source ->", message)

        # A failed extract must not leave its half-written WAV behind.
        strays = list(scratch.glob("*.wav"))
        assert not strays, f"a failed extract left a temp WAV behind: {strays}"

        # --- 2. what the job record (and therefore the UI) actually shows -----
        import server  # imported late: it pulls in fastapi, which 1. does not need

        job_id = server._new_job("transcribe", path=str(silent))
        server._run_job(job_id, lambda: transcribe_mod.extract_audio(str(silent)))
        snapshot = server._snapshot(job_id)
        assert snapshot["state"] == "error", snapshot
        assert snapshot["error"] == message, (
            "a UserFacingError must reach the UI verbatim, with no class-name "
            f"prefix: {snapshot['error']!r}"
        )
        print("ok: job record carries the message verbatim")

        # --- 3. an UNEXPECTED failure still keeps its class name -------------
        def boom() -> None:
            raise KeyError("segments")

        job_id = server._new_job("transcribe", path="none")
        server._run_job(job_id, boom)
        unexpected = server._snapshot(job_id)["error"]
        assert unexpected.startswith("KeyError:"), unexpected
        print("ok: an unexpected fault still reports its type —", unexpected)

        # --- 4. a source that DOES have audio still extracts ------------------
        sounded = tmp / "with-audio.mp4"
        if not _synth(
            sounded,
            [
                "-f", "lavfi", "-i", "color=black:size=64x64:duration=1:rate=24",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=48000",
                "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
            ],
        ):
            print("skip: could not synthesize the audio-bearing fixture")
            return 0

        wav = transcribe_mod.extract_audio(str(sounded))
        try:
            size = os.path.getsize(wav)
            assert size > 1000, f"extracted WAV is suspiciously small: {size} bytes"
            print(f"ok: audio-bearing source still extracts ({size} bytes of WAV)")
        finally:
            Path(wav).unlink(missing_ok=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("all B-119 transcript-error checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
