// D-402 — the reloaded page asks the backend once for the WebKit termination
// it died of; the answer is consumed by that ask, so it is cached per page.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ pending: null as unknown, asks: 0, fail: false }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    if (cmd !== 'chroma_webview_take_termination') throw new Error(`no stub for ${cmd}`);
    backend.asks += 1;
    if (backend.fail) throw new Error('unknown command');
    const r = backend.pending;
    backend.pending = null; // taken, like the Rust side
    return r;
  },
}));

import { takeWebviewTermination } from './pageLifecycle';

beforeEach(() => {
  backend.pending = null;
  backend.asks = 0;
  backend.fail = false;
});

describe('takeWebviewTermination (D-402)', () => {
  it('reports the termination, and a second ask from the same page gets the same answer', async () => {
    backend.pending = { label: 'main', at: '2026-10-26T13:44:00Z', count: 1 };
    const page = {};
    const first = await takeWebviewTermination(page);
    expect(first).toEqual({ label: 'main', at: '2026-10-26T13:44:00Z', count: 1 });
    // React StrictMode mounts twice: the second ask must not read the emptied slot.
    expect(await takeWebviewTermination(page)).toEqual(first);
    expect(backend.asks).toBe(1);
    // A later page (an ordinary reload) is not told again.
    expect(await takeWebviewTermination({})).toBeNull();
  });

  it('is null when there was none or the backend cannot answer', async () => {
    expect(await takeWebviewTermination({})).toBeNull();
    backend.fail = true;
    expect(await takeWebviewTermination({})).toBeNull();
  });
});
