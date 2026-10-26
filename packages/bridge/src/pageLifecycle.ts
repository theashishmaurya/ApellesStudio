/**
 * `@apelles/bridge` — telling a page that was reloaded because its web process
 * died apart from one that was reloaded on purpose (B-274).
 *
 * **What it is.** A tiny marker in `sessionStorage`. While a page is running it
 * reads `running`; the page's own `pagehide` (fired by every deliberate
 * navigation or reload, including a dev-server full reload) flips it to
 * `unloading`. A page that starts and finds `running` therefore follows one that
 * never got to say goodbye: macOS terminated the WKWebView's web content
 * process (memory pressure) and the webview came back by itself, which on the
 * Edit tab means everything not yet saved is gone.
 *
 * **What it does.** [`classifyPageStart`] returns `first` (a fresh session),
 * `clean-reload` or `unexpected-reload` and arms the marker for this page;
 * [`watchPageUnload`] installs the `pagehide` half.
 *
 * **D-402 — the native signal.** The Rust side now hooks WebKit's own
 * `webViewWebContentProcessDidTerminate` (`chroma::webview_lifecycle`), records
 * the termination and reloads the page itself. [`takeWebviewTermination`] is the
 * typed binding the reloaded page asks once: an authoritative answer, where the
 * `sessionStorage` marker above is a heuristic that stays as the fallback (it
 * also catches a reload the hook never saw).
 *
 * **What it does NOT do.** Show anything or recover anything: the caller says
 * what to tell the user (`app/src/Root.tsx`), and the Edit timeline's
 * write-ahead journal (`@apelles/editor`'s `editJournal.ts`) does the
 * recovering. WebKit's `sessionStorage` surviving a web process replacement is
 * the documented behaviour but is unverified on the running app (see B-274).
 */

import { invoke } from '@tauri-apps/api/core';

const MARKER_KEY = 'apelles.page.lifecycle';

export type PageStart = 'first' | 'clean-reload' | 'unexpected-reload';

/** The slice of `Storage` this needs, so tests need no DOM. */
export interface MarkerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Classify this page start from what the previous page left, then mark this
 *  page as running. Storage that cannot be read or written (private mode,
 *  blocked) classifies as `first`: no claim is made without evidence. */
export function classifyPageStart(storage: MarkerStorage): PageStart {
  let previous: string | null = null;
  try {
    previous = storage.getItem(MARKER_KEY);
    storage.setItem(MARKER_KEY, 'running');
  } catch {
    return 'first';
  }
  if (previous === 'running') return 'unexpected-reload';
  if (previous === 'unloading') return 'clean-reload';
  return 'first';
}

const PAGE_START_CACHE = Symbol.for('apelles.page.start');

/** [`classifyPageStart`] ONCE per page load. The marker is armed by the first
 *  call, so a second call in the same page (React StrictMode's dev double-mount,
 *  a hot-reloaded module) would read its own `running` and cry wolf; the answer
 *  is cached on `target` instead, which survives both. */
export function pageStart(target: object, storage: MarkerStorage): PageStart {
  const cache = target as { [PAGE_START_CACHE]?: PageStart };
  cache[PAGE_START_CACHE] ??= classifyPageStart(storage);
  return cache[PAGE_START_CACHE];
}

/** Mark the page as leaving deliberately when the browser says so. Returns the
 *  uninstall function. */
export function watchPageUnload(target: Pick<Window, 'addEventListener' | 'removeEventListener'>, storage: MarkerStorage): () => void {
  const onHide = () => {
    try {
      storage.setItem(MARKER_KEY, 'unloading');
    } catch {
      /* nothing to record against */
    }
  };
  target.addEventListener('pagehide', onHide);
  return () => target.removeEventListener('pagehide', onHide);
}

/** Mirrors `chroma::webview_lifecycle::WebviewTermination`. */
export interface WebviewTermination {
  /** the webview's label (`main` for the app window) */
  label: string;
  /** RFC 3339, when WebKit reported it */
  at: string;
  /** terminations this app process has seen, this one included */
  count: number;
}

const TERMINATION_CACHE = Symbol.for('apelles.page.termination');

/** The web content process termination the previous page died of, if no page
 *  has been told yet (the backend hands it out once). `null` when there was
 *  none, or when the backend cannot answer: no claim without evidence.
 *
 *  Asked ONCE per page load, the answer cached on `target` for the reason
 *  [`pageStart`] caches its own: the backend's answer is consumed by the first
 *  ask, so a StrictMode double-mount or a hot-reloaded module asking again
 *  would otherwise get `null` and miss it. */
export function takeWebviewTermination(target: object): Promise<WebviewTermination | null> {
  const cache = target as { [TERMINATION_CACHE]?: Promise<WebviewTermination | null> };
  cache[TERMINATION_CACHE] ??= invoke<WebviewTermination | null>('chroma_webview_take_termination').then(
    (r) => (r && typeof r.count === 'number' ? r : null),
    () => null,
  );
  return cache[TERMINATION_CACHE];
}
