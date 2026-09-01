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
