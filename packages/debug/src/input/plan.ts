/**
 * plan.ts — high-level gestures → a timed list of primitive events (D-434).
 *
 * What it is: the pure middle of `debug_pointer` / `debug_key`. A gesture
 *   ("drag from here to there in 300 ms over 12 steps with Alt held", "press
 *   Cmd+Z") becomes the exact `LowEvent` sequence a human's hand would
 *   produce — the modifier key going down first, the move onto the target,
 *   the press, the pause, the interpolated path, the release — each with the
 *   delay before it. Both dispatchers play the SAME list, so the synthetic
 *   and native paths can only differ in how an event is delivered, never in
 *   which events there are.
 *
 * What it does NOT do: touch the DOM, resolve targets, or wait. Inputs are
 *   already-resolved points; output is data. Unit-tested in `plan.test.ts`.
 */

import { codeForChar, keyForCode, MODIFIER_KEYS, KNOWN_CODES, type ModifierName } from './keys';
import { NO_MODIFIERS, type LowEvent, type Modifiers, type MouseButton, type Point } from './types';

/** Defaults for a human-paced gesture. A real press is never instantaneous,
 *  and several handlers in this app gate on movement over time (dnd-kit's
 *  activation distance, interact.js's start threshold, the marquee's). */
export const DEFAULT_DRAG_STEPS = 12;
export const DEFAULT_DRAG_DURATION_MS = 300;
/** Pause between press and the first move of a drag — long enough for a
 *  pointerdown handler to set up its listeners before the moves arrive. */
export const DEFAULT_HOLD_MS = 50;
/** How long a click's button stays down. */
export const DEFAULT_CLICK_HOLD_MS = 40;
/** Gap between the two clicks of a double-click (well under the OS threshold). */
export const DEFAULT_DOUBLE_CLICK_GAP_MS = 80;
export const DEFAULT_KEY_HOLD_MS = 30;
export const DEFAULT_KEY_GAP_MS = 50;
export const DEFAULT_WHEEL_STEPS = 5;
export const DEFAULT_WHEEL_DURATION_MS = 100;
export const DEFAULT_PINCH_STEPS = 8;
export const DEFAULT_PINCH_DURATION_MS = 200;
/** Upper bound on any one gesture's event count — a typo'd `steps: 100000`
 *  must not hold the app's main thread for minutes. */
export const MAX_PLAN_EVENTS = 2000;

const BUTTON_BIT: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 };

export interface PlanError {
  error: string;
}

export function isPlanError<T>(v: T | PlanError): v is PlanError {
  return typeof v === 'object' && v !== null && (v as PlanError).error !== undefined;
}

const MODIFIER_ALIASES: Record<string, ModifierName> = {
  shift: 'shift',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
};

/** `['alt', 'shift']` → `Modifiers`. Unknown names are refused by name. */
export function parseModifiers(list: unknown): Modifiers | PlanError {
  if (list === undefined || list === null) return { ...NO_MODIFIERS };
  if (!Array.isArray(list)) return { error: "'modifiers' must be a list such as [\"alt\", \"shift\"]" };
  const out: Modifiers = { ...NO_MODIFIERS };
  for (const raw of list) {
    const name = MODIFIER_ALIASES[String(raw).toLowerCase()];
    if (!name) return { error: `unknown modifier ${JSON.stringify(raw)} — expected shift, ctrl, alt/option, meta/cmd` };
    out[name] = true;
  }
  return out;
}

export function parseButton(raw: unknown): MouseButton | PlanError {
  if (raw === undefined || raw === null) return 'left';
  if (raw === 'left' || raw === 'right' || raw === 'middle') return raw;
  return { error: `unknown button ${JSON.stringify(raw)} — expected left, right or middle` };
}

/** The points strictly after `points[0]` along straight segments through every
 *  waypoint, `stepsPerSegment` per segment, each waypoint landed on exactly. */
export function interpolatePath(points: readonly Point[], stepsPerSegment: number): Point[] {
  const steps = Math.max(1, Math.round(stepsPerSegment));
  const out: Point[] = [];
  for (let s = 1; s < points.length; s += 1) {
    const a = points[s - 1];
    const b = points[s];
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      out.push({ x: Math.round((a.x + (b.x - a.x) * t) * 10) / 10, y: Math.round((a.y + (b.y - a.y) * t) * 10) / 10 });
    }
  }
  return out;
}

/** The modifier presses before a gesture and the releases after it, in the
 *  order a hand does them (press in order, release in reverse). */
function modifierEvents(mods: Modifiers, phase: 'down' | 'up', delayMs: number): LowEvent[] {
  const names = (Object.keys(MODIFIER_KEYS) as ModifierName[]).filter((n) => mods[n]);
  const ordered = phase === 'down' ? names : [...names].reverse();
  const state: Modifiers = phase === 'down' ? { ...NO_MODIFIERS } : { ...mods };
  return ordered.map((name, i) => {
    state[name] = phase === 'down';
    return {
      kind: 'modifier',
      phase,
      code: MODIFIER_KEYS[name].code,
      key: MODIFIER_KEYS[name].key,
      modifiers: { ...state },
      delayMs: i === 0 ? delayMs : 0,
    };
  });
}

export type PointerAction = 'move' | 'down' | 'up' | 'click' | 'doubleClick' | 'drag' | 'wheel' | 'pinch' | 'html5Drag';
export const POINTER_ACTIONS: readonly PointerAction[] = ['move', 'down', 'up', 'click', 'doubleClick', 'drag', 'wheel', 'pinch', 'html5Drag'];

export interface PointerPlanOptions {
  action: PointerAction;
  /** Resolved points: the target, then (for `move`/`drag`) every waypoint and `to`. */
  points: readonly Point[];
  button?: MouseButton;
  modifiers?: Modifiers;
  /** Press the modifier KEYS around the gesture (default true) — the app arms
   *  its smart trim tool on an Alt keydown, not on a flag inside the drag. */
  pressModifiers?: boolean;
  steps?: number;
  durationMs?: number;
  holdMs?: number;
  /** Pause at the end of a drag before releasing. Default `holdMs`. */
  releaseDelayMs?: number;
  /** Buttons already held when the gesture starts (a `down` in an earlier call). */
  heldButtons?: number;
  deltaX?: number;
  deltaY?: number;
  /** `pinch`: the overall zoom factor (1.5 = 50 % larger, 0.5 = half). */
  scale?: number;
}

export function buildPointerPlan(o: PointerPlanOptions): LowEvent[] | PlanError {
  const mods = o.modifiers ?? { ...NO_MODIFIERS };
  const button = o.button ?? 'left';
  const bit = BUTTON_BIT[button];
  const held = o.heldButtons ?? 0;
  const hold = o.holdMs ?? DEFAULT_HOLD_MS;
  if (o.points.length === 0) return { error: 'a target is required' };
  const [p0] = o.points;
  const events: LowEvent[] = [];
  const mouse = (phase: 'move' | 'down' | 'up', p: Point, buttons: number, clickCount: number, delayMs: number): LowEvent => ({
    kind: 'mouse',
    phase,
    x: p.x,
    y: p.y,
    button,
    buttons,
    clickCount,
    modifiers: { ...mods },
    delayMs,
  });

  const press = o.pressModifiers !== false;
  if (press) events.push(...modifierEvents(mods, 'down', 0));

  switch (o.action) {
    case 'move': {
      events.push(mouse('move', p0, held, 0, 0));
      if (o.points.length > 1) {
        const path = interpolatePath(o.points, o.steps ?? DEFAULT_DRAG_STEPS);
        const each = (o.durationMs ?? DEFAULT_DRAG_DURATION_MS) / path.length;
        for (const p of path) events.push(mouse('move', p, held, 0, each));
      }
      break;
    }
    case 'down':
      events.push(mouse('move', p0, held, 0, 0), mouse('down', p0, held | bit, 1, 0));
      break;
    case 'up':
      events.push(mouse('move', p0, held, 0, 0), mouse('up', p0, held & ~bit, 1, 0));
      break;
    case 'click':
      events.push(
        mouse('move', p0, held, 0, 0),
        mouse('down', p0, held | bit, 1, 0),
        mouse('up', p0, held, 1, o.holdMs ?? DEFAULT_CLICK_HOLD_MS),
      );
      break;
    case 'doubleClick': {
      const clickHold = o.holdMs ?? DEFAULT_CLICK_HOLD_MS;
      events.push(
        mouse('move', p0, held, 0, 0),
        mouse('down', p0, held | bit, 1, 0),
        mouse('up', p0, held, 1, clickHold),
        mouse('down', p0, held | bit, 2, DEFAULT_DOUBLE_CLICK_GAP_MS),
        mouse('up', p0, held, 2, clickHold),
      );
      break;
    }
    case 'drag': {
      if (o.points.length < 2) return { error: "a drag needs somewhere to go: pass 'to' (or a 'path')" };
      const path = interpolatePath(o.points, o.steps ?? DEFAULT_DRAG_STEPS);
      const each = (o.durationMs ?? DEFAULT_DRAG_DURATION_MS) / path.length;
      events.push(mouse('move', p0, held, 0, 0), mouse('down', p0, held | bit, 1, 0));
      path.forEach((p, i) => events.push(mouse('move', p, held | bit, 0, i === 0 ? hold : each)));
      const last = path[path.length - 1];
      events.push(mouse('up', last, held, 1, o.releaseDelayMs ?? hold));
      break;
    }
    case 'wheel': {
      const steps = Math.max(1, Math.round(o.steps ?? DEFAULT_WHEEL_STEPS));
      const dx = o.deltaX ?? 0;
      const dy = o.deltaY ?? 0;
      if (dx === 0 && dy === 0) return { error: "a wheel needs 'deltaX' and/or 'deltaY' (CSS px; negative deltaY scrolls up)" };
      const each = (o.durationMs ?? DEFAULT_WHEEL_DURATION_MS) / steps;
      events.push(mouse('move', p0, held, 0, 0));
      for (let i = 0; i < steps; i += 1) {
        events.push({ kind: 'wheel', x: p0.x, y: p0.y, deltaX: dx / steps, deltaY: dy / steps, modifiers: { ...mods }, delayMs: i === 0 ? 0 : each });
      }
      break;
    }
    case 'pinch': {
      const scale = o.scale ?? 0;
      if (!(scale > 0) || scale === 1) return { error: "a pinch needs a 'scale' > 0 and ≠ 1 (1.5 zooms in 50 %, 0.5 zooms out)" };
      const steps = Math.max(1, Math.round(o.steps ?? DEFAULT_PINCH_STEPS));
      // Each event applies a relative change; `steps` equal factors multiply to `scale`.
      const perStep = Math.pow(scale, 1 / steps) - 1;
      const each = (o.durationMs ?? DEFAULT_PINCH_DURATION_MS) / steps;
      events.push(mouse('move', p0, held, 0, 0));
      events.push({ kind: 'magnify', x: p0.x, y: p0.y, magnification: 0, phase: 'begin', modifiers: { ...mods }, delayMs: 0 });
      for (let i = 0; i < steps; i += 1) {
        events.push({ kind: 'magnify', x: p0.x, y: p0.y, magnification: perStep, phase: 'change', modifiers: { ...mods }, delayMs: each });
      }
      events.push({ kind: 'magnify', x: p0.x, y: p0.y, magnification: 0, phase: 'end', modifiers: { ...mods }, delayMs: 0 });
      break;
    }
    default:
      return { error: `unknown action ${JSON.stringify(o.action)} — expected one of ${POINTER_ACTIONS.join(', ')}` };
  }

  if (press) events.push(...modifierEvents(mods, 'up', 0));
  if (events.length > MAX_PLAN_EVENTS) {
    return { error: `that gesture is ${events.length} events — over the ${MAX_PLAN_EVENTS} limit; use fewer steps` };
  }
  return events;
}

/** `"meta+shift+KeyZ"` → modifiers + code. The key is the LAST part and must
 *  be a DOM `code`; modifiers are any of the names `parseModifiers` accepts. */
export function parseCombo(combo: string): { modifiers: Modifiers; code: string } | PlanError {
  const parts = combo.split('+').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return { error: 'empty key combo' };
  const code = parts[parts.length - 1];
  const mods = parseModifiers(parts.slice(0, -1));
  if (isPlanError(mods)) return mods;
  if (keyForCode(code, false) === null) {
    return {
      error: `unknown key code ${JSON.stringify(code)} in ${JSON.stringify(combo)} — use a DOM KeyboardEvent.code such as KeyZ, Space, ArrowLeft, Delete (known: ${KNOWN_CODES.length} codes)`,
    };
  }
  return { modifiers: mods, code };
}

export interface KeyPlanOptions {
  /** Combos pressed one after another, e.g. `["Space"]`, `["meta+KeyZ"]`. */
  keys?: readonly string[];
  /** Text typed character by character (US layout). */
  text?: string;
  /** `press` (default) = down + up; `down` / `up` = only that half, to hold a key across calls. */
  phase?: 'press' | 'down' | 'up';
  holdMs?: number;
  gapMs?: number;
}

export function buildKeyPlan(o: KeyPlanOptions): LowEvent[] | PlanError {
  const hold = o.holdMs ?? DEFAULT_KEY_HOLD_MS;
  const gap = o.gapMs ?? DEFAULT_KEY_GAP_MS;
  const phase = o.phase ?? 'press';
  const strokes: { modifiers: Modifiers; code: string }[] = [];
  if (o.keys && o.text !== undefined) return { error: "pass 'keys' or 'text', not both" };
  if (o.keys) {
    for (const combo of o.keys) {
      const parsed = parseCombo(String(combo));
      if (isPlanError(parsed)) return parsed;
      strokes.push(parsed);
    }
  } else if (o.text !== undefined) {
    for (const ch of Array.from(o.text)) {
      const found = codeForChar(ch);
      if (!found) return { error: `cannot type ${JSON.stringify(ch)} — no single US-layout key produces it` };
      strokes.push({ code: found.code, modifiers: { ...NO_MODIFIERS, shift: found.shift } });
    }
  } else {
    return { error: "pass 'keys' (e.g. [\"meta+KeyZ\"]) or 'text'" };
  }
  if (strokes.length === 0) return { error: 'nothing to press' };

  const events: LowEvent[] = [];
  strokes.forEach((s, i) => {
    const key = keyForCode(s.code, s.modifiers.shift) ?? s.code;
    const lead = i === 0 ? 0 : gap;
    if (phase !== 'up') {
      const modsDown = modifierEvents(s.modifiers, 'down', lead);
      events.push(...modsDown);
      events.push({ kind: 'key', phase: 'down', code: s.code, key, modifiers: { ...s.modifiers }, delayMs: modsDown.length ? 0 : lead });
    }
    if (phase !== 'down') {
      events.push({ kind: 'key', phase: 'up', code: s.code, key, modifiers: { ...s.modifiers }, delayMs: phase === 'up' ? lead : hold });
      events.push(...modifierEvents(s.modifiers, 'up', 0));
    }
  });
  if (events.length > MAX_PLAN_EVENTS) return { error: `${events.length} key events is over the ${MAX_PLAN_EVENTS} limit` };
  return events;
}
