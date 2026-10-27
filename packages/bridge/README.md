# @apelles/bridge

**The frontend↔backend seam** (D-039): typed Tauri command bindings + the
zustand stores + the control-bridge hook `useChromaControl` (D-020, currently
`app/src/hooks/useChromaControl.ts`).

Consumed by every tab package.

**Status:** mostly still a D-039 stub — its first real content is the D-044/
D-045/D-046 media-pool store, now consumed by a real panel (D-046's
`SourcesPanel`, `app/src/components/chroma/SourcesPanel.tsx`):

- `useMediaPoolStore` (`src/media.ts`) — a typed binding over the
  `chroma_media_import` / `chroma_media_list` / `chroma_media_move` (D-045)
  Tauri commands (`app/src-tauri/src/chroma/project.rs`) plus the
  client-side pool state (`items`, `loading`, `error`, `refresh()`,
  `importPaths(paths, folder?)`, `moveToFolder(id, folder)`). Which project's
  pool it holds is pushed in from the composition root
  (`setOpenProject(projectKey)`, `app/src/Root.tsx` — B-083/D-203), the same
  one-input shape both tab stores use; the panel does not fetch it itself. D-046's "add to
  grading" action (`chroma_project_add_shot`) is deliberately **not** a store
  action here — it needs `useSessionStore._hydrateOpenDto` (`app/src/store`),
  which this package cannot depend on without inverting the D-039 layer
  direction, so it lives directly in `SourcesPanel.tsx` instead.

- `useAiEnv` / `useAiEnvStore` (`src/aiEnv.ts`, D-315) — the AI-environment
  bootstrap's one frontend view: `chroma_ai_env_status`, `chroma_ai_env_retry`
  and the `ai-env-status` event behind a reference-counted subscription, plus
  the pure functions that turn a status into words (`aiEnvHeadline`,
  `aiEnvNotice`, `aiEnvProgressLabel`, `aiEnvWarning`, `aiEnvIsBuilding`). It
  is in **this** package precisely because its consumers straddle the D-039
  boundary — Settings, masking and relight are in `app/src`, captions are in
  `packages/editor`, and only `bridge` is visible to both. **It reports state
  and never refuses a call**: a sidecar started by hand answers regardless of
  what the bootstrap thinks, so gating here would be a regression — the app
  explains a real failure reactively at the sidecar call site instead. Design
  and the full consumer inventory: `docs/notes/ai-env-bootstrap.md` § "The GUI
  surface".

- `safeUnlisten` (`src/tauriListeners.ts`) — the correct teardown for a
  `listen()` registration (B-032/B-034/D-112). The canonical copy for
  `packages/*`, which cannot import `app/src/utils/tauriListeners.ts`.

- `newBridgeClaim` (`src/controlBridge.ts`, B-272) — the control-bridge
  handshake every op registry (Colorist, Edit, Motion, Debug) uses: a fresh
  `instance` id per subscription, and `isForMe(payload)` so a listener leaked
  across a reload never runs an op the control server addressed to its
  replacement.

- `pageStart` / `watchPageUnload` / `takeWebviewTermination`
  (`src/pageLifecycle.ts`, B-274/D-402) — whether this page follows one whose
  web content process the OS killed. `takeWebviewTermination` is the binding
  over `chroma_webview_take_termination` (WebKit's own report, recorded by the
  Rust hook in `chroma::webview_lifecycle`), asked once per page; the
  `sessionStorage` marker is the fallback heuristic.

**Tests:** `npm test --workspace @apelles/bridge` (vitest, node environment) —
`src/media.test.ts` covers the pool's project-identity input (B-083/D-203);
`src/aiEnv.test.ts` covers the D-315 status vocabulary and the rule that
nothing in it ever reports a control as unusable.

- `detectBeats` / `useBeats` / `useBeatStore` (`src/beats.ts`, D-413) — the one binding over
  `chroma_detect_beats` (musical beat analysis, `apelles-beat`) and its session cache keyed by
  (path, meter, tempo hint), with in-flight requests shared. The Edit tab's beat grid and the
  Motion tab's soundtrack both read beats through it; the types and maths are `@apelles/beats`.
