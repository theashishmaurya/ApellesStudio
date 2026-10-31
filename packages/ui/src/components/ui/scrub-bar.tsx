'use client';

import * as React from 'react';
import { Slider as SliderPrimitive } from '@base-ui/react/slider';

import { cn } from '../../lib/utils';

/**
 * A thin position bar for a media viewer (D-432 P5, `docs/notes/ui-redesign.md`
 * §4.11; the owner's answer to open question 6: "a thin 3 px scrub bar").
 *
 * **What it is.** Base UI's `Slider` (the same primitive `slider.tsx` wraps, so
 * pointer capture, keyboard stepping and the ARIA slider role come from the
 * library, not from here) drawn as a 3 px line: the played part in
 * `--color-playhead`, the rest a faint track, and a 9 px playhead-coloured
 * knob that appears only on hover, focus or drag. The hit area is the whole
 * 12 px-tall control, so a 3 px line is still easy to grab.
 *
 * **Keyboard** (Base UI): ←/→ one step, Shift+←/→ and PageUp/PageDown ten
 * (`largeStep`), Home/End to the ends.
 *
 * **What it does NOT do.** It owns no position: `value` and `onValueChange`
 * are the caller's, exactly like `Slider`. Single value only.
 */
export interface ScrubBarProps
  extends Omit<SliderPrimitive.Root.Props<number>, 'value' | 'defaultValue' | 'onValueChange' | 'onValueCommitted'> {
  value: number;
  onValueChange?: (value: number) => void;
  /** The gesture ended: pointer up or key up. */
  onValueCommitted?: () => void;
}

function ScrubBar({ className, value, onValueChange, onValueCommitted, ...props }: ScrubBarProps) {
  return (
    <SliderPrimitive.Root
      data-slot="scrub-bar"
      value={value}
      onValueChange={(v) => onValueChange?.(Array.isArray(v) ? v[0] : (v as number))}
      onValueCommitted={() => onValueCommitted?.()}
      className={cn('group/scrub w-full', className)}
      {...props}
    >
      <SliderPrimitive.Control className="relative flex h-3 w-full cursor-pointer touch-none items-center select-none data-disabled:cursor-default data-disabled:opacity-50">
        <SliderPrimitive.Track
          data-slot="scrub-bar-track"
          className="relative h-[3px] w-full overflow-hidden bg-border-color"
        >
          <SliderPrimitive.Indicator data-slot="scrub-bar-range" className="absolute h-full bg-playhead" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          data-slot="scrub-bar-thumb"
          className="block size-[9px] rounded-full bg-playhead opacity-0 outline-hidden transition-opacity group-hover/scrub:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring data-dragging:opacity-100 data-disabled:hidden"
        />
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { ScrubBar };
