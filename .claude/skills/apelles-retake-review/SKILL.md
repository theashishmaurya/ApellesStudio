---
name: apelles-retake-review
description: Find the retakes (a flubbed delivery followed by a redo) in a talking-head track of the open Apelles project by reading its numbered word transcript yourself and proposing the groups through Apelles' MCP tools, so the person reviews them in the Recut panel. Use when asked to find, clean up, or review retakes / false starts / repeated takes on the Edit timeline. Not for silence removal (editor_detect_silences), not for grading, and it never cuts unless the user explicitly asks.
---

# Apelles retake review

What this is: the checked-in wrapper around D-380's retake loop. The app runs no
model for retakes; **you** read a track's words and judge, the app **checks** each
group with a deterministic coverage gate and hands the survivors to a person in the
Recut panel (`docs/notes/retake-detection.md` §11-§12, D-380, D-382).

What it does NOT do:

- **It does not contain the judging rules.** They are served by the app, on page 0
  of `editor_get_word_transcript`, as `instructions` - the rules a blind evaluation
  measured at 0.00 s of unique speech lost (D-379). They live in one place on purpose
  (`JUDGING_RULES` in `crates/apelles-speech/src/proposal.rs`, pinned to
  `eval/retake/client_runs/prompt.md`). Read them every run and follow them; do not
  work from memory of an earlier run, and do not paste them here.
- It does not cut anything by default. Proposing stores groups for review.
- It is not `editor_detect_retakes` (the deterministic fallback detector, same gate,
  D-382), and not silence removal.

## 0. Prerequisites

- The Apelles app is running (`npm run tauri:dev` from the repo root) with the
  project open - every `editor_*` tool needs its control server up.
- The `chroma` MCP server is connected in this Claude Code session. If a tool was
  added or changed since the session started, run `/mcp` to reconnect. Never kill
  the running `mcp/server.py` to force a refresh.
- Call `editor_get_state` once to find the track number. The view is every clip on
  that track that has audio, in play order, showing only the words those clips still
  show.

## 1. Read the words

1. `editor_get_word_transcript {track, start: true}`. If `state` is `"transcribing"`
   the app is still transcribing a source and serves no words (indices would shift
   when it lands): wait a few seconds and call again with the same arguments until
   it is not. Parakeet takes seconds to tens of seconds per file.
2. Page 0 carries `instructions`. **Read them before anything else.**
3. Keep calling with `offset` = the previous `nextOffset` until `nextOffset` is
   null. Indices are global, and `viewId` is the same on every page of one view.
4. **A group must never straddle words you have not seen.** The app does not
   overlap pages (2500 words a page), so do it yourself: judge a page, but treat
   groups touching its last ~150 words as provisional and re-judge that tail
   together with the next page. Only a group wholly inside the words you have read
   is final. Do not propose until the last page is read - a proposal REPLACES the
   track's whole set.
5. If `viewId` differs between pages, an edit or a finished transcript landed
   mid-read: start over from `offset` 0.

## 2. Judge, then propose

Judge per the served instructions. Then one call:

`editor_propose_retakes {track, view_id, groups}` with every group you stand by.
`groups` is `[{line, takes: [{first, last}, ...], keep, note, confirm}]` - word-index
ranges, inclusive, in spoken order. The tool description is authoritative for the
shape.

Each group comes back `verified`, `ai_confirmed` or `refused` (with `reason`,
`reasonText`, `offending` word indices). Nothing is cut.

## 3. The refusal loop

For every `refused` group, in order, until resolved or dropped:

1. **Narrow.** If the offending words are unique speech the take swallowed, move
   them outside the take (adjust `first`/`last`) and resubmit.
2. **Is it a mishearing?** If an offending word looks misheard, preview
   `editor_retranscribe_words {track, view_id, first, last}` over that stretch and
   compare `current` with `reread`. If the re-read is better, call again with
   `apply: true`. **Applying changes `viewId` and shifts later indices**
   (`indexShift`): re-read the affected words, re-derive every group's indices and
   resubmit the whole set under the new `viewId`. A stale `view_id` is refused.
3. **Confirm, rarely.** Only if the content genuinely survives - a mis-hearing the
   re-read kept, or an inflection ("run" / "ran") - resubmit with `confirm` giving a
   reason for EVERY offending word. A reason must say why the word is not lost, not
   that the group looks right. `notConfirmable: true` means malformed or in conflict
   with another group: fix it, do not confirm it.
4. **Otherwise drop it.** A group you cannot justify is better absent than confirmed.
   An unresolved group stays `refused`, untickable, and is still shown to the person.

Each resubmission replaces the whole set, so always send every group you still
stand by.

## 4. Hand back to the human

Tell the user to open the **Recut panel** (Edit tab): verified / AI-confirmed /
refused badges, offending words marked, your `confirm` reasons shown, refused rows
untickable until they listen and unlock one. They review and press Cut. Summarise
what you proposed: counts per status, and each refusal you left open and why.

**Only when the user explicitly asks you to apply the cuts:** pass every `segments`
entry of every non-kept take (from the `editor_propose_retakes` answer) to
`editor_ripple_delete_ranges`. Never cut a `refused` group on your own authority.

## 5. Changing the judging prompt: the eval loop

The served rules are measured, so a change to them is only made with numbers
(`eval/retake/README.md`, "Scoring proposals from outside the crate"):

1. `cargo run -p apelles-speech --example render_word_transcript -- eval/retake/transcripts/<source>.parakeet.words.json`
   prints exactly the view a client reads.
2. Run the proposer **3 times** per source with the candidate prompt (fresh context,
   only the view and the prompt), saving each answer as
   `<dir>/C0xx__parakeet.json` in index form (`{"takes": [{"first","last"}...], "keep": k}`).
3. `APELLES_RETAKE_EVAL_PROPOSALS=<dir> cargo test -p apelles-speech --test retake_eval external_proposals -- --nocapture`
   scores them through the app's real gate. The bar is over-cut `0.00 s` on every
   task in every run; recall is what you are trying to raise.
4. Land the new rules in `JUDGING_RULES` and `eval/retake/client_runs/prompt.md`
   together (a test pins them equal), commit the runs under
   `eval/retake/client_runs/`, and record the change in `docs/notes/retake-detection.md`.
