# Timeline drag performance: measurements, causes, fix plan (B-347)

Status: **measured 2026-11-01 against the live debug app, after D-432 P2.** No code
changed in this pass. The fixes below are proposals with expected gains; each one is
measured again with the same driver before it counts as done.

Question asked: after P2's own gesture engine (`useEditGesture.ts`: `previewEdit` runs
`applyOp` on a copy, `transform`s on the moving clips, a `width` on a trimmed clip, one pane
render at release), the second harness run still showed median frames of 16–17 ms but p95
29–36 ms, worst frames 49–85 ms and 12–33 % dropped
(`scratch/ui-harness/runs/2026-10-31T18-56-56-222Z/`). Why?

**Short answer.** The misses come from two different places:

1. **The release.** Every commit re-renders every clip on the timeline. The library has no
   memoisation, and `applyOp` deep-clones the timeline, so no clip keeps its identity. That
   is followed by a style recalc, a layout and a repaint of all clips. It scales with the
   clip count: 60–95 ms at 3–50 clips, **180–340 ms at 200 clips**. The owner's real
   timeline ("Voiceover v2") has **288 clips** on 8 tracks.
2. **The move phase.** Each preview writes `width` / `transform` and then reads the
   readout's `offsetWidth`. That read forces a synchronous layout, and the layout is broad,
   not one clip: it reaches the scroll container's overflow, flex boxes and scrollbars.
   Forced layout is **57–78 % of the main thread's busy time while a ripple / trim moves**,
   about 8 ms per preview at both 10 and 200 clips. Ripple and slide also restyle and
   re-layer every downstream clip (`translate3d` on ~200 clips), so their move phase grows
   with the clip count too.

Cloning the timeline per snapped frame is **not** a cost (≤ 1 % of busy time). Waveform,
filmstrip and image decode are not costs either (≤ 0.6 %), and the viewer does not update
during an edit gesture at all.

The harness's own method inflates p95 and dropped frames. Its rect watch forces one layout
per frame, and with ~40 frames per 450 ms gesture, p95 is just the second-worst frame. The
dev build adds React 19.2's dev-only Performance Tracks (~22 % of release time at 200 clips)
and StrictMode's double render.

## How it was measured

- **Driver:** a scratchpad script (not repo code) that imports the harness
  (`openScratchProject`, `buildFixture`, `resolveTargetRef`) and calls `debug_pointer` with
  `measure: true`, writing every raw reply to JSON lines. It ran in the usual throwaway
  `ui-harness-*.chroma` project, which was deleted afterwards. Fixture: N butted 30-frame
  clips on V1 (`c0…cN-1`), an empty V2. The target is `c1`, which is on screen at the default
  90 px/s. Each gesture ran 3–5 times, with Cmd+Z after each. Gestures: `trim` / `ripple`
  (`c1`'s right edge −30 px in 15 moves over 450 ms, the harness's own shape), `slide`
  (+30 px), `move` (one row down, dnd-kit), `hover` (a buttonless sweep over the clips) and
  `idle` (moves over the title bar: the floor).
- **Phases:** per-frame timestamps come from the `watch` sampler; the `pointerdown` /
  `pointerup` times come from `observed.events`. Frames are split into press (first
  ~70 ms), move (up to the `pointerup` frame), and release (after it).
- **Profiles:** macOS `sample` on the app's `com.apple.WebKit.WebContent` process (1 ms
  interval). Main-thread samples were bucketed by WebKit entry point (style recalc
  `Document::resolveStyle`, layout `LocalFrameView::layout`, forced layout from JS
  `jsHTMLElement_offsetWidth` / `getBoundingClientRect`, paint and layer flush, GC, event
  dispatch, microtasks, `PerformanceUserTiming::measure`). JS frames are not symbolicated,
  but the native callers are. The move phase was isolated with 6 s drags (200 moves, sampler
  started 1.5 s in). The release was isolated with 14 short gestures (3 moves / 60 ms each)
  under one 10 s sample. The sampler stalls the process, so profiles are used for
  **proportions only**, never for frame numbers.
- **Controls:** with and without the rect watch; occlusion throttling on and off; app
  frontmost and app behind the browser; a 120 Hz input rate (120 moves / 1 s).
- WebKit's Web Inspector timeline could not be driven from the CLI against the WKWebView,
  and no debug op reads `performance` entries. Instrumentation that would give exact
  per-phase numbers is spelled out under "Instrument next".

## Measurements

### Frame stats per gesture × clip count (ms; rect watch ON, as the harness runs; 3 runs each)

| clips | gesture | p95 per run | worst per run | dropped % per run | move phase p95 / max | release phase p95 / max |
|---|---|---|---|---|---|---|
| 3 | idle | 22/27/19 | 60/48/56 | 8/8/5 | 19 / 60 | — |
| 3 | hover | 34/30/35 | 42/32/42 | 19/15/20 | 32 / 42 | — |
| 3 | trim | 71/55/38 | 95/79/60 | 50/34/30 | 41 / 71 | 79 / 95 |
| 3 | ripple | 56/56/39 | 65/67/58 | 28/26/22 | 39 / 65 | 43 / 67 |
| 3 | slide | 32/36/40 | 60/41/61 | 17/17/20 | 32 / 61 | 47 / 50 |
| 3 | move | 18/26/26 | 59/57/70 | 10/12/12 | 18 / 57 | 59 / 70 |
| 10 | trim | 63/35/36 | 94/75/61 | 41/26/26 | 35 / 63 | 75 / 94 |
| 10 | ripple | 61/59/39 | 71/68/69 | 35/36/26 | 48 / 61 | 68 / 71 |
| 10 | slide | 44/40/47 | 69/50/55 | 21/15/19 | 39 / 69 | 44 / 47 |
| 10 | move | 19/21/19 | 58/64/83 | 9/15/14 | 18 / 62 | 64 / 83 |
| 50 | trim | 27/26/30 | 70/72/93 | 12/14/19 | 27 / 35 | 72 / 93 |
| 50 | ripple | 47/59/28 | 93/73/71 | 32/33/19 | 42 / 59 | 71 / 93 |
| 50 | slide | 67/36/56 | 76/75/97 | 24/20/35 | 48 / 67 | 75 / 97 |
| 50 | move | 22/24/52 | 72/92/103 | 12/17/18 | 18 / 55 | 92 / 103 |
| 200 | idle | 53/34/36 | 59/55/55 | 17/9/9 | 34 / 59 | — |
| 200 | trim | 58/54/31 | **275/196/190** | 59/39/40 | 41 / 58 | **196 / 275** |
| 200 | ripple | 81/78/80 | **260/260/249** | 94/71/67 | **66 / 81** | **249 / 260** |
| 200 | slide | 94/97/83 | **188/192/178** | 49/51/54 | 45 / 97 | **178 / 192** |
| 200 | move | 19/88/57 | **265/337/264** | 44/72/44 | 21 / 88 | **265 / 337** |

Medians were 16–17 ms in every row. A further 8 ripples at 200 clips (watch off) had worst
frames of 281–434 ms.

### Controls

| control | result |
|---|---|
| rect watch OFF (10 clips, 4 runs) | trim p95 31/28/34/23 (watch on: 63/35/36), ripple 38/32/36/72 (61/59/39), hover 29/30/28/29 (34/33/36). Worst frames are unchanged (release-driven). **The watch adds ~5–25 ms to p95**: each frame's `getBoundingClientRect` forces the layout the preview dirtied |
| occlusion throttling enabled vs disabled, app frontmost (10 clips, ripple ×5) | p95 29–40 vs 32–47, worst 52–73 vs 51–72: **no difference** |
| app behind the browser, throttling off | p95 31–39, worst 43–65: **no difference** |
| 120 Hz input (120 moves / 1 s, +90 px) | 10 clips: trim move p95 18, ripple move p95 29; 200 clips: ripple move p95 33, release 265–334. The release dominates whatever the input rate |

### Where the main thread goes (`sample`, % of busy main-thread time)

| phase | clips | busy / window | forced layout from JS | layout (all) | style recalc | paint + layer flush | React dev perf tracks | GC |
|---|---|---|---|---|---|---|---|---|
| ripple, move only | 10 | 1360 / 3327 ms | **78.7 %** (`offsetWidth` reads) | 77.9 % | 2.4 % | 9.6 % | 0 % | 0 % |
| ripple, move only | 200 | 1370 / 3415 ms | **62.7 %** | 56.7 % | **13.1 %** | **13.4 %** | 0 % | 3.0 % |
| slide, move only | 10 / 200 | 356 / 443 ms | 36.8 / 34.3 % | 27.0 / 26.6 % | 9.8 / 9.3 % | 14.6 / 10.2 % | 0 % | 0 / 7.9 % |
| move (dnd-kit), move only | 200 | 408 / 3435 ms | 0 % | 0 % | 7.6 % | 8.1 % | 0 % | 0 % |
| hover sweep | 10 / 200 | 375 / 531 ms | 54 / 33 % | 53 / 32 % | 2.7 / 2.3 % | 12 / 12 % | 0 % | 0 % |
| 14 short ripples + undos (release-dominated) | 10 | 2444 / 8561 ms | 13.7 % | **42.5 %** | 15.0 % | **31.5 %** | 1.2 % | 4.8 % |
| 14 short ripples + undos (release-dominated) | 200 | 5857 / 8497 ms | 7.0 % | 13.4 % | **23.2 %** | 18.0 % | **22.2 %** | 6.1 % |

At 200 clips, React's own work (event-handler microtasks 46 % plus scheduler
`MessageChannel` tasks 18 %, overlapping the rows above) is most of the release. Of the
release window, 21.8 % is `structuredClone` called from `PerformanceUserTiming::measure`:
React 19.2.8's **development** build logs every component render with a props diff as a
`performance.measure` detail. The production build has none of this
(`react-dom-client.production.js` has no `performance.measure`), and `app/src/main.tsx`
wraps the app in `React.StrictMode`, which renders twice in dev.

`structuredClone` called from our code (`WindowOrWorkerGlobalScope::structuredClone`, i.e.
`previewEdit`'s timeline copy) took 4–17 samples per window: **≤ 1 %**. Image decode took
≤ 0.6 % and canvas 2D ≤ 0.1 %.

## Ranked causes

1. **The release commit re-renders and re-lays-out every clip.** On release, `finish()`
   calls `applyOp` (store), then `selectClip`, then the history push (5 store commits per
   gesture, `perf.store.commits`). `applyOp` returns `clone(tl)` (`timeline.ts:3604`,
   `structuredClone`), so every clip object is new. `@xzdarcy/react-timeline-editor` 1.0.0
   has **no `memo` anywhere** (0 occurrences in `dist/index.es.js`): its rows are virtualised
   vertically (an inlined react-virtualized `Grid`), but every action in a row re-renders
   and calls `getActionRender` on every `editorData` change. Each clip's `ClipBlock`
   (strip, filmstrip tiles, waveform band) and the library's own `RowDnd` / interact.js
   wrapper (still mounted although `flexible: false`) render again. Then come a style recalc
   of every clip, a layout, and a repaint, plus teardown of the compositing layers the
   preview promoted (cause 3).
   **Evidence:** the release-phase worst frame rises with the clip count (3–50 clips:
   60–103 ms; 200: 178–337 ms). The release-dominated profile is JS-heavy at 200 clips and
   layout/paint-heavy at 10. The plain dnd-kit move has a cheap move phase (p95 18–21) and
   the same release spike, so the spike is the commit, not the gesture engine.
   **Dev inflation:** ~22 % of the release window is React's dev Performance Tracks, and
   StrictMode doubles render JS. A production React bundle is likely **0.5–0.7×** the dev
   release time. That is an estimate, not measured: see F6. Even at 0.5×, 200 clips stays
   at 90–170 ms, far over the 50 ms worst-frame budget.
2. **Forced synchronous layout in every preview, and the layout is broad.**
   `useEditGesture.ts` `paint()` writes `style.width` on the trimmed clip and
   `translate3d(...)` on moved clips. Right after that, `EditFeedbackLayer.tsx:106`'s
   `readout()` reads `el.offsetWidth` "once per text change", but the text (`+3f`, `+4f`…)
   changes on every snapped preview, so it forces a layout every time. The forced layout's
   self-time is spread across `RenderFlexibleBox::performFlexLayout`,
   `addOverflowWithRendererOffset`, `horizontalScrollbarHeight` / `verticalScrollbarWidth`
   and `PositionedLayoutConstraints`, i.e. a tree-wide relayout, not one clip. The width
   change escapes the clip because `contain: layout paint style` sits on the clip body,
   whose own size is not contained. Its parent, the library's absolutely-positioned
   `.timeline-editor-action`, has its scrollable overflow change, and that change propagates
   to the edit area's `overflow: overlay` scroller.
   **Evidence:** 63–79 % of busy main-thread time in the ripple move phase is
   `jsHTMLElement_offsetWidth` → layout. That is ~8 ms per preview at both 10 and 200 clips,
   which is what turns every other frame at the harness's 33 Hz input into 25–35 ms (move
   phase p95 35–48 at ≤ 50 clips). Removing the read alone saves little at 33 Hz: the same
   layout then runs once per frame at rendering time. It saves a whole layout per extra move
   at 120 Hz trackpad rates, and fix F2 is what makes the layout cheap.
3. **Ripple and slide restyle and re-layer every moved clip.** Each preview rewrites
   `transform: translate3d(...)` on every downstream clip (198 of 200 for a ripple of `c1`).
   That is a style recalc of each, and `translate3d` promotes each one to its own compositing
   layer: layers are created mid-drag and destroyed at release.
   **Evidence:** at 200 clips, ripple move-phase style recalc rises from 2 % to 13 % and
   paint/layer flush from 10 % to 13 %; move-phase p95 66 (vs 39–48 at ≤ 50 clips); release
   paint/layer flush 18–31 %.
4. **The press costs one 20–55 ms frame** (claim, pointer capture, first bracket and
   snap-target build). This is minor, but it is often the second-worst frame, so it sets
   p95 (cause 5).
5. **The measurement amplifies the misses.** (a) The rect `watch` forces a layout every frame
   (+5–25 ms p95, table above). (b) A 450 ms gesture yields ~40 frames, so "p95" is the
   second-worst frame and "dropped %" counts a handful of frames: one release spike plus one
   press spike decide both, and the same gesture's p95 ranged 35–71 ms across three runs.
   (c) Background work after building a big fixture (filmstrip and waveform requests):
   `idle` at 200 clips had p95 34–53 ms with nothing happening. (d) The dev build (cause 1).
   This is why run 2's dropped % looked "worse than run 1". Run 1's library resize moved one
   node and never previewed neighbours. P2 previews the real result, which costs more per
   move, and the release is unchanged.

**Ruled out:** the timeline copy per snapped frame (`previewEdit`; ≤ 1 %), waveform /
filmstrip repaint and image decode (≤ 0.6 %), the viewer (no store change during an edit
gesture, so no preview frame is requested), occlusion throttling, and window focus.

## Is the library the bottleneck?

**For the release, yes, as a multiplier. For the move phase, no.**
- **Move phase:** P2 already took the library out of the gesture: no React render, no
  interact.js `left`/`width` writes. What remains is our own forced read plus a layout whose
  scope is set by the library's DOM: absolutely-positioned action wrappers inside a native
  `overflow: overlay` scroller, which our CSS can contain (F2).
- **Release:** the library re-renders every action of every rendered row on any
  `editorData` change, with no memo and no horizontal virtualisation. It keeps an interact.js
  `RowDnd` per action that P2 no longer uses, and it owns the playhead DOM whose 1 px line
  still grabs over clips (B-349). Memoising our own `ClipBlock` inside `getActionRender`
  would cut our share of the commit, but not the library's per-action wrappers.
- **What replacing it would buy** (our own lanes: one absolutely-positioned, memoised block
  per clip keyed by clip identity, rendered only inside the horizontal viewport ± overscan,
  with our own ruler and playhead, which P3 is partly building anyway):
  - the commit becomes O(changed clips) instead of O(all clips);
  - mount and zoom become O(visible clips), which also helps the zoom half of B-347;
  - a ripple or slide preview becomes one transform on a per-track "downstream group"
    instead of ~200;
  - layout containment sits on wrappers we own;
  - interact.js and most of `timeline-overrides.css` go away.
  Expected release worst frame at 200–300 clips: **< 30 ms** (only the edited clips and
  their neighbours re-render). It is the largest item, and its own D-NNN (`ui-redesign.md`
  §8 already says so).

## Fix plan

| # | fix | file(s) | expected gain | when | who |
|---|---|---|---|---|---|
| F1 | No layout read after preview writes: give the readout a fixed width (tabular figures, `min-width` in `ch`) and centre it with CSS (`translateX(-50%)`), clamping with a width measured **once at gesture start, before any write** | `EditFeedbackLayer.tsx`, `useEditGesture.ts` | Removes the forced layout from the input handler: −1 layout per extra move at 120 Hz; at 33 Hz it mainly moves the work to the frame. Small alone, needed for F2 to show | now (neither file is in P3's way) | Sonnet |
| F2 | Contain the trimmed clip's size change: `contain: layout size style` on `.timeline-editor-action` (its size is set inline by the library, so size containment is safe, and layout containment makes the body's overflow ink overflow, so it no longer changes the scroller's scrollable overflow). Re-profile: the forced/frame layout should shrink to one clip subtree | `timeline-overrides.css` | Move-phase layout ~8 ms → < 1 ms per preview. Trim / ripple move p95 → ~17–20 ms at harness rate | now, or right after P3 if P3 touches the overrides file | Sonnet, with this note's profile as the check |
| F3 | Stop promoting every moved clip: `translate` (2D) instead of `translate3d` for neighbours, or, better, one transform per track on a wrapper of the downstream clips (needs F5's DOM) | `useEditGesture.ts` (2D now), F5 for the group | 200-clip ripple/slide move p95 66 → ~25 (2D: no layer churn); group transform: O(1) style work | 2D: now; group: with F5 | Sonnet / with F5 |
| F4 | Make the commit O(changed): `applyOp` with structural sharing (copy the touched track arrays and the clips an op changes, keep every other clip object), and `getActionRender` returning a `memo`'d `ClipBlock` keyed on the clip object | `timeline.ts` (`clone` → per-op copy), `TimelinePane.tsx` (`getActionRender`) | Our share of the release (ClipBlock subtrees, ~200 per commit) drops to the edited clips; the library's wrappers still re-render. Release at 200 clips likely −40–60 % | after P3 lands (`TimelinePane.tsx`); `applyOp` part now, behind its exhaustive tests | **Opus** (`applyOp` is the edit model's core; every op needs its sharing right) |
| F5 | Replace `@xzdarcy/react-timeline-editor` with Apelles' own virtualised lanes (own D-NNN) | new `packages/editor/src/lanes/*`, `TimelinePane.tsx` | Release < 30 ms at 300 clips; zoom and mount O(visible); fixes B-349 by construction; enables F3's group transform | after P3; plan first | **Opus** (plan, then Sonnet forks per part) |
| F6 | Measure what ships: (a) a perf run against a `tauri build --debug` app (run in `app/`; Rust debug, so the `debug_*` ops exist; production React bundle: no StrictMode double render, no dev Performance Tracks); (b) harness perf: measure with no rect `watch` (take live-feedback evidence in a separate watched run), gestures ≥ 1.5 s or aggregated across reps, split move vs release (record the `pointerup` frame index in `perf.ts`), wait for idle after building a fixture | `packages/ui-harness/*`, `packages/debug/src/input/perf.ts` | Numbers that mean what they say; the budgets stop flapping run to run | now | Sonnet |

The order that pays off fastest: F6 (so every other fix is judged on real numbers), F1 + F2
together, F3-2D, then F4. F5 is the structural fix and the one that makes 300-clip timelines
meet the D-432 §8 target (p95 ≤ 8 ms, zero layout during `pointermove`).

## Progress (quick-win pass, 2026-11-01)

Each line is a landed fix. None is re-profiled against the live app yet (that needs a
`tauri build --debug` run, F6); the gain column is the plan's expectation.

- **F1 done.** `EditFeedbackLayer` no longer reads `offsetWidth` in `readout()`. A hidden
  10-glyph probe is measured once by `measure()`, which `useEditGesture` calls at the claim
  before its first write; the pill is monospace, so `width = text.length x glyph + padding`
  and clamps with no layout read. Pinned by `EditFeedbackLayer.dom.test.tsx` (a spy on
  `offsetWidth` counts one read per gesture). Expected: the forced layout leaves the input
  handler (-1 layout per extra move at 120 Hz).
- **F2 done.** `.timeline-editor-action { contain: layout size style }` in
  `timeline-overrides.css` (not `paint`). Nothing legitimately draws outside the wrapper:
  its only child is the `ClipBlock` body, which already has its own `contain: layout paint
  style`, and the brackets, readout, snap guide, transitions, markers and the playhead all
  live in the pane's overlay layers, not in the action. Pinned as text in
  `timelineOverrides.test.ts` (jsdom applies no CSS). Expected: move-phase layout
  ~8 ms -> < 1 ms per preview; **unverified live**: re-profile with the F6 build.
- **F3 (2D part) done.** Moved neighbours get `translate(dx, 0)` instead of
  `translate3d(dx, 0, 0)` in `useEditGesture.ts`, so no clip is promoted to its own
  compositing layer mid-drag (transform-only, nothing else changed). The slip picture's
  `media` shift keeps `translate3d`: it is one element per gesture. Pinned by a
  `TimelinePane.clipBlock.dom.test.tsx` case. The per-track group transform stays with F5.
  Expected: 200-clip ripple/slide move p95 66 -> ~25 ms; **unverified live**.
- **F4 (domain part) done.** `applyOp` is now `shareUnchanged(tl, applyOpCopy(tl, op))`
  (`timeline.ts`): the ~60 op bodies are untouched and still deep-copy, then a reconcile pass
  hands back the original node for every deeply-equal subtree (arrays of id'd records, i.e. a
  track's clips, are matched by id so an insert or remove does not misalign the rest). An
  untouched clip, track or array is `===` to the input's; a no-op is the input itself. Chosen
  over a copy-on-write rewrite of every op because the copy costs <= 1 % and the exhaustive
  op suite then holds by construction (2760 editor tests green, results `toEqual`-identical).
  It exposed one real aliasing hazard: `rippleDeleteOneRange` mutated the result of the
  composed `applyOp` calls in place, which now shares clips with the input, so it clones
  first (caught by `rippleDeleteRanges.property.test.ts`). Pinned by `timelineShare.test.ts`.
  **Not done here (after P3):** memoising `ClipBlock` in `TimelinePane.tsx`'s
  `getActionRender` on the now-stable clip identity. That memo is what turns the identity
  into the release-time win (expected -40-60 % at 200 clips); until it lands the library
  still re-renders every wrapper.

## Instrument next (exact additions; debug-only)

Sampling gave proportions. Exact per-phase times need marks the harness can read back:

- `useEditGesture.ts`:
  - `performance.mark('apelles:edit:press')` in the claim;
  - around `previewEdit` + `paint`: `performance.mark('apelles:edit:preview:start')` and
    `performance.measure('apelles:edit:preview', 'apelles:edit:preview:start')`;
  - in `finish(true)`: `performance.mark('apelles:edit:commit')` before `v.applyOp(op)`.
- `TimelinePane.tsx`: in the existing layout effect that calls
  `editGesture.committedRendered()`, `performance.measure('apelles:edit:commit-rendered',
  'apelles:edit:commit')`; then in a `requestAnimationFrame` from it,
  `performance.measure('apelles:edit:commit-painted', 'apelles:edit:commit')`.
- All behind `import.meta.env.DEV` (Vite strips it from a production bundle), matching the
  debug-only rule.
- A debug op in `packages/debug/src/debugOps.ts`:
  `debug_perf_entries {prefix: string, clear?: boolean}` →
  `performance.getEntriesByType('measure')` filtered by name prefix
  (`{name, startTime, duration}`), registered only in debug builds like the other `debug_*`
  ops, plus its MCP wrapper in both servers.
- The harness then attaches `preview p50/p95`, `commit→rendered` and `commit→painted` to each
  measured step.

## Raw data

Scratchpad JSON lines and `sample` outputs (session scratchpad, not kept in the repo):
`matrix.jsonl` (the main table), `nowatch.jsonl`, `thr0/1.jsonl`, `bg.jsonl`,
`rate10/200.jsonl`, `long-*.txt` / `s_short*.txt` / `s_ripple200.txt` (profiles). The method
above is enough to reproduce them.
