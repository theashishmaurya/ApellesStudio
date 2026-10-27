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
 * placeholder box is shown with "rendering preview…"; a failed render shows
 * "preview failed: <why>" there (and in the console, `customProxyStore.ts`).
 * The status line carries `data-custom-proxy-status`, and the debug-only
 * `debug_get_ui_state` reports every proxy's state, so an agent can check it
 * without a screenshot.
 *
 * Requesting, debouncing, queueing and caching live in `customProxyStore.ts`;
 * this file only reads it, through `useSyncExternalStore` (B-282).
 *
 * What it does NOT do: evaluate component code (nothing here imports the
 * engine's `custom/runtime.tsx`), or affect what renders on export (the export
 * runs the real component in the renderer process).
 */
import React, { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  CustomRendererProvider,
  PlaceholderRenderer,
  type CustomRenderer,
} from '@apelles/motion-engine/src/custom/renderer';
import type { Manifest } from '@apelles/motion-engine/src/engine/schema';
import { proxyManifest } from './customComponents';
import { customProxyStore, type ProxyState } from './customProxyStore';

/** The document fields a proxy manifest inherits. */
export type ProxyDoc = Pick<Manifest, 'theme' | 'themeDef'>;

/** The status line's size in canvas px: legible once the player scales a
 *  1080p canvas down into its panel, never louder than the placeholder's own
 *  label. */
const STATUS_MIN_PX = 16;
const STATUS_MAX_PX = 40;
const STATUS_BOX_DIVISOR = 24;

/** One proxy key's state, through React's external-store contract. Never read
 *  the store during render any other way: the React Compiler memoizes such a
 *  read on its inputs, and the update then never shows (B-282). */
function useProxyState(key: string): ProxyState {
  const subscribe = useCallback((onChange: () => void) => customProxyStore.subscribe(key, onChange), [key]);
  const get = useCallback(() => customProxyStore.get(key), [key]);
  return useSyncExternalStore(subscribe, get, get);
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
  const state = useProxyState(key);
  if (state.status === 'ready') {
    const file = state.files[Math.max(0, Math.min(frame, state.files.length - 1))];
    return (
      <img
        src={convertFileSrc(file)}
        alt=""
        data-custom-proxy-status="ready"
        // A frame the webview cannot load (outside the asset-protocol scope, a
        // file gone) becomes a named error, not a broken image.
        onError={() => customProxyStore.frameFailed(key, file)}
        style={{ width, height, display: 'block' }}
      />
    );
  }
  const statusPx = Math.max(STATUS_MIN_PX, Math.min(STATUS_MAX_PX, Math.round(Math.min(width, height) / STATUS_BOX_DIVISOR)));
  return (
    <div style={{ position: 'relative', width, height }}>
      <PlaceholderRenderer {...req} />
      <span
        data-custom-proxy-status={state.status}
        style={{
          position: 'absolute',
          left: 8,
          right: 8,
          bottom: 6,
          fontSize: statusPx,
          lineHeight: 1.25,
          overflowWrap: 'anywhere',
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
