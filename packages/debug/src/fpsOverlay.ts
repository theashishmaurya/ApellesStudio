/**
 * fpsOverlay.ts — a live, on-screen frame-rate readout, burned into whatever
 * looks at the window (D-330, `docs/notes/debug-tooling.md` piece 6).
 *
 * What it is: a single fixed-position element, toggled by the
 *   `debug_set_fps_overlay` op, that displays the Edit-tab preview's REAL
 *   paint/raf frame rate four times a second. It exists so a recording of the
 *   app (`debug_record_video`, the other half of D-330) carries its own
 *   measurement in-frame — a before/after comparison of a performance fix is
 *   only evidence if the number is visible in the footage and is the same
 *   number the tooling reports.
 *
 * Where the numbers come from: `@apelles/editor`'s `previewTiming.ts`, via
 *   `previewLiveFps` — the SAME ring buffers `debug_frame_timing` reads, not
 *   a second, parallel measurement. This is the load-bearing property of the
 *   whole feature. Two independently-derived "fps" numbers on screen and in
 *   the tool could disagree, and a viewer with no way to tell which was right
 *   would be right to trust neither. This module computes nothing: it
 *   formats.
 *
 * What it does NOT do: measure anything, affect what is measured, or change
 *   layout. Three deliberate properties, each load-bearing:
 *
 *   1. **No React.** This is plain DOM created with `document.createElement`
 *      and updated by writing `textContent` on a `setInterval`. A React
 *      component re-rendering four times a second would add render/commit
 *      work to the very path `raf`/`paint` measure — D-325 has the numbers on
 *      how expensive an extra per-frame subscriber on this app's tree is
 *      (11 reactive `playhead` subscribers, one of them 22.8 ms/commit at 200
 *      clips). An observer that changes the observation is worse than none.
 *   2. **`position: fixed` + `pointer-events: none`.** It is outside flow, so
 *      nothing reflows when it appears or when its text changes width, and it
 *      cannot swallow a click meant for the UI underneath.
 *   3. **Its own colours, not the theme's.** The one deliberate departure
 *      from CLAUDE.md's "all theming flows from the `--color-*` vars" rule,
 *      for a reason specific to this element: it must stay legible over the
 *      preview's own picture (which is arbitrary video, any brightness) and
 *      must not change appearance halfway through a recording because the
 *      user switched tab or theme. A fixed high-contrast pair is the point,
 *      not an oversight — see D-330.
 *
 * Debug-only: nothing imports this statically. `debugOps.ts` does, and that
 *   module is itself reached only through the `import()` inside
 *   `useDebugControl`'s `import.meta.env.DEV` branch, so this file lands in
 *   the same dropped chunk. See `docs/notes/debug-tooling.md`'s gate
 *   verification.
 */

import { previewLiveFps, DEFAULT_TIMING_WINDOW_MS } from '@apelles/editor';

/** The id the overlay element carries, so a screenshot/DOM dump can find it
 *  and a stale one can never be duplicated. */
export const FPS_OVERLAY_ID = 'chroma-debug-fps-overlay';

/** How often the text is rewritten, in ms.
 *
 *  250 ms (4 Hz) is a readability choice, not a performance one. A number
 *  redrawn every frame is unreadable — the digits blur into noise and a
 *  viewer of the recording cannot copy a value down — while anything slower
 *  than about 500 ms visibly lags a real stall, which is the event the
 *  recording exists to show. 4 Hz is the fastest rate at which a changing
 *  3-4 digit number still reads as a number. The work per tick is one
 *  arithmetic pass over at most {@link DEFAULT_TIMING_WINDOW_MS} of samples
 *  plus one `textContent` write, so the cost is irrelevant at any rate in
 *  this range; readability is the only real constraint. */
export const DEFAULT_OVERLAY_UPDATE_MS = 250;

/** Bounds on a caller-supplied update interval. The floor is one 60 Hz frame
 *  (faster cannot render anyway); the ceiling is the point past which the
 *  readout is stale enough to misrepresent what is on screen beside it. */
export const MIN_OVERLAY_UPDATE_MS = 16;
export const MAX_OVERLAY_UPDATE_MS = 2000;

export const OVERLAY_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
export type OverlayCorner = (typeof OVERLAY_CORNERS)[number];

/** Top-right by default: the Edit tab's preview sits centre, its timeline
 *  along the bottom and its track headers bottom-left, so the top-right is
 *  the one corner whose content (the Inspector's own header) is never the
 *  subject of a performance recording. Overridable for the case where it is. */
export const DEFAULT_OVERLAY_CORNER: OverlayCorner = 'top-right';

/** Deliberately fixed, theme-independent colours — see the module doc. */
const OVERLAY_BACKGROUND = 'rgba(0, 0, 0, 0.72)';
const OVERLAY_TEXT = '#00ff66';
const OVERLAY_MUTED = '#b0b0b0';
/** Above every panel, dialog and the wgpu surface's DOM hole alike. */
const OVERLAY_Z_INDEX = '2147483000';
const CORNER_INSET = '12px';

export interface FpsOverlayOptions {
  updateMs?: number;
  corner?: OverlayCorner;
}

/** What the op echoes back — the live state, read off the real element. */
export interface FpsOverlayState {
  enabled: boolean;
  updateMs: number;
  corner: OverlayCorner;
  /** Whether the element is genuinely in the document right now. */
  mounted: boolean;
}

export function parseOverlayCorner(value: unknown): OverlayCorner | null {
  if (typeof value !== 'string') return null;
  return (OVERLAY_CORNERS as readonly string[]).includes(value) ? (value as OverlayCorner) : null;
}

/** Clamp an update interval into [{@link MIN_OVERLAY_UPDATE_MS},
 *  {@link MAX_OVERLAY_UPDATE_MS}], falling back to the default for anything
 *  that is not a real number. Clamped rather than refused: an out-of-range
 *  interval has an obvious correct intent, unlike an unknown corner name. */
export function clampUpdateMs(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_OVERLAY_UPDATE_MS;
  return Math.min(MAX_OVERLAY_UPDATE_MS, Math.max(MIN_OVERLAY_UPDATE_MS, n));
}

/** One fps value as it appears on screen. `null` (no samples yet) is shown as
 *  a dash, never as `0.0` — "nothing has painted" and "painting at zero" look
 *  the same in a recording otherwise, and only one of them is a bug. */
export function formatFps(fps: number | null): string {
  return fps === null ? '  --' : fps.toFixed(1).padStart(4, ' ');
}

/** The exact text the overlay shows. Pure, so the legibility decisions above
 *  (dash for no samples, fixed column widths so digits do not jitter) are
 *  unit-tested without a DOM. */
export function overlayText(live: ReturnType<typeof previewLiveFps>): string {
  const seconds = (live.windowMs / 1000).toFixed(1);
  const hitch = live.hitches === 1 ? '1 hitch' : `${live.hitches} hitches`;
  return [
    `PAINT ${formatFps(live.paintFps)} fps`,
    `RAF   ${formatFps(live.rafFps)} fps`,
    `${seconds}s window · ${hitch}`,
  ].join('\n');
}

let timer: ReturnType<typeof setInterval> | null = null;
let element: HTMLElement | null = null;
let currentUpdateMs = DEFAULT_OVERLAY_UPDATE_MS;
let currentCorner: OverlayCorner = DEFAULT_OVERLAY_CORNER;

function applyCorner(el: HTMLElement, corner: OverlayCorner): void {
  // Reset all four first: a corner change must not leave the previous
  // corner's inset behind and stretch the box across the window.
  el.style.top = 'auto';
  el.style.right = 'auto';
  el.style.bottom = 'auto';
  el.style.left = 'auto';
  const [vertical, horizontal] = corner.split('-');
  el.style[vertical as 'top' | 'bottom'] = CORNER_INSET;
  el.style[horizontal as 'left' | 'right'] = CORNER_INSET;
}

function createElement(): HTMLElement {
  const el = document.createElement('div');
  el.id = FPS_OVERLAY_ID;
  // A stable hook for `debug_dom_tree` and for asserting in a DOM test,
  // matching the `data-chroma-panel` convention the real panels use.
  el.setAttribute('data-chroma-debug', 'fps-overlay');
  el.setAttribute('aria-hidden', 'true');
  Object.assign(el.style, {
    position: 'fixed',
    zIndex: OVERLAY_Z_INDEX,
    pointerEvents: 'none',
    // `pre` keeps the newlines in `overlayText` without any child elements,
    // so an update is one `textContent` write and zero DOM mutations.
    whiteSpace: 'pre',
    font: '600 13px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace',
    color: OVERLAY_TEXT,
    background: OVERLAY_BACKGROUND,
    padding: '6px 9px',
    borderRadius: '4px',
    // Legibility over an arbitrarily bright video frame underneath.
    textShadow: `0 1px 2px ${OVERLAY_BACKGROUND}`,
    border: `1px solid ${OVERLAY_MUTED}`,
    // The overlay is a measuring instrument; it must never be what makes a
    // frame expensive. No blur, no filter, no animation.
    contain: 'layout style paint',
  } satisfies Partial<CSSStyleDeclaration>);
  return el;
}

function tick(): void {
  if (!element) return;
  element.textContent = overlayText(previewLiveFps(DEFAULT_TIMING_WINDOW_MS));
}

/** Turn the overlay on or off. Idempotent in both directions: enabling an
 *  already-enabled overlay re-applies the options rather than mounting a
 *  second element, and disabling a disabled one is a no-op that still
 *  reports the true state. */
export function setFpsOverlay(enabled: boolean, options: FpsOverlayOptions = {}): FpsOverlayState {
  currentUpdateMs = clampUpdateMs(options.updateMs ?? currentUpdateMs);
  currentCorner = options.corner ?? currentCorner;

  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }

  if (!enabled) {
    element?.remove();
    element = null;
    return { enabled: false, updateMs: currentUpdateMs, corner: currentCorner, mounted: false };
  }

  // Re-query rather than trusting the module-level handle: an HMR reload or a
  // hand-removed node would otherwise leave a dangling reference and mount a
  // duplicate on the next enable.
  const existing = document.getElementById(FPS_OVERLAY_ID);
  element = existing instanceof HTMLElement ? existing : createElement();
  applyCorner(element, currentCorner);
  if (!element.isConnected) document.body.appendChild(element);

  // Paint once immediately: at a 250 ms interval an overlay that waited for
  // its first tick would be blank in any screenshot taken right after it was
  // switched on, which is exactly when one is taken.
  tick();
  timer = setInterval(tick, currentUpdateMs);

  return {
    enabled: true,
    updateMs: currentUpdateMs,
    corner: currentCorner,
    mounted: element.isConnected,
  };
}

/** The overlay's live state without changing it — what `debug_get_ui_state`
 *  reports, so an agent can tell whether a recording will carry the readout
 *  before spending N seconds making one. */
export function fpsOverlayState(): FpsOverlayState {
  const mounted = document.getElementById(FPS_OVERLAY_ID) !== null;
  return {
    enabled: timer !== null && mounted,
    updateMs: currentUpdateMs,
    corner: currentCorner,
    mounted,
  };
}
