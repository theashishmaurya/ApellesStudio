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

### 2026-09-01 — Phase 0 engine code-read
- `CLAUDE.md` — project working rules. Cardinal rule: **every architectural decision is
  documented (context / options / choice / rationale / consequences) in `docs/08` before
  or as it's made**; module headers state what-it-is / what-it-does / what-it-doesn't /
  why; docs must match reality; per-session decision + bug + changelog discipline.
- `docs/09-engine-notes.md` — first-pass map of `engine/` (RapidRAW, ~35k LOC Rust):
  toolchain needs (Rust 1.98+ — B-001), the grade path (`apply_adjustments` →
  `image_processing` → `gpu_processing` wgsl), the file layout, and **the AI stack finding.**
- **Finding:** RapidRAW runs all its AI (Depth Anything V2, SAM v1, U2-Net, CLIP, LaMa)
  as **ONNX via `ort`, in-process in Rust — no Python.** → **D-009 revised**: match that,
  ONNX in-process is the default; the `ai/` Python sidecar is downgraded to
  prototyping/edge-cases. Architecture doc component 2 rewritten; `ai/README.md` updated.
- New decisions: **D-011** (Rust toolchain floor), **D-012** (SAM 1 → SAM 2 for tracked
  subject mask), **D-013** (AI relight / IC-Light — v3, bake-step only, never a live node).
- `docs/02-scope.md` — relight added to v3 (IC-Light, bake step); "relight-ish" via
  depth+shape masks noted as shipping in v1.
- `B-001` filed: Rust 1.72.1 on the machine, engine needs 1.98+.

---

## Release history

_(none yet — pre-v1)_
