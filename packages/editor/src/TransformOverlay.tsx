/**
 * @chroma/editor — on-canvas transform handles for the Edit-tab preview
 * (D-136, Phase 1 of `docs/notes/on-canvas-transform.md`). The owner's
 * original ask: "the player is canvas — once I have another video I can
 * select, drag and make it smaller or larger, PIP etc."
 *
 * Renders as a sibling of `PreviewPane.tsx`'s `<img>`, absolutely positioned
 * over the same wrapper `<div>` — no `@chroma/player` change needed, `Player`
 * already accepts an arbitrary `surface` ReactNode (see that package's own
 * contract doc). Draws a box + corner handles for the ONE selected clip
 * (`useEditorTimelineStore.selection`, D-107/D-118) — nothing when
 * `selection.length !== 1`, the same Phase-1 multi-select fallback every
 * other single-clip-only consumer in this tab already applies
 * (`EditorInspectorPanel.tsx`). **This component only ever REFLECTS a
 * selection, never sets it** — still true after D-204: clicking the picture
 * to select is now built (B-085), but it lives in `useCanvasClipPick.ts`, a
 * capture-phase listener on the shared surface. That hook explicitly stands
 * aside for a press on the already-selected clip's own picture, and for any
 * press on a `data-transform-handle` corner, so every drag below behaves
 * exactly as it did before.
 *
 * **The box's geometry is composition-fraction space (D-136), not screen
 * pixels or canvas pixels.** `chroma_timeline_clip_geometry` (Rust,
 * `chroma::edit::clip_geometry`) is the one thing the frontend cannot derive
 * on its own — a clip's own source resolution, measured against the
 * project's composition — everything else (`position_x`/`position_y`/
 * `scale`) is already a normalised fraction on `Clip` itself post-migration.
 * `transformGeometry.ts` does the actual fraction<->screen-pixel math (pure,
 * unit-tested there — this component is DOM/pointer wiring around it, not
 * itself unit-tested, matching this package's `node`-only vitest
 * environment).
 *
 * **Live overlay-only feedback during a drag; ONE write op on pointer-up**
 * (`set_clip_transform`, or — since D-209 — `set_clip_keyframes` for whichever
 * of the dragged properties is already animated; see `commit` below).
 * Mirrors `RelightPuckLayer.tsx`/D-046's own pattern, which
 * exists for exactly this reason (Phase 0b of the note): `applyOp` pushes a
 * whole-timeline undo snapshot on every call, so a naive
 * `onPointerMove -> applyOp` would flood the undo stack. The picture itself
 * does NOT re-composite live while dragging — `PreviewPane`'s frame is a
 * server-rendered JPEG per the note's own "no cheap live re-render" finding
 * — only this component's own CSS position/size updates per pointermove;
 * the composited picture catches up once the drag commits and the next
 * frame is fetched.
 *
 * **B-088 — that last clause was, until D-202, simply not true**, and this
 * component is where it showed: the box moved and the picture underneath it
 * never did. Nothing here was wrong (the box is drawn from the live store,
 * which is correct); `PreviewPane` refetched its frame ~400 ms before the
 * committed op had been persisted, and the backend renders only what is
 * persisted. See `timelineStore.ts`'s `savedVersion` for the real story. The
 * "catches up on commit" contract above now holds — ~400 ms after
 * pointer-up, once the debounced save actually lands.
 *
 * **D-209/B-093 — the box follows the clip's EFFECTIVE transform at the
 * playhead, not its static fields, and a drag on an animated property keys
 * that property.** Until this fix every value below came straight off
 * `clip.position_x`/`position_y`/`scale`, which on a KEYFRAMED clip is not
 * where the picture is: the compositor resolves those same fields through
 * `chroma_keyframes` per frame (`chroma::edit::resolve_clip_transform`) and
 * only falls back to the static field for a property no keyframe names. On
 * the owner's real 50-keyframe clip the two disagreed by two thirds of the
 * canvas width, so the box was drawn well away from the picture it was
 * supposedly around. `clipKeyframes.ts`'s `resolveClipBoxTransform` — built on
 * the same per-property `paramValueAt` the Inspector's own number fields use
 * (D-208), not a second interpolator — is what everything here reads instead.
 * The second half of the same bug was `commit`: `set_clip_transform` writes
 * the static field, which a keyframe on that property overrides at every
 * frame, so a drag on an animated clip moved the box and could not possibly
 * move the picture. See `commit` for what it does now.
 *
 * Not in Phase 1 (see the note): rotation, non-uniform scale (via on-canvas
 * DRAGGING — see D-193's own note on this component below), crop, anchor
 * point, snapping/guides, marquee, multi-clip transform. (Click-to-select was
 * on this list until D-204 — see above.)
 *
 *
 * **D-193 — independent `box_width`/`box_height` (the Inspector's new
 * Width/Height/ratio-lock control) render correctly here (the STATIC box,
 * whenever no drag is in flight, uses them when the clip has them), but
 * dragging a corner handle stays Phase-1 uniform-only and, on release,
 * ALWAYS commits a plain `scale` and clears both overrides back to `null`
 * (on a clip whose `scale` is animated the new value goes into the keyframe
 * and the override is cleared by its own op — D-209, see `commit`)
 * — an on-canvas resize is a deliberately simpler, uniform gesture, and
 * silently only-partially-respecting an existing non-uniform override
 * would be worse than this explicit, documented "resizing on canvas
 * re-uniforms the box" contract. Precise independent sizing stays an
 * Inspector-only affordance for now (see that panel's own doc). A plain
 * MOVE (reposition) drag never touches box size and always preserves
 * whatever override already existed.
 *
 * **D-211 follow-up — a text clip gets the box and its MOVE (reposition)
 * drag, never the four corner handles.** `chroma_timeline_clip_geometry`
 * already answers correctly for a text clip (its natural footprint is the
 * whole composition — `chroma::edit::clip_geometry`'s own `is_text()`
 * branch), so the box itself needs no special-casing at all: `resolveClip
 * BoxTransform` reads the same `position_x`/`position_y`/`scale` fields
 * either way, and a title's `scale` is simply always its identity `1`
 * (never set by anything that writes to a text clip). The corner handles ARE
 * special-cased, and had to be: a scale drag's `commit` writes `scale`
 * through the SAME `set_clip_transform` op a video clip's does, and unlike
 * the MCP tool of the same name, that op's own store reducer
 * (`timeline.ts`) applies a text clip's write completely unchecked — nothing
 * stops a non-1 `scale` from actually landing on the clip. It would then sit
 * there silently doing nothing: `resolve_text_clip_transform` (Rust) pins
 * `scale` to `1.0` for a text clip regardless of what is stored, and
 * `drawtext` cannot scale at all on the export side either. That is B-053's
 * exact shape (a transform silently dropped, not refused) reproduced through
 * a different door — hiding the handles closes the door rather than
 * teaching this component (or the store reducer) to refuse mid-drag.
 */
import { useEffect, useRef, useState } from 'react';

import { usePreviewContentBox } from './usePreviewContentBox';
import {
  clipSourceFrame,
  hasParamKeyframes,
  mergeClipKeyframeParams,
  resolveClipBoxTransform,
} from './clipKeyframes';
import { findClip, timelineFps, type ClipTransformParam } from './timeline';
import { useEditorTimelineStore } from './timelineStore';
import { useClipGeometry } from './useClipGeometry';
import {
  boxToScreenRect,
  clipBoxFraction,
  dragCornerScale,
  dragReposition,
  resolvedBoxSize,
  screenToFraction,
} from './transformGeometry';

/** Screen-pixel handle size + hit-slop, and the box stroke width — named
 *  constants per the house no-magic-numbers rule, not tuned against
 *  anything deeper than "comfortable to grab with a mouse." */
const HANDLE_SIZE = 10;
const HANDLE_HIT_SLOP = 6;
const BOX_STROKE_WIDTH = 1.5;

type Corner = 'nw' | 'ne' | 'sw' | 'se';
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se'];

/** In-flight gesture state — local, uncommitted (Phase 0b). `null` when no
 *  drag is active. */
type DragState =
  | { kind: 'move'; startPoint: { x: number; y: number }; startPosition: { x: number; y: number } }
  | { kind: 'scale'; startPoint: { x: number; y: number }; center: { x: number; y: number }; startScale: number };

/** The box's live, uncommitted geometry mid-drag — what it RENDERS from while
 *  a gesture is in flight, and the exact value `commit` writes on release. */
interface Draft {
  position: { x: number; y: number };
  scale: number;
}

export function TransformOverlay({ container }: { container: HTMLElement | null }) {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  // D-209 — the box is a function of the playhead now (see this module's doc),
  // so this component re-renders as the playhead moves. That is unavoidable
  // for a box that has to sit on an animated picture; it is also cheap — the
  // per-property resolution below reads `clipKeyframes.ts`'s cached per-param
  // index rather than re-sorting the key list, and it renders at all only when
  // exactly one clip is selected.
  const playhead = useEditorTimelineStore((s) => s.playhead);
  const selection = useEditorTimelineStore((s) => s.selection);
  const applyOp = useEditorTimelineStore((s) => s.applyOp);

  // Same Phase-1 multi-select fallback `EditorInspectorPanel.tsx` already
  // uses: a selection that isn't exactly one clip draws nothing.
  const primary = selection.length === 1 ? selection[0] : null;
  const found = primary ? findClip(timeline, primary.track, primary.id) : null;
  const clip = found?.clip ?? null;
  const clipIndex = found?.index ?? -1;
  const trackLocked = primary ? !!timeline?.tracks[primary.track]?.locked : false;
  // D-211 follow-up — see this module's own doc: a text clip's `scale` is
  // pinned server-side and a corner drag would silently write a value
  // nothing ever reads, so the handles for it are hidden entirely rather
  // than left to fail mid-gesture.
  const isText = !!clip?.text;
  // D-229 — an ADJUSTMENT clip gets no transform overlay at all, not just
  // reduced handles. Its correction is full-frame and it draws nothing, so
  // every gesture this overlay offers (move, scale, crop) would write a value
  // neither renderer reads — the same reasoning that hides a title's scale
  // handles above, applied to the whole box because for this clip kind there
  // is nothing left over. `chroma_timeline_clip_geometry` still answers for it
  // (the whole composition), so this is a deliberate hide rather than a
  // side-effect of the fetch failing.
  const isAdjustment = !!clip?.adjustment;

  const geometry = useClipGeometry(primary?.track ?? null, clipIndex, clip?.source_path);

  // D-218 — the picture's real on-screen rect, i.e. the `object-contain` fit
  // box with the preview's own viewport zoom/pan composed on top. Every
  // fraction<->pixel conversion below (`localPoint`, `boxToScreenRect`) is
  // unchanged and stays correct at any zoom: the box just maps a fraction
  // onto more (or fewer) screen pixels. See `usePreviewContentBox`'s doc.
  const contentBox = usePreviewContentBox(
    container,
    geometry ? { width: geometry.compWidth, height: geometry.compHeight } : null,
  );

  // The in-flight drag (Phase 0b: local + uncommitted; one `applyOp` on
  // release). `draft` is what the box actually renders while dragging —
  // `null` means "render straight from the committed clip fields."
  //
  // **`draftRef` mirrors `draft` so pointer-up can READ the last dragged
  // value without a state updater** (D-209). `handlePointerUp` used to commit
  // from inside `setDraft(current => …)`, which reads the right value but runs
  // `applyOp` — a store write, i.e. an update to `PreviewPane` — during
  // React's own update computation: React logs "Cannot update a component
  // while rendering a different component" for exactly that, and under
  // StrictMode an updater may be invoked twice, which would commit the gesture
  // and push its undo entry TWICE. That second half matters much more now than
  // it did before D-209: a doubled commit on an animated clip means two
  // keyframe writes, not one idempotent static write. Surfaced by this
  // component's new DOM drag coverage. The ref keeps the original "commit
  // precisely what was last rendered" property with none of that.
  const dragRef = useRef<DragState | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const [draft, setDraftState] = useState<Draft | null>(null);
  const setDraft = (next: Draft | null) => {
    draftRef.current = next;
    setDraftState(next);
  };

  // D-209 — the clip's own SOURCE frame under the playhead (the frame its
  // keyframes are keyed against, and the exact value `Track::clip_at` hands
  // `resolve_clip_transform`), and the box transform that actually holds
  // there. `clipSourceFrame` clamps into the clip's source window, which is
  // what the Inspector's own keyframe controls already use — the playhead can
  // sit outside a still-selected clip, and both surfaces then agree on which
  // frame they are talking about.
  const sourceFrame = clip ? clipSourceFrame(clip, playhead, timelineFps(timeline)) : 0;
  const effective = clip ? resolveClipBoxTransform(clip, sourceFrame) : null;

  const committedPosition = { x: effective?.position_x ?? 0, y: effective?.position_y ?? 0 };
  const committedScale = effective?.scale ?? 1;
  const position = draft?.position ?? committedPosition;
  const scale = draft?.scale ?? committedScale;

  // D-201 — no `useCallback` here, nor on `commit` below, deliberately. The
  // React Compiler (D-091) auto-memoizes this whole component, but only when it
  // can *preserve* every piece of memoization already written by hand; these
  // two made it bail out of `TransformOverlay` entirely ("Existing memoization
  // could not be preserved" — one for a dependency it saw as mutated later, one
  // for a value it does not need to memoize at all), which costs the component
  // every bit of auto-memoization it would otherwise get. This is the
  // highest-update-frequency surface in the Edit tab's preview (an on-canvas
  // move/scale drag), so bailing out here is exactly the wrong trade. Leave
  // these plain — the compiler memoizes them with dependencies it infers
  // itself, which is also strictly safer than a hand-maintained array.
  // `reactCompiler.test.ts` fails if a future edit reintroduces a bailout here.
  const localPoint = (e: { clientX: number; clientY: number }) => {
    if (!container) return { x: 0, y: 0 };
    const rect = container.getBoundingClientRect();
    return screenToFraction({ x: e.clientX - rect.left, y: e.clientY - rect.top }, contentBox);
  };

  const cancelDrag = () => {
    dragRef.current = null;
    setDraft(null);
  };

  // Escape cancels the in-flight gesture (the note's own Phase 1 spec) —
  // listened for only while a drag is actually active.
  useEffect(() => {
    if (!draft) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelDrag();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [draft, cancelDrag]);

  /**
   * Write the gesture — ONCE, on pointer-up, with the value the box was last
   * rendered at. Every intermediate `pointermove` value stays in `draft` and
   * is never written anywhere, so a drag across an animated clip produces one
   * keyframe at the playhead, not one per pointer sample.
   *
   * **D-209/B-093 — a drag on an ALREADY-ANIMATED property keys it, per
   * property.** `set_clip_transform` sets the base/unkeyframed value (that
   * op's own doc says so). On a clip whose keyframes name `scale`,
   * `resolve_clip_transform` resolves `scale` from those keys and never
   * reaches the base — so the pre-D-209 commit wrote a real, persisted number
   * that no frame of any render could reflect, which is exactly what the owner
   * saw ("i made it small but no clip follows that only the box"). Every
   * reference NLE auto-keys an already-animated property on edit instead, and
   * D-208 already gave that answer for the Inspector's own number fields; this
   * is the same answer for the same model, reached through the same
   * `hasParamKeyframes` test and the same `mergeClipKeyframeParams` write.
   *
   * **Per PROPERTY, not per clip** — the one place this differs from the
   * obvious "does the clip have keyframes?" rule. Since D-208 a clip's keys
   * really do name different subsets of properties, and the Rust resolver
   * brackets each property over only its own keys (`interpolate_param`,
   * B-094), so "animated" is a per-property fact. A move drag on a clip whose
   * `position_x` is keyed but whose `position_y` is not must key the first and
   * write the second statically, or one of the two axes silently does nothing.
   * That is the only case that costs two ops; both are one gesture's worth of
   * history, and the common cases (all dragged properties animated, or none)
   * stay at one.
   *
   * The keyframe carries ONLY the dragged properties: `mergeClipKeyframeParams`
   * merges into whatever entry already sits at that frame, so every other
   * property's key there — and every other frame of the animation — is
   * untouched.
   *
   * **The one extra op D-193 forces:** a corner (scale) drag on a clip that
   * also carries a static `box_width`/`box_height` override. An override wins
   * over `scale` outright in the compositor and only `set_clip_transform` can
   * clear it (a keyframe modulates an override, it cannot remove one), so that
   * gesture emits the clearing transform op as well. Identical to what
   * `EditorInspectorPanel`'s own `applyParam` does for a typed scale.
   */
  const commit = (next: Draft, kind: 'move' | 'scale') => {
    if (!primary || !clip || clipIndex < 0) return;
    const keyframes = clip.chroma_keyframes;
    const dragged: Array<[ClipTransformParam, number]> =
      kind === 'move'
        ? [
            ['position_x', next.position.x],
            ['position_y', next.position.y],
          ]
        : [['scale', next.scale]];

    const keyed: Record<string, number> = {};
    const statics: Partial<Record<ClipTransformParam, number>> = {};
    for (const [param, value] of dragged) {
      if (hasParamKeyframes(keyframes, param)) keyed[param] = value;
      else statics[param] = value;
    }

    // D-193 — a corner (scale) drag stays Phase-1 uniform-only (see this
    // module's own doc above): committing one always clears any independent
    // `box_width`/`box_height` override back to `null`, so the box ends up the
    // uniform size just dragged rather than silently keeping a stale,
    // now-wrong override. A plain MOVE drag never resizes anything, so it
    // preserves whatever override already existed untouched.
    const clearsOverride = kind === 'scale' && ((clip.box_width ?? null) !== null || (clip.box_height ?? null) !== null);

    if (Object.keys(statics).length > 0 || clearsOverride) {
      // `set_clip_transform` replaces the WHOLE static set, so every field the
      // gesture didn't change is restated from the clip's own static value —
      // never from the resolved/effective one, which would bake this frame's
      // interpolated pose into the base underneath the animation.
      applyOp({
        kind: 'set_clip_transform',
        track: primary.track,
        clip: clipIndex,
        opacity: clip.opacity ?? 1,
        position_x: statics.position_x ?? clip.position_x ?? 0,
        position_y: statics.position_y ?? clip.position_y ?? 0,
        scale: statics.scale ?? clip.scale ?? 1,
        box_width: kind === 'scale' ? null : clip.box_width ?? null,
        box_height: kind === 'scale' ? null : clip.box_height ?? null,
        rotation: clip.rotation ?? 0,
        crop_left: clip.crop_left ?? 0,
        crop_top: clip.crop_top ?? 0,
        crop_right: clip.crop_right ?? 0,
        crop_bottom: clip.crop_bottom ?? 0,
      });
    }

    if (Object.keys(keyed).length > 0) {
      applyOp({
        kind: 'set_clip_keyframes',
        track: primary.track,
        clip: clipIndex,
        keyframes: mergeClipKeyframeParams(keyframes, sourceFrame, keyed),
      });
    }
  };

  const handleBodyPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || trackLocked) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const startPoint = localPoint(e);
    dragRef.current = { kind: 'move', startPoint, startPosition: committedPosition };
    setDraft({ position: committedPosition, scale: committedScale });
  };

  const handleCornerPointerDown = (corner: Corner) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || trackLocked) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const startPoint = localPoint(e);
    const center = { x: 0.5 + committedPosition.x, y: 0.5 + committedPosition.y };
    dragRef.current = { kind: 'scale', startPoint, center, startScale: committedScale };
    setDraft({ position: committedPosition, scale: committedScale });
    void corner; // Phase 1 is uniform-only — every corner drives the same math (see note).
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    e.stopPropagation();
    const point = localPoint(e);
    if (drag.kind === 'move') {
      setDraft({ position: dragReposition(drag.startPoint, point, drag.startPosition), scale: committedScale });
    } else {
      setDraft({ position: committedPosition, scale: dragCornerScale(drag.center, drag.startPoint, point, drag.startScale) });
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    e.stopPropagation();
    dragRef.current = null;
    // Read the live draft rather than recomputing — it's already exactly what
    // was last rendered, and pointerup itself can land a fraction of a pixel
    // from the last pointermove. Through the REF, not a `setDraft` updater —
    // see `draftRef`'s own note above for what that cost.
    const current = draftRef.current;
    setDraft(null);
    if (current) commit(current, drag.kind);
  };

  if (!clip || isAdjustment || !effective || !geometry || contentBox.width <= 0 || contentBox.height <= 0)
    return null;

  // D-193 — while a drag is live, the box always follows the natural*scale
  // formula (Phase 1's uniform-only drag math, unchanged). At rest, an
  // independent `box_width`/`box_height` override (set via the Inspector)
  // takes over per axis — passing the already-resolved size through as
  // `natural` with `scale: 1` reuses `clipBoxFraction` unchanged rather
  // than needing a second box-math variant. D-209 — the override read here is
  // the EFFECTIVE one (an override is itself keyframeable on top of its static
  // value), for the same reason the position/scale above are.
  const box = draft
    ? clipBoxFraction({ width: geometry.naturalWidth, height: geometry.naturalHeight }, position, scale)
    : clipBoxFraction(
        resolvedBoxSize({ width: geometry.naturalWidth, height: geometry.naturalHeight }, committedScale, {
          width: effective.box_width,
          height: effective.box_height,
        }),
        position,
        1,
      );
  const rect = boxToScreenRect(box, contentBox);

  return (
    <div className="absolute inset-0 pointer-events-none z-30" data-transform-overlay>
      <div
        className="absolute border-accent"
        style={{
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          borderWidth: BOX_STROKE_WIDTH,
          boxSizing: 'border-box',
        }}
      >
        {/* Body — reposition. Fully covers the box so a grab anywhere on the
            clip (not just its exact edge) starts a move, matching Premiere/
            Resolve's own "drag the picture" body affordance. */}
        <div
          className={trackLocked ? 'absolute inset-0' : 'absolute inset-0 pointer-events-auto cursor-move'}
          onPointerDown={handleBodyPointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />
        {!trackLocked &&
          !isText &&
          CORNERS.map((corner) => {
            const isTop = corner[0] === 'n';
            const isLeft = corner[1] === 'w';
            // The pointer TARGET is `HANDLE_HIT_SLOP` bigger on every side
            // than the VISIBLE handle — grabbing a corner shouldn't need
            // pixel accuracy. Outer div is the (invisible) hit area,
            // centred on the corner; inner div is the drawn square,
            // centred inside it via flex.
            const hit = HANDLE_SIZE + HANDLE_HIT_SLOP * 2;
            return (
              <div
                key={corner}
                // D-204 — marks this as a real corner-grab target, so canvas
                // click-to-select never steals a resize gesture (a handle's
                // hit area deliberately overhangs the box by
                // `HANDLE_HIT_SLOP` and so can sit over another clip's
                // picture). Same `closest()`-on-a-marker convention
                // `TimelinePane`'s D-100 clear-selection branch uses.
                data-transform-handle
                className="absolute pointer-events-auto flex items-center justify-center"
                style={{
                  width: hit,
                  height: hit,
                  left: isLeft ? -hit / 2 : undefined,
                  right: isLeft ? undefined : -hit / 2,
                  top: isTop ? -hit / 2 : undefined,
                  bottom: isTop ? undefined : -hit / 2,
                  cursor: isTop === isLeft ? 'nwse-resize' : 'nesw-resize',
                }}
                onPointerDown={handleCornerPointerDown(corner)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
              >
                <div className="rounded-sm border border-accent bg-bg-primary" style={{ width: HANDLE_SIZE, height: HANDLE_SIZE }} />
              </div>
            );
          })}
      </div>
    </div>
  );
}
