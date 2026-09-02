# notes/eval-harness.md — the agent eval harness

Round-3 tail item. Built 2026-09-02. See `docs/08-decisions.md` **D-035** (the
call), `docs/notes/agent-visual-feedback.md` (the thesis it tests),
`docs/notes/scopes.md` / `app/src/utils/scopes.ts` (the ground-truth math the
scorer ports), `docs/notes/match-reference.md` (D-026 — the workflow task (b)
mirrors).

## Why

The thesis: a grading agent must **grade by the numbers** — measure scopes,
adjust, re-measure, converge on a target — not glance at a preview and say "looks
good". The harness is how we know the agent (its MCP tools + the grading skill +
its prompt) actually does that and gets **closer** to a target instead of
confidently drifting. It is a regression + capability test for the agent, not a
feature a user sees.

## Shape — `eval/` (parent repo, new top-level)

```
eval/
  tasks.json            the task set (data — 7 tasks)
  score.mjs             the offline scorer + regression gate  ← CI-able
  baseline.json         the committed floor (setup grades left unfixed)
  run.md                the closed-loop runbook (needs the app + a live agent)
  README.md             how to run it
  lib/
    png.mjs             dependency-free PNG decode/encode (Node zlib only)
    scopes.mjs          STANDALONE PORT of scopes.ts (computeScopes/Gap/gapMagnitude)
    scopes.check.mjs    drift tripwire: port constants vs scopes.ts
    apply.mjs           APPROXIMATE primary-grade operator (grade.json → result frame)
  fixtures/
    _gen.mjs            regenerate the frames
    *.in.png etc.       480×270 test frames (committed)
  results/              7 hand-authored "good" grade.json (committed sample)
  bad_examples/         deliberately wrong grades (committed — proves good ≫ bad)
```

## The two halves

**Closed loop (`eval/run.md`) — manual / CI-with-an-agent.** Per task: `open` the
fixture in the running app, hand the agent the task's `description` + goal, let it
work its measure→adjust→re-measure loop, `save_grade` to
`eval/results/<id>.grade.json` (and optionally save the rendered frame as
`eval/results/<id>.result.png`), then run the scorer. This is the check against
the **real engine render** + real `inspect_color` numbers.

**Offline scorer (`eval/score.mjs`) — the CI-able part.** No app, no agent, no
network.

```
node eval/score.mjs eval/results     # score a results dir vs tasks.json + baseline.json
node eval/score.mjs --baseline       # (re)write baseline.json = the unfixed floor
node eval/score.mjs --scopes         # dump computeScopes for every fixture (debug)
node eval/lib/scopes.check.mjs       # fail if the port drifted from scopes.ts
```

For each task the scorer resolves a *result* in priority order:
`<id>.result.png` (a real render) → `<id>.grade.json` (applied to the fixture via
`apply.mjs`) → `--baseline` (identity: the setup left unfixed). It computes
`computeScopes` on the result and scores it against the task goal.

## The approximate operator (`apply.mjs`) — the trade-off

The real grade runs in WGSL in the engine and is not portable here. `apply.mjs`
models the **primary balance subset** the agent works in (exposure / contrast /
temperature / tint / saturation / black & white points / hi-lo tone regions,
plus radial & rect masks) with simple monotone pixel ops.

Consequences, by design:

- **Absolute scores are only comparable *within* the harness** — baseline,
  "good", and agent results all go through the same operator.
- A `grade.json` leaning on **curves / wheels / LUT / HSL is under-applied** (the
  operator ignores those knobs). Tasks are authored to be solvable with primary
  knobs — the same scope as `match_to_reference` (D-026).
- Absolute fidelity to the engine is `eval/run.md`'s job (it scores the app's
  real render). The offline scorer's value is a **deterministic regression gate**:
  did a change to the tools / skill / prompt move the agent's grades toward or
  away from the targets, vs the committed floor.

`scopes.mjs` is a **verbatim** port of `scopes.ts`'s constants (REC709 weights,
512-px downsample, zone splits, percentile points, clip rails, cast formulas,
`computeGap` exposure term). `scopes.check.mjs` string-compares those constants
against `scopes.ts` and fails on drift — run it in CI alongside `score.mjs`.

## Scoring

Per check (`{ id, metric, max? | min?, slack?, region? }`): the score is the
**normalised inverse of the residual gap** — `1` when the metric is within
tolerance, `0` when the result is no better than the unfixed baseline value
(computed live from the fixture), linear between. When the baseline already
passes a check (e.g. `dont_overgrade`), the check instead penalises *moving away*
from tolerance, scaled by `slack`.

Task score = mean of check scores, then zeroed by any **hard-fail gate**:

| gate metric | fires when |
|---|---|
| `clipIntroduced` | result adds > N% luma/channel clipping vs the input |
| `knobEffort` | Σ\|primary knob\| in the grade.json exceeds the cap (over-grade) |
| `blackPointDeltaToInput` (clip task) | shadows crushed to "fix" the highlights |
| `midsLumaDeltaToRef` (cast task) | exposure moved while "just" fixing a cast |

Rollup: mean score, pass count (`score ≥ task.passThreshold`), and a diff vs
`baseline.json` — **exit code 1 on any task > 0.05 below its baseline**.

## The task set (`eval/tasks.json`)

| id | goal type | what it checks |
|---|---|---|
| `neutralise_cast` | reference | kill a warm+green cast; cast deltas to a neutral ref small; exposure/contrast barely move |
| `match_shot_to_ref` | reference | the D-026 workflow — pull a cool/dark/flat shot to a warm/bright hero ref; `gapMagnitude` ≤ 20 |
| `set_black_white_points` | rubric | black → ~0, white → ~245, no clipping either end |
| `fix_exposure` | reference | recover a −1.1 EV frame to the correctly-exposed ref; no crush, no clip |
| `dont_overgrade` | rubric | frame is already right — `knobEffort` ≤ 6, every scope within ε of the input; gate hard-fails a confident over-correction |
| `mask_region_only` | rubric | correct a bright warm patch through a radial sub-mask; background provably unmoved (3 corner regions) |
| `tame_highlight_clip` | rubric | pull blown highlights back under the clip point without crushing the shadows |

## Numbers as built (2026-09-02)

- `baseline.json` (setup unfixed): mean **0.452**, pass **2/7** (`dont_overgrade`
  1.0, `mask_region_only` 0.75 — their floor is genuinely high).
- `eval/results/` (7 hand-authored good grades): mean **0.975**, pass **7/7**,
  every task up vs baseline (`neutralise_cast` 0.00→0.94, `fix_exposure`
  0.33→1.00, `tame_highlight_clip` 0.33→1.00, …).
- `eval/bad_examples/` (desaturate-to-hide-a-cast, exposure +2.4, punch-up an
  already-fine frame): mean **0.0**, gates fire (`clipIntroduced=15.7`,
  `knobEffort=77`).

So the scorer ranks good ≫ bad in both directions, on the committed fixtures,
with no app and no agent.

## Open / follow-ups

- Not wired into an actual CI workflow file yet — the hook is
  `node eval/lib/scopes.check.mjs && node eval/score.mjs eval/results`.
- Engine-backed exact scorer (D-035 option (a)) as a later accuracy upgrade —
  a `render_core` example that emits `computeScopes` JSON for a real render.
- A task that exercises curves / wheels once the operator (or an engine scorer)
  can see them.
- `eval/run.md` is a runbook, not automation — a scripted MCP driver that plays
  the agent turn-by-turn is a possible future.
