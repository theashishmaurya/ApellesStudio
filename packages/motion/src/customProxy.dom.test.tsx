// @vitest-environment jsdom
/**
 * @apelles/motion — the live player's custom-layer proxy, end to end in a DOM
 * (D-409, B-282).
 *
 * The real `<Player>` playing the real engine `Video` composition, inside the
 * real `CustomProxyProvider`, all compiled by the React Compiler exactly as the
 * app builds them (`vitest.config.ts`) — only the Tauri `invoke` is stubbed.
 * B-282 lived precisely in that combination: uncompiled, the old renderer
 * showed its frames; compiled, it stayed on "rendering preview…" forever after
 * the frames existed. So this is the test that has to stay compiled.
 *
 * jsdom has no image decoder: a frame "loads" or "fails" only when the test
 * fires the event, which is how the load-error path is driven.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Player } from '@remotion/player';
import { Video } from '@apelles/motion-engine/src/engine/Video';
import type { ComponentRef } from '@apelles/motion-engine/src/custom/componentDef';
import type { Manifest } from '@apelles/motion-engine/src/engine/schema';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** What the stubbed `chroma_motion_component_proxy` answers, per test. */
const backend = vi.hoisted(() => ({
  calls: 0,
  answer: (() => Promise.resolve(null)) as () => Promise<unknown>,
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (p: string) => `asset://localhost/${encodeURIComponent(p)}`,
  invoke: async (cmd: string) => {
    if (cmd !== 'chroma_motion_component_proxy') return null;
    backend.calls += 1;
    return backend.answer();
  },
}));

const { CustomProxyProvider } = await import('./customProxy');
const { PROXY_DEBOUNCE_MS } = await import('./customProxyStore');

const FRAMES = Array.from({ length: 60 }, (_, i) => `/p/proxy/k/frames/element-${String(i).padStart(2, '0')}.png`);
const HEX = 'b'.repeat(64);
const ref: ComponentRef = {
  id: 'rings',
  name: 'Rings',
  props: [],
  size: { w: 400, h: 300 },
  duration: 2,
  version: 1,
  sourceHash: HEX,
  codeHash: HEX,
  code: `sha256:${HEX}.js`,
  source: `sha256:${HEX}.tsx`,
};

/** A distinct document per test (the proxy cache is keyed by content and is
 *  module state, so tests must not share a key). */
function manifestFor(w: number): Manifest {
  return {
    title: 'proxy test',
    width: 1920,
    height: 1080,
    fps: 30,
    components: { 'rings@1': ref },
    scenes: [{ id: 's', dur: 4, layers: [{ use: 'custom', id: 'r', component: 'rings@1', x: 0, y: 0, w, h: 300 }] }],
  } as unknown as Manifest;
}

const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mountPlayer(manifest: Manifest) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <React.StrictMode>
        <CustomProxyProvider doc={{}}>
          <Player
            component={Video}
            inputProps={manifest}
            durationInFrames={120}
            fps={30}
            compositionWidth={1920}
            compositionHeight={1080}
            acknowledgeRemotionLicense
          />
        </CustomProxyProvider>
      </React.StrictMode>,
    );
  });
  return host;
}

const status = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-custom-proxy-status]');

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  backend.calls = 0;
  vi.restoreAllMocks();
});

describe('the live player draws a custom layer from its proxy frames (B-282)', () => {
  it('shows "rendering preview…" first, then the frame once the render answers', async () => {
    let finish: (v: unknown) => void = () => {};
    backend.answer = () => new Promise((r) => (finish = r));
    const el = await mountPlayer(manifestFor(401));
    expect(status(el)?.dataset.customProxyStatus).toBe('waiting');
    expect(status(el)?.textContent).toBe('rendering preview…');

    await wait(PROXY_DEBOUNCE_MS + 100);
    expect(backend.calls).toBe(1);
    expect(status(el)?.dataset.customProxyStatus).toBe('rendering');

    await act(async () => finish({ dir: '/p/proxy/k', files: FRAMES, cached: false }));
    const img = el.querySelector<HTMLImageElement>('img[data-custom-proxy-status="ready"]');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe(`asset://localhost/${encodeURIComponent(FRAMES[0])}`);
    expect(el.textContent).not.toContain('rendering preview');
  });

  it('shows a failed render on the layer and reports it to the console', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    backend.answer = () => Promise.reject('remotion render --sequence failed: boom');
    const el = await mountPlayer(manifestFor(402));
    await wait(PROXY_DEBOUNCE_MS + 100);
    expect(status(el)?.dataset.customProxyStatus).toBe('error');
    expect(status(el)?.textContent).toBe('preview failed: remotion render --sequence failed: boom');
    expect(report).toHaveBeenCalledWith(expect.stringContaining('rings@1'));
    expect(report).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('treats a render that produced no frames as a failure, not as "still rendering"', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    backend.answer = () => Promise.resolve({ dir: '/p/proxy/empty', files: [], cached: true });
    const el = await mountPlayer(manifestFor(403));
    await wait(PROXY_DEBOUNCE_MS + 100);
    expect(status(el)?.dataset.customProxyStatus).toBe('error');
    expect(status(el)?.textContent).toContain('produced no frames');
  });

  it('turns a frame the webview cannot load into a named error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    backend.answer = () => Promise.resolve({ dir: '/p/proxy/k', files: FRAMES, cached: true });
    const el = await mountPlayer(manifestFor(404));
    await wait(PROXY_DEBOUNCE_MS + 100);
    const img = el.querySelector('img[data-custom-proxy-status="ready"]');
    expect(img).not.toBeNull();
    await act(async () => {
      img?.dispatchEvent(new Event('error'));
    });
    expect(status(el)?.dataset.customProxyStatus).toBe('error');
    expect(status(el)?.textContent).toContain(`could not load preview frame ${FRAMES[0]}`);
  });
});
