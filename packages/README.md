# packages/ — Chroma's frontend workspace

npm workspaces. Mirrors the Rust `crates/` split (D-039): one package per tab +
shared `tokens` / `ui` / `bridge` / `shell`. `app/` (the vendored RapidRAW fork
frontend, `@chroma/app`) is also a workspace member and is where all real UI
code lives today — the packages below are extracted from it incrementally.

## The planned packages (D-039)

| package | exists? | what it will hold |
|---|---|---|
| `@chroma/tokens` | **yes (stub)** | design tokens + light/dark theme, from RapidRAW's CSS vars |
| `@chroma/ui` | **yes (stub)** | shared component kit — buttons, sliders, dropdowns, modals (RapidRAW `components/ui/`) |
| `@chroma/bridge` | **yes (stub)** | typed Tauri command bindings + zustand stores + the control-bridge hook `useChromaControl` (D-020) |
| `@chroma/editor` | **yes (stub)** | the **Editing tab** (new) — timeline strip (`react-timeline-editor`), transcript pane, trim/ripple UI |
| `@chroma/motion` | **yes (stub)** | the **Motion tab** — `@remotion/player` embed + manifest editor |
| `@chroma/shell` | **yes (stub)** | app shell — tab switcher, project launcher (D-037), window chrome, routing |
| `@chroma/motion-engine` | **yes** — moved in from `videoAgent/engine/motion/` (D-039) | the Remotion project itself: 7 primitives + the JSON scene-manifest compiler (`src/engine/build.ts`) |
| `@chroma/colorist` | future | the **Colorist tab** — adjustment panels, scopes, mask editor (RapidRAW's adjustment UI, adapted). Lives in `app/src/` for now. |
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
