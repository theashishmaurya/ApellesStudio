'use client';

import { Switch as SwitchPrimitive } from '@base-ui/react/switch';

import { cn } from '../../lib/utils';

/**
 * shadcn `switch` on the Base UI `Switch` primitive (D-042).
 *
 * Base UI drives the knob slide, so the framer-motion spring the pre-D-042
 * hand-extraction had to drop is back as a real transition (`data-checked`
 * translate).
 */
function Switch({
  className,
  size = 'default',
  ...props
}: SwitchPrimitive.Root.Props & {
  size?: 'sm' | 'default';
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        'peer group/switch inline-flex shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'data-disabled:cursor-not-allowed data-disabled:opacity-50',
        'data-[size=default]:h-[1.15rem] data-[size=default]:w-8 data-[size=sm]:h-3.5 data-[size=sm]:w-6',
        'data-checked:bg-primary data-unchecked:bg-input',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block rounded-full bg-background ring-0 transition-transform',
          'group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3',
          'data-checked:translate-x-[calc(100%-2px)] data-unchecked:translate-x-0',
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
