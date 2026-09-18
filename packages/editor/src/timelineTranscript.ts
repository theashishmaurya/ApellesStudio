/**
 * @apelles/editor — one transcript for the WHOLE timeline, stitched out of the
 * per-file transcripts the media-understanding store caches (D-329).
 *
 * **What it is.** The pure data half of the Index panel's Transcript view. A
 * transcript is produced per SOURCE FILE and its times are absolute source
 * seconds; a timeline is a sequence of trimmed, reordered, possibly
 * speed-ramped windows onto one or more of those files. This module is the
 * mapping between the two: given a `Timeline` and whatever transcripts are
 * cached, it returns the rows a reader sees, in TIMELINE order, each carrying
 * the TIMELINE frames it occupies.
 *
 * **What it does.**
 * - `transcriptSources` — every distinct source file the timeline's dialogue-
 *   bearing video clips reference, in first-use timeline order, with how many
 *   clips use each. This is the fetch list, already deduped: a silence cut
 *   produces dozens of clips against one `.MOV` and that must cost one
 *   transcription, not dozens.
 * - `stitchTimelineTranscript` — walk the clips in TIMELINE order (not
 *   per-file), take each clip's transcript, keep only the segments that
 *   overlap the clip's own trimmed source window, and convert each kept
 *   segment's source seconds into the timeline frames it actually plays at.
 *   Each row also carries its own WORDS, put through the identical filter and
 *   conversion — that is what makes a karaoke-style per-word highlight and a
 *   click-this-word-to-seek possible without any consumer re-deriving times.
 * - `locateTimelineFrame` — given a timeline frame, which row and which word
 *   inside it the playhead is on, in one scan.
 *
 * **The frame math is NOT re-derived here.** `spanToFrames` (`recut.ts`) is
 * the single source of truth for source-seconds → timeline-frames, and it
 * already handles the three things that make this easy to get wrong: the
 * clip's own `source_fps` (B-077 — a clip's `duration`/`source_start` are its
 * own NATIVE frames, so `start_frame + (sourceFrame - source_start)` is only
 * correct when the source and the project run at the same rate), speed ramps,
 * and clamping a rounded edge back inside the clip so a row can never seek
 * into a neighbour. This module is the ordering and filtering around it.
 *
 * **What it does NOT do.**
 * - It does not fetch or transcribe anything. It is pure and synchronous —
 *   given the same timeline and the same transcript map it returns the same
 *   rows, every time. Fetching, polling and progress live in the panel and in
 *   `useEditorControl`'s op, both of which call `transcriptSources` to know
 *   WHAT to ask for.
 * - It does not read audio tracks. See `dialogueClips` for why, and for the
 *   limit that leaves.
 * - It does not merge, re-punctuate or re-flow speech across a cut. A cut
 *   mid-sentence produces two rows, which is the truth about the edit rather
 *   than a defect: the second half genuinely starts at a different timeline
 *   frame.
 */
import { spanToFrames } from './recut';
import { isStillSource, timelineFps, type Clip, type Timeline } from './timeline';
import type { Transcript, TranscriptSegment } from './mediaUnderstandingStore';
import { spliceTranscript, type RecoveredWindow, type SplicedSegment } from './darkRegions';

/** One WORD of the stitched transcript, located on the timeline.
 *
 *  Present only when the transcript was produced with word timings
 *  (`wordTimestamps: true`, which is what every caller in this repo asks for).
 *  A transcript without them yields rows whose `words` is empty, and every
 *  consumer falls back to the row's own `text` — see `TranscriptRow` in
 *  `EditIndexPanel.tsx`. */
export interface TimelineTranscriptWord {
  /** The word as the model emitted it, INCLUDING its leading space where it
   *  had one. Preserved verbatim rather than trimmed so that rendering the
   *  words back-to-back reproduces the segment's own spacing and punctuation
   *  instead of a naive `join(' ')` that would mangle contractions and
   *  clause-final punctuation. */
  text: string;
  /** TIMELINE frames, clamped inside the clip — what clicking this word
   *  seeks to, and what the playhead highlight compares against. */
  startFrame: number;
  endFrame: number;
  /** The absolute SOURCE seconds it came from. */
  sourceStart: number;
  sourceEnd: number;
}

/** One line of the stitched timeline transcript: a segment of speech, located
 *  on the TIMELINE rather than in its source file. */
export interface TimelineTranscriptRow {
  /** Which clip this speech plays from — the stable id, not an index. */
  clipId: string;
  /** Which track that clip is on. */
  track: number;
  /** The file the words came from. */
  sourcePath: string;
  /** TIMELINE frames, clamped inside the clip. `startFrame` is what a click on
   *  this row seeks to. */
  startFrame: number;
  endFrame: number;
  /** The absolute SOURCE seconds this row came from, kept so a caller can go
   *  back to the file's own transcript without re-deriving the conversion. */
  sourceStart: number;
  sourceEnd: number;
  /** The segment's text, trimmed. The fallback for rendering and the whole
   *  content when the transcript carries no word timings. */
  text: string;
  /** This segment's words, each on the timeline. Empty when the transcript has
   *  no word-level timings. */
  words: TimelineTranscriptWord[];
  /** This row exists because the app went back and re-transcribed a region the
   *  whole-file pass silently dropped (D-349). Surfaced rather than folded in
   *  invisibly: a reader is entitled to know which words appeared for that
   *  reason, and `true` here is the difference between "whisper said this" and
   *  "whisper missed this and we recovered it." */
  recovered?: true;
}

/** One file the timeline needs a transcript for. */
export interface TranscriptSourceRef {
  path: string;
  /** How many clips on the timeline play from this file. `12` here means one
   *  transcription serves twelve rows' worth of clips — the reason this list
   *  is deduped by path rather than being one entry per clip. */
  clipCount: number;
}

/** A clip paired with the track it sits on, which a row needs to report and
 *  the ordering needs as a tie-break. */
interface PlacedClip {
  clip: Clip;
  track: number;
}

/**
 * Every clip that could carry dialogue, in TIMELINE order.
 *
 * **The filter, and why each part of it is here.**
 * - **Video tracks only.** `editor_get_transcript`'s own framing is
 *   talking-head content, and on this timeline model the speech of a normal
 *   edit lives on the video clips (a clip carries its own embedded audio —
 *   see `Clip.volume`/D-129's A/V link). Walking audio tracks as well would
 *   double-count every A/V-linked pair: the same source, the same timeline
 *   span, twice. **Disclosed limit:** a voice-over placed on its own audio
 *   track with no video therefore does not appear. That is a real gap, named
 *   in D-329 rather than implied away.
 * - **Hidden tracks are skipped.** A hidden track does not composite (see
 *   `Track.hidden`), so its speech is not in the edit the reader is reading.
 * - **A clip with no `source_path` is skipped** — a title or adjustment clip
 *   has no file and therefore nothing to transcribe.
 * - **A still image is skipped** (D-292's `isStillSource`). A `.png` has no
 *   audio at all, so offering to transcribe it would queue a job that can
 *   only come back empty.
 *
 * **Ordering is by `start_frame`, tie-broken by track index**, and the sort is
 * stable, so two clips starting on the same frame on the same track keep their
 * Vec order. Ordering by timeline position rather than by file is the whole
 * point: a retake cut interleaves clips from several files, and a per-file
 * walk would read them out in the order they were shot instead of the order
 * they play.
 */
export function dialogueClips(tl: Timeline | null): PlacedClip[] {
  if (!tl) return [];
  const placed: PlacedClip[] = [];
  tl.tracks.forEach((tr, track) => {
    if (tr.kind !== 'video') return;
    if (tr.hidden) return;
    for (const clip of tr.clips) {
      if (!clip.source_path) continue;
      if (isStillSource(clip.source_path)) continue;
      placed.push({ clip, track });
    }
  });
  return placed.sort((a, b) =>
    a.clip.start_frame !== b.clip.start_frame
      ? a.clip.start_frame - b.clip.start_frame
      : a.track - b.track,
  );
}

/**
 * The distinct files this timeline needs transcribed, in first-use timeline
 * order, each with the number of clips that play from it.
 *
 * First-use order rather than alphabetical: it is the order the reader will
 * hit them in, so a progress list built from this reads top-to-bottom the way
 * the transcript does.
 */
export function transcriptSources(tl: Timeline | null): TranscriptSourceRef[] {
  const counts = new Map<string, number>();
  for (const { clip } of dialogueClips(tl)) {
    const path = clip.source_path as string;
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return Array.from(counts, ([path, clipCount]) => ({ path, clipCount }));
}

/**
 * The whole timeline's speech as one ordered list of rows.
 *
 * `transcripts` is the store's `sourcePath -> Transcript` map. A clip whose
 * file is not in it yet simply contributes no rows — that is how a partially
 * transcribed timeline renders the files that ARE done instead of blocking on
 * the slowest one.
 *
 * `recoveries` is the store's `sourcePath -> RecoveredWindow[]` map (D-349).
 * Every recovered window is spliced into its file's transcript before the walk,
 * so a reader sees the speech whisper silently dropped — marked `recovered` on
 * the row, never smuggled in as if the model had read it. Omitting the argument
 * is the pre-D-349 behaviour exactly.
 *
 * Within one clip the segments keep the transcript's own order (chronological
 * in the source, which for a single trimmed window is also chronological on
 * the timeline). Across clips the order is `dialogueClips`' timeline order.
 * The two compose because a clip occupies one contiguous timeline span.
 */
export function stitchTimelineTranscript(
  tl: Timeline | null,
  transcripts: Readonly<Record<string, Transcript>>,
  recoveries: Readonly<Record<string, readonly RecoveredWindow[]>> = {},
): TimelineTranscriptRow[] {
  if (!tl) return [];
  const fps = timelineFps(tl);
  const rows: TimelineTranscriptRow[] = [];
  // D-349 — one spliced list per FILE, computed once rather than per clip: a
  // silence cut produces dozens of clips against one source, and splicing per
  // clip would redo the same merge dozens of times for an identical answer.
  const spliced = new Map<string, SplicedSegment[]>();

  for (const { clip, track } of dialogueClips(tl)) {
    const path = clip.source_path as string;
    const transcript = transcripts[path];
    if (!transcript) continue;
    if (!spliced.has(path)) {
      spliced.set(path, spliceTranscript(transcript.segments ?? [], recoveries[path] ?? []));
    }

    const window = clipWindowSecs(clip, fps);

    for (const segment of clipSegments(clip, spliced.get(path) ?? [], fps)) {
      // `spanToFrames` owns the conversion AND the clamp into the clip's own
      // bounds, so a segment that straddles the cut point reports the part
      // that is actually on the timeline rather than running past it.
      const span = spanToFrames(clip, segment.start, segment.end, fps);
      rows.push({
        clipId: clip.id,
        track,
        sourcePath: path,
        startFrame: span.startFrame,
        endFrame: span.endFrame,
        sourceStart: segment.start,
        sourceEnd: segment.end,
        text: segment.text.trim(),
        // Words get the SAME overlap filter and the SAME conversion as their
        // segment — not a cheaper approximation. A segment straddling a cut
        // keeps only the words actually on the timeline, so a word highlight
        // can never land on speech the edit removed, and clicking one can
        // never seek outside the clip.
        words: (segment.words ?? [])
          .filter((w) => w.end > window.startSecs && w.start < window.endSecs)
          .map((w) => {
            const wordSpan = spanToFrames(clip, w.start, w.end, fps);
            return {
              text: w.word,
              startFrame: wordSpan.startFrame,
              endFrame: wordSpan.endFrame,
              sourceStart: w.start,
              sourceEnd: w.end,
            };
          }),
        ...(segment.recovered ? { recovered: true as const } : {}),
      });
    }
  }

  return rows;
}

/**
 * The segments of a source transcript that this clip actually SHOWS.
 *
 * A clip is a trim of its source, so listing speech from outside its window
 * would put rows in the list that the edit does not contain and seek the
 * playhead to material that is not on the timeline. The test is OVERLAP, not
 * containment: a segment that starts before the in-point and runs past it is
 * partly on the timeline and belongs in the list (clamped by `spanToFrames`),
 * whereas one that merely touches the boundary — `segment.end === startSecs` —
 * contributes no audible frame and is excluded. Same filter `RecutPanel` and
 * the pre-D-329 single-clip view already applied.
 */
function clipSegments<T extends TranscriptSegment>(
  clip: Clip,
  segments: readonly T[],
  fps: number,
): T[] {
  const { startSecs, endSecs } = clipWindowSecs(clip, fps);
  return segments.filter((s) => s.end > startSecs && s.start < endSecs);
}

/** The absolute SOURCE seconds a clip shows, `[startSecs, endSecs)`.
 *
 *  At the CLIP's own rate, not the timeline's: `source_start`/`duration` are
 *  the clip's native frames (B-077), so dividing either by the project fps
 *  would put the window in the wrong place for any clip whose source runs at a
 *  different rate. One helper rather than two copies, because the segment
 *  filter and the word filter must agree exactly — a word kept by a wider
 *  window than its own segment would render outside the row that contains it. */
function clipWindowSecs(clip: Clip, fps: number): { startSecs: number; endSecs: number } {
  const rate = clip.source_fps && clip.source_fps > 0 ? clip.source_fps : fps;
  const startSecs = clip.source_start / rate;
  return { startSecs, endSecs: startSecs + clip.duration / rate };
}

/**
 * The index of the row a TIMELINE frame falls inside, or `-1`.
 *
 * Pure and separated from the hook that calls it so the playhead-highlight
 * lookup can be unit-tested without a DOM, and so the hook's hot path (see
 * `useActiveTranscriptRow` in `EditIndexPanel.tsx`) is one call rather than an
 * inline scan. A linear scan is right here: the list is what a human reads, so
 * it is hundreds of rows at most, and this runs only when the playhead moves.
 *
 * Rows are half-open (`start <= frame < end`), matching every other frame
 * range in this package. A zero-length row — a segment clamped away to nothing
 * at a cut edge — therefore never matches, which is correct: no frame plays it.
 */
export function rowAtTimelineFrame(rows: readonly TimelineTranscriptRow[], frame: number): number {
  return rows.findIndex((r) => frame >= r.startFrame && frame < r.endFrame);
}

/** Where the playhead is in the transcript: which row, and which word inside
 *  it. `-1` for either means "not in one". */
export interface TranscriptPosition {
  row: number;
  word: number;
}

/**
 * The row AND the word a TIMELINE frame falls inside, in one pass.
 *
 * **Deliberately one function returning both**, rather than a row lookup plus
 * a separate word lookup. The playhead subscription that drives the highlight
 * (`useActivePosition` in `EditIndexPanel.tsx`) runs this on every tick and
 * re-renders only when the RESULT changes — so computing both together means
 * one scan per tick and one comparison, instead of two subscriptions or two
 * scans. The word search is scoped to the row already found, so it is bounded
 * by a sentence's length rather than the whole transcript.
 *
 * A word is `-1` while the playhead is inside a row but in a pause between its
 * words, or when the transcript has no word timings at all — both are normal,
 * and both mean "highlight the row, no word".
 */
export function locateTimelineFrame(
  rows: readonly TimelineTranscriptRow[],
  frame: number,
): TranscriptPosition {
  const row = rowAtTimelineFrame(rows, frame);
  if (row < 0) return { row: -1, word: -1 };
  const word = rows[row].words.findIndex((w) => frame >= w.startFrame && frame < w.endFrame);
  return { row, word };
}
