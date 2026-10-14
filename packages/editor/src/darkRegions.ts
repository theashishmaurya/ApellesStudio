/**
 * `@apelles/editor` — dark regions: plan the recovery, and splice it back into
 * the transcript (D-349, B-216).
 *
 * **What it is.** The pure half of "whisper dropped some speech here, go and get
 * it." `apelles-speech`'s `dark` module says *where* the holes are; this module
 * decides *what windows to re-transcribe* and *how the recovered words rejoin
 * the transcript* that retake grouping and the Transcript panel read.
 *
 * **Why the splice, and not just a warning.** The dropped speech is not randomly
 * distributed — it lands preferentially on immediately-repeated near-duplicate
 * material, i.e. on retakes, which is exactly what `editor_detect_retakes`
 * exists to find (`docs/notes/whisper-dark-region-research.md` §2). A report
 * that merely says "there is unread speech at 365.7s" leaves the retake grouper
 * reading the same blind transcript it always did, and leaves a human to run
 * `ffmpeg` by hand. Splicing the recovered words in fixes the *input* to every
 * consumer instead of warning about the output of one.
 *
 * **What it does NOT do.** No detection (that is the Rust crate), no
 * transcription (that is the sidecar's windowed pass), no store access, no
 * React, no I/O. Pure functions over plain data — which is what makes the two
 * decisions worth arguing about (which window to re-read, and what the merged
 * transcript looks like) testable without a model in the loop.
 *
 * **Nothing here is destructive to the timeline.** A splice changes the
 * transcript this session reads; it never changes a clip, and it never touches
 * the cached whole-file transcript — [`spliceTranscript`] returns a new list.
 */

import type { Transcript, TranscriptSegment, TranscriptWord } from './mediaUnderstandingStore';

/** One located dark region, as `chroma_detect_dark_regions` puts it on the
 *  wire. Absolute SOURCE seconds throughout. */
export interface DarkRegionWire {
  start_secs: number;
  end_secs: number;
  duration_secs: number;
  /** The uncovered stretch the region was found in — wider than the region, and
   *  bounded by the transcript words either side of it. */
  stretch_start_secs: number;
  stretch_end_secs: number;
  stretch_speech_secs: number;
  rms_peak: number;
}

/** `chroma_detect_dark_regions`' result, verbatim. */
export interface DarkDetection {
  source: string;
  start_secs: number;
  duration_secs: number;
  analysed_secs: number;
  min_dark_secs: number;
  max_word_secs: number;
  model: string;
  regions: DarkRegionWire[];
  /** `null` when the range held too few well-transcribed utterances to
   *  calibrate a floor — in which case no amplitude gate was applied. */
  rms_floor: number | null;
  calibration_spans: number;
  gated_out: number;
  speech_secs: number;
  covered_secs: number;
}

/** A window to re-transcribe in isolation, in absolute source seconds. */
export interface RecoveryWindow {
  startSecs: number;
  durationSecs: number;
}

/**
 * The longest window handed to one isolated pass.
 *
 * Whisper's own sliding window is 30 s, so a longer extract buys nothing: it
 * would simply be chunked again, reintroducing the whole-file behaviour this
 * recovery exists to escape. An uncovered stretch longer than this is split
 * into windows around its own regions rather than truncated, so no located
 * region is left unread.
 */
export const MAX_RECOVERY_WINDOW_SECS = 30;

/**
 * The shortest window handed to one isolated pass.
 *
 * A 1.3 s extract with no context around it is where whisper starts inventing —
 * every confirmed recovery in the research was a window with a second or two of
 * room either side. The window is grown symmetrically to reach this, clamped to
 * the analysed range.
 */
export const MIN_RECOVERY_WINDOW_SECS = 4;

/**
 * The windows to re-transcribe for a set of detected regions.
 *
 * **One window per STRETCH, not per region** — the stretch is the span between
 * the transcript words either side of the hole, so it is exactly "the audio
 * nobody has read, plus its boundaries." Several regions inside one stretch (a
 * dropped take split by a pause) share a window and cost one pass, and whisper
 * gets the contiguous context that makes an isolated read reliable.
 *
 * Windows are clamped to `[rangeStartSecs, rangeStartSecs + rangeSecs)` — the
 * clip's own trimmed source range — so a recovery can never read material the
 * edit does not contain, and are returned in time order with no overlaps.
 */
export function recoveryWindows(
  regions: readonly DarkRegionWire[],
  rangeStartSecs: number,
  rangeSecs: number,
): RecoveryWindow[] {
  const rangeEnd = rangeStartSecs + Math.max(rangeSecs, 0);
  if (!(rangeEnd > rangeStartSecs)) return [];

  // Deduplicate by stretch: regions carry their stretch, and several regions in
  // one stretch must not become several passes over the same audio.
  const stretches = new Map<string, { start: number; end: number }>();
  for (const r of regions) {
    const start = Math.max(r.stretch_start_secs, rangeStartSecs);
    const end = Math.min(r.stretch_end_secs, rangeEnd);
    if (!(end > start)) continue;
    stretches.set(`${r.stretch_start_secs}|${r.stretch_end_secs}`, { start, end });
  }

  const windows: RecoveryWindow[] = [];
  for (const { start, end } of Array.from(stretches.values()).sort((a, b) => a.start - b.start)) {
    for (const w of splitLong(start, end)) {
      windows.push(grown(w.start, w.end, rangeStartSecs, rangeEnd));
    }
  }

  // Growing to the minimum can make neighbours touch or overlap; merging those
  // keeps the promise that one second of audio is read at most once per pass.
  // **Never past the maximum**, or this would silently undo the split above and
  // hand whisper back the long window it was just spared.
  const merged: RecoveryWindow[] = [];
  for (const w of windows.sort((a, b) => a.startSecs - b.startSecs)) {
    const last = merged[merged.length - 1];
    const lastEnd = last ? last.startSecs + last.durationSecs : 0;
    const union = last ? Math.max(lastEnd, w.startSecs + w.durationSecs) - last.startSecs : 0;
    if (last && w.startSecs <= lastEnd && union <= MAX_RECOVERY_WINDOW_SECS) {
      last.durationSecs = union;
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}

/** A stretch longer than [`MAX_RECOVERY_WINDOW_SECS`], cut into equal pieces at
 *  most that long. Equal rather than greedy so no piece is a 0.5 s remainder
 *  that whisper would read out of context. */
function splitLong(start: number, end: number): Array<{ start: number; end: number }> {
  const span = end - start;
  if (span <= MAX_RECOVERY_WINDOW_SECS) return [{ start, end }];
  const pieces = Math.ceil(span / MAX_RECOVERY_WINDOW_SECS);
  const each = span / pieces;
  return Array.from({ length: pieces }, (_, i) => ({
    start: start + i * each,
    end: i === pieces - 1 ? end : start + (i + 1) * each,
  }));
}

/** `[start, end)` grown symmetrically to [`MIN_RECOVERY_WINDOW_SECS`] and
 *  clamped to the range — never past either edge, and never longer than the
 *  range itself. */
function grown(start: number, end: number, lo: number, hi: number): RecoveryWindow {
  const deficit = MIN_RECOVERY_WINDOW_SECS - (end - start);
  let s = start;
  let e = end;
  if (deficit > 0) {
    s = Math.max(lo, start - deficit / 2);
    e = Math.min(hi, end + deficit / 2);
    // One edge clamped — take the rest from the other, so a region at the very
    // start of a clip still gets its context rather than half of it.
    if (e - s < MIN_RECOVERY_WINDOW_SECS) {
      if (s <= lo) e = Math.min(hi, s + MIN_RECOVERY_WINDOW_SECS);
      else s = Math.max(lo, e - MIN_RECOVERY_WINDOW_SECS);
    }
  }
  return { startSecs: s, durationSecs: e - s };
}

/** One window's recovered transcript, as the store holds it. */
export interface RecoveredWindow {
  window: RecoveryWindow;
  /** The isolated pass's segments, already in absolute source seconds — the
   *  sidecar shifts them (D-349), so nothing here re-derives an offset. */
  segments: TranscriptSegment[];
}

/** A transcript segment that came from a recovery pass rather than from the
 *  whole-file one. The flag is not decoration: a human reading the Transcript
 *  panel is entitled to know which words appeared because the app went back for
 *  them, and a caller comparing two runs needs to tell a splice from a model
 *  change. */
export interface SplicedSegment extends TranscriptSegment {
  recovered?: true;
}

/**
 * The transcript as it should be read, with every recovered window spliced in.
 *
 * **The rule, and why it is at WORD granularity.** A recovery window is an
 * uncovered stretch, so by construction the only whole-file words inside it are
 * the ones the detector refused to believe — the >2 s words the DTW alignment
 * smeared across the hole. Those are replaced, not kept alongside: keeping them
 * would hand the retake grouper the fragment *and* the recovered full text and
 * invite it to call them a retake of each other. Everything outside the window
 * is untouched, including the rest of a segment that merely straddles the edge —
 * which is why the trim is per word rather than per segment.
 *
 * A transcript with no word timings cannot be trimmed that finely, so a segment
 * is dropped only when it lies wholly inside a window. That is the honest
 * fallback rather than a silent approximation, and every caller in this repo
 * asks for word timings.
 *
 * **Windows are applied in the order given, and a later one wins** (D-380 step
 * 2). Each window trims every word already in the list — the whole-file pass's
 * and any earlier window's re-read — whose midpoint it holds, then adds its own
 * segments. The dark-region windows are disjoint by construction, so for them
 * this is exactly the one-shot splice it always was; it matters for a client's
 * isolated re-read of a stretch (`editor_retranscribe_words`), which may
 * overlap an earlier recovery or an earlier re-read and must replace those
 * words rather than sit beside them as a duplicate.
 *
 * Pure: `segments` is not mutated, and the same inputs give the same output in
 * the same order.
 */
export function spliceTranscript(
  segments: readonly TranscriptSegment[],
  recovered: readonly RecoveredWindow[],
): SplicedSegment[] {
  let out: SplicedSegment[] = segments.map((s) => ({ ...s }));
  for (const r of recovered) {
    const win = { start: r.window.startSecs, end: r.window.startSecs + r.window.durationSecs };
    // An empty window read nothing and replaces nothing.
    if (!(win.end > win.start)) continue;
    out = trimWindow(out, win);
    for (const s of r.segments) {
      if (!s.text.trim()) continue;
      out.push({ ...s, recovered: true });
    }
  }

  // Stable by start, then by end — two segments starting on the same instant
  // (a recovered one landing exactly on a kept boundary) read in the order a
  // person would say them.
  return out.sort((a, b) => (a.start !== b.start ? a.start - b.start : a.end - b.end));
}

/** One window's trim, the word-granular rule [`spliceTranscript`] documents:
 *  a segment the window does not overlap is untouched; one with words keeps
 *  the words whose MIDPOINT is outside it (an endpoint test would drop a word
 *  that merely abuts the edge), rebuilt from them; one without word timings is
 *  dropped only when wholly inside. Flags such as `recovered` survive. */
function trimWindow(
  segments: readonly SplicedSegment[],
  win: { start: number; end: number },
): SplicedSegment[] {
  const wordInside = (w: TranscriptWord) => {
    const mid = (w.start + w.end) / 2;
    return mid >= win.start && mid < win.end;
  };
  const out: SplicedSegment[] = [];
  for (const s of segments) {
    if (!(s.end > win.start && s.start < win.end)) {
      out.push(s);
      continue;
    }
    const words = s.words ?? [];
    if (words.length === 0) {
      // No word timings: all-or-nothing is the only honest call.
      if (!(s.start >= win.start && s.end <= win.end)) out.push(s);
      continue;
    }
    const kept = words.filter((w) => !wordInside(w));
    if (kept.length === 0) continue;
    out.push({
      ...s,
      start: kept[0].start,
      end: kept[kept.length - 1].end,
      text: kept.map((w) => w.word).join('').trim(),
      words: kept,
    });
  }
  return out;
}

/** [`spliceTranscript`] applied to a whole [`Transcript`], for the consumers
 *  that take one (the Transcript panel, `editor_get_timeline_transcript`).
 *
 *  `text` is rebuilt from the spliced segments rather than carried over: a
 *  transcript whose `text` disagreed with its own `segments` would be a worse
 *  artefact than either. */
export function spliceTranscriptDoc(
  transcript: Transcript,
  recovered: readonly RecoveredWindow[],
): Transcript {
  if (recovered.length === 0) return transcript;
  const segments = spliceTranscript(transcript.segments ?? [], recovered);
  return {
    ...transcript,
    segments,
    text: segments.map((s) => s.text.trim()).filter(Boolean).join(' '),
    words: segments.flatMap((s) => s.words ?? []),
  };
}

/** How many segments in a spliced list came from a recovery pass — the one
 *  number a panel or a tool response needs to say "this transcript is not the
 *  one whisper handed us." */
export function recoveredCount(segments: readonly SplicedSegment[]): number {
  return segments.filter((s) => s.recovered).length;
}
