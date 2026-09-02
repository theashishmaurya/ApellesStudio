# @chroma/shell

**The app shell** (D-039) — the window title bar (window chrome + the tab
switcher) over the active tab's content. Mounted by `app/src/main.tsx` today
(the future `apps/desktop` entry).

## The title bar

The app runs `decorations: false, transparent: true` (`app/src-tauri/tauri.conf.json`)
and draws its own chrome. That chrome is the shell's, once, above all three
tabs:

- **left** — macOS traffic lights (close / minimize / toggle-fullscreen) + the
  `CHROMA` wordmark
- **centre** — the tabs (Edit / Motion / Colorist), absolutely centred
- **right** — Windows / Linux window controls, or a matching spacer on macOS

The whole bar is a `data-tauri-drag-region` except the buttons and tabs.
`h-10`, `bg-surface border-b`. On macOS windowed, the shell root carries
`.macos-window-shell` (14px rounded corners) — that class used to sit on the
Colorist app root.

Platform logic (`WindowChrome.tsx`) is ported from RapidRAW's
`app/src/window/TitleBar.tsx`, which stays in the repo unrouted for reference.

## Deps

`react` + `zustand` + `lucide-react` + `@tauri-apps/api` + `@tauri-apps/plugin-os`.
The Tauri coupling is deliberate and acceptable — **the shell is the app chrome
now.** Tab content is still injected via the `tabs` registry prop, so the shell
never imports the colorist app or the tab packages.

## Status

D-039 — the 3-tab layout + window chrome are live. Still to move here: the
project launcher (D-037), since a project spans all three tabs.
