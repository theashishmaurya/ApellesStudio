# @chroma/editor

**The Edit tab** (D-039 / D-041; timeline switcher + drag-to-track D-046). A
single-video-track timeline of the open project's shots — scrub + play with a
live preview, reorder / trim / split / remove edits, and add a clip by
dragging a pool item in from the shell's Sources panel.

- `EditorTab` — the tab: preview pane (top) + `TimelineSwitcher` +
  `@xzdarcy/react-timeline-editor` strip (bottom), or an empty state when no
  project is open. The transport (`SkipBack` / `Play`–`Pause` / `SkipForward`)
  uses `lucide-react` icons; the timeline toolbar (`Scissors` split, `Trash2`
  remove) and the empty-state action are `@chroma/ui` `<Button>`s, the toolbar
  buttons wrapped in `@chroma/ui` `<Tooltip>` (D-042).
- `TimelineSwitcher` (D-046) — a `@chroma/ui` `<Select>` of the project's
  timelines (D-045's `chroma_timeline_list`) with the active one checked,
  switching via `chroma_timeline_set_active`, plus inline "+ New" →
  `chroma_timeline_create`. No rename/delete UI (no backing commands).
- `useEditorTimelineStore` — zustand store: `timeline`, `playhead`, `playing`,
  `timelines` (D-046), `load()`, `applyOp()`, `restoreSnapshot()` (D-051),
  `setPlayhead()`, `loadList()`/`createTimeline()`/`setActiveTimeline()`
  (D-046). Optimistic ops → debounced `chroma_timeline_set` →
  `chroma_timeline_get` refetch. Lives here for now; a `@chroma/bridge`
  extraction is a later task.
- `timeline.ts` — the model mirrored from the `chroma-timeline` Rust crate,
  the pure edit ops (including D-046's `add_clip`, purely client-side — no
  Rust op needed since `chroma_timeline_set` stores whatever is sent
  verbatim), `labelForOp` (D-051), and
  `CHROMA_MEDIA_DRAG_MIME`/`DraggedMedia`/`clipFromDraggedMedia` — the
  drag-to-track contract `TimelinePane`'s drop handler and the Sources
  panel's drag source both implement.
- `marquee.ts` (D-137) — marquee-select's pure half: whether a `pointerdown`
  may start a rubber-band at all (`canStartMarquee` /
  `MARQUEE_BLOCKING_SELECTOR`), the activation threshold, the
  clip-box-vs-rect intersection, how the result composes with the existing
  selection, and the pixel↔timeline conversions the overlay paints from. No
  React, no DOM, no `window` — `TimelinePane` owns the wiring. See
  **Marquee-select** below.

**Marquee-select (D-137, roadmap item 12 Phase 2).** Click-drag on empty
timeline canvas draws a rubber band; every clip whose bounding box the rect
intersects becomes the selection, with shift/cmd/ctrl (read once, at
`pointerdown`) unioning onto the existing selection instead of replacing it.
**The boundary that matters is with the `@dnd-kit/core` clip drag** (D-098 /
D-100), since both gestures begin with a `pointerdown` in the same edit-area
subtree: they are mutually exclusive **by DOM position**, not by precedence or
ordering. `ClipBody` — the one `useDraggable` node inside the edit area, and so
the only place dnd-kit's `PointerSensor` activator lives there — carries
`data-chroma-clip-drag`, and `canStartMarquee` refuses any press with that
attribute on its propagation path. Nothing relies on handler order or
`stopPropagation`. The rect is held in timeline units (frame + fractional
track row), so a scroll or ctrl-wheel zoom mid-drag moves and rescales the band
with the content it encloses. `marquee.test.ts` covers the intersection math,
the threshold, the modifier composition and the gesture guard.

**Undo/redo (D-051).** Every real (non-no-op) `applyOp` call pushes one
`{tab:'edit', label: labelForOp(op, before), undo, redo}` entry onto
`@chroma/history`'s shared stack — whole-`Timeline` snapshots (`before`/`after`),
not inverse deltas, since every op here already round-trips through a
whole-document `chroma_timeline_set`. `undo()`/`redo()` call
`restoreSnapshot()`, which sets state to the given snapshot, cancels any
pending debounced save, and persists + refetches immediately (no debounce —
undo/redo are discrete actions). Shell-level Cmd/Ctrl+Z / Cmd/Ctrl+Y
(`@chroma/shell`) is the only way this fires; there's no Edit-tab-local
undo keybinding. `src/timeline.test.ts` (vitest) covers `labelForOp`.

Backed by the `chroma-timeline` crate and the `chroma::edit` Tauri commands
(`chroma_timeline_get` / `_set` / `_frame` / `_list` / `_create` /
`_set_active`). The preview is a standalone decode→jpeg (`chroma_timeline_frame`)
— **not** the Colorist's graded wgpu path.

**Two clocks, and which one a backend read follows (B-088 / D-202).**
`chroma_timeline_frame` (and every other backend renderer of this timeline) is
handed no timeline: it composites the project's **persisted** manifest. But
`applyOp` updates `timeline` optimistically and persists it on a 400 ms
debounce, so for that window the in-memory object and the document the backend
renders are two different things. `savedVersion` is the backend's clock —
bumped only when a `chroma_timeline_set` resolves or a `chroma_timeline_get`
lands. **Anything that re-invokes a backend read of the timeline must depend on
`savedVersion`, never on `timeline`'s identity**; doing the latter is B-088,
where the preview fetched a frame ~400 ms before the edit existed backend-side
and then never fetched again. `PreviewPane` is currently the only such
consumer.

**Drag-to-track (D-046).** `TimelinePane` accepts a plain HTML5
`dataTransfer` drop carrying `CHROMA_MEDIA_DRAG_MIME` JSON (from the shell's
Sources panel, `app/src/components/chroma/SourcesPanel.tsx` — not a package
this one depends on) and turns it into an `add_clip` op. Plain browser DnD
rather than a shared `DndContext`/store, because the Sources panel is docked
at the shell level and D-039's layer direction forbids the shell depending on
a tab package to share one. This also scopes the drop to "only while the Edit
tab is active" for free — an inactive tab's content is `hidden`
(`display:none`), which is never a valid drop target. `TimelinePane` also
handles a *track-less* timeline (`tracks: []`, what `chroma_timeline_create`
makes) with its own empty-state drop zone; the first drop creates the video
track.

**Deferred** (later tracked steps): multi-track, audio, transitions, transcript
cut, GPU compositing, grade-in-preview, OTIO export, MCP, timeline
rename/delete. See `docs/notes/editor-mvp.md`.
