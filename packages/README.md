# packages/ — Chroma's frontend workspace

npm workspaces. Mirrors the Rust `crates/` split (D-039): one package per tab +
shared `tokens` / `ui` / `bridge` / `shell`. `app/` (the vendored RapidRAW fork
frontend, `@chroma/app`) is also a workspace member and is where all real UI
code lives today — the packages below are extracted from it incrementally.

## The planned packages (D-039)

| package | exists? | what it will hold |
|---|---|---|
| `@chroma/tokens` | **yes (stub)** | design tokens + light/dark theme, from RapidRAW's CSS vars |
| `@chroma/ui` | **yes** — shadcn/ui on Base UI (D-042): ~18 structural components (Button, Dialog, DropdownMenu, ContextMenu, Tooltip, Popover, Tabs, Select, Command, Resizable, Sheet, Slider, Switch, ScrollArea, Separator, Input, Label, Sonner) + the 5 rebuilt RapidRAW primitives (Text, LabeledSwitch, CollapsibleSection, Button, Input) | shared component kit; app-side files are re-export shims. Themed onto the existing `--app-*`/`--color-*` tokens (one source, `src/styles.css`). Craft-specific grading components (ColorWheel, LUTControl, DepthRangePicker, grading Slider) stay in `app/`. See `ui/README.md` |
| `@chroma/bridge` | **yes (stub)** | typed Tauri command bindings + zustand stores + the control-bridge hook `useChromaControl` (D-020) |
| `@chroma/editor` | **yes (stub)** | the **Editing tab** (new) — timeline strip (`react-timeline-editor`), transcript pane, trim/ripple UI |
| `@chroma/motion` | **yes (stub)** | the **Motion tab** — `@remotion/player` embed + manifest editor |
| `@chroma/shell` | **yes** — 3-tab layout + window chrome (D-039 steps 6a/6b) | the window title bar (`WindowChrome.tsx` — traffic lights / window controls / drag region) + the tab switcher; project launcher (D-037) still to move here. Owns the app chrome, so it couples to Tauri |
| `@chroma/motion-engine` | **yes** — moved in from `videoAgent/engine/motion/` (D-039) | the Remotion project itself: 7 primitives + the JSON scene-manifest compiler (`src/engine/build.ts`) |
| `@chroma/colorist` | future | the **Colorist tab** — adjustment panels, scopes, mask editor (RapidRAW's adjustment UI, adapted). Lives in `app/src/` for now. |
| `@chroma/player` | **yes** — canvas viewport + title strip + transport bar, presentational only (roadmap "Next" item 1) | the shared `<Player>` component every tab embeds: each supplies its own frame `surface` (Editor's `chroma_timeline_frame` `<img>`, Colorist's wgpu surface, Motion's `@remotion/player`) and owns its own frame-fetch/IPC/playback-loop logic — this package has none. Also exports `fmtTimecode`. `@chroma/editor` is the first (and so far only) consumer; Colorist + Motion adoption is follow-on. See `player/README.md` |
| `apps/desktop` | future | the Vite entry that composes shell + tabs; what `src-tauri` serves. `app/` plays this role today. |

## Migration status (D-039)

- **Step 1 (this commit):** workspace declared (`package.json` `workspaces`),
  the 6 stub packages above (`src/index.ts` placeholder + `README.md` each),
  `@chroma/motion-engine` moved in. `app/` renamed `rapidraw` → `@chroma/app`.
  **`app/` does NOT import from `packages/*` yet** — the workspace is only
  declared.
- **Step 6:** `@chroma/tokens` + `@chroma/ui` + `@chroma/bridge` extracted
  first, then `@chroma/shell` + the 3-tab layout (Colorist wrapped as-is), then
  `@chroma/editor` greenfield.
- **Step 6a (2026-09-02):** `@chroma/shell` + the 3-tab layout live; Colorist =
  the existing app, Edit built out by D-041.
- **Step 6b (2026-09-02):** window chrome moved into `@chroma/shell`
  (`WindowChrome.tsx`); `@chroma/ui` made real with the safe subset (`Button`,
  `Input`, `Text`, `Switch`, `CollapsibleSection`) + app-side re-export shims;
  `@chroma/editor` transport/toolbar switched to `lucide-react` icons +
  `@chroma/ui`.
- **D-042 (2026-09-02):** `@chroma/ui` moved onto **shadcn/ui + Base UI**
  (`@base-ui/react`). Canonical shadcn structure (`components.json`, `lib/utils`,
  `components/ui/*`), ~18 structural components added, the 5 hand-extracted
  primitives rebuilt on the new base, themed onto the existing `--app-*` tokens
  (one `@theme` source in `src/styles.css`, `--accent` collision resolved by
  keeping RapidRAW's brand `--color-accent` and swapping shadcn's hover state to
  `bg-muted`). `@chroma/shell` ("‹ Projects" button) + `@chroma/editor` (timeline
  toolbar → `Button` + `Tooltip`) migrated. `@chroma/tokens` + `@chroma/bridge`
  are still later passes.
- **`@chroma/player` (2026-09-02, roadmap "Next" item 1):** new package — the
  shared `<Player>` preview component (viewport + title strip + transport bar),
  presentational only, built on `@chroma/ui`'s `Button`/`Slider`. `fmtTimecode`
  moved here from `@chroma/editor`'s `PreviewPane.tsx` (single source of truth).
  `@chroma/editor` migrated: `PreviewPane.tsx` keeps all its frame-fetch/rAF
  play-loop logic as-is, only the rendered transport JSX now comes from
  `<Player>`. Colorist + Motion adoption is follow-on, not done here.
