# 01 — PRD

Status: **draft**. Owner: Ashish. Last updated: 2026-09-08 (feature-status reconciliation,
D-231 — see note below).

> **2026-09-02 correction.** This PRD was written for a grading-only product. D-039
> (`docs/08-decisions.md`) repointed Apelles at a 3-tab app — Edit / Motion / Colorist. The
> problem statement, goals, and non-goals below are updated for that; the **Colorist-specific
> goals and success criteria are kept close to as-written** because they describe what's
> actually built and shipping.
>
> **2026-09-08 reconciliation (D-231).** The 3-tab framing above was right and is unchanged.
> What was wrong six days later was the *feature status*: this file still called Edit a
> "single-video-track timeline… no multi-track, audio, transitions" and Motion a
> "placeholder tab… isn't wired into a tab UI yet." Both were badly out of date — Edit is a
> real multi-track NLE and Motion is a real authoring tab. Every status claim below is now
> verified against `docs/04-roadmap.md`, `docs/08-decisions.md`, or the code itself; where
> something is built on one interface but not the other (GUI vs. MCP), that is stated
> rather than rounded off in either direction.

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

All three are real, routed tabs with real UI. They are at genuinely different depths, and
the differences that matter are in *which interface* each capability has — this project's
standing rule is that a feature exists for a human **and** an AI (`CLAUDE.md`), and the one
place that rule is currently unmet is named explicitly below.

- **Colorist** — the most mature tab and the original v1 ship target. Primary / curves /
  wheels / LUT / HSL, shape + AI subject masks (composable, tracked, keyframeable), a live
  scopes panel (luma / RGB / parade / vectorscope / histogram), `match_to_reference`, depth
  haze + a temporal depth track, interactive depth-driven **relight** pucks (D-048/D-077–079),
  export + `.cube` bake, `grade.json`, an agent activity feed with jump-to-here undo, and an
  offline eval harness. RapidRAW's inherited photo-library shell is gone (D-043) — this is
  the grading editor only.
- **Edit** — a real multi-track NLE, and the tab that has moved furthest since 2026-09-02.
  Video **and** audio tracks with an alpha-over compositor; ripple/roll/slip/slide, split,
  trim, multi-select, marquee, gap close, cross-track ripple + sync-lock, A/V linking;
  per-clip transform (position / scale / independent width+height / rotation / opacity /
  crop) with **per-property keyframes**, on-canvas drag handles and click-to-select; fades
  with real bezier curves and on-clip drag handles; **transitions** (cross-dissolve,
  dip-to-colour) dragged onto a cut; **timeline markers**; **text/title clips** and a
  **subtitles/captions** track kind (D-229); a real
  audio path — device playback, per-clip volume/pan, a 4-band parametric EQ, track gain and
  ducking, all of it mixed into the export; multiple named timelines per project; and export
  to a real video file (GUI dialog + queue) or to **FCPXML 1.7** for interchange.
- **Motion** — a real authoring tab, no longer a placeholder. A `@remotion/player` live
  preview of `packages/motion-engine/`, **multi-scene** manifests (add a scene, preview a
  scene as its own 0:00-start clip, render every scene as its own video file), a layer list
  with drag-to-reorder and real per-layer thumbnails, a browsable primitive **Catalog** that
  creates layers, a typed property Inspector, **on-canvas select / drag / resize /
  marquee**, a per-row **keyframe timeline** with a bezier ease-curve editor, and a
  `zod`-validated JSON manifest editor. Render goes through the `apelles-motion` crate to
  `npx remotion render` and auto-imports the output into Sources.

**Agent reach, stated precisely** (the numbers are the real ones, counted from
`mcp/server.py`, not carried forward): **95 MCP tools** — 42 Colorist/session/project, 45
Edit (41 timeline/editing + 4 media-understanding), and 8 debug-only tools that are
compiled out of a production build. **Motion has 0 MCP tools.** Its 18 `motion_*` ops are
real and live-verified, but they exist only on the in-app control-server bridge
(`useMotionControl.ts`, D-167–D-171) — nobody wrote the Python `@mcp.tool()` wrappers, so an
MCP client cannot reach them. That is a known, recorded gap (D-170's own closing note), not
an oversight of this document, and it is the one place the human-and-AI rule is currently
unmet on a shipped tab. The mirror-image gap on the Edit tab: media understanding
(word-level transcript + scene analysis, D-189) is MCP-only — four tools and a store, with
no GUI surface that consumes it yet.

Full detail: `docs/03-architecture.md`. Live state, always: `docs/04-roadmap.md`.

## Goals — Colorist (largely achieved; see `docs/04-roadmap.md` "Shipped")

| # | Goal | Measure | Status |
|---|---|---|---|
| G1 | An agent can perform a full primary grade on a shot from a natural-language brief | agent completes it in ≤6 tool round-trips, human rates the result "usable starting point" | built — 42 Colorist MCP tools, agent activity feed |
| G2 | An agent can match a shot to a reference frame | scope-gap metric below a threshold vs. the reference, no human input | built — `match_to_reference` (D-026), closed-loop, verified 78.3→10.0 gap on a real clip |
| G3 | Subject isolation that survives gestures | SAM 2 tracked matte; subject stays isolated across a clip with hands moving, ≤1 human correction keyframe | built — SAM 2 + ViTMatte (D-016/018), mask keyframes for manual assist (D-034) |
| G4 | Depth-based grading (haze / atmosphere) | agent applies a depth-weighted haze; far plane visibly separated; no hard mask edge | built — depth-haze preset (D-024), now temporally tracked for moving cameras (D-036) |
| G5 | The grade is a versioned document | `grade.json` in git; a diff is human-readable; re-render from the doc is bit-identical | built — D-025, verified: one-knob change = one-line diff |
| G6 | Round-trips to an editor | primary bakes to a valid `.cube`; full grade renders to ProRes | built — D-022 |
| G7 | Human keeps full control | every agent-set parameter is visible and editable in the GUI; no hidden state | built — `grade.json` is the single source of truth (`CLAUDE.md` invariant); agent activity feed shows + undoes every agent change (D-032) |
| G8 | Local, free, private | zero network calls in the grade path; models run on-device | built — SAM2/ViTMatte/VDA run in the local `ai/` sidecar, Depth Anything V2 runs in-process ONNX |

## Goals — Edit and Motion

These are now real enough to state the same way the Colorist table above does, rather than
as a prose summary. Same rule as that table: "built" means it works on a real project, and
anything half-built says which half.

| # | Goal | Measure | Status |
|---|---|---|---|
| E1 | An agent or human can assemble a multi-track cut from raw footage and play it back | import → place → trim/split/move on stacked video+audio tracks, with device audio | built — D-086/D-088 compositor, D-050 audio, 41 `editor_*` MCP tools |
| E2 | Clips composite, not just abut — stack, PIP, animate | per-clip transform + crop + opacity, per-property keyframes, on-canvas handles | built — D-136/D-193/D-204/D-208/D-209 |
| E3 | The cut has a real audio path, not a silent preview | per-clip volume/pan + 4-band EQ + track gain + ducking + fades, identical in preview and export | built — D-223/D-224/D-149/D-197, verified by measuring real exported files |
| E4 | A cut renders to a real file, and moves to another NLE | multi-track ffmpeg export with mixed audio; FCPXML 1.7 interchange | built — D-197/D-198 (export + GUI queue), D-196 (FCPXML; keyframes/fades/ducking are *not* carried, and say so in `warnings`) |
| E5 | An agent can decide *where* to cut, not just cut precisely | word-level transcript + scene analysis of a source file | built for the agent only — D-189, 4 MCP tools; **no GUI surface consumes it yet**, and there is no transcript-driven cut op |
| E6 | The timeline is a real editing surface, not a strip | zoom, snap, edge-trim, filmstrip + waveform on clip, timecode ruler, markers, transitions, marquee | built — D-051/D-119/D-134/D-222/D-226/D-227 |
| M1 | A human can build a motion scene without hand-writing JSON | create layers from a Catalog, drag/resize on canvas, edit typed properties | built — D-151 (Catalog), D-156/D-157/D-158 (canvas), D-099/D-103 (Inspector) |
| M2 | A motion piece can be more than one scene | add scenes, preview one scene in isolation, render each scene to its own file | built — D-179/D-180/D-181 |
| M3 | Motion is animatable on a timeline, not only in the manifest | per-row keyframe timeline, drag/box-select keys, bezier ease editor | built — D-160–D-164 |
| M4 | A rendered motion piece flows into the cut | render → auto-import into Sources → drag onto an Edit timeline | built — D-047, D-062 (deliberately not auto-placed on a timeline) |
| M5 | An agent can drive the Motion tab | MCP tools an MCP client can actually call | **not met.** The 18 `motion_*` control-bridge ops are built and live-verified (D-167–D-171); the Python `mcp/server.py` wrappers were never written, so the surface is unreachable from an MCP client |

## Non-goals

**No longer a blanket non-goal:** timeline editing. The original v1 PRD excluded it
entirely ("Timeline editing of any kind"); D-039 made it a first-class tab. What's still
explicitly out, by tab:

- **Colorist (v1 scope, unchanged — `docs/02-scope.md`):** node graph (stack only, D-005);
  ACES/scene-linear/HDR mastering (Rec.709 only, D-004); planar tracking GUI, mesh warp,
  face-mesh relight (the *deterministic* depth-driven puck relight did ship — D-048; the
  photoreal diffusion bake is what stays out, D-013); Windows/Linux polish (macOS Apple
  Silicon first); multi-user / collaboration; a plugin marketplace.
- **Edit — the 2026-09-02 list here is obsolete.** Multi-track, audio, transitions and MCP
  tools were all listed as out of scope and have all since shipped (D-086/D-088, D-050,
  D-226/D-227, D-183). What is genuinely still out, as of 2026-09-08: **GPU compositing**
  (today's compositor is CPU — `apelles-compositor` is still unbuilt), **grade-in-preview**
  (Edit and Colorist remain two passes), **OTIO export** (FCPXML 1.7 shipped instead, D-196),
  **adjustment clips** (subtitles/captions landed as D-229 mid-pass), a **timeline curve
  editor**, a
  **context-sensitive trim tool**, **speed-ramp curves** (a flat export-time speed override
  exists; a ramp does not), the **seven edit types on drop**, **dynamic zoom**, the **EQ
  response-curve UI** (the math and both engines are done — only the interactive plot is
  missing, D-224), **audio scrubbing**, and a **transcript-driven cut** (the transcript
  itself exists; nothing turns it into edits). All are tracked in `docs/04-roadmap.md`
  item 27, not abandoned.
- **Motion:** a Rust/native motion engine (Remotion is the engine, deliberately — D-046);
  multi-manifest per project (one per project, D-046, waiting on a real need); undo/redo
  inside the tab (D-052 deferred it; roadmap item 16.4 has the shape); using a Motion
  composition directly as a nested sequence inside an Edit timeline (render-and-import is
  the path today, D-062).
- **All tabs:** a plugin marketplace, live/broadcast workflows, real-time collaboration,
  hardware control surfaces, multicam.

## Constraints

- **macOS Apple Silicon first.** wgpu (Metal), MPS for the models.
- **Rust-native, performance-first, small binary — hence Tauri** (D-039 owner constraint).
  This rejected WebCodecs/browser-based editing engines (Remotion-as-editor, Diffusion
  Studio, OpenCut-web) for the Edit tab specifically.
- **AGPL-3.0** on the `app/` engine (inherited from RapidRAW). Apelles code license TBD
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

**3-tab v1 (longer-term, closer than it was):** the same one-session loop, but starting from
raw footage — cut to a rough assembly, a motion-graphic explainer generated from a script,
then graded — with each pass agent-assisted and human-reviewable. The three blockers named
here on 2026-09-02 (the Editor's audio gap, the Motion tab's UI, a multi-track compositor)
have all since been cleared. What actually stands between here and that loop now: **Motion
is unreachable from an MCP client** (M5 above — the agent leg of "generated from a script"
is the missing one, not the UI), **grade-in-preview / a real Edit→Colorist hand-off** (the
two tabs are still separate passes over separate models — roadmap item 8), and the
transcript existing without anything that cuts from it (E5).

## Open questions

Tracked in `docs/08-decisions.md`. Headline ones, largely still open even after the pivot
(`docs/notes/product-direction.md` §9 confirms none were re-decided by D-039 itself):
- Apelles' own license? (D-002, leaning AGPL, not yet decided)
- Working name "Apelles" — final? (D-010, provisional)
- v1 headline feature — shot-match-to-reference vs. subject-isolation+haze, now also
  competing for attention against the Edit/Motion tabs? (D-007)
- Does the Editor's eventual compositor replace the Colorist's grade path, or do they stay
  two passes (composite → grade)? Leaning two-pass, not re-litigated since D-039. Still
  genuinely open — roadmap item 8 (unify clip identity, Edit ↔ Colorist) is where it lands.
- ~~Does the Motion manifest editor become visual, or stay JSON-in/agent-driven?~~
  **Answered: both.** D-152's research pass, then D-155–D-164, built a real visual builder
  (canvas manipulation + keyframe timeline + Catalog) *alongside* the JSON editor, which
  collapses behind a `</>` toggle by default (D-153/D-173). Neither replaced the other.
