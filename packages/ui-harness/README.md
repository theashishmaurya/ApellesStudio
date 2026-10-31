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

Needs a running **debug** build of the app (`npm run tauri:dev`). It never edits the
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
| `src/runner.ts` | plays a scenario's steps and judges them (PASS / FAIL / SKIP / ERROR + perf) |
| `src/assertions.ts` | the pure judge: paths, references, operators, live feedback, cursor |
| `src/snapshot.ts` | timeline / view state shaped for assertions; frame ↔ pixel arithmetic |
| `src/budgets.ts` | the performance budgets, each a named constant |
| `src/targets.ts` | named places on the timeline (built on `@apelles/editor`'s `timelineTestIds.ts`) |
| `src/report.ts` | the markdown report |
| `src/scenario.ts` | the scenario / step types |
| `src/scenarios/` | the starter suite: `editTools.ts` (trim, ripple, roll, slip, slide, split, blade, two-up) and `timeline.ts` (seek, selection, moves, linked A/V, delete/undo, zoom, scroll, header column, markers, keyboard transport, playback) |

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
