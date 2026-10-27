/**
 * `@apelles/editor` — a long file transcribed in windows, in order, so its
 * first minutes are readable while the rest is still being transcribed
 * (D-411 §8, the Automatic Clipper's performance budget).
 *
 * **What it is.** The pure half of `mediaUnderstandingStore`'s
 * `transcribeProgressively`: the window plan ([`planWindows`]) and the stitch
 * ([`stitchWindows`]). Each window is read by the ASR in isolation with
 * [`WINDOW_OVERLAP_S`] of audio either side of its CORE, so a word straddling
 * a core edge is heard whole by both neighbours; the stitch then keeps each
 * word in the one window whose core holds its midpoint — the midpoint rule the
 * word view and the dark-region splice already use — and drops any segment
 * left empty.
 *
 * **Why it is the file's transcript, not a second one.** The windowed pass is
 * the same `chroma_transcribe` call (Parakeet, greedy and deterministic,
 * D-381) the whole-file pass makes, just cut at different seams (Parakeet
 * already chunks a long file internally). When the last window lands the
 * stitched result is adopted as the file's one transcript — cached, persisted
 * (D-385) and read by every consumer — so there is never a clipper transcript
 * that disagrees with the Index panel's.
 *
 * **What it does NOT do.** Run anything (the store does), or splice
 * recoveries (they splice onto the adopted transcript like onto any other).
 */
import type { TranscriptSegment } from './mediaUnderstandingStore';

/** Core length of one window: 5 minutes, the design's choice — the first
 *  window lands in ~17 s at Parakeet's measured 17.6x realtime (D-381). */
export const WINDOW_CORE_S = 300;

/** Audio read either side of a core, so an edge word is heard whole. */
export const WINDOW_OVERLAP_S = 2;

/** One window to read: `[startSecs, startSecs + durationSecs)` of the file,
 *  keeping the words whose midpoint lies in `[coreStart, coreEnd)`. */
export interface TranscriptWindow {
  startSecs: number;
  durationSecs: number;
  coreStart: number;
  coreEnd: number;
}

/** The windows covering `durationSecs` of a file, in order. The last core
 *  runs to infinity so a word stamped past the probed duration is kept. */
export function planWindows(durationSecs: number, core = WINDOW_CORE_S, overlap = WINDOW_OVERLAP_S): TranscriptWindow[] {
  if (!Number.isFinite(durationSecs) || durationSecs <= 0) return [];
  const out: TranscriptWindow[] = [];
  for (let coreStart = 0; coreStart < durationSecs; coreStart += core) {
    const last = coreStart + core >= durationSecs;
    const startSecs = Math.max(0, coreStart - overlap);
    const endSecs = last ? durationSecs + overlap : coreStart + core + overlap;
    out.push({
      startSecs,
      durationSecs: endSecs - startSecs,
      coreStart,
      coreEnd: last ? Number.POSITIVE_INFINITY : coreStart + core,
    });
  }
  return out;
}

/** Keep the words of one window's segments whose midpoint is in its core;
 *  segments keep their own bounds clipped to the words they keep. */
export function coreSegments(segments: readonly TranscriptSegment[], w: Pick<TranscriptWindow, 'coreStart' | 'coreEnd'>): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const seg of segments) {
    const words = (seg.words ?? []).filter((x) => {
      const mid = (x.start + x.end) / 2;
      return mid >= w.coreStart && mid < w.coreEnd;
    });
    if (words.length === 0) continue;
    out.push({
      start: Math.min(words[0].start, Math.max(seg.start, w.coreStart)),
      end: words[words.length - 1].end,
      text: words.map((x) => x.word.trim()).join(' '),
      words,
    });
  }
  return out;
}

/** The finished windows (in order) as one transcript's segments. */
export function stitchWindows(
  windows: ReadonlyArray<{ window: Pick<TranscriptWindow, 'coreStart' | 'coreEnd'>; segments: readonly TranscriptSegment[] }>,
): TranscriptSegment[] {
  return windows.flatMap((w) => coreSegments(w.segments, w.window));
}
