# eval/ — Apelles grading-agent eval harness

A regression + capability test for the **grading agent** (its MCP tools + the
grading skill + its prompt): does it *grade by the numbers* — measure scopes,
adjust, re-measure, converge on a target — or does it confidently drift?

It is **not** a feature users see. See `docs/notes/eval-harness.md` for the full
rationale and `docs/08-decisions.md` D-035.

## Run the offline scorer (no app, no agent, no network)

```sh
node eval/lib/scopes.check.mjs        # tripwire: the ported scope math vs scopes.ts
node eval/score.mjs eval/results      # score the committed sample grades
node eval/score.mjs eval/bad_examples # the deliberately-wrong control set
```

`score.mjs` prints a per-task table (score in [0,1] + per-check breakdown) and a
rollup, then diffs against `eval/baseline.json` and **exits 1 on any regression**
(a task > 0.05 below its committed baseline). That is the CI gate:

```sh
node eval/lib/scopes.check.mjs && node eval/score.mjs eval/results
```

Other modes:

```sh
node eval/score.mjs --baseline   # (re)write baseline.json — the unfixed floor
node eval/score.mjs --scopes     # dump computeScopes for every fixture
node eval/fixtures/_gen.mjs      # regenerate the fixture frames
```

## Run the full closed loop (needs the running app + a live agent)

See `eval/run.md`. Short version: per task, `open` the fixture in Apelles, hand
the agent the task's `description` + goal, let it work, `save_grade` to
`eval/results/<id>.grade.json`, then run the scorer.

## What's committed

| path | what |
|---|---|
| `tasks.json` | the 7 tasks (data) |
| `fixtures/*.png` | 480×270 test frames + `_gen.mjs` to rebuild them |
| `baseline.json` | the floor — every task scored with the setup grade left unfixed |
| `results/*.grade.json` | 7 hand-authored "good" grades (mean 0.975 vs baseline 0.452) |
| `bad_examples/*.grade.json` | deliberately wrong grades (mean 0.0, gates fire) |
| `lib/` | the PNG codec, the ported scope math, the approximate grade operator |

## The one big caveat

`lib/apply.mjs` is an **approximate** primary-grade operator, not RapidRAW's
pipeline (that's WGSL and not portable here). So **absolute scores are only
meaningful relative to each other and to the baseline** — every number in the
harness goes through the same operator. It ignores curves / wheels / LUT / HSL,
so the tasks are authored to be solvable with primary knobs (the same scope as
`match_to_reference`, D-026). Fidelity to the real engine is `eval/run.md`'s job.
