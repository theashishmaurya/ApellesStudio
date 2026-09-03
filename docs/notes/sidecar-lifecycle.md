# Sidecar lifecycle (D-028)

The Chroma app starts and supervises the `ai/` FastAPI sidecar itself. No more
`cd ai && ./run.sh` before using subject mask / tracking / depth.

Code: `app/src-tauri/src/chroma/sidecar.rs` (one file). Upstream footprint:
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
   `CARGO_MANIFEST_DIR` is `<workspace>/app/src-tauri`, so `../../ai` is the
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

## TODO — real ownership of an "external" sidecar (found 2026-09-03, D-069)

**The gap:** "External already up" mode (above) makes its owned-vs-external
decision **exactly once**, at app boot, from a single bare `GET /health`. Once
anything answers, Rust defers to it **forever** — `monitor_external`'s 10s poll
loop only updates a `healthy` flag for the UI; it never re-evaluates whether
that process is still the right one, and explicitly never restarts it even
once it's confirmed dead ("not managed — not restarting it").

**Why this bit for real:** a sidecar process from **Tuesday, Sept 1, 21:19** —
over two days old, from before `/depth_track` even existed in `ai/server.py`
— sat on port 8765 through this entire session. Every one of that night's many
app restarts found it healthy and deferred to it, so the staleness was
invisible to every actual code rebuild. Root-caused and worked around by hand
(`kill` + `ai/run.sh`) — see **D-069**, `docs/08-decisions.md`. The underlying
gap is still open.

**What "properly Rust-owned" would need** (real design work, not scoped in
detail yet — this section is the placeholder for that scoping pass, not the
scoping itself):
- A stronger health check than a bare 200 on `/health` — e.g. a version/build
  marker in the `/health` payload (`ai/server.py` already returns a JSON body
  with a `models` list; a `version` or `git_sha` field would let Rust compare
  "is this process running code I recognize" instead of just "is it alive")
  so a genuinely stale external process gets detected, not silently trusted.
- A real policy decision for what happens on a detected mismatch: refuse and
  warn (safest — never kill a process the app didn't start), offer to take
  over (kill it and spawn a fresh Rust-owned one), or something in between.
  Killing an external process Rust never started is not something to do by
  default without the owner's say-so — this needs a real UI moment, not a
  silent auto-kill.
- Reconsider whether "already up → external, hands off forever" should
  instead periodically re-poll `/health` for a version match even after the
  initial boot decision, not just for liveness — so a sidecar that gets
  restarted *externally* mid-session (e.g. someone runs `ai/run.sh` fresh
  while the app is still open) is picked up rather than needing a full app
  restart to re-evaluate.
- Surfacing `chroma_ai_status`'s existing `managed`/`healthy` fields
  somewhere in the UI (today: "nothing consumes it yet," per this doc's own
  note above) — an owner staring at a feature that silently does nothing has
  no way to tell "sidecar's down" from "sidecar's stale" from "this feature
  is just broken" without reading `app.log` by hand, exactly what happened
  here.

Not started. See `docs/04-roadmap.md`'s Next queue for the tracked item.

## TODO — packaged app (Phase 4)

`resolve_ai_dir` relies on `CARGO_MANIFEST_DIR`, a build-machine path. A signed
`.app` bundle has no workspace next to it. Phase 4 (packaging) needs:
- the sidecar source (or a PyInstaller/`briefcase` freeze) shipped as a Tauri
  resource, resolved via `app.path().resolve("ai", BaseDirectory::Resource)`;
- a bundled Python or a first-run venv bootstrap + `pip install`;
- models either bundled or downloaded on first `/segment` (already the case).
Until then a packaged build should ship with `CHROMA_AI_DIR` +
`CHROMA_AI_PYTHON` baked in, or the sidecar disabled.
