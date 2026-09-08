import * as React from 'react';
import { Input as InputPrimitive } from '@base-ui/react/input';

import { cn } from '../../lib/utils';

/**
 * B-113 — the strip a `type="number"` field must keep clear for its own
 * native spinner.
 *
 * WebKit (which is what Tauri renders in on macOS) paints
 * `::-webkit-inner-spin-button` inside the input's right edge WITHOUT giving
 * it any layout space, so a right-aligned value is drawn underneath the
 * arrows — the digits are simply not readable. Reserving the strip as real
 * padding is the fix, and it belongs here rather than at each call site: the
 * defect is a property of "a number input", not of any one panel, and every
 * `type="number"` in the app had it.
 *
 * Exported as a class/px pair so a caller that needs to reason about the
 * remaining text width (`@chroma/editor`'s `numericField.ts`) reads the same
 * number this file applies, instead of restating it.
 */
const NUMBER_INPUT_SPINNER_RESERVE = {
  /** `pr-5` = 20px, enough for WebKit's spinner at this font size. */
  className: 'pr-5',
  px: 20,
} as const;

/**
 * shadcn `input` on the Base UI `Input` primitive (D-042).
 *
 * Backwards-compat: the pre-D-042 `@chroma/ui` Input exposed a `bgClassName`
 * prop (default `bg-surface`); three SettingsPanel call sites pass
 * `bgClassName="bg-bg-primary"`. Kept, same default. Everything else is the
 * canonical shadcn input, token-themed.
 *
 * B-113 — a `type="number"` input additionally reserves
 * [`NUMBER_INPUT_SPINNER_RESERVE`] on its right and renders `tabular-nums`.
 * Applied before `className`, so the shadcn "caller's classes win"
 * convention still holds — a caller that really wants its own right padding
 * can set one, it just then owns the spinner overlap too.
 */
function Input({
  className,
  type,
  bgClassName = 'bg-surface',
  ...props
}: React.ComponentProps<'input'> & { bgClassName?: string }) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        'flex h-9 w-full min-w-0 rounded-md border border-input px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none',
        'text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground',
        'file:inline-flex file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20',
        type === 'number' && `${NUMBER_INPUT_SPINNER_RESERVE.className} tabular-nums`,
        bgClassName,
        className,
      )}
      {...props}
    />
  );
}

export { Input, NUMBER_INPUT_SPINNER_RESERVE };
