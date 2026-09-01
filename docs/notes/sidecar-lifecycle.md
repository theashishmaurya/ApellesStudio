# Sidecar lifecycle (D-028)

The Chroma app starts and supervises the `ai/` FastAPI sidecar itself. No more
`cd ai && ./run.sh` before using subject mask / tracking / depth.

Code: `engine/src-tauri/src/chroma/sidecar.rs` (one file). Upstream footprint:
`chroma/mod.rs` +1 (`pub mod sidecar;`), `lib.rs` +1 `std::thread::spawn` in
`.setup()`, +2 `chroma::sidecar::shutdown()` calls in the `.run(...)` exit hook,
+1 `generate_handler!` line (`chroma_ai_status`). No new crate.

## Where it runs

`spawn_and_supervise(app)` runs on its own thread, spawned from `lib.rs`
`.setup()` right after the preview / analytics / thumbnail workers (so `fern`
logging is already installed and every `[sidecar]` line lands in `app.log`).

## Resolve order

**Sidecar dir** (`resolve_ai_dir`):
1. `CHROMA_AI_DIR` env, if it contains `server.py` (else warn + fall through).
2. `env!("CARGO_MANIFEST_DIR")/../../ai` → `../ai` → `ai` (first with `server.py`).
   `CARGO_MANIFEST_DIR` is `<workspace>/engine/src-tauri`, so `../../ai` is the
   dev checkout's sidecar.

**Python** (`resolve`):
1. `CHROMA_AI_PYTHON` env — must be an existing file (else hard error, retried).
2. `<ai>/.venv/bin/python`.
3. `python3` on `PATH`.

**Port**: `CHROMA_AI_PORT` (default `8765`) — same value `chroma::mask`'s
`sidecar_base_url()` uses.

## Modes

- **`CHROMA_AI_NO_SPAWN=1`** → log "auto-spawn disabled" and return. For devs
  running `ai/run.sh` by hand.
- **External already up** → one `GET /health` at start; if OK, log
  "already running (external)" and enter monitor-only mode: health-poll every
  10 s, log state changes, never own / kill / respawn it. `chroma_ai_status`
  reports `managed: false`.
- **We spawn it** → `python -m uvicorn server:app --host 127.0.0.1 --port <port>`
  with `cwd = <ai>` and `CHROMA_AI_PORT` in the env. stdout+stderr are each read
  on a thread and every line goes to `log::info!("[sidecar] {line}")`; the last
  12 stderr lines are kept for the exit message.

## Ready + supervise + backoff

- **Wait-for-ready**: poll `/health` every 500 ms up to 30 s →
  `sidecar ready in {ms}` or `failed to become healthy within 30s` (keeps
  supervising either way).
- **Supervise**: `try_wait` poll every 2 s (keeps the `Child` in a shared
  `Mutex` so the exit hook can reach it) + an opportunistic `/health` refresh
  for `chroma_ai_status`.
- **Restart backoff** on exit: 2 s → 4 → 8 → 16 → 30 (cap). After **6**
  consecutive failures that each lasted < 60 s, drop to a 60 s slow-retry with a
  clear "check the [sidecar] log" error. Any run that stays up ≥ 60 s resets the
  backoff and the fast-failure counter.
- **venv / python missing**: log
  `AI sidecar can't start: no python at <path>. Run:  cd ai && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`
  and re-resolve every 30 s. The app does not crash; mask/track calls fail with
  the existing "sidecar unreachable" error until it's fixed.

## Exit hook

`lib.rs` `.run(...)` handles `RunEvent::ExitRequested` and `RunEvent::Exit` by
calling `chroma::sidecar::shutdown()` **before** its `libc::_exit(0)` /
`std::process::exit(0)`. `shutdown()` sets a `shutting_down` flag (every sleep in
the supervisor is interruptible and checks it) and `child.kill()` + `wait()` on
the owned child. An external sidecar is never touched. Result: `pgrep -f
"uvicorn server:app"` is empty after quit.

## `chroma_ai_status` command

`{ managed: bool, healthy: bool, pid?: u32, restarts: u32, lastError?: string }`
— for a future UI "AI: ●" indicator. Nothing consumes it yet.

## TODO — packaged app (Phase 4)

`resolve_ai_dir` relies on `CARGO_MANIFEST_DIR`, a build-machine path. A signed
`.app` bundle has no workspace next to it. Phase 4 (packaging) needs:
- the sidecar source (or a PyInstaller/`briefcase` freeze) shipped as a Tauri
  resource, resolved via `app.path().resolve("ai", BaseDirectory::Resource)`;
- a bundled Python or a first-run venv bootstrap + `pip install`;
- models either bundled or downloaded on first `/segment` (already the case).
Until then a packaged build should ship with `CHROMA_AI_DIR` +
`CHROMA_AI_PYTHON` baked in, or the sidecar disabled.
