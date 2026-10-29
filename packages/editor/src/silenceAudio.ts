/**
 * `@apelles/editor` — silences where the AUDIO is the authority, and the
 * tunable knobs around it (B-327, D-428).
 *
 * **What it is.** The one resolver behind `editor_detect_silences` (single clip
 * and sweep) and the Recut panel's Silences button. Given what the audio says
 * (the Silero VAD's silences plus a dBFS loudness envelope, both from
 * `chroma_detect_silences`), the words of the source (if it has a transcript)
 * and a bag of options, it answers: which stretches are silent, which of them
 * are safe to cut around the words, and where exactly to cut.
 *
 * **Why (B-327).** The word-aware rule of B-289 / D-420 trims every silence
 * 0.125 s back from each transcribed word. A transcriber that times a
 * sentence-final word late, over the real pause (45 of 973 words in the
 * Nemotron edit), made that rule trim a real, visibly flat pause to nothing, and
 * the tool answered "no silences". When the audio and the transcript
 * disagree the audio wins: before words protect anything, [`correctWords`]
 * clamps a word to the stretch of its span that is actually voiced, and a word
 * lying wholly over measured silence protects nothing.
 *
 * **Knobs** ([`SilenceOptions`], all optional, every default keeps the
 * pre-B-327 behaviour apart from the correction above):
 * - `basis` — `vad+words` (default) | `vad` | `energy` | `energy+words`;
 *   `energy` finds silence from the waveform (RMS below a threshold), not the
 *   voice model.
 * - `thresholdDb` / `autoThreshold` (+ `autoOffsetDb`) — what counts as quiet.
 *   Auto = measured noise floor + offset; the floor is reported in the answer.
 * - `mergeGapMs` — silences split by a click/blip no longer than this are one.
 * - `padAfterMs` / `padBeforeMs` — the cushion left INSIDE each silence after
 *   the speech before it and before the speech after it; the suggested `cut`
 *   is the silence minus those cushions. `keepMs` instead says how much pause
 *   to leave in total.
 *
 * **What it does NOT do.** It runs no model, reads no store, and cuts nothing.
 * Pure and deterministic: same inputs, same ranges.
 */

import { cuttableSpans, spanToFrames, type DetectedSpan } from './recut';
import {
  SILENCE_WORD_GUARD_SECS,
  wordAwareSilences,
  type SilenceSecs,
  type WordSpanSecs,
} from './silenceWords';
import type { SilenceDetection } from './mediaUnderstandingStore';
import type { Clip } from './timeline';

export const SILENCE_BASES = ['vad+words', 'vad', 'energy', 'energy+words'] as const;
export type SilenceBasis = (typeof SILENCE_BASES)[number];

/** Energy-basis threshold when neither `threshold_db` nor `auto_threshold` is
 *  given: the level the owner's B-327 workaround measured the pause against. */
export const DEFAULT_ENERGY_THRESHOLD_DB = -30;
/** Auto threshold = noise floor + this. Room tone sits at the floor; speech
 *  tails stay well above floor + 12 dB. */
export const DEFAULT_AUTO_OFFSET_DB = 12;
/** The auto threshold never goes below this: a digitally clean recording's
 *  floor (−80 dB and lower) would otherwise make dither noise "voiced". */
export const AUTO_THRESHOLD_MIN_DB = -60;
/** A silence split by a click or blip of at most this is one silence. */
export const DEFAULT_MERGE_GAP_MS = 120;
/** The noise floor is this quantile of the envelope: room tone is the quietest
 *  common state of a voiceover, and a quantile ignores both a few digital-zero
 *  frames and the speech above. */
export const NOISE_FLOOR_QUANTILE = 0.1;
/** A word edge is only clamped when at least this much of it is unvoiced —
 *  one 20 ms frame of soft consonant is not a mistimed word. */
export const WORD_CORRECT_MIN_SECS = 0.06;
/** With `keepMs` and no pads, the share of the kept pause that goes AFTER the
 *  preceding speech (soft tails need more room than sharp onsets — the
 *  0.22 s / 0.10 s cushion of the B-327 workaround). */
export const KEEP_SHARE_AFTER = 2 / 3;

export interface SilenceOptions {
  basis: SilenceBasis;
  /** Explicit quiet level in dBFS (e.g. −30). */
  thresholdDb?: number;
  /** Derive the level from the measured noise floor + `autoOffsetDb`. */
  autoThreshold: boolean;
  autoOffsetDb: number;
  mergeGapMs: number;
  /** Cushion kept at the END of each silence (just before the next speech). */
  padBeforeMs: number;
  /** Cushion kept at the START of each silence (just after the last speech). */
  padAfterMs: number;
  /** Total pause to leave in each silence; the pads then only set the split. */
  keepMs?: number;
}

export const DEFAULT_SILENCE_OPTIONS: SilenceOptions = {
  basis: 'vad+words',
  autoThreshold: false,
  autoOffsetDb: DEFAULT_AUTO_OFFSET_DB,
  mergeGapMs: DEFAULT_MERGE_GAP_MS,
  padBeforeMs: 0,
  padAfterMs: 0,
};

/** Validate the optional silence knobs of an op call. Shared by the single-clip
 *  op, the sweep and the status twins so all of them read an argument the same
 *  way. */
export function parseSilenceOptions(
  a: Readonly<Record<string, unknown>> | undefined,
): { error: string } | { options: SilenceOptions } {
  const o: SilenceOptions = { ...DEFAULT_SILENCE_OPTIONS };

  if (a?.basis !== undefined && a.basis !== null) {
    if (!(SILENCE_BASES as readonly unknown[]).includes(a.basis)) {
      return { error: `basis must be one of ${SILENCE_BASES.join(' | ')}` };
    }
    o.basis = a.basis as SilenceBasis;
  }

  const read = (key: string, min: number, max: number): number | undefined | { error: string } => {
    const v = a?.[key];
    if (v === undefined || v === null) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) return { error: `${key} must be a finite number` };
    if (n < min || n > max) return { error: `${key} must be between ${min} and ${max}` };
    return n;
  };
  const knobs: Array<[keyof SilenceOptions & string, number, number]> = [
    ['thresholdDb', -120, 0],
    ['autoOffsetDb', 0, 60],
    ['mergeGapMs', 0, 10_000],
    ['padBeforeMs', 0, 60_000],
    ['padAfterMs', 0, 60_000],
    ['keepMs', 0, 60_000],
  ];
  for (const [key, min, max] of knobs) {
    const v = read(key, min, max);
    if (v === undefined) continue;
    if (typeof v === 'object') return v;
    (o as unknown as Record<string, number>)[key] = v;
  }
  if (a?.autoThreshold !== undefined && a.autoThreshold !== null) o.autoThreshold = a.autoThreshold === true;
  if (o.autoThreshold && o.thresholdDb !== undefined) {
    return { error: 'give thresholdDb or autoThreshold, not both' };
  }
  return { options: o };
}

/** The `NOISE_FLOOR_QUANTILE` level of the envelope in dBFS — the measured
 *  room tone. `null` for an empty envelope. */
export function noiseFloorDb(db: readonly number[]): number | null {
  if (db.length === 0) return null;
  const sorted = [...db].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * NOISE_FLOOR_QUANTILE))];
}

type Range = { start: number; end: number };
type Envelope = SilenceDetection['energy'];

/** Union of ranges separated by at most `gapSecs`. */
function mergeRanges(ranges: readonly Range[], gapSecs: number): Range[] {
  const sorted = [...ranges].sort((x, y) => x.start - y.start);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start - last.end <= gapSecs + 1e-9) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** Maximal runs of envelope frames quieter than `thresholdDb` (no minimum
 *  length: the caller merges across blips first). */
export function quietRuns(env: Envelope, thresholdDb: number): Range[] {
  const runs: Range[] = [];
  let from = -1;
  env.db.forEach((d, i) => {
    if (d < thresholdDb) {
      if (from < 0) from = i;
    } else if (from >= 0) {
      runs.push({ start: env.start_secs + from * env.hop_secs, end: env.start_secs + i * env.hop_secs });
      from = -1;
    }
  });
  if (from >= 0) {
    runs.push({
      start: env.start_secs + from * env.hop_secs,
      end: env.start_secs + env.db.length * env.hop_secs,
    });
  }
  return runs;
}

export interface WordCorrection {
  original: WordSpanSecs;
  /** The voiced part of the word, or `null` when none of it is voiced (the
   *  word sits wholly over silence and protects nothing). */
  corrected: WordSpanSecs | null;
}

/**
 * Audio is the authority: clamp each word to the part of its span the
 * waveform shows as voiced (level at or above `thresholdDb`). Only the word's
 * EDGES move — an unvoiced run of at least [`WORD_CORRECT_MIN_SECS`] at its
 * start or end is cut off; a dip inside a word (a stop consonant) is left alone.
 * A word with no voiced frame at all is dropped. Words outside the envelope are
 * untouched. Returns the surviving words and the corrections that changed
 * something.
 */
export function correctWords(
  words: readonly WordSpanSecs[],
  env: Envelope,
  thresholdDb: number,
): { words: WordSpanSecs[]; corrections: WordCorrection[] } {
  const { hop_secs: hop, start_secs: t0, db } = env;
  const out: WordSpanSecs[] = [];
  const corrections: WordCorrection[] = [];
  for (const w of words) {
    if (!(Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start)) continue;
    const i0 = Math.max(0, Math.floor((w.start - t0) / hop + 1e-9));
    const i1 = Math.min(db.length, Math.ceil((w.end - t0) / hop - 1e-9));
    if (i1 <= i0) {
      out.push(w);
      continue;
    }
    let first = -1;
    let last = -1;
    for (let i = i0; i < i1; i++) {
      if (db[i] >= thresholdDb) {
        if (first < 0) first = i;
        last = i;
      }
    }
    if (first < 0) {
      corrections.push({ original: w, corrected: null });
      continue;
    }
    const start = (first - i0) * hop >= WORD_CORRECT_MIN_SECS ? Math.max(w.start, t0 + first * hop) : w.start;
    const end = (i1 - 1 - last) * hop >= WORD_CORRECT_MIN_SECS ? Math.min(w.end, t0 + (last + 1) * hop) : w.end;
    const corrected = { start, end };
    if (start !== w.start || end !== w.end) corrections.push({ original: w, corrected });
    out.push(corrected);
  }
  return { words: out, corrections };
}

/** Where to cut inside the silence `[start, end]` given the cushions, or `null`
 *  when the cushions leave nothing. */
export function cutRange(start: number, end: number, o: SilenceOptions): Range | null {
  let after = o.padAfterMs / 1000;
  let before = o.padBeforeMs / 1000;
  if (o.keepMs !== undefined) {
    const keep = o.keepMs / 1000;
    const total = o.padAfterMs + o.padBeforeMs;
    after = keep * (total > 0 ? o.padAfterMs / total : KEEP_SHARE_AFTER);
    before = keep - after;
  }
  const s = start + after;
  const e = end - before;
  return e - s > 1e-6 ? { start: s, end: e } : null;
}

export interface ResolvedSilence {
  /** The silence, word-safe (what pre-B-327 callers read as THE range). */
  startSecs: number;
  endSecs: number;
  /** As measured, before words trimmed it. */
  rawStartSecs: number;
  rawEndSecs: number;
  /** Suggested cut: the silence minus the cushions; `null` if they eat it. */
  cut: Range | null;
  /** A transcribed word overlapping this silence was corrected by the audio. */
  wordCorrected: boolean;
}

export interface ResolvedSilences {
  silences: ResolvedSilence[];
  /** What was actually used: a `+words` basis degrades when there is no transcript. */
  basis: SilenceBasis;
  requestedBasis: SilenceBasis;
  wordAware: boolean;
  /** Silences the base detector found (after merging), before word trimming. */
  baseSilences: number;
  trimmedForWords: number;
  droppedForWords: number;
  /** Words whose span the audio changed (clamped or dropped). */
  correctedWords: number;
  noiseFloorDb: number | null;
  /** The level used (energy detection or word correction); absent for plain `vad`. */
  thresholdDb?: number;
  thresholdSource?: 'threshold_db' | 'auto' | 'default';
  wordGuardSecs: number;
}

/** The whole pipeline: base detector → merge → min length → audio-corrected
 *  word protection → cushions. See the module header. */
export function resolveSilences(
  detection: SilenceDetection,
  words: readonly WordSpanSecs[] | null,
  minSilenceMs: number,
  options: SilenceOptions,
): { error: string } | ResolvedSilences {
  const requestedBasis = options.basis;
  const energyBased = requestedBasis.startsWith('energy');
  const env: Envelope | undefined = detection.energy;
  const haveEnv = !!env && env.db.length > 0;
  if (energyBased && !haveEnv) {
    return { error: 'no loudness data for this clip (re-run the detection with force)' };
  }

  const floor = haveEnv ? noiseFloorDb(env.db) : null;
  let thresholdDb: number | undefined;
  let thresholdSource: ResolvedSilences['thresholdSource'];
  if (options.thresholdDb !== undefined) {
    thresholdDb = options.thresholdDb;
    thresholdSource = 'threshold_db';
  } else if (options.autoThreshold || !energyBased) {
    // Word correction without an explicit level always derives it from the
    // room tone; an energy detection does so only when asked.
    if (floor !== null) {
      thresholdDb = Math.max(floor + options.autoOffsetDb, AUTO_THRESHOLD_MIN_DB);
      thresholdSource = 'auto';
    }
  } else {
    thresholdDb = DEFAULT_ENERGY_THRESHOLD_DB;
    thresholdSource = 'default';
  }

  const minSecs = minSilenceMs / 1000;
  const base: Range[] =
    energyBased && haveEnv
      ? quietRuns(env, thresholdDb ?? DEFAULT_ENERGY_THRESHOLD_DB)
      : detection.silences.map((s) => ({ start: s.start_secs, end: s.end_secs }));
  const baseSilences: SilenceSecs[] = mergeRanges(base, options.mergeGapMs / 1000)
    .filter((r) => r.end - r.start >= minSecs)
    .map((r) => ({ start_secs: r.start, end_secs: r.end, duration_secs: r.end - r.start }));

  const useWords = requestedBasis.endsWith('+words') && words !== null;
  let corrections: WordCorrection[] = [];
  let pieces: SilenceSecs[] = baseSilences;
  let trimmed = 0;
  let dropped = 0;
  if (useWords) {
    let protect: readonly WordSpanSecs[] = words;
    if (haveEnv && thresholdDb !== undefined) {
      const c = correctWords(words, env, thresholdDb);
      protect = c.words;
      corrections = c.corrections;
    }
    const aware = wordAwareSilences(baseSilences, protect, minSecs);
    pieces = aware.silences;
    trimmed = aware.trimmed;
    dropped = aware.dropped;
  }

  const silences = pieces.map<ResolvedSilence>((p) => {
    const rawStart = p.raw_start_secs ?? p.start_secs;
    const rawEnd = p.raw_end_secs ?? p.end_secs;
    return {
      startSecs: p.start_secs,
      endSecs: p.end_secs,
      rawStartSecs: rawStart,
      rawEndSecs: rawEnd,
      cut: cutRange(p.start_secs, p.end_secs, options),
      wordCorrected: corrections.some((c) => c.original.start < rawEnd && c.original.end > rawStart),
    };
  });

  return {
    silences,
    basis: useWords ? requestedBasis : energyBased ? 'energy' : 'vad',
    requestedBasis,
    wordAware: useWords,
    baseSilences: baseSilences.length,
    trimmedForWords: trimmed,
    droppedForWords: dropped,
    correctedWords: corrections.length,
    noiseFloorDb: floor,
    ...(thresholdDb !== undefined && (energyBased || useWords) ? { thresholdDb, thresholdSource } : {}),
    wordGuardSecs: SILENCE_WORD_GUARD_SECS,
  };
}

/** One silence in every coordinate system a caller needs. `startSecs`…`endFrame`
 *  are the word-safe range (the pre-B-327 meaning); `cut` is what to delete. */
export interface FramedSilence extends DetectedSpan {
  rawStartSecs: number;
  rawEndSecs: number;
  basis: SilenceBasis;
  wordCorrected: boolean;
  cut: DetectedSpan | null;
}

/** Convert a resolved answer to the clip's source / timeline frames, dropping
 *  silences (and cuts) that round to nothing. */
export function framedSilences(c: Clip, fps: number, r: ResolvedSilences): FramedSilence[] {
  return r.silences
    .map((s) => {
      const range = spanToFrames(c, s.startSecs, s.endSecs, fps);
      const cut = s.cut ? (cuttableSpans([spanToFrames(c, s.cut.start, s.cut.end, fps)])[0] ?? null) : null;
      return {
        ...range,
        rawStartSecs: s.rawStartSecs,
        rawEndSecs: s.rawEndSecs,
        basis: r.basis,
        wordCorrected: s.wordCorrected,
        cut,
      };
    })
    .filter((s) => s.endFrame > s.startFrame);
}
