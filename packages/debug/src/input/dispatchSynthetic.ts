/**
 * dispatchSynthetic.ts — play a `LowEvent` plan as in-page DOM events (D-434).
 *
 * What it is: the FALLBACK dispatcher — `PointerEvent` + `MouseEvent`,
 *   `WheelEvent` and `KeyboardEvent` constructed in the page and dispatched at
 *   the element under each point. It is what runs where there is no native
 *   path: the jsdom DOM-tier tests, and a non-macOS dev build.
 *
 * What it does NOT do — and why it is not the default on the real app
 *   (D-434): every event it makes has `isTrusted === false`, the browser runs
 *   none of its own default actions for it (no focus move, no text selection,
 *   no native scroll from a wheel, no real pointer capture, no hover/`:active`
 *   state, no WebKit `gesture*` events for a pinch), and it cannot reproduce
 *   WebKit's own coalescing or timing. A handler that works here can still be
 *   broken for a human. A pinch is played as Chromium's representation (a
 *   `wheel` with `ctrlKey`), NOT WebKit's — only the native path can say what
 *   a real trackpad pinch does in this app.
 */

import type { LowEvent, Modifiers, MouseButton } from './types';

const DOM_BUTTON: Record<MouseButton, number> = { left: 0, middle: 1, right: 2 };
/** The CSS-px `deltaY` one unit of synthetic magnification maps to — the order
 *  of magnitude Chromium uses for a pinch-as-ctrl-wheel. */
const PINCH_WHEEL_SCALE = 100;
const POINTER_ID = 1;

function mods(m: Modifiers) {
  return { shiftKey: m.shift, ctrlKey: m.ctrl, altKey: m.alt, metaKey: m.meta };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

export interface SyntheticReport {
  dispatched: number;
}

/** Play `plan` against `doc`. `hitTest` is injectable because jsdom has no
 *  layout (and no `elementFromPoint`); tests supply their own geometry. */
export async function dispatchSynthetic(
  plan: readonly LowEvent[],
  opts: { doc?: Document; hitTest?: (x: number, y: number) => Element | null } = {},
): Promise<SyntheticReport> {
  const doc = opts.doc ?? document;
  const view = doc.defaultView ?? window;
  const hitTest =
    opts.hitTest ?? ((x: number, y: number) => (typeof doc.elementFromPoint === 'function' ? doc.elementFromPoint(x, y) : null));
  const PointerCtor: typeof MouseEvent = (view as unknown as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? view.MouseEvent;
  let downTarget: Element | null = null;
  let dispatched = 0;

  for (const ev of plan) {
    if (ev.delayMs > 0) await sleep(ev.delayMs);
    dispatched += 1;
    if (ev.kind === 'mouse') {
      // While a button is held, keep delivering to the press target — what
      // implicit pointer capture does for a real touch/pen and what most drag
      // code here assumes by listening on `window` anyway.
      const target: Element = (ev.phase !== 'down' && downTarget) || hitTest(ev.x, ev.y) || doc.body;
      const init = {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: ev.x,
        clientY: ev.y,
        button: ev.phase === 'move' ? -1 : DOM_BUTTON[ev.button],
        buttons: ev.buttons,
        detail: ev.clickCount,
        ...mods(ev.modifiers),
      };
      const pointerInit = { ...init, pointerId: POINTER_ID, pointerType: 'mouse', isPrimary: true };
      const type = ev.phase === 'move' ? 'move' : ev.phase;
      target.dispatchEvent(new PointerCtor(`pointer${type}`, pointerInit));
      target.dispatchEvent(new view.MouseEvent(`mouse${type}`, init));
      if (ev.phase === 'down') downTarget = target;
      if (ev.phase === 'up') {
        const pressed = downTarget;
        downTarget = null;
        if (pressed && (pressed === target || pressed.contains(target) || target.contains(pressed))) {
          const clickInit = { ...init, button: DOM_BUTTON[ev.button] };
          if (ev.button === 'right') target.dispatchEvent(new view.MouseEvent('contextmenu', clickInit));
          else target.dispatchEvent(new view.MouseEvent('click', clickInit));
          if (ev.clickCount === 2 && ev.button === 'left') target.dispatchEvent(new view.MouseEvent('dblclick', clickInit));
        }
      }
    } else if (ev.kind === 'wheel' || ev.kind === 'magnify') {
      const target: Element = hitTest(ev.x, ev.y) || doc.body;
      const isPinch = ev.kind === 'magnify';
      if (isPinch && ev.phase !== 'change') continue;
      target.dispatchEvent(
        new view.WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: ev.x,
          clientY: ev.y,
          deltaMode: 0,
          deltaX: isPinch ? 0 : ev.deltaX,
          deltaY: isPinch ? -ev.magnification * PINCH_WHEEL_SCALE : ev.deltaY,
          ...mods(ev.modifiers),
          ...(isPinch ? { ctrlKey: true } : {}),
        }),
      );
    } else {
      const target = doc.activeElement ?? doc.body;
      target.dispatchEvent(
        new view.KeyboardEvent(ev.phase === 'down' ? 'keydown' : 'keyup', {
          bubbles: true,
          cancelable: true,
          composed: true,
          code: ev.code,
          key: ev.key,
          ...mods(ev.modifiers),
        }),
      );
    }
  }
  return { dispatched };
}
