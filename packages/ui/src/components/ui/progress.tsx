'use client';

import { Progress as ProgressPrimitive } from '@base-ui/react/progress';

import { cn } from '../../lib/utils';

/** shadcn `progress` on Base UI (D-042) — a DETERMINATE progress bar.
 *
 * Added by D-362 for the Edit tab's export queue, which now has a real
 * percentage to show instead of a spinner. Base UI's `Progress` is what makes
 * it accessible without hand-rolling the ARIA: `Root` owns the value and emits
 * `role="progressbar"` with the right `aria-valuenow`/`min`/`max`, and an
 * indeterminate state is simply `value={null}`.
 *
 * Does NOT own a label or a percentage caption — those are `Progress.Label` /
 * `Progress.Value`, left to the caller, because a queue row and a modal want
 * them in very different places. */
function Progress({
  className,
  trackClassName,
  ...props
}: ProgressPrimitive.Root.Props & { trackClassName?: string }) {
  return (
    <ProgressPrimitive.Root data-slot="progress" className={cn('w-full', className)} {...props}>
      <ProgressPrimitive.Track
        data-slot="progress-track"
        className={cn('relative h-1 w-full overflow-hidden rounded-full bg-surface', trackClassName)}
      >
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className="h-full rounded-full bg-accent transition-[width] duration-200 ease-out"
        />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  );
}

export { Progress };
