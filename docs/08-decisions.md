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
  Module: `app/src-tauri/src/chroma/video.rs`.
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
- **Consequences:** `app/src/utils/scopes.ts` (new, pure, no deps). The
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
- **Consequences:** `app/src-tauri/src/chroma/sidecar.rs` (new, self-
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
- **Shape of the impl:** `app/src-tauri/src/chroma/grade.rs` (new, pure JSON+fs, no
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
- **Store:** a new `app/src/store/useAgentStore.ts` (not folded into
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
**decided (2026-09-02) · built (2026-09-02) · session persistence superseded by D-037 (2026-09-02)**

> **Update (D-037):** the deferred `.chroma/session.json` reopen path is now
> **D-037's project model** — a `<name>.chroma` *directory* (`project.json` +
> `thumb.jpg` + `grades/`). D-033's in-memory `Session { shots, active }` is
> unchanged; it is now the *loaded form* of a saved project. This record stays
> as the multi-shot design; the "no bundle" call is what D-037 revisits — and it
> still isn't a bundle, it's a folder of plain diff-able files.

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
- **Frontend.** New `app/src/utils/maskKeyframes.ts` mirrors the Rust
  interpolator (same rules, same cases) so the canvas overlay shows the
  **interpolated** shape at the current frame ("what you see is what renders")
  and the keyframe button / canvas-drag writer share one code path. New
  `app/src/components/chroma/MaskKeyframeBar.tsx` (mounted in the Chroma-owned
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

## D-036 — Per-frame depth = a temporal video-depth **track** (Video Depth Anything — Small), in the `ai/` sidecar; render-time read mirrors the subject track (D-019)
**decided (2026-09-02) · built (2026-09-02)**

- **Context:** the depth-haze preset (D-024) bakes ONE Depth Anything V2 map — the
  frame it was applied on — into the sub-mask and every frame reuses it. On a
  moving camera the depth is wrong for every other frame: the haze crawls, the
  separation slips. D-024 itself flagged "keyframed / temporally-smoothed depth
  track" as still open. The ask: a *proper* depth track — per-frame, temporally
  stable, read at render time keyed by the current source frame, exactly like the
  SAM subject track (D-018 `/track` → per-frame matte PNGs → D-019 render-time
  read via `chromaTrackDir`).

- **Option A — how to get per-frame depth that doesn't flicker:**
  1. **Per-frame Depth Anything V2 + a hand-rolled temporal filter** (EMA across
     consecutive frames, or a flow-warped / guided temporal filter). Cheap, no
     new model, deterministic. But it is a *bolt-on* — it smooths the *output* of
     a model that has no idea frames are related, so it lags on real motion,
     smears depth edges across a fast pan, and never actually understands
     occlusion or parallax.
  2. **A temporally-consistent video-depth model.** DaVinci Resolve's Depth Map
     (v19/20) made exactly this move — "z-depth estimation is now temporal, it
     understands the motion of depth." The current SOTA zero-shot open model is
     **Video Depth Anything** (CVPR 2025 Highlight): the Depth Anything V2 DINOv2
     backbone + a **spatial-temporal head** (temporal self-attention across a
     32-frame window + a temporal-gradient consistency loss). Temporal
     consistency is *native*, not a post-filter.
  - **Choice: 2 — Video Depth Anything, Small (`vits`).** Matching Resolve's
    architecture, not approximating it, is the whole point of "proper". The
    project bias is "cheapest that works" (D-024/D-027/D-030) — but here the cheap
    per-frame + EMA path doesn't actually *work* for the stated failure case
    (moving camera). VDA-Small is 28.4M params, real-time-class on CUDA (a
    minutes-long bake on MPS — fine, it's a precompute, cached to disk, like
    `/track`'s ViTMatte pass at ~3 s/frame).

- **Option B — model choice within VDA. LICENSE GATE:**
  - **`vits` = Apache-2.0 — use this.** `vitb` / `vitl` = **CC-BY-NC-4.0
    (non-commercial)** — Chroma ships as a real product, so **they must never be
    used**, and nobody should "upgrade" the encoder later without re-checking.
    The vendored `ai/vendor/README.md` states this; `VDA_CFG` in the sidecar is
    pinned to vits with a comment.
  - Relative-depth `vits` checkpoint (`video_depth_anything_vits.pth`, ~112 MB
    fp32). Not the metric model — the haze matte only needs a monotone
    near→far ordering, and the existing preset already normalises + inverts.

- **Option C — where it runs. Rust in-process (ONNX) vs the `ai/` Python
  sidecar:**
  - Depth Anything V2 (single-frame) already runs in Rust as ONNX via `ort`
    (`ai_processing::run_depth_anything_model`). A batch loop there would be
    zero new deps, no sidecar round-trip.
  - **But VDA's temporal consistency comes from cross-frame self-attention
    threaded through the whole 32-frame window with keyframe alignment between
    windows** — the *same* "the community ONNX exports cover the image path but
    the stateful video loop is fragile to reproduce" argument D-009/D-012 used to
    put SAM 2's video memory in the Python sidecar. The sidecar (D-028-supervised)
    already has `torch` + MPS.
  - **Choice: the `ai/` sidecar.** A `/depth_track` job mirroring `/track`:
    `{video_path, from_frame, to_frame, step, input_size, max_res}` → background
    job in `_jobs` (tagged `kind:"depth"`, cancels only a running *depth* job,
    `_GPU` lock around the infer, `_free_gpu()` in `finally` — B-002) → per-frame
    depth PNGs to `<video_dir>/.chroma/depth/<key>/<frame:06d>.png` + a
    `_depth.json`, progress polled at `/depth_track/{job_id}`. VDA is **vendored**
    (`ai/vendor/video_depth_anything/`, Apache-2.0 — it isn't pip-installable;
    3 local edits, all logged in `ai/vendor/README.md`); the checkpoint
    lazy-downloads to `ai/models/` on first call like every other model. New deps:
    `einops`, `easydict`.
  - **Depth Anything V2 (Rust ONNX) stays exactly as-is** — the **static
    single-frame bake** for stills and for `apply_haze` before a track exists.
    `chromaDepthDir` present → the VDA track; absent → the existing static base64.
    **Absent by default — zero behaviour change for stills and un-tracked masks.**

- **The render-time read (mirrors D-019 precisely).** New
  `src/chroma/depth.rs::tracked_depth_map(&Value) -> Option<GrayImage>`:
  `params.chromaDepthDir` + `chroma::state::current_video().frame` → the nearest
  `<n>.png` with `n <= frame` (holds a map between samples when `step > 1`).
  **One** hook in `mask_generation.rs::generate_ai_depth_bitmap` — the exact shape
  of the `tracked_full_mask` call in `generate_ai_subject_bitmap`:
  `Some(full) => generate_ai_bitmap_from_full_mask(&full, &tf)`, `None =>` the
  static base64. The band / invert / feather maths downstream are untouched —
  VDA's PNG is disparity-like (**bright = near**), the same orientation as the
  Rust DA-V2 bake, and the preset already inverts. `current_video().frame` is set
  per frame by scrub (`seek_and_install`), playback (`chroma_play_frame`, D-031)
  and export (`export.rs`) — **confirmed by reading all three** — so all three get
  per-frame depth for free, in lockstep with the frame being graded, no per-frame
  frontend state churn.

- **Temporal smoothing = the model, plus one deterministic normalisation
  choice.** No EMA. The one thing that *would* re-introduce flicker is
  normalising each depth frame independently (brightness pumping), so the job
  normalises **once, across the whole clip** (1/99 percentile clip → `u8`). Given
  the same clip + params the worker is deterministic up to MPS float noise; the
  *render-time read* (load a PNG) is fully deterministic — which is what the Rust
  test depends on. A flow-warped or guided cross-frame filter on top is a
  possible v2 if a specific clip still crawls, but VDA's head already covers the
  cases a per-frame model can't; noted in `docs/notes/depth-track.md`, not built.

- **Surface.**
  - Rust: `chroma_depth_track` / `chroma_depth_track_status` (thin sidecar
    bridges), `tracked_depth_map`. `chroma/mod.rs` +2, `lib.rs` +2. **No
    `AppState` / Cargo change.**
  - Frontend: `useAiMasking.handleTrackDepth` (mirror of `handleTrackSubject`);
    `handleAddDepthHaze` gains `tracked?` (video → also runs the track);
    `useChromaStore.depthTrackProgress`; `useChromaControl` `depth_track`
    (non-blocking) + `depth_track_status` ops. Upstream-file edit: `MasksPanel.tsx`
    +~10 — one "Track depth over clip" button in the `Mask.AiDepth &&
    chromaIsVideo` block.
  - MCP: `depth_track(from_frame?, to_frame?, step?, input_size?)`,
    `depth_track_status()`, `apply_haze` += `tracked` — **31 → 33**.
  - `ai/README.md`, `mcp/README.md`, divergence log (doc 09) updated.

- **Consequences / limits.**
  - MPS inference is ~1–1.5 fps for VDA-Small (measured: 16 frames in ~11 s incl.
    the 32-frame window pad) — a real bake, not interactive. A long 4K clip wants
    a narrowed `from`/`to` range and/or a lower `max_res` (default 1280) /
    `input_size` (default 518). The job decodes the whole requested range into
    RAM before the infer (VDA's windowing needs the sequence); it refuses a range
    that would need > ~6 GB and tells you to narrow it.
  - **Cancel granularity is per-run, not per-frame during the infer** — VDA's
    `infer_video_depth` is one call; `job["cancelled"]` is checked before it and
    during the PNG write, so a mid-infer cancel waits for the current infer to
    return. Acceptable for a bake; documented.
  - `step` only controls save density (every frame is fed to the model so the
    temporal head stays dense) — same semantics as `/track` post-D-018.
  - The eval scorer (D-035) is primary-only, so no automated depth eval there —
    `eval/run.md` gets a `depth_haze_tracked` closed-loop entry instead.
  - **The repo's only static-camera clip (C019) is the *weak* case** for this
    feature. `scratch/` now has moving-camera clips (Tokyo-Walk, DAVIS, two
    4K/foggy Pexels walks) for the test + a convincing demo; a static talking
    head shows almost no difference between the static bake and the track.

- **Verified (2026-09-02).** `cargo check --no-default-features` clean;
  `cargo test --no-default-features chroma::` **41/41** (37 baseline + 4
  depth-read: nearest-≤-frame / hold-between-samples / before-first→None /
  missing-dir + absent-param→None / non-numeric-stems-ignored). `npx tsc
  --noEmit` — **74** pre-existing errors (baseline unchanged), none in a
  new/touched file. `python3 -m py_compile mcp/server.py ai/server.py` clean;
  `import server` OK, **33** tools; `import server` for the sidecar OK, routes
  include `/depth_track` + `/depth_track/{job_id}`. **Genuine VDA-on-MPS run:**
  `ai/test_depth_track.py` (gated `CHROMA_DEPTH_TEST=1` + a `scratch/` clip)
  drives the real `_depth_track_worker` on 16 Tokyo-Walk frames — worker reaches
  `state:done`, every depth PNG has real dynamic range (near ≠ far), VDA
  consecutive-frame mean |Δ| **0.0032** vs per-frame Depth Anything V2 **0.0050**
  on the same frames (**1.5× steadier** — the temporal head earns its place).
  The sidecar `/depth_track` HTTP path, the "Track depth over clip" button, and a
  scrub-with-moving-camera check are an open **manual** smoke test (the
  `useEffect([])` bridge listener doesn't hot-reload and the running app was not
  driven) — listed in `docs/notes/depth-track.md`.

## D-037 — Home screen = a Chroma **project launcher**; a project is a `<name>.chroma` directory (`project.json` + `thumb.jpg` + `grades/`), media referenced in place
**decided (2026-09-02) · built (2026-09-02)**

- **Context:** Chroma still lands on RapidRAW's inherited **Library view** — a
  folder tree (Sources), a photo-thumbnail grid, albums, culling. None of it
  fits a colourist's workflow: you don't browse a photo catalogue, you open *a
  job* — a set of shots from one shoot, each with its own grade and session
  state. D-033 built the multi-shot `Session` but explicitly deferred
  persistence ("`.chroma/session.json` reopen … deferred"). This completes that:
  the launcher's cards *are* saved sessions.

- **Decisions the user made up front (implemented as-is):**
  1. **Media is referenced in place** by absolute path — a project never copies
     video files (matches Resolve; matches D-033's lightweight bias). A missing
     path → the shot shows **"media offline"** with a **relink** (re-point to a
     new file). Grades still load — "media offline but grade intact".
  2. **Projects live in `~/Movies/Chroma/`** by default, one directory per
     project (`<name>.chroma/`), the folder **configurable in Settings**. The
     launcher scans that folder for `*.chroma` dirs, newest first.

- **What a project is** (finalised here):
  ```
  ~/Movies/Chroma/<name>.chroma/
    project.json    { schema: "chroma.project/1", name, created, modified,
                      shots: [{ id, sourcePath, frame, name }], activeShot, settings }
    thumb.jpg       a frame from the active/first shot — the launcher card (regen on save)
    grades/
      <shotId>.grade.json    each shot's grade, D-025 format, verbatim
  ```
  - **Versioned + a `chroma.project/<major>` migration gate** — same discipline
    as `grade.json` (D-025): an untagged file is treated as v1; a newer major is
    rejected with "Upgrade Chroma".
  - **Per-shot grades live *inside* the project** (`grades/<shotId>.grade.json`),
    not as a sidecar next to the clip. Rationale: media is referenced and may sit
    on a scratch disk / be read-only / be shared between projects — the grade
    belongs to *this* project, so it travels with the project directory. D-025's
    `$matte` / `$trackDir` / `$depthDir` externalisation rules are unchanged: the
    static `.mattes/` PNGs sit beside the grade (so `grades/<id>.mattes/`), and
    tracked/depth dirs are still *referenced* at `.chroma/mattes|depth/` next to
    the **source clip** (they're per-clip precomputes, not per-project).
  - The **D-032 activity feed is session-only** — never written to the project.

- **Options for the format:** (a) a single `.chroma` **file** (zip/sqlite) —
  opaque, needs a bespoke reader, fights git; (b) a **directory** of plain files
  — `project.json` + `grades/*.grade.json` are the exact JSON we already
  git-commit (D-025), inspectable, diffable, `rsync`-able. **Chose (b).** It is
  D-033's "not a bundle" position held: a project is just a folder you could
  hand-edit. D-033's deferred `.chroma/session.json` is *replaced* by
  `project.json` (which is a superset — it also carries per-shot ids + active +
  settings).

- **Media-offline behaviour:** `chroma_project_open` probes each shot's
  `sourcePath`. Present + a video → loaded into the Rust `Session` (D-033) as
  normal. Missing → **flagged, not fatal**: it stays in the manifest, shows in
  the shot strip as an amber "media offline" card with a **Relink** button
  (`chroma_project_relink` → rewrite that shot's `sourcePath` → reopen). Its
  `grades/<id>.grade.json` is untouched and reattaches on relink.

- **Implementation** (fork hygiene, D-003):
  - **Rust:** new `chroma/project.rs` — `ProjectManifest` + load/save (pure
    `serde_json` + `std::fs`, no GPU/store, exactly like `grade.rs`) + commands
    `chroma_project_list` / `_open` / `_new` / `_save` / `_relink` / `_current` /
    `_settings_dir` / `_set_dir`. `state.rs` gains a `ProjectRef {path, name}`
    module-global so `chroma_project_save` knows where to write; `current_video()`
    unchanged. Thumb regen reuses `chroma::video::extract_thumb`. Upstream
    footprint: `chroma/mod.rs` +2, `lib.rs` +8 `generate_handler!` lines —
    nothing else in Rust core.
  - **Frontend:** new `components/chroma/ProjectLauncher.tsx` (the grid + a
    "New Project" modal + a "Projects folder" control), new
    `hooks/useProjectAutosave.ts` (debounced `chroma_project_save` on any grade /
    shot-list / active-shot change once a real project is loaded — skipped for an
    "Untitled" session). `useUIStore` default `activeView` `'library'` →
    `'projects'`; **one** routing conditional in `App.tsx` picks `ProjectLauncher`
    over `LibraryView` for the default view. `useSessionStore` (D-033) extends
    with `projectPath` / `projectName` / `gradeDir` / `dirty` / `shotIds` /
    `offlineShots` + `openProject` / `newProject` / `saveProject` /
    `saveUntitledAs` / `relinkShot`. **RapidRAW's LibraryView / albums / culling
    are NOT deleted** — folder / album navigation still routes to `'library'`, so
    the upstream code stays cherry-pick-able; the default flow just never shows
    the folder browser.
  - **Quick-open preserved:** a loose clip via the file picker or MCP `open(path)`
    with no project → an in-memory **"Untitled"** session. It seeks / plays /
    exports / tracks headlessly exactly as before; the shot strip shows a "Save
    project" nudge. Autosave stays off until `saveUntitledAs(name)` scaffolds a
    real project from the loaded shots.
  - **MCP:** `list_projects` / `open_project(name_or_path)` / `new_project(name,
    media_paths?)` / `save_project()` (33 → 37 tools). `get_state` gains
    `project: {name, path, dirty}` (null for Untitled). D-033's `add_shots` now
    also adds to the open project and marks it dirty.

- **Deferred (documented roadmap follow-ups, not designed away):** project
  rename / delete / duplicate from the launcher, a project search box,
  drag-a-clip-onto-the-window import, a `Projects folder` row inside the big
  `SettingsPanel` (the launcher has its own folder control for now), and
  batching the open-time per-shot decode.

- **Verified:** `cargo check --no-default-features` clean; `cargo test
  chroma::` **49/49** (41 + 8 new: manifest round-trip, `chroma.project/2`
  migration gate, untagged→v1 + active-shot clamp, newest-first listing +
  non-project dirs ignored, media-offline flagged not fatal, name sanitisation,
  new-project creates dir+manifest, project-ref set/clear). `tsc --noEmit`
  baseline unchanged (74, none in new/touched files — verified via `git stash
  -u`). `py_compile` + `import server` clean, 37 tools. The launcher grid, the
  New-Project flow, autosave, reopen, and media-offline/relink are an open
  **manual** smoke test (the `useEffect([])` bridge listener doesn't hot-reload
  and the running app was not driven) — listed in `docs/notes/project-model.md`.

## D-038 — Per-project `settings` = a typed output spec (resolution / fps / colour space); colour space is store-only pending D-004
**decided (2026-09-02) · built (2026-09-02)**

- **Context:** D-037 gave `ProjectManifest` a `settings: Value` field and left it
  `empty_obj()` — reserved, unused. A multi-shot project had no output spec of
  its own: resolution, frame rate and colour interpretation were all derived from
  whichever clip happened to be loaded. A grading job that mixes a 4K hero clip
  with 1080p coverage should export to **one** spec, not per-clip.

- **Decision.** `settings` becomes a typed `ProjectSettings`, every field
  **optional**:
  - `width: Option<u32>`, `height: Option<u32>` — output resolution
  - `fps: Option<f64>` — project timebase
  - `color_space: Option<String>` — `"rec709"` (default when `None`) / `"rec2020"`
    / `"dci-p3"` / `"srgb"`
  A project with **no explicit settings behaves exactly as before** — output is
  clip-derived, exports are byte-identical. This is purely additive.

- **Colour space is stored + surfaced only.** It round-trips through
  `project.json`, shows in the "Project settings" UI, and is exposed on
  `get_state().project.settings` and the MCP tool. It does **not** change grade
  math, working space, or the output display transform — the grade still renders
  display-referred Rec.709. A real colour-managed pipeline (OCIO, ACEScg working
  space, PQ/HLG output, encoder colour-primaries/transfer/matrix tagging) is
  **D-004**, its own phase. D-038 only reserves the field with a real type so the
  UI and the manifest are ready for it.

- **Backward compatibility.** `chroma.project/1` schema major is **unchanged**
  (additive, non-breaking). `ProjectSettings` deserializes leniently — each field
  is `#[serde(default)]`, so a legacy `settings: {}` or `settings: { "fps": 24 }`
  (the shape the D-037 round-trip test wrote) still loads: `fps` is picked up,
  unknown keys are ignored, an absent `settings` key → all `None`. The schema doc
  notes the addition.

- **Defaults on new-project.** `chroma_project_new` probes the **first shot's
  clip** (`chroma::video::probe`) and seeds `width` / `height` / `fps` from it, so
  a fresh project has a sensible, editable spec. `color_space` defaults to `None`
  (→ treated as rec709). A clip that won't probe (offline / not a video) leaves
  settings unset — the project is then clip-derived, same as a no-settings
  project.

- **The setter.** A dedicated `chroma_project_set_settings(path?, partial)`
  command (cleaner for the MCP tool + the UI than folding into
  `chroma_project_save`'s payload). `partial` is a JSON `{ width?, height?, fps?,
  colorSpace? }`: a **present** key is applied, an explicit `null` clears the
  field back to clip-derived, an **absent** key is left as-is. It merges, saves
  `project.json`, and returns the merged `ProjectSettings`.

- **Export uses it** (`chroma/export.rs`). `chroma_export_video` reads the loaded
  project's `settings`:
  - `width` + `height` set → the graded composite (rendered at clip res, as
    always) is **Lanczos3-resized to the project resolution as the final step
    before the encoder**. This is a few lines at the existing `frame.dimensions()`
    read — `ExportOpts` gains `out_width` / `out_height`; when they equal the clip
    dims the resize path is skipped entirely (zero-copy, byte-identical output).
  - `fps` set → feeds the existing `fps_override: Option<f64>` path. An explicit
    `fps_override` argument (the export dialog) still wins over the project's fps.
  - `color_space` → carried on the settings, **not** passed to ffmpeg yet (see
    "store-only" above).
  A project with no settings → the export is byte-identical to pre-D-038
  (regression-guarded by `export_resolution_override`, which asserts the
  no-override path keeps clip dims).

- **Fork hygiene (D-003):** all new logic in `src/chroma/project.rs` +
  `export.rs` + new frontend files. Upstream footprint: `lib.rs` +1
  `generate_handler!` line. Full divergence entry in `docs/09`.

- **Explicitly out of scope:** playhead-position persistence (owner said not
  needed), and the other deferred D-037 items (rename / delete / duplicate,
  drag-import, a Projects-folder row in the big SettingsPanel).

- **Verified:** `cargo check --no-default-features` clean; `cargo test
  --no-default-features chroma::` **54/54** (49 + 5: typed settings round-trip,
  legacy `{fps:24}` still loads, empty/absent settings → all `None`,
  `merge_patch` semantics, new-project infers from an ffmpeg-synthesised clip; +
  a gated `export_resolution_override` in `export.rs`). `tsc --noEmit` baseline
  unchanged (74, none in new/touched files — `git stash -u` verified).
  `py_compile` + `import server` clean, **38** tools. The "Project settings"
  modal, a 1080p-override export, a clear-to-clip-res export, and MCP
  `set_project_settings` + `get_state` are an open **manual** smoke test (the
  `useEffect([])` bridge listener doesn't hot-reload and the running app was not
  driven) — listed in `docs/notes/project-model.md`.

---

## D-039 — Chroma becomes a 3-tab app (Edit / Motion / Colorist) on a Rust workspace + frontend package workspace; thin-shell/fat-core; incremental migration

**decided (2026-09-02) · owner call — build starts now**

- **Context.** Palmier Pro (the NLE the pipeline leaned on for the cut) is going
  closed-source + commercial. The owner's whole content workflow is script → cut →
  motion graphics → grade → publish. Decision: Chroma stops being grading-only and
  becomes **one AI-native local app, three tabs — Editing / Motion / Colorist** —
  general-purpose (not talking-head-only). Supersedes `docs/00-vision.md`'s
  "**Not an NLE**" clause (vision/prd/scope rewritten alongside). Research trail:
  `docs/notes/product-direction.md`, `docs/notes/architecture-lock.md`.
- **Constraint lock (owner):** Rust-native, performance-first ("can't afford lags"),
  small binary — **hence Tauri**. This **rejects** JS/WebCodecs/headless-Chrome
  editing engines (Remotion-as-editor, Diffusion Studio, OpenCut-web) and
  heavy-runtime C++ (libopenshot — evaluated, rejected: CPU compositing, no Rust
  bindings, JUCE/Qt weight). Remotion stays **only** as the Motion tab's engine.
- **Reuse (not build from scratch), perf-safe because the video never flows through
  the React UI:**
  - **decode** → `re_video` (Rerun, MIT/Apache) / VideoToolbox on macOS → wgpu texture
  - **multi-track compositor** → OpenCut's `rust/crates/compositor` (MIT, wgpu, shipping
    v0.3.0) as reference/vendored dep, else built on Chroma's `render_core` (D-014)
  - **timeline model** → OpenTimelineIO-shaped serde structs (not the C bindings)
  - **timeline UI** → `react-timeline-editor` (MIT) — a control surface, zero perf cost
  - **transcript cut** → whisper `--word-timestamps` (already have) + the CutScript/
    Rescript edit-model
  - **audio** → `symphonia` + `cpal` + `rubato` + `dasp`
  - **UI kit / dnd** → RapidRAW's `components/ui/` + `@dnd-kit/core` (already a dep)
  - libopenshot's `Timeline`/`Clip`/`Keyframe` (Bezier) headers — **read, don't link**

### The structure (locked)

**Thin-shell / fat-core (the Gyroflow model): the Tauri app is glue; every capability
is a library. Domain models are pure Rust — no wgpu, no ffmpeg — with GPU + media I/O
isolated below them. One-directional, compiler-enforced dependency graph.**

**Rust workspace `chroma/crates/`:**

| layer | crate | responsibility | deps |
|---|---|---|---|
| L0 | `chroma-types` | `Frame`/`Rational`/`Resolution`/`ColorSpace`/`TimeRange`, IDs, errors — zero heavy deps | — |
| L0 | `chroma-gpu` | wgpu context (no surface), texture pool, `render_core` (D-014, extracted) | wgpu, types |
| L1 | `chroma-media` | decode/probe/encode — VideoToolbox→texture, ffmpeg-CLI fallback (D-015), decode pipe (D-030), export encode pipe (D-022) | gpu, types |
| L1 | `chroma-grade` | the grade **renderer** — wraps `engine/` shader + adjustments↔uniform bridge + masks + scopes (D-021) | gpu, types, engine |
| L1 | `chroma-compositor` | multi-layer wgpu blend + transitions, then `chroma-grade` per output frame — **new, for Edit** | gpu, media, grade, types |
| L2 | `chroma-timeline` | OTIO-shaped edit model: tracks/clips/gaps/ripple/roll/slip/slide, transcript→EDL. **Pure.** | types |
| L2 | `chroma-grade-model` | `grade.json` (D-025) — adjustments, mask geometry, keyframes (D-034), matte/track/depth refs. **Pure** (model vs renderer) | types |
| L2 | `chroma-project` | `.chroma` project (D-037) + settings (D-038) | types, grade-model, timeline |
| L2 | `chroma-motion` | manifest → Remotion bridge (render / read frames as overlay) | types |
| L3 | `chroma-ai` | sidecar client (SAM/ViTMatte/YOLO/depth/whisper) + lifecycle (D-028) | types |
| L3 | `chroma-agent` | control server (D-020) + MCP op registry + scope exposure | project, grade-model, timeline, types |
| L4 | `chroma-app` (`src-tauri`) | the Tauri binary — `#[tauri::command]` surface per tab, RunEvent hooks, sidecar spawn | all |

`engine/` (RapidRAW submodule) stays vendored; only `chroma-grade` links it. Over time
Chroma crates absorb more; RapidRAW shrinks to "grade shader + mask raster."

**Frontend workspace `chroma/packages/`:** `@chroma/tokens`, `@chroma/ui`,
`@chroma/bridge` (typed Tauri bindings + stores + control-bridge hook), `@chroma/colorist`
(Colorist tab), `@chroma/editor` (Edit tab — new), `@chroma/motion` (Motion tab), plus
`@chroma/motion-engine` (the `videoAgent/engine/motion/` Remotion project, **moved in**),
`@chroma/shell` (tab switcher + project launcher D-037 + chrome), `apps/desktop` (the Vite
entry `src-tauri` serves). **Monorepo — `chroma/` is the home.**

### Migration — incremental, `cargo test` green at every commit

1. Workspace **skeleton** first: `Cargo.toml [workspace]`, `crates/*` + `packages/*`
   stubs (`lib.rs` + `README.md` each), move the motion engine in. **No code moves; app
   still builds + runs.**
2. Extract leaf **pure** crates: `chroma-types`, `chroma-grade-model`, `chroma-timeline`.
3. `chroma-gpu` (`render_core`), `chroma-media` (decode pipe + `video`), `chroma-project`
   (`project.rs`/`grade.rs`/`state.rs`).
4. `chroma-agent` (`control.rs` + op registry), `chroma-ai` (`sidecar.rs` + mask/depth
   clients).
5. `chroma-grade` wraps `engine/`; `chroma-app` becomes the thin binary.
6. Frontend: `@chroma/tokens` + `@chroma/ui` + `@chroma/bridge` out first, then the
   `@chroma/shell` + 3-tab layout (Colorist wrapped as-is initially), then `@chroma/editor`
   greenfield.
7. `chroma-compositor` + `@chroma/editor` are built **into** the structure from day one.

### Consequences

- `docs/00-vision.md` / `01-prd.md` / `02-scope.md` rewritten for the 3-tab product;
  `04-roadmap.md` restructured (v1 = grade; v2 adds Edit MVP + Motion; the old phases
  fold in). `03-architecture.md` rewritten from this decision. `BUGS.md` "known
  constraints" list refreshed (D-034/D-036/D-014 done).
- D-002 (licence) / D-007 (headline) / D-010 (name) now decided under the 3-tab framing —
  a **fully-open** (no commercial-feature gate) + local + Rust-fast suite is the unclaimed
  position (Palmier closed, Diffusion/Gausian = open-core + paid-pro).
- D-013 (relight) upgraded — see `docs/notes/relight-research.md`: interactive
  depth-driven puck relight ships early (deterministic), photoreal diffusion bake at v3.

### Migration log

Incremental execution of D-039. Each step is its own commit; the app builds at every one.

- **D-040 (2026-09-02) — de-submodule.** The `engine/` git submodule (RapidRAW fork,
  branch `chroma`, tip `41e9326`) moved to `app/` verbatim; `.gitmodules` + submodule
  gone. Pre-fold history → `engine-history.bundle` (gitignored). Upstream RapidRAW is
  now tracked manually (no live remote). Its own commit; nothing else moved.

- **Step 1 (2026-09-02) — workspace skeleton.** Recorded here rather than as a new
  D-number (it's execution of D-039, not a new decision).
  - **Rust:** root `Cargo.toml` — virtual `[workspace]` (`resolver = "2"`, members
    `["app/src-tauri", "crates/*"]`), `[workspace.package]` (edition 2024, rust 1.98,
    AGPL), `[workspace.dependencies]` (serde / serde_json / anyhow / thiserror) —
    `app/src-tauri` does **not** adopt them yet. `app/src-tauri/Cargo.lock` → root
    `Cargo.lock`. Build profiles (`[profile.*]`) hoisted from `app/src-tauri/Cargo.toml`
    to the root (Cargo ignores them in a non-root member). `rust-toolchain.toml` copied
    to the root. `app/src-tauri/Cargo.toml` unchanged otherwise — still `[package]
    name = "RapidRAW"` (rename is a later step), absorbed as a member.
  - **3 stub crates** under `crates/` (each `cargo check` + `cargo test` clean, doc
    comment stating its D-039 responsibility, one placeholder item, an `it_builds` test,
    a `README.md`): `chroma-types` (`Resolution` / `Rational` / `ChromaError`),
    `chroma-timeline` (`Timeline` / `Track` / `Clip`, OTIO-shaped, serde),
    `chroma-grade-model` (`Grade` wrapper mirroring `grade.json` D-025).
    `crates/README.md` carries the full ~11-crate plan (which exist / which are future).
  - **Frontend:** root `package.json` — `private`, `name: "chroma"`, npm workspaces
    `["app", "packages/*"]`, scripts (`dev` / `build` / `tauri` / `tauri:dev` /
    `tauri:build`). 6 stub packages under `packages/` (`@chroma/tokens`, `@chroma/ui`,
    `@chroma/bridge`, `@chroma/editor`, `@chroma/motion`, `@chroma/shell`) — each a
    `package.json` + `src/index.ts` placeholder + `README.md`. `app/package.json` name
    `rapidraw` → `@chroma/app` (nothing else changed). `app/` does **not** import from
    `packages/*` yet — workspace only declared. `packages/README.md` carries the full
    package plan (incl. the future `@chroma/colorist` + `apps/desktop`).
  - **Motion engine moved in:** `videoAgent/engine/motion/` → `packages/motion-engine/`
    (`cp -R`, dropped `node_modules` / `out/` / `.git` / nested `package-lock.json`),
    `package.json` name →
    `@chroma/motion-engine`. `videoAgent`'s copy is now stale (delete it); its
    `engine/catalog.md` + `.claude/skills/motion-primitives/` stay the design reference.
  - **Path fixes:** repo-wide `engine/src-tauri/…` → `app/src-tauri/…`,
    `engine/src/…` → `app/src/…` (docs, `mcp/README.md`, `mcp/server.py`, `ai/README.md`,
    `eval/lib/*.mjs`, `CLAUDE.md`, `README.md`). `09-engine-notes.md` header notes the
    D-040 vendor; `03-architecture.md` got a "stale, see D-039" banner (full rewrite is
    separate); `sidecar.rs::resolve_ai_dir` comment corrected (`../../ai` still resolves
    from `app/src-tauri`). `tauri.conf.json` unchanged — `beforeDevCommand: "npm run dev"`
    still resolves to `app/`'s vite because `tauri` is invoked with cwd `app/`
    (`npm run start --workspace app`).
  - **Verified:** `cargo build --no-default-features` clean (`RapidRAW` + 3 stubs, 6m30s
    cold); `cargo test -p chroma-types -p chroma-timeline -p chroma-grade-model` green;
    `npm install` hoists; `cd app && npx tsc --noEmit` = **74** errors (baseline
    unchanged); `python3 -m py_compile mcp/server.py` clean. App run command:
    `npm run tauri:dev` from the repo root. No `cargo clean` needed (fresh root `target/`).

- **Step 6a (2026-09-02) — the 3-tab shell.** `@chroma/shell` `<Shell tabs={registry}>`
  mounted by `app/src/main.tsx`; Colorist tab = the existing app (`h-screen` → `h-full`),
  Edit/Motion placeholder tabs. (See CHANGELOG; the Edit tab is fleshed out by D-041.)

- **Step 6b (2026-09-02) — UI consistency: window chrome + `@chroma/ui` started.**
  - **Window chrome → the shell.** `packages/shell/src/WindowChrome.tsx` ports the
    platform logic from `app/src/window/TitleBar.tsx` (macOS traffic lights =
    close/minimize/toggle-fullscreen; Win/Linux window controls; `data-tauri-drag-region`).
    `Shell.tsx`'s top bar is now the window title bar: left = traffic lights + `CHROMA`
    wordmark, centre = the tabs (absolutely centred), right = Win/Linux controls or a
    mac-width spacer; `h-10`, `bg-surface border-b`, whole bar draggable except
    buttons/tabs. `.macos-window-shell` (14px rounded corners) is applied to the **shell
    root** now (mac, windowed). `app/src/App.tsx` no longer imports or renders
    `<TitleBar/>` (the file stays, unrouted, for reference). `@chroma/shell` gains
    `@tauri-apps/api` + `@tauri-apps/plugin-os` + `lucide-react` — acceptable, the shell
    is the app chrome now (noted in its README).
  - **`@chroma/ui` — the shim pattern established with a safe subset.** `Button`, `Input`,
    `Text`, `Switch`, `CollapsibleSection` moved to `packages/ui/src/` (real source);
    each `app/src/components/ui/<Name>.tsx` is now `export { <Name> as default } from
    '@chroma/ui'` so the existing `import X from '../ui/X'` sites are untouched. Kit deps
    are **react + clsx + lucide-react only**: `Switch` swaps its `framer-motion` spring
    for a CSS transform transition, `CollapsibleSection` inlines its two `react-i18next`
    tooltip strings, and `typography.ts` is copied into the package (the app keeps its own
    copy for the ~40 direct-import call sites — keep in sync). `Slider` (pulls
    `react-i18next` + `GLOBAL_KEYS` from the app-coupled `AppProperties`) and the heavy /
    app-coupled components (`Dropdown`, `ColorWheel`, `LUTControl`, …) stay in `app/` for
    a later pass. `@source "../../packages/ui/src"` added to `app/src/styles.css`.
  - **`@chroma/editor` icons.** Transport = `SkipBack` / `Play`–`Pause` / `SkipForward`;
    toolbar = `Scissors` (split) / `Trash2` (remove, disabled with no selection), all
    `lucide-react` + aria-labels, matching `ChromaTimeline.tsx`'s icon-button style. The
    "Timeline" header label dropped. Empty-state action is a `@chroma/ui` `<Button>`.
    New deps on `@chroma/editor`: `@chroma/ui`, `lucide-react`.
  - **Verified:** `npm install` clean; `cd app && npx tsc --noEmit` = **74** (baseline
    unchanged); `cd app && npm run build` (vite prod) green — `@chroma/ui` + `@chroma/shell`
    Tauri imports + `@chroma/editor` icons all bundle; `cargo check --no-default-features`
    unchanged (no Rust touched).

- **Step 6c (2026-09-02) — the project launcher is the app entry screen.**
  The D-037 launcher stopped being a view *inside* the Colorist tab and became
  the shell-level entry screen.
  - **`@chroma/shell`.** `<Shell>` gains three props: `projectOpen: boolean`,
    `launcher: ReactNode` (injected — the shell never imports the app's
    `ProjectLauncher`, dependency direction stays app → shell), and
    `onCloseProject?: () => void`. `projectOpen === false` → the chrome bar shows
    only traffic lights + `CHROMA` + window controls (no tab buttons) and the
    content area renders `{launcher}` full-window; `true` → the tabs plus a
    "‹ Projects" button (next to the wordmark) that calls `onCloseProject`.
    Cmd/Ctrl+1/2/3 gated on `projectOpen`. The tab panels stay **mounted**
    (hidden) under the launcher so the Colorist app's MCP control bridge
    (`useChromaControl`) keeps running — MCP `open_project` still works from the
    launcher screen. `.macos-window-shell` stays on the shell root in both states.
  - **Composition root.** `app/src/main.tsx` is now a small `Root` component:
    `projectOpen = !!s.projectPath || !!s.projectName` (the `|| projectName`
    covers a loose-clip Untitled quick-open, which sets `projectName` but not
    `projectPath`), `launcher={<ProjectLauncher/>}`,
    `onCloseProject={() => useSessionStore.getState().closeProject()}`.
  - **`useSessionStore`.** New `closeProject()` action — best-effort final
    `saveProject()` for a dirty, non-Untitled project, then reset `shots` /
    `activeIndex` / `grades` / `projectPath` / `projectName` / `gradeDir` /
    `shotIds` / `offlineShots` / `dirty` / `projectSettings` to initial and drop
    the clip from the editor/chroma/agent stores (mirrors `removeShot`'s
    "session empty" branch). **No Rust change** — `state::ProjectRef` is left
    set; harmless because the next `open`/`new` overwrites it and every frontend
    save path guards on `projectPath`. Autosave's debounce already no-ops once
    `projectPath` is null.
  - **Colorist tab.** `useUIStore` `activeView` default `'projects'` → `'editor'`
    (a project is always open when `<App/>` is mounted now). `App.tsx` drops the
    `activeView === 'projects' ? <ProjectLauncher/> : <LibraryView/>` conditional
    — renders `<LibraryView/>` directly (still the fallback for the unrouted
    albums/culling/community nav); `ProjectLauncher` import removed from `App.tsx`
    (kept as a file — `main.tsx` imports it). `useAppNavigation`'s editor "back"
    → `activeView: 'library'` (the `'projects'` view value is retired). The
    settings-overlay guard in `App.tsx` drops its `|| activeView === 'projects'`
    clause (back to `hasRoots`).
  - **Deferred:** reopen-the-last-project on launch (no persisted "last project"
    — `projectPath` starts null, so the app always opens at the launcher);
    "‹ Projects" on a dirty Untitled session just discards (Untitled autosave is
    already skipped); moving `ProjectLauncher` + the session store into
    `@chroma/bridge` / a `@chroma/project` fe package so shell + colorist share
    them without the app-side import.
  - **Verified:** `npm install` clean; `cd app && npx tsc --noEmit` = **74**
    (baseline unchanged, none in a touched file); `cd app && npm run build`
    (vite prod) green; no Rust touched (`git status` = 6 frontend files).

---

## D-041 — Editor tab MVP: single-video-track timeline of the project's shots, lightweight decode→jpeg preview, timeline persisted in the `.chroma` project

**decided (2026-09-02) · built (2026-09-02)**

- **Context.** D-039 gave Chroma a 3-tab shell; the Edit tab was a placeholder.
  This is its first real cut — a working timeline — kept deliberately small.
- **Scope (MVP).** One video track assembled from the open project's shots
  (`ProjectShot` → one full-length clip each, back to back), scrub + play with a
  live preview, and the four edit ops: reorder, trim (head/tail), split, remove.
- **Out of scope (later tracked steps):** multi-track, audio, transitions,
  transcript cut, GPU compositing, grade-in-the-preview, OTIO (`.otio`) export,
  MCP tools.
- **Options considered / choices:**
  - *Where the edit model lives* → the pure `chroma-timeline` crate (D-039 L2),
    made real here: `Timeline::from_shots`, position helpers (`Track::clip_at`,
    `Timeline::duration`), and the edit ops as `Result<(), TimelineError>`
    methods, each unit-tested. `Clip` gains a stable `id`, an optional
    `shot_id`, and `source_len` (the media frame-count ceiling for trims). serde
    is our own plain JSON for v1 — a real OTIO exporter is deferred and noted in
    the module doc. The crate still probes nothing; callers pass frame counts.
  - *Preview render path* → a **standalone lightweight decode→jpeg**
    (`chroma::edit` + `decode_pipe::playback_frame_scaled` → `image` JPEG q80 →
    `data:` URL), **independent of the Colorist's `AppState` / wgpu / grade
    path**. Rationale: the editor preview needs "give me timeline frame N fast",
    not a graded composite; compositing + grade-in-preview come with
    `chroma-compositor` (D-039 L1) later. Keeps the fork diff tiny and the two
    render paths decoupled.
  - *Timeline persistence* → **inside the `.chroma` project**:
    `ProjectManifest.timeline: Option<Timeline>`, `#[serde(default)]`, schema
    major unchanged — the exact additive move D-038 made for `settings`. Travels
    through the existing `load_manifest` / `save_manifest`; built + persisted
    lazily on first `chroma_timeline_get`.
  - *Timeline UI* → `@xzdarcy/react-timeline-editor` (MIT, the lib D-039 named) —
    a pure control surface, no video through it. New dep on `@chroma/editor`
    only.
- **Commands (registered in `lib.rs`):** `chroma_timeline_get` (persisted or
  freshly built + persisted), `chroma_timeline_set` (replace + persist — stores
  verbatim, the frontend ops are authoritative), `chroma_timeline_frame(pos,
  max_long_edge?)` (resolve `pos` → `(clip, source frame)` via `clip_at`, decode,
  JPEG, `data:` URL; out-of-range → 1×1 transparent PNG).
- **Fork hygiene (D-003).** All new code in `crates/chroma-timeline` +
  `app/src-tauri/src/chroma/edit.rs`. The only upstream-file edits: the
  `timeline` field on `ProjectManifest` (`project.rs`), `pub mod edit;` in
  `chroma/mod.rs`, three `generate_handler!` lines + one path-dep in
  `app/src-tauri/Cargo.toml`. Logged in `docs/09-engine-notes.md`.
- **Consequences / deferred.** Editor preview fps defaults to 24 (`from_shots`
  leaves `rate: None`) — wiring project `settings.fps` in is a follow-up. No
  gaps in the model yet (clips are strictly back to back). `@chroma/bridge`
  extraction of the store is still its own later task — `useEditorTimelineStore`
  lives in `@chroma/editor` for now.

---

## D-042 — `@chroma/ui` is built on shadcn/ui + Base UI primitives, not hand-rolled

**decided (2026-09-02)**

- **Context.** The owner pushed back twice on hand-crafting UI ("don't we have
  reusable components instead of building everything from scratch"). D-039's UI pass
  started `@chroma/ui` by hand-extracting a few RapidRAW components (Button, Switch,
  Input, Text, CollapsibleSection) — which meant re-implementing a Switch spring as a
  CSS transition, inlining i18n strings, and deferring `Slider`/`Dropdown` because
  they're app-coupled. That's the wrong direction for the 20+ structural components the
  3-tab app needs (dialogs, dropdowns, context menus, tooltips, popovers, tabs, select,
  command palette, resizable panels, sheets…).
- **Options:** (a) keep hand-extracting from RapidRAW; (b) a batteries-included lib
  (Mantine / MUI) — its own styling system, clashes with the Tailwind-v4 + CSS-var token
  setup, heavy; (c) **shadcn/ui** — copy-in components (you own the source, **zero
  runtime dep**), Tailwind-native, themed via CSS vars, on accessible headless
  primitives.
- **Choice:** (c). shadcn/ui is the 2026 standard, React 19 + Tailwind v4 ready, and its
  copy-in model fits Chroma's "vendored, no bloat" ethos exactly. Its CSS-var theming
  maps straight onto RapidRAW's existing `--color-*` token system. **Primitive layer:
  Base UI** (shadcn's July-2026 default — from the ex-Radix / MUI / Floating-UI team,
  stable v1.0; Radix's own development slowed after the WorkOS acquisition). Base UI also
  gives Switch/Slider real animation back for free.
- **What `@chroma/ui` becomes:**
  - shadcn/Base-UI components for everything **structural + generic**: Button, Dialog,
    DropdownMenu, ContextMenu, Tooltip, Popover, Tabs, Select, Command (`cmdk`),
    Resizable (`react-resizable-panels`), Toggle, Switch, Slider, ScrollArea, Sheet,
    Separator, Input, Label, Toast.
  - **Keep RapidRAW's domain components** in `app/` (unrouted where replaced): `ColorWheel`,
    `LUTControl`, `DepthRangePicker`, the grading-tuned sliders, `ImagePicker`. These are
    craft-specific, not worth replacing.
  - Deps `@chroma/ui` may now use: `@base-ui-components/react`, `class-variance-authority`,
    `clsx`, `tailwind-merge`, `lucide-react`, `cmdk`, `react-resizable-panels`. (Relaxes
    D-039's "react + clsx + lucide only" — that constraint was premature.)
  - The 5 already-extracted components get rebuilt on shadcn (Button, Switch, Input,
    Text→Typography, Collapsible via Base UI) — the re-export shims in
    `app/src/components/ui/*` stay, so app call sites don't change.
- **Migration:** additive. New UI (shell menus, Export dialog, media pool, player
  controls, Editor) uses `@chroma/ui` from the start. The Colorist tab swaps its generic
  components (esp. `Dropdown`) over time; its grading panels are last / never.
- **Order:** this lands **before** `@chroma/player` / media-pool / Export-window (all of
  which want dialogs + dropdowns).

---

## D-043 — The Colorist tab is the grading editor ONLY; RapidRAW's DAM / welcome / library shell is removed

**decided (2026-09-02) · owner directive**

- **Context.** RapidRAW is a photo **DAM + RAW editor**. Its app shell — a "Welcome
  back / Continue Session / Add Folder" home screen (`MainLibrary.tsx`), a folder-tree
  "Sources" panel + a "Library" photo grid (`LibraryView.tsx` + `panel/library/*`, ~3800
  LOC), albums, culling, a web "Community" presets page (`CommunityPage.tsx`), a "Home"
  button, and RapidRAW branding (name, version "1.6.2", "Images by Timon Käch", Ko-Fi /
  GitHub links) — all still ship inside the Colorist tab. The owner: *"it creates a
  separate app inside our app."* Screenshots: clicking **Home** in the Library header
  drops you into RapidRAW's own welcome screen, fully branded.
- **This overrides D-003's "keep everything cherry-pickable"** *for the shell/DAM layer*.
  Chroma has diverged so far (3-tab video app vs. photo RAW editor) that the library /
  welcome / albums / culling / community code will **never** run again — keeping it as
  dead routed code is noise, and the branding actively misleads. The **grading engine**
  (wgsl shader, masks, adjustments model, the adjustment panels, the canvas/preview,
  scopes, LUT, curves, wheels) is what we forked for and stays.
- **Decision.** The Colorist tab renders **only the editor view**. Remove from the routed
  UI: the welcome/home screen, `LibraryView` + the `panel/library/*` folder browser,
  albums, culling, the Community presets page, the "Home"/back-to-library nav, and every
  RapidRAW branding string / donate link / version line. `useUIStore.activeView`
  collapses (no more `'library'` / `'community'`). Media to grade comes from the shared
  media pool (roadmap — "Media pool + global Sources") / a file picker stopgap until
  that lands — **not** RapidRAW's folder tree.
- **Method.** A **proper analysis first** (owner asked): map every `activeView` branch,
  every entry into `LibraryView` / `MainLibrary` / `CommunityPage`, every branding
  string, every Tauri command only the DAM uses — written into
  `docs/notes/colorist-strip.md`. Then the surgery: delete the DAM/welcome/community
  components + their commands (or gut to a stub if a shared util lives inside), collapse
  the router, drop the branding. Divergence recorded in `docs/09-engine-notes.md`. The
  Rust side: RapidRAW commands that only served the library (`get_folder_tree`,
  album CRUD, culling, community fetch…) get removed too — analysis names them.
- **Order:** right after `@chroma/ui` (D-042). Heavy `app/src/App.tsx` overlap, so serial.
