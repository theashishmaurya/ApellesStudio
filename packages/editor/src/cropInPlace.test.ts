/**
 * @apelles/editor — crop that keeps the picture in place (v0.3.0, D-443).
 * The geometry has a correct answer: after the write, the kept part of the
 * source must paint on exactly the pixels it painted on before.
 */
import { describe, expect, it } from 'vitest';

import {
  MIN_CROP_KEEP,
  clampCropInsets,
  cropEditOp,
  cropKeptRect,
  cropPlacement,
  cropSourceRect,
  type CropInsetValues,
} from './cropInPlace';
import { applyOp, type Clip, type EditOp, type Timeline } from './timeline';
import { clipBoxOrigin, paintedClipBox } from './transformGeometry';
import { resolveClipBoxTransform } from './clipKeyframes';

const NONE: CropInsetValues = { crop_left: 0, crop_top: 0, crop_right: 0, crop_bottom: 0 };
/** A 16:9 source in a 16:9 frame at scale 1. */
const NATURAL = { width: 1, height: 1 };

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'c',
    name: 'shot',
    source_path: '/m/shot.mp4',
    source_start: 0,
    duration: 100,
    source_len: 100,
    source_fps: 24,
    start_frame: 0,
    ...over,
  } as Clip;
}

function timeline(c: Clip): Timeline {
  return { id: 't', name: 'T', rate: 24, tracks: [{ kind: 'video', clips: [c] }] } as unknown as Timeline;
}

/** Where the source pixel at fraction (u, v) of the SOURCE lands on screen. */
function sourcePointOnScreen(c: Clip, u: number, v: number) {
  const eff = resolveClipBoxTransform(c, 0);
  const box = paintedClipBox(c, NATURAL, eff);
  const src = cropSourceRect(box, eff);
  return { x: src.left + u * src.width, y: src.top + v * src.height };
}

describe('clampCropInsets', () => {
  it('keeps every inset in 0…1 and at least the minimum on each axis, the moved edge giving way', () => {
    expect(clampCropInsets({ ...NONE, crop_left: -1, crop_top: 2 })).toEqual({
      crop_left: 0,
      crop_top: 1 - MIN_CROP_KEEP,
      crop_right: 0,
      crop_bottom: 0,
    });
    const pushed = clampCropInsets({ ...NONE, crop_left: 0.6, crop_right: 0.6 }, 'crop_right');
    expect(pushed.crop_left).toBe(0.6);
    expect(pushed.crop_right).toBeCloseTo(1 - MIN_CROP_KEEP - 0.6, 10);
  });
});

describe('cropSourceRect / cropKeptRect', () => {
  it('are inverses: the kept part of the source of a box is the box', () => {
    const box = { left: 0.2, top: 0.1, width: 0.5, height: 0.4 };
    const crop = { crop_left: 0.1, crop_top: 0.2, crop_right: 0.15, crop_bottom: 0.05 };
    const kept = cropKeptRect(cropSourceRect(box, crop), crop);
    expect(kept.left).toBeCloseTo(box.left, 12);
    expect(kept.top).toBeCloseTo(box.top, 12);
    expect(kept.width).toBeCloseTo(box.width, 12);
    expect(kept.height).toBeCloseTo(box.height, 12);
  });
});

describe('cropPlacement', () => {
  it('scales and moves an un-overridden box so the kept part stays put', () => {
    const p = cropPlacement({
      box: { left: 0, top: 0, width: 1, height: 1 },
      crop: NONE,
      next: { ...NONE, crop_left: 0.12, crop_right: 0.12 },
      natural: NATURAL,
      origin: { x: 0, y: 0 },
      override: false,
    });
    expect(p).toEqual({ position_x: 0.12, position_y: 0, scale: expect.closeTo(0.76, 10) });
  });

  it('writes the new box as the override when the clip has one', () => {
    const p = cropPlacement({
      box: { left: 0, top: 0, width: 1, height: 0.5 },
      crop: NONE,
      next: { ...NONE, crop_top: 0.5 },
      natural: NATURAL,
      origin: { x: 0, y: 0 },
      override: true,
    });
    expect(p).toEqual({ position_x: 0, position_y: 0.25, box_width: 1, box_height: 0.25 });
  });
});

describe('cropEditOp', () => {
  const target = (c: Clip) => ({ track: 0, index: 0, clip: c });
  const apply = (c: Clip, op: EditOp | null) => (op ? applyOp(timeline(c), op).tracks[0].clips[0] : c);

  it('a static clip: one set_clip_transform, and every source pixel that is kept stays where it was', () => {
    const before = clip({ scale: 0.8, position_x: 0.05, position_y: 0.1, scaling: 'fit' } as Partial<Clip>);
    const next = { crop_left: 0.1, crop_top: 0.2, crop_right: 0.05, crop_bottom: 0.1 };
    const op = cropEditOp(target(before), 0, NATURAL, next);
    expect(op?.kind).toBe('set_clip_transform');
    const after = apply(before, op);
    expect(after.crop_left).toBe(0.1);
    for (const [u, v] of [
      [0.1, 0.2],
      [0.5, 0.5],
      [0.95, 0.9],
    ]) {
      const a = sourcePointOnScreen(before, u, v);
      const b = sourcePointOnScreen(after, u, v);
      expect(b.x).toBeCloseTo(a.x, 10);
      expect(b.y).toBeCloseTo(a.y, 10);
    }
  });

  it('un-cropping back to nothing restores the original placement', () => {
    const before = clip({ scale: 0.8, position_x: 0.05, position_y: 0.1 });
    const cropped = apply(before, cropEditOp(target(before), 0, NATURAL, { ...NONE, crop_left: 0.25 }));
    const back = apply(cropped, cropEditOp(target(cropped), 0, NATURAL, NONE));
    expect(back.scale).toBeCloseTo(0.8, 10);
    expect(back.position_x).toBeCloseTo(0.05, 10);
    expect(back.position_y).toBeCloseTo(0.1, 10);
  });

  it('a keyframed crop: the insets are keyed at the playhead instead', () => {
    const before = clip({ chroma_keyframes: [{ frame: 0, params: { crop_left: 0 } }] });
    const op = cropEditOp(target(before), 40, NATURAL, { ...NONE, crop_left: 0.3 });
    expect(op?.kind).toBe('set_clip_keyframes');
    const after = apply(before, op);
    expect(after.chroma_keyframes?.find((k) => k.frame === 40)?.params.crop_left).toBe(0.3);
  });

  it('a keyframed position or a rotation: the insets alone, the placement untouched', () => {
    const moving = clip({ position_x: 0.2, chroma_keyframes: [{ frame: 0, params: { position_x: 0.2 } }] });
    const op = cropEditOp(target(moving), 0, NATURAL, { ...NONE, crop_left: 0.1 });
    expect(op).toMatchObject({ kind: 'set_clip_transform', crop_left: 0.1, position_x: 0.2, scale: 1 });
    const turned = clip({ rotation: 15 });
    expect(cropEditOp(target(turned), 0, NATURAL, { ...NONE, crop_left: 0.1 })).toMatchObject({ scale: 1, position_x: 0 });
  });

  it('nothing for a title, and nothing when the crop does not change', () => {
    expect(cropEditOp(target(clip({ text: { content: 'Hi', font: 'Inter', size: 0.1, color: '#ffffff' } })), 0, NATURAL, { ...NONE, crop_left: 0.1 })).toBeNull();
    expect(cropEditOp(target(clip()), 0, NATURAL, NONE)).toBeNull();
  });

  it('the fit origin is honoured (B-328)', () => {
    const c = clip({ scaling: 'fit' } as Partial<Clip>);
    // A 4:3 source fitted into 16:9: natural is narrower, origin centres it.
    const natural = { width: 0.75, height: 1 };
    const origin = clipBoxOrigin(c, natural);
    expect(origin.x).toBeCloseTo(0.125, 10);
    const op = cropEditOp(target(c), 0, natural, { ...NONE, crop_left: 0.2 });
    // The kept part's left edge = the source's left edge + 0.2 of its width.
    expect(op).toMatchObject({ position_x: expect.closeTo(0.2 * 0.75, 10), scale: expect.closeTo(0.8, 10) });
  });
});
