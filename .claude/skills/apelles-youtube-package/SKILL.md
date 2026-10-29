---
name: apelles-youtube-package
description: Finish an approved Apelles edit for YouTube - the master export at -14 LUFS through Apelles, a measured sound QA with five listen moments, an .srt from the final voice with names corrected against a glossary, the description with chapters that match the final timing, sources and licence credits, and a Content ID check on every music track. Use only after the owner explicitly says to export ("export it now"), or when asked for the captions, description, chapters or upload files of a finished edit. Not for editing (apelles-explainer-edit) or audio design (apelles-sound-design).
---

# Apelles YouTube package

What this is: the checklist that turned the Five Levels edit into an upload (2026-10-28), including
the Content ID claim that followed it. It orchestrates Apelles' export, the sound-design QA script
and the local transcriber; it adds no app capability.

What it does NOT do:
- Export without the owner's explicit go.
- Upload to YouTube, or dispute a claim on the owner's behalf. A dispute is a legal statement in
  their name: prepare the text, and they submit it.

## 1. Before exporting

- **Music:** every track's source page is checked for **"Content ID Registered"**. A Pixabay track
  ("Upbeat Jazz" by Aurec) drew a claim despite the Pixabay licence. Prefer CC0 / CC BY. If a
  registered track stays in the edit, tell the owner before export that a claim is likely, and how
  to clear it.
- **Credits:** collect the licence credits from `editor_get_credits`. CC BY needs its credit line in
  the description.
- **Final listen:** the owner has approved the final listen of every fix (the "DONE" markers are
  all checked).

## 2. Export the master

- Use `editor_export(out_path=…, renderer="compositor", loudness_preset="youtube")`. That gives
  **-14 LUFS / -1 dBTP** (D-401). Never normalise by hand.
- Use 4K when the source and project are 4K. Every export re-renders everything (about 12–15 min for
  7–8 min of 4K). There is no incremental export yet (roadmap 0n), so batch all fixes before
  exporting.
- Verify the file with `ffprobe` (duration, resolution, codecs).
- Run the QA:
  ```
  ai-env/.venv/bin/python .claude/skills/apelles-sound-design/scripts/sound_qa.py \
      --project "<project>.chroma" --export <master.mp4> --voice-track <N>
  ```
  Put its **five moments to check by ear** in the report.

## 3. Captions (.srt)

- Transcribe the **final** voice (the cleaned voice export, not the raw takes) with the local
  transcriber.
- Correct names against a glossary: product and people names, model names, jargon. Five Levels
  needed about 30 fixes (Claude, CLAUDE.md, Apelles, Lamis, Anthropic…). Build the glossary from the
  script and `REFERENCES.md`.
- If a late fix changed the timing (an inserted or removed bit), shift every cue after that point by
  the exact delta.

## 4. Description file

Write `<title> - description.txt` next to the master, in Downloads. It holds:

- **Title options:** 2–3, with a recommended one.
- **Description:** the hook in 2–3 lines.
- **Chapters:** computed from the FINAL timeline, using the section markers' times. Re-check them
  after any late change.
- **Apelles line:** "Edited in Apelles… https://apelles.studio (join the beta)".
- **Sources:** with links.
- **Music:** with licences.
- **Sound effects:** the CC BY credits (required) listed separately from CC0 (appreciated).
- **Tags:** including `apelles`.

## 5. Report

List the files (master, .srt, description), the measured loudness and peak, the five listen
moments, any Content ID risk, and anything still pending.

If a claim arrives after upload, find the track's source page and prepare the dispute text: licence
name, track page link, licence link, credited in the description. Copy it to the clipboard for the
owner to paste and submit.
