import React, { forwardRef } from 'react';
import clsx from 'clsx';
import {
  TextWeight,
  TextColor,
  VariantConfig,
  TEXT_WEIGHT_KEYS,
  TEXT_COLOR_KEYS,
  TextVariants,
} from './typography';

interface TextProps extends React.HTMLAttributes<HTMLElement> {
  variant?: VariantConfig;
  weight?: TextWeight;
  color?: TextColor;
  as?: React.ElementType;
  children: React.ReactNode;
}

const Text = forwardRef<HTMLElement, TextProps>(
  ({ variant = TextVariants.body, weight, color, as, className, children, ...props }, ref) => {
    // `React.createElement`, not JSX, for this one call: `Component`'s type
    // is the broad `React.ElementType` union, and JSX's type-checking
    // collapses `children`/prop types to `never` when that union includes
    // non-DOM elements with an incompatible `children` shape — which is
    // exactly what happens once anything in the same `tsc` program pulls in
    // `@react-three/fiber`'s global `JSX.IntrinsicElements` augmentation
    // (e.g. `@apelles/motion-engine`'s `Scene3D`, via `@apelles/motion`, D-046
    // — see B-008). `createElement`'s signature doesn't distribute the same
    // way, so it type-checks correctly under both a plain-DOM and an
    // r3f-augmented `JSX.IntrinsicElements`. No behavior change — this is
    // exactly what the JSX below desugared to anyway.
    const Component = as || variant.defaultElement;

    return React.createElement(
      Component,
      {
        ref,
        className: clsx(
          variant.size,
          TEXT_WEIGHT_KEYS[weight ?? variant.defaultWeight],
          TEXT_COLOR_KEYS[color ?? variant.defaultColor],
          variant.extraClasses,
          className,
        ),
        ...props,
      },
      children,
    );
  },
);

Text.displayName = 'Text';
export default Text;
