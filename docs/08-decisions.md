# 08 — Decision log

ADR-style. Each decision: context, options, choice, status. Newest first for open ones.

Status: `open` · `decided` · `revisit`

---

## D-001 — Engine base: fork RapidRAW
**decided (2026-09-01)**

- **Context:** need a GPU grading engine. Building from scratch is months.
- **Options:** (a) fork RapidRAW (Rust/wgpu/Tauri, has depth mask + AI mask + curves +
  wheels + LUT, photo-only); (b) libplacebo (C) + build own GUI; (c) Natron (C++, node
  compositor, scriptable, does video, dated); (d) from scratch.
- **Choice:** (a). ~70% of the engine exists and runs, in the language we want, with the
  hard bits (wgpu renderer, Depth Anything integration) already done. The gaps (video,
  tracking, MCP, scopes, shot-match) are exactly the layer we want to own.
- **Fallbacks if RapidRAW's still-centric arch fights the video model:** Path B
  (libplacebo + own GUI) or Path C (RapidRAW engine as a crate, new video-first shell).

## D-002 — Chroma's own license
**open**

- **Context:** `engine/` is AGPL-3.0. Any distributed combined build is AGPL regardless.
- **Options:** AGPL-3.0 (match engine; SaaS must open-source) · GPL-3.0 · "AGPL because we
  have to, but state open intent."
- **Leaning:** AGPL-3.0 for the whole project, stated as deliberate. Blocks a closed SaaS;
  does not block an open project, sponsorships, or paid support. Revisit only if a
  compelling reason to relicense appears (won't — engine is AGPL).
- **Decide before:** first public push.

## D-003 — Fork hard, or collaborate with the RapidRAW maintainer
**open**

- **Context:** solo dev, 18, ships daily, clearly cares. A hard fork duplicates effort and
  invites friction; upstream may *want* the video direction.
- **Action:** open a discussion / issue on RapidRAW describing the video + agent direction
  before diverging. Worst case: clean AGPL fork, keep upstream as a remote for
  cherry-picking.
- **Decide before:** end of Phase 0.

## D-004 — Colour management: display-referred vs ACES
**decided for v1 (2026-09-01), revisit for v2**

- **v1:** display-referred **Rec709** only. YouTube talking-head doesn't need scene-linear
  or HDR, and it removes a large surface. RapidRAW is display-referred today.
- **v2:** OpenColorIO, ACEScg working space, HDR (PQ/HLG) output. This is the "power tool"
  line and a real chunk of work — its own phase.

## D-005 — Node graph vs adjustment stack
**decided for v1 (2026-09-01)**

- **v1:** adjustment **stack** (ordered, non-destructive layers) — RapidRAW's model, and
  enough for grading. `grade.json.stack` is an array.
- **v2:** optional node graph (parallel + serial + layer mixer) for people who want it.
  The stack stays as the simple mode.

## D-006 — Video presentation through Tauri
**decided (2026-09-01) — code-read answered it**

- **Context:** cannot IPC-copy 4K RGBA frames to the webview per scrub.
- **Options:** (1) wgpu → native surface under the webview; (2) shared GPU texture interop;
  (3) encode proxy → `<video>` (playback only).
- **Finding (doc 09):** RapidRAW **already has option (1) built** — `WgpuDisplay` in
  `gpu_processing.rs` owns a `wgpu::Surface<'static>` + `RenderPipeline` + a
  `DisplayTransform` (pan/zoom); the graded image renders straight to that surface, the
  webview only holds UI chrome.
- **Choice:** (1) — extend `WgpuDisplay` to present decoded video frames. No spike needed;
  it's a code path we adapt, not invent. Keep (3) as the fallback for a review-only view.
- **Consequence:** the frontend work is "add a transport bar + playhead over the existing
  canvas," not "solve video rendering."

## D-007 — v1 headline feature
**open**

- **Options:** (a) shot-match-to-reference; (b) subject-isolation (SAM2 tracked) + depth
  haze.
- **Context:** (b) is the pain that started this (the hands problem, no depth mask in
  Palmier). (a) is the bigger long-term differentiator (grade-as-code + consistency).
- **Leaning:** ship both in v1 (Phase 2 covers both), lead the demo with (b) because it's
  the visible "wow", lead the *pitch* with (a) + grade-as-code.

## D-008 — MCP server language
**open — Phase 3**

- **Options:** (a) Rust, shares the core crate, one process, type-safe against the grade
  doc. (b) Python, separate process, talks to the core over the same local socket the UI
  uses, fastest to write, matches the AI sidecar's language.
- **Leaning:** (a) if the core exposes a clean lib API by Phase 3; (b) as the quick path.
  Not blocking — the tool *surface* (D-007, doc 07) matters more than the impl language.

## D-009 — AI model runtime: ONNX in-process (was: PyTorch sidecar)
**decided (2026-09-01), superseded the draft**

- **New info (Phase 0 code-read, doc 09):** RapidRAW already runs Depth Anything V2, SAM
  (v1), U2-Net, CLIP, LaMa **all as ONNX via `ort` (ONNX Runtime), in-process in Rust.**
  No Python.
- **Options:** (a) match RapidRAW — ONNX via `ort`, in-process; (b) Python sidecar
  (PyTorch/MPS) as originally drafted; (c) `candle` (pure-Rust inference).
- **Choice:** (a). Depth Anything V2 and SAM 2 both have ONNX exports. Running in-process
  means no socket boundary, no Python env for the user, and we reuse RapidRAW's model
  loader / download / cache machinery.
- **Consequences:**
  - The `ai/` Python sidecar (doc 03 component 2) is **downgraded** to: a prototyping
    shortcut, a home for models with no good ONNX export (CoTracker/TAPIR — TBD), and
    `color-matcher` (or reimplement that in Rust with `ndarray`/`nalgebra`, already deps).
  - SAM 2 video propagation via ONNX is more involved than SAM 1 (memory-attention module)
    — validate in the Phase 0 spike.
  - Doc 03 diagram + `ai/README.md` to be updated.

## D-011 — Rust toolchain floor
**decided (2026-09-01)**

- RapidRAW `Cargo.toml`: `rust-version = "1.98"`, `edition = "2024"`. We inherit this.
- Dev machine had 1.72.1 → `rustup update` required before any build (B-001).
- Consequence: contributors need current stable Rust. Document in a future `CONTRIBUTING`.

## D-012 — SAM 1 → SAM 2 for the subject mask
**open — Phase 0 / Phase 2**

- **Context:** RapidRAW ships SAM ViT-B (v1) — single-image, no tracking. Our headline
  need (doc 01 G3) is a subject matte that survives gestures *across a clip* = tracking.
- **Options:** (a) SAM 2 ONNX (encoder + decoder + memory attention) for native video
  propagation; (b) SAM 1 per-frame + optical-flow / point-tracker to carry the mask; (c)
  SAM 1 per-keyframe + interpolate + human corrections.
- **Leaning:** (a) if the ONNX export + `ort` path is workable; (b) as fallback.
- **Decide after:** the Phase 0 SAM2-on-`ort` spike.

## D-013 — AI relight (IC-Light) — v3, bake-step only
**open — v3, not before**

- **Context:** user wants ClipDrop-Relight-style relighting (add a virtual key light,
  change lighting direction). Genuinely useful for flat talking-head footage.
- **Options:** (a) IC-Light / IC-Light v2 (lllyasviel, open-source, diffusion) as a
  **bake step** — run once, cache a relit source, then grade normally; (b) live relight
  node (not viable — diffusion is seconds/frame + non-deterministic, breaks the render
  invariant); (c) skip it, rely on depth+mask "relight-ish" (ships v1 anyway).
- **Leaning:** (a) for v3, image-first. **Not (b) ever** — a diffusion pass cannot live
  in the deterministic per-frame render path.
- **Blockers:** video temporal consistency of a relight is an unsolved research problem —
  expect flicker/crawl. v3 scope is likely "relight a held frame / a slow shot", not
  "relight any clip."
- **Meanwhile:** depth + shape masks already fake directional relighting deterministically
  (doc 02, "relight-ish") — that covers most talking-head needs in v1.

## D-014 — Decouple the render core from Tauri
**decided (2026-09-01) — first real fork change**

- **Context (doc 09):** the render entry points are Tauri-coupled —
  `process_and_get_dynamic_image(context, state: &tauri::State<AppState>, base_image,
  transform_hash, request: RenderRequest, caller_id)` takes a `tauri::State`, and
  `get_or_init_gpu_context` needs a `tauri::AppHandle`. You cannot call the grade path
  from a plain binary, a test, or an MCP server without a running Tauri app.
- **Options:** (a) extract a `render_core` crate/module: `fn render(gpu: &GpuContext,
  base: &DynamicImage, req: &RenderRequest) -> Result<DynamicImage>` + a Tauri-free
  `init_gpu_context()`, with the Tauri commands becoming thin wrappers; (b) fabricate a
  fake `tauri::State` (brittle, fights the framework); (c) always drive through the app
  (kills headless spikes, MCP, batch/CI).
- **Choice:** (a). This is the seam between "RapidRAW the app" and "Chroma the engine +
  agent + video." It also isolates our fork surface — most of our work sits in
  `render_core` + new crates, not scattered through `lib.rs`.
- **Consequences:** first change *inside* `engine/` — log it in doc 09's divergence
  section. Keep it a clean extraction (move, don't rewrite) so upstream fixes still
  cherry-pick. `AppState` fields the core actually needs (gpu_context mutex, caches) move
  with it or get passed explicitly.
- **Sequencing:** this is now the first task of Phase 1, and the ffmpeg→grade spike
  depends on it.

## D-010 — Project name
**open**

- Working name **"Chroma"**. Provisional. Rename is cheap while pre-public. Alternatives
  welcome. Decide before first public push.
