# CHANGELOG

Human-readable history. `Keep a Changelog` style. Dates are ISO.

## [Unreleased]

### 2026-09-01 — Phase 0 kickoff
- Repo created (`~/my_projects/chroma`, working name "Chroma").
- `engine/` added as a git submodule → `CyberTimon/RapidRAW` (shallow), the Rust + wgpu +
  Tauri image grading engine we're forking as the base.
- `docs/` written:
  - `00-vision.md` — why an AI-native colorist, the thesis, what it is / isn't
  - `01-prd.md` — problem, users, goals G1–G8, non-goals, success criteria
  - `02-scope.md` — feature scope v1 / v2 / v3, anti-scope
  - `03-architecture.md` — 4 components (engine / AI sidecar / MCP / GUI), data flow,
    the Tauri video-presentation problem, "is Rust+Tauri fast" analysis
  - `04-roadmap.md` — Phases 0–4 to v1, risks
  - `05-research.md` — landscape survey: nothing OSS does this, the Palmier trials, the
    RapidRAW find
  - `06-grade-format.md` — the `grade.json` schema ("the grade is code")
  - `07-mcp-surface.md` — the MCP tool list + the agent loop
  - `08-decisions.md` — decision log D-001…D-010
  - `BUGS.md`, `CHANGELOG.md`
- `ai/`, `mcp/` — placeholder dirs with READMEs.

---

## Release history

_(none yet — pre-v1)_
