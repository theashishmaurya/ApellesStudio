# @chroma/editor

**The Edit tab** (D-039 / D-041). A single-video-track timeline of the open
project's shots — scrub + play with a live preview, and reorder / trim / split /
remove edits.

- `EditorTab` — the tab: preview pane (top) + `@xzdarcy/react-timeline-editor`
  strip (bottom), or an empty state when no project is open. The transport
  (`SkipBack` / `Play`–`Pause` / `SkipForward`) uses `lucide-react` icons; the
  timeline toolbar (`Scissors` split, `Trash2` remove) and the empty-state action
  are `@chroma/ui` `<Button>`s, the toolbar buttons wrapped in `@chroma/ui`
  `<Tooltip>` (D-042).
- `useEditorTimelineStore` — zustand store: `timeline`, `playhead`, `playing`,
  `load()`, `applyOp()`, `setPlayhead()`. Optimistic ops → debounced
  `chroma_timeline_set` → `chroma_timeline_get` refetch. Lives here for now; a
  `@chroma/bridge` extraction is a later task.
- `timeline.ts` — the model mirrored from the `chroma-timeline` Rust crate + the
  pure edit ops.

Backed by the `chroma-timeline` crate and the `chroma::edit` Tauri commands
(`chroma_timeline_get` / `_set` / `_frame`). The preview is a standalone
decode→jpeg (`chroma_timeline_frame`) — **not** the Colorist's graded wgpu path.

**Deferred** (later tracked steps): multi-track, audio, transitions, transcript
cut, GPU compositing, grade-in-preview, OTIO export, MCP. See
`docs/notes/editor-mvp.md`.
