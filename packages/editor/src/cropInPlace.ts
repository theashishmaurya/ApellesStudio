/**
 * @apelles/editor — crop that leaves the picture where it is (v0.3.0 panel
 * redesign, B-366, D-443): the geometry behind the viewer's crop mode
 * (`CropOverlay`) and the Inspector's L · R · T · B fields.
 *
 * **Why this exists.** The compositor resizes a crop's sub-image INTO the
 * clip's box (B-218): the box keeps its width (`natural.width * scale`) and
 * takes the cropped aspect for its height. So writing `crop_left = 0.12` alone
 * makes the remaining 88 % of the picture zoom up to fill the old width: the
 * edge you dragged does not stay under your pointer. Final Cut's Trim crop —
 * the model the owner approved ("crop should be interactive", FCP's) — trims
 * the edge and leaves everything else exactly where it was. This module turns
 * a new set of insets into the one `set_clip_transform` patch that does that:
 * the new crop plus the `position` / `scale` (or `box_width` / `box_height`)
 * that put the kept part of the picture on the same pixels it already
 * occupied.
 *
 * **The geometry.** A painted box `B` shows the kept part of the source, so
 * the whole uncropped source spans `S = B` grown by the insets (`S.width =
 * B.width / (1 − left − right)`, and so on). A new crop's kept part is the
 * sub-rectangle of that same `S`; it becomes the new box. With no size
 * override, `scale = box.width / natural.width` (the height follows by
 * itself: `natural.height * scale * keptV / keptH` is exactly the kept
 * height), and `position = box.left − origin` (D-338 top-left, B-328 fit
 * origin). With an override, the new box is written as the override.
 *
 * **What it does NOT do.** Compensate an animated clip or a rotated one: when
 * `position`, `scale` or the crop itself is keyframed, or `rotation ≠ 0`, the
 * caller writes the crop alone (the pre-D-443 behaviour) — moving a keyframed
 * box would need a key per frame, and a rotated box pivots on its centre,
 * which a re-centred box would move. `cropCanKeepPicture` is that test. No
 * React, no I/O.
 */
import { hasParamKeyframes, mergeClipKeyframeParams, resolveClipBoxTransform } from './clipKeyframes';
import type { Clip, EditOp } from './timeline';
import { clipBoxOrigin, paintedClipBox, type FractionBox } from './transformGeometry';

/** The four insets, each a fraction of the source trimmed off that edge. */
export interface CropInsetValues {
  crop_left: number;
  crop_top: number;
  crop_right: number;
  crop_bottom: number;
}

export type CropEdge = keyof CropInsetValues;

export const CROP_EDGES: readonly CropEdge[] = ['crop_left', 'crop_right', 'crop_top', 'crop_bottom'];

/** The least of the source a crop may keep on either axis: 2 %. A crop that
 *  kept nothing would leave no box to grab and divide by zero below. */
export const MIN_CROP_KEEP = 0.02;

/** `next` with every inset in `[0, 1]` and at least `MIN_CROP_KEEP` kept per
 *  axis — the edge named by `moved` gives way, so dragging one edge into the
 *  other stops at the minimum instead of pushing it. */
export function clampCropInsets(next: CropInsetValues, moved?: CropEdge): CropInsetValues {
  const c = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
  const out: CropInsetValues = {
    crop_left: c(next.crop_left),
    crop_top: c(next.crop_top),
    crop_right: c(next.crop_right),
    crop_bottom: c(next.crop_bottom),
  };
  const fit = (a: 'crop_left' | 'crop_top', b: 'crop_right' | 'crop_bottom') => {
    const over = out[a] + out[b] - (1 - MIN_CROP_KEEP);
    if (over <= 0) return;
    if (moved === b) out[b] -= over;
    else out[a] = Math.max(0, out[a] - over);
  };
  fit('crop_left', 'crop_right');
  fit('crop_top', 'crop_bottom');
  return out;
}

/** The whole uncropped source's rectangle, given the painted box and its crop. */
export function cropSourceRect(box: FractionBox, crop: CropInsetValues): FractionBox {
  const keptH = Math.max(MIN_CROP_KEEP, 1 - crop.crop_left - crop.crop_right);
  const keptV = Math.max(MIN_CROP_KEEP, 1 - crop.crop_top - crop.crop_bottom);
  const width = box.width / keptH;
  const height = box.height / keptV;
  return { left: box.left - crop.crop_left * width, top: box.top - crop.crop_top * height, width, height };
}

/** The part of `source` a crop keeps. */
export function cropKeptRect(source: FractionBox, crop: CropInsetValues): FractionBox {
  return {
    left: source.left + crop.crop_left * source.width,
    top: source.top + crop.crop_top * source.height,
    width: source.width * (1 - crop.crop_left - crop.crop_right),
    height: source.height * (1 - crop.crop_top - crop.crop_bottom),
  };
}

/** Whether a crop on this clip can keep the picture in place (see the module
 *  doc): nothing keyframed among position / scale / crop, and no rotation. */
export function cropCanKeepPicture(state: { animated: boolean; rotation: number }): boolean {
  return !state.animated && state.rotation === 0;
}

/** The transform fields a crop-in-place writes besides the insets. */
export type CropPlacement =
  | { position_x: number; position_y: number; scale: number }
  | { position_x: number; position_y: number; box_width: number; box_height: number };

/**
 * The placement that keeps the picture where it is under `next`.
 *
 * `box` is the clip's painted box now (composition fractions, from
 * `clipBoxFraction` + `resolvedBoxSize`), `crop` its current insets,
 * `natural` its scale-1 footprint, `origin` its fit origin (`clipBoxOrigin`),
 * `override` whether it carries `box_width` / `box_height`.
 */
export function cropPlacement(input: {
  box: FractionBox;
  crop: CropInsetValues;
  next: CropInsetValues;
  natural: { width: number; height: number };
  origin: { x: number; y: number };
  override: boolean;
}): CropPlacement {
  const kept = cropKeptRect(cropSourceRect(input.box, input.crop), input.next);
  if (input.override) {
    return { position_x: kept.left, position_y: kept.top, box_width: kept.width, box_height: kept.height };
  }
  return {
    position_x: kept.left - input.origin.x,
    position_y: kept.top - input.origin.y,
    scale: input.natural.width > 0 ? kept.width / input.natural.width : 1,
  };
}

/** Whether any keyframe names `key` (a box size override is keyframeable
 *  without being a `ClipKeyframeParam`). */
function keyed(clip: Pick<Clip, 'chroma_keyframes'>, key: string): boolean {
  return (clip.chroma_keyframes ?? []).some((k) => Object.prototype.hasOwnProperty.call(k.params, key));
}

/**
 * The ONE op a crop edit writes, for the viewer's crop handles and the
 * Inspector's L · R · T · B fields alike (D-443).
 *
 * - A **keyframed crop**: the new insets keyed at the playhead
 *   (`set_clip_keyframes`), the D-208 rule for editing an animated property.
 * - A **static crop on a clip that can keep its picture** (nothing keyframed
 *   among position / scale / size, no rotation, geometry known): one
 *   `set_clip_transform` with the insets AND the placement that leaves the
 *   kept picture where it was (`cropPlacement`).
 * - Otherwise: the insets alone, in one `set_clip_transform`.
 *
 * `next` is clamped (`clampCropInsets`, `moved` gives way). `null` when the
 * clip is a title (no crop) or nothing changes.
 */
export function cropEditOp(
  target: { track: number; index: number; clip: Clip },
  sourceFrame: number,
  natural: { width: number; height: number } | null,
  next: CropInsetValues,
  moved?: CropEdge,
): EditOp | null {
  const { clip } = target;
  if (clip.text || clip.caption || clip.adjustment) return null;
  const crop = clampCropInsets(next, moved);
  const effective = resolveClipBoxTransform(clip, sourceFrame);
  const current: CropInsetValues = {
    crop_left: effective.crop_left,
    crop_top: effective.crop_top,
    crop_right: effective.crop_right,
    crop_bottom: effective.crop_bottom,
  };
  if (CROP_EDGES.every((e) => current[e] === crop[e])) return null;

  const kfs = clip.chroma_keyframes;
  if (CROP_EDGES.some((e) => hasParamKeyframes(kfs, e))) {
    return {
      kind: 'set_clip_keyframes',
      track: target.track,
      clip: target.index,
      keyframes: mergeClipKeyframeParams(kfs, sourceFrame, { ...crop }),
    };
  }

  const base: Extract<EditOp, { kind: 'set_clip_transform' }> = {
    kind: 'set_clip_transform',
    track: target.track,
    clip: target.index,
    opacity: clip.opacity ?? 1,
    position_x: clip.position_x ?? 0,
    position_y: clip.position_y ?? 0,
    scale: clip.scale ?? 1,
    box_width: clip.box_width ?? null,
    box_height: clip.box_height ?? null,
    rotation: clip.rotation ?? 0,
    corner_radius: clip.corner_radius ?? 0,
    ...crop,
  };
  const placementAnimated =
    hasParamKeyframes(kfs, 'position_x') ||
    hasParamKeyframes(kfs, 'position_y') ||
    hasParamKeyframes(kfs, 'scale') ||
    hasParamKeyframes(kfs, 'rotation') ||
    keyed(clip, 'box_width') ||
    keyed(clip, 'box_height');
  if (!natural || !cropCanKeepPicture({ animated: placementAnimated, rotation: clip.rotation ?? 0 })) return base;

  const override = effective.box_width !== null || effective.box_height !== null;
  const box = paintedClipBox(clip, natural, effective);
  return {
    ...base,
    ...cropPlacement({
      box,
      crop: current,
      next: crop,
      natural,
      origin: clipBoxOrigin(clip, natural, { width: effective.box_width, height: effective.box_height }),
      override,
    }),
  };
}
