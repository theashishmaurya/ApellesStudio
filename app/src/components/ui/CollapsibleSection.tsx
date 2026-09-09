/**
 * Re-export shim. The real component lives in `@apelles/ui`; this file keeps
 * the existing `import CollapsibleSection from '../ui/CollapsibleSection'` sites working.
 *
 * D-042: rebuilt on the shadcn/Base-UI `Collapsible` (Base UI drives the
 * open/close height transition). Props unchanged; the two visibility-toggle
 * tooltip strings stay inlined in English.
 */
export { CollapsibleSection as default } from '@apelles/ui';
