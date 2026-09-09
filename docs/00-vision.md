# 00 — Vision

> Rewritten 2026-09-02 alongside `01-prd.md` / `02-scope.md` for the D-039 pivot. This is a
> correction of the "grading only" framing below, not a rewrite of the underlying thesis —
> the local-first, agent-native, colour-science-depth argument is unchanged and still the
> differentiator (`docs/notes/product-direction.md` §7).
>
> **Re-checked 2026-09-08 (D-231) and left substantially as-written.** Unlike `01-prd.md`
> and `02-scope.md`, which had gone badly stale on feature status, this file is pitched
> above the feature layer and none of its claims had drifted. One factual detail was
> corrected (the interchange format under "what success looks like"). The thesis holds:
> what changed in the intervening week is that considerably more of it is now built.

## The one-liner

An AI-native, local, open-source **video tool — three tabs, Edit / Motion / Colorist, one
app** (D-039). The agent does the repetitive craft work — cutting to a transcript, roughing
in a motion-graphic explainer, colour science and mask setup — the human keeps the
judgement, the precision, and full manual control on a real GUI, across all three.

## Why this exists

Four things are true as of 2026-09-02:

1. **The pro tools do the hard parts locally.** DaVinci Resolve (free even) has AI Color
   Match, Magic Mask, Depth Map, Face Refinement — all on-device. Premiere has AI masks.
   The technology is solved and shipping.
2. **They're closed, and un-scriptable where it matters.** Resolve's Python API cannot
   create a power window, run the tracker, or drive Magic Mask — that's GUI-only, and
   external scripting is Studio-only since v19.1. Premiere is closed. You cannot build an
   agent on top of either for the part that counts.
3. **Open-source is fragmented across the craft.** OpenShot, Kdenlive, Shotcut, OpenCut are
   editors with grading bolted on as an afterthought. The good grading *components* exist
   (color-matcher, film-emulation curves, LUT tools, SAM 2, Depth Anything) but nobody had
   assembled them into a real grading-first tool — and separately, motion graphics live in
   yet another tool again (Remotion, After Effects).
4. **The trigger.** This project's own production workflow — script → cut → motion
   graphics → grade → publish — leaned on Palmier Pro for the cut. On 2026-09-02 Palmier
   announced it's going closed-source and commercial. Rather than build a grading-only
   sidecar to someone else's closing editor, the call was to become the editor: one local,
   agent-native app that owns the whole post-production loop (D-039).

**So there is a real, still-unclaimed space.** 2026 saw "agentic video editing" become a
funded, named category (a16z's thesis piece, YC's Cardboard, Avid shipping agentic
features) — editing got its agents. Nobody in that wave takes colour grading seriously as
a craft (see `docs/notes/product-direction.md` §7 for the full competitive read). Apelles'
bet: be the one tool that's agent-native across cut, motion, *and* grade, with real colour
science as the part nobody else has bothered to build.

## The thesis

- **Real colour science is still the unclaimed wedge.** Editing agents are now a crowded
  field; a grading pipeline this deep — GPU shader stack, scopes, `match_to_reference`,
  depth-based haze, tracked/keyframed masks — is still Apelles' alone among the local/open
  competitors surveyed (`docs/notes/product-direction.md` §7). Grading is the part of post
  that's hardest to fake with a thin AI wrapper.
- **The grade should be code.** A serialisable document — adjustments, keyframes, mask
  geometry, tracker/depth-track refs — versioned in git next to the project (`grade.json`,
  D-025). That's what an AI-native tool can do that a GUI-first tool structurally can't:
  diff a grade, review a grade in a PR, generate a grade, replay a grade.
- **The agent is not blind, but it is imprecise.** It can read rendered frames and scopes
  and iterate (proven — the Palmier trials, `docs/05-research.md`; the closed-loop
  `match_to_reference`, D-026). It cannot place a bezier on a jawline or judge a cut's pace
  by feel. The tool's job is to make that division of labour frictionless: agent sets
  intent, human refines geometry/timing, agent continues. `request_human(reason, roi?)`
  (D-032) is the explicit handoff.
- **Local-first, no credits, no cloud.** Everything runs on the machine — grading, the AI
  sidecar (SAM 2, ViTMatte, Video Depth Anything, all local), and the motion-graphics
  render. Every well-funded competitor surveyed is cloud + metered; that's a real,
  durable difference, not a marketing line.

## What success looks like (18 months)

- A raw shoot goes from footage to a published cut in one agent conversation plus real
  human refinement time: cut to the transcript, a motion-graphic explainer roughed in from
  a script, the talking-head shot graded — subject isolated (tracked), background hazed by
  depth, matched to a reference — each pass reviewable and undoable, not a black box.
- The grade exports as a `.cube` (primary) + the project round-trips (a timeline
  interchange format for the edit, `grade.json` per clip) so any piece of it drops back
  into whatever else owns a later step. *Partly real already:* the `.cube` bake and
  `grade.json` shipped in v1 (D-022/D-025), and the edit exports **FCPXML 1.7** as of
  D-196 — OTIO, named here in 2026-09-02, is not what shipped and is still open.
- Other people use it. It's the obvious answer when someone asks "is there an open-source,
  local, agent-native video tool that actually takes colour seriously?"

## What this is NOT

- **Not a generation-first "vibe editing" tool.** It doesn't chain Sora/Veo/Kling calls to
  conjure footage (contrast: Mobbi AI). It works with real, shot footage.
- **Not an auto-editor or auto-grader.** No "make it cinematic" one-click filter, on any
  tab. Every parameter the agent sets is visible and editable in the GUI — cuts, motion
  primitives, grade adjustments alike.
- **Not a Resolve/Premiere replacement on breadth.** Resolve still wins on Fusion,
  Fairlight, conform, HDR mastering, feature-DI-scale tooling. Apelles wins on: agent-native
  across the whole pipeline, grade-as-code, open, local, Rust-fast, scriptable end to end.
- **Not a SaaS.** No cloud dependency in the critical path (see the licence note,
  `docs/08-decisions.md` D-002).
