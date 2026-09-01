// _gen.mjs — regenerate the eval fixture frames. One-time / on-demand tool.
// Run:  node eval/fixtures/_gen.mjs
//
// Sources:
//  - scratch/frame_c019_10s.png (3840x2160, C019 talking-head still) — NOT in the
//    repo (scratch/ is gitignored). Downscaled to 480px long edge -> base.png.
//    If it is missing, base.png is left as-is (it is committed) and only the
//    synthetic fixtures are rebuilt.
//  - the rest are synthesised procedurally with a documented baked offset.
//
// Every derived fixture is produced by eval/lib/apply.mjs so "the baked setup
// grade" and "the grade the agent must undo" use the exact same operator.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG, encodePNG, downscale } from '../lib/png.mjs';
import { applyGrade } from '../lib/apply.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '../..');
const W = 480, H = 270;

const wrap = (adjustments) => ({ schema: 'chroma.grade/1', shot: { width: W, height: H }, adjustments });
const save = (name, img) => {
  fs.writeFileSync(path.join(DIR, name), encodePNG(img));
  console.log('  wrote', name, `${img.width}x${img.height}`);
};

/* ------------------------------------------------------------------ base --- */
let base;
const src = path.join(ROOT, 'scratch/frame_c019_10s.png');
if (fs.existsSync(src)) {
  console.log('base <- scratch/frame_c019_10s.png');
  base = downscale(decodePNG(fs.readFileSync(src)), 480);
  // normalise to a clean neutral starting point (mild)
  base = applyGrade(base, wrap({ exposure: 0.0 }));
  save('base.png', base);
} else if (fs.existsSync(path.join(DIR, 'base.png'))) {
  console.log('base <- committed fixtures/base.png (scratch source absent)');
  base = decodePNG(fs.readFileSync(path.join(DIR, 'base.png')));
} else {
  throw new Error('no scratch source and no committed base.png');
}

/* -------------------------------------------------------- synthetic helpers */
function blank(w, h, fill = [128, 128, 128]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = fill[0]; data[i * 4 + 1] = fill[1]; data[i * 4 + 2] = fill[2]; data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}
function forEach(img, fn) {
  const { width, height, data } = img;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const [r, g, b] = fn(x, y, data[i], data[i + 1], data[i + 2]);
    data[i] = r; data[i + 1] = g; data[i + 2] = b;
  }
  return img;
}

/* ============================================================ TASK FIXTURES */

// 1. neutralise_cast — base + a strong warm/green cast baked in.
save('cast.in.png', applyGrade(base, wrap({ temperature: 20, tint: 14 })));

// 2. match_shot_to_ref — a warm/bright "hero" reference and a cool/dark subject.
save('match.ref.png', applyGrade(base, wrap({ temperature: 16, exposure: 0.35, contrast: 8, saturation: 6 })));
save('match.in.png', applyGrade(base, wrap({ temperature: -18, exposure: -0.3, contrast: -6, saturation: -6 })));

// 3. set_black_white_points — a synthetic low-contrast wedge (a "flat log" look):
//    a horizontal luma ramp remapped into 42..196 with vertical dither texture.
{
  const img = blank(W, H);
  forEach(img, (x, y) => {
    const t = x / (W - 1);
    let v = 34 + t * (206 - 34);
    v += ((x * 7 + y * 13) % 9) - 4;            // texture so percentiles aren't degenerate
    v += Math.sin(y / 9) * 2.5;
    const c = Math.round(Math.max(0, Math.min(255, v)));
    return [c, c - 1, c + 1];                    // near-neutral, faint cast
  });
  save('levels.in.png', img);
}

// 4. fix_exposure — base pulled ~1.1 stops under.
save('exposure.in.png', applyGrade(base, wrap({ exposure: -1.1 })));

// 5. dont_overgrade — the base itself (already balanced). setup = "neutral".
save('neutral.in.png', base);

// 6. mask_region_only — a neutral graded background with one bright, warm
//    rectangular patch (a stand-in "face"): only the patch should be corrected.
{
  const img = blank(W, H);
  // background: gentle vertical grey ramp, faintly cool
  forEach(img, (x, y) => {
    const v = 96 + (y / H) * 40 + ((x + y) % 5);
    return [Math.round(v - 2), Math.round(v), Math.round(v + 4)];
  });
  // the patch: rect [160,70,160,130], bright + warm + a touch oversaturated
  const rx = 160, ry = 70, rw = 160, rh = 130;
  forEach(img, (x, y, r, g, b) => {
    if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) {
      return [Math.min(255, r + 78), Math.min(255, g + 44), Math.max(0, b + 6)];
    }
    return [r, g, b];
  });
  save('mask.in.png', img);
}

// 7. tame_highlight_clip — base pushed bright enough to blow some highlights.
save('clip.in.png', applyGrade(base, wrap({ exposure: 0.95, whites: 22 })));

console.log('done.');
