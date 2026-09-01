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
- Read `shaders/shader.wgsl` (1910 LOC): 32-mask texture-array model (AI mattes = array
  slots), 3D LUT, wheels, HSL, curves, **AgX tone-map**, **`apply_dehaze`** (= the "haze"
  feature, negative amount per-mask), linear-light + V-Log. Most v1 grade ops already
  exist in-shader → our engine work is video I/O + grade.json↔uniform bridge + per-frame
  mask textures + scopes + MCP, not grade math. Noted in doc 09; D-004 (ACES) de-prioritised.

### 2026-09-01 — toolchain + deeper read
- `rustup update stable` → **rustc 1.98.0** (B-001 resolved). `engine` npm install done (255 pkgs).
- `gpu_processing.rs`: **`WgpuDisplay` = the render-to-native-surface path, already built**
  → **D-006 decided** (extend it for video, no spike). `RenderRequest.mask_bitmaps` is
  `&[Luma<u8>]` — AI mattes drop in, swap per frame. `apply_adjustments` already
  JSON-driven + has `compute_waveform`. Histogram + 1-ch waveform exist.
- `mask_generation.rs`: `MaskDefinition` is JSON/serde; **`generate_ai_bitmap_from_base64`
  is the hook for feeding SAM 2 tracked mattes per frame**; all generators → `GrayImage`.
- Frontend map (`engine/src/`, 114 files): keep `adjustments/`, extend `panel/editor/`
  canvas with transport, replace `panel/library/` with a shot strip, strip `@clerk` auth.
- **`cargo check` on the engine PASSES clean** — 4m24s, 682 deps, ONNX runtime dylib
  auto-downloaded + SHA-verified. **B-001 fixed; the engine builds on this machine.**
- Phase 0 spikes status: D-006 (video surface) answered by code-read, no spike needed.
  Remaining: run the app, ffmpeg→grade spike, SAM2-on-`ort` spike, D-003 (fork vs collab).

### 2026-09-01 — disk cleanup + video-decode spike
- **Disk: 3.6 GiB → 38 GiB free** (~34 GB). Cleared regenerable caches (Yarn/Chrome/
  JetBrains/SwiftPM/pip/brew/Cursor/Code/cargo-registry), a 1 GB crash dump, 36 downloaded
  TV episodes, installer dmgs, shipped video-project folders in Downloads, and dead-project
  `node_modules`/`venv`. Kept `A001_..._C019.MOV` (2.2 GB) as the color-grade test take.
  Docker (`Docker.raw`, 20 GB) left in place — user uses it. B-002 downgraded (not a
  blocker now; note the ceiling).
- **ffmpeg decode spike ✅** — 4K **Rec709** frame from `C019.MOV` →
  `scratch/frame_c019_10s.png`. Video-decode half proven.
- **D-014 (decided):** the render entry points are Tauri-coupled
  (`process_and_get_dynamic_image` takes `tauri::State`, `get_or_init_gpu_context` needs
  an `AppHandle`). Extract a Tauri-free `render_core` — **first Phase 1 task, first fork
  divergence.** The frame→grade spike depends on it.
- Roadmap updated; `scratch/` gitignored (keeps README).

---

## Release history

_(none yet — pre-v1)_
