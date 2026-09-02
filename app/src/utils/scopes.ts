/**
 * scopes.ts — numeric colour analysis for the AI grading loop (roadmap item 1,
 * D-021). NOT the interactive UI scopes (that's RapidRAW's Rust waveform path).
 *
 * WHAT IT IS: a pure, dependency-free reader that turns a rendered frame
 * (`ImageData`) into numbers an agent can't sycophant away — black/white points,
 * per-zone means, measured colour cast, clip %, a hue histogram — plus small
 * PNG scope images (RGB parade, vectorscope). See
 * `docs/notes/agent-visual-feedback.md` (grade by the numbers) and
 * `docs/notes/scopes.md`.
 *
 * WHAT IT IS NOT: a real-time GPU scope. It downsamples to <=512px long edge and
 * runs on the CPU in the webview — fine for grounding a grade decision, not for
 * 60fps. A WGSL UI-scopes path can land later, independently.
 */

/* ------------------------------------------------------------------ types --- */

export interface ZoneStat {
  meanRGB: [number, number, number];
  luma: number;
}

export interface ChannelClip {
  lo: number; // % of pixels with this channel == 0
  hi: number; // % of pixels with this channel == 255
}

export interface Scopes {
  /** 1st-percentile luma, 0–255 */
  blackPoint: number;
  /** 99th-percentile luma, 0–255 */
  whitePoint: number;
  /** % of pixels with luma <= 1 */
  clipLowPct: number;
  /** % of pixels with luma >= 254 */
  clipHighPct: number;
  /** per-channel clipping at the 0 / 255 rails */
  clip: { r: ChannelClip; g: ChannelClip; b: ChannelClip };
  /** mean of each channel over the frame, 0–255 */
  meanRGB: [number, number, number];
  /** means split by luma: shadows <64, mids 64–191, highs >191 */
  zones: { shadows: ZoneStat; mids: ZoneStat; highs: ZoneStat };
  /** colour cast measured in the mids (units: 0–255 channel deltas) */
  cast: { warmCool: number; greenMagenta: number };
  /** mean HSV saturation, 0–1 */
  saturation: number;
  /** 12 bins x 30° from 0° (red), saturation-weighted, normalised to sum 1 */
  hueHistogram: number[];
  /** frame pixel dimensions the numbers were read from (pre-downsample) */
  frameSize: [number, number];
  /** how many pixels were actually sampled */
  sampled: number;
}

/* --------------------------------------------------------------- helpers --- */

const REC709 = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** HSV-style saturation, 0–1. */
function satOf(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  if (max <= 0) return 0;
  const min = Math.min(r, g, b);
  return (max - min) / max;
}

/** hue in degrees 0–360 (0 = red). Returns 0 for greys. */
function hueOf(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d <= 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/** stride so the long edge is <= target pixels. */
function strideFor(w: number, h: number, target = 512): number {
  return Math.max(1, Math.ceil(Math.max(w, h) / target));
}

/* ----------------------------------------------------------- computeScopes --- */

export function computeScopes(img: {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array | number[];
}): Scopes {
  const { width, height, data } = img;
  const step = strideFor(width, height);

  const lumaHist = new Float64Array(256);
  let rSum = 0, gSum = 0, bSum = 0;
  let rClipLo = 0, rClipHi = 0, gClipLo = 0, gClipHi = 0, bClipLo = 0, bClipHi = 0;
  let lumaClipLo = 0, lumaClipHi = 0;
  let satSum = 0;

  // zone accumulators
  const z = {
    sh: { r: 0, g: 0, b: 0, n: 0 },
    mi: { r: 0, g: 0, b: 0, n: 0 },
    hi: { r: 0, g: 0, b: 0, n: 0 },
  };

  const hueHist = new Float64Array(12);
  let n = 0;

  for (let y = 0; y < height; y += step) {
    let rowOff = y * width * 4;
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

  // percentiles off the luma histogram
  const pct = (p: number): number => {
    const want = (p / 100) * n;
    let cum = 0;
    for (let v = 0; v < 256; v++) {
      cum += lumaHist[v];
      if (cum >= want) return v;
    }
    return 255;
  };

  const zoneStat = (a: { r: number; g: number; b: number; n: number }): ZoneStat => {
    const c = Math.max(1, a.n);
    const mean: [number, number, number] = [a.r / c, a.g / c, a.b / c];
    return { meanRGB: mean, luma: REC709(mean[0], mean[1], mean[2]) };
  };

  const shadows = zoneStat(z.sh);
  const mids = zoneStat(z.mi);
  const highs = zoneStat(z.hi);

  const hueSum = hueHist.reduce((s, v) => s + v, 0) || 1;
  const hueHistogram = Array.from(hueHist, (v) => v / hueSum);

  const round2 = (v: number) => Math.round(v * 100) / 100;
  const asPct = (c: number) => round2((c / n) * 100);

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
      shadows: { meanRGB: shadows.meanRGB.map(round2) as [number, number, number], luma: round2(shadows.luma) },
      mids: { meanRGB: mids.meanRGB.map(round2) as [number, number, number], luma: round2(mids.luma) },
      highs: { meanRGB: highs.meanRGB.map(round2) as [number, number, number], luma: round2(highs.luma) },
    },
    cast: {
      warmCool: round2(mids.meanRGB[0] - mids.meanRGB[2]),
      greenMagenta: round2(mids.meanRGB[1] - (mids.meanRGB[0] + mids.meanRGB[2]) / 2),
    },
    saturation: round2(satSum / n),
    hueHistogram: hueHistogram.map((v) => Math.round(v * 1000) / 1000),
    frameSize: [width, height],
    sampled: n,
  };
}

/* --------------------------------------------------------------- gap hint --- */

export interface GapHint {
  /** EV-ish exposure hint: >0 => subject should go brighter to match ref */
  exposure: number;
  temperature: { direction: 'warmer' | 'cooler' | 'ok'; delta: number; magnitude: string };
  tint: { direction: 'greener' | 'magenta' | 'ok'; delta: number; magnitude: string };
  contrast: { refSpread: number; subjSpread: number; direction: 'more' | 'less' | 'ok' };
  saturation: number; // ref.saturation / subj.saturation
  reading: string;
}

function magOf(abs: number): string {
  if (abs < 2) return 'slight';
  if (abs < 6) return 'moderate';
  return 'strong';
}

/** subject → reference gap, as HINTS that map onto knobs (not commands). */
export function computeGap(subj: Scopes, ref: Scopes): GapHint {
  const exposure = ((ref.zones.mids.luma - subj.zones.mids.luma) / 64) * 0.5;

  const tDelta = Math.round((ref.cast.warmCool - subj.cast.warmCool) * 100) / 100;
  const gmDelta = Math.round((ref.cast.greenMagenta - subj.cast.greenMagenta) * 100) / 100;

  const refSpread = ref.whitePoint - ref.blackPoint;
  const subjSpread = subj.whitePoint - subj.blackPoint;
  const spreadDelta = refSpread - subjSpread;

  const satRatio = subj.saturation > 0.001
    ? Math.round((ref.saturation / subj.saturation) * 100) / 100
    : 1;

  const tempDir = Math.abs(tDelta) < 1 ? 'ok' : tDelta > 0 ? 'warmer' : 'cooler';
  const tintDir = Math.abs(gmDelta) < 1 ? 'ok' : gmDelta > 0 ? 'greener' : 'magenta';
  const contrastDir = Math.abs(spreadDelta) < 4 ? 'ok' : spreadDelta > 0 ? 'more' : 'less';

  const bits: string[] = [];
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

/* ------------------------------------------------------------ point sample --- */

export interface PointSample {
  x: number;
  y: number;
  rgb: [number, number, number];
  hex: string;
  luma: number;
}

const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');

export function samplePoint(img: { width: number; height: number; data: Uint8ClampedArray | Uint8Array | number[] }, x: number, y: number): PointSample {
  const px = Math.max(0, Math.min(img.width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(img.height - 1, Math.round(y)));
  const i = (py * img.width + px) * 4;
  const rgb: [number, number, number] = [img.data[i], img.data[i + 1], img.data[i + 2]];
  return { x: px, y: py, rgb, hex: `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}`, luma: Math.round(REC709(rgb[0], rgb[1], rgb[2]) * 100) / 100 };
}

export interface RegionSample {
  rect: [number, number, number, number];
  meanRGB: [number, number, number];
  minRGB: [number, number, number];
  maxRGB: [number, number, number];
  hex: string;
  luma: number;
  pixels: number;
}

export function sampleRegion(
  img: { width: number; height: number; data: Uint8ClampedArray | Uint8Array | number[] },
  x: number, y: number, w: number, h: number,
): RegionSample {
  const x0 = Math.max(0, Math.min(img.width - 1, Math.round(x)));
  const y0 = Math.max(0, Math.min(img.height - 1, Math.round(y)));
  const x1 = Math.max(x0 + 1, Math.min(img.width, Math.round(x + w)));
  const y1 = Math.max(y0 + 1, Math.min(img.height, Math.round(y + h)));
  let rS = 0, gS = 0, bS = 0, n = 0;
  const mn: [number, number, number] = [255, 255, 255];
  const mx: [number, number, number] = [0, 0, 0];
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const i = (py * img.width + px) * 4;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      rS += r; gS += g; bS += b; n++;
      if (r < mn[0]) mn[0] = r; if (g < mn[1]) mn[1] = g; if (b < mn[2]) mn[2] = b;
      if (r > mx[0]) mx[0] = r; if (g > mx[1]) mx[1] = g; if (b > mx[2]) mx[2] = b;
    }
  }
  n = Math.max(1, n);
  const mean: [number, number, number] = [rS / n, gS / n, bS / n];
  const round2 = (v: number) => Math.round(v * 100) / 100;
  return {
    rect: [x0, y0, x1 - x0, y1 - y0],
    meanRGB: mean.map(round2) as [number, number, number],
    minRGB: mn,
    maxRGB: mx,
    hex: `#${hex2(mean[0])}${hex2(mean[1])}${hex2(mean[2])}`,
    luma: round2(REC709(mean[0], mean[1], mean[2])),
    pixels: n,
  };
}

/* -------------------------------------------------------- scope image draws --- */

type Canvasish = { canvas: any; ctx: CanvasRenderingContext2D };

function makeCanvas(w: number, h: number): Canvasish {
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d') as unknown as CanvasRenderingContext2D;
      if (ctx) return { canvas: c, ctx };
    }
  } catch {
    /* fall through */
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { canvas: c, ctx: c.getContext('2d') as CanvasRenderingContext2D };
}

async function toDataURL(canvas: any): Promise<string> {
  if (typeof canvas.toDataURL === 'function') return canvas.toDataURL('image/png');
  // OffscreenCanvas
  const blob: Blob = await canvas.convertToBlob({ type: 'image/png' });
  return await new Promise<string>((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.readAsDataURL(blob);
  });
}

/** RGB parade: R, G, B waveforms side by side. Returns a PNG data URL. */
export async function renderParade(img: {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array | number[];
}): Promise<string> {
  const PANEL = 104, GAP = 4, W = PANEL * 3 + GAP * 2, H = 256;
  const { canvas, ctx } = makeCanvas(W, H);
  ctx.fillStyle = '#0d0d0f';
  ctx.fillRect(0, 0, W, H);

  const buf = ctx.createImageData(W, H);
  const d = buf.data;
  const step = strideFor(img.width, img.height, 480);
  const chanColor: [number, number, number][] = [
    [255, 90, 90],
    [90, 230, 120],
    [100, 150, 255],
  ];
  const ADD = 26;

  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      const i = (y * img.width + x) * 4;
      const col = Math.min(PANEL - 1, Math.floor((x / img.width) * PANEL));
      for (let ch = 0; ch < 3; ch++) {
        const v = img.data[i + ch];
        const py = 255 - (v < 0 ? 0 : v > 255 ? 255 : v);
        const px = ch * (PANEL + GAP) + col;
        const o = (py * W + px) * 4;
        d[o] = Math.min(255, d[o] + (chanColor[ch][0] * ADD) / 255);
        d[o + 1] = Math.min(255, d[o + 1] + (chanColor[ch][1] * ADD) / 255);
        d[o + 2] = Math.min(255, d[o + 2] + (chanColor[ch][2] * ADD) / 255);
        d[o + 3] = 255;
      }
    }
  }
  ctx.putImageData(buf, 0, 0);

  // graticule: 0 / 25 / 50 / 75 / 100 IRE lines
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  for (let f = 0; f <= 4; f++) {
    const yy = Math.round((f / 4) * (H - 1)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, yy);
    ctx.lineTo(W, yy);
    ctx.stroke();
  }
  return toDataURL(canvas);
}

/** Classic vectorscope (YUV chroma plot) with the skin-tone line marked. */
export async function renderVectorscope(img: {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array | number[];
}): Promise<string> {
  const S = 256, C = S / 2, SCALE = 220;
  const { canvas, ctx } = makeCanvas(S, S);
  ctx.fillStyle = '#0d0d0f';
  ctx.fillRect(0, 0, S, S);

  // graticule
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(C, C, SCALE * 0.5, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(C, C, SCALE * 0.32, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(C, 0); ctx.lineTo(C, S); ctx.moveTo(0, C); ctx.lineTo(S, C); ctx.stroke();

  // skin-tone (I) line — ~123° in the U/V plane
  const ang = (123 * Math.PI) / 180;
  ctx.strokeStyle = 'rgba(255,190,140,0.55)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(C, C);
  ctx.lineTo(C + Math.cos(ang) * SCALE * 0.55, C - Math.sin(ang) * SCALE * 0.55);
  ctx.stroke();

  const buf = ctx.getImageData(0, 0, S, S);
  const d = buf.data;
  const step = strideFor(img.width, img.height, 480);
  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      const i = (y * img.width + x) * 4;
      const r = img.data[i] / 255, g = img.data[i + 1] / 255, b = img.data[i + 2] / 255;
      const u = -0.14713 * r - 0.28886 * g + 0.436 * b;
      const v = 0.615 * r - 0.51499 * g - 0.10001 * b;
      const px = Math.round(C + u * SCALE);
      const py = Math.round(C - v * SCALE);
      if (px < 0 || px >= S || py < 0 || py >= S) continue;
      const o = (py * S + px) * 4;
      d[o] = Math.min(255, d[o] + 60);
      d[o + 1] = Math.min(255, d[o + 1] + 200);
      d[o + 2] = Math.min(255, d[o + 2] + 90);
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(buf, 0, 0);
  return toDataURL(canvas);
}
