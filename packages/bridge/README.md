# @apelles/bridge

**The frontend↔backend seam** (D-039): typed Tauri command bindings + the
zustand stores + the control-bridge hook `useChromaControl` (D-020, currently
`app/src/hooks/useChromaControl.ts`).

Consumed by every tab package.

**Status:** mostly still a D-039 stub — its first real content is the D-044/
D-045/D-046 media-pool store, now consumed by a real panel (D-046's
`SourcesPanel`, `app/src/components/chroma/SourcesPanel.tsx`):

- `useMediaPoolStore` (`src/media.ts`) — a typed binding over the
  `chroma_media_import` / `chroma_media_list` / `chroma_media_move` (D-045)
  Tauri commands (`app/src-tauri/src/chroma/project.rs`) plus the
  client-side pool state (`items`, `loading`, `error`, `refresh()`,
  `importPaths(paths, folder?)`, `moveToFolder(id, folder)`). Which project's
  pool it holds is pushed in from the composition root
  (`setOpenProject(projectKey)`, `app/src/Root.tsx` — B-083/D-203), the same
  one-input shape both tab stores use; the panel does not fetch it itself. D-046's "add to
  grading" action (`chroma_project_add_shot`) is deliberately **not** a store
  action here — it needs `useSessionStore._hydrateOpenDto` (`app/src/store`),
  which this package cannot depend on without inverting the D-039 layer
  direction, so it lives directly in `SourcesPanel.tsx` instead.

**Tests:** `npm test --workspace @apelles/bridge` (vitest, node environment) —
`src/media.test.ts` covers the pool's project-identity input (B-083/D-203).
