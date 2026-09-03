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
 *
 * D-056: `Clip.start_frame` — mirrors `chroma-timeline::Clip::start_frame`
 * (D-054). Before this, every op here still assumed the pre-D-054 world
 * (a clip's timeline position is *implicit*, the sum of every preceding
 * clip's duration — `chroma_timeline_set` stores what's sent, so this file,
 * not the Rust ops, is what actually ran for every edit made through this
 * UI). D-054 gave the crate an explicit, authoritative `start_frame` and
 * changed `trim_start`/`trim_end`'s real semantics to be gap-aware around
 * it, but nothing here was updated to match — new/modified clips were built
 * without the field at all (an absent JSON key, not a wrong value), and
 * every position was still derived from Vec order. See D-056 for the full
 * bug writeup (B-011, B-012); every op below now mirrors the Rust op of the
 * same name field-for-field (`trim_start`'s neighbor clamp, `trim_end`'s
 * neighbor clamp, `split`'s `start_frame` on the right half, `add_clip`'s
 * append-at-track-end position) so what this file computes and what
 * `chroma-timeline::lib.rs` would compute for the same input agree.
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
  /** Timeline-absolute start frame (D-054/D-056) — see the module doc. */
  start_frame: number;
}

/** A clip's exclusive timeline end frame — `chroma-timeline::Clip::end_frame`. */
export function endFrame(c: Clip): number {
  return c.start_frame + c.duration;
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

/** Every `Clip` field except `start_frame` — a dropped clip doesn't know its
 *  timeline position yet (D-056): that depends on the *target* track's
 *  current contents (append after its last clip), which only `applyOp`'s
 *  `add_clip` case knows at the moment the op is actually applied. Building
 *  a placeholder `start_frame` here (the pre-D-056 bug: simply omitting the
 *  field) is exactly what let a dropped clip land with no real position. */
export type NewClipFields = Omit<Clip, 'start_frame'>;

/** Build a full-length clip (minus `start_frame` — see `NewClipFields`)
 *  referencing a dropped pool item, or `null` if it has no known frame count
 *  (unprobed / offline — nothing to place). */
export function clipFromDraggedMedia(media: DraggedMedia): NewClipFields | null {
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

/** Length of `tr` in frames — the furthest clip end, mirroring
 *  `chroma-timeline::Track::duration` (D-054): clips may leave a trailing
 *  gap, so this is a max over `endFrame`, not a sum of durations. */
export function trackDuration(tr: Track): number {
  return tr.clips.reduce((max, c) => Math.max(max, endFrame(c)), 0);
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

/** Where a new clip appended to `tr` should start — right after the
 *  furthest-out clip already on it (0 for an empty track). Mirrors what
 *  `backfill_legacy_positions` reconstructs for a legacy back-to-back track,
 *  but computed directly rather than relying on that migration path (see
 *  D-056 — that reliance was the drag-and-drop bug). */
export function nextAppendFrame(tr: Track): number {
  return trackDuration(tr);
}

/** The clip covering `frame` (by its real `start_frame`, D-054/D-056 — Vec
 *  order is bookkeeping only, never assumed to match position order) and
 *  the source frame inside it. Mirrors `chroma-timeline::Track::clip_at`. */
export function clipAt(tr: Track, frame: number): { clip: Clip; index: number; sourceFrame: number } | null {
  if (frame < 0) return null;
  for (let i = 0; i < tr.clips.length; i++) {
    const c = tr.clips[i];
    if (frame >= c.start_frame && frame < endFrame(c)) {
      return { clip: c, index: i, sourceFrame: c.source_start + (frame - c.start_frame) };
    }
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
  /** Vec **storage order** only (D-054) — does not move the clip in time.
   *  Kept for API completeness / bookkeeping; the timeline UI's clip-body
   *  drag uses `move`, below, not this. */
  | { kind: 'reorder'; track: number; from: number; to: number }
  | { kind: 'trim_start'; track: number; clip: number; delta: number }
  | { kind: 'trim_end'; track: number; clip: number; delta: number }
  | { kind: 'split'; track: number; clip: number; atFrame: number }
  | { kind: 'remove'; track: number; clip: number }
  /** D-046 pass 3 — drag a Sources-panel pool item onto the timeline. Appends
   *  a full-length clip referencing the media (or inserts at `atIndex`). If
   *  `track` doesn't exist yet (a brand new timeline has `tracks: []` — see
   *  `chroma_timeline_create`), a video track is created to hold it.
   *  `start_frame` (D-056) is computed by `applyOp` itself — always the end
   *  of whatever's already on the target track, i.e. a plain append. */
  | { kind: 'add_clip'; track: number; clip: NewClipFields; atIndex?: number }
  /** D-056 — reposition a clip in time (the timeline UI's clip-body drag).
   *  Mirrors `chroma-timeline::Timeline::move_clip`'s same-track case:
   *  rejected (no-op) rather than clamped if the destination would overlap
   *  another clip already on the track — same "just don't do it" contract
   *  the crate uses, so this file never invents an overlap the crate
   *  wouldn't also refuse. */
  | { kind: 'move'; track: number; clip: number; startFrame: number };

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
    case 'move':
      return `Move ${clipLabel(before, op.track, op.clip)}`;
    default:
      return 'Edit timeline';
  }
}

/** Clamp `v` into `[lo, hi]` — used throughout to mirror Rust's `i64::clamp`. */
function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

export function applyOp(tl: Timeline, op: EditOp): Timeline {
  if (op.kind === 'add_clip') {
    const next = clone(tl);
    if (next.tracks.length === 0) next.tracks.push({ kind: 'video', clips: [] });
    const trackIdx = op.track < next.tracks.length ? op.track : 0;
    const track = next.tracks[trackIdx];
    // D-056 — always an append: the position a dragged clip lands at is
    // "after everything already on this track," computed here (the only
    // place that has both the target track's real contents and the new
    // clip at once), never left for the clip to arrive without one.
    const startFrame = nextAppendFrame(track);
    const clip: Clip = { ...op.clip, start_frame: startFrame };
    const at = Math.min(Math.max(op.atIndex ?? track.clips.length, 0), track.clips.length);
    track.clips.splice(at, 0, clip);
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
    case 'move': {
      const c = tr.clips[op.clip];
      if (!c) return tl;
      if (op.startFrame < 0 || op.startFrame === c.start_frame) return tl;
      const newEnd = op.startFrame + c.duration;
      // mirrors `Timeline::move_clip`'s overlap check — the clip being
      // moved never counts as overlapping itself.
      const overlaps = tr.clips.some(
        (other, i) => i !== op.clip && op.startFrame < endFrame(other) && newEnd > other.start_frame,
      );
      if (overlaps) return tl;
      const next = clone(tl);
      next.tracks[op.track].clips[op.clip].start_frame = op.startFrame;
      return next;
    }
    case 'remove': {
      // D-054/D-056: a "lift", not a ripple delete — every other clip's
      // `start_frame` is untouched, so this plain splice already matches
      // `chroma-timeline::Timeline::remove` exactly; the gap it leaves is
      // implicit (nothing occupies that `start_frame` range any more).
      if (op.clip < 0 || op.clip >= tr.clips.length) return tl;
      const next = clone(tl);
      next.tracks[op.track].clips.splice(op.clip, 1);
      return next;
    }
    case 'trim_start': {
      // Mirrors `chroma-timeline::Timeline::trim_start` field-for-field: the
      // clip's *end* stays fixed — `source_start` and `start_frame` shift by
      // the same clamped delta, `duration` shrinks by it.
      const c = tr.clips[op.clip];
      if (!c) return tl;
      const ceiling = Math.max(c.source_len, 0);
      // nearest preceding clip's end on this track (0 if none) — start_frame
      // may never move earlier than this (no overlap with it).
      const prevEnd = tr.clips.reduce((max, other, i) => {
        if (i === op.clip) return max;
        const oe = endFrame(other);
        return oe <= c.start_frame ? Math.max(max, oe) : max;
      }, 0);
      let d = clampInt(op.delta, -c.source_start, Math.max(ceiling - 1, 0) - c.source_start);
      d = Math.max(d, prevEnd - c.start_frame);
      const newDur = c.duration - d;
      if (newDur < 1) return tl;
      const next = clone(tl);
      const nc = next.tracks[op.track].clips[op.clip];
      nc.source_start = c.source_start + d;
      nc.start_frame = c.start_frame + d;
      nc.duration = newDur;
      return next;
    }
    case 'trim_end': {
      // Mirrors `chroma-timeline::Timeline::trim_end`: `start_frame` stays
      // fixed, only `duration` changes, clamped by both the source media's
      // remaining length and the nearest following clip's `start_frame` (no
      // overlap with it).
      const c = tr.clips[op.clip];
      if (!c) return tl;
      const ceiling = Math.max(c.source_len, 0);
      const maxDurSource = Math.max(ceiling - c.source_start, 1);
      let nextStart: number | null = null;
      for (const [i, other] of tr.clips.entries()) {
        if (i === op.clip || other.start_frame < c.start_frame) continue;
        if (nextStart === null || other.start_frame < nextStart) nextStart = other.start_frame;
      }
      const maxDurPosition = nextStart === null ? Infinity : Math.max(nextStart - c.start_frame, 1);
      const maxDur = Math.max(Math.min(maxDurSource, maxDurPosition), 1);
      const newDur = clampInt(c.duration + op.delta, 1, maxDur);
      if (newDur === c.duration) return tl;
      const next = clone(tl);
      next.tracks[op.track].clips[op.clip].duration = newDur;
      return next;
    }
    case 'split': {
      // Mirrors `chroma-timeline::Timeline::split` — including giving the
      // right half its own `start_frame` (the D-056 bug: this used to copy
      // the left half's `start_frame` unchanged, leaving both halves
      // claiming the same timeline position).
      const c = tr.clips[op.clip];
      if (!c) return tl;
      const offset = op.atFrame - c.start_frame;
      if (offset <= 0 || offset >= c.duration) return tl;
      const next = clone(tl);
      const clips = next.tracks[op.track].clips;
      const left = clips[op.clip];
      const right: Clip = {
        ...left,
        id: `${left.id}·${op.atFrame}`,
        start_frame: left.start_frame + offset,
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
