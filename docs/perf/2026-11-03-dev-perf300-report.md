# Timeline UI harness — 2026-11-03T09-03-54-926Z

**12/12 pass** · 0 fail · 0 skip · 0 error · perf: 5/12 measured steps within budget

Input mode `auto` · control port 19788 · scratch project `/Users/ashishmaurya/Movies/Chroma/ui-harness-2026-11-03T09-03-54-926Z.chroma`

Budgets (D-434, `packages/ui-harness/src/budgets.ts`): frame 16.7 ms; p95 ≤ 33.3 ms; worst ≤ 50 ms (the move phase of a gesture; the release frame is held to the same 50 ms on its own); dropped ≤ 10%; input→frame p95 ≤ 50 ms; input→store ≤ 100 ms where checked; playback paint ≥ 24 fps, play loop ≥ 50 fps.

Notes:
- web bundle: DEVELOPMENT (React dev build with Performance Tracks and StrictMode double render); the release phase is inflated (estimated 0.5-0.7x in production, not yet measured). For shipping numbers run against `tauri build --debug` (docs/notes/ui-harness.md "Baseline recipe"). perf run: measured steps have no rect watch and run >= 1.5 s; live-feedback and cursor checks on them are skipped (use --evidence)
- deleted the scratch project /Users/ashishmaurya/Movies/Chroma/ui-harness-2026-11-03T09-03-54-926Z.chroma

| | scenario | area | checks | perf |
|---|---|---|---|---|
| PASS | [300 clips: Select-tool trim of a right edge](#perf-300-trim-select) | perf-300 | 1/1 | 0/1 |
| PASS | [300 clips: Ripple trim (every later clip on the track moves)](#perf-300-ripple-trim) | perf-300 | 2/2 | 0/1 |
| PASS | [300 clips: Roll of a cut](#perf-300-roll) | perf-300 | 2/2 | 0/1 |
| PASS | [300 clips: Slip of a clip](#perf-300-slip) | perf-300 | 2/2 | 1/1 |
| PASS | [300 clips: Slide of a clip between its neighbours](#perf-300-slide) | perf-300 | 2/2 | 0/1 |
| PASS | [300 clips: Drag a clip along its track](#perf-300-move-clip) | perf-300 | 0/0 | 1/1 |
| PASS | [300 clips: Trackpad pinch zooms in](#perf-300-zoom-pinch-in) | perf-300 | 1/1 | 0/1 |
| PASS | [300 clips: Trackpad pinch zooms out (more clips on screen)](#perf-300-zoom-pinch-out) | perf-300 | 1/1 | 0/1 |
| PASS | [300 clips: Ctrl+wheel zooms around the cursor](#perf-300-zoom-ctrl-wheel) | perf-300 | 1/1 | 0/1 |
| PASS | [300 clips: Horizontal two-finger scroll](#perf-300-scroll-horizontal) | perf-300 | 1/1 | 1/1 |
| PASS | [300 clips: Vertical scroll across the tracks](#perf-300-scroll-vertical) | perf-300 | 0/0 | 1/1 |
| PASS | [300 clips: Playback holds the frame rate](#perf-300-playback) | perf-300 | 1/1 | 1/1 |

## <a id="perf-300-trim-select"></a>PASS — 300 clips: Select-tool trim of a right edge

`perf-300-trim-select` · perf-300 · 5.5 s

Expected (reference): Snappy at scale (CLAUDE.md priority order; D-437 section 4 targets): the tools must feel the same on a 300-clip timeline as on three clips

- ✓ step 2: timeline.clips.t1c1.duration = 60 — expected lt 75

| measured step | verdict | numbers |
|---|---|---|
| trim t1c1's right edge 15 frames left | OVER: release frame 102 ms > 50 ms | frames 115, moveFrames 107, moveP95Ms 19, moveMaxMs 25, releaseMaxMs 102, previews 8, previewP50Ms 1, previewP95Ms 2, commitRenderedMs 45, commitEffectsMs 48, commitFrameMs 87, commitPaintedMs 92, paintMs 5, frameP50Ms 17, frameP95Ms 22, frameMaxMs 102, dropped 8, inputToFrameP95Ms 27, firstCommitMs 1818, settleMs 57 |

## <a id="perf-300-ripple-trim"></a>PASS — 300 clips: Ripple trim (every later clip on the track moves)

`perf-300-ripple-trim` · perf-300 · 5.3 s

Expected (reference): Snappy at scale (CLAUDE.md priority order; D-437 section 4 targets): the tools must feel the same on a 300-clip timeline as on three clips

- ✓ step 9: reachable from the GUI: [data-testid="timeline-trim-tool"][data-chroma-trim-tool="ripple"][aria-pressed="true"]
- ✓ step 11: timeline.clips.t2c1.duration = 135 — expected lt 150

| measured step | verdict | numbers |
|---|---|---|
| ripple-trim t2c1's right edge 15 frames left | OVER: worst frame 151 ms > 50 ms; 15 dropped of 104 frames (14% > 10%); release frame 67 ms > 50 ms | frames 109, moveFrames 104, moveP95Ms 30, moveMaxMs 151, releaseMaxMs 67, previews 11, previewP50Ms 2, previewP95Ms 4, commitRenderedMs 18, commitEffectsMs 20, commitFrameMs 55, commitPaintedMs 65, paintMs 10, frameP50Ms 17, frameP95Ms 33, frameMaxMs 151, dropped 21, inputToFrameP95Ms 47, firstCommitMs 1948, settleMs 26 |

## <a id="perf-300-roll"></a>PASS — 300 clips: Roll of a cut

`perf-300-roll` · perf-300 · 5.2 s

Expected (reference): Snappy at scale (CLAUDE.md priority order; D-437 section 4 targets): the tools must feel the same on a 300-clip timeline as on three clips

- ✓ step 2: reachable from the GUI: [data-testid="timeline-trim-tool"][data-chroma-trim-tool="roll"][aria-pressed="true"]
- ✓ step 4: timeline.clips.t3c1.duration = 45 — expected gt 30

| measured step | verdict | numbers |
|---|---|---|
| roll the t3c1\|t3c2 cut 15 frames right | OVER: release frame 63 ms > 50 ms | frames 111, moveFrames 104, moveP95Ms 25, moveMaxMs 45, releaseMaxMs 63, previews 8, previewP50Ms 1, previewP95Ms 2, commitRenderedMs 20, commitEffectsMs 22, commitFrameMs 58, commitPaintedMs 63, paintMs 5, frameP50Ms 17, frameP95Ms 25, frameMaxMs 63, dropped 10, inputToFrameP95Ms 22, firstCommitMs 1776, settleMs 30 |

## <a id="perf-300-slip"></a>PASS — 300 clips: Slip of a clip

`perf-300-slip` · perf-300 · 6.3 s

Expected (reference): Snappy at scale (CLAUDE.md priority order; D-437 section 4 targets): the tools must feel the same on a 300-clip timeline as on three clips

- ✓ step 2: reachable from the GUI: [data-testid="timeline-trim-tool"][data-chroma-trim-tool="slip"][aria-pressed="true"]
- ✓ step 4: timeline.clips.t1c2.sourceStart = 45 — expected in [15,45]

| measured step | verdict | numbers |
|---|---|---|
| slip t1c2 by 15 frames | within budget | frames 113, moveFrames 106, moveP95Ms 20, moveMaxMs 39, releaseMaxMs 49, previews 15, previewP50Ms 1, previewP95Ms 2, commitRenderedMs 14, commitEffectsMs 15, commitFrameMs 44, commitPaintedMs 48, paintMs 4, frameP50Ms 17, frameP95Ms 25, frameMaxMs 49, dropped 7, inputToFrameP95Ms 22, firstCommitMs 1786, settleMs 20 |

## <a id="perf-300-slide"></a>PASS — 300 clips: Slide of a clip between its neighbours

`perf-300-slide` · perf-300 · 5.0 s

Expected (reference): Snappy at scale (CLAUDE.md priority order; D-437 section 4 targets): the tools must feel the same on a 300-clip timeline as on three clips

- ✓ step 3: reachable from the GUI: [data-testid="timeline-trim-tool"][data-chroma-trim-tool="slide"][aria-pressed="true"]
- ✓ step 5: timeline.clips.t2c2.startFrame = 255 — expected gt 240

| measured step | verdict | numbers |
|---|---|---|
| slide t2c2 15 frames right | OVER: release frame 84 ms > 50 ms | frames 110, moveFrames 103, moveP95Ms 20, moveMaxMs 42, releaseMaxMs 84, previews 8, previewP50Ms 1, previewP95Ms 2, commitRenderedMs 28, commitEffectsMs 32, commitFrameMs 68, commitPaintedMs 73, paintMs 5, frameP50Ms 17, frameP95Ms 25, frameMaxMs 84, dropped 11, inputToFrameP95Ms 21, firstCommitMs 1801, settleMs 39 |

## <a id="perf-300-move-clip"></a>PASS — 300 clips: Drag a clip along its track

`perf-300-move-clip` · perf-300 · 4.7 s

Expected (reference): Snappy at scale (CLAUDE.md priority order; D-437 section 4 targets): the tools must feel the same on a 300-clip timeline as on three clips

| measured step | verdict | numbers |
|---|---|---|
| move t4c3 30 frames right | within budget | frames 114, moveFrames 106, moveP95Ms 18, moveMaxMs 37, releaseMaxMs 44, frameP50Ms 17, frameP95Ms 19, frameMaxMs 44, dropped 5, inputToFrameP95Ms 18, firstCommitMs 1808, settleMs 8 |

## <a id="perf-300-zoom-pinch-in"></a>PASS — 300 clips: Trackpad pinch zooms in

`perf-300-zoom-pinch-in` · perf-300 · 3.2 s

Expected (reference): Snappy at scale (CLAUDE.md priority order; D-437 section 4 targets): the tools must feel the same on a 300-clip timeline as on three clips

- ✓ step 3: view.pxPerSec = 386.9835263999999 — expected gt 90

| measured step | verdict | numbers |
|---|---|---|
| debug_pointer pinch | OVER: frame p95 66 ms > 33.3 ms; worst frame 66 ms > 50 ms; 12 dropped of 11 frames (109% > 10%) | frames 11, frameP50Ms 17, frameP95Ms 66, frameMaxMs 66, dropped 12, inputToFrameP95Ms 24 |

## <a id="perf-300-zoom-pinch-out"></a>PASS — 300 clips: Trackpad pinch zooms out (more clips on screen)

`perf-300-zoom-pinch-out` · perf-300 · 3.2 s

Expected (reference): Snappy at scale (CLAUDE.md priority order; D-437 section 4 targets): the tools must feel the same on a 300-clip timeline as on three clips

- ✓ step 3: view.pxPerSec = 20.931123542524016 — expected lt 90

| measured step | verdict | numbers |
|---|---|---|
| debug_pointer pinch | OVER: frame p95 109 ms > 33.3 ms; worst frame 109 ms > 50 ms; 18 dropped of 6 frames (300% > 10%) | frames 6, frameP50Ms 57, frameP95Ms 109, frameMaxMs 109, dropped 18, inputToFrameP95Ms 32 |

## <a id="perf-300-zoom-ctrl-wheel"></a>PASS — 300 clips: Ctrl+wheel zooms around the cursor

`perf-300-zoom-ctrl-wheel` · perf-300 · 3.4 s

Expected (reference): Snappy at scale (CLAUDE.md priority order; D-437 section 4 targets): the tools must feel the same on a 300-clip timeline as on three clips

- ✓ step 3: view.pxPerSec = 155.51999999999998 — expected gt 90

| measured step | verdict | numbers |
|---|---|---|
| debug_pointer wheel | OVER: frame p95 52 ms > 33.3 ms; worst frame 52 ms > 50 ms; 5 dropped of 8 frames (63% > 10%) | frames 8, frameP50Ms 17, frameP95Ms 52, frameMaxMs 52, dropped 5, inputToFrameP95Ms 18 |

## <a id="perf-300-scroll-horizontal"></a>PASS — 300 clips: Horizontal two-finger scroll

`perf-300-scroll-horizontal` · perf-300 · 3.6 s

Expected (reference): Snappy at scale (CLAUDE.md priority order; D-437 section 4 targets): the tools must feel the same on a 300-clip timeline as on three clips

- ✓ step 3: view.scrollLeft = 600 — expected gt 0

| measured step | verdict | numbers |
|---|---|---|
| debug_pointer wheel | within budget | frames 12, frameP50Ms 17, frameP95Ms 17, frameMaxMs 17, dropped 0, inputToFrameP95Ms 19 |

## <a id="perf-300-scroll-vertical"></a>PASS — 300 clips: Vertical scroll across the tracks

`perf-300-scroll-vertical` · perf-300 · 3.6 s

Expected (reference): Snappy at scale (CLAUDE.md priority order; D-437 section 4 targets): the tools must feel the same on a 300-clip timeline as on three clips

| measured step | verdict | numbers |
|---|---|---|
| debug_pointer wheel | within budget | frames 12, frameP50Ms 17, frameP95Ms 17, frameMaxMs 17, dropped 0, inputToFrameP95Ms 18 |

## <a id="perf-300-playback"></a>PASS — 300 clips: Playback holds the frame rate

`perf-300-playback` · perf-300 · 5.7 s

Expected (reference): Snappy at scale (CLAUDE.md priority order; D-437 section 4 targets): the tools must feel the same on a 300-clip timeline as on three clips

- ✓ step 1: playback ran: 181 play-loop ticks, 81 paints in 3s

| measured step | verdict | numbers |
|---|---|---|
| playback 3s | within budget | paintFps 27.21, rafFps 60.12, paintSamples 81, rafSamples 181 |
