/** D-434 — the gesture planner: path interpolation, timing, modifiers, keys. */
import { describe, expect, it } from 'vitest';

import { buildKeyPlan, buildPointerPlan, interpolatePath, isPlanError, parseCombo, parseModifiers } from './plan';
import { NO_MODIFIERS, type LowEvent } from './types';

function ok<T>(v: T | { error: string }): T {
  if (isPlanError(v)) throw new Error(v.error);
  return v;
}

const mouseOnly = (plan: LowEvent[]) => plan.filter((e) => e.kind === 'mouse');

describe('interpolatePath', () => {
  it('lands on every waypoint exactly and spaces the steps evenly between', () => {
    const path = interpolatePath(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 40 },
      ],
      4,
    );
    expect(path).toEqual([
      { x: 25, y: 0 },
      { x: 50, y: 0 },
      { x: 75, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 10 },
      { x: 100, y: 20 },
      { x: 100, y: 30 },
      { x: 100, y: 40 },
    ]);
  });

  it('never emits fewer than one step per segment', () => {
    expect(interpolatePath([{ x: 0, y: 0 }, { x: 10, y: 10 }], 0)).toEqual([{ x: 10, y: 10 }]);
  });
});

describe('buildPointerPlan', () => {
  it('a click is move → down → up, with the button held for the click time', () => {
    const plan = ok(buildPointerPlan({ action: 'click', points: [{ x: 5, y: 6 }] }));
    expect(plan.map((e) => (e.kind === 'mouse' ? e.phase : e.kind))).toEqual(['move', 'down', 'up']);
    const [, down, up] = mouseOnly(plan);
    expect(down).toMatchObject({ buttons: 1, clickCount: 1, x: 5, y: 6 });
    expect(up).toMatchObject({ buttons: 0, delayMs: 40 });
  });

  it('a double-click carries clickCount 1 then 2', () => {
    const plan = mouseOnly(ok(buildPointerPlan({ action: 'doubleClick', points: [{ x: 1, y: 1 }] })));
    expect(plan.filter((e) => e.kind === 'mouse' && e.phase === 'down').map((e) => (e.kind === 'mouse' ? e.clickCount : 0))).toEqual([1, 2]);
  });

  it('a drag presses at the start, moves along the path with the button held, and releases at the end', () => {
    const plan = mouseOnly(
      ok(buildPointerPlan({ action: 'drag', points: [{ x: 0, y: 0 }, { x: 120, y: 0 }], steps: 6, durationMs: 300, holdMs: 50 })),
    );
    const moves = plan.filter((e) => e.kind === 'mouse' && e.phase === 'move').slice(1);
    expect(moves).toHaveLength(6);
    expect(moves.every((e) => e.kind === 'mouse' && e.buttons === 1)).toBe(true);
    // The first move waits the hold; each later one gets an even share of the duration.
    expect(moves.map((e) => e.delayMs)).toEqual([50, 50, 50, 50, 50, 50]);
    const up = plan[plan.length - 1];
    expect(up).toMatchObject({ phase: 'up', x: 120, y: 0, buttons: 0 });
  });

  it('a drag with no destination is refused', () => {
    expect(isPlanError(buildPointerPlan({ action: 'drag', points: [{ x: 0, y: 0 }] }))).toBe(true);
  });

  it('modifier keys go down before the gesture and come up after it, in reverse', () => {
    const plan = ok(
      buildPointerPlan({
        action: 'click',
        points: [{ x: 0, y: 0 }],
        modifiers: { ...NO_MODIFIERS, alt: true, shift: true },
      }),
    );
    const mods = plan.filter((e) => e.kind === 'modifier').map((e) => (e.kind === 'modifier' ? `${e.phase}:${e.key}` : ''));
    expect(mods).toEqual(['down:Shift', 'down:Alt', 'up:Alt', 'up:Shift']);
    expect(plan[0].kind).toBe('modifier');
    expect(plan[plan.length - 1].kind).toBe('modifier');
    // Every mouse event inside carries the held modifiers.
    expect(mouseOnly(plan).every((e) => e.modifiers.alt && e.modifiers.shift)).toBe(true);
  });

  it('pressModifiers:false keeps the flags on the events but sends no key presses', () => {
    const plan = ok(
      buildPointerPlan({ action: 'click', points: [{ x: 0, y: 0 }], modifiers: { ...NO_MODIFIERS, alt: true }, pressModifiers: false }),
    );
    expect(plan.some((e) => e.kind === 'modifier')).toBe(false);
    expect(mouseOnly(plan)[1].modifiers.alt).toBe(true);
  });

  it('a wheel splits its delta evenly over the steps', () => {
    const plan = ok(buildPointerPlan({ action: 'wheel', points: [{ x: 9, y: 9 }], deltaY: -100, steps: 4 }));
    const wheels = plan.filter((e) => e.kind === 'wheel');
    expect(wheels).toHaveLength(4);
    expect(wheels.every((e) => e.kind === 'wheel' && e.deltaY === -25)).toBe(true);
  });

  it('a pinch is begin, N changes whose factors multiply to the scale, end', () => {
    const plan = ok(buildPointerPlan({ action: 'pinch', points: [{ x: 1, y: 1 }], scale: 2, steps: 4 }));
    const mags = plan.filter((e) => e.kind === 'magnify');
    expect(mags.map((e) => (e.kind === 'magnify' ? e.phase : ''))).toEqual(['begin', 'change', 'change', 'change', 'change', 'end']);
    const product = mags.reduce((acc, e) => (e.kind === 'magnify' && e.phase === 'change' ? acc * (1 + e.magnification) : acc), 1);
    expect(product).toBeCloseTo(2, 9);
  });

  it('refuses a gesture over the event limit', () => {
    const plan = buildPointerPlan({ action: 'drag', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], steps: 100000 });
    expect(isPlanError(plan) && plan.error).toMatch(/limit/);
  });

  it('a later call continues a held button', () => {
    const plan = mouseOnly(ok(buildPointerPlan({ action: 'up', points: [{ x: 3, y: 3 }], heldButtons: 1 })));
    expect(plan[0]).toMatchObject({ phase: 'move', buttons: 1 });
    expect(plan[1]).toMatchObject({ phase: 'up', buttons: 0 });
  });
});

describe('modifiers and combos', () => {
  it('accepts the platform names and refuses unknown ones by name', () => {
    expect(ok(parseModifiers(['cmd', 'option']))).toEqual({ ...NO_MODIFIERS, meta: true, alt: true });
    const bad = parseModifiers(['hyper']);
    expect(isPlanError(bad) && bad.error).toMatch(/hyper/);
  });

  it('parses a combo into modifiers and a DOM code', () => {
    expect(ok(parseCombo('meta+shift+KeyZ'))).toEqual({ modifiers: { ...NO_MODIFIERS, meta: true, shift: true }, code: 'KeyZ' });
    expect(isPlanError(parseCombo('meta+z'))).toBe(true); // `z` is a key, not a code
  });
});

describe('buildKeyPlan', () => {
  it('presses a combo: modifiers down, key down, key up, modifiers up', () => {
    const plan = ok(buildKeyPlan({ keys: ['meta+KeyZ'] }));
    expect(plan.map((e) => `${e.kind}:${'phase' in e ? e.phase : ''}:${'key' in e ? e.key : ''}`)).toEqual([
      'modifier:down:Meta',
      'key:down:z',
      'key:up:z',
      'modifier:up:Meta',
    ]);
  });

  it('types text with Shift where a character needs it', () => {
    const plan = ok(buildKeyPlan({ text: 'Hi' }));
    const downs = plan.filter((e) => e.kind === 'key' && e.phase === 'down');
    expect(downs.map((e) => (e.kind === 'key' ? `${e.code}/${e.key}/${e.modifiers.shift}` : ''))).toEqual([
      'KeyH/H/true',
      'KeyI/i/false',
    ]);
  });

  it('waits the gap before every stroke after the first', () => {
    const plan = ok(buildKeyPlan({ keys: ['KeyJ', 'KeyK'], gapMs: 70, holdMs: 20 }));
    expect(plan.map((e) => e.delayMs)).toEqual([0, 20, 70, 20]);
  });

  it('phase down / up hold a key across calls', () => {
    expect(ok(buildKeyPlan({ keys: ['KeyK'], phase: 'down' })).map((e) => ('phase' in e ? e.phase : ''))).toEqual(['down']);
    expect(ok(buildKeyPlan({ keys: ['KeyK'], phase: 'up' })).map((e) => ('phase' in e ? e.phase : ''))).toEqual(['up']);
  });

  it('refuses text no single key can type, and both keys and text at once', () => {
    expect(isPlanError(buildKeyPlan({ text: 'é' }))).toBe(true);
    expect(isPlanError(buildKeyPlan({ keys: ['KeyA'], text: 'a' }))).toBe(true);
  });
});
