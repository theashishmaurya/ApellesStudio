// @vitest-environment jsdom
/**
 * @apelles/editor — `@apelles/ui`'s `SliderField` on a real DOM (D-432 §4.10,
 * v0.3.0 gap closure, B-359 item 2).
 *
 * Lives here for `NumberScrubber.dom.test.tsx`'s reason: the real-`PointerEvent`
 * harness is this package's. Pins the contract the Inspector relies on: the
 * slider and the field drive one value, a slider gesture (a drag or one key
 * press) is bracketed by exactly one `onScrubStart` / `onScrubEnd`, changes are
 * coalesced per frame with the last value flushed before the bracket closes,
 * double-click resets, and the slider's span does not clamp the field.
 */
import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import { SLIDER_FIELD, SliderField } from '@apelles/ui';

import {
  actSync,
  firePointerEvent,
  installPointerCaptureStub,
  mount,
  nextFrame,
  type MountedComponent,
} from './testUtils/pointerHarness';

let mounted: MountedComponent | null = null;
let restore: Array<() => void> = [];

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  for (const r of restore) r();
  restore = [];
});

const TRACK = { left: 100, width: 200, top: 0, height: 12 };

function stubTrackRect(): void {
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const slot = this.getAttribute('data-slot');
    if (slot === 'inline-slider-track' || this.closest('[data-slot="inline-slider"]') === this.parentElement) {
      return {
        x: TRACK.left,
        y: TRACK.top,
        left: TRACK.left,
        top: TRACK.top,
        width: TRACK.width,
        height: TRACK.height,
        right: TRACK.left + TRACK.width,
        bottom: TRACK.top + TRACK.height,
        toJSON: () => ({}),
      } as DOMRect;
    }
    return original.call(this);
  };
  restore.push(() => {
    HTMLElement.prototype.getBoundingClientRect = original;
  });
}

interface Harness {
  root: HTMLElement;
  thumbInput: HTMLInputElement;
  field: HTMLInputElement;
  events: string[];
  value: () => number;
}

function render(opts: { initial: number; min?: number; max?: number; onReset?: boolean }): Harness {
  const events: string[] = [];
  let current = opts.initial;
  restore.push(installPointerCaptureStub());
  function Host() {
    const [value, setValue] = React.useState(opts.initial);
    current = value;
    return (
      <SliderField
        aria-label="Opacity"
        value={value}
        step={0.01}
        min={opts.min}
        max={opts.max}
        sliderMin={0}
        sliderMax={1}
        onScrubStart={() => events.push('start')}
        onScrubEnd={() => events.push('end')}
        onReset={
          opts.onReset
            ? () => {
                events.push('reset');
                setValue(1);
              }
            : undefined
        }
        onChange={(v) => {
          events.push(`change:${v}`);
          setValue(v);
        }}
      />
    );
  }
  mounted = mount(<Host />, { strictMode: true });
  const root = mounted.container.querySelector('[data-slot="slider-field"]') as HTMLElement;
  const thumbInput = mounted.container.querySelector('[data-slot="inline-slider"] input') as HTMLInputElement;
  const field = mounted.container.querySelector('[data-slot="number-scrubber"] input') as HTMLInputElement;
  return { root, thumbInput, field, events, value: () => current };
}

describe('SliderField', () => {
  it('draws the spec geometry: a 3 px track, a 12 px thumb and a 56 px field', () => {
    const h = render({ initial: 0.5 });
    expect(SLIDER_FIELD).toEqual({ TRACK_PX: 3, THUMB_PX: 12, FIELD_PX: 56 });
    const track = h.root.querySelector('[data-slot="inline-slider-track"]') as HTMLElement;
    const thumb = h.root.querySelector('[data-slot="inline-slider-thumb"]') as HTMLElement;
    const field = h.root.querySelector('[data-slot="number-scrubber"]') as HTMLElement;
    expect(track.className).toContain('h-[3px]');
    expect(thumb.className).toContain('size-3');
    expect(field.className).toContain('w-14');
  });

  it('exposes a keyboard-reachable slider named after the field', () => {
    const h = render({ initial: 0.5 });
    expect(h.thumbInput.getAttribute('aria-label')).toBe('Opacity slider');
    expect(h.thumbInput.getAttribute('aria-valuetext')).toBe('0.5');
    expect(h.field.getAttribute('aria-label')).toBe('Opacity');
  });

  it('one arrow key press is one bracketed change', async () => {
    const h = render({ initial: 0.5 });
    actSync(() => h.thumbInput.focus());
    actSync(() => {
      h.thumbInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    });
    await nextFrame();
    actSync(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
    });
    await nextFrame();
    expect(h.events).toEqual(['start', 'change:0.51', 'end']);
    expect(h.value()).toBe(0.51);
  });

  it('a pointer drag is ONE start / end pair, the final value flushed before the end', async () => {
    stubTrackRect();
    const h = render({ initial: 0.5 });
    const control = h.thumbInput.closest('[data-slot="inline-slider"]')?.firstElementChild as HTMLElement;
    firePointerEvent(control, 'pointerdown', { x: TRACK.left + 100, y: 6 });
    await nextFrame();
    for (const x of [140, 160, 180, 220]) {
      firePointerEvent(document, 'pointermove', { x: TRACK.left + x, y: 6 });
      await nextFrame();
    }
    firePointerEvent(document, 'pointerup', { x: TRACK.left + 180, y: 6 });
    firePointerEvent(window, 'pointerup', { x: TRACK.left + 180, y: 6 });
    await nextFrame();
    expect(h.events.filter((e) => e === 'start')).toHaveLength(1);
    expect(h.events.filter((e) => e === 'end')).toHaveLength(1);
    expect(h.events[0]).toBe('start');
    expect(h.events.at(-1)).toBe('end');
    // The last change lands before the bracket closes, and it is the release point.
    const changes = h.events.filter((e) => e.startsWith('change:'));
    expect(changes.length).toBeGreaterThan(0);
    expect(h.value()).toBeGreaterThan(0.5);
  });

  it('double-click on the slider resets', async () => {
    const h = render({ initial: 0.2, onReset: true });
    const control = h.thumbInput.closest('[data-slot="inline-slider"]')?.firstElementChild as HTMLElement;
    actSync(() => {
      control.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(h.events).toContain('reset');
    expect(h.value()).toBe(1);
  });

  it('the slider span does not clamp the field: a typed value past it is kept and the thumb pins', async () => {
    const h = render({ initial: 0.5, min: 0, max: 4 });
    actSync(() => h.field.focus());
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    actSync(() => {
      setter?.call(h.field, '3');
      h.field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    actSync(() => {
      h.field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(h.value()).toBe(3);
    expect(h.thumbInput.getAttribute('aria-valuenow') ?? h.thumbInput.value).toBe('1');
  });
});
