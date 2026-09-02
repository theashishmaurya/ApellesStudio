import * as React from 'react';
import { Input as InputPrimitive } from '@base-ui/react/input';

import { cn } from '../../lib/utils';

/**
 * shadcn `input` on the Base UI `Input` primitive (D-042).
 *
 * Backwards-compat: the pre-D-042 `@chroma/ui` Input exposed a `bgClassName`
 * prop (default `bg-surface`); three SettingsPanel call sites pass
 * `bgClassName="bg-bg-primary"`. Kept, same default. Everything else is the
 * canonical shadcn input, token-themed.
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
        bgClassName,
        className,
      )}
      {...props}
    />
  );
}

export { Input };
