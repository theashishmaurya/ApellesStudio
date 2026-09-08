// @chroma/editor — the adjustment-clip MODEL and OP layer (D-229).
//
// The pixel-level claims live in the two real-render suites
// (`timelineExportAdjustment.ffmpeg.test.ts` and `chroma::edit`'s
// `preview_adjustment_tests`). This file covers the parts underneath them that
// those cannot reach cheaply: the validator both interfaces share, the reducer's
// refusals, and the filtergraph strings the exporter emits.
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
import { buildAdjustmentOps, buildAdjustmentSteps, clipAdjustmentOps, adjustmentSummary } from './adjustment';

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

describe('clipAdjustmentOps — what the exporter and the preview both resolve', () => {
  it('is null for a clip that is not an adjustment clip', () => {
    expect(clipAdjustmentOps({ opacity: 1 })).toBeNull();
  });

  it('is null for an identity correction, so a neutral clip costs nothing', () => {
    expect(clipAdjustmentOps({ adjustment: { ...IDENTITY_ADJUSTMENT }, opacity: 1 })).toBeNull();
  });

  it('is null at zero opacity — a fully un-mixed correction is a no-op', () => {
    const layer: AdjustmentLayer = { ...IDENTITY_ADJUSTMENT, exposure: 1 };
    expect(clipAdjustmentOps({ adjustment: layer, opacity: 0 })).toBeNull();
  });

  it('reads opacity STATICALLY as the mix amount', () => {
    const layer: AdjustmentLayer = { ...IDENTITY_ADJUSTMENT, exposure: 1 };
    const half = clipAdjustmentOps({ adjustment: layer, opacity: 0.5 });
    expect(half?.gain[0]).toBeCloseTo(1.5, 10);
    // …and defaults to a full mix when the clip has no explicit opacity.
    expect(clipAdjustmentOps({ adjustment: layer })?.gain[0]).toBeCloseTo(2, 10);
  });
});

describe('buildAdjustmentSteps — the emitted filtergraph', () => {
  const ops = buildAdjustmentOps({ ...IDENTITY_ADJUSTMENT, exposure: 0.5, saturation: -0.5 }, 1);
  const steps = buildAdjustmentSteps(ops, 'ov1', 'ov2', 1.5, 2.5);

  it('emits exactly two nodes, chained through one intermediate label', () => {
    expect(steps).toHaveLength(2);
    expect(steps[0]).toContain('[ov1]');
    expect(steps[0]).toContain('[ov2_adj]');
    expect(steps[1]).toContain('[ov2_adj]');
    expect(steps[1]).toContain('[ov2]');
  });

  // Verified empirically against real ffmpeg (D-229): without an explicit alpha
  // format the graph can settle on a format with no alpha plane and the colour
  // stage silently does less than it says. Pinned here so a refactor cannot
  // quietly drop it.
  it('pins format=rgba before the colour stages', () => {
    expect(steps[0]).toContain('format=rgba');
    expect(steps[0].indexOf('format=rgba')).toBeLessThan(steps[0].indexOf('lutrgb'));
  });

  it('gates BOTH nodes to the clip’s own timeline window', () => {
    for (const s of steps) expect(s).toContain("enable='between(t,1.5,2.5)'");
  });

  it('uses lutrgb for the gain stage and colorchannelmixer for the saturation matrix', () => {
    expect(steps[0]).toContain('lutrgb=');
    expect(steps[1]).toContain('colorchannelmixer=');
  });

  // The ±2 cap is ffmpeg's, on `colorchannelmixer` only. The whole reason the
  // gain lives in `lutrgb` is that it can exceed it; this asserts stage 2 never
  // does, across the parameter space, so no clamp or fallback is needed.
  it('never emits a colorchannelmixer coefficient outside ffmpeg’s ±2 range', () => {
    for (const saturation of [-1, -0.5, 0, 0.5, 1]) {
      for (const mix of [0, 0.5, 1]) {
        const o = buildAdjustmentOps({ ...IDENTITY_ADJUSTMENT, saturation }, mix);
        for (const row of o.sat) {
          for (const v of row) expect(Math.abs(v)).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it('never emits exponential notation, which ffmpeg’s option parser rejects', () => {
    const tiny = buildAdjustmentOps({ ...IDENTITY_ADJUSTMENT, exposure: 1e-7 }, 1);
    for (const s of buildAdjustmentSteps(tiny, 'a', 'b', 0, 1)) {
      expect(s).not.toMatch(/e[+-]\d/i);
    }
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
