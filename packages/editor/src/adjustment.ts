/**
 * @apelles/editor — the adjustment-clip colour operator (D-230).
 *
 * **What it is:** the TypeScript mirror of `apelles_types::adjustment` — it
 * turns a `Clip.adjustment`'s five parameters into the same two-stage operator
 * the Rust live-preview compositor applies, and then into the two ffmpeg filter
 * nodes that run it in the export.
 *
 * **What it does NOT do:** it does not know what a clip, a track or a timeline
 * is, does not emit labels, and does not decide *where* in a filtergraph the
 * nodes go (`timelineExport.ts` owns that, at the clip's own z-position). It is
 * pure maths plus one string builder.
 *
 * **Why the maths is duplicated here at all.** It is the same reason
 * `keyframeExprAt` re-implements `resolve_clip_transform`'s interpolation:
 * export happens outside the Rust engine entirely, in ffmpeg, so the
 * coefficients have to be computed in TypeScript. What keeps the two from
 * drifting is not hope — it is that both sides are pinned to the *same measured
 * ffmpeg output* by tests on both sides (`apelles_types`'
 * `matches_real_ffmpeg_output_within_one_code_value` and this package's own
 * real-ffmpeg pixel suite), so a change to one that is not mirrored in the
 * other fails a test rather than shipping as a silent preview/export
 * divergence — the B-090/B-095/B-098 failure mode.
 *
 * ## The two stages, and why the split is exactly this
 *
 * 1. **per-channel affine** (exposure × white balance × contrast pivot) →
 *    `lutrgb`, whose expressions have **no coefficient limit** and which is a
 *    256-entry LUT built once at filter init, not per-pixel work.
 * 2. **saturation matrix** (Rec.709) → `colorchannelmixer`, a real SIMD 3×3
 *    matrix filter whose coefficients ffmpeg caps at ±2 — a cap this stage
 *    provably never reaches (max 1.928).
 *
 * Folding all three conceptual steps into ONE `colorchannelmixer` was tried
 * first and rejected: the folded matrix breaches that ±2 cap at ordinary
 * settings (contrast 0.6 + saturation 0.8 already clamps, crushing mid-grey).
 * `geq` would run the whole operator verbatim with no cap at all, and was
 * rejected on measurement: **~39× slower** (76.9 s vs 1.95 s for 6 s of
 * 1080p30). See D-230.
 */

import type { AdjustmentLayer } from './timeline';
import { ADJUSTMENT_PARAMS, isIdentityAdjustment } from './timeline';

/** Rec.709 luma weights — must match `apelles_types::adjustment`'s constants. */
export const LUMA_R = 0.2126;
export const LUMA_G = 0.7152;
export const LUMA_B = 0.0722;

/** How far `temperature`/`tint` at full deflection push their channels —
 *  must match the Rust `WB_STRENGTH`. */
const WB_STRENGTH = 0.3;

/** The resolved operator: stage 1 `clamp01(gain[c]·v + offset)`, then stage 2
 *  `clamp01(sat · v)`. Mirrors `apelles_types::adjustment::AdjustmentOps`. */
export interface AdjustmentOps {
  /** Stage 1's per-channel multiplier, R/G/B. */
  gain: [number, number, number];
  /** Stage 1's uniform offset, in normalised `0..1` units. `lutrgb` works in
   *  8-bit code values, so the filter builder scales this by 255. */
  offset: number;
  /** Stage 2's matrix, row-major `sat[outChannel][inChannel]` — the same
   *  convention as `colorchannelmixer`'s `rr`/`rg`/`rb` naming, so the mapping
   *  below is a direct transcription with no transpose to get wrong. */
  sat: [[number, number, number], [number, number, number], [number, number, number]];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Clamp a stored parameter to its documented range, degrading a non-finite
 *  value to identity — mirrors `AdjustmentLayer::normalised`. */
function normalised(layer: AdjustmentLayer): AdjustmentLayer {
  const f = (v: number) => (Number.isFinite(v) ? clamp(v, -1, 1) : 0);
  return {
    exposure: f(layer.exposure),
    contrast: f(layer.contrast),
    saturation: f(layer.saturation),
    temperature: f(layer.temperature),
    tint: f(layer.tint),
  };
}

/**
 * Build the operator for `layer`, mixed `mix` of the way from identity.
 * Exact mirror of `AdjustmentOps::build` — including that the mix is applied
 * **per stage**, toward each stage's own identity, so the result stays
 * expressible as the same two filter nodes at every mix value.
 */
export function buildAdjustmentOps(layer: AdjustmentLayer, mix: number): AdjustmentOps {
  const a = normalised(layer);
  const m = Number.isFinite(mix) ? clamp(mix, 0, 1) : 1;

  const ge = Math.pow(2, a.exposure);
  const c = 1 + a.contrast;
  const fullGain = [
    c * ge * (1 + WB_STRENGTH * a.temperature),
    c * ge * (1 - WB_STRENGTH * a.tint),
    c * ge * (1 - WB_STRENGTH * a.temperature),
  ];
  const gain = fullGain.map((g) => 1 + (g - 1) * m) as [number, number, number];
  const offset = 0.5 * (1 - c) * m;

  const s = 1 + a.saturation;
  const w = [LUMA_R, LUMA_G, LUMA_B];
  const sat = [0, 1, 2].map((i) =>
    [0, 1, 2].map((j) => {
      const ident = i === j ? 1 : 0;
      const full = s * ident + (1 - s) * w[j];
      return ident * (1 - m) + full * m;
    }),
  ) as AdjustmentOps['sat'];

  return { gain, offset, sat };
}

/** Whether the operator provably leaves every pixel alone. */
export function isIdentityOps(ops: AdjustmentOps): boolean {
  return (
    ops.offset === 0 &&
    ops.gain.every((g) => g === 1) &&
    ops.sat.every((row, i) => row.every((v, j) => v === (i === j ? 1 : 0)))
  );
}

/**
 * The resolved operator for a clip's adjustment, or `null` when it is not an
 * adjustment clip or its correction provably does nothing.
 *
 * **`opacity` is read statically** — no keyframe lookup, no fade — mirroring
 * `Clip::adjustment_ops` in Rust, for the reason that function documents:
 * ffmpeg fixes these coefficients at filter init, so a time-varying mix is not
 * expressible in the export, and a preview that animated it would be a
 * guaranteed divergence.
 */
export function clipAdjustmentOps(clip: {
  adjustment?: AdjustmentLayer | null;
  opacity?: number;
}): AdjustmentOps | null {
  const layer = clip.adjustment;
  if (!layer || isIdentityAdjustment(layer)) return null;
  const raw = clip.opacity ?? 1;
  const mix = Number.isFinite(raw) ? clamp(raw, 0, 1) : 1;
  const ops = buildAdjustmentOps(layer, mix);
  return isIdentityOps(ops) ? null : ops;
}

/** Short labels for the five parameters, for anywhere a correction has to be
 *  described in a few characters (the clip body on the timeline). */
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

/** Format a coefficient for a filtergraph — fixed precision so the emitted
 *  argv is stable and diffable across runs, and never exponential notation
 *  (`1e-7`), which ffmpeg's option parser does not accept. */
function coeff(v: number): string {
  return v.toFixed(6);
}

/**
 * The two filter nodes that run `ops` on the stream at `inLabel`, writing
 * `outLabel` — spliced into the overlay chain at exactly the position the
 * adjustment clip's own `overlay` would have occupied, which is what makes
 * "applies to everything beneath it" fall out of z-order with no extra rule
 * (the same trick D-213's `drawtext` uses).
 *
 * **`format=rgba` is not optional and not cosmetic.** Verified against real
 * ffmpeg (D-230): without it the graph can settle on a format with no alpha
 * plane, and `colorchannelmixer` then silently drops the whole stage — the
 * filter still runs, still reports success, and simply does less than it says.
 * That is precisely the invisible-failure shape of B-090/B-095, so the format
 * is pinned here rather than left to negotiation. (This stage's own offset now
 * rides on `lutrgb` rather than the alpha channel, but the format pin stays:
 * both filters are RGB-domain, and pinning it once here is what stops ffmpeg
 * inserting a YUV round-trip between them.)
 *
 * `enable='between(t,…)'` gates both nodes to the clip's own timeline window —
 * both filters support ffmpeg's timeline API (checked, not assumed).
 */
export function buildAdjustmentSteps(
  ops: AdjustmentOps,
  inLabel: string,
  outLabel: string,
  startSec: number,
  endSec: number,
): string[] {
  const gate = `enable='between(t,${startSec},${endSec})'`;
  const off = coeff(ops.offset * 255);
  // `clip(...)` inside the expression, not just ffmpeg's own output clamp, so
  // the LUT is defined over the whole 0..255 domain even at extreme gains.
  const lutExpr = (i: number) => `'clip(val*${coeff(ops.gain[i])}+${off},0,255)'`;
  const mid = `${outLabel}_adj`;
  const [r, g, b] = ops.sat;
  return [
    `[${inLabel}]format=rgba,lutrgb=r=${lutExpr(0)}:g=${lutExpr(1)}:b=${lutExpr(2)}:${gate}[${mid}]`,
    `[${mid}]colorchannelmixer=` +
      `rr=${coeff(r[0])}:rg=${coeff(r[1])}:rb=${coeff(r[2])}:` +
      `gr=${coeff(g[0])}:gg=${coeff(g[1])}:gb=${coeff(g[2])}:` +
      `br=${coeff(b[0])}:bg=${coeff(b[1])}:bb=${coeff(b[2])}:${gate}[${outLabel}]`,
  ];
}
