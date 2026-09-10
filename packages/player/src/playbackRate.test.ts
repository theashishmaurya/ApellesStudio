/**
 * D-278 — the transport playback-rate model. Pure arithmetic with real correct
 * answers, so it is tested rather than reasoned about; the two invariants that
 * matter are that it CLAMPS rather than rejects (so no surface, human or MCP,
 * can leave an impossible rate for the rAF loop and the audio session to find)
 * and that the presets are the ones the roadmap asked for.
 */

import { describe, expect, it } from 'vitest';

import {
  clampPlaybackRate,
  DEFAULT_PLAYBACK_RATE,
  formatPlaybackRate,
  isDefaultPlaybackRate,
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
  PLAYBACK_RATE_PRESETS,
  PLAYBACK_RATE_STEP,
} from './playbackRate';

describe('clampPlaybackRate', () => {
  it('passes an in-range rate through untouched', () => {
    for (const r of [0.25, 0.5, 1, 2, 3, 4, 7.5, 8]) {
      expect(clampPlaybackRate(r)).toBe(r);
    }
  });

  it('clamps an out-of-range rate to the bounds rather than rejecting it', () => {
    expect(clampPlaybackRate(0.01)).toBe(MIN_PLAYBACK_RATE);
    expect(clampPlaybackRate(100)).toBe(MAX_PLAYBACK_RATE);
  });

  it('reads nonsense as ordinary playback, never as an error or as silence', () => {
    expect(clampPlaybackRate(0)).toBe(DEFAULT_PLAYBACK_RATE);
    expect(clampPlaybackRate(-2)).toBe(DEFAULT_PLAYBACK_RATE);
    expect(clampPlaybackRate(Number.NaN)).toBe(DEFAULT_PLAYBACK_RATE);
    expect(clampPlaybackRate(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PLAYBACK_RATE);
  });
});

describe('the presets', () => {
  it('cover the owner-requested 2x / 3x / 4x and a way back to 1x', () => {
    expect(PLAYBACK_RATE_PRESETS).toContain(2);
    expect(PLAYBACK_RATE_PRESETS).toContain(3);
    expect(PLAYBACK_RATE_PRESETS).toContain(4);
    expect(PLAYBACK_RATE_PRESETS).toContain(DEFAULT_PLAYBACK_RATE);
  });

  it('are all inside the bounds — no preset the engine would clamp away', () => {
    for (const r of PLAYBACK_RATE_PRESETS) {
      expect(clampPlaybackRate(r)).toBe(r);
    }
  });

  it('are listed slowest-first with no duplicates', () => {
    const sorted = [...PLAYBACK_RATE_PRESETS].sort((a, b) => a - b);
    expect([...PLAYBACK_RATE_PRESETS]).toEqual(sorted);
    expect(new Set(PLAYBACK_RATE_PRESETS).size).toBe(PLAYBACK_RATE_PRESETS.length);
  });
});

describe('the bounds', () => {
  it('are expressible in whole steps of the custom field', () => {
    for (const bound of [MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE]) {
      expect(Math.abs(bound / PLAYBACK_RATE_STEP - Math.round(bound / PLAYBACK_RATE_STEP))).toBeLessThan(1e-9);
    }
  });

  it('bracket ordinary playback', () => {
    expect(MIN_PLAYBACK_RATE).toBeLessThan(DEFAULT_PLAYBACK_RATE);
    expect(MAX_PLAYBACK_RATE).toBeGreaterThan(DEFAULT_PLAYBACK_RATE);
  });
});

describe('formatPlaybackRate', () => {
  it('drops trailing zeros so a whole rate reads as a whole number', () => {
    expect(formatPlaybackRate(1)).toBe('1×');
    expect(formatPlaybackRate(4)).toBe('4×');
  });

  it('keeps the decimals the bounds actually need', () => {
    expect(formatPlaybackRate(0.5)).toBe('0.5×');
    expect(formatPlaybackRate(0.25)).toBe('0.25×');
    expect(formatPlaybackRate(1.5)).toBe('1.5×');
  });
});

describe('isDefaultPlaybackRate', () => {
  it('is true only at ordinary playback, tolerating float noise', () => {
    expect(isDefaultPlaybackRate(1)).toBe(true);
    expect(isDefaultPlaybackRate(1 + 1e-9)).toBe(true);
    expect(isDefaultPlaybackRate(1.5)).toBe(false);
    expect(isDefaultPlaybackRate(0.5)).toBe(false);
  });
});
