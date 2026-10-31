/**
 * @apelles/ui — InspectorRow: one label / control / keyframe-slot row (D-432, P4).
 *
 * **What it is.** The Inspector's row grid, defined once so no panel carries
 * ad-hoc widths: a **92 px label column** (`--text-xs`, secondary, one line,
 * full text on hover), a flexible **control** cell, and an optional **fixed
 * 80 px slot** at the right for the keyframe controls and reset.
 *
 * **What it does NOT do.** It owns no behaviour and no value. The control is
 * whatever the caller passes (a `NumberScrubber`, a `Select`, a toggle); the
 * slot is whatever the caller passes too (`@apelles/editor`'s `PropertyRow`
 * fills it with ‹ ◇ › and reset).
 *
 * **Why the slot is fixed (the layout-shift rule).** Today's rows squeezed
 * four `icon-xs` buttons next to the field, so hover, or a property becoming
 * animated, resized the value. The slot always takes its width; its content
 * fades in with `opacity`/`visibility`, which cost no layout. With no `slot`
 * prop the control spans the slot's column too (a Select, a paired field).
 *
 * Rows are at least 26 px high (the spec's row height) and `group`, so a
 * child can reveal itself on row hover with `group-hover:` classes.
 */
import * as React from 'react';

import { cn } from '../../lib/utils';

/** The declared geometry, restated for tests (the classes below are the same
 *  numbers — Tailwind needs literal class strings). */
export const INSPECTOR_ROW = {
  /** `grid-cols-[92px_…]` */
  LABEL_PX: 92,
  /** `…_80px]` */
  SLOT_PX: 80,
  /** `min-h-[26px]` */
  MIN_HEIGHT_PX: 26,
} as const;

export interface InspectorRowProps {
  label: string;
  /** Tooltip for the label; defaults to the label itself (the truncation
   *  escape hatch — the full text is always one hover away). */
  labelTitle?: string;
  /** The right-hand fixed slot. Omit to let the control span it. */
  slot?: React.ReactNode;
  /** Render a slot of the right width with nothing in it (keeps a row with no
   *  keyframe controls aligned with its keyframeable neighbours). */
  reserveSlot?: boolean;
  /** Dim the label (a disabled row). */
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
  /** Extra classes for the control cell (`flex-wrap` for a pill group). */
  controlClassName?: string;
}

function InspectorRow({
  label,
  labelTitle,
  slot,
  reserveSlot = false,
  disabled = false,
  children,
  className,
  controlClassName,
}: InspectorRowProps) {
  const hasSlot = slot !== undefined || reserveSlot;
  return (
    <div
      data-slot="inspector-row"
      className={cn(
        'group grid min-h-[26px] items-center gap-x-1.5',
        hasSlot ? 'grid-cols-[92px_minmax(0,1fr)_80px]' : 'grid-cols-[92px_minmax(0,1fr)]',
        className,
      )}
    >
      <span
        data-slot="inspector-label"
        title={labelTitle ?? label}
        className={cn('text-text-secondary truncate text-xs', disabled && 'opacity-50')}
      >
        {label}
      </span>
      <div data-slot="inspector-control" className={cn('flex min-w-0 items-center gap-1', controlClassName)}>
        {children}
      </div>
      {hasSlot && (
        <div data-slot="inspector-slot" className="flex items-center justify-end">
          {slot}
        </div>
      )}
    </div>
  );
}

export { InspectorRow };
