/**
 * Re-export shim (D-039). The real component lives in `@chroma/ui`; this file
 * keeps the existing `import Switch from '../ui/Switch'` sites working.
 *
 * Note: the extracted `@chroma/ui` version slides the knob with a CSS transform
 * transition instead of the original `framer-motion` spring.
 */
export { Switch as default } from '@chroma/ui';
