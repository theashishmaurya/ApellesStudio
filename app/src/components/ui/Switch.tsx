/**
 * Re-export shim. The real component lives in `@chroma/ui`; this file keeps the
 * existing `import Switch from '../ui/Switch'` sites working.
 *
 * D-042: `@chroma/ui`'s `Switch` is now the bare shadcn/Base-UI switch. The
 * row-style toggle these ~13 call sites use (`<Switch label=… checked=…
 * onChange={fn} />`) is `LabeledSwitch`, rebuilt on that same Base UI switch —
 * so the framer-motion spring the D-039 extraction had to drop is back.
 */
export { LabeledSwitch as default } from '@chroma/ui';
