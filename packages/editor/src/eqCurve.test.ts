// @chroma/editor — unit tests for `eqCurve.ts` (D-237, roadmap item 27's "EQ
// response curve UI"): the log-frequency/±24 dB screen mapping, the sampled
// composite curve, a band's own point, drag-to-patch, and the scroll-wheel Q
// mapping. No DOM here — `EqResponseGraph.dom.test.tsx` covers the real
// pointer/wheel gestures through the actual component; this file is purely
// the geometry those gestures are built on, asserted against exact numbers.
import { describe, expect, it } from 'vitest';

import {
  EQ_DB_GRIDLINES,
  EQ_FREQ_GRIDLINES,
  dbToY,
  eqBandPoint,
  eqCurveFillPath,
  eqCurveLinePath,
  eqCurveSamples,
  eqPointDragPatch,
  eqQAfterWheel,
  freqToX,
  xToFreq,
  yToDb,
} from './eqCurve';
import {
  EQ_MAX_FREQ_HZ,
  EQ_MAX_GAIN_DB,
  EQ_MAX_Q,
  EQ_MIN_FREQ_HZ,
  EQ_MIN_Q,
  eqResponseDb,
  type EqBand,
} from './eq';

const WIDTH = 300;
const HEIGHT = 100;

describe('freqToX / xToFreq — the log-frequency axis', () => {
  it('places the axis extremes at the plot edges', () => {
    expect(freqToX(EQ_MIN_FREQ_HZ, WIDTH)).toBeCloseTo(0, 6);
    expect(freqToX(EQ_MAX_FREQ_HZ, WIDTH)).toBeCloseTo(WIDTH, 6);
  });

  it('places a mid-range frequency at the geometric (not arithmetic) midpoint', () => {
    // sqrt(20 * 20000) is the log-axis MIDPOINT frequency — the point where
    // an octave-doubling below and above it cover equal screen width.
    const mid = Math.sqrt(EQ_MIN_FREQ_HZ * EQ_MAX_FREQ_HZ);
    expect(freqToX(mid, WIDTH)).toBeCloseTo(WIDTH / 2, 4);
  });

  it('round-trips through both directions', () => {
    for (const hz of [20, 60, 120, 500, 1_000, 2_500, 8_000, 20_000]) {
      const x = freqToX(hz, WIDTH);
      expect(xToFreq(x, WIDTH)).toBeCloseTo(hz, 4);
    }
  });

  it('clamps a frequency outside the model range to the plot edge', () => {
    expect(freqToX(1, WIDTH)).toBe(0);
    expect(freqToX(100_000, WIDTH)).toBe(WIDTH);
  });

  it('clamps an x outside the plot to the axis range', () => {
    // `Math.pow(10, log10(x))` isn't bit-exact for every x, so this checks
    // the clamp's intent (pinned to the axis edge) rather than `Object.is`.
    expect(xToFreq(-50, WIDTH)).toBeCloseTo(EQ_MIN_FREQ_HZ, 9);
    expect(xToFreq(WIDTH + 50, WIDTH)).toBeCloseTo(EQ_MAX_FREQ_HZ, 6);
  });
});

describe('dbToY / yToDb — the ±24 dB axis', () => {
  it('puts +max at the top (y=0) and -max at the bottom (y=height)', () => {
    expect(dbToY(EQ_MAX_GAIN_DB, HEIGHT)).toBeCloseTo(0, 6);
    expect(dbToY(-EQ_MAX_GAIN_DB, HEIGHT)).toBeCloseTo(HEIGHT, 6);
    expect(dbToY(0, HEIGHT)).toBeCloseTo(HEIGHT / 2, 6);
  });

  it('round-trips through both directions', () => {
    for (const db of [-24, -12, -6.5, 0, 3.25, 12, 24]) {
      expect(yToDb(dbToY(db, HEIGHT), HEIGHT)).toBeCloseTo(db, 6);
    }
  });

  it('clamps a gain outside ±24 dB to the axis edge', () => {
    expect(dbToY(90, HEIGHT)).toBe(0);
    expect(dbToY(-90, HEIGHT)).toBe(HEIGHT);
  });
});

describe('EQ_FREQ_GRIDLINES / EQ_DB_GRIDLINES', () => {
  it('every frequency gridline is inside the model range', () => {
    for (const hz of EQ_FREQ_GRIDLINES) {
      expect(hz).toBeGreaterThanOrEqual(EQ_MIN_FREQ_HZ);
      expect(hz).toBeLessThanOrEqual(EQ_MAX_FREQ_HZ);
    }
  });

  it('the dB gridlines are the axis ends, its halves and the centre', () => {
    expect(EQ_DB_GRIDLINES).toEqual([-24, -12, 0, 12, 24]);
  });
});

// A high-pass, a bell cut and a disabled shelf — deliberately awkward numbers
// so an accidental identity can't pass, the same discipline
// `chroma_types::eq`'s own `reference_band_set` uses.
function sampleBands(): EqBand[] {
  return [
    { kind: 'high_pass', freq_hz: 90, gain_db: 0, q: 0.71, enabled: true },
    { kind: 'peak', freq_hz: 950, gain_db: -6.5, q: 1.8, enabled: true },
    { kind: 'high_shelf', freq_hz: 6_200, gain_db: 5.5, q: 0.62, enabled: true },
    { kind: 'low_shelf', freq_hz: 400, gain_db: 18, q: 0.9, enabled: false },
  ];
}

describe('eqCurveSamples — the rendered curve matches eqResponseDb exactly', () => {
  it('every sampled point’s own dB is exactly what eqResponseDb computes at that frequency', () => {
    const bands = sampleBands();
    const samples = eqCurveSamples(bands, WIDTH, HEIGHT, 48_000);
    expect(samples.length).toBeGreaterThan(2);
    for (const s of samples) {
      expect(s.db).toBe(eqResponseDb(bands, s.freqHz, 48_000));
      expect(s.y).toBe(dbToY(s.db, HEIGHT));
    }
  });

  it('checked at several standard frequencies — not merely "renders without crashing"', () => {
    const bands = sampleBands();
    for (const hz of [50, 120, 300, 1_000, 3_000, 8_000, 15_000]) {
      const x = freqToX(hz, WIDTH);
      const samples = eqCurveSamples(bands, WIDTH, HEIGHT, 48_000);
      // Nearest sample to this frequency's own x — the curve is sampled, not
      // solved (see the module doc), so this asserts agreement at the
      // resolution the plot actually draws at, which is the property that
      // matters for a rendered line.
      const nearest = samples.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a));
      const expected = eqResponseDb(bands, nearest.freqHz, 48_000);
      expect(nearest.db).toBeCloseTo(expected, 9);
    }
  });

  it('a disabled band contributes nothing to the sampled curve either', () => {
    const bands = sampleBands();
    const withoutDisabled = bands.filter((b) => b.enabled);
    const a = eqCurveSamples(bands, WIDTH, HEIGHT, 48_000);
    const b = eqCurveSamples(withoutDisabled, WIDTH, HEIGHT, 48_000);
    for (let i = 0; i < a.length; i++) {
      expect(a[i].db).toBeCloseTo(b[i].db, 9);
    }
  });

  it('an empty band list is a flat 0 dB line', () => {
    const samples = eqCurveSamples([], WIDTH, HEIGHT, 48_000);
    expect(samples.every((s) => s.db === 0)).toBe(true);
  });

  it('returns nothing for a zero-width plot rather than dividing by zero', () => {
    expect(eqCurveSamples(sampleBands(), 0, HEIGHT)).toEqual([]);
  });
});

describe('eqCurveLinePath / eqCurveFillPath', () => {
  it('the line path starts with M and continues with one L per further point', () => {
    const samples = eqCurveSamples(sampleBands(), WIDTH, HEIGHT, 48_000, 5);
    const path = eqCurveLinePath(samples);
    expect(path.startsWith('M ')).toBe(true);
    expect(path.match(/L /g)?.length).toBe(4);
  });

  it('the fill path closes down to the 0 dB baseline at both ends', () => {
    const samples = eqCurveSamples(sampleBands(), WIDTH, HEIGHT, 48_000, 5);
    const fill = eqCurveFillPath(samples, HEIGHT);
    const zeroY = dbToY(0, HEIGHT).toFixed(2);
    expect(fill.endsWith('Z')).toBe(true);
    expect(fill).toContain(`${samples[samples.length - 1].x.toFixed(2)} ${zeroY}`);
    expect(fill).toContain(`${samples[0].x.toFixed(2)} ${zeroY}`);
  });

  it('an empty sample set produces empty paths', () => {
    expect(eqCurveLinePath([])).toBe('');
    expect(eqCurveFillPath([], HEIGHT)).toBe('');
  });
});

describe('eqBandPoint — where a band’s own draggable point sits', () => {
  it('a gain-using band sits at its own frequency and gain', () => {
    const band: EqBand = { kind: 'peak', freq_hz: 1_000, gain_db: 6, q: 1, enabled: true };
    const p = eqBandPoint(band, WIDTH, HEIGHT);
    expect(p.x).toBeCloseTo(freqToX(1_000, WIDTH), 6);
    expect(p.y).toBeCloseTo(dbToY(6, HEIGHT), 6);
  });

  it('a pass filter sits on the 0 dB line regardless of its (ignored) gain_db', () => {
    const band: EqBand = { kind: 'high_pass', freq_hz: 80, gain_db: 99, q: 0.7, enabled: true };
    const p = eqBandPoint(band, WIDTH, HEIGHT);
    expect(p.y).toBeCloseTo(dbToY(0, HEIGHT), 6);
  });
});

describe('eqPointDragPatch — what dragging a point means', () => {
  it('a gain-using band’s drag writes both freq_hz and gain_db, rounded', () => {
    const band: EqBand = { kind: 'peak', freq_hz: 1_000, gain_db: 0, q: 1, enabled: true };
    const x = freqToX(2_000, WIDTH);
    const y = dbToY(-6.37, HEIGHT);
    const patch = eqPointDragPatch(band, WIDTH, HEIGHT, x, y);
    expect(patch.freq_hz).toBe(2_000);
    expect(patch.gain_db).toBe(-6.4); // rounded to the nearest 0.1 dB
  });

  it('a pass filter’s drag writes ONLY freq_hz — never a gain_db it would ignore', () => {
    const band: EqBand = { kind: 'low_pass', freq_hz: 5_000, gain_db: 0, q: 0.7, enabled: true };
    const x = freqToX(9_000, WIDTH);
    const y = dbToY(20, HEIGHT); // an arbitrary y — must be ignored entirely
    const patch = eqPointDragPatch(band, WIDTH, HEIGHT, x, y);
    expect(patch).toEqual({ freq_hz: 9_000 });
    expect('gain_db' in patch).toBe(false);
  });

  it('clamps a drag outside the plot into the axis range', () => {
    const band: EqBand = { kind: 'peak', freq_hz: 1_000, gain_db: 0, q: 1, enabled: true };
    const patch = eqPointDragPatch(band, WIDTH, HEIGHT, -100, -100);
    expect(patch.freq_hz).toBe(EQ_MIN_FREQ_HZ);
    expect(patch.gain_db).toBe(EQ_MAX_GAIN_DB);
  });
});

describe('eqQAfterWheel — the scroll-wheel Q convention', () => {
  it('scrolling up (negative deltaY) narrows the band (raises Q)', () => {
    expect(eqQAfterWheel(1, -100)).toBeGreaterThan(1);
  });

  it('scrolling down (positive deltaY) widens the band (lowers Q)', () => {
    expect(eqQAfterWheel(1, 100)).toBeLessThan(1);
  });

  it('a zero delta changes nothing but still clamps an out-of-range input', () => {
    expect(eqQAfterWheel(1, 0)).toBe(1);
    expect(eqQAfterWheel(999, 0)).toBe(EQ_MAX_Q);
  });

  it('never leaves the model’s own Q range no matter how far scrolled', () => {
    let q = 1;
    for (let i = 0; i < 200; i++) q = eqQAfterWheel(q, -1_000);
    expect(q).toBe(EQ_MAX_Q);
    for (let i = 0; i < 200; i++) q = eqQAfterWheel(q, 1_000);
    expect(q).toBe(EQ_MIN_Q);
  });

  it('is symmetric enough that scrolling up then down the same amount returns near the start', () => {
    const up = eqQAfterWheel(2, -100);
    const back = eqQAfterWheel(up, 100);
    expect(back).toBeCloseTo(2, 1);
  });
});
