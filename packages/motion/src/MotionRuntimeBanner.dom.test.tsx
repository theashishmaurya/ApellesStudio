// @vitest-environment jsdom
/**
 * @apelles/motion — the Motion tab's render-runtime states in a DOM (D-417).
 *
 * The harness wires exactly what `MotionTab` wires: `useMotionRuntime()` (the
 * bridge store, its status read and its event subscription),
 * `useMotionRuntimeAutoInstall()` (the "first time the tab opens" download),
 * the `MotionRuntimeBanner`, and a Render button gated by
 * `motionRuntimeBlockedReason` — compiled by the React Compiler as the app
 * builds them. Only Tauri's `invoke` / `listen` are stubbed; the test plays the
 * backend, pushing `motion-runtime-status` events as the Rust manager does.
 *
 * Pins: missing → the download starts by itself, once → downloading shows real
 * progress and Render waits with the reason → ready hides the banner and frees
 * Render → a failure shows why with Retry, and is not retried by itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MotionRuntimeStatus } from '@apelles/bridge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MB = 1024 * 1024;

function status(over: Partial<MotionRuntimeStatus>): MotionRuntimeStatus {
  return {
    state: 'missing',
    detail: 'not installed',
    bytesDone: 0,
    bytesTotal: 152 * MB,
    downloadBytes: 152 * MB,
    installedBytes: 0,
    versions: { node: '24.22.1', chrome: '149.0.7790.0', remotion: '4.0.519' },
    canInstall: true,
    canRemove: false,
    ...over,
  };
}

/** The fake backend: what the status command answers, every command called,
 *  and the event listener the bridge registered. */
const backend = vi.hoisted(() => ({
  current: null as unknown,
  calls: [] as string[],
  emit: null as ((payload: unknown) => void) | null,
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (p: string) => p,
  invoke: async (cmd: string) => {
    backend.calls.push(cmd);
    if (cmd === 'chroma_motion_runtime_status') return backend.current;
    if (cmd === 'chroma_motion_runtime_install') {
      backend.current = { ...(backend.current as object), state: 'installing', canInstall: false };
      return { ...(backend.current as object), started: true };
    }
    return null;
  },
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: async (_event: string, handler: (e: { payload: unknown }) => void) => {
    backend.emit = (payload) => handler({ payload });
    return () => {
      backend.emit = null;
    };
  },
}));

const bridge = await import('@apelles/bridge');
const { resetMotionRuntimeAutoInstallForTests, useMotionRuntimeStore } = await import(
  '@apelles/bridge/src/motionRuntime'
);
const { MotionRuntimeBanner } = await import('./MotionRuntimeBanner');

/** What MotionTab wires, and nothing else. */
function Harness() {
  const runtime = bridge.useMotionRuntime();
  bridge.useMotionRuntimeAutoInstall();
  const blocked = bridge.motionRuntimeBlockedReason(runtime.status, 'Render');
  return (
    <div>
      <MotionRuntimeBanner
        status={runtime.status}
        busy={runtime.busy}
        actionError={runtime.actionError}
        onInstall={() => void runtime.install()}
      />
      <button type="button" data-testid="render" disabled={blocked !== null} title={blocked ?? undefined}>
        Render
      </button>
    </div>
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<Harness />);
  });
  // Let the status read and the auto-install resolve.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function push(next: MotionRuntimeStatus) {
  backend.current = next;
  await act(async () => {
    backend.emit?.(next);
  });
}

const banner = () => host?.querySelector('[role="status"]') ?? null;
const renderButton = () => host?.querySelector<HTMLButtonElement>('[data-testid="render"]') ?? null;
const installs = () => backend.calls.filter((c) => c === 'chroma_motion_runtime_install').length;

beforeEach(() => {
  backend.calls = [];
  backend.current = status({});
  resetMotionRuntimeAutoInstallForTests();
  useMotionRuntimeStore.setState({ status: bridge.MOTION_RUNTIME_UNKNOWN, loaded: false, busy: false, actionError: null });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('the Motion tab and its render runtime', () => {
  it('missing → downloads by itself once → progress → ready', async () => {
    await mount();
    expect(installs()).toBe(1);
    expect(banner()?.getAttribute('data-motion-runtime-state')).toBe('installing');
    expect(renderButton()?.disabled).toBe(true);

    await push(status({ state: 'installing', canInstall: false, step: 'downloading', bytesDone: 76 * MB }));
    const bar = host?.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('50');
    expect(banner()?.textContent).toContain('76 MB of 152 MB');
    expect(renderButton()?.title).toContain('downloading (50%)');
    expect(host?.textContent).not.toContain('Download (');

    await push(status({ state: 'ready', source: 'managed', canInstall: false, canRemove: true, installedBytes: 326 * MB }));
    expect(banner()).toBeNull();
    expect(renderButton()?.disabled).toBe(false);
    expect(installs()).toBe(1);
  });

  it('a failure says why, offers Retry, and is not retried by itself', async () => {
    await mount();
    await push(
      status({
        state: 'failed',
        errorKind: 'offline',
        error: 'cannot reach nodejs.org — check the internet connection and press Retry',
      }),
    );
    expect(banner()?.getAttribute('data-motion-runtime-state')).toBe('failed');
    expect(banner()?.textContent).toContain('no internet connection');
    expect(banner()?.textContent).toContain('cannot reach nodejs.org');
    expect(renderButton()?.disabled).toBe(true);
    expect(renderButton()?.title).toContain('download failed');
    expect(installs()).toBe(1);

    const retry = [...(host?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Retry');
    expect(retry).toBeDefined();
    await act(async () => {
      retry?.click();
    });
    expect(installs()).toBe(2);
  });

  it('opening the tab again in the same session does not start a second download', async () => {
    await mount();
    expect(installs()).toBe(1);
    act(() => root?.unmount());
    host?.remove();
    backend.current = status({});
    await mount();
    expect(installs()).toBe(1);
    expect(banner()?.textContent).toContain('one-time 152 MB download');
    const download = [...(host?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.startsWith('Download'));
    expect(download?.textContent).toBe('Download (152 MB)');
  });

  it('a development build that renders with its own Node shows nothing and downloads nothing', async () => {
    backend.current = status({ state: 'ready', source: 'developer', canInstall: true });
    await mount();
    expect(banner()).toBeNull();
    expect(renderButton()?.disabled).toBe(false);
    expect(installs()).toBe(0);
  });
});
