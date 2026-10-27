#!/usr/bin/env python3
"""Claude Code hook: point the agent at the apelles-sound-design skill when audio work starts.

What it is: the trigger half of D-406. Registered in `.claude/settings.json` for two events:
  - UserPromptSubmit: the prompt mentions music, a soundtrack, SFX, sound design, ducking…
  - PreToolUse on Apelles' audio MCP tools (search/import audio, credits, track ducking, clip audio).
What it does: prints `hookSpecificOutput.additionalContext` asking the agent to load the skill
before placing or mixing audio. At most once per REMIND_EVERY_S per session, so a long audio pass
is not flooded with the same reminder.
What it does NOT do: block, modify or approve anything. Any error exits 0 silently, so a broken
hook can never stop a prompt or a tool call.

Stdlib only; reads the hook payload as JSON on stdin.
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path

REMIND_EVERY_S = 30 * 60
AUDIO_WORDS = re.compile(
    r"\b(music|soundtrack|score|bgm|sfx|sound ?effects?|sound ?design|whoosh(es)?|risers?|"
    r"duck(ing|ed)?|audio mix|mix(ing)? (the )?audio|foley|stingers?|jingles?)\b",
    re.IGNORECASE,
)
REMINDER = (
    "This task involves music or sound effects in Apelles. Before placing, changing or mixing any "
    "audio, load the `apelles-sound-design` skill (Skill tool) and follow it: an edited music bed "
    "with dropouts on story beats (dry cold open, punchlines, dry CTAs), sparse effects at "
    "conservative levels, CC0 / CC BY sources only with credits, sounds chosen by measured "
    "character (scripts/sound_character.py), every change read back from editor_get_timeline, and "
    "a closing scripts/sound_qa.py report with five moments for the person to check by ear."
)


def should_remind(session_id: str) -> bool:
    marker = Path(tempfile.gettempdir()) / "apelles-sound-design-hook" / re.sub(r"[^\w.-]", "_", session_id or "nosession")
    try:
        if marker.exists() and time.time() - marker.stat().st_mtime < REMIND_EVERY_S:
            return False
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.touch()
    except OSError:
        pass  # can't record it: remind anyway, a duplicate reminder is harmless
    return True


def main() -> None:
    payload = json.load(sys.stdin)
    event = payload.get("hook_event_name", "")
    if event == "UserPromptSubmit":
        relevant = bool(AUDIO_WORDS.search(payload.get("prompt") or ""))
    elif event == "PreToolUse":
        relevant = True  # the settings matcher already limits this to the audio tools
    else:
        relevant = False
    if relevant and should_remind(payload.get("session_id", "")):
        print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": REMINDER}}))


if __name__ == "__main__":
    try:
        main()
    except Exception:  # never let the reminder break a prompt or a tool call
        pass
    sys.exit(0)
