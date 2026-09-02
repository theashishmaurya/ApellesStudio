import clsx from 'clsx';
import Text from './Text';
import { TextVariants } from './typography';
import { Switch } from './components/ui/switch';

interface LabeledSwitchProps {
  checked: boolean;
  className?: string;
  disabled?: boolean;
  id?: string;
  label: string;
  onChange(val: boolean): void;
  tooltip?: string;
  trackClassName?: string;
}

/**
 * `LabeledSwitch` — the RapidRAW row-style toggle (a `<Text>` label on the left,
 * a switch on the right), rebuilt on the shadcn/Base-UI `Switch` (D-042).
 *
 * This is what the `app/src/components/ui/Switch.tsx` shim points at, so the
 * ~13 `<Switch label=… checked=… onChange={fn} />` call sites are unchanged.
 * The bare shadcn switch is exported separately as `Switch`.
 *
 * `tooltip` is surfaced as `data-tooltip` for RapidRAW's `GlobalTooltip`.
 */
export default function LabeledSwitch({
  checked,
  className = '',
  disabled = false,
  id,
  label,
  onChange,
  tooltip,
  trackClassName,
}: LabeledSwitchProps) {
  const uniqueId = id ?? `switch-${label.replace(/\s+/g, '-').toLowerCase()}`;

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
      <Switch
        id={uniqueId}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value: boolean) => onChange(value)}
        className={trackClassName}
      />
    </label>
  );
}
