/**
 * Re-export shim (D-039). The real component lives in `@chroma/ui`; this file
 * keeps the existing `import Text from '../ui/Text'` sites working.
 *
 * The `typography` variant table still lives at `app/src/types/typography.ts`
 * for the ~40 call sites that import the constants directly; `@chroma/ui` keeps
 * its own copy — keep the two in sync.
 */
export { Text as default } from '@chroma/ui';
