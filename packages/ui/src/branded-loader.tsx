/**
 * BrandedLoader — the Apelles loading state (B-369).
 *
 * What it is: the one component for a wait long enough to explain: the real
 * Apelles mark (`assets/apelles-mark-256.png`, exported from the brand master
 * `brand/apelles-mark-transparent.png`, never redrawn — CLAUDE.md's asset rule),
 * the current step in words ("Checking media (120/288)…"), and a bar that is
 * determinate when the caller knows a fraction and indeterminate otherwise.
 *
 * Three sizes: `overlay` fills its positioned parent (the full-window project
 * open), `inline` centres in a pane (a timeline switch), `compact` sits on a
 * card (the launcher card being opened).
 *
 * Motion: the mark breathes (opacity + a 2 % scale) and an indeterminate bar
 * sweeps, both from the `--animate-loader-*` theme entries in `styles.css`, and
 * both only under `motion-safe:` — with `prefers-reduced-motion: reduce` the
 * mark is still and the indeterminate bar is a static track.
 *
 * What it does NOT do: know what is loading or when it ends. The caller owns
 * the label, the fraction and whether to render it at all.
 */

import markSrc from './assets/apelles-mark-256.png';
import { cn } from './lib/utils';
import { Progress } from './components/ui/progress';

export type BrandedLoaderVariant = 'overlay' | 'inline' | 'compact';

export interface BrandedLoaderProps {
  /** The current step, in words. Announced to assistive tech as it changes. */
  label: string;
  /** What is loading (a project name); shown above the label. */
  title?: string;
  /** 0..1 when known; null or absent for an indeterminate bar. */
  progress?: number | null;
  variant?: BrandedLoaderVariant;
  className?: string;
}

const MARK_SIZE: Record<BrandedLoaderVariant, string> = {
  overlay: 'size-24',
  inline: 'size-16',
  compact: 'size-10',
};

const BAR_WIDTH: Record<BrandedLoaderVariant, string> = {
  overlay: 'w-64',
  inline: 'w-48',
  compact: 'w-32',
};

export function BrandedLoader({ label, title, progress = null, variant = 'inline', className }: BrandedLoaderProps) {
  const determinate = typeof progress === 'number' && Number.isFinite(progress);
  const pct = determinate ? Math.round(Math.min(1, Math.max(0, progress)) * 100) : null;
  return (
    <div
      data-slot="branded-loader"
      data-variant={variant}
      role="status"
      aria-live="polite"
      className={cn(
        'flex flex-col items-center justify-center text-center',
        variant === 'compact' ? 'gap-2' : 'gap-4',
        variant === 'overlay' && 'absolute inset-0 bg-bg-primary',
        variant === 'inline' && 'size-full',
        className,
      )}
    >
      <img
        src={markSrc}
        alt="Apelles"
        draggable={false}
        data-slot="branded-loader-mark"
        className={cn(MARK_SIZE[variant], 'select-none motion-safe:animate-loader-breathe')}
      />
      <div className={cn('flex flex-col items-center', variant === 'compact' ? 'gap-0.5' : 'gap-1')}>
        {title && variant !== 'compact' && (
          <div data-slot="branded-loader-title" className="text-base font-semibold text-text-primary">
            {title}
          </div>
        )}
        <div
          data-slot="branded-loader-label"
          className={cn('tabular-nums', variant === 'compact' ? 'text-xs font-medium text-text-primary' : 'text-sm text-text-secondary')}
        >
          {label}
        </div>
      </div>
      {determinate ? (
        <Progress
          value={pct}
          aria-label={label}
          className={BAR_WIDTH[variant]}
          trackClassName="bg-bg-secondary"
        />
      ) : (
        <div
          data-slot="branded-loader-indeterminate"
          aria-hidden="true"
          className={cn('relative h-1 overflow-hidden rounded-full bg-bg-secondary', BAR_WIDTH[variant])}
        >
          <div className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-accent opacity-0 motion-safe:opacity-100 motion-safe:animate-loader-sweep" />
        </div>
      )}
    </div>
  );
}
