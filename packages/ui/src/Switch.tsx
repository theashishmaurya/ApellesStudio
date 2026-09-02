import React from 'react';
import clsx from 'clsx';
import Text from './Text';
import { TextVariants } from './typography';

interface SwitchProps {
  checked: boolean;
  className?: string;
  disabled?: boolean;
  id?: string;
  label: string;
  onChange(val: boolean): any;
  tooltip?: string;
  trackClassName?: string;
}

/**
 * A beautiful, reusable, and accessible toggle switch component.
 *
 * @param {string} label - The text label for the switch.
 * @param {boolean} checked - The current state of the switch.
 * @param {function(boolean): void} onChange - Callback function that receives the new boolean state.
 * @param {boolean} [disabled=false] - Whether the switch is interactive.
 * @param {string} [className=''] - Additional classes for the container.
 * @param {string} [trackClassName] - Custom classes for the switch's background track.
 *
 * @remarks The knob slide was a `framer-motion` spring in the RapidRAW original;
 * extracted into `@chroma/ui` (D-039) it uses a plain CSS transform transition
 * to keep the kit's deps to react + clsx + lucide-react.
 */
const Switch = ({
  checked,
  className = '',
  disabled = false,
  label,
  onChange,
  tooltip,
  trackClassName,
}: SwitchProps) => {
  const uniqueId = `switch-${label.replace(/\s+/g, '-').toLowerCase()}`;

  return (
    <label
      className={clsx(
        'flex items-center justify-between',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        className,
      )}
      htmlFor={uniqueId}
      data-tooltip={tooltip}
    >
      <Text variant={TextVariants.label} className="select-none">
        {label}
      </Text>
      <div className="relative w-10 h-5">
        <input
          checked={checked}
          className="sr-only"
          disabled={disabled}
          id={uniqueId}
          onChange={(e: any) => !disabled && onChange(e.target.checked)}
          type="checkbox"
        />
        <div className={clsx('w-full h-full bg-card-active/50 rounded-full shadow-inner', trackClassName)}></div>
        <div
          className={clsx('absolute top-0.5 left-0.5 w-4 h-4 rounded-full transition-all duration-200 ease-out', {
            'bg-accent': checked,
            'bg-text-secondary/80': !checked,
          })}
          style={{ transform: `translateX(${checked ? 20 : 0}px)` }}
        />
      </div>
    </label>
  );
};

export default Switch;
