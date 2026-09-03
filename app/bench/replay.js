// Deterministic UI perf benchmark — Edit-tab multi-track timeline.
// Paste into the browser devtools Console of a running Chroma build
// (right-click -> Inspect) and press Enter.
//
// Drives the same pan/dragover/clip-move interaction with fixed synthetic
// timing, repeated over several iterations (with a discarded warmup
// iteration) so results carry median/p95/stdev instead of a single noisy
// sample. Frame timing is attributed per interaction phase so you can tell
// *which* interaction regressed, not just that the run as a whole did.
//
// Measures its own frame timing via requestAnimationFrame + performance.now()
// -- standard web APIs, so this works the same under WebKitGTK (Linux),
// WKWebView (macOS), and WebView2 (Windows). It does NOT depend on any
// devtools-specific recording/export format.
//
// Output: a JSON blob printed between BENCH_RESULT_JSON_START/END markers,
// and copied to the clipboard if the console supports copy(). Save it to
// bench/out/<name>.json (gitignored) and diff two runs with analyze.mjs.
//
// Requirements: a project open on the Edit tab, with a timeline that has at
// least one clip on the first video track. Ideally 2+ tracks with several
// clips each -- the `dragover` phase (below) is a direct regression test for
// D-083 (a real freeze bug where cost scaled with track count), so more
// tracks give a stronger signal; one track/clip still runs, just measures a
// cheaper case.

(async function bench() {
  const ITERATIONS = 10;
  const WARMUP_ITERATIONS = 2;

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const dispatchMouse = (target, type, x, y, opts = {}) =>
    target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, ...opts }),
    );

  // `.timeline-editor-*` classes are @xzdarcy/react-timeline-editor's own
  // bundled CSS class names (see TimelinePane.tsx's doc comment) -- stable
  // across our own restyles since we don't own them, so used directly rather
  // than adding app-side data-bench-id hooks for library-rendered elements.
  // `[data-bench-id="timeline-edit-area"]` is the one app-owned hook (the
  // wrapper div around <TimelineEditor>, added alongside this script).
  const EDIT_AREA_SELECTOR = '[data-bench-id="timeline-edit-area"]';
  const ACTION_SELECTOR = '.timeline-editor-action';

  // --- continuous frame-timing capture -------------------------------------------
  // One rAF loop runs for the whole benchmark; phase attribution happens
  // afterwards by bucketing frame-to-frame durations against phase time
  // windows, so starting/stopping the loop per-phase (and the gaps that would
  // introduce) isn't a concern.
  let measuring = false;
  let rafHandle = null;
  const frameTimestamps = [];

  function frameTick(ts) {
    if (!measuring) return;
    frameTimestamps.push(ts);
    rafHandle = requestAnimationFrame(frameTick);
  }

  function startMeasuring() {
    measuring = true;
    rafHandle = requestAnimationFrame(frameTick);
  }

  function stopMeasuring() {
    measuring = false;
    if (rafHandle !== null) cancelAnimationFrame(rafHandle);
  }

  const DROPPED_THRESHOLD_MS = 1000 / 60 + 2; // small tolerance over one vsync

  function durationsInWindow(startTs, endTs) {
    const out = [];
    for (let i = 1; i < frameTimestamps.length; i++) {
      const ts = frameTimestamps[i];
      if (ts > startTs && ts <= endTs) out.push(ts - frameTimestamps[i - 1]);
    }
    return out;
  }

  function summarizeWindow(startTs, endTs) {
    const durations = durationsInWindow(startTs, endTs);
    const dropped = durations.filter((d) => d > DROPPED_THRESHOLD_MS);
    const totalMs = durations.reduce((a, b) => a + b, 0);
    return {
      durationMs: endTs - startTs,
      frameCount: durations.length,
      avgFps: durations.length ? 1000 / (totalMs / durations.length) : 0,
      worstFrameMs: durations.length ? Math.max(...durations) : 0,
      droppedFrameCount: dropped.length,
      droppedFrameTimeMs: dropped.reduce((a, b) => a + b, 0),
    };
  }

  // --- interaction steps -----------------------------------------------------

  // `pan`: plain (non-ctrl) wheel events over the timeline -- per D-072,
  // `TimelinePane.tsx`'s own wheel handler only intercepts (zooms) on
  // `ctrlKey: true`, so a plain wheel tick falls through to the library's
  // native horizontal scroll. Analogous to the old library-view `scroll`
  // phase: a sustained, cheap, very-frequent-event interaction.
  async function panTimeline() {
    const area = document.querySelector(EDIT_AREA_SELECTOR);
    if (!area) throw new Error(`bench: timeline edit area not found (${EDIT_AREA_SELECTOR})`);
    const rect = area.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const start = performance.now();
    const steps = 30;
    for (let i = 0; i < steps; i++) {
      area.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY: 40, deltaX: 0, ctrlKey: false }),
      );
      await wait(16);
    }
    return { start, end: performance.now() };
  }

  // `dragover`: sustained native `dragover` ticks over the timeline, with no
  // corresponding `drop` -- simulating a Sources-panel drag held in progress
  // over a multi-track timeline. This is the EXACT scenario D-083 (a real,
  // live-reported freeze bug: every native dragover tick forced a full
  // re-render, cost scaling with track count) fixed -- the single highest-
  // value phase in this rewrite, a direct regression test for that fix and
  // for whether the React Compiler (D-091) measurably helps this class of
  // interaction. A real Sources-panel drag also carries a
  // `application/x-chroma-media` DataTransfer type
  // (`CHROMA_MEDIA_DRAG_MIME`, `timeline.ts`) that a synthetic `DragEvent`
  // built in a console context can't fully replicate (DataTransfer
  // construction is restricted outside a trusted user gesture in most
  // engines) -- this still exercises the real `onDragOver` handler and its
  // downstream re-render cost, just without a real payload triggering the
  // `add_clip` branch on drop, which is fine: this phase measures sustained
  // per-tick cost, not the drop itself.
  async function dragOverTimeline() {
    const area = document.querySelector(EDIT_AREA_SELECTOR);
    if (!area) throw new Error(`bench: timeline edit area not found (${EDIT_AREA_SELECTOR})`);
    const rect = area.getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    const start = performance.now();
    // ~60 ticks over ~1s -- real browsers fire dragover at a similar
    // cadence (roughly display refresh rate) while a drag is held over an
    // element.
    const steps = 60;
    for (let i = 0; i < steps; i++) {
      const x = rect.left + (rect.width * (i % steps)) / steps;
      const evt = new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: y });
      area.dispatchEvent(evt);
      await wait(16);
    }
    return { start, end: performance.now() };
  }

  // `move`: select an existing clip, drag its body to a new horizontal
  // position (`onActionMoveEnd` -> the `move` EditOp), then drag it back so
  // the next iteration starts from the same layout. Analogous to the old
  // `edit` phase (dragging two adjustment sliders) -- a real, sustained,
  // library-owned drag interaction, not just a synthetic event storm.
  async function moveClip() {
    const action = document.querySelector(ACTION_SELECTOR);
    if (!action) throw new Error(`bench: no timeline clip/action found (${ACTION_SELECTOR})`);
    const rect = action.getBoundingClientRect();
    const startX = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const deltaPx = 60;

    const start = performance.now();
    const drag = async (totalDeltaPx) => {
      dispatchMouse(action, 'mousedown', startX, y);
      await wait(16);
      const steps = 20;
      for (let i = 1; i <= steps; i++) {
        const x = startX + (totalDeltaPx * i) / steps;
        dispatchMouse(window, 'mousemove', x, y);
        await wait(16);
      }
      dispatchMouse(window, 'mouseup', startX + totalDeltaPx, y);
      await wait(150);
    };
    await drag(deltaPx);
    await drag(-deltaPx); // drag back -- keeps layout stable across iterations
    return { start, end: performance.now() };
  }

  // --- stats -------------------------------------------------------------------
  function median(values) {
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function p95(values) {
    const s = [...values].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
  }

  function stdev(values) {
    if (values.length < 2) return 0;
    const m = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length;
    return Math.sqrt(variance);
  }

  function statOf(values) {
    return { median: median(values), p95: p95(values), stdev: stdev(values) };
  }

  function summarizePhaseAcrossIterations(measuredIterations, phaseName) {
    const metrics = ['durationMs', 'avgFps', 'worstFrameMs', 'droppedFrameCount', 'droppedFrameTimeMs'];
    const out = {};
    for (const metric of metrics) {
      out[metric] = statOf(measuredIterations.map((it) => it.phases[phaseName][metric]));
    }
    return out;
  }

  // --- run ---------------------------------------------------------------------
  const iterations = [];
  try {
    startMeasuring();
    for (let i = 0; i < ITERATIONS; i++) {
      const warmup = i < WARMUP_ITERATIONS;
      const panWindow = await panTimeline();
      await wait(200);
      const dragoverWindow = await dragOverTimeline();
      await wait(200);
      const moveWindow = await moveClip();
      await wait(200);

      iterations.push({
        index: i,
        warmup,
        phases: {
          pan: summarizeWindow(panWindow.start, panWindow.end),
          dragover: summarizeWindow(dragoverWindow.start, dragoverWindow.end),
          move: summarizeWindow(moveWindow.start, moveWindow.end),
        },
      });
    }
    stopMeasuring();
  } catch (err) {
    stopMeasuring();
    console.error('bench: failed —', err.message);
    return;
  }

  const measuredIterations = iterations.filter((it) => !it.warmup);
  const summary = {
    pan: summarizePhaseAcrossIterations(measuredIterations, 'pan'),
    dragover: summarizePhaseAcrossIterations(measuredIterations, 'dragover'),
    move: summarizePhaseAcrossIterations(measuredIterations, 'move'),
  };

  const result = {
    userAgent: navigator.userAgent,
    recordedAt: new Date().toISOString(),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
    config: { iterations: ITERATIONS, warmupIterations: WARMUP_ITERATIONS },
    iterations,
    summary,
  };

  const json = JSON.stringify(result, null, 2);
  console.log('BENCH_RESULT_JSON_START');
  console.log(json);
  console.log('BENCH_RESULT_JSON_END');
  try {
    copy(json);
    console.log('bench: result copied to clipboard. Paste into bench/out/<name>.json');
  } catch {
    console.log('bench: clipboard copy() unavailable in this console, copy the JSON above manually');
  }
})();
