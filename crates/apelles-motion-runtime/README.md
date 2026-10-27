# apelles-motion-runtime

**Layer 1 (I/O).** Motion's render runtime (D-417): the programs a Motion render
runs — Node.js, Chrome Headless Shell and the Remotion compositor — downloaded on
demand, checksum-verified, installed atomically into app data, and found by one
resolver every Motion render path uses.

- **Deps:** `serde`, `serde_json`, `thiserror`, `log`, `reqwest` (blocking, rustls),
  `sha2`, `flate2` + `tar`, `zip`, `rustix` (`statvfs`). All were already in
  `Cargo.lock`; this crate added none to the graph.
- **Used by:** `apelles-motion` (builds every render command from a located
  `MotionRuntime`) and the app (`chroma::motion_runtime`: layout, status event,
  install/remove commands, the three MCP ops).
- **Does NOT:** render, bundle, know about manifests, or install anything on its
  own. The Motion tab asks the first time it opens; an agent asks with
  `motion_install_runtime`.

## Modules

| module | what |
|---|---|
| `pins` | the three pinned downloads (URL, size, SHA-256, what to keep, the entry file), `runtime_key()` |
| `fetch` | one download, resumable (`.part` + HTTP `Range`), kept only if size and SHA-256 match |
| `unpack` | `.tar.gz` / `.zip` into a folder: leading folder stripped, optional keep-list, modes kept, unsafe paths and symlinks refused |
| `store` | the on-disk layout, the cheap integrity check (`inspect`), the disk-space check, the atomic install / upgrade, removal |
| `locate` | `Layout` (dev checkout or installed app), `MotionRuntime`, `resolve()` — developer override → installed runtime → not ready |
| `manager` | the process-wide state: `configure`, `status`, `require`, `start_install`, `remove` |

## On disk

```
<app data>/motion-runtime/
  node-24.22.1_chrome-149.0.7790.0_remotion-4.0.519/   one installed runtime (its key)
    node/bin/node, node/LICENSE
    chrome/chrome-headless-shell, …, LICENSE.headless_shell
    compositor/remotion, ffmpeg, ffprobe, *.dylib
    runtime.json                                        the stamp the integrity check reads
  downloads/        verified archives and resumable *.part files (deleted after an install)
  staging-<key>/    an install in progress (never read as a runtime)
```

## Developer notes

- A dev build (`tauri dev`, `cargo test`) renders with the developer's own Node:
  `APELLES_MOTION_NODE`, else `node` on `PATH`, else Homebrew's, if it is 22.18+.
  `APELLES_MOTION_MANAGED=1` skips that and uses the downloaded runtime instead.
- `cargo run -p apelles-motion-runtime --example install_runtime -- <dir>` installs
  the real pinned runtime into `<dir>` (real network) and prints timings and sizes.
  Pass the printed runtime folder to `apelles-motion`'s render tests as
  `APELLES_MOTION_RUNTIME_DIR` to run them on it.
- `tests/install_mirror.rs` installs from a local fixture HTTP server: clean install,
  resume, corrupt download, upgrade, disk-space refusal, offline. No network.
- Bumping a pin: re-derive URL, size and SHA-256 as `pins.rs`'s header describes;
  the key changes, so installed runtimes report `outdated` and the next install
  replaces them.
