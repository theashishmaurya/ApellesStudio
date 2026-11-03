# @apelles/ui-harness

**The Edit-timeline UI test + measurement harness (D-434).** Runs scenarios against the
LIVE app — real pointer/keyboard input through `debug_pointer` / `debug_key`, assertions on
store and DOM state, frame-time and latency budgets — and writes a markdown report with
screenshots.

```bash
npm run harness --workspace @apelles/ui-harness                  # the whole suite
npm run harness --workspace @apelles/ui-harness -- --filter roll # by id / area
npm run harness --workspace @apelles/ui-harness -- --list
```

Flags: `--evidence` keeps the per-frame rect watch on measured steps (live-feedback checks;
its frame numbers are inflated), `--no-activate` leaves the front app alone, `--port` targets
another app instance (e.g. a `tauri build --debug` one for production-bundle numbers).

Needs a running **debug** build of the app (`npm run tauri:dev`, or `tauri build --debug`
for numbers from the production web bundle). It brings Apelles to the front for the run
(hover needs a key window) and hands the front back at the end. It never edits the
owner's projects: it opens a scratch `ui-harness-<stamp>` project with generated ffmpeg
test media, builds one fresh timeline per scenario, and on the way out reopens the
original project and deletes the scratch one. Full guide — running, writing scenarios,
budgets, test ids, known limits: **`docs/notes/ui-harness.md`**.

## Layout

| file | what it is |
|---|---|
| `src/cli.ts` | the entry point: setup, run, restore, write `report.md` / `report.json` / `shots/` |
| `src/client.ts` | `POST /op` to the app's control server (19788) |
| `src/fixture.ts` | test media, the scratch project, per-scenario fixture timelines |
| `src/bigFixture.ts` | `bigFixtureSpec({clips, tracks})`, the deterministic 300-clip / 8-track perf fixture (D-437 S0c) |
| `src/runner.ts` | plays a scenario's steps and judges them (PASS / FAIL / SKIP / ERROR + perf) |
| `src/assertions.ts` | the pure judge: paths, references, operators, live feedback, cursor |
| `src/snapshot.ts` | timeline / view state shaped for assertions; frame ↔ pixel arithmetic |
| `src/budgets.ts` | the performance budgets, each a named constant |
| `src/targets.ts` | named places on the timeline (built on `@apelles/editor`'s `timelineTestIds.ts`) |
| `src/report.ts` | the markdown report |
| `src/perfMethod.ts` | how a measured step is run (no watch, stretched gesture, idle first) and the `apelles:edit:*` mark summary |
| `src/visibility.ts` | keeps targets inside the visible edit area (H11) |
| `src/activation.ts` | brings the app to the front for a run and hands it back (H15) |
| `src/scenario.ts` | the scenario / step types |
| `src/scenarios/` | the starter suite: `editTools.ts` (trim, ripple, roll, slip, slide, split, blade, two-up) `perf300.ts` (the opt-in 300-clip baseline, `--filter perf-300`), `timeline.ts` (seek, selection, moves, linked A/V, delete/undo, zoom, scroll, header column, markers, keyboard transport, playback), `redesign.ts` (the v0.3.0 gap closure) and `panels.ts` (the v0.3.0 panel redesigns: Export preset chips + an MCP-saved preset in the open sheet, Music edits fade-dot drag on the marked range, the Clipper surface in the viewer area — D-441 / D-444 / D-445) |

## Boundary

- **Depends on** `@apelles/editor`'s `timelineTestIds.ts` (the test-id catalog) and
  `@apelles/debug`'s `input/stats.ts` (the shared percentile arithmetic) — both imported by
  file, pure TS with no imports of their own, so nothing else from those packages loads.
- **Is not app code.** Nothing in `app/` or `packages/` imports it; it runs in Node (type
  stripping, Node ≥ 23.6 — the repo runs 24), talks to the app only over HTTP, and is never
  bundled.
- **Does not** decide what the app should do — scenarios encode NLE behaviour with their
  references — and does not fix anything; phase 2 runs it and logs `B-NNN`s.

## Testing

`npm run test --workspace @apelles/ui-harness` — assertions, snapshots and the frame ↔
pixel arithmetic, budgets, the report, and the real `roll-edit-tool` scenario run against a
fake app: PASS for a correct roll, FAIL with the specific findings for a broken one.
