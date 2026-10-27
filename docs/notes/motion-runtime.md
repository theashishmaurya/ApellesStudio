# Motion's render runtime (D-417)

How the Motion tab renders in an installed app, and how to check it. The decision
and its reasons are D-417 in `docs/08-decisions.md`; this note is the working detail.

## The three parts

| part | where | size | who publishes it |
|---|---|---|---|
| **Engine pack** — prebuilt Remotion bundle, `scripts/render.mts`, `scripts/check-component.mts`, the engine sources the check reads, built-in components, `@remotion/renderer` + deps, TypeScript, the traced type declarations | inside the app: `Apelles.app/Contents/Resources/motion-engine/` | 90 MB in the `.app`, +33 MB in the DMG (14.5 MB as one `.tar.gz`; see D-417's open option) | built from this repo by `packages/motion-engine/scripts/build-pack.mts` |
| **Node.js 24.22.1** (`bin/node`, `LICENSE`) | downloaded: `<app data>/motion-runtime/<key>/node/` | 53 MB → 123 MB | nodejs.org |
| **Chrome Headless Shell 149.0.7790.0** | downloaded: `…/<key>/chrome/` | 98 MB → 202 MB | Chrome for Testing |
| **Remotion compositor 4.0.519** (ffmpeg + dylibs) | downloaded: `…/<key>/compositor/` | 8 MB → 18 MB | npm registry |

`<app data>` is `~/Library/Application Support/studio.apelles.app`. `<key>` is
`node-24.22.1_chrome-149.0.7790.0_remotion-4.0.519` (`pins::runtime_key()`).

In a developer checkout the engine files are `packages/motion-engine` itself and the
developer's own `node` is used (see "Development" below), so nothing downloads.

## Flow

1. **Launch** — `chroma::motion_runtime::configure` sets the layout (dev or
   packaged) and logs the cheap integrity check (`[motion-runtime] Ready: …` or
   `Missing: …`). Nothing downloads.
2. **Motion tab opens** — `useMotionRuntimeAutoInstall` (in `@apelles/bridge`) starts
   `chroma_motion_runtime_install` once per app session if the state is `missing`,
   `outdated` or `broken`. The banner shows progress from `motion-runtime-status`
   events (sent at most once per MiB downloaded and on every step change).
3. **Install** (`apelles_motion_runtime::store::install`, on its own thread):
   disk-space check → for each artifact (compositor, Node, Chrome — smallest first, so
   a network problem shows quickly): download to `downloads/<file>.part`, resuming with
   `Range`, keep only if size and SHA-256 match → unpack each into
   `staging-<key>/<part>/` → write `runtime.json` → rename to `<key>/` → delete the
   downloads and any other runtime version.
4. **Render** — every path (`render_scene_file`, `chroma_motion_preview_frame`, the
   component check, proof and proxy) calls `motion_runtime::require()`, which returns a
   `MotionRuntime` (node, engine dir, prebuilt bundle, browser, compositor dir) or
   `motion_runtime_not_ready: <why>`. Commands are `node <engine>/scripts/render.mts
   <still|frames|video> --serve-url=<bundle> … --browser-executable=… --binaries-directory=…`.

## States (`motion_runtime_status`, the banner, Settings)

| state | means | what happens |
|---|---|---|
| `ready` | renders work (`source`: `managed` or `developer`) | banner hidden; Settings offers Remove |
| `missing` | nothing installed | auto-download on first tab open; else Download |
| `outdated` | a runtime for older pins | same; the old one is removed after the new one is in place |
| `broken` | the current runtime fails the integrity check | same (reinstall) |
| `installing` | downloading / unpacking / finishing | progress; Render, Still, component check disabled with the reason |
| `failed` | `errorKind` `offline` / `diskSpace` / `checksum` / `http` / `interrupted` / `archive` / `io` | Retry; never retried on a timer |
| `removing`, `unconfigured` | transient | — |

## Development

- `tauri dev` renders with your Node: `APELLES_MOTION_NODE=/path/to/node`, else `node` on
  `PATH`, else `/opt/homebrew/bin/node` or `/usr/local/bin/node`, if it is 22.18+ (the
  engine's `.mts` scripts need Node's built-in type stripping). Chrome is Remotion's
  own cache in `node_modules/.remotion`, as before.
- `APELLES_MOTION_MANAGED=1 npm run tauri:dev` ignores your Node and uses the downloaded
  runtime (downloaded into your dev app data by the Motion tab, like a user's) with the
  checkout's engine files. The prebuilt bundle is release-only; dev still bundles from
  source.
- Install the real runtime without the app:
  `cargo run -p apelles-motion-runtime --example install_runtime -- /tmp/rt`.
  Run the render tests on it:
  `APELLES_MOTION_RUNTIME_DIR=/tmp/rt/<key> cargo test -p apelles-motion --test preview_render -- --ignored`.
  Add `APELLES_MOTION_PACK_DIR=/tmp/pack` (below) and the same tests, and `component_render`,
  run exactly what an installed app runs: the pack's prebuilt bundle and files with the
  downloaded Node, Chrome and compositor.
- Build and inspect the pack:
  `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON packages/motion-engine/scripts/build-pack.mts --out=/tmp/pack`
  (it self-tests from a copy outside the repo). Render from it with a downloaded runtime:
  `<rt>/node/bin/node /tmp/pack/scripts/render.mts still --serve-url=/tmp/pack/bundle
  --props=crates/apelles-motion/tests/fixtures/sample.json --output=/tmp/s.png --frame=60
  --scale=0.25 --browser-executable=<rt>/chrome/chrome-headless-shell --binaries-directory=<rt>/compositor`
  → SHA-256 `1142adab…5dbf1`, the recorded D-403 hash.

## Bumping a pin

- **Remotion:** bump the engine's Remotion packages together; then re-pin the compositor
  (URL, size, SHA-256 of the tarball, and `COMPOSITOR_NPM_INTEGRITY` from the new
  `package-lock.json`) and Chrome (`TESTED_VERSION` in
  `node_modules/@remotion/renderer/dist/browser/get-chrome-download-url.js`; measure the
  zip's SHA-256, compare its MD5 with the bucket's `x-goog-hash`). `pins.rs`'s tests fail
  until both match the checkout.
- **Node:** take the newest LTS release, its `darwin-arm64.tar.gz` line from
  `SHASUMS256.txt`, and its size; update `unpacked_size` from `tar tzvf`.
- Every bump changes the key: installed runtimes read `outdated` and the next Motion tab
  open replaces them.

## Checking an installed build

The release checklist (`docs/releases/README.md`, step 5) is the list: first open
downloads with progress, editing meanwhile, Render/Still disabled then working, a
component check, offline + Retry + resume, relaunch integrity, Remove, and
`motion_runtime_status` over MCP.
