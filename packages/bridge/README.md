# @chroma/bridge

**The frontend↔backend seam** (D-039): typed Tauri command bindings + the
zustand stores + the control-bridge hook `useChromaControl` (D-020, currently
`app/src/hooks/useChromaControl.ts`).

Consumed by every tab package.

**Status:** mostly still a D-039 stub — its first real content is the D-044
media-pool store:

- `useMediaPoolStore` (`src/media.ts`) — a typed binding over the
  `chroma_media_import` / `chroma_media_list` Tauri commands
  (`app/src-tauri/src/chroma/project.rs`) plus the client-side pool state
  (`items`, `loading`, `error`, `refresh()`, `importPaths()`). Scaffolding
  only — no panel UI consumes it yet; that's a later roadmap pass ("Media
  pool + import + multiple timelines", passes 2/3).
