/**
 * The pure rules behind the second-run harness fixes (B-347 F6, H11, H15, H17):
 * how a measured step is run, how targets are kept inside the visible edit area,
 * how the app is brought to the front and given back, and how phase numbers are
 * judged.
 */
import { describe, expect, it } from 'vitest';

import { activateApp, restoreFront } from './activation.ts';
import { checkBudget, DEFAULT_PERF_BUDGET, type PerfReport } from './budgets.ts';
import type { OpClient } from './client.ts';
import { measuredArgs, MIN_MEASURED_GESTURE_MS, summarizeEditMarks } from './perfMethod.ts';
import type { ViewSnap } from './snapshot.ts';
import { assertVisible, clampAtToVisible, OutsideVisibleArea, visibleBand, zoomToShowFrame } from './visibility.ts';

describe('measuredArgs (F6)', () => {
  const drag = { action: 'drag', durationMs: 450, steps: 15, watch: { selectors: ['.x'] }, target: { x: 1, y: 2 } };

  it('drops the rect watch and stretches a short drag, keeping its endpoints', () => {
    const m = measuredArgs(drag, false);
    expect(m.watchDropped).toBe(true);
    expect(m.stretched).toBe(true);
    expect(m.args).not.toHaveProperty('watch');
    expect(m.args.durationMs).toBe(MIN_MEASURED_GESTURE_MS);
    expect(Number(m.args.steps)).toBe(Math.round((MIN_MEASURED_GESTURE_MS / 1000) * 33));
    expect(m.args.target).toEqual({ x: 1, y: 2 });
  });

  it('spreads the moves over the legs of a path (steps is per segment)', () => {
    const m = measuredArgs({ ...drag, path: [{ x: 5, y: 5 }] }, false);
    expect(Number(m.args.steps)).toBe(Math.round(((MIN_MEASURED_GESTURE_MS / 1000) * 33) / 2));
  });

  it('never shortens a gesture that is already long, and leaves a click alone', () => {
    expect(measuredArgs({ ...drag, durationMs: 3000, steps: 90 }, false).args).toMatchObject({ durationMs: 3000, steps: 90 });
    const click = measuredArgs({ action: 'click', target: { x: 1, y: 2 } }, false);
    expect(click.stretched).toBe(false);
    expect(click.args).toEqual({ action: 'click', target: { x: 1, y: 2 } });
  });

  it('with the evidence flag the step is exactly what the scenario wrote', () => {
    const m = measuredArgs(drag, true);
    expect(m).toEqual({ args: drag, watchDropped: false, stretched: false });
  });

  it('a step that never had a watch reports none dropped', () => {
    expect(measuredArgs({ action: 'drag', durationMs: 2000, steps: 60 }, false).watchDropped).toBe(false);
  });
});

describe('summarizeEditMarks (F6)', () => {
  const entry = (name: string, duration: number) => ({ name, entryType: 'measure', startTime: 0, duration });

  it('summarises the previews and takes the last commit measures', () => {
    const out = summarizeEditMarks([
      ...[1, 2, 3, 4, 20].map((d) => entry('apelles:edit:preview', d)),
      entry('apelles:edit:commit-rendered', 12),
      entry('apelles:edit:commit-rendered', 30),
      entry('apelles:edit:commit-effects', 33),
      entry('apelles:edit:commit-frame', 38),
      entry('apelles:edit:commit-painted', 45),
    ]);
    expect(out).toMatchObject({
      previews: 5,
      previewP50Ms: 3,
      previewP95Ms: 20,
      previewMaxMs: 20,
      commitRenderedMs: 30,
      commitEffectsMs: 33,
      commitFrameMs: 38,
      commitPaintedMs: 45,
      paintMs: 7,
    });
  });

  it('is null when the app wrote no edit marks (a production web bundle)', () => {
    expect(summarizeEditMarks([])).toBeNull();
    expect(summarizeEditMarks([entry('other', 3)])).toBeNull();
  });
});

describe('phase budgets (F6)', () => {
  const frames = (over: object = {}) => ({ samples: 60, p50Ms: 16.7, p95Ms: 17, maxMs: 20, dropped: 0, ...over });
  const perf = (phases: PerfReport['phases'], whole = frames({ p95Ms: 17, maxMs: 120 })): PerfReport => ({
    frameBudgetMs: 16.7,
    frames: whole,
    phases,
    inputToFrame: { samples: 10, p95Ms: 12 },
    store: { commits: 1, firstCommitAfterInputMs: 30, lastCommitAfterLastInputMs: 10 },
  });

  it('judges the move phase on the frame budgets, so one release spike does not flap p95 or the dropped ratio', () => {
    // the whole-gesture worst frame is 120 ms (the release), but the drag itself was smooth
    const ok = checkBudget(perf({ move: frames(), release: frames({ maxMs: 30, samples: 5 }) }));
    expect(ok).toEqual({ ok: true, misses: [] });
  });

  it('judges the release on its own budget and says so', () => {
    const r = checkBudget(perf({ move: frames(), release: frames({ maxMs: 180, samples: 5 }) }));
    expect(r.ok).toBe(false);
    expect(r.misses).toEqual(['release frame 180 ms > 50 ms']);
    expect(checkBudget(perf({ move: frames(), release: frames({ maxMs: 180 }) }), { ...DEFAULT_PERF_BUDGET, releaseMaxMs: null }).ok).toBe(true);
  });

  it('a slow move phase still fails the move budgets', () => {
    const r = checkBudget(perf({ move: frames({ p95Ms: 40 }), release: null }));
    expect(r.misses).toEqual(['frame p95 40 ms > 33.3 ms']);
  });

  it('a gesture without a release falls back to the whole-gesture numbers', () => {
    expect(checkBudget(perf(undefined, frames({ maxMs: 120 }))).misses).toEqual(['worst frame 120 ms > 50 ms']);
  });
});

describe('visible targets (H11)', () => {
  const view: ViewSnap = { pxPerSec: 90, scrollLeft: 0, scrollTop: 0, fps: 30, startLeft: 32, rowHeight: 52, rowsTop: 50, rect: { x: 490, y: 100, width: 659, height: 400 } };

  it('the visible band is the edit area inset by a margin', () => {
    expect(visibleBand(view)).toEqual({ left: 506, right: 1133, top: 100, bottom: 484 });
  });

  it('assertVisible throws a typed error naming the area, with the frame when there is one', () => {
    expect(() => assertVisible({ x: 700, y: 200 }, view, 'a')).not.toThrow();
    try {
      assertVisible({ x: 1197, y: 200 }, view, 'clip c', 220);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OutsideVisibleArea);
      expect((e as OutsideVisibleArea).frame).toBe(220);
      expect((e as Error).message).toMatch(/clip c resolves to \(1197, 200\), outside the timeline's visible area \(x 506-1133/);
    }
  });

  it('zoomToShowFrame returns a multiplier that fits the frame, or null when none can', () => {
    // frame 400 (13.3 s): room = 1133 - 490 - 32 - 16 = 595 px, so < 45 px/s
    const z = zoomToShowFrame(view, 400);
    expect(z).not.toBeNull();
    expect((z ?? 1) * 90).toBeLessThan(45);
    expect((z ?? 1) * 90 * (400 / 30) + 32 + 490).toBeLessThanOrEqual(1133);
    expect(zoomToShowFrame(view, 10_000_000)).toBeNull();
    expect(zoomToShowFrame(view, 0)).toBeNull();
  });

  it('clampAtToVisible keeps a visible press, moves a hidden one onto the visible part, refuses a wholly hidden element', () => {
    const visible = clampAtToVisible({ x: 600, y: 120, width: 200, height: 40 }, { fx: 0.5, fy: 0.3 }, view);
    expect(visible).toEqual({ at: { fx: 0.5, fy: 0.3 }, clamped: false });
    // a clip from x 1000 to 1400: its centre (1200) is under the Inspector
    const hidden = clampAtToVisible({ x: 1000, y: 120, width: 400, height: 40 }, { fy: 0.3 }, view);
    expect(hidden).toEqual({ at: { fy: 0.3, fx: (1133 - 1000) / 400, dx: 0 }, clamped: true });
    expect('error' in clampAtToVisible({ x: 1200, y: 120, width: 100, height: 40 }, undefined, view)).toBe(true);
  });
});

describe('activation (H15)', () => {
  class Stub implements OpClient {
    calls: { op: string; args: Record<string, unknown> }[] = [];
    reply: unknown;
    fail = false;
    constructor(reply: unknown) {
      this.reply = reply;
    }
    async op<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
      this.calls.push({ op, args });
      if (this.fail) throw new Error('no such op');
      return this.reply as T;
    }
  }

  it('brings Apelles forward and remembers the app that had the front', async () => {
    const c = new Stub({ previous: { pid: 501, name: 'Terminal' }, now: { pid: 900, name: 'Apelles' }, active: true, windowKey: true });
    const state = await activateApp(c);
    expect(c.calls).toEqual([{ op: 'debug_activate_app', args: {} }]);
    expect(state.restorePid).toBe(501);
    expect(state.notes.join(' ')).toMatch(/behind Terminal/);
  });

  it('hands the front back with the remembered pid, and only then', async () => {
    const c = new Stub({});
    expect(await restoreFront(c, { restorePid: null, notes: [] })).toEqual([]);
    expect(c.calls).toEqual([]);
    expect(await restoreFront(c, { restorePid: 501, notes: [] })).toEqual([]);
    expect(c.calls).toEqual([{ op: 'debug_activate_app', args: { restorePid: 501 } }]);
  });

  it('already in front: nothing to give back', async () => {
    const c = new Stub({ previous: { pid: 900, name: 'Apelles' }, now: { pid: 900, name: 'Apelles' }, active: true, windowKey: true });
    expect((await activateApp(c)).restorePid).toBeNull();
  });

  it('a window that did not become key is reported, not hidden', async () => {
    const c = new Stub({ previous: { pid: 501 }, now: { pid: 900 }, active: true, windowKey: false });
    expect((await activateApp(c)).notes.join(' ')).toMatch(/not key/);
  });

  it('an app that cannot be activated does not fail the run, and nothing is handed back', async () => {
    const c = new Stub({});
    c.fail = true;
    const state = await activateApp(c);
    expect(state.restorePid).toBeNull();
    expect(state.notes[0]).toMatch(/could not bring Apelles to the front/);
    expect(await restoreFront(c, { restorePid: 7, notes: [] })).toEqual([expect.stringMatching(/could not hand the front back to pid 7/)]);
  });
});
