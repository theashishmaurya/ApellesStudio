/**
 * @apelles/editor — the Inspector's display units (v0.3.0, D-443): every
 * conversion round-trips, so a value shown and edited in % / dB / s / px
 * writes back exactly the stored value it came from.
 */
import { describe, expect, it } from 'vitest';

import {
  DECIBELS,
  PERCENT,
  VOLUME_DB_FLOOR,
  centredPositionPx,
  centredPositionUnits,
  dbFromGain,
  easeLabel,
  fadeSummary,
  formatDb,
  formatHz,
  formatPan,
  framesFromSeconds,
  gainFromDb,
  hzFromOctaves,
  octavesFromHz,
  parseHz,
  parsePan,
  positionSummary,
  roundHz,
  secondsFromFrames,
  secondsMapping,
} from './displayUnits';

describe('percent (Scale, Opacity, Crop)', () => {
  it('round-trips stored fractions through % without float dust', () => {
    for (const v of [0, 0.07, 0.052212, 0.5, 1, 1.1, 2.5, 4]) {
      expect(PERCENT.fromDisplay(PERCENT.toDisplay(v))).toBe(v);
    }
    expect(PERCENT.toDisplay(0.07)).toBe(7);
    expect(PERCENT.toDisplay(1.1)).toBe(110);
  });
});

describe('decibels (Volume)', () => {
  it('unity is 0 dB, half is −6 dB, silence is the floor', () => {
    expect(dbFromGain(1)).toBe(0);
    expect(dbFromGain(0.5)).toBeCloseTo(-6.0206, 4);
    expect(dbFromGain(0)).toBe(VOLUME_DB_FLOOR);
    expect(gainFromDb(VOLUME_DB_FLOOR)).toBe(0);
    expect(gainFromDb(-200)).toBe(0);
  });

  it('round-trips gains through dB', () => {
    for (const g of [0.01, 0.25, 0.55, 1, 2, 10.6]) {
      expect(DECIBELS.fromDisplay(DECIBELS.toDisplay(g))).toBeCloseTo(g, 4);
    }
  });

  it('formats with a sign and a real minus', () => {
    expect(formatDb(-3)).toBe('−3.0 dB');
    expect(formatDb(2.5)).toBe('+2.5 dB');
    expect(formatDb(0.01)).toBe('0 dB');
    expect(formatDb(VOLUME_DB_FLOOR)).toBe('Silent');
  });
});

describe('pan', () => {
  it('reads L / Center / R and parses the same words back', () => {
    expect(formatPan(0).text).toBe('Center');
    expect(formatPan(-40).text).toBe('L 40');
    expect(formatPan(100).text).toBe('R 100');
    expect(parsePan('center')).toBe(0);
    expect(parsePan('C')).toBe(0);
    expect(parsePan('L 40')).toBe(-40);
    expect(parsePan('r25')).toBe(25);
    expect(parsePan('R 250')).toBe(100);
    expect(parsePan('40')).toBeNull();
  });
});

describe('seconds (fades, highlights)', () => {
  it('round-trips whole frames through seconds at the rate', () => {
    for (const fps of [24, 25, 29.97, 30, 60]) {
      for (const f of [0, 1, 12, 48, 241]) {
        expect(framesFromSeconds(secondsFromFrames(f, fps), fps)).toBe(f);
      }
    }
    const m = secondsMapping(30);
    expect(m.toDisplay(12)).toBe(0.4);
    expect(m.fromDisplay(0.4)).toBe(12);
  });

  it('summarises a fade pair', () => {
    expect(fadeSummary(12, 0, 30)).toBe('In 0.40 s · Out none');
    expect(fadeSummary(0, 0, 30)).toBe('In none · Out none');
  });
});

describe('frequency (EQ)', () => {
  it('maps Hz to octaves above 20 Hz and back', () => {
    expect(octavesFromHz(20)).toBe(0);
    expect(octavesFromHz(40)).toBe(1);
    for (const hz of [20, 85, 500, 3500, 20000]) {
      expect(hzFromOctaves(octavesFromHz(hz))).toBeCloseTo(hz, 6);
    }
  });

  it('rounds a scrubbed frequency to three figures and formats Hz / kHz', () => {
    expect(roundHz(3498.71)).toBe(3500);
    expect(roundHz(84.6)).toBe(84.6);
    expect(formatHz(250)).toEqual({ text: '250', unit: 'Hz' });
    expect(formatHz(3500)).toEqual({ text: '3.5', unit: 'kHz' });
    expect(formatHz(12500)).toEqual({ text: '12.5', unit: 'kHz' });
    expect(parseHz('3.5k')).toBe(3500);
    expect(parseHz('3.5 kHz')).toBe(3500);
    expect(parseHz('250 Hz')).toBe(250);
    expect(parseHz('L 4')).toBeNull();
  });
});

describe('position from the centre', () => {
  const comp = { width: 1920, height: 1080 };

  it('a centred box reads 0, 0, and the summary says centred', () => {
    const box = { left: 0, top: 0, width: 1, height: 1 };
    expect(centredPositionPx(box, comp)).toEqual({ x: 0, y: 0 });
    expect(positionSummary({ x: 0, y: 0 })).toBe('centred');
    expect(positionSummary({ x: 0, y: -48 })).toBe('48 px up');
    expect(positionSummary({ x: -120, y: 30 })).toBe('120 px left · 30 px down');
  });

  it('round-trips stored top-left positions through px, with a fit origin and a size', () => {
    // A half-size box whose fit origin is 0.25 across: position 0 is centred.
    const position = { x: 0.1, y: -0.05 };
    const origin = { x: 0.25, y: 0.25 };
    const box = { left: position.x + origin.x, top: position.y + origin.y, width: 0.5, height: 0.5 };
    const [ux, uy] = centredPositionUnits(box, position, comp);
    expect(ux.toDisplay(position.x)).toBeCloseTo(0.1 * 1920, 6);
    expect(uy.toDisplay(position.y)).toBeCloseTo(-0.05 * 1080, 6);
    expect(ux.toDisplay(0)).toBe(0);
    for (const v of [-0.4, 0, 0.123456, 0.9]) {
      expect(ux.fromDisplay(ux.toDisplay(v))).toBeCloseTo(v, 6);
      expect(uy.fromDisplay(uy.toDisplay(v))).toBeCloseTo(v, 6);
    }
  });
});

describe('ease curve names', () => {
  it('names the four presets plainly, and an unmatched curve as the agent’s', () => {
    expect(easeLabel('linear')).toBe('Even');
    expect(easeLabel('ease-in')).toBe('Slow start');
    expect(easeLabel('ease-out')).toBe('Slow end');
    expect(easeLabel('ease-in-out')).toBe('Slow start and end');
    expect(easeLabel(null)).toBe('Custom (set by your agent)');
  });
});
