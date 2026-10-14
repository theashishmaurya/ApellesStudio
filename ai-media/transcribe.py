#!/usr/bin/env python3
"""Speech-to-text — "what was said, and when" (D-189).

**What it is:** the audio half of Apelles' media sidecar. Given an audio or
video path, returns the full text plus segment- and word-level timings —
everything an agent (or the Edit tab) needs to cut to an exact spoken word.

**What it does NOT do:** it does not cut anything, touch the timeline, or
touch `grade.json`; it does not describe the PICTURE — that is
`video_understand.py`, a genuinely different question. It makes no network
calls beyond a first-run model download.

**The two are complementary, not interchangeable.** This finds nothing in
silent or music-only footage; `video_understand.py` finds nothing in a single
continuous uncut shot (a talking head has no visual delta to key off). Pick by
what is being asked: "find where I said X" → here; "find where the picture
changed" → there.

**The MODEL is swappable; this file's return value is not** (D-374, 2026-10-09).
`mlx-whisper large-v3` was hard-coded here until D-374 moved it behind the
[`asr.AsrBackend`] Protocol beside `parakeet-tdt-0.6b-v3`. **Since D-381
(2026-10-13) Parakeet is the only backend** (`asr/parakeet_mlx.py`, ~25×
realtime end-to-end): Whisper was decommissioned and its module deleted, and
the seam stays so another backend can be added without touching anything above
this file. What a backend is, and what it owes, is `asr/base.py`; the
measurements and the migration are `docs/notes/asr-backends-and-harness.md`.

**Languages.** Parakeet covers 25 European languages; **Hindi and code-switched
Hinglish are not supported** (D-381, the owner's call — until then this file
promised Hinglish on Whisper). A caller that names a language outside the set is
refused with a sentence saying so; one that names none gets the model's own
behaviour, which on a Hindi source is fluent, wrong English — there is no
detected language to refuse on (`asr.base.check_language`).

**The seam is at the contract that already existed.** [`transcribe`]'s return
value IS the interface, unchanged since D-189, and this file keeps every piece
of the job that is not the model: the path check, the ffmpeg window, the shift
into absolute source seconds, the flattened `words`, the `model`/`source`/
`window` keys, and the contract validation. A backend is handed one prepared
audio file and returns window-local seconds — which is why D-349's windowing
below works identically on a backend that knows nothing about it.

**Determinism.** Parakeet decodes greedily — no sampling, no RNG — so the same
file and the same arguments give byte-identical output with no seed set. D-349
seeded MLX's global RNG for Whisper (B-224, its temperature-fallback ladder
sampled); that seed left with the Whisper backend (D-381).

**D-349's window**: [`transcribe`]'s `start_secs`/`duration_secs` transcribe one
WINDOW of a source with its timestamps shifted back to absolute source seconds —
the recovery primitive `apelles-speech`'s dark-region detector feeds, and the
way the harness's multi-pass reconciliation moves a backend's chunk seams.

**Why this runs as a SUBPROCESS of `server.py` and not in-process** (D-189):
an MLX model's weights (~2.3 GB for Parakeet; ~3 GB for the `large-v3` this was
written for) and the Metal buffers a run allocates are several times that
again. `ai/server.py` had to grow a whole TTL idle-unloader (D-084)
because its lazily-loaded singletons never released theirs. Running each job as
its own process means the OS reclaims every byte on exit, so this sidecar's
idle footprint stays at roughly the FastAPI process itself and the D-084
problem cannot recur here.

**That was the design from day one; until D-322 it was not the code** (B-189).
`server.py` imported this module and called [`transcribe`] like any other
function, so every job's weights and Metal buffers landed in the long-lived
uvicorn process and were never released — measured at 11 GB of
`IOAccelerator (graphics)` after two real jobs, growing roughly linearly per
job. [`transcribe_subprocess`] below is the real process boundary that claim
always described: it runs THIS FILE as `__main__` through `sys.executable`,
exactly as `video_understand.describe_frames` runs `mlx_vlm.generate`. Call it
from any long-lived process. [`transcribe`] itself is unchanged and still the
in-process implementation — right for the CLI below (which IS the short-lived
process) and for a caller that already is one, wrong for a server.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from asr import (
    BACKENDS,
    DEFAULT_BACKEND,
    backend_models,
    check_language,
    get_backend,
    validate_body,
)
from errors import UserFacingError

VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}

# --------------------------------------------------------------------------- #
# the process boundary (B-189 / D-322)
# --------------------------------------------------------------------------- #

# A ceiling, not a schedule. Before D-322 a transcribe job had no timeout at all,
# which is how B-174's dead-TCP hang could sit at 0% CPU forever with nothing to
# report; a subprocess that is killed at least ends as a job error the poller can
# see. It was sized when `large-v3` was the model — one hour covered roughly
# five hours of audio at its measured ~2.7× realtime, and Parakeet's ~25× makes
# the margin far wider — so it can only fire on a job that is genuinely stuck;
# killing a real long take would be the worse failure of the two.
TRANSCRIBE_TIMEOUT_S = 3600

# A `UserFacingError` is a SENTENCE written for the person reading it (B-119),
# and `server.py` records it verbatim. An exception type does not survive a
# process boundary, so the child re-states that one bit explicitly: this exit
# code plus one marked stderr line. Everything else exits non-zero the ordinary
# way and is reported as the raw stderr tail, exactly as `video_understand`
# reports a failed `mlx_vlm.generate`.
USER_FACING_EXIT = 3
USER_FACING_MARKER = "apelles-user-facing-error: "


# What `ffmpeg` prints when the INPUT has no audio stream to map into the WAV
# output. It is not a distinct exit code — the process exits non-zero the same
# way an unreadable file does — so the stderr text is the only signal available.
# Both spellings are real: ffmpeg 7 says "Output file does not contain any
# stream", earlier builds number it ("Output file #0 ...").
_NO_STREAM_MARKERS = (
    "does not contain any stream",
    "Output file is empty",
)


def _last_ffmpeg_error(stderr: str) -> str:
    """The last non-empty stderr line — ffmpeg's own summary of what went
    wrong, without the several screens of stream metadata above it."""
    lines = [ln.strip() for ln in stderr.splitlines() if ln.strip()]
    return lines[-1] if lines else "ffmpeg failed with no output"


def extract_audio(
    video_path: str,
    start_secs: float | None = None,
    duration_secs: float | None = None,
) -> str:
    """16 kHz mono WAV in a temp file — the ASR model's own native input rate
    (Parakeet's preprocessor, as Whisper's was), so the model never has to
    resample.

    `start_secs` / `duration_secs` cut a WINDOW out of the source instead of the
    whole thing (D-349). `-ss` goes **before** `-i` so ffmpeg seeks the input
    rather than decoding and discarding everything up to the mark — on a 680 s
    camera original that is the difference between a fraction of a second and
    tens of them, and it has been frame-accurate for these containers since
    ffmpeg 2.1. The caller is responsible for shifting the resulting timestamps
    back to absolute source seconds; [`transcribe`] does.

    **Raises [`UserFacingError`] rather than `CalledProcessError`** (B-119).
    A source with no audio stream is not an exceptional condition — a screen
    recording captured without audio is an ordinary file to drop on a timeline —
    but `ffmpeg` can only report it as a failed run, and before this the
    resulting `CalledProcessError: Command ['ffmpeg', '-y', '-i', '/Users/…',
    …] returned non-zero exit status 234.` travelled through the job record and
    the Tauri bridge into the Edit tab's own error line, naming a temp path the
    user has never seen. Every other failure is reported as ffmpeg's own last
    line, which is the diagnostic, instead of a repeat of the argv.

    The app refuses this case one layer earlier and never gets here
    (`chroma::media_understanding::no_audio_message`, which reuses the app's own
    `VideoInfo::has_audio` probe). This translation exists so the sidecar is
    correct on its own — for its CLI, and for any caller that is not that app.
    """
    tmp = tempfile.mktemp(suffix=".wav")
    cmd = ["ffmpeg", "-y"]
    if start_secs is not None and start_secs > 0:
        cmd += ["-ss", f"{start_secs:.6f}"]
    cmd += ["-i", video_path]
    if duration_secs is not None and duration_secs > 0:
        cmd += ["-t", f"{duration_secs:.6f}"]
    cmd += ["-ar", "16000", "-ac", "1", tmp]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode == 0:
        return tmp

    # ffmpeg leaves a 0-byte (or partial) WAV behind on a failed run.
    Path(tmp).unlink(missing_ok=True)
    stderr = proc.stderr.decode("utf-8", errors="replace")
    name = Path(video_path).name
    if any(marker in stderr for marker in _NO_STREAM_MARKERS):
        raise UserFacingError(
            f"“{name}” has no audio to transcribe — this file has no audio stream at "
            "all, so there is nothing to turn into words. Use a clip that was "
            "recorded with sound."
        )
    raise UserFacingError(
        f"could not read the audio of “{name}”: {_last_ffmpeg_error(stderr)}"
    )


def _shift(value: object, offset: float) -> object:
    """A timestamp moved into absolute source seconds, or left alone if the
    backend did not emit one. The contract allows an untimed word (`asr/base.py`
    — mlx-whisper emitted them), and `None` must not become `None + offset`."""
    if offset == 0.0 or not isinstance(value, (int, float)) or isinstance(value, bool):
        return value
    return round(float(value) + offset, 6)


def transcribe(
    path: str,
    model: str | None = None,
    language: str | None = None,
    word_timestamps: bool = True,
    start_secs: float | None = None,
    duration_secs: float | None = None,
    backend: str = DEFAULT_BACKEND,
) -> dict:
    """`{text, language, model, source, segments: [{start, end, text, words:
    [{word, start, end, probability?}]}], words: [...]}`.

    `language`: an ISO code ("en", "de", …) or `None` to let the model decide.
    Parakeet takes no language argument, so a named language is only ever
    checked: one outside its 25 European languages is **refused** with a
    sentence, before any model loads, rather than silently mis-transcribed
    (`asr.base.check_language`). Hindi/Hinglish is unsupported (D-381).
    `word_timestamps=False` returns segment-level timings only — not enough to
    cut to a word, and not faster on Parakeet (its own docstring says why).

    `words` is the flattened per-word list across every segment: the shape a
    caller actually wants for "find the word at 12.4s" without walking the
    segment tree itself. Absent (rather than empty) when the model returned no
    word timings at all.

    **`backend`** selects the implementation behind the seam (D-374). Since
    D-381 there is one, `"parakeet"` (`parakeet-tdt-0.6b-v3`), and it is the
    default; the argument stays because the seam does. `model=None` means "that
    backend's own default", so a caller never has to know model names.

    **`start_secs` / `duration_secs` transcribe one WINDOW of the source**
    (D-349, the recovery half of B-216's dark-region fix). The window is cut out
    with ffmpeg and handed to the model on its own, and **every timestamp coming
    back is shifted by `start_secs`**, so a windowed result is in the same
    absolute source seconds as a whole-file one and can be spliced straight into
    it. `window` in the output records the range that was actually asked for.
    This is done HERE and not in a backend, so a new backend gets it for free
    and the shift arithmetic exists exactly once.

    Transcribing a window in ISOLATION is not merely a speed optimisation: it
    was the one technique measured to recover the multi-second regions of real
    speech that Whisper's whole-file pass silently declined to transcribe
    (B-216; `docs/notes/whisper-dark-region-research.md`). It is also how the
    harness's multi-pass reconciliation moves a backend's chunk seams (D-375).

    **Deterministic**: Parakeet decodes greedily with no RNG, so the same file
    and the same arguments give the same transcript, byte for byte, with no
    seed (D-381 retired D-349's Whisper-only seeding along with Whisper)."""
    src = Path(path)
    if not src.exists():
        raise FileNotFoundError(path)

    asr = get_backend(backend)
    model = asr.descriptor.require_model(model)
    check_language(asr.descriptor, language)

    offset = float(start_secs) if start_secs and start_secs > 0 else 0.0
    windowed = offset > 0.0 or bool(duration_secs and duration_secs > 0)

    tmp_audio: str | None = None
    if windowed or src.suffix.lower() in VIDEO_EXTS:
        # A window is cut out even from a plain WAV — the model is handed the
        # window and nothing else, which is the entire point.
        tmp_audio = extract_audio(str(src), start_secs, duration_secs)
        audio_path = tmp_audio
    else:
        audio_path = str(src)

    try:
        body = asr.transcribe(
            audio_path,
            model=model,
            language=language,
            word_timestamps=word_timestamps,
        )
    finally:
        if tmp_audio:
            Path(tmp_audio).unlink(missing_ok=True)

    # The backend's half of the contract, checked at its own boundary (see
    # `asr/base.py`): a backend that returns a malformed segment fails here,
    # naming itself, rather than several layers downstream in a retake group.
    validate_body(body, backend=asr.descriptor.name)

    output: dict = {
        "text": body["text"],
        "language": body["language"],
        "model": model,
        "source": str(src),
    }
    if windowed:
        output["window"] = {
            "start_secs": offset,
            "duration_secs": float(duration_secs) if duration_secs else None,
        }

    # Window-local → absolute source seconds, in place so each entry keeps the
    # key order the contract has always had, and flattened as we go so `words`
    # and `segments[].words` hold the same objects and cannot drift apart.
    segments: list[dict] = body["segments"]
    flat_words: list[dict] = []
    for seg in segments:
        seg["start"] = _shift(seg["start"], offset)
        seg["end"] = _shift(seg["end"], offset)
        for w in seg["words"]:
            w["start"] = _shift(w["start"], offset)
            w["end"] = _shift(w["end"], offset)
            flat_words.append(w)

    output["segments"] = segments
    if flat_words:
        output["words"] = flat_words
    return output


def _subprocess_cmd(
    audio_path: str,
    model: str,
    language: str | None,
    word_timestamps: bool,
    out_path: str,
    start_secs: float | None = None,
    duration_secs: float | None = None,
    backend: str = DEFAULT_BACKEND,
) -> list[str]:
    """The child's argv — this file, run as `__main__`, through the SAME
    interpreter the caller is running on.

    `sys.executable` is correct by construction and for the same reason
    `video_understand` relies on it: whatever interpreter imported this module
    is the one whose environment has `parakeet_mlx` (D-314 — both sidecars share
    `ai-env/.venv`, and `/health` reports the prefix so that is externally
    visible). `__file__` is resolved rather than passed bare so the child's
    implicit `sys.path[0]` is this directory and its `from errors import
    UserFacingError` resolves regardless of the parent's cwd.

    Every argument is one of the CLI flags `main()` already documents — no
    private side-channel, so running a job by hand reproduces exactly what the
    server runs.

    `--backend` is omitted when it is the default, exactly as `--language` is
    omitted for auto-detect: the flag's absence IS the default, so a default
    job's argv names only what the caller actually chose."""
    cmd = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--audio", audio_path,
        "--model", model,
        "--output", out_path,
    ]
    if language and language != "auto":
        cmd += ["--language", language]
    if not word_timestamps:
        cmd.append("--no-word-timestamps")
    if start_secs is not None and start_secs > 0:
        cmd += ["--start-secs", repr(float(start_secs))]
    if duration_secs is not None and duration_secs > 0:
        cmd += ["--duration-secs", repr(float(duration_secs))]
    if backend != DEFAULT_BACKEND:
        cmd += ["--backend", backend]
    return cmd


def _user_facing_message(stderr: str) -> str | None:
    """The child's marked line, un-marked — or `None` if it never wrote one.
    Scanned from the end: the model library's own progress output and warnings
    own stderr too."""
    for line in reversed(stderr.splitlines()):
        line = line.strip()
        if line.startswith(USER_FACING_MARKER):
            return line[len(USER_FACING_MARKER):].strip() or None
    return None


def transcribe_subprocess(
    path: str,
    model: str | None = None,
    language: str | None = None,
    word_timestamps: bool = True,
    timeout_s: int = TRANSCRIBE_TIMEOUT_S,
    start_secs: float | None = None,
    duration_secs: float | None = None,
    backend: str = DEFAULT_BACKEND,
) -> dict:
    """[`transcribe`], run as its own OS process — same arguments, same return
    value, no model weights and no Metal buffers left in the caller (B-189).

    This is what a long-lived process must call. An MLX model loads GBs of
    weights and allocates several GB more of GPU-resident buffers per run, and
    MLX's Metal allocator keeps them: measured (on `mlx_whisper`, B-189) at 11 GB of
    `IOAccelerator (graphics)` in the uvicorn parent after two real jobs, which
    `ps`/`top` cannot see at all (they reported ~35 MB RSS throughout — only
    `footprint <pid>` shows it). Letting the OS reclaim it at process exit is
    the same fix `video_understand` has always had, and it needs no unloader,
    no cache-trim call and no knowledge of MLX's allocator internals.

    The result travels through a temp file, not stdout, because stdout belongs
    to the child's own libraries — any progress output and any warning the
    model library decides to print. `--output` is the CLI's own already-
    documented way to say "put the JSON here," so the parent's contract with
    the child is the same one a human at a terminal gets.

    Failures: a `UserFacingError` in the child arrives here as a
    `UserFacingError` with the identical message (B-119 — `server.py` shows it
    to the user verbatim); a timeout becomes one too, because "this took too
    long and was stopped" is a sentence the user can act on; anything else
    becomes a `RuntimeError` carrying the child's stderr tail, so a crash,
    an OOM kill or an MLX fault is diagnosable instead of silent.

    `backend` / `model` are validated HERE as well as in the child, and against
    the same descriptor, so a bad argument costs no process spawn. The resolved
    model is then passed explicitly, which is what keeps the child's argv a
    complete record of the run even when the caller passed `model=None`."""
    src = Path(path)
    if not src.exists():
        raise FileNotFoundError(path)
    descriptor = get_backend(backend).descriptor
    model = descriptor.require_model(model)
    check_language(descriptor, language)

    out_dir = tempfile.mkdtemp(prefix="apelles_transcript_")
    out_path = str(Path(out_dir) / "transcript.json")
    try:
        try:
            proc = subprocess.run(
                _subprocess_cmd(
                    str(src),
                    model,
                    language,
                    word_timestamps,
                    out_path,
                    start_secs,
                    duration_secs,
                    descriptor.name,
                ),
                capture_output=True,
                text=True,
                timeout=timeout_s,
            )
        except subprocess.TimeoutExpired as e:
            # `subprocess.run` has already killed the child and reaped it, so
            # its GPU memory is gone with it — the reason a timeout is safe to
            # have here at all.
            raise UserFacingError(
                f"transcribing “{src.name}” took longer than {timeout_s // 60} minutes "
                "and was stopped. Try a shorter clip."
            ) from e

        if proc.returncode == USER_FACING_EXIT:
            message = _user_facing_message(proc.stderr)
            if message:
                raise UserFacingError(message)
        if proc.returncode != 0:
            raise RuntimeError(
                f"transcribe subprocess failed (exit {proc.returncode}): "
                f"{proc.stderr[-2000:].strip()}"
            )

        try:
            return json.loads(Path(out_path).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            raise RuntimeError(
                f"transcribe subprocess exited 0 but wrote no readable result ({e}): "
                f"{proc.stderr[-2000:].strip()}"
            ) from e
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)


def main() -> int:
    """The CLI, and — since D-322 — the body of every server job as well
    ([`transcribe_subprocess`] spawns exactly this). Both callers get the same
    treatment of a predicted failure: the sentence alone, no traceback. The
    marker prefix is meaningless to a human reading a terminal and load-bearing
    for a parent process reading stderr, which is why it is on stderr and not
    mixed into the JSON on stdout."""
    parser = argparse.ArgumentParser(description="Word-level transcript, local, Apple Silicon (D-374)")
    parser.add_argument("--audio", required=True, help="Audio or video file path")
    parser.add_argument(
        "--backend",
        default=DEFAULT_BACKEND,
        choices=sorted(BACKENDS),
        help=f"ASR backend (default and only: {DEFAULT_BACKEND})",
    )
    # Not `choices=` scoped to one backend, because the valid set depends on
    # `--backend` and argparse cannot express that. The union is the help text;
    # the real check is `BackendDescriptor.require_model`, which names the
    # backend in its error — one source of truth instead of two.
    parser.add_argument(
        "--model",
        default=None,
        help=f"one of: {', '.join(sorted(backend_models()))} (default: the backend's own)",
    )
    parser.add_argument(
        "--language",
        default=None,
        help="ISO code of the source's language, checked against the model's 25 European "
        "languages and refused if outside them (Hindi is not supported); omit to let the "
        "model decide",
    )
    parser.add_argument("--no-word-timestamps", action="store_true", help="Segment-level timings only")
    parser.add_argument("--output", default=None, help="Save JSON to this path")
    parser.add_argument(
        "--start-secs",
        type=float,
        default=None,
        help="Transcribe only from this point (absolute source seconds). Timestamps come back shifted to absolute source seconds.",
    )
    parser.add_argument(
        "--duration-secs",
        type=float,
        default=None,
        help="Transcribe only this many seconds from --start-secs.",
    )
    args = parser.parse_args()

    try:
        result = transcribe(
            args.audio,
            model=args.model,
            language=args.language,
            word_timestamps=not args.no_word_timestamps,
            start_secs=args.start_secs,
            duration_secs=args.duration_secs,
            backend=args.backend,
        )
    except UserFacingError as e:
        print(f"{USER_FACING_MARKER}{' '.join(str(e).splitlines())}", file=sys.stderr)
        return USER_FACING_EXIT

    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(text, encoding="utf-8")
        print(f"Transcript saved to {args.output}", file=sys.stderr)
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
