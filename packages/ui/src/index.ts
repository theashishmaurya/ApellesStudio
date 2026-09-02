/**
 * @chroma/ui — shared component kit (D-039).
 *
 * The generic, dependency-light primitives from RapidRAW's
 * `app/src/components/ui/`, extracted so every tab (`@chroma/editor`,
 * `@chroma/motion`, `@chroma/shell`) draws from one kit instead of
 * hand-crafting. Deps are react + clsx + lucide-react only — app-store /
 * context / heavy-dep components (Dropdown, ColorWheel, LUTControl, Slider,
 * …) stay in `app/` until a later pass.
 *
 * The app's `app/src/components/ui/<Name>.tsx` files are now thin re-export
 * shims pointing here, so the existing `import X from '../ui/X'` sites keep
 * working unchanged.
 */

export { default as Button } from './Button';
export { default as Input } from './Input';
export { default as Text } from './Text';
export { default as Switch } from './Switch';
export { default as CollapsibleSection } from './CollapsibleSection';

export * from './typography';
