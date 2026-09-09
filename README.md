# Apelles

> **Working name — provisional.** AI-native, local, open-source **color grading** tool.
> Not an editor. Grading only, done properly, with an agent that can actually drive it.

The gap: DaVinci Resolve and Premiere do AI color match, depth masks, tracked subject
masks — all locally — but they're closed, and their scripting APIs don't expose the
color page anyway. Every open-source project in this space is an **editor** with grading
bolted on as an afterthought. **Nobody is building an AI-native colorist tool.**

Apelles is that tool: a GPU grading engine + a segmentation/depth/tracking AI layer + an
MCP server so an agent can grade a shot, match it to a reference, and set up masks —
with a real GUI for the human to do the parts an agent can't (place a bezier, nudge a
tracker, judge a look).

## Status

**Phase 0 — scaffolding.** Reading `docs/`. Nothing runs yet.

## Layout

> **As of D-039/D-040 (2026-09-02):** Apelles is becoming a 3-tab app
> (Edit / Motion / Colorist) on a Cargo + npm **monorepo workspace**. The prose
> above predates that — see `docs/08-decisions.md` D-039 and
> `docs/notes/architecture-lock.md`.

```
app/        the vendored RapidRAW fork (was the engine/ submodule — de-submoduled
            in D-040, working tree at app/; Rust + wgpu + Tauri grading engine).
            app/src (React/TS frontend) + app/src-tauri (the Rust crate)
crates/     Apelles' own layered Rust crates (D-039) — apelles-types / apelles-timeline
            / apelles-grade-model so far
packages/   Apelles' frontend workspace — @apelles/{tokens,ui,bridge,editor,motion,shell}
            + packages/motion-engine/ (the Remotion motion engine, moved in)
ai/         Python sidecar — SAM 2, Depth Anything V2, CoTracker, color-matcher (planned)
mcp/        MCP server exposing the grade graph to an agent
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

Apelles' own code: TBD (see [`docs/08-decisions.md`](docs/08-decisions.md) D-002).
The vendored RapidRAW fork at `app/` is **AGPL-3.0** (inherited from RapidRAW) — any
distributed build of the combined work is AGPL. This blocks a closed SaaS; it does not
block an open project.
