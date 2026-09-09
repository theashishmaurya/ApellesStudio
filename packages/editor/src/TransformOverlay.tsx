/**
 * @apelles/editor — on-canvas transform handles for the Edit-tab preview
 * (D-136, Phase 1 of `docs/notes/on-canvas-transform.md`). The owner's
 * original ask: "the player is canvas — once I have another video I can
 * select, drag and make it smaller or larger, PIP etc."
 *
 * Renders as a sibling of `PreviewPane.tsx`'s `<img>`, absolutely positioned
 * over the same wrapper `<div>` — no `@apelles/player` change needed, `Player`
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
 * **D-234 — the BOX ITSELF is now `TransformBox.tsx`, and this component
 * stands aside in dynamic-zoom mode.** Two changes, both structural rather
 * than behavioural. First, the rectangle, its four corner handles and all the
 * pointer wiring moved into a reusable component so dynamic zoom's start/end
 * pair could be two of the same box rather than a copy-paste of this one — see
 * that file's own doc for why that extraction was not optional. What is left
 * here is exactly this overlay's own job: which clip, resolved at which frame,
 * and what a released gesture MEANS (`commit`, below). Second, when
 * `timelineStore.dynamicZoom` names the selected clip, `DynamicZoomOverlay` is
 * drawing its two boxes over this same picture and this overlay renders
 * nothing — one box per meaning, never a third stroke on top of the pair.
 *
 * **D-211 follow-up — a text clip gets the box and its MOVE (reposition)
 * drag, never the four corner handles.** The box itself needs no
 * special-casing here at all: `resolveClipBoxTransform` reads the same
 * `position_x`/`position_y`/`scale` fields either way, and a title's `scale`
 * is simply always its identity `1` (never set by anything that writes to a
 * text clip). Its SIZE comes from `chroma_timeline_clip_geometry` like every
 * other clip's — **B-130/D-262: that command now reports a title's real
 * rendered INK box**, measured by the same advance-and-kern walk that
 * rasterises the glyphs, rather than the whole composition. It used to report
 * the whole frame, on the true-but-irrelevant fact that a text layer's RGBA
 * buffer is allocated at composition size; the buffer is almost entirely
 * transparent, so a modest 12%-of-frame-height title drew a selection box
 * spanning the entire frame. Nothing here changed for that fix — this
 * component was already asking the right question, and was being given a
 * wrong answer. The corner handles ARE
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
import { TransformBox, type TransformDraft, type TransformGestureKind } from './TransformBox';
import { resolvedBoxSize } from './transformGeometry';

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
  // D-234 — while dynamic zoom is armed for this clip, `DynamicZoomOverlay`
  // owns the picture and this overlay draws nothing (see this module's doc).
  const dynamicZoom = useEditorTimelineStore((s) => s.dynamicZoom);

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
  // D-230 — an ADJUSTMENT clip gets no transform overlay at all, not just
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

  // D-234 — the in-flight drag state (Phase 0b: local + uncommitted; one
  // `applyOp` on release) now lives in `TransformBox`, along with the
  // `draftRef` that keeps a pointer-up commit out of React's own update
  // computation. See that file's own doc.

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

  // D-201 — no `useCallback` on `commit` below, deliberately. The React
  // Compiler (D-091) auto-memoizes this whole component, but only when it can
  // *preserve* every piece of memoization already written by hand; the ones
  // this file used to carry made it bail out of `TransformOverlay` entirely
  // ("Existing memoization could not be preserved"), which costs the component
  // every bit of auto-memoization it would otherwise get. This is the
  // highest-update-frequency surface in the Edit tab's preview (an on-canvas
  // move/scale drag), so bailing out here is exactly the wrong trade. Leave it
  // plain — the compiler memoizes with dependencies it infers itself, which is
  // also strictly safer than a hand-maintained array. `reactCompiler.test.ts`
  // fails if a future edit reintroduces a bailout here.

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
  const commit = (next: TransformDraft, kind: TransformGestureKind) => {
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

  if (!clip || isAdjustment || !effective || !geometry || contentBox.width <= 0 || contentBox.height <= 0)
    return null;
  // D-234 — dynamic zoom is armed for this very clip: its own overlay is
  // drawing the start/end pair over this picture, so this single box stands
  // aside rather than adding a third stroke to the same rectangle.
  if (dynamicZoom && clip.id === dynamicZoom.clipId) return null;

  const natural = { width: geometry.naturalWidth, height: geometry.naturalHeight };
  // D-193 — while a drag is live the box follows the natural*scale formula
  // (Phase 1's uniform-only drag math, unchanged); at rest an independent
  // `box_width`/`box_height` override takes over per axis. `TransformBox` owns
  // that switch — this is just the resolved rest size to hand it. D-209 — the
  // override read here is the EFFECTIVE one (an override is itself
  // keyframeable on top of its static value), for the same reason the
  // position/scale above are.
  const restSize =
    effective.box_width === null && effective.box_height === null
      ? null
      : resolvedBoxSize(natural, committedScale, { width: effective.box_width, height: effective.box_height });

  return (
    <div className="absolute inset-0 pointer-events-none z-30" data-transform-overlay>
      <TransformBox
        container={container}
        contentBox={contentBox}
        position={committedPosition}
        scale={committedScale}
        natural={natural}
        restSize={restSize}
        moveEnabled={!trackLocked}
        scaleEnabled={!trackLocked && !isText}
        strokeClassName="border-accent"
        onCommit={commit}
      />
    </div>
  );
}
