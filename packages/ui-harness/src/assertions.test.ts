/** D-434 — the judge: paths, references with arithmetic, every operator, live feedback, cursor. */
import { describe, expect, it } from 'vitest';

import { evaluate, getPath, resolveValue, rootsOf } from './assertions.ts';

const scope = {
  timeline: { clips: { a: { end: 105, startFrame: 0 }, b: { startFrame: 105 } }, tracks: [[1, 2, 3]], durationFrames: 270 },
  before: { clips: { a: { end: 90, startFrame: 0 } }, durationFrames: 270 },
  state: { playhead: 121.4, playing: false, selection: [{ track: 0, id: 'x' }] },
};

describe('paths and references', () => {
  it('walks objects and arrays, with .length on arrays', () => {
    expect(getPath(scope, 'timeline.clips.a.end')).toBe(105);
    expect(getPath(scope, 'timeline.tracks.0.length')).toBe(3);
    expect(getPath(scope, 'state.selection.0.id')).toBe('x');
    expect(getPath(scope, 'timeline.clips.zz.end')).toBeUndefined();
  });

  it('a reference resolves with arithmetic, and a non-number with arithmetic is NaN rather than a guess', () => {
    expect(resolveValue({ ref: 'before.clips.a.end', plus: 15 }, scope)).toBe(105);
    expect(resolveValue({ ref: 'before.durationFrames', times: 2 }, scope)).toBe(540);
    expect(resolveValue({ ref: 'state.selection.0.id' }, scope)).toBe('x');
    expect(Number.isNaN(resolveValue({ ref: 'state.selection.0.id', plus: 1 }, scope))).toBe(true);
  });

  it('rootsOf names every root the runner must fetch', () => {
    expect(rootsOf({ path: 'timeline.clips.a.end', value: { ref: 'before.clips.a.end' } })).toEqual(['timeline', 'before']);
    expect(rootsOf({ path: 'timeline.x', op: 'unchanged', from: 'snap' })).toEqual(['timeline', 'snap']);
    expect(rootsOf({ live: { selector: 's', prop: 'x', minDistinct: 2 } })).toEqual(['last']);
  });
});

describe('operators', () => {
  it('eq / near / gt / in / truthy, with messages that stand on their own', () => {
    expect(evaluate({ path: 'timeline.clips.a.end', value: { ref: 'before.clips.a.end', plus: 15 } }, scope).ok).toBe(true);
    const near = evaluate({ path: 'state.playhead', op: 'near', value: 120, tolerance: 2 }, scope);
    expect(near.ok).toBe(true);
    expect(near.message).toBe('state.playhead = 121.4 — expected ≈ 120 ±2');
    expect(evaluate({ path: 'state.playhead', op: 'near', value: 120 }, scope).ok).toBe(false);
    expect(evaluate({ path: 'timeline.durationFrames', op: 'gt', value: 200 }, scope).ok).toBe(true);
    expect(evaluate({ path: 'timeline.durationFrames', op: 'gt', value: 'x' }, scope).ok).toBe(false);
    expect(evaluate({ path: 'timeline.clips.b.startFrame', op: 'in', value: [90, 105] }, scope).ok).toBe(true);
    expect(evaluate({ path: 'state.playing', op: 'falsy' }, scope).ok).toBe(true);
  });

  it('changed / unchanged compare the same path in a captured snapshot', () => {
    expect(evaluate({ path: 'timeline.durationFrames', op: 'unchanged', from: 'before' }, scope).ok).toBe(true);
    expect(evaluate({ path: 'timeline.clips.a.end', op: 'changed', from: 'before' }, scope).ok).toBe(true);
    expect(evaluate({ path: 'timeline.clips.a.startFrame', op: 'changed', from: 'before' }, scope).ok).toBe(false);
    // A path missing from the live side is never "unchanged".
    expect(evaluate({ path: 'timeline.clips.zz.end', op: 'unchanged', from: 'before' }, scope).ok).toBe(false);
    expect(evaluate({ path: 'timeline.x', op: 'changed' }, scope).message).toMatch(/needs 'from'/);
  });

  it('a label prefixes the message', () => {
    expect(evaluate({ path: 'state.playing', op: 'truthy', label: 'playing' }, scope).message).toMatch(/^playing: /);
  });
});

describe('live feedback and cursor', () => {
  const rect = (x: number, width: number) => ({ x, y: 0, width, height: 10 });
  const live = {
    last: {
      watch: [
        { t: 0, rects: { '.b': [rect(100, 50)] }, cursor: 'default' },
        { t: 16, rects: { '.b': [rect(110, 50)] }, cursor: 'ew-resize' },
        { t: 33, rects: { '.b': [rect(120, 50)] }, cursor: 'ew-resize' },
        { t: 50, rects: { '.b': [rect(120, 50)] } },
      ],
    },
  };

  it('counts distinct positions across the frames of the gesture', () => {
    expect(evaluate({ live: { selector: '.b', prop: 'x', minDistinct: 3 } }, live).ok).toBe(true);
    expect(evaluate({ live: { selector: '.b', prop: 'width', minDistinct: 2 } }, live).ok).toBe(false);
    expect(evaluate({ live: { selector: '.b', prop: 'right', minDistinct: 3 } }, live).ok).toBe(true);
  });

  it('says what to do when nothing was watched', () => {
    const v = evaluate({ live: { selector: '.b', prop: 'x', minDistinct: 1 } }, { last: {} });
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/pass watch/);
  });

  it('the cursor check passes when any frame showed one of the cursors', () => {
    expect(evaluate({ cursor: { anyOf: ['col-resize', 'ew-resize'] } }, live).ok).toBe(true);
    expect(evaluate({ cursor: { anyOf: ['grab'] } }, live).message).toContain('["default","ew-resize"]');
  });
});
