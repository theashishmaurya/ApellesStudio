/**
 * Re-export shim. The real component lives in `@chroma/ui`; this file keeps
 * the existing `import Button from '../ui/Button'` sites working.
 *
 * D-042: `@chroma/ui`'s Button is now the shadcn/Base-UI button. It stays a
 * superset of the old hand-rolled one — `variant="primary"` kept as an alias,
 * `className` still wins via tailwind-merge (the old `bg-surface` hack).
 */
export { Button as default } from '@chroma/ui';
