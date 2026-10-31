// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { EDIT_PERF, EDIT_PERF_PREFIX, perfMark, perfMeasure, perfMeasureAfterPaint } from './editPerf';

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

  it('measures commit -> painted on the frame after', async () => {
    perfMark(EDIT_PERF.commit);
    perfMeasureAfterPaint(EDIT_PERF.commitPainted, EDIT_PERF.commit);
    expect(names()).toEqual([`mark:${EDIT_PERF.commit}`]);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(names()).toContain(`measure:${EDIT_PERF.commitPainted}`);
  });
});
