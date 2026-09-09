# eval/run.md — the closed-loop run

The full loop — open a clip → drive the grading agent over MCP → agent saves
`grade.json` → score it — needs the **running app** and a **live agent**, so it
is a runbook, not CI. The CI-able part is `node eval/score.mjs eval/results`
(see `eval/README.md`). Do this run when you change the MCP tools, the grading
skill, or the agent prompt, and want to know if the agent got better or worse.

## Prereqs

- Apelles desktop app running (`cd engine && npm run tauri dev`), a clip/still
  open is not required — the runbook `open`s each fixture.
- The MCP server reachable (`mcp/server.py`, control server on
  `127.0.0.1:19788`).
- The agent loaded with the grading skill / prompt under test.

## Per task

For each task in `eval/tasks.json`:

1. **Load the fixture.** `open` with the absolute path to
   `eval/fixtures/<input.frame>`. (These are 480×270 PNG stills — `seek` is a
   no-op, `frame` args are ignored.)

2. **Reset to the setup grade.** `tasks.json` records each task's `setup`
   ("neutral" or a baked offset). The fixture *already has the setup baked into
   the pixels* — so just make sure the live grade is neutral: `load_grade` a
   neutral doc, or `set_primary` everything to 0 / delete masks via
   `get_state` → `delete_mask`.

3. **Hand the agent the brief.** Give it the task's `description` and its goal:
   - `goal.type: "reference"` → the reference image path
     (`eval/fixtures/<goal.reference>`) — the agent should use
     `inspect_color(reference=…)` and/or `match_to_reference`.
   - `goal.type: "rubric"` → the pass/fail checks in `goal.checks` (black point,
     white point, clip %, region deltas). The agent works to those.
   Do **not** tell it the tolerances or the scoring — the point is whether its
   own measure→adjust→re-measure loop lands in tolerance.

4. **Let it work.** It should: `inspect_color` before, reason from the numbers,
   `set_primary` / `set_curve` / `set_mask_adjust` / `match_to_reference`,
   `inspect_color` after, iterate, and `request_human` only for a genuine
   creative call.

5. **Save the result.**
   - `save_grade("<repo>/eval/results/<id>.grade.json")`.
   - Optionally also save the app's real render for a fidelity-accurate score:
     capture the rendered frame (the last mutating tool's returned image, or
     `inspect_color`) and write it to `eval/results/<id>.result.png`. When
     present, `score.mjs` scores *that* instead of re-applying the grade.json
     with the approximate operator.

6. **Reset for the next task** — neutral grade, `delete_mask` any masks.

## Score

```sh
node eval/lib/scopes.check.mjs
node eval/score.mjs eval/results
```

Read the table: each task's score, the per-check breakdown (`id:score`, `*` =
over tolerance), any `GATE:` flag, and the rollup vs `eval/baseline.json`.

## Interpreting a run

- **Every task should beat its baseline** (the committed `eval/results/` grades
  do — mean 0.975 vs 0.452). A task at or below baseline = the agent did not
  move it toward the target.
- **A `GATE:` flag is a hard fail** — the agent introduced clipping, moved a
  masked task's background, or over-graded. That is worse than doing nothing.
- **`dont_overgrade` is the anti-drift check** — its baseline is 1.0. If the
  agent's score there drops, it is "improving" a frame that was already right.
- **Regressions exit 1.** If a tools/skill/prompt change drops a task > 0.05
  below baseline, `score.mjs` fails. Either the change is bad, or the baseline
  is stale — if the latter, re-run `--baseline` in the same commit and say why.

## Updating the task set

- New task → add to `tasks.json`, add its fixture (extend `fixtures/_gen.mjs`,
  re-run it), re-run `--baseline`, commit all three + the note.
- Changed `scopes.ts` → update `eval/lib/scopes.mjs` to match,
  `node eval/lib/scopes.check.mjs` must pass, re-run `--baseline`.

## `depth_haze_tracked` — manual closed-loop check (D-036, not scored)

The offline scorer is primary-only (no masks / depth), so the depth track can't
be a `tasks.json` entry. Run this by hand when you touch `/depth_track`, the
render-time depth hook, or `apply_haze`:

1. `open` a **moving-camera** clip — `scratch/pexels_28808272.mp4` (4K daylight
   street walk, strong fg/bg depth) or `scratch/Tokyo-Walk_rgb.mp4`.
2. `apply_haze({})` → the static single-frame bake. `seek` forward ~2 s and
   `sample_region` a far-background patch vs a near-subject patch. The haze band
   is now misaligned — it sits where the camera *was* (this is the bug D-036
   fixes).
3. `depth_track()` (or the "Track depth over clip" button). Poll
   `depth_track_status` until `tracked: true`.
4. `seek` across the same range. Expected: the haze band **tracks the camera** —
   far stays milky/soft, the near field stays clear, and consecutive frames
   don't shimmer. `sample_region` the same two patches at 2–3 timecodes: the
   background-vs-subject luma/saturation gap should hold roughly constant, not
   swing frame to frame.
5. `export({kind:"h264", from_frame, to_frame})` a short range → the graded MP4
   shows per-frame depth (export reads `chromaDepthDir` through the same hook).
6. Regression: a **still** + a depth mask with no `chromaDepthDir` must render
   exactly as before (the Rust `chroma::depth` tests cover the read logic;
   `ai/test_depth_track.py` covers the sidecar output).

A rubric-only scored task (rendered result-frame background-vs-subject
separation) is possible later if `score.mjs` grows a mask-aware operator — kept
light for now, per D-036.
