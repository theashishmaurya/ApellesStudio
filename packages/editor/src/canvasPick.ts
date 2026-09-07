/**
 * @chroma/editor — pure hit-testing for canvas click-to-select (D-204, fixing
 * B-085; Open Question 3 of `docs/notes/on-canvas-transform.md`, answered).
 * The DOM/pointer half — when a press counts as a selection at all — is
 * `useCanvasClipPick.ts`; this file is only the geometry it asks.
 *
 * **What it is.** Given the timeline, the playhead, and one point in
 * COMPOSITION-FRACTION space (the unit `transformGeometry.ts` documents), it
 * answers "which clip's own rendered picture is under the pointer?" — the
 * missing half of D-136's on-canvas transform, whose `TransformOverlay` only
 * ever *reflected* a timeline-side selection and so could never be reached by
 * clicking the picture itself (B-085, reported live by the owner: "not able
 * to click on a clip in canvas to resize it, need to click from timeline").
 *
 * **It mirrors the compositor, it does not guess.** Both halves are a
 * deliberate one-to-one mirror of the Rust that actually paints the preview:
 *
 *   - `visibleVideoLayersAt` mirrors `Timeline::resolve_visible_video_layers_at`
 *     (`crates/chroma-timeline/src/lib.rs`) exactly — video tracks only, a
 *     `hidden` track contributes nothing, and a track with a gap at that frame
 *     contributes nothing. It returns layers in **track-index-ascending order,
 *     which is topmost-first**: `composite_video_frame` decodes in that order
 *     and PAINTS IN REVERSE (lowest priority at the back), so track 0's clip
 *     is the one a human sees on top and therefore the one a click must pick.
 *   - the box each layer is tested against is `transformGeometry.ts`'s own
 *     `clipBoxFraction(resolvedBoxSize(...))` — literally the same call
 *     `TransformOverlay` makes to DRAW its box at rest, so a click can never
 *     select a clip whose handles then appear somewhere else.
 *
 * **What it deliberately does NOT model** (each matching an existing,
 * documented limit of the overlay it feeds, not a new one invented here):
 *
 *   - **Keyframes.** A clip's per-frame animated transform lives in
 *     `chroma_keyframes` and is resolved by Rust at render time
 *     (`resolve_clip_transform`); `clipKeyframes.ts`'s own doc states that
 *     interpolation stays the engine's job. So this tests the clip's STATIC
 *     base transform — exactly the box `TransformOverlay` already draws, and
 *     exactly the field an on-canvas drag already writes. A keyframed clip's
 *     hit rect can therefore differ from its painted position mid-animation;
 *     that is the overlay's own pre-existing behaviour, made no worse here.
 *   - **Crop.** `composite_layer_onto` crops a layer's pixels in place
 *     without shrinking its footprint (D-132), so the bounding box is
 *     unchanged by crop — `FractionBox`'s own doc says so, and Phase 1 has no
 *     crop handles at all. A heavily-cropped clip is therefore clickable
 *     across its whole uncropped footprint, the same area its transform box
 *     already covers.
 *   - **Rotation and per-pixel alpha.** The test is an axis-aligned
 *     rectangle, like every reference NLE's own program-monitor pick against
 *     a layer's bounding box. Rotation is Phase 2 and unbuilt.
 *
 * Pure and node-testable, kept out of the component for the same reason
 * `transformGeometry.ts` is (this package's vitest environment is bare
 * `node`) — see `canvasPick.test.ts`.
 */

import { clipAt, timelineFps, type Clip, type Timeline } from './timeline';
import { clipBoxFraction, fractionBoxContains, resolvedBoxSize, type FractionBox } from './transformGeometry';

/** One video layer visible at some frame, identified the way every per-clip
 *  command on this surface already identifies one: by track index + clip
 *  index (`chroma_timeline_clip_geometry`, the `set_clip_transform` op) plus
 *  the clip's own stable `id`, which is what `Selection` is keyed on. */
export interface CanvasLayer {
  track: number;
  clipIndex: number;
  clip: Clip;
}

/**
 * Every video layer with picture at `frame`, **topmost first** (track 0 is
 * the top of the stack) — the TS mirror of Rust's
 * `Timeline::resolve_visible_video_layers_at`, including its two exclusions:
 * a non-video track, and a `hidden` one.
 *
 * A `locked` track is deliberately still included: locking protects a track's
 * clips from being *edited*, not from being selected — `TimelinePane` lets
 * you select a locked clip today and `TransformOverlay` draws its box and
 * simply refuses to drag it. A canvas click behaves identically.
 */
export function visibleVideoLayersAt(tl: Timeline | null, frame: number): CanvasLayer[] {
  if (!tl) return [];
  const fps = timelineFps(tl);
  const layers: CanvasLayer[] = [];
  tl.tracks.forEach((track, i) => {
    if (track.kind !== 'video' || track.hidden) return;
    const found = clipAt(track, frame, fps);
    if (found) layers.push({ track: i, clipIndex: found.index, clip: found.clip });
  });
  return layers;
}

/** A layer plus the source footprint `chroma_timeline_clip_geometry` reports
 *  for it. `natural: null` means that probe hasn't resolved (or failed — e.g.
 *  offline media): such a layer has no knowable box and is skipped by
 *  `pickTopmostLayer` rather than guessed at, the same `null`-means-"nothing
 *  to show yet" fallback `useClipGeometry`'s own doc already establishes. */
export interface PickCandidate extends CanvasLayer {
  natural: { width: number; height: number } | null;
}

/** The clip's on-canvas bounding box in composition fractions — the SAME
 *  expression `TransformOverlay` draws its at-rest box from (see this
 *  module's doc). */
export function layerBoxFraction(clip: Clip, natural: { width: number; height: number }): FractionBox {
  return clipBoxFraction(
    resolvedBoxSize(natural, clip.scale ?? 1, { width: clip.box_width, height: clip.box_height }),
    { x: clip.position_x ?? 0, y: clip.position_y ?? 0 },
    1,
  );
}

/**
 * The topmost layer whose box contains `point`, or `null` for a click on
 * empty canvas.
 *
 * `candidates` must already be in `visibleVideoLayersAt`'s topmost-first
 * order; this walks it in order and returns the FIRST hit, which is what
 * makes "topmost wins" true rather than "whichever the loop happened to
 * reach last". A layer whose geometry hasn't resolved is skipped — it does
 * not block a lower layer from being picked, since an unknown box is not the
 * same as a covering one.
 */
export function pickTopmostLayer(
  point: { x: number; y: number },
  candidates: readonly PickCandidate[],
): CanvasLayer | null {
  for (const c of candidates) {
    if (!c.natural) continue;
    if (fractionBoxContains(layerBoxFraction(c.clip, c.natural), point)) {
      return { track: c.track, clipIndex: c.clipIndex, clip: c.clip };
    }
  }
  return null;
}
