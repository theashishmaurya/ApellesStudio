/**
 * @apelles/editor — a clip's input scaling: how its source picture is sized
 * into the timeline frame (D-425, B-325).
 *
 * **What it is.** The per-clip "input scaling" choice every NLE has — DaVinci
 * Resolve's *Image Scaling → Input Scaling* (project default, overridable per
 * clip under *Retime and Scaling*) and Premiere's *Set to Frame Size* / *Scale
 * to Frame Size* — and the one pure function, {@link fittedFootprint}, that
 * turns a source size and a frame size into the clip's footprint at
 * `scale == 1`. An exact mirror of `apelles_timeline::scaling`; the vectors in
 * both test modules are the same.
 *
 * **What it does.** `Clip.scale` has always been a multiplier of the clip's own
 * footprint (D-353). This decides that footprint: `fit` (whole picture,
 * letterboxed — the default for a newly placed clip), `fill` (frame covered,
 * overflow cropped) or `native` (source pixels 1:1, the only behaviour before
 * D-425 — and therefore what a clip with NO `scaling` key means, so a saved
 * project does not change look). Resolve's fourth mode, *Stretch*, is the
 * existing `box_width = box_height = 1` override.
 *
 * **What it does NOT do.** No I/O (the caller supplies the source size), no
 * crop awareness (the footprint is that of the uncropped source — `scale`'s
 * width has never depended on crop).
 */

/** A clip's input-scaling mode. */
export type ClipScaling = 'fit' | 'fill' | 'native';

/** Every mode, in the order the Inspector and the MCP schema list them. */
export const CLIP_SCALING_MODES: readonly ClipScaling[] = ['fit', 'fill', 'native'];

/** What a timeline uses for new clips when it has not chosen one (Resolve's
 *  default). */
export const TIMELINE_DEFAULT_SCALING: ClipScaling = 'fit';

/** What a clip with NO `scaling` key means — the pre-D-425 behaviour. */
export const LEGACY_CLIP_SCALING: ClipScaling = 'native';

/** Human labels for the Inspector and timeline settings (Resolve's wording). */
export const CLIP_SCALING_LABELS: Record<ClipScaling, string> = {
  fit: 'Fit to frame',
  fill: 'Fill frame (crop)',
  native: 'Native size',
};

/** Narrow an untrusted value (an MCP argument, a persisted file) to a mode. */
export function parseClipScaling(v: unknown): ClipScaling | null {
  return typeof v === 'string' && (CLIP_SCALING_MODES as readonly string[]).includes(v) ? (v as ClipScaling) : null;
}

/** The mode a clip renders with: its own, else the legacy `native`. */
export function effectiveClipScaling(clip: { scaling?: ClipScaling | null }): ClipScaling {
  return clip.scaling ?? LEGACY_CLIP_SCALING;
}

/** The clip's footprint at `scale == 1`, in the units of `frame`.
 *
 *  The binding axis of `fit`/`fill` is returned as exactly the frame's own
 *  extent (not `source * (frame / source)`, which can be one ulp off), so a
 *  source with the frame's aspect maps to precisely the frame. A non-positive
 *  edge has nothing to fit: the source is returned unchanged. */
export function fittedFootprint(
  mode: ClipScaling,
  source: { width: number; height: number },
  frame: { width: number; height: number },
): { width: number; height: number } {
  const { width: sw, height: sh } = source;
  const { width: fw, height: fh } = frame;
  if (mode === 'native' || !(sw > 0 && sh > 0 && fw > 0 && fh > 0)) return { width: sw, height: sh };
  // Cross-multiplied comparison of fw/sw and fh/sh: exact for integers.
  const widthIsTighter = fw * sh <= fh * sw;
  const bindWidth = mode === 'fit' ? widthIsTighter : !widthIsTighter;
  return bindWidth ? { width: fw, height: (sh * fw) / sw } : { width: (sw * fh) / sh, height: fh };
}
