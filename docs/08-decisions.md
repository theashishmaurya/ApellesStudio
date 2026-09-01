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

## D-028 — Sidecar lifecycle: Rust-managed spawn + supervise, not `ai/run.sh` by hand
**decided (2026-09-01) · built (2026-09-01)**

- **Context:** round-2 item 3. Every AI feature (D-012 subject mask, D-016 matte
  refine, D-018 tracking) needs `ai/` up on `:8765`; until now the user had to
  remember `cd ai && ./run.sh` before opening the app, and a sidecar crash mid-
  session just left mask/track calls failing with "unreachable" until a manual
  restart.
- **Options:** (a) leave it manual, just document it better; (b) a shell script
  the app launches once and forgets (no crash recovery, no logs in `app.log`);
  (c) **Rust-owned spawn + supervise** — resolve python/venv, spawn
  `uvicorn`, pipe its logs into the app log, poll `/health`, restart on crash
  with backoff, kill it on quit.
- **Choice:** (c). It's the only option that survives a sidecar crash mid-
  session without the user noticing, and it puts uvicorn's own log lines where
  the rest of the app's diagnostics already live (`app.log`), not a second
  terminal window. An **already-running external sidecar is detected and left
  alone** — `ai/run.sh` for standalone testing still works, the app just
  doesn't fight it.
- **No new dependency.** The health check is a raw `TcpStream` HTTP/1.1 GET, not
  `reqwest`'s blocking client — the runtime `reqwest` here is async-only
  (`default-features = false`, no `blocking` feature; adding it would pull a
  second HTTP client stack for one GET). The child process comes from
  `std::process::Command` (already used elsewhere in the fork), not
  `tauri-plugin-shell` — no sidecar-specific shell-plugin permissions needed.
- **Backoff:** 2 s → 4 → 8 → 16 → 30 s cap; 6 consecutive failures each under
  60 s uptime drop to a 60 s slow-retry (assume it's broken, stop hammering);
  any run ≥ 60 s resets both counters. A missing venv/python re-resolves every
  30 s rather than erroring out — fixable without an app restart.
- **Exit-safety:** the owned `Child` lives behind a `Mutex` shared with the
  `.run(...)` exit hook (`RunEvent::ExitRequested` / `Exit`), which
  `kill()` + `wait()`s it *before* the existing `libc::_exit(0)` — that call
  doesn't run destructors, so the kill has to happen first, not via `Drop`.
- **Consequences:** `engine/src-tauri/src/chroma/sidecar.rs` (new, self-
  contained). `lib.rs` +1 spawn line, +2 `shutdown()` calls, +1 handler line;
  `chroma/mod.rs` +1. `chroma::mask`'s "unreachable" error hints now mention the
  auto-start + `CHROMA_AI_NO_SPAWN`. **Packaged-app path resolution is still
  open** — `resolve_ai_dir` keys off `CARGO_MANIFEST_DIR` (a dev-only path);
  Phase 4 packaging needs a resource-dir lookup or a bundled/frozen sidecar.
  Detail: `docs/notes/sidecar-lifecycle.md`. Divergence in doc 09.

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

## D-027 — Per-mask blur = one shared large-radius pre-blur, blended per mask (not a per-mask pass or global lens-blur)
**decided (2026-09-01) · built (2026-09-01)**

- **Context:** round-2 item 2. A `blur` on a mask's adjustments — completes the
  depth-haze preset (background defocus, deferred in D-024: "`MaskAdjustments` has
  no blur field") and unblocks "blur the background" as a mask op.
- **Options for the shader:**
  (a) **reuse `structure_blur_texture`** — a ~40 px·scale separable gaussian of the
      input that the shader *already* computes every render (for dehaze / glow /
      structure). Blend `mix(color, blurred, mask_weight·blur/100)` per mask in the
      grade compute pass. One `f32` on the struct, ~20 lines of WGSL, scales to all
      32 masks for free, no new texture / pass / bind-group entry.
  (b) a dedicated separable-gaussian pass per masked ROI, radius from `blur` —
      variable radius (more correct) but a real GPU pass per mask and new plumbing.
  (c) drive RapidRAW's **global** `lensBlur*` off the active mask's matte — global
      only, wires just depth-haze, leaves "blur any mask" unsolved.
- **Choice:** (a). Cheapest that works and it covers both use cases (depth-haze +
  generic mask blur). The radius is fixed (not driven by the slider — the slider is
  the blend amount), which is the accepted trade for v1; (b) is the upgrade path if
  a real variable defocus is wanted later.
- **Known limits (documented, `docs/notes/mask-blur.md`):**
  - the blurred sample is the **ungraded input** (a shared pre-pass), so under a
    heavy per-mask grade the defocused area carries slightly less of that grade;
  - **fixed radius** ~40 px at scale 1 (≈ the structure-blur radius);
  - blended in **linear light before tone-mapping**, right after the per-mask
    colour-grade loop — the sharp regions are fully graded, bokeh highlights roll
    off through the same transform as everything else.
- **Layout:** `blur: f32` **replaces `_pad_cg1`** in `MaskAdjustments` (Rust +
  WGSL) — struct size and every other field offset unchanged, so `bytemuck` /
  `AllAdjustments` buffer size are untouched.
- **Surface:** frontend `INITIAL_MASK_ADJUSTMENTS.blur = 0` + a "Blur" slider
  (0–100, mask-only) in `Details.tsx`'s Presence group; `set_mask_adjust` whitelist
  gains `blur` (a new `MASK_ONLY_KNOBS` set, so `set_primary` still rejects it);
  `handleAddDepthHaze` adds `blur: min(40, 12·amount)`. Also added a small
  `add_mask(type, geometry)` op (new radial/linear container) — the agent had no
  way to make a plain shape mask headlessly (`add_subject_mask` / `apply_haze` are
  AI mattes, `add_component` only carves into an existing container).
- **Verified** on the C019 talking-head: a radial mask + `blur 70` drops masked
  local contrast (max−min spread, ΣRGB) ~25–35 % (−42 / −75 / −27 at three edge
  patches) while unmasked patches move exactly 0; `blur 0` restores byte-identical
  output. `apply_haze` now softens background edges (~10 % std drop) on top of the
  haze, subject untouched. Blur survives to an H.264 export. No wgsl compile error.
  Detail: `docs/notes/mask-blur.md`. Divergence in doc 09.

---

## D-029 — Strip `@clerk/react` instead of wiring it to anything
**decided (2026-09-02) · built (2026-09-02)**

- **Context:** round-2 item 4. RapidRAW ships `@clerk/react` for a hosted account
  (community presets + its own cloud generative-AI features). In our fork it did
  nothing useful but cost us: a hard-coded `pk_test_…` dev key in `App.tsx`, a
  `<ClerkProvider>` at the tree root, a `<TitleBar>` React error and repeated
  "Clerk has been loaded with development keys" console warnings on every launch.
- **Options:** (a) leave it, ignore the noise; (b) register a real Clerk app and
  wire it up; (c) **remove the dep**, stub the three hook call sites.
- **Choice:** (c). Chroma has no cloud — every model runs locally (the `ai/`
  sidecar + in-process ONNX, D-009/D-028), so there is nothing to authenticate
  against. (b) would add a signup wall for a feature we don't have; (a) leaves a
  third-party auth SDK loaded on every start for no reason.
- **Shape:** `useUser` → `{ user: null }`, `useAuth` → `{ getToken: async () =>
  null }`, `useClerk` → `{ signOut: async () => {} }` as local consts at each of
  the 3 call sites (`useAiMasking.ts`, `AIPanel.tsx`, `SettingsPanel.tsx`).
  RapidRAW's cloud paths already treat a null token as "signed out", so they
  compile and no-op cleanly. The Settings `<SignIn>` / `<CloudDashboard>` block
  becomes a one-line "Chroma runs all AI locally" note (`CloudDashboard` left in
  as dead code — small, harmless, easier upstream merges).
- **Verified:** `npm install` clean (0 `@clerk` in the lockfile), `tsc --noEmit`
  shows only pre-existing unrelated errors, app rebuilds + launches with no
  `<TitleBar>` error and no Clerk warnings in `app.log`, control bridge healthy.
  Frontend-only, no Rust change. Divergence in doc 09.

## D-030 — Smooth playback = one persistent sequential-decode pipe per clip (not a proxy file)
**decided (2026-09-02) · built (2026-09-02)**

- **Context:** round-2 item 5 (D-015 / D-022 flagged it). Scrub + play ran
  ~1–10 fps: every playback frame paid a fresh `ffmpeg` spawn + a keyframe seek +
  a PNG encode/decode round-trip (`video::decode_frame`). Export had the sibling
  bug — a `from > 0` range still decoded from frame 0
  (`select=between(n,FROM,TO)`, chosen in D-022 for matte safety).
- **Options:** (a) **one long-lived `ffmpeg -f rawvideo` pipe per clip, sequential
  reads, keyframe-seek respawn on a jump**; (b) a pre-rendered half/quarter-res
  proxy `.mov`; (c) an in-memory ring buffer of decoded frames; (d) playback that
  skips the GPU grade or approximates it with a cached LUT. Full table in
  `docs/notes/smooth-playback.md`.
- **Choice:** (a). Cheapest thing that materially helps (the D-027/D-028 bias):
  ~120 lines, isolated to a new `src/chroma/decode_pipe.rs`, no new failure mode
  (any pipe error falls back to `video::decode_frame`). (b) is a whole subsystem
  and the grade still runs per frame; (c) needs (a) to fill it and 24 MB/frame at
  4K; (d) shows the wrong pixels in a grading tool.
- **Pipe:** `ffmpeg -ss <(start-0.5)/fps> -i clip -an -sn -f rawvideo -pix_fmt
  rgb24 -`. `-ss` before `-i` is an accurate seek that lands exactly on `start`
  for CFR footage; the half-frame margin points backward so an `avg_frame_rate`
  vs `r_frame_rate` rounding wobble can't skip forward. `frame(target)`: one
  `read_exact` for a step, discard-to-target for a ≤48-frame forward hop,
  kill+respawn otherwise. Raw rgb24 ⇒ no PNG round-trip. Process-global
  `Mutex<Option<FramePipe>>`; `state::set_current_video` drops it on a clip-path
  change; `Drop` kills the child.
- **Export half:** `spawn_decoder` now seeks — `-ss <(from/fps)-1s> -copyts` +
  `select=gte(t,(from-0.5)/fps)` + `-frames:v count`. The fix vs D-022's worry is
  selecting by **absolute timestamp `t`**, not decoded-frame index `n`, so an
  input `-ss` no longer desyncs the per-frame tracked mattes (D-019). `from = 0`
  is byte-for-byte unchanged.
- **Not done (still open, in the roadmap + note):** the frontend re-runs a
  full-res WGSL grade + an IPC JPEG per seeked frame — that's the remaining fps
  ceiling for a heavy grade. Proxy files (b) stay deferred.
- **Verified:** `cargo check --no-default-features` clean; `cargo test chroma::`
  14/14 — new `pipe_matches_single_frame_decode` / `pipe_forward_skip_and_backward_restart`
  (pipe frames byte-match `decode_frame`, mean|Δ| < 1) and `seeked_decoder_is_frame_aligned`
  (export decoder frame-exact vs the old walk-from-0 path); `export_neutral_30_frames`
  / `export_exposure_brighter` / `export_tracked_range` still green. Measured on
  C019 (3840×2160 HEVC, 24fps): 24 sequential frames **0.61 s (~39 fps)** via the
  pipe vs **15.3 s (~1.6 fps)** as 24 spawns; a mid-clip export frame **0.83 s**
  vs **2.9 s**. App not driven manually (a `tauri dev` was already running) —
  Rust + ffmpeg paths verified instead; a manual scrub/play smoke test is the one
  open check. Divergence in doc 09. Detail: `docs/notes/smooth-playback.md`.
- **Follow-up:** the "frontend regrade + IPC" ceiling is **closed by D-031**.

## D-031 — Real-time playback = a fused decode+grade command at reduced res, driven by a wall-clock rAF loop (not per-frame `chroma_seek` + `apply_adjustments`)
**decided (2026-09-02) · built (2026-09-02)**

- **Context:** round-2 item 5 tail. D-030 fixed *decode* (~1.6 → ~39 fps raw) but
  named the real ceiling: per playback frame the frontend did **two** IPC calls
  (`chroma_seek` then `apply_adjustments`) with a React `frameNonce` round-trip
  between them, a frame-dropping `seekInFlight` mutex, a `setInterval` with no
  wall-clock sync, and — because `calculateTargetRes()` snaps to the source long
  edge for 4K footage — a **full-4K** WGSL grade *plus* a ~40 ms/frame CPU
  `downscale_f32_image`. Headless proxy at 4K: **14.5 fps** (39 ms downscale,
  25 ms grade, 5 ms decode).
- **Options (per the brief):** (1) grade at ~1280 px during playback; (2) kill
  the nonce/debounce path for playback; (3) one fused Rust command
  (decode+swap+grade in one IPC); (4) a decode-ahead worker; (5) a
  `requestAnimationFrame` + wall-clock frontend loop. Full table:
  `docs/notes/playback-30fps.md`.
- **Choice:** **1 + 2 + 3 + 5**, and do the downscale **in ffmpeg, not the CPU.**
  Measurement drove the last part: after (1) the CPU downscale *becomes* the
  bottleneck (39 ms > the grade), so the decode pipe grows an optional
  `-vf scale=` and decodes straight to playback res (~0.8 ms/frame, SIMD) —
  `AppState.original_image` is then already ≤ playback res and
  `generate_transformed_preview` does no downscale at all.
  - `decode_pipe.rs` +`scale_target` / `open_scaled` / `frame_scaled` /
    `playback_frame_scaled` (an `Option<(w,h)>`; a scale change = one respawn).
    D-030's native `open` / `frame` / `playback_frame` stay as
    `..._scaled(.., None)` wrappers — D-030's tests untouched.
  - new `src/chroma/playback.rs::chroma_play_frame(frame, jsAdjustments,
    targetResolution)` — `commands::seek_and_install(frame, Some(dim), state)`
    (the extracted `chroma_seek` body: clear per-frame caches, scaled decode,
    swap `original_image`, set `CurrentVideo.frame` for the D-019 matte) → **one**
    `PreviewJob` at `target_resolution = dim` → await → return its bytes. One IPC
    call, no nonce, no React hop. The loop awaits each job before requesting the
    next, so frame and tracked matte cannot desync; `seek_and_install` clearing
    `cached_preview` + `gpu_image_cache` is what stops `process_preview_job`
    reusing the prior frame's cached base (adjustments hash is constant across a
    run — same reason `export.rs` keys `transform_hash` by frame).
  - `ChromaTimeline.tsx` — `setInterval` + `seekInFlight` mutex + the
    `goToFrame→doSeek→nonce` chain replaced, **for playback only**, by a rAF loop
    against a wall clock (`want = startFrame + floor(elapsed·fps)`, skip missed
    frames, one `invoke('chroma_play_frame')` at a time). Pause → one
    `goToFrame(currentFrame)` re-decodes native + regrades full-res. **Scrub is
    unchanged** (`chroma_seek` + nonce at `calculateTargetRes()`).
  - (4) decode-ahead **not needed** — scaled decode is ~3 % of the frame budget.
- **`PLAYBACK_LONG_EDGE = 1280`** (a `ChromaTimeline.tsx` constant). Quality at
  rest is unchanged (pause settles full-res); nobody pixel-peeps at 30 fps.
  Drop toward 960 (50 fps headless) if a low-end GPU can't hold 30.
- **Verified:** `cargo check --no-default-features` clean; `cargo test
  --no-default-features chroma::` **18/18** (new `scale_target_math`,
  `scaled_pipe_is_sequential_and_downscaled`, `playback_dim_clamps`,
  `playback_throughput_c019`; D-030 + export tests still green). Frontend `tsc
  --noEmit` — only the pre-existing unrelated errors, none in `ChromaTimeline`.
  Headless timing harness on C019 (4K/24p), 60 frames, real grade via
  `render_core::render` @ 1280 px long edge: **27.4 ms/frame → 36.5 fps** (scaled
  decode 0.83 ms + grade 26.6 ms), vs **68.8 ms/frame → 14.5 fps** on the old 4K
  path; **19.6 ms → 50.9 fps** at 960 px. Clears the 30 fps bar the user asked
  for, with margin for the IPC hop + wgpu surface present that end-to-end adds.
  App not driven (a `tauri dev` was running); the 5-step scrub/play/tracked-matte
  smoke test is the open human check (listed in the note). Divergence in doc 09.
  Detail: `docs/notes/playback-30fps.md`.

## D-032 — Agent activity feed = a session-only log recorded at the bridge chokepoint, jump-to-here undo; `request_human` = a non-blocking single-slot handoff
**decided (2026-09-02) · built (2026-09-02)**

- **Context:** round-3 item 1. The vision's core intent
  (`docs/00-vision.md`): "whatever edit the agent makes I can see and make
  changes — one shared state", and "hand back to a human when it's unsure".
  Two deliverables: a GUI feed of every agent change (per-change diff + undo),
  and `request_human(reason, roi?)`.
- **Where to record the feed:**
  (a) **the `chroma://request` handler in `useChromaControl.ts`** — every MCP op
      already funnels through it; snapshot the grade + `historyIndex` before
      `fn`, diff after;
  (b) wrap each `OPS` entry;
  (c) a Rust-side log in `control.rs`;
  (d) diff RapidRAW's `history[]` stack directly.
  → **(a).** One place, ~40 lines, no per-op boilerplate, and it already holds
  the `before`/`after` render settle. (b) is N edits that drift. (c) can't see
  the grade (it lives in the frontend — D-020). (d) can't attribute a history
  entry to *which* op caused it, and the 500 ms `debouncedSetHistory` coalesces
  agent + human edits together.
- **One entry per op, not per internal step:** after the op settles, call
  `debouncedSetHistory.flush()` to force the pending history push *now*, so a
  mutating op = exactly one history entry. `match_reference`'s ~5 internal
  `setAdjustments` iterations → one feed entry (`gap 78→10`), one history entry.
- **Undo model:**
  (a) **jump-to-here** — revert the grade to `historyIndexBefore`, mark this
      feed entry + all newer ones `undone` (they built on this op);
  (b) a branching timeline / per-op selective revert;
  (c) inverse-patch replay.
  → **(a)** — it's the history slider's existing semantics, honest, and cheap
  (D-027/D-030 bias). (b)/(c) are a real subsystem for a v1 feed. **Documented
  limitations:** middle-undo drops newer feed entries; if >50 mutations pushed
  the pre-op state off RapidRAW's 50-slot `history[]`, undo falls back to
  restoring the stored `adjustmentsBefore` snapshot as a new forward edit (the
  feed entry always keeps the snapshot). `seek` / `open` (pure navigation) are
  not logged.
- **`request_human` = non-blocking, single-slot:**
  (a) **post a request → return an ack immediately;** the user clears it; the
      agent polls `get_state().pendingHumanRequest`;
  (b) hold the MCP call open until the user responds (minutes — trips the 20 s
      bridge timeout, blocks the agent);
  (c) a separate response channel.
  → **(a).** `roi` is normalised `{x,y,w,h}` 0..1, clamped on receipt, drawn as
  an amber rect + outside-dim on the canvas (reusing the mask-overlay coordinate
  space). Last-write-wins (one slot). Zero Rust — it rides the generic
  `POST /op` path like every other op.
- **Store:** a new `engine/src/store/useAgentStore.ts` (not folded into
  `useEditorStore` / `useChromaStore`) — same fork-hygiene rationale as
  `useChromaStore` (D-003). Session-only; not in `grade.json`.
- **Consequences / footprint:** new files `useAgentStore.ts`,
  `utils/agentActivity.ts` (`diffAdjustments` + `summarizeActivity`, pure),
  `components/chroma/AgentActivityDock.tsx` + `AgentRoiHighlight.tsx`. Upstream
  edits: `App.tsx` +2, `ImageCanvas.tsx` +2 (`useChromaControl.ts` is a
  Chroma-only file). MCP: +1 tool (`request_human`), 23 → 24.
- **Verified:** frontend `npx tsc --noEmit` — 74 errors, all pre-existing and
  unrelated (identical to the pre-change baseline), **none** in any touched or
  new file. `python3 -m py_compile mcp/server.py` clean. **No Rust change** — the
  op is handled entirely in `useChromaControl.ts`'s `OPS`; `cargo` untouched, so
  `chroma::` tests are unaffected. The `useEffect([])` bridge listener does not
  hot-reload (documented gotcha), so the running-app path (feed populates, diff
  expands, undo reverts, `request_human` banner + ROI) is an open **manual**
  smoke test — listed in `docs/notes/agent-activity-feed.md`. Divergence in
  doc 09.

## D-033 — Multi-shot session = an in-memory `Session` + per-clip `grade.json` sidecars; NOT a `.chroma` project bundle
**decided (2026-09-02) · built (2026-09-02)**

- **Context:** round-3 item 2. Chroma loaded exactly one clip — `chroma/state.rs`
  said so ("There is only ever one clip loaded, so a module global is enough for
  now"), and D-025 left "full session/shot model" open. A real grading job is N
  shots from one shoot, each needing its own grade, with the ability to flip
  between them and copy a grade across.
- **The question put to the user:** lightweight (N open clips + a strip to
  switch, each keeps its own `grade.json`, no project file) **vs** a full project
  model (a saved `.chroma` bundle of all shots + grades + refs + session state).
  Answer: "do whichever is better."
- **Options:**
  (a) **lightweight** — a process-global `Session { shots: Vec<Shot>, active }`,
      each `Shot = {path, VideoInfo, playhead}`; per-shot grade + activity feed
      live in the frontend stores keyed by clip path; `grade.json` (D-025) stays
      the on-disk per-shot serialisation; no session file (a `.chroma/session.json`
      path list is a later add).
  (b) **full project bundle** — a `.chroma` file format wrapping every shot ref +
      its grade + reference images + window/session state, with save/open-project
      UX and a migrator.
  (c) a hybrid: `Session` now + `.chroma/session.json` (just the shot-path list,
      pointing at each clip's `grade.json` sidecar) as the reopen mechanism.
- **Choice: (a) now, (c)'s `session.json` deferred.** Weighed against this
  project's established bias — "cheapest thing that works" (D-027/D-030/D-031),
  minimal fork diff (D-003), docs-as-source-of-truth, one shared state with the
  agent (D-020/D-032):
  - (b) is a whole subsystem: a new format + serializer + migrator + a
    save/open-project surface + conflict rules against the `grade.json` sidecars
    that *already exist* and are the git-committable differentiator (D-025).
    Nothing in v1's job (Phase 3 checkpoint — grade a shoot in one conversation)
    needs a bundle: the shots are on disk, the grades are sidecars.
  - (a) is ~1 file of new Rust (`chroma/session.rs`) + a `Session` type in
    `state.rs` + 3 new frontend files. `current_video()` keeps its signature and
    returns the active shot, so every existing caller (`chroma_seek`, `export`,
    `mask`, `playback`) is untouched. The blast radius is a module global, not an
    `AppState` refactor.
  - reopening a session is the one thing (a) gives up vs (b)/(c). A shot-path
    list in `.chroma/session.json` recovers it without a bundle — deferred as a
    follow-up, not designed away.
- **Data model.** `state.rs`: `Session { shots: Vec<Shot>, active: usize }`
  (`Shot` = the old `CurrentVideo` — `{path, VideoInfo, frame}` — name kept so
  D-015…D-032 call sites don't churn). `set_current_video(Some(shot))` **upserts
  by path**: a fresh clip appends a shot and makes it active; a seek / re-open of
  a clip already in the session updates it in place. `set_current_video(None)`
  clears the session. Thumb cache + decode pipe (D-030) reset exactly when the
  *active clip path* changes — same trigger as before, now driven off the
  session. Per-shot **grade** + **activity feed** are frontend state
  (`useSessionStore.grades[path]`, `useAgentStore.shotFeeds[path]`) — switching a
  shot stashes the live grade under the outgoing path, restores the target's (or
  neutral) via `setAdjustments` + `resetHistory`, and calls
  `useAgentStore.scopeToShot`. `grade.json` (D-025) is unchanged — it is still
  *the* per-shot document; a shot's grade saves to `<clip>.grade.json` beside it.
- **Consequences / built:**
  - Rust: new `chroma/session.rs` — `chroma_session_list` / `_add` /
    `_set_active` / `_remove` / `_thumbnail`. `state.rs` grows the `Session`
    struct (pure, unit-tested) + module-global wrappers. `video.rs` +1 helper
    (`extract_thumb`, one small preview per shot). Upstream footprint: `mod.rs`
    +2, `lib.rs` +5 `generate_handler!` lines. No `AppState` / image-loader
    change — the file-picker / `open` flow funnels into `load_video_frame` →
    `set_current_video` → upsert, so opening a second clip *is* adding a shot.
  - Frontend: new `store/useSessionStore.ts` (shot list + `grades` cache +
    switch/add/remove/copy thunks), `components/chroma/ShotStrip.tsx` (the strip
    — replaces the folder browser per doc 09), `useAgentStore` += per-shot feed
    scoping. `useChromaControl.ts` += `list_shots` / `set_active_shot` /
    `add_shots` ops; `get_state` += `session`. `BottomBar.tsx` renders the strip
    + a sync effect. MCP: +3 tools (`list_shots`, `set_active_shot`, `add_shots`)
    — 24 → 27.
  - Single-shot behaviour is identical: opening one clip is a session of one
    shot; `current_video()` returns it; seek / playback / export / tracking /
    activity feed / `grade.json` all unchanged.
- **Deferred (roadmap follow-ups, not half-built):** `.chroma/session.json`
  reopen (shot-path list only, still no bundle); drag-drop shot reorder; a
  copy-grade-to-any-shot picker (v1 copies to the *next* shot only); per-shot
  `grade.json` auto-load on `add_shots` (v1 loads neutral, D-025's `load_grade`
  is manual); still images in the session (video shots only for now).
- **Verified:** `cargo check --no-default-features` clean; `cargo test
  --no-default-features chroma::` **23/23** (18 baseline + 5 new: session
  add/list/set-active/remove, upsert-by-path switches active, remove clamps
  active, single-shot path unchanged, active-shot change busts the thumb cache).
  Frontend `npx tsc --noEmit` — 74 pre-existing unrelated errors (baseline
  unchanged), none in a new/touched file. `python3 -m py_compile mcp/server.py`
  clean; `import server` OK, 27 tools. The `useEffect([])` bridge listener +
  the running app are not driven (a `tauri dev` is running) — the strip
  interaction + MCP round-trip are an open **manual** smoke test, listed in
  `docs/notes/multi-shot.md`. Divergence in doc 09.

## D-034 — Mask keyframes = interpolate the sub-mask's geometry `parameters` at render time (one hook, mirrors D-019); linear scalars, shortest-arc rotation, brush points snap-or-lerp
**decided (2026-09-02) · built (2026-09-02)**

- **Context:** round-3 item "mask keyframes". A shape sub-mask (radial / linear /
  brush) is static — its geometry is one value for the whole clip. For a subject
  that moves but that SAM can't / shouldn't track (a hand, a product, a light, a
  reflection, a region of sky) the user needs to keyframe the mask's geometry
  over source frames and have it interpolate per frame on scrub / playback /
  export. Geometry only — **not** the grade adjustments (a separate future item).
- **Where the interpolation happens:**
  (a) frontend swaps `parameters` on every seek (the pattern D-019 explicitly
      rejected — overlay-regen storm, frame vs matte desync, timeline lockup);
  (b) a keyframed-mask concept baked into RapidRAW's `MaskDefinition` /
      `image_processing` (deep upstream surface);
  (c) **read the keyframes at render time** — `generate_sub_mask_bitmap`
      interpolates `parameters` for `chroma::state::current_video().frame` (the
      frame `export.rs` / `playback.rs` / scrub already set for the D-019 tracked
      matte) and proceeds with the interpolated value. One hook call, exactly
      like D-019's `tracked_full_mask`.
- **Choice: (c).** Same rationale as D-019: matte and frame are one render pass,
  in lockstep; a seek is just the existing re-render; zero per-frame frontend
  state churn; scrub + playback + export animate **for free** (verified — all
  three drive `set_current_frame` / `install_frame` per frame). Fork diff is one
  hook line in `mask_generation.rs` + a new `chroma/keyframes.rs` (D-003).
- **Data model (extends grade.json, D-025).** `parameters.chromaKeyframes` =
  an ordered `[{ frame: u64, params: { …geometry subset… } }]`. Geometry subset
  per type — radial: `centerX/centerY/radiusX/radiusY/rotation/feather`;
  linear: `startX/startY/endX/endY/range`; brush/flow: `lines`. `mode` / `invert`
  / `opacity` and the grade stay on the sub-mask. **Absent by default** — a
  sub-mask with no `chromaKeyframes` is byte-identical to today (the hook returns
  `None` before any clone). Round-trips through `grade.json` as plain JSON (tiny
  numbers, kept inline — no matte externalisation). `docs/notes/grade-json.md`
  updated.
- **Interpolation rules (deterministic, cheap — a handful of `f64` lerps):**
  - scalars: linear between the two bracketing keys.
  - **`rotation`: shortest signed arc** (350° → 10° passes through 0°, not 180°).
  - before the first key / after the last: **clamp (hold)** that key. One key ⇒
    that key everywhere.
  - exact-on-key ⇒ that key's params. A field in only one bracketing key ⇒ held.
  - **brush `points` / `lines`**: interpolated element-wise **only when the two
    bracketing keys have identical structure** (same line count, same points per
    line). Otherwise the field **snaps to the nearer key** (`t < 0.5` → low).
    Any non-numeric / shape-mismatched field snaps the same way. Documented
    limitation — a brush mask whose stroke changes point count between keys jumps
    rather than morphs.
  - all interpolated numbers rounded to 6 dp (no float dust in `grade.json`).
- **Tracked and keyframed are mutually exclusive per sub-mask.** If both
  `chromaTrackDir` (D-019) and `chromaKeyframes` are somehow present, **tracked
  wins** — `interpolated_parameters` returns `None`. The frontend / MCP block
  creating one on top of the other.
- **No video loaded (a still):** `interpolated_parameters` returns `None` — a
  still renders byte-identical. Keyframes are meaningless without a frame axis.
- **Frontend.** New `engine/src/utils/maskKeyframes.ts` mirrors the Rust
  interpolator (same rules, same cases) so the canvas overlay shows the
  **interpolated** shape at the current frame ("what you see is what renders")
  and the keyframe button / canvas-drag writer share one code path. New
  `engine/src/components/chroma/MaskKeyframeBar.tsx` (mounted in the Chroma-owned
  `ChromaTimeline`): a "◆ Keyframe mask" button that snapshots the active shape
  sub-mask's geometry at the current frame (re-press = update), a diamond track
  (click a diamond to seek), delete-this-key, clear-all. **Dragging the mask on
  the canvas** when keyframes exist writes/updates the key at the current frame
  (`ImageCanvas.tsx` — a keyframe-aware `updateSubMask` wrapper + the overlay
  reads interpolated params). Upstream-file edits: `ImageCanvas.tsx` +~4 (import
  + `chromaFrame` + the wrapper + the overlay param swap). `useChromaControl.ts`
  (Chroma-only) += `add_mask_keyframe` / `list_mask_keyframes` /
  `clear_mask_keyframe` / `clear_mask_keyframes` ops.
- **MCP.** 4 tools: `add_mask_keyframe(mask_id, sub_mask_id, frame?)`,
  `list_mask_keyframes`, `clear_mask_keyframe(…, frame)`, `clear_mask_keyframes`.
  27 → 31. The agent workflow: "seek 0, radial over the face, add_mask_keyframe;
  seek 90, reposition, add_mask_keyframe" — hand-tracking without SAM.
- **Consequences / footprint.** New: `chroma/keyframes.rs` (pure + 14 unit
  tests), `src/utils/maskKeyframes.ts`, `src/components/chroma/MaskKeyframeBar.tsx`.
  Upstream edits: `mask_generation.rs` +1 hook call, `chroma/mod.rs` +2,
  `ImageCanvas.tsx` +~4. No `lib.rs` / Cargo / `AppState` change (the ops ride
  the generic `POST /op` bridge — no new tauri command). Cost: the interpolated
  common path is `None` (zero-cost); a keyframed sub-mask clones its `parameters`
  `Value` + interpolates once per render (~µs).
- **Verified (2026-09-02).** `cargo check --no-default-features` clean;
  `cargo test --no-default-features chroma::` **37/37** (23 baseline + 14
  keyframe: empty / one key / before-first / after-last / exact-on-key /
  between-keys per field / rotation shortest-arc both directions / brush points
  lerp + snap / field-held / sorted / un-keyframed→None / tracked-wins→None).
  Frontend `npx tsc --noEmit` — **74** pre-existing unrelated errors (baseline
  unchanged), none in a new / touched file. `python3 -m py_compile mcp/server.py`
  clean; `import server` OK, **31** tools. Export (D-022) + playback (D-031)
  confirmed to interpolate for free by reading `export.rs`
  (`set_current_frame(frame_index)` per frame) + `playback.rs` /
  `commands::seek_and_install` (`install_frame` → `set_current_video(…frame)`).
  The `useEffect([])` bridge listener + the running app aren't driven (a
  `tauri dev` is running) — the keyframe-bar interaction, canvas-drag-writes-key,
  and interpolated-overlay are an open **manual** smoke test, listed in
  `docs/notes/mask-keyframes.md`. Divergence in doc 09.
- **Deferred:** grade-adjustment keyframing (a separate item); easing / bezier
  handles (linear only); a keyframe on `mode` / `invert`; a full timeline dope
  sheet (the diamond track is deliberately minimal).

## D-035 — Agent eval harness = a task set + an OFFLINE approximate-render scorer + a committed baseline; the closed loop is a runbook, not CI
**decided (2026-09-02) · built (2026-09-02)**

- **Context:** round-3 tail — "agent eval harness". The thesis
  (`docs/notes/agent-visual-feedback.md`) is that the grading agent must **grade
  by the numbers**: measure scopes → adjust → re-measure, toward a target. We
  need a repeatable check that the agent (its MCP tools + skill + prompt) *does*
  that and gets **closer** to a target rather than confidently drifting — a
  regression + capability test for the agent, not a user feature.
- **What a run needs vs what CI can have.** A true closed-loop run is: open a
  clip in the app → drive the agent over MCP with the grading skill → agent saves
  `grade.json` → score it. That needs the running app **and** a live agent —
  not CI-able. So the harness splits:
  - **`eval/run.md`** — the manual/CI-with-an-agent runbook for the full closed
    loop (per task: `open` the fixture, hand the agent the task's `description` +
    goal, let it work, `save_grade` to `eval/results/<id>.grade.json`, optionally
    drop the rendered frame as `<id>.result.png`, then score).
  - **`eval/score.mjs`** — the CI-able part. Scores a directory of
    `<id>.grade.json` / `<id>.result.png` against `eval/tasks.json`, prints a
    table + rollup, diffs against `eval/baseline.json`, exits non-zero on a
    regression. **No app, no agent, no network** — `node eval/score.mjs
    eval/results`.
- **The scorer's render problem — options:**
  (a) **shell out to the engine** — a `render_core` example / `chroma_` command
      that renders the fixture through the `grade.json` and emits `computeScopes`
      JSON. Most accurate; needs the engine built; not CI-able without a GPU
      box; adds an upstream-adjacent binary.
  (b) **standalone port** — mirror `computeScopes` / `computeGap` /
      `gapMagnitude` in Node (`eval/lib/scopes.mjs`, constants copied verbatim
      from `scopes.ts`, drift-guarded by `eval/lib/scopes.check.mjs`) **plus** an
      *approximate* primary-grade operator (`eval/lib/apply.mjs`: exposure /
      contrast / temp / tint / saturation / black-white points / hi-lo tone
      regions + radial & rect masks) that turns a `grade.json` into a scoped
      result frame offline.
- **Choice: (b).** The CI-able regression gate is worth more than absolute
  fidelity. The approximate operator's consequence — **absolute scores are only
  comparable within the harness** (same operator for baseline, "good", and agent
  results) — is acceptable because the harness measures *movement toward a
  target vs a committed floor*, not a colour-science ground truth. Fidelity to
  the real engine is what `eval/run.md` + `inspect_color` cover: that path scores
  the app's real render. The operator ignores curves / wheels / LUT / HSL, so
  **tasks are authored to be solvable with primary knobs** — the same scope as
  `match_to_reference` (D-026).
- **Task set (7, `eval/tasks.json`):** neutralise a colour cast toward a neutral
  reference; match a shot to a hero reference (the D-026 workflow); set
  black/white points without clipping; fix a −1.1 EV exposure error; **don't
  over-grade** a frame that is already correct (floor = 1.0, the agent can only
  hold or lose; a `knobEffort` gate hard-fails a confident over-correction);
  grade only a masked region (radial sub-mask) with the background provably
  unmoved; tame blown highlights without crushing the shadows. Fixtures
  (`eval/fixtures/`, 480×270, regenerable via `_gen.mjs`): a downscaled C019
  still from `scratch/` for the realistic tasks, synthesised wedge / patch frames
  for the levels + mask tasks, each derived state baked with the same
  `apply.mjs` operator.
- **Score = normalised inverse residual gap.** Per check: `1` when the metric is
  within tolerance, `0` when no better than the unfixed setup (the baseline
  value, computed live), linear between. Task score = mean of checks × hard-fail
  gates (`clipIntroduced`, background moved on a mask task, `knobEffort` blown).
  `eval/baseline.json` (committed) = every task scored with the setup left
  unfixed — mean **0.452**, 2/7 pass. The seven hand-authored "good"
  `grade.json` results in `eval/results/` score mean **0.975**, 7/7, every task
  up vs baseline; `eval/bad_examples/` (desaturate-to-hide-a-cast,
  exposure +2.4, punch-up-an-already-fine-frame) score **0.0** with the gates
  firing — the scorer ranks good ≫ bad in both directions.
- **MCP discipline (agent-visual-feedback §"What this means for Chroma's MCP").**
  The measure-first language was already in-band (`inspect_color`, `set_primary`,
  `match_to_reference`, `set_mask_adjust`, server `instructions`). Added the one
  missing piece — the **adversarial** framing ("assume the grade is still
  flawed; hunt for the cast/clip/crushed channel you have not ruled out") — to
  the shared `SCOPE_DISCIPLINE` string, `inspect_color`, and `mcp/README.md`.
  Tool count unchanged (**31**).
- **Consequences / footprint.** New top-level `eval/` (parent repo only). **Zero
  engine changes**, zero upstream edits, no new deps (Node built-ins: `zlib` for
  the PNG codec). `eval/score.mjs` is the CI hook. Not done: wiring it into an
  actual CI workflow file; an engine-backed exact scorer (option (a)) as a later
  accuracy upgrade; a fixture task that exercises curves/wheels once the operator
  or an engine scorer can see them. Detail: `docs/notes/eval-harness.md`.
