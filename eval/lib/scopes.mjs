// scopes.mjs — STANDALONE PORT of app/src/utils/scopes.ts (computeScopes +
// computeGap) for the offline eval scorer. No engine dependency.
//
// ⚠ SECOND COPY OF THE MATH. The engine's scopes.ts is the ground truth the
// grading agent measures by (D-021). This mirrors its constants exactly:
//   - REC709 luma weights 0.2126 / 0.7152 / 0.0722
//   - downsample stride so the long edge is <= 512 px
//   - zone split: shadows luma < 64, mids 64..191, highs > 191
//   - blackPoint / whitePoint = 1st / 99th percentile luma off a 256-bin hist
//   - clipLowPct / clipHighPct = luma <= 1 / >= 254 ; per-channel clip at ==0 / ==255
//   - hue histogram: 12 bins x 30deg, saturation-weighted, only sat > 0.05
//   - cast.warmCool = mids.R - mids.B ; cast.greenMagenta = mids.G - (mids.R+mids.B)/2
// If scopes.ts changes, update this file and re-run `node eval/score.mjs` to
// re-baseline. Checked in CI by `eval/lib/scopes.check.mjs` (string-compares the
// constants block against scopes.ts).

const REC709 = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function satOf(r, g, b) {
  const max = Math.max(r, g, b);
  if (max <= 0) return 0;
  const min = Math.min(r, g, b);
  return (max - min) / max;
}

function hueOf(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d <= 0) return 0;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

function strideFor(w, h, target = 512) {
  return Math.max(1, Math.ceil(Math.max(w, h) / target));
}

const round2 = (v) => Math.round(v * 100) / 100;

/** computeScopes({width,height,data:RGBA}) -> Scopes (mirror of scopes.ts) */
export function computeScopes(img) {
  const { width, height, data } = img;
  const step = strideFor(width, height);

  const lumaHist = new Float64Array(256);
  let rSum = 0, gSum = 0, bSum = 0;
  let rClipLo = 0, rClipHi = 0, gClipLo = 0, gClipHi = 0, bClipLo = 0, bClipHi = 0;
  let lumaClipLo = 0, lumaClipHi = 0;
  let satSum = 0;
  const z = {
    sh: { r: 0, g: 0, b: 0, n: 0 },
    mi: { r: 0, g: 0, b: 0, n: 0 },
    hi: { r: 0, g: 0, b: 0, n: 0 },
  };
  const hueHist = new Float64Array(12);
  let n = 0;

  for (let y = 0; y < height; y += step) {
    const rowOff = y * width * 4;
    for (let x = 0; x < width; x += step) {
      const i = rowOff + x * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      n++;
      rSum += r; gSum += g; bSum += b;
      if (r === 0) rClipLo++; else if (r === 255) rClipHi++;
      if (g === 0) gClipLo++; else if (g === 255) gClipHi++;
      if (b === 0) bClipLo++; else if (b === 255) bClipHi++;

      const l = REC709(r, g, b);
      const li = l < 0 ? 0 : l > 255 ? 255 : Math.round(l);
      lumaHist[li]++;
      if (li <= 1) lumaClipLo++;
      if (li >= 254) lumaClipHi++;

      const zone = l < 64 ? z.sh : l <= 191 ? z.mi : z.hi;
      zone.r += r; zone.g += g; zone.b += b; zone.n++;

      const s = satOf(r, g, b);
      satSum += s;
      if (s > 0.05) {
        const hb = Math.floor(hueOf(r, g, b) / 30) % 12;
        hueHist[hb] += s;
      }
    }
  }
  if (n === 0) n = 1;

  const pct = (p) => {
    const want = (p / 100) * n;
    let cum = 0;
    for (let v = 0; v < 256; v++) {
      cum += lumaHist[v];
      if (cum >= want) return v;
    }
    return 255;
  };

  const zoneStat = (a) => {
    const c = Math.max(1, a.n);
    const mean = [a.r / c, a.g / c, a.b / c];
    return { meanRGB: mean, luma: REC709(mean[0], mean[1], mean[2]) };
  };

  const shadows = zoneStat(z.sh);
  const mids = zoneStat(z.mi);
  const highs = zoneStat(z.hi);

  const hueSum = hueHist.reduce((s, v) => s + v, 0) || 1;
  const hueHistogram = Array.from(hueHist, (v) => Math.round((v / hueSum) * 1000) / 1000);

  const asPct = (c) => round2((c / n) * 100);

  return {
    blackPoint: pct(1),
    whitePoint: pct(99),
    clipLowPct: asPct(lumaClipLo),
    clipHighPct: asPct(lumaClipHi),
    clip: {
      r: { lo: asPct(rClipLo), hi: asPct(rClipHi) },
      g: { lo: asPct(gClipLo), hi: asPct(gClipHi) },
      b: { lo: asPct(bClipLo), hi: asPct(bClipHi) },
    },
    meanRGB: [round2(rSum / n), round2(gSum / n), round2(bSum / n)],
    zones: {
      shadows: { meanRGB: shadows.meanRGB.map(round2), luma: round2(shadows.luma) },
      mids: { meanRGB: mids.meanRGB.map(round2), luma: round2(mids.luma) },
      highs: { meanRGB: highs.meanRGB.map(round2), luma: round2(highs.luma) },
    },
    cast: {
      warmCool: round2(mids.meanRGB[0] - mids.meanRGB[2]),
      greenMagenta: round2(mids.meanRGB[1] - (mids.meanRGB[0] + mids.meanRGB[2]) / 2),
    },
    saturation: round2(satSum / n),
    hueHistogram,
    frameSize: [width, height],
    sampled: n,
  };
}

function magOf(abs) {
  if (abs < 2) return 'slight';
  if (abs < 6) return 'moderate';
  return 'strong';
}

/** computeGap(subj, ref) -> GapHint (mirror of scopes.ts) */
export function computeGap(subj, ref) {
  const exposure = ((ref.zones.mids.luma - subj.zones.mids.luma) / 64) * 0.5;
  const tDelta = Math.round((ref.cast.warmCool - subj.cast.warmCool) * 100) / 100;
  const gmDelta = Math.round((ref.cast.greenMagenta - subj.cast.greenMagenta) * 100) / 100;
  const refSpread = ref.whitePoint - ref.blackPoint;
  const subjSpread = subj.whitePoint - subj.blackPoint;
  const spreadDelta = refSpread - subjSpread;
  const satRatio = subj.saturation > 0.001
    ? Math.round((ref.saturation / subj.saturation) * 100) / 100 : 1;

  const tempDir = Math.abs(tDelta) < 1 ? 'ok' : tDelta > 0 ? 'warmer' : 'cooler';
  const tintDir = Math.abs(gmDelta) < 1 ? 'ok' : gmDelta > 0 ? 'greener' : 'magenta';
  const contrastDir = Math.abs(spreadDelta) < 4 ? 'ok' : spreadDelta > 0 ? 'more' : 'less';

  const bits = [];
  if (Math.abs(exposure) >= 0.05)
    bits.push(`${Math.abs(exposure).toFixed(2)} EV ${exposure > 0 ? 'darker' : 'brighter'} than ref`);
  if (tempDir !== 'ok') bits.push(`needs ${tempDir} (~${magOf(Math.abs(tDelta))}, Δ${tDelta})`);
  if (tintDir !== 'ok') bits.push(`tint ${tintDir} (Δ${gmDelta})`);
  if (contrastDir !== 'ok') bits.push(`${contrastDir} contrast (spread ${subjSpread} vs ${refSpread})`);
  if (Math.abs(satRatio - 1) >= 0.05) bits.push(`saturation ${satRatio}x`);

  return {
    exposure: Math.round(exposure * 100) / 100,
    temperature: { direction: tempDir, delta: tDelta, magnitude: magOf(Math.abs(tDelta)) },
    tint: { direction: tintDir, delta: gmDelta, magnitude: magOf(Math.abs(gmDelta)) },
    contrast: { refSpread, subjSpread, direction: contrastDir },
    saturation: satRatio,
    reading: bits.length ? `Subject vs reference: ${bits.join('; ')}.` : 'Subject already matches the reference within tolerance.',
  };
}

/**
 * gapMagnitude(subj, ref) — the combined convergence scalar from
 * docs/notes/match-reference.md (D-026):
 *   |Δexposure|·8 + |ΔwarmCool| + |ΔgreenMagenta| + |Δsaturation|·20
 *   + |ΔblackPoint| + |ΔwhitePoint|
 */
export function gapMagnitude(subj, ref) {
  const dExp = ((ref.zones.mids.luma - subj.zones.mids.luma) / 64) * 0.5;
  const dWarm = ref.cast.warmCool - subj.cast.warmCool;
  const dGm = ref.cast.greenMagenta - subj.cast.greenMagenta;
  const dSat = ref.saturation - subj.saturation;
  const dBp = ref.blackPoint - subj.blackPoint;
  const dWp = ref.whitePoint - subj.whitePoint;
  return Math.abs(dExp) * 8 + Math.abs(dWarm) + Math.abs(dGm)
    + Math.abs(dSat) * 20 + Math.abs(dBp) + Math.abs(dWp);
}

export { round2 };
