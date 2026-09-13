/**
 * @apelles/editor — on-canvas selection, move and resize for a CAPTION
 * (D-316, fixing B-183; `docs/notes/subtitles.md` §"On-canvas manipulation").
 *
 * **The gap this closes.** A caption is an ordinary `Clip` on a
 * `TrackKind::Subtitle` track (D-229), so it was selectable, inspectable and
 * editable everywhere *except* the one surface a caption is actually judged
 * on: the picture. Selecting one showed a full Inspector — Position X/Y, Font
 * Size, alignment, padding — and drew absolutely nothing on the canvas, no box,
 * no handles, no indication it was selected at all. The owner hit exactly that
 * ("fix that caption is not selectable movable / resizable at all"). The root
 * cause was mechanical: `TransformOverlay` needs
 * `chroma_timeline_clip_geometry`, which errors with "clip has no source" for a
 * caption clip (its `source_path` is empty), so `useClipGeometry` returned
 * `null` and the overlay bailed before drawing anything — a silent nothing,
 * not a refusal. See B-183.
 *
 * **Its own component, not a branch of `TransformOverlay`** — for exactly the
 * reason `CaptionInspectorPanel` is its own panel next to
 * `EditorInspectorPanel`. Nothing a caption's box is made of is a `Clip`
 * transform: it has no `position_x`/`scale`/`box_width` of its own (see
 * `apelles_timeline::caption`'s "what this module deliberately does not carry"
 * — a caption is not a transformable clip), its geometry is measured rather
 * than derived, it grows about its style's anchor rather than its own centre,
 * and a released gesture writes a caption STYLE op rather than a transform op.
 * `TransformOverlay` correspondingly stands aside for a caption clip, the same
 * way it already does for an adjustment clip (D-230) and for a dynamic-zoom-
 * armed clip (D-234): one box per meaning, never two strokes on one rectangle.
 *
 * **What IS shared, deliberately:** the box itself. `TransformBox` (D-234)
 * owns the rectangle, the four corner handles, pointer capture, the Escape
 * cancel, the handle hit-slop, and the "live overlay-only feedback during the
 * drag, ONE `applyOp` on pointer-up" discipline every on-canvas gesture in
 * this tab follows (D-136/Phase 0b — `applyOp` pushes a whole-timeline undo
 * snapshot per call, so a `pointermove -> applyOp` would flood the undo
 * stack). D-316 taught it one new prop, `model`, for a consumer whose
 * rectangle is given rather than derived. No pointer wiring is duplicated here.
 *
 * ## The two gestures, and why they mean what they mean
 *
 * Built from real reference rather than invented — see D-316 for the pages
 * actually read (`scratch/caption-oncanvas-reference/`).
 *
 * - **Body drag = move.** Writes `position_x`/`position_y`, the same two
 *   fields the Inspector's own Position X/Y number fields write, through the
 *   same op. Note what that anchor MEANS (`CaptionStyle.position_y`): it is
 *   where the LAST line sits, with extra lines stacking upward. The box the
 *   drag moves is the whole cue's, every line of it, so a two-line caption
 *   moves as one unit and keeps its own internal layout — which is the
 *   "propagate to the whole caption" half of the ask.
 *
 * - **Corner drag = FONT SIZE.** A caption has no `scale`, and inventing one
 *   would be B-053's shape all over again: a value the model would store, the
 *   preview would ignore and `drawtext` could not honour on export. Its one
 *   real size field is `CaptionStyle.size` (a fraction of composition height),
 *   which is precisely what the reference tools' own corner handle drives on a
 *   text object. The whole box — every line, the leading between them and the
 *   background padding — is proportional to that one number, so the corner
 *   grows the entire caption together rather than any one line.
 *
 * **Which STYLE the write lands on is `CaptionInspectorPanel`'s rule, exactly**
 * (its `patchStyle`): the cue's own override if it has one, otherwise the
 * track's. That is not a caption-specific quirk invented here — it is the
 * reference Inspector's "Use Track Style" checkbox, and it means that dragging
 * a caption that uses its track's style repositions the whole subtitle track,
 * which is the subtitle convention and what typing in the Inspector's Position
 * X field already does. One control, one meaning; the GUI drag and the number
 * field are one source of truth rather than two paths to the same fields.
 *
 * ## What this does NOT do (each with a real reason)
 *
 * - **No per-frame animation tracking.** For a per-word animated cue (D-243)
 *   the box is the envelope its words SETTLE into, not the moving extent of
 *   whichever word is entering right now — `caption_bounds_px` documents the
 *   same limit from the measuring side. A selection box that jittered frame by
 *   frame while nobody was dragging it would be worse than one that sits still
 *   on the settled text.
 * - **No rotation, no independent width/height, no wrap-width handle.** A
 *   caption has no field for any of them and neither renderer could draw one;
 *   `.srt`-style line breaks are the cue's own text, not a box property.
 * - **It never SETS the selection**, the same contract `TransformOverlay`
 *   states: clicking a caption on the picture to select it is
 *   `useCanvasClipPick.ts`, which D-316 taught to see subtitle tracks.
 * - **It draws ONLY while the selected cue is actually on screen** — the
 *   playhead inside its own span, [`clipCoversFrame`] (D-317, fixing B-185).
 *   D-316 shipped the opposite rule ("the box is drawn where the caption WILL
 *   be when its cue comes up") and it was wrong, live: a caption is drawn at
 *   an anchor its style pins, so an off-screen cue's box lands on top of
 *   whichever cue IS on screen, describing text that is not there. With a
 *   one-line cue selected and a two-line cue showing, the phantom box covers
 *   exactly the visible cue's LAST line — because `CaptionLayout` anchors
 *   `position_y` at the last line and stacks earlier lines upward — which
 *   reads precisely as "the box only covers one line of a multi-line caption"
 *   (B-185's report). The box is not stale or mis-measured in that state; it
 *   is a correct box for the wrong cue. Gating on visibility also restores the
 *   guarantee `canvasPick.ts` states from the other side — `visibleCaptionsAt`
 *   already lets a click select only an on-screen cue, so a box that outlived
 *   its cue's span was the one way the two halves could disagree.
 */
import {
  captionSizeAfterDrag,
  clipCoversFrame,
  findClip,
  resolveCaptionStyle,
  timelineFps,
  type CaptionStyle,
} from './timeline';
import { useEditorTimelineStore } from './timelineStore';
import { TransformBox, type TransformDraft, type TransformGestureKind } from './TransformBox';
import { useCaptionGeometry } from './useCaptionGeometry';
import { usePreviewContentBox } from './usePreviewContentBox';
import type { CompositionSize } from './useCompositionSize';

export function CaptionTransformOverlay({
  container,
  size,
}: {
  container: HTMLElement | null;
  /** The composition's own pixel size (`useCompositionSize`), passed in rather
   *  than read back off the measurement below — it is a REFETCH DEPENDENCY, and
   *  taking it from the fetch's own result would be circular. A caption's box is
   *  reported as a fraction of the composition, and that fraction genuinely
   *  moves when the composition does (the font size resolves against the
   *  height, the measured advance is divided by the width), so a project-
   *  settings change has to re-measure. Same escape hatch `useClipGeometries`
   *  documents as its `extraDep`, for the same reason. */
  size: CompositionSize | null;
}) {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const selection = useEditorTimelineStore((s) => s.selection);
  const applyOp = useEditorTimelineStore((s) => s.applyOp);
  // B-185/D-317 — the box may only exist while its cue is on screen, so this
  // component re-renders as the playhead moves. Same cost `TransformOverlay`
  // already documents for its own D-209 playhead dependency, and the same
  // reason: what the canvas shows is a function of the playhead.
  const playhead = useEditorTimelineStore((s) => s.playhead);

  // The same Phase-1 multi-select fallback every single-clip-only consumer in
  // this tab applies (`docs/notes/multi-select.md`).
  const primary = selection.length === 1 ? selection[0] : null;
  const found = primary ? findClip(timeline, primary.track, primary.id) : null;
  const clip = found?.clip ?? null;
  const clipIndex = found?.index ?? -1;
  const track = primary ? (timeline?.tracks[primary.track] ?? null) : null;
  const cue = clip?.caption ?? null;
  const trackLocked = !!track?.locked;

  // B-185/D-317 — is the selected cue the one the viewer is actually looking
  // at? The SAME predicate `visibleCaptionsAt` gates canvas click-to-select on,
  // so the box a click can produce and the box this draws are answers to one
  // question rather than two. A hidden track draws nothing either, which is
  // why that is part of the same test.
  const onScreen =
    !!clip && !!track && !track.hidden && clipCoversFrame(clip, playhead, timelineFps(timeline));

  // The resolved style — the cue's own override, else the track's, else the
  // defaults — which is what the preview actually drew with
  // (`Timeline::resolve_visible_captions_at`) and therefore what the box has to
  // be measured against.
  const style = resolveCaptionStyle(cue?.style, track?.caption_style);
  const usingTrackStyle = cue != null && cue.style == null;

  // The measurement, from the style this component is looking at RIGHT NOW —
  // not from the persisted timeline, which lags by the save debounce (see
  // `useCaptionGeometry`'s own doc, and B-088). Derived fresh every render on
  // purpose: the hook keys its fetch on the request's CONTENT, so nothing
  // refetches until the box genuinely moves.
  // `null` when the cue is off screen: there is no box to draw, so there is no
  // measurement to ask the backend for either — scrubbing past a selected cue
  // must not spend a font round trip per frame.
  const geometry = useCaptionGeometry(cue && onScreen ? `${primary?.track ?? -1}:${clip?.id ?? ''}` : null, {
    text: cue?.text ?? '',
    style,
    size,
  });

  // D-218 — the picture's real on-screen rect (the `object-contain` fit box
  // with the preview's own viewport zoom/pan composed on top), the same hook
  // `TransformOverlay`, `CanvasBoundary` and `useCanvasClipPick` all read, so
  // every box on this surface agrees by construction rather than by being
  // handed a value.
  const contentBox = usePreviewContentBox(container, size);

  // D-201 — no `useCallback` here, deliberately, for the reason
  // `TransformOverlay`'s own note gives in full: a hand-written memo the React
  // Compiler cannot preserve costs this whole file its auto-memoization, and
  // this is the preview's highest-update-frequency surface.

  /**
   * Write the gesture — ONCE, on pointer-up, at the value the box was last
   * rendered at. Every intermediate `pointermove` value stayed in
   * `TransformBox`'s own draft and was never written anywhere.
   *
   * A caption has no keyframes to auto-key into, so there is no per-property
   * static/keyed split to make here (D-209's rule, which `TransformOverlay`'s
   * `commit` implements, has nothing to apply to): one patch, one op, one undo
   * entry per gesture.
   */
  const commit = (next: TransformDraft, kind: TransformGestureKind) => {
    if (!primary || !cue || clipIndex < 0) return;
    const patch: Partial<CaptionStyle> =
      kind === 'move'
        ? { position_x: next.position.x, position_y: next.position.y }
        : // `TransformBox` was handed `scale: 1`, so what it reports back IS
          // the ratio the corner grew the box by — and the whole box is
          // proportional to the font size, so that ratio is the font size's.
          { size: captionSizeAfterDrag(style.size, next.scale) };
    if (usingTrackStyle) {
      applyOp({ kind: 'set_caption_style', track: primary.track, patch });
    } else {
      applyOp({ kind: 'set_caption_cue_style', track: primary.track, clip: clipIndex, patch });
    }
  };

  if (!cue || !onScreen || !geometry || contentBox.width <= 0 || contentBox.height <= 0) return null;

  const restBox = geometry;
  // The style's own anchor — where `CaptionLayout` pins the cue, and so the
  // point its whole box grows about as the font size changes.
  const anchor = { x: style.position_x, y: style.position_y };

  return (
    <div className="absolute inset-0 pointer-events-none z-30" data-transform-overlay data-caption-transform-overlay>
      <TransformBox
        container={container}
        contentBox={contentBox}
        // The anchor is this box's "position": a move drag reports it shifted
        // by exactly the pointer delta, which is what `position_x`/
        // `position_y` are.
        position={anchor}
        // Identity, so the reported `scale` is the corner's growth RATIO
        // rather than an absolute in some unit a caption does not have.
        scale={1}
        natural={{ width: restBox.width, height: restBox.height }}
        restSize={null}
        model={{ restBox, pivot: anchor }}
        moveEnabled={!trackLocked}
        scaleEnabled={!trackLocked}
        strokeClassName="border-accent"
        onCommit={commit}
      />
    </div>
  );
}
