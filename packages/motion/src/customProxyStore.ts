/**
 * @apelles/motion — the live player's custom-layer proxy store (D-409, B-282).
 *
 * What it is: the external store behind `customProxy.tsx`. Each custom layer
 * the player shows asks for its proxy frames by KEY — the JSON of its
 * one-layer proxy manifest (`customComponents.ts`'s `proxyManifest`), so the
 * same layer always maps to the same entry and a props edit maps to a new one.
 * The store debounces a newly-shown key, renders keys one at a time through
 * the injected `render` (in the app: `chroma_motion_component_proxy`, the
 * Remotion renderer process), and tells the key's viewers when its state
 * changes. React reads it through `useSyncExternalStore` only.
 *
 * Why a store with a subscribe/snapshot contract rather than module maps read
 * during render (B-282): the app builds every component through the React
 * Compiler (D-091), which memoizes what a render reads by its inputs. A render
 * that read `states.get(key)` straight off a module map was memoized on `key`
 * alone, so the re-render a finished proxy triggered returned the cached
 * "pending" and the frames never showed. `useSyncExternalStore` is React's own
 * contract for outside state: React calls `get` itself on every render and on
 * every notification, which no memoization can skip.
 *
 * Lifecycle of one key:
 *  - first viewer → `waiting`, and a debounce timer starts (a props edit in
 *    progress does not render every keystroke: the key changes per keystroke
 *    and only the one that survives the debounce renders);
 *  - the timer fires → queued; its turn → `rendering`;
 *  - the render answers → `ready` (the frame files), or `error` (a thrown or
 *    refused render, or one that produced no frames). Every error is also
 *    reported (`report`, `console.error` in the app), never only drawn.
 *  - the last viewer leaves → a request that has not started is dropped, and
 *    an error is forgotten so the next showing retries; a `ready` key stays
 *    (it is the cache) and a `rendering` one lands when it finishes.
 * The timer belongs to the KEY, not to a viewer, so a viewer leaving while
 * another still shows the key never strands it.
 *
 * What it does NOT do: build manifests, render anything itself, or touch the
 * DOM. `snapshot` is a read for the debug-only `debug_get_ui_state`.
 */
import { PROXY_SCALE } from './customComponents';
import { renderComponentProxy, type ComponentProxyResult } from './customComponentLibraryIO';

/** How long a newly-shown key waits for its props to settle, ms. */
export const PROXY_DEBOUNCE_MS = 450;

export type ProxyState =
  | { status: 'waiting' }
  | { status: 'rendering' }
  | { status: 'ready'; files: string[]; dir: string; cached: boolean }
  | { status: 'error'; error: string };

/** One key as the debug read reports it. */
export interface ProxyDebugEntry {
  /** the component `<id>@<version>` the proxy renders */
  component: string | null;
  /** the layer's own props, as rendered */
  props: unknown;
  status: ProxyState['status'];
  /** how many mounted custom layers are showing this key right now */
  viewers: number;
  frames?: number;
  dir?: string;
  cached?: boolean;
  error?: string;
}

export interface CustomProxyStoreDeps {
  /** renders one proxy manifest to frames */
  render: (manifest: unknown) => Promise<ComponentProxyResult>;
  debounceMs: number;
  /** where an error goes besides the layer's own status line */
  report: (message: string) => void;
}

export interface CustomProxyStore {
  /** Start showing `key`; `onChange` runs whenever its state changes. Returns
   *  the unsubscribe. */
  subscribe(key: string, onChange: () => void): () => void;
  /** The key's state (a stable object until it changes). */
  get(key: string): ProxyState;
  /** A frame of a `ready` key failed to load in the webview (an asset-protocol
   *  scope or a missing file): turn it into an error rather than a broken
   *  image. */
  frameFailed(key: string, file: string): void;
  snapshot(): ProxyDebugEntry[];
}

const WAITING: ProxyState = { status: 'waiting' };
const RENDERING: ProxyState = { status: 'rendering' };

/** The component and props a proxy key renders, for messages and the debug
 *  read. A key is a proxy manifest's JSON, so it always parses. */
function describeKey(key: string): { component: string | null; props: unknown } {
  try {
    const m: unknown = JSON.parse(key);
    const layer =
      typeof m === 'object' && m !== null && Array.isArray((m as { scenes?: unknown }).scenes)
        ? (m as { scenes: { layers?: unknown }[] }).scenes[0]?.layers
        : undefined;
    const first: unknown = Array.isArray(layer) ? layer[0] : undefined;
    if (typeof first !== 'object' || first === null) return { component: null, props: null };
    const { component, props } = first as { component?: unknown; props?: unknown };
    return { component: typeof component === 'string' ? component : null, props: props ?? null };
  } catch {
    return { component: null, props: null };
  }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createCustomProxyStore(deps: CustomProxyStoreDeps): CustomProxyStore {
  const states = new Map<string, ProxyState>();
  const viewers = new Map<string, Set<() => void>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const queue: string[] = [];
  let running = false;

  const viewerCount = (key: string) => viewers.get(key)?.size ?? 0;

  function set(key: string, state: ProxyState) {
    states.set(key, state);
    for (const onChange of [...(viewers.get(key) ?? [])]) onChange();
  }

  function fail(key: string, error: string) {
    deps.report(`[motion] custom layer preview failed (${describeKey(key).component ?? 'unknown component'}): ${error}`);
    // Nobody to show it to: forget it, so the next showing retries.
    if (viewerCount(key) === 0) states.delete(key);
    else set(key, { status: 'error', error });
  }

  async function drain() {
    if (running) return;
    running = true;
    try {
      for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
        set(key, RENDERING);
        try {
          const r = await deps.render(JSON.parse(key));
          if (r.files.length === 0) fail(key, `the renderer produced no frames (${r.dir})`);
          else set(key, { status: 'ready', files: r.files, dir: r.dir, cached: r.cached });
        } catch (e) {
          fail(key, errorText(e));
        }
      }
    } finally {
      running = false;
    }
  }

  function subscribe(key: string, onChange: () => void): () => void {
    let own = viewers.get(key);
    if (!own) {
      own = new Set();
      viewers.set(key, own);
    }
    own.add(onChange);
    if (!states.has(key)) {
      states.set(key, WAITING);
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          queue.push(key);
          void drain();
        }, deps.debounceMs),
      );
    }
    return () => {
      own.delete(onChange);
      if (own.size > 0 || viewers.get(key) !== own) return;
      viewers.delete(key);
      const timer = timers.get(key);
      if (timer !== undefined) {
        clearTimeout(timer);
        timers.delete(key);
      }
      const state = states.get(key);
      if (state?.status === 'waiting' || state?.status === 'error') {
        const queued = queue.indexOf(key);
        if (queued >= 0) queue.splice(queued, 1);
        states.delete(key);
      }
    };
  }

  return {
    subscribe,
    get: (key) => states.get(key) ?? WAITING,
    frameFailed(key, file) {
      if (states.get(key)?.status !== 'ready') return;
      fail(key, `could not load preview frame ${file}`);
    },
    snapshot: () =>
      [...states].map(([key, state]) => ({
        ...describeKey(key),
        status: state.status,
        viewers: viewerCount(key),
        ...(state.status === 'ready' ? { frames: state.files.length, dir: state.dir, cached: state.cached } : {}),
        ...(state.status === 'error' ? { error: state.error } : {}),
      })),
  };
}

/** The app's store: renders through the Tauri command, reports to the console
 *  (which the app forwards to its log as `[frontend]`). */
export const customProxyStore: CustomProxyStore = createCustomProxyStore({
  render: (manifest) => renderComponentProxy(manifest, PROXY_SCALE),
  debounceMs: PROXY_DEBOUNCE_MS,
  report: (message) => console.error(message),
});
