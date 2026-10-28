/**
 * `@apelles/editor` — word-aware silences: a VAD silence never overlaps a
 * transcribed word (B-289, D-420).
 *
 * **What it is.** The one rule both silence surfaces apply before showing a
 * silence as something to cut: `editor_detect_silences` (and its sweep) and the
 * Recut panel's Find silences. Given the Silero VAD's silences for a clip
 * (`chroma_detect_silences`, D-319/D-342, source seconds) and the words of the
 * same source file, it removes every stretch a word occupies, plus a guard
 * either side, and drops what is left if it is shorter than the minimum the
 * caller asked for.
 *
 * **Why.** B-289: a straight "cut the silences" pass on the owner's voiceover
 * (350 ms minimum, 134 silences) removed the first word of the recording and
 * the trailing word of many sentences ("…where you are *at*", "amnesia every
 * *morning*"). Silero's silence starts inside a quiet, trailing-off word —
 * the speech probability falls below its threshold before the word is over.
 * The transcript knows where the word is; the VAD alone cannot.
 *
 * **What it does NOT do.** It does not run the VAD, read the store, or cut. It
 * never ADDS silence: a range can only shrink, split or disappear, so a
 * word-aware answer is always a subset of the VAD-only one. With no words (no
 * transcript yet) the caller reports the VAD's ranges unchanged and says so —
 * `wordAware: false` is part of the answer, never implied.
 */

import { spliceTranscript, type RecoveredWindow } from './darkRegions';
import type { Transcript } from './mediaUnderstandingStore';

/** Kept either side of every word, in seconds. The owner's B-289 workaround
 *  (each VAD silence intersected with the word transcript, +3 frames) kept all
 *  1355 words of the voiceover; 3 frames at its ~24 fps is 0.125 s. It also
 *  covers what a Parakeet word end misses: a word's end is the end of its last
 *  0.08 s-frame token, and a soft final consonant can trail past it. */
export const SILENCE_WORD_GUARD_SECS = 0.125;

/** A silence in source seconds, the shape `chroma_detect_silences` returns. */
export interface SilenceSecs {
  start_secs: number;
  end_secs: number;
  duration_secs: number;
}

export interface WordSpanSecs {
  start: number;
  end: number;
}

export interface WordAwareSilences {
  silences: SilenceSecs[];
  /** VAD silences that a word (with its guard) overlapped — shortened, split
   *  or removed. */
  trimmed: number;
  /** VAD silences removed outright: every piece left was shorter than the
   *  minimum. */
  dropped: number;
}

/**
 * `silences` minus every word span widened by `guardSecs`, keeping only pieces
 * of at least `minSilenceSecs`. `words` need not be sorted; an untimed or
 * inverted word is ignored.
 */
export function wordAwareSilences(
  silences: readonly SilenceSecs[],
  words: readonly WordSpanSecs[],
  minSilenceSecs: number,
  guardSecs: number = SILENCE_WORD_GUARD_SECS,
): WordAwareSilences {
  const blocked = words
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start)
    .map((w) => ({ start: w.start - guardSecs, end: w.end + guardSecs }))
    .sort((a, b) => a.start - b.start);

  const out: SilenceSecs[] = [];
  let trimmed = 0;
  let dropped = 0;
  for (const s of silences) {
    let pieces: Array<{ start: number; end: number }> = [{ start: s.start_secs, end: s.end_secs }];
    let touched = false;
    for (const b of blocked) {
      if (b.start >= s.end_secs) break;
      if (b.end <= s.start_secs) continue;
      touched = true;
      pieces = pieces.flatMap((p) => {
        if (b.end <= p.start || b.start >= p.end) return [p];
        const left = { start: p.start, end: Math.max(p.start, b.start) };
        const right = { start: Math.min(p.end, b.end), end: p.end };
        return [left, right].filter((q) => q.end > q.start);
      });
    }
    const kept = pieces.filter((p) => p.end - p.start >= minSilenceSecs);
    if (touched) {
      trimmed += 1;
      if (kept.length === 0) dropped += 1;
    }
    for (const p of kept) {
      out.push({ start_secs: p.start, end_secs: p.end, duration_secs: p.end - p.start });
    }
  }
  return { silences: out, trimmed, dropped };
}

/**
 * Every timed word of one source file as every consumer reads it: the
 * whole-file pass with its recoveries and applied re-reads spliced in (the
 * same `spliceTranscript(segments, recoveriesFor(path))` the word view and the
 * Index panel use). `null` when there is no transcript — the caller then
 * answers VAD-only, and says so.
 */
export function transcriptWordSpans(
  transcript: Transcript | undefined,
  recoveries: readonly RecoveredWindow[],
): WordSpanSecs[] | null {
  if (!transcript) return null;
  return spliceTranscript(transcript.segments ?? [], recoveries)
    .flatMap((s) => s.words ?? [])
    .filter((w) => typeof w.start === 'number' && typeof w.end === 'number')
    .map((w) => ({ start: w.start, end: w.end }));
}
