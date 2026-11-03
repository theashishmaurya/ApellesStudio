import { describe, expect, it } from 'vitest';

import {
  INITIAL_OPEN_PROGRESS,
  OPEN_PHASES,
  isOpenPhase,
  openPhaseLabel,
  openProgressView,
  reduceOpenProgress,
  type OpenProgressAction,
  type OpenProgressState,
} from './openProgress';

const run = (actions: OpenProgressAction[], from: OpenProgressState = INITIAL_OPEN_PROGRESS) =>
  actions.reduce(reduceOpenProgress, from);

const started = run([{ type: 'start', openId: 1, kind: 'open', projectName: 'Nemotron' }]);

describe('reduceOpenProgress (B-369)', () => {
  it('starts on reading, active, with the project name', () => {
    expect(started).toMatchObject({ openId: 1, active: true, phase: 'reading', projectName: 'Nemotron', done: 0, total: 0 });
  });

  it('walks the phases forward and keeps the media count', () => {
    const s = run(
      [
        { type: 'progress', openId: 1, phase: 'media', done: 0, total: 288 },
        { type: 'progress', openId: 1, phase: 'media', done: 120, total: 288 },
      ],
      started,
    );
    expect(s).toMatchObject({ phase: 'media', done: 120, total: 288 });
    const next = reduceOpenProgress(s, { type: 'progress', openId: 1, phase: 'preview' });
    expect(next).toMatchObject({ phase: 'preview', done: 0, total: 0 });
  });

  it('never moves backwards: a late event of an earlier phase is dropped', () => {
    const s = run([{ type: 'progress', openId: 1, phase: 'timeline' }], started);
    expect(reduceOpenProgress(s, { type: 'progress', openId: 1, phase: 'media', done: 288, total: 288 })).toBe(s);
  });

  it('a throttled count that arrives behind a newer one does not lower it', () => {
    const s = run([{ type: 'progress', openId: 1, phase: 'media', done: 200, total: 288 }], started);
    expect(reduceOpenProgress(s, { type: 'progress', openId: 1, phase: 'media', done: 150, total: 288 })).toBe(s);
  });

  it("drops another open's events, by id rather than by arrival order", () => {
    const second = reduceOpenProgress(started, { type: 'start', openId: 2, kind: 'open', projectName: 'B' });
    expect(reduceOpenProgress(second, { type: 'progress', openId: 1, phase: 'media', done: 5, total: 9 })).toBe(second);
    expect(reduceOpenProgress(second, { type: 'finish', openId: 1 })).toBe(second);
  });

  it('ignores progress once finished, and fail ends it like finish', () => {
    const done = reduceOpenProgress(started, { type: 'finish', openId: 1 });
    expect(done.active).toBe(false);
    expect(reduceOpenProgress(done, { type: 'progress', openId: 1, phase: 'grades' })).toBe(done);
    expect(reduceOpenProgress(started, { type: 'fail', openId: 1 }).active).toBe(false);
  });

  it('clamps a count to its total and rejects junk', () => {
    const s = reduceOpenProgress(started, { type: 'progress', openId: 1, phase: 'media', done: 400, total: 288 });
    expect(s).toMatchObject({ done: 288, total: 288 });
    const junk = reduceOpenProgress(started, { type: 'progress', openId: 1, phase: 'media', done: Number.NaN, total: -3 });
    expect(junk).toMatchObject({ done: 0, total: 0 });
  });
});

describe('openProgressView / labels (B-369)', () => {
  it('says the media count and gives a determinate fraction', () => {
    const s = reduceOpenProgress(started, { type: 'progress', openId: 1, phase: 'media', done: 120, total: 288 });
    const v = openProgressView(s);
    expect(v).toMatchObject({ label: 'Checking media (120/288)…', step: 2, steps: OPEN_PHASES.length });
    expect(v?.fraction).toBeCloseTo(120 / 288);
  });

  it('is indeterminate where a phase has no count, and null when idle', () => {
    expect(openProgressView(started)?.fraction).toBeNull();
    expect(openProgressView(INITIAL_OPEN_PROGRESS)).toBeNull();
  });

  it('has words for every phase', () => {
    expect(OPEN_PHASES.map((p) => openPhaseLabel(p, 0, 0))).toEqual([
      'Reading project…',
      'Checking media…',
      'Decoding the first frame…',
      'Loading grades…',
      'Building timeline…',
      'Preparing previews…',
    ]);
    expect(openPhaseLabel('reading', 0, 0, 'new')).toBe('Creating project…');
  });

  it('isOpenPhase guards the wire value', () => {
    expect(isOpenPhase('media')).toBe(true);
    expect(isOpenPhase('nope')).toBe(false);
    expect(isOpenPhase(3)).toBe(false);
  });
});
