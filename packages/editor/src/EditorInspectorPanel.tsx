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
 * D-193 — this is also where `ClipInspectorPanel`'s new Width/Height fields
 * get their `chroma_timeline_clip_geometry` fetch (`useClipGeometry`, the
 * same hook `TransformOverlay.tsx` uses for the on-canvas box), keeping
 * that panel pure presentation per its own doc — this file already owns
 * every other piece of selected-clip derived state.
 *
 * D-208 — and it is where the per-property keyframe model lives: this file
 * derives every property's `PropertyState` (value at the playhead, animated
 * or not, its own previous/next key) and owns the four new handlers
 * (`onParamChange`/`onKeyframeToggle`/`onKeyframeNav`/`onResetParam`).
 * `ClipInspectorPanel` stays pure presentation, exactly as before.
 */
import {
  adjacentParamKeyframeFrame,
  clearClipKeyframes,
  clipSourceFrame,
  clipTimelineFrame,
  hasParamKeyframes,
  mergeClipKeyframeParams,
  paramValueAt,
  removeClipKeyframe,
  removeClipKeyframeParam,
  type ClipKeyframe,
} from './clipKeyframes';
import { ClipInspectorPanel, type FadePatch, type PropertyState, type TransformPatch } from './ClipInspectorPanel';
import {
  CLIP_TRANSFORM_DEFAULTS,
  DEFAULT_FADE_CURVE,
  findClip,
  timelineFps,
  type ClipTransformParam,
} from './timeline';
import { useEditorTimelineStore } from './timelineStore';
import { useClipGeometry } from './useClipGeometry';

export function EditorInspectorPanel() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const playhead = useEditorTimelineStore((s) => s.playhead);
  const selection = useEditorTimelineStore((s) => s.selection);
  const applyOp = useEditorTimelineStore((s) => s.applyOp);
  // D-208 — the `<` / `>` per-property keyframe nav moves the playhead.
  const setPlayhead = useEditorTimelineStore((s) => s.setPlayhead);

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
  // absolute timeline position — see `clipKeyframes.ts`'s doc. B-079 —
  // fps-aware as of this pass, so this needs the project's own rate.
  const clipKfSourceFrame = selectedClip ? clipSourceFrame(selectedClip, playhead, timelineFps(timeline)) : 0;
  const clipKeyframes = selectedClip?.chroma_keyframes ?? [];
  const keyedHere = clipKeyframes.some((k) => k.frame === Math.round(clipKfSourceFrame));

  // D-193 — the same `chroma_timeline_clip_geometry` fetch `TransformOverlay.
  // tsx` uses for the on-canvas box, needed here for `ClipInspectorPanel`'s
  // Width/Height fields to convert composition-fraction sizes to real
  // pixels and back.
  const geometry = useClipGeometry(primary?.track ?? null, selectedIdx, selectedClip?.source_path);

  // D-132 — crop joins the transform patch rather than getting its own op:
  // one clip-geometry write, one history entry, one save. See the
  // `set_clip_transform` op's own doc in `timeline.ts` for why.
  //
  // D-193 — `box_width`/`box_height` join the same patch for the same
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

  // D-208 — every keyframeable property's static (un-animated) value, read
  // once here through `CLIP_TRANSFORM_DEFAULTS` instead of nine scattered
  // `?? 1` / `?? 0` fallbacks that could each drift from the backend's own
  // defaults independently.
  const staticValue = (param: ClipTransformParam): number =>
    (selectedClip?.[param] as number | undefined) ?? CLIP_TRANSFORM_DEFAULTS[param];

  // D-208 — one write of a `set_clip_keyframes` op, so every per-property
  // handler below stays a single expression and none of them can forget the
  // guard or the track/clip indices.
  const applyKeyframes = (keyframes: ClipKeyframe[] | undefined) => {
    if (!primary || selectedIdx < 0) return;
    applyOp({ kind: 'set_clip_keyframes', track: primary.track, clip: selectedIdx, keyframes: keyframes ?? [] });
  };

  // D-208 — what `ClipInspectorPanel` renders each row from. `value` is the
  // property's value AT THE PLAYHEAD (interpolated when animated), and
  // `prevFrame`/`nextFrame` are TIMELINE frames (`clipTimelineFrame` runs
  // the key's own source frame back through `source_fps`), ready to hand
  // straight to `setPlayhead`.
  const paramState = (param: ClipTransformParam): PropertyState => {
    const prev = adjacentParamKeyframeFrame(clipKeyframes, param, clipKfSourceFrame, -1);
    const next = adjacentParamKeyframeFrame(clipKeyframes, param, clipKfSourceFrame, 1);
    const toTimeline = (f: number | null) =>
      f === null || !selectedClip ? null : clipTimelineFrame(selectedClip, f, timelineFps(timeline));
    return {
      value: paramValueAt(clipKeyframes, param, clipKfSourceFrame, staticValue(param)),
      animated: hasParamKeyframes(clipKeyframes, param),
      keyedHere: clipKeyframes.some(
        (k) => k.frame === Math.round(clipKfSourceFrame) && Object.prototype.hasOwnProperty.call(k.params, param),
      ),
      prevFrame: toTimeline(prev),
      nextFrame: toTimeline(next),
    };
  };

  const paramStates = Object.fromEntries(
    (Object.keys(CLIP_TRANSFORM_DEFAULTS) as ClipTransformParam[]).map((p) => [p, paramState(p)]),
  ) as Record<ClipTransformParam, PropertyState>;

  /** D-208 — edit ONE property's value.
   *
   *  Animated: the edit lands on that property's own keyframe at the
   *  playhead (created if there isn't one yet) — the standard NLE
   *  auto-keyframe-on-edit, and the only behaviour that isn't a lie, since
   *  the keyframe is what the renderer actually reads. Static: an ordinary
   *  `set_clip_transform` write. One op either way, so one history entry
   *  per edit.
   *
   *  D-193 — editing `scale` additionally clears any independent
   *  Width/Height override, so that field stays a real "go back to plain
   *  uniform scale" affordance rather than one that silently does nothing
   *  once an override exists. That clear rides the same `set_clip_transform`
   *  in the static case; in the animated case it is a second op, but only
   *  when an override actually exists (the rare case), so the ordinary
   *  animated edit stays one op. */
  const applyParam = (param: ClipTransformParam, value: number) => {
    if (!primary || !selectedClip || selectedIdx < 0 || !Number.isFinite(value)) return;
    if (hasParamKeyframes(clipKeyframes, param)) {
      if (param === 'scale' && (selectedClip.box_width != null || selectedClip.box_height != null)) {
        applyTransform({ box_width: null, box_height: null });
      }
      applyKeyframes(mergeClipKeyframeParams(clipKeyframes, clipKfSourceFrame, { [param]: value }));
    } else {
      applyTransform(param === 'scale' ? { scale: value, box_width: null, box_height: null } : { [param]: value });
    }
  };

  /** D-208 — After Effects' stopwatch, for one property.
   *
   *  ON: key its CURRENT value at the playhead. With exactly one key,
   *  `interpolate_param` (Rust) / `keyframeExprAt` (export) both hold that
   *  value everywhere, so turning animation on is guaranteed to change no
   *  pixel — the property simply becomes animatable from here.
   *
   *  OFF: drop that property's keys, and bake the value it had at the
   *  playhead into its static field so the picture holds instead of snapping
   *  back to a stale static number. That bake is skipped when the two
   *  already agree, which is the common case and keeps the whole gesture to
   *  one op/one undo step; when they differ it is deliberately two ops (the
   *  edit model has one op per history entry — see `applyOp` — and there is
   *  no combined transform-and-keyframes op to reach for). */
  const toggleParamKeyframes = (param: ClipTransformParam) => {
    if (!primary || !selectedClip || selectedIdx < 0) return;
    if (hasParamKeyframes(clipKeyframes, param)) {
      const held = paramValueAt(clipKeyframes, param, clipKfSourceFrame, staticValue(param));
      if (held !== staticValue(param)) applyTransform({ [param]: held });
      applyKeyframes(removeClipKeyframeParam(clipKeyframes, param));
    } else {
      applyKeyframes(mergeClipKeyframeParams(clipKeyframes, clipKfSourceFrame, { [param]: staticValue(param) }));
    }
  };

  /** D-208 — jump the playhead to this property's own previous/next
   *  keyframe. A no-op when there is none in that direction (the button is
   *  disabled then too — this guard is for the keyboard-activated case). */
  const goToParamKeyframe = (param: ClipTransformParam, dir: -1 | 1) => {
    const target = dir < 0 ? paramStates[param].prevFrame : paramStates[param].nextFrame;
    if (target !== null) setPlayhead(target);
  };

  /** D-208 — put ONE property back to its rest value.
   *
   *  Always writes the static field (that is what "default" means, and it is
   *  the value the property falls back to if its animation is later turned
   *  off); when the property is animated it ALSO keys that default at the
   *  playhead, so the reset is visible immediately instead of being masked
   *  by the keyframes — Premiere's own behaviour for a keyframed property's
   *  reset, and non-destructive (it never silently deletes an animation).
   *
   *  `scale` additionally clears any independent Width/Height override, for
   *  exactly the D-193 reason its own number field does: without that, a
   *  clip with a `box_width`/`box_height` pair would report scale 1 while
   *  still rendering at the overridden size. */
  const resetParam = (param: ClipTransformParam) => {
    if (!primary || !selectedClip || selectedIdx < 0) return;
    const value = CLIP_TRANSFORM_DEFAULTS[param];
    applyTransform(param === 'scale' ? { scale: value, box_width: null, box_height: null } : { [param]: value });
    if (hasParamKeyframes(clipKeyframes, param)) {
      applyKeyframes(mergeClipKeyframeParams(clipKeyframes, clipKfSourceFrame, { [param]: value }));
    }
  };

  // D-208 — "Key all properties": the same MERGE every per-property write
  // uses, with all nine names at once, so it can never clobber a key a
  // single property's diamond already put at this frame (the pre-D-208
  // `upsertClipKeyframe` replaced the entry's whole `params` object and
  // would have).
  //
  // D-132 — the crop insets are keyed alongside everything else, which is
  // what makes them animatable at all: `resolve_clip_transform` (Rust) reads
  // them out of this same flat params object through the D-034 interpolator.
  const doUpsertKeyframe = () => {
    if (!primary || !selectedClip || selectedIdx < 0) return;
    // Each property's value AT THE PLAYHEAD, not its static field — for an
    // already-animated property those differ, and "pin everything as it is
    // right now" means the former.
    const all = Object.fromEntries(
      (Object.keys(CLIP_TRANSFORM_DEFAULTS) as ClipTransformParam[]).map((p) => [p, paramStates[p].value]),
    );
    applyKeyframes(mergeClipKeyframeParams(clipKeyframes, clipKfSourceFrame, all));
  };

  const doRemoveKeyframeHere = () => applyKeyframes(removeClipKeyframe(clipKeyframes, clipKfSourceFrame));

  const doClearKeyframes = () => applyKeyframes(clearClipKeyframes());

  return (
    <ClipInspectorPanel
      // D-193 — remounts `ClipInspectorPanel` on every new clip selection,
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
      paramStates={paramStates}
      onTransformChange={applyTransform}
      onFadeChange={applyFade}
      onParamChange={applyParam}
      onKeyframeToggle={toggleParamKeyframes}
      onKeyframeNav={goToParamKeyframe}
      onResetParam={resetParam}
      onUpsertKeyframe={doUpsertKeyframe}
      onRemoveKeyframeHere={doRemoveKeyframeHere}
      onClearKeyframes={doClearKeyframes}
    />
  );
}
