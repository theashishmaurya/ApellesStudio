import { describe, expect, it } from 'vitest';

import { IDLE_MAX_WAIT_MS, readPerfEntries, waitForIdle, type IdleDeps, type PerfSource } from './perfEntries';

function entry(name: string, entryType: string, startTime: number, duration = 0): PerformanceEntry {
  return { name, entryType, startTime, duration, toJSON: () => ({}) } as PerformanceEntry;
}

function source(entries: PerformanceEntry[]) {
  const cleared: string[] = [];
  const src: PerfSource = {
    getEntries: () => entries,
    clearMarks: (n) => void cleared.push(`mark:${n}`),
    clearMeasures: (n) => void cleared.push(`measure:${n}`),
  };
  return { src, cleared };
}

describe('readPerfEntries', () => {
  const entries = [
    entry('apelles:edit:press', 'mark', 10.04),
    entry('apelles:edit:preview', 'measure', 12.26, 3.14),
    entry('other:thing', 'mark', 13),
    entry('apelles:edit:fetch', 'resource', 14, 5),
  ];

  it('keeps only marks and measures under the prefix, rounded to 0.1 ms', () => {
    const { src } = source(entries);
    expect(readPerfEntries(src, 'apelles:')).toEqual([
      { name: 'apelles:edit:press', entryType: 'mark', startTime: 10, duration: 0 },
      { name: 'apelles:edit:preview', entryType: 'measure', startTime: 12.3, duration: 3.1 },
    ]);
    expect(readPerfEntries(src, 'apelles:edit:prev')).toHaveLength(1);
  });

  it('defaults to the apelles: prefix and does not clear unless asked', () => {
    const { src, cleared } = source(entries);
    expect(readPerfEntries(src)).toHaveLength(2);
    expect(cleared).toEqual([]);
  });

  it('clears exactly the entries it returned', () => {
    const { src, cleared } = source(entries);
    readPerfEntries(src, 'apelles:', true);
    expect(cleared.sort()).toEqual([
      'mark:apelles:edit:press',
      'mark:apelles:edit:preview',
      'measure:apelles:edit:press',
      'measure:apelles:edit:preview',
    ]);
  });
});

/** A manual clock and frame scheduler: `frames` is the list of frame timestamps to deliver in order. */
function fakeDeps(frames: number[]) {
  let clock = 0;
  let pending: ((ts: number) => void) | null = null;
  let timer: { cb: () => void; at: number } | null = null;
  const deps: IdleDeps = {
    raf: (cb) => {
      pending = cb;
      return 1;
    },
    cancelRaf: () => {
      pending = null;
    },
    now: () => clock,
    setTimer: (cb, ms) => {
      timer = { cb, at: clock + ms };
      return timer;
    },
    clearTimer: () => {
      timer = null;
    },
  };
  /** Deliver frames until the scheduler stops asking, or the timer is due. */
  const run = () => {
    for (const ts of frames) {
      if (timer && ts >= timer.at) break;
      clock = ts;
      const cb = pending;
      pending = null;
      if (!cb) return;
      cb(ts);
    }
    if (timer) {
      clock = timer.at;
      timer.cb();
    }
  };
  return { deps, run };
}

describe('waitForIdle', () => {
  it('resolves once the frames have been on time for quietMs', async () => {
    const t = fakeDeps(Array.from({ length: 40 }, (_, i) => (i + 1) * 16));
    const p = waitForIdle(t.deps, 100);
    t.run();
    const r = await p;
    expect(r.reached).toBe(true);
    expect(r.waitedMs).toBeGreaterThanOrEqual(100);
    expect(r.waitedMs).toBeLessThan(130);
  });

  it('a long frame restarts the quiet period', async () => {
    // on-time frames to t=128 (not yet 150 ms quiet), a stall to t=280, then on time again
    const frames = [16, 32, 48, 64, 80, 96, 112, 128, 280];
    for (let t = 296; t <= 456; t += 16) frames.push(t);
    const t = fakeDeps(frames);
    const p = waitForIdle(t.deps, 150);
    t.run();
    const r = await p;
    expect(r.reached).toBe(true);
    // quiet restarts at the stall's end (t=280), so it cannot resolve before 430
    expect(r.waitedMs).toBeGreaterThanOrEqual(430);
  });

  it('gives up at the cap when frames never come (a throttled window), and says so', async () => {
    const t = fakeDeps([]);
    const p = waitForIdle(t.deps, 200, 800);
    t.run();
    expect(await p).toEqual({ waitedMs: 800, reached: false });
  });

  it('never waits longer than the global cap', async () => {
    const t = fakeDeps([]);
    const p = waitForIdle(t.deps, 100, 60_000);
    t.run();
    expect((await p).waitedMs).toBe(IDLE_MAX_WAIT_MS);
  });

  it('quietMs 0 resolves immediately', async () => {
    const t = fakeDeps([]);
    expect(await waitForIdle(t.deps, 0)).toEqual({ waitedMs: 0, reached: true });
  });
});
