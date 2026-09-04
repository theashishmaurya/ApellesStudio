'use client';

import * as React from 'react';
import { Slider as SliderPrimitive } from '@base-ui/react/slider';

import { cn } from '../../lib/utils';

/**
 * shadcn `slider` on Base UI (D-042). Base UI wraps the track in a `Control`
 * and renders a `Thumb` per value; the visual language matches the shadcn
 * Radix slider.
 *
 * B-050/D-131: every orientation-conditional class below used to read
 * `data-horizontal:`/`data-vertical:` — Tailwind's bare `data-<name>:`
 * shorthand compiles to a presence check on a literally-named attribute
 * (`&[data-horizontal]`), not a value match. Base UI stamps orientation as
 * `data-orientation="horizontal"` (confirmed by reading
 * `@base-ui/react`'s `getStateAttributesProps`, which maps a non-boolean
 * state value to `data-${key}="${value}"`), so `[data-horizontal]` never
 * matched anything — Track/Indicator got no explicit size, collapsed to
 * `auto` (0, since their content is absolutely positioned and doesn't
 * contribute to it), and disappeared. The upstream shadcn source for this
 * exact component uses `data-[orientation=horizontal]:`; that's the correct
 * form, verified against a real compile of this app's own `styles.css`
 * through `@tailwindcss/node`'s `compile()` (see D-131 for the generated
 * selectors). `data-disabled:` is untouched — Base UI stamps `disabled` as
 * a bare boolean attribute (`data-disabled`, no value), which the shorthand
 * form matches correctly.
 */
function Slider({ className, defaultValue, value, min = 0, max = 100, ...props }: SliderPrimitive.Root.Props) {
  const _values = React.useMemo(
    () => (Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min, max]),
    [value, defaultValue, min, max],
  );

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn('data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full', className)}
      {...props}
    >
      <SliderPrimitive.Control className="relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col">
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="relative grow overflow-hidden rounded-full bg-muted data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5"
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className="absolute rounded-full bg-primary data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full"
          />
        </SliderPrimitive.Track>
        {Array.from({ length: _values.length }, (_, index) => (
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            key={index}
            className="block size-4 shrink-0 rounded-full border border-primary bg-white shadow-sm ring-ring/50 transition-[color,box-shadow] hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden data-disabled:pointer-events-none data-disabled:opacity-50"
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
