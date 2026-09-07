# Sidecar lifecycle (D-028; two sidecars since D-184, N-sidecar supervisor D-185)

The Chroma app starts and supervises its Python sidecars itself. No more
`cd <dir> && ./run.sh` before using the features that depend on them.

**There are two**, and everything in this doc applies to each independently —
they are separate processes, separate venvs, separate ports, separate status:

| spec | dir | port | what it does | why it's separate |
|---|---|---|---|---|
| `AI` | `ai/` | 8765 | SAM 2 → ViTMatte matting (D-012/D-016), depth track (D-036), MoGe-2 normals (D-077) | — |
| `AI_MEDIA` | `ai-media/` | 8766 | word-level transcript (mlx-whisper) + video understanding (ffmpeg scene-detect + Qwen3-VL), D-184 | PyTorch/`transformers<5` vs. MLX/`transformers>=5.5` — pip reports the union as `ResolutionImpossible` (D-184) |

Code: `chroma_ai::sidecar` (the whole implementation, D-145) +
`app/src-tauri/src/chroma/sidecar.rs` (the Tauri-only bits). Upstream
footprint: `chroma/mod.rs` +1 (`pub mod sidecar;`), `lib.rs` +2
`std::thread::spawn` in `.setup()` (one per sidecar), +2
`chroma::sidecar::shutdown()` calls in the `.run(...)` exit hook (one call
kills *both*), +2 `generate_handler!` lines (`chroma_ai_status`,
`chroma_ai_media_status`). No new crate.

**D-185 — one supervisor, N sidecars.** The per-sidecar facts (name, dir,
default port, the four env var names) live in a `SidecarSpec` static; the
per-sidecar runtime state (owned child, status snapshot) lives in a registry
keyed by spec name; the logic below is written once and shared. Adding a third
sidecar is a new `SidecarSpec` + a spawn line + a status command — not a copy
of this file. Everything below reads "the sidecar" for brevity; substitute the
spec you care about.

## Where it runs

`supervise(&SPEC)` runs on its own thread — one per sidecar, spawned from
`lib.rs` `.setup()` right after the preview / analytics / thumbnail workers (so
`fern` logging is already installed and every `[sidecar/<name>]` line lands in
`app.log`). `spawn_and_supervise` / `spawn_and_supervise_media` are zero-argument
wrappers, because `std::thread::spawn` needs an `FnOnce()`.

## Resolve order

Each spec names its own four env vars. For `AI` they are `CHROMA_AI_*`; for
`AI_MEDIA`, `CHROMA_AI_MEDIA_*`.

**Sidecar dir** (`resolve_dir`):
1. `<spec>.dir_env` (`CHROMA_AI_DIR` / `CHROMA_AI_MEDIA_DIR`), if it contains
   `server.py` (else warn + fall through).
2. `env!("CARGO_MANIFEST_DIR")/../../<dir>` → `../<dir>` → `./<dir>` (first with
   `server.py`). `CARGO_MANIFEST_DIR` is `<workspace>/crates/chroma-ai` since
   D-145, so `../../ai` and `../../ai-media` are the dev checkout's sidecars.

**Python** (`resolve`):
1. `<spec>.python_env` (`CHROMA_AI_PYTHON` / `CHROMA_AI_MEDIA_PYTHON`) — must be
   an existing file (else hard error, retried).
2. `<dir>/.venv/bin/python`.
3. `python3` on `PATH`.

**Port**: `<spec>.port_env` — `CHROMA_AI_PORT` (default `8765`), the same value
`chroma_ai::sidecar_base_url()` uses; `CHROMA_AI_MEDIA_PORT` (default `8766`),
the same value `chroma_ai::media_understanding::media_base_url()` uses.

## Modes

- **`<spec>.no_spawn_env=1`** (`CHROMA_AI_NO_SPAWN` / `CHROMA_AI_MEDIA_NO_SPAWN`)
  → log "auto-spawn disabled" and return, for that sidecar only. For devs
  running `ai/run.sh` / `ai-media/run.sh` by hand.
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
  `<name> sidecar can't start: no python at <path>. Run:  cd <dir> && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`
  and re-resolve every 30 s. The app does not crash; mask/track calls fail with
  the existing "sidecar unreachable" error until it's fixed.

## Exit hook

`lib.rs` `.run(...)` handles `RunEvent::ExitRequested` and `RunEvent::Exit` by
calling `chroma::sidecar::shutdown()` **before** its `libc::_exit(0)` /
`std::process::exit(0)`. One call covers **every** sidecar (D-185): it walks the
registry, sets each one's `shutting_down` flag (every sleep in every supervisor
is interruptible and checks it) and `child.kill()` + `wait()`s each owned child.
So a newly-added sidecar can never be forgotten here — the exit-hook call site
needs no per-sidecar change. External sidecars are never touched. Result:
`pgrep -f "uvicorn server:app"` is empty after quit.

## The status commands

`chroma_ai_status` and `chroma_ai_media_status` (D-184) both return
`{ managed: bool, healthy: bool, pid?: u32, restarts: u32, stale: bool,
lastError?: string }` — the same `SidecarStatus`, one per spec, from
`chroma_ai::sidecar::status_snapshot(&SPEC)`. Both are consumed by the Settings
panel's sidecar status cards (D-101 built the first, D-184 the second; before
D-101 nothing consumed the command at all).

## Real ownership of an "external" sidecar — done (D-101, 2026-09-04)

**This section (below) is the original scoping note, kept for its "why" —
everything it describes as needed is now built.** Summary of what actually
landed, D-101 has the full writeup:

- `ai/server.py`'s `/health` reports `content_sha256` (SHA256 of its own
  file bytes, truncated to 16 hex chars) — a zero-maintenance signal, not a
  hand-bumped version string.
- `chroma::sidecar::content_hash` computes the identical hash over its own
  resolved `ai/server.py` and compares it against an external sidecar's
  `/health` response, both at the initial boot-time decision and on every
  subsequent `monitor_external` poll (still the existing 10s cadence).
- **Policy: refuse-and-warn only.** A mismatch is logged clearly and
  surfaced via `SidecarStatus.stale` — never auto-killed. Killing a process
  this app didn't start stays a real UI moment requiring explicit consent,
  not a default this or any future autonomous pass should take. An
  "offer to restart the stale sidecar" one-click UI is a legitimate,
  explicitly deferred follow-up (unlike an automatic kill, a one-click
  action *with a human present to click it* is fine).
- `chroma_ai_status` has a real consumer for the first time: a small "AI
  Sidecar" status card in `SettingsPanel.tsx` (health/managed/stale/
  restart-count/last-error, polled every 5s).
- Live-verified against a real ~6-hour-stale sidecar process this session
  had genuinely been running against — not a synthetic scenario.

**Still not addressed** (out of scope for D-101, real remaining gaps):
- No "offer to take over" UI — a stale external sidecar still requires a
  manual `kill` + `cd ai && ./run.sh` by hand, same as before, just now
  with a clear on-screen signal that it's needed.
- Nothing changed about what happens if an external sidecar dies
  permanently while the app stays open — `monitor_external` only monitors,
  by design (D-028 step 3); it still never falls through to spawning an
  owned replacement. Not this item's scope; a real design question of its
  own if it ever becomes a real problem.

## TODO — real ownership of an "external" sidecar (found 2026-09-03, D-069) — ORIGINAL SCOPING NOTE, kept for context, see "done" section above

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

**Done — see the "Real ownership... — done (D-101)" section above this one.**

## TODO — packaged app (Phase 4)

`resolve_ai_dir` relies on `CARGO_MANIFEST_DIR`, a build-machine path. A signed
`.app` bundle has no workspace next to it. Phase 4 (packaging) needs:
- the sidecar source (or a PyInstaller/`briefcase` freeze) shipped as a Tauri
  resource, resolved via `app.path().resolve("ai", BaseDirectory::Resource)`;
- a bundled Python or a first-run venv bootstrap + `pip install`;
- models either bundled or downloaded on first `/segment` (already the case).
Until then a packaged build should ship with `CHROMA_AI_DIR` +
`CHROMA_AI_PYTHON` baked in, or the sidecar disabled.
