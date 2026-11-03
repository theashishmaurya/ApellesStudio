/**
 * releaseTrace.test.ts - the release tracer writes what it saw after a commit
 * mark, and nothing before it (B-374, D-437 S11).
 */
import { describe, expect, it } from 'vitest';

import { EDIT_PERF } from '@apelles/editor/src/editPerfNames';
import { armReleaseTrace, TRACE_PREFIX } from './releaseTrace';

const busy = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // spin: a stand-in for a forced layout / a slow callback
  }
};

const traced = () =>
  performance
    .getEntriesByType('measure')
    .filter((e) => e.name.startsWith(TRACE_PREFIX))
    .map((e) => e.name.slice(TRACE_PREFIX.length));

describe('armReleaseTrace', () => {
  // Installed once per page; this file arms it first so every wrapper is in place.
  Element.prototype.getBoundingClientRect = function () {
    busy(2);
    return new DOMRect();
  };
  const armed = armReleaseTrace(300);

  it('reports the window it armed', () => {
    expect(armed).toMatchObject({ armed: true, windowMs: 300 });
  });

  it('records nothing outside a commit window', () => {
    performance.clearMeasures();
    document.createElement('div').getBoundingClientRect();
    expect(traced()).toEqual([]);
  });

  it('after a commit mark, records a slow layout read with its caller, a slow timer, and the window start', async () => {
    performance.clearMeasures();
    performance.mark(EDIT_PERF.press);
    performance.mark(EDIT_PERF.commit);
    function readsLayoutInAnEffect() {
      document.createElement('div').getBoundingClientRect();
    }
    readsLayoutInAnEffect();
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        busy(2);
        resolve();
      }, 0),
    );
    const rows = traced();
    expect(rows).toContain('t0|commit');
    expect(rows.some((r) => r.startsWith('layout|getBoundingClientRect') && r.includes('readsLayoutInAnEffect'))).toBe(
      true,
    );
    expect(rows.some((r) => r.startsWith('timeout|'))).toBe(true);
  });

  it('0 disarms: a later commit opens no window', () => {
    armReleaseTrace(0);
    performance.clearMeasures();
    performance.mark(EDIT_PERF.commit);
    expect(traced().filter((r) => r.startsWith('t0|'))).toEqual([]);
  });
});
