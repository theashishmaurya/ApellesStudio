'use client';

import { Toaster as Sonner, type ToasterProps } from 'sonner';

/**
 * shadcn `sonner` toast (D-042).
 *
 * The shadcn source reads the active theme from `next-themes`; Apelles has no
 * next-themes (RapidRAW swaps `--app-*` vars at runtime, `app/src/utils/themes.ts`).
 * The toast surface is driven entirely by the mapped CSS vars below, so it
 * always tracks the current RapidRAW theme without a `theme` prop. `theme`
 * still passes through for an explicit override.
 */
function Toaster({ theme = 'dark', ...props }: ToasterProps) {
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      style={
        {
          '--normal-bg': 'var(--color-popover)',
          '--normal-text': 'var(--color-popover-foreground)',
          '--normal-border': 'var(--color-border)',
          '--border-radius': 'var(--radius)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster };
