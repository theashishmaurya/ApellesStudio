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
  /** A/V link group (D-129) — mirrors `chroma_timeline::Clip::link_group`.
   *  The id of the group of clips this one is linked to; absent/`null` =
   *  unlinked, which is what every pre-D-129 clip deserializes to.
   *
   *  **On a video clip it additionally means "this clip's audio lives in a
   *  linked audio clip — don't play its embedded stream"** (Rust-side
   *  `chroma_audio_play` reads it for exactly that). See the Rust field's own
   *  doc for the full reasoning; this is the single fact "this video clip's
   *  sound has been externalized," which is what Premiere/Resolve mean by a
   *  linked A/V pair. */
  link_group?: string | null;
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
   *  the next `chroma_timeline_get`.
   *
   *  **`position_x`/`position_y` are normalised (D-136), not absolute
   *  pixels** — a fraction of the project's own composition
   *  (`ProjectSettings.width`/`height`), the same per-axis convention
   *  `crop_left`/`crop_top` below already used. This closed B-043: before
   *  D-136 these were canvas pixels in a compositor canvas that changed size
   *  with the preview quality (960 scrubbing / 640 playing), so a PIP
   *  offset visibly moved and resized when you pressed Play. A pre-D-136
   *  `project.json`'s stored values are migrated once on load
   *  (`chroma::project::load_manifest`, schema-minor gated) — this file
   *  never sees the old unit. */
  opacity?: number;
  position_x?: number;
  position_y?: number;
  scale?: number;
  rotation?: number;
  /** Crop (D-132) — mirrors `chroma_timeline::Clip::crop_left`/`crop_top`/
   *  `crop_right`/`crop_bottom`. Four **normalised (0–1) edge insets** into
   *  the clip's own SOURCE frame: the fraction of the picture trimmed off
   *  that edge, all four `0` = uncropped. Optional here for the same reason
   *  the five fields above are — a pre-D-132 clip has no such key and the
   *  backend defaults it to `0`.
   *
   *  A fraction rather than pixels because the compositor decodes each
   *  layer at whatever preview scale the caller asked for (960 scrubbing /
   *  640 playing), so a pixel crop would cover a different part of the
   *  picture at each quality — see the Rust field's own doc. `position_x`/
   *  `position_y` above carried that same defect (B-043) until D-136. */
  crop_left?: number;
  crop_top?: number;
  crop_right?: number;
  crop_bottom?: number;
  /** D-086/D-132 — `[{frame, params: {opacity?, position_x?, position_y?,
   *  scale?, rotation?, crop_left?, crop_top?, crop_right?, crop_bottom?}}]`,
   *  the exact shape `utils/maskKeyframes.ts` already writes
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
  /** Cross-track ripple sync (D-106/roadmap item 11) — mirrors
   *  `chroma_timeline::Track::sync_locked`. Whether this track RECEIVES a
   *  ripple shift triggered by an edit on a DIFFERENT track; independent of
   *  whether THIS track's own edits ripple (always, unconditionally, same
   *  as before this field existed). Matches DaVinci Resolve's/Palmier Pro's
   *  real Sync Lock semantics (checked live, `docs/notes/
   *  cross-track-ripple-sync-lock.md`), a distinct concept from `locked`
   *  (protects THIS track's own clips from being edited at all — not the
   *  same as whether it receives someone else's ripple). Optional here for
   *  the same reason `gain` is: absent on a pre-D-106 track, defaulted to
   *  `true` (NOT the bare-optional "falsy" reading) wherever a `Track` is
   *  constructed or migrated — see `DEFAULT_SYNC_LOCKED`. */
  sync_locked?: boolean;
}

export const DEFAULT_TRACK_GAIN = 1.0;
/** Mirrors Rust's `default_sync_locked()` — see `Track.sync_locked`'s own
 *  doc for why this is `true`, not a bare falsy default. */
export const DEFAULT_SYNC_LOCKED = true;

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
  /** D-129 — whether this source has a decodeable audio stream, so the drop
   *  knows whether to build a linked audio half at all. Mirrors
   *  `MediaItem.video.hasAudio` (`@chroma/bridge`), which mirrors
   *  `chroma::video::VideoInfo::has_audio`. Absent/`null` = **not known**
   *  (a pool item imported before D-129 that hasn't been re-probed), which is
   *  treated as "no audio half" — the same conservative reading
   *  `clipFromDraggedMedia` already gives an absent `frameCount`. This is the
   *  real signal D-097's `inferNewTrackKind` explicitly flagged as missing
   *  ("`DraggedMedia`/`MediaItem` carry NO real audio-vs-video signal today
   *  … without a real backend model change"). */
  hasAudio?: boolean | null;
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
  const pair = linkedClipsFromDraggedMedia(media);
  return pair && pair.video;
}

/** D-129 — the real "drop a clip, get V1 + a linked A1" pair, the owner's
 *  own ask ("in palmier and other, any time i drop a clip it … created a
 *  linked track in audio") and the default behaviour of every reference NLE
 *  (Premiere patches a dropped clip to V1 *and* A1; Resolve links the two
 *  and propagates every move/trim/delete between them).
 *
 *  Returns the video half plus, when the source really has an audio stream,
 *  a second full `Clip` for that audio — a genuinely separate, independently
 *  addressable clip (confirmed against both references: the audio half is a
 *  real clip on its own track that Unlink makes fully independent, not a
 *  sub-part of the video clip) — with both halves carrying the same
 *  `link_group`. `audio: null` for a silent source, or one whose audio status
 *  isn't known (`hasAudio` absent, a pre-D-129 pool item): no audio half is
 *  invented, and the video clip stays `link_group`-free so `chroma::audio`
 *  keeps playing its embedded stream exactly as it does today (D-050).
 *
 *  `null` overall for media with no usable frame count, same as before. */
export function linkedClipsFromDraggedMedia(
  media: DraggedMedia,
): { video: NewClipFields; audio: NewClipFields | null } | null {
  const frames = media.frameCount ?? 0;
  if (!frames || frames <= 0) return null;
  const stamp = Date.now().toString(36);
  const linkGroup = media.hasAudio ? `lg-${media.id}-${stamp}` : null;
  const common = {
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
  const video: NewClipFields = { id: `${media.id}-${stamp}`, link_group: linkGroup, ...common };
  if (!linkGroup) return { video, audio: null };
  // Same source window, same length — the audio half starts life exactly
  // congruent with the picture, and only diverges if the user deliberately
  // unlinks and slips it (an L-cut).
  const audio: NewClipFields = { id: `${media.id}-${stamp}-a`, link_group: linkGroup, ...common };
  return { video, audio };
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

/** D-104 — where an EXISTING clip should land when dragged onto `dest`
 *  (same-track reposition or cross-track move) at `intendedFrame`. Owner's
 *  explicit, absolute direction after live-testing D-096/D-100: "i should be
 *  able to drop it before any clip, between two clip or after two clip, not
 *  on top of the clip... that should not be possible" — landing mid-overlap
 *  is never a reachable outcome of a plain drag, full stop, not "allowed
 *  unless you signal otherwise." This is the exact question `computeInsertion`
 *  already answers for a brand-new clip dropped from Sources — reused here
 *  rather than a second placement algorithm, with the moving clip's own
 *  current slot excluded (by id) so it doesn't collide with itself when it's
 *  already sitting on `dest`. Falls back to appending after everything else
 *  on `dest` on the rare `computeInsertion` `null` case (a frame that's
 *  neither near a snap edge nor inside/adjacent to any clip's span, and NOT
 *  a plain open fit either), same safe default `add_clip` itself falls back
 *  to. This REVERSES D-096's "cross-track overlap allowed" policy — see the
 *  `move` `EditOp`'s own doc for why; real intentional layer-stacking (V1/V2
 *  compositing, D-088) stays possible via other means, just not as a side
 *  effect of where a drag happens to land. */
export function resolveClipLanding(
  dest: Track,
  movingClipId: string,
  duration: number,
  intendedFrame: number,
  snapFrames: number,
): { startFrame: number; ripple: boolean } {
  const withoutSelf: Track = { ...dest, clips: dest.clips.filter((c) => c.id !== movingClipId) };
  const insertion = computeInsertion(withoutSelf, Math.max(0, intendedFrame), duration, snapFrames);
  if (insertion) return insertion;
  return { startFrame: nextAppendFrame(withoutSelf), ripple: false };
}

/** D-105 — the exclusive `[gapStart, gapEnd)` bounds of the REAL, closeable
 *  gap containing `frame` on `tr`, or `null` if there isn't one. Mirrors
 *  `chroma-timeline::Track::gap_at` field-for-field (same two "there isn't
 *  one" cases: `frame` is inside a clip, or it's trailing empty space past
 *  the last clip — nothing after it to ripple, so not a real gap). Clips are
 *  walked by value, never assumed to be in position order (D-054). */
export function gapAt(tr: Track, frame: number): { gapStart: number; gapEnd: number } | null {
  if (frame < 0 || clipAt(tr, frame)) return null;
  let gapStart = 0;
  for (const c of tr.clips) {
    const e = endFrame(c);
    if (e <= frame && e > gapStart) gapStart = e;
  }
  let gapEnd: number | null = null;
  for (const c of tr.clips) {
    if (c.start_frame > gapStart && (gapEnd === null || c.start_frame < gapEnd)) gapEnd = c.start_frame;
  }
  return gapEnd === null ? null : { gapStart, gapEnd };
}

/** Where a new clip appended to `tr` should start — right after the
 *  furthest-out clip already on it (0 for an empty track). Mirrors what
 *  `backfill_legacy_positions` reconstructs for a legacy back-to-back track,
 *  but computed directly rather than relying on that migration path (see
 *  D-058 — that reliance was the drag-and-drop bug). */
export function nextAppendFrame(tr: Track): number {
  return trackDuration(tr);
}

/** The clip with `id` on `track`, by id (not position) — the lookup both
 *  `TimelinePane` (selection UI) and `EditorInspectorPanel` (now a sibling
 *  component, not nested inside `TimelinePane`, per the "full height, not
 *  squeezed into the timeline" panel move) need for the same selected clip,
 *  kept here once rather than duplicated in both. */
export function findClip(tl: Timeline | null, track: number, id: string): { clip: Clip; index: number } | null {
  const clips = tl?.tracks[track]?.clips ?? [];
  const index = clips.findIndex((c) => c.id === id);
  return index >= 0 ? { clip: clips[index], index } : null;
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

/** Shift every clip on `tr` starting at/after `threshold` by `delta` frames
 *  (positive = later, negative = earlier) — mirrors `chroma-timeline::
 *  shift_clips_at_or_after` (D-106) exactly, the one real ripple-shift
 *  primitive shared by `add_clip`'s insertion ripple, `move`'s ripple, and
 *  `remove_gap` (a real, pre-existing triplication in this file this pass
 *  cleans up rather than adding a fourth copy). Mutates `tr.clips` in place
 *  — callers already work on a `clone()`d timeline before calling this. */
function shiftClipsAtOrAfter(tr: Track, threshold: number, delta: number): void {
  for (const c of tr.clips) {
    if (c.start_frame >= threshold) c.start_frame += delta;
  }
}

/** Auto-decommission an empty track (owner, live: "if we have an empty
 *  track we auto decommission it and renumber the tracks... not
 *  unnecessary empty tracks"). Deliberately narrow, not a blanket sweep of
 *  every track in the timeline: only the ONE track a `remove`/cross-track
 *  `move` op just directly emptied gets pruned here — a track that started
 *  this op already empty (e.g. one the owner just added via `add_track` and
 *  hasn't placed a clip on yet) is left alone. Checked live against real
 *  reference behavior, not assumed: neither Premiere Pro nor DaVinci
 *  Resolve auto-removes an empty track by default (both require an
 *  explicit "Delete Empty Tracks" action) — this is a deliberate, informed
 *  deviation from that convention for this specific op class, per the
 *  owner's own explicit ask, not an oversight. `Vec`/array removal renumbers
 *  the remaining tracks by construction (index-derived labels, `labels[i]`
 *  in `TimelinePane.tsx`, are already correct with no further change) — the
 *  caller (`timelineStore.ts::applyOp`) is responsible for remapping any
 *  *selection* state that held a track index across this call, the same
 *  class of index-shift the track-reorder drag's own `trackIndexAfterMove`
 *  already has to handle. Mirrors `chroma-timeline::Timeline::{remove,
 *  move_clip}`'s own end-of-function prune exactly. */
function pruneIfEmptyTrack(tracks: Track[], trackIdx: number): void {
  if (tracks[trackIdx]?.clips.length === 0) tracks.splice(trackIdx, 1);
}

/** The sync-lock version of `shiftClipsAtOrAfter` (D-106) — mirrors
 *  `chroma-timeline::ripple_shift_with_auto_split` field-for-field. For a
 *  track receiving someone ELSE's ripple (never the track directly being
 *  edited, which keeps using the plain shift above and D-104's own
 *  reject-on-straddle contract unchanged). A clip straddling `threshold`
 *  (starts before it, ends after it) is auto-split there first — the
 *  owner's own explicit call, matching Resolve's real behavior: rejecting
 *  would make sync-lock block ripples constantly whenever a straddling clip
 *  (a music bed, room tone — sync-lock's own headline use case) sits on a
 *  synced track. The new right half gets a derived id (`${id}·${threshold}`,
 *  this file's existing `split` id convention) so the ripple-flash diff
 *  effect in `TimelinePane.tsx` picks it up and flashes it — an auto-split
 *  is automatic but never silent. */
/** B-033 — REVERTED from auto-split to reject-on-straddle, a deliberate
 *  safety rollback, not a redesign. The auto-split version (D-106/D-107)
 *  let a REPEATED ripple (several real remove_gap/move/add_clip ops in the
 *  same session, each individually correct in isolation) keep re-splitting
 *  a fragment created by a PREVIOUS ripple — confirmed on the owner's real
 *  `New.chroma` project: the same source clip ended up split into a chain
 *  of ever-smaller slivers (four consecutive 166-frame fragments of one
 *  clip) and the same clip id appearing three times on one track at wildly
 *  different positions, with the project's total duration growing instead
 *  of shrinking after closing a gap. All 93 existing single-operation unit
 *  tests passed throughout — the bug is in the cross-operation, cumulative
 *  case those tests never exercised, not in any single call's math. Rather
 *  than ship a fix for a multi-operation interaction not fully reproduced
 *  and verified under time pressure, this reverts to exactly D-104's own
 *  already-proven-safe same-track contract: a straddling clip on a
 *  sync-locked track REJECTS the whole op (same as an unresolvable
 *  same-track overlap), never splits. Auto-split may come back as a real,
 *  separately-scoped, separately-verified follow-up — see B-033. */
/** Returns *which* track index has a clip straddling `threshold` (or `null`
 *  if none does) — `applyOp` uses this to reject a ripple that can't clear a
 *  straddling clip (B-033); the visual sync-highlight in `TimelinePane.tsx`
 *  (owner, 2026-09-04: "for sync when i select on is should see all the sync
 *  selected") reuses the same predicate to find which OTHER clips a
 *  selection's own sync-locked tracks are really linked to. */
function findStraddlingSyncLockedTrack(tracks: Track[], editedTrack: number, threshold: number): number | null {
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (i === editedTrack || !(t.sync_locked ?? DEFAULT_SYNC_LOCKED) || t.locked) continue;
    if (t.clips.some((c) => c.start_frame < threshold && endFrame(c) > threshold)) return i;
  }
  return null;
}

/** Owner, 2026-09-04: "for sync when i select one is should see all the sync
 *  selected" — a real, proactive visual instead of a reactive error toast
 *  (see B-033's own UX follow-up for the toast approach this replaces).
 *
 *  For each selected clip, walks every OTHER `sync_locked` (and not
 *  individually `locked`) track and collects every clip on it that a ripple
 *  originating at the selected clip's own `start_frame` would touch —
 *  exactly the same two predicates `propagateSyncLockRipple`/
 *  `findStraddlingSyncLockedTrack` already use for the real ripple
 *  mechanics, not a second, only-approximately-matching definition: a clip
 *  starting at/after the threshold (would SHIFT together) or straddling it
 *  (would BLOCK the ripple, B-033). Both read as "this clip is really tied
 *  to the selection via sync-lock" — the caller renders one shared secondary
 *  highlight for the whole set, distinct from the primary selection ring. */
function collectSyncLinkedClips(tracks: Track[], editedTrack: number, threshold: number): Set<string> {
  const linked = new Set<string>();
  tracks.forEach((t, i) => {
    if (i === editedTrack || !(t.sync_locked ?? DEFAULT_SYNC_LOCKED) || t.locked) return;
    for (const c of t.clips) {
      if (c.start_frame >= threshold || (c.start_frame < threshold && endFrame(c) > threshold)) {
        linked.add(c.id);
      }
    }
  });
  return linked;
}

export function syncLinkedClipIds(tl: Timeline, selection: { track: number; id: string }[]): Set<string> {
  const linked = new Set<string>();
  for (const sel of selection) {
    const track = tl.tracks[sel.track];
    const clip = track?.clips.find((c) => c.id === sel.id);
    if (!clip) continue;
    for (const id of collectSyncLinkedClips(tl.tracks, sel.track, clip.start_frame)) linked.add(id);
  }
  return linked;
}

/** Live drag-preview variant of `syncLinkedClipIds` — same shared predicate
 *  (`collectSyncLinkedClips`), but from an explicit `(track, thresholdFrame)`
 *  pair instead of an existing selected clip's own `start_frame`. Needed
 *  because a clip mid-drag to a new track isn't a member of that track's
 *  `clips` yet, so there's no real clip to look up — `TimelinePane.tsx`'s
 *  `onDndDragMove` passes the live-resolved landing track/frame straight
 *  through instead. D-113 (owner: "if both are synced, then both should
 *  move together and hover together" — the drag-preview follow-up to
 *  D-111's selection-time highlight; D-112 is a concurrent, unrelated
 *  fork's own number — checked before claiming this one). */
export function syncLinkedClipIdsAtPosition(tl: Timeline, track: number, thresholdFrame: number): Set<string> {
  return collectSyncLinkedClips(tl.tracks, track, thresholdFrame);
}

/** Propagate a ripple already applied to `editedTrack` (index into
 *  `tracks`) to every OTHER track whose `sync_locked` is on — mirrors
 *  `chroma-timeline::propagate_sync_lock_ripple`. A track that's BOTH
 *  sync-locked AND individually `locked` is skipped, same real judgment
 *  call as the Rust side's own doc: `locked` already means "protect this
 *  track's clips from edits through the normal ops," and a foreign ripple
 *  shifting this track's clips is exactly that. Plain shift only — callers
 *  MUST check `findStraddlingSyncLockedTrack` first and reject the whole op
 *  if it returns non-null (B-033); this function assumes that's already been
 *  done and never splits. */
function propagateSyncLockRipple(tracks: Track[], editedTrack: number, threshold: number, delta: number): void {
  tracks.forEach((t, i) => {
    if (i !== editedTrack && (t.sync_locked ?? DEFAULT_SYNC_LOCKED) && !t.locked) {
      shiftClipsAtOrAfter(t, threshold, delta);
    }
  });
}

// --------------------------------------------------------------------------- //
// A/V link groups (D-129, `docs/notes/av-linking.md`) — mirrors the Rust
// crate's own link helpers field-for-field.
// --------------------------------------------------------------------------- //

/** Every `[trackIndex, clipIndex]` whose clip belongs to `group`, ascending —
 *  mirrors `chroma-timeline::Timeline::link_group_members`. Index-based, so
 *  only valid until the next mutation. */
export function linkGroupMembers(tl: Timeline, group: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  tl.tracks.forEach((t, ti) => {
    t.clips.forEach((c, ci) => {
      if (c.link_group && c.link_group === group) out.push([ti, ci]);
    });
  });
  return out;
}

/** The group id + member locations for the clip at `(track, clip)`, or `null`
 *  when it's unlinked — mirrors Rust's `link_targets`, the lookup every
 *  link-aware op starts from. */
function linkTargets(
  tl: Timeline,
  track: number,
  clip: number,
): { group: string; members: Array<[number, number]> } | null {
  const group = tl.tracks[track]?.clips[clip]?.link_group;
  if (!group) return null;
  return { group, members: linkGroupMembers(tl, group) };
}

/** Every clip id linked to any clip in `selection` (excluding the selection's
 *  own ids) — what `TimelinePane` paints its link highlight from, so grabbing
 *  one half visibly shows the other. The link-group counterpart of
 *  `syncLinkedClipIds`, deliberately a SEPARATE set: sync-lock ("these tracks
 *  ripple together") and an A/V link ("these clips ARE one shot") are
 *  different relationships and read as different things on screen. */
export function linkedClipIds(tl: Timeline, selection: { track: number; id: string }[]): Set<string> {
  const own = new Set(selection.map((s) => s.id));
  const linked = new Set<string>();
  for (const sel of selection) {
    const group = tl.tracks[sel.track]?.clips.find((c) => c.id === sel.id)?.link_group;
    if (!group) continue;
    for (const [ti, ci] of linkGroupMembers(tl, group)) {
      const id = tl.tracks[ti].clips[ci].id;
      if (!own.has(id)) linked.add(id);
    }
  }
  return linked;
}

/** One clip's address for [`checkLink`]/the `link` op — `{ track, clip }`
 *  index pair, same addressing every other per-clip op on this surface uses. */
export interface LinkTarget {
  track: number;
  clip: number;
}

/** The result of [`checkLink`] — `ok: false` always carries a human-readable
 *  `reason`, precisely so `TimelinePane`'s Link button can surface it rather
 *  than just disabling silently (the owner's own ask: "surface a clear
 *  reason when it's not available, don't just hide the button"). */
export interface LinkCheck {
  ok: boolean;
  reason?: string;
}

/** D-138 — the shared precondition check behind `applyOp`'s `link` case AND
 *  `TimelinePane`'s Link button, so the two can never disagree about when
 *  linking is allowed: the button enables/disables and shows `reason` from
 *  exactly the same logic that decides whether `applyOp` actually mutates
 *  anything. Mirrors `chroma_timeline::Timeline::link`'s own validation
 *  order (self-link → range → lock → already-linked → kind-mismatch) so the
 *  first reason surfaced here is the first one the Rust op would reject on
 *  too, if this were ever sent through `chroma_timeline_link_clips` instead
 *  of `chroma_timeline_set`. */
export function checkLink(tl: Timeline, a: LinkTarget, b: LinkTarget): LinkCheck {
  if (a.track === b.track && a.clip === b.clip) {
    return { ok: false, reason: 'Select two different clips' };
  }
  const trackA = tl.tracks[a.track];
  const trackB = tl.tracks[b.track];
  const clipA = trackA?.clips[a.clip];
  const clipB = trackB?.clips[b.clip];
  if (!trackA || !trackB || !clipA || !clipB) {
    return { ok: false, reason: 'Clip not found' };
  }
  if (trackA.locked || trackB.locked) {
    return { ok: false, reason: 'A track in the selection is locked' };
  }
  if (clipA.link_group || clipB.link_group) {
    return { ok: false, reason: 'Already linked — unlink first' };
  }
  if (trackA.kind === trackB.kind) {
    return { ok: false, reason: 'Select one video clip and one audio clip' };
  }
  return { ok: true };
}

/** Where `startFrame` ends up once a pending ripple is applied — mirrors
 *  `chroma-timeline::start_after_ripple`. Lets a linked move be accepted or
 *  rejected before anything is mutated. */
function startAfterRipple(startFrame: number, rippled: boolean, threshold: number, delta: number): number {
  return rippled && startFrame >= threshold ? startFrame + delta : startFrame;
}

/** The clamped head-trim delta `trim_start` would really apply — mirrors
 *  `chroma-timeline::clamped_trim_start_delta`, extracted for the same D-129
 *  reason (asking every link-group member for its own clamp before mutating).
 *  Caller guarantees `clipIdx` is in range. */
function clampedTrimStartDelta(tr: Track, clipIdx: number, delta: number): number {
  const c = tr.clips[clipIdx];
  const ceiling = Math.max(c.source_len, 0);
  const prevEnd = tr.clips.reduce((max, other, i) => {
    if (i === clipIdx) return max;
    const oe = endFrame(other);
    return oe <= c.start_frame ? Math.max(max, oe) : max;
  }, 0);
  const d = clampInt(delta, -c.source_start, Math.max(ceiling - 1, 0) - c.source_start);
  return Math.max(d, prevEnd - c.start_frame);
}

/** The clamped new `duration` `trim_end` would really apply — mirrors
 *  `chroma-timeline::clamped_trim_end_duration`. */
function clampedTrimEndDuration(tr: Track, clipIdx: number, delta: number): number {
  const c = tr.clips[clipIdx];
  const ceiling = Math.max(c.source_len, 0);
  const maxDurSource = Math.max(ceiling - c.source_start, 1);
  let nextStart: number | null = null;
  for (const [i, other] of tr.clips.entries()) {
    if (i === clipIdx || other.start_frame < c.start_frame) continue;
    if (nextStart === null || other.start_frame < nextStart) nextStart = other.start_frame;
  }
  const maxDurPosition = nextStart === null ? Infinity : Math.max(nextStart - c.start_frame, 1);
  const maxDur = Math.max(Math.min(maxDurSource, maxDurPosition), 1);
  return clampInt(c.duration + delta, 1, maxDur);
}

/** First unlocked audio track with room for `[startFrame, startFrame +
 *  duration)`, or `null` — mirrors
 *  `chroma-timeline::Timeline::audio_track_with_room`. */
export function audioTrackWithRoom(tl: Timeline, startFrame: number, duration: number): number | null {
  const end = startFrame + duration;
  const i = tl.tracks.findIndex(
    (t) =>
      t.kind === 'audio' &&
      !t.locked &&
      !t.clips.some((c) => startFrame < endFrame(c) && end > c.start_frame),
  );
  return i >= 0 ? i : null;
}

/** [`audioTrackWithRoom`], appending a brand-new audio track when none has
 *  room — mirrors `chroma-timeline::Timeline::ensure_audio_track_with_room`.
 *  Mutates `tracks` in place (callers already hold a `clone()`d timeline) and
 *  uses the SAME track shape `add_track` builds, rather than a second
 *  track-creation path (D-095/D-096/D-117's one real mechanism). A fresh
 *  track is empty, so the returned index is always genuinely free — which is
 *  what makes "a dropped clip's audio half always lands somewhere valid" a
 *  guarantee with no failure branch. */
export function ensureAudioTrackWithRoom(tl: Timeline, startFrame: number, duration: number): number {
  const existing = audioTrackWithRoom(tl, startFrame, duration);
  if (existing !== null) return existing;
  tl.tracks.push({ kind: 'audio', clips: [], gain: DEFAULT_TRACK_GAIN, sync_locked: DEFAULT_SYNC_LOCKED });
  return tl.tracks.length - 1;
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
  /** D-105 — select an empty stretch of track (not a clip) and delete IT:
   *  close the gap at `frame` on `track`, shifting every clip at/after the
   *  gap's end earlier by the gap's own width. The deliberate mirror image
   *  of `remove` (a "lift," leaves a gap, see that op's own doc) — a real
   *  NLE always pairs the two: delete a CLIP and the space stays, delete a
   *  GAP and the space closes. `frame` just needs to land anywhere inside
   *  the gap being closed (`gapAt` finds its exact bounds); refused as a
   *  no-op if `frame` isn't inside a real, closeable gap on `track` (either
   *  it's inside a clip, the track is locked, or it's trailing empty space
   *  past the last clip — nothing there to ripple). */
  | { kind: 'remove_gap'; track: number; frame: number }
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
   *  which stay explicit-position-only by design, D-054).
   *
   *  D-129 — `linkedAudio` is the dropped source's **own embedded audio, as a
   *  second real clip**: when set, this op also places it on an audio track
   *  (the first one with room at the same `startFrame`, else a brand-new one
   *  appended via the same shape `add_track` builds — see
   *  `ensureAudioTrackWithRoom`), both halves already carrying the same
   *  `link_group`. Deliberately ONE op rather than two chained ones so the
   *  pair is atomic: one history entry, one undo, and never a half-linked
   *  timeline in between. Absent = today's behaviour exactly (a silent
   *  source, or a pool item whose audio status isn't known). */
  | {
      kind: 'add_clip';
      track: number;
      clip: NewClipFields;
      atIndex?: number;
      startFrame?: number;
      ripple?: boolean;
      linkedAudio?: NewClipFields;
    }
  /** D-058/D-080 — reposition a clip in time, and optionally onto a
   *  different track (`fromTrack !== toTrack`) — the drag handle / "move to
   *  another track" affordance in the panel. Mirrors
   *  `chroma-timeline::Timeline::move_clip(from_track, from_idx, to_track,
   *  to_start_frame)` field-for-field, extended with `ripple` (D-104).
   *
   *  D-104 — **overlap is rejected for every move now, same-track or
   *  cross-track**, unless `ripple: true`. This reverses D-096's "cross-track
   *  overlap allowed" policy: D-096 reasoned that since D-088's compositor
   *  renders every visible track together, two clips overlapping in time
   *  across tracks is a normal composited stack, not an error — true in
   *  principle, but live-tested and explicitly overridden by the owner:
   *  landing directly on top of another clip should never be a reachable
   *  outcome of a plain drag. The caller (`TimelinePane`'s
   *  `resolveClipLanding`, mirroring `computeInsertion`) is expected to
   *  always resolve a real, non-overlapping `startFrame` before calling this
   *  — before the first clip, snapped into an open gap, or `ripple: true`
   *  to make room between two already-touching clips (shifting every clip on
   *  `toTrack` at/after `startFrame` later by this clip's own duration,
   *  mirroring `add_clip`'s existing ripple contract) — never a silent
   *  overlap. If `startFrame` still overlaps something and `ripple` isn't
   *  set (a caller bug, not an expected path), the op is rejected (no-op)
   *  rather than corrupting the timeline. */
  | { kind: 'move'; fromTrack: number; toTrack: number; clip: number; startFrame: number; ripple?: boolean }
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
  /** D-106 — toggle a track's cross-track ripple sync. Mirrors
   *  `chroma_timeline::Track::sync_locked`. Always succeeds — same
   *  track-list-level reasoning as `set_track_locked`/`set_track_hidden`. */
  | { kind: 'set_track_sync_locked'; track: number; syncLocked: boolean }
  /** D-129 — dissolve the COMPLETE A/V link group the clip at `(track, clip)`
   *  belongs to (not just remove that one clip from it): Palmier Pro's own
   *  documented `manage_clip_links` unlink semantics, and what Premiere's
   *  `Clip > Unlink` / Resolve's "Unlink Clips" both do. The escape hatch for
   *  an L-cut — unlink, slip one half, and (a later pass) relink. A no-op for
   *  an already-unlinked clip; refused if the clip's own track is locked.
   *  Mirrors `chroma_timeline::Timeline::unlink`. */
  | { kind: 'unlink'; track: number; clip: number }
  /** D-138, `docs/notes/av-linking.md` "Deferred" list — link two
   *  ALREADY-INDEPENDENT clips (one video-track, one audio-track) into a new
   *  A/V link group. Mirrors `chroma_timeline::Timeline::link` field-for-
   *  field, including its deliberately narrower scope vs. Palmier's own
   *  group-merging `link`: both clips must currently be unlinked, and the
   *  op is rejected whole (a no-op, same "reject rather than corrupt"
   *  discipline every other link-aware op here uses) rather than partially
   *  applied — see [`checkLink`], the shared precondition check `applyOp`
   *  and the toolbar's Link button both call, so the button's disabled-
   *  reason tooltip can never drift from what actually gets enforced.
   *  Order-independent — `{trackA, clipA}`/`{trackB, clipB}` may name
   *  either clip first, the resulting group id is the same either way. */
  | { kind: 'link'; trackA: number; clipA: number; trackB: number; clipB: number }
  /** D-086/D-089 — reorder the track list itself (compositing z-order,
   *  D-086's own doc: "track index order is compositing z-order, not
   *  cosmetic"). Mirrors `chroma_timeline::Timeline::move_track(from, to)`
   *  exactly: bounds-checked, `from === to` a genuine no-op, NOT gated by
   *  either track's lock (same track-list-vs-track-clips split as
   *  `add_track`/`remove_track`). */
  | { kind: 'move_track'; from: number; to: number }
  /** D-088/D-089 — set a clip's compositing transform (opacity/position/
   *  scale/rotation, **and D-132's four crop insets**), the interim
   *  popover's write op. Always replaces the
   *  full set together (no partial-field variant) since the UI edits one
   *  clip's transform as a single form; refused (no-op) if the clip's track
   *  is locked, same as every other per-clip op. Keyframes are a SEPARATE
   *  op (`set_clip_keyframes`, below) — a transform edit while keyframes
   *  exist is a "set the base/unkeyframed value" edit, matching how
   *  `resolve_clip_transform` (Rust, D-088) only falls back to the static
   *  fields when no keyframe covers the requested frame or none exist.
   *
   *  **D-132 — crop rides this op rather than getting a `set_clip_crop` of
   *  its own.** Both references present crop as a separate *mode* in the
   *  viewer, but that is an on-canvas affordance question, not a write-path
   *  one: crop and the D-082 five are one clip's geometry, edited from one
   *  form, and two ops would mean two history entries, two save round trips
   *  and a real ordering question between them for no gain. The fields are
   *  **required**, not optional-with-fallback, precisely because this op
   *  replaces the full set — an optional crop field would silently reset a
   *  clip's crop to zero on any caller that forgot it. */
  | {
      kind: 'set_clip_transform';
      track: number;
      clip: number;
      opacity: number;
      position_x: number;
      position_y: number;
      scale: number;
      rotation: number;
      crop_left: number;
      crop_top: number;
      crop_right: number;
      crop_bottom: number;
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
    case 'remove_gap':
      return `Close gap on track ${op.track + 1}`;
    case 'add_clip':
      return op.linkedAudio ? `Add "${op.clip.name}" + audio` : `Add "${op.clip.name}"`;
    case 'unlink':
      return `Unlink ${clipLabel(before, op.track, op.clip)}`;
    case 'link':
      return `Link ${clipLabel(before, op.trackA, op.clipA)} + ${clipLabel(before, op.trackB, op.clipB)}`;
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
    case 'set_track_sync_locked':
      return op.syncLocked ? `Sync-lock track ${op.track + 1}` : `Unsync track ${op.track + 1}`;
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

/** Clamp a normalised 0–1 value (D-132's crop insets), mirroring the Rust
 *  compositor's own `clamp(0.0, 1.0)` in `crop_pixel_rect`. `NaN` — what a
 *  numeric `<input>` produces when it is cleared — becomes `0`, i.e. "no
 *  crop on this edge", rather than propagating into the stored timeline. */
function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
}

export function applyOp(tl: Timeline, op: EditOp): Timeline {
  if (op.kind === 'add_clip') {
    const next = clone(tl);
    if (next.tracks.length === 0)
      next.tracks.push({ kind: 'video', clips: [], gain: DEFAULT_TRACK_GAIN, sync_locked: DEFAULT_SYNC_LOCKED });
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
        // B-033 — reject upfront (checked against the ORIGINAL, pre-clone
        // tracks) if a sync-locked track has a clip straddling the
        // insertion point; never auto-split. See the doc on
        // `findStraddlingSyncLockedTrack` for why.
        if (findStraddlingSyncLockedTrack(tl.tracks, trackIdx, startFrame) !== null) return tl;
        const dur = op.clip.duration;
        shiftClipsAtOrAfter(track, startFrame, dur);
        // D-106 — sync-locked tracks ripple too, same shift.
        propagateSyncLockRipple(next.tracks, trackIdx, startFrame, dur);
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
    // D-129 — the dropped source's own audio, as a second real clip on a
    // linked audio track. Placed AFTER the video half (and after any ripple
    // above) so `ensureAudioTrackWithRoom` sees the timeline's real final
    // shape: on a sync-locked audio track the ripple has already made the
    // same room there, so the existing track is normally reused; only when
    // it genuinely can't fit is a new track appended. Never fails — a fresh
    // track is always free — so there is no half-applied outcome here.
    if (op.linkedAudio) {
      const audioTrackIdx = ensureAudioTrackWithRoom(next, startFrame, op.linkedAudio.duration);
      const audioTrack = next.tracks[audioTrackIdx];
      const audioClip: Clip = { ...op.linkedAudio, start_frame: startFrame };
      const audioAt = audioTrack.clips.filter((c) => c.start_frame < startFrame).length;
      audioTrack.clips.splice(audioAt, 0, audioClip);
    }
    return next;
  }

  if (op.kind === 'unlink') {
    // Mirrors `chroma_timeline::Timeline::unlink` — dissolves the clip's
    // COMPLETE group, no-op when it isn't linked, refused on a locked track.
    const tr = tl.tracks[op.track];
    if (!tr || tr.locked) return tl;
    const group = tr.clips[op.clip]?.link_group;
    if (!group) return tl;
    const next = clone(tl);
    for (const t of next.tracks) {
      for (const c of t.clips) {
        if (c.link_group === group) c.link_group = null;
      }
    }
    return next;
  }

  if (op.kind === 'link') {
    // Mirrors `chroma_timeline::Timeline::link` — rejected whole (a no-op)
    // rather than partially applied, same discipline every link-aware op
    // here uses. `checkLink` is the single source of truth for why.
    const a: LinkTarget = { track: op.trackA, clip: op.clipA };
    const b: LinkTarget = { track: op.trackB, clip: op.clipB };
    if (!checkLink(tl, a, b).ok) return tl;
    const next = clone(tl);
    const trackA = next.tracks[op.trackA];
    const trackB = next.tracks[op.trackB];
    const clipA = trackA.clips[op.clipA];
    const clipB = trackB.clips[op.clipB];
    // Video-then-audio regardless of argument order, so `link(x, y)` and
    // `link(y, x)` produce the identical group id — mirrors the Rust op's
    // own order-independence.
    const [videoClip, audioClip] = trackA.kind === 'video' ? [clipA, clipB] : [clipB, clipA];
    const group = `lg-${videoClip.id}-${audioClip.id}`;
    clipA.link_group = group;
    clipB.link_group = group;
    return next;
  }

  // D-080 — track-list-level ops: none of these operate on "the clips of one
  // already-known track" the way the switch below's remaining ops do (`move`
  // spans two tracks; `add_track`/`remove_track` mutate the list itself), so
  // they're handled before the generic `tr = tl.tracks[op.track]` guard.
  if (op.kind === 'add_track') {
    // Mirrors `chroma_timeline::Timeline::add_track` — always succeeds.
    const next = clone(tl);
    next.tracks.push({ kind: op.trackKind, clips: [], gain: DEFAULT_TRACK_GAIN, sync_locked: DEFAULT_SYNC_LOCKED });
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
  if (op.kind === 'set_track_sync_locked') {
    if (op.track < 0 || op.track >= tl.tracks.length) return tl;
    const next = clone(tl);
    next.tracks[op.track].sync_locked = op.syncLocked;
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
    // D-132 — clamped here, on the way in, so a value out of the 0–1 inset
    // range can never reach `project.json`. The Rust compositor clamps again
    // at the point of use (it has to: `chroma_timeline_set` stores whatever
    // it is given, and MCP/agent writes don't come through this file), but
    // the UI's own writes should be well-formed at rest, not merely
    // survivable — the same reason `trim_end` clamps here rather than
    // leaving it all to the backend.
    nc.crop_left = clamp01(op.crop_left);
    nc.crop_top = clamp01(op.crop_top);
    nc.crop_right = clamp01(op.crop_right);
    nc.crop_bottom = clamp01(op.crop_bottom);
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
    // D-104 — overlap is rejected for EVERY move now, same-track or
    // cross-track alike (reverses D-096's cross-track allowance, see this
    // op's own doc comment for why). `i === op.clip` excludes the clip's own
    // current slot from the check — only meaningful for a same-track move,
    // a no-op filter for cross-track since the clip isn't in `dest.clips` yet.
    const overlaps = dest.clips.some((other, i) => {
      if (op.fromTrack === op.toTrack && i === op.clip) return false;
      return op.startFrame < endFrame(other) && newEnd > other.start_frame;
    });
    // D-104 — ripple only ever shifts clips starting AT/AFTER the landing
    // point (the real, edge-aligned case `resolveClipLanding` always
    // produces — computeInsertion's ripple positions are always an existing
    // clip's own start_frame or endFrame). A clip that starts BEFORE the
    // landing point but extends past it (straddling — not a real
    // ripple-insert scenario any NLE supports without splitting the clip
    // first) can't be cleared by this shift, so ripple can't rescue that
    // case either; reject the same as a non-ripple overlap rather than
    // leave a silently still-overlapping result.
    const straddles = dest.clips.some((other, i) => {
      if (op.fromTrack === op.toTrack && i === op.clip) return false;
      return other.start_frame < op.startFrame && endFrame(other) > op.startFrame;
    });
    // B-033 — same reject-on-straddle now also covers every OTHER
    // sync-locked track this move's ripple would touch, checked against
    // the ORIGINAL tracks before any mutation.
    const syncLockBlocked =
      overlaps && op.ripple && findStraddlingSyncLockedTrack(tl.tracks, op.toTrack, op.startFrame) !== null;
    if (overlaps && (!op.ripple || straddles || syncLockBlocked)) return tl;

    // D-129 — every other member of this clip's A/V link group moves by the
    // SAME delta, staying on its own track (Resolve's own "any change made to
    // one … automatically applies to the other"; a linked pair keeps sync, it
    // does not follow the video half onto the video half's new track).
    // Validated in full here, BEFORE any mutation, so a move that can't be
    // applied to every member is rejected whole rather than desyncing the
    // halves — the reject-rather-than-corrupt discipline B-033 established.
    // Mirrors `chroma-timeline::Timeline::move_clip`'s own link block.
    const rippleFires = overlaps && !!op.ripple;
    const delta = op.startFrame - c.start_frame;
    // `[track, clip id, where it must end up]` captured by STABLE id before
    // anything moves — the mutation below invalidates every clip index.
    const siblingTargets: Array<[number, string, number]> = [];
    const link = linkTargets(tl, op.fromTrack, op.clip);
    if (link) {
      for (const [ti, ci] of link.members) {
        if (ti === op.fromTrack && ci === op.clip) continue;
        const ot = tl.tracks[ti];
        if (ot.locked) return tl;
        const sib = ot.clips[ci];
        const target = sib.start_frame + delta;
        if (target < 0) return tl;
        siblingTargets.push([ti, sib.id, target]);
        // Whether THIS member's track receives the pending ripple — the same
        // predicate `propagateSyncLockRipple` uses, so the prediction here
        // and the real shift below can never disagree.
        const rippled =
          rippleFires && (ti === op.toTrack || ((ot.sync_locked ?? DEFAULT_SYNC_LOCKED) && !ot.locked));
        const sibEnd = target + sib.duration;
        const clash = ot.clips.some((o, i) => {
          // Other members of the same group shift by the same delta from a
          // non-overlapping start, so they can never collide with each other.
          if (i === ci || link.members.some(([mt, mc]) => mt === ti && mc === i)) return false;
          const os = startAfterRipple(o.start_frame, rippled, op.startFrame, c.duration);
          return target < os + o.duration && sibEnd > os;
        });
        if (clash) return tl;
      }
    }

    const next = clone(tl);
    const [moved] = next.tracks[op.fromTrack].clips.splice(op.clip, 1);
    const destClips = next.tracks[op.toTrack].clips;
    if (overlaps && op.ripple) {
      // D-104 — mirrors `add_clip`'s own ripple contract: everything on the
      // destination track at/after the landing point shifts later by this
      // clip's own duration to make room, rather than overlapping it.
      shiftClipsAtOrAfter(next.tracks[op.toTrack], op.startFrame, moved.duration);
    }
    moved.start_frame = op.startFrame;
    destClips.push(moved);
    // D-106 — propagate to every OTHER sync-locked track, same shift, only
    // when this move's own ripple actually fired.
    if (overlaps && op.ripple) {
      propagateSyncLockRipple(next.tracks, op.toTrack, op.startFrame, moved.duration);
    }
    // D-129 — place each linked sibling at the target computed (and fully
    // validated) above, resolved by its stable id rather than the index it
    // was validated with: splicing the primary out of `fromTrack` shifted
    // every later index there, and the ripple/sync shifts may have moved
    // siblings too. The target is absolute and already accounts for both, so
    // this is a plain assignment, never a second relative shift. Runs BEFORE
    // the prune below, while every track index is still the validated one.
    for (const [ti, sibId, target] of siblingTargets) {
      const sib = next.tracks[ti]?.clips.find((s) => s.id === sibId && s.id !== moved.id);
      if (sib) sib.start_frame = target;
    }
    // Auto-decommission — only the source track can have been emptied by a
    // cross-track move; a same-track move never changes clip *count* on
    // either track. Prune AFTER `toTrack`'s own mutations above, and before
    // returning, so the caller's own selection-remap sees the final shape.
    if (op.fromTrack !== op.toTrack) pruneIfEmptyTrack(next.tracks, op.fromTrack);
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
      // D-129 — deleting one member of an A/V link group deletes every
      // member (Resolve's own "…or deleting… automatically applies to the
      // other"). Refused whole if any member's track is locked; each emptied
      // track prunes, highest index first so lower ones stay valid. Mirrors
      // `chroma-timeline::Timeline::remove`.
      const link = linkTargets(tl, op.track, op.clip);
      if (link && link.members.some(([ti]) => tl.tracks[ti].locked)) return tl;
      const targets: Array<[number, number]> = link ? [...link.members] : [[op.track, op.clip]];
      targets.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
      const next = clone(tl);
      for (const [ti, ci] of targets) next.tracks[ti].clips.splice(ci, 1);
      const touched = [...new Set(targets.map(([ti]) => ti))].sort((a, b) => b - a);
      for (const ti of touched) pruneIfEmptyTrack(next.tracks, ti);
      return next;
    }
    case 'remove_gap': {
      // D-105 — mirrors `chroma-timeline::Timeline::remove_gap` exactly:
      // find the real gap `frame` is inside (`gapAt`), reject as a no-op if
      // there isn't one, otherwise shift every clip at/after the gap's end
      // earlier by its width.
      const gap = gapAt(tr, op.frame);
      if (!gap) return tl;
      const shift = gap.gapEnd - gap.gapStart;
      // B-033 — reject upfront if a sync-locked track has a straddling
      // clip, checked against the ORIGINAL (pre-clone) tracks.
      if (findStraddlingSyncLockedTrack(tl.tracks, op.track, gap.gapEnd) !== null) return tl;
      const next = clone(tl);
      shiftClipsAtOrAfter(next.tracks[op.track], gap.gapEnd, -shift);
      // D-106 — every OTHER sync-locked track ripples too, unconditionally
      // (not gated on THAT track having a matching gap — Resolve's own real
      // behavior; see `propagateSyncLockRipple`'s own doc). The gap-*finding*
      // requirement above (`gapAt`) stays exactly as-is for `op.track` only.
      propagateSyncLockRipple(next.tracks, op.track, gap.gapEnd, -shift);
      return next;
    }
    case 'trim_start': {
      // Mirrors `chroma-timeline::Timeline::trim_start` field-for-field: the
      // clip's *end* stays fixed — `source_start` and `start_frame` shift by
      // the same clamped delta, `duration` shrinks by it.
      const c = tr.clips[op.clip];
      if (!c) return tl;
      const d = clampedTrimStartDelta(tr, op.clip, op.delta);
      if (c.duration - d < 1) return tl;
      // D-129 — a linked clip trims in lockstep with every other member of
      // its group; if any member would clamp to a DIFFERENT delta (its own
      // source runs out first, a neighbour blocks it) the whole op is
      // rejected rather than leaving the halves out of sync. Unlink first for
      // a deliberate L-cut — that's what unlink is for, in both references.
      // Mirrors `chroma-timeline::Timeline::trim_start`.
      const link = linkTargets(tl, op.track, op.clip);
      if (link) {
        for (const [ti, ci] of link.members) {
          if (ti === op.track && ci === op.clip) continue;
          const ot = tl.tracks[ti];
          if (ot.locked) return tl;
          if (clampedTrimStartDelta(ot, ci, op.delta) !== d || ot.clips[ci].duration - d < 1) return tl;
        }
      }
      const next = clone(tl);
      const targets: Array<[number, number]> = link ? link.members : [[op.track, op.clip]];
      for (const [ti, ci] of targets) {
        const nc = next.tracks[ti].clips[ci];
        nc.source_start += d;
        nc.start_frame += d;
        nc.duration -= d;
      }
      return next;
    }
    case 'trim_end': {
      // Mirrors `chroma-timeline::Timeline::trim_end`: `start_frame` stays
      // fixed, only `duration` changes, clamped by both the source media's
      // remaining length and the nearest following clip's `start_frame` (no
      // overlap with it).
      const c = tr.clips[op.clip];
      if (!c) return tl;
      const newDur = clampedTrimEndDuration(tr, op.clip, op.delta);
      if (newDur === c.duration) return tl;
      const applied = newDur - c.duration;
      // D-129 — same lockstep-or-reject contract as `trim_start` above.
      const link = linkTargets(tl, op.track, op.clip);
      if (link) {
        for (const [ti, ci] of link.members) {
          if (ti === op.track && ci === op.clip) continue;
          const ot = tl.tracks[ti];
          if (ot.locked) return tl;
          if (clampedTrimEndDuration(ot, ci, op.delta) - ot.clips[ci].duration !== applied) return tl;
        }
      }
      const next = clone(tl);
      const targets: Array<[number, number]> = link ? link.members : [[op.track, op.clip]];
      for (const [ti, ci] of targets) next.tracks[ti].clips[ci].duration += applied;
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
      // D-129 — a razor through one member of a link group cuts every member
      // at the same frame ("clicking a linked clip with the Razor Tool cuts
      // both tracks at once"), producing two INTACT pairs: left halves keep
      // the group, right halves move to a derived one (`{group}·{frame}`,
      // matching the clip-id derivation already used here). Rejected whole if
      // the frame isn't strictly inside every member (an already-slipped
      // L-cut). Mirrors `chroma-timeline::Timeline::split`.
      const link = linkTargets(tl, op.track, op.clip);
      if (link) {
        for (const [ti, ci] of link.members) {
          if (ti === op.track && ci === op.clip) continue;
          const ot = tl.tracks[ti];
          if (ot.locked) return tl;
          const o = ot.clips[ci];
          const off = op.atFrame - o.start_frame;
          if (off <= 0 || off >= o.duration) return tl;
        }
      }
      const rightGroup = link ? `${link.group}·${op.atFrame}` : null;
      const next = clone(tl);
      // Descending, so inserting each right half at `ci + 1` never shifts an
      // index still to be processed (only matters when two members share a
      // track — possible for a richer group, harmless for a plain pair).
      const targets: Array<[number, number]> = link ? [...link.members] : [[op.track, op.clip]];
      targets.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
      for (const [ti, ci] of targets) {
        const clips = next.tracks[ti].clips;
        const left = clips[ci];
        const off = op.atFrame - left.start_frame;
        const right: Clip = {
          ...left,
          id: `${left.id}·${op.atFrame}`,
          link_group: rightGroup,
          start_frame: left.start_frame + off,
          source_start: left.source_start + off,
          duration: left.duration - off,
        };
        left.duration = off;
        clips.splice(ci + 1, 0, right);
      }
      return next;
    }
    default:
      return tl;
  }
}
