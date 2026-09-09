# UI Performance Benchmark

Deterministic replay for comparing UI smoothness before/after a change.

Currently targets the **Edit tab's multi-track timeline** (`TimelinePane.tsx`). The
original version of this harness targeted RapidRAW's library grid/editor-slider flow,
which was removed when the DAM shell was stripped out (D-043) — see git history if you
need that version back for some reason.

## Usage

1. Run the build you want to measure (`npm start`, or a packaged build), open a project,
   and get to the Edit tab with a timeline that has at least one clip on the first video
   track. Ideally use a timeline with 2+ tracks and several clips each — the `dragover`
   phase is a direct regression test for D-083 (a freeze bug whose cost scaled with track
   count), so more tracks give a stronger signal.
2. Open devtools (right-click → Inspect) and switch to the Console tab.
3. Paste the contents of `bench/replay.js` and press Enter.
4. It repeats a pan → dragover-stress → move-clip cycle 10 times (2 discarded warmup + 8
   measured), then prints a JSON result between `BENCH_RESULT_JSON_START`/`END` markers
   (and copies it to your clipboard if the console supports `copy()`).
5. Save the result as `bench/out/<name>.json` (gitignored, doesn't need to be committed).
6. Compare two runs:
   ```
   node bench/analyze.mjs bench/out/before.json bench/out/after.json
   ```

### The three phases

- **`pan`** — sustained plain (non-ctrl) wheel events over the timeline. Per D-072,
  `TimelinePane.tsx`'s wheel handler only intercepts on `ctrlKey: true` (zoom); a plain
  wheel tick falls through to the library's native horizontal scroll. Cheap,
  high-frequency-event baseline, analogous to the old library-grid `scroll` phase.
- **`dragover`** — sustained native `dragover` ticks held over the timeline with no
  `drop`, simulating a Sources-panel drag in progress. This is a direct regression test
  for **D-083**, a real live-reported freeze where every native `dragover` tick forced a
  full re-render (including every track's waveform canvas), with cost scaling with track
  count. The single highest-value phase here — it's exactly the interaction class the
  React Compiler (D-091) was enabled to help with. Note: a real Sources-panel drag also
  carries an `application/x-apelles-media` DataTransfer payload
  (`CHROMA_MEDIA_DRAG_MIME`); a synthetic `DragEvent` built from a console context can't
  fully replicate that (DataTransfer construction is gated behind a trusted user gesture
  in most engines), so this phase exercises the real `onDragOver` re-render cost but
  won't trigger an actual drop/`add_clip`. That's fine — it's measuring sustained
  per-tick cost, not the drop itself.
- **`move`** — select an existing clip and drag it to a new horizontal position
  (`onActionMoveEnd` → the `move` EditOp), then drag it back so the next iteration starts
  from the same layout. A real, sustained, library-owned drag interaction — analogous to
  the old `edit` phase's slider drags.

## Why it's built this way

- **Self-measuring, not devtools-export-dependent.** `replay.js` times itself with
  `requestAnimationFrame`/`performance.now()` (standard web APIs) rather than relying on
  a devtools Timeline recording. Tauri uses a different webview per OS — WebKitGTK on
  Linux, WKWebView on macOS, WebView2 (Chromium) on Windows — and each one's devtools
  Timeline/Performance export uses a different JSON format. Self-measurement sidesteps
  that entirely, so the same script and analyzer work on all three platforms.
- **Fixed synthetic input.** All interaction timing is scripted (`setTimeout` steps at a
  fixed cadence, fixed pixel deltas), so two runs get identical input instead of
  whatever pacing a human happened to use. Don't hand-drive the interaction and try to
  compare the numbers to a scripted run — only compare scripted run to scripted run.
- **Repeated iterations, not a single sample.** One run of the interaction can't tell you
  whether a difference between "before" and "after" is real or just jitter. `replay.js`
  repeats the full cycle several times (first one discarded as warmup) and
  `analyze.mjs` reports median/p95/stdev per metric so you can judge whether a change
  is bigger than the run-to-run noise.
- **Per-phase frame attribution.** Frame timing is bucketed into the `pan`, `dragover`,
  and `move` windows separately (not just one number for the whole run), so a result
  points at *which* interaction got slower instead of just "the run as a whole".

## Known limitations

- Numbers are only comparable **on the same machine** (same window size, same display
  scaling). A slider's pixel-delta → value-delta depends on its on-screen width, so
  results aren't meaningful across different maintainers' machines — only before/after
  on one machine. `replay.js` records `viewport` (width/height/devicePixelRatio) in its
  output, and `analyze.mjs` prints a warning if you diff two runs whose viewports don't
  match.
- The timeline container uses the one app-owned hook,
  `[data-bench-id="timeline-edit-area"]` (the wrapper div around `<TimelineEditor>` in
  `packages/editor/src/TimelinePane.tsx`). The clip/action element uses
  `.timeline-editor-action`, a class owned by the `@xzdarcy/react-timeline-editor`
  library itself (not app CSS) — stable across our own restyles since we don't control
  it, so it's used directly rather than adding a redundant `data-bench-id`. If you add
  new interaction steps against app-owned elements, prefer a `data-bench-id` hook over
  relying on utility classes, which shift on any restyle.
- This is a general smoothness/regression check, not a profiler. It won't tell you
  *why* something is slow — use devtools Timeline/Performance recording by hand for
  root-causing, and this script for confirming a fix actually helped.
- Still requires a manual paste-and-save per run (devtools console access, `copy()` to
  clipboard, write `bench/out/<name>.json` by hand). There's no CI/headless runner —
  Tauri's WebDriver story (`tauri-driver`) doesn't cover macOS and would trade away the
  cross-platform self-measurement approach above for a Linux/Windows-only automation
  path. If you need unattended/CI runs, that trade-off is worth revisiting, but it's out
  of scope for this same-machine before/after tool.
