# @chroma/shell

**The app shell** (D-039; docked Sources panel D-046) — the window title bar
(window chrome + the tab switcher + the Sources-panel toggle) over the active
tab's content, plus an optional docked side panel. Mounted by `app/src/main.tsx`
today (the future `apps/desktop` entry).

## The title bar

The app runs `decorations: false, transparent: true` (`app/src-tauri/tauri.conf.json`)
and draws its own chrome. That chrome is the shell's, once, above all three
tabs:

- **left** — macOS traffic lights (close / minimize / toggle-fullscreen) + the
  `CHROMA` wordmark
- **centre** — the tabs (Edit / Motion / Colorist), absolutely centred
- **right** — the Sources-panel toggle (D-046, project open only) + Windows /
  Linux window controls, or a matching spacer on macOS

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
  sourcesPanel?: ReactNode;     // the D-046 Sources panel, injected by the app
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

**Docked Sources panel (D-046).** Same injection pattern as `launcher`: the
shell renders whatever `sourcesPanel` node is passed (`app/src/main.tsx` wires
in `<SourcesPanel />`) as a fixed-width (288px) column to the right of the tab
content — a sibling, never layered over it, so it can't fight Colorist's own
panels or Editor's timeline pane for space. Toggled by a chrome-bar button
(`useShellStore.sourcesPanelOpen`, session-only, closed by default); the
button carries `aria-pressed`, which WebKit maps to an `AXCheckBox` role, not
`AXButton` — worth knowing if you're scripting against it.

## Deps

`react` + `zustand` + `lucide-react` + `@tauri-apps/api` + `@tauri-apps/plugin-os`
+ `@chroma/ui` (D-042 — the "‹ Projects" chrome button is a `@chroma/ui`
`<Button variant="ghost">`). The Tauri coupling is deliberate and acceptable —
**the shell is the app chrome now.** Tab content is still injected via the `tabs`
registry prop, so the shell never imports the colorist app or the tab packages;
`sourcesPanel` is injected the same way for the same reason.

## Status

D-039 — the 3-tab layout + window chrome + the project-launcher entry screen
(step 6c) are live. D-046 added the docked Sources-panel slot. Follow-up: move
`ProjectLauncher` + the session store into `@chroma/bridge` / a `@chroma/project`
fe package so the shell can own the launcher outright instead of taking it as
a prop.
