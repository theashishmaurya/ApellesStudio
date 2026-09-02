/**
 * @chroma/editor — the edit model, mirrored from the `chroma-timeline` Rust
 * crate (D-041), plus pure edit ops for optimistic UI updates.
 *
 * The Rust `chroma_timeline_set` command stores whatever we send verbatim (no
 * server-side clamping), so these ops are authoritative for what lands on disk.
 * They mirror `chroma-timeline`'s clamp rules; a `chroma_timeline_get` refetch
 * after each save reconciles anything (e.g. a source frame count that only the
 * backend knows).
 */

export interface Rational {
  num: number;
  den: number;
}

/** Mirrors `chroma_timeline::Clip` (serde snake_case). */
export interface Clip {
  id: string;
  shot_id?: string | null;
  name: string;
  source_path: string;
  source_start: number;
  duration: number;
  source_len: number;
}

export interface Track {
  kind: 'video' | 'audio';
  clips: Clip[];
}

export interface Timeline {
  name: string;
  rate?: Rational | null;
  tracks: Track[];
}

export const DEFAULT_FPS = 24;

export function timelineFps(tl: Timeline | null): number {
  const r = tl?.rate;
  if (r && r.num > 0 && r.den > 0) return r.num / r.den;
  return DEFAULT_FPS;
}

export function trackDuration(tr: Track): number {
  return tr.clips.reduce((a, c) => a + c.duration, 0);
}

export function timelineDuration(tl: Timeline | null): number {
  if (!tl || tl.tracks.length === 0) return 0;
  return Math.max(0, ...tl.tracks.map(trackDuration));
}

/** First video track index, or 0. */
export function videoTrackIndex(tl: Timeline): number {
  const i = tl.tracks.findIndex((t) => t.kind === 'video');
  return i >= 0 ? i : 0;
}

/** Timeline frame at which clip `idx` starts on `tr` (clips are back to back). */
export function clipStartFrame(tr: Track, idx: number): number {
  return tr.clips.slice(0, idx).reduce((a, c) => a + c.duration, 0);
}

/** The clip covering `frame` and the source frame inside it. */
export function clipAt(tr: Track, frame: number): { clip: Clip; index: number; sourceFrame: number } | null {
  if (frame < 0) return null;
  let acc = 0;
  for (let i = 0; i < tr.clips.length; i++) {
    const c = tr.clips[i];
    if (frame < acc + c.duration) {
      return { clip: c, index: i, sourceFrame: c.source_start + (frame - acc) };
    }
    acc += c.duration;
  }
  return null;
}

// --------------------------------------------------------------------------- //
// pure edit ops — return a NEW timeline (or the same ref if the op is a no-op)
// --------------------------------------------------------------------------- //

function clone(tl: Timeline): Timeline {
  return typeof structuredClone === 'function'
    ? structuredClone(tl)
    : JSON.parse(JSON.stringify(tl));
}

export type EditOp =
  | { kind: 'reorder'; track: number; from: number; to: number }
  | { kind: 'trim_start'; track: number; clip: number; delta: number }
  | { kind: 'trim_end'; track: number; clip: number; delta: number }
  | { kind: 'split'; track: number; clip: number; atFrame: number }
  | { kind: 'remove'; track: number; clip: number };

export function applyOp(tl: Timeline, op: EditOp): Timeline {
  const tr = tl.tracks[op.track];
  if (!tr) return tl;

  switch (op.kind) {
    case 'reorder': {
      const { from, to } = op;
      if (from === to || from < 0 || to < 0 || from >= tr.clips.length || to >= tr.clips.length) return tl;
      const next = clone(tl);
      const clips = next.tracks[op.track].clips;
      const [moved] = clips.splice(from, 1);
      clips.splice(to, 0, moved);
      return next;
    }
    case 'remove': {
      if (op.clip < 0 || op.clip >= tr.clips.length) return tl;
      const next = clone(tl);
      next.tracks[op.track].clips.splice(op.clip, 1);
      return next;
    }
    case 'trim_start': {
      const c = tr.clips[op.clip];
      if (!c) return tl;
      const ceiling = Math.max(c.source_len, 0);
      const newStart = Math.min(Math.max(c.source_start + op.delta, 0), Math.max(ceiling - 1, 0));
      const newDur = c.duration - (newStart - c.source_start);
      if (newDur < 1) return tl;
      const next = clone(tl);
      const nc = next.tracks[op.track].clips[op.clip];
      nc.source_start = newStart;
      nc.duration = newDur;
      return next;
    }
    case 'trim_end': {
      const c = tr.clips[op.clip];
      if (!c) return tl;
      const maxDur = Math.max(Math.max(c.source_len, 0) - c.source_start, 1);
      const newDur = Math.min(Math.max(c.duration + op.delta, 1), maxDur);
      if (newDur === c.duration) return tl;
      const next = clone(tl);
      next.tracks[op.track].clips[op.clip].duration = newDur;
      return next;
    }
    case 'split': {
      const c = tr.clips[op.clip];
      if (!c) return tl;
      const start = clipStartFrame(tr, op.clip);
      const offset = op.atFrame - start;
      if (offset <= 0 || offset >= c.duration) return tl;
      const next = clone(tl);
      const clips = next.tracks[op.track].clips;
      const left = clips[op.clip];
      const right: Clip = {
        ...left,
        id: `${left.id}·${op.atFrame}`,
        source_start: left.source_start + offset,
        duration: left.duration - offset,
      };
      left.duration = offset;
      clips.splice(op.clip + 1, 0, right);
      return next;
    }
    default:
      return tl;
  }
}
