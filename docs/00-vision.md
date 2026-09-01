# 00 — Vision

## The one-liner

An AI-native, local, open-source **color grading** tool. Grading only. The agent does the
colour science and the setup; the human does the judgement and the precision.

## Why this exists

Three things are all true in 2026 and they don't overlap:

1. **The pro tools do the hard parts locally.** DaVinci Resolve (free even) has AI Color
   Match, Magic Mask, Depth Map, Face Refinement — all on-device. Premiere has AI masks.
   The technology is solved and shipping.

2. **They're closed, and un-scriptable where it matters.** Resolve's Python API cannot
   create a power window, run the tracker, or drive Magic Mask — that's GUI-only, and
   external scripting is Studio-only since v19.1. Premiere is closed. You cannot build an
   agent on top of either for the part that counts.

3. **Every open-source project is an editor, not a colorist.** OpenShot, Kdenlive,
   Shotcut, OpenCut — grading is an afterthought bolted onto a timeline. The good grading
   *components* exist (color-matcher, film-emulation curves, LUT tools, SAM 2, Depth
   Anything) but nobody has assembled them into a grading-first tool, and nobody has put
   an agent in front of it.

**So there is a real, unclaimed space: an AI-native colorist.** Not "AI that auto-grades
for you" (that's a filter). An agent that works *with* a colorist — proposes a grade,
matches shots to a reference, sets up depth-based haze, roughs in masks — inside a tool
where every parameter is still under human control and visible on a real GUI.

## The thesis

- **Grading is the last un-agented craft in post.** Editing has agents. VFX has agents.
  Grading has "apply this LUT."
- **The grade should be code.** A serialisable document — nodes, params, keyframes, mask
  geometry, tracker data, colour config — versioned in git next to the project. That's
  what an AI-native tool can do that a GUI-first tool structurally can't: diff a grade,
  review a grade in a PR, generate a grade, replay a grade.
- **The agent is not blind, but it is imprecise.** It can read rendered frames and scopes
  and iterate (proven — see `docs/05-research.md`, the Palmier trials). It cannot place a
  bezier on a jawline. The tool's job is to make that division of labour frictionless:
  agent sets intent, human refines geometry, agent continues.
- **Local-first, no credits, no cloud.** Everything runs on the machine. The models are
  small enough (SAM 2, Depth Anything V2) to run on Apple Silicon.

## What success looks like (18 months)

- A talking-head shot goes from flat to graded — subject isolated (tracked), background
  hazed by depth, primary + look applied, matched to the series' reference frame — in
  one agent conversation plus ~2 minutes of human mask cleanup.
- The grade exports as a `.cube` (primary) + an OTIO/round-trip doc so it drops back into
  whatever editor owns the cut.
- Other people use it. It's the obvious answer when someone asks "is there an open-source
  AI colorist?"

## What this is NOT

- Not an NLE. No timeline editing, no trimming, no transitions, no audio. It grades clips
  handed to it.
- Not an auto-grader. It doesn't hide the controls behind "make it cinematic."
- Not a Resolve replacement. Resolve wins on breadth (Fusion, Fairlight, conform, HDR
  mastering). Chroma wins on: agent-native, grade-as-code, open, scriptable end to end.
- Not a SaaS. See license note (`docs/08-decisions.md` D-002).
