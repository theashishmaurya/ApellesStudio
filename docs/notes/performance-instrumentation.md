# Performance instrumentation — what exists, where

Owner asked: "do we have any performance matrix setup to know the difference? Or will we
be doing just blindly? Also we need perf metric for all the things right or else we will
be just shooting in dark." This note is the answer: an inventory of every real timing
mechanism already in the codebase, plus what's new (D-092), so nobody has to rediscover
this by grepping cold. It replaces "shooting in the dark" with "here's where the numbers
already are, and here's the one gap that was closed tonight."

None of this is one unified dashboard — that's a real gap, not an oversight (see
"What's still missing" below) — but the raw numbers are not being lost; they're logged
and callable today, just scattered across three layers.

## 1. UI layer — `app/bench/` (D-092)

Deterministic, self-measuring frame-timing harness for the React/webview UI. Was built
against RapidRAW's old library/editor-slider flow; that flow was removed with the DAM
strip-out (D-043), so the harness had gone stale (its own selectors pointed at removed
DOM). Retargeted tonight at the Edit tab's multi-track timeline — the most relevant
surface given tonight's NLE build (D-086/088/089/090) and freeze fix (D-083), and the
most direct way to check whether the just-enabled React Compiler (D-091) measurably
helps.

- `bench/replay.js` — paste into devtools console against a running build. Drives three
  scripted phases (`pan`, `dragover`, `move`) with fixed synthetic timing, 10 iterations
  (2 warmup discarded), and buckets `requestAnimationFrame` frame-to-frame durations per
  phase. `dragover` is a direct regression probe for D-083 (sustained native `dragover`
  ticks over a multi-track timeline — the exact freeze scenario).
  Self-measuring, not devtools-Timeline-export-dependent, so it reads the same across
  WebKitGTK/WKWebView/WebView2 — see the file's own header comment and
  `bench/README.md`'s "Why it's built this way" for the full rationale.
- `bench/analyze.mjs` — diffs two saved result JSONs, reports median/p95/stdev per
  metric per phase with a before→after percent change.
- **Known, real limitation, not fixed tonight**: this harness requires a manual
  paste-and-save per run inside a live devtools console. No tool available in this
  Claude Code session can drive the actual native Tauri window (browser-automation tools
  only reach a plain Chrome tab, which hard-fails immediately on `window.__TAURI__`
  being undefined — confirmed earlier this session). So **no compiler-on-vs-off numbers
  were captured tonight** — doing so requires a human (or a future CI/WebDriver setup,
  see below) to actually run the two paste-and-save cycles by hand. The script and
  analyzer are ready; running them is the next real step, not something to fabricate a
  number for.

## 2. Rust/native layer — scattered `Instant::now()`/`elapsed()` + `log::info!`

No unified framework — each hot path times itself locally and logs via the existing
`log`/`env_logger` setup (`RUST_LOG=info` or similar to see it). Real, load-bearing
instrumentation already in place:

- `app/src-tauri/src/chroma/playback.rs:209,214,220` — per-frame decode (`d0`) and GPU
  upload (`g0`) timing inside the playback loop (`loop_start`).
- `app/src-tauri/src/chroma/export.rs:341` — full export job wall-clock time.
- `app/src-tauri/src/chroma/sidecar.rs:310,369,385` — sidecar process startup + the
  `READY_TIMEOUT` readiness poll.
- `app/src-tauri/src/gpu_processing.rs:1662`, `app/src-tauri/src/image_processing.rs:198`,
  `app/src-tauri/src/image_loader.rs:117,181` — GPU render pass and image-decode timing.
- `app/src-tauri/src/panorama_stitching.rs` (4 sites), `app/src-tauri/src/lens_blur.rs:73`,
  `app/src-tauri/src/adjustment_utils.rs:97`, `app/src-tauri/src/lib.rs:335,600` — per-
  effect and per-Tauri-command timing.

Pattern: `let start = Instant::now(); /* work */ log::info!("... {}ms", start.elapsed().as_millis());`.
Grep `Instant::now()` across `app/src-tauri/src` and `crates/` to find the current
complete list — this note is a snapshot, don't treat it as exhaustive going forward.

## 3. Sidecar (Python/AI) layer — `time.time()` per-call timing + `GET /memory`

- Per-inference timing returned inline in several endpoint responses — e.g.
  `ai/server.py:491-546` (SAM mask: `sam_ms`, `refine_ms` fields in the response body),
  `ai/server.py:1011-1018` (`infer_secs` on async job results). Grep `time.time()` in
  `ai/server.py` for the current list.
- **`GET /memory`** (added with the TTL auto-unload work, D-087) — process RSS plus
  per-model loaded/idle-seconds/TTL status for every lazy-singleton model
  (SAM2/YOLO/ViTMatte/Video-Depth-Anything/MoGe-2). This is real memory instrumentation,
  not timing, but it's the sidecar's other half of "don't fly blind" — see D-087 and
  `docs/08-decisions.md`.
- **`POST /unload`** — manual reclaim, also from D-087, useful when checking whether a
  memory number is "still warm" vs "actually released."

## What's still missing (real gaps, not implied by the above)

- No single dashboard/command aggregates all three layers into one view — each is
  checked independently today (devtools console for UI, `log::info!` output for Rust,
  the sidecar's own HTTP responses/`/memory` for Python).
- No CI/headless runner for `app/bench/` (documented in its own README) — Tauri's
  WebDriver story (`tauri-driver`) doesn't cover macOS, which is the primary dev
  platform here.
- No automated before/after gate anywhere (e.g. "fail if p95 frame time regresses more
  than X%") — every comparison today is a manually-triggered, manually-read one-off.

None of these are blocking anything currently in flight; flagged here so the next time
someone reaches for "are we faster now?" they know exactly which of these three places
to check, and know that a real unified answer is still future work, not something
already half-broken.

## Real finding, 2026-09-04: check `uptime`/system load before blaming app code

Chased a real "it hangs the UI so much" report (D-111) expecting an app-level
optimistic-UI gap. `useEditorTimelineStore.applyOp` was already fully optimistic — the
real, measured cause of most of the felt lag was **system load**: `uptime` read `41.47
23.73 14.89` on this 10-core dev machine (4x oversubscribed) from the session's own many
concurrent agent/cargo processes, corroborated by a direct measurement — writing this
project's real 8KB `project.json` took 87.83ms, when a file that size should write in
low single-digit ms under normal load. **Check `uptime` first** when a performance
report comes in during a session with several concurrent agents/builds running — it's a
five-second check that can save chasing an app-code bug that isn't there. Self-resolving
once concurrent activity quiets down, not something to "fix" in the app.
