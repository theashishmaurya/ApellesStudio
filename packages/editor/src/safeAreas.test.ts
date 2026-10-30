import { describe, expect, it } from 'vitest';
import {
  SAFE_AREA_PRESETS,
  insetsToRect,
  isSafeAreaViewId,
  presetRects,
  safeAreaPreset,
  suggestedPresets,
} from './safeAreas';

describe('safe-area presets', () => {
  it('reproduces the researched pixel figures on a 1080x1920 frame', () => {
    const rect = (id: Parameters<typeof safeAreaPreset>[0]) => presetRects(safeAreaPreset(id), 1080, 1920)[0];
    expect(rect('tiktok').insets).toEqual({ top: 240, bottom: 660, left: 120, right: 120 });
    expect(rect('instagram-reels').insets).toEqual({ top: 269, bottom: 672, left: 65, right: 65 });
    expect(rect('youtube-shorts').insets).toEqual({ top: 288, bottom: 672, left: 48, right: 192 });
  });

  it('the union is the per-side maximum, so it sits inside every platform rect', () => {
    const union = presetRects(safeAreaPreset('vertical-union'), 1080, 1920)[0];
    expect(union.insets).toEqual({ top: 288, bottom: 672, left: 120, right: 192 });
    expect(union).toMatchObject({ x: 120, y: 288, width: 768, height: 960 });
    for (const id of ['tiktok', 'instagram-reels', 'youtube-shorts'] as const) {
      const r = presetRects(safeAreaPreset(id), 1080, 1920)[0];
      expect(union.x).toBeGreaterThanOrEqual(r.x);
      expect(union.y).toBeGreaterThanOrEqual(r.y);
      expect(union.x + union.width).toBeLessThanOrEqual(r.x + r.width);
      expect(union.y + union.height).toBeLessThanOrEqual(r.y + r.height);
    }
  });

  it('title/action safe are 80% / 90% of a 3840x2160 frame', () => {
    const [action, title] = presetRects(safeAreaPreset('broadcast'), 3840, 2160);
    expect(action).toMatchObject({ id: 'action', x: 192, y: 108, width: 3456, height: 1944 });
    expect(title).toMatchObject({ id: 'title', x: 384, y: 216, width: 3072, height: 1728 });
  });

  it('scales with resolution: 720x1280 keeps the same fractions', () => {
    const big = presetRects(safeAreaPreset('vertical-union'), 1080, 1920)[0];
    const small = presetRects(safeAreaPreset('vertical-union'), 720, 1280)[0];
    expect(small.x / 720).toBeCloseTo(big.x / 1080, 2);
    expect(small.height / 1280).toBeCloseTo(big.height / 1920, 2);
  });

  it('never returns a negative size on a tiny frame', () => {
    const r = insetsToRect(safeAreaPreset('tiktok').regions[0], 10, 10);
    expect(r.width).toBeGreaterThanOrEqual(0);
    expect(r.height).toBeLessThan(10);
  });

  it('suggests the vertical presets (union first) for a portrait frame, broadcast otherwise', () => {
    expect(suggestedPresets(1080, 1920)).toEqual(['vertical-union', 'youtube-shorts', 'instagram-reels', 'tiktok']);
    expect(suggestedPresets(3840, 2160)).toEqual(['broadcast']);
  });

  it('every preset cites a source and ids are unique', () => {
    expect(new Set(SAFE_AREA_PRESETS.map((p) => p.id)).size).toBe(SAFE_AREA_PRESETS.length);
    for (const p of SAFE_AREA_PRESETS) expect(p.source.length).toBeGreaterThan(10);
    expect(isSafeAreaViewId('off')).toBe(true);
    expect(isSafeAreaViewId('tiktok')).toBe(true);
    expect(isSafeAreaViewId('nope')).toBe(false);
  });
});
