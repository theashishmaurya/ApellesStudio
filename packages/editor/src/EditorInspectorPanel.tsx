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
 */
import {
  clearClipKeyframes,
  clipSourceFrame,
  removeClipKeyframe,
  upsertClipKeyframe,
} from './clipKeyframes';
import { ClipInspectorPanel } from './ClipInspectorPanel';
import { findClip } from './timeline';
import { useEditorTimelineStore } from './timelineStore';

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

  const applyTransform = (
    patch: Partial<{ opacity: number; position_x: number; position_y: number; scale: number; rotation: number }>,
  ) => {
    if (!primary || !selectedClip || selectedIdx < 0) return;
    applyOp({
      kind: 'set_clip_transform',
      track: primary.track,
      clip: selectedIdx,
      opacity: patch.opacity ?? selectedClip.opacity ?? 1,
      position_x: patch.position_x ?? selectedClip.position_x ?? 0,
      position_y: patch.position_y ?? selectedClip.position_y ?? 0,
      scale: patch.scale ?? selectedClip.scale ?? 1,
      rotation: patch.rotation ?? selectedClip.rotation ?? 0,
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
      clip={selectedClip}
      trackLocked={selectedTrackLocked}
      clipKeyframes={clipKeyframes}
      keyedHere={keyedHere}
      onTransformChange={applyTransform}
      onUpsertKeyframe={doUpsertKeyframe}
      onRemoveKeyframeHere={doRemoveKeyframeHere}
      onClearKeyframes={doClearKeyframes}
    />
  );
}
