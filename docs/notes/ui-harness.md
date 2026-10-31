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
is not frontmost reads zero (B-124 / D-217 / D-330's standing blocker). And
`debug_set_webkit_layer_debug({borders, repaint_counters})` (D-437 S0b), which draws WebKit's
compositing borders and per-layer repaint counters on the page, so a paint-isolation change can
be seen in a screenshot; turn it off again after, it paints over what you are measuring.

## Running the suite against the live app

(The `perf-300` family is opt-in: it only runs with `--filter perf-300`. See "Baseline recipe".)

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
4. per scenario: creates a fresh timeline `ui-harness <id>`, resets the timeline zoom to the
   default (`editor_set_timeline_view`), lays out its fixture through `editor_*` ops, checks
   (`debug_overlay_check`) that no `position: fixed` overlay covers the timeline's lanes,
   header column or toolbar buttons (fails fast, naming the overlay), runs its steps,
   screenshots it on failure, deletes the timeline and drops the undo entries its ops left.
   Every harness request carries `source: "harness"`, so the Agent activity dock and a
   person's undo history never see the fixture ops as agent work;
5. restores throttling, reopens the project the app had open (or, when none was open,
   calls `close_project`), then deletes the scratch project folder (only a
   `ui-harness-*.chroma` folder this run created, and only once the app has left it: a
   failed reopen/close keeps the folder and says so, B-356).

At start the CLI recovers from a previous run's leftover: if `editor_get_state` fails
because the open project's folder is gone (`read …/project.json: No such file`), it calls
`close_project`, notes it in the report, and carries on. If `debug_activate_app` fails
because the frontmost app is `loginwindow` (the Mac is locked or asleep), it stops with
"unlock the Mac and keep Apelles visible" instead of measuring zero frames (B-352).

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
(the clip's own 8 px edge-trim zones, D-432 P2), `clipEdge(name, side, px)`, `ruler(fx)`,
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
| `timeline-edit-area` | the edit area; also the view readout `data-chroma-px-per-sec`, `-scroll-left`, `-scroll-top`, `-fps`, `-start-left`, `-row-height` (the view's default track height), `-rows-top`, `-row-tops` (D-432 P3: each row's top, comma-separated, one past the last; `pointAtFrame` uses it) | |
| `timeline-clip` | a clip body (dnd-kit drag source) | `data-chroma-clip-id`, `data-chroma-track` |
| `timeline-clip-fade-in` / `-fade-out` | fade handles | inside the clip |
| `timeline-clip-trim-start` / `-end` | a clip's edge-trim zones (D-432 P2; replaced the library's stretch handles) | inside the clip; `data-chroma-trim-edge` |
| `timeline-clip-strip`, `-film`, `-band`, `-keyframes-badge` | the clip anatomy (name strip, filmstrip, waveform band, curve-lane badge) | inside the clip; the picture+waveform layer is `[data-chroma-clip-media]` |
| `timeline-track-lane` | a track's row (pointer-transparent geometry) | `data-chroma-track` |
| `timeline-track-header` + `-lock` `-sync-lock` `-hide` `-mute` `-beats` `-duck` `-badge` `-name` `-name-input` `-menu` | header and its parts (D-432 P3: toggles are `display: none` until the header is hovered unless non-default, which carries `data-chroma-active`) | `data-chroma-track` on the header |
| `timeline-track-rename`, `timeline-track-remove` | the track menu's Rename and Delete track items (open `timeline-track-menu` or right-click the header first) | |
| `timeline-track-height-resize`, `timeline-lane-height-resize`, `timeline-track-height-guide` | a header's / lane's bottom-edge height zone, and the guide line while dragging | `data-chroma-track` |
| `timeline-header-resize`, `timeline-curve-resize` | the column / curve-lane dividers | |
| `timeline-split` `-delete` `-link` `-unlink` `-remove-gap` `-zoom-in` `-zoom-out` `-zoom-readout` `-add-marker` `-marker-list` `-snapping-toggle` `-skimming-toggle` `-clip-appearance` | toolbar | |
| `timeline-clip-appearance-popover`, `timeline-zoom-slider`, `timeline-show-clip-names`, `timeline-show-clip-badges` | the Clip Appearance popover | height buttons `data-chroma-clip-height`, balance `data-chroma-band-ratio` |
| `timeline-ruler`, `timeline-ruler-label` | our own ruler (D-432 P3; press seeks, drag scrubs) | `data-chroma-tick-seconds`, `data-chroma-tick-split` |
| `timeline-skim-line`, `timeline-two-up-viewer` | the skim line; the viewer's two-up overlay during roll / slip / slide | halves: `data-chroma-two-up-half` |
| `timeline-trim-tool` | a trim-palette button | `data-chroma-trim-tool` (`select` `ripple` `roll` `slip` `slide`) |
| `timeline-marker`, `timeline-marker-editor` | a marker flag (drag moves it), its editor popover | `data-chroma-marker`, `data-chroma-marker-selected` |
| `timeline-transition` | a transition badge | `data-chroma-transition` |
| `timeline-marquee`, `timeline-gap-selection`, `timeline-drag-ghost` | overlays | |
| `timeline-edit-bracket`, `timeline-edit-readout`, `timeline-snap-guide`, `timeline-blade-line` | the edit-gesture feedback layer (D-432 P2) | bracket: `data-chroma-bracket-side` in/out, `data-chroma-limit` |

Library-rendered parts by the library's own classes (`TIMELINE_LIBRARY_SELECTORS`, pinned by
`timelineTestIds.test.ts` against the installed stylesheet): playhead `.timeline-editor-cursor` and its handle
`.timeline-editor-cursor-top`, a clip's wrapper `.timeline-editor-action`, the scroll container
`.timeline-editor-edit-area`. There is zoom slider only inside the Clip Appearance popover (D-432 P3; scenarios use the buttons, `=` / `-` or the wheel) and
no scrollbar element (native overflow scrolling) — scenarios scroll with the wheel.

D-432 P3 scenarios (2026-11-01): `snapping-toggle-button`, `skimming-toggle-key`,
`scrub-ruler-drag` (B-350), `track-height-drag`, `track-header-quiet`; updated:
`move-snapping-toggle` (N, not S), `trim-tool-shortcuts` (Roll on T),
`trim-two-up-viewer` (the real overlay id). The fixture now resets every
`editor_set_timeline_view` field per scenario, and frame targets in the ruler
resolve against `timeline-ruler`.

## Known limits (phase 2 checks these first)

- Native delivery was checked live on 2026-10-31: see "First live run" below for the answers
  (trusted events yes; keys while not key yes; hover moves while not key **no**; the wheel is
  **not** attributed to the window). The 2026-10-31 fix wave addresses the last two (H5, H8);
  both are **unverified** until the next live run, see "Fix wave" below. Second run: H5
  works only while Apelles is the active app (H15).
- **Real input leaks into the observer.** The capture-phase observer counts every event the page
  gets, including the owner's real mouse and keyboard; a live check saw a real Shift keydown
  and stray pointermoves in an injected call's `observed`. Run with nobody at the machine, or
  read `observed.lastPointer` against the target.
- `+[NSEvent pressedMouseButtons]` is overridden while an injected button is held; a real
  mouse press during that window reports the injected state. It is restored when a call
  ends with no button held (a `down` in one call and `up` in the next keeps it in between).
- Frame-addressed targets assume the fixture media's 30 fps (each scenario's `FPS_GUARD`
  skips otherwise) and that the ruler starts at the edit area's left edge.
- Synthetic mode cannot judge WebKit behaviour (no default actions, no real capture, a
  pinch is played as Chromium's ctrl+wheel); its results are labelled `mode: synthetic`.

## First live run (2026-10-31)

Run `scratch/ui-harness/runs/2026-10-31T17-37-31-132Z/` (all 49, mode auto = native): **18 pass,
30 fail, 1 error**, perf over budget in 13 of 23 measured steps. Triage then reran the blocked
scenarios with the Agent activity dock's list collapsed (`…/2026-10-31T17-42-35-009Z/`, 22
scenarios: 7 pass) and ran one-off experiments in a throwaway project from a scratchpad script
that imports the runner (step-size sweep for trims, hover delivery, scrub from the hit strip,
Cmd+K with an off-playhead select; native and synthetic). The owner's project was reopened by
each run's restore and verified open afterwards.

### Classification of the 31 non-passes

Primary class first; a scenario blocked by a harness defect was rerun to find what lies
behind it.

| scenario | class | evidence → finding |
|---|---|---|
| `trim-right-edge-select-tool` (ERROR) | real | 77 vs 75: B-344 (snap eats travel). ERROR itself is harness H3 (MCP sign) |
| `trim-left-edge-select-tool` | real | 193 vs 195: B-344 |
| `ripple-trim-tool` | real | B-344 (77) + B-345 (`c` does not follow live). Run 1 also H1 (dock) and H3 (MCP step made `b` 105) |
| `roll-edit-tool` | real | B-344 (103) + B-345 (`b`'s head static). Run 1 H1 |
| `roll-smart-trim-alt` | real | B-344 + B-345 |
| `slide-tool` | real | B-345 (no slide preview). Store result right on rerun. Run 1 H1 (tool click missed, so the drag was a Select-tool move) |
| `split-at-playhead-shortcut` | real | B-346: the select click lands on `.timeline-editor-cursor-area`; off the playhead the select + Cmd+K split works |
| `slip-tool` | harness | H1 only; PASS on rerun. But H9: it has no live check, and B-345 says slip shows nothing while dragging |
| `split-toolbar-button` | harness | H1; PASS on rerun |
| `scrub-playhead-drag` | harness | H1 then H4 (the head `svg` sits under the 16 px hit strip); a drag from the strip scrubs to 200 exactly |
| `seek-empty-lane-click` | harness | H6: frame 200 is past the 180-frame GAPPED timeline; `setPlayhead` clamps to the last frame (179) by design |
| `select-shift-multi` | harness | H6: Shift-click is a RANGE by design (D-107, `onClickAction`), so a..c selects 3. Cmd-click toggles |
| `linked-av-select-together` | harness | H6: D-129 chose option (b): one half selects, the partner gets a dashed outline, ops act on the group |
| `gap-select-and-close` | harness | H6: GAPPED's track-1 clip `c` (30–150) straddles the gap's end (120), so `checkRemoveGap` refuses (B-033), correctly |
| `track-header-resize` | harness | H7: the divider exists (D-094) but `react-resizable-panels` 4.12.3 overwrites `data-testid` with its own id |
| `marker-add-key-m`, `marker-click-jumps`, `key-space-play-pause`, `key-arrows-frame-step` | harness | H2 (zoom leaked from the pinch scenario put targets at x 6633); all PASS on rerun |
| `marker-add-button` | harness | H1; PASS on rerun |
| `clip-body-hover-cursor`, `track-header-present` | harness | H5: a plain move is not delivered while the window is not key (synthetic delivers it and shows `grab`) |
| `trim-two-up-viewer`, `razor-blade-tool`, `move-snapping-toggle`, `ripple-delete-shortcut`, `zoom-keyboard`, `marker-drag-move`, `key-jkl-shuttle`, `key-in-out-marks`, `key-edit-point-navigation` | missing | B-348 (one grouped entry); absence confirmed in `@apelles/keymap` `SHORTCUTS` and `TimelineMarkers.tsx` |

**Counts:** real 7 · missing feature 9 · harness 15. Real bugs logged: **B-341** (dock covers the
timeline toolbar/headers), **B-342** (marker flag over the dock, P2), **B-343** (undo stack
crosses projects), **B-344** (snap eats trim travel), **B-345** (no live preview for
ripple/roll/slip/slide, P2), **B-346** (playhead strip eats clip clicks, P2), **B-347** (perf).

**The toolbar hit failure** ("aimed at the Roll tool button but the press lands on
`div.flex.items-center.gap-2`") was a real element on top, not a coordinate mismatch: the hit
is `elementFromPoint` at resolve time, before any event is sent, and that element is a row of
the Agent activity dock (`fixed left-3 bottom-3 z-40 w-[340px]`, up to 45 vh tall), which the
harness's own setup ops had filled. The trim buttons sit where the layout puts them
(x 104–240, y 643–675 at 1470×923); P1's type scale did not move or overlap them. A human with
an agent working hits the same dock: B-341 (fixed afterwards by D-435: the dock is now a top-bar popover that never opens by itself, so the runs no longer need to collapse it).

### Harness defects and the fix each needs

| # | defect | fix |
|---|---|---|
| H1 | Every fixture op runs through the control server as `source: 'agent'`, so the Agent activity dock opens and fills (100+ rows: "Add harness-video-30s.mp4", "Add video track") and covers the bottom-left of the timeline | mark harness ops as their own source (`'harness'` / debug) that the dock and the user's history ignore, or run them outside `runAsAgent`; clear what the run pushed on teardown (B-343's fix makes the project switch do it); and assert no fixed overlay intersects the timeline before a scenario starts |
| H2 | View state leaks between scenarios: `zoom-trackpad-pinch` left 480 px/s and every later frame-addressed target went off screen | reset zoom and scroll in `buildFixture`. No MCP or debug op sets timeline zoom today (a parity gap too), so add one (`editor_set_timeline_zoom`, or a debug setter) rather than clicking the buttons N times |
| H3 | The MCP parity steps send `editor_trim_clip(edge: 'end', delta: 15)` believing the docstring ("positive shortens"), which is backwards for the end edge (B-337): the plain trim refuses to grow into `c` (the ERROR), the ripple makes `b` 105 | use the reducer's real sign (end edge: negative shortens) until B-337 settles the contract, then follow it |
| H4 | `playheadHandle()` aims at `svg.timeline-editor-cursor-top`, which sits under the library's 16 px `.timeline-editor-cursor-area` | aim at the hit strip's top (or the `.timeline-editor-cursor` container); if B-346 confines the strip to the ruler, aim at whatever the handle becomes |
| H5 | Native `move` (no button) uses `_simulateMouseMove:`, which WebKit drops while the window is not key: `windowKey: true` → 1 pointermove, `false` → 0 (checked live on the same button). Drags (`mouseDragged:`) are delivered either way | in `debug_input.rs`, deliver a buttonless move another way when not key (try `mouseMoved:` on the view), and if nothing arrives, fail with "hover needs a key window" rather than the generic "input never arrived"; the runner can then SKIP hover checks with that reason |
| H6 | Expectations that contradict decided behaviour or the fixture: shift-click (D-107 range), linked selection (D-129 option b), seek past the timeline end (clamp), gap close with a straddling sync-locked clip (B-033) | shift test → Cmd-click to add (keep a range test for Shift); linked test → assert the partner's outline and that a move/delete takes both; empty-lane seek → a frame inside the timeline; gap fixture → keep track 1 clear of the gap's end |
| H7 | `data-testid="timeline-header-resize"` never reaches the DOM: `react-resizable-panels` 4.x's `Separator` writes `data-testid` from its `id` | pass `id="timeline-header-resize"` (and the same for `timeline-curve-resize`), and pin it in `timelineTestIds.test.ts` against a real render |
| H8 | `native.wheelWindowMatched` is **false**: the wheel `NSEvent` built from the `CGEvent` is not attributed to the window, so WebKit reads its location as screen coordinates. Scroll/zoom scenarios passed only because the window spans the screen from x = 0 (y is off by the menu bar); the observer does not record wheel coordinates, so this was invisible | verify with a window moved away from the origin; fix the attribution (or convert the location for a windowless event); record `clientX/Y` of wheel events in `observe.ts` |
| H9 | `slip-tool` has no live-feedback check, so it passes while slip shows nothing during the drag (B-345) | add a `live` check on what slip should animate (the filmstrip offset / a two-up frame) once P2 builds it |
| H10 | `native.pressedButtonsOverride` reads `true` on calls with no button (a move, a key, a wheel) | report it only when a button is held, or rename it to what it means |

### Fix wave, 2026-10-31: status of H1-H10

Code and unit tests for all ten. "Fixed" = verified by tests that run without the app;
**unverified** = needs the live app (the owner's instance was off limits for this wave).

| # | status | what changed | how to confirm live |
|---|---|---|---|
| H1 | **fixed** | `ControlClient` stamps `source: "harness"`; `control.rs` forwards only that value; the dispatchers use `runForRequest` (`@apelles/history` gains an `EntrySource` `'harness'`, which the dock ignores); `teardownFixture` calls `debug_clear_harness_history`; `debug_overlay_check` + `assertNothingCoversTheTimeline` fail fast. | a run no longer opens the dock |
| H2 | **fixed** | zoom moved from `TimelinePane` state into `useTimelineViewStore`; `editor_set_timeline_view({zoom})` (D-432's planned name, zoom is its first field) sets it and `editor_get_state.timelineView` reads it; `buildFixture` resets it. Both MCP servers, corpus, 261 -> 262. | `zoom-trackpad-pinch` followed by any frame-addressed scenario |
| H3 | **fixed** | B-337 docstring corrected in both servers (`delta` moves the edge; `end` + extends); the replay steps use -15 | `trim-right-edge-select-tool`, `ripple-trim-tool` MCP replays |
| H4 | **fixed** | `playheadGrab(frame)` = the ruler at the playhead's frame, `expectHit: false`, so it holds both before and after B-346 shrinks the strip | `scrub-playhead-drag` |
| H5 | **fixed in code, unverified** | a buttonless move into a non-key window calls `makeKeyWindow` first (WebKitTestRunner's pattern; `native.madeKeyForMove`); if no `pointermove` still arrives in a non-key window the runner SKIPs the scenario with "hover needs a key window" instead of the generic failure. It is not known that WebKit honours a window made key while the app is inactive. | `clip-body-hover-cursor`, `track-header-present`: `observed.counts.pointermove` > 0 with `native.windowKey` false |
| H6 | **fixed** | `select-shift-multi` -> `select-cmd-click-toggles` + `select-shift-click-range` (D-107); `linked-av-select-together` -> `linked-av-select-one-half` (D-129 option b: one half selected, partner dashed, Delete takes both); empty-lane seek at frame 150 inside the 180-frame timeline; `GAPPED`'s track-1 clip no longer straddles the gap end (B-033) | the four scenarios |
| H7 | **fixed** | `ResizableHandle id={…}` for `timeline-header-resize` and `timeline-curve-resize` (the library derives `data-testid` from `id`); the scenario targets `#timeline-header-resize`; `TimelinePane.testIds.dom.test.tsx` pins it on a real render | `track-header-resize` |
| H8 | **fixed in code, unverified** | an unmatched wheel `NSEvent` is rebuilt at `windowless_event_location` so its `locationInWindow` is the window-space point (`native.wheelLocationCorrected`); the observer records `observed.lastWheel`; the runner FAILS a wheel that lands more than 3 px from its aim. The check, not the fix, is what the next run proves. | any wheel scenario with the window moved off screen (0,0) |
| H9 | **fixed** | `slip-tool` watches the clip's filmstrip tiles (`<clip> img`) and expects their `x` to change during the drag; it FAILS today by design (B-345) | `slip-tool` fails on that one check |
| H10 | **fixed** | `pressedButtonsOverride` is true only when a button is held when the call begins or an event in it holds one (`override_in_effect`) | a `move` / `key` / `wheel` reply says false |

### D-434's "verify live first" answers

| item | answer |
|---|---|
| trusted events | yes: `observed.trusted` equals every event, `untrusted` 0, for pointer, key and wheel in native mode |
| `native.mouseMovePath` | `simulateMouseMove` (the SPI exists in the shipped WebKit), but a buttonless move only arrives while the window is key (H5) |
| `native.wheelWindowMatched` | **false** (H8); events arrive and x is right only because the window starts at screen x 0 |
| `native.magnifyBuilt` | built: `zoom-trackpad-pinch` zoomed 155 → 480 px/s (a non-built gesture is refused loudly) |
| keys while not key | yes: `debug_key` Escape with `windowKey: false` gave a trusted keydown + keyup, focus on `body`; `trim-tool-shortcuts`, Space, arrows and M all pass |
| occlusion throttling | with `_setWindowOcclusionDetectionEnabled:NO` the window kept running rAF while not key: 40–53 frames per 450–600 ms gesture, p50 16–17 ms. A fully covered window was not separately tested |

### Perf picture

All numbers native, first run unless marked "rerun". Budget: p95 ≤ 33.3 ms, worst ≤ 50 ms,
dropped ≤ 10 %, input→frame p95 ≤ 50 ms.

| gesture | p95 | worst | dropped | input→frame p95 |
|---|---|---|---|---|
| slide b 15 frames | 27 / **37** (rerun) | **90** / **76** | **20 %** / **15 %** | **79** / **68** |
| slip b 15 frames | 27 / **35** | **75** / **65** | **17 %** / **12 %** | **72** / **58** |
| ripple trim | 21 / 22 | **72** / **67** | 9 % / 7 % | **62** / **60** |
| roll | 21 / 27 | 38 / **72** | 2 % / **12 %** | 37 / **57** |
| Alt smart trim | 27 | 44 | **12 %** | 38 |
| plain trim, right / left | 27 / 21 | **53** / **53** | 10 % / 5 % | 47 / 41 |
| move across tracks | 28 | **57** | 8 % | **52** |
| linked A/V move | **44** | 45 | **18 %** | 44 |
| marquee | 28 | 30 | **18 %** | 18 |
| scrub (rerun) | 30 | 33 | **12 %** | 21 |
| zoom buttons / ctrl+wheel / pinch | **38** / **48** / **46** | 38–48 | 29–64 % of 7–14 frames | 7–33 |
| within budget | same-track move, clicks, ruler seek, scrolls, keys, playback (28.8 paint fps, 50 rAF fps) | | | |

Medians are 16–17 ms everywhere: the misses are spikes, mostly at release (commit) and on the
first moves. Likely causes from the code (B-347): the commit re-renders the whole
`TimelinePane` (no memo boundary; D-201's notes say the compiler bails out); the library's
interact.js resize writes `left`/`width` per move; dnd-kit re-renders `useDraggable` consumers
per move; zoom re-lays out every clip and its filmstrip in one frame. Not profiled yet: a
Performance trace of one slide drag is the first step of the fix.

### Fix-wave proposal

- **Harness wave (Sonnet, small):** H1–H10. H1 and H2 first, they masked 13 scenarios. H5 and
  H8 touch `debug_input.rs` (Rust/AppKit, worth Opus if the `mouseMoved:` route does not work).
- **Wave A, trim correctness (Opus):** B-344. Owning the edge position from the absolute pointer
  offset is the same machinery P2's trim bracket needs, so do it as P2's first slice rather than
  patching the library.
- **Redesign P2 (Opus, sequential with P3 on `TimelinePane.tsx`):** B-345 (live edit preview +
  two-up), B-346 (playhead hit strip), B-342 (z-index layer tokens), and the B-347 measurements
  as its acceptance bar.
- **Standalone, now (Sonnet):** B-343 (clear or scope `@apelles/history` per project: one hook at
  project open, plus a test). Needs no design.
- **Owner call, then Sonnet:** B-341 (where the Agent activity dock lives in the Edit tab), unless
  it waits for P5.
- **Roadmap (B-348):** keymap additions (J/K/L, I/O, ↑/↓, Shift+Delete, `=`/`-`, N snapping) are
  one Sonnet wave with their MCP tools; blade tool and marker drag are P2/P3-sized.

## Second live run (2026-10-31, after D-432 P2)

Run `scratch/ui-harness/runs/2026-10-31T18-56-56-222Z/` (50 scenarios, native): **29 pass,
19 fail, 2 skip**, perf over budget in 14 of 24 measured steps. All seven edit-tool
scenarios pass on correctness (B-344 and B-345 confirmed fixed live) and the Blade tool is
reachable. Triage reran every non-pass from a scratchpad script that imports the runner, in
a throwaway project. Each scenario was prefixed with `pickTool('select')`, focus targets
were moved inside the visible edit area, and the hover pair was run with Apelles frontmost.
Custom probes: a scrub from the head band, a scrub from the ruler, a select off the
playhead line, and a drag starting on the line. The owner's project was reopened afterwards.

### Classification of the 21 non-passes

| scenario | class | evidence → finding |
|---|---|---|
| `split-at-playhead-shortcut` | **real** | B-349: the press lands on the 1 px `div.timeline-editor-cursor` (the playhead is at `b`'s centre). A drag starting on the line over a clip moves the playhead 135 → 155. Off the line, select + Cmd+K splits |
| `scrub-playhead-drag` | harness, then real | H16: the target is the ruler (H4), but P2 made the head band the grab zone. From `.timeline-editor-cursor-area` it scrubs live (21 distinct x values, ends at 200). Behind it: **B-350**, a ruler drag does not scrub (Premiere and Resolve do) |
| `clip-body-hover-cursor` (SKIP) | harness, then real | H15, then **B-351**: with the app frontmost, the cursor is `pointer` (dnd-kit's `role="button"` + the base rule), not the arrow D-432 specifies |
| `track-header-present` (SKIP) | harness | H15: PASS with the app frontmost |
| `select-cmd-click-toggles`, `select-shift-click-range` | harness | H11: clip `c`'s centre (x ≈ 1197) is under the Inspector, so the press lands on `div.flex.flex-col.gap-2.5`. PASS with Select forced and the clip visible |
| `select-marquee` | harness | H11: the drag starts at frame 220 (x 1182), past the edit area's right edge (1149), on the Inspector. Started at frame 200: the band grows and selects all 3. **Not a P2 regression** |
| `select-click-empty-deselects` | harness | H11: "empty space" at frame 260 is on the Inspector. PASS inside the edit area |
| `marker-add-key-m`, `key-space-play-pause`, `key-arrows-frame-step` | harness | H11: "focus the timeline" at frame 400 is x 1722, outside the 1470-px viewport. All PASS with an on-screen focus click |
| `linked-av-select-one-half` | harness | H13: looks for `outline-dashed`; P2 drew the partner as a solid 1 px `before:outline-selection/55`, as spec §4.3 says ("solid, not dashed"). Selection and Delete-takes-both pass |
| `track-header-resize` | harness | H14: `elementFromPoint` at the 1 px separator is `.timeline-editor-edit-row`, but `react-resizable-panels` resolves its separator by proximity, and the column grew 185 → 215 |
| `trim-two-up-viewer`, `move-snapping-toggle`, `ripple-delete-shortcut`, `zoom-keyboard`, `marker-drag-move`, `key-jkl-shuttle`, `key-in-out-marks`, `key-edit-point-navigation` | missing | B-348, unchanged by P2 (rechecked: no ids in `SHORTCUTS`; the two-up viewer is listed as "not built in P2"). The keyboard ones also hit H11 first |

**Counts:** real 1 primary + 2 found behind harness defects (B-349, B-350, B-351) · missing
feature 8 · harness 12 primary. **Regressions from P2: none.** B-349 is an incomplete
B-346 fix, and B-351 is a P2 spec item not reached.

### Harness defects and the fix each needs (second run)

| # | defect | fix |
|---|---|---|
| H11 | Frame and element targets are not checked against the edit area's **visible** rect. At 1470×923 with Sources and the Inspector open, the edit area is x 490–1149 (frames ≈ 0–209 at 90 px/s). The hard-coded "focus" frames 400 / 260, the marquee start (220) and a partly hidden clip's centre land outside the viewport or on the Inspector. It hit 11 scenarios (the first run's "PASS on rerun" for these was at a different window/layout) | `resolveTargetRef`: fail with "outside the timeline's visible area" when a resolved point is outside the edit area rect; clamp an element target's `fx` to the part of it that is inside; pick focus and empty-space points from the fixture (an empty track, a frame just past the last clip) rather than fixed far frames **Status 2026-11-01: done.** `visibility.ts` + `ScenarioRunner`: a frame-addressed target outside the visible edit area (the edit-area rect inset 16 px) is brought into view by `editor_set_timeline_view` (zoom out) and resolved again; a clip target whose press point is outside is moved onto the visible part of the clip; anything that cannot be shown is an ERROR naming the visible area, never a blind press. `resolveTargetRef` itself throws `OutsideVisibleArea`. Unit-tested (`method.test.ts`, `runner.test.ts`); not run live. The fixed far frames (400 / 260 / 220) now zoom the timeline out for the rest of that scenario rather than being rewritten. |
| H12 | The trim tool leaks between scenarios (`TimelinePane`'s `useState` outlives timeline and project switches): Roll stayed active from `trim-two-up-viewer` to the end of the run | `buildFixture` resets the tool: press V, or a new `editor_set_tool` MCP op (already a parity gap in `ui-redesign.md` §7) **Status 2026-11-01: done.** `editor_set_tool` (both MCP servers, parity corpus, tool count 264 on its branch, 266 once merged with D-432 P3's two) reads or sets the tool through `useTimelineViewStore.trimTool`, the store the toolbar and the V/B/T/Y/U/C shortcuts now use (Roll is T since D-432 P3); `buildFixture` also resets zoom, clip height, balance, names, badges, snapping and skimming through `editor_set_timeline_view`. ; `buildFixture` sets Select through it for every scenario. |
| H13 | `linked-av-select-one-half` matches a class substring that P2 changed | a stable hook on the partner (`data-chroma-link-partner` on `ClipBody`, an app change) and target that **Status 2026-11-01: done.** `ClipBody` carries `data-chroma-link-partner` on the selected clip's linked A/V partner (4 lines in `TimelinePane.tsx`); the scenario targets it. |
| H14 | The separator press check cannot pass for `react-resizable-panels` (proximity hit) | `expectHit: false` on that drag; keep the width assertion **Status 2026-11-01: done.** The drag sets `expectHit: false`; the width assertion stays. |
| H15 | H5's `makeKeyWindow` does not take while Apelles is not the active app (`madeKeyForMove: false`); with Apelles frontmost the moves arrive | the CLI activates the app at start and restores the previous front app at the end, through a debug-gated op (`NSApp activate` + `makeKeyAndOrderFront`) **Status 2026-11-01: done in code, not run live.** `debug_activate_app` (native, `chroma::debug_input`, compile-gated like the rest; control op only, no MCP tool, like `debug_clear_harness_history`) activates the app and makes its window key and reports the previous front app; the CLI calls it after switching to the Edit tab and again with `restorePid` at the end (`--no-activate` skips it). `activation.ts`. **2026-11-01 (B-352):** `debug_activate_app` now answers an error, naming the frontmost app, when activation did not take; the CLI stops early on `loginwindow`. |
| H16 | `playheadGrab` aims at the ruler, which only seeks on release | aim at `.timeline-editor-cursor-area` (the head band) until B-350 / P3's ruler scrubs **Status 2026-11-01: done.** `playheadGrab()` is `.timeline-editor-cursor-area` (new `TIMELINE_LIBRARY_SELECTORS.playheadBand`); the scrub scenario no longer sets `expectHit: false`. B-350 (ruler drag does not scrub) is still open. |
| H17 | Perf method: the rect `watch` forces a layout per frame (+5–25 ms p95); ~40 frames per gesture makes p95 the second-worst frame; no wait for idle after a big fixture; dev build | `docs/notes/timeline-drag-perf.md` F6 **Status 2026-11-01: done.** See "Perf method" below. |

**Window note:** one triage batch run with the Inspector closed
(`debug_set_editor_inspector {open:false}`) sampled 0 frames on every measured step. A
direct check right after it (same calls) sampled frames normally, so it is recorded as not
reproduced, not as a defect.

### Perf method (B-347 F6, H17: what a measured step does now)

- **No rect watch on a measured step.** The per-frame `getBoundingClientRect` forced a layout
  every frame (+5-25 ms of p95). A step with both `watch` and `measure` runs without the watch;
  its `live` / `cursor` checks pass as "skipped" and say so. `--evidence` keeps the watch
  (and the scenario's own gesture shape) to take those checks; its frame numbers are then
  inflated and the report says so.
- **A gesture long enough for a p95.** A measured drag or path move is stretched to at least
  1.5 s at about 33 moves a second (~90 frames instead of ~40), endpoints unchanged
  (`perfMethod.ts`).
- **Move and release are judged apart.** `debug_pointer`'s `perf` now carries `phases.move` and
  `phases.release`, split at the `pointerup` (`observe.ts` records it, `stats.splitFramePhases`
  divides the frames). The move phase is held to the p95 / worst / dropped budgets, the release
  frame to `releaseMaxMs` (50 ms) on its own, so one commit spike no longer decides p95.
- **Idle first.** Before a measured step the runner calls `debug_perf_entries {waitIdleMs: 400,
  clear: true}`: it waits (at most 5 s) for 400 ms of on-time frames, so the filmstrip and
  waveform requests a big fixture queued do not land in the measurement.
- **Exact per-phase numbers.** After the step the runner reads the `apelles:edit:*` marks
  (`editPerf.ts`) and attaches `previews`, `previewP50Ms`, `previewP95Ms`, `commitRenderedMs`,
  `commitEffectsMs`, `commitFrameMs`, `commitPaintedMs`, `paintMs` (= painted - frame, the
  paint+composite estimate), plus `moveP95Ms`, `moveMaxMs`, `releaseMaxMs` to the step. D-437
  S0a made the marks mean what they say: `commitPaintedMs` used to stop at the next rAF
  callback (before that frame's style/layout/paint) and is now rAF then a `MessageChannel`
  task; the old measure is `commitFrameMs`. The marks exist in `vite dev` and in a
  `tauri build --debug` bundle (production React); a release build writes none. They are null
  only in a release bundle.
- **Measure what ships.** The report names the web bundle it saw (`debug_perf_entries
  build.dev`). A `tauri dev` app serves the Vite DEVELOPMENT bundle: React dev Performance
  Tracks (~22 % of the release at 200 clips) and StrictMode's double render. For shipping
  numbers build `cd app && npm run tauri build -- --debug` (Rust debug, so the `debug_*` ops
  exist, with the production web bundle), start that app with `CHROMA_CONTROL_PORT=<free port>`
  if the dev app is running, and point the harness at it with `--port`. See "Baseline recipe" below for
  the exact commands (D-437 S0c).

### Baseline recipe (D-437 S0c: the 300-clip perf run, dev and production bundle)

**What is measured.** `perf-300-*` (12 scenarios in `src/scenarios/perf300.ts`: select trim,
ripple, roll, slip, slide, a clip move, three zooms, both scrolls, playback) on `BIG_300`
(`src/bigFixture.ts`: 300 clips on 8 tracks: 5 video, 3 audio; mixed lengths 30-150 frames with
small gaps, the first four clips of every track butted; 20 linked A/V pairs on video track 0
whose audio halves land on the first audio track; 4 markers; 2 cross dissolves; clip names
`t<track>c<index>`). `bigFixtureSpec({clips, tracks})` makes other sizes. The family is opt-in
(`optIn`): a run with no `--filter` leaves it out; `--filter perf-300` runs it. It builds the
300-clip timeline once per scenario (about 300 `editor_add_clip` calls), so expect a minute or
two per scenario. The scenarios assert almost nothing: they measure. Each step's numbers
(frame p95 / worst / dropped, `moveP95Ms`, `releaseMaxMs`, `commitRenderedMs`, `commitEffectsMs`,
`commitFrameMs`, `commitPaintedMs`, `paintMs`) are in `report.md` / `report.json`.

**1. The development bundle (the running `npm run tauri:dev`, control port 19788).** From the
repo root, with Apelles open and nothing modal:

```sh
mkdir -p scratch/perf-baseline
npm run harness --workspace @apelles/ui-harness -- --filter perf-300 \
  --out "$PWD/scratch/perf-baseline/dev"
```

The report's notes say `web bundle: DEVELOPMENT`.

**2. The production bundle (`tauri build --debug`: Rust debug, so the `debug_*` ops exist; the
web bundle is production React).** Needs about 8 GB free (the workspace `target/debug`, opt-level
3 dependencies) and network for `build.rs`'s pinned `uv`/`ffmpeg` fetch on a fresh checkout. Two
things stop a second Apelles from simply running next to the dev one, and the recipe handles both:
the single-instance plugin (a second launch hands over to the first and exits, keyed on the bundle
identifier) and the control port. So the build gets its own identifier, and is started on its own
port. The default `beforeBuildCommand` also builds a release `apelles-mcp` and the Motion pack,
neither of which a debug bundle uses; the override keeps only the web build.

```sh
# from the repo root
npm run tauri --workspace app -- build --debug --bundles app \
  --config '{"identifier":"studio.apelles.perf","build":{"beforeBuildCommand":"npm run build"}}'

# prove the bundle carries the perf marks (Tauri sets TAURI_ENV_DEBUG=true for the before-command)
grep -l 'apelles:edit:' app/dist/assets/*.js

# start it beside the dev app, on its own control port
open -n --env CHROMA_CONTROL_PORT=19790 target/debug/bundle/macos/Apelles.app

# confirm which bundle answers: build.dev must be false, build.perfMarks true
curl -s -X POST localhost:19790/op -d '{"op":"debug_perf_entries","args":{}}' | grep -o '"build":{[^}]*}'

npm run harness --workspace @apelles/ui-harness -- --filter perf-300 --port 19790 \
  --out "$PWD/scratch/perf-baseline/prod"

# quit the perf build (by its identifier, so the dev app is untouched)
osascript -e 'tell application id "studio.apelles.perf" to quit'
```

(The control server's `/op` request shape is whatever `ControlClient` in `src/client.ts` sends;
the `curl` line is a convenience, the harness's own first note says the same thing.) A release
`npm run tauri:build` bundle writes no marks and has no `debug_*` ops, so it cannot be measured
this way: that is the gate working.

**3. Paint evidence for the same gestures** (S0b): `debug_set_webkit_layer_debug(borders=true,
repaint_counters=true)`, start a gesture with `debug_pointer`, `debug_screenshot` mid-gesture,
then turn both flags off. For the paint / layer-flush / JS split of a release and a ripple move,
`sample` the WebContent process during a 1.5 s gesture as in `docs/notes/timeline-drag-perf.md`.

**Status 2026-11-01:** the fixture, the scenarios and the recipe are in; no baseline was run in
this pass (the machine's free disk was below the 8 GB the production build needs, and the running
dev app was off limits for the agent that wrote this). The numbers go in the "Baseline" section
of `docs/notes/timeline-lanes.md` with the run directories above.

### Perf picture (second run)

Profiled for real in `docs/notes/timeline-drag-perf.md`: per-gesture × clip-count tables,
`sample` profiles of the WebContent process by phase, controls (watch, throttling, focus,
input rate), ranked causes and fix plan F1–F6.
