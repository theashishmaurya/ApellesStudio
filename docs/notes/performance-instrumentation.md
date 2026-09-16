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

## 4. Per-clip IPC FAN-OUT — `TimelinePane.mountCost.dom.test.tsx` (D-334)

The newest piece, and a different KIND of measurement from everything above:
it counts backend round trips rather than timing them.

Why that is the right instrument here. The owner's "opening a project takes
forever / the timeline takes forever" report turned out to be dominated not by
any single slow operation but by **how many operations one mount starts** — 75
`chroma_audio_waveform` decodes to fill a viewport showing five clips. A timer
cannot see that (each call is individually fine); a counter can. And in jsdom
the wall-clock is meaningless anyway (every `invoke` resolves on a microtask),
while the CALL COUNT is the same number in jsdom as in production.

- Mounts the real `TimelinePane` at 8 / 150 / 300 clips in the owner's real
  project shape (linked A/V pairs off one long 4K source) and counts `invoke`s
  by command name.
- Asserts the fan-out is bounded by what is VISIBLE, not by clip count.
- **Two traps this file documents in place, because both made it pass for the
  wrong reason during D-334**: `Waveform`'s module-level peak cache leaks
  between test cases unless every mount uses a fresh source path, and a culling
  fix can make a "not many" assertion vacuously true by fetching *nothing* — so
  the cross-check now asserts the small case fetched something real first.

Sits alongside `TimelinePane.playheadCost.dom.test.tsx` (D-325), which measures
the opposite thing: steady-state React commit cost with the IPC deliberately
stubbed out. Neither subsumes the other, and the `playheadCost` stub is exactly
what hid B-204 until this file existed.

## 5. The `scrub` channel — the PAUSED preview path (D-334)

`previewTiming.ts`'s `fetch`/`tick`/`raf` channels are recorded **only inside
the play loop** (`PreviewPane`'s rAF `tick`). That left the paused/scrub path —
the one "the preview takes like hell" is actually about — with no cost
instrumentation at all: `debug_frame_timing` could report its paint cadence but
could not say how much of a scrub frame was Rust and how much was webview.

`scrub` times the same `chroma_timeline_frame` round trip on the paused path.
It is a **separate channel, not more samples in `fetch`**, because the two
measure different regimes: playback streams the decode pipe forward (~3.5 ms of
Rust, per D-290), while a scrub routinely asks for a frame BEHIND the pipe's
read head, which costs a kill-and-respawn plus an ffmpeg keyframe seek —
248-337 ms against 6.7 ms sequential, per `decode_pipe.rs`'s own measurement.
Averaging them would hide precisely the difference the channel exists to show.

**How to read it:** `scrub.medianMs` far above `fetch.medianMs` means the
decode pipe, not the webview. Move the playhead while PAUSED to fill it.

**Note for macOS specifically:** WebKit does not implement the Long Tasks API,
so `PerformanceObserver({type:'longtask'})` and Long Animation Frames record
nothing in this app's webview. `requestAnimationFrame` gap sampling — what this
module already does — is the only option, which is why D-334 extended it rather
than reaching for the standard API.

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

## Second live confirmation, 2026-09-16: load average 130 from sibling agents

The 2026-09-04 finding above repeated, harder, and is now recorded as a standing
rule rather than an anecdote. During D-334/D-335 this 10-core machine ran at a
**load average of 92-130** from concurrent subagent `cargo` builds and `vitest`
runs. Two concrete consequences, both measured:

- **D-335:** the same transcription model, on the same input, producing
  **byte-identical output**, took **215 s in one run and 498 s in another**.
  Anything derived from those wall-clocks is a ratio at best.
- **D-334:** a live-app measurement was attempted and **abandoned** — a second
  `tauri dev` instance could not even finish starting under that load, and a
  frame-timing number taken on a box that oversubscribed would not have meant
  anything anyway. That entry's numbers are therefore fan-out COUNTS and
  code-level cost accounting, deliberately, not stopwatch figures.

**The rule:** run `uptime` before taking any performance number, and record the
load alongside it. A number taken above roughly 2x core count is a ratio, not a
measurement — and a number taken above 10x is noise. Counting invariants (how
many IPC calls, how many subprocesses, how many React commits) are the
measurements that survive a contended machine, which is a good reason to prefer
them when building a harness that other agents will run.
