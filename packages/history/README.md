# @chroma/history

**Shell-level global undo/redo** (D-051) — a generic stack of
`{ tab, label, undo(), redo(), ts }` entries, shared across all 3 tabs
(Edit / Motion / Colorist). This package knows nothing about grade docs,
timelines, or any other tab's data shape; it only knows "an action happened,
here is how to undo/redo it."

## Why a new package, not `@chroma/bridge`

`@chroma/bridge` (per its own README) is specifically the **frontend↔backend
seam** — typed Tauri command bindings + the control-bridge hook. This store
has no Tauri dependency and no backend seam at all; it's pure frontend state
consumed by `@chroma/shell` (the keybinding) and by whichever tab packages
want to participate. Folding it into `@chroma/bridge` would blur that
package's stated boundary for no benefit, so it's its own leaf package
instead — same layer as `@chroma/ui`, depended on by `@chroma/shell` and the
tab packages, depending on nothing but `zustand`.

## API

```ts
import { useHistoryStore } from '@chroma/history';

useHistoryStore.getState().push({
  tab: 'edit', // or 'motion' / 'colorist' — a plain string, this package
               // doesn't import `ShellTabId` (would create a dependency on
               // @chroma/shell in the wrong direction)
  label: 'Trim clip (start)',
  undo: () => { /* restore the pre-op state */ },
  redo: () => { /* re-apply it */ },
});

useHistoryStore.getState().undo(); // pops the top of the undo stack, calls
                                    // its undo(), returns the entry (or null)
useHistoryStore.getState().redo(); // mirror image
```

Two stacks (`undoStack`/`redoStack`), standard semantics: `push()` always
clears `redoStack` (a fresh edit invalidates whatever redo branch existed).
Each stack is capped at `MAX_HISTORY_ENTRIES` (100) — the oldest entry is
dropped silently past the cap, same "no error, just forget the very old"
convention as the Colorist's own 50-deep `useEditorStore` history.

In-memory only — nothing here is persisted, by design for this pass (see
D-051's "what's deferred").

## Consumers

- `@chroma/shell`'s `Shell.tsx` — owns the actual Cmd/Ctrl+Z / Cmd/Ctrl+Y
  keydown handler, calls `undo()`/`redo()` here regardless of which tab is
  active, and switches the active tab to whichever tab the returned entry
  belongs to (see D-051 for why "switch tabs" was chosen over "apply
  silently in the background").
- `app/src/store/coloristHistoryBridge.ts` — bridges the Colorist's
  pre-existing `useEditorStore` grade-adjustment history into this store
  (adapter, not a rewrite — `useEditorStore`'s own 50-deep stack is
  untouched).
- `@chroma/editor`'s `useEditorTimelineStore.applyOp()` — pushes a
  before/after snapshot pair here for every `chroma-timeline` edit op
  (reorder/trim/split/remove/add_clip).

## Testing

`src/store.test.ts` (vitest) covers push/undo/redo/stack-limit/cross-tab
ordering — pure logic, no DOM. `npm run test --workspace @chroma/history` or
just `npm test` from the repo root (`--workspaces --if-present`).
