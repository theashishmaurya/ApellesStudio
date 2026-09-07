/**
 * @chroma/editor — the Inspector, NLE half (D-102, Phase 3 of
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
 * from `@chroma/inspector` (a tiny shared package with no `@chroma/ui`
 * dependency — see its README), the same components `@chroma/motion`'s
 * `InspectorPanel.tsx` uses. The field layout (`row`/`numInput` below) stays
 * local and different from Motion's — this panel's side-by-side label/input
 * rows were built for a narrower panel with only numeric fields, Motion's
 * stacked label-above-input rows were built for a wider panel with
 * selects/colour-pickers too; forcing one shape onto the other would mean
 * rewriting a working, tested layout for no real benefit, exactly the
 * "don't force a deeper unification than is actually clean" call
 * `@chroma/inspector`'s README documents. Motion's `InspectorPanel.tsx` and
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
 */
import { useState } from 'react';
import { ChevronLeft, ChevronRight, Diamond, Lock, RotateCcw, Unlock, X } from 'lucide-react';
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@chroma/ui';
import { InspectorEmptyState, InspectorSection } from '@chroma/inspector';
import { FADE_PRESETS, fadePresetName, type Clip, type ClipTransformParam, type FadeCurve } from './timeline';
import type { ClipKeyframe } from './clipKeyframes';
import type { ClipGeometry } from './useClipGeometry';

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
  fade_in_curve: FadeCurve;
  fade_out_curve: FadeCurve;
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
const numInput = 'h-7 w-20 text-right';
/** D-208 — a property row's field shares its line with four icon buttons, so
 *  it runs one step narrower than the Size/Fade rows' `numInput`. */
const propInput = 'h-7 w-16 text-right';

/** D-208 — one keyframeable property's live state, as this pure-presentation
 *  panel needs it. `EditorInspectorPanel` derives every field (see its own
 *  `paramStates`); nothing here reads `clip.chroma_keyframes` directly.
 *
 *  `value` is the property's value AT THE PLAYHEAD — the interpolated one for
 *  an animated property, the static field otherwise — because a field showing
 *  a static number while the preview renders an interpolated one is a panel
 *  that lies about the picture. */
export interface PropertyState {
  value: number;
  /** Any keyframe at all names this property (the filled diamond). */
  animated: boolean;
  /** …and one of them sits exactly at the playhead. */
  keyedHere: boolean;
  /** The nearest key strictly before / after the playhead, or `null` when
   *  there is none in that direction (the `<` / `>` buttons' disabled state).
   *  Timeline frames, ready to hand straight to `setPlayhead`. */
  prevFrame: number | null;
  nextFrame: number | null;
}

/** One Transform/Crop row: label, value field, that property's own keyframe
 *  nav + stopwatch diamond, and its own reset (D-208). Local to this file —
 *  it is this panel's row layout, not a shared component. */
function PropertyRow({
  label,
  param,
  state,
  step,
  min,
  max,
  disabled,
  onChange,
  onKeyframeToggle,
  onKeyframeNav,
  onReset,
}: {
  label: string;
  param: ClipTransformParam;
  state: PropertyState;
  step: number;
  min?: number;
  max?: number;
  disabled: boolean;
  onChange: (value: number) => void;
  onKeyframeToggle: (param: ClipTransformParam) => void;
  onKeyframeNav: (param: ClipTransformParam, dir: -1 | 1) => void;
  onReset: (param: ClipTransformParam) => void;
}) {
  return (
    <div className={row}>
      {/* The label still really labels the input (clicking it focuses the
          field) — which is why the buttons live OUTSIDE this element: a
          <label> wrapping them would make every icon click also hit the
          input. */}
      <label className="flex min-w-0 flex-1 items-center justify-between gap-2">
        <span className="text-text-secondary truncate">{label}</span>
        <Input
          type="number"
          step={step}
          min={min}
          max={max}
          disabled={disabled}
          className={propInput}
          value={state.value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </label>
      <div className="flex shrink-0 items-center">
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={disabled || state.prevFrame === null}
          onClick={() => onKeyframeNav(param, -1)}
          title={`Go to the previous ${label} keyframe`}
          aria-label={`Previous ${label} keyframe`}
        >
          <ChevronLeft size={12} />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={disabled}
          // Animated AND a key right here reads at full strength; animated
          // but between keys is dimmed. That is the whole reason `<`/`>`
          // mean anything — without it there is no way to tell, from the
          // row, whether the playhead is sitting on one of this property's
          // keys or between two of them.
          className={
            state.animated ? (state.keyedHere ? 'text-accent' : 'text-accent/50') : 'text-text-secondary'
          }
          onClick={() => onKeyframeToggle(param)}
          title={
            state.animated
              ? `Stop animating ${label} (removes its keyframes, holds its current value)` +
                (state.keyedHere ? ' — keyframed at the playhead' : ' — no keyframe at the playhead')
              : `Animate ${label} (keyframes it at the playhead)`
          }
          aria-label={`Toggle ${label} keyframes`}
          aria-pressed={state.animated}
        >
          {/* Filled = this property is animated, hollow = static — the same
              Diamond-plus-fill convention `RelightPanel.tsx` and this
              panel's own Keyframes section already use. */}
          <Diamond size={11} fill={state.animated ? 'currentColor' : 'none'} />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={disabled || state.nextFrame === null}
          onClick={() => onKeyframeNav(param, 1)}
          title={`Go to the next ${label} keyframe`}
          aria-label={`Next ${label} keyframe`}
        >
          <ChevronRight size={12} />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={disabled}
          onClick={() => onReset(param)}
          title={`Reset ${label} to its default`}
          aria-label={`Reset ${label}`}
        >
          <RotateCcw size={11} />
        </Button>
      </div>
    </div>
  );
}

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

/** D-211 follow-up — a TEXT clip's own `resolve_text_clip_transform` (Rust)
 *  pins `scale`/`rotation`/crop/box size to their identity values regardless
 *  of what's stored, and `editor_set_clip_transform` REFUSES a non-default
 *  write to any of them — only `opacity`/`position_x`/`position_y` actually
 *  do anything for a title. Filters `TRANSFORM_FIELDS` down to those three
 *  for a text clip, rather than rendering rows that silently do nothing (or
 *  worse, that a human edits and then can't work out why nothing moved). */
const TEXT_CLIP_TRANSFORM_PARAMS = new Set<ClipTransformParam>(['opacity', 'position_x', 'position_y']);

export function ClipInspectorPanel({
  clip,
  trackLocked,
  geometry,
  clipKeyframes,
  keyedHere,
  paramStates,
  onTransformChange,
  onFadeChange,
  onParamChange,
  onKeyframeToggle,
  onKeyframeNav,
  onResetParam,
  onUpsertKeyframe,
  onRemoveKeyframeHere,
  onClearKeyframes,
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
  paramStates: Record<ClipTransformParam, PropertyState>;
  onTransformChange: (patch: TransformPatch) => void;
  onFadeChange: (patch: FadePatch) => void;
  /** D-208 — edit ONE property's value. Distinct from `onTransformChange`
   *  because an animated property's edit must land on its keyframe at the
   *  playhead, not (only) on its static field — the caller decides, this
   *  panel just says which property changed to what. */
  onParamChange: (param: ClipTransformParam, value: number) => void;
  onKeyframeToggle: (param: ClipTransformParam) => void;
  onKeyframeNav: (param: ClipTransformParam, dir: -1 | 1) => void;
  onResetParam: (param: ClipTransformParam) => void;
  onUpsertKeyframe: () => void;
  onRemoveKeyframeHere: () => void;
  onClearKeyframes: () => void;
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

  return (
    <div className="h-full w-full overflow-y-auto p-3">
      <div className="flex flex-col gap-4 text-xs">
        <div className="text-text-primary font-medium truncate" title={clip.name}>
          {clip.name}
        </div>
        {trackLocked && (
          <div className="text-[10px] text-text-secondary/60 rounded bg-surface px-2 py-1.5">
            This clip's track is locked — unlock it to edit transform or keyframes.
          </div>
        )}

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
                <Input
                  type="number"
                  step={1}
                  min={0}
                  disabled={trackLocked || !geometry}
                  className={numInput}
                  value={widthPx != null ? Math.round(widthPx) : ''}
                  onChange={(e) => handleWidthPxChange(Number(e.target.value))}
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
                <Input
                  type="number"
                  step={1}
                  min={0}
                  disabled={trackLocked || !geometry}
                  className={numInput}
                  value={heightPx != null ? Math.round(heightPx) : ''}
                  onChange={(e) => handleHeightPxChange(Number(e.target.value))}
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
              />
            ))}
          </InspectorSection>
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
            const preset = fadePresetName(clip[curveKey]);
            return (
              <div className="flex flex-col gap-1" key={durationKey}>
                <label className={row}>
                  <span className="text-text-secondary">{label}</span>
                  <Input
                    type="number"
                    // Whole frames, never negative. Not capped at the clip's
                    // own `duration`: a fade longer than the clip is
                    // legitimate (the two windows overlap and multiply), and
                    // capping would silently move a handle the user placed.
                    step={1}
                    min={0}
                    disabled={trackLocked}
                    className={numInput}
                    value={clip[durationKey] ?? 0}
                    onChange={(e) => onFadeChange({ [durationKey]: Number(e.target.value) })}
                  />
                </label>
                <label className={row}>
                  <span className="text-text-secondary/70 pl-2 text-[11px]">Curve</span>
                  <Select
                    value={preset ?? CUSTOM_CURVE}
                    onValueChange={(v) => {
                      const hit = FADE_PRESETS.find((p) => p.name === v);
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
                      {FADE_PRESETS.map((p) => (
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
      </div>
    </div>
  );
}
