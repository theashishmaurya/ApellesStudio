// @vitest-environment jsdom
/**
 * B-196 regression tests — a failed `presets.json` read must never be
 * treated as "the user genuinely has zero presets." Before this fix,
 * `loadPresets`'s `catch` did `setPresets([])` on ANY load failure, and the
 * very next preset edit's debounced `savePresetsToBackend` then wrote that
 * empty list back over the real file on disk — permanent, silent loss of
 * the user's whole preset library.
 *
 * These drive the real `usePresets` hook (not a reimplementation) through
 * both the failure path and the happy path, and assert on the one thing
 * that actually matters: whether `invoke('save_presets', ...)` is ever
 * called with an empty (or otherwise wrong) list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { usePresets } = await import('./usePresets');
const { Invokes } = await import('../components/ui/AppProperties');
const { INITIAL_ADJUSTMENTS } = await import('../utils/adjustments');

/** Every `save_presets` call this mock has seen, across the whole test. */
function saveCalls() {
  return invoke.mock.calls.filter(([cmd]) => cmd === Invokes.SavePresets);
}

beforeEach(() => {
  invoke.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a presets.json read that fails', () => {
  it('never lets the next edit persist an empty list over the real file (B-196)', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === Invokes.LoadPresets) throw new Error("EACCES: permission denied, open 'presets.json'");
      throw new Error(`unexpected invoke in this test: ${cmd}`);
    });

    const { result } = renderHook(() => usePresets(INITIAL_ADJUSTMENTS));

    await waitFor(() => expect(result.current.loadStatus).toBe('error'));
    // Still empty in memory — but for the right reason (nothing loaded yet),
    // not because a failure was silently treated as "zero presets".
    expect(result.current.presets).toEqual([]);
    expect(result.current.loadError).not.toBeNull();

    // Fake timers BEFORE the edit: `savePresetsToBackend` schedules its
    // `lodash.debounce` timer synchronously inside `addPreset`, so the timer
    // has to be fake from the moment it's created, or advancing the fake
    // clock later does nothing to it.
    vi.useFakeTimers();

    // The exact trigger from the bug report: the user adds a preset while
    // the list is (unknowingly) in this failed state.
    act(() => {
      result.current.addPreset('My Look');
    });

    // Let the 500ms debounce on `savePresetsToBackend` elapse.
    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(saveCalls()).toHaveLength(0);
  });
});

describe('a presets.json read that succeeds', () => {
  it('still persists a real edit once the load is known-good', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === Invokes.LoadPresets) return [];
      if (cmd === Invokes.SavePresets) return null;
      throw new Error(`unexpected invoke in this test: ${cmd}`);
    });

    const { result } = renderHook(() => usePresets(INITIAL_ADJUSTMENTS));

    await waitFor(() => expect(result.current.loadStatus).toBe('ready'));

    // See the sibling test above for why this comes before the edit.
    vi.useFakeTimers();
    act(() => {
      result.current.addPreset('My Look');
    });

    act(() => {
      vi.advanceTimersByTime(600);
    });

    const calls = saveCalls();
    expect(calls).toHaveLength(1);
    const [, args] = calls[0] as [string, { presets: Array<{ preset?: { name?: string } }> }];
    expect(args.presets).toEqual(
      expect.arrayContaining([expect.objectContaining({ preset: expect.objectContaining({ name: 'My Look' }) })]),
    );
  });
});

describe('a presets.json refresh that fails after an earlier successful load', () => {
  it('keeps the last known-good presets in memory and still refuses to persist', async () => {
    let loadCount = 0;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === Invokes.LoadPresets) {
        loadCount += 1;
        if (loadCount === 1) return [{ preset: { id: 'p1', name: 'Existing Look', adjustments: {} } }];
        throw new Error('disk read failed on refresh');
      }
      throw new Error(`unexpected invoke in this test: ${cmd}`);
    });

    const { result } = renderHook(() => usePresets(INITIAL_ADJUSTMENTS));

    await waitFor(() => expect(result.current.loadStatus).toBe('ready'));
    expect(result.current.presets).toHaveLength(1);

    // A later refresh (e.g. `refreshPresets`, or the effect re-running) that
    // fails must not wipe the presets already known to be good.
    await act(async () => {
      await result.current.refreshPresets();
    });

    expect(result.current.loadStatus).toBe('error');
    expect(result.current.presets).toHaveLength(1); // untouched, not cleared to []

    vi.useFakeTimers();
    act(() => {
      result.current.addPreset('Another Look');
    });

    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(saveCalls()).toHaveLength(0);
  });
});
