/**
 * @apelles/motion — a tiny local button (D-046).
 *
 * Not `@apelles/ui`'s `Button`: that package's barrel also exports `Text`,
 * whose polymorphic `as`-prop typing breaks once `@react-three/fiber`'s
 * global `JSX.IntrinsicElements` augmentation — pulled in transitively via
 * `@apelles/motion-engine`'s `Scene3D`/`ParticleFlow` — sits in the same
 * `tsc` program (a pre-existing `@apelles/ui` fragility, not this tab's
 * bug). `@apelles/ui`'s own `exports` map also has no subpath for `Button`
 * alone, so a deep import isn't an option either. Two buttons don't
 * warrant a shared-package edit — a plain styled `<button>` on the app's
 * existing `--color-*` tokens.
 */
import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

const base =
  'h-8 px-3 rounded-md text-xs font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none';

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-button-text hover:opacity-90',
  secondary: 'bg-surface text-text-primary hover:bg-hover-color',
};

export function Button({ variant = 'primary', className, ...props }: Props) {
  return (
    <button
      type="button"
      className={[base, variants[variant], className].filter(Boolean).join(' ')}
      {...props}
    />
  );
}
