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

Backend: `mlx-whisper` (Apple Silicon, local) with `large-v3`. Ported from
videoAgent's own `/whisper-mlx` script (`src/transcribe/whisper_transcribe.py`)
— a mature, already-proven capability, nothing novel to validate. Two
deliberate simplifications from that source, so this file has no unused
surface (`CLAUDE.md`: no dead code):
  - Its `lightning-whisper-mlx` backend is dropped. It cannot produce
    word-level timings at all (segments only), which is the entire reason
    Apelles wants a transcript; keeping it would mean a second model dependency
    that no caller here can use.
  - Its `--quant` / `--batch-size` knobs went with that backend; `mlx-whisper`
    has neither.

`condition_on_previous_text=False` is kept from the source: a loop/hallucination
guard that matters on exactly the long single-take footage an editor works
with.

**Why this runs as a SUBPROCESS of `server.py` and not in-process** (D-189):
`large-v3` weights are ~3 GB, and the Metal buffers a run allocates are several
times that again. `ai/server.py` had to grow a whole TTL idle-unloader (D-084)
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

from errors import UserFacingError

VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}

DEFAULT_MODEL = "large-v3"

# mlx-whisper loads weights from an HF repo, not a bare model name.
MLX_MODEL_REPOS = {
    "tiny": "mlx-community/whisper-tiny-mlx",
    "base": "mlx-community/whisper-base-mlx",
    "small": "mlx-community/whisper-small-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "large-v2": "mlx-community/whisper-large-v2-mlx",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
    "large": "mlx-community/whisper-large-v3-mlx",
    "distil-large-v3": "mlx-community/distil-whisper-large-v3",
}

# --------------------------------------------------------------------------- #
# the process boundary (B-189 / D-322)
# --------------------------------------------------------------------------- #

# A ceiling, not a schedule. Before D-322 a transcribe job had no timeout at all,
# which is how B-174's dead-TCP hang could sit at 0% CPU forever with nothing to
# report; a subprocess that is killed at least ends as a job error the poller can
# see. One hour covers roughly five hours of audio at `large-v3`'s real MLX
# speed, so it can only fire on a job that is genuinely stuck — killing a real
# long take would be the worse failure of the two.
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


def extract_audio(video_path: str) -> str:
    """16 kHz mono WAV in a temp file — whisper's own native input rate, so the
    model never has to resample.

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
    proc = subprocess.run(
        ["ffmpeg", "-y", "-i", video_path, "-ar", "16000", "-ac", "1", tmp],
        capture_output=True,
    )
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


def _local_snapshot_or_repo(repo: str) -> str:
    """Resolve `repo` to its cached local snapshot path, or return `repo`
    unchanged if it is not cached yet (B-174).

    `mlx_whisper.load_models.load_model` calls
    `huggingface_hub.snapshot_download(repo_id=path_or_hf_repo)` with no
    `local_files_only` — which, even when every file is already cached, still
    reaches out to the Hub to check the cached revision is current. That
    contradicts this module's own promise ("no network calls beyond a
    first-run model download") and was caught live: a dead TCP connection
    (CLOSE_WAIT — the peer had already closed, the client never noticed) left
    a transcribe job hung indefinitely with 0% CPU, no timeout, no error.

    `load_model` only calls `snapshot_download` when `Path(path_or_hf_repo)`
    does NOT already exist — a real local directory is used as-is. So
    resolving the cached snapshot path ourselves, with `local_files_only=True`
    (which raises immediately rather than touching the network when the
    repo isn't cached), and handing `load_model` that path instead of the bare
    repo id skips the network call entirely on every call after the first,
    with no global state (`HF_HUB_OFFLINE`) to mutate and no thread-safety
    concern with concurrent jobs for different models."""
    try:
        from huggingface_hub import snapshot_download

        return snapshot_download(repo_id=repo, local_files_only=True)
    except Exception:
        # Not cached yet (or the cache is unreadable) — fall back to the bare
        # repo id so `load_model` does its normal first-run download.
        return repo


def transcribe(
    path: str,
    model: str = DEFAULT_MODEL,
    language: str | None = None,
    word_timestamps: bool = True,
) -> dict:
    """`{text, language, model, source, segments: [{start, end, text, words:
    [{word, start, end, probability?}]}], words: [...]}`.

    `language`: "en", "hi", … or `None` to auto-detect (code-switched Hinglish
    auto-detects fine on `large-v3`). `word_timestamps=False` returns
    segment-level timings only — faster, but not enough to cut to a word.

    `words` is the flattened per-word list across every segment: the shape a
    caller actually wants for "find the word at 12.4s" without walking the
    segment tree itself. Absent (rather than empty) when the model returned no
    word timings at all."""
    src = Path(path)
    if not src.exists():
        raise FileNotFoundError(path)

    repo = MLX_MODEL_REPOS.get(model)
    if repo is None:
        raise ValueError(
            f"no HF repo mapped for model {model!r}. Supported: {', '.join(MLX_MODEL_REPOS)}"
        )

    tmp_audio: str | None = None
    if src.suffix.lower() in VIDEO_EXTS:
        tmp_audio = extract_audio(str(src))
        audio_path = tmp_audio
    else:
        audio_path = str(src)

    try:
        import mlx_whisper

        kwargs: dict = {
            "path_or_hf_repo": _local_snapshot_or_repo(repo),
            "word_timestamps": word_timestamps,
            # Loop/hallucination guard on long single-take footage — kept from
            # the ported source, where it was added for exactly that reason.
            "condition_on_previous_text": False,
        }
        if language and language != "auto":
            kwargs["language"] = language
        result = mlx_whisper.transcribe(audio_path, **kwargs)
    finally:
        if tmp_audio:
            Path(tmp_audio).unlink(missing_ok=True)

    output: dict = {
        "text": (result.get("text") or "").strip(),
        "language": result.get("language", language or "unknown"),
        "model": model,
        "source": str(src),
    }

    segments: list[dict] = []
    flat_words: list[dict] = []
    for seg in result.get("segments") or []:
        if not isinstance(seg, dict):
            continue
        seg_words: list[dict] = []
        for w in seg.get("words") or []:
            if not isinstance(w, dict):
                continue
            entry = {"word": w.get("word"), "start": w.get("start"), "end": w.get("end")}
            if "probability" in w:
                entry["probability"] = round(w["probability"], 3)
            seg_words.append(entry)
            flat_words.append(entry)
        segments.append(
            {
                "start": seg.get("start"),
                "end": seg.get("end"),
                "text": (seg.get("text") or "").strip(),
                "words": seg_words,
            }
        )

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
) -> list[str]:
    """The child's argv — this file, run as `__main__`, through the SAME
    interpreter the caller is running on.

    `sys.executable` is correct by construction and for the same reason
    `video_understand` relies on it: whatever interpreter imported this module
    is the one whose environment has `mlx_whisper` (D-314 — both sidecars share
    `ai-env/.venv`, and `/health` reports the prefix so that is externally
    visible). `__file__` is resolved rather than passed bare so the child's
    implicit `sys.path[0]` is this directory and its `from errors import
    UserFacingError` resolves regardless of the parent's cwd.

    Every argument is one of the CLI flags `main()` already documents — no
    private side-channel, so running a job by hand reproduces exactly what the
    server runs."""
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
    return cmd


def _user_facing_message(stderr: str) -> str | None:
    """The child's marked line, un-marked — or `None` if it never wrote one.
    Scanned from the end: `mlx_whisper`'s own progress bar owns stderr too."""
    for line in reversed(stderr.splitlines()):
        line = line.strip()
        if line.startswith(USER_FACING_MARKER):
            return line[len(USER_FACING_MARKER):].strip() or None
    return None


def transcribe_subprocess(
    path: str,
    model: str = DEFAULT_MODEL,
    language: str | None = None,
    word_timestamps: bool = True,
    timeout_s: int = TRANSCRIBE_TIMEOUT_S,
) -> dict:
    """[`transcribe`], run as its own OS process — same arguments, same return
    value, no model weights and no Metal buffers left in the caller (B-189).

    This is what a long-lived process must call. `mlx_whisper` loads ~3 GB of
    weights and allocates several GB more of GPU-resident buffers per run, and
    MLX's Metal allocator keeps them: measured at 11 GB of
    `IOAccelerator (graphics)` in the uvicorn parent after two real jobs, which
    `ps`/`top` cannot see at all (they reported ~35 MB RSS throughout — only
    `footprint <pid>` shows it). Letting the OS reclaim it at process exit is
    the same fix `video_understand` has always had, and it needs no unloader,
    no cache-trim call and no knowledge of MLX's allocator internals.

    The result travels through a temp file, not stdout, because stdout belongs
    to the child's own libraries — the run's progress bar and any warning
    `mlx_whisper` decides to print. `--output` is the CLI's own already-
    documented way to say "put the JSON here," so the parent's contract with
    the child is the same one a human at a terminal gets.

    Failures: a `UserFacingError` in the child arrives here as a
    `UserFacingError` with the identical message (B-119 — `server.py` shows it
    to the user verbatim); a timeout becomes one too, because "this took too
    long and was stopped" is a sentence the user can act on; anything else
    becomes a `RuntimeError` carrying the child's stderr tail, so a crash,
    an OOM kill or an MLX fault is diagnosable instead of silent."""
    src = Path(path)
    if not src.exists():
        raise FileNotFoundError(path)
    if model not in MLX_MODEL_REPOS:
        raise ValueError(
            f"no HF repo mapped for model {model!r}. Supported: {', '.join(MLX_MODEL_REPOS)}"
        )

    out_dir = tempfile.mkdtemp(prefix="apelles_transcript_")
    out_path = str(Path(out_dir) / "transcript.json")
    try:
        try:
            proc = subprocess.run(
                _subprocess_cmd(str(src), model, language, word_timestamps, out_path),
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
                "and was stopped. Try a shorter clip, or a smaller model."
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
    parser = argparse.ArgumentParser(description="Word-level transcript via mlx-whisper (local, Apple Silicon)")
    parser.add_argument("--audio", required=True, help="Audio or video file path")
    parser.add_argument("--model", default=DEFAULT_MODEL, choices=sorted(MLX_MODEL_REPOS))
    parser.add_argument("--language", default=None, help="en, hi, … or omit for auto-detect")
    parser.add_argument("--no-word-timestamps", action="store_true", help="Segment-level timings only (faster)")
    parser.add_argument("--output", default=None, help="Save JSON to this path")
    args = parser.parse_args()

    try:
        result = transcribe(
            args.audio,
            model=args.model,
            language=args.language,
            word_timestamps=not args.no_word_timestamps,
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
