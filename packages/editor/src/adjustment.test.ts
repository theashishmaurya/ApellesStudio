// @apelles/editor — the adjustment-clip MODEL and OP layer (D-230).
//
// The pixel-level claims live in `chroma::edit`'s `preview_adjustment_tests`
// (one renderer for the preview and the export since D-449). This file covers
// the parts underneath them that those cannot reach cheaply: the validator
// both interfaces share, the reducer's refusals and the clip body's summary.
import { describe, expect, it } from 'vitest';

import {
  ADJUSTMENT_PARAMS,
  IDENTITY_ADJUSTMENT,
  applyOp,
  isAdjustmentClip,
  isGeneratedClip,
  isIdentityAdjustment,
  isTextClip,
  newAdjustmentClipFields,
  newAdjustmentLayer,
  type AdjustmentLayer,
  type Clip,
  type Timeline,
} from './timeline';
import { adjustmentSummary } from './adjustment';

function adjustmentClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'ADJ',
    name: 'Adjustment Clip',
    source_path: '',
    source_start: 0,
    duration: 24,
    source_len: 24,
    start_frame: 0,
    adjustment: { ...IDENTITY_ADJUSTMENT },
    ...overrides,
  };
}

function timelineWith(clips: Clip[]): Timeline {
  return { id: 'tl', name: 'tl', tracks: [{ kind: 'video', clips }] };
}

describe('newAdjustmentLayer — the validator both the GUI and MCP go through', () => {
  it('fills in identity for everything unspecified', () => {
    expect(newAdjustmentLayer({})).toEqual(IDENTITY_ADJUSTMENT);
  });

  it('merges against a base, so setting one parameter never resets another', () => {
    const base: AdjustmentLayer = { ...IDENTITY_ADJUSTMENT, exposure: 0.5, tint: -0.2 };
    const merged = newAdjustmentLayer({ saturation: 0.3 }, base);
    expect(merged).toEqual({ ...base, saturation: 0.3 });
  });

  it('clamps an out-of-range value rather than refusing it', () => {
    expect(newAdjustmentLayer({ exposure: 9 })).toMatchObject({ exposure: 1 });
    expect(newAdjustmentLayer({ contrast: -9 })).toMatchObject({ contrast: -1 });
  });

  it('refuses a non-finite or non-numeric value with a named error', () => {
    for (const bad of [Number.NaN, Infinity, '0.5' as unknown as number]) {
      const r = newAdjustmentLayer({ exposure: bad });
      expect(r, `${String(bad)} should be refused`).toHaveProperty('error');
    }
  });

  it('covers exactly the five documented parameters', () => {
    expect([...ADJUSTMENT_PARAMS].sort()).toEqual(
      ['contrast', 'exposure', 'saturation', 'temperature', 'tint'].sort(),
    );
    expect(Object.keys(IDENTITY_ADJUSTMENT).sort()).toEqual([...ADJUSTMENT_PARAMS].sort());
  });
});

describe('clip predicates', () => {
  it('separates adjustment clips from text clips and media clips', () => {
    const adj = adjustmentClip();
    expect(isAdjustmentClip(adj)).toBe(true);
    expect(isTextClip(adj)).toBe(false);
    expect(isGeneratedClip(adj)).toBe(true);

    const media: Clip = {
      id: 'M', name: 'M', source_path: '/tmp/a.mp4',
      source_start: 0, duration: 10, source_len: 10, start_frame: 0,
    };
    expect(isAdjustmentClip(media)).toBe(false);
    expect(isGeneratedClip(media)).toBe(false);
  });

  it('a new adjustment clip carries no media and an identity correction', () => {
    const fields = newAdjustmentClipFields(IDENTITY_ADJUSTMENT, 48);
    expect(fields.source_path).toBe('');
    expect(fields.duration).toBe(48);
    // `source_len` mirrors `duration` so a trim can extend it back out again.
    expect(fields.source_len).toBe(48);
    expect(isIdentityAdjustment(fields.adjustment as AdjustmentLayer)).toBe(true);
  });
});

describe('the set_adjustment_clip reducer', () => {
  it('patches only the parameters named', () => {
    const tl = timelineWith([adjustmentClip({ adjustment: { ...IDENTITY_ADJUSTMENT, exposure: 0.5 } })]);
    const next = applyOp(tl, {
      kind: 'set_adjustment_clip', track: 0, clip: 0, patch: { saturation: -0.4 },
    });
    expect(next.tracks[0].clips[0].adjustment).toEqual({
      ...IDENTITY_ADJUSTMENT, exposure: 0.5, saturation: -0.4,
    });
  });

  // The guard that matters most: patching an `adjustment` onto a media clip
  // would not merely mis-render it — both renderers branch on `is_adjustment`
  // BEFORE they look at `source_path`, so the clip's picture would vanish from
  // the edit while its file reference sat there looking fine.
  it('refuses to turn a media clip into an adjustment clip', () => {
    const media: Clip = {
      id: 'M', name: 'M', source_path: '/tmp/a.mp4',
      source_start: 0, duration: 10, source_len: 10, start_frame: 0,
    };
    const tl = timelineWith([media]);
    const next = applyOp(tl, {
      kind: 'set_adjustment_clip', track: 0, clip: 0, patch: { exposure: 1 },
    });
    expect(next.tracks[0].clips[0].adjustment).toBeUndefined();
    expect(next.tracks[0].clips[0].source_path).toBe('/tmp/a.mp4');
  });

  it('refuses on a locked track', () => {
    const tl: Timeline = {
      id: 'tl', name: 'tl',
      tracks: [{ kind: 'video', clips: [adjustmentClip()], locked: true }],
    };
    const next = applyOp(tl, {
      kind: 'set_adjustment_clip', track: 0, clip: 0, patch: { exposure: 1 },
    });
    expect(next.tracks[0].clips[0].adjustment).toEqual(IDENTITY_ADJUSTMENT);
  });
});

describe('adjustmentSummary — what the clip body shows', () => {
  it('says "neutral" when nothing is set', () => {
    expect(adjustmentSummary(IDENTITY_ADJUSTMENT)).toBe('neutral');
  });

  it('lists only the parameters actually in play, signed', () => {
    expect(adjustmentSummary({ ...IDENTITY_ADJUSTMENT, exposure: 0.3, saturation: -0.5 })).toBe(
      'EXP +0.30 · SAT -0.50',
    );
  });

  it('caps a busy correction so a short clip’s label cannot overflow', () => {
    const all: AdjustmentLayer = {
      exposure: 0.1, contrast: 0.2, saturation: 0.3, temperature: 0.4, tint: 0.5,
    };
    expect(adjustmentSummary(all)).toBe('EXP +0.10 · CON +0.20 · SAT +0.30 +2');
  });
});
