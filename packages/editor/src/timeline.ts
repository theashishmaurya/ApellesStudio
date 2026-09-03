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
 * D-058: `Clip.start_frame` — mirrors `chroma-timeline::Clip::start_frame`
 * (D-054). Before this, every op here still assumed the pre-D-054 world
 * (a clip's timeline position is *implicit*, the sum of every preceding
 * clip's duration — `chroma_timeline_set` stores what's sent, so this file,
 * not the Rust ops, is what actually ran for every edit made through this
 * UI). D-054 gave the crate an explicit, authoritative `start_frame` and
 * changed `trim_start`/`trim_end`'s real semantics to be gap-aware around
 * it, but nothing here was updated to match — new/modified clips were built
 * without the field at all (an absent JSON key, not a wrong value), and
 * every position was still derived from Vec order. See D-058 for the full
 * bug writeup (B-011, B-012); every op below now mirrors the Rust op of the
 * same name field-for-field (`trim_start`'s neighbor clamp, `trim_end`'s
 * neighbor clamp, `split`'s `start_frame` on the right half, `add_clip`'s
 * append-at-track-end position) so what this file computes and what
 * `chroma-timeline::lib.rs` would compute for the same input agree.
 *
 * D-070 (unified clip identity, `docs/notes/unified-clip-model.md`):
 * `Clip.media_id` mirrors the Rust crate's new field — `clipFromDraggedMedia`
 * sets it from the dragged Sources-panel item's id, so a clip created by
 * dragging onto this timeline already carries the pool-item link
 * `chroma::project`'s grade-file migration and "add to grading" convenience
 * both key off.
 */

export interface Rational {
  num: number;
  den: number;
}

/** Mirrors `chroma_timeline::Clip` (serde snake_case). */
export interface Clip {
  id: string;
  shot_id?: string | null;
  /** Pool-item back-link (D-070) — mirrors `chroma_timeline::Clip::media_id`.
   *  Set by `clipFromDraggedMedia` for a clip dropped from the Sources
   *  panel; absent/`null` for a clip built before D-070 (`Timeline::
   *  from_shots`), which only ever set `shot_id`. */
  media_id?: string | null;
  name: string;
  source_path: string;
  source_start: number;
  duration: number;
  source_len: number;
  /** Timeline-absolute start frame (D-054/D-058) — see the module doc. */
  start_frame: number;
  /** Compositing transform (D-086/D-088, Phase 1/2 of the full-NLE P0
   *  effort) — mirrors `chroma_timeline::Clip`'s new fields exactly.
   *  `opacity`/`scale` default to `1.0` server-side (NOT `0.0` — see the
   *  Rust field's own doc for why `Clip` moved off `#[derive(Default)]`),
   *  `position_x`/`position_y`/`rotation` to `0.0`. Optional here the same
   *  way `Track.gain` already is — a pre-D-086 clip (or one this file
   *  builds without setting them) round-trips fine, `chroma_timeline_set`'s
   *  verbatim-storage contract means the server fills in real defaults on
   *  the next `chroma_timeline_get`. */
  opacity?: number;
  position_x?: number;
  position_y?: number;
  scale?: number;
  rotation?: number;
  /** D-086 — `[{frame, params: {opacity?, position_x?, position_y?, scale?,
   *  rotation?}}]`, the exact shape `utils/maskKeyframes.ts` already writes
   *  for mask/relight-light keyframes, reused verbatim rather than a
   *  second keyframe shape. `chroma::keyframes`'s D-034 engine
   *  (Rust-side) interpolates it at render time relative to the clip's own
   *  source frame — this file never interpolates it itself. */
  chroma_keyframes?: Array<{ frame: number; params: Record<string, unknown> }>;
}

/** A clip's exclusive timeline end frame — `chroma-timeline::Clip::end_frame`. */
export function endFrame(c: Clip): number {
  return c.start_frame + c.duration;
}

export interface Track {
  kind: 'video' | 'audio';
  clips: Clip[];
  /** Linear volume multiplier (D-057) — mirrors `chroma_timeline::Track::gain`.
   *  `1.0` unity, `0.0` full mute, `> 1.0` boosts. Absent on a pre-D-057
   *  timeline (defaults to `1.0` server-side); optional here for the same
   *  reason. Only meaningful for `kind === 'audio'` — a video track's own
   *  embedded audio stays hardcoded at unity (D-057's own scoping). */
  gain?: number;
  /** D-086 — mirrors `chroma_timeline::Track::locked`/`hidden` (both default
   *  `false` server-side, optional here for the same reason as `gain`).
   *  `locked` blocks per-clip edits on this track (`reorder`/`trim_start`/
   *  `trim_end`/`split`/`remove`/`move` in `applyOp` below all refuse —
   *  mirroring Rust's single `track_mut` choke point, `TimelineError::
   *  TrackLocked`) but NOT `add_track`/`remove_track`/`move_track` — same
   *  "locking protects a track's clips, not the track list" split as the
   *  Rust side. `hidden` is a pure compositor/render concern (`chroma_
   *  timeline_frame`'s `resolve_visible_video_layers_at` skips a hidden
   *  video track) — `applyOp` has nothing to refuse for it. */
  locked?: boolean;
  hidden?: boolean;
}

export const DEFAULT_TRACK_GAIN = 1.0;

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

// D-094 originally added `CHROMA_CLIP_MOVE_MIME` here for a native-HTML5
// cross-track clip-move drag; D-098 replaced that mechanism with a real
// `@dnd-kit/core` drag (native HTML5 drag was unreliable on Tauri's
// WKWebView — see D-098 in `docs/08-decisions.md`), so this constant has no
// producer or consumer left and was removed rather than kept as dead code.

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
 *  timeline position yet (D-058): that depends on the *target* track's
 *  current contents (append after its last clip), which only `applyOp`'s
 *  `add_clip` case knows at the moment the op is actually applied. Building
 *  a placeholder `start_frame` here (the pre-D-058 bug: simply omitting the
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
    // D-070: the pool-item link — this is the one real place a Clip gets
    // built from a known media pool item on the frontend (a Sources-panel
    // drag), so it's the one place that can set this for free.
    media_id: media.id,
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

/** D-095 — where a new clip of `duration` frames should land on `tr` if
 *  dropped at `frame`, and whether making room requires shifting anything.
 *
 *  Real NLEs distinguish two cases when a Sources-panel clip is dropped over
 *  an existing track: dropped into an open gap big enough to hold it (no
 *  other clip moves — consistent with this model's normal "explicit
 *  position, overlap rejected" contract, D-054/D-058) or dropped where
 *  there's no room (between two touching/too-close clips, or before the
 *  first) — a real ripple insert, the one place this model intentionally
 *  gains ripple behaviour (`applyOp`'s `add_clip` case is the only thing
 *  that ever shifts another clip's `start_frame` out from under it;
 *  `remove`/`trim_start`/`trim_end`/`split`/`move` all stay explicit-
 *  position-only, by design — see their own doc comments).
 *
 *  Snaps `frame` to the nearest clip edge (start or end of any clip already
 *  on `tr`, or 0) within `snapFrames`, so a visually "between these two"
 *  drop doesn't need pixel-perfect aim — mirrors the snap-assist
 *  `TimelinePane` already gets for free from the timeline library's own
 *  `dragLine` (D-051), just for this drag, which the library has no
 *  cross-drag-type concept of.
 *
 *  D-100 — a third case, found live: hovering somewhere in the MIDDLE of an
 *  existing clip, too far from either of ITS OWN edges for the snap above
 *  to catch, with no open gap there either. Owner: "when i try to add a
 *  clip between two which was already added does not work" — when two
 *  clips are already touching (zero gap, the ordinary state for a real
 *  edit, not an edge case), the ONLY way into the snap branch above was a
 *  pixel-precise hit on the seam between them; everywhere else on either
 *  clip's own body fell through to "no open gap" and silently appended at
 *  the track's end instead — which reads as "does not work," not "needs a
 *  wider gap." Falls back to whichever HALF of the clip currently under
 *  `frame` is closer — insert before it if `frame`'s in its first half,
 *  after it if its second — so the clip's own full body becomes a real,
 *  unambiguous insertion target instead of a dead zone. `null` is now only
 *  a drop in a genuinely empty region too far from anything to mean
 *  anything specific — the caller falls back to plain append there. */
export function computeInsertion(
  tr: Track,
  frame: number,
  duration: number,
  snapFrames: number,
): { startFrame: number; ripple: boolean } | null {
  const clips = tr.clips;
  if (clips.length === 0) return { startFrame: Math.max(0, frame), ripple: false };

  const fitsNoOverlap = (pos: number) => !clips.some((c) => pos < endFrame(c) && pos + duration > c.start_frame);

  const edges = new Set<number>([0]);
  for (const c of clips) {
    edges.add(c.start_frame);
    edges.add(endFrame(c));
  }
  let snapped: number | null = null;
  let bestDist = snapFrames + 1;
  edges.forEach((e) => {
    const d = Math.abs(e - frame);
    if (d <= snapFrames && d < bestDist) {
      bestDist = d;
      snapped = e;
    }
  });

  if (snapped !== null) {
    const pos: number = snapped;
    return fitsNoOverlap(pos) ? { startFrame: pos, ripple: false } : { startFrame: pos, ripple: true };
  }

  if (fitsNoOverlap(frame)) return { startFrame: Math.max(0, frame), ripple: false };

  const covering = clips.find((c) => frame >= c.start_frame && frame < endFrame(c));
  if (covering) {
    const mid = covering.start_frame + covering.duration / 2;
    const pos = frame < mid ? covering.start_frame : endFrame(covering);
    return fitsNoOverlap(pos) ? { startFrame: pos, ripple: false } : { startFrame: pos, ripple: true };
  }

  return null;
}

/** Where a new clip appended to `tr` should start — right after the
 *  furthest-out clip already on it (0 for an empty track). Mirrors what
 *  `backfill_legacy_positions` reconstructs for a legacy back-to-back track,
 *  but computed directly rather than relying on that migration path (see
 *  D-058 — that reliance was the drag-and-drop bug). */
export function nextAppendFrame(tr: Track): number {
  return trackDuration(tr);
}

/** The clip covering `frame` (by its real `start_frame`, D-054/D-058 — Vec
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
   *  `start_frame` (D-058) is computed by `applyOp` itself — always the end
   *  of whatever's already on the target track, i.e. a plain append, UNLESS
   *  `startFrame` is given (D-095 — a drop snapped to a specific insertion
   *  point, computed by `computeInsertion` at drop time). `ripple: true`
   *  means every clip on `track` at/after `startFrame` shifts later by the
   *  new clip's `duration` to make room — the one place this model
   *  intentionally gains ripple behaviour, see `computeInsertion`'s own doc
   *  for why (this is NOT extended to `remove`/`trim`/`split`/`move`, all of
   *  which stay explicit-position-only by design, D-054). */
  | { kind: 'add_clip'; track: number; clip: NewClipFields; atIndex?: number; startFrame?: number; ripple?: boolean }
  /** D-058/D-080 — reposition a clip in time, and optionally onto a
   *  different track (`fromTrack !== toTrack`) — the drag handle / "move to
   *  another track" affordance in the panel. Mirrors
   *  `chroma-timeline::Timeline::move_clip(from_track, from_idx, to_track,
   *  to_start_frame)` field-for-field. Overlap is rejected (no-op) ONLY for
   *  a same-track move (`fromTrack === toTrack`) — two clips can't occupy
   *  the same frame on ONE track. A cross-track move is allowed to overlap
   *  another clip already on `toTrack` (D-096) — since D-088's real
   *  multi-layer compositor, that's a normal composited-layer stack, not an
   *  error state; the earlier blanket rejection was stale "top wins" logic
   *  from before D-088 existed. */
  | { kind: 'move'; fromTrack: number; toTrack: number; clip: number; startFrame: number }
  /** D-080 — append a new empty track. Mirrors `chroma_timeline::Timeline::
   *  add_track`: always succeeds, no validation to mirror. */
  | { kind: 'add_track'; trackKind: 'video' | 'audio' }
  /** D-080 — remove a track and every clip on it (no confirmation/undo
   *  special-casing here — same as the Rust op, recovery is the shared
   *  undo stack's job like any other edit, D-051). Mirrors `chroma_timeline
   *  ::Timeline::remove_track`: no-op (rejected) for an out-of-range index. */
  | { kind: 'remove_track'; track: number }
  /** D-080 — set a track's linear volume multiplier (D-057's `Track.gain`).
   *  The panel's mute toggle uses this (`gain: 0` / restore to `1`) rather
   *  than a separate boolean field, matching what `chroma::audio`'s mixer
   *  already reads — "muted" has no independent representation to drift
   *  out of sync with the actual gain. No validation to mirror (the Rust
   *  field is a plain `f32` with no clamp of its own). */
  | { kind: 'set_track_gain'; track: number; gain: number }
  /** D-086/D-089 — toggle a track's lock. Mirrors `chroma_timeline::Track::
   *  locked`: always succeeds (locking is itself a track-list-level op, not
   *  gated by its own lock — matches `add_track`/`remove_track`/`move_track`'s
   *  own unlocked status in `track_mut`'s doc). */
  | { kind: 'set_track_locked'; track: number; locked: boolean }
  /** D-086/D-089 — toggle a track's visibility in the compositor. Mirrors
   *  `chroma_timeline::Track::hidden`. Always succeeds — same reasoning as
   *  `set_track_locked`. */
  | { kind: 'set_track_hidden'; track: number; hidden: boolean }
  /** D-086/D-089 — reorder the track list itself (compositing z-order,
   *  D-086's own doc: "track index order is compositing z-order, not
   *  cosmetic"). Mirrors `chroma_timeline::Timeline::move_track(from, to)`
   *  exactly: bounds-checked, `from === to` a genuine no-op, NOT gated by
   *  either track's lock (same track-list-vs-track-clips split as
   *  `add_track`/`remove_track`). */
  | { kind: 'move_track'; from: number; to: number }
  /** D-088/D-089 — set a clip's compositing transform (opacity/position/
   *  scale/rotation), the interim popover's write op. Always replaces the
   *  full set together (no partial-field variant) since the UI edits one
   *  clip's transform as a single form; refused (no-op) if the clip's track
   *  is locked, same as every other per-clip op. Keyframes are a SEPARATE
   *  op (`set_clip_keyframes`, below) — a transform edit while keyframes
   *  exist is a "set the base/unkeyframed value" edit, matching how
   *  `resolve_clip_transform` (Rust, D-088) only falls back to the static
   *  fields when no keyframe covers the requested frame or none exist. */
  | {
      kind: 'set_clip_transform';
      track: number;
      clip: number;
      opacity: number;
      position_x: number;
      position_y: number;
      scale: number;
      rotation: number;
    }
  /** D-089 — replace a clip's keyframe track outright (add/move/remove a
   *  keyframe is "recompute the array, then set it" client-side — mirrors
   *  the exact pattern `utils/maskKeyframes.ts`'s `upsertKeyframe`/
   *  `removeKeyframe`/`clearKeyframes` already use for mask/relight-light
   *  keyframes; this op is the timeline-clip equivalent write). `keyframes:
   *  []` and `keyframes: undefined` are both "no keyframes" — normalized to
   *  `undefined` on write so an empty array never round-trips as a
   *  keyframed clip. Refused (no-op) if the clip's track is locked. */
  | {
      kind: 'set_clip_keyframes';
      track: number;
      clip: number;
      keyframes: Array<{ frame: number; params: Record<string, unknown> }>;
    };

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
    case 'move': {
      const label = clipLabel(before, op.fromTrack, op.clip);
      return op.fromTrack === op.toTrack ? `Move ${label}` : `Move ${label} to another track`;
    }
    case 'add_track':
      return `Add ${op.trackKind} track`;
    case 'remove_track':
      return `Remove track ${op.track + 1}`;
    case 'set_track_gain':
      return op.gain <= 0 ? `Mute track ${op.track + 1}` : `Unmute track ${op.track + 1}`;
    case 'set_track_locked':
      return op.locked ? `Lock track ${op.track + 1}` : `Unlock track ${op.track + 1}`;
    case 'set_track_hidden':
      return op.hidden ? `Hide track ${op.track + 1}` : `Show track ${op.track + 1}`;
    case 'move_track':
      return `Reorder track ${op.from + 1}`;
    case 'set_clip_transform':
      return `Adjust ${clipLabel(before, op.track, op.clip)}`;
    case 'set_clip_keyframes':
      return `Keyframe ${clipLabel(before, op.track, op.clip)}`;
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
    if (next.tracks.length === 0) next.tracks.push({ kind: 'video', clips: [], gain: DEFAULT_TRACK_GAIN });
    const trackIdx = op.track < next.tracks.length ? op.track : 0;
    const track = next.tracks[trackIdx];
    let startFrame: number;
    if (op.startFrame !== undefined) {
      // D-095 — an explicit insertion point (the caller already resolved
      // this via `computeInsertion` at drop time, snapping to a real clip
      // edge). `ripple: true` shifts every clip at/after it later by the new
      // clip's own duration to make room — `false` means it was already
      // confirmed to fit in an open gap, so nothing else moves.
      startFrame = Math.max(0, op.startFrame);
      if (op.ripple) {
        const dur = op.clip.duration;
        for (const c of track.clips) {
          if (c.start_frame >= startFrame) c.start_frame += dur;
        }
      }
    } else {
      // D-058 — always an append: the position a dragged clip lands at is
      // "after everything already on this track," computed here (the only
      // place that has both the target track's real contents and the new
      // clip at once), never left for the clip to arrive without one.
      startFrame = nextAppendFrame(track);
    }
    const clip: Clip = { ...op.clip, start_frame: startFrame };
    const defaultAt = track.clips.filter((c) => c.start_frame < startFrame).length;
    const at = Math.min(Math.max(op.atIndex ?? defaultAt, 0), track.clips.length);
    track.clips.splice(at, 0, clip);
    return next;
  }

  // D-080 — track-list-level ops: none of these operate on "the clips of one
  // already-known track" the way the switch below's remaining ops do (`move`
  // spans two tracks; `add_track`/`remove_track` mutate the list itself), so
  // they're handled before the generic `tr = tl.tracks[op.track]` guard.
  if (op.kind === 'add_track') {
    // Mirrors `chroma_timeline::Timeline::add_track` — always succeeds.
    const next = clone(tl);
    next.tracks.push({ kind: op.trackKind, clips: [], gain: DEFAULT_TRACK_GAIN });
    return next;
  }
  if (op.kind === 'remove_track') {
    // Mirrors `Timeline::remove_track` — out-of-range is a no-op (`NoSuchTrack`).
    if (op.track < 0 || op.track >= tl.tracks.length) return tl;
    const next = clone(tl);
    next.tracks.splice(op.track, 1);
    return next;
  }
  if (op.kind === 'set_track_gain') {
    if (op.track < 0 || op.track >= tl.tracks.length) return tl;
    const next = clone(tl);
    next.tracks[op.track].gain = op.gain;
    return next;
  }
  if (op.kind === 'set_track_locked') {
    // D-089 — not gated by the track's own current lock state, same as the
    // Rust side (`Track.locked` is a plain field write, not routed through
    // `track_mut`).
    if (op.track < 0 || op.track >= tl.tracks.length) return tl;
    const next = clone(tl);
    next.tracks[op.track].locked = op.locked;
    return next;
  }
  if (op.kind === 'set_track_hidden') {
    if (op.track < 0 || op.track >= tl.tracks.length) return tl;
    const next = clone(tl);
    next.tracks[op.track].hidden = op.hidden;
    return next;
  }
  if (op.kind === 'move_track') {
    // Mirrors `Timeline::move_track(from, to)` exactly: bounds-checked,
    // `from === to` a genuine no-op, not gated by lock (track-list
    // structure, not per-clip editing).
    if (op.from < 0 || op.from >= tl.tracks.length) return tl;
    if (op.to < 0 || op.to >= tl.tracks.length) return tl;
    if (op.from === op.to) return tl;
    const next = clone(tl);
    const [moved] = next.tracks.splice(op.from, 1);
    next.tracks.splice(op.to, 0, moved);
    return next;
  }
  if (op.kind === 'set_clip_transform') {
    const tr = tl.tracks[op.track];
    if (!tr || tr.locked) return tl;
    const c = tr.clips[op.clip];
    if (!c) return tl;
    const next = clone(tl);
    const nc = next.tracks[op.track].clips[op.clip];
    nc.opacity = op.opacity;
    nc.position_x = op.position_x;
    nc.position_y = op.position_y;
    nc.scale = op.scale;
    nc.rotation = op.rotation;
    return next;
  }
  if (op.kind === 'set_clip_keyframes') {
    const tr = tl.tracks[op.track];
    if (!tr || tr.locked) return tl;
    const c = tr.clips[op.clip];
    if (!c) return tl;
    const next = clone(tl);
    const nc = next.tracks[op.track].clips[op.clip];
    // normalize `[]` to `undefined` — see the op's own doc.
    nc.chroma_keyframes = op.keyframes.length > 0 ? op.keyframes : undefined;
    return next;
  }
  if (op.kind === 'move') {
    // Mirrors `Timeline::move_clip(from_track, from_idx, to_track,
    // to_start_frame)` field-for-field, including its error order (negative
    // position checked first, before either track/clip is even looked up).
    if (op.startFrame < 0) return tl;
    const src = tl.tracks[op.fromTrack];
    const c = src?.clips[op.clip];
    if (!c) return tl;
    const dest = tl.tracks[op.toTrack];
    if (!dest) return tl;
    // D-089 — mirrors Rust `move_clip`'s explicit lock check on BOTH the
    // source track (losing a clip to elsewhere) and the destination track
    // (gaining one dropped onto it).
    if (src.locked || dest.locked) return tl;
    if (op.fromTrack === op.toTrack && op.startFrame === c.start_frame) return tl; // genuine no-op
    const newEnd = op.startFrame + c.duration;
    // D-096 — overlap is only ever rejected for a SAME-TRACK move now.
    // Before D-088's real multi-layer compositor, only one video track's
    // clip was ever visible per frame ("top wins"), so two clips
    // overlapping in time on DIFFERENT tracks would have been meaningless —
    // rejecting cross-track overlap made sense then. D-088 shipped
    // `resolve_visible_video_layers_at`, which composites every visible
    // track together — two clips overlapping in time across tracks is now
    // the NORMAL, intended shape of a real edit (that's the entire point of
    // V1/V2 stacking), not an error state, so continuing to reject it here
    // was stale behaviour left over from the pre-compositing model, not a
    // deliberate safety rule (confirmed live: dragging a clip from one
    // track onto another that already held something in the same time
    // range silently no-op'd instead of landing it as a new layer). WITHIN
    // one track, two clips overlapping in time still makes no sense (a
    // single track can't show two different things at once) — that
    // rejection is unchanged.
    const overlaps =
      op.fromTrack === op.toTrack &&
      dest.clips.some((other, i) => {
        if (i === op.clip) return false;
        return op.startFrame < endFrame(other) && newEnd > other.start_frame;
      });
    if (overlaps) return tl;
    const next = clone(tl);
    const [moved] = next.tracks[op.fromTrack].clips.splice(op.clip, 1);
    moved.start_frame = op.startFrame;
    next.tracks[op.toTrack].clips.push(moved);
    return next;
  }

  const tr = tl.tracks[op.track];
  if (!tr) return tl;
  // D-089 — single choke point for the remaining per-clip ops
  // (reorder/trim_start/trim_end/split/remove), mirroring Rust's own single
  // `track_mut` check (`TimelineError::TrackLocked`) rather than repeating
  // the guard in each `case` below.
  if (tr.locked) return tl;

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
      // D-054/D-058: a "lift", not a ripple delete — every other clip's
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
      // right half its own `start_frame` (the D-058 bug: this used to copy
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
