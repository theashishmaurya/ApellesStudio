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
 */
import { useState } from 'react';
import { Diamond, Lock, Unlock, X } from 'lucide-react';
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
import { FADE_PRESETS, fadePresetName, type Clip, type FadeCurve } from './timeline';
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

/** D-132 — the four crop rows, in Resolve's own Left/Right/Top/Bottom order
 *  (its Crop palette's own control order, not alphabetical), each a
 *  normalised 0–1 inset. `0.01` steps because a percent of the frame is the
 *  finest crop anyone nudges by hand; `min`/`max` bound the input, and
 *  `applyOp` clamps again on the way into the timeline for the values a
 *  keyboard can still type past them. */
const CROP_FIELDS: Array<{ key: 'crop_left' | 'crop_right' | 'crop_top' | 'crop_bottom'; label: string }> = [
  { key: 'crop_left', label: 'Left' },
  { key: 'crop_right', label: 'Right' },
  { key: 'crop_top', label: 'Top' },
  { key: 'crop_bottom', label: 'Bottom' },
];
const CROP_STEP = 0.01;

export function ClipInspectorPanel({
  clip,
  trackLocked,
  geometry,
  clipKeyframes,
  keyedHere,
  onTransformChange,
  onFadeChange,
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
  onTransformChange: (patch: TransformPatch) => void;
  onFadeChange: (patch: FadePatch) => void;
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
          <label className={row}>
            <span className="text-text-secondary">Opacity</span>
            <Input
              type="number"
              step={0.05}
              min={0}
              max={1}
              disabled={trackLocked}
              className={numInput}
              value={clip.opacity ?? 1}
              onChange={(e) => onTransformChange({ opacity: Number(e.target.value) })}
            />
          </label>
          <label className={row}>
            <span className="text-text-secondary">Position X</span>
            <Input
              type="number"
              // D-136 — `position_x`/`position_y` are normalised fractions of
              // the composition now (B-043 fix), not absolute pixels; `1`
              // used to be a 1px nudge and is now a full frame-width jump.
              // `0.01` matches the crop insets' own step below, the same
              // stored unit.
              step={CROP_STEP}
              disabled={trackLocked}
              className={numInput}
              value={clip.position_x ?? 0}
              onChange={(e) => onTransformChange({ position_x: Number(e.target.value) })}
            />
          </label>
          <label className={row}>
            <span className="text-text-secondary">Position Y</span>
            <Input
              type="number"
              step={CROP_STEP}
              disabled={trackLocked}
              className={numInput}
              value={clip.position_y ?? 0}
              onChange={(e) => onTransformChange({ position_y: Number(e.target.value) })}
            />
          </label>
          <label className={row}>
            <span className="text-text-secondary">Scale</span>
            <Input
              type="number"
              step={0.05}
              min={0}
              disabled={trackLocked}
              className={numInput}
              value={clip.scale ?? 1}
              // D-193 — always resets to simple uniform mode: an independent
              // Width/Height override (below) is explicitly CLEARED, not
              // left stale, so this field stays a real "go back to plain
              // scale" affordance rather than one that silently does
              // nothing once an override exists.
              onChange={(e) => onTransformChange({ scale: Number(e.target.value), box_width: null, box_height: null })}
            />
          </label>

          {/* D-193 — independent Width/Height, in pixels of the project's
              own known composition (`geometry`), with a ratio-lock toggle.
              See this file's own module doc for the full "why" this exists
              alongside `Scale` rather than replacing it. */}
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

          <label className={row}>
            <span className="text-text-secondary">Rotation</span>
            <Input
              type="number"
              step={1}
              disabled={trackLocked}
              className={numInput}
              value={clip.rotation ?? 0}
              onChange={(e) => onTransformChange({ rotation: Number(e.target.value) })}
            />
          </label>
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
            surface for no real gain at this size. */}
        <InspectorSection label="Crop">
          {CROP_FIELDS.map(({ key, label }) => (
            <label className={row} key={key}>
              <span className="text-text-secondary">{label}</span>
              <Input
                type="number"
                step={CROP_STEP}
                min={0}
                max={1}
                disabled={trackLocked}
                className={numInput}
                value={clip[key] ?? 0}
                onChange={(e) => onTransformChange({ [key]: Number(e.target.value) })}
              />
            </label>
          ))}
        </InspectorSection>

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
            of `app/src/utils/maskKeyframes.ts`. */}
        <InspectorSection label="Keyframes">
          <div className="flex items-center gap-2 text-[11px] text-text-secondary select-none">
            <Button
              variant="ghost"
              size="xs"
              disabled={trackLocked}
              className={`gap-1 px-1.5 ${keyedHere ? 'text-accent' : 'text-text-primary'}`}
              onClick={onUpsertKeyframe}
              title={keyedHere ? 'Update this clip keyframe' : 'Keyframe this clip at the current frame'}
            >
              <Diamond size={11} fill={keyedHere ? 'currentColor' : 'none'} />
              {clipKeyframes.length === 0 ? 'Keyframe clip' : keyedHere ? 'Update key' : 'Add key'}
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
                    title="Delete the keyframe at this frame"
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
