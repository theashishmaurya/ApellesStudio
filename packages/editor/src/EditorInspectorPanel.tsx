/**
 * @chroma/editor — the Edit tab's Inspector, as a full-height sibling panel
 * (D-118).
 *
 * D-102 built `ClipInspectorPanel` as a *third pane nested inside
 * `TimelinePane.tsx`'s own `ResizablePanelGroup`* — a real, working panel,
 * but one whose height was capped at the timeline area (`EditorTab.tsx`'s
 * `h-[46%]` row), not the Edit tab's full height. Owner, live, right after
 * D-116 moved Sources to a real full-height shell panel on the left: "move
 * the clip editor like source control full height instead of being in the
 * timeline" + "create a panel" with its own opener next to Sources'.
 *
 * This component is the extraction: everywhere `TimelinePane.tsx` used to
 * compute `selectedClip`/`applyTransform`/the keyframe CRUD functions
 * inline (D-089/D-090), that logic now lives here instead — reading the
 * same `selection`/`timeline`/`playhead` from `useEditorTimelineStore`
 * (lifted out of `TimelinePane`'s local `useState` in this same pass, so
 * both this panel and `TimelinePane` read one shared selection, not two
 * that could drift) rather than receiving them as props from a parent that
 * doesn't otherwise need to know about clip transforms. `EditorTab.tsx`
 * renders this as a real sibling of the preview+timeline column, in a
 * `ResizablePanel` spanning the tab's full height — the same architectural
 * treatment D-116 gave Sources, applied to the other side.
 *
 * D-103's own note ("a per-tab-local Inspector already behaves exactly like
 * a cross-tab shared one, since every tab stays mounted") is still correct
 * for *why this didn't need to be a shell-level, cross-tab panel* — Motion's
 * `InspectorPanel.tsx` and Colorist's `ControlsPanel` each remain their own
 * tab's own always-visible right panel, not this one. Only the Edit tab's
 * own internal layout changed; `Shell.tsx` and the other two tabs are
 * untouched by this pass.
 *
 * D-186 — this is also where `ClipInspectorPanel`'s new Width/Height fields
 * get their `chroma_timeline_clip_geometry` fetch (`useClipGeometry`, the
 * same hook `TransformOverlay.tsx` uses for the on-canvas box), keeping
 * that panel pure presentation per its own doc — this file already owns
 * every other piece of selected-clip derived state.
 */
import { clearClipKeyframes, clipSourceFrame, removeClipKeyframe, upsertClipKeyframe } from './clipKeyframes';
import { ClipInspectorPanel, type FadePatch, type TransformPatch } from './ClipInspectorPanel';
import { DEFAULT_FADE_CURVE, findClip } from './timeline';
import { useEditorTimelineStore } from './timelineStore';
import { useClipGeometry } from './useClipGeometry';

export function EditorInspectorPanel() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const playhead = useEditorTimelineStore((s) => s.playhead);
  const selection = useEditorTimelineStore((s) => s.selection);
  const applyOp = useEditorTimelineStore((s) => s.applyOp);

  // Same Phase 1 multi-select fallback `TimelinePane.tsx` already uses for
  // every single-clip-only consumer (docs/notes/multi-select.md): a
  // selection that isn't exactly one clip falls back to the empty state,
  // it isn't a real N-clip batch-edit contract yet.
  const primary = selection.length === 1 ? selection[0] : null;
  const found = primary ? findClip(timeline, primary.track, primary.id) : null;
  const selectedClip = found?.clip ?? null;
  const selectedIdx = found?.index ?? -1;
  const selectedTrackLocked = primary ? !!timeline?.tracks[primary.track]?.locked : false;

  // Keyframes are interpolated against the clip's own SOURCE frame, not the
  // absolute timeline position — see `clipKeyframes.ts`'s doc.
  const clipKfSourceFrame = selectedClip ? clipSourceFrame(selectedClip, playhead) : 0;
  const clipKeyframes = selectedClip?.chroma_keyframes ?? [];
  const keyedHere = clipKeyframes.some((k) => k.frame === Math.round(clipKfSourceFrame));

  // D-186 — the same `chroma_timeline_clip_geometry` fetch `TransformOverlay.
  // tsx` uses for the on-canvas box, needed here for `ClipInspectorPanel`'s
  // Width/Height fields to convert composition-fraction sizes to real
  // pixels and back.
  const geometry = useClipGeometry(primary?.track ?? null, selectedIdx, selectedClip?.source_path);

  // D-132 — crop joins the transform patch rather than getting its own op:
  // one clip-geometry write, one history entry, one save. See the
  // `set_clip_transform` op's own doc in `timeline.ts` for why.
  //
  // D-186 — `box_width`/`box_height` join the same patch for the same
  // reason: one clip-geometry write. `!== undefined` (not `??`) because
  // `null` is itself a MEANINGFUL patch value here (explicitly clear an
  // override) that `??` would otherwise treat the same as "not provided".
  const applyTransform = (patch: TransformPatch) => {
    if (!primary || !selectedClip || selectedIdx < 0) return;
    applyOp({
      kind: 'set_clip_transform',
      track: primary.track,
      clip: selectedIdx,
      opacity: patch.opacity ?? selectedClip.opacity ?? 1,
      position_x: patch.position_x ?? selectedClip.position_x ?? 0,
      position_y: patch.position_y ?? selectedClip.position_y ?? 0,
      scale: patch.scale ?? selectedClip.scale ?? 1,
      box_width: patch.box_width !== undefined ? patch.box_width : selectedClip.box_width ?? null,
      box_height: patch.box_height !== undefined ? patch.box_height : selectedClip.box_height ?? null,
      rotation: patch.rotation ?? selectedClip.rotation ?? 0,
      crop_left: patch.crop_left ?? selectedClip.crop_left ?? 0,
      crop_top: patch.crop_top ?? selectedClip.crop_top ?? 0,
      crop_right: patch.crop_right ?? selectedClip.crop_right ?? 0,
      crop_bottom: patch.crop_bottom ?? selectedClip.crop_bottom ?? 0,
    });
  };

  // D-147 — fades get their own op rather than riding `set_clip_transform`
  // (see that op's own doc in `timeline.ts` for why this is the opposite call
  // D-132 made for crop, and deliberately so). Same fill-the-rest-from-the-clip
  // shape `applyTransform` uses, since `set_clip_fade` also replaces the whole
  // set — an omitted field would otherwise reset to the default rather than
  // being left alone.
  const applyFade = (patch: FadePatch) => {
    if (!primary || !selectedClip || selectedIdx < 0) return;
    applyOp({
      kind: 'set_clip_fade',
      track: primary.track,
      clip: selectedIdx,
      fade_in_frames: patch.fade_in_frames ?? selectedClip.fade_in_frames ?? 0,
      fade_out_frames: patch.fade_out_frames ?? selectedClip.fade_out_frames ?? 0,
      fade_in_curve: patch.fade_in_curve ?? selectedClip.fade_in_curve ?? DEFAULT_FADE_CURVE,
      fade_out_curve: patch.fade_out_curve ?? selectedClip.fade_out_curve ?? DEFAULT_FADE_CURVE,
    });
  };

  const doUpsertKeyframe = () => {
    if (!primary || !selectedClip || selectedIdx < 0) return;
    applyOp({
      kind: 'set_clip_keyframes',
      track: primary.track,
      clip: selectedIdx,
      keyframes: upsertClipKeyframe(clipKeyframes, clipKfSourceFrame, {
        opacity: selectedClip.opacity ?? 1,
        position_x: selectedClip.position_x ?? 0,
        position_y: selectedClip.position_y ?? 0,
        scale: selectedClip.scale ?? 1,
        rotation: selectedClip.rotation ?? 0,
        // D-132 — the crop insets are keyed with everything else, which is
        // what makes them animatable at all: `resolve_clip_transform` (Rust)
        // reads them out of this same flat params object through the D-034
        // interpolator, and a key that omitted them would snap a cropped
        // clip back to full frame the moment it became keyframed.
        crop_left: selectedClip.crop_left ?? 0,
        crop_top: selectedClip.crop_top ?? 0,
        crop_right: selectedClip.crop_right ?? 0,
        crop_bottom: selectedClip.crop_bottom ?? 0,
      }),
    });
  };

  const doRemoveKeyframeHere = () => {
    if (!primary || selectedIdx < 0) return;
    applyOp({
      kind: 'set_clip_keyframes',
      track: primary.track,
      clip: selectedIdx,
      keyframes: removeClipKeyframe(clipKeyframes, clipKfSourceFrame) ?? [],
    });
  };

  const doClearKeyframes = () => {
    if (!primary || selectedIdx < 0) return;
    applyOp({
      kind: 'set_clip_keyframes',
      track: primary.track,
      clip: selectedIdx,
      keyframes: clearClipKeyframes() ?? [],
    });
  };

  return (
    <ClipInspectorPanel
      // D-186 — remounts `ClipInspectorPanel` on every new clip selection,
      // which is what resets that component's own local ratio-lock state
      // (ephemeral UI state, not a `Clip` field — see that file's own doc)
      // back to the right default for the newly-selected clip, without
      // this file having to own or thread that state itself.
      key={selectedClip?.id ?? 'none'}
      clip={selectedClip}
      trackLocked={selectedTrackLocked}
      geometry={geometry}
      clipKeyframes={clipKeyframes}
      keyedHere={keyedHere}
      onTransformChange={applyTransform}
      onFadeChange={applyFade}
      onUpsertKeyframe={doUpsertKeyframe}
      onRemoveKeyframeHere={doRemoveKeyframeHere}
      onClearKeyframes={doClearKeyframes}
    />
  );
}
