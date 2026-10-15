"""ffmpeg_bin.py — which `ffmpeg` this sidecar runs (D-389, B-253).

What it is: the one place `ai-media/` turns "ffmpeg" into a program to spawn.
What it does: honours `CHROMA_FFMPEG`, which the app's Rust supervisor
  (`apelles_ai::sidecar`) sets to the binary `apelles_media::ffmpeg_locate`
  resolved — normally the copy bundled inside Apelles.app — so a transcription
  or scene-detect runs the same ffmpeg the app does. Run standalone (the CLI,
  the tests, `run.sh`), with no override, it falls back to `PATH`.
What it does NOT do: search install locations itself. The ladder (override →
  bundled → /opt/homebrew/bin, /usr/local/bin → PATH) lives in Rust once; this
  module only reads its answer. A Finder-launched app's sidecar inherits
  launchd's minimal PATH, which is exactly why it must not guess here.
"""

from __future__ import annotations

import os
import shutil


def ffmpeg_bin() -> str:
    """The ffmpeg to run: `CHROMA_FFMPEG` if set, else `ffmpeg` from PATH."""
    override = os.environ.get("CHROMA_FFMPEG")
    if override:
        return override
    return shutil.which("ffmpeg") or "ffmpeg"


def ffmpeg_available() -> str | None:
    """The resolved ffmpeg path if it names a real file, else None — for the
    `/health` status card."""
    override = os.environ.get("CHROMA_FFMPEG")
    if override:
        return override if os.path.isfile(override) else shutil.which(override)
    return shutil.which("ffmpeg")
