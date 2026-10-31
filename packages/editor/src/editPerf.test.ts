// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { EDIT_PERF, EDIT_PERF_PREFIX, perfMark, perfMeasure, perfMeasureAfterPaint, perfMeasureAtFrame } from './editPerf';

const names = () => performance.getEntries().filter((e) => e.name.startsWith(EDIT_PERF_PREFIX)).map((e) => `${e.entryType}:${e.name}`);

afterEach(() => {
  performance.clearMarks();
  performance.clearMeasures();
});

describe('editPerf (development builds only)', () => {
  it('every name lives under the one prefix the debug op reads', () => {
    for (const n of Object.values(EDIT_PERF)) expect(n.startsWith(EDIT_PERF_PREFIX)).toBe(true);
  });

  it('writes a mark and a measure from it', () => {
    perfMark(EDIT_PERF.previewStart);
    perfMeasure(EDIT_PERF.preview, EDIT_PERF.previewStart);
    expect(names()).toEqual([`mark:${EDIT_PERF.previewStart}`, `measure:${EDIT_PERF.preview}`]);
  });

  it('a measure whose start mark was cleared is skipped, not thrown', () => {
    expect(() => perfMeasure(EDIT_PERF.commitRendered, EDIT_PERF.commit)).not.toThrow();
    expect(names()).toEqual([]);
  });

  it('commit-frame is measured at the rAF callback, before any posted task', async () => {
    perfMark(EDIT_PERF.commit);
    perfMeasureAtFrame(EDIT_PERF.commitFrame, EDIT_PERF.commit);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(names()).toContain(`measure:${EDIT_PERF.commitFrame}`);
  });

  it('commit-painted runs after a task posted from the frame callback, not at the callback', async () => {
    perfMark(EDIT_PERF.commit);
    perfMeasureAfterPaint(EDIT_PERF.commitPainted, EDIT_PERF.commit);
    const order: string[] = [];
    // registered after the measure, so it runs after the helper's own rAF callback
    requestAnimationFrame(() => {
      order.push(`frame:${names().includes(`measure:${EDIT_PERF.commitPainted}`)}`);
    });
    expect(names()).toEqual([`mark:${EDIT_PERF.commit}`]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // at the frame callback the painted measure did not exist yet; afterwards it does
    expect(order).toEqual(['frame:false']);
    expect(names()).toContain(`measure:${EDIT_PERF.commitPainted}`);
  });

  it('commit-painted is not shorter than commit-frame for the same commit', async () => {
    perfMark(EDIT_PERF.commit);
    perfMeasureAtFrame(EDIT_PERF.commitFrame, EDIT_PERF.commit);
    perfMeasureAfterPaint(EDIT_PERF.commitPainted, EDIT_PERF.commit);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const d = (n: string) => performance.getEntriesByName(n, 'measure')[0].duration;
    expect(d(EDIT_PERF.commitPainted)).toBeGreaterThanOrEqual(d(EDIT_PERF.commitFrame));
  });
});
