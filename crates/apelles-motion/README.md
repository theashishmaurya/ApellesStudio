# apelles-motion

**Layer 2 (domain).** The manifest → Remotion render bridge for the Motion
tab (D-039 roadmap "Motion tab MVP", D-046).

- **Deps:** `apelles-types` (for the shared `ChromaError`), `apelles-motion-runtime`
  (the located Node / browser / engine files, D-417), `serde` + `serde_json`.
  **No `wgpu`, no `ffmpeg`, no Remotion/Node reimplementation.**
- **What it is:** a thin process-orchestration wrapper around the *existing*,
  fully-functional `packages/motion-engine/` Remotion project. Every render —
  a scene export, a preview still, a component proof, proxy frames — runs the
  engine's own renderer, `node <engine>/scripts/render.mts <video|still|frames>`
  (`@remotion/renderer` over a prebuilt bundle, D-417), with the Node, Chrome
  Headless Shell and compositor the runtime resolver located. Before D-417 it ran
  `npx remotion render`, which needed the whole Remotion CLI (bundler + Studio) on
  the machine; the renderer script needs only `@remotion/renderer`, so a release
  app can ship it in a small engine pack.
- **Why Rust wraps Node instead of the other way round:** the Remotion
  engine — 7 primitives, a manifest compiler, React/Three.js rendering — IS
  the fat core for motion graphics here. Reimplementing it in Rust would
  throw away real, working, non-trivial code to satisfy an architectural
  preference. `apelles-motion` is the one deliberate exception to "the fat
  core is Rust" named in `docs/notes/architecture-lock.md`; see **D-046** in
  `docs/08-decisions.md`.
- **What it does NOT do:** no manifest schema validation beyond "is this
  parseable JSON" — the manifest schema's single source of truth is the
  `zod` schema in `packages/motion-engine/src/engine/schema.ts` (Remotion's
  own `calculateMetadata` re-validates it at render time too); duplicating
  that schema in Rust would just drift. No progress reporting — the Tauri
  command blocks (on a background thread) until Node exits. No downloading or
  locating of Node / Chrome (`apelles-motion-runtime`). No GPU, no
  media decode, no reading rendered frames back as an overlay layer yet
  (that's the `apelles-compositor`-facing follow-up the crate's original
  scope line envisioned — deferred, not needed for the tab MVP).

## API

- `RenderRequest::new(runtime, bundle_cache, manifest_path, output_path)` —
  `runtime` is a located `MotionRuntime` (re-exported from
  `apelles-motion-runtime`); `composition_id` defaults to `"Animation"`.
- `validate_request(&req) -> Result<(), ChromaError>` — the engine dir
  exists, the manifest file exists and parses as JSON. Fails fast, before
  spawning anything.
- `runner_command(&runtime, mode)` / `build_command(&req, &bundle)` — pure and
  unit-tested: the exact `node scripts/render.mts video --serve-url=… --props=…
  --output=… [--frames=a-b] [--browser-executable=…] [--binaries-directory=…]`
  argv/cwd, not yet run.
- `run_render(&req) -> Result<RenderOutcome, ChromaError>` — validates, takes the
  bundle from `still::ensure_bundle`, then runs Node synchronously (**blocks the
  calling thread**; the job worker runs it on its own thread), on its own port
  (B-278).
- `MotionRuntime::developer(engine_dir)` — the developer's checkout and `node`
  (22.18+), what the tests and the certify example run with.

## Status

D-046 — the render-bridge MVP wired to the Motion tab's "Render" action
(`chroma_motion_render` in `app/src-tauri/src/chroma/motion.rs`). One render
at a time, synchronous, no cancel, no progress reporting — see
`docs/04-roadmap.md` "Motion tab MVP" for what's deferred.

## Render jobs (D-398)

`src/job.rs` is the pure state of one multi-scene render: the manifest snapshot's
hash, one entry per scene (frame window, pending / done / failed, output path,
delivered-to-Sources), the scene in flight, and the `JobView` the GUI and
`motion_get_state` show (`idle | running | error | interrupted`, what is done, what
is left). It has no threads and renders nothing; the app's worker
(`app/src-tauri/src/chroma/motion_job.rs`) runs `run_render` per scene and drives the
transitions. Persistence is an atomic JSON write beside the project. `blake3` hashes the
snapshot (already in the tree via `apelles-media`).

## Assets (D-404)

`src/assets.rs`: `import_asset` copies an image into `<project>.chroma/motion/assets/` named
by the SHA-256 of its bytes (`sha2`, already in the tree) and returns the `sha256:<hex>.<ext>`
id a manifest uses; idempotent, atomic. `RenderRequest::with_public_dir` / `PreviewRequest.public_dir`
serve that folder as Remotion's `public/`.

## Template library (D-407)

`src/templates.rs`: the user's Motion templates on disk, one `<app data>/motion/templates/<id>.json`
per template. `load_library` returns what parsed plus one `{file, error}` per file that did not
(a bad file never takes the library down); `save_template` writes atomically (`.part`, fsync,
rename) after checking the id is a safe file stem; `delete_template`. No schema validation here:
`templateDef.ts` (zod) is the one source of truth and the frontend checks each entry.

## Custom components (D-409)

`src/components.rs`: the custom-component backend. The library (`<root>/<id>/<version>/`,
built-ins under `packages/motion-engine/components/` plus `<app data>/motion/components/`;
per-folder load errors; staged-then-renamed versions; atomic `meta.json`); `check_source`
(spawns `node scripts/check-component.mts`); `write_draft` (replaces the open draft, never a
certified version); `prove` (three passes at once — in order in one tab via
`still::render_sequence --concurrency=1`, and two out-of-order fresh-still passes — compared by
decoded pixels: stills bit-exact, in-order within `IN_ORDER_MAX_DELTA`; contact sheet and
thumbnail); `certify` (only for a proof of the current source and module); `delete`;
`install_into_project` (hash-checked copy into the asset folder, `assets::store_bytes`); and
`render_proxy` (a custom layer's frames for the live player, cached by content).
`examples/certify_component.rs` runs the same path from a fixture folder (how the built-ins
were made); `tests/component_render.rs` (`--ignored`) re-proves them, renders an agent-built
document in two parallel renders, renders proxy frames and shows a stateful component fail.
This crate spawns the renderer; it never evaluates component code.

## Still frames (D-403)

`src/still.rs` is `motion_preview_frame`'s backend: `build_still_command` (the twin of
`build_command`, `node scripts/render.mts still --serve-url=<bundle> --props --frame --scale`),
`build_sequence_command` (`frames`, an image sequence in one process), `ensure_bundle`, and
`contact_sheet` (several frames tiled into one PNG, at most four per row, with `image`,
already in the tree). No clock, no randomness: the same manifest and frame give the same
PNG bytes (`tests/preview_render.rs`, `--ignored`, real renders).

**The bundle (D-417).** A release app renders its engine pack's prebuilt bundle in place;
a checkout builds one with the Remotion CLI it has (`build_bundle_command`, ~18 s), cached
under a blake3 content fingerprint of the engine's sources and reused until a file changes.
A project's assets are layered on as a derived copy of that bundle with the asset folder in
its `public/` (APFS clones the copy), keyed by the base and the asset names. Every render
path (export, still, proof, proxy) goes through this one function.

**Tests on the downloaded runtime.** `APELLES_MOTION_RUNTIME_DIR=<installed runtime folder>`
makes `tests/preview_render.rs` and `tests/component_render.rs` render with that runtime's
Node, Chrome Headless Shell and compositor instead of the developer's (see
`apelles-motion-runtime`'s `install_runtime` example); `APELLES_MOTION_PACK_DIR=<engine pack>`
renders from a pack built by `scripts/build-pack.mts`. With both set they run what an installed
app runs.
