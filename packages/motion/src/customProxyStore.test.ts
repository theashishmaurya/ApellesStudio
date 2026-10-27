/**
 * @apelles/motion — the custom-layer proxy store's lifecycle (D-409, B-282).
 *
 * Pure: a fake `render`, fake timers. The DOM half (the player actually
 * drawing the frames, compiled as the app compiles it) is
 * `customProxy.dom.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProxyResult } from './customComponentLibraryIO';
import { createCustomProxyStore } from './customProxyStore';

const DEBOUNCE = 100;
const keyFor = (props: Record<string, unknown>) =>
  JSON.stringify({ scenes: [{ layers: [{ use: 'custom', component: 'rings@1', props }] }] });
const K1 = keyFor({ label: 'a' });
const K2 = keyFor({ label: 'b' });
const done = (dir: string): ComponentProxyResult => ({ dir, files: [`${dir}/frames/element-0.png`], cached: false });

function setup(render: (m: unknown) => Promise<ComponentProxyResult> = async () => done('/d')) {
  const renders: unknown[] = [];
  const reports: string[] = [];
  const store = createCustomProxyStore({
    render: (m) => {
      renders.push(m);
      return render(m);
    },
    debounceMs: DEBOUNCE,
    report: (msg) => reports.push(msg),
  });
  return { store, renders, reports };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the custom-layer proxy store', () => {
  it('debounces a shown key, renders it once, and notifies its viewer with the frames', async () => {
    const { store, renders } = setup();
    const seen = vi.fn();
    store.subscribe(K1, seen);
    expect(store.get(K1)).toEqual({ status: 'waiting' });
    expect(store.get(K1)).toBe(store.get(K1)); // a stable snapshot
    await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);
    expect(renders).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(renders).toEqual([JSON.parse(K1)]);
    expect(store.get(K1)).toEqual({ status: 'ready', files: ['/d/frames/element-0.png'], dir: '/d', cached: false });
    expect(seen).toHaveBeenCalled();
  });

  it('never renders a key that was left before its debounce ran out (a props edit in progress)', async () => {
    const { store, renders } = setup();
    const leave = store.subscribe(K1, () => {});
    await vi.advanceTimersByTimeAsync(DEBOUNCE / 2);
    leave();
    store.subscribe(K2, () => {});
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 3);
    expect(renders).toEqual([JSON.parse(K2)]);
    expect(store.snapshot().map((e) => e.props)).toEqual([{ label: 'b' }]);
  });

  it('does not strand a second viewer when the one that started the debounce leaves', async () => {
    const { store, renders } = setup();
    const leaveFirst = store.subscribe(K1, () => {});
    const second = vi.fn();
    store.subscribe(K1, second);
    leaveFirst();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(renders).toHaveLength(1);
    expect(store.get(K1).status).toBe('ready');
    expect(second).toHaveBeenCalled();
  });

  it('survives a StrictMode subscribe / unsubscribe / subscribe', async () => {
    const { store, renders } = setup();
    store.subscribe(K1, () => {})();
    store.subscribe(K1, () => {});
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(renders).toHaveLength(1);
    expect(store.get(K1).status).toBe('ready');
  });

  it('lands a render that finishes after its viewer left, and serves it from cache next time', async () => {
    let finish: (r: ComponentProxyResult) => void = () => {};
    const { store, renders } = setup(() => new Promise((r) => (finish = r)));
    const leave = store.subscribe(K1, () => {});
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(store.get(K1).status).toBe('rendering');
    leave();
    finish(done('/late'));
    await vi.advanceTimersByTimeAsync(0);
    store.subscribe(K1, () => {});
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(renders).toHaveLength(1);
    expect(store.get(K1)).toMatchObject({ status: 'ready', dir: '/late' });
  });

  it('renders one key at a time, in order', async () => {
    const pending: ((r: ComponentProxyResult) => void)[] = [];
    const { store, renders } = setup(() => new Promise((r) => pending.push(r)));
    store.subscribe(K1, () => {});
    store.subscribe(K2, () => {});
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(renders).toHaveLength(1);
    expect(store.get(K2).status).toBe('waiting');
    pending[0](done('/1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(renders).toHaveLength(2);
    expect(store.get(K2).status).toBe('rendering');
  });

  it('reports every failure, shows it to viewers, and retries once nobody shows the key any more', async () => {
    let fail = true;
    const { store, renders, reports } = setup(async () => {
      if (fail) throw new Error('remotion exited 1');
      return done('/ok');
    });
    const leave = store.subscribe(K1, () => {});
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(store.get(K1)).toEqual({ status: 'error', error: 'remotion exited 1' });
    expect(reports).toEqual(['[motion] custom layer preview failed (rings@1): remotion exited 1']);
    expect(store.snapshot()).toEqual([
      { component: 'rings@1', props: { label: 'a' }, status: 'error', viewers: 1, error: 'remotion exited 1' },
    ]);
    leave();
    fail = false;
    store.subscribe(K1, () => {});
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(renders).toHaveLength(2);
    expect(store.get(K1).status).toBe('ready');
  });

  it('calls a render with no frames a failure', async () => {
    const { store, reports } = setup(async () => ({ dir: '/empty', files: [], cached: true }));
    store.subscribe(K1, () => {});
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(store.get(K1)).toEqual({ status: 'error', error: 'the renderer produced no frames (/empty)' });
    expect(reports).toHaveLength(1);
  });

  it('turns a frame that fails to load into an error, only for a ready key', async () => {
    const { store, reports } = setup();
    store.subscribe(K1, () => {});
    store.frameFailed(K1, '/x.png'); // still waiting: ignored
    expect(store.get(K1).status).toBe('waiting');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    store.frameFailed(K1, '/d/frames/element-0.png');
    expect(store.get(K1)).toEqual({ status: 'error', error: 'could not load preview frame /d/frames/element-0.png' });
    expect(reports).toHaveLength(1);
  });

  it('reports a ready key with its frame count and folder in the debug snapshot', async () => {
    const { store } = setup();
    store.subscribe(K1, () => {});
    store.subscribe(K1, () => {});
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(store.snapshot()).toEqual([
      { component: 'rings@1', props: { label: 'a' }, status: 'ready', viewers: 2, frames: 1, dir: '/d', cached: false },
    ]);
  });
});
