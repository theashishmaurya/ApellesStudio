# Keyboard shortcuts — the audit, and the registry that came out of it

**D-272**, 2026-09-10. Closes the two owner requests logged 2026-09-10: *"a full
keyboard-shortcut audit — every shortcut actually registered and working, Play
included"* and *"a real Keyboard Shortcuts settings window — view AND edit/remap
any shortcut."*

This note is the worked-out detail behind D-272. The code lives in
`packages/keymap/` (see its README for the boundary and the call-site map).

---

## Part 1 — the audit

Every keydown handler in `app/src` and `packages/*` was read, not sampled.
`grep` for `addEventListener('keydown'`, `onKeyDown`, `key ===`, `code ===`
across both trees, then each hit read in place.

### What owned a shortcut before D-272

Five independent listeners, none of which knew about the others.

| Owner | Keys | Mechanism | Working? |
| --- | --- | --- | --- |
| `packages/shell/src/Shell.tsx` | ⌘1 / ⌘2 / ⌘3 — switch tab | `window` listener, inline `{'1':0,'2':1,'3':2}` | yes |
| `packages/shell/src/Shell.tsx` | ⌘Z undo, ⌘Y / ⌘⇧Z redo | `window` listener, `e.key.toLowerCase()` | yes |
| `packages/editor/src/TimelinePane.tsx` | `M` — add marker | React `onKeyDown` on a `tabIndex={0}` div | **only with pane focus** |
| `packages/editor/src/TimelinePane.tsx` | `V B N Y U` — trim tools | same handler, via `trimToolForKey` | **only with pane focus** |
| `packages/editor/src/TimelinePane.tsx` | Delete / Backspace — remove clip or gap | same handler | **only with pane focus** |
| `app/src/hooks/useKeyboardShortcuts.ts` | 45 Colorist actions | `window` listener + `KEYBIND_DEFINITIONS` combo map | yes, **but in every tab** |
| `app/src/hooks/useKeyboardShortcuts.ts` | Escape, contextual mask-Delete | `builtinShortcuts` list | yes |

### The three real findings

**1. Play/Space was bound to nothing.** Confirmed by exhaustive search, not
assumed: there was no `Space` / `' '` / `code === 'Space'` handler anywhere in
`packages/*` or `app/src` outside Colorist's own `cycle_zoom`. The Edit tab's
preview had click-only transport buttons. `useEditorTimelineStore.setPlaying`
existed and worked — nothing reached it from the keyboard. This is exactly the
owner's report. Same for frame-stepping (←/→): buttons, no keys. → **B-139**.

**2. Colorist's shortcuts fired in every tab.** `useKeyboardShortcuts` is
mounted by `App.tsx`, which stays mounted under all three tabs (B-007), and its
`window` listener cannot see which tab is on screen. Every action with
`shouldFire: () => true` — the panel toggles (`M`, `D`, `R`, `K`, `P`, `I`,
`E`, `A`), the rating and colour-label keys, copy/paste adjustments — fired
while the user was in Edit or Motion. Worse where both tabs wanted the same
key: `M` in the Edit tab dropped a marker *and* toggled Colorist's Masks panel,
because React's root handler and the `window` handler both ran (a
`preventDefault` does not stop propagation). ⌘1 both switched tab and zoomed
Colorist to 100%. → **B-138**.

**3. The Edit tab's keys needed the timeline clicked first.** They hung off a
`tabIndex={0}` div's own `onKeyDown`. Drag a clip in from Sources and press `M`
and nothing happened, because focus was still on the drag source. Each branch
also re-implemented its own "no modifier held" and "not in a text field"
guards, and they had drifted — the Delete branch had neither.

### What is deliberately NOT a shortcut

Not everything that reads a key is a binding a user could meaningfully rebind.
Excluded from the registry, with the same reasoning macOS's own pane uses (it
lists no equivalent either):

- **Escape-cancels-this-drag** — `TransformBox`, `ClipFadeOverlay`,
  `ClipCurveEditor`, `TimelinePane`'s marquee, `MotionCanvasOverlay`,
  `LayerList`, `KeyframeTimeline`. Modal gesture state, live only during a drag.
- **Enter / Escape inside a text field** — `TimelineSwitcher`,
  `TimelineTransitions`, the modals. Field semantics, not app shortcuts.
- **Held-modifier tracking** — `TimelinePane`'s Alt-arms-a-smart-trim,
  `ImageCanvas`'s Alt/Ctrl/Meta, `Editor.tsx`'s Shift. These read
  `e.altKey`-style *state*, not a keypress.
- **A focused control's own ARIA keys** — `Slider.tsx`'s ↑/↓.
- **Colorist's two `builtinShortcuts`** — "Escape backs out of whatever is
  innermost" and "Delete removes the mask container you are inside". Contextual
  and modal; their meaning depends entirely on what is open.

---

## Part 2 — the design

### One registry

`packages/keymap/src/shortcuts.ts` — a flat list of
`{ id, label, category, scope, defaultCombo, aliases? }`. Every call-site
resolves through it; no literal key comparison is left in the app. This is the
same "one source of truth" pattern CLAUDE.md already mandates for `grade.json`
and `Clip`/`Timeline`.

The registry holds **no handlers**. A component claims an action with
`useShortcut('edit.split', fn)`. That split is what lets a shortcut be listed
and rebound in the settings window whether or not its component is mounted.

`RapidRAW already had half of this` — `app/src/utils/keyboardUtils.ts`'s
`KEYBIND_DEFINITIONS`, plus a remap UI inside Colorist's settings modal. It was
extended, not replaced: that file is deleted and its 45 rows are the
`colorist`-scoped rows of the one registry, **ids and defaults byte-identical**
so existing user remaps keep working. It could never have served the Edit tab
where it was — `packages/*` may not import from `app/src` (dependency
direction), which is precisely why the Edit tab grew its own hardcoded keys.

### Scope is what fixes B-138

Each action carries `scope: 'global' | 'edit' | 'motion' | 'colorist'`. `Shell`
— the one component that knows which tab is frontmost — reports it via
`setActiveScope`. The dispatcher will not consider an action out of scope.

**Precedence: `global` beats the active tab.** One keydown dispatches at most
one action, chosen deterministically. The global set is tiny and deliberate
(tab switching, undo/redo) and must work everywhere, so it wins; a tab action on
the same combo is shadowed, flagged with a ⚠ in the settings window, and
rebindable there. ⌘1 (tab switch vs. Colorist `zoom_100`) is the live case.
Before D-272 both fired; now one does, and the loser is visible instead of
silent.

### One dispatcher

`useShortcut.ts` installs exactly one `window` `keydown` listener for the whole
app, lazily, while any handler is registered. It normalises the event, resolves
one action, and calls it. An unclaimed combo falls through with no
`preventDefault`, so the browser and OS keep their own keys.

The typing guard lives here now, once, instead of being re-implemented per
branch: nothing fires while an `<input>`/`<textarea>`/contenteditable has
focus. `<input type="number">` is deliberately **not** counted as a text field —
it holds no prose to protect and having one focused is the normal state while
using the Inspector, so counting it swallowed shortcuts pressed near a value
field. That refinement was D-051's, for undo/redo only; it is now global.

### Persistence — the existing mechanism, not a new one

`@apelles/keymap` stores nothing itself (no `packages/*` depends on Tauri). The
app calls `setPersist(fn)` once; every mutation hands it the whole overrides
map. `Root.tsx` wires it to **`appSettings.keybinds`** — the
`HashMap<String, Vec<String>>` that `app/src-tauri/src/app_settings.rs` has
persisted since RapidRAW. Being a generic string map, it carried Apelles' new
action ids with **no Rust change at all**.

This was checked rather than assumed: there is no `localStorage` and no zustand
`persist` middleware anywhere in this app. `appSettings` is *the*
per-user-preference mechanism, so matching it was the canonical choice, not
inventing a second store.

Stored overrides are pruned to real deltas (an "override" equal to the default
is dropped). An override of `[]` is a real value meaning **unassigned**, which
is what Escape-while-recording writes.

### The settings window

`KeyboardShortcutsDialog.tsx`, shell-level, opened by the keyboard button in
the title bar — so it is reachable from all three tabs. The Colorist settings
modal's own keybind section is **moved, not duplicated**: it listed Colorist's
45 actions only and was unreachable without switching tabs first. That card now
points at the new window.

Pattern taken from **macOS System Settings ▸ Keyboard ▸ Keyboard Shortcuts**,
the reference the owner cited:

- grouped categories, then one row per action;
- the combo chip **is** the control — click it, press the new chord;
- Escape while recording leaves the action unassigned (not "cancel");
- one "Restore Defaults" for the whole pane.

Two deliberate divergences: a **per-row reset** as well (this list is ~60 rows
against macOS's dozen, so nuking all of them to undo one is a worse trade), and
a **scope tag** per section, which macOS has no equivalent of because it has no
tabs.

> **Reference-material note.** The screenshot the roadmap cites at
> `scratch/keyboard-shortcuts-settings-reference.png` is **not** the macOS pane
> — the file saved there is a screenshot of Apelles' own Edit tab, presumably
> saved over. The pane's documented behaviour above was used instead. Worth
> re-capturing if this surface is revisited.

### Aliases

Two actions have genuinely always had two bindings: redo (⌘Y *and* ⌘⇧Z) and the
Edit tab's delete (Delete *and* Backspace). Modelled as `aliases` on one row
rather than two registry rows, because the settings window must show one row per
action — two "Redo" rows read as a bug. Aliases are defaults, not bindings: the
moment a user remaps that action, their combo is the whole binding.

---

## What is bound now

| Action | Default | Scope | Status before D-272 |
| --- | --- | --- | --- |
| Go to Edit / Motion / Colorist | ⌘1 / ⌘2 / ⌘3 | global | worked, hardcoded |
| Undo / Redo | ⌘Z / ⌘Y (⌘⇧Z) | global | worked, hardcoded |
| **Play / Pause** | **Space** | edit | **unbound** |
| **Step back / forward one frame** | **← / →** | edit | **unbound** |
| **Split at playhead** | **⌘K** | edit | **unbound** (button only) |
| Delete selected clip or gap | Delete (Backspace) | edit | needed pane focus |
| Add marker at playhead | M | edit | needed pane focus |
| Select / Ripple / Roll / Slip / Slide | V / B / N / Y / U | edit | needed pane focus |
| the 45 Colorist actions | unchanged | colorist | fired in every tab |

## MCP surface — deliberately none

CLAUDE.md requires a GUI affordance and an MCP surface for the same capability.
The judgment here is that a key binding is **not** such a capability: it is a
local human input preference, like a theme choice. An agent never presses keys —
its equivalent of every shortcut in the table above is the `editor_*` / `set_*`
tool that shortcut invokes, and all of those already exist
(`editor_set_playing`, `editor_set_playhead`, `editor_split_clip`,
`editor_add_marker`, `editor_remove_clip`, …). A `set_shortcut` tool would let
an agent silently rewrite the human's muscle memory: real hazard, no capability
gained. Reasoning recorded in D-272 rather than a tool being forced to fit.

## Adding one later

1. A row in `SHORTCUT_DEFINITIONS` — visible and rebindable immediately.
2. `useShortcut('<id>', handler)` where the action lives.

Never rename an `id`: user remaps are stored against it.
