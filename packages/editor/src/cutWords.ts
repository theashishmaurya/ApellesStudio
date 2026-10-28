/**
 * `@apelles/editor` — the cut planner behind "edit by text": word ranges of a
 * track's word view in, the exact timeline frames to ripple-delete out (D-420,
 * roadmap 0l).
 *
 * **What it is.** A pure function over the word view `editor_get_word_transcript`
 * serves (`retakeWordView.ts`'s `WordViewInput` + the view's words): given the
 * word-index ranges to delete, it decides where each cut starts and ends, and —
 * when asked — which pauses between the words that stay are tightened to a
 * breath. `editor_cut_words` and the Index panel's transcript (select words,
 * Delete) both call it, then apply the result as ONE `ripple_delete_ranges` op,
 * so the human and the agent cut identically.
 *
 * **Why a planner, and why these rules.** Editing the owner's "Five Levels"
 * voiceover by text was done with throwaway scripts, and their padding left 16
 * fragments of deleted words that had to be found and cut again (roadmap 0l).
 * A word's edges are only trustworthy to within one Parakeet token, so a cut has
 * to reach PAST them — and must never reach into a word that stays. The rules:
 *
 * - **A deleted word is always wholly inside a cut.** Each edge is padded away
 *   from the deleted words by up to [`CUT_PAD_MAX_SECS`] (one maximum-length
 *   Parakeet token — the retake gate's `EDGE_PAD_MAX_SECS`, D-380, for the same
 *   reason), and then snapped to a frame at or beyond the word's own edge.
 * - **A kept word is never touched.** Toward a kept neighbour the pad stops at
 *   the middle of the gap between them, and the snapped frame is held at or
 *   beyond the kept word's edge. When the gap between a kept and a deleted word
 *   is shorter than one frame there is no frame that honours both; the edge goes
 *   to the middle of the gap and the word is reported in `tight`.
 * - **Deleted neighbours are one cut.** A run of deleted words is cut from the
 *   first's onset to the last's release, the pauses between them included —
 *   the "fragment" failure was cutting each word on its own and leaving the
 *   slivers between them. A run that reaches a clip boundary while the next
 *   word in play order (in the next clip) is also deleted is cut to that
 *   boundary, so a range spanning clips leaves nothing between its halves.
 * - **Tightening is optional and only ever removes silence.** With
 *   `tightenGapsSecs`, every pause between two KEPT words that is still longer
 *   than that after the word cuts is cut down to `keepBreathSecs`, half kept
 *   after the earlier word and half before the later one. A pause across a clip
 *   boundary is tightened in both clips; a pause with a whole wordless clip in
 *   it is left alone (that clip is not silence this op can judge).
 *
 * **What it does NOT do.** No store, no I/O, no React, nothing applied. It does
 * not judge which words are fillers (`fillers.ts` suggests; a person or the MCP
 * client decides), and it does not cut a sync-locked partner track itself — the
 * `ripple_delete_ranges` op it feeds already carries linked and sync-locked
 * partners (D-129, D-106).
 */

import { spanToFrames, clipSourceRate } from './recut';
import type { ViewWord, WordViewInput } from './retakeWordView';

/** How far a cut edge reaches past a deleted word, at most: one maximum-length
 *  Parakeet TDT token (5 frames × 0.08 s). The same value and reasoning as
 *  `apelles_speech::proposal::EDGE_PAD_MAX_SECS` (D-376/D-380) — a word edge is
 *  only trustworthy to within one token. */
export const CUT_PAD_MAX_SECS = 0.32;

/** The pause kept between two words when tightening, by default: 0.3 s, 0.15 s
 *  either side — more than the 0.125 s word guard silence detection keeps
 *  (`SILENCE_WORD_GUARD_SECS`, B-289), so a tightened join never clips a soft
 *  word ending, and short enough to read as one breath. */
export const DEFAULT_KEEP_BREATH_SECS = 0.3;

/** Two float times this close are the same instant (transcript times are
 *  two-decimal model output). */
const EPS = 1e-6;

export interface WordRange {
  first: number;
  last: number;
}

export interface CutWordsOptions {
  /** Tighten every pause between kept words longer than this (seconds). */
  tightenGapsSecs?: number | null;
  /** What a tightened pause is cut down to (seconds). */
  keepBreathSecs?: number;
}

/** One cut, in the clip it lies in, before anything moves. */
export interface PlannedCut {
  /** Index into `input.pieces`. */
  piece: number;
  /** The clip on the track (index and stable id). */
  clip: number;
  clipId: string;
  /** Source seconds actually cut (after frame snapping). */
  startSecs: number;
  endSecs: number;
  /** Timeline frames, half-open, as the timeline is NOW. */
  startFrame: number;
  endFrame: number;
  /** The view indices of the deleted words this cut removes. */
  words: number[];
  /** `words` — only deleted words and the pauses between them; `gap` — only a
   *  tightened pause; `words+gap` — both, merged. */
  kind: 'words' | 'gap' | 'words+gap';
}

export interface CutWordsPlan {
  cuts: PlannedCut[];
  /** Every deleted view index, ascending. */
  deleted: number[];
  /** Pauses between kept words that were tightened. */
  tightened: number;
  /** Deleted words whose gap to a kept neighbour is under one frame: the cut
   *  edge there is the middle of the gap, so a sliver of one of the two may be
   *  cut or left. Listen at these. */
  tight: Array<{ index: number; side: 'start' | 'end' }>;
  /** Deleted words too short to hold one whole frame of their clip — nothing
   *  could be cut for them. */
  uncut: number[];
}

interface Interval {
  start: number;
  end: number;
  words: number[];
  gap: boolean;
}

/** Validate and flatten the ranges into a sorted set of view indices. An empty
 *  list is valid (a tightening-only pass); the planner decides whether that
 *  leaves anything to do. */
export function deletedIndices(ranges: readonly WordRange[], total: number): number[] | { error: string } {
  if (!Array.isArray(ranges)) {
    return { error: 'ranges must be an array of {first, last} word indices' };
  }
  const out = new Set<number>();
  for (const r of ranges) {
    const first = Number(r?.first);
    const last = Number(r?.last);
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first) {
      return { error: `range ${JSON.stringify(r)} is not {first, last} word indices with 0 <= first <= last` };
    }
    if (last >= total) return { error: `word ${last} is past the end of the view (${total} words)` };
    for (let i = first; i <= last; i += 1) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The plan for deleting `ranges` (inclusive word-index ranges of the view) and,
 * optionally, tightening the pauses left between the words that stay.
 */
export function planCutWords(
  input: WordViewInput,
  words: readonly ViewWord[],
  ranges: readonly WordRange[],
  options: CutWordsOptions = {},
): CutWordsPlan | { error: string } {
  const flat = deletedIndices(ranges, words.length);
  if ('error' in flat) return flat;
  const deleted = new Set(flat);
  const tighten = options.tightenGapsSecs ?? null;
  const breath = options.keepBreathSecs ?? DEFAULT_KEEP_BREATH_SECS;
  if (flat.length === 0 && tighten === null) {
    return { error: 'nothing asked for — give word ranges to delete, tighten_gaps_ms to tighten pauses, or both' };
  }
  if (tighten !== null && !(Number.isFinite(tighten) && tighten > 0)) {
    return { error: 'tighten_gaps_ms must be a positive number of milliseconds' };
  }
  if (!(Number.isFinite(breath) && breath >= 0)) {
    return { error: 'keep_breath_ms must be zero or a positive number of milliseconds' };
  }
  if (tighten !== null && breath > tighten) {
    return { error: 'keep_breath_ms must not exceed tighten_gaps_ms — a tightened pause cannot be longer than the threshold' };
  }

  // Each piece's words, in view (= play) order.
  const byPiece = new Map<number, number[]>();
  words.forEach((w, i) => {
    const list = byPiece.get(w.piece);
    if (list) list.push(i);
    else byPiece.set(w.piece, [i]);
  });

  const intervals = new Map<number, Interval[]>();
  const add = (piece: number, iv: Interval) => {
    if (iv.end - iv.start <= EPS) return;
    const list = intervals.get(piece);
    if (list) list.push(iv);
    else intervals.set(piece, [iv]);
  };

  // 1. Runs of deleted words.
  for (const [piece, list] of byPiece) {
    const p = input.pieces[piece];
    if (!p) continue;
    for (let a = 0; a < list.length; a += 1) {
      if (!deleted.has(list[a])) continue;
      let b = a;
      while (b + 1 < list.length && deleted.has(list[b + 1])) b += 1;
      const firstIdx = list[a];
      const lastIdx = list[b];
      const first = words[firstIdx];
      const last = words[lastIdx];
      const run = list.slice(a, b + 1);

      let start: number;
      if (a > 0) {
        const prev = words[list[a - 1]];
        start = first.start - Math.min(CUT_PAD_MAX_SECS, Math.max(0, first.start - prev.end) / 2);
      } else if (firstIdx > 0 && deleted.has(firstIdx - 1) && words[firstIdx - 1].piece !== piece) {
        start = p.startSecs; // a range continuing from the previous clip
      } else {
        start = Math.max(p.startSecs, first.start - CUT_PAD_MAX_SECS);
      }

      let end: number;
      if (b + 1 < list.length) {
        const next = words[list[b + 1]];
        end = last.end + Math.min(CUT_PAD_MAX_SECS, Math.max(0, next.start - last.end) / 2);
      } else if (lastIdx + 1 < words.length && deleted.has(lastIdx + 1) && words[lastIdx + 1].piece !== piece) {
        end = p.endSecs; // a range continuing into the next clip
      } else {
        end = Math.min(p.endSecs, last.end + CUT_PAD_MAX_SECS);
      }
      add(piece, { start, end, words: run, gap: false });
      a = b;
    }
  }

  // 2. Tightening, measured against what the word cuts already removed.
  let tightened = 0;
  if (tighten !== null) {
    const kept = words.map((_, i) => i).filter((i) => !deleted.has(i));
    const half = breath / 2;
    for (let k = 0; k + 1 < kept.length; k += 1) {
      const w1 = words[kept[k]];
      const w2 = words[kept[k + 1]];
      if (w1.piece === w2.piece) {
        const region = { start: w1.end, end: w2.start };
        if (region.end - region.start <= breath + EPS) continue;
        const remaining = uncovered(region, intervals.get(w1.piece) ?? []);
        if (remaining <= tighten + EPS) continue;
        add(w1.piece, { start: region.start + half, end: region.end - half, words: [], gap: true });
        tightened += 1;
        continue;
      }
      // Across a clip boundary: only between ADJACENT pieces of the view.
      if (w2.piece !== w1.piece + 1) continue;
      const p1 = input.pieces[w1.piece];
      const p2 = input.pieces[w2.piece];
      if (!p1 || !p2) continue;
      const tail = { start: w1.end, end: p1.endSecs };
      const head = { start: p2.startSecs, end: w2.start };
      const remaining =
        uncovered(tail, intervals.get(w1.piece) ?? []) + uncovered(head, intervals.get(w2.piece) ?? []);
      if (remaining <= tighten + EPS) continue;
      add(w1.piece, { start: tail.start + half, end: tail.end, words: [], gap: true });
      add(w2.piece, { start: head.start, end: head.end - half, words: [], gap: true });
      tightened += 1;
    }
  }

  // 3. Merge per piece, snap to frames with the protections, collect.
  const cuts: PlannedCut[] = [];
  const tight: CutWordsPlan['tight'] = [];
  const uncut: number[] = [];
  for (const [piece, list] of intervals) {
    const p = input.pieces[piece];
    const pieceWords = byPiece.get(piece) ?? [];
    for (const iv of mergeIntervals(list)) {
      const snapped = snap(input, words, pieceWords, deleted, piece, iv, tight);
      const span = spanToFrames(p.c, snapped.start, snapped.end, input.fps);
      if (span.endFrame <= span.startFrame) {
        uncut.push(...iv.words);
        continue;
      }
      cuts.push({
        piece,
        clip: p.clip,
        clipId: p.clipId,
        startSecs: span.sourceStartFrame / clipSourceRate(p.c, input.fps),
        endSecs: span.sourceEndFrame / clipSourceRate(p.c, input.fps),
        startFrame: span.startFrame,
        endFrame: span.endFrame,
        words: iv.words,
        kind: iv.words.length === 0 ? 'gap' : iv.gap ? 'words+gap' : 'words',
      });
    }
  }
  cuts.sort((x, y) => x.startFrame - y.startFrame || x.endFrame - y.endFrame);
  return { cuts, deleted: flat, tightened, tight, uncut };
}

/** A word picked somewhere other than the view — the Index panel's transcript,
 *  which lists words per timeline row: the clip it plays in and its source
 *  seconds. */
export interface WordPick {
  clipId: string;
  sourceStart: number;
  sourceEnd: number;
}

/** The view indices of `picks` (a pick matches the view word in the same clip
 *  with the same source span), and how many picks matched no view word. */
export function viewIndicesOf(
  input: WordViewInput,
  words: readonly ViewWord[],
  picks: readonly WordPick[],
): { indices: number[]; missing: number } {
  const found = new Set<number>();
  let missing = 0;
  for (const pick of picks) {
    const i = words.findIndex(
      (w) =>
        input.pieces[w.piece]?.clipId === pick.clipId &&
        Math.abs(w.start - pick.sourceStart) < EPS &&
        Math.abs(w.end - pick.sourceEnd) < EPS,
    );
    if (i < 0) missing += 1;
    else found.add(i);
  }
  return { indices: [...found].sort((a, b) => a - b), missing };
}

/** Sorted, distinct indices as the fewest inclusive ranges. */
export function rangesOf(indices: readonly number[]): WordRange[] {
  const out: WordRange[] = [];
  for (const i of [...new Set(indices)].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && i === last.last + 1) last.last = i;
    else out.push({ first: i, last: i });
  }
  return out;
}

/** How much of `region` no interval covers. */
function uncovered(region: { start: number; end: number }, list: readonly Interval[]): number {
  let covered = 0;
  for (const iv of mergeIntervals(list)) {
    const s = Math.max(region.start, iv.start);
    const e = Math.min(region.end, iv.end);
    if (e > s) covered += e - s;
  }
  return Math.max(0, region.end - region.start - covered);
}

function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end + EPS) {
      last.end = Math.max(last.end, iv.end);
      last.words = [...last.words, ...iv.words].sort((a, b) => a - b);
      last.gap = last.gap || iv.gap;
    } else {
      out.push({ ...iv, words: [...iv.words] });
    }
  }
  return out;
}

/**
 * The interval's edges in source seconds, snapped to whole source frames so
 * that every deleted word inside is wholly cut and no kept word outside is
 * touched — or, when a gap is under a frame, the middle of it (reported).
 */
function snap(
  input: WordViewInput,
  words: readonly ViewWord[],
  pieceWords: readonly number[],
  deleted: ReadonlySet<number>,
  piece: number,
  iv: Interval,
  tight: CutWordsPlan['tight'],
): { start: number; end: number } {
  const p = input.pieces[piece];
  const rate = clipSourceRate(p.c, input.fps);
  const clipLo = p.c.source_start;
  const clipHi = p.c.source_start + p.c.duration;

  // The kept words either side of the interval, and the deleted words inside.
  let keptBefore: ViewWord | null = null;
  let keptAfter: ViewWord | null = null;
  let firstDeleted: { index: number; w: ViewWord } | null = null;
  let lastDeleted: { index: number; w: ViewWord } | null = null;
  for (const i of pieceWords) {
    const w = words[i];
    if (deleted.has(i) && w.end > iv.start - EPS && w.start < iv.end + EPS) {
      if (!firstDeleted) firstDeleted = { index: i, w };
      lastDeleted = { index: i, w };
    } else if (!deleted.has(i)) {
      if (w.end <= iv.start + EPS) keptBefore = w;
      else if (w.start >= iv.end - EPS && !keptAfter) keptAfter = w;
    }
  }

  let s = Math.round(iv.start * rate);
  const lo = keptBefore ? Math.ceil(keptBefore.end * rate - EPS) : clipLo;
  const mustStart = firstDeleted ? Math.floor(firstDeleted.w.start * rate + EPS) : Number.POSITIVE_INFINITY;
  if (lo <= mustStart) {
    s = Math.min(Math.max(s, lo), mustStart);
  } else if (keptBefore && firstDeleted) {
    s = Math.round(((keptBefore.end + firstDeleted.w.start) / 2) * rate);
    tight.push({ index: firstDeleted.index, side: 'start' });
  }

  let e = Math.round(iv.end * rate);
  const hi = keptAfter ? Math.floor(keptAfter.start * rate + EPS) : clipHi;
  const mustEnd = lastDeleted ? Math.ceil(lastDeleted.w.end * rate - EPS) : Number.NEGATIVE_INFINITY;
  if (mustEnd <= hi) {
    e = Math.max(Math.min(e, hi), mustEnd);
  } else if (keptAfter && lastDeleted) {
    e = Math.round(((lastDeleted.w.end + keptAfter.start) / 2) * rate);
    tight.push({ index: lastDeleted.index, side: 'end' });
  }

  s = Math.min(Math.max(s, clipLo), clipHi);
  e = Math.min(Math.max(e, s), clipHi);
  return { start: s / rate, end: e / rate };
}
