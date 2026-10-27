/**
 * @apelles/motion — the live player's custom-component renderer (D-409).
 *
 * What it is: the `CustomRenderer` the app installs around its Remotion player
 * and thumbnails (`CustomProxyProvider`). Agent-written component code must
 * never execute in the Tauri webview, which has IPC to the backend, so a custom
 * layer here shows FRAMES that the renderer process rendered: the layer is
 * turned into a one-layer transparent manifest (`customComponents.ts`'s
 * `proxyManifest`), rendered once to a PNG sequence by
 * `chroma_motion_component_proxy` (the same Remotion renderer the export uses),
 * cached by content, and the player draws the PNG of the layer's current local
 * frame. Until the frames exist (a first insert, a props edit) the safe
 * placeholder box is shown with "rendering preview…".
 *
 * Requests are debounced (a props edit in progress does not render every
 * keystroke) and run one at a time; a request nobody is showing any more is
 * skipped when its turn comes.
 *
 * What it does NOT do: evaluate component code (nothing here imports the
 * engine's `custom/runtime.tsx`), or affect what renders on export (the export
 * runs the real component in the renderer process).
 */
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  CustomRendererProvider,
  PlaceholderRenderer,
  type CustomRenderer,
} from '@apelles/motion-engine/src/custom/renderer';
import type { Manifest } from '@apelles/motion-engine/src/engine/schema';
import { PROXY_SCALE, proxyManifest } from './customComponents';
import { renderComponentProxy, type ComponentProxyResult } from './customComponentLibraryIO';

/** How long a layer's proxy request waits for its props to settle, ms. */
const PROXY_DEBOUNCE_MS = 450;

type ProxyState =
  | { status: 'pending' }
  | { status: 'ready'; files: string[] }
  | { status: 'error'; error: string };

/** The document fields a proxy manifest inherits. */
export type ProxyDoc = Pick<Manifest, 'theme' | 'themeDef'>;

const states = new Map<string, ProxyState>();
const listeners = new Map<string, Set<() => void>>();
const queue: { key: string; manifest: Manifest }[] = [];
let running = false;

function notify(key: string) {
  for (const l of listeners.get(key) ?? []) l();
}

async function drain(render: (manifest: Manifest) => Promise<ComponentProxyResult>) {
  if (running) return;
  running = true;
  try {
    for (let job = queue.shift(); job; job = queue.shift()) {
      // Nobody shows it any more (the props moved on): skip the render.
      if ((listeners.get(job.key)?.size ?? 0) === 0) {
        states.delete(job.key);
        continue;
      }
      try {
        const r = await render(job.manifest);
        states.set(job.key, { status: 'ready', files: r.files });
      } catch (e) {
        states.set(job.key, { status: 'error', error: e instanceof Error ? e.message : String(e) });
      }
      notify(job.key);
    }
  } finally {
    running = false;
  }
}

/** Subscribe to one proxy's state, requesting its render (debounced). */
function useProxyFrames(key: string, manifest: Manifest): ProxyState {
  const [, bump] = useState(0);
  useEffect(() => {
    const set = listeners.get(key) ?? new Set<() => void>();
    const listener = () => bump((n) => n + 1);
    set.add(listener);
    listeners.set(key, set);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!states.has(key)) {
      states.set(key, { status: 'pending' });
      timer = setTimeout(() => {
        queue.push({ key, manifest });
        void drain((m) => renderComponentProxy(m, PROXY_SCALE));
      }, PROXY_DEBOUNCE_MS);
    }
    return () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        if (states.get(key)?.status === 'pending' && !queue.some((j) => j.key === key)) states.delete(key);
      }
      set.delete(listener);
    };
  }, [key, manifest]);
  return states.get(key) ?? { status: 'pending' };
}

const ProxyDocCtx = createContext<ProxyDoc>({});

/** Draws a custom layer from frames the renderer process rendered. */
const ProxyRenderer: CustomRenderer = (req) => {
  const { def, raw, width, height, durationInFrames } = req;
  const doc = useContext(ProxyDocCtx);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const manifest = useMemo(
    () => proxyManifest({ fps, theme: doc.theme, themeDef: doc.themeDef }, def, raw, durationInFrames),
    [fps, doc.theme, doc.themeDef, def, raw, durationInFrames],
  );
  const key = useMemo(() => JSON.stringify(manifest), [manifest]);
  const state = useProxyFrames(key, manifest);
  if (state.status === 'ready' && state.files.length > 0) {
    const file = state.files[Math.max(0, Math.min(frame, state.files.length - 1))];
    return <img src={convertFileSrc(file)} alt="" style={{ width, height, display: 'block' }} />;
  }
  return (
    <div style={{ position: 'relative', width, height }}>
      <PlaceholderRenderer {...req} />
      <span
        style={{
          position: 'absolute',
          left: 8,
          bottom: 6,
          fontSize: 14,
          color: req.theme.textDim,
          fontFamily: req.theme.fontUi,
        }}
      >
        {state.status === 'error' ? `preview failed: ${state.error}` : 'rendering preview…'}
      </span>
    </div>
  );
};

/** Install the proxy renderer for everything below (the player, thumbnails). */
export function CustomProxyProvider({ doc, children }: { doc: ProxyDoc; children: React.ReactNode }) {
  return (
    <ProxyDocCtx.Provider value={doc}>
      <CustomRendererProvider renderer={ProxyRenderer}>{children}</CustomRendererProvider>
    </ProxyDocCtx.Provider>
  );
}
