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
 */
import { Diamond, X } from 'lucide-react';
import { Button, Input } from '@chroma/ui';
import { InspectorEmptyState, InspectorSection } from '@chroma/inspector';
import type { Clip } from './timeline';
import type { ClipKeyframe } from './clipKeyframes';

export type TransformPatch = Partial<{
  opacity: number;
  position_x: number;
  position_y: number;
  scale: number;
  rotation: number;
  crop_left: number;
  crop_top: number;
  crop_right: number;
  crop_bottom: number;
}>;

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
  clipKeyframes,
  keyedHere,
  onTransformChange,
  onUpsertKeyframe,
  onRemoveKeyframeHere,
  onClearKeyframes,
}: {
  clip: Clip | null;
  trackLocked: boolean;
  clipKeyframes: ClipKeyframe[];
  keyedHere: boolean;
  onTransformChange: (patch: TransformPatch) => void;
  onUpsertKeyframe: () => void;
  onRemoveKeyframeHere: () => void;
  onClearKeyframes: () => void;
}) {
  if (!clip) {
    return <InspectorEmptyState>Select a clip to edit its properties.</InspectorEmptyState>;
  }

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
              onChange={(e) => onTransformChange({ scale: Number(e.target.value) })}
            />
          </label>
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
