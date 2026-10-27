---
name: apelles-auto-clip
description: Cut short vertical clips (Reels, Shorts, TikTok) from a long video, podcast, course or edited timeline in the open Apelles project, by reading its numbered moment view yourself, proposing the best moments through Apelles' MCP tools and having them built as 9:16 timelines the person reviews in the Clipper panel. Use when asked for shorts, reels, clips, highlights or "the best moments" from a long recording or timeline in Apelles. Not for retake clean-up (apelles-retake-review), not for music (apelles-sound-design), and it renders files only when asked.
---

# Apelles auto clip

What this is: the checked-in wrapper around D-411's clipper loop. The app runs no
model and picks nothing. It analyses the source (sentences, topics, every clean,
in-length window, evidence tags), **you** judge which moments are worth a short, and
the app checks each of your picks with a deterministic clean-cut gate and builds the
passing ones as timelines in the same project (`docs/notes/automatic-clipper.md`,
D-411 and its Phase 1-2 build notes).

What it does NOT do:

- **It does not contain the judging rules.** They are served by the app on page 0 of
  the moment view as `instructions` (`JUDGING_RULES` in
  `crates/apelles-clipper/src/view.rs`, versioned). Read them every run and follow
  them; do not work from memory of an earlier run and do not paste them here.
- It does not render files unless the person asked for them (`export_dir`).
- It does not cut the long-form, and it is not retake or silence removal — a short's
  dead air and VERIFIED retakes are tightened inside the short when it is built.

## 0. Prerequisites

- The Apelles app is running (`npm run tauri:dev` from the repo root) with the
  project open.
- The `chroma` MCP server is connected. If a tool is missing, run `/mcp` to
  reconnect. Never kill the running `mcp/server.py`.
- Know the source: a media-pool file (`editor_list_media` → `media_id`) or a long
  timeline (`editor_list_timelines` → `timeline_id`, plus the dialogue `track` if it
  is not the first track with media). Ask the person how many shorts, which lengths
  (15 / 30 / 60 / 90 s) and whether there is a focus, unless they said.
- Optional but better: if the long-form has retakes, run apelles-retake-review first
  so verified retakes are cut out of the shorts.

## 1. Analyse

1. `editor_auto_clip {media_id | timeline_id (+track), count, durations, focus?}`.
   It answers with `runId`, `state` and, when it can, `view` (page 0 with
   `instructions`).
2. If `state` is `"transcribing"`, the transcript is being read in 5-minute
   windows. Poll `editor_auto_clip_status {run_id}` every 10-20 s until `state` is
   `"ready"`. A `provisional` view of the part done so far may be shown — you may
   read it to get oriented, but you cannot propose against it (sentence numbers can
   still change at the end).
3. Read `view.instructions` **before anything else**.

## 2. Read the whole view

- Page through `editor_get_moment_view {run_id, offset}` with `offset` = the previous
  `nextOffset` until it is null. Sentence numbers are global; `viewId` is the same on
  every page of one view. If it changes between pages, start again from 0.
- Each line is `S<n>  start-end  [tags]  words`. Tags are measured facts (a question,
  a number, "needs context \"so\"", "lands (1.2s pause)", pace, loudness, picture
  cuts, focus words) — evidence, not a score. `ends:` under a sentence lists clean
  endings per target length. Judge the words.
- Do not propose until you have read every page: the best moment may be in the last
  minutes, and the set should spread across the recording.

## 3. Propose

One call, your `count` best shorts (add one or two alternates only if the person
asked for options):

`editor_propose_clips {run_id, view_id, clips: [{segments: [{first, last}], hook?,
title, reason, hook_line}]}`

- `segments` are inclusive SENTENCE numbers, in play order — usually one range.
- `hook` (optional): one to three whole sentences, at most 8 s, played first, when the
  strongest line sits later in the moment.
- `title`: the viewer-facing headline the clip delivers; `reason`: one line the
  person can check against the words; `hook_line`: the opening line, quoted.
- By default the passing clips are **built** straight away as timelines (9:16, centre
  crop, tightened, captioned in the brand kit's style). Pass `build: false` if the
  person wants to review before anything is built.

Each clip comes back `verified`, `warned` (with the issue named) or `refused` (with
`notes` and `offendingSentences`).

## 4. The refusal loop

For each `refused` clip: read the reason, fix the ranges, resubmit just those clips
(the default `replace: false` adds to the run):

- **starts / ends mid-sentence** — only possible with word nudges; use sentence ranges.
- **length outside every band** — add or drop a sentence (`ends:` shows clean
  endings), or pick a different target length.
- **starts / ends inside a reviewed retake** — move the edge past the retake.
- **hook not whole sentences / too long** — shorten it to one or two sentences.
- **stale view_id** — the source changed: re-read the view and re-derive numbers.

For `warned` clips: an opener that needs context ("And so…") usually means the
previous sentence belongs in the clip; an unanswered question at the end usually
means the answer belongs in it. Fix those with `editor_set_clip_proposal {run_id,
proposal_id, extend_start: 1 | extend_end: 1}` (re-gated), then rebuild
(`editor_build_clips {run_id, ids, rebuild: true}`).

## 5. Hand back to the person

Tell them to open the **Clipper** panel (Edit tab library column, the clapperboard):
each short with its reason, the gate's verdict, accept / reject, sentence nudges, and
a button to open the built short's timeline. Summarise: how many built, each title
and length, any refusal you left and why.

Work on a built short with the ordinary `editor_*` tools after
`editor_set_active_timeline {id}`. **Never rebuild over a person's edits:**
`editor_build_clips` refuses by default; pass `mode: "new_version"` (or `"replace"`
only when they said to overwrite).

**Only when the person asks for files:** `editor_build_clips {run_id, export_dir,
loudness_preset: "youtube"}` queues every built short's export (sequential; poll
`editor_export_status`). For music under a short, use apelles-sound-design.

## 6. Changing the judging rules

The served rules are version 1 and **not yet measured** against owner labels. A change
is made with numbers, the D-379 way: render the view a client reads with
`cargo run -p apelles-clipper --example render_moment_view -- <transcript.json> 30 60`,
run blind proposers on it, score them against the owner's labelled best moments
(`eval/clipper/README.md`), then land the new text in `JUDGING_RULES` and bump
`JUDGING_RULES_VERSION` together.
