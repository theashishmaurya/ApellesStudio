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

## D-003 — Hard fork; Chroma is its own project
**decided (2026-09-01)**

- Chroma is a standalone project, not an upstream contribution. Hard fork of RapidRAW
  under AGPL. No coordination issue with the maintainer.
- Keep `upstream` remote for opportunistic cherry-picks, but assume divergence — the
  video + agent + MCP direction is a different product.
- **Still keep changes clean** (CLAUDE.md): new files/modules over scattered edits in
  `engine/`, a divergence log in doc 09, `render_core` as a clean *extraction* not a
  rewrite — so upstream bug fixes still cherry-pick with minimal conflict.
- Consequence: our design choices don't need to fit RapidRAW's roadmap. `render_core`
  extraction (D-014) and everything after is ours to shape.

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

## D-011 — (retired: not a real decision)

Rust 1.98+ / edition 2024 is inherited from RapidRAW's `Cargo.toml`. Setup note, not a
decision. Lives in a future `CONTRIBUTING`.

## D-012 — SAM 2 for the subject mask, via a Python sidecar
**decided (2026-09-01), revised same day**

- Subject mask = **SAM 2**. Runtime = **Python sidecar** (not ONNX/`ort`).
- **Why not ONNX:** SAM 2's video propagation needs the memory-attention + memory-encoder
  modules threaded frame-to-frame with stateful tensors. The community ONNX exports cover
  the image path but the video-memory loop is fragile to reproduce. Not worth the risk
  when a sidecar gets a *correct* tracked matte in a fraction of the time.
- **Package:** `ultralytics` (`from ultralytics import SAM`). It wraps SAM 2.1 incl. the
  video predictor, auto-downloads checkpoints, runs on MPS. Far less surface than Meta's
  raw `sam2` package.
- Consistent with D-009: ONNX in-process is the default; the sidecar is for models where
  ONNX is "too painful" — this is the first such case.
- The sidecar (`ai/`) is now on the v1 path (was downgraded). Still local, still free.
- RapidRAW's SAM 1 stays for its existing click-mask feature; our subject mask is new.
- **Edge quality** — SAM 2 alone staircases at 4K; the matte is finished with a ViTMatte
  refine pass. See **D-016**.

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
**decided (2026-09-01) · done (2026-09-01)**

**Landed:** `src-tauri/src/render_core.rs`. `process_and_get_dynamic_image_inner`
now takes `&render_core::RenderCaches<'_>` (`{ gpu_processor, gpu_image_cache }` —
the only two `AppState` fields it touched) instead of `&tauri::State<AppState>`;
it stays in `gpu_processing.rs`, the GUI wrappers build `RenderCaches` from state
inline. `render_core` adds: `render(...)` (headless pass-through), `init_gpu_context()`
(device+queue, no surface), `OwnedRenderCaches`. Unused until the control/MCP server
— that's the seam. `GpuContext` was already Tauri-free. Original text below.

---


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

## D-015 — Video I/O via the ffmpeg CLI (not `ffmpeg-next` bindings)
**decided (2026-09-01)**

- **Choice:** shell out to `ffmpeg` / `ffprobe` (subprocess) for probe + frame decode.
  Module: `engine/src-tauri/src/chroma/video.rs`.
- **Why not `ffmpeg-next` / `ffmpeg-sys`:** those need libav + pkg-config + a C toolchain
  in every build/CI; a constant source of breakage. ffmpeg is already a hard dep of this
  workflow, it's on every target, the CLI is stable.
- **Cost:** ~10–30 ms process spawn per frame. Fine for *load* and *proxied scrub*. Smooth
  playback needs a persistent `-f rawvideo` pipe or a pre-rendered proxy — a later layer,
  the CLI approach doesn't block it.
- **Overridable:** `CHROMA_FFMPEG` / `CHROMA_FFPROBE` env vars for a pinned/bundled binary.

## D-016 — Subject matte: SAM 2 → trimap → ViTMatte
**decided (2026-09-01) — worklog in [notes/matte-edge-pipeline](notes/matte-edge-pipeline/README.md)**

- **Context:** SAM 2's mask decoder is 256×256 internally → a ~15 px staircase on the
  subject edge at 4K. Feather can't fix it (turns steps into blur). This is the core
  feature (the "hands problem"), so the edge has to be clean.
- **Options:** (a) accept it / feather; (b) "Matte Finesse" — guided-filter edge refine,
  the Resolve Magic Mask approach; (c) bigger SAM (base/large) — *rejected, same 256 px
  decoder, no edge gain*; (d) SAM-HQ / HQ-SAM2; (e) RobustVideoMatting standalone;
  (f) SAM coarse mask → trimap → **ViTMatte** (the Adobe "Refine Edge" approach).
- **Choice:** (f). Tested all three viable paths on a worst-case frame (underexposed, low
  edge contrast). Finesse-only failed — the guided filter can't lock onto a weak luma
  edge. ViTMatte (`vitmatte-small`, ~100 MB) over the trimap unknown-band produced a true
  alpha that follows the real garment line. RVM rejected because it's person-only and
  takes no prompt — SAM + ViTMatte keeps "select anything by box/click" *and* gets the
  clean edge.
- **Pipeline:** `YOLO box → SAM 2.1 (~400ms) → erode/dilate trimap → ViTMatte (~2.8s)`,
  all in the `ai/` sidecar on MPS, local, no network. `/segment` refines by default;
  `refine: false` returns the raw SAM mask.
- **Consequences:** `transformers` + `opencv-contrib-python` added to `ai/requirements.txt`.
  `vitmatte-small` auto-downloads on first `/segment`. Video path (`/track`) will refine
  per propagated frame — ~3 s/frame is fine for a bake, not for live scrub (proxy/cache
  layer handles that). Revisit model choice (ViTMatte-base, BiRefNet) only if edge quality
  is short on hair/fine detail in real use.

## D-021 — Agent scopes computed in JS from the rendered preview (not WGSL)
**decided (2026-09-01) · built (2026-09-01)**

- **Context:** roadmap item 1 needs scopes + a numeric summary for the AI grading
  loop (`docs/notes/agent-visual-feedback.md` — grade by the numbers). The
  roadmap line says "WGSL compute where possible."
- **Options:** (a) a WGSL compute pass in `gpu_processing.rs` that produces the
  parade / vectorscope / numeric readout on the GPU, wired into the analytics
  readback; (b) a pure-JS reader in the frontend that runs on the frame the MCP
  bridge *already captures* (`generate_uncropped_preview` → JPEG → `ImageData`),
  downsampled to ≤512 px.
- **Choice:** (b) for the agent path. The bridge already decodes a preview frame
  for "the agent's eyes"; computing ~10 numbers + two 256-px scope images off a
  512-px downsample is sub-100 ms on the CPU and needs **zero** engine Rust
  changes (fork hygiene — D-003). The agent needs *grounding numbers*, not a
  60 fps scope. A WGSL pass would touch `gpu_processing.rs`, the shader set, and
  the readback path for a precision the agent loop doesn't use.
- **Consequences:** `engine/src/utils/scopes.ts` (new, pure, no deps). The
  interactive **UI** scopes (real-time, while the user drags) stay RapidRAW's
  Rust waveform path and can get a WGSL build later, independently — the two
  don't share code. Histogram is still RapidRAW's (passed through). Sample coords
  are in preview-resolution space; `frameSize` is returned so the agent can scale.
- Detail: `docs/notes/scopes.md`.

## D-020 — AI grading via an in-app control server + event bridge (not headless)
**decided (2026-09-01) · built (2026-09-01) — v1 shipped**

- **Context:** the canonical `adjustments` doc lives in the **frontend** (zustand
  `useEditorStore`); the Rust `apply_adjustments` command receives it fresh each call
  and doesn't own it. So "let AI grade" can't just poke Rust state.
- **Options:** (a) move the grade doc into Rust `AppState` (big, invasive); (b) true
  headless via `render_core` (D-014) — needs its own grade-doc owner + no live preview
  for the user; (c) **in-app control server**: a tiny HTTP server inside the running
  Tauri app bridges HTTP ⇄ Tauri events; the frontend (which owns the grade) applies
  ops and reports back the rendered frame + scopes.
- **Choice:** (c) for v1 — "easy, not deep, AI can grade *alongside* you." The user
  keeps the GUI open, Claude drives it through the MCP server, both see the same live
  preview. `render_core` (D-014) still stands — it's for headless **export** and batch,
  a later path.
- **One shared state — no divergence (like Palmier).** There is exactly one grade doc:
  the frontend `useEditorStore`. MCP edits go through the *same* `setAdjustments` a
  slider drag uses → the UI sliders move, the canvas re-renders, undo/history/save all
  work. `get_grade` reads that store live, so it reflects the user's manual edits too.
  The bridge is pull-based (MCP asks, frontend answers with current state) — same model
  as Palmier's `inspect_color` / `get_timeline`.
- **Shape:**
  - Rust `src/chroma/control.rs` — HTTP on `127.0.0.1:${CHROMA_CONTROL_PORT:-19788}`,
    spawned in `lib.rs` `.setup()`. Each request → `emit("chroma://request", {id, op, args})`,
    await `once("chroma://response:{id}")`, return its payload. Endpoints wrap ops:
    `/health /state /adjust /curve /wheels /seek /render /scopes`.
  - Frontend `useChromaControl` hook (mounted once) — `listen("chroma://request")`,
    apply the op to `useEditorStore` via the existing setters, wait for the render to
    settle, capture preview PNG + histogram, `emit` the response.
  - `mcp/` — Python MCP server (matches the sidecar), thin: tools call the control
    server's HTTP API. Every mutating tool returns `{image_b64, histogram}` (doc 07 rule).
- **Consequences:** needs the GUI running (fine for v1). Grade logic stays in the
  frontend (no duplication). New Rust dep: a minimal sync HTTP server (`tiny_http`).
- **As built (2026-09-01):** `src/chroma/control.rs` (~150 lines, `tiny_http`) + one
  `std::thread::spawn` in `.setup()`; the generic `POST /op {op,args}` endpoint (server
  doesn't know the op list) + `GET /health`. Response event name is `chroma://response/<id>`
  (slash, not colon). Frontend `src/hooks/useChromaControl.ts` with an `OPS` registry —
  every op calls a real store action (`setAdjustments`, `useAiMasking` handlers,
  `chroma_seek`); mounted in `Editor.tsx`. v1 ops: `get_state, set_primary, set_curve,
  set_color_grade, seek, list_masks, add_subject_mask, track_subject, set_mask_adjust,
  invert_mask, delete_mask`. `mcp/` = Python stdio server (`mcp` SDK 2.x), 11 thin tools.
  The rendered frame comes from `generate_uncropped_preview` (the app renders to a native
  WGPU surface, so `apply_adjustments` returns no JPEG) — histogram + adjustments are read
  straight from the store. The bridge only runs while the editor view is mounted (an
  image/video must be open). Details + divergence in doc 09.

## D-019 — Tracked matte read at render time, not swapped into `adjustments`
**decided (2026-09-01)**

- **Context:** first cut had the frontend swap `params.maskDataBase64` on every
  seek. It fought RapidRAW's render pipeline — overlay-regen storm, undo/save churn,
  and (worst) frame vs matte desync: a drag bumps `frameNonce` faster than
  `setAdjustments` settles, so the frame-N matte landed on the frame-M image → an
  offset red blob. The timeline also stopped responding under the render load.
- **Choice:** the sub-mask stores its `/track` cache dir once
  (`params.chromaTrackDir`, persists with the project). `generate_ai_subject_bitmap`
  — the existing bitmap path, called every render — loads
  `<dir>/<current_video_frame>.png` via `chroma::mask::tracked_full_mask` instead
  of the static base64. Matte and frame are the *same* render pass, always in
  lockstep. A seek just bumps `frameNonce` (the existing re-render path); the mask
  overlay effect also keys on it. No per-frame `setAdjustments`.
- **Seek-settle ViTMatte upgrade:** `chroma_refine_tracked_frame` overwrites
  `<dir>/<frame>.png` in place, then bumps `frameNonce` → re-render picks it up.
  Deduped per `(dir, frame)`.
- **Consequences:** removed the `TRACK_DIRS` session map + `chroma_subject_matte_for_frame`
  + `trackedSubMaskIds`. `tracked_full_mask` does a `read_dir` + `image::open` per
  render (~2–5 ms) — cache later if it shows up. Assumes the matte PNG is at the
  warped-image resolution (true for v1: no crop/geometry on video).
- **Also fixed:** `ChromaTimeline`'s root `onPointerDownCapture` stopPropagation was
  eating the strip's own `onPointerDown` (clicks did nothing) — moved onto the strip.

## D-018 — Tracking = SAM 2 memory propagation (`SAM2DynamicInteractivePredictor`)
**decided (2026-09-01)**

- **Context:** the first `/track` (2026-09-01 AM) followed the subject by re-detecting
  the person with YOLO every frame + running image-mode SAM. Works for one stationary
  person, ~1s/frame, no temporal understanding (occlusion, turn-away, two people all break
  it).
- **Choice:** switch to **SAM 2 video mode** via `ultralytics.models.sam.predict.
  SAM2DynamicInteractivePredictor` — already in the installed `ultralytics 8.4.137`, no
  Meta `sam2` package, no new checkpoint. Prompt once on the start frame, feed frames in
  order; the model carries the object in its memory bank. ~180ms/frame for the mask.
- **Gotchas found:** (1) `conf` must be ~0 — SAM 2's object-presence score sits ~0.15–0.20
  after the `/32` clamp and the default conf filters every mask out. (2) `obj_ids` are
  0-indexed and must be `< max_obj_num`. (3) **SAM 2 is very box-sensitive** — a loose
  hand-drawn prompt box segments only the head; we refine the user's box to the best-
  overlapping YOLO person box on the prompt frame before prompting.
- **Consequences:** every frame gets a matte (no more "hold between sampled frames"); the
  old `_iou` YOLO-follow is gone. `step` now just controls save density. Predictor holds
  GPU state for the clip — fine for a few thousand frames, chunk later if needed.
  Propagation is forward-only from the prompt frame (v1: prompt at frame 0).

## D-017 — Multi-subject / multi-object tracking
**partially done (2026-09-01) — per-sub-mask tracking works; per-instance follow still single**

- **Context:** `/track` + the engine wiring (2026-09-01) follow **one** subject: the
  sidecar picks "the central person" each frame, the engine keeps a single global
  `track_dir`, seek-swap patches the first `ai-subject` component. Background grading works
  (invert the subject matte). Two people each with their own mask, or several independently
  tracked `ai-subject` components in nested containers, do **not** work — they'd all follow
  the same person. Non-person objects drift (frames 2..N re-detect person only).
- **Done 2026-09-01 PM:**
  1. **Sidecar** — each `/track` call = one prompted object, followed by SAM 2 memory
     propagation from its own prompt box (D-018), not "central person". Own cache dir
     keyed by prompt box.
  2. **Engine** — `track_dir` → `HashMap<sub_mask_id, PathBuf>` (`state::TRACK_DIRS`);
     `chroma_track_subject` / `_subject_matte_for_frame` / `_refine_tracked_frame` all
     take `sub_mask_id`. Cleared on clip change.
  3. **Frontend** — Track button is per-component (`activeSubMask.id`); `useChromaStore.
     trackedSubMaskIds`; seek-swap loops every tracked sub-mask.
- **Still single-instance:** two `ai-subject` masks each track fine *independently*, but
  each `/track` runs its own predictor + frame-decode pass (2 subjects = 2× the work) and
  a non-person object still isn't handled specially. Batch multiple objects into one
  propagation pass (`max_obj_num > 1`, `obj_ids` per mask) when it matters.

## D-010 — Project name
**open**

- Working name **"Chroma"**. Provisional. Rename is cheap while pre-public. Alternatives
  welcome. Decide before first public push.

## D-022 — Video export: one rawvideo pipe through the grade path into one ffmpeg encoder
**decided (2026-09-01) · built (2026-09-01)**

- **Context:** roadmap item 2 — "a colour tool must output." Need the loaded clip,
  graded, written to a file (ProRes / H.264) + a `.cube` bake of the primary. `render_core`
  (D-014) is the headless grade seam; this is the I/O around it.
- **Options for the frame pump:**
  (a) per-frame temp PNG/TIFF files (`image2` in + `image2` out) — simple, but N×2 file
      writes + a scratch dir to manage;
  (b) `image2pipe` (PNG/BMP framing over a pipe) — no scratch files, but per-frame
      encode/decode of an intra codec for no reason;
  (c) **one persistent `ffmpeg -f rawvideo -pix_fmt rgb24` decoder pipe → grade →
      one persistent `ffmpeg -f rawvideo` encoder pipe.** No framing overhead, no temp
      files, backpressure is just OS pipe flow-control (drain each stderr on a thread,
      pump decode→grade→encode single-threaded).
- **Choice:** (c). One `render_core::init_gpu_context()` + one `OwnedRenderCaches` for the
  whole run (B-002: never re-init per frame). `transform_hash` = frame index so the GPU
  input-texture cache doesn't hand frame N frame N-1's pixels.
- **Decoder seek:** pure `-vf select=between(n,FROM,TO)` from frame 0, **no input `-ss`.**
  Input seek is keyframe-accurate and shifts `n`; tracked-matte PNGs are keyed by absolute
  source frame (D-019), so an off-by-a-few start would desync the matte. Cost: a late
  range decodes from 0. Acceptable for a bake; a persistent proxy is the perf answer
  later (already flagged in D-015).
- **Per-frame tracked matte:** the export loop calls `chroma::state::set_current_frame(n)`
  before grading each frame so `generate_ai_subject_bitmap → tracked_full_mask` fetches
  `<chromaTrackDir>/<n>.png` (D-019). The loop saves + restores the app's `CurrentVideo`.
- **Codecs:** prores = `prores_ks -profile:v 3 (HQ) -pix_fmt yuv422p10le`; h264 =
  `libx264 -crf 18 -pix_fmt yuv420p`. `quality` overrides the profile / crf respectively.
- **`.cube` bake:** a `size³` identity RGB lattice as a `DynamicImage` (x = R, y = B·size+G),
  run through the **primary grade only** — masks / `lutPath` / geometry stripped — then
  written red-fastest. 8-bit lattice → ~1/256 quantisation on the input axis; fine for
  v1's talking-head grades, revisit with an f32 grid path if banding shows. Warns when the
  grade had masked/local layers a 3D LUT can't carry.
- **Command shape:** `chroma_export_video` spawns the work on a blocking task and returns
  `{started, out_path, total}` immediately (a full clip is minutes — can't block the
  20 s control-server bridge); progress is a module-global polled via
  `chroma_export_progress`. `chroma_bake_lut` is synchronous (a 33³ lattice is sub-second).
- **v1 limitations:** no audio passthrough; parametric `color` / `luminance` masks are
  skipped on video export (they need the GUI-state `resolve_warped_image_for_masks`);
  crop/ROI on a video errors out (matte-resolution assumption, D-019). Detail:
  `docs/notes/export.md`.

## D-023 — Mask include/exclude refinement = RapidRAW's Add/Subtract/Intersect composition, not a +/− point mechanism
**decided (2026-09-01)**

- **Context:** roadmap had "interactive +/− point prompts" (SAM click-to-refine). The
  sidecar + engine already accept `points: [{x,y,label}]`. A subagent started building a
  canvas click UI + a menu item + an MCP `refine_mask` points op.
- **User observation:** RapidRAW already ships **"Subtract from Mask" / "Intersect Mask
  with"**, and the submenu offers *every* mask type — including **Subject** (SAM). So
  "exclude this region" = Subtract → Subject (box the region, SAM segments + subtracts it,
  edge-aware); "include more" = Add → Subject / a shape. Full include/exclude, already
  there, for the human.
- **Choice:** do **not** build a +/− point UI or an MCP points op. Expose the *existing*
  composition to the agent instead:
  - `add_subject_mask` gains a `mode` (additive | subtractive | intersect).
  - `add_component(mask_id, type, mode, bbox?/geometry?)` — add a Subject/Radial/Linear/
    Brush sub-mask to an existing container (default subtractive) — the agent's version of
    the menu.
  - `set_submask_mode(sub_mask_id, mode)` — flip a component's mode.
  All three call the same `createSubMask` / `updateSubMask` a slider drag uses (D-020).
- **Why not SAM +/− points too:** they *are* slightly different (one segmentation call,
  both hints condition the same contour). But the marginal quality gain didn't justify a
  parallel mechanism + UI when composition covers the practical cases. The backend
  `points` support stays (unused) in case this is revisited.
- **Consequence:** no menu clutter, one refinement model, less code. The `ai/` `points`
  path is dead code for now — leave it, it's harmless and already tested.

## D-024 — Depth-haze preset: full-range inverted depth mask + static (non-tracked) depth
**decided (2026-09-01) · built (2026-09-01)**

- **Context:** roadmap item 4 / the Phase 2 checkpoint / the original "depth map and do
  haze" ask. One action → depth-weighted atmospheric haze on the background.
- **How the matte is built — options:**
  (a) a depth *band* mask over the far part of the range (what the depth-range picker is
      for) — but the picker's stored param space is inverted from its UI
      (`stored.minDepth = 100 - ui.maxDepth`), Depth Anything's ONNX output is bright=near,
      and `generate_ai_depth_bitmap` additionally weights by `depth_pct/100` (favouring
      near) — three sign traps stacked, and the near-weighting is backwards for haze;
  (b) **full range (`0–100`) + `invert: true`** — the mask value becomes `1 - proximity`
      = **distance**. No band edges to get wrong, and it is the physically correct haze
      falloff (haze accumulates with distance: subject ≈ 0, far wall ≈ max).
  (c) a Rust-side dedicated "atmosphere matte" generator.
- **Choice:** (b). Zero new engine mask code, robust against the sign traps, correct
  falloff. The container grade is the look: negative `dehaze` (adds haze in-shader) +
  `saturation -25` + `blacks +10` + `shadows +8`, all × `amount` (default 1.0). No blur
  (`MaskAdjustments` has no blur field — deferred).
- **Depth is a STATIC map, not tracked.** `generate_ai_depth_mask` bakes the depth PNG
  into the sub-mask params at apply time; every frame reuses it. Options were: bake-once
  (this), re-run per seek (expensive, flickers without temporal smoothing), or a full
  keyframed depth track (Phase 2 "Depth Anything V2 for video", still open). Bake-once is
  right for v1's one footage type (static-camera talking head). A moving camera → re-apply
  per section. To make a *re-apply on a new frame* actually use that frame's depth,
  `chroma_seek` now busts `state.ai_state.depth_map` (it was cache-keyed by
  `hash(path + geometry)`, both constant across a video's frames).
- **`protect_subject` is a v1 no-op flag.** A tracked `ai-subject` mask's own grade
  composites on top and keeps the subject punchy. Caveat: a subject standing in the
  far-depth band still gets some haze; the clean fix (an additive-depth + subtractive-
  subject composite in one container) is deferred — `add_component` (D-023) already
  exposes the mechanism manually.
- **Consequences:** `useAiMasking.handleAddDepthHaze`, one UI button, MCP `apply_haze`.
  Also pulled the Phase 4 "mount `useChromaControl` at app level" line forward (the
  required Rust rebuild restarts the app and drops the open clip, and the bridge was only
  alive in the editor view) + added an `open(path)` op/tool. Detail:
  `docs/notes/depth-haze.md`. Divergence in doc 09.

## D-026 — `match_to_reference` = a damped closed-loop nudge of five primary sliders (not a colour-science transform)
**decided (2026-09-01) · built (2026-09-01)**

- **Context:** round-2 item 1 — close the agent grading loop. `computeGap` (D-021)
  already turns a subject↔reference scope delta into knob-shaped hints; this makes
  it act: measure → adjust → re-measure until the gap is small.
- **Options for the correction:**
  (a) a colour-science match (Reinhard / MKL / Monge–Kantorovich) → a CDL or curve
      fragment, as the `docs/07` sketch's `method` param implied;
  (b) **a closed-loop nudge of the five primary balance sliders** (exposure,
      temperature, tint, contrast, saturation), re-measuring each step;
  (c) solve a 3×3 + offset in one shot from the two frames' channel stats.
- **Choice:** (b). (a)/(c) need pixel access to both frames in a matched colour
  space and a place to put a matrix/curve the grade doc doesn't model as a
  first-class thing yet; they're also opaque to the user. (b) reuses the exact
  knobs a human balances with, every step is a real `setAdjustments` (D-020) the
  user sees move, and the trace is legible. The `method` param is dropped for v1.
- **Merges into `primary`, not a new layer.** A reference match is a *balance*
  pass; the creative look (curves, wheels, film emulation) and mask work are
  separate. Documented in the tool text and the return `note`.
- **Gap → knob heuristics (the "why did they pick these numbers"):**
  - `exposure` ← the mids-luma gap (D-021's EV-ish formula) **plus** the
    common-mode black/white-point shift (`0.004·(Δbp+Δwp)`) — contrast can't fix a
    level offset because it pivots on mid-grey.
  - `temperature` ← `0.9 · ΔwarmCool`; scalar back-derived from the app's WB-picker
    (`ImageCanvas.tsx`: normalized R−B imbalance ×~125 → temp units) and the
    measured temp↔warmCool slope on real footage (~1.0–1.2).
  - `tint` ← `1.3 · ΔgreenMagenta` (same WB-picker basis, ×~400 → tint units).
  - `contrast` ← `0.45 · (Δwp − Δbp)` (the spread difference only).
  - `saturation` ← `130 · Δsat` where `Δsat` is the raw mean-HSV-sat **difference**
    (0–1), never the ratio (a ratio explodes when the subject starts near-grey).
- **Convergence machinery:** a combined scalar gap magnitude
  (`|EV|·8 + |ΔwarmCool| + |ΔgreenMagenta| + |Δsat|·20 + |Δbp| + |Δwp|`), damping
  `≈0.78` (near-constant — a fast per-iter decay double-counts against the already
  shrinking gap and stalls short), per-knob per-step ceilings (contrast/saturation
  tight — they amplify cast and clip channels, poisoning the next measurement),
  **roll-back any step that doesn't improve the magnitude** + halve strength, keep
  a **best-snapshot** and land on it, stop after 2 stalls / `max_iters` / a 16 s
  wall-clock budget (the control-server bridge times out at 20 s).
- **Consequences / limits:** the numbers come off a 512-px JPEG downsample (D-021),
  so the combined magnitude has a noise floor of roughly 10–20 — `tolerance` (3.0
  default) is rarely *reached* on a real shot; the tool's value is a monotone,
  legible reduction of the gap and casts pulled toward the reference, not a
  numeric bullseye. Zero engine-Rust changes (frontend op + MCP tool only). No
  `whites`/`blacks`/curve knobs in the loop yet. Detail:
  `docs/notes/match-reference.md`.

## D-025 — `grade.json` v1 = a versioned wrapper around `adjustments`, not the ordered `stack`; mattes externalized
**decided (2026-09-01) · built (2026-09-01)**

- **Context:** roadmap "Now" item 5 — lock "the grade is code" (the differentiator):
  save/load a git-committable grade document. `docs/06` had a DRAFT schema: an ordered
  `stack[]` of typed entries (`primary` / `curve` / `wheels` / `lut` / `masked` /
  `compound`) + a `masks{}` map + `meta.history`. But the canonical grade at runtime is
  RapidRAW's flat `adjustments` blob, owned by the frontend `useEditorStore` (D-020), and
  the renderer reads *that*.
- **Options:**
  (a) build `docs/06`'s ordered `stack` now — a lossy two-way map `stack ⇄ adjustments`
      maintained on every save/load/edit;
  (b) **a versioned, documented wrapper** — `{schema, shot, adjustments, notes}` — that
      embeds `adjustments` verbatim and only adds a schema tag, shot context, and matte
      externalization;
  (c) move the grade doc into Rust `AppState` and make *it* canonical (rejected by D-020
      as too invasive; also re-opens the divergence problem).
- **Choice:** (b). The `stack` model is real and still the plan, but it is the **v2 node
  graph's** data model (D-005) — "ordered non-destructive layers" + "parallel/serial/layer
  mixer". Re-modelling in v1 buys the user nothing and costs a fragile mapping layer +
  two sources of truth. v1 ships the honest wrapper; `chroma.grade/2` carries the `stack`
  when the node graph lands. `docs/06` rewritten; the `stack` sketch kept under "## v2".
- **Matte externalization:** a mask matte is MB of base64 → inlining kills the diff. On
  save, `subMasks[].parameters.maskDataBase64` (a static PNG) → written to
  `<gradeName>.mattes/<subMaskId>.png`, replaced by `{"$matte": "<relpath>"}`; a
  `chromaTrackDir` (per-frame matte folder, D-019) → `{"$trackDir": "<rel-or-abs>"}`,
  **referenced not copied**. Load reverses it. Caveat: moving a project needs the clip's
  `.chroma/mattes/` dir too (documented in `docs/06` + the `save_grade` tool text).
- **Schema gate:** `chroma.grade/<major>`; `load` migrates `major==1|missing` (identity
  stub), hard-errors a newer or unknown major.
- **Shape of the impl:** `engine/src-tauri/src/chroma/grade.rs` (new, pure JSON+fs, no
  GPU, no store) — `chroma_save_grade` / `chroma_load_grade`. Frontend `useChromaControl`
  ops `get_grade` / `save_grade` / `load_grade` (load → `setAdjustments(() =>
  normalizeLoadedAdjustments(g.adjustments))` → `bumpFrameNonce`). MCP: 3 tools. **v1 does
  not auto-switch clips** — `load_grade` flags a `shot.source` mismatch and applies anyway.
- **Consequences:** upstream footprint `pub mod grade;` + 2 `generate_handler!` lines.
  Full session/shot model (multiple shots, in/out, a shot strip) is still open — this is
  one grade per open clip. Detail: `docs/notes/grade-json.md`. Divergence in doc 09.
