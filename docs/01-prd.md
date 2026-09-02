# 01 — PRD

Status: **draft**. Owner: Ashish. Last updated: 2026-09-02 (D-039 3-tab correction — see
note below).

> **2026-09-02 correction.** This PRD was written for a grading-only product. D-039
> (`docs/08-decisions.md`) repointed Chroma at a 3-tab app — Edit / Motion / Colorist. The
> problem statement, goals, and non-goals below are updated for that; the **Colorist-specific
> goals and success criteria are kept close to as-written** because they describe what's
> actually built and shipping (`docs/04-roadmap.md`'s "Now"/"Shipped" — Colorist is by far
> the most mature tab). Edit and Motion are newer and smaller; their state is summarised
> rather than given the same goal-by-goal treatment, since re-deriving G1-scale goals for
> two MVP-or-earlier tabs would be describing aspiration as spec.

## Problem statement

A creator running their own post-production — cutting a talking-head/explainer take,
building a motion-graphic explainer, and grading the result — has no single tool that lets
an AI agent do the repetitive, skill-heavy work across that whole loop while keeping full
manual control and a visual GUI. The options are: closed pro apps an agent can't drive
(Resolve/Premiere), open editors whose grading is too weak (OpenShot/Kdenlive), a
motion-graphics tool with no editing or grading (Remotion alone), or — until 2026-09-02 —
a closed NLE for the cut (Palmier) that just announced it's going commercial. Concretely,
from the sessions that led here:
- Palmier's MCP masking works but only ellipse/rect/linear — can't hug a body, breaks on
  hand gestures, has no depth mask, magic mask costs credits — and Palmier itself is now
  closing.
- Resolve would solve the grading half but is closed, Studio-gated for scripting, and
  can't script the colour page regardless.
- The grade (and, now, the cut and the motion pass) lives trapped in an app's project file
  — not diffable, not reviewable, not generatable.

## Target users

1. **Primary: the solo creator** (this project's originator). Cuts, motion-graphs, and
   grades their own YouTube/IG talking-head + explainer footage. Wants: fast, consistent,
   agent-assisted, runs locally, free, one tool instead of three. Comfortable in a terminal
   and a GUI.
2. **Secondary: the small studio / freelance colorist** who wants grade-as-code — version
   control, PR review of looks, reproducible grades across a series. (Colorist-specific;
   this user may never touch Edit or Motion.)
3. **Tertiary: the tool-builder** who wants an open, scriptable video-editing/grading
   engine to embed (an MCP tool surface is a product in itself).

Explicitly **not** targeting: feature-film DI, HDR mastering, broadcast QC, live grading,
professional multicam/live-switching workflows.

## Product shape — the three tabs

- **Colorist** (most mature — see Goals below). Primary/curves/wheels/LUT, shape + AI
  subject masks (tracked, keyframeable), scopes, `match_to_reference`, depth haze +
  temporal depth track, export + `.cube` bake, `grade.json`, an agent activity feed, an
  eval harness. 38 MCP tools.
- **Edit** — MVP. A single-video-track timeline of a project's shots: reorder, trim,
  split, remove, scrub/play preview. No multi-track, audio, transitions, or transcript-cut
  yet (`docs/04-roadmap.md` Next #2/#3).
- **Motion** — placeholder tab. The underlying Remotion engine (`packages/motion-engine/`
  — 7 primitives + a JSON manifest compiler) is complete and usable standalone via the
  CLI, but isn't wired into a tab UI yet (`docs/04-roadmap.md` Next #5).

Full detail: `docs/03-architecture.md`.

## Goals — Colorist (largely achieved; see `docs/04-roadmap.md` "Shipped")

| # | Goal | Measure | Status |
|---|---|---|---|
| G1 | An agent can perform a full primary grade on a shot from a natural-language brief | agent completes it in ≤6 tool round-trips, human rates the result "usable starting point" | built — 38-tool MCP surface, agent activity feed |
| G2 | An agent can match a shot to a reference frame | scope-gap metric below a threshold vs. the reference, no human input | built — `match_to_reference` (D-026), closed-loop, verified 78.3→10.0 gap on a real clip |
| G3 | Subject isolation that survives gestures | SAM 2 tracked matte; subject stays isolated across a clip with hands moving, ≤1 human correction keyframe | built — SAM 2 + ViTMatte (D-016/018), mask keyframes for manual assist (D-034) |
| G4 | Depth-based grading (haze / atmosphere) | agent applies a depth-weighted haze; far plane visibly separated; no hard mask edge | built — depth-haze preset (D-024), now temporally tracked for moving cameras (D-036) |
| G5 | The grade is a versioned document | `grade.json` in git; a diff is human-readable; re-render from the doc is bit-identical | built — D-025, verified: one-knob change = one-line diff |
| G6 | Round-trips to an editor | primary bakes to a valid `.cube`; full grade renders to ProRes | built — D-022 |
| G7 | Human keeps full control | every agent-set parameter is visible and editable in the GUI; no hidden state | built — `grade.json` is the single source of truth (`CLAUDE.md` invariant); agent activity feed shows + undoes every agent change (D-032) |
| G8 | Local, free, private | zero network calls in the grade path; models run on-device | built — SAM2/ViTMatte/VDA run in the local `ai/` sidecar, Depth Anything V2 runs in-process ONNX |

## Goals — Edit and Motion (current, smaller in scope than Colorist's)

- **Edit:** an agent (or the human) can assemble and trim a single-track sequence from a
  project's shots and see it play back — done. Audio-synced playback, multi-track, and an
  MCP surface for the timeline are **not** built yet (tracked in the roadmap, not claimed
  here as shipped).
- **Motion:** the manifest → video pipeline works end-to-end via the CLI
  (`npx remotion render`) — done, pre-existing. A tab-embedded player + manifest editor +
  a `chroma-motion` Rust bridge are **not** built.

## Non-goals

**No longer a blanket non-goal:** timeline editing. The original v1 PRD excluded it
entirely ("Timeline editing of any kind"); D-039 made it a first-class tab. What's still
explicitly out, by tab:

- **Colorist (v1 scope, unchanged — `docs/02-scope.md`):** node graph (stack only, D-005);
  ACES/scene-linear/HDR mastering (Rec.709 only, D-004); planar tracking GUI, mesh warp,
  face-mesh relight; Windows/Linux polish (macOS Apple Silicon first); multi-user /
  collaboration; a plugin marketplace.
- **Edit (current MVP boundary, D-041):** multi-track, audio, transitions, transcript-driven
  cutting, GPU compositing, grade-in-preview, OTIO export, MCP tools.
- **Motion (current boundary):** any tab UI beyond a placeholder; a visual manifest editor
  (JSON-in is the only path today).
- **All tabs:** a plugin marketplace, live/broadcast workflows, real-time collaboration.

## Constraints

- **macOS Apple Silicon first.** wgpu (Metal), MPS for the models.
- **Rust-native, performance-first, small binary — hence Tauri** (D-039 owner constraint).
  This rejected WebCodecs/browser-based editing engines (Remotion-as-editor, Diffusion
  Studio, OpenCut-web) for the Edit tab specifically.
- **AGPL-3.0** on the `app/` engine (inherited from RapidRAW). Chroma code license TBD
  (D-002) but must be AGPL-compatible.
- **No cloud dependency** in the critical path. Optional cloud model calls allowed only as
  an explicit opt-in fallback, never default.
- **Build on RapidRAW for the grading engine, don't reimplement it** (D-001). The Edit tab
  is greenfield-inside-the-structure by contrast (D-039) — reuse (`re_video`, an
  OpenCut-derived compositor reference, `react-timeline-editor`) rather than build from
  scratch, but it isn't a fork of an existing NLE the way Colorist forked RapidRAW.

## Success criteria

**v1 ship (Colorist, largely met — see Goals table above):** on a real talking-head clip,
in one session, the agent produces a primary grade + a tracked subject mask + a depth haze
pass + a shot match to a reference, the human spends <5 min on mask cleanup in the GUI, and
the result exports as `.cube` + ProRes that drop cleanly back into an external editor. This
remains the nearest-term ship target — `docs/notes/product-direction.md` §8 explicitly
recommends finishing the colorist before spreading effort across all three tabs. Still
open: someone other than the originator using it and filing an issue.

**3-tab v1 (longer-term, not yet met):** the same one-session loop, but starting from raw
footage — cut to a rough assembly, a motion-graphic explainer generated from a script, then
graded — with each pass agent-assisted and human-reviewable. Blocked on the Editor's audio
gap, the Motion tab's UI, and (eventually) a real multi-track compositor
(`docs/04-roadmap.md`).

## Open questions

Tracked in `docs/08-decisions.md`. Headline ones, largely still open even after the pivot
(`docs/notes/product-direction.md` §9 confirms none were re-decided by D-039 itself):
- Chroma's own license? (D-002, leaning AGPL, not yet decided)
- Working name "Chroma" — final? (D-010, provisional)
- v1 headline feature — shot-match-to-reference vs. subject-isolation+haze, now also
  competing for attention against the Edit/Motion tabs? (D-007)
- Does the Editor's eventual compositor replace the Colorist's grade path, or do they stay
  two passes (composite → grade)? Leaning two-pass, not re-litigated since D-039.
- Does the Motion manifest editor become visual, or stay JSON-in/agent-driven? No strong
  signal yet.
