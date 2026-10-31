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
  /** Whether `+[NSEvent pressedMouseButtons]` was overridden for the gesture, so
   *  DOM `buttons` reports the injected button rather than the physical mouse. */
  pressedButtonsOverride: boolean;
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
