/**
 * Re-export shim (D-039). The real component lives in `@chroma/ui`; this file
 * keeps the existing `import CollapsibleSection from '../ui/CollapsibleSection'`
 * sites working.
 *
 * Note: the extracted `@chroma/ui` version inlines its two visibility-toggle
 * tooltip strings (English) instead of going through `react-i18next`.
 */
export { CollapsibleSection as default } from '@chroma/ui';
