# Timeline UI harness — 2026-11-03T10-47-18-872Z

**6/6 pass** · 0 fail · 0 skip · 0 error · perf: 6/6 measured steps within budget

Input mode `auto` · control port 19798 · scratch project `/Users/ashishmaurya/Movies/Chroma/ui-harness-2026-11-03T10-47-18-872Z.chroma`

Budgets (D-434, `packages/ui-harness/src/budgets.ts`): frame 16.7 ms; p95 ≤ 33.3 ms; worst ≤ 50 ms (the move phase of a gesture; the release frame is held to the same 50 ms on its own); dropped ≤ 10%; input→frame p95 ≤ 50 ms; input→store ≤ 100 ms where checked; playback paint ≥ 24 fps, play loop ≥ 50 fps.

Notes:
- web bundle: production (React production build, no StrictMode). perf run: measured steps have no rect watch and run >= 1.5 s; live-feedback and cursor checks on them are skipped (use --evidence)
- deleted the scratch project /Users/ashishmaurya/Movies/Chroma/ui-harness-2026-11-03T10-47-18-872Z.chroma

| | scenario | area | checks | perf |
|---|---|---|---|---|
| PASS | [300 clips: Select-tool trim of a right edge](#perf-300-trim-select) | perf-300 | 1/1 | 1/1 |
| PASS | [300 clips: Ripple trim (every later clip on the track moves)](#perf-300-ripple-trim) | perf-300 | 2/2 | 1/1 |
| PASS | [300 clips: Roll of a cut](#perf-300-roll) | perf-300 | 2/2 | 1/1 |
| PASS | [300 clips: Slip of a clip](#perf-300-slip) | perf-300 | 2/2 | 1/1 |
| PASS | [300 clips: Slide of a clip between its neighbours](#perf-300-slide) | perf-300 | 2/2 | 1/1 |
| PASS | [300 clips: Drag a clip along its track](#perf-300-move-clip) | perf-300 | 0/0 | 1/1 |

## <a id="perf-300-trim-select"></a>PASS — 300 clips: Select-tool trim of a right edge

`perf-300-trim-select` · perf-300 · 4.8 s

Expected (reference): Snappy at scale (CLAUDE.md priority order; D-437 section 4 targets): the tools must feel the same on a 300-clip timeline as on three clips

- ✓ step 2: timeline.clips.t1c1.duration = 60 — expected lt 75

| measured step | verdict | numbers |
|---|---|---|
| trim t1c1's right edge 15 frames left | within budget | frames 115, moveFrames 106, moveP95Ms 18, moveMaxMs 35, releaseMaxMs 31, previews 8, previewP50Ms 2, previewP95Ms 3, commitRenderedMs 16, commitEffectsMs 17, commitFrameMs 29, commitPaintedMs 49, paintMs 20, frameP50Ms 17, frameP95Ms 23, frameMaxMs 35, dropped 4, inputToFrameP95Ms 18, firstCommitMs 1813, settleMs 4 |

## <a id="perf-300-ripple-trim"></a>PASS — 300 clips: Ripple trim (every later clip on the track moves)

`perf-300-ripple-trim` · perf-300 · 4.1 s

Expected (reference): Snappy at scale (CLAUDE.md priority order; D-437 section 4 targets): the tools must feel the same on a 300-clip timeline as on three clips

- ✓ step 9: reachable from the GUI: [data-testid="timeline-trim-tool"][data-chroma-trim-tool="ripple"][aria-pressed="true"]
- ✓ step 11: timeline.clips.t2c1.duration = 135 — expected lt 150

| measured step | verdict | numbers |
|---|---|---|
| ripple-trim t2c1's right edge 15 frames left | within budget | frames 113, moveFrames 105, moveP95Ms 23, moveMaxMs 38, releaseMaxMs 40, previews 11, previewP50Ms 2, previewP95Ms 5, commitRenderedMs 16, commitEffectsMs 18, commitFrameMs 33, commitPaintedMs 49, paintMs 16, frameP50Ms 17, frameP95Ms 25, frameMaxMs 40, dropped 6, inputToFrameP95Ms 28, firstCommitMs 1771, settleMs 4 |

## <a id="perf-300-roll"></a>PASS — 300 clips: Roll of a cut

`perf-300-roll` · perf-300 · 4.3 s

Expected (reference): Snappy at scale (CLAUDE.md priority order; D-437 section 4 targets): the tools must feel the same on a 300-clip timeline as on three clips

- ✓ step 2: reachable from the GUI: [data-testid="timeline-trim-tool"][data-chroma-trim-tool="roll"][aria-pressed="true"]
- ✓ step 4: timeline.clips.t3c1.duration = 45 — expected gt 30

| measured step | verdict | numbers |
|---|---|---|
| roll the t3c1\|t3c2 cut 15 frames right | within budget | frames 114, moveFrames 106, moveP95Ms 18, moveMaxMs 29, releaseMaxMs 37, previews 8, previewP50Ms 1, previewP95Ms 1, commitRenderedMs 13, commitEffectsMs 15, commitFrameMs 26, commitPaintedMs 41, paintMs 15, frameP50Ms 17, frameP95Ms 19, frameMaxMs 37, dropped 3, inputToFrameP95Ms 27, firstCommitMs 1791, settleMs 6 |

## <a id="perf-300-slip"></a>PASS — 300 clips: Slip of a clip

`perf-300-slip` · perf-300 · 3.9 s

Expected (reference): Snappy at scale (CLAUDE.md priority order; D-437 section 4 targets): the tools must feel the same on a 300-clip timeline as on three clips

- ✓ step 2: reachable from the GUI: [data-testid="timeline-trim-tool"][data-chroma-trim-tool="slip"][aria-pressed="true"]
- ✓ step 4: timeline.clips.t1c2.sourceStart = 45 — expected in [15,45]

| measured step | verdict | numbers |
|---|---|---|
| slip t1c2 by 15 frames | within budget | frames 115, moveFrames 107, moveP95Ms 18, moveMaxMs 24, releaseMaxMs 27, previews 15, previewP50Ms 1, previewP95Ms 2, commitRenderedMs 7, commitEffectsMs 8, commitFrameMs 19, commitPaintedMs 29, paintMs 10, frameP50Ms 17, frameP95Ms 20, frameMaxMs 27, dropped 2, inputToFrameP95Ms 21, firstCommitMs 1800, settleMs 3 |

## <a id="perf-300-slide"></a>PASS — 300 clips: Slide of a clip between its neighbours

`perf-300-slide` · perf-300 · 4.3 s

Expected (reference): Snappy at scale (CLAUDE.md priority order; D-437 section 4 targets): the tools must feel the same on a 300-clip timeline as on three clips

- ✓ step 3: reachable from the GUI: [data-testid="timeline-trim-tool"][data-chroma-trim-tool="slide"][aria-pressed="true"]
- ✓ step 5: timeline.clips.t2c2.startFrame = 255 — expected gt 240

| measured step | verdict | numbers |
|---|---|---|
| slide t2c2 15 frames right | within budget | frames 113, moveFrames 106, moveP95Ms 18, moveMaxMs 27, releaseMaxMs 42, previews 8, previewP50Ms 1, previewP95Ms 2, commitRenderedMs 16, commitEffectsMs 18, commitFrameMs 33, commitPaintedMs 56, paintMs 23, frameP50Ms 17, frameP95Ms 19, frameMaxMs 42, dropped 4, inputToFrameP95Ms 27, firstCommitMs 1790, settleMs 5 |

## <a id="perf-300-move-clip"></a>PASS — 300 clips: Drag a clip along its track

`perf-300-move-clip` · perf-300 · 4.3 s

Expected (reference): Snappy at scale (CLAUDE.md priority order; D-437 section 4 targets): the tools must feel the same on a 300-clip timeline as on three clips

| measured step | verdict | numbers |
|---|---|---|
| move t4c3 30 frames right | within budget | frames 113, moveFrames 105, moveP95Ms 19, moveMaxMs 36, releaseMaxMs 42, frameP50Ms 17, frameP95Ms 20, frameMaxMs 42, dropped 4, inputToFrameP95Ms 19, firstCommitMs 1790, settleMs 13 |
