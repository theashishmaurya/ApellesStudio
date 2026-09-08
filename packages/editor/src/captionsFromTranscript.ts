// @chroma/editor — auto-captioning from the D-189 transcript (D-238,
// roadmap item 27's "Auto-captioning from the D-189 transcript" line).
//
// **What it is:** the ONE new thing this feature needed — a pure function
// that groups a D-189 transcript's timed words into caption CUES, plus the
// seconds->frames conversion that turns those cues into the exact
// `{id, start_frame, duration, text}` shape `import_subtitles` already
// consumes (see `timeline.ts`'s `EditOp` union and its reducer). It does NOT
// introduce a new track kind, a new clip variant, or a new store op — a
// generated cue becomes a `Clip` on a `TrackKind::Subtitle` track exactly the
// way an imported `.srt` cue does (D-229), through the identical
// `import_subtitles` op. `editor_generate_captions_from_transcript` (the MCP
// tool) and the GUI's "Captions from Transcript" button both call the two
// functions below and then dispatch that same op — one grouping algorithm,
// one frame-rounding rule, one undo entry, whichever interface asked
// (CLAUDE.md's "one op underneath both").
//
// **What it does NOT do:** it does not call the `ai-media/` sidecar (that is
// `mediaUnderstandingStore.ts`'s `getTranscript`/`startTranscript`, already
// built for D-189) and it does not touch the timeline (the caller applies the
// `import_subtitles` op, same as the SRT importer).
//
// ## The grouping heuristic, and why these numbers
//
// A transcript's `words` are one word each — far too fine-grained to read as
// on-screen cues (a new caption every 200-400 ms). Turning them into cues
// means deciding where to break, and three real reference points went into
// this:
//
//   - **Premiere Pro's "Create Captions from Transcript"** and **CapCut's**
//     auto-caption both default to short, sentence-aware chunks rather than
//     one cue per ASR segment or one giant paragraph — a handful of words per
//     card, re-broken at a pause or a sentence end when a segment runs long.
//   - **Broadcast subtitle practice** (also D-229's own `CaptionCue::
//     chars_per_second` doc) targets roughly 1-6 s on screen and a reading
//     rate around 15-20 characters/second — the range this repo already
//     treats as the norm.
//   - **mlx-whisper's own segments are already sentence/clause-shaped** (its
//     decoder breaks on natural pauses, not a fixed word count) — reusing
//     that boundary is free sentence-boundary awareness, cheaper and more
//     honest than re-detecting sentences from punctuation.
//
// So the algorithm is two-level:
//
//   1. **A transcript segment is always a cue boundary.** Two segments never
//      merge into one cue, even if both are short — mlx-whisper's segment
//      break already IS the sentence/clause break this feature wants, and
//      re-joining them would throw that boundary away for no benefit.
//   2. **Within one segment, a cue breaks on the first of:** reaching
//      [`DEFAULT_MAX_WORDS_PER_CUE`] (8 - the middle of a one-line subtitle's
//      usual 6-10 word range at typical English word length), reaching
//      [`DEFAULT_MAX_CUE_DURATION_S`] (3.0 s - the middle of the 1-6 s
//      broadcast range, chosen on the short side because a generated caption
//      is a starting point an editor will retime, not a final broadcast
//      master), or a gap to the next word of at least
//      [`DEFAULT_MAX_PAUSE_GAP_S`] (0.7 s - long enough to be a real breath or
//      a clause break rather than ordinary inter-word spacing, short enough to
//      still catch one).
//
// 8 words at ~5.7 characters/word (average English word length including the
// space) is ~46 characters over up to 3.0 s - about 15 characters/second at
// the cap, inside the 15-20 cps broadcast norm even before an editor retimes
// anything.
//
// A cue this produces is always **single-line** (no `\n`) - unlike an
// imported `.srt` cue, a generated one never needs `CaptionCue.lines()`'s
// multi-line handling, since the grouping heuristic caps a cue at one line's
// worth of text by construction.

import type { TranscriptSegment, TranscriptWord } from './mediaUnderstandingStore';

/** How many words trigger a break, regardless of duration or pause. See the
 *  module doc for why 8. */
export const DEFAULT_MAX_WORDS_PER_CUE = 8;

/** How many seconds of the SOURCE (word start-to-end span) trigger a break,
 *  regardless of word count or pause. See the module doc for why 3.0. */
export const DEFAULT_MAX_CUE_DURATION_S = 3.0;

/** A gap to the next word at least this long triggers a break early - a real
 *  pause, not ordinary inter-word spacing. See the module doc for why 0.7. */
export const DEFAULT_MAX_PAUSE_GAP_S = 0.7;

export interface CaptionGroupingOptions {
  maxWords?: number;
  maxDurationS?: number;
  maxPauseGapS?: number;
}

/** One generated cue, before it has met a project's frame rate - source
 *  SECONDS, exactly as `TranscriptWord.start`/`end` already are. */
export interface GeneratedCue {
  text: string;
  start_s: number;
  end_s: number;
}

/** Group a transcript's segments into caption cues.
 *
 * A segment with no word-level timings (`words` absent or empty - the
 * `word_timestamps: false` case `editor_get_transcript` still allows) is
 * skipped entirely rather than falling back to one cue per segment: a
 * segment can legitimately be many seconds long, and a segment-level cue
 * would sit on screen far past broadcast norms with no way to sub-divide it
 * honestly. If every segment lacks word timings, this returns `[]` - the
 * caller is expected to tell the user to re-run `editor_get_transcript` with
 * `word_timestamps: true` (the default), not to guess at a fallback.
 *
 * Non-finite/negative option overrides degrade to the default, the same
 * "the caller's bad number never poisons the arithmetic" contract
 * `CaptionLayout::resolve` (Rust) already holds to.
 */
export function groupTranscriptIntoCues(
  segments: TranscriptSegment[],
  options: CaptionGroupingOptions = {},
): GeneratedCue[] {
  const maxWords = positiveIntOr(options.maxWords, DEFAULT_MAX_WORDS_PER_CUE);
  const maxDurationS = positiveOr(options.maxDurationS, DEFAULT_MAX_CUE_DURATION_S);
  const maxPauseGapS = positiveOr(options.maxPauseGapS, DEFAULT_MAX_PAUSE_GAP_S);

  const cues: GeneratedCue[] = [];
  for (const segment of segments) {
    const words = (segment.words ?? []).filter(
      (w) => typeof w.word === 'string' && w.word.length > 0,
    );
    cues.push(...chunkSegmentWords(words, maxWords, maxDurationS, maxPauseGapS));
  }
  return cues;
}

/** Break one segment's words into cues. Always ends a cue at the segment's
 *  last word (the caller never merges across segments), and otherwise closes
 *  the current group as soon as it would exceed `maxWords`/`maxDurationS`, or
 *  when the gap before the NEXT word is at least `maxPauseGapS`. */
function chunkSegmentWords(
  words: TranscriptWord[],
  maxWords: number,
  maxDurationS: number,
  maxPauseGapS: number,
): GeneratedCue[] {
  const cues: GeneratedCue[] = [];
  let group: TranscriptWord[] = [];

  for (let i = 0; i < words.length; i++) {
    group.push(words[i]);
    const isLastWordOfSegment = i === words.length - 1;
    const groupStart = group[0].start;
    const groupEnd = words[i].end;
    const duration = groupEnd - groupStart;
    const reachedMax = group.length >= maxWords || duration >= maxDurationS;
    const nextGapTooLarge =
      !isLastWordOfSegment && words[i + 1].start - words[i].end >= maxPauseGapS;

    if (isLastWordOfSegment || reachedMax || nextGapTooLarge) {
      cues.push({
        text: joinWords(group),
        start_s: groupStart,
        end_s: groupEnd,
      });
      group = [];
    }
  }
  return cues;
}

/** Join a group of transcript words into one cue's text.
 *
 * mlx-whisper's own word tokens carry their OWN leading space (` want`, not
 * `want`) - the D-189 decision entry's own verified-live example - so a plain
 * concatenation already reproduces natural spacing; `.trim()` drops the one
 * leading space the first word contributes, and collapsing repeated
 * whitespace tolerates a transcript from a differently-conventioned ASR
 * backend without producing a visibly double-spaced caption. */
function joinWords(words: TranscriptWord[]): string {
  return words
    .map((w) => w.word)
    .join('')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveIntOr(value: number | undefined, fallback: number): number {
  const v = positiveOr(value, fallback);
  return Math.max(1, Math.round(v));
}

/** One cue already converted to the project's own frame rate - the exact
 *  shape `import_subtitles` (`timeline.ts`) consumes, and what
 *  `chroma::subtitles::ImportedCaption` mirrors for the `.srt` path. */
export interface GeneratedCaption {
  id: string;
  start_frame: number;
  duration: number;
  text: string;
}

/** Convert generated cues (source seconds) to timeline frames, offset by
 *  `offsetFrames` - the same "drop it at the playhead, not at 0:00" rule
 *  `SubtitleImportButton`/`editor_import_subtitles` already use.
 *
 * **Mirrors `chroma_timeline::subtitle_import::cues_to_clips` exactly**: each
 * timestamp is rounded to a frame independently (not the duration computed
 * from an un-rounded seconds delta), and a cue is given a minimum duration of
 * one frame rather than being allowed to collapse to zero. Doing this
 * arithmetic once, here, in the ONE function both the MCP tool and the GUI
 * button call, is what keeps the two interfaces from ever rounding a cue
 * differently (CLAUDE.md's "one source of truth").
 *
 * `idPrefix` seeds stable, distinct clip ids (mirrors `chroma_import_
 * subtitles`'s own `cap-<stem>-<i>` convention) - `fps` non-finite/`<= 0`
 * falls back to `DEFAULT_FPS`, same degrade-not-poison contract as the Rust
 * function. */
export function generatedCuesToCaptions(
  cues: GeneratedCue[],
  fps: number,
  offsetFrames: number,
  idPrefix: string,
): GeneratedCaption[] {
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 24;
  const offset = Number.isFinite(offsetFrames) ? Math.round(offsetFrames) : 0;
  return cues.map((cue, i) => {
    const start = Math.round(cue.start_s * rate) + offset;
    const end = Math.round(cue.end_s * rate) + offset;
    return {
      id: `${idPrefix}${i}`,
      start_frame: start,
      duration: Math.max(1, end - start),
      text: cue.text,
    };
  });
}

/** A source path/name reduced to characters safe in a clip id - mirrors
 *  `chroma::subtitles::sanitise_id` (Rust) so a generated id LOOKS like an
 *  imported one, not a second, differently-shaped convention. */
export function sanitiseIdStem(stem: string): string {
  return stem
    .split('')
    .map((c) => (/[a-zA-Z0-9]/.test(c) ? c : '-'))
    .join('')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}
