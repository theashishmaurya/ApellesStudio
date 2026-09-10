# `@apelles/keymap`

Apelles' **single source of truth for keyboard shortcuts** (D-273).

One registry, one dispatcher, one settings window. No component in this app
compares a key to a literal any more.

## What's in it

| File | What it is |
| --- | --- |
| `shortcuts.ts` | **The registry.** Every shortcut: `id`, `label`, `category`, `scope`, `defaultCombo`. No handlers. |
| `combo.ts` | `KeyboardEvent` → canonical combo (`['ctrl','shift','KeyC']`) and back to `⌘ + Shift + C`. |
| `store.ts` | The user's remaps, an injected persistence sink, and the pure resolution/conflict rules. |
| `useShortcut.ts` | The **one** `window` `keydown` listener, and the hook a call-site claims an action with. |
| `KeyboardShortcutsDialog.tsx` | The settings window — categorised rows, click-to-record, per-row and global reset. |

## Boundary

Depends on `react`, `zustand`, `lucide-react` and `@apelles/ui` — **nothing
else**. No Tauri, no `@apelles/bridge`, no tab package, and never anything from
`app/src`. It sits below the tabs, so `@apelles/shell`, `@apelles/editor`,
`@apelles/motion` and the vendored Colorist app can all import it.

It does **not** own persistence. The app calls `useKeymapStore.setPersist(fn)`
once and wires it to `appSettings.keybinds` — the
`HashMap<String, Vec<String>>` that `app/src-tauri/src/app_settings.rs` has
persisted since RapidRAW, which needed no Rust change to carry the new action
ids. This app has no `localStorage` and no zustand `persist` middleware
anywhere; `appSettings` is its per-user-preference mechanism.

It does **not** know what an action does. `useShortcut('edit.split', fn)` is how
a component says "I perform this"; the registry only says what it's called and
what it's bound to.

## Adding a shortcut

1. Add a row to `SHORTCUT_DEFINITIONS`. It is now visible and remappable in the
   settings window immediately, whether or not anything performs it yet.
2. Call `useShortcut('<id>', handler)` wherever the action lives.

Never rename an `id`: user remaps are stored against it.

## Call-site map

| Owner | Actions |
| --- | --- |
| `@apelles/shell` `Shell.tsx` | `app.tab_*`, `app.undo`, `app.redo` |
| `@apelles/editor` `PreviewPane.tsx` | `edit.play_pause`, `edit.frame_back`, `edit.frame_forward` |
| `@apelles/editor` `TimelinePane.tsx` | `edit.split`, `edit.delete_selection`, `edit.add_marker`, `edit.tool_*` |
| `app/src/hooks/useKeyboardShortcuts.ts` | the 45 `colorist`-scoped actions |

## Not covered, deliberately

Escape-cancels-this-drag (`TransformBox`, `ClipFadeOverlay`, `MotionCanvasOverlay`,
`LayerList`, `KeyframeTimeline`, `ClipCurveEditor`, `TimelinePane`'s marquee),
Enter/Escape inside a text field, and holding Alt to arm a smart trim are **not**
shortcuts and are not in the registry. They are modal gesture state, live only
while a drag or an edit is in progress, and would be meaningless — and dangerous
— to rebind. macOS's own pane lists none of its equivalents either.

## MCP

None, deliberately — see D-273. A key binding is a local human input
preference, like a theme; an agent never presses keys, it calls the
`editor_*`/`set_*` tool the shortcut invokes.
