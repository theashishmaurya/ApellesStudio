# chroma-motion

**Layer 2 (domain).** The manifest → Remotion render bridge for the Motion
tab (D-039 roadmap "Motion tab MVP", D-046).

- **Deps:** `chroma-types` (for the shared `ChromaError`), `serde` +
  `serde_json`. **No `wgpu`, no `ffmpeg`, no Remotion/Node reimplementation.**
- **What it is:** a thin process-orchestration wrapper around the *existing*,
  fully-functional `packages/motion-engine/` Remotion project. Given a
  manifest JSON path and an output path, it shells out to
  `npx remotion render Animation <output> --props=<manifest>` inside
  `packages/motion-engine/` — the exact command `/animate` already documents
  for a CLI render.
- **Why Rust wraps Node instead of the other way round:** the Remotion
  engine — 7 primitives, a manifest compiler, React/Three.js rendering — IS
  the fat core for motion graphics here. Reimplementing it in Rust would
  throw away real, working, non-trivial code to satisfy an architectural
  preference. `chroma-motion` is the one deliberate exception to "the fat
  core is Rust" named in `docs/notes/architecture-lock.md`; see **D-046** in
  `docs/08-decisions.md`.
- **What it does NOT do:** no manifest schema validation beyond "is this
  parseable JSON" — the manifest schema's single source of truth is the
  `zod` schema in `packages/motion-engine/src/engine/schema.ts` (Remotion's
  own `calculateMetadata` re-validates it at render time too); duplicating
  that schema in Rust would just drift. No progress reporting — the Tauri
  command blocks (on a background thread) until `npx` exits. No GPU, no
  media decode, no reading rendered frames back as an overlay layer yet
  (that's the `chroma-compositor`-facing follow-up the crate's original
  scope line envisioned — deferred, not needed for the tab MVP).

## API

- `RenderRequest::new(engine_dir, manifest_path, output_path)` — `engine_dir`
  is `packages/motion-engine`; `composition_id` defaults to `"Animation"`.
- `validate_request(&req) -> Result<(), ChromaError>` — the engine dir
  exists, the manifest file exists and parses as JSON. Fails fast, before
  spawning `npx`.
- `build_command(&req) -> std::process::Command` — pure and unit-tested: the
  exact `npx remotion render …` argv/cwd, not yet run.
- `run_render(&req) -> Result<RenderOutcome, ChromaError>` — validates, then
  runs `npx` synchronously (**blocks the calling thread**). The Tauri command
  wraps this in `tauri::async_runtime::spawn_blocking(...).await`, so from
  the caller's point of view the render finishes before the command returns
  — no polling, no progress bar.

## Status

D-046 — the render-bridge MVP wired to the Motion tab's "Render" action
(`chroma_motion_render` in `app/src-tauri/src/chroma/motion.rs`). One render
at a time, synchronous, no cancel, no progress reporting — see
`docs/04-roadmap.md` "Motion tab MVP" for what's deferred.
