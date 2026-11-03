/**
 * @apelles/editor — the Edit tab's Inspector, as a full-height sibling panel
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
 *
 * D-223 — the per-clip audio properties (`volume`/`pan`) join that same model
 * rather than getting a parallel one: one `paramStates` record over
 * `CLIP_KEYFRAME_DEFAULTS` (transform ∪ audio), one set of four handlers, one
 * keyframe path. The ONE thing that branches is where a STATIC edit is
 * written — `set_clip_audio` for the audio pair, `set_clip_transform` for the
 * rest ([`staticWrite`] below) — because a level is not geometry and does not
 * belong in a transform write (see the ops' own docs). "Key all properties"
 * deliberately stays transform+crop only; see `doUpsertKeyframe`.
 *
 * D-224 — the per-clip EQ deliberately does NOT join that model, and the
 * reason is worth stating rather than inferring from its absence: an EQ band
 * here is STATIC (ffmpeg's biquad filters parse their parameters once, so an
 * animated EQ cannot be exported at all — see D-224), so it has no
 * `PropertyState`, no diamond and no place in `paramStates`. What it gets
 * instead is its own pair of handlers below (`applyEqBand`/`clearEq`) writing
 * its own `set_clip_eq` op, exactly as the level pair writes `set_clip_audio`.
 *
 * D-274 — when NOTHING is selected (`selection.length === 0`), this component
 * renders `ProjectSettingsPanel` instead of `ClipInspectorPanel`, filling the
 * column's own former "Select a clip to edit its properties" empty state with
 * the project's own output spec. Deliberately scoped to the genuinely-empty
 * case only, not `!selectedClip` in general: a multi-selection (`selection.
 * length > 1`) still falls through to `ClipInspectorPanel`'s own empty state
 * (Phase 1's documented multi-select fallback, `docs/notes/multi-select.md`)
 * unchanged — showing Project Settings there would misreport "nothing is
 * selected" when several clips actually are.
 */
import { useDeferredValue } from 'react';
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
import { ClipInspectorPanel, type FadePatch, type TransformPatch } from './ClipInspectorPanel';
import { ProjectSettingsPanel } from './ProjectSettingsPanel';
import {
  applyDynamicZoom,
  dynamicZoomFramings,
  dynamicZoomIsStatic,
  dynamicZoomSpan,
  dynamicZoomWouldReplace,
} from './dynamicZoom';
import type { PropertyState } from './PropertyRow';
import {
  CLIP_KEYFRAME_DEFAULTS,
  CLIP_TRANSFORM_DEFAULTS,
  DEFAULT_EASE_CURVE,
  EASE_PRESETS,
  easePresetName,
  isClipAudioParam,
  timelineFps,
  type ClipAudioParam,
  type ClipKeyframeParam,
  type ClipTransformParam,
  type EaseCurve,
  type EqBand,
  type Timeline,
} from './timeline';
import type { SpeedPoint } from './speedRamp';
import { useEditorTimelineStore, type Selection } from './timelineStore';
import { inspectorTarget, paramFacet, type ClipTarget } from './inspectorTarget';
import { useClipGeometry } from './useClipGeometry';

/** One facet's clip plus the keyframe context every per-property handler
 *  needs: that clip's own keys and the playhead's source frame within it. */
interface FacetCtx {
  target: ClipTarget | null;
  keyframes: ClipKeyframe[];
  sourceFrame: number;
}

/** D-437 S10 — `EditorInspectorPanel`'s playhead selector: the playhead while
 *  the selected clip (either facet of a linked pair) has keyframes, whose
 *  values the rows show at the playhead; otherwise `-1`, a constant, so
 *  playback does not render the panel. Exported for its render-count test. */
export function inspectorPlayhead(s: { timeline: Timeline | null; selection: readonly Selection[]; playhead: number }): number {
  const selected = s.selection.length === 1 ? s.selection[0] : null;
  if (!selected) return -1;
  const keyed = (t: ClipTarget | null) => (t?.clip.chroma_keyframes?.length ?? 0) > 0;
  return keyed(inspectorTarget(s.timeline, selected, 'video')) || keyed(inspectorTarget(s.timeline, selected, 'audio'))
    ? s.playhead
    : -1;
}

export function EditorInspectorPanel() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  // D-437 S10 — the playhead only while something on screen depends on it: a
  // selected clip with keyframes shows each property's value AT the playhead.
  // Otherwise the selector answers a constant and a played frame renders this
  // panel zero times (it used to render the whole Inspector per frame). The
  // handlers that write at the playhead read it live (`liveSourceFrame`), and
  // the Speed section's "add a point here" subscribes for itself.
  const playhead = useEditorTimelineStore(inspectorPlayhead);
  // D-437 S10 — the selection this panel SHOWS is deferred (React's
  // `useDeferredValue`): a click or a select-and-trim release commits the
  // timeline's own change first, and the Inspector's re-mount for the new clip
  // (its tabs, sections and Base UI composites, plus the layout read a
  // composite's first mount forces) renders in the background right after,
  // interruptible, instead of inside the release frame (measured at 300 clips:
  // about half of that frame's React work). By id, so a timeline that changed
  // underneath still resolves the right clip.
  const liveSelection = useEditorTimelineStore((s) => s.selection);
  const selection = useDeferredValue(liveSelection);
  const applyOp = useEditorTimelineStore((s) => s.applyOp);
  // D-208 — the `<` / `>` per-property keyframe nav moves the playhead.
  const setPlayhead = useEditorTimelineStore((s) => s.setPlayhead);
  const curveEditor = useEditorTimelineStore((s) => s.curveEditor);
  const setCurveEditor = useEditorTimelineStore((s) => s.setCurveEditor);
  // D-234 — the dynamic-zoom authoring mode, armed from this panel and drawn
  // by `DynamicZoomOverlay`. Store state, never persisted — see its field doc.
  const dynamicZoom = useEditorTimelineStore((s) => s.dynamicZoom);
  const setDynamicZoom = useEditorTimelineStore((s) => s.setDynamicZoom);
  // D-246 — which Inspector tab is showing. Store state, not this component's
  // own `useState`, for the two reasons its field doc gives: the panel below
  // is remounted per clip selection, and the debug op drives the same state
  // the human's click does.
  const inspectorTab = useEditorTimelineStore((s) => s.inspectorTab);
  const setInspectorTab = useEditorTimelineStore((s) => s.setInspectorTab);

  // Same Phase 1 multi-select fallback `TimelinePane.tsx` already uses for
  // every single-clip-only consumer (docs/notes/multi-select.md): a
  // selection that isn't exactly one clip falls back to the empty state,
  // it isn't a real N-clip batch-edit contract yet.
  const selected = selection.length === 1 ? selection[0] : null;

  // B-334/D-430 — a linked A/V pair is one shot in the Inspector: the Video
  // tab reads and writes the PICTURE half and the Audio tab the AUDIBLE audio
  // partner, whichever half is selected (`inspectorTarget.ts`). Everything
  // below that is not explicitly audio therefore speaks of the picture half —
  // `primary` is that half (not the raw selection), so `selectedClip`,
  // `selectedIdx` and every `primary.track` write already address it.
  const videoTarget = inspectorTarget(timeline, selected, 'video');
  const audioTarget = inspectorTarget(timeline, selected, 'audio');
  const primary = videoTarget ? { track: videoTarget.track, id: videoTarget.clip.id } : null;
  const selectedClip = videoTarget?.clip ?? null;
  const selectedIdx = videoTarget?.index ?? -1;
  const selectedTrackLocked = videoTarget ? !!timeline?.tracks[videoTarget.track]?.locked : false;
  const audioTrackLocked = audioTarget ? !!timeline?.tracks[audioTarget.track]?.locked : false;

  // Keyframes are interpolated against the clip's own SOURCE frame, not the
  // absolute timeline position — see `clipKeyframes.ts`'s doc. B-079 —
  // fps-aware as of this pass, so this needs the project's own rate. One
  // context per facet: the picture half and the audio partner each have their
  // own clip, keys and source frame.
  const fps = timelineFps(timeline);
  const facetCtx = (t: ClipTarget | null): FacetCtx => ({
    target: t,
    keyframes: t?.clip.chroma_keyframes ?? [],
    sourceFrame: t ? clipSourceFrame(t.clip, playhead, fps) : 0,
  });
  /** The playhead's source frame in `t` NOW, for the handlers that write at
   *  the playhead: the render's `playhead` is a constant when nothing is
   *  keyframed (`inspectorPlayhead`). */
  const liveSourceFrame = (t: ClipTarget | null) =>
    t ? clipSourceFrame(t.clip, useEditorTimelineStore.getState().playhead, fps) : 0;
  const ctxVideo = facetCtx(videoTarget);
  const ctxAudio = facetCtx(audioTarget);
  const clipKfSourceFrame = ctxVideo.sourceFrame;
  const clipKeyframes = ctxVideo.keyframes;
  const keyedHere = clipKeyframes.some((k) => k.frame === Math.round(clipKfSourceFrame));

  // D-193 — the same `chroma_timeline_clip_geometry` fetch `TransformOverlay.
  // tsx` uses for the on-canvas box, needed here for `ClipInspectorPanel`'s
  // Width/Height fields to convert composition-fraction sizes to real
  // pixels and back.
  const geometry = useClipGeometry(primary?.track ?? null, selectedIdx, selectedClip?.source_path, selectedClip?.scaling);

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
      // D-425 — only sent when the patch states it; absent leaves the mode.
      ...(patch.scaling !== undefined ? { scaling: patch.scaling } : {}),
      rotation: patch.rotation ?? selectedClip.rotation ?? 0,
      crop_left: patch.crop_left ?? selectedClip.crop_left ?? 0,
      crop_top: patch.crop_top ?? selectedClip.crop_top ?? 0,
      crop_right: patch.crop_right ?? selectedClip.crop_right ?? 0,
      crop_bottom: patch.crop_bottom ?? selectedClip.crop_bottom ?? 0,
      corner_radius: patch.corner_radius ?? selectedClip.corner_radius ?? 0,
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
      fade_in_curve: patch.fade_in_curve ?? selectedClip.fade_in_curve ?? DEFAULT_EASE_CURVE,
      fade_out_curve: patch.fade_out_curve ?? selectedClip.fade_out_curve ?? DEFAULT_EASE_CURVE,
    });
  };

  // D-236 — the speed ramp gets its own op, for `set_clip_fade`'s reasons
  // exactly (speed is not geometry, and it applies to audio clips with no
  // transform at all). Whole-array replacement, like `set_clip_keyframes`:
  // `SpeedRampEditor` computes the next point list and this writes it.
  const applySpeed = (points: SpeedPoint[]) => {
    if (!primary || !selectedClip || selectedIdx < 0) return;
    applyOp({ kind: 'set_clip_speed', track: primary.track, clip: selectedIdx, points });
  };

  // D-223 — per-clip volume/pan get their own op, for exactly the reason
  // fades do (a level is not geometry — see `set_clip_audio`'s own doc). Both
  // fields are independently optional there, so unlike `applyTransform` /
  // `applyFade` this does NOT restate the clip's other value: an omitted field
  // is left alone by the reducer itself.
  const applyAudio = (patch: Partial<Record<ClipAudioParam, number>>) => {
    if (!audioTarget) return;
    applyOp({ kind: 'set_clip_audio', track: audioTarget.track, clip: audioTarget.index, ...patch });
  };

  // D-224 — per-clip EQ gets its own op too, for `set_clip_audio`'s own
  // reasons (an EQ is not geometry and not a level). One BAND per call, and
  // partial by field, so a Gain nudge cannot restate a frequency it never
  // looked at — the reducer materialises the default four-band strip for a
  // clip that has no EQ yet, so the panel never has to.
  const applyEqBand = (band: number, patch: Partial<EqBand>) => {
    if (!audioTarget) return;
    applyOp({ kind: 'set_clip_eq', track: audioTarget.track, clip: audioTarget.index, band, patch });
  };

  const clearEq = () => {
    if (!audioTarget) return;
    applyOp({ kind: 'set_clip_eq', track: audioTarget.track, clip: audioTarget.index, clear: true });
  };

  // D-208 — every keyframeable property's static (un-animated) value, read
  // once here through `CLIP_KEYFRAME_DEFAULTS` instead of eleven scattered
  // `?? 1` / `?? 0` fallbacks that could each drift from the backend's own
  // defaults independently.
  const ctxOf = (param: ClipKeyframeParam): FacetCtx => (paramFacet(param) === 'audio' ? ctxAudio : ctxVideo);
  const staticValue = (param: ClipKeyframeParam): number =>
    (ctxOf(param).target?.clip[param] as number | undefined) ?? CLIP_KEYFRAME_DEFAULTS[param];

  /** D-223 — write ONE property's static field through the op that owns it.
   *  The only place the transform/audio split shows up in this file's
   *  per-property handlers; everything else about them is identical, which is
   *  the whole point of keeping one set of handlers rather than two. */
  const staticWrite = (param: ClipKeyframeParam, value: number) => {
    if (isClipAudioParam(param)) applyAudio({ [param]: value });
    // D-193 — editing `scale` also clears any independent Width/Height
    // override, so that field stays a real "back to plain uniform scale"
    // affordance rather than one that silently does nothing.
    else if (param === 'scale') applyTransform({ scale: value, box_width: null, box_height: null });
    else applyTransform({ [param]: value });
  };

  // D-208 — one write of a `set_clip_keyframes` op, so every per-property
  // handler below stays a single expression and none of them can forget the
  // guard or the track/clip indices.
  const applyKeyframes = (keyframes: ClipKeyframe[] | undefined, ctx: FacetCtx = ctxVideo) => {
    if (!ctx.target) return;
    applyOp({ kind: 'set_clip_keyframes', track: ctx.target.track, clip: ctx.target.index, keyframes: keyframes ?? [] });
  };

  // D-208 — what `ClipInspectorPanel` renders each row from. `value` is the
  // property's value AT THE PLAYHEAD (interpolated when animated), and
  // `prevFrame`/`nextFrame` are TIMELINE frames (`clipTimelineFrame` runs
  // the key's own source frame back through `source_fps`), ready to hand
  // straight to `setPlayhead`.
  const paramState = (param: ClipKeyframeParam): PropertyState => {
    const { target, keyframes, sourceFrame } = ctxOf(param);
    const prev = adjacentParamKeyframeFrame(keyframes, param, sourceFrame, -1);
    const next = adjacentParamKeyframeFrame(keyframes, param, sourceFrame, 1);
    const toTimeline = (f: number | null) => (f === null || !target ? null : clipTimelineFrame(target.clip, f, fps));
    return {
      value: paramValueAt(keyframes, param, sourceFrame, staticValue(param)),
      animated: hasParamKeyframes(keyframes, param),
      keyedHere: keyframes.some(
        (k) => k.frame === Math.round(sourceFrame) && Object.prototype.hasOwnProperty.call(k.params, param),
      ),
      prevFrame: toTimeline(prev),
      nextFrame: toTimeline(next),
    };
  };

  const paramStates = Object.fromEntries(
    (Object.keys(CLIP_KEYFRAME_DEFAULTS) as ClipKeyframeParam[]).map((p) => [p, paramState(p)]),
  ) as Record<ClipKeyframeParam, PropertyState>;

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
  const applyParam = (param: ClipKeyframeParam, value: number) => {
    const ctx = ctxOf(param);
    if (!ctx.target || !Number.isFinite(value)) return;
    if (hasParamKeyframes(ctx.keyframes, param)) {
      if (param === 'scale' && (ctx.target.clip.box_width != null || ctx.target.clip.box_height != null)) {
        applyTransform({ box_width: null, box_height: null });
      }
      applyKeyframes(mergeClipKeyframeParams(ctx.keyframes, liveSourceFrame(ctx.target), { [param]: value }), ctx);
    } else {
      staticWrite(param, value);
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
  const toggleParamKeyframes = (param: ClipKeyframeParam) => {
    const ctx = ctxOf(param);
    if (!ctx.target) return;
    if (hasParamKeyframes(ctx.keyframes, param)) {
      const held = paramValueAt(ctx.keyframes, param, liveSourceFrame(ctx.target), staticValue(param));
      if (held !== staticValue(param)) staticWrite(param, held);
      applyKeyframes(removeClipKeyframeParam(ctx.keyframes, param), ctx);
    } else {
      applyKeyframes(mergeClipKeyframeParams(ctx.keyframes, liveSourceFrame(ctx.target), { [param]: staticValue(param) }), ctx);
    }
  };

  /** D-208 — jump the playhead to this property's own previous/next
   *  keyframe. A no-op when there is none in that direction (the button is
   *  disabled then too — this guard is for the keyboard-activated case). */
  const goToParamKeyframe = (param: ClipKeyframeParam, dir: -1 | 1) => {
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
  const resetParam = (param: ClipKeyframeParam) => {
    const ctx = ctxOf(param);
    if (!ctx.target) return;
    const value = CLIP_KEYFRAME_DEFAULTS[param];
    staticWrite(param, value);
    if (hasParamKeyframes(ctx.keyframes, param)) {
      applyKeyframes(mergeClipKeyframeParams(ctx.keyframes, liveSourceFrame(ctx.target), { [param]: value }), ctx);
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
  //
  // D-223 — `CLIP_TRANSFORM_DEFAULTS`, deliberately, NOT the merged
  // `CLIP_KEYFRAME_DEFAULTS`: this button's own label and tooltip say
  // "transform and crop", it sits in a section about the clip's geometry, and
  // silently keying a clip's volume and pan as a side effect of "pin the
  // picture as it is" would be an animation the user never asked for on a
  // property they may not even have open. The two audio rows have their own
  // diamonds, which is the affordance for keying them.
  const doUpsertKeyframe = () => {
    if (!primary || !selectedClip || selectedIdx < 0) return;
    // Each property's value AT THE PLAYHEAD, not its static field — for an
    // already-animated property those differ, and "pin everything as it is
    // right now" means the former.
    const all = Object.fromEntries(
      (Object.keys(CLIP_TRANSFORM_DEFAULTS) as ClipTransformParam[]).map((p) => [p, paramStates[p].value]),
    );
    applyKeyframes(mergeClipKeyframeParams(clipKeyframes, liveSourceFrame(videoTarget), all));
  };

  const doRemoveKeyframeHere = () => applyKeyframes(removeClipKeyframe(clipKeyframes, liveSourceFrame(videoTarget)));

  const doClearKeyframes = () => applyKeyframes(clearClipKeyframes());

  /**
   * D-233 — open (or toggle off) one property's ease curve in the timeline's
   * curve editor lane.
   *
   * The Inspector does not render the lane; it only names the target, exactly
   * as the timeline's own curve button does, and the store is the one place
   * that target lives (see `CurveEditorTarget`). That is what lets the two
   * affordances stay in step: pressing the timeline's button lights up the
   * matching Inspector row's, and vice versa, with no state to synchronise.
   */
  const toggleParamCurve = (param: ClipKeyframeParam) => {
    const target = ctxOf(param).target;
    if (!target) return;
    const open = curveEditor?.id === target.clip.id && curveEditor?.param === param;
    setCurveEditor(open ? null : { track: target.track, id: target.clip.id, param });
  };

  /** Which property's curve is open, but only when it belongs to the clip this
   *  panel is showing — otherwise a row here would light up for a curve that
   *  is open on some other clip. */
  const openCurveParam =
    curveEditor && ctxOf(curveEditor.param).target?.clip.id === curveEditor.id ? curveEditor.param : null;

  // ---- D-234: dynamic zoom -------------------------------------------------
  //
  // The MODE (which clip's boxes the viewer shows, and the ease the next bake
  // uses) is store state; the KEYFRAMES it bakes are the only thing persisted.
  // Arming and disarming therefore write nothing at all — see
  // `dynamicZoom.ts`'s module doc for why this feature is a shortcut on top of
  // the existing keyframe model rather than a new one.
  const dynamicZoomArmed = !!dynamicZoom && !!selectedClip && dynamicZoom.clipId === selectedClip.id;
  // `?? EASE_PRESETS[0].name` covers the disarmed case (nothing to name) and
  // the theoretical custom curve an MCP caller could arm with; `linear` is
  // what both mean to this picker.
  const dynamicZoomEasePreset = (dynamicZoomArmed ? easePresetName(dynamicZoom?.curve) : null) ?? EASE_PRESETS[0].name;

  const armDynamicZoom = (armed: boolean) => {
    if (!selectedClip) return;
    setDynamicZoom(armed ? { clipId: selectedClip.id, curve: dynamicZoom?.curve ?? DEFAULT_EASE_CURVE } : null);
  };

  /** Changing the ease RE-BAKES immediately, rather than waiting for the next
   *  drag. The boxes are already on screen at their real framings, so "ease
   *  in" has an unambiguous meaning right now — and re-baking is exactly what
   *  a drag would do anyway, with the same one-op/one-undo cost. On a clip
   *  with no zoom authored yet (both framings identical) it writes nothing:
   *  there is no animation to re-shape, and keying a static hold would be an
   *  edit the user did not ask for. */
  const setDynamicZoomEase = (curve: EaseCurve) => {
    if (!selectedClip) return;
    setDynamicZoom({ clipId: selectedClip.id, curve });
    const { start, end } = dynamicZoomFramings(selectedClip);
    if (dynamicZoomIsStatic(start, end)) return;
    const span = dynamicZoomSpan(selectedClip);
    applyKeyframes(applyDynamicZoom(clipKeyframes, start, end, span.first, span.last, curve));
  };

  /** Resolve's own Swap button: the start framing becomes the end and vice
   *  versa, turning a push-in into a pull-out. A no-op on a clip with no zoom
   *  yet, for the same reason the ease change is. */
  const swapDynamicZoom = () => {
    if (!selectedClip || !dynamicZoom) return;
    const { start, end } = dynamicZoomFramings(selectedClip);
    if (dynamicZoomIsStatic(start, end)) return;
    const span = dynamicZoomSpan(selectedClip);
    applyKeyframes(applyDynamicZoom(clipKeyframes, end, start, span.first, span.last, dynamicZoom.curve));
  };

  // D-274 — nothing selected at all fills this column with Project Settings
  // instead of the generic "Select a clip" message; see this file's own
  // module doc for why a multi-selection deliberately does NOT take this
  // branch.
  if (selection.length === 0) {
    return <ProjectSettingsPanel />;
  }

  return (
    <ClipInspectorPanel
      // D-193 — remounts `ClipInspectorPanel` on every new clip selection,
      // which is what resets that component's own local ratio-lock state
      // (ephemeral UI state, not a `Clip` field — see that file's own doc)
      // back to the right default for the newly-selected clip, without
      // this file having to own or thread that state itself.
      key={`${selectedClip?.id ?? 'none'}|${audioTarget?.clip.id ?? 'none'}`}
      clip={selectedClip}
      audioClip={audioTarget?.clip ?? null}
      trackLocked={selectedTrackLocked}
      audioTrackLocked={audioTrackLocked}
      geometry={geometry}
      clipKeyframes={clipKeyframes}
      keyedHere={keyedHere}
      paramStates={paramStates}
      onTransformChange={applyTransform}
      onFadeChange={applyFade}
      onSpeedChange={applySpeed}
      onEqBandChange={applyEqBand}
      onEqClear={clearEq}
      onParamChange={applyParam}
      onKeyframeToggle={toggleParamKeyframes}
      onKeyframeNav={goToParamKeyframe}
      onResetParam={resetParam}
      onOpenCurve={toggleParamCurve}
      openCurveParam={openCurveParam}
      onUpsertKeyframe={doUpsertKeyframe}
      onRemoveKeyframeHere={doRemoveKeyframeHere}
      onClearKeyframes={doClearKeyframes}
      dynamicZoomArmed={dynamicZoomArmed}
      dynamicZoomEasePreset={dynamicZoomEasePreset}
      dynamicZoomWouldReplace={dynamicZoomWouldReplace(clipKeyframes)}
      onDynamicZoomArm={armDynamicZoom}
      onDynamicZoomEase={setDynamicZoomEase}
      onDynamicZoomSwap={swapDynamicZoom}
      tab={inspectorTab}
      onTabChange={setInspectorTab}
    />
  );
}
