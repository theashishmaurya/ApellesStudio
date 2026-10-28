# Edit by text — cut words, fillers and pauses in the app (D-420, roadmap 0l)

**Status: built 2026-10-28.** Not verified live yet (the running app serves
main's code; live-check steps at the end).

## Why

Editing the owner's "Five Levels of Claude Code" voiceover this week needed
throwaway scripts outside the app for three jobs the app had no tool for:
mapping words to TIMELINE times after cuts, cutting filler/fluff words, and
removing silence without clipping words. Their hand-rolled padding left 16
fragments of deleted words that had to be found and cut again, and a straight
cut of the VAD's silences removed real words (B-289). The owner: *"why external
code? do we not have these inbuilt?"* Along the way two more defects surfaced:
the whole-file transcript dropped ~1.5 min of speech (B-287) and one valid
range of a ripple batch was refused (B-288).

## What was built

| piece | where | for the human | for the AI |
|---|---|---|---|
| word → timeline frames | `retakeWordView.ts` `viewWordFrames` | Index panel rows already seek by word | `editor_get_word_transcript {include_timeline: true}` → `words[]` with `clip`, `startFrame`, `endFrame` |
| filler suggestions | `fillers.ts` `findFillers` | Index panel › Transcript: "Fillers" highlight, "Select fillers" | `fillers[]` on every page of the word view |
| the cut planner | `cutWords.ts` `planCutWords` (pure) | ⇧/⌘-click words, Delete | `editor_cut_words` |
| applying it | `cutWordsOps.ts` → one `ripple_delete_ranges` op | same | same |
| voice-over transcripts | `timelineTranscript.ts` `dialogueClips` | Index panel transcript, captions from transcript | `editor_get_timeline_transcript` |
| word-aware silences | `silenceWords.ts` `wordAwareSilences` | Recut panel › Find silences | `editor_detect_silences` (+ sweep, `_status`) |
| unread speech | `ai-media/asr_coverage.py` + `Transcript.coverage` | (recovered words simply appear) | `unreadSpeech` in the word view |

## The cut planner's rules

Inputs: the track's word view (each source's spliced transcript, one piece per
visible clip, words by midpoint — `apelles_speech::proposal::index_pieces`),
the word-index ranges to delete, and optionally `tightenGapsSecs` /
`keepBreathSecs`.

1. **Runs.** Within each piece, consecutive deleted words form one run, cut from
   the first's onset to the last's release, pauses between them included. This
   is the fragment fix: cutting word by word leaves the slivers between them.
2. **Pad.** Each edge reaches up to `CUT_PAD_MAX_SECS` = 0.32 s past the deleted
   word (one maximum-length Parakeet token; the retake gate's
   `EDGE_PAD_MAX_SECS`, D-376/D-380), but toward a KEPT neighbour only to the
   middle of the gap between them.
3. **Clip boundaries.** A run reaching a piece edge whose next word in play
   order (in the next clip) is also deleted is cut to that edge, in both clips.
   The ripple op merges the two adjacent ranges into one cut.
4. **Frames.** Each edge is snapped to a whole source frame held between the
   kept word's edge and the deleted word's edge (`snap`). When a kept and a
   deleted word are less than a frame apart there is no such frame: the edge is
   the middle of the gap and the word is reported in `tight`.
5. **Tightening** (optional). For each pair of consecutive kept words whose
   remaining pause (after the word cuts) exceeds `tightenGapsSecs`, cut the
   pause down to `keepBreathSecs` (default 0.3 s), half kept after the earlier
   word and half before the later. Across a clip boundary both clips are
   trimmed; a pause with a whole wordless clip inside is left alone.
6. **Apply.** All cuts go to `applyRippleDeleteRanges` as a dry run (per-range
   verdicts, B-197) and then to ONE `ripple_delete_ranges` op: one undo step,
   A/V-linked partners (D-129) and sync-locked tracks (D-106) carried as the
   Recut panel's cuts are. The answer lists every cut (frames as they were
   before), its words, the per-range outcome and the new `viewId`.

## Word-aware silences (B-289)

Silero's silence starts inside a quiet, trailing-off word. When the clip's
source has a transcript (any consumer's splice: whole-file pass + recoveries +
applied re-reads), each VAD silence has every word span widened by
`SILENCE_WORD_GUARD_SECS` = 0.125 s subtracted, and pieces shorter than the
caller's minimum dropped. It only ever shrinks a range. The answer says
`wordAware` / `basis` either way; a VAD-only answer tells the caller to
transcribe first. The Recut panel applies the same function and says so in its
notice.

## Voice-over transcripts (D-329 → D-420)

`dialogueClips` read video tracks only (to avoid counting an A/V pair twice),
so a timeline with only a voice-over track had no transcript, and subtitles
from it failed. It now also reads audio-track clips that are not A/V-linked to
a video clip, skipping a track that ducks under another (a music bed). A muted
voice is still read: muting is a mixing state (B-293 found a voiceover at gain
0 mid-edit).

## Tests

- `cutWords.test.ts` — the planner: the fragment case, deleted neighbours as one
  cut, a kept word between two cuts, the pad at a clip edge, the under-a-frame
  `tight` case, a range spanning two clips, tightening (in a clip, across a clip
  boundary, merged with a word cut, the default breath), refusals.
- `fillers.test.ts`, `silenceWords.test.ts`, `rippleDeleteRanges.test.ts` (B-288).
- `editByText.e2e.dom.test.tsx` — the ops through the real dispatch: timeline
  rows / fillers / unread speech; the cut on an A/V-linked pair as one undo
  step and its undo; all suggested fillers in one call; a range across two
  clips; tightening and a dry run; a stale view; a voice-over timeline
  transcript; word-aware vs VAD-only silences; B-288's batch.
- `EditIndexPanel.wordEdit.dom.test.tsx` — the panel: plain click seeks,
  ⇧-click selects, Delete cuts (one undo step), ⌘-click toggles, Esc clears,
  the filler highlight and "Select fillers" review.
- `ai-media/test_asr_coverage.py`, `test_transcribe_coverage_live.py` (B-287).

## Live check (after merge, in the running app)

1. Re-transcribe the voiceover (`editor_get_transcript {path, force: true}` or
   Index › Transcript after clearing it): the word count should match the
   repaired one (9:28 file: ~1343 words), `coverage.unread` empty.
2. `editor_get_word_transcript {track, include_timeline: true}`: `words[i]`
   frames match where the word plays (seek there and listen); `fillers` lists
   the uh/um.
3. `editor_cut_words {track, view_id, ranges: <fillers>, dry_run: true}`, then
   without `dry_run`: one undo entry; scrub each cut — no fragment, no clipped
   word; undo restores.
4. `editor_detect_silences {track}` on the transcribed voiceover: `wordAware:
   true`; no range starts inside a word.
5. Index panel › Transcript: ⇧-click a few words, Delete; "Fillers" → "Select
   fillers" → Delete.
6. A voice-over-only timeline: `editor_get_timeline_transcript` has rows;
   captions from transcript works.
