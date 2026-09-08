/**
 * @chroma/editor — the Inspector's **Adjustment** section: an adjustment
 * clip's five-parameter primary correction (D-229,
 * `docs/notes/adjustment-clips.md`).
 *
 * **Its own component, rendered ABOVE `EditorInspectorPanel`**, exactly as
 * `TextClipInspectorPanel` is and for the same reasons: these are a different
 * form from a clip's geometry, they write a different op
 * (`set_adjustment_clip`), and they are only ever relevant for one kind of
 * clip. Stacking the panels is also what keeps the shared half genuinely
 * shared — an adjustment clip's Opacity row is the EXISTING D-208 row
 * underneath, not a copy of it.
 *
 * Renders `null` for anything that is not exactly one selected adjustment clip,
 * so `EditorTab` can mount it unconditionally.
 *
 * **The reference this is built from** is Resolve's own Inspector with an
 * adjustment clip selected (`scratch/resolve-reference/adjustments.jpg`): the
 * selected adjustment clip shows its *effect's* parameters as a plain list of
 * labelled sliders with a numeric readout and a per-parameter reset, rather
 * than the clip-geometry form a media clip gets. That is the layout here —
 * slider + number + reset per row, and a reset-all for the section.
 *
 * **What the sliders do NOT include, deliberately:** an adjustment clip's
 * `opacity` is its correction's *mix* amount, and it is edited in the Transform
 * panel below like any other clip's opacity, not duplicated here — one field,
 * one place. It is static-only for an adjustment clip (see
 * `Clip.adjustment`'s own doc: ffmpeg fixes these filter coefficients at init,
 * so a keyframed mix is not expressible in the export), which the note at the
 * bottom of this section states outright rather than leaving the keyframe
 * diamond below to imply otherwise.
 *
 * Every write goes through the same `set_adjustment_clip` op and the same
 * `newAdjustmentLayer` validator the MCP `editor_set_adjustment_clip` tool
 * uses — one op and one validator under both interfaces, per CLAUDE.md.
 */
import { useState } from 'react';
import { Button, Input } from '@chroma/ui';
import { InspectorSection } from '@chroma/inspector';
import { RotateCcw } from 'lucide-react';

import {
  ADJUSTMENT_PARAMS,
  findClip,
  isIdentityAdjustment,
  newAdjustmentLayer,
  type AdjustmentLayer,
} from './timeline';
import { useEditorTimelineStore } from './timelineStore';

/** Row labels + the hint each control needs to be self-explanatory. Kept
 *  beside the panel rather than in the model: these are UI copy, and the model
 *  already documents the semantics for the MCP surface. */
const PARAM_LABELS: Record<keyof AdjustmentLayer, { label: string; hint: string }> = {
  exposure: { label: 'Exposure', hint: 'stops — a gain of 2^value' },
  contrast: { label: 'Contrast', hint: 'about the mid-grey pivot' },
  saturation: { label: 'Saturation', hint: '-1 is greyscale, +1 is double' },
  temperature: { label: 'Temperature', hint: '+ warmer (red), - cooler (blue)' },
  tint: { label: 'Tint', hint: '+ magenta, - green' },
};

/** Every parameter shares one range and one step — they are all normalised
 *  `-1..1` in the model, and giving them a common feel is the point. */
const MIN = -1;
const MAX = 1;
const STEP = 0.01;

const row = 'flex items-center justify-between gap-2';

export function AdjustmentClipInspectorPanel() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const selection = useEditorTimelineStore((s) => s.selection);
  const applyOp = useEditorTimelineStore((s) => s.applyOp);
  const [error, setError] = useState<string | null>(null);

  // Same Phase 1 multi-select fallback every single-clip-only consumer uses
  // (`docs/notes/multi-select.md`): a selection that isn't exactly one clip
  // shows nothing.
  const primary = selection.length === 1 ? selection[0] : null;
  const found = primary ? findClip(timeline, primary.track, primary.id) : null;
  const clip = found?.clip ?? null;
  const layer = clip?.adjustment ?? null;
  const clipIndex = found?.index ?? -1;
  const trackLocked = primary ? !!timeline?.tracks[primary.track]?.locked : false;

  if (!primary || !clip || !layer || clipIndex < 0) return null;

  const patch = (p: Partial<AdjustmentLayer>) => {
    // Validated here with the SAME validator the MCP op uses, so a human gets
    // the identical message an agent would.
    const merged = newAdjustmentLayer(p, layer);
    if ('error' in merged) {
      setError(merged.error);
      return;
    }
    setError(null);
    applyOp({ kind: 'set_adjustment_clip', track: primary.track, clip: clipIndex, patch: p });
  };

  const neutral = isIdentityAdjustment(layer);

  return (
    <div className="shrink-0 border-b border-border-color p-3">
      <InspectorSection label="Adjustment">
        <div className="flex flex-col gap-2 text-xs">
          {ADJUSTMENT_PARAMS.map((key) => {
            const value = Number.isFinite(layer[key]) ? layer[key] : 0;
            const { label, hint } = PARAM_LABELS[key];
            return (
              <div key={key} className="flex flex-col gap-1">
                <div className={row}>
                  <span className="text-text-secondary" title={hint}>
                    {label}
                  </span>
                  <span className="flex items-center gap-1">
                    <Input
                      type="number"
                      step={STEP}
                      min={MIN}
                      max={MAX}
                      disabled={trackLocked}
                      className="h-7 w-20 text-right"
                      value={Number(value.toFixed(3))}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (!Number.isFinite(v)) return;
                        patch({ [key]: v } as Partial<AdjustmentLayer>);
                      }}
                    />
                    {/* Per-parameter reset, mirroring the D-208 transform
                        rows' own affordance — disabled when already at
                        identity so it never looks like it would do
                        something. */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      aria-label={`Reset ${label.toLowerCase()}`}
                      disabled={trackLocked || value === 0}
                      onClick={() => patch({ [key]: 0 } as Partial<AdjustmentLayer>)}
                    >
                      <RotateCcw className="size-3" />
                    </Button>
                  </span>
                </div>
                {/* The slider is the primary control (this is a look, judged by
                    eye — a number box alone makes it a typing exercise); the
                    number box beside it is the exact one. Both write the same
                    field through the same `patch`, so neither is a second
                    source of truth. */}
                <input
                  type="range"
                  aria-label={label}
                  min={MIN}
                  max={MAX}
                  step={STEP}
                  disabled={trackLocked}
                  value={value}
                  className="h-1 w-full accent-accent"
                  onChange={(e) => patch({ [key]: Number(e.target.value) } as Partial<AdjustmentLayer>)}
                />
              </div>
            );
          })}

          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-text-secondary/60 text-[10px]">
              {neutral ? 'Neutral — affects nothing yet' : 'Applies to every clip beneath this one'}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[11px]"
              disabled={trackLocked || neutral}
              onClick={() =>
                patch({ exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0 })
              }
            >
              Reset all
            </Button>
          </div>

          {error && <p className="text-[10px] leading-snug text-red-400">{error}</p>}

          {/* Stated, not implied. The Transform panel below shows this clip's
              Opacity row with a keyframe diamond like any other clip's, but a
              keyframed mix is not expressible in the export (ffmpeg fixes
              `lutrgb`/`colorchannelmixer` coefficients at filter init), so
              both renderers read `opacity` statically here. Saying so is the
              same disclosure discipline `TextClipInspectorPanel` uses for its
              own Phase 1 gap. */}
          <p className="text-text-secondary/60 pt-1 text-[10px] leading-snug">
            Opacity (in Transform, below) sets how strongly this correction is mixed in. It is read
            statically for an adjustment clip — keyframing it, or a fade, will not animate the
            correction in either the preview or the export. Position, scale, rotation and crop do not
            apply: the correction is always full-frame.
          </p>
        </div>
      </InspectorSection>
    </div>
  );
}
