# notes/match-reference.md — the automated grade-by-the-numbers loop

Round-2 queue item 1. Built 2026-09-01. See `docs/notes/agent-visual-feedback.md`
(the discipline this automates), `docs/notes/scopes.md` (`computeScopes` /
`computeGap`), `docs/08-decisions.md` **D-026** (the gap→knob heuristics +
damping), and D-021 (the gap already computed, this applies it).

## What shipped

- **`match_reference` op** in `app/src/hooks/useChromaControl.ts` `OPS`.
  `match_reference({ reference, strength = 1.0, max_iters = 4, tolerance = 3.0 })`.
- **`match_to_reference` MCP tool** in `mcp/server.py` → `POST /op match_reference`.

It measures the scope gap from the current graded frame to a reference image,
applies a **damped primary correction**, re-measures, and iterates until the
combined gap is `< tolerance` or `max_iters` is reached.

**Merges into `primary`, not a new layer.** A reference match is a *balance* —
exposure / white balance / contrast / saturation pulled toward the target. The
creative look (curves, wheels, film emulation) and any mask work are separate
concerns and are left untouched. This mirrors how a colorist balances a shot
before doing anything expressive.

## The loop

1. Load `reference` (absolute path) through the same `generate_preview_for_path`
   + neutral-adjustments path `inspect_color` uses → `ImageData` →
   `computeScopes` → `refScopes` (measured once; it doesn't change).
2. Capture the current graded preview → `computeScopes` → `subjScopes`.
3. Combined gap magnitude (the convergence signal):

   ```
   gapMag = |Δexposure|·8 + |ΔwarmCool| + |ΔgreenMagenta|
          + |Δsaturation|·20 + |ΔblackPoint| + |ΔwhitePoint|
   ```

   where `Δexposure = (ref.mids.luma − subj.mids.luma)/64 · 0.5` (EV-ish, same
   formula as `computeGap`), the cast deltas are in 0–255 channel-code units
   (`ref − subj` of `cast.warmCool` / `cast.greenMagenta`), `Δsaturation` is the
   mean-HSV-sat difference (0–1), and the point deltas are 0–255 luma codes.
   The weights put a ~0.4 EV error, a ~10-unit cast, a ~0.1 sat swing and a
   ~10-code black/white-point miss all in the same ballpark (~3–4 each).

4. If `gapMag < tolerance` → **converged**, stop. (First call already within
   tolerance → `{ converged: true, iterations: 0 }`, no change.)

5. Translate the gap into a `set_primary` **delta patch**, damped. `eff = strength
   · damp`; each raw delta is then clamped to a per-knob per-step ceiling:

   | knob | raw delta / iter | gain | step cap | rationale |
   |---|---|---|---|---|
   | `exposure` | `(Δexposure + 0.004·(Δbp+Δwp)) · 1.0` | 1.0 | 0.6 | the `computeGap` EV-ish mids term **plus** the common-mode black/white shift — contrast can't fix a level offset (it pivots on mid-grey) |
   | `temperature` | `ΔwarmCool · 0.9` | 0.9 | 34 | back-derived from the app's WB-picker (`ImageCanvas.tsx`: normalized R−B imbalance `(B−R)/(B+R)` × ~125 → temp units, ≈0.49/code near mid-grey) and the measured temp↔warmCool slope on real footage (~1.0–1.2) |
   | `tint` | `ΔgreenMagenta · 1.3` | 1.3 | 22 | same WB-picker basis: `(G−M)/(G+M)` × ~400 → tint units, ≈1.56/code near mid-grey |
   | `contrast` | `(Δwp − Δbp) · 0.45` | 0.45 | 9 | the spread **difference** only |
   | `saturation` | `Δsat · 130` | 130 | 13 | `Δsat` is the raw mean-HSV-sat difference (0–1) — **never a ratio** (a ratio blows up when the subject starts near-greyscale) |

   contrast + saturation amplify cast and clip channels, so the next measurement
   is only as trustworthy as their step was small — hence the tight caps and low
   gains. exposure / temperature / tint target a scope value directly and rarely
   cascade, so they move freely.

   **Damping.** `damp = 0.78 · 0.95^iter` → `0.78, 0.74, 0.70, 0.67, …` —
   deliberately near-constant. The gap itself shrinks each step; a fast per-iter
   decay (an earlier `0.6·0.75^iter`) multiplied by that shrinking gap
   double-counts and the loop stalls well short of the target. Overshoot is
   handled by roll-back, not by starving every step.

   **Roll-back + best-snapshot.** After applying a step and re-measuring: if
   `gapMag` didn't drop by at least 0.5, the step is **reverted** (restore the
   previous knob values, re-apply, re-measure) and `strength` is halved. The
   lowest-`gapMag` knob set seen is kept and the loop lands on it at the end. Two
   reverts (`stalls >= 2`) ends the loop.

6. Each cumulative knob value is clamped to its slider range (`exposure` ±5, the
   rest ±100), merged via the same `setAdjustments` a slider drag uses, and the
   loop waits ~450 ms for the re-render to settle before re-measuring. Each
   measurement is the **average of two captures** — the numbers come off a
   512-px JPEG downsample (D-021) and carry a few units of per-capture noise.

`iterations` counts **accepted** steps (a revert doesn't count); `trace` lists
every attempt, reverts flagged `"reverted": true`.

**Wall-clock budget.** The control-server bridge times out at 20 s
(`control.rs BRIDGE_TIMEOUT`). The loop stops iterating after ~16 s elapsed and
returns what it has (`converged: false`), so a slow machine or a high
`max_iters` never trips the 504.

## Return shape

```jsonc
{
  "converged": false,           // true once gapMag < tolerance
  "iterations": 5,              // ACCEPTED steps (reverts don't count)
  "gap_before": 78.29,
  "gap_after": 10.02,
  "gap_reading": "Subject vs reference: needs warmer (~slight, Δ1.54); tint greener (Δ3.98).",
  "applied": { "exposure": 0.292, "contrast": 7.733, "temperature": 47.624, "tint": 12.905, "saturation": 15.206 },
  "merged_into": "primary",
  "trace": [
    { "iter": 1, "damp": 0.78, "gapMag_before": 78.29, "gapMag_after": 33.39, "patch": {...}, "cumulative": {...} },
    { "iter": 2, "damp": 0.74, "gapMag_before": 33.39, "gapMag_after": 16.90, "patch": {...}, "cumulative": {...} },
    // ...
    { "iter": 6, "gapMag_before": 85.99, "gapMag_after": 89.05, "reverted": true, "patch": {...} }
  ],
  "note": "primary balance only — creative look, curves, and mask work are separate. Inspect the result."
}
```

`applied` is the cumulative primary delta from where the grade started.
`settleAndCapture` folds in the final rendered frame + `scopes` (mutating-op
path), so the caller gets the picture and the new numbers for free.

## Scope / what it does NOT do

- **Primary only.** No curves, wheels, LUT, or masks. A reference match is the
  balance pass; the look is a separate, often human, decision.
- **Global.** It reads whole-frame scopes — it will chase a coloured background
  as readily as skin. For a talking-head, mask the subject and match on that, or
  match primary then correct the subject through a mask.
- **Not a colour-science transform** (Reinhard / MKL / MVGD). It's a closed-loop
  nudge of five sliders. The `method` param in the `docs/07` sketch is dropped
  for v1.
- **Downsampled-preview measurement** (≤512 px JPEG, D-021). The combined
  magnitude has a noise floor of roughly **10–20** on a real shot, so `tolerance`
  (3.0) is rarely *reached* — `converged` is usually `false` even on a good
  match. Read `gap_before → gap_after` and `gap_reading`, not the boolean.

## Verification (2026-09-01, live bridge, `010BEB07….MOV`, 1080×1920 talking-head, frame 90)

`cargo check --no-default-features` clean — **no Rust changes** (frontend op +
MCP tool only). App launches.

Setup: `set_primary` warm+bright (`temp +26, exp +0.4, sat +9, contrast +10`) →
saved the rendered frame as `/tmp/ref_warm.jpg` (`warmCool 58.1, white 253,
sat 0.43`); reset the clip cool+dark (`temp −22, exp −0.28, sat −6, contrast −4`
→ `warmCool 12.7, white 230, sat 0.25`).

| check | result |
|---|---|
| **2. trace monotone decreasing; `gap_after < gap_before`; casts land near ref** | gap **78.29 → 10.02** over 5 steps: `78.3 → 33.4 → 16.9 → 13.3 → 10.9 → 10.0`. Final vs ref: `warmCool 56.6 / 58.1`, `white 251 / 253`, `black 18 / 20`, `sat 0.44 / 0.43`. `gap_reading`: "needs warmer (~slight, Δ1.54); tint greener (Δ3.98)". `applied`: `temp +47.6, tint +12.9, sat +15.2, exp +0.29, contrast +7.7`. |
| **3. idempotent-ish — re-run immediately** | `iterations: 0`, `gap 10.02 → 10.02`, `applied` all zero. First step didn't clear the +0.5 improvement bar, rolled back, second stall → stop. No swing. |
| **4. harder case (unrelated reference `scratch/frame_c019_10s.png`)** | `gap 130.63 → 85.99`, 4 accepted steps then 2 reverts → `stalls>=2` stop. `converged: false`, graceful. |
| **5. `get_state` after the hard run — all finite & in range** | `exp −0.368, contrast −25.2, temp 18.0, tint 82.2, sat 52.0` — all finite, all within slider range. No NaN. |
| **trace readable in MCP output** | yes — `{iter, damp, gapMag_before, gapMag_after, patch{5 knobs}, cumulative{5 knobs}}` per step, `reverted: true` on rolled-back attempts. |

Repro script: `verify_match.py` (control-server `POST /op`, not committed).

