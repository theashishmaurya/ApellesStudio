/**
 * observe.ts — record what the page actually received during a gesture (D-434).
 *
 * What it is: capture-phase listeners on `window` for every input event type
 *   the harness can cause, installed for the duration of one `debug_pointer` /
 *   `debug_key` call. This is what makes the tool self-verifying: the result
 *   says how many `pointerdown`s the DOM saw, on which element, whether they
 *   were `isTrusted` (true only for the native path — a synthetic event can
 *   never claim it), and where the pointer really was. A native injection
 *   whose events never reached the page, or reached the wrong element, shows
 *   up as a count of zero or a surprising `target`, not as a mysterious
 *   assertion failure later.
 *
 * What it does NOT do: change, stop or re-order anything. Listeners are
 *   passive observers on the capture phase and never call
 *   `preventDefault`/`stopPropagation`.
 */

import { describeElement } from './geometry';

/** The event types worth recording. `gesture*` are WebKit's own pinch events
 *  (Safari's `GestureEvent`): a real trackpad pinch in a WKWebView produces
 *  those, which is exactly what this lets a pinch scenario see. */
export const OBSERVED_TYPES = [
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointercancel',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'contextmenu',
  'wheel',
  'keydown',
  'keyup',
  'gesturestart',
  'gesturechange',
  'gestureend',
  'dragstart',
] as const;

/** Types too frequent to list one by one — counted, and the last one kept. */
const HIGH_RATE = new Set(['pointermove', 'wheel', 'gesturechange']);
/** Cap on listed events, so a long gesture cannot bloat the reply. */
export const MAX_LISTED_EVENTS = 200;

export interface ObservedEvent {
  type: string;
  /** `performance.now()` when the listener ran. */
  t: number;
  /** The event's own `timeStamp` (same clock as `performance.now()` in WebKit and Chromium). */
  timeStamp: number;
  trusted: boolean;
  target: string | null;
  x?: number;
  y?: number;
  buttons?: number;
  button?: number;
  code?: string;
  key?: string;
  modifiers?: string;
  deltaX?: number;
  deltaY?: number;
}

export interface ObserveSummary {
  counts: Record<string, number>;
  trusted: number;
  untrusted: number;
  /** Every non-high-rate event, in order (capped). */
  events: ObservedEvent[];
  eventsTruncated: boolean;
  /** The last pointer position the page saw. */
  lastPointer: { x: number; y: number } | null;
  /** Where the last `wheel` event landed (H8): the page's own `clientX/Y`, to
   *  compare with where the gesture aimed. A wheel built from a `CGEvent` that
   *  lost its window arrives offset by the window's screen origin, and
   *  nothing else in the reply would show it. */
  lastWheel: { x: number; y: number } | null;
  /** Input timestamps (every observed event) — used for latency. */
  inputTimes: number[];
}

function modifierString(e: { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }): string | undefined {
  const parts = [e.metaKey && 'meta', e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift'].filter(Boolean);
  return parts.length ? parts.join('+') : undefined;
}

export interface Observer {
  /** The last pointer position seen so far (live, for the frame sampler's cursor probe). */
  lastPointer(): { x: number; y: number } | null;
  stop(): ObserveSummary;
}

export function startObserver(win: Window = window): Observer {
  const counts: Record<string, number> = {};
  const events: ObservedEvent[] = [];
  const inputTimes: number[] = [];
  let trusted = 0;
  let untrusted = 0;
  let truncated = false;
  let lastPointer: { x: number; y: number } | null = null;
  let lastWheel: { x: number; y: number } | null = null;
  const now = () => win.performance?.now() ?? Date.now();

  const onEvent = (raw: Event) => {
    counts[raw.type] = (counts[raw.type] ?? 0) + 1;
    if (raw.isTrusted) trusted += 1;
    else untrusted += 1;
    const t = now();
    inputTimes.push(raw.timeStamp > 0 ? raw.timeStamp : t);
    const rec: ObservedEvent = {
      type: raw.type,
      t: Math.round(t * 10) / 10,
      timeStamp: Math.round(raw.timeStamp * 10) / 10,
      trusted: raw.isTrusted,
      target: describeElement(raw.target instanceof Element ? raw.target : null),
    };
    const e = raw as Partial<MouseEvent & KeyboardEvent & WheelEvent>;
    if (typeof e.clientX === 'number' && typeof e.clientY === 'number') {
      rec.x = e.clientX;
      rec.y = e.clientY;
      if (raw.type.startsWith('pointer') || raw.type.startsWith('mouse')) lastPointer = { x: e.clientX, y: e.clientY };
      if (raw.type === 'wheel') lastWheel = { x: e.clientX, y: e.clientY };
    }
    if (typeof e.buttons === 'number') rec.buttons = e.buttons;
    if (typeof e.button === 'number') rec.button = e.button;
    if (typeof e.code === 'string') rec.code = e.code;
    if (typeof e.key === 'string') rec.key = e.key;
    if (typeof e.deltaX === 'number') rec.deltaX = e.deltaX;
    if (typeof e.deltaY === 'number') rec.deltaY = e.deltaY;
    const mods = modifierString(e);
    if (mods) rec.modifiers = mods;
    if (HIGH_RATE.has(raw.type)) return;
    if (events.length < MAX_LISTED_EVENTS) events.push(rec);
    else truncated = true;
  };

  for (const type of OBSERVED_TYPES) win.addEventListener(type, onEvent, { capture: true, passive: true });

  return {
    lastPointer: () => lastPointer,
    stop() {
      for (const type of OBSERVED_TYPES) win.removeEventListener(type, onEvent, { capture: true });
      return { counts, trusted, untrusted, events, eventsTruncated: truncated, lastPointer, lastWheel, inputTimes };
    },
  };
}
