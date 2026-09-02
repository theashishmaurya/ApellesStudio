/**
 * Re-export shim. The real component lives in `@chroma/ui`; this file keeps
 * the existing `import Input from '../ui/Input'` sites working.
 *
 * D-042: rebuilt on the shadcn/Base-UI input; the `bgClassName` prop (default
 * `bg-surface`) is kept for the SettingsPanel call sites.
 */
export { Input as default } from '@chroma/ui';
