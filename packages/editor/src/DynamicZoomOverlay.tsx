/**
 * @chroma/editor — dynamic zoom's on-canvas START and END boxes (D-234,
 * roadmap 27).
 *
 * **The reference, and what it actually says.** Blackmagic's own Edit-page
 * copy for the feature (`scratch/resolve-reference/dynamic.jpg` and the
 * `edit-dynamic` section of `resolve-edit-features.json`): *"select a clip in
 * the timeline, then turn on dynamic zoom in the inspector. … green and red
 * boxes will appear in the viewer over your image. The green box shows where
 * the shot will be framed at the beginning of the clip and the red box shows
 * where it will be framed at the end. Simply drag and resize the boxes to your
 * desired start and end positions, then press play!"* So: TWO boxes, not one;
 * green = start, red = end; armed from the **Inspector**, not a viewer
 * toolbar; and the whole clip is the animation's span. This component is that,
 * with two deliberate divergences recorded in D-234 — what the box MEANS, and
 * that Chroma bakes keyframes instead of keeping a separate stage.
 *
 * **What a box means here — the divergence worth knowing.** Resolve's dynamic
 * zoom rectangles are a FRAMING rect: the part of the image you end up seeing,
 * so a smaller box means more zoomed in. Chroma's boxes are the clip's own
 * layer footprint on the canvas — the exact same rectangle `TransformOverlay`
 * has always drawn, where a BIGGER box means more zoomed in. Two opposite
 * meanings for "the box" in one viewer would be worse than one consistent
 * meaning, so these are the same box, in the same composition-fraction space,
 * driven by the same `transformGeometry.ts` math and the same `TransformBox`
 * component. Only the colours and the count are Resolve's.
 *
 * **What it does.** Draws the two boxes at the clip's resolved framing at the
 * first and last frames of its own source span (`dynamicZoom.ts`'s
 * `dynamicZoomFramings`), and on release of either box commits ONE
 * `set_clip_keyframes` op holding the whole baked animation. Arming and
 * disarming the mode write nothing at all: on a clip with no zoom yet the two
 * boxes sit exactly on top of each other (the end box is dashed so both stay
 * legible), and the first drag is what creates the animation.
 *
 * **What it does NOT do.** No draft state, no Apply button, no second source
 * of truth. The boxes are READ BACK from the clip's own keyframes every
 * render, so what is on screen is always what is stored — the same property
 * that makes `TransformOverlay` trustworthy, kept rather than traded for a
 * staging buffer. It also never sets the selection (it only reflects one), and
 * it never runs on a locked track, a text clip or an adjustment clip, for the
 * reasons `TransformOverlay`'s own doc gives for each.
 */
import { usePreviewContentBox } from './usePreviewContentBox';
import {
  applyDynamicZoom,
  dynamicZoomFramings,
  dynamicZoomSpan,
  type DynamicZoomFraming,
} from './dynamicZoom';
import { findClip } from './timeline';
import { useEditorTimelineStore } from './timelineStore';
import { useClipGeometry } from './useClipGeometry';
import { TransformBox, type TransformDraft } from './TransformBox';

/** Which end of the zoom a box is. */
type Which = 'start' | 'end';

/** Resolve's own green/red convention, as classes rather than raw hex — the
 *  house no-magic-colour rule. The `-400` shade is the one the Edit tab
 *  already uses for its green/red status marks (`EditorExportDialog`,
 *  `Filmstrip`), reused so this overlay's two strokes read as the same red and
 *  green the rest of the tab does. Deliberately NOT `--color-accent`: these
 *  two boxes must be told apart from each other AND from the ordinary
 *  accent-coloured transform box, which is exactly what a semantic accent
 *  token cannot express. */
const BOX_STROKE: Readonly<Record<Which, string>> = {
  start: 'border-green-400',
  end: 'border-red-400',
};

export function DynamicZoomOverlay({ container }: { container: HTMLElement | null }) {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const selection = useEditorTimelineStore((s) => s.selection);
  const applyOp = useEditorTimelineStore((s) => s.applyOp);
  const dynamicZoom = useEditorTimelineStore((s) => s.dynamicZoom);

  // Same single-selection fallback every other single-clip surface in this tab
  // applies. The armed clip is identified by ID, so a selection change (or an
  // insert that shifts every index) simply stops matching and the overlay
  // disappears rather than drawing over the wrong picture.
  const primary = selection.length === 1 ? selection[0] : null;
  const found = primary ? findClip(timeline, primary.track, primary.id) : null;
  const clip = found?.clip ?? null;
  const clipIndex = found?.index ?? -1;
  const armed = !!dynamicZoom && !!clip && clip.id === dynamicZoom.clipId;
  const trackLocked = primary ? !!timeline?.tracks[primary.track]?.locked : false;

  const geometry = useClipGeometry(primary?.track ?? null, clipIndex, clip?.source_path);
  const contentBox = usePreviewContentBox(
    container,
    geometry ? { width: geometry.compWidth, height: geometry.compHeight } : null,
  );

  // Read the two boxes straight off the clip — no draft state (see the module
  // doc). On a clip with no `position_*`/`scale` keys both come back as its
  // static framing, i.e. two coincident boxes and no animation yet.
  const framings = clip ? dynamicZoomFramings(clip) : null;

  /**
   * One box released — rewrite the WHOLE dynamic zoom in one op.
   *
   * The dragged end takes its new framing; the other end keeps the framing it
   * already had. `applyDynamicZoom` then replaces every existing
   * `position_x`/`position_y`/`scale` key and leaves every other property's
   * keys alone — see its own doc for why replacing (not appending) is the only
   * coherent answer for a gesture that spans the whole clip.
   *
   * **The one extra op D-193 forces**, identical to `TransformOverlay`'s own
   * commit: a clip carrying a static `box_width`/`box_height` override. An
   * override beats `scale` outright in the compositor and only
   * `set_clip_transform` can clear it, so a dynamic zoom on such a clip would
   * animate a `scale` neither renderer looks at. Clearing it is what makes the
   * gesture actually do something.
   */
  const commit = (which: Which) => (next: TransformDraft) => {
    if (!primary || !clip || clipIndex < 0 || !framings || !dynamicZoom) return;
    const dragged: DynamicZoomFraming = {
      position_x: next.position.x,
      position_y: next.position.y,
      scale: next.scale,
    };
    const start = which === 'start' ? dragged : framings.start;
    const end = which === 'end' ? dragged : framings.end;
    const span = dynamicZoomSpan(clip);

    if ((clip.box_width ?? null) !== null || (clip.box_height ?? null) !== null) {
      applyOp({
        kind: 'set_clip_transform',
        track: primary.track,
        clip: clipIndex,
        opacity: clip.opacity ?? 1,
        position_x: clip.position_x ?? 0,
        position_y: clip.position_y ?? 0,
        scale: clip.scale ?? 1,
        box_width: null,
        box_height: null,
        rotation: clip.rotation ?? 0,
        crop_left: clip.crop_left ?? 0,
        crop_top: clip.crop_top ?? 0,
        crop_right: clip.crop_right ?? 0,
        crop_bottom: clip.crop_bottom ?? 0,
      });
    }

    applyOp({
      kind: 'set_clip_keyframes',
      track: primary.track,
      clip: clipIndex,
      keyframes: applyDynamicZoom(clip.chroma_keyframes, start, end, span.first, span.last, dynamicZoom.curve),
    });
  };

  // A text clip's `scale` is pinned server-side and an adjustment clip has no
  // geometry at all, so neither can be dynamically zoomed — the same two
  // exclusions `TransformOverlay` makes, applied to the whole overlay because
  // for these clip kinds there is nothing left over. The Inspector hides the
  // section for them too, so this is belt-and-braces rather than the only
  // guard.
  if (!armed || !clip || clip.text || clip.adjustment || !framings || !geometry) return null;
  if (contentBox.width <= 0 || contentBox.height <= 0) return null;

  const natural = { width: geometry.naturalWidth, height: geometry.naturalHeight };

  return (
    <div className="absolute inset-0 pointer-events-none z-30" data-dynamic-zoom-overlay>
      {(['start', 'end'] as const).map((which) => (
        <TransformBox
          key={which}
          container={container}
          contentBox={contentBox}
          position={{ x: framings[which].position_x, y: framings[which].position_y }}
          scale={framings[which].scale}
          natural={natural}
          // Always the uniform `natural * scale` box: a dynamic zoom clears
          // any independent size override on commit (see `commit` above), so
          // drawing the rest box at an override it is about to remove would
          // show a rectangle the gesture will not honour.
          restSize={null}
          moveEnabled={!trackLocked}
          scaleEnabled={!trackLocked}
          strokeClassName={BOX_STROKE[which]}
          dashed={which === 'end'}
          label={which === 'start' ? 'Start' : 'End'}
          onCommit={commit(which)}
        />
      ))}
    </div>
  );
}
