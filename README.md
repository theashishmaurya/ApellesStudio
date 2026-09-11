# Apelles

**An AI-native, local, open-source video tool — three tabs, Edit / Motion / Colorist,
one app.** The agent does the repetitive craft work — cutting to a transcript, roughing
in a motion-graphic explainer, colour science and mask setup — the human keeps the
judgement, the precision, and full manual control on a real GUI, across all three.

The gap: DaVinci Resolve and Premiere already do AI colour match, depth masks, tracked
subject masks, transcript-based cutting — all locally — but they're closed, and their
scripting APIs don't expose the parts that matter (Resolve's Python API can't create a
power window or drive Magic Mask; Premiere's is closed entirely). Every open-source
editor bolts grading on as an afterthought, and no open, local, agent-native tool takes
colour science seriously. Apelles is a GPU-native compositor + grading engine + a
segmentation/depth/tracking AI layer, all driven by both a real GUI **and** a matching
[MCP](https://modelcontextprotocol.io) server (150+ tools) — so any MCP client, not a
bespoke chat UI, can cut, grade, and animate on the exact same project a human is editing,
live. Local-first: no cloud calls in the render path, no per-use fees, no account.

## Status

**Pre-1.0, actively developed.** All three tabs — Edit (multi-track NLE), Motion
(scene-based motion graphics on Remotion), and Colorist (masks, scopes, AI relight,
match-to-reference) — run today from source. No packaged installer yet; see
[`docs/04-roadmap.md`](docs/04-roadmap.md) for what's shipped vs. in flight, and
[`docs/CHANGELOG.md`](docs/CHANGELOG.md) for a session-by-session log.

Run it: `npm run tauri:dev` from the repo root (needs Rust + Node; see
[`docs/03-architecture.md`](docs/03-architecture.md) for the full stack).

## Layout

One repo, a Cargo + npm monorepo workspace (D-039). Full per-crate/per-package
boundaries: [`crates/README.md`](crates/README.md).

```
app/        the vendored RapidRAW fork (Rust + wgpu + Tauri grading engine), owned code
            now, not a tracked upstream drop (D-281). app/src (React/TS) + app/src-tauri.
crates/     Apelles' own layered Rust crates — apelles-{types,gpu,media,timeline,
            grade-model,project,motion,ai} — the fork shrinks as these absorb more.
packages/   Apelles' frontend workspace — @apelles/{tokens,ui,bridge,shell,editor,motion,
            motion-engine,player,inspector,history,debug}
ai/         Python sidecars — SAM 2, Depth Anything V2, CoTracker, colour-matcher
mcp/        the MCP server exposing the Edit/Motion/Colorist surface to an agent
website/    apelles.studio's source (Astro, static) — not yet deployed
docs/       everything: vision, PRD, scope, architecture, roadmap, research, decisions, bugs
```

## Start here

| Doc | What |
|---|---|
| [`docs/00-vision.md`](docs/00-vision.md) | why this exists, the thesis |
| [`docs/01-prd.md`](docs/01-prd.md) | problem, users, goals, non-goals, success criteria |
| [`docs/02-scope.md`](docs/02-scope.md) | feature scope — v1 / v2 / v3, in and out |
| [`docs/03-architecture.md`](docs/03-architecture.md) | full system design |
| [`docs/04-roadmap.md`](docs/04-roadmap.md) | phased milestones |
| [`docs/05-research.md`](docs/05-research.md) | landscape survey — what exists, why nothing fits, why RapidRAW |
| [`docs/06-grade-format.md`](docs/06-grade-format.md) | the grade-document schema ("the grade is code") |
| [`docs/07-mcp-surface.md`](docs/07-mcp-surface.md) | the MCP tool surface |
| [`docs/08-decisions.md`](docs/08-decisions.md) | decision log (ADR-style) |
| [`docs/BUGS.md`](docs/BUGS.md) | bug tracker |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md) | changelog |

## License

**AGPL-3.0** for the whole project (see [`LICENSE`](LICENSE) and
[`docs/08-decisions.md`](docs/08-decisions.md) D-002) — inherited from the vendored
RapidRAW fork at `app/`, which any distributed combined build is AGPL under regardless.
This blocks a closed SaaS; it does not block an open project, sponsorships, or paid
support.

`packages/motion-engine/` (the Remotion-derived motion engine) carries its own separate
MIT license — see [`packages/motion-engine/LICENSE.md`](packages/motion-engine/LICENSE.md).
