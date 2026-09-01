# 01 — PRD

Status: **draft**. Owner: Ashish. Last updated: 2026-09-01.

## Problem statement

A creator grading their own talking-head / explainer videos has no tool that lets an AI
agent do the repetitive, skill-heavy colour work — primary correction, shot matching,
subject isolation, depth-based atmosphere — while keeping full manual control and a
visual GUI. The options are: a closed pro app the agent can't drive (Resolve/Premiere),
or an open editor whose grading is too weak (OpenShot/Kdenlive), or a headless library
with no GUI (color-matcher, OCIO).

Concretely, from the sessions that led here:
- Palmier's MCP masking works but only ellipse/rect/linear — can't hug a body, breaks on
  hand gestures, has no depth mask, magic mask costs credits.
- Resolve would solve it but is closed, Studio-gated for scripting, and can't script the
  color page regardless.
- The grade lives trapped in an app's project file — not diffable, not reviewable, not
  generatable.

## Target users

1. **Primary: the solo creator-colorist** (this project's originator). Grades their own
   YouTube/IG talking-head + explainer footage. Wants: fast, consistent, agent-assisted,
   runs locally, free. Comfortable in a terminal and a GUI.
2. **Secondary: the small studio / freelance colorist** who wants grade-as-code —
   version control, PR review of looks, reproducible grades across a series.
3. **Tertiary: the tool-builder** who wants an open, scriptable grading engine to embed
   (an MCP tool surface is a product in itself).

Explicitly **not** targeting: feature-film DI, HDR mastering, broadcast QC, live grading.

## Goals

| # | Goal | Measure |
|---|---|---|
| G1 | An agent can perform a full primary grade on a shot from a natural-language brief | agent completes it in ≤6 tool round-trips, human rates the result "usable starting point" |
| G2 | An agent can match a shot to a reference frame | ΔE (or a scope-gap metric) below a threshold vs. the reference, no human input |
| G3 | Subject isolation that survives gestures | SAM 2 tracked matte; subject stays isolated across a 30s clip with hands moving, ≤1 human correction keyframe |
| G4 | Depth-based grading (haze / atmosphere) | agent applies a depth-weighted haze; far plane visibly separated from subject; no hard mask edge |
| G5 | The grade is a versioned document | `grade.json` in git; a diff is human-readable; re-render from the doc is bit-identical |
| G6 | Round-trips to the editor | primary bakes to a valid `.cube`; full grade renders to ProRes for `swap_clip_media` |
| G7 | Human keeps full control | every agent-set parameter is visible and editable in the GUI; no hidden state |
| G8 | Local, free, private | zero network calls in the grade path; models run on-device |

## Non-goals (v1)

- Timeline editing of any kind.
- Audio.
- ACES / scene-linear / HDR mastering (display-referred Rec709 only in v1 — see D-004).
- Node graph (v1 uses a layer/adjustment stack — D-005).
- Planar tracking GUI, mesh warp, face-mesh relight.
- Windows/Linux polish (macOS Apple Silicon first).
- Multi-user / collaboration.
- A plugin marketplace.

## Constraints

- **macOS Apple Silicon first.** wgpu (Metal), MPS for the models.
- **AGPL-3.0** on the engine (inherited). Chroma code license TBD but must be
  AGPL-compatible.
- **No cloud dependency** in the critical path. Optional cloud model calls allowed only
  as an explicit opt-in fallback, never default.
- **Build on RapidRAW**, don't reimplement its engine (D-001).

## Success criteria (v1 ship)

v1 is done when: on a real talking-head clip, in one session, the agent produces a
primary grade + a tracked subject mask + a depth haze pass + a shot match to a reference,
the human spends <5 min on mask cleanup in the GUI, and the result exports as `.cube` +
ProRes that drop cleanly back into Palmier. And someone other than the originator has
used it and filed an issue.

## Open questions

Tracked in `docs/08-decisions.md`. Headline ones:
- Fork RapidRAW hard, or collaborate with its maintainer? (D-003)
- Chroma's own license. (D-002)
- How does video presentation work through Tauri without IPC-copying 4K frames? (D-006)
- Is "shot match to reference" the headline v1 feature, or is subject-isolation+haze? (D-007)
