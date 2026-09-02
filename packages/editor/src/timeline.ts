/**
 * @chroma/editor — the edit model, mirrored from the `chroma-timeline` Rust
 * crate (D-041), plus pure edit ops for optimistic UI updates.
 *
 * The Rust `chroma_timeline_set` command stores whatever we send verbatim (no
 * server-side clamping), so these ops are authoritative for what lands on disk.
 * They mirror `chroma-timeline`'s clamp rules; a `chroma_timeline_get` refetch
 * after each save reconciles anything (e.g. a source frame count that only the
 * backend knows).
 *
 * D-045 (multiple named timelines): a project can now hold several
 * `Timeline`s with one active — `Timeline.id` (below) is how they're told
 * apart. That selection is a Rust-side concept this pass (`ProjectManifest.
 * active_timeline` in `app/src-tauri/src/chroma/project.rs`): `chroma_timeline_
 * get`/`_set`/`_frame` are unchanged here, they just transparently target
 * whichever timeline is active. No timeline-switcher UI yet (pass 3).
 *
 * D-051: `labelForOp` turns an `EditOp` into the human-readable label
 * `useEditorTimelineStore.applyOp` puts on the `@chroma/history` entry it
 * pushes for every op — kept here (pure, testable) rather than inline in the
 * store.
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
  /** Stable id (D-045) — distinguishes this timeline among a project's others. */
  id: string;
  name: string;
  rate?: Rational | null;
  tracks: Track[];
}

export const DEFAULT_FPS = 24;

/**
 * D-046 pass 3 — the `dataTransfer` MIME type a Sources-panel pool item drag
 * carries (`DraggedMedia` JSON), and `TimelinePane`'s drop handler reads. A
 * plain string constant rather than a shared type-only contract because HTML5
 * drag/drop crosses a package boundary the D-039 layer direction forbids a
 * shared `DndContext`/store from crossing (see `TimelinePane`'s doc).
 */
export const CHROMA_MEDIA_DRAG_MIME = 'application/x-chroma-media';

/** What a Sources-panel drag carries — just enough to build a full-length
 *  `Clip` on drop; `frameCount`/`fps` absent (unprobed or offline media)
 *  means the drop is rejected rather than adding a zero-length clip. */
export interface DraggedMedia {
  id: string;
  sourcePath: string;
  name: string;
  frameCount?: number | null;
}

/** Build a full-length `Clip` referencing a dropped pool item, or `null` if
 *  it has no known frame count (unprobed / offline — nothing to place). */
export function clipFromDraggedMedia(media: DraggedMedia): Clip | null {
  const frames = media.frameCount ?? 0;
  if (!frames || frames <= 0) return null;
  return {
    id: `${media.id}-${Date.now().toString(36)}`,
    shot_id: null,
    name: media.name,
    source_path: media.sourcePath,
    source_start: 0,
    duration: frames,
    source_len: frames,
  };
}

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
  | { kind: 'remove'; track: number; clip: number }
  /** D-046 pass 3 — drag a Sources-panel pool item onto the timeline. Appends
   *  a full-length clip referencing the media (or inserts at `atIndex`). If
   *  `track` doesn't exist yet (a brand new timeline has `tracks: []` — see
   *  `chroma_timeline_create`), a video track is created to hold it. */
  | { kind: 'add_clip'; track: number; clip: Clip; atIndex?: number };

/** Clip name at `track`/`clip` in `tl`, or a short fallback — for history
 *  labels (D-051) only, never used in the actual edit logic below. */
function clipLabel(tl: Timeline, track: number, clip: number): string {
  const name = tl.tracks[track]?.clips[clip]?.name;
  return name ? `"${name}"` : 'clip';
}

/** Human-readable one-liner for an `EditOp`, evaluated against the timeline
 *  it's about to be applied to (`before`) — used as the `label` on the
 *  `@chroma/history` entry `useEditorTimelineStore.applyOp` pushes for every
 *  op (D-051). Pure and separately testable; not used by `applyOp` itself. */
export function labelForOp(op: EditOp, before: Timeline): string {
  switch (op.kind) {
    case 'reorder':
      return `Reorder ${clipLabel(before, op.track, op.from)}`;
    case 'trim_start':
      return `Trim ${clipLabel(before, op.track, op.clip)} (start)`;
    case 'trim_end':
      return `Trim ${clipLabel(before, op.track, op.clip)} (end)`;
    case 'split':
      return `Split ${clipLabel(before, op.track, op.clip)}`;
    case 'remove':
      return `Remove ${clipLabel(before, op.track, op.clip)}`;
    case 'add_clip':
      return `Add "${op.clip.name}"`;
    default:
      return 'Edit timeline';
  }
}

export function applyOp(tl: Timeline, op: EditOp): Timeline {
  if (op.kind === 'add_clip') {
    const next = clone(tl);
    if (next.tracks.length === 0) next.tracks.push({ kind: 'video', clips: [] });
    const trackIdx = op.track < next.tracks.length ? op.track : 0;
    const clips = next.tracks[trackIdx].clips;
    const at = Math.min(Math.max(op.atIndex ?? clips.length, 0), clips.length);
    clips.splice(at, 0, op.clip);
    return next;
  }

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
