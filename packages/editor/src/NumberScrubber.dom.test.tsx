// @vitest-environment jsdom
/**
 * @apelles/editor — `@apelles/ui`'s `NumberScrubber` on a real DOM (D-432, P4).
 *
 * Lives here for the reason `ScrubbableNumberInput.dom.test.tsx` does: the
 * real-`PointerEvent` harness (`testUtils/pointerHarness.ts`) is this
 * package's. jsdom has no layout and no pointer capture, so this asserts the
 * gesture's DECISIONS (scrub vs click, notches, modifiers, rAF coalescing,
 * undo bracket, typing, arithmetic, keys, ARIA) — not pixels.
 */
import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import { NumberScrubber, NUMBER_SCRUBBER, scrubberValue } from '@apelles/ui';

import {
  actSync,
  firePointerEvent,
  installPointerCaptureStub,
  mount,
  nextFrame,
  type MountedComponent,
} from './testUtils/pointerHarness';

let mounted: MountedComponent | null = null;
let restoreCapture: (() => void) | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  restoreCapture?.();
  restoreCapture = null;
});

const X0 = 200;
const Y = 40;

interface Harness {
  field: HTMLInputElement;
  wrapper: HTMLElement;
  committed: number[];
  events: string[];
}

function render(opts: {
  initial: number;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  precision?: number;
  disabled?: boolean;
  format?: (v: number) => { text: string; unit?: string };
  parse?: (text: string) => number | null;
}): Harness {
  const committed: number[] = [];
  const events: string[] = [];
  restoreCapture = installPointerCaptureStub();

  function Host() {
    const [value, setValue] = React.useState(opts.initial);
    return (
      <NumberScrubber
        aria-label="Scale"
        value={value}
        step={opts.step}
        min={opts.min}
        max={opts.max}
        unit={opts.unit}
        precision={opts.precision}
        format={opts.format}
        parse={opts.parse}
        disabled={opts.disabled}
        onScrubStart={() => events.push('start')}
        onScrubEnd={() => events.push('end')}
        onChange={(v) => {
          committed.push(v);
          events.push(`change:${v}`);
          setValue(v);
        }}
      />
    );
  }
  mounted = mount(<Host />, { strictMode: true });
  const field = mounted.container.querySelector('input') as HTMLInputElement;
  const wrapper = mounted.container.querySelector('[data-slot="number-scrubber"]') as HTMLElement;
  return { field, wrapper, committed, events };
}

async function scrub(
  target: HTMLElement,
  dxPx: number,
  modifiers: { shiftKey?: boolean; altKey?: boolean } = {},
  moves = 4,
): Promise<void> {
  firePointerEvent(target, 'pointerdown', { x: X0, y: Y }, modifiers);
  await nextFrame();
  for (let i = 1; i <= moves; i++) {
    firePointerEvent(window, 'pointermove', { x: X0 + (dxPx * i) / moves, y: Y }, modifiers);
    await nextFrame();
  }
  firePointerEvent(window, 'pointerup', { x: X0 + dxPx, y: Y }, modifiers);
  await nextFrame();
}

function type(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  actSync(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function key(input: HTMLInputElement, k: string, mods: { shiftKey?: boolean; altKey?: boolean } = {}): void {
  actSync(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods }));
  });
}

function focus(input: HTMLInputElement): void {
  actSync(() => input.focus());
}

describe('NumberScrubber — scrubbing', () => {
  it('moves one step per pixel (the spec’s notch), absolute from the press', async () => {
    const { wrapper, committed } = render({ initial: 0, step: 0.01 });
    await scrub(wrapper, 25);
    expect(NUMBER_SCRUBBER.PX_PER_STEP).toBe(1);
    expect(committed.at(-1)).toBe(0.25);
  });

  it('Shift is coarse (x10) and Alt is fine (x0.1); Shift wins over Alt', async () => {
    const a = render({ initial: 0, step: 1 });
    await scrub(a.wrapper, 5, { shiftKey: true });
    expect(a.committed.at(-1)).toBe(50);
    mounted?.unmount();

    const b = render({ initial: 0, step: 1 });
    await scrub(b.wrapper, 5, { altKey: true });
    expect(b.committed.at(-1)).toBe(0.5);
    mounted?.unmount();

    const c = render({ initial: 0, step: 1 });
    await scrub(c.wrapper, 5, { shiftKey: true, altKey: true });
    expect(c.committed.at(-1)).toBe(50);
  });

  it('clamps to min / max', async () => {
    const { wrapper, committed } = render({ initial: 0.9, step: 0.01, min: 0, max: 1 });
    await scrub(wrapper, 50);
    expect(committed.at(-1)).toBe(1);
    expect(Math.max(...committed)).toBe(1);
  });

  it('brackets the gesture so the caller can make ONE undo step, final value inside', async () => {
    const { wrapper, events } = render({ initial: 0, step: 1 });
    await scrub(wrapper, 8);
    expect(events[0]).toBe('start');
    expect(events.at(-1)).toBe('end');
    expect(events.filter((e) => e === 'start')).toHaveLength(1);
    expect(events.filter((e) => e === 'end')).toHaveLength(1);
    expect(events.at(-2)).toBe('change:8');
  });

  it('coalesces a burst of pointer moves into one change per frame, flushing the last on release', async () => {
    const { wrapper, committed } = render({ initial: 0, step: 1 });
    firePointerEvent(wrapper, 'pointerdown', { x: X0, y: Y });
    await nextFrame();
    // Ten moves in ONE frame (a 1000 Hz mouse): the parent hears at most one.
    for (let dx = 5; dx <= 50; dx += 5) firePointerEvent(window, 'pointermove', { x: X0 + dx, y: Y });
    expect(committed).toHaveLength(0);
    firePointerEvent(window, 'pointerup', { x: X0 + 50, y: Y });
    expect(committed).toEqual([50]);
  });

  it('shows the live value locally while the scrub is in flight', async () => {
    const { wrapper, field } = render({ initial: 0, step: 1 });
    firePointerEvent(wrapper, 'pointerdown', { x: X0, y: Y });
    firePointerEvent(window, 'pointermove', { x: X0 + 12, y: Y });
    expect(field.value).toBe('12');
    expect(wrapper.hasAttribute('data-scrubbing')).toBe(true);
    firePointerEvent(window, 'pointerup', { x: X0 + 12, y: Y });
    await nextFrame();
    expect(wrapper.hasAttribute('data-scrubbing')).toBe(false);
  });

  it('Escape mid-drag restores the pre-drag value', async () => {
    const { wrapper, committed, events } = render({ initial: 3, step: 1 });
    firePointerEvent(wrapper, 'pointerdown', { x: X0, y: Y });
    firePointerEvent(window, 'pointermove', { x: X0 + 20, y: Y });
    await nextFrame(); // the frame flush emits 23
    expect(committed.at(-1)).toBe(23);
    actSync(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(committed.at(-1)).toBe(3);
    expect(events.at(-1)).toBe('end');
  });

  it('a press under the slop is a click: nothing changes, the field is focused with all selected', async () => {
    const { wrapper, field, committed, events } = render({ initial: 5, step: 1 });
    firePointerEvent(wrapper, 'pointerdown', { x: X0, y: Y });
    await nextFrame();
    firePointerEvent(window, 'pointermove', { x: X0 + NUMBER_SCRUBBER.CLICK_SLOP_PX - 1, y: Y });
    firePointerEvent(window, 'pointerup', { x: X0, y: Y });
    await nextFrame();
    expect(committed).toEqual([]);
    expect(events).toEqual([]);
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(field.value.length);
  });

  it('a disabled field neither scrubs nor takes focus', async () => {
    const { wrapper, committed, field } = render({ initial: 1, step: 1, disabled: true });
    await scrub(wrapper, 30);
    expect(committed).toEqual([]);
    expect(field.disabled).toBe(true);
  });

  it('scrubberValue quantises and avoids float dust', () => {
    expect(scrubberValue(0, 3, 0.05, 1)).toBe(0.15);
    expect(scrubberValue(1, -3, 0.05, 1)).toBe(0.85);
    expect(scrubberValue(0, 5, 0.01, 0.1)).toBe(0.005);
  });
});

describe('NumberScrubber — typing', () => {
  it('Enter commits the typed number and leaves the field', () => {
    const { field, committed } = render({ initial: 1, step: 0.05 });
    focus(field);
    type(field, '2.5');
    expect(committed).toEqual([]); // not per keystroke
    key(field, 'Enter');
    expect(committed).toEqual([2.5]);
    expect(document.activeElement).not.toBe(field);
  });

  it('Escape reverts and commits nothing', () => {
    const { field, committed } = render({ initial: 1, step: 1 });
    focus(field);
    type(field, '99');
    key(field, 'Escape');
    expect(committed).toEqual([]);
    expect(field.value).toBe('1');
  });

  it('blur commits (clicking elsewhere is not a cancel)', () => {
    const { field, committed } = render({ initial: 1, step: 1 });
    focus(field);
    type(field, '7');
    actSync(() => field.blur());
    expect(committed).toEqual([7]);
  });

  it('evaluates arithmetic against the current value', () => {
    const { field, committed } = render({ initial: 100, step: 1 });
    focus(field);
    type(field, '+10');
    key(field, 'Enter');
    expect(committed.at(-1)).toBe(110);
    focus(field);
    type(field, '*2');
    key(field, 'Enter');
    expect(committed.at(-1)).toBe(220);
    focus(field);
    type(field, '(1920-40)/2');
    key(field, 'Enter');
    expect(committed.at(-1)).toBe(940);
  });

  it('snaps back on text that is not arithmetic, and clamps to the range', () => {
    const { field, committed } = render({ initial: 0.5, step: 0.01, min: 0, max: 1 });
    focus(field);
    type(field, 'banana');
    key(field, 'Enter');
    expect(committed).toEqual([]);
    expect(field.value).toBe('0.5');
    focus(field);
    type(field, '4');
    key(field, 'Enter');
    expect(committed).toEqual([1]);
  });

  it('accepts the field’s own unit when typed back', () => {
    const { field, committed } = render({ initial: 10, step: 1, unit: '%' });
    focus(field);
    type(field, '55%');
    key(field, 'Enter');
    expect(committed).toEqual([55]);
  });
});

describe('NumberScrubber — keyboard and ARIA', () => {
  it('ArrowUp / ArrowDown step by `step`; Shift x10; Alt x0.1', () => {
    const { field, committed } = render({ initial: 1, step: 0.5 });
    focus(field);
    key(field, 'ArrowUp');
    expect(committed.at(-1)).toBe(1.5);
    key(field, 'ArrowDown', { shiftKey: true });
    expect(committed.at(-1)).toBe(-3.5);
    key(field, 'ArrowUp', { altKey: true });
    expect(committed.at(-1)).toBe(-3.45);
  });

  it('steps the typed text, not the stale value, while editing', () => {
    const { field, committed } = render({ initial: 1, step: 1 });
    focus(field);
    type(field, '10');
    key(field, 'ArrowUp');
    expect(committed.at(-1)).toBe(11);
  });

  it('is a spinbutton exposing now / min / max / text and a name', () => {
    const { field } = render({ initial: 0.25, step: 0.01, min: 0, max: 1, unit: '%' });
    expect(field.getAttribute('role')).toBe('spinbutton');
    expect(field.getAttribute('aria-label')).toBe('Scale');
    expect(field.getAttribute('aria-valuenow')).toBe('0.25');
    expect(field.getAttribute('aria-valuemin')).toBe('0');
    expect(field.getAttribute('aria-valuemax')).toBe('1');
    expect(field.getAttribute('aria-valuetext')).toBe('0.25%');
  });

  it('shows the unit as a suffix and honours a fixed precision', () => {
    const { wrapper, field } = render({ initial: 2, step: 1, unit: '°', precision: 1 });
    expect(field.value).toBe('2.0');
    expect(wrapper.textContent).toContain('°');
  });
});

// v0.3.0 panel redesign (B-365, D-442): display text in place of the number.
describe('NumberScrubber — format / parse', () => {
  const pan = {
    format: (v: number) => ({ text: v === 0 ? 'Center' : `${v < 0 ? 'L' : 'R'} ${Math.abs(v)}` }),
    parse: (t: string) => {
      const m = /^([lr])\s*(\d+)$/i.exec(t.trim());
      if (t.trim().toLowerCase() === 'center') return 0;
      return m ? (m[1].toLowerCase() === 'l' ? -1 : 1) * Number(m[2]) : null;
    },
  };

  it('shows the formatted text at rest and as the aria value text', () => {
    const h = render({ initial: -40, ...pan });
    expect(h.field.value).toBe('L 40');
    expect(h.field.getAttribute('aria-valuetext')).toBe('L 40');
    expect(h.field.getAttribute('aria-valuenow')).toBe('-40');
  });

  it('edits from the formatted text and reads it back through parse, else arithmetic', () => {
    const h = render({ initial: 0, ...pan });
    focus(h.field);
    expect(h.field.value).toBe('Center');
    type(h.field, 'R 25');
    key(h.field, 'Enter');
    expect(h.committed).toEqual([25]);
    focus(h.field);
    type(h.field, '-10');
    key(h.field, 'Enter');
    expect(h.committed).toEqual([25, -10]);
  });

  it('a formatted unit replaces the plain unit suffix', () => {
    const h = render({ initial: 3, unit: 'x', format: (v) => ({ text: String(v * 1000), unit: 'Hz' }) });
    expect(h.wrapper.textContent).toContain('Hz');
    expect(h.wrapper.textContent).not.toContain('x');
  });
});
