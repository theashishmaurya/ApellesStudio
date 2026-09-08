#!/usr/bin/env python3
"""Speech-to-text — "what was said, and when" (D-189).

**What it is:** the audio half of Chroma's media sidecar. Given an audio or
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
    Chroma wants a transcript; keeping it would mean a second model dependency
    that no caller here can use.
  - Its `--quant` / `--batch-size` knobs went with that backend; `mlx-whisper`
    has neither.

`condition_on_previous_text=False` is kept from the source: a loop/hallucination
guard that matters on exactly the long single-take footage an editor works
with.

**Why this runs as a SUBPROCESS of `server.py` and not in-process** (D-189):
`large-v3` weights are ~3 GB. `ai/server.py` had to grow a whole TTL
idle-unloader (D-084) because its lazily-loaded singletons never released
theirs. Running each job as its own process means the OS reclaims every byte
on exit, so this sidecar's idle footprint stays at roughly the FastAPI process
itself and the D-084 problem cannot recur here.
"""

from __future__ import annotations

import argparse
import json
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
            "path_or_hf_repo": repo,
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


def main() -> None:
    parser = argparse.ArgumentParser(description="Word-level transcript via mlx-whisper (local, Apple Silicon)")
    parser.add_argument("--audio", required=True, help="Audio or video file path")
    parser.add_argument("--model", default=DEFAULT_MODEL, choices=sorted(MLX_MODEL_REPOS))
    parser.add_argument("--language", default=None, help="en, hi, … or omit for auto-detect")
    parser.add_argument("--no-word-timestamps", action="store_true", help="Segment-level timings only (faster)")
    parser.add_argument("--output", default=None, help="Save JSON to this path")
    args = parser.parse_args()

    result = transcribe(
        args.audio,
        model=args.model,
        language=args.language,
        word_timestamps=not args.no_word_timestamps,
    )
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(text, encoding="utf-8")
        print(f"Transcript saved to {args.output}", file=sys.stderr)
    else:
        print(text)


if __name__ == "__main__":
    main()
