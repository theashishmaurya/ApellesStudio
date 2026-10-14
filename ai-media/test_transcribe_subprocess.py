#!/usr/bin/env python3
"""B-189 / D-322 — the transcribe job must cross a real process boundary.

`server.py` used to `import transcribe` and call it, so the model's weights
and its Metal buffers loaded into the long-lived uvicorn process and were never
released (11 GB of `IOAccelerator (graphics)` after two real mlx-whisper jobs; `ps` showed
~35 MB throughout and saw none of it). `transcribe.transcribe_subprocess` is
the fix. What has a correct answer, and is therefore checked here:

  1. the child's argv — the right interpreter, this file as `__main__`, and
     every option expressed as one of the CLI flags `main()` already documents;
  2. the result comes back from the temp file verbatim, and that file's
     directory does not survive the call;
  3. a `UserFacingError` in the child arrives as a `UserFacingError` with the
     IDENTICAL sentence (B-119 — `server.py` shows it to the user verbatim),
     picked out of stderr that also carries the model's own progress noise;
  4. an ordinary crash becomes a `RuntimeError` carrying the child's stderr,
     and so does exit-0-with-no-result;
  5. a timeout is reported as a sentence, not a `TimeoutExpired` dump;
  6. **the real spawn really works** — argv, `sys.path[0]`, the `errors` import,
     the marker and the exit code — exercised against a genuinely running child
     process on a video-only fixture, which fails in `ffmpeg` long before a
     single model weight is touched;
  7. `POST /transcribe` is wired to `transcribe_subprocess` and NOT to
     `transcribe`, which is the regression B-189 actually was.

Deliberately importable-free of MLX: nothing here loads a model, so it runs on a
plain `python3` without the sidecar's multi-GB venv. Only `ffmpeg` is needed
(for 6), and that section skips when it is absent — the same skip discipline
`test_transcribe_errors.py` and `ai/test_depth_track.py` use.

    python3 ai-media/test_transcribe_subprocess.py
"""
import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import transcribe as transcribe_mod  # noqa: E402
from errors import UserFacingError  # noqa: E402


class _FakeProc:
    def __init__(self, returncode: int, stderr: str = "", stdout: str = "") -> None:
        self.returncode = returncode
        self.stderr = stderr
        self.stdout = stdout


class _FakeSubprocess:
    """Stands in for the `subprocess` module inside `transcribe` alone — the
    real one is restored in a `finally`, and nothing else in the process sees
    this. `run` records the argv it was handed and hands back whatever the test
    programmed, optionally writing the result file the child would have."""

    TimeoutExpired = subprocess.TimeoutExpired

    def __init__(self, proc=None, writes=None, raises=None) -> None:
        self._proc = proc
        self._writes = writes
        self._raises = raises
        self.cmd: list[str] = []
        self.kwargs: dict = {}

    def run(self, cmd, **kwargs):
        self.cmd = list(cmd)
        self.kwargs = kwargs
        if self._raises is not None:
            raise self._raises
        if self._writes is not None:
            out = cmd[cmd.index("--output") + 1]
            Path(out).write_text(json.dumps(self._writes), encoding="utf-8")
        return self._proc


def _with_fake(fake: _FakeSubprocess, fn):
    real = transcribe_mod.subprocess
    transcribe_mod.subprocess = fake
    try:
        return fn()
    finally:
        transcribe_mod.subprocess = real


def _synth(out: Path, args: list[str]) -> bool:
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args, str(out)],
        capture_output=True,
    )
    if proc.returncode != 0:
        print("ffmpeg synthesis failed:", proc.stderr.decode("utf-8", "replace")[-400:])
        return False
    return out.exists()


def check_argv(audio: Path) -> None:
    cmd = transcribe_mod._subprocess_cmd(
        str(audio), "parakeet-tdt-0.6b-v3", "en", True, "/tmp/out.json"
    )
    assert cmd[0] == sys.executable, f"the child must run on this interpreter: {cmd[0]}"
    assert cmd[1] == str(Path(transcribe_mod.__file__).resolve()), cmd[1]
    assert cmd[2:] == [
        "--audio", str(audio),
        "--model", "parakeet-tdt-0.6b-v3",
        "--output", "/tmp/out.json",
        "--language", "en",
    ], cmd[2:]

    # auto-detect is the ABSENCE of --language, exactly as the in-process call
    # never forwards it — "auto" is a request, not a language.
    for lang in (None, "auto", ""):
        cmd = transcribe_mod._subprocess_cmd(str(audio), "parakeet-tdt-0.6b-v3", lang, True, "/o.json")
        assert "--language" not in cmd, f"language={lang!r} must not be passed: {cmd}"

    # word timestamps are ON by default and only the opt-OUT is a flag.
    assert "--no-word-timestamps" not in transcribe_mod._subprocess_cmd(
        str(audio), "parakeet-tdt-0.6b-v3", None, True, "/o.json"
    )
    assert "--no-word-timestamps" in transcribe_mod._subprocess_cmd(
        str(audio), "parakeet-tdt-0.6b-v3", None, False, "/o.json"
    )
    print("ok: child argv is this interpreter, this file, and documented flags only")


def check_result_roundtrip(audio: Path) -> None:
    payload = {
        "text": "hello there",
        "language": "en",
        "model": "parakeet-tdt-0.6b-v3",
        "source": str(audio),
        "segments": [{"start": 0.0, "end": 1.0, "text": "hello there", "words": []}],
        "words": [{"word": "hello", "start": 0.0, "end": 0.4, "probability": 0.9}],
    }
    fake = _FakeSubprocess(proc=_FakeProc(0), writes=payload)
    got = _with_fake(fake, lambda: transcribe_mod.transcribe_subprocess(str(audio)))
    assert got == payload, got

    out_dir = Path(fake.cmd[fake.cmd.index("--output") + 1]).parent
    assert not out_dir.exists(), f"the temp result dir outlived the call: {out_dir}"
    assert fake.kwargs.get("capture_output") and fake.kwargs.get("text"), fake.kwargs
    assert fake.kwargs.get("timeout") == transcribe_mod.TRANSCRIBE_TIMEOUT_S, fake.kwargs
    print("ok: result returns verbatim through the temp file, which is then gone")


def check_user_facing(audio: Path) -> None:
    sentence = (
        "“clip.mp4” has no audio to transcribe — this file has no audio stream at all."
    )
    stderr = (
        "some earlier warning\n"
        f"{transcribe_mod.USER_FACING_MARKER}{sentence}\n"
        "  0%|          | 0/1234 [00:00<?, ?frames/s]\n"
    )
    fake = _FakeSubprocess(
        proc=_FakeProc(transcribe_mod.USER_FACING_EXIT, stderr=stderr)
    )
    try:
        _with_fake(fake, lambda: transcribe_mod.transcribe_subprocess(str(audio)))
    except UserFacingError as e:
        assert str(e) == sentence, f"the sentence must survive intact: {e!r}"
    else:
        raise AssertionError("a user-facing child failure did not raise UserFacingError")
    print("ok: the child's sentence crosses the boundary intact, progress noise ignored")

    # …and reaches the job record with no `ClassName:` prefix (B-119), which is
    # the string the Edit tab's error line renders.
    try:
        import server
    except ImportError as e:
        print(f"skip: server needs fastapi, not installed here ({e})")
        return
    job_id = server._new_job("transcribe", path=str(audio))
    server._run_job(
        job_id,
        lambda: _with_fake(fake, lambda: transcribe_mod.transcribe_subprocess(str(audio))),
    )
    snapshot = server._snapshot(job_id)
    assert snapshot["state"] == "error", snapshot
    assert snapshot["error"] == sentence, snapshot["error"]
    print("ok: job record carries it verbatim")


def check_crash(audio: Path) -> None:
    fake = _FakeSubprocess(proc=_FakeProc(1, stderr="Traceback…\nRuntimeError: metal oom"))
    try:
        _with_fake(fake, lambda: transcribe_mod.transcribe_subprocess(str(audio)))
    except UserFacingError as e:  # must NOT be swallowed as a polished sentence
        raise AssertionError(f"an unexpected crash was mis-reported as user-facing: {e}")
    except RuntimeError as e:
        assert "exit 1" in str(e) and "metal oom" in str(e), str(e)
    else:
        raise AssertionError("a crashed child did not raise")
    print("ok: an ordinary crash reports the child's own stderr")

    # exit 0 with nothing written is a real case (a killed child that trapped
    # its own signal); it must not surface as a confusing JSON parse error.
    fake = _FakeSubprocess(proc=_FakeProc(0, stderr="killed"))
    try:
        _with_fake(fake, lambda: transcribe_mod.transcribe_subprocess(str(audio)))
    except RuntimeError as e:
        assert "no readable result" in str(e), str(e)
    else:
        raise AssertionError("a missing result file did not raise")
    print("ok: exit-0-with-no-result is a RuntimeError naming the child's stderr")

    # exit 3 with no marker line: still a failure, still diagnosable.
    fake = _FakeSubprocess(
        proc=_FakeProc(transcribe_mod.USER_FACING_EXIT, stderr="nothing marked here")
    )
    try:
        _with_fake(fake, lambda: transcribe_mod.transcribe_subprocess(str(audio)))
    except RuntimeError as e:
        assert "nothing marked here" in str(e), str(e)
    else:
        raise AssertionError("an unmarked exit-3 did not raise")
    print("ok: exit 3 without a marked line still raises with the stderr attached")


def check_timeout(audio: Path) -> None:
    fake = _FakeSubprocess(raises=subprocess.TimeoutExpired(cmd=["python"], timeout=3600))
    try:
        _with_fake(fake, lambda: transcribe_mod.transcribe_subprocess(str(audio)))
    except UserFacingError as e:
        message = str(e)
    else:
        raise AssertionError("a timed-out child did not raise UserFacingError")
    assert audio.name in message, message
    assert "60 minutes" in message, message
    for leak in ("TimeoutExpired", "Traceback", "Command"):
        assert leak not in message, f"the message leaks {leak!r}: {message}"
    print("ok: a timeout is a sentence —", message)


def check_real_spawn(tmp: Path) -> None:
    """The one check that runs a REAL child. A video-only file fails inside
    `extract_audio`'s ffmpeg call, which happens before `import parakeet_mlx` —
    so this exercises the whole boundary (spawn, `sys.path[0]`, `from errors
    import …`, the marker, the exit code, the parent's translation) for the
    price of a 1-second black clip and no model at all."""
    silent = tmp / "no-audio.mp4"
    if not _synth(
        silent,
        ["-f", "lavfi", "-i", "color=black:size=64x64:duration=1:rate=24",
         "-pix_fmt", "yuv420p", "-an"],
    ):
        print("skip: could not synthesize the video-only fixture")
        return

    try:
        transcribe_mod.transcribe_subprocess(str(silent))
    except UserFacingError as e:
        message = str(e)
    else:
        raise AssertionError("a real child on a video-only file did not raise")

    assert "no audio to transcribe" in message, message
    assert silent.name in message, message
    for leak in (transcribe_mod.USER_FACING_MARKER, "Traceback", ".wav", "returned non-zero"):
        assert leak not in message, f"the message leaks {leak!r}: {message}"
    print("ok: a REAL spawned child reports its sentence —", message)


def check_server_wiring(tmp: Path) -> None:
    """B-189 itself: `/transcribe` must reach the subprocess, not the function."""
    try:
        import server
    except ImportError as e:
        print(f"skip: server needs fastapi, not installed here ({e})")
        return

    fixture = tmp / "wiring.wav"
    fixture.write_bytes(b"not really a wav")

    def _must_not_run(*_a, **_k):
        raise AssertionError(
            "server called transcribe() in-process — this is B-189 all over again"
        )

    real_fn, real_sub = transcribe_mod.transcribe, transcribe_mod.transcribe_subprocess
    calls: list[dict] = []

    # `**kwargs` and not a fixed signature, which is B-245: this stub used to
    # name `(path, model, language, word_timestamps)` positionally, so when D-349
    # added `start_secs`/`duration_secs` to `server.py`'s call it raised
    # `TypeError` inside the job — the job recorded an error, the assertion
    # below failed on `state == "error"`, and the real question (is `/transcribe`
    # wired to the subprocess?) stopped being asked at all. Recording every
    # kwarg and asserting the whole set still catches drift, and now reports it
    # as the diff it is rather than as a stub that cannot be called.
    def _stub(path, **kwargs):
        calls.append({"path": path, **kwargs})
        return {"text": "stubbed"}

    transcribe_mod.transcribe = _must_not_run
    transcribe_mod.transcribe_subprocess = _stub
    try:
        started = server.start_transcribe(
            server.TranscribeReq(path=str(fixture), language="en", word_timestamps=False)
        )
        job_id = started["job_id"]
        deadline = time.time() + 10
        while time.time() < deadline:
            snapshot = server._snapshot(job_id)
            if snapshot["state"] != "running":
                break
            time.sleep(0.05)
    finally:
        transcribe_mod.transcribe = real_fn
        transcribe_mod.transcribe_subprocess = real_sub

    assert snapshot["state"] == "done", snapshot
    assert snapshot["result"] == {"text": "stubbed"}, snapshot
    assert calls == [
        {
            "path": str(fixture),
            "model": "parakeet-tdt-0.6b-v3",
            "language": "en",
            "word_timestamps": False,
            "start_secs": None,
            "duration_secs": None,
        }
    ], calls
    print("ok: POST /transcribe runs the subprocess, and passes every option through")


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="chroma_b189_"))
    try:
        audio = tmp / "clip.mp4"
        audio.write_bytes(b"fixture")

        check_argv(audio)
        check_result_roundtrip(audio)
        check_user_facing(audio)
        check_crash(audio)
        check_timeout(audio)
        check_server_wiring(tmp)
        if shutil.which("ffmpeg") is None:
            print("skip: ffmpeg not on PATH — the real-spawn check needs it")
        else:
            check_real_spawn(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("all B-189 transcribe-subprocess checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
