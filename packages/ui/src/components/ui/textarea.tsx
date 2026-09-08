import * as React from 'react';

import { cn } from '../../lib/utils';

/**
 * shadcn `textarea` (D-042's canonical structure, D-222's first consumer).
 *
 * A plain `<textarea>`, unlike its `Input` sibling: Base UI ships an `Input`
 * primitive but has no textarea primitive of its own (checked against
 * `@base-ui/react`'s own export list, not assumed), and shadcn's own textarea
 * is a bare element too. Classes mirror `input.tsx` field for field — same
 * radius, border, ring, disabled and invalid treatment, same `bgClassName`
 * escape hatch and the same `bg-surface` default — so the two read as one
 * control family rather than two.
 *
 * Does NOT auto-grow, and does not manage its own value: it is an ordinary
 * controlled form element.
 */
function Textarea({
  className,
  bgClassName = 'bg-surface',
  ...props
}: React.ComponentProps<'textarea'> & { bgClassName?: string }) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-16 w-full rounded-md border border-input px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none',
        'text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground',
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

export { Textarea };
