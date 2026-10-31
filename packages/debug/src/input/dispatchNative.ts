/**
 * dispatchNative.ts — hand a `LowEvent` plan to Rust as REAL input (D-434).
 *
 * What it is: the default dispatcher on the running app. It sends the plan to
 *   the debug-only Tauri command `chroma_debug_inject_input`
 *   (`app/src-tauri/src/chroma/debug_input.rs`), which builds a genuine
 *   `NSEvent` for each entry and delivers it to the window's `WKWebView`
 *   through the same responder methods AppKit itself calls (`mouseDown:`,
 *   `mouseDragged:`, `keyDown:`, `scrollWheel:`, `magnifyWithEvent:`) — the
 *   WebKitTestRunner pattern. WebKit then does everything it does for a hand
 *   on a trackpad: hit-testing, `isTrusted` DOM events, pointer capture,
 *   default actions, its own coalescing.
 *
 * What it does NOT do: resolve targets or wait for the page — the plan is
 *   already in viewport CSS pixels, and the command returns once the last
 *   event has been delivered to AppKit. It also never falls back silently:
 *   `inputOps.ts` decides what an unavailable native path means.
 */

import { invoke, isTauri } from '@tauri-apps/api/core';

import type { LowEvent } from './types';

/** The command's name, spelled once. */
export const INJECT_COMMAND = 'chroma_debug_inject_input';

/** What the Rust side reports back (`debug_input::InjectReport`). */
export interface NativeReport {
  dispatched: number;
  /** How a plain mouse move was delivered (`simulateMouseMove` SPI or `mouseMoved:`). */
  mouseMovePath: string;
  /** Whether `+[NSEvent pressedMouseButtons]` was reporting an injected button
   *  during the call (H10) — false on a hover, a key or a wheel, where nothing
   *  is held — so DOM `buttons` reflects the injected button, not the physical mouse. */
  pressedButtonsOverride: boolean;
  /** Wheel only (H8): the `NSEvent` built from the `CGEvent` was attributed to the window. */
  wheelWindowMatched?: boolean;
  /** Wheel only (H8): the location was rewritten into window space because it was not. */
  wheelLocationCorrected?: boolean;
  /** A buttonless move into a non-key window (H5): the window was made key first. */
  madeKeyForMove?: boolean;
  /** Pinch only: the built event really is a Magnify event. */
  magnifyBuilt?: boolean;
  /** Whether the window was key while events were delivered. */
  windowKey: boolean;
  /** WebKit's own occlusion detection (`_windowOcclusionDetectionEnabled`) —
   *  `true` means a covered window still throttles rAF. `null` when unknown. */
  occlusionDetection: boolean | null;
  /** The webview's size in points vs. the page's CSS viewport, as used to map coordinates. */
  viewScale: number;
}

export function nativeInputAvailable(): boolean {
  return isTauri();
}

export async function dispatchNative(plan: readonly LowEvent[], win: Window = window): Promise<NativeReport> {
  return invoke<NativeReport>(INJECT_COMMAND, {
    events: plan,
    viewport: { width: win.innerWidth, height: win.innerHeight },
  });
}
