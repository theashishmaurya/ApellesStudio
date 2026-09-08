// @vitest-environment jsdom
/**
 * @chroma/editor — drag-to-scrub on a numeric field (D-253, finishing B-113).
 *
 * **Why the tests for a `@chroma/ui` component live in `@chroma/editor`.**
 * `@chroma/ui` has no test tier at all today (only `bridge`, `editor`,
 * `history`, `motion` and `debug` have one), and this file's real subject —
 * real `PointerEvent`s, correctly sequenced, a frame apart, under
 * `<React.StrictMode>` — needs the harness `@chroma/editor` already owns
 * (`testUtils/pointerHarness.ts`, D-142). Building a second copy of that
 * harness in `@chroma/ui` to test one component is exactly the duplication
 * this repo's own rules exist to stop; standing up a whole vitest tier there
 * for it is a bigger, separate change. The component is also consumed here
 * more than anywhere else, so this is where a regression would actually bite.
 *
 * **What this tier can and cannot prove.** jsdom has no layout engine and no
 * pointer capture — so this file asserts the gesture's DECISIONS (did the
 * press become a drag, by how many steps, under which modifier, clamped where)
 * against real dispatched events, not pixels. Whether `cursor-ew-resize`
 * actually paints, and whether WebKit's spin buttons are really gone, is the
 * owner's own eye against the running app; the class assertions in
 * `PropertyRow.numericField.dom.test.tsx` are the closest a test gets.
 */

import { describe, expect, it, afterEach } from 'vitest';
import React from 'react';
import { NUMBER_SCRUB, ScrubbableNumberInput } from '@chroma/ui';

import {
  actSync,
  captureConsole,
  firePointerEvent,
  installPointerCaptureStub,
  mount,
  nextFrame,
  waitFrames,
  type MountedComponent,
} from './testUtils/pointerHarness';

let mounted: MountedComponent | null = null;
let restorePointerCapture: (() => void) | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  restorePointerCapture?.();
  restorePointerCapture = null;
});

/** The press point. Arbitrary — every assertion below is about the DELTA from
 *  it, which is the only thing the gesture reads. */
const X0 = 200;
const Y = 40;

interface Harness {
  input: HTMLInputElement;
  /** Every value the field has committed, oldest first. */
  committed: number[];
}

/** A real `ScrubbableNumberInput` in a real DOM, wired to a real controlled
 *  value the way every call site wires it. */
function render(opts: {
  initial: number;
  step: number;
  min?: number;
  max?: number;
  disabled?: boolean;
}): Harness {
  const committed: number[] = [];
  // jsdom implements no pointer-capture API; the component calls
  // `setPointerCapture` defensively, and this is the existing stub for it.
  restorePointerCapture = installPointerCaptureStub();

  function Host() {
    const [value, setValue] = React.useState(opts.initial);
    return (
      <ScrubbableNumberInput
        value={value}
        step={opts.step}
        min={opts.min}
        max={opts.max}
        disabled={opts.disabled}
        aria-label="Test field"
        onValueChange={(next) => {
          committed.push(next);
          setValue(next);
        }}
      />
    );
  }

  mounted = mount(<Host />, { strictMode: true });
  const input = mounted.container.querySelector('input');
  if (!input) throw new Error('no input rendered');
  return { input: input as HTMLInputElement, committed };
}

/** Press at [`X0`], travel `dxPx` in four real frames, release. Mirrors
 *  `dragPointer` but pins the press to the input and the moves to `window`,
 *  which is where the component registers them (see its own doc). */
async function scrub(
  input: HTMLInputElement,
  dxPx: number,
  modifiers: { shiftKey?: boolean; metaKey?: boolean } = {},
): Promise<void> {
  firePointerEvent(input, 'pointerdown', { x: X0, y: Y }, modifiers);
  await nextFrame();
  for (let i = 1; i <= 4; i++) {
    firePointerEvent(window, 'pointermove', { x: X0 + (dxPx * i) / 4, y: Y }, modifiers);
    await nextFrame();
  }
  firePointerEvent(window, 'pointerup', { x: X0 + dxPx, y: Y }, modifiers);
  await nextFrame();
}

/** Type `text` into a controlled React number input. Setting `.value`
 *  directly bypasses React's value tracker, so the native setter is used and a
 *  bubbling `input` event fired — React's own documented interop path, and the
 *  same one `EditorInspectorPanel.keyframes.dom.test.tsx` already uses. */
function type(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  actSync(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('drag-to-scrub — the notch (D-253)', () => {
  it('moves the value by exactly round(dx / PX_PER_STEP) steps', async () => {
    // The owner's own case: a crop inset, whose step is a hundredth. Eighty
    // pixels is ten notches, so ten hundredths — 0.10, not "some amount".
    const { input, committed } = render({ initial: 0, step: 0.01 });
    await scrub(input, 80);
    expect(committed.at(-1)).toBe(0.1);
    expect(80 / NUMBER_SCRUB.PX_PER_STEP).toBe(10);
  });

  it('runs backwards as readily as forwards', async () => {
    const { input, committed } = render({ initial: 1, step: 0.05 });
    await scrub(input, -48); // 6 notches of 0.05
    expect(committed.at(-1)).toBe(0.7);
  });

  it('quantises to whole steps rather than to the pixel', async () => {
    // 20px is 2.5 notches; the value lands on a real notch, not on 2.5 of one.
    const { input, committed } = render({ initial: 0, step: 1 });
    await scrub(input, 20);
    expect(committed.at(-1)).toBe(3); // Math.round(2.5) === 3
    expect(committed.every(Number.isInteger)).toBe(true);
  });

  it('lands on a clean decimal, not on float dust', async () => {
    // `0 + 3 * 0.05` is 0.15000000000000002 in raw IEEE arithmetic. Rounding
    // to the DECLARED step's own decimals is what keeps that off the screen.
    const { input, committed } = render({ initial: 0, step: 0.05 });
    await scrub(input, 24);
    expect(committed.at(-1)).toBe(0.15);
    expect(String(committed.at(-1))).toBe('0.15');
  });

  it('is absolute, not cumulative — every value is measured from the press', async () => {
    const { input, committed } = render({ initial: 0, step: 1 });
    await scrub(input, 32); // four notches, over four intermediate moves
    // Not 1+2+3+4: each move recomputes from the press-time value, so a
    // dropped or repeated move event cannot accumulate error.
    expect(committed).toEqual([1, 2, 3, 4]);
  });
});

describe('drag-to-scrub — the modifiers (D-253)', () => {
  it('Shift is the coarse pass: ten steps per notch', async () => {
    const { input, committed } = render({ initial: 0, step: 0.01 });
    await scrub(input, 80, { shiftKey: true });
    expect(committed.at(-1)).toBe(1); // 10 notches x 0.01 x 10
    expect(NUMBER_SCRUB.COARSE_FACTOR).toBe(10);
  });

  it('Meta is the fine pass: a tenth of a step per notch', async () => {
    const { input, committed } = render({ initial: 0, step: 0.01 });
    await scrub(input, 80, { metaKey: true });
    // A tenth of the field's own step — a place the step alone cannot reach,
    // which is the whole point of the fine pass.
    expect(committed.at(-1)).toBe(0.01);
    expect(NUMBER_SCRUB.FINE_FACTOR).toBe(0.1);
  });

  it('Shift wins when both are held, rather than silently going fine', async () => {
    const { input, committed } = render({ initial: 0, step: 1 });
    await scrub(input, 80, { shiftKey: true, metaKey: true });
    expect(committed.at(-1)).toBe(100);
  });
});

describe('drag-to-scrub — click versus drag (D-253)', () => {
  it('a press that never moves changes nothing and leaves the field typable', async () => {
    const { input, committed } = render({ initial: 0.5, step: 0.01 });
    firePointerEvent(input, 'pointerdown', { x: X0, y: Y });
    await nextFrame();
    firePointerEvent(window, 'pointerup', { x: X0, y: Y });
    await nextFrame();

    expect(committed).toEqual([]);
    // Nothing was `preventDefault`ed, so focusing still works — which is what
    // makes "double-click and type an exact value" available at all.
    expect(input.hasAttribute('data-scrubbing')).toBe(false);
  });

  it('3px is still a click; 5px is a scrub — the 4px threshold, both sides', async () => {
    const under = render({ initial: 0, step: 1 });
    await scrub(under.input, 3);
    expect(under.committed).toEqual([]);
    mounted?.unmount();
    mounted = null;
    restorePointerCapture?.();
    restorePointerCapture = null;

    const over = render({ initial: 0, step: 1 });
    await scrub(over.input, 5);
    expect(over.committed.length).toBeGreaterThan(0);
    expect(over.committed.at(-1)).toBe(1); // round(5/8) === 1
    expect(NUMBER_SCRUB.MIN_DRAG_PX).toBe(4);
  });

  it('marks itself as scrubbing only while the drag is live', async () => {
    const { input } = render({ initial: 0, step: 1 });
    firePointerEvent(input, 'pointerdown', { x: X0, y: Y });
    await nextFrame();
    expect(input.hasAttribute('data-scrubbing')).toBe(false); // a press, not yet a drag
    firePointerEvent(window, 'pointermove', { x: X0 + 40, y: Y });
    await nextFrame();
    expect(input.hasAttribute('data-scrubbing')).toBe(true);
    firePointerEvent(window, 'pointerup', { x: X0 + 40, y: Y });
    await nextFrame();
    expect(input.hasAttribute('data-scrubbing')).toBe(false);
  });

  it('a cancelled pointer ends the drag rather than leaving it stuck live', async () => {
    const { input, committed } = render({ initial: 0, step: 1 });
    firePointerEvent(input, 'pointerdown', { x: X0, y: Y });
    await nextFrame();
    firePointerEvent(window, 'pointermove', { x: X0 + 40, y: Y });
    await nextFrame();
    firePointerEvent(window, 'pointercancel', { x: X0 + 40, y: Y });
    await nextFrame();
    const afterCancel = committed.length;

    // Moves after the cancel are somebody else's gesture now.
    firePointerEvent(window, 'pointermove', { x: X0 + 400, y: Y });
    await nextFrame();
    expect(committed.length).toBe(afterCancel);
    expect(input.hasAttribute('data-scrubbing')).toBe(false);
  });
});

describe('drag-to-scrub — range and disabled state (D-253)', () => {
  it('pins a scrub at the field’s own min and max', async () => {
    const high = render({ initial: 0.9, step: 0.05, min: 0, max: 1 });
    await scrub(high.input, 400); // 50 notches; would be 3.4 unclamped
    expect(high.committed.at(-1)).toBe(1);
    mounted?.unmount();
    mounted = null;
    restorePointerCapture?.();
    restorePointerCapture = null;

    const low = render({ initial: 0.1, step: 0.05, min: 0, max: 1 });
    await scrub(low.input, -400);
    expect(low.committed.at(-1)).toBe(0);
  });

  it('a disabled field does not scrub at all', async () => {
    const { input, committed } = render({ initial: 0, step: 1, disabled: true });
    await scrub(input, 80);
    expect(committed).toEqual([]);
  });
});

describe('the field still reads and edits like a number field (B-113)', () => {
  it('shows the rounded value at rest and the exact one on focus', async () => {
    // 0.052212 is a REAL value out of the owner's project — an on-canvas crop
    // drag stores full float precision.
    const { input, committed } = render({ initial: 0.052212, step: 0.01 });
    await waitFrames(1);
    expect(input.value).toBe('0.052');

    // A real focus, not a synthesised event: React delegates `onFocus` off
    // `focusin`, which only `HTMLElement.focus()` actually raises.
    actSync(() => input.focus());
    await waitFrames(1);
    expect(input.value).toBe('0.052212');

    actSync(() => input.blur());
    await waitFrames(1);
    expect(input.value).toBe('0.052');
    // Nothing was committed by looking at it.
    expect(committed).toEqual([]);
  });

  it('a scrub leaves the field showing the number it committed', async () => {
    const { input, committed } = render({ initial: 0, step: 0.01 });
    await scrub(input, 80);
    await waitFrames(1);
    expect(committed.at(-1)).toBe(0.1);
    expect(input.value).toBe('0.1');
  });

  it('lets a full-precision decimal be typed a character at a time', async () => {
    // The draft string is what makes this possible: without it, every
    // keystroke would be re-rendered from the parsed number and the trailing
    // `2` of `0.0522` would be erased under the caret each time.
    const { input, committed } = render({ initial: 0, step: 0.01 });
    actSync(() => input.focus());
    await waitFrames(1);
    // `0.` is in the run deliberately, and is deliberately NOT asserted on:
    // a `type="number"` input's own value-sanitisation algorithm reports `''`
    // for a half-typed number, in jsdom and in a real browser alike. What
    // matters is that passing through that state neither commits anything nor
    // erases the digits already typed — which is what the NEXT iteration's
    // assertion proves.
    for (const text of ['0', '0.', '0.0', '0.05', '0.052', '0.0522', '0.052212']) {
      type(input, text);
      await waitFrames(1);
      if (text !== '0.') expect(input.value).toBe(text);
    }
    expect(committed.at(-1)).toBe(0.052212);
    // The rounding is a DISPLAY rounding only: the stored value is intact, and
    // comes back in full the moment the field is focused.
    actSync(() => input.blur());
    await waitFrames(1);
    expect(input.value).toBe('0.052');
    actSync(() => input.focus());
    await waitFrames(1);
    expect(input.value).toBe('0.052212');
  });

  it('pins a TYPED out-of-range value on blur, not mid-keystroke', async () => {
    // Mid-keystroke clamping is what makes a field with a floor impossible to
    // type into: `5` on the way to `50` would snap to the minimum every time.
    const { input, committed } = render({ initial: 50, step: 1, min: 10, max: 100 });
    actSync(() => input.focus());
    await waitFrames(1);
    type(input, '5');
    await waitFrames(1);
    expect(committed.at(-1)).toBe(5); // not yet pinned — still being typed
    type(input, '500');
    await waitFrames(1);
    actSync(() => input.blur());
    await waitFrames(1);
    expect(committed.at(-1)).toBe(100);
    expect(input.value).toBe('100');
  });

  it('runs a whole gesture with no console error or warning', async () => {
    const console = captureConsole();
    try {
      const { input } = render({ initial: 0, step: 0.01 });
      await scrub(input, 80, { shiftKey: true });
      expect(console.errors).toEqual([]);
      expect(console.warnings).toEqual([]);
    } finally {
      console.restore();
    }
  });
});
