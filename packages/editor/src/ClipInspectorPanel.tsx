/**
 * @chroma/editor — the Inspector, NLE half (D-102, Phase 3 of
 * `docs/notes/global-inspector.md`).
 *
 * A real, persistent property panel for the selected clip's compositing
 * transform (opacity/position/scale/rotation) and keyframes — the same
 * fields, the same ops (`set_clip_transform`/`set_clip_keyframes`), and the
 * same keyframe CRUD (`clipKeyframes.ts`, itself mirroring `RelightPanel.
 * tsx`'s pattern) the D-090 popover this replaces already used. This is a
 * pure presentation swap, not new editing logic: `TimelinePane.tsx` still
 * owns `selectedClip`/`applyTransform`/`doUpsertKeyframe`/etc. exactly as
 * D-089/D-090 built them — this component only renders them, as a
 * persistent side panel instead of a click-to-open `Popover`, matching
 * `@chroma/motion`'s `InspectorPanel.tsx` (D-099, Phase 2) UX for the
 * "Global Inspector" framing's other half.
 *
 * D-090's popover is REMOVED as of this pass, not kept alongside this panel
 * — same field set, same ops, a persistent panel is strictly better UX for
 * exactly the kind of "nudge a value, watch the preview" iteration this
 * editor supports, and having both would mean two controls that can edit
 * the same clip out of sync with each other for no real benefit. `Selection`
 * itself stays local to `TimelinePane.tsx` for this pass (not lifted to a
 * shared store/prop-drilled up to `Shell.tsx`).
 *
 * D-103 (Phase 4): the empty-state message and section-heading styling now
 * come from `@chroma/inspector` (a tiny shared package with no `@chroma/ui`
 * dependency — see its README), the same components `@chroma/motion`'s
 * `InspectorPanel.tsx` uses. The field layout (`row`/`numInput` below) stays
 * local and different from Motion's — this panel's side-by-side label/input
 * rows were built for a narrower panel with only numeric fields, Motion's
 * stacked label-above-input rows were built for a wider panel with
 * selects/colour-pickers too; forcing one shape onto the other would mean
 * rewriting a working, tested layout for no real benefit, exactly the
 * "don't force a deeper unification than is actually clean" call
 * `@chroma/inspector`'s README documents. `Selection` staying local (not
 * lifted to a shared, tab-agnostic store) is the other real Phase 4 call —
 * `Shell.tsx` already keeps every tab mounted and simply hides inactive
 * ones, so a per-tab-local Inspector already behaves exactly like a
 * cross-tab shared one from the user's side; there was no real gap lifting
 * state would have closed, so it wasn't built.
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
}>;

const row = 'flex items-center justify-between gap-2';
const numInput = 'h-7 w-20 text-right';

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
              step={1}
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
              step={1}
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
