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
 * and a `RotateCcw` reset to that field's default — the same icon and
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
 */
import { useState } from 'react';
import { Diamond, Lock, RotateCcw, Unlock, X } from 'lucide-react';
import {
  Button,
  ScrubbableNumberInput,
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
import { InspectorEmptyState, InspectorSection } from '@apelles/inspector';
// D-246 — the tab model (which tabs a clip has, and which one resolves as
// active) is pure and lives on its own so it can be unit-tested and so the
// store, the debug op and this panel all read one definition.
import {
  CLIP_INSPECTOR_TAB_LABELS,
  clipInspectorTabs,
  resolveClipInspectorTab,
  type ClipInspectorTab,
} from './clipInspectorTabs';
// B-113 — the numeric field's own geometry, shared with `PropertyRow`.
import { NUM_FIELD } from './numericField';
// D-236 — the Speed (Retime) section, in its own file for the reason every
// other non-trivial section here is not: it owns real derived state (the
// resolved segments, the retime curve) rather than being a row of inputs.
import { SpeedRampEditor } from './SpeedRampEditor';
import type { SpeedPoint } from './speedRamp';
// D-237 — the EQ section's own response graph, in its own file for the same
// reason `SpeedRampEditor` is: it owns real derived geometry (the sampled
// curve, each band's screen point, its own pointer-drag/wheel gesture state)
// rather than being a row of inputs.
import { EqResponseGraph } from './EqResponseGraph';
import {
  EQ_BAND_KINDS,
  EQ_BAND_KIND_LABELS,
  EQ_DEFAULT_Q,
  EQ_MAX_FREQ_HZ,
  EQ_MAX_GAIN_DB,
  EQ_MAX_Q,
  EQ_MIN_FREQ_HZ,
  EQ_MIN_Q,
  EASE_PRESETS,
  eqBandsForDisplay,
  eqKindUsesGain,
  easePresetName,
  hasActiveEq,
  type Clip,
  type ClipAudioParam,
  type ClipKeyframeParam,
  type ClipTransformParam,
  type EqBand,
  type EqBandKind,
  type EaseCurve,
} from './timeline';
import type { ClipKeyframe } from './clipKeyframes';
import type { ClipGeometry } from './useClipGeometry';
import { PropertyRow, staticPropertyState, type PropertyState } from './PropertyRow';

export type TransformPatch = Partial<{
  opacity: number;
  position_x: number;
  position_y: number;
  scale: number;
  box_width: number | null;
  box_height: number | null;
  rotation: number;
  crop_left: number;
  crop_top: number;
  crop_right: number;
  crop_bottom: number;
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

/** The two fade rows, each a duration + a curve, sharing one layout.
 *  `durationKey`/`curveKey` are the real `Clip` field names so the row can
 *  read and write them without a lookup table. */
const FADE_FIELDS: Array<{
  label: string;
  durationKey: 'fade_in_frames' | 'fade_out_frames';
  curveKey: 'fade_in_curve' | 'fade_out_curve';
}> = [
  { label: 'Fade in', durationKey: 'fade_in_frames', curveKey: 'fade_in_curve' },
  { label: 'Fade out', durationKey: 'fade_out_frames', curveKey: 'fade_out_curve' },
];

/** The value the curve `<select>` shows for a curve with no matching preset —
 *  an MCP-authored custom curve. Rendered as a real, selectable-looking option
 *  so the panel never silently misreports a custom curve as `linear`; picking
 *  a named preset from there overwrites it, which is the only thing this panel
 *  can do about a curve it has no editor for (D-147's known gap). */
const CUSTOM_CURVE = 'custom';

const row = 'flex items-center justify-between gap-2';
/** B-113 — the same field `PropertyRow` uses, so the two kinds of numeric row
 *  on this panel cannot drift apart in width, padding or spinner clearance.
 *  See `numericField.ts` for what each part of it is for. */
const numInput = NUM_FIELD.className;

/** D-132 — the four crop rows, in Resolve's own Left/Right/Top/Bottom order
 *  (its Crop palette's own control order, not alphabetical), each a
 *  normalised 0–1 inset. `0.01` steps because a percent of the frame is the
 *  finest crop anyone nudges by hand; `min`/`max` bound the input, and
 *  `applyOp` clamps again on the way into the timeline for the values a
 *  keyboard can still type past them. */
const CROP_FIELDS: Array<{ key: ClipTransformParam; label: string }> = [
  { key: 'crop_left', label: 'Left' },
  { key: 'crop_right', label: 'Right' },
  { key: 'crop_top', label: 'Top' },
  { key: 'crop_bottom', label: 'Bottom' },
];
const CROP_STEP = 0.01;

/** D-208 — the Transform section's five keyframeable rows, in the order they
 *  render. Only the numbers differ per field; the keyframe/reset behaviour is
 *  identical and lives in `PropertyRow`.
 *
 *  `position_x`/`position_y` step by `CROP_STEP` because D-136 made them
 *  normalised fractions of the composition (B-043's fix), not absolute
 *  pixels — `1` used to be a 1px nudge and is now a whole frame-width jump,
 *  so a percent of the frame is the right increment, the same unit and step
 *  the crop insets use. */
const TRANSFORM_FIELDS: Array<{
  param: ClipTransformParam;
  label: string;
  step: number;
  min?: number;
  max?: number;
}> = [
  { param: 'opacity', label: 'Opacity', step: 0.05, min: 0, max: 1 },
  { param: 'position_x', label: 'Position X', step: CROP_STEP },
  { param: 'position_y', label: 'Position Y', step: CROP_STEP },
  { param: 'scale', label: 'Scale', step: 0.05, min: 0 },
  { param: 'rotation', label: 'Rotation', step: 1 },
];

/** D-223 — the per-clip audio rows, in Resolve's own order (Clip Volume above
 *  Clip Pan, `scratch/resolve-reference/soundtrack.jpg`). Same
 *  `PropertyRow`-shaped record `TRANSFORM_FIELDS` is, so both sections render
 *  through one component.
 *
 *  **Steps and bounds are the stored units**, as everywhere else on this panel
 *  (Opacity is 0–1, not 0–100; crop insets are fractions). Volume steps by
 *  `0.05`, the same nudge Opacity uses for the same reason — it is a 0–1-ish
 *  multiplier a human drags in twentieths — and is floored at `0` with NO
 *  maximum, because a clip legitimately needs boosting above unity and
 *  `Track.gain` has no ceiling either. Pan steps by `0.1` across its `-1..1`
 *  range: ten positions across the stereo field is finer than any human
 *  actually places a clip by ear, and a finer default step would make the
 *  spinner arrows useless. */
const AUDIO_FIELDS: Array<{
  param: ClipAudioParam;
  label: string;
  step: number;
  min?: number;
  max?: number;
}> = [
  { param: 'volume', label: 'Volume', step: 0.05, min: 0 },
  { param: 'pan', label: 'Pan', step: 0.1, min: -1, max: 1 },
];

/** D-211 follow-up — a TEXT clip's own `resolve_text_clip_transform` (Rust)
 *  pins `scale`/`rotation`/crop/box size to their identity values regardless
 *  of what's stored, and `editor_set_clip_transform` REFUSES a non-default
 *  write to any of them — only `opacity`/`position_x`/`position_y` actually
 *  do anything for a title. Filters `TRANSFORM_FIELDS` down to those three
 *  for a text clip, rather than rendering rows that silently do nothing (or
 *  worse, that a human edits and then can't work out why nothing moved). */
const TEXT_CLIP_TRANSFORM_PARAMS = new Set<ClipTransformParam>(['opacity', 'position_x', 'position_y']);

/** D-224 — one EQ band's three numeric rows, in Resolve's own order
 *  (Frequency, Gain, Q). Same `PropertyRow`-shaped record `TRANSFORM_FIELDS`
 *  and `AUDIO_FIELDS` are, so all four sections render through one component.
 *
 *  **Steps and bounds are the stored units**, as everywhere else on this
 *  panel. Frequency steps by 10 Hz — a useful nudge in the low-mids where
 *  problems actually live, and coarse enough that the spinner is not useless
 *  up at 8 kHz (a log-scaled drag is what the response-curve UI would bring;
 *  see D-224's deferred half). Gain steps by 0.5 dB, the finest step an editor
 *  can hear on a broad band. Q steps by 0.1 across `0.1..20`.
 *
 *  `key` is the `EqBand` field these write, so the row's `param` really is the
 *  name of the thing it edits — the same property `TRANSFORM_FIELDS` has. */
const EQ_BAND_FIELDS: Array<{
  key: 'freq_hz' | 'gain_db' | 'q';
  label: string;
  step: number;
  min: number;
  max: number;
}> = [
  { key: 'freq_hz', label: 'Freq', step: 10, min: EQ_MIN_FREQ_HZ, max: EQ_MAX_FREQ_HZ },
  { key: 'gain_db', label: 'Gain', step: 0.5, min: -EQ_MAX_GAIN_DB, max: EQ_MAX_GAIN_DB },
  { key: 'q', label: 'Q', step: 0.1, min: EQ_MIN_Q, max: EQ_MAX_Q },
];

/** D-224 — each EQ field's own rest value, for its `PropertyRow`'s reset.
 *  The same one-source-of-truth role `CLIP_TRANSFORM_DEFAULTS` plays, and
 *  matching `apelles_types::EqBand`'s own serde defaults exactly (`1 kHz`,
 *  flat, Butterworth) so a reset writes the value the backend would also treat
 *  as unset. Deliberately per FIELD rather than per band: resetting Gain must
 *  not also move a frequency the user placed. */
const DEFAULT_EQ_BAND_VALUES: Readonly<Record<'freq_hz' | 'gain_db' | 'q', number>> = {
  freq_hz: 1_000,
  gain_db: 0,
  q: EQ_DEFAULT_Q,
};

/** D-254 — a real hairline between adjacent Inspector sections, on BOTH tabs.
 *
 *  The owner drew a line on a screenshot of the Crop → Dynamic Zoom seam and
 *  asked for a divider there. Every other seam had the same gap and the same
 *  absence — Transform → Crop, Dynamic Zoom → Speed, Speed → Fade, Fade →
 *  Keyframes, and Audio → EQ on the other tab — so all of them get it, rather
 *  than the one that happened to be screenshotted; a rule in exactly one of
 *  six identical seams is worse than none.
 *
 *  Expressed as a between-children rule (`* + *`) on the tab panel rather
 *  than a `<Separator />` interleaved six times, or a border baked into
 *  `@apelles/inspector`'s shared `InspectorSection`. The first is six edits to
 *  keep in sync and one more thing to forget when a seventh section lands;
 *  the second would reach into Motion's Inspector too, where the same
 *  component is returned as the root of a dozen different subcomponents and
 *  `:first-child` means something different in each. `* + *` is inherently
 *  correct as sections come and go — never above the first, never below the
 *  last, no per-section bookkeeping.
 *
 *  `border-border-color` is the fork's own line token (what this panel's
 *  header, the Inspector column and `TimelineSwitcher` already use); `pt-4`
 *  balances the `gap-4` the panel already sets, so the rule sits centred in
 *  16px of air on each side rather than crowding the heading under it. */
const INSPECTOR_SECTION_DIVIDERS = '[&>*+*]:border-t [&>*+*]:border-border-color [&>*+*]:pt-4';

export function ClipInspectorPanel({
  clip,
  trackLocked,
  geometry,
  clipKeyframes,
  keyedHere,
  paramStates,
  onTransformChange,
  onFadeChange,
  onSpeedChange,
  playheadSourceFrame,
  onEqBandChange,
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
  dynamicZoomArmed,
  dynamicZoomEasePreset,
  dynamicZoomWouldReplace,
  onDynamicZoomArm,
  onDynamicZoomEase,
  onDynamicZoomSwap,
  tab,
  onTabChange,
}: {
  clip: Clip | null;
  trackLocked: boolean;
  /** D-193 — the selected clip's composition/source geometry, or `null`
   *  while it hasn't resolved yet (fresh selection, still probing, or the
   *  source is offline). The Width/Height fields below are disabled without
   *  it — there's no pixel size to show or write without a known
   *  composition/source resolution. `Scale` needs no such fetch and stays
   *  always editable. */
  geometry: ClipGeometry | null;
  clipKeyframes: ClipKeyframe[];
  keyedHere: boolean;
  /** D-208 — every keyframeable property's live state, derived by
   *  `EditorInspectorPanel`. Complete by construction (`Record`, not
   *  `Partial`), so a row can never be rendered without one. */
  paramStates: Record<ClipKeyframeParam, PropertyState>;
  onTransformChange: (patch: TransformPatch) => void;
  onFadeChange: (patch: FadePatch) => void;
  /** D-236 — replace this clip's speed ramp. Whole-array, like the op itself;
   *  `SpeedRampEditor` computes the next list. */
  onSpeedChange: (points: SpeedPoint[]) => void;
  /** D-236 — the SOURCE frame under the playhead, or `null` when the playhead
   *  is not over this clip. Only the Speed section reads it ("add a speed
   *  point at the playhead"); resolved by `EditorInspectorPanel` through the
   *  same `clipSourceFrame` the keyframe rows already use, so a speed point
   *  and a keyframe added at the same moment land on the same frame. */
  playheadSourceFrame: number | null;
  /** D-224 — patch ONE band of this clip's EQ. Partial by field, exactly as
   *  `set_clip_eq` itself is: the panel edits one control at a time and must
   *  never restate a frequency it did not touch. */
  onEqBandChange: (band: number, patch: Partial<EqBand>) => void;
  /** D-224 — drop the whole band set back to "no EQ" (the section's own reset
   *  button). Distinct from resetting each field: it is the only way back to a
   *  clip that stores no `eq_bands` key at all. */
  onEqClear: () => void;
  /** D-208 — edit ONE property's value. Distinct from `onTransformChange`
   *  because an animated property's edit must land on its keyframe at the
   *  playhead, not (only) on its static field — the caller decides, this
   *  panel just says which property changed to what. */
  onParamChange: (param: ClipKeyframeParam, value: number) => void;
  onKeyframeToggle: (param: ClipKeyframeParam) => void;
  onKeyframeNav: (param: ClipKeyframeParam, dir: -1 | 1) => void;
  onResetParam: (param: ClipKeyframeParam) => void;
  /** D-233 — open (or close) one property's ease curve in the timeline's
   *  curve editor lane. Passed straight through to every keyframeable
   *  `PropertyRow`; the rows themselves decide whether to render the button
   *  (only an animated property has a curve — see `PropertyRow`). */
  onOpenCurve: (param: ClipKeyframeParam) => void;
  /** Which property's curve is open right now, or `null`. Drives the pressed
   *  state of exactly one row's button. */
  openCurveParam: ClipKeyframeParam | null;
  onUpsertKeyframe: () => void;
  onRemoveKeyframeHere: () => void;
  onClearKeyframes: () => void;
  /** D-234 — is the viewer showing THIS clip's start/end boxes? Store state
   *  (`timelineStore.dynamicZoom`), resolved against the selection by
   *  `EditorInspectorPanel`, so this panel stays pure presentation. */
  dynamicZoomArmed: boolean;
  /** The `EASE_PRESETS` name of the ease the next bake will use. A name rather
   *  than a `EaseCurve` because the `<select>` speaks names, and unlike the
   *  Fade section's own curve picker there is no "custom" case to represent:
   *  the ease here is authoring state this panel itself sets, never something
   *  read back off a clip. */
  dynamicZoomEasePreset: string;
  /** Does the clip already carry `position_x`/`position_y`/`scale` keys that a
   *  dynamic zoom would replace? Drives the warning line, not the controls —
   *  the gesture is offered either way, it is just stated first. */
  dynamicZoomWouldReplace: boolean;
  onDynamicZoomArm: (armed: boolean) => void;
  onDynamicZoomEase: (curve: EaseCurve) => void;
  /** Swap the start and end framings — Resolve's own Swap button, which turns
   *  a push-in into a pull-out without re-dragging either box. Writes
   *  keyframes (unlike the arm toggle), so it is a real edit and a real undo
   *  step. */
  onDynamicZoomSwap: () => void;
  /** D-246 — which Inspector tab the user last chose. Store state
   *  (`timelineStore.inspectorTab`), resolved against THIS clip's own
   *  available tabs below, so a title (which has no Audio tab) shows its
   *  Video tab without the panel forgetting where the user was. */
  tab: ClipInspectorTab;
  onTabChange: (tab: ClipInspectorTab) => void;
}) {
  // D-193 — locked by default for a clip with no independent-axis override
  // yet (the common "just scale it" case); a clip an MCP agent or a prior
  // session already gave independent `box_width`/`box_height` starts
  // unlocked, matching what's actually on screen. Ephemeral — see this
  // file's own module doc for why this is UI-only, never persisted, and
  // `EditorInspectorPanel.tsx`'s `key={clip.id}` for why this resets
  // correctly on every new clip selection despite living in local state.
  const [ratioLocked, setRatioLocked] = useState(() => clip?.box_width == null && clip?.box_height == null);

  if (!clip) {
    return <InspectorEmptyState>Select a clip to edit its properties.</InspectorEmptyState>;
  }

  const transformFields = clip.text
    ? TRANSFORM_FIELDS.filter((f) => TEXT_CLIP_TRANSFORM_PARAMS.has(f.param))
    : TRANSFORM_FIELDS;

  // D-224 — what the EQ section RENDERS: this clip's own bands, or the default
  // four-band strip when it has none. Read-only — nothing is written until a
  // real edit, so merely selecting a clip never dirties the project (the
  // reducer materialises the same strip on the first patch, so what a user
  // sees and what their first edit stores are the same four bands).
  const eqBands = eqBandsForDisplay(clip.eq_bands);
  // …and whether any of it is doing anything, which is what the section's own
  // note tells the user. An untouched strip is completely inert, and saying so
  // is what stops "I set up four bands and nothing happened" reading as a bug.
  const eqActive = hasActiveEq(clip.eq_bands);

  // D-193 — the box's CURRENT effective size, in composition fractions:
  // the override when the clip has one, else `scale`'s own natural-footprint
  // formula (mirrors `chroma::edit::ClipTransform::effective_size` exactly,
  // one layer up). `null` when `geometry` hasn't resolved — nothing to
  // compute a pixel size from yet.
  const scale = clip.scale ?? 1;
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
      // Unlocked: only Width changes — Height is restated at its CURRENT
      // resolved value (possibly still `scale`-derived) so it becomes a
      // real, explicit override rather than silently drifting later if
      // `scale` itself ever changes again.
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

  const tabs = clipInspectorTabs(clip);
  const activeTab = resolveClipInspectorTab(tab, tabs);

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => onTabChange(value as ClipInspectorTab)}
      // `gap-0` because this panel supplies its own spacing: the header block
      // below is padded and bordered, and the scroller under it is padded.
      className="flex h-full min-h-0 w-full flex-col gap-0 text-xs"
      data-chroma-panel="clip-inspector"
    >
      {/* D-246 — the clip's name, its locked note and the tab bar stay put
          while the properties scroll. That is the whole point of a tab bar: a
          navigation control you have to scroll to find is not one. */}
      <div className="flex shrink-0 flex-col gap-2 border-b border-border-color p-3 pb-2">
        <div className="text-text-primary font-medium truncate" title={clip.name}>
          {clip.name}
        </div>
        {trackLocked && (
          <div className="text-[10px] text-text-secondary/60 rounded bg-surface px-2 py-1.5">
            This clip's track is locked — unlock it to edit transform or keyframes.
          </div>
        )}
        {/* One tab is not a tab bar: a text clip has no audio, so its
            Inspector renders exactly the single scrolling column it always
            did, with no chrome that does nothing. */}
        {/* D-254 — the app's OWN tab language, not shadcn's default pill.
            Apelles draws a selected tab as an accent underline under a
            full-strength label, in both places it already had tabs: the
            shell's Edit/Motion/Colorist switcher (`Shell.tsx` — a `bg-accent`
            2px bar plus `text-text-primary`) and this same tab's own
            `TimelineSwitcher` (`data-active:border-b-accent`). The pill this
            bar shipped with was the shadcn kit's untouched `default` variant,
            which is why it read as borrowed; `line` is the kit's own
            no-pill variant, and the accent underline below is the same
            `border-b-2` idiom `TimelineSwitcher` uses, stated at the call
            site (the `editor` layer) rather than pushed into `@apelles/ui`,
            so the generic kit stays generic. */}
        {tabs.length > 1 && (
          <TabsList variant="line" className="w-full gap-0 p-0">
            {tabs.map((id) => (
              <TabsTrigger
                key={id}
                value={id}
                className="flex-1 rounded-none border-b-2 border-b-transparent py-1.5 text-xs data-active:border-b-accent data-active:text-text-primary"
              >
                {CLIP_INSPECTOR_TAB_LABELS[id]}
              </TabsTrigger>
            ))}
          </TabsList>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {/* D-246 — the VIDEO tab: this clip's picture, its geometry, and
            everything measured against its extent. Resolve's own Inspector
            puts Transform, Cropping, Dynamic Zoom and Speed Change on its
            Video tab, and this keeps that grouping; Fade and Keyframes join
            them because they are properties of the clip's extent rather than
            of its sound (a fade drives picture AND sound together — the
            section's own note says so — and "Key all properties" keys
            transform and crop). See `clipInspectorTabs.ts` for the split. */}
        <TabsContent value="video" className={`flex flex-col gap-4 ${INSPECTOR_SECTION_DIVIDERS}`}>
          <InspectorSection label="Transform">
            {/* D-208 — the five transform properties, each its own independently
                keyframeable/resettable row. `TRANSFORM_FIELDS` carries only the
                per-field numbers (label/step/bounds); everything behavioural is
                identical across rows and lives in `PropertyRow`.

                Every row — `Scale` included — routes its edit through the one
                `onParamChange`. `Scale`'s extra D-193 duty (clearing an
                independent Width/Height override) belongs to the caller, not
                here: only the caller knows whether the property is currently
                animated, and an edit to an animated `Scale` has to land on its
                keyframe. Special-casing it in this file instead made typing in
                `Scale` silently not key at all while animated — caught by
                `EditorInspectorPanel.keyframes.dom.test.tsx`. */}
            {transformFields.map(({ param, label, step, min, max }) => (
              <PropertyRow
                key={param}
                label={label}
                param={param}
                state={paramStates[param]}
                step={step}
                min={min}
                max={max}
                disabled={trackLocked}
                onChange={(v) => onParamChange(param, v)}
                onKeyframeToggle={onKeyframeToggle}
                onKeyframeNav={onKeyframeNav}
                onReset={onResetParam}
                onOpenCurve={onOpenCurve}
                curveOpen={openCurveParam === param}
              />
            ))}

            {/* D-193 — independent Width/Height, in pixels of the project's
                own known composition (`geometry`), with a ratio-lock toggle.
                See this file's own module doc for the full "why" this exists
                alongside `Scale` rather than replacing it.

                D-208 moved these BELOW Rotation (they used to sit between Scale
                and Rotation) so the five per-property-keyframeable rows stay
                contiguous and this ratio-locked, deliberately un-keyframeable
                pair reads as the separate thing it is.

                D-211 follow-up — a text clip has no box to size: Rust's
                `resolve_text_clip_transform` pins `box_width`/`box_height` to
                `None` regardless of what's stored, and a title's own size is
                its Title section's `size` field (a font-size fraction), not a
                bounding box. Hidden rather than shown-and-disabled, matching
                how the Crop section below is hidden entirely rather than
                rendered inert. */}
            {!clip.text && (
              <>
                <label className={row}>
                  <span className="text-text-secondary">Width</span>
                  <ScrubbableNumberInput
                    step={1}
                    min={0}
                    disabled={trackLocked || !geometry}
                    className={numInput}
                    value={widthPx != null ? Math.round(widthPx) : null}
                    onValueChange={handleWidthPxChange}
                  />
                </label>
                <div className="flex items-center justify-center py-0.5">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={trackLocked || !geometry}
                    onClick={() => setRatioLocked((v) => !v)}
                    title={ratioLocked ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
                  >
                    {ratioLocked ? <Lock size={12} /> : <Unlock size={12} />}
                  </Button>
                </div>
                <label className={row}>
                  <span className="text-text-secondary">Height</span>
                  <ScrubbableNumberInput
                    step={1}
                    min={0}
                    disabled={trackLocked || !geometry}
                    className={numInput}
                    value={heightPx != null ? Math.round(heightPx) : null}
                    onValueChange={handleHeightPxChange}
                  />
                </label>
                {!geometry && (
                  <p className="text-text-secondary/60 text-[10px] leading-snug">
                    Measuring source resolution…
                  </p>
                )}
              </>
            )}
          </InspectorSection>

          {/* D-132 — Crop, the Edit tab's first (D-127 Finding 3: the concept
              was absent here entirely, while Colorist had its own unrelated
              pixel-space one). Its own section rather than four more Transform
              rows, because both references treat crop as a separate thing from
              the motion/transform controls — Premiere splits it into its own
              Crop effect, Resolve into its own viewer mode. Values are the
              stored unit itself (a 0–1 fraction of the source), not a
              percentage: this panel already shows Opacity as 0–1 rather than
              0–100, and a display-only unit conversion is a rounding-bug
              surface for no real gain at this size.

              D-211 follow-up — hidden entirely for a text clip: `drawtext`
              has no crop concept and `resolve_text_clip_transform` pins all
              four insets to 0, so a rendered-but-inert Crop section would be
              four rows that visibly do nothing when dragged. */}
          {!clip.text && (
            <InspectorSection label="Crop">
              {/* D-208 — the same `PropertyRow` the Transform section uses: each
                  inset is independently keyframeable and independently
                  resettable, exactly like every other transform field. */}
              {CROP_FIELDS.map(({ key, label }) => (
                <PropertyRow
                  key={key}
                  label={label}
                  param={key}
                  state={paramStates[key]}
                  step={CROP_STEP}
                  min={0}
                  max={1}
                  disabled={trackLocked}
                  onChange={(v) => onParamChange(key, v)}
                  onKeyframeToggle={onKeyframeToggle}
                  onKeyframeNav={onKeyframeNav}
                  onReset={onResetParam}
                  onOpenCurve={onOpenCurve}
                  curveOpen={openCurveParam === key}
                />
              ))}
            </InspectorSection>
          )}

          {/* D-234 — Dynamic Zoom. **In the Inspector because that is where
              Resolve puts it** — its own Edit-page copy is explicit ("select a
              clip in the timeline, then turn on dynamic zoom in the inspector"),
              and it sits next to Crop for the same reason Crop sits where it
              does: both are viewer MODES that replace the on-canvas controls,
              which is exactly how Resolve's own viewer mode selector groups
              them. See `DynamicZoomOverlay.tsx` for the reference itself.

              The toggle arms the two boxes and writes NOTHING. The keyframes are
              written by dragging a box (or by `editor_set_dynamic_zoom`), so
              arming and disarming are both free and the section never has a
              pending, unapplied state to reconcile.

              Hidden for a text clip and an adjustment clip, matching Crop above
              and the overlay's own guards: a title's `scale` is pinned
              server-side and an adjustment clip's correction is full-frame, so
              for both the animation this section writes would be one neither
              renderer reads. */}
          {!clip.text && !clip.adjustment && (
            <InspectorSection label="Dynamic Zoom">
              <label className={row}>
                <span className="text-text-secondary">Show start/end boxes</span>
                <Button
                  type="button"
                  size="sm"
                  variant={dynamicZoomArmed ? 'default' : 'outline'}
                  className="h-7 px-2 text-xs"
                  disabled={trackLocked}
                  aria-pressed={dynamicZoomArmed}
                  onClick={() => onDynamicZoomArm(!dynamicZoomArmed)}
                  data-dynamic-zoom-toggle
                >
                  {dynamicZoomArmed ? 'On' : 'Off'}
                </Button>
              </label>
              <label className={row}>
                <span className="text-text-secondary/70 pl-2 text-[11px]">Ease</span>
                <Select
                  value={dynamicZoomEasePreset}
                  onValueChange={(v) => {
                    const hit = EASE_PRESETS.find((p) => p.name === v);
                    if (hit) onDynamicZoomEase(hit.curve);
                  }}
                  disabled={trackLocked || !dynamicZoomArmed}
                >
                  <SelectTrigger className="h-7 w-28 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EASE_PRESETS.map((p) => (
                      <SelectItem key={p.name} value={p.name}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              {dynamicZoomArmed && (
                <div className="flex justify-end pt-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    disabled={trackLocked}
                    onClick={onDynamicZoomSwap}
                    title="Swap the start and end framings — turns a push-in into a pull-out"
                    data-dynamic-zoom-swap
                  >
                    Swap start / end
                  </Button>
                </div>
              )}
              <p className="text-text-secondary/60 pt-1 text-[10px] leading-snug">
                {dynamicZoomArmed
                  ? 'Drag the green (start) and red (end) boxes in the viewer. Releasing either one writes the clip’s position and scale keyframes across its whole length.'
                  : 'Animate a push-in or pull-out by dragging two boxes in the viewer instead of keying by hand.'}
              </p>
              {/* Not decoration: a dynamic zoom spans the WHOLE clip, so it
                  replaces any position/scale animation already there. Saying so
                  before the drag is the difference between an informed
                  replacement and B-067's shape (a field that silently destroys
                  work). Everything else the clip has keyed — opacity, rotation,
                  crop, volume, pan — survives untouched. */}
              {dynamicZoomArmed && dynamicZoomWouldReplace && (
                <p className="pt-1 text-[10px] leading-snug text-red-400">
                  This clip already has position or scale keyframes. Dragging a box replaces them
                  (one undo step); its other animated properties are left alone.
                </p>
              )}
            </InspectorSection>
          )}

          {/* D-236 — Speed (retime). Placed above Fade because a retime changes
              the clip's LENGTH, which is what every duration below it is
              measured against — the reference (Resolve's own Retime Controls)
              likewise presents speed as a property of the clip's extent rather
              than of its picture. Not offered on a generated layer: a title or
              an adjustment clip has no source footage to retime, and its
              timeline footprint is simply its own duration. */}
          {!clip.text && !clip.adjustment && (
            <SpeedRampEditor
              clip={clip}
              trackLocked={trackLocked}
              playheadSourceFrame={playheadSourceFrame}
              onSpeedChange={onSpeedChange}
            />
          )}

          {/* D-147 — Fade in / out. Its own section rather than more Transform
              rows, for the same reason Crop got one: a fade is not part of a
              clip's geometry, it is a time-domain envelope over whatever that
              geometry produces, and it applies to audio-track clips that have
              no transform at all. Both references present it separately too.

              **Durations are frames**, matching every other number the Edit tab
              speaks (`start_frame`, `duration`, `source_start`) — not seconds,
              which would need the clip's fps here and would be the only unit on
              this panel that isn't the stored one.

              The note below is not decoration: one fade drives BOTH picture and
              sound on a video clip, and a user who does not know that will read
              a silent picture fade as a bug. See the plan doc §2. */}
          <InspectorSection label="Fade">
            {FADE_FIELDS.map(({ label, durationKey, curveKey }) => {
              const preset = easePresetName(clip[curveKey]);
              return (
                <div className="flex flex-col gap-1" key={durationKey}>
                  <label className={row}>
                    <span className="text-text-secondary">{label}</span>
                    <ScrubbableNumberInput
                      // Whole frames, never negative. Not capped at the clip's
                      // own `duration`: a fade longer than the clip is
                      // legitimate (the two windows overlap and multiply), and
                      // capping would silently move a handle the user placed.
                      step={1}
                      min={0}
                      disabled={trackLocked}
                      className={numInput}
                      value={clip[durationKey] ?? 0}
                      onValueChange={(frames) => onFadeChange({ [durationKey]: frames })}
                    />
                  </label>
                  <label className={row}>
                    <span className="text-text-secondary/70 pl-2 text-[11px]">Curve</span>
                    <Select
                      value={preset ?? CUSTOM_CURVE}
                      onValueChange={(v) => {
                        const hit = EASE_PRESETS.find((p) => p.name === v);
                        // `custom` is display-only — it names a curve MCP
                        // authored that this panel has no editor for, so
                        // selecting it must not overwrite that curve with
                        // anything.
                        if (hit) onFadeChange({ [curveKey]: hit.curve });
                      }}
                      disabled={trackLocked}
                    >
                      <SelectTrigger className="h-7 w-28 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {EASE_PRESETS.map((p) => (
                          <SelectItem key={p.name} value={p.name}>
                            {p.name}
                          </SelectItem>
                        ))}
                        {/* Only offered when the clip really has one, so the
                            list stays the four real presets otherwise. */}
                        {preset === null && <SelectItem value={CUSTOM_CURVE}>custom</SelectItem>}
                      </SelectContent>
                    </Select>
                  </label>
                </div>
              );
            })}
            <p className="text-text-secondary/60 pt-1 text-[10px] leading-snug">
              Fades this clip's picture and its sound together. Unlink its audio to fade them
              separately.
            </p>
          </InspectorSection>

          {/* the exact interaction `RelightPanel.tsx` uses for relight-light
              keyframes (Diamond icon, `keyedHere` highlight, add/update/
              delete-here/clear-all) — see `clipKeyframes.ts`'s doc for why
              this is a small local mirror rather than a cross-package import
              of `app/src/utils/maskKeyframes.ts`.

              **D-208 — KEPT, deliberately, not left as redundant UI.** The
              per-property diamonds above subsume "which properties are
              animated", so this section stops being the only keyframe control
              and becomes what it is actually good at: whole-clip batch actions
              that have no single-property equivalent.
              - "Key all properties" is a real batch shortcut — nine diamond
                clicks in one, and the standard NLE "pin everything as it is
                right now, then animate from here" gesture. It is no longer
                confusing the way it was as the ONLY control, because its
                effect is now fully visible in the nine diamonds it lights up.
                It MERGES now (D-208's `mergeClipKeyframeParams`) rather than
                replacing the frame's whole entry, so it can never clobber a
                key a single property's diamond already put there.
              - Delete-here / Clear-all are pure housekeeping over the raw
                array, which matters precisely because MCP agents
                (`editor_set_clip_keyframes`) and older sessions can leave
                keyframe data no per-property control would fully explain.
              The label says "all properties" rather than "clip" so it can't be
              misread as "the one thing that turns keyframing on." */}
          <InspectorSection label="Keyframes">
            <div className="flex items-center gap-2 text-[11px] text-text-secondary select-none">
              <Button
                variant="ghost"
                size="xs"
                disabled={trackLocked}
                className={`gap-1 px-1.5 ${keyedHere ? 'text-accent' : 'text-text-primary'}`}
                onClick={onUpsertKeyframe}
                title="Keyframe every transform and crop property at the current frame"
              >
                <Diamond size={11} fill={keyedHere ? 'currentColor' : 'none'} />
                Key all properties
              </Button>
              {clipKeyframes.length > 0 && (
                <>
                  <span className="tabular-nums">
                    {clipKeyframes.length} key{clipKeyframes.length === 1 ? '' : 's'}
                  </span>
                  {keyedHere && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={trackLocked}
                      onClick={onRemoveKeyframeHere}
                      title="Delete every property's keyframe at this frame"
                    >
                      <X size={12} />
                    </Button>
                  )}
                  <Button variant="ghost" size="xs" disabled={trackLocked} onClick={onClearKeyframes} title="Remove all keyframes">
                    Clear
                  </Button>
                </>
              )}
            </div>
          </InspectorSection>
        </TabsContent>

        {/* D-246 — the AUDIO tab: this clip's own sound, and nothing else.
            Rendered only when the clip has audio at all (a title has none),
            which is exactly the `!clip.text` gate these two sections used to
            carry individually — now stated once, in `clipInspectorTabs`. */}
        {tabs.includes('audio') && (
          <TabsContent value="audio" className={`flex flex-col gap-4 ${INSPECTOR_SECTION_DIVIDERS}`}>
          {/* D-223 — this clip's OWN level and stereo position, independent of
              its track's fader. Its own section rather than more Fade rows for
              the same reason Crop got one: the reference NLE presents them as a
              separate group (Resolve's Inspector: "Clip Volume" / "Clip Pan" on
              its own Audio tab, `scratch/resolve-reference/soundtrack.jpg`),
              and a level is a different kind of thing from a fade envelope.

              Both rows are `PropertyRow`s, so both are keyframeable, navigable
              and resettable exactly like every Transform/Crop row — a volume
              automation ramp is the same machinery an animated Opacity uses
              (D-208/D-220), not a parallel one.

              Hidden entirely for a TEXT clip, matching how Crop is: a generated
              title has no audio stream at all, so a rendered-but-inert Audio
              section would be two rows that visibly do nothing. */}
          <InspectorSection label="Audio">
            {AUDIO_FIELDS.map(({ param, label, step, min, max }) => (
              <PropertyRow
                key={param}
                label={label}
                param={param}
                state={paramStates[param]}
                step={step}
                min={min}
                max={max}
                disabled={trackLocked}
                onChange={(v) => onParamChange(param, v)}
                onKeyframeToggle={onKeyframeToggle}
                onKeyframeNav={onKeyframeNav}
                onReset={onResetParam}
                onOpenCurve={onOpenCurve}
                curveOpen={openCurveParam === param}
              />
            ))}
            {/* Not decoration, for the same reason the Fade note isn't: the
                first is what stops "I turned the track down and this clip is
                still loud" being read as a bug, and the second is the real,
                stated cost of this app's own pan law (a 0 dB centre means the
                boost lands at the extremes — see `apelles_types::pan`). */}
            <p className="text-text-secondary/60 pt-1 text-[10px] leading-snug">
              This clip's own level, multiplied with its track's gain — not a replacement for it.
              Hard panning boosts the destination channel by 3 dB, so lower Volume if the source is
              already close to full scale.
            </p>
          </InspectorSection>

          {/* D-224 — this clip's own multi-band parametric EQ. Its own section
              under Audio, matching where Resolve puts its Clip Equalizer
              (`scratch/resolve-reference/soundtrack.jpg`: Clip Volume, Clip Pan,
              Clip Pitch, then Clip Equalizer, in that order down the Inspector's
              Audio tab).

              **Four bands, laid out as Resolve lays them out**: that reference
              shows `Band 1`…`Band 4`, each a name button that doubles as the
              band's enable toggle plus a shape dropdown, over a ±24 dB response
              graph. The four bands and the ±24 dB range are matched exactly, and
              (D-237) so is the graph itself now — `EqResponseGraph` below,
              rendered first so the section reads graph-then-bands exactly as the
              reference does. Each band's Freq/Gain/Q are still real
              `PropertyRow`s underneath it, so the numbers are all authorable and
              every row gets the same field layout and reset the Transform rows
              have — the graph is an ADDITIONAL affordance over the same
              `onEqBandChange`, not a replacement for typing an exact value.

              The rows carry NO keyframe diamond, and that is a decision rather
              than an oversight: an EQ here is static (see `Clip.eq_bands` and
              D-224 — ffmpeg's biquad filters parse their parameters once, so an
              animated EQ cannot be exported at all). `PropertyRow` renders no
              keyframe controls when it is handed none, rather than three dead
              buttons.

              Hidden for a TEXT clip, exactly as Audio and Crop are. */}
          <InspectorSection label="EQ">
            <EqResponseGraph bands={eqBands} disabled={trackLocked} onBandChange={onEqBandChange} />
            {eqBands.map((band, index) => (
              <div className="flex flex-col gap-1.5 border-l border-border-color pl-2" key={index}>
                <div className={row}>
                  {/* The band number IS the enable toggle — Resolve's own
                      affordance, where `Band N` reads coloured when on. Accent
                      when enabled, muted when bypassed, so a band that has
                      been switched off is visibly off rather than silently
                      inert. */}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={trackLocked}
                    className={`h-7 px-1.5 text-[11px] ${band.enabled ? 'text-accent' : 'text-text-secondary/50'}`}
                    onClick={() => onEqBandChange(index, { enabled: !band.enabled })}
                    title={
                      band.enabled
                        ? `Bypass band ${index + 1} (keeps its settings)`
                        : `Enable band ${index + 1}`
                    }
                    aria-pressed={band.enabled}
                  >
                    Band {index + 1}
                  </Button>
                  <Select
                    value={band.kind}
                    onValueChange={(v) => onEqBandChange(index, { kind: v as EqBandKind })}
                    disabled={trackLocked}
                  >
                    <SelectTrigger className="h-7 w-28 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {EQ_BAND_KINDS.map((k) => (
                        <SelectItem key={k} value={k}>
                          {EQ_BAND_KIND_LABELS[k]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {EQ_BAND_FIELDS.map(({ key, label, step, min, max }) => (
                  <PropertyRow
                    key={key}
                    label={label}
                    param={key}
                    // Static: no keyframe callbacks passed, so no diamond and
                    // no nav arrows render at all (see `PropertyRow`).
                    state={staticPropertyState(band[key])}
                    step={step}
                    min={min}
                    max={max}
                    // A pass filter has no gain — the row would be editable and
                    // do nothing, so it is disabled rather than hidden (hiding
                    // it would make the three bands' rows jump around as kinds
                    // change).
                    disabled={trackLocked || (key === 'gain_db' && !eqKindUsesGain(band.kind))}
                    onChange={(v) => onEqBandChange(index, { [key]: v })}
                    onReset={() => onEqBandChange(index, { [key]: DEFAULT_EQ_BAND_VALUES[key] })}
                  />
                ))}
              </div>
            ))}
            <div className="flex items-center justify-between pt-0.5">
              <p className="text-text-secondary/60 text-[10px] leading-snug">
                {eqActive
                  ? 'Applied before the clip’s volume, fade and duck — in the preview and the render alike.'
                  : 'Every band is flat, so this clip is unfiltered. Set a Gain, or pick a High Pass, to hear it.'}
              </p>
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={trackLocked || !clip.eq_bands || clip.eq_bands.length === 0}
                onClick={onEqClear}
                title="Remove this clip's EQ entirely"
                aria-label="Reset EQ"
              >
                <RotateCcw size={11} />
              </Button>
            </div>
          </InspectorSection>
          </TabsContent>
        )}
      </div>
    </Tabs>
  );
}
