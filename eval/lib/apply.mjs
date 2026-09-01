// apply.mjs — an APPROXIMATE primary-grade operator for the offline scorer.
//
// ⚠ NOT RapidRAW's pipeline. The real grade runs in WGSL in the engine and is
// not portable here. This models the *primary balance* subset the grading agent
// works in (exposure / contrast / temperature / tint / saturation / black &
// white points / highlights / shadows) with simple, monotone, well-behaved
// pixel ops. Its job is to let `eval/score.mjs` turn a hand- or agent-authored
// grade.json into a scoped result frame OFFLINE so the harness is CI-able.
//
// Consequences (documented in eval/README.md + docs/notes/eval-harness.md):
//  - Absolute scores are only meaningful RELATIVE to each other and to the
//    committed baseline (all computed with the same operator).
//  - The closed-loop runbook (eval/run.md) is the check against the real engine:
//    the app renders, `inspect_color` measures, `score.mjs` scores that real PNG.
//  - A grade.json that leans on curves / wheels / LUT / HSL will be UNDER-applied
//    here (those knobs are ignored). Tasks are authored to be solvable with
//    primary knobs, matching how `match_to_reference` (D-026) works.
//
// Knob ranges mirror the app sliders: exposure in stops (~-5..5); temperature,
// tint, contrast, saturation, blacks, whites, highlights, shadows in -100..100.

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const REC709 = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// Approximate scalars. `temperature` / `tint` are the inverse of the engine's
// WB-picker slope near mid-grey (~0.49 temp-units/code, ~1.56 tint-units/code —
// see docs/notes/match-reference.md), i.e. ~2.0 code/temp-unit is too hot; we
// use a gentler perceptual value and keep it consistent across the harness.
const K_TEMP = 0.5;   // code shift per temperature unit (R up, B down)
const K_TINT = 0.28;  // code shift per tint unit (G vs R/B)
const K_LEVEL = 0.9;  // code shift per blacks/whites unit at the rail

/** Apply the primary subset of a RapidRAW `adjustments` object to one RGB triplet. */
function gradePixel(r, g, b, a) {
  // exposure (stops)
  if (a.exposure) {
    const m = Math.pow(2, a.exposure);
    r *= m; g *= m; b *= m;
  }
  // temperature / tint (white balance)
  if (a.temperature) { r += a.temperature * K_TEMP; b -= a.temperature * K_TEMP; }
  if (a.tint) { g += a.tint * K_TINT; r -= a.tint * K_TINT * 0.5; b -= a.tint * K_TINT * 0.5; }
  // contrast — pivot on mid-grey
  if (a.contrast) {
    const k = 1 + a.contrast / 100;
    r = (r - 128) * k + 128; g = (g - 128) * k + 128; b = (b - 128) * k + 128;
  }
  // blacks / whites — move the endpoints, weighted toward that rail
  if (a.blacks) {
    const w = (v) => v + a.blacks * K_LEVEL * (1 - Math.min(1, v / 255));
    r = w(r); g = w(g); b = w(b);
  }
  if (a.whites) {
    const w = (v) => v + a.whites * K_LEVEL * Math.min(1, v / 255);
    r = w(r); g = w(g); b = w(b);
  }
  // shadows / highlights — tone-region lifts
  if (a.shadows) {
    const w = (v) => v + a.shadows * 0.45 * Math.max(0, 1 - v / 160);
    r = w(r); g = w(g); b = w(b);
  }
  if (a.highlights) {
    const w = (v) => v + a.highlights * 0.45 * Math.max(0, (v - 96) / 159);
    r = w(r); g = w(g); b = w(b);
  }
  // saturation / vibrance (vibrance treated as a gentler saturation)
  const satAmt = (a.saturation || 0) + 0.5 * (a.vibrance || 0);
  if (satAmt) {
    const k = 1 + satAmt / 100;
    const y = REC709(r, g, b);
    r = y + (r - y) * k; g = y + (g - y) * k; b = y + (b - y) * k;
  }
  return [r, g, b];
}

/** Sum of |value| over the primary knobs this operator understands. */
export const PRIMARY_KNOBS = [
  'exposure', 'contrast', 'temperature', 'tint', 'saturation', 'vibrance',
  'blacks', 'whites', 'shadows', 'highlights',
];
export function knobEffort(adj) {
  if (!adj) return 0;
  // exposure is in stops; scale it into slider-ish units (x20) so 0.5 EV ~ 10.
  let s = 0;
  for (const k of PRIMARY_KNOBS) {
    const v = Math.abs(adj[k] || 0);
    s += k === 'exposure' ? v * 20 : v;
  }
  return Math.round(s * 100) / 100;
}

/**
 * Elliptical soft mask weight for a radial sub-mask.
 * geom in the frame's pixel space: {cx,cy,rx,ry,feather} (feather 0..100 %).
 */
function radialWeight(x, y, geom) {
  const dx = (x - geom.cx) / Math.max(1, geom.rx);
  const dy = (y - geom.cy) / Math.max(1, geom.ry);
  const d = Math.sqrt(dx * dx + dy * dy);
  const f = Math.max(0.001, (geom.feather ?? 50) / 100);
  if (d <= 1 - f) return 1;
  if (d >= 1) return 0;
  return (1 - d) / f;
}

/** Rectangular hard mask weight. rect in frame px: [x,y,w,h]. */
function rectWeight(x, y, rect) {
  return x >= rect[0] && x < rect[0] + rect[2] && y >= rect[1] && y < rect[1] + rect[3] ? 1 : 0;
}

/**
 * applyGrade(img, grade, opts) -> new {width,height,data}
 *
 * - Applies grade.adjustments (primary subset) globally.
 * - Then, for each mask container in grade.adjustments.masks with a supported
 *   sub-mask, applies that container's adjustments weighted by the mask.
 *   Supported sub-mask types: 'radial' (centerX/centerY/radiusX/radiusY[/feather])
 *   and 'brush'/'ai-subject' ONLY when opts.maskRects[subMaskId] gives a rect
 *   (from the task file) — offline we can't rasterise a SAM matte.
 * - Mask geometry is in the grade's shot pixel space; we scale by
 *   (frameW / grade.shot.width) so a grade authored at 1080p lands on a 480p
 *   fixture.
 */
export function applyGrade(img, grade, opts = {}) {
  const { width, height, data } = img;
  const out = new Uint8ClampedArray(data.length);
  const adj = grade.adjustments || {};
  const shotW = grade?.shot?.width || width;
  const sc = width / shotW;

  const masks = [];
  for (const c of adj.masks || []) {
    if (c.visible === false) continue;
    const cadj = c.adjustments || {};
    for (const sm of c.subMasks || []) {
      if (sm.visible === false) continue;
      const p = sm.parameters || {};
      const type = sm.type;
      if (type === 'radial' && p.centerX != null) {
        masks.push({
          adj: cadj, invert: !!c.invert || !!sm.invert,
          geom: {
            cx: p.centerX * sc, cy: p.centerY * sc,
            rx: p.radiusX * sc, ry: p.radiusY * sc, feather: p.feather ?? 50,
          },
          kind: 'radial',
        });
      } else if (opts.maskRects && opts.maskRects[sm.id]) {
        const r = opts.maskRects[sm.id].map((v, i) => v * sc);
        masks.push({ adj: cadj, invert: !!c.invert || !!sm.invert, rect: r, kind: 'rect' });
      }
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let [r, g, b] = gradePixel(data[i], data[i + 1], data[i + 2], adj);
      for (const m of masks) {
        let w = m.kind === 'radial' ? radialWeight(x, y, m.geom) : rectWeight(x, y, m.rect);
        if (m.invert) w = 1 - w;
        if (w <= 0) continue;
        const [mr, mg, mb] = gradePixel(r, g, b, m.adj);
        r = r + (mr - r) * w; g = g + (mg - g) * w; b = b + (mb - b) * w;
      }
      out[i] = clamp255(r); out[i + 1] = clamp255(g); out[i + 2] = clamp255(b); out[i + 3] = 255;
    }
  }
  return { width, height, data: out };
}
