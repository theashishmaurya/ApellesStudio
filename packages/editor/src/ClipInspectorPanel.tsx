/**
 * @apelles/editor — the Inspector, NLE half (D-102, Phase 3 of
 * `docs/notes/global-inspector.md`).
 *
 * A real, persistent property panel for the selected clip's compositing
 * transform (opacity/position/scale/rotation), its **crop** (D-132, four
 * normalised source-space edge insets — the owner's "no UI for crop" ask,
 * and Phase 3 of `docs/notes/on-canvas-transform.md`) and keyframes — the same
 * fields, the same ops (`set_clip_transform`/`set_clip_keyframes`), and the
 * same keyframe CRUD (`clipKeyframes.ts`, itself mirroring `RelightPanel.
 * tsx`'s pattern) the D-090 popover this replaced already used. This
 * component is pure presentation — it takes `clip`/`clipKeyframes`/the
 * transform-and-keyframe callbacks as props and renders them, nothing else.
 *
 * D-118 — **who owns those props changed, this component's own contract
 * didn't.** D-102/D-103 had `TimelinePane.tsx` compute `selectedClip`/
 * `applyTransform`/the keyframe CRUD functions inline and render this panel
 * as a third pane nested in its own `ResizablePanelGroup` (capped at the
 * timeline's own height, not the tab's). The owner asked for this panel
 * full-height instead ("like source control... instead of being in the
 * timeline"), so `EditorInspectorPanel.tsx` is now the real owner of that
 * derivation — `TimelinePane.tsx` no longer renders `ClipInspectorPanel` at
 * all. `selection`/`selectedGap` moved from `TimelinePane`'s local
 * `useState` into `useEditorTimelineStore` in the same pass (see that
 * file's doc), specifically so both components can read the one shared
 * selection without prop-drilling through a parent that doesn't otherwise
 * need it. This file's own props/JSX are unchanged — only its caller moved.
 *
 * D-090's popover is REMOVED, not kept alongside this panel — same field
 * set, same ops, a persistent panel is strictly better UX for exactly the
 * kind of "nudge a value, watch the preview" iteration this editor
 * supports, and having both would mean two controls that can edit the same
 * clip out of sync with each other for no real benefit.
 *
 * D-103 (Phase 4): the empty-state message and section-heading styling come
 * from `@apelles/inspector` (a tiny shared package with no `@apelles/ui`
 * dependency — see its README), the same components `@apelles/motion`'s
 * `InspectorPanel.tsx` uses. The field layout (`row`/`numInput` below) stays
 * local and different from Motion's — this panel's side-by-side label/input
 * rows were built for a narrower panel with only numeric fields, Motion's
 * stacked label-above-input rows were built for a wider panel with
 * selects/colour-pickers too; forcing one shape onto the other would mean
 * rewriting a working, tested layout for no real benefit, exactly the
 * "don't force a deeper unification than is actually clean" call
 * `@apelles/inspector`'s README documents. Motion's `InspectorPanel.tsx` and
 * Colorist's `ControlsPanel` remain each tab's own always-visible right
 * panel — this pass only changed the Edit tab's own internal layout, not
 * `Shell.tsx` or the other two tabs (D-118's own decision entry has the
 * real reasoning for why this stayed tab-local, not a shell-level panel).
 *
 * **D-193 — Width/Height + ratio lock.** A single `scale` can only ever
 * produce a box with the clip's own natural (source) aspect ratio — see
 * `Clip.box_width`'s own doc for the full "why" and B-074's own finding
 * that this made a full-width/half-height stacked layout mathematically
 * impossible. This panel's new Size rows show the box's real pixel size
 * (given the project's own known composition size — `geometry`, a new
 * prop, since the actual `chroma_timeline_clip_geometry` fetch lives in
 * `EditorInspectorPanel.tsx`/`useClipGeometry.ts`, keeping this component
 * pure presentation per its own doc above) with a padlock toggle between
 * them: locked (the default for a clip with no override yet) keeps both
 * fields moving together in the ratio currently on screen; unlocked lets
 * Width and Height be set independently, freezing whichever axis wasn't
 * just edited at its current value so it never jumps as a side effect of
 * editing the other. Both modes write `box_width`/`box_height` — `Scale`
 * above stays a separate, always-available "reset to simple uniform mode"
 * control: editing it clears both overrides back to `null`. The lock
 * boolean itself is local, ephemeral UI state (not persisted on `Clip`,
 * reset per clip via the `key={clip.id}` `EditorInspectorPanel.tsx` mounts
 * this component with) — see D-193's decision entry for why: once a real
 * width/height pair is stored, "was it locked when I typed this" carries
 * no independent information a future session needs back.
 *
 * **D-208 — per-property keyframing and per-property reset.** Every Transform
 * and Crop row is now one `PropertyRow`, carrying (left to right) its label,
 * its number field, a `<`/`>` pair that walks the playhead to that property's
 * OWN previous/next keyframe, a diamond that toggles keyframing for that one
 * property (After Effects' stopwatch: filled = animated, hollow = static),
 * and an `ArrowCounterClockwise` reset to that field's default — the same icon and
 * meaning Colorist's `ControlsPanel` already uses for its own reset actions,
 * reused rather than invented. The value shown is the property's value AT THE
 * PLAYHEAD (`EditorInspectorPanel` resolves it through `paramValueAt`), not
 * its static field, so an animated property reads what the preview is really
 * showing; editing it while animated keys that new value at the playhead.
 *
 * Width/Height (D-193) deliberately get NO diamond and NO reset: they are a
 * nullable, ratio-locked *pair*, so neither action is a well-defined
 * single-field operation, and `Scale`'s own field already is the "clear the
 * override" affordance. See `ClipTransformParam`'s doc and D-208.
 *
 * **D-223 — an Audio section: this clip's own Volume and Pan.** Two more
 * `PropertyRow`s, so both are keyframeable/navigable/resettable exactly like
 * every Transform and Crop row — the reuse `PropertyRow.tsx`'s own extraction
 * was for. Its own section rather than more Fade rows because the reference
 * (Resolve's Inspector, `scratch/resolve-reference/soundtrack.jpg`) presents
 * "Clip Volume"/"Clip Pan" as their own group, and because a level is a
 * different kind of thing from a fade's time-domain envelope. Hidden entirely
 * for a text clip, by the same `!clip.text` gate and for the same reason Crop
 * is: a generated title has no audio at all, so the rows would visibly do
 * nothing. The section's note is load-bearing, not decoration — it says the
 * clip's level MULTIPLIES with its track's gain (otherwise "I turned the track
 * down and this clip is still loud" reads as a bug) and states the 3 dB boost
 * a hard pan applies (the real, documented cost of this app's 0 dB-centre pan
 * law — `apelles_types::pan`).
 *
 * **D-224 — an EQ section: this clip's own multi-band parametric equaliser.**
 * FOUR bands, which is exactly what the same reference screenshot shows under
 * its response graph (`Band 1`…`Band 4`, each a name button that doubles as
 * that band's enable toggle, plus a shape dropdown). Each band renders that
 * header row plus three `PropertyRow`s — Freq, Gain, Q — so the numbers are
 * all real and every row inherits the field layout and per-field reset the
 * Transform rows already have.
 *
 * One deliberate difference from those rows, stated in D-224 rather than an
 * accident: **no keyframe diamond** — an EQ here is static, because ffmpeg's
 * biquad filters parse their parameters once as numbers, so an animated EQ is
 * not expressible in the export at all, and `PropertyRow` now renders no
 * keyframe controls when handed none rather than three dead buttons. Hidden
 * for a text clip, exactly as Audio and Crop are.
 *
 * **D-237 — the response CURVE**, the one half of D-224 deliberately deferred
 * there: `EqResponseGraph` (its own file) renders above these four band
 * blocks, matching the reference's own stacking order (graph, then `Band
 * 1`…`4`). A numbered, draggable point per band on the ±24 dB / log-frequency
 * plot, plus the whole strip's combined response as a filled/stroked line —
 * every dB value still comes from `eqResponseDb` (`./eq`), never re-derived.
 * The graph and these `PropertyRow`s write the SAME `onEqBandChange`, so a
 * drag and a typed value can never disagree about what a band's own numbers
 * are.
 *
 * **Roadmap 25 — `PropertyRow`/`PropertyState` now live in their own file**
 * (`PropertyRow.tsx`), generalised over any param-name type rather than
 * pinned to `ClipTransformParam` — see that file's own doc for why this was
 * worth extracting and why it stops there (not a cross-tab Inspector
 * unification). This file's own `TRANSFORM_FIELDS`/`CROP_FIELDS` and their
 * rendering are unchanged; only where the row itself is defined moved.
 *
 * **D-246 — VIDEO / AUDIO tabs, replacing one long scroll.** Every section
 * above accumulated into a single vertically-scrolling column: Transform,
 * Crop, Dynamic Zoom, Speed, Fade, Volume/Pan, a four-band EQ with its
 * response graph, Keyframes. The owner, working a real project, asked for the
 * video and audio halves to be separated — and the reference this panel has
 * been built against all along already does exactly that: DaVinci Resolve's
 * Inspector is a tabbed Video / Audio / Effects / File strip, with Transform,
 * Cropping, Dynamic Zoom and Speed Change on Video and Clip Volume, Clip Pan
 * and the Clip Equalizer on Audio (`scratch/resolve-reference/`, the same
 * `animate.jpg`/`soundtrack.jpg` pair D-208/D-223/D-224 were built from).
 *
 * What changed is WHERE the sections render, nothing about what they do: the
 * same sections, in the same order, behind the same gates and writing the
 * same ops. Concretely —
 *   - **Video**: Transform, Crop, Dynamic Zoom, Speed, Fade, Keyframes.
 *     Fade and Speed are cross-domain (both retime/envelope the picture AND
 *     the sound), and sit here because they are properties of the clip's
 *     EXTENT rather than of its sound — Resolve likewise files Speed Change
 *     under Video — and because the Fade section's own note already says it
 *     covers both. Keyframes joins them because "Key all properties" keys
 *     transform and crop (D-223's own scoping call).
 *   - **Audio**: Volume/Pan and the EQ.
 *   - **Neither, i.e. always visible**: the clip's name, the track-locked
 *     note, and the tab bar itself, in a header that no longer scrolls away.
 * The two sections that used to carry their own `!clip.text` gate no longer
 * need one: the Audio tab itself only exists for a clip that has audio, which
 * is that same predicate stated once in `clipInspectorTabs.ts`. A text clip
 * therefore renders exactly the panel it did before — one column, no tab bar,
 * because one tab is not a tab bar.
 *
 * The selected tab is STORE state, not local state (`timelineStore.
 * inspectorTab`): this component is deliberately remounted per clip selection
 * (`key={clip.id}`, D-193), so a local tab would reset every time the user
 * picked a different clip, and `debug_set_inspector_tab` needs to drive the
 * same state the human's click drives (CLAUDE.md's one-action-under-both-
 * interfaces rule). See that field's own doc.
 *
 * **B-124 / D-254 — the tab CHROME, which is a separate story from the split
 * above and worth reading before touching either.** D-246's split was correct
 * and invisible. The deselected panel went on painting, stacked under the
 * selected one, because Base UI hides a `Tabs.Panel` by unmounting it and that
 * unmount waits on a `requestAnimationFrame` a non-frontmost window never
 * fires; and the selected tab had no selected state at all, because the kit
 * styled `data-selected:` while Base UI emits `data-active`. Both are fixed in
 * `@apelles/ui`'s `tabs.tsx` (see `TABS_CONTENT_HIDDEN` there), so this file
 * only carries what is genuinely app-specific: the `line` variant plus the
 * accent underline that matches `Shell.tsx`'s own tab switcher and
 * `TimelineSwitcher`, and `INSPECTOR_SECTION_DIVIDERS` below. jsdom cannot see
 * B-124 — that is stated, with the reason, in B-124's own entry and in
 * `ClipInspectorPanel.tabChrome.dom.test.tsx`'s header.
 *
 * **D-432 (P4) — the whole panel moved to the row system.** Sections are
 * `EditorSection`s (collapsible, state in the store), rows are `InspectorRow`s
 * with `NumberScrubber` values and a fixed keyframe slot, the tabs are icons, and
 * Width / Height is one linked Size row. Opacity is its own Compositing section.
 * The D-254 `INSPECTOR_SECTION_DIVIDERS` and accent-underline tabs are gone: each
 * section owns its divider. See `docs/notes/ui-redesign.md` "P4 as built".
 *
 * **v0.3.0 panel redesign (B-365 / B-366, D-442 / D-443) — the approved
 * revision 2 ("the control is the explanation").** Every collapsed section
 * header carries its value (`110% · 0° · 48 px up`, `L 12% · R 12%`, `In
 * 0.40 s · Out none`). Values are shown in display units through
 * `displayUnits.ts` — Position in px from the frame's centre, Scale and
 * Opacity in %, Rotation in °, fades in seconds — and converted back at the
 * row's edge, so the model and the MCP tools keep their stored units. Scale,
 * Rotation, Opacity and Corner radius are sliders with a detent at the
 * default. Crop is one L · R · T · B row plus the header's crop button, which
 * puts the viewer into crop mode (`CropOverlay`, Final Cut's model); a crop
 * edit from either keeps the picture in place (`cropInPlace.ts`). Dynamic
 * zoom (`ClipDynamicZoomSection`) previews its boxes; Highlights
 * (`ClipHighlightsSection`) is one row per sweep with header icons; the Audio
 * tab is `ClipAudioTab` (Level, Fades and Ducking summaries, the EQ as a
 * graph). The explanatory hint paragraphs are gone; what they said is in
 * tooltips. See `docs/notes/panel-redesign.md` "As built".
 */
import { useState } from 'react';
import {
  ArrowCounterClockwiseIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CropIcon,
  CursorClickIcon,
  DiamondIcon,
  FilmStripIcon,
  GaugeIcon,
  InfoIcon,
  LinkSimpleBreakIcon,
  LinkSimpleIcon,
  SpeakerHighIcon,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import { fmtTimecode } from '@apelles/player';
import {
  Button,
  InspectorRow,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@apelles/ui';
import { InspectorEmptyState } from '@apelles/inspector';
// D-432 (P4) — collapsible sections (open state in the store) and the number
// field with its scrub-undo bracket.
import { EditorSection } from './EditorSection';
import { InspectorNumber } from './InspectorNumber';
// D-246 — the tab model (which tabs a clip has, and which one resolves as
// active) is pure and lives on its own so it can be unit-tested and so the
// store, the debug op and this panel all read one definition.
import {
  CLIP_INSPECTOR_TAB_LABELS,
  clipInspectorTabs,
  resolveClipInspectorTab,
  type ClipInspectorTab,
} from './clipInspectorTabs';
// D-236 — the Speed (Retime) section, in its own file: it owns real derived
// state (the resolved segments, the retime curve) rather than a row of inputs.
import { SpeedRampEditor } from './SpeedRampEditor';
import type { SpeedPoint } from './speedRamp';
import { ClipAudioTab } from './ClipAudioTab';
import { ClipDynamicZoomSection } from './ClipDynamicZoomSection';
import { ClipHighlightsSection } from './ClipHighlightsSection';
import {
  EASE_PRESETS,
  easePresetName,
  endFrame,
  type Clip,
  type ClipKeyframeParam,
  type ClipTransformParam,
  type EqBand,
  type EaseCurve,
} from './timeline';
import type { ClipKeyframe } from './clipKeyframes';
import { CLIP_SCALING_LABELS, CLIP_SCALING_MODES, effectiveClipScaling, type ClipScaling } from './clipScaling';
import type { ClipGeometry } from './useClipGeometry';
import { PairedPropertyRow, PropertyRow, type PropertyState, type SliderSpan } from './PropertyRow';
import { ClipInfoPanel } from './ClipInfoPanel';
import { CROP_EDGES, type CropEdge, type CropInsetValues } from './cropInPlace';
import {
  EASE_PRESET_LABELS,
  PERCENT,
  centredPositionPx,
  centredPositionUnits,
  easeLabel,
  fadeSummary,
  formatPercent,
  positionSummary,
  secondsMapping,
  type UnitMapping,
} from './displayUnits';
import type { FractionBox } from './transformGeometry';
import { useEditorTimelineStore } from './timelineStore';

export type TransformPatch = Partial<{
  opacity: number;
  position_x: number;
  position_y: number;
  scale: number;
  box_width: number | null;
  box_height: number | null;
  /** D-425 — how the source is sized into the frame (what `scale == 1` means). */
  scaling: ClipScaling;
  rotation: number;
  crop_left: number;
  crop_top: number;
  crop_right: number;
  crop_bottom: number;
  /** D-344 — output-composition pixels, `0` = square corners. */
  corner_radius: number;
}>;

/** D-147 — what the Fade section's controls hand back. Partial for the same
 *  reason `TransformPatch` is: the panel edits one field at a time and
 *  `EditorInspectorPanel` fills the rest from the clip's current values. */
export type FadePatch = Partial<{
  fade_in_frames: number;
  fade_out_frames: number;
  fade_in_curve: EaseCurve;
  fade_out_curve: EaseCurve;
}>;

/** The two fade rows, each a duration + a curve on ONE row (v0.3.0). The
 *  keys are the real `Clip` field names. */
const FADE_FIELDS: Array<{
  label: string;
  durationKey: 'fade_in_frames' | 'fade_out_frames';
  curveKey: 'fade_in_curve' | 'fade_out_curve';
}> = [
  { label: 'Fade in', durationKey: 'fade_in_frames', curveKey: 'fade_in_curve' },
  { label: 'Fade out', durationKey: 'fade_out_frames', curveKey: 'fade_out_curve' },
];

/** The curve picker's value for a curve with no matching preset (an
 *  MCP-authored custom curve): shown as "Custom (set by your agent)" so the
 *  panel never misreports it as Even; picking a preset overwrites it. */
const CUSTOM_CURVE = 'custom';

/** D-132 / v0.3.0 — the crop row's four fields, Resolve's L · R · T · B
 *  order, shown in % (the stored inset is a 0–1 fraction of the source). */
const CROP_PREFIX: Readonly<Record<CropEdge, string>> = {
  crop_left: 'L',
  crop_right: 'R',
  crop_top: 'T',
  crop_bottom: 'B',
};
const CROP_NAME: Readonly<Record<CropEdge, string>> = {
  crop_left: 'left',
  crop_right: 'right',
  crop_top: 'top',
  crop_bottom: 'bottom',
};

/** v0.3.0 — the Transform rows in DISPLAY units (D-443): `units` converts at
 *  the row's edge, so `step` / bounds / `slider` / `detent` here are what the
 *  person reads (Scale 0–400 %, detent 100 %). */
const TRANSFORM_FIELDS: Array<{
  param: ClipTransformParam;
  label: string;
  step: number;
  min?: number;
  max?: number;
  unit?: string;
  units?: UnitMapping;
  slider?: SliderSpan;
  detent?: number;
  precision?: number;
}> = [
  { param: 'scale', label: 'Scale', step: 1, min: 0, unit: '%', units: PERCENT, slider: { min: 0, max: 400 }, detent: 100, precision: 0 },
  { param: 'rotation', label: 'Rotation', step: 1, unit: '°', slider: { min: -180, max: 180 }, detent: 0, precision: 0 },
];

/** D-344 — Corner radius, output-composition PIXELS, in Compositing (the
 *  mockup's answer to the spec's Q3). The slider's 200 px is a comfortable
 *  span, not a bound: both renderers clamp to half the box at use. */
const CORNER_RADIUS_SLIDER: SliderSpan = { min: 0, max: 200 };

/** D-432 §4.10 — one Phosphor glyph per Inspector tab (the mockup's four). */
const CLIP_INSPECTOR_TAB_ICONS: Record<ClipInspectorTab, PhosphorIcon> = {
  video: FilmStripIcon,
  audio: SpeakerHighIcon,
  speed: GaugeIcon,
  info: InfoIcon,
};

/** D-211 follow-up — a TEXT clip's `resolve_text_clip_transform` (Rust) pins
 *  `scale` / `rotation` / crop / box size, and `editor_set_clip_transform`
 *  refuses a non-default write to them: only opacity and position do anything
 *  for a title, so only those rows render for one. */
const TEXT_CLIP_TRANSFORM_PARAMS = new Set<ClipTransformParam>(['opacity', 'position_x', 'position_y']);

/** v0.3.0 (B-359 item 2) — Position as ONE paired row (`X [..] Y [..]`), in
 *  px from the frame's centre (D-443). */
const POSITION_PARAMS = ['position_x', 'position_y'] as const satisfies readonly [ClipTransformParam, ClipTransformParam];

/** A small header icon button (crop, reset). */
const HEADER_ICON = 'size-5';

/** `L 12% · R 12%`, or `None`. */
function cropSummary(crop: CropInsetValues): string {
  const parts = CROP_EDGES.filter((e) => Math.round(crop[e] * 100) !== 0).map(
    (e) => `${CROP_PREFIX[e]} ${Math.round(crop[e] * 100)}%`,
  );
  return parts.length === 0 ? 'None' : parts.join(' · ');
}

export function ClipInspectorPanel({
  clip,
  audioClip,
  audioTrack,
  trackLocked,
  audioTrackLocked,
  geometry,
  paintedBox,
  clipKeyframes,
  keyedHere,
  keyframeNav,
  paramStates,
  onTransformChange,
  onCropChange,
  cropArmed,
  onCropArm,
  onFadeChange,
  onSpeedChange,
  onEqBandChange,
  onEqPreset,
  onEqClear,
  onParamChange,
  onKeyframeToggle,
  onKeyframeNav,
  onResetParam,
  onOpenCurve,
  openCurveParam,
  onUpsertKeyframe,
  onRemoveKeyframeHere,
  onClearKeyframes,
  onGoToFrame,
  dynamicZoomArmed,
  dynamicZoomEasePreset,
  dynamicZoomWouldReplace,
  onDynamicZoomArm,
  onDynamicZoomEase,
  onDynamicZoomSwap,
  tab,
  onTabChange,
  fps,
}: {
  /** The PICTURE half — what every Video-tab section reads (B-334/D-430;
   *  `inspectorTarget.ts`). For an unlinked clip, the selected clip itself. */
  clip: Clip | null;
  /** The AUDIBLE half — what the Audio tab's level, pan and EQ read and write:
   *  a linked pair's audio partner, else the clip itself. `null` for a linked
   *  picture with no audio half (silent, so no Audio tab). */
  audioClip: Clip | null;
  /** The audible clip's track index (the Audio tab's ducking summary). */
  audioTrack: number;
  trackLocked: boolean;
  /** Whether the audio half's own track is locked — a pair's two tracks lock
   *  independently, so the Audio tab cannot borrow the picture track's flag. */
  audioTrackLocked: boolean;
  /** D-193 — the selected clip's composition/source geometry, or `null`
   *  while it hasn't resolved yet. Size and the px Position need it. */
  geometry: ClipGeometry | null;
  /** v0.3.0 (D-443) — the clip's painted box at the playhead (composition
   *  fractions), for Position in px from the centre; `null` without geometry. */
  paintedBox: FractionBox | null;
  clipKeyframes: ClipKeyframe[];
  keyedHere: boolean;
  /** v0.3.0 — the nearest keyframe of ANY property before / after the
   *  playhead, timeline frames (the Keyframes section's ‹ ›). */
  keyframeNav: { prev: number | null; next: number | null };
  /** D-208 — every keyframeable property's live state, derived by
   *  `EditorInspectorPanel`. Complete by construction. */
  paramStates: Record<ClipKeyframeParam, PropertyState>;
  onTransformChange: (patch: TransformPatch) => void;
  /** v0.3.0 (D-443) — new crop insets from the L · R · T · B row or the
   *  header's reset (`moved` gives way when two edges meet). The caller
   *  writes the one op that keeps the picture in place (`cropEditOp`). */
  onCropChange: (next: CropInsetValues, moved?: CropEdge) => void;
  /** The viewer is in crop mode for this clip (`timelineStore.cropEdit`). */
  cropArmed: boolean;
  onCropArm: (armed: boolean) => void;
  onFadeChange: (patch: FadePatch) => void;
  /** D-236 — replace this clip's speed ramp (whole array, like the op). */
  onSpeedChange: (points: SpeedPoint[]) => void;
  /** D-224 — patch ONE band of this clip's EQ, partial by field. */
  onEqBandChange: (band: number, patch: Partial<EqBand>) => void;
  /** v0.3.0 (D-442) — write a named preset's four bands (one op). */
  onEqPreset: (name: string) => void;
  /** D-224 — drop the whole band set back to "no EQ". */
  onEqClear: () => void;
  /** D-208 — edit ONE property's value (the caller decides static field vs
   *  keyframe at the playhead). */
  onParamChange: (param: ClipKeyframeParam, value: number) => void;
  /** One property, or several on the same facet as ONE keyframe write. */
  onKeyframeToggle: (params: ClipKeyframeParam | readonly ClipKeyframeParam[]) => void;
  onKeyframeNav: (param: ClipKeyframeParam, dir: -1 | 1) => void;
  onResetParam: (params: ClipKeyframeParam | readonly ClipKeyframeParam[]) => void;
  /** D-233 — open (or close) one property's ease curve in the timeline lane. */
  onOpenCurve: (param: ClipKeyframeParam) => void;
  openCurveParam: ClipKeyframeParam | null;
  onUpsertKeyframe: () => void;
  onRemoveKeyframeHere: () => void;
  onClearKeyframes: () => void;
  /** Move the playhead (the Keyframes section's ‹ ›). */
  onGoToFrame: (frame: number) => void;
  /** D-234 — is the viewer showing THIS clip's start/end boxes? */
  dynamicZoomArmed: boolean;
  /** The `EASE_PRESETS` name of the ease the next bake will use. */
  dynamicZoomEasePreset: string;
  /** Would a dynamic zoom replace existing position/scale keys? */
  dynamicZoomWouldReplace: boolean;
  onDynamicZoomArm: (armed: boolean) => void;
  onDynamicZoomEase: (curve: EaseCurve) => void;
  /** Swap the start and end framings (Resolve's Swap). */
  onDynamicZoomSwap: () => void;
  /** D-246 — which Inspector tab the user last chose (store state). */
  tab: ClipInspectorTab;
  onTabChange: (tab: ClipInspectorTab) => void;
  /** The timeline's frame rate: durations, fades, timecodes. */
  fps: number;
}) {
  // D-193 — locked by default for a clip with no independent-axis override
  // yet; ephemeral UI state, reset per clip by the caller's `key={clip.id}`.
  // B-379 — this panel is no longer remounted on every new clip selection.
  // D-193 used a `key` on it for one reason: to reset the ratio lock below to
  // the newly-selected clip's own default. That remount cost 10–20 ms after
  // each release, including a forced layout from a Base UI composite's first
  // mount. React's documented "adjust state when a prop changes" does the same
  // reset in the same render, with no remount, no effect and no extra frame.
  const shotIdentity = `${clip?.id ?? 'none'}|${audioClip?.id ?? 'none'}`;
  const ratioDefault = clip?.box_width == null && clip?.box_height == null;
  const [ratioLocked, setRatioLocked] = useState(ratioDefault);
  const [ratioShot, setRatioShot] = useState(shotIdentity);
  if (ratioShot !== shotIdentity) {
    setRatioShot(shotIdentity);
    setRatioLocked(ratioDefault);
  }
  const setSectionOpen = useEditorTimelineStore((s) => s.setInspectorSectionOpen);

  if (!clip) {
    // v0.3.0 (§4.13) — reached when the selection resolves to no single clip.
    return (
      <InspectorEmptyState icon={<CursorClickIcon aria-hidden />}>
        Select a clip to edit its properties.
      </InspectorEmptyState>
    );
  }

  const transformFields = clip.text
    ? TRANSFORM_FIELDS.filter((f) => TEXT_CLIP_TRANSFORM_PARAMS.has(f.param))
    : TRANSFORM_FIELDS;

  // D-193 — the box's CURRENT effective size, in composition fractions: the
  // override when the clip has one, else `scale`'s natural-footprint formula.
  const scale = clip.scale ?? 1;
  const hasSizeOverride = clip.box_width != null || clip.box_height != null;
  const effectiveBoxWidth = clip.box_width ?? (geometry ? geometry.naturalWidth * scale : null);
  const effectiveBoxHeight = clip.box_height ?? (geometry ? geometry.naturalHeight * scale : null);
  const widthPx = geometry && effectiveBoxWidth != null ? effectiveBoxWidth * geometry.compWidth : null;
  const heightPx = geometry && effectiveBoxHeight != null ? effectiveBoxHeight * geometry.compHeight : null;

  const handleWidthPxChange = (newWidthPx: number) => {
    if (!geometry || effectiveBoxWidth == null || effectiveBoxHeight == null) return;
    if (!Number.isFinite(newWidthPx) || geometry.compWidth <= 0) return;
    const newBoxWidth = newWidthPx / geometry.compWidth;
    if (ratioLocked) {
      const ratio = effectiveBoxWidth > 0 ? effectiveBoxHeight / effectiveBoxWidth : 1;
      onTransformChange({ box_width: newBoxWidth, box_height: newBoxWidth * ratio });
    } else {
      // Unlocked: Height is restated at its CURRENT value, so it becomes an
      // explicit override rather than drifting later if `scale` changes.
      onTransformChange({ box_width: newBoxWidth, box_height: effectiveBoxHeight });
    }
  };

  const handleHeightPxChange = (newHeightPx: number) => {
    if (!geometry || effectiveBoxWidth == null || effectiveBoxHeight == null) return;
    if (!Number.isFinite(newHeightPx) || geometry.compHeight <= 0) return;
    const newBoxHeight = newHeightPx / geometry.compHeight;
    if (ratioLocked) {
      const ratio = effectiveBoxHeight > 0 ? effectiveBoxWidth / effectiveBoxHeight : 1;
      onTransformChange({ box_width: newBoxHeight * ratio, box_height: newBoxHeight });
    } else {
      onTransformChange({ box_width: effectiveBoxWidth, box_height: newBoxHeight });
    }
  };

  const tabs = clipInspectorTabs(clip, audioClip);
  const activeTab = resolveClipInspectorTab(tab, tabs);

  // ---- the value summaries the collapsed headers show (D-443) -------------
  const comp = geometry ? { width: geometry.compWidth, height: geometry.compHeight } : null;
  const position = { x: paramStates.position_x.value, y: paramStates.position_y.value };
  const positionUnits = paintedBox && comp ? centredPositionUnits(paintedBox, position, comp) : undefined;
  const transformMeta = [
    ...(clip.text ? [] : [formatPercent(paramStates.scale.value), `${Math.round(paramStates.rotation.value)}°`]),
    ...(paintedBox && comp ? [positionSummary(centredPositionPx(paintedBox, comp))] : []),
  ].join(' · ');
  const radius = paramStates.corner_radius.value;
  const compositingMeta = clip.text
    ? formatPercent(paramStates.opacity.value)
    : `${formatPercent(paramStates.opacity.value)} · ${radius > 0 ? `${Math.round(radius)} px corners` : 'square corners'}`;
  const crop: CropInsetValues = {
    crop_left: paramStates.crop_left.value,
    crop_top: paramStates.crop_top.value,
    crop_right: paramStates.crop_right.value,
    crop_bottom: paramStates.crop_bottom.value,
  };
  const cropMeta = cropSummary(crop);
  const fadeMeta = fadeSummary(clip.fade_in_frames ?? 0, clip.fade_out_frames ?? 0, fps);
  const seconds = secondsMapping(fps);

  /** Open the Video tab's Fade section (the Audio tab's Fades row). */
  const editFades = () => {
    setSectionOpen('fade', true);
    onTabChange('video');
  };

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => onTabChange(value as ClipInspectorTab)}
      // `gap-0` because this panel supplies its own spacing: the header block
      // below is padded and bordered, and the sections are full-bleed.
      className="flex h-full min-h-0 w-full flex-col gap-0 text-xs"
      data-chroma-panel="clip-inspector"
    >
      {/* D-246 / D-432 — the clip's name, its locked note and the icon tab bar
          stay put while the properties scroll. The header is 44 px: kind
          icon, the name, the duration. */}
      <div className="flex shrink-0 flex-col">
        <div className="border-border-color flex h-11 items-center gap-2 border-b px-3">
          {clip.text || clip.caption || clip.adjustment ? null : (
            <FilmStripIcon size={14} className="text-text-secondary shrink-0" aria-hidden />
          )}
          <div className="text-text-primary min-w-0 flex-1 truncate text-base font-semibold" title={clip.name}>
            {clip.name}
          </div>
          {/* v0.3.0 (B-359 item 1) — the clip's length on the timeline. */}
          <span
            data-chroma-inspector-duration=""
            className="text-text-secondary shrink-0 font-mono text-xs tabular-nums"
            title="Duration on the timeline"
          >
            {fmtTimecode(endFrame(clip, fps) - clip.start_frame, fps)}
          </span>
        </div>
        {trackLocked && (
          <div className="text-text-secondary border-border-color border-b px-3 py-1.5 text-2xs">
            This clip's track is locked — unlock it to edit transform or keyframes.
          </div>
        )}
        {/* One tab is not a tab bar. D-432 — icon tabs, 28 × 22, centred; the
            name is a tooltip and the accessible name. */}
        {tabs.length > 1 && (
          <TabsList
            variant="line"
            className="border-border-color h-8 w-full justify-center gap-1 rounded-none border-b p-0"
          >
            {tabs.map((id) => (
              <TabsTrigger
                key={id}
                value={id}
                aria-label={CLIP_INSPECTOR_TAB_LABELS[id]}
                title={CLIP_INSPECTOR_TAB_LABELS[id]}
                className="text-text-secondary group-data-[variant=line]/tabs-list:data-active:bg-bg-secondary data-active:text-accent-text h-[22px] w-7 flex-none rounded-sm px-0"
              >
                {(() => {
                  const TabIcon = CLIP_INSPECTOR_TAB_ICONS[id];
                  return <TabIcon size={15} />;
                })()}
              </TabsTrigger>
            ))}
          </TabsList>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* D-246 — the VIDEO tab: the picture, its geometry, and everything
            measured against its extent (Fade and Keyframes too: a fade drives
            picture and sound, "Key everything here" keys transform and crop). */}
        <TabsContent value="video" className="flex flex-col">
          <EditorSection
            id="transform"
            label="Transform"
            meta={transformMeta}
            actions={
              <Button
                variant="ghost"
                size="icon-xs"
                className={HEADER_ICON}
                disabled={trackLocked}
                onClick={() =>
                  onResetParam(clip.text ? ['position_x', 'position_y'] : ['position_x', 'position_y', 'scale', 'rotation'])
                }
                title="Reset Transform"
                aria-label="Reset Transform"
              >
                <ArrowCounterClockwiseIcon size={11} />
              </Button>
            }
          >
            {/* D-208 — every row routes its edit through `onParamChange`; an
                animated property's edit lands on its keyframe (the caller's
                call). Position is px from the frame's centre (D-443). */}
            <PairedPropertyRow
              label="Position"
              params={POSITION_PARAMS}
              prefixes={['X', 'Y']}
              states={[paramStates.position_x, paramStates.position_y]}
              step={positionUnits ? 1 : 0.01}
              // No `px` suffix inside the two fields: at the default 320 px
              // Inspector each field is ~50 px and the suffix pushed "-48" out
              // (seen live). The unit is in the tooltip and the header summary.
              labelTitle={positionUnits ? 'Position, in px from the frame’s centre' : undefined}
              units={positionUnits}
              precision={positionUnits ? 0 : undefined}
              disabled={trackLocked}
              onChange={onParamChange}
              onKeyframeToggle={onKeyframeToggle}
              onKeyframeNav={onKeyframeNav}
              onReset={onResetParam}
              onOpenCurve={onOpenCurve}
              openCurveParam={openCurveParam}
            />
            {transformFields.map(({ param, label, step, min, max, unit, units, slider, detent, precision }) => (
              <PropertyRow
                key={param}
                label={label}
                param={param}
                state={paramStates[param]}
                step={step}
                min={min}
                max={max}
                unit={unit}
                units={units}
                slider={slider}
                detent={detent}
                precision={precision}
                disabled={trackLocked}
                onChange={(v) => onParamChange(param, v)}
                onKeyframeToggle={onKeyframeToggle}
                onKeyframeNav={onKeyframeNav}
                onReset={onResetParam}
                onOpenCurve={onOpenCurve}
                curveOpen={openCurveParam === param}
              />
            ))}

            {/* D-193 — Size, a linked W / H pair in composition pixels, below
                the keyframeable rows. "Auto" while no override is set (the
                size then follows Scale). Hidden for a title (its size is its
                Title section's). */}
            {!clip.text && (
              <>
                <InspectorRow label="Size" labelTitle={geometry ? 'Size in pixels' : 'Measuring the source resolution…'}>
                  <InspectorNumber
                    aria-label="Width"
                    prefix="W"
                    step={1}
                    min={0}
                    unit={hasSizeOverride ? 'px' : undefined}
                    format={hasSizeOverride ? undefined : () => ({ text: 'Auto' })}
                    disabled={trackLocked || !geometry}
                    className="min-w-0 flex-1"
                    value={widthPx != null ? Math.round(widthPx) : 0}
                    onChange={handleWidthPxChange}
                  />
                  <button
                    type="button"
                    className="text-text-secondary hover:text-text-primary aria-pressed:text-accent-text flex size-4 shrink-0 items-center justify-center rounded-sm disabled:opacity-40"
                    disabled={trackLocked || !geometry}
                    aria-pressed={ratioLocked}
                    aria-label="Link width and height"
                    onClick={() => setRatioLocked((v) => !v)}
                    title={ratioLocked ? 'Aspect ratio linked — click to unlink' : 'Aspect ratio unlinked — click to link'}
                  >
                    {ratioLocked ? <LinkSimpleIcon size={12} /> : <LinkSimpleBreakIcon size={12} />}
                  </button>
                  <InspectorNumber
                    aria-label="Height"
                    prefix="H"
                    step={1}
                    min={0}
                    unit={hasSizeOverride ? 'px' : undefined}
                    format={hasSizeOverride ? undefined : () => ({ text: 'Auto' })}
                    disabled={trackLocked || !geometry}
                    className="min-w-0 flex-1"
                    value={heightPx != null ? Math.round(heightPx) : 0}
                    onChange={handleHeightPxChange}
                  />
                </InspectorRow>
                {/* D-425 / B-325 — Resolve's per-clip Input Scaling: what
                    Scale 100 % means. A Width / Height override beats it
                    (said in the tooltip, not a footnote). */}
                <InspectorRow label="Scaling">
                  <Select
                    value={effectiveClipScaling(clip)}
                    onValueChange={(v) => {
                      const hit = CLIP_SCALING_MODES.find((m) => m === v);
                      if (hit) onTransformChange({ scaling: hit });
                    }}
                    disabled={trackLocked}
                  >
                    <SelectTrigger
                      className="data-[size=default]:h-[22px] w-full text-xs"
                      data-chroma-field="clip-scaling"
                      title={
                        hasSizeOverride
                          ? 'A Width / Height is set, so Scaling has no effect until it is cleared (change Scale).'
                          : 'How the source is sized into the frame at Scale 100 %'
                      }
                    >
                      <SelectValue>{CLIP_SCALING_LABELS[effectiveClipScaling(clip)]}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {CLIP_SCALING_MODES.map((m) => (
                        <SelectItem key={m} value={m}>
                          {CLIP_SCALING_LABELS[m]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </InspectorRow>
              </>
            )}
          </EditorSection>

          {/* D-432 — Compositing: Opacity (%) and, for a picture, Corner
              radius (px), both sliders with a detent at the default. */}
          <EditorSection
            id="compositing"
            label="Compositing"
            meta={compositingMeta}
            actions={
              <Button
                variant="ghost"
                size="icon-xs"
                className={HEADER_ICON}
                disabled={trackLocked}
                onClick={() => onResetParam(clip.text ? ['opacity'] : ['opacity', 'corner_radius'])}
                title="Reset Compositing"
                aria-label="Reset Compositing"
              >
                <ArrowCounterClockwiseIcon size={11} />
              </Button>
            }
          >
            <PropertyRow
              label="Opacity"
              param="opacity"
              state={paramStates.opacity}
              step={1}
              min={0}
              max={100}
              unit="%"
              units={PERCENT}
              slider={{ min: 0, max: 100 }}
              detent={100}
              precision={0}
              disabled={trackLocked}
              onChange={(v) => onParamChange('opacity', v)}
              onKeyframeToggle={onKeyframeToggle}
              onKeyframeNav={onKeyframeNav}
              onReset={onResetParam}
              onOpenCurve={onOpenCurve}
              curveOpen={openCurveParam === 'opacity'}
            />
            {!clip.text && (
              <PropertyRow
                label="Corner radius"
                param="corner_radius"
                state={paramStates.corner_radius}
                step={1}
                min={0}
                unit="px"
                slider={CORNER_RADIUS_SLIDER}
                detent={0}
                precision={0}
                disabled={trackLocked}
                onChange={(v) => onParamChange('corner_radius', v)}
                onKeyframeToggle={onKeyframeToggle}
                onKeyframeNav={onKeyframeNav}
                onReset={onResetParam}
                onOpenCurve={onOpenCurve}
                curveOpen={openCurveParam === 'corner_radius'}
              />
            )}
          </EditorSection>

          {/* D-132 / v0.3.0 (D-443) — Crop: one L · R · T · B row in %, and
              the header's crop button for the viewer's crop mode (Final
              Cut's). Hidden for a title (a title keeps its position/opacity-only
              boundary, `chroma::edit`'s text-clip doc). Crop stays
              keyframeable through "Key everything here"; an animated crop's
              edit lands on its keyframe at the playhead. */}
          {!clip.text && (
            <EditorSection
              id="crop"
              label="Crop"
              meta={cropMeta}
              actions={
                <div className="flex items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className={`${HEADER_ICON} ${cropArmed ? 'text-accent-text' : ''}`}
                    disabled={trackLocked || !!clip.adjustment || !!clip.caption}
                    aria-pressed={cropArmed}
                    onClick={() => onCropArm(!cropArmed)}
                    title={cropArmed ? 'Done cropping (Esc)' : 'Crop in the viewer: drag the edges'}
                    aria-label="Crop in the viewer"
                    data-crop-toggle
                  >
                    <CropIcon size={12} weight={cropArmed ? 'bold' : 'regular'} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className={HEADER_ICON}
                    disabled={trackLocked || cropMeta === 'None'}
                    onClick={() => onCropChange({ crop_left: 0, crop_top: 0, crop_right: 0, crop_bottom: 0 })}
                    title="Reset Crop"
                    aria-label="Reset Crop"
                  >
                    <ArrowCounterClockwiseIcon size={11} />
                  </Button>
                </div>
              }
            >
              <div className="grid grid-cols-4 gap-1 pt-0.5" data-chroma-crop-row>
                {CROP_EDGES.map((edge) => (
                  <InspectorNumber
                    key={edge}
                    aria-label={`Crop ${CROP_NAME[edge]}`}
                    title={`Crop ${CROP_NAME[edge]}: ${PERCENT.toDisplay(crop[edge])} % of the source`}
                    prefix={CROP_PREFIX[edge]}
                    unit="%"
                    step={1}
                    min={0}
                    max={100}
                    precision={0}
                    disabled={trackLocked}
                    className="min-w-0"
                    value={PERCENT.toDisplay(crop[edge])}
                    onChange={(pct) => onCropChange({ ...crop, [edge]: PERCENT.fromDisplay(pct) }, edge)}
                  />
                ))}
              </div>
            </EditorSection>
          )}

          {/* D-234 — Dynamic zoom; hidden for a title and an adjustment clip. */}
          {!clip.text && !clip.adjustment && (
            <ClipDynamicZoomSection
              clip={clip}
              geometry={geometry}
              locked={trackLocked}
              armed={dynamicZoomArmed}
              easePreset={dynamicZoomEasePreset}
              wouldReplace={dynamicZoomWouldReplace}
              onArm={onDynamicZoomArm}
              onEase={onDynamicZoomEase}
              onSwap={onDynamicZoomSwap}
            />
          )}

          {/* D-396 — Highlights: hidden for a title, caption or adjustment
              clip (no decoded picture to draw on). Self-contained. */}
          {!clip.text && !clip.adjustment && !clip.caption && <ClipHighlightsSection />}

          {/* D-147 — Fade in / out, in seconds (stored frames), each with its
              curve on the same row in plain words. One fade drives picture
              AND sound (the label's tooltip says so; the footnote is gone). */}
          <EditorSection id="fade" label="Fade" meta={fadeMeta}>
            {FADE_FIELDS.map(({ label, durationKey, curveKey }) => {
              const preset = easePresetName(clip[curveKey]);
              return (
                <InspectorRow
                  key={durationKey}
                  label={label}
                  labelTitle={`${label}: fades this clip's picture and its sound together`}
                >
                  <InspectorNumber
                    aria-label={label}
                    step={0.01}
                    min={0}
                    unit="s"
                    precision={2}
                    disabled={trackLocked}
                    className="w-[72px] shrink-0"
                    value={seconds.toDisplay(clip[durationKey] ?? 0)}
                    onChange={(s) => onFadeChange({ [durationKey]: seconds.fromDisplay(s) })}
                  />
                  <Select
                    value={preset ?? CUSTOM_CURVE}
                    onValueChange={(v) => {
                      const hit = EASE_PRESETS.find((p) => p.name === v);
                      if (hit) onFadeChange({ [curveKey]: hit.curve });
                    }}
                    disabled={trackLocked}
                  >
                    <SelectTrigger
                      className="data-[size=default]:h-[22px] min-w-0 flex-1 text-xs"
                      aria-label={`${label} curve`}
                      title={`${label} curve: ${easeLabel(preset)}`}
                    >
                      <SelectValue>{easeLabel(preset)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {EASE_PRESETS.map((p) => (
                        <SelectItem key={p.name} value={p.name}>
                          {EASE_PRESET_LABELS[p.name] ?? p.name}
                        </SelectItem>
                      ))}
                      {/* Only offered when the clip really has one. */}
                      {preset === null && <SelectItem value={CUSTOM_CURVE}>{easeLabel(null)}</SelectItem>}
                    </SelectContent>
                  </Select>
                </InspectorRow>
              );
            })}
          </EditorSection>

          {/* The whole-clip keyframe actions (D-208 kept them): ‹ previous
              keyframe of any property, "Key everything here", next ›, Delete
              here, Clear all. Each row also has its own ◇. */}
          <EditorSection
            id="keyframes"
            label="Keyframes"
            meta={clipKeyframes.length === 0 ? 'None' : `${clipKeyframes.length} on this clip`}
          >
            {/* Wraps rather than overflow the column (seen live at 320 px). */}
            <div className="flex flex-wrap items-center gap-1 text-xs select-none">
              <Button
                variant="ghost"
                size="icon-xs"
                className={HEADER_ICON}
                disabled={keyframeNav.prev === null}
                onClick={() => keyframeNav.prev !== null && onGoToFrame(keyframeNav.prev)}
                title="Previous keyframe"
                aria-label="Previous keyframe"
              >
                <CaretLeftIcon size={11} />
              </Button>
              <Button
                variant="ghost"
                size="xs"
                disabled={trackLocked}
                className={`gap-1 px-1.5 ${keyedHere ? 'text-selection' : 'text-text-primary'}`}
                onClick={onUpsertKeyframe}
                title="Keyframe every Transform and Crop value at the playhead"
              >
                {/* D-300 — solid = Phosphor's `fill` weight. */}
                <DiamondIcon size={11} weight={keyedHere ? 'fill' : 'regular'} />
                Key everything here
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className={HEADER_ICON}
                disabled={keyframeNav.next === null}
                onClick={() => keyframeNav.next !== null && onGoToFrame(keyframeNav.next)}
                title="Next keyframe"
                aria-label="Next keyframe"
              >
                <CaretRightIcon size={11} />
              </Button>
              <span className="grow" />
              <Button
                variant="ghost"
                size="xs"
                disabled={trackLocked || !keyedHere}
                onClick={onRemoveKeyframeHere}
                title="Delete every property's keyframe at the playhead"
              >
                Delete here
              </Button>
              <Button
                variant="ghost"
                size="xs"
                disabled={trackLocked || clipKeyframes.length === 0}
                onClick={onClearKeyframes}
                title="Remove all of this clip's keyframes"
              >
                Clear all
              </Button>
            </div>
          </EditorSection>
        </TabsContent>

        {/* D-246 / v0.3.0 (D-442) — the AUDIO tab: `ClipAudioTab`. Rendered
            only when the clip has audio at all (`clipInspectorTabs`). */}
        {tabs.includes('audio') && audioClip && (
          <TabsContent value="audio" className="flex flex-col">
            <ClipAudioTab
              audioClip={audioClip}
              fadeClip={clip}
              audioTrack={audioTrack}
              locked={audioTrackLocked}
              fps={fps}
              paramStates={paramStates}
              onParamChange={onParamChange}
              onKeyframeToggle={onKeyframeToggle}
              onKeyframeNav={onKeyframeNav}
              onResetParam={onResetParam}
              onOpenCurve={onOpenCurve}
              openCurveParam={openCurveParam}
              onEqBandChange={onEqBandChange}
              onEqPreset={onEqPreset}
              onEqClear={onEqClear}
              onEditFades={editFades}
            />
          </TabsContent>
        )}

        {/* v0.3.0 (B-359 item 1) — the SPEED tab: D-236's retime. */}
        {tabs.includes('speed') && (
          <TabsContent value="speed" className="flex flex-col">
            <SpeedRampEditor clip={clip} trackLocked={trackLocked} onSpeedChange={onSpeedChange} />
          </TabsContent>
        )}

        {/* v0.3.0 (B-359 item 1) — the INFO tab: read-only media facts. */}
        <TabsContent value="info" className="flex flex-col">
          <ClipInfoPanel clip={clip} fps={fps} />
        </TabsContent>
      </div>
    </Tabs>
  );
}
