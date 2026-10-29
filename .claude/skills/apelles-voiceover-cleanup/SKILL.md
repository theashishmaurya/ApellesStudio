---
name: apelles-voiceover-cleanup
description: Turn a raw voiceover or talking-head recording into a clean, well-paced voice track on an Apelles Edit timeline, in multiple passes - transcript coverage check, retakes and blunders, fillers and stutters, then a pacing pass with explicit gap targets - checked against the script, with section and judgement-call markers for the person's listen. Use when asked to "clean the audio", "cut the silences", "fix the pacing / gaps", "remove the blunders / retakes" or prepare a voiceover before the visual edit. Not for noise removal or EQ (the owner cleans the voice himself), not for music/SFX (apelles-sound-design), and it never exports.
---

# Apelles voiceover clean-up

What this is: the owner's standing workflow for a recorded voiceover, learned on the Five Levels
(2026-10-28) and Nemotron Transcribe (2026-10-29) edits. It orchestrates existing tools and skills;
it adds no app capability.

What it does NOT do:

- **Judge retakes on its own rules.** Retake groups follow `apelles-retake-review` (the app serves the
  judging rules on page 0 of `editor_get_word_transcript`). Read that skill and follow it.
- **Denoise, de-ess, EQ or level the voice.** The owner cleans the voice himself (an external
  enhancer) and hands back a WAV. Swap it in with `editor_swap_clip_media` or a new clip at the same
  frame, and check the offset is 0 ms against the original.
- **Export, or add music, video, captions or motion.** It stops at a clean voice track. The owner
  listens first ("don't export, let me check once editing is done").

## 0. Prerequisites

- The Apelles app is running and the `chroma` MCP server is connected. If tools changed, run `/mcp`;
  never kill `mcp/server.py`.
- Everything goes through `mcp__chroma__*` tools. **No Python or control-bridge workarounds** for
  something a tool does. The owner has asked "why Python, why not MCP?" more than once. If a tool is
  broken, log a `B-NNN` in `docs/BUGS.md` and say so. Don't hand-roll it.
- Read compactly: use `editor_list_tracks` and `get_timeline(track=…, start_frame/end_frame,
  fields=[…])`, never a full timeline dump.
- Find the script (`script_clean.md` / `script.md` in the video's project folder under
  `~/my_projects/videoAgent/projects/…`). It is the reference for every pass.

## 1. Set up

- `new_project` with the recordings, then name the timeline (for example "Voiceover").
- Place the files in recording order, back to back, on ONE audio track (`editor_add_clip`, explicit
  `start_frame`).
- **Set the timeline rate now if video will follow** (`editor_set_timeline_output(fps=30)`). New
  projects default to 24 fps, and converting later is avoidable work.

## 2. The passes (run all of them, in order)

1. **Coverage.** Get the word transcript (`editor_get_word_transcript`) and line it up with the
   script. A script stretch missing from the transcript means speech was dropped (B-287 history).
   Run `editor_retranscribe_words` on that range BEFORE cutting anything.
2. **Retakes and blunders.** Follow `apelles-retake-review`. Keep the best take, usually the last
   complete one, and cut false starts and abandoned fragments. When the owner asked for the clean
   cut, apply the groups yourself with `editor_cut_words` as one undo step. Then clear stale proposals
   from the Recut panel.
3. **Fillers and stutters.** Cut "um", "uh", doubled words, half-words, and "like"/"so" used as
   filler. **Keep words that are in the script**, even if they look like filler.
4. **Pacing.** The owner wants it tight; "the pacing seems slow" is the most common note. Targets:

   | Where | Keep |
   |---|---|
   | Inside a sentence (hesitations): only gaps ≥ 0.3 s | ~0.12 s |
   | Between sentences | ~0.18–0.22 s |
   | Section change (a `##` heading in the script) | ~0.4 s |

   - **Breaths:** cut breaths and mouth sounds that sit alone in a gap. Keep a breath that leads
     into a word.
     - Breaths and "ehh"s are not in the word transcript, and no tool detects them yet (noted
       2026-10-29).
     - Tightening every gap to the targets removes most lone breaths: cut edges stop ~50 ms short
       of a word.
     - What remains (a drawn-out syllable, a sigh inside a word's own timing) only a listen finds.
       Ask the person for timestamps.
   - **How to cut:** use `editor_cut_words` (`tighten_gaps_ms` / `keep_breath_ms`), which is
     word-safe. When gaps need different keep values (for example longer at section changes), dry-run
     it, then apply its planned ranges with `editor_ripple_delete_ranges`, shrinking only the ranges
     that need a longer keep. Every cut stays inside the tool's word-safe ranges.
   - **Never touch mid-sentence gaps under ~0.3 s.** The transcriber times words to ~80 ms, so a
     "gap" in a fast phrase is often not silence. On 2026-10-29, tightening 0.15–0.25 s gaps
     chopped fast phrases into slivers. It garbled "misheard surnames…" (the word is split as
     "Miss | Heard") and "Seven paid systems…". The between-sentence and section targets are safe.
   - **Never clip a word's start or end** (B-289 history). Check that the word count is equal before
     and after the pacing pass.
5. **Final read.** Re-read the cut transcript top to bottom against the script. Anything doubled,
   garbled, out of order or missing gets fixed or reported.
   - Read every tool answer (`applied` / `skipped`). Never assume a cut landed.
   - The transcriber mishears names (Claude, Apelles, Hinglish, Hildy, Otter). That is not the
     speaker's fault. Note it, but don't cut over it.

## 3. Markers for the listen

- A **blue marker** at each script section start, named after the heading.
- A **yellow marker** at every judgement call, with a note:
  - a splice between takes with no silence;
  - an ad-lib not in the script;
  - a line that may need a re-record;
  - a section title said aloud.
- Markers follow ripple edits (D-422), so add them whenever is convenient.

## 4. Report

Give the owner the following:

- **Length:** raw vs clean.
- **Counts per pass:** retakes, fillers, pauses tightened.
- **Section times.**
- **The yellow markers** as a table: time and what to check.
- **Script differences:** where they said something different from the script (worth knowing,
  not necessarily wrong).
- **Transcriber mishearings.**

Then stop and wait for their listen and markers. Save the project (`save_project`).
