/**
 * @apelles/editor — pure geometry for `TransformOverlay.tsx` (D-136, Phase 1
 * of `docs/notes/on-canvas-transform.md`).
 *
 * Kept apart from the component on purpose: this package's vitest config
 * runs in a bare `node` environment (no DOM, no pointer events) — the same
 * reason `ruler.ts`/`clipKeyframes.ts` are split from the components that
 * consume them. The pointer-event wiring in `TransformOverlay.tsx` is not
 * unit-tested; this math, which is where an off-by-one would actually hide,
 * is.
 *
 * Every fraction below is COMPOSITION space (D-136): `0,0` the project
 * composition's top-left, `1,1` its bottom-right, independent of preview
 * resolution — exactly the unit `Clip.position_x`/`position_y`/`scale`
 * already use post-migration, and the unit `chroma_timeline_clip_geometry`'s
 * `naturalWidth`/`naturalHeight` report a clip's own source footprint in
 * (see that command's Rust-side doc, `chroma::edit::ClipGeometry`). A
 * `ContentBox` (`@apelles/player`'s `useContentBox`) then maps that fraction
 * space onto real screen pixels — see `boxToScreenRect`.
 *
 * **D-204 (B-085) — a second consumer.** `canvasPick.ts` (canvas
 * click-to-select) hit-tests a pointer against every visible layer's own box,
 * which has to be the SAME box `TransformOverlay` draws or a click could
 * select a clip whose handles then appear somewhere else. `resolvedBoxSize`
 * + `fractionBoxContains` below are that shared rule, extracted here rather
 * than re-derived in either component.
 */

import type { Clip } from './timeline';

export interface ContentBoxLike {
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

/** A clip's placement box in COMPOSITION-FRACTION space — mirrors exactly
 *  what `chroma::edit::composite_layer_onto` computes in canvas pixels
 *  (`x = position_x*cw`, `y` likewise) and what `timelineExport.ts` compiles
 *  to `overlay=x='<position_x>*W'`, just undivided by the canvas size.
 *  D-338 (fixes B-201) — `position_*` is the box's TOP-LEFT corner in all
 *  three; it used to be a centre offset here and in the Rust compositor while
 *  already being the top-left corner in the exporter.
 *
 *  Crop DOES reach this box, through [`resolvedBoxSize`]'s height (B-218):
 *  `composite_layer_onto` resizes the crop's sub-image into the box, so a
 *  cropped clip's box carries the CROPPED aspect ratio, not the source's.
 *  (Until B-218 was fixed the preview cropped a layer's pixels in place
 *  without shrinking its footprint, and this box correctly ignored the insets
 *  for that reason — the comment that used to sit here.) Phase 1 still builds
 *  no crop HANDLES (see the note's own phasing); the box just has to describe
 *  the rectangle that is actually painted. */
export interface FractionBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The smallest scale a corner drag is allowed to produce. Not `0` (or
 *  anything close): a box shrunk to a handful of screen pixels is one no
 *  pointer can grab a handle on to grow back — this is a usability floor on
 *  the DRAG, not a value-correctness one (the compositor itself already
 *  floors a layer at 1 raw pixel via `.max(1.0)`, `edit.rs`'s
 *  `composite_layer_onto`; the numeric Inspector field is free to go lower
 *  by typing). */
export const MIN_DRAG_SCALE = 0.02;

/** What `position_x`/`position_y` names for one clip's box (D-338).
 *
 *  - `'top-left'` — the box's own top-left corner, as a fraction of the
 *    composition. Every media layer. Mirrors `composite_layer_onto`'s
 *    `x = position_x * cw` and the exporter's `overlay=x='<position_x>*W'`.
 *  - `'composition-centre'` — an offset from the composition's centre, with
 *    the box centred there at `position 0,0`. **A TEXT clip only**, and not a
 *    leftover: a title's layer is RASTERISED AT CANVAS SIZE with its ink
 *    centred inside it (`chroma::text::render_text_layer`), and only then
 *    offset by `position_*`. So the ink a user sees really does start centred
 *    and move from there, which is exactly what ffmpeg's `drawtext` does on
 *    the export side too (`x='(w-text_w)/2+w*(position_x)'`). Both engines
 *    already agreed about titles before D-338 and still do — a title's
 *    canvas-sized layer makes `cw/2 - cw/2 + px*cw` and `px*cw` the same
 *    expression — so this is the one place where drawing a centre-anchored
 *    box is CORRECT rather than the B-201 bug. B-130 is the regression test. */
export type BoxAnchor = 'top-left' | 'composition-centre';

/** Which anchor a clip's box uses — the ONE place that decision lives, so the
 *  drawn overlay box (`TransformOverlay`) and the click hit-rect
 *  (`canvasPick.ts`) can never disagree about it. Same reasoning as
 *  [`resolvedBoxSize`]'s own extraction (D-204/B-085). */
export function clipBoxAnchor(clip: Pick<Clip, 'text'>): BoxAnchor {
  return clip.text ? 'composition-centre' : 'top-left';
}

/** The clip's bounding box, in composition fractions, at its current
 *  `position`/`scale` and (unscaled) `natural` footprint.
 *
 *  D-338 — under the default `'top-left'` anchor `position` IS the box's
 *  top-left corner, so `left`/`top` are that position verbatim and the box's
 *  size never moves it. That is what makes a drawn box, a click hit-rect
 *  (`canvasPick.ts`), the Rust preview and the ffmpeg export all agree on one
 *  rectangle; see the interface doc above. See [`BoxAnchor`] for the one kind
 *  of clip that is genuinely centre-anchored and why. */
export function clipBoxFraction(
  natural: { width: number; height: number },
  position: { x: number; y: number },
  scale: number,
  anchor: BoxAnchor = 'top-left',
): FractionBox {
  const width = natural.width * scale;
  const height = natural.height * scale;
  return anchor === 'composition-centre'
    ? { left: 0.5 - width / 2 + position.x, top: 0.5 - height / 2 + position.y, width, height }
    : { left: position.x, top: position.y, width, height };
}

/** The box's own centre, in composition fractions — the pivot a corner drag
 *  scales about (see [`dragCornerScale`]). Per anchor, because the centre of a
 *  top-left-anchored box moves with its size and the centre of a
 *  composition-centred one does not. */
export function boxCentre(
  natural: { width: number; height: number },
  position: { x: number; y: number },
  scale: number,
  anchor: BoxAnchor = 'top-left',
): { x: number; y: number } {
  const box = clipBoxFraction(natural, position, scale, anchor);
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

/** A clip's four crop insets, each a fraction of the clip trimmed off that
 *  edge — the shape [`resolvedBoxSize`] needs to derive an unoverridden
 *  height. Every field optional so a caller with no crop concept (a title, a
 *  caption) can pass nothing. */
export interface CropInsets {
  left?: number | null;
  top?: number | null;
  right?: number | null;
  bottom?: number | null;
}

/** The clip's box SIZE (composition fractions) at rest, i.e. with no drag in
 *  flight.
 *
 *  - **width** — `box_width` when the clip has one (D-193,
 *    `docs/notes/independent-clip-size.md`), else `natural.width * scale`.
 *    Crop-independent, matching both engines.
 *  - **height** — `box_height` when the clip has one, else the WIDTH times
 *    the clip's CROPPED aspect ratio (B-218). That is what
 *    `timelineExport.ts` asks ffmpeg for in the same case (`h='-2'`) and what
 *    `ClipTransform::effective_size` now computes in the Rust compositor. For
 *    an uncropped clip with no `box_width` it is exactly `natural.height *
 *    scale`, the pre-B-218 formula, which is why the overwhelming majority of
 *    clips draw the same box they always did.
 *
 *  Mirrors `ClipTransform::effective_size` (Rust, `chroma::edit`) — the
 *  compositor's own per-axis resolution of the same inputs. Extracted as its
 *  own function by D-204 because two frontend consumers need exactly this:
 *  `TransformOverlay.tsx`'s static box, and `canvasPick.ts`'s click-to-select
 *  hit rect. A hit rect that disagreed with the drawn box by even one of these
 *  rules would let a click land "on" a clip the handles aren't drawn around,
 *  so this is the one place the rule lives. */
export function resolvedBoxSize(
  natural: { width: number; height: number },
  scale: number,
  override: { width?: number | null; height?: number | null },
  crop?: CropInsets,
): { width: number; height: number } {
  const width = override.width ?? natural.width * scale;
  if (override.height != null) return { width, height: override.height };
  // Clamped per edge exactly as `crop_pixel_rect` clamps them, so a nonsense
  // inset can never make a kept fraction negative.
  const kept = (near: number | null | undefined, far: number | null | undefined): number =>
    Math.max(0, 1 - Math.min(Math.max(near ?? 0, 0), 1) - Math.min(Math.max(far ?? 0, 0), 1));
  const croppedWidth = natural.width * kept(crop?.left, crop?.right);
  return {
    width,
    height:
      croppedWidth > 0
        ? (width * natural.height * kept(crop?.top, crop?.bottom)) / croppedWidth
        : natural.height * scale,
  };
}

/** `box` shifted by `delta` (composition fractions) — what the live overlay
 *  draws while a MOVE drag is in flight for a consumer whose rectangle is
 *  given explicitly rather than derived from `natural * scale` (D-316's
 *  caption box; see `TransformBox`'s `model` prop).
 *
 *  A video clip's box needs no such function: its box is recomputed from the
 *  dragged `position` through `clipBoxFraction`, which already IS this
 *  translation. A caption's box is measured, not derived, so the same
 *  translation has to be applied to the measured rectangle. */
export function translateFractionBox(box: FractionBox, delta: { x: number; y: number }): FractionBox {
  return { left: box.left + delta.x, top: box.top + delta.y, width: box.width, height: box.height };
}

/** `box` scaled uniformly by `factor` about `pivot` (both composition
 *  fractions).
 *
 *  D-316 — the caption half of the same pair as [`translateFractionBox`]. A
 *  caption's whole rendered box really is a uniform scale about its style's
 *  own `(position_x, position_y)` anchor as its font size changes: every
 *  distance in `CaptionLayout` (the advance widths, the line box, the line
 *  step, the background padding) is proportional to the resolved font size,
 *  and the anchor itself is not — see `CaptionLayout::bounds`' own
 *  `bounds_scale_uniformly_about_the_style_anchor` test, which pins that
 *  property on the Rust side so this function is allowed to assume it. */
export function scaleFractionBoxAbout(
  box: FractionBox,
  pivot: { x: number; y: number },
  factor: number,
): FractionBox {
  const k = Number.isFinite(factor) ? factor : 1;
  return {
    left: pivot.x + (box.left - pivot.x) * k,
    top: pivot.y + (box.top - pivot.y) * k,
    width: box.width * k,
    height: box.height * k,
  };
}

/** Whether `point` (composition fractions) is inside `box` — half-open on the
 *  right/bottom edges, the same convention `Track::clip_at`'s own
 *  `start <= f < end` frame test uses, so two exactly-abutting boxes can
 *  never both claim the same point. */
export function fractionBoxContains(box: FractionBox, point: { x: number; y: number }): boolean {
  return (
    point.x >= box.left &&
    point.x < box.left + box.width &&
    point.y >= box.top &&
    point.y < box.top + box.height
  );
}

/** `box` (composition fractions) placed onto real screen pixels, relative to
 *  the same container `contentBox` was measured against — what an
 *  `absolute` overlay child's CSS `left`/`top`/`width`/`height` should be
 *  set to. */
export function boxToScreenRect(box: FractionBox, contentBox: ContentBoxLike) {
  return {
    left: contentBox.offsetX + box.left * contentBox.width,
    top: contentBox.offsetY + box.top * contentBox.height,
    width: box.width * contentBox.width,
    height: box.height * contentBox.height,
  };
}

/** The inverse of `boxToScreenRect`'s position half — a point in the SAME
 *  local container coordinates that function's output lives in (i.e.
 *  already `clientX - container.getBoundingClientRect().left`, etc.) mapped
 *  back to composition-fraction space. What a drag's pointer position is
 *  converted through on every move. */
export function screenToFraction(point: { x: number; y: number }, contentBox: ContentBoxLike): { x: number; y: number } {
  return {
    x: contentBox.width > 0 ? (point.x - contentBox.offsetX) / contentBox.width : 0,
    y: contentBox.height > 0 ? (point.y - contentBox.offsetY) / contentBox.height : 0,
  };
}

/** Body drag: the pointer moved from `startPoint` to `currentPoint` (both
 *  already `screenToFraction`-converted) — the new `position_x`/
 *  `position_y` is `startPosition` shifted by exactly that delta. A delta,
 *  not "position = pointer", so grabbing anywhere on the box doesn't snap
 *  its centre to the cursor. */
export function dragReposition(
  startPoint: { x: number; y: number },
  currentPoint: { x: number; y: number },
  startPosition: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: startPosition.x + (currentPoint.x - startPoint.x),
    y: startPosition.y + (currentPoint.y - startPoint.y),
  };
}

/** Corner drag, the SCALE half: uniform scale about the box's own centre
 *  (`center`, in composition fractions — `position + size/2`, where `size` is
 *  the box's own `natural * scale`; `clipBoxFraction`'s `left`/`top` are the
 *  position verbatim since D-338, so the centre is no longer the constant
 *  `0.5 + position` it was while the box was centre-anchored).
 *
 *  The centre is still the only pivot the gesture uses — there is no anchor
 *  point field yet (Phase 2) and all four handles drive the same uniform math
 *  — but since D-338 the compositor anchors a layer at its TOP-LEFT, so
 *  holding the centre still takes a compensating `position` write as well:
 *  that is [`dragCornerReposition`], and the two are always used as a pair.
 *
 *  The new scale is the ratio of the pointer's current distance from
 *  `center` to its distance when the drag started — corner-distance-from-
 *  pivot grows/shrinks the box, the same relationship Premiere's and
 *  Resolve's own corner-scale handles use (see the note's "Real references
 *  checked" section). Floored at `MIN_DRAG_SCALE`. */
export function dragCornerScale(
  center: { x: number; y: number },
  startPoint: { x: number; y: number },
  currentPoint: { x: number; y: number },
  startScale: number,
): number {
  const startDist = Math.hypot(startPoint.x - center.x, startPoint.y - center.y);
  if (startDist <= 0) return startScale;
  const currentDist = Math.hypot(currentPoint.x - center.x, currentPoint.y - center.y);
  return Math.max(MIN_DRAG_SCALE, startScale * (currentDist / startDist));
}

/** Corner drag, the POSITION half (D-338): the top-left `position` that keeps
 *  the box's centre exactly where it was while its scale goes from
 *  `startScale` to `scale`.
 *
 *  **Why this exists at all.** Before D-338 a box was drawn centred on
 *  `0.5 + position`, so growing `scale` alone already grew it about its own
 *  centre and a corner drag never had to touch `position`. `position` is now
 *  the box's top-left corner in both renderers (B-201 — the exporter always
 *  read it that way), which means `scale` alone grows a box down and to the
 *  right. Keeping the corner-drag gesture itself unchanged for a human —
 *  every reference NLE scales about the anchor, and ours sits at the centre
 *  until there is a real anchor-point field — therefore takes this explicit
 *  half-a-size-delta shift, which the caller commits alongside the new scale.
 *
 *  Pure: `natural` is the box's UNSCALED footprint, so `natural * s` is its
 *  size at scale `s` and the centre is `position + natural * s / 2`. Setting
 *  the two centres equal and solving for the new position gives exactly the
 *  shift below. */
export function dragCornerReposition(
  startPosition: { x: number; y: number },
  natural: { width: number; height: number },
  startScale: number,
  scale: number,
  anchor: BoxAnchor = 'top-left',
): { x: number; y: number } {
  // A composition-centred box (a title — see `BoxAnchor`) already grows about
  // its own centre with `position` untouched, so there is nothing to
  // compensate; returning `startPosition` keeps this one function total
  // rather than making every caller remember the exception.
  if (anchor === 'composition-centre') return startPosition;
  const delta = scale - startScale;
  return {
    x: startPosition.x - (natural.width * delta) / 2,
    y: startPosition.y - (natural.height * delta) / 2,
  };
}
