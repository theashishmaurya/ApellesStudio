/**
 * @apelles/editor — the adjustment clip's one-line summary (D-230).
 *
 * **What it is:** `adjustmentSummary`, the label an adjustment clip's body
 * shows in the timeline (`ClipBlock.tsx`).
 *
 * **What it does NOT do:** resolve or apply the correction. The operator is
 * `apelles_types::adjustment` (Rust), applied by the one GPU engine in the
 * preview and the export alike (D-448/D-449). This file used to mirror that
 * maths in TypeScript and emit the ffmpeg `lutrgb` / `colorchannelmixer`
 * nodes the filter-graph export ran; that export was deleted by D-448 and the
 * mirror with it (roadmap 00r 5d (d)).
 */

import type { AdjustmentLayer } from './timeline';
import { ADJUSTMENT_PARAMS } from './timeline';

const PARAM_ABBREV: Record<keyof AdjustmentLayer, string> = {
  exposure: 'EXP',
  contrast: 'CON',
  saturation: 'SAT',
  temperature: 'TMP',
  tint: 'TNT',
};

/**
 * A one-line summary of what a correction actually does — e.g. `EXP +0.3 · SAT
 * -0.5`, or `neutral` when nothing is set.
 *
 * Shown on the clip body in the timeline so an adjustment clip says what it
 * does at a glance, the way Resolve's own body shows the name of the effect it
 * carries. Non-zero parameters only, in `ADJUSTMENT_PARAMS` order, capped to
 * the first three so a short clip's label never overflows its own body.
 */
export function adjustmentSummary(layer: AdjustmentLayer): string {
  const parts = ADJUSTMENT_PARAMS.filter((k) => Number.isFinite(layer[k]) && layer[k] !== 0).map(
    (k) => `${PARAM_ABBREV[k]} ${layer[k] > 0 ? '+' : ''}${layer[k].toFixed(2)}`,
  );
  if (parts.length === 0) return 'neutral';
  return parts.length > 3 ? `${parts.slice(0, 3).join(' · ')} +${parts.length - 3}` : parts.join(' · ');
}
