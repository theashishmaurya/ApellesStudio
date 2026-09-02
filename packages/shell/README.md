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

## Props

```ts
interface ShellProps {
  tabs: ShellTab[];             // { id, label, icon?, element } per tab
  projectOpen: boolean;         // false → launcher full-window, no tab buttons
  launcher: ReactNode;          // the D-037 ProjectLauncher, injected by the app
  onCloseProject?: () => void;  // "‹ Projects" — back to the launcher
}
```

**Project gating (D-039 step 6c).** The shell is the app's entry screen. While
`projectOpen` is `false` the chrome bar shows only traffic lights + `CHROMA` +
window controls, and the content area renders `{launcher}` full-window. Once a
project opens the tabs appear plus a "‹ Projects" button (next to the wordmark)
that calls `onCloseProject`; Cmd/Ctrl+1/2/3 are gated on `projectOpen`. The tab
panels stay **mounted** (hidden) under the launcher so the Colorist app's MCP
control bridge keeps running. The shell never imports `ProjectLauncher` — it
arrives via the `launcher` prop (dependency direction is app → shell). The
routing flag is computed in a small `Root` component in `app/src/main.tsx` from
`useSessionStore` (`projectPath || projectName`).

## Deps

`react` + `zustand` + `lucide-react` + `@tauri-apps/api` + `@tauri-apps/plugin-os`
+ `@chroma/ui` (D-042 — the "‹ Projects" chrome button is a `@chroma/ui`
`<Button variant="ghost">`). The Tauri coupling is deliberate and acceptable —
**the shell is the app chrome now.** Tab content is still injected via the `tabs`
registry prop, so the shell never imports the colorist app or the tab packages.

## Status

D-039 — the 3-tab layout + window chrome + the project-launcher entry screen
(step 6c) are live. Follow-up: move `ProjectLauncher` + the session store into
`@chroma/bridge` / a `@chroma/project` fe package so the shell can own the
launcher outright instead of taking it as a prop.
