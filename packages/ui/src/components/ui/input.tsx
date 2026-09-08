import * as React from 'react';
import { Input as InputPrimitive } from '@base-ui/react/input';

import { cn } from '../../lib/utils';

/**
 * B-113 (completed by D-253) — every `type="number"` field renders with NO
 * native spinner at all.
 *
 * WebKit (which is what Tauri renders in on macOS) paints
 * `::-webkit-inner-spin-button` inside the input's right edge, and a
 * right-aligned value is drawn underneath the arrows — the digits are simply
 * not readable. B-113's first attempt reserved a `pr-5` strip for the spinner
 * instead, which could not have worked and did not: the spin button is laid
 * out INSIDE the field's padding box, so more `padding-right` shifts the text
 * AND the spinner left by the same amount and the overlap survives exactly,
 * at any value length. Removing the widget is the fix.
 *
 * Nothing accessible is lost. `appearance` governs the spin BUTTON, not the
 * input's behaviour: ArrowUp/ArrowDown still step by `step`, and the pointer
 * affordance the arrows used to (badly) offer is now the drag-to-scrub gesture
 * in `ScrubbableNumberInput`, which is what the app's numeric fields use.
 *
 * Applied here rather than at each call site: the defect is a property of "a
 * number input", not of any one panel, and every `type="number"` in the app —
 * including the vendored RapidRAW fork's, via `app/src/components/ui/Input.tsx`
 * — had it. Exported so a caller reasoning about the field's usable text width
 * (`@chroma/editor`'s `numericField.ts`) can assert on the same string this
 * file applies rather than restating it.
 */
const NUMBER_INPUT_SPINNER_SUPPRESSION =
  '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';

/**
 * shadcn `input` on the Base UI `Input` primitive (D-042).
 *
 * Backwards-compat: the pre-D-042 `@chroma/ui` Input exposed a `bgClassName`
 * prop (default `bg-surface`); three SettingsPanel call sites pass
 * `bgClassName="bg-bg-primary"`. Kept, same default. Everything else is the
 * canonical shadcn input, token-themed.
 *
 * B-113 — a `type="number"` input additionally drops its native spinner
 * ([`NUMBER_INPUT_SPINNER_SUPPRESSION`]) and renders `tabular-nums`. Applied
 * before `className`, so the shadcn "caller's classes win" convention still
 * holds.
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
        type === 'number' && `${NUMBER_INPUT_SPINNER_SUPPRESSION} tabular-nums`,
        bgClassName,
        className,
      )}
      {...props}
    />
  );
}

export { Input, NUMBER_INPUT_SPINNER_SUPPRESSION };
