# The timeline UI harness — driving and measuring the live app (D-434)

Owner, 2026-10-31: *"the timeline is way buggy, nothing works as it should — set up a
harness for measuring and testing, drive it, and fix it."* This note is how to use what
phase 1 built. D-434 has the decision and the research behind it.

## What it is

Three layers, all debug-only (compiled out of a release build, see
`docs/notes/debug-tooling.md` piece 7):

| layer | where | what it does |
|---|---|---|
| input tools | `@apelles/debug` `src/input/` + MCP `debug_pointer` / `debug_key` | real pointer / keyboard input at a DOM target, with what was hit, what the page received, and optional perf + per-frame rects |
| native delivery | `app/src-tauri/src/chroma/debug_input.rs` + crate `apelles-ui-input` | each event as a genuine `NSEvent` delivered to the window's WKWebView (WebKitTestRunner's pattern) — trusted DOM events, no macOS permission, the real cursor never moves, the window need not be in front |
| scenario runner | `packages/ui-harness` | scenarios against the live app through the control server; PASS/FAIL per scenario, perf vs budgets, markdown report with screenshots |

Plus `debug_set_occlusion_throttling(enabled)` — WebKit's own switch that keeps a covered
window running `requestAnimationFrame`. Without it, every frame number from a window that
is not frontmost reads zero (B-124 / D-217 / D-330's standing blocker).

## Running the suite against the live app

The app must be a **debug** build (`npm run tauri:dev`), with nothing modal open. From the
repo root:

```bash
npm run harness --workspace @apelles/ui-harness                    # everything
npm run harness --workspace @apelles/ui-harness -- --filter roll   # by id or area substring
npm run harness --workspace @apelles/ui-harness -- --list          # what exists
```

Options: `--port` (default `CHROMA_CONTROL_PORT` or 19788), `--mode auto|native|synthetic`
(default `auto` = native inside the app), `--out` (default `scratch/ui-harness`),
`--ffmpeg` (default `ffmpeg` on PATH), `--keep-project`, `--keep-throttling`.

What a run does, and undoes:

1. switches to the Edit tab; turns occlusion throttling **off** (remembering the old value);
2. generates three 30 s test files with ffmpeg into `scratch/ui-harness/media/` (once):
   `testsrc2` picture only, the same with a 440 Hz tone, and the tone alone;
3. creates and opens a **new** project `ui-harness-<stamp>` holding that media, and waits
   until the Edit tab has switched to it — the owner's projects are never edited;
4. per scenario: creates a fresh timeline `ui-harness <id>`, lays out its fixture through
   `editor_*` ops, runs its steps, screenshots it on failure, deletes the timeline;
5. restores throttling, reopens the project the app had open, deletes the scratch project
   folder (only a `ui-harness-*.chroma` folder this run created).

Output: `scratch/ui-harness/runs/<stamp>/report.md`, `report.json`, `shots/*.png`. Exit
code 0 = all passed, 1 = any FAIL/ERROR, 2 = could not start.

**One-time permissions: none.** Native input is delivered in-process, so no Accessibility,
Input Monitoring or Screen Recording grant is involved. (Do not "fix" a delivery problem by
switching to `CGEventPost` — that path needs a TCC grant a dev rebuild invalidates; D-434.)

## Reading the verdicts

- **PASS** — every check held. **FAIL** — a check did not; this includes a press that
  landed on another element (`aimed at … but the press lands on …`), a target that is not
  on screen, a gesture the page never received, and a GUI affordance that does not exist
  (`NOT reachable from the GUI — …`). All are findings about the app.
- **SKIP** — a `require` precondition failed (e.g. the timeline is not 30 fps, or the A/V
  fixture came without a linked audio half). **ERROR** — the harness could not proceed
  (a control op refused, the app went away).
- **Perf** is a separate verdict per measured step: `within budget` or `OVER: <each miss>`.

The suite is written against how Resolve / Premiere / Final Cut behave, not against what
Apelles does today. Several scenarios encode affordances Apelles does not have yet (J/K/L,
I/O, a ripple-delete key, a snapping toggle, keyboard zoom, edit-point navigation, a blade
tool, a two-up trim viewer): those FAIL until built — that is the point.

## Budgets

`packages/ui-harness/src/budgets.ts`, each a named constant:

| budget | value | source |
|---|---|---|
| frame | 16.7 ms | one 60 Hz refresh (`FRAME_BUDGET_MS`, shared with the in-app instrument) |
| frame p95 during a gesture | ≤ 33.3 ms | two refreshes: an occasional miss tolerated, a steady 30 fps drag is not |
| worst frame | ≤ 50 ms | RAIL's long-task line |
| dropped frames | ≤ 10 % | |
| input → next frame, p95 | ≤ 50 ms | one refresh plus the handler's work |
| input → store commit (where a step asks) | ≤ 100 ms | RAIL "instant" response |
| playback paint | ≥ 24 fps | slowest real footage rate |
| playback play loop (rAF) | ≥ 50 fps | the loop must not stall |

A measured step with **no frames at all** is itself a miss: the window was throttled and
nothing was measured.

## Writing a scenario

Scenarios are typed data in `packages/ui-harness/src/scenarios/` (`editTools.ts`,
`timeline.ts`), listed in `index.ts`. Shape (`src/scenario.ts`):

```ts
{
  id: 'roll-edit-tool',                // kebab-case; what --filter matches
  title: 'Roll tool: …',
  area: 'edit tools',
  reference: 'Premiere Rolling Edit tool (N) / Resolve roll: …',   // the expected NLE behaviour
  fixture: THREE_CLIPS,                // tracks top→bottom, clips by NAME, markers, playhead
  steps: [
    FPS_GUARD,                                              // skip on a non-30 fps timeline
    { capture: 'timeline', as: 'before' },
    pickTool('roll'),                                       // click the toolbar button, as a human does
    { pointer: { action: 'drag', target: trimRight('a'), to: byFrames(15), steps: 15,
                 watch: { selectors: [clipSelector('a'), clipSelector('b')], cursor: true } },
      measure: true },
    { expect: { live: { selector: clipSelector('b'), prop: 'x', minDistinct: 4 } } },
    { expect: { cursor: { anyOf: TRIM_CURSORS } } },
    { waitFor: clipIs('a', 'duration', 105) },
    { expect: [clipIs('b', 'startFrame', 105), { path: 'timeline.durationFrames', op: 'unchanged', from: 'before' }] },
  ],
}
```

**Steps:** `pointer` / `key` (real input; `measure: true` holds the numbers to the default
budget, or pass a partial budget), `op` (any control op with wire arguments — fixture
tweaks, `undo`, the MCP side of a parity check; `args` may be a function of the scope),
`capture` (`timeline` / `state` / `view` / `dom` + `selector`, stored under `as`), `expect`,
`waitFor` (poll until it holds, default 2 s), `wait`, `screenshot`, `require` (→ SKIP),
`reachable` (an element must exist, else FAIL with the reason), `playback` (play N seconds
and hold `debug_frame_timing` to the playback budget).

**Targets** (`src/targets.ts`): `clip(name, at?)`, `trimLeft(name)` / `trimRight(name)`
(the library's 10 px edge zones), `clipEdge(name, side, px)`, `ruler(fx)`,
`playheadHandle()`, `trackHeader(i)`, `trimTool(tool)`, `marker(name)`, `editArea(at?)`,
`headerResize()`, `testid(id)`, `selector(css)`; frame-addressed `atFrame(frame, track |
'ruler', fy?)` and relative `byFrames(frames, tracks?)` are resolved by the runner from the
live view readout (zoom, scroll, layout), so no scenario hard-codes a pixel. A clip or
marker NAME in a selector is written as `@clip:<name>` / `@marker:<name>` (the builders do
this) and replaced with the real id once the fixture exists.

**Assertions** (`src/assertions.ts`): `{path, op, value, tolerance?, from?, label?}` over
the roots `timeline` (`editor_get_timeline`, clips keyed by fixture name with `end`
precomputed — `timeline.clips.b.startFrame`, `timeline.tracks.0.length`,
`timeline.markers.0.frame`), `state` (`editor_get_state`), `view` (zoom/scroll readout),
`last` (the last input reply — `last.observed.counts.pointerdown`), and any captured name.
Operators: `eq ne gt gte lt lte near in truthy falsy changed unchanged`; a value may be
`{ref: 'before.clips.a.end', plus: 15}`. `live` (an element's rect took ≥ N distinct values
across the gesture's frames — it moved WHILE dragging) and `cursor` (some frame showed one
of these cursors) judge the `watch` samples.

**GUI ↔ MCP parity** (CLAUDE.md: every feature is built for a human AND an AI): after the
GUI edit, `capture` it as `gui`, `undo`, apply the matching `editor_*` op with the delta the
GUI produced, and `expect` the same fields (`sameAsGui`). The edit-tool scenarios do this
for trim, ripple, roll, slip, slide and split.

## Driving the app by hand (an agent, without the runner)

```text
debug_set_occlusion_throttling(enabled=False)        # a covered window keeps rendering
debug_dom_tree('[data-testid="timeline-edit-area"]', max_depth=0)   # zoom/scroll readout
debug_pointer(action="click", target={"testid": "timeline-trim-tool", "nth": 2})
debug_pointer(action="drag",
              target={"selector": ".timeline-editor-action:has([data-chroma-clip-id='c1']) .timeline-editor-action-right-stretch"},
              to={"byX": 45}, steps=15, measure=True,
              watch={"selectors": ["[data-chroma-clip-id='c2']"], "cursor": True})
debug_key(keys=["meta+KeyZ"])
debug_set_occlusion_throttling(enabled=True)
```

Read the reply before trusting it: `mode` (native or synthetic), `targets[].hitInside`,
`observed.counts` / `observed.trusted`, and `native` (`windowKey`, `occlusionDetection`,
`mouseMovePath`, `pressedButtonsOverride`, `wheelWindowMatched`, `magnifyBuilt`).

## Stable test ids

`packages/editor/src/timelineTestIds.ts` is the one list. Our parts carry `data-testid`;
a repeated part carries one id on every instance and its identity in `data-chroma-*`:

| test id | element | identity |
|---|---|---|
| `timeline-edit-area` | the edit area; also the view readout `data-chroma-px-per-sec`, `-scroll-left`, `-scroll-top`, `-fps`, `-start-left`, `-row-height`, `-rows-top` | |
| `timeline-clip` | a clip body (dnd-kit drag source) | `data-chroma-clip-id`, `data-chroma-track` |
| `timeline-clip-fade-in` / `-fade-out` | fade handles | inside the clip |
| `timeline-track-lane` | a track's row (pointer-transparent geometry) | `data-chroma-track` |
| `timeline-track-header` + `-lock` `-sync-lock` `-hide` `-mute` `-beats` `-remove` | header and its buttons | `data-chroma-track` on the header |
| `timeline-header-resize`, `timeline-curve-resize` | the column / curve-lane dividers | |
| `timeline-split` `-delete` `-link` `-unlink` `-remove-gap` `-zoom-in` `-zoom-out` `-zoom-readout` `-add-marker` `-marker-list` | toolbar | |
| `timeline-trim-tool` | a trim-palette button | `data-chroma-trim-tool` (`select` `ripple` `roll` `slip` `slide`) |
| `timeline-marker` | a marker flag | `data-chroma-marker` |
| `timeline-transition` | a transition badge | `data-chroma-transition` |
| `timeline-marquee`, `timeline-gap-selection`, `timeline-drag-ghost` | overlays | |

Library-rendered parts by the library's own classes (`TIMELINE_LIBRARY_SELECTORS`, pinned by
`timelineTestIds.test.ts` against the installed stylesheet): ruler
`.timeline-editor-time-area`, playhead `.timeline-editor-cursor` and its handle
`.timeline-editor-cursor-top`, a clip's wrapper `.timeline-editor-action`, its trim zones
`.timeline-editor-action-left-stretch` / `-right-stretch`, the scroll container
`.timeline-editor-edit-area`. There is no zoom SLIDER (buttons, ctrl/pinch wheel only) and
no scrollbar element (native overflow scrolling) — scenarios scroll with the wheel.

## Known limits (phase 2 checks these first)

- Native delivery is verified by unit tests of its rules and a compile, **not yet live**.
  The first run should look at `observed.trusted` (expect every event), `native.wheelWindowMatched`
  (if false, wheel events land at the wrong place — WebKit reads a windowless event's
  location as screen coordinates), `native.magnifyBuilt` (pinch is built from undocumented
  `CGEvent` gesture fields; refused loudly if AppKit does not produce a Magnify event), and
  whether keys reach the page while the window is not key.
- `+[NSEvent pressedMouseButtons]` is overridden while an injected button is held; a real
  mouse press during that window reports the injected state. It is restored when a call
  ends with no button held (a `down` in one call and `up` in the next keeps it in between).
- Frame-addressed targets assume the fixture media's 30 fps (each scenario's `FPS_GUARD`
  skips otherwise) and that the ruler starts at the edit area's left edge.
- Synthetic mode cannot judge WebKit behaviour (no default actions, no real capture, a
  pinch is played as Chromium's ctrl+wheel); its results are labelled `mode: synthetic`.
