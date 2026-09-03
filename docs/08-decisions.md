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

### Built (2026-09-02)

- **Setup — manual, not the CLI.** `packages/ui/components.json` is present and
  canonical (`style: new-york`, `baseColor: neutral`, `cssVariables: true`,
  `rsc: false`, aliases → `@chroma/ui/*`), but the shadcn CLI can't target a
  workspace **library** package cleanly, so every component was **hand-placed
  from shadcn's published source**: the Base UI variant JSX (shadcn ships Radix +
  Base UI trees in parallel) with the classic token-based utility classes from
  the `new-york-v4` tree. Structure is exact: `src/lib/utils.ts` (`cn`),
  `src/components/ui/<name>.tsx`, `src/index.ts` barrel, `src/hooks/use-mobile.ts`.
- **Package rename.** Base UI reached stable and renamed `@base-ui-components/react`
  → **`@base-ui/react`** (pinned `1.7.0`). Deps added to `packages/ui/package.json`:
  `@base-ui/react` 1.7.0, `class-variance-authority` 0.7.1, `clsx` 2.1.1,
  `tailwind-merge` 3.6.0, `cmdk` 1.1.1, `react-resizable-panels` 4.12.3 (v4 API:
  `Group`/`Panel`/`Separator`), `sonner` 2.0.8, `lucide-react` ^1.33.0.
- **Components landed (18):** `button`, `dialog`, `dropdown-menu`, `context-menu`,
  `tooltip`, `popover`, `tabs`, `select`, `command`, `resizable`, `sheet`,
  `slider`, `switch`, `scroll-area`, `separator`, `input`, `label`, `sonner`.
  `sonner`'s `next-themes` dependency dropped (theme via the mapped CSS vars —
  RapidRAW has no next-themes).
- **The 5 rebuilt:** `Button` (shadcn `button` + `buttonVariants` cva, kept a
  superset of the old API — `variant="primary"` alias, `className` still wins via
  `tailwind-merge` so the old `bg-surface` hack needs no special case);
  `Input` (+ `bgClassName` prop kept); `Switch` → the bare shadcn switch, and a
  new `LabeledSwitch` composite (the row-toggle the ~13 call sites use) rebuilt on
  it — Base UI gives the knob animation back; `CollapsibleSection` rebuilt on Base
  UI `Collapsible` (drives the height transition); `Text` unchanged. The
  `app/src/components/ui/*` shims stay — only `Switch.tsx` changed target
  (`LabeledSwitch as default`).
- **Theme — one source.** `packages/ui/src/styles.css` is the single definition of
  the shadcn token names, each an alias of an existing `--app-*` / `--color-*` /
  `--radius-*` var; `app/src/styles.css` `@import`s it right after
  `@import 'tailwindcss'`. All three RapidRAW themes drive it at runtime. Mapping
  table: `packages/ui/README.md`.
- **The `--accent` collision — decision (a).** `--color-accent` is **not**
  redefined (it stays RapidRAW's brand white). The copied component source is
  edited: `hover/focus/data-highlighted/data-[selected]:bg-accent` (+
  `text-accent-foreground`) → `bg-muted` / `text-foreground`.
  `--color-accent-foreground` is still mapped as a harmless safety net.
  `--color-destructive` is the one pinned colour value (`rgb(229,72,77)`), in the
  theme block. `--radius` → `--radius-md` (no third radius scale).
- **Migrations done:** `@chroma/shell` "‹ Projects" button → `Button variant="ghost"`
  (new `@chroma/ui` dep); `@chroma/editor` timeline toolbar (Split / Remove) →
  `Button variant="ghost"` wrapped in `Tooltip` + `TooltipProvider`. The Colorist
  app's panels are **not** touched (later, per this decision).
- **Verified:** `npm install` clean (38 packages, hoisted); `packages/ui` `tsc
  --noEmit` clean; `app` `tsc --noEmit` = **74**, byte-identical to baseline;
  `packages/shell` `tsc` clean, `packages/editor` `tsc` = 1 pre-existing error
  (a `.css` side-effect import, not new); `app` `npm run build` (vite prod) green,
  every component bundles (verified with a temporary all-exports probe, removed);
  `cargo check --no-default-features` clean (no Rust touched); dev-server HMR
  applied the changes with no new errors.
- **Deferred:** typography unification (`app/src/types/typography.ts` ↔
  `packages/ui/src/typography.ts` still two copies); Colorist panel migration
  (esp. `Dropdown` → `Select` / `DropdownMenu`); `@chroma/tokens` + `@chroma/bridge`.

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
- **Built (2026-09-02).** Full detail: `docs/09-engine-notes.md` D-043 entry.
  Frontend deleted: `LibraryView.tsx`, `MainLibrary.tsx`, `panel/library/`
  (`CullingView`/`LibraryGrid`/`LibraryHeader`/`LibraryItems`), `CommunityPage.tsx`,
  `FolderTree.tsx` (the "Sources" panel — taken in this same pass per the
  analysis's recommendation, since the owner named it directly and it unlocks
  Tier-2 Rust), `CullingModal.tsx`, `ImportSettingsModal.tsx` (orphaned).
  `useUIStore.activeView` deleted outright (collapsed to its one value).
  `App.tsx` / `useAppNavigation.ts` / `useKeyboardShortcuts.ts` /
  `useAppContextMenus.ts` / `useLibraryActions.ts` / `useFileOperations.ts` /
  `useAppInitialization.ts` / `useTauriListeners.ts` gutted to what still
  operates on the actively-edited image, independent of any library-folder
  concept. Rust: Tier 1 (album/community) + Tier 2 (folder-tree/import/culling)
  removed, `tagging_utils/` module deleted, plus two newly-orphaned functions
  the analysis's Tier lists got wrong in each direction — `add_tag_for_paths`/
  `remove_tag_for_paths` kept (still reachable via the editor's tagging
  context-menu), `read_exif_for_paths` removed (its only real caller was gone).
  `export_processing::run_headless_export`'s direct in-process call to
  `list_images_recursive` (not a frontend `invoke`, missed by the initial
  audit) — kept that one function as a plain internal fn, unregistered from
  `generate_handler!`. `TetheringPanel` capture rewired to a local one-off
  folder picker instead of the removed library folder. Branding: all 13
  i18n locales, `tauri.conf.json`, exported-file EXIF `Software` tag +
  skeleton-XMP `x:xmptk` (ship in real output, not just UI chrome).
  **Net: 51 files, +363/−7823 LOC** (`app/src` + `app/src-tauri/src`) + 13
  locale-file edits. `cargo build`/`cargo test chroma::` (54/54)/`tsc`
  (74→64)/`vite build` all green.

---

## D-044 — Media pool pass 1: `ProjectManifest.media: Vec<MediaItem>`, additive alongside `shots`; import + list only, unification deferred

**decided (2026-09-02) · built (2026-09-02)**

- **Context.** Roadmap "Next" item 1, "Media pool + import + multiple
  timelines," scoped as 2–3 passes. This is **pass 1: model + import only** —
  no bins/folders, no multiple named timelines, no docked Sources-panel UI.
  Today "media in a project" only exists as `ProjectShot` — every entry is
  already assumed to be a graded shot; there's no concept of media sitting in
  a pool, unused. The target model (per the roadmap item): pool = all media a
  project references; a Colorist "shot" = a pool item being graded; an Editor
  "clip" = a windowed reference to a pool item on a timeline track
  (`chroma-timeline::Clip` already has that shape).
- **Decision — additive, not unified.** `ProjectManifest` gains `media:
  Vec<MediaItem>` (`#[serde(default)]`, schema major unchanged — the same
  additive move D-038 made for `settings` and D-041 made for `timeline`).
  `MediaItem` is `{ id, source_path, name, added, video: Option<MediaVideoInfo>
  }` — referenced in place, never copied (the same invariant `ProjectShot`
  already keeps); `MediaVideoInfo` is a cheap probed subset (`width, height,
  fps, frame_count, duration_secs`) reusing the existing `video::probe` /
  `VideoInfo` path (no new prober). `shots` is **untouched** this pass — no
  `media_id` back-reference yet, no shared id space, two independent lists
  that both happen to hold "paths this project references." Only
  `chroma_media_import` writes to `media`; nothing yet reads it into `shots`
  or the Editor timeline.
- **Why not unify now.** A real unification (`ProjectShot` becomes a view over
  `MediaItem`, or a shot carries a `media_id`) touches every shot-related code
  path at once — `chroma_project_save`, `open_manifest`'s offline handling,
  `session.rs`, `edit.rs`'s `build_from_shots`, and the frontend
  `useSessionStore` — which is exactly the "sprawling refactor" the roadmap
  item explicitly warned pass 1 off of. Keeping `media` purely additive means
  this pass touches none of those paths and cannot regress the existing
  Colorist/Editor flows. **Owed to pass 2/3:** decide the real relationship
  (most likely: a shot gains an optional `media_id`, `ProjectShot` keeps
  `source_path` for backward compat but the pool becomes the source of truth
  for probed facts) once bins/folders and the docked Sources panel give a
  reason to actually read from `media` on the hot paths.
- **Commands (registered in `lib.rs`):** `chroma_media_import(paths: Vec<String>)
  -> Vec<MediaItemDto>` — probes each new path (`video::probe`, reusing the
  same path `build_from_shots` / `infer_settings_from_clip` already use),
  skips a path already in the pool (dedup by `source_path`, not an error),
  persists, returns just the newly-added items. `chroma_media_list() ->
  Vec<MediaItemDto>` — the full pool, `offline` live-checked per item (same
  cheap `is_file() && is_video_file()` test as `ProjectShotDto`). Named
  `chroma_media_*` (not the roadmap text's literal `import_media`/
  `list_media`) to match this file's existing `chroma_project_*` /
  `chroma_timeline_*` convention. A probe failure at import time doesn't drop
  the item — same "offline is flagged, not fatal" discipline as
  `open_manifest`'s shot handling; `video` is just `None` and `offline` comes
  back `true` on the next list. No MCP tool wiring — none of the existing
  `chroma_project_*` commands are MCP-exposed either, so there's no
  established pattern to extend yet.
- **Frontend scaffolding.** `useMediaPoolStore` (zustand: `items`, `loading`,
  `error`, `refresh()`, `importPaths()`) lives in `@chroma/bridge`
  (`src/media.ts`) — not `app/src/store` (would violate the D-039 layer
  direction: an `app/src` store can't be imported by a future tab package) and
  not a new package (`@chroma/bridge`'s own README already scopes it as
  "typed Tauri command bindings + zustand stores"; this is its first real
  content beyond the D-039 stub). No panel/UI consumes it yet — pass 3's job.
- **Verified:** `cargo test chroma::` 58/58 (was 54; +4 new: dedup-on-reimport,
  a real-clip probe via the existing `make_test_clip` ffmpeg helper,
  `offline` flagging, and a legacy-`project.json`-with-no-`media`-key load).
  The real `~/Movies/Chroma/New.chroma/project.json` (one shot, written before
  this change, no `media` key) still loads through `load_manifest` — checked
  with a temporary throwaway test against the live file, not just reasoned
  about. `app` `tsc --noEmit` unchanged at 64 (no `app/src` touched);
  `packages/bridge` `tsc --noEmit` clean. `cargo fmt --check` /
  `cargo clippy` clean on the touched files (`project.rs`, `lib.rs`) —
  pre-existing warnings/diffs elsewhere in the crate untouched, no broad
  `cargo fmt` run (`CLAUDE.md` hard rule). Dev server boots clean
  (`npm run tauri:dev`, no new errors in the log).
- **Deferred to pass 2/3** (per the roadmap item, unchanged): bins/folders,
  multiple named timelines, the docked Sources/Library panel (thumbnails,
  search, drag-to-track), `set_active_timeline`, the `shots`/`media`
  unification above.

## D-045 — Media pool pass 2: bins/folders + multiple named timelines, model + commands only

**decided (2026-09-02) · built (2026-09-02)**

- **Context.** D-044 pass 1 shipped `ProjectManifest.media` (import + list, no
  bins) and left the Edit tab on D-041's singular `timeline: Option<Timeline>`.
  This is **pass 2**: bins for the media pool, and multiple independently-
  editable named timelines with one active. Still no UI (pass 3) and still no
  `shots`/`media` unification (unchanged from D-044's deferral).
- **Bins — no separate entity, a plain path string.** `MediaItem` gains
  `folder: Option<String>` (`None`/blank = pool root). A bin is not a row
  anywhere; it exists exactly when some item's `folder` names it, created
  implicitly on first use — same convention Palmier Pro's own MCP folders use
  (`"B-roll/Sunset"`, no id), chosen explicitly to match a mental model
  already established elsewhere in this codebase's tooling rather than invent
  a second one. `chroma_media_import` gained an optional `folder` arg (an
  already-pooled path is skipped on re-import regardless of `folder` — use
  the new `chroma_media_move(id, folder)` to re-file it); a blank/whitespace
  folder normalises to `None`. `chroma_media_list` still returns the flat
  list (each item now carrying `folder`) — no bin-tree endpoint. A future
  Sources panel derives the tree client-side from the flat path strings, the
  same way Palmier's own UI does; building a hierarchy API now would be
  guessing at a shape pass 3's actual UI hasn't asked for yet.
- **Multiple timelines — `Vec<Timeline>` + an index, migrated losslessly.**
  `ProjectManifest.timeline: Option<chroma_timeline::Timeline>` (D-041)
  became `timelines: Vec<Timeline>` + `active_timeline: usize` — the same
  `usize`-index convention `active_shot` already uses, not a second id-keyed
  selector, so the two "which one is current" fields in this struct read the
  same way. `chroma_timeline::Timeline` gained an `id: String` field
  (`#[serde(default)]`, defaults to `""` for pre-D-045 JSON) so a timeline
  can be referenced stably from outside the manifest — the crate itself
  never generates one (it has no `uuid` dependency and shouldn't gain one
  just for this; `chroma::edit`/`chroma::project`, which already depend on
  `uuid` for `MediaItem::id`, assign it on creation, same as they already
  assign `Timeline::name`). **The migration is a raw-JSON rewrite in
  `project::load_manifest`, before typed deserialize**: a present `timeline`
  key (and no `timelines` key yet) becomes a one-element `timelines` array,
  backfilling a fresh id since the legacy shape never had one; a present
  `timelines` key is left alone (and a stray `timeline` alongside it is just
  dropped, not merged — that shape shouldn't exist outside a hand-edited
  file). `ProjectManifest` has no `timeline` field left to serialize, so a
  save can never reintroduce the old key — the same one-way-door pattern
  D-038/D-041 used for `settings`/`timeline` themselves. Checked against the
  real `~/Movies/Chroma/New.chroma/project.json` by hand (a throwaway test,
  deleted after) before trusting it, then again live: booting the app against
  that file rewrote it from the singular `timeline` shape to `timelines: [...]`
  + `activeTimeline: 0` + `media: []` on its first Edit-tab load, exactly as
  designed.
- **`chroma_timeline_get`/`_set`/`_frame` now target the active timeline** —
  same signatures, same behaviour for a project with exactly one (still the
  lazy build-from-shots fallback D-041 had, now landing in a one-element
  `timelines` list instead of the singular field). New commands:
  `chroma_timeline_list()` (id/name/duration/`active` per timeline, lazily
  building the first one first if the project has none — never returns
  empty), `chroma_timeline_create(name)` (a new empty timeline, made active,
  returned in full), `chroma_timeline_set_active(id)` (resolves the given
  **id** to an index and stores that — the roadmap text named this
  `set_active_timeline`; shipped as `chroma_timeline_set_active` to match
  this file's `chroma_timeline_*` naming convention, same reasoning D-044
  gave for `chroma_media_*` over the roadmap's literal `import_media`/
  `list_media`). Taking a stable id here rather than a raw index (even
  though storage is index-based) means a caller never has to track ordering
  to switch timelines — smallest-footprint way to get both an
  `active_shot`-consistent storage shape and an ergonomic-for-later-UI
  command surface without adding a second id space.
- **Frontend — deliberately untouched beyond one type.** "Active timeline"
  selection stays a **Rust-side concept** this pass: `@chroma/editor`'s
  `timelineStore.ts` calls `chroma_timeline_get`/`_set`/`_frame` exactly as
  before and needs no changes — a single-timeline project's Edit tab behaves
  identically (verified: `chroma_timeline_get` → mutate → `_set` → `_get`
  round-trips unchanged, still exactly one timeline). The only frontend touch
  is `packages/editor/src/timeline.ts`'s `Timeline` interface gaining
  `id: string` for type accuracy (the field already flowed through at
  runtime — plain JS objects don't drop untyped keys — this just names it).
  `@chroma/bridge`'s `useMediaPoolStore` is **not** extended with `folder`/
  `chroma_media_move` this pass — no panel consumes it yet, and pass 1 set
  the precedent of landing store scaffolding only once there's a real
  first consumer; adding it blind here would be guessing at the shape pass
  3's UI needs.
- **Verified:** `cargo test chroma::` 65/65 (was 58; +7: bin path assignment
  + `chroma_media_move`, the legacy-timeline-migration fixture test (the
  exact shape `~/Movies/Chroma/New.chroma/project.json` had), an
  absent/null-`timeline` load, an out-of-range `active_timeline` clamp,
  multi-timeline create/list/set-active, and that a single-timeline project
  still round-trips `chroma_timeline_get`/`_set` unchanged) + `chroma-timeline`
  10/10 (+1: a legacy `Timeline` JSON blob with no `id` still loads). `app`
  `tsc --noEmit` unchanged at 64 (no `app/src` file touched);
  `packages/bridge` clean (untouched); `packages/editor`/`packages/player`
  unchanged at their pre-existing baseline (editor's one pre-existing error
  is an unrelated CSS-import type declaration, not from this change).
  `cargo fmt --check` / `cargo clippy` clean on the touched files
  (`project.rs`, `edit.rs`, `crates/chroma-timeline/src/lib.rs`; `lib.rs`'s
  three-line `generate_handler!` addition needed no reformatting) — verified
  file-by-file, deliberately never invoking `rustfmt`/`cargo fmt -p` on
  `lib.rs` itself, which (found the hard way this session) recursively walks
  every `mod`-reachable file from a crate root and would silently reformat
  the whole crate; pre-existing drift elsewhere in the crate (confirmed
  present in this same file before this change too) untouched. Dev server
  boots clean (`npm run tauri:dev`) and, loading the real project, performs
  the migration live as designed; server killed after.
- **Deferred to pass 3:** the `shots`/`media` unification (unchanged from
  D-044), the docked Sources/Library panel, the bin-tree UI, the
  timeline-switcher UI, and wiring `useMediaPoolStore` to `folder`/
  `chroma_media_move`.

## D-046 — Media pool pass 3: `shots`/`media` unification, docked Sources panel, bin tree, timeline switcher — closes the roadmap item

**decided (2026-09-02) · built (2026-09-02)**

- **Context.** Pass 1 (D-044) and pass 2 (D-045) shipped the model + commands
  (`media: Vec<MediaItem>`, bins, multiple `timelines`) with zero UI. This is
  **pass 3**, the last of the roadmap's "media pool + import + multiple
  timelines" item: unify `shots`/`media` for real, then build the actual
  panel/tree/switcher UI on top of it.
- **`shots`/`media` unification — `ProjectShot` references a `MediaItem` by
  id, wire DTOs unchanged.** `ProjectShot` becomes `{ id, mediaId, frame }` —
  `sourcePath`/`name` are gone; `project::resolve_shot(manifest, shot)` does
  the `media_id → (source_path, name)` lookup, with a graceful "dangling
  reference" fallback (`("", "(missing media)")`, flagged offline downstream
  — no `chroma_media_remove` command exists yet, but the reference can still
  go dangling from a hand-edited file or a future removal feature, so this
  had to be a real, tested case, not an assumption). `find_or_create_media`
  is the one choke point that attaches a shot's path to the pool
  (find-by-`source_path` or probe + create) — `new_project_in`,
  `chroma_project_save`, and `chroma_project_relink` all go through it
  instead of duplicating find-or-create logic. A brand new
  `chroma_project_add_shot(media_id)` command is the Sources panel's
  explicit "add to grading" action on an existing pool item (distinct from
  `chroma_media_import`, which stays pool-only).
  - **The wire DTOs (`ProjectShotDto`, `ProjectShotInput`, `ProjectOpenDto`)
    did not need to change shape.** D-044 flagged this unification as the
    pass likely to "touch every shot-related code path at once" including
    `useSessionStore` on the frontend. It turned out not to: `ProjectShotDto`
    (`chroma_project_open`'s output) and `ProjectShotInput`
    (`chroma_project_save`'s input) both already carried
    `id`/`sourcePath`/`name`/`frame` as a flat, self-contained shape with no
    hint of the backing model — so the media-id indirection could move
    entirely inside `project.rs`'s translation to/from those DTOs, invisible
    to the frontend. `chroma_project_save` now does find-or-create-media per
    incoming shot before building `ProjectShot`; `chroma_project_open`
    resolves each shot's path/name via `resolve_shot` before building the
    DTO. Net frontend cost for the *unification itself*: zero — `app/src/
    store/useSessionStore.ts` is unchanged (only exporting `ProjectOpenDto`,
    already an internal type, for `SourcesPanel`'s reuse). This is also why
    the existing Colorist "add shot via file picker" flow keeps working
    unmodified: it was always going through `chroma_project_save`, which now
    routes through the same find-or-create-media path pool imports do,
    without the frontend knowing anything changed.
  - **Migration — raw JSON, before typed deserialize, same move as D-045's
    timeline migration.** `migrate_legacy_shots` runs alongside
    `migrate_legacy_timeline` in `load_manifest`: every shot lacking a
    non-empty `mediaId` gets one, reusing a `media` entry with a matching
    `sourcePath` if one exists (dedup, same rule `add_media` uses) or
    synthesizing an unprobed one otherwise (no ffprobe shell-out on every
    project load — cheap and correct; a later `chroma_media_list` re-checks
    it). Checked against the real `~/Movies/Chroma/New.chroma/project.json`
    (1 shot, `media: []`) via a throwaway test, then deleted — it migrated
    to a real `mediaId` pointing at a synthesized pool entry with the
    correct `sourcePath`/`name`, exactly as designed.
  - **Probing cost note.** `new_project_in` now probes every seed clip up
    front (via `find_or_create_media` → the existing `probe_media_item`),
    not just the first one (previously only `infer_settings_from_clip`
    probed the first clip for the project's output spec). A minor behaviour
    change, not a regression — every shot's `MediaVideoInfo` is now
    available immediately instead of lazily via `edit.rs`'s probe cache on
    first Edit-tab open.
- **The docked Sources panel — lives in `app/`, injected into `@chroma/shell`
  by prop, same pattern as `ProjectLauncher`.** `Shell` gained a
  `sourcesPanel?: ReactNode` prop rendered as a fixed-width (288px) column
  sibling to the tab content (never layered over it), toggled by a
  chrome-bar button, state in `useShellStore.sourcesPanelOpen` (session-only,
  same reasoning as `activeTab`/`wgpuSurfaceActive`). The shell still never
  imports the panel component directly — `app/src/main.tsx` wires
  `<SourcesPanel />` in, exactly how `launcher` already worked. This keeps
  the D-039 layer direction intact: the panel needs `useSessionStore`
  (`_hydrateOpenDto`, for "add to grading") and `@chroma/editor`'s
  drag-to-track contract, neither of which `@chroma/shell` may depend on.
  `app/src/components/chroma/SourcesPanel.tsx`: Import (reuses
  `ProjectLauncher`'s `pickClips` native multi-select dialog, now exported),
  a client-side name filter (no search index — not asked for this pass), the
  bin tree, and a plain (no-thumbnail-image) grid of the pool, draggable.
  Importing through the panel is **pool-only** — it does not auto-create a
  shot; "add to grading" is a separate, explicit "+" on each item
  (`chroma_project_add_shot`). The existing Colorist file-picker "add shot"
  flow is untouched and still works standalone.
- **Bin tree.** A small recursive component (`FolderRow` in
  `SourcesPanel.tsx`) derived client-side from the flat `MediaItem.folder`
  path strings by splitting on `/` — no bin-hierarchy Rust endpoint, per
  D-045's call. Dragging a grid item onto a folder row calls
  `chroma_media_move` (`useMediaPoolStore.moveToFolder`, added this pass).
- **Timeline switcher.** `TimelineSwitcher.tsx` in `@chroma/editor` — a
  `Select` of `chroma_timeline_list` (D-045) with the active one checked,
  switching via `chroma_timeline_set_active`, plus inline "+ New" →
  `chroma_timeline_create`. Deliberately minimal: no rename/delete UI (no
  backing commands exist, and it wasn't asked for). `useEditorTimelineStore`
  gained `timelines`/`loadList`/`createTimeline`/`setActiveTimeline` wrapping
  those three D-045 commands, which had no UI consumer until now.
- **Drag-to-track — scoped to "the Edit tab is active," by construction, not
  by extra code.** The roadmap item pre-approved narrowing this scope if
  cross-tab drag was awkward under D-039's tab-mounting model, and it was:
  the Sources panel is shell-level, `TimelinePane` is inside the Edit tab's
  content, and D-039 forbids a shell-level component from depending on a tab
  package to share a `DndContext`. The fix is plain HTML5 `dataTransfer`
  drag/drop (`CHROMA_MEDIA_DRAG_MIME`, exported from `@chroma/editor`) —
  browser-native drag events cross the package boundary for free, no shared
  store or context needed. This *also* delivers the scoping requirement for
  free: `Shell` keeps every tab mounted but `hidden` (`display:none`) when
  inactive (pre-existing D-039 behaviour), and a `display:none` element is
  never a valid drop target — so a drop only ever lands on `TimelinePane`
  while the Edit tab is actually visible, with no explicit "is this tab
  active" check anywhere in the drop handler. `packages/editor/src/
  timeline.ts` gained an `add_clip` `EditOp` (append/insert a full-length
  `Clip` built from the dragged media's known frame count; a drop with no
  known frame count — unprobed/offline media — is rejected rather than
  adding a zero-length clip) and `clipFromDraggedMedia`. `TimelinePane` also
  gained a guard for a *track-less* timeline (`chroma_timeline_create` makes
  one with `tracks: []`, a state the pre-pass-3 UI could never actually
  reach since nothing created empty timelines yet) — an empty-state drop
  zone that creates the first video track on first drop.
- **Verified.** `cargo test chroma::` 73/73 (was 65; +8: shot↔media
  reference/rename/dangling-id/migration/save/add-shot round trips — real
  edge cases, not just happy path, per the ask). `chroma-timeline` untouched
  (no crate change needed — timeline edits still flow through
  `chroma_timeline_set`'s "store what's sent verbatim" contract, so
  `add_clip` is pure-TS, no Rust op needed). `cargo clippy`/`cargo fmt`
  clean on touched files only (`project.rs`, `edit.rs`, `lib.rs`) — verified
  file-by-file per the hard rule, no crate-wide `cargo fmt` run; the
  pre-existing `project.rs` `if`-collapse/`sort_by_key` clippy hints predate
  this change and were left alone. `app` `tsc --noEmit` unchanged at 64;
  `packages/bridge` and `packages/shell` clean; `packages/editor` at its
  pre-existing 1 (the unrelated CSS-import declaration).
  - **A `--no-default-features` full build (what `npm run tauri:dev` actually
    invokes) hit a flaky macOS `ld` "symbol(s) not found" error mid-session**
    (duplicate-anonymous-LLVM-constant class of bug, in `image-webp`/
    `av-scenechange`/`rav1e` — codecs this change never touches). Confirmed
    via `git stash` that the pre-D-046 tree built clean under the same flags,
    then confirmed a `CARGO_INCREMENTAL=0` full rebuild of the **D-046** tree
    also built clean — isolating it to stale/corrupted incremental-cache
    state from this session's many mixed-feature-flag `cargo` invocations,
    not a defect in this change. Not logged as a `B-NNN` (housekeeping, same
    exclusion `CLAUDE.md` names for "disk was full").
  - **Booted the real app** (`npm run tauri:dev`) and drove it via macOS
    Accessibility (`osascript`/System Events) — no screen-recording access.
    Created a real project from a real file, confirmed the Sources panel
    toggle, grid, and "add to grading" all work by reading `project.json`
    before/after each interaction (not just AX-tree presence): a fresh
    project's seed clip lands in `media` **and** gets a `shot` referencing
    it; `Import`ing a second real file adds it to `media` only, confirmed
    zero new shots (import is pool-only, by design); clicking a pool item's
    "+" fires the real `chroma_project_add_shot` command end-to-end
    (`tauri::State` and all — untestable as a unit test, verified live
    instead) and the shot count goes to 2. `TimelineSwitcher`'s "+ New"
    creates a second, empty (`tracks: []`) timeline and makes it active,
    confirmed via `project.json`'s `activeTimeline`.
  - **Two real bugs found live and fixed, not just "it renders":**
    (1) `TimelinePane`'s `buildRow` (feeding `editorData`'s `useMemo`, which
    runs *before* the component's own "no video track yet" early-return
    guard) crashed the whole React tree — `TypeError: undefined is not an
    object (evaluating 'track.clips')` — the moment a project actually
    switched to an empty timeline, which pass 2 could never produce
    (`chroma_timeline_create` didn't exist yet) but pass 3's switcher does
    every time "+ New" is clicked. Fixed with `buildRow`'s own `if (!track)`
    guard. (2) `TimelineSwitcher`'s `SelectValue` showed the raw timeline
    **id** instead of its name — Base UI's `Select.Value` renders the bare
    `value` unless given a `children` render function; fixed by mapping
    `id → timelines.find(...).name` there. Both caught only by actually
    clicking through the app, not by `tsc`/build success — exactly why this
    pass's verification bar required it.
  - **Drag-to-track / drag-to-folder — verified by review, not a live
    click-through; noted honestly rather than asserted.** AppleScript UI
    scripting (the mechanism every other live check in this pass used) has
    no drag primitive, so `cliclick` (CGEvent-level synthetic input) was
    installed to attempt a real OS drag. Its mouse *moves* landed correctly
    (`m:` + position read-back matched), but neither its synthetic clicks
    nor drags produced any observable effect on the app (no `project.json`
    change, no frontend console activity at all) — including a plain
    synthetic click on a button AX scripting had already proven clickable
    seconds earlier. That isolates it to a CGEvent-delivery/permission gap
    for whatever posts on `cliclick`'s behalf in this sandbox (distinct from
    the Accessibility-API path `osascript`/System Events uses, which does
    work here), not a bug in the drag code itself. What *is* verified: the
    `dataTransfer` contract is symmetric and small (`CHROMA_MEDIA_DRAG_MIME`
    set on `dragstart` in `SourcesPanel`, read in `onDrop` in `TimelinePane`/
    `FolderRow`), `clipFromDraggedMedia`'s reject-when-unprobed guard, and
    `add_clip`'s empty-timeline auto-vivify — all by direct code review, plus
    the fact that a clip landing via any path (drag or otherwise) flows
    through `chroma_timeline_set`'s already-tested "store what's sent
    verbatim" contract. This is the one piece of this pass without a live
    click-through; a follow-up session with working drag-capable tooling (or
    running interactively, where a person can literally drag) should confirm
    it directly rather than trusting review alone indefinitely.
  - Dev server killed after (`lsof -ti:1420 | xargs kill -9` +
    `pkill RapidRAW`).
- **Deferred / still open:** a live (not just reviewed) confirmation of
  drag-to-track/drag-to-folder once drag-capable tooling is available;
  timeline rename/delete (no UI or command); thumbnail generation for the
  Sources grid (generic file icon for now); Editor timeline audio playback
  (roadmap item 1, unrelated to this one); and the mature multi-track
  timeline UI (roadmap item 2) — this pass closes out "media pool + import +
  multiple timelines," not those neighbours.

## D-047 — Motion tab MVP: `@remotion/player` embed, JSON-in manifest editor, `chroma-motion` render bridge (Rust orchestrates Node)

**decided (2026-09-02) · built (2026-09-02)**

- **Context.** `04-roadmap.md`'s "Next" item 5: `packages/motion-engine/`
  (7 primitives + the JSON scene-manifest compiler, moved in from
  `videoAgent/engine/motion/` at the D-039 migration) is fully functional but
  only reachable via a CLI render — `@chroma/motion`'s `MotionTab` was a
  static placeholder. This wires it into a real tab: a live preview, an
  editor, save, and a render action.
- **`@remotion/player`, not a CLI render, for the preview.** `MotionPreview`
  renders `<Player component={Video} inputProps={manifest} …>` — `Video` is
  the engine's own component (the same one the `Animation` `<Composition>`
  registers in `Root.tsx`), fed `durationInFrames`/`fps`/`compositionWidth`/
  `compositionHeight` computed from the manifest via the engine's own
  `totalFrames`/schema defaults (`build.ts`) rather than reimplementing that
  math. Deep-imports the engine's `src/engine/*` modules directly
  (`@chroma/motion-engine/src/engine/Video` etc.) — the package ships no
  `main`/`exports` field (it's a Remotion CLI project, not built as a
  library), and adding one would mean editing a package this task treats as
  a read-only reference; a bare subpath import resolves fine with no
  `exports` map to sandbox it, and needs zero engine-side changes.
- **JSON-in, not a visual editor — deliberately scoped down.**
  `product-direction.md` §9 leaves "does the manifest editor become visual"
  genuinely undecided. Building a node/property editor this pass would be
  guessing at a shape nobody has picked yet. `ManifestEditor` is a plain
  `<textarea>` (no code-editor dependency — `@chroma/ui` has none; pulling
  one in for a first pass wasn't worth it), live-parsed (300ms debounced)
  against the engine's actual `zod` `manifestSchema` — the schema's single
  source of truth stays `schema.ts`, nothing is redeclared in Rust or a
  second TS copy. A parse/validation failure never blanks the preview: the
  last manifest that parsed clean keeps rendering while the error text shows
  separately, so a mid-edit typo doesn't read as "it's broken."
- **`chroma-motion` crate = Rust orchestrates Node, not reimplements it.**
  Per `architecture-lock.md`'s layer table (`chroma-motion`, L2, depends on
  `chroma-types`). Its entire job is `npx remotion render Animation
  <output> --props=<manifest>` inside `packages/motion-engine/` — the exact
  command `/animate` already documents for a CLI render — via
  `std::process::Command`. This is the one deliberate exception to "the fat
  core is Rust" in this otherwise Rust-centric architecture: the Remotion
  engine (7 primitives, a manifest compiler, React/Three.js rendering) is
  already real, working, non-trivial code, and reimplementing a Remotion
  renderer in Rust to satisfy an architectural preference would be pure
  waste. The crate validates fast before spawning (`engine_dir` exists,
  `manifest_path` exists and parses as JSON) and otherwise does no schema
  validation of its own — re-deriving the `zod` schema in Rust would just
  drift from `schema.ts`. `build_command`/`validate_request` are pure and
  unit-tested (5 tests); `run_render` blocks the calling thread, so the
  Tauri command `chroma_motion_render` wraps it in
  `tauri::async_runtime::spawn_blocking(...).await` — the caller gets a
  plain success/failure once `npx` exits, no progress polling. Uses
  `chroma_types::ChromaError` directly as its error type rather than a
  redundant local enum — a genuine fit for chroma-types' own stated role
  ("every fallible Chroma API returns `Result<_, ChromaError>`"), not a
  drive-by dependency to match the layer table.
- **Manifest persistence = a project-scoped sidecar file, not a
  `ProjectManifest` field.** `<project>.chroma/motion/manifest.json` (new
  Tauri commands in a new `app/src-tauri/src/chroma/motion.rs`, resolved via
  `state::current_project()` — the same source `edit.rs`'s
  `current_project_dir()` reads), mirroring how `grade.rs` already
  externalises each shot's `grade.json` as a path-addressed sidecar rather
  than inlining it into `project.json`. Deliberately **not** a
  `ProjectManifest.motion: Option<...>` field even though the additive-field
  pattern (`settings`, `timelines`, `media`) was available and would have
  been the more "consistent" choice on paper: `project.rs` had a large,
  actively in-flight concurrent edit (D-044/D-045's media-pool work) at the
  time this was built, in a separate worktree — touching that file at all
  would have meant a merge collision for no real benefit, since a sidecar
  needs no `ProjectManifest` change to work. One manifest per project this
  pass (matches the roadmap's stated scope); multi-manifest / scene
  management is deferred, not designed.
- **Render output defaults to `<project>.chroma/motion/render.mp4`** — a
  single fixed path (not timestamped), so "Render" is a safe re-run/
  overwrite by default; `chroma_motion_render` still accepts an explicit
  `output_path`. A save-dialog / render history / progress UI is future
  work — out of scope for "does the manifest editor + preview + a basic
  render action work at all."
- **A latent `@react-three/fiber` × `@chroma/ui` typing collision, found and
  fixed (see B-008).** Wiring `Scene3D` (via `Video`) into a shared `tsc`
  program for the first time exposed that `@react-three/fiber`'s global
  `JSX.IntrinsicElements` augmentation — inherent to how r3f works, not a
  bug in r3f — breaks any component elsewhere in the *same* program that
  renders a `React.ElementType`-typed prop through JSX (TS's prop-type
  intersection over the now-much-larger `JSX.IntrinsicElements` union
  collapses `children` to `never`). Two pre-existing instances of that
  pattern broke: `@chroma/ui`'s `Text.tsx` (`as`-prop polymorphism) and
  `app/src/components/panel/BottomBar.tsx`'s `PanelToggleButton` (`Icon`
  prop). Both fixed with `React.createElement`/`createElement` in place of
  JSX for that one call — behaviorally identical (JSX desugars to the same
  call), and `createElement`'s generic signature doesn't distribute over the
  union the same way JSX's does. No other instances found: a strict
  before/after `tsc --noEmit` diff across `app/` (64 errors either side,
  identical file list) was used specifically to catch every such instance
  application-wide, not just the ones exercised by manual testing.
- **Two real duplicate-package bugs, found and fixed — one a type-checking
  problem, one an actual runtime crash.** Both share a root cause:
  `packages/motion-engine`'s dependency versions don't line up with what
  the rest of the workspace resolves, and npm nests a second copy instead
  of hoisting one shared instance — invisible until something actually
  imported motion-engine's components into another package's tree (nothing
  had, before this).
  - **react/react-dom/@types (type-checking).** `packages/motion-engine/package.json`
    pins exact versions (`react@19.2.3`, `@types/react@19.2.7`) that don't
    satisfy the root workspace's `react@^19.2.8` range, so npm installed a
    **second, nested** copy under `packages/motion-engine/node_modules/`.
    Two React instances in one component tree is not just a type-checking
    nuisance, it's a real runtime bug class (broken hooks, context that
    can't cross the boundary) — `<Player component={Video} …>` would have
    hit exactly this at runtime even if `tsc` had stayed quiet.
  - **remotion (runtime crash, caught live — B-009).** Booting the app for
    real (see Verified) surfaced what static checks structurally cannot:
    six `@remotion/*` packages `motion-engine` pins with a caret
    (`animation-utils`, `google-fonts`, `motion-blur`, `noise`,
    `transitions`, and transitively `shapes`) each carry their own nested
    `remotion@4.0.520`, one patch ahead of the `4.0.519` pinned everywhere
    else — and Remotion's own runtime **hard-errors** on a version mismatch
    ("Multiple versions of Remotion detected"). Since `Video.tsx`'s
    `loadFont()` (a `@remotion/google-fonts` call) runs at module-eval
    time and `@chroma/shell` keeps every tab mounted, this crashed the
    **whole frontend**, not just the Motion tab — no `tsc` signal at all,
    since both versions are type-compatible. This is the concrete reason
    the "boot the app for real" verification step in the brief matters.
  - **Fixed at the root workspace, not by touching motion-engine's pins**
    (kept read-only): a root `package.json` `overrides` block pins
    `react`/`react-dom`/`@types/react`/`@types/react-dom`/`remotion` to the
    versions already resolved at the workspace root, which a **full clean**
    `rm -rf node_modules && npm install` (an incremental `npm install` on
    top of the old lockfile/`node_modules` state did *not* reliably apply a
    newly-added override — confirmed twice, for both the react and the
    remotion override) used to collapse both duplicates —
    `packages/motion-engine/node_modules/{react,react-dom,@types/react}`
    and `node_modules/@remotion/google-fonts/node_modules/remotion` no
    longer exist after. Confirmed no regression: `motion-engine`'s own
    `tsc --noEmit` went from 24 pre-existing errors (all in
    `Scene3D.tsx`/`ParticleFlow.tsx`, r3f's `JSX.IntrinsicElements`
    augmentation not resolving consistently under the split-version setup)
    to **0** — the react dedup fixed a second pre-existing bug as a side
    effect, not just avoided a new one.
- **Verified:** `cargo test -p chroma-motion` 5/5. `cargo check -p RapidRAW`
  clean (pre-existing warnings only, all in `ai_processing.rs`, unrelated).
  `cargo clippy -p RapidRAW -p chroma-motion --all-targets` — zero warnings
  in any file this change touched (the warnings clippy does report are all
  pre-existing, in files untouched by this change). `cargo fmt --check` run
  only on the files actually written (`crates/chroma-motion/src/lib.rs`,
  `app/src-tauri/src/chroma/motion.rs`) — never on `mod.rs`/`lib.rs`
  themselves, which (per D-045's note above) recursively reformat every
  `mod`-reachable file from a crate root; caught an accidental cascade into
  12 unrelated `chroma/*.rs` files from one early exploratory `rustfmt
  mod.rs` call and reverted it via `git checkout` before it went anywhere.
  `tsc --noEmit` — `packages/motion` 0 errors, `packages/motion-engine` 0
  (was 24, see above), `packages/ui` 0 (was 3, see B-008), `app` 64 errors
  before AND after this change, byte-identical file list (diffed, not
  eyeballed) — so the two real typing fixes above are net-zero on the
  app's pre-existing debt, not a new regression hiding among it.
  **`npm run tauri:dev` real boot** (port 1420 was held by a concurrent
  agent's own dev session in a different worktree — same-bundle-identifier
  Tauri apps are OS-level single-instance, so this run used a temporary
  port override, 1425, in both `vite.config.mjs` and `tauri.conf.json`'s
  `devUrl`, for the verification session only, reverted before commit;
  confirmed via `osascript`, matching on the launched process's own PID,
  that a distinct native window opened rather than refocusing the other
  worktree's): Vite ready, the Tauri binary starts, and — the concrete
  regression test for the exact bug this session found (the "Multiple
  versions of Remotion" crash below) — the dev-server stdout and the
  app's own log file stayed clean for the whole session: no "Multiple
  versions of Remotion" error, no "Frontend failed to report ready within
  timeout" warning (both of which fired immediately, every time, before
  the fix), and no `console.error`/`warn` forwarded through
  `frontendLogBridge`. Every module in the Motion tab's import chain
  (`MotionPreview.tsx` → `motion-engine`'s `Video.tsx` →
  `@remotion/google-fonts`) serves `200` through Vite. **Not verified this
  pass:** pixel-level confirmation that the `@remotion/player` canvas paints
  the sample manifest (no screen-recording permission in this environment —
  `screencapture` fails with "could not create image from
  display"/"...from rect" — and WKWebView content isn't introspectable via
  `System Events` accessibility beyond window existence, so this falls back
  to the log-evidence method the task anticipated for exactly this
  constraint), and Save/Render were not exercised against a real open
  project (no `.chroma` project was created for this pass) — both are
  thin, already-unit-adjacent Tauri commands (`chroma_motion_save_manifest`/
  `chroma_motion_render`, see `motion.rs`) rather than load-bearing new
  logic, but they are genuinely unverified end-to-end and should be the
  first thing a follow-up session checks with a real project open.
- **Deferred:** a visual manifest editor (open question, see above), multi-
  manifest / scene management, render progress reporting / cancel / queue,
  a save-dialog for the render output path, any packaged-build story for
  `packages/motion-engine` (today's `engine_dir()` resolution assumes the
  dev-time monorepo layout via `CARGO_MANIFEST_DIR`), and an end-to-end
  save/render check against a real open project (see Verified, above).

## D-048 — Interactive relight (puck UI + depth-driven shading): v1/v2 scope, WGSL stage placement, depth-bitmap reuse
**decided (2026-09-02) · built (2026-09-02)**

- **Context.** `docs/notes/relight-research.md` (2026-09-02) split relight into
  two modes behind one puck UI: **interactive** (deterministic, real-time,
  screen-space shading off the depth track — v1/v2) and **bake photoreal**
  (RelightVid/IC-Light diffusion in the `ai/` sidecar — v3, separate task, not
  touched here). This decision covers the interactive mode only: the puck UI,
  the "Relight" grade layer + light schema, keyframing, and the GPU shading
  pass. Studied first: the existing radial/linear mask handle interaction
  (`ImageCanvas.tsx`), D-024 (depth-haze — the closest precedent for a
  grade-shader stage consuming a depth bitmap), D-034 (mask keyframes — the
  mechanism this reuses verbatim for light position/radius), D-036 (the
  Video-Depth-Anything per-frame depth track this feature shades against).

- **Where the shader stage lives — crate placement.** Checked
  `crates/README.md`'s migration status first, per the brief: `chroma-grade`/
  `chroma-grade-model` are still **stub crates** (D-039 step 1) — the real
  grade renderer (`AllAdjustments`, the WGSL shader, D-024's depth-haze logic)
  all still live directly in `app/src-tauri/src/{image_processing,
  gpu_processing,mask_generation}.rs` + `shaders/shader.wgsl`. **Choice:**
  follow that actual current pattern — relight's uniform struct + JSON parsing
  go in `image_processing.rs`, its depth-bitmap rasterizer in
  `mask_generation.rs` (sibling to `generate_ai_depth_bitmap`), its shading
  math in `shader.wgsl` — not a premature `chroma-grade` extraction that would
  split relight from the depth-haze code it directly parallels.

- **The puck UI — HTML overlay, not the Konva mask-shape tree.** The brief
  named the radial/linear mask handles as the pattern to study. Read them
  (`handleRadialDragStart/Move/End`, a Konva `<Transformer>`-backed shape with
  resize + rotate). But `ImageCanvas.tsx` already has a **second**, lighter
  canvas-overlay pattern for a plain draggable point that isn't a mask
  geometry — the clone/heal source marker (`directPatchMarkers`): a bare
  `absolute inset-0 pointer-events-none` div holding `pointer-events-auto`
  circles positioned via `(imageSpace - crop) * imageRenderSize.scale +
  imageRenderSize.offsetX/Y`. A light puck (drag = position only; no resize,
  no rotate — falloff radius is a side-panel slider per the brief's own
  ClipDrop-interaction spec) is structurally that marker, not a mask shape.
  **Choice:** `RelightPuckLayer.tsx` (new, `panel/editor/`) — the marker
  overlay pattern, native pointer-capture drag, mounted as a sibling `<div>`
  inside `ImageCanvas.tsx`'s existing content wrapper, gated on a new
  `isRelighting` prop (mirrors `isMasking`/`isCropping` exactly). Zero Konva
  `<Stage>`/`<Layer>` changes.

- **The "Relight" layer — a sibling top-level `Adjustments` field, not a
  mask.** `adjustments.relightLights: RelightLight[]` (`{id, kind: 'key' |
  'fill' | 'rim' | 'ambient', x, y, radius, intensity, color, visible,
  chromaKeyframes?}`, 0–100 percentages matching existing shape-mask geometry
  conventions) + `adjustments.relightDepthDir: string | null` (its own
  tracked-depth-dir reference, D-036's shape, at the top level because relight
  shades every pixel via a depth-derived normal — it has no rasterized
  opacity matte and doesn't belong in `adjustments.masks`). `kind` only
  changes the shading math for `'ambient'` (uniform tint, no
  position/normal/falloff); key/fill/rim share one math path and differ by UI
  preset defaults only (`relightUtils.ts`).

- **Depth source — reuses D-036's tracked-dir mechanism verbatim, no static-
  bake fallback in v1.** The Relight panel's "Track Depth" button calls the
  *same* `chroma_depth_track`/`chroma_depth_track_status` commands D-036's
  mask-panel button does (one sidecar job type; only one runs at a time
  regardless of caller) — `useAiMasking.ts`'s new `handleTrackRelightDepth`
  writes the resulting dir to `relightDepthDir` instead of a sub-mask's
  parameters. Rust-side, `chroma::relight::resolve_depth_dir` reads that
  field and `mask_generation::generate_relight_depth_bitmap` rasterizes it via
  the *exact* `tracked_depth_map` (D-036) + `generate_ai_bitmap_from_full_mask`
  path `generate_ai_depth_bitmap` already uses for the AI-Depth mask, minus
  the band-pass/feather (relight wants the raw per-pixel depth value, not a
  mask opacity). **Deferred:** a static single-frame bake fallback for a
  depth-less clip (D-024's AI-Depth mask has one; relight doesn't in v1) —
  `docs/04-roadmap.md`. Until "Track Depth" runs, positional lights are inert
  (no crash — see the shader gate below); ambient lights work with no depth
  at all.

- **The GPU pass — reuses the mask-texture-array + `textureLoad` access
  pattern D-024's depth-haze mask already established, not a new bind-group
  texture.** `mask_textures` (`texture_2d_array<f32>`, binding 3) is already
  how a depth bitmap reaches the shader (D-024: the AI-Depth mask's bitmap is
  just one more array layer, sampled via `get_mask_influence`'s
  `textureLoad`). **Choice:** append the relight depth bitmap as **one more**
  layer on the *same* array — no new texture, no new bind-group entry, no new
  WGSL binding. The render call site (`process_preview_job` in `lib.rs` —
  the **one** function both `apply_adjustments` (interactive edits) and
  `chroma_play_frame` (D-031 playback) funnel through via the shared preview-
  worker channel, so this wiring covers both live paths for free, at
  playback speed, with zero `playback.rs` changes) pushes the resolved depth
  bitmap onto the same `Vec` `get_cached_or_generate_mask` already built, and
  records its index in a new `AllAdjustments.relight_depth_layer: i32` field
  (`-1` = none bound). Every *other* `mask_bitmaps` construction site
  (export, thumbnail, LUT bake — 7ish call sites) is deliberately left
  untouched: `relight_depth_layer` stays `-1` there, so positional lights are
  inert on those paths (ambient still renders — it needs no depth) rather
  than wired up. This is the explicit "do NOT build an export/apply-to-whole-
  video step" boundary from the brief — export inherits relight for free once
  a future pass wires the same two lines into `export.rs`, but that pass is
  not this one.
  - `RelightLightGpu` (`image_processing.rs`): 8 `f32`s, two 16-byte rows, no
    padding — `pos_x, pos_y, radius, intensity, color_r, color_g, color_b,
    kind` (`kind`: `0.0` positional, `1.0` ambient). `AllAdjustments` gains
    `relight_lights: [RelightLightGpu; 8]`, `relight_light_count: u32`,
    `relight_depth_layer: i32` + 2×u32 pad — mirrored field-for-field in
    `shader.wgsl`'s `AllAdjustments`/new `RelightLight` struct.
  - **Shading model (`apply_relight`, `shader.wgsl`)** — deterministic,
    approximate, explicitly not photoreal (matches
    `relight-research.md`'s stated trade-off): per-pixel normal reconstructed
    from a central finite-difference of the depth texture (treating "near"
    i.e. bright as "up" toward camera — a heightfield-normal trick, not a
    real 3D reconstruction), a screen-space light direction built from the
    puck's 2D screen offset (aspect-corrected) plus a depth delta between the
    light's own anchor point and the shaded pixel, `max(0, dot(N,L)) ·
    falloff(radius) · colour · intensity` per light, `falloff` a quadratic
    ramp to zero at `radius`. No cast shadows, no reflections, can't undo
    lighting baked into the plate — the exact limitations
    `relight-research.md` named as the accepted trade for "instant, holds on
    video, fully deterministic." Runs in the same stage as the existing
    mask-blur/vignette block: linear light, post per-mask grade, pre-tonemap.
  - **Determinism.** Same inputs → same `textureLoad`s → same arithmetic —
    no new source of non-determinism (no `rand()`, no wall-clock; the one
    external input, the depth PNG, is itself a deterministic file read keyed
    by source frame, D-036). Verified by rendering the same frame twice with
    a relight setup and diffing (byte-identical).

- **Keyframing — reuses D-034's mechanism verbatim, not a new system.** A
  `RelightLight` object carries `chromaKeyframes` in the *exact* `[{frame,
  params}]` shape a shape sub-mask's geometry does. Rust:
  `chroma::relight::parse_relight_lights` calls
  `chroma::keyframes::interpolated_parameters` (already generic over any
  params `Value`) per light before extracting `x`/`y`/`radius` — the same
  one-hook pattern `generate_sub_mask_bitmap` uses, zero new interpolation
  code. Frontend: `utils/maskKeyframes.ts` gains one entry,
  `GEOMETRY_KEYS.relight = ['x', 'y', 'radius']` — every existing function
  (`parseKeyframes`/`interpolate`/`upsertKeyframe`/`removeKeyframe`/
  `clearKeyframes`) is already generic over a plain params object, so a
  `RelightLight` is used as one directly. `RelightPanel.tsx`'s keyframe row
  is a light-specific redraw of `MaskKeyframeBar.tsx`'s UI (button + diamond
  affordance), not an import of it — that component is sub-mask-typed
  (`updateSubMask`); a byte-shared component wasn't worth forcing over a
  ~20-line redraw against the same underlying utils.

- **v1/v2 scope boundary (per the brief) — confirmed, not touched:** the
  diffusion "bake" mode (RelightVid/IC-Light, the `ai/` sidecar, the
  preview-one-frame-then-commit bake UX note in `relight-research.md`) is
  entirely out of scope for this decision — v3, a separate future task. No
  `ai/` sidecar file was touched. No batch/export command was added.

- **Panel registration.** `Panel.Relight` added to `AppProperties.tsx`'s enum
  + `useUIStore.ts`'s `ALL_PANELS`/`DEFAULT_PANEL_DEFAULT_REGIONS`/both
  `rightTop` default layouts + one i18n tooltip key (the framework-level
  panel-switcher plumbing is upstream RapidRAW machinery every panel already
  goes through this way). `RelightPanel.tsx`'s own content is plain strings,
  no `useTranslation` — matching the established Chroma-addition convention
  (`MaskKeyframeBar.tsx`), not upstream's i18n convention, since Chroma's own
  components have never carried translations. **Trimmed from the brief's
  ClipDrop reference strip:** the bottom tabs are Ambient / Light-N / +Add
  Light only — no "Preset" tab (saved/built-in lighting looks). Nothing in
  the schema or the functional asks needed it; it's UI polish, deferred to
  `docs/04-roadmap.md` rather than guessed at.

- **Consequences / footprint.** New: `app/src-tauri/src/chroma/relight.rs`
  (pure + unit-tested: hex-colour parsing, JSON→spec parsing + defaulting,
  visibility filtering, the `MAX_RELIGHT_LIGHTS` cap, GPU-struct percentage
  scaling, the keyframe-hook wiring, depth-dir resolution, and a real-GPU
  render-determinism + "lights actually change pixels" test — 10 tests),
  `app/src/utils/relightUtils.ts`, `app/src/components/panel/editor/
  RelightPuckLayer.tsx`, `app/src/components/chroma/RelightPanel.tsx`. Edited:
  `image_processing.rs` (+`RelightLightGpu`, `AllAdjustments` fields — the two
  pad fields are `pub(crate)`, not private: `export_processing.rs`'s
  `build_single_mask_adjustments` constructs a full `AllAdjustments` via
  `..Default::default()` from outside this module, which Rust's struct-update
  syntax still requires every field be visible for — and the
  `get_all_adjustments_from_json` hook), `mask_generation.rs`
  (+`generate_relight_depth_bitmap`), `lib.rs` (`process_preview_job`'s
  depth-bitmap-append, a `let`-chain per `clippy::collapsible_if`),
  `export_processing.rs` (`build_single_mask_adjustments` zeroes relight too —
  it isolates one mask's effect for a preview export, and relight is a global
  layer, not scoped to any mask), `shader.wgsl` (+`RelightLight` struct,
  `AllAdjustments` fields, `apply_relight` + 3 helpers, one call site),
  `chroma/mod.rs` (+1 `pub mod`), `adjustments.ts` (+`RelightLight` interface,
  2 `Adjustments` fields), `maskKeyframes.ts` (+1 `GEOMETRY_KEYS` entry),
  `ImageCanvas.tsx` (+`isRelighting` prop, the puck-layer mount, a drag
  handler — ~30 lines), `Editor.tsx`/`App.tsx` (panel wiring),
  `useEditorStore.ts` (+`activeRelightLightId`), `useAiMasking.ts`
  (+`handleTrackRelightDepth`), `AppProperties.tsx`/`PanelSwitcher.tsx`/
  `useUIStore.ts`/`en.json` (panel registration), `useChromaControl.ts`
  (+`list_relight_lights`/`add_relight_light`/`set_relight_light`/
  `delete_relight_light` — the control-server/MCP-facing surface, mirroring
  `add_mask`/`list_masks`/`delete_mask`'s exact shape; added so the feature
  is agent-drivable like every other adjustment layer already is, and used
  to verify this decision against the real running app — see Verified below).
  **No `AppState`/Cargo/bind-group/new-Tauri-command change** — relight rides
  the existing generic preview-worker + mask-texture-array plumbing entirely.

- **Verified (2026-09-02).** `cargo check`/`cargo test --no-default-features
  chroma::` **75/75** green (incl. the 10 new relight tests — the GPU
  determinism test ran for real, a real Metal adapter was available);
  `cargo clippy --no-default-features -p RapidRAW --no-deps` clean on every
  touched/new file (fixed the 2 `collapsible_if` hits in `lib.rs` this pass
  introduced; the other 15 pre-existing warnings, in files this pass never
  touched, are untouched); `cargo fmt --check` clean on every touched file
  (the one flagged diff, `mask_generation.rs:1272`, is pre-existing D-034
  drift, confirmed present before this change too — left alone per CLAUDE.md).
  `cd app && npx tsc --noEmit` — **64** errors, unchanged from baseline, zero
  in a touched/new file. **Live app, real project:** booted
  `npm run tauri:dev` from this worktree (temporarily overrode
  `tauri.conf.json`'s `identifier` for the run only, to dodge
  `tauri-plugin-single-instance` colliding with a concurrent agent's own
  RapidRAW-identified dev instance on the same machine — reverted to a clean
  `git diff` before finishing), opened the real
  `~/Movies/Chroma/New.chroma` project (a 4K/50fps video shot) over the
  control-server bridge, and drove the new ops directly (no screen-recording
  or accessibility access to the WKWebView content in this sandbox, so this
  is the log/state-evidence fallback the brief names, not a screenshot):
  `add_relight_light` (ambient, green, intensity 80) → the control server's
  own mutating-op response includes a fresh rendered preview JPEG + scopes;
  decoded and inspected it — **the entire frame is washed a solid, uniform
  green**, exactly `apply_relight`'s ambient math (`color · intensity`, no
  position/normal/falloff). `set_relight_light` (intensity 80 → 15) on the
  same light → the re-rendered preview shows a visibly fainter, proportional
  tint — confirms live intensity scaling and that a per-id update actually
  re-renders. A positional `key` light added with no depth track present
  produced **zero visible change** (correct — `apply_relight`'s `has_depth`
  gate; already proven to shade correctly *with* depth by the Rust
  determinism test's synthetic radial depth map). `list_relight_lights`
  confirmed both test lights, then both were deleted via
  `delete_relight_light` and the scopes returned to the pre-test baseline
  numbers — the project's `grades/*.grade.json` on disk (autosaved mid-test)
  was re-checked after cleanup and correctly shows `relightLights: []`, so
  the user's real project was left exactly as found. **Not directly
  observed:** the canvas puck drag interaction itself (`RelightPuckLayer`) —
  no screen capture available in this sandbox to watch a drag; verified by
  code review + the identical coordinate-math pattern the existing
  clone/heal marker overlay already uses successfully, plus `tsc` finding no
  type errors in it. Dev server + app process killed after.

## D-049 — Export moves to a top-right dialog in the Colorist tab, `ExportDialog`; the old `Panel.Export` toggle stays routed (different, unrelated feature)

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** `04-roadmap.md` "Next" item 3: move Export out of "the buried
  `ExportPanel` toggle" into a proper dialog. Before touching anything: read
  what `Panel.Export`/`ExportPanel.tsx` (`app/src/components/panel/right/`)
  actually does. **Finding: it is not, and never was, a video exporter.**
  It's the unmodified RapidRAW still-image export panel — JPEG/PNG/TIFF/
  WebP/JXL/Cube format buttons, resize/watermark/metadata options, calling
  `Invokes.ExportImages` → `export_processing.rs`'s `export_images_impl`,
  which `image::open()`s each path as a still. `selectedImage` (the panel's
  input) is non-null and points at the real clip path for a loaded *video*
  shot too (`useSessionStore`'s `applyLoaded` sets it alongside
  `useChromaStore.videoInfo` — no video/still branch anywhere), so the panel
  is fully reachable and shows "Export" as a live option while grading a
  clip — it would just feed the video file into the still-image pipeline and
  fail. The actual video-export backend (`chroma_export_video`/
  `chroma_bake_lut`/`chroma_export_progress`, D-022) had **zero** GUI caller
  before this decision — the only place invoking them was
  `useChromaControl.ts`'s agent-facing `OPS.export` (the MCP control
  surface). `BottomBar.tsx` even carries a long-dead `onExportClick`/
  `isExportDisabled` prop pair, declared but never read in its body and
  never passed from `App.tsx` — a leftover stub from some earlier,
  abandoned wiring attempt.
- **Built: a new self-contained `ExportDialog.tsx`** (`app/src/components/
  chroma/`, same "reads its own stores, no prop drilling" pattern as
  `ShotStrip`/`RelightPanel`/`ProjectSettingsModal`), mounted as the
  right-most icon button in `EditorToolbar`'s top-right button group
  (undo/redo/show-original/fullscreen already live there — literally the
  Colorist tab's top-right corner, since the canvas fills the rest of the
  screen). `@chroma/ui`'s `Dialog` + `Select` (D-042) per the roadmap
  item's explicit ask; the rest (resolution/range chips, number inputs,
  progress bar) are plain elements + app colour tokens, matching
  `ProjectSettingsModal`'s pre-existing convention — no `@chroma/ui`
  `Progress` primitive exists yet and adding one for a single caller wasn't
  worth it.
  - **Fields:** codec (ProRes profile 0–5 / H.264 CRF 0–51), resolution
    (chip choice: **Project** spec if `ProjectSettings.width`/`height` are
    set (D-038) — the stated default — else **Clip** (the loaded clip's own
    dimensions, selected by default when no project spec exists) — or
    **Custom** w×h), frame range (**Full clip** default, or a **Custom**
    from/to pair validated client-side against `[0, frameCount-1]`), a
    "**also bake a .cube LUT**" toggle, an output path via
    `@tauri-apps/plugin-dialog`'s `save()` (same convention as `ShotStrip`/
    the old `ExportPanel`) defaulting to `<stem>.graded.<ext>` next to the
    source clip when left unset (mirrors `export.rs`'s own
    `default_out_path`), and a progress bar.
  - **Progress: wired to the real thing, not faked.** `chroma_export_video`
    already exposes `chroma_export_progress` (a poll-only `{running, done,
    total, out_path, error}` snapshot of a module-global `Mutex`, no push
    events) — the dialog polls it every 350 ms while exporting and turns
    `done/total` into a real percentage bar. No Rust change was needed for
    this part; it was already there, just never polled from a GUI.
  - **The `.cube` bake is a second, sequential call**, not folded into
    `chroma_export_video` — `chroma_bake_lut` is a different, already-fast
    (sub-second, no progress needed) synchronous operation on the *primary
    grade only* (D-022's existing scope/limits: masks dropped, no LUT-on-LUT
    — unchanged, this dialog doesn't touch that logic). Runs after the video
    export finishes; a bake failure toasts a warning but doesn't roll back
    or re-flag the (successful) video export.
- **One real Rust change, and it's a parameter, not new logic: `out_width`/
  `out_height` on `chroma_export_video`.** The command already had
  `ExportOpts.out_width/out_height` (D-038) — it just always derived them
  itself from the *project's* settings, with no way for a caller to pass an
  explicit override or force "clip-derived" back on when a project spec
  exists. The dialog's resolution chips need exactly that (its "Clip" choice
  must be selectable — and win — even when a project spec is set). Added the
  two `Option<u32>` params plus a small pure `resolve_export_resolution`
  helper (`chroma/export.rs`) encoding the precedence explicit-arg > project
  spec > `None` (`export_video`'s own clip-derived fallback) — 4 unit tests
  (explicit wins, falls back to project, falls back to clip-derived when
  neither set, a partial/zero explicit pair is treated as absent, matching
  `ExportOpts`'s own `(Some(w), Some(h)) if w>0 && h>0` guard elsewhere in
  the same file). No change to `export_video`/`bake_primary_lut` themselves,
  no new Tauri command, no new progress mechanism — this is the one
  "minimal, safe addition" the brief allowed for, not new export logic.
- **`ExportPanel`/`Panel.Export` stays routed — a real reason, not
  inertia.** The brief's default was "remove or fold in… unless there's a
  real reason to keep both." There is one: **they are not the same
  functionality.** `ExportDialog` exports the graded *video* (or a `.cube`
  of the primary grade); `ExportPanel` exports a *still image* — a RapidRAW
  feature this repo has never removed generally (unlike the DAM/library
  shell, D-043) and that a still-image project would still need. Fully
  unrouting `Panel.Export` (dropping it from `ALL_PANELS`/
  `DEFAULT_PANEL_DEFAULT_REGIONS`/the default workspace layout in
  `useUIStore.ts`) touches a keyboard shortcut (`useKeyboardShortcuts.ts`)
  and a context-menu action (`useAppContextMenus.ts`, two call sites) that
  are otherwise unrelated to this task and not verified safe to cut in this
  pass — real blast radius for a "purely UI/UX move + wiring" brief that
  explicitly scoped out reimplementing anything. Left it exactly as-is.
  **The pre-existing bug this surfaced — `ExportPanel` silently attempting
  a still-image export against a loaded video's path — is real and is
  logged separately as B-010,** not fixed here (out of scope: fixing it
  means either gating the panel on `!videoInfo?.isVideo` or teaching
  `export_images_impl` about video paths, both real changes this task's
  brief didn't ask for). Practically: now that a working, prominent Export
  button exists, a user has little reason to ever reach the broken one, but
  the dead path itself remains until B-010 is picked up.
- **Colorist-first, per the roadmap.** No Edit-tab timeline export in this
  pass (deferred, unchanged from before); `ExportDialog` reads the
  Colorist-only `useChromaStore.videoInfo`, disabled (button greyed,
  tooltipped "Load a clip to export") when nothing is loaded.
- **Consequences / footprint.** New: `app/src/components/chroma/
  ExportDialog.tsx`. Edited: `app/src-tauri/src/chroma/export.rs`
  (`out_width`/`out_height` params + `resolve_export_resolution` + 4 tests +
  header comment), `app/src/components/panel/editor/EditorToolbar.tsx`
  (+import, +one button in the existing top-right group). No other file
  touched — `Panel.Export`/`ExportPanel.tsx`/`useUIStore.ts`/
  `useKeyboardShortcuts.ts`/`useAppContextMenus.ts` are all unchanged.
- **Verified (2026-09-03).** `cargo test --no-default-features -p RapidRAW
  chroma::` — **87/87** (+4, the new `resolve_export_resolution` tests);
  `cargo clippy --no-default-features -p RapidRAW --no-deps` clean on
  `export.rs`. `cargo fmt --check` on `export.rs`: pre-existing drift (80
  diff hunks against the file *before* this change too, confirmed by
  stashing it and re-checking — the D-034/`mask_generation.rs` precedent,
  left alone per CLAUDE.md) plus 2 more from my own additions, isolated with
  a standalone `rustfmt --edition 2024 --check` on just the new code and
  fixed (one test's `assert_eq!` needed multi-lining) — my new code is
  fmt-clean. `cd app && npx tsc --noEmit`: **64** errors both before and
  after this change (confirmed by stashing the TS changes and re-running,
  not just trusting the brief's number) — this worktree's real baseline
  matched the brief exactly, and the error sets are byte-identical
  (`diff` of the two runs is empty), zero new errors anywhere, none in
  `ExportDialog.tsx`/`EditorToolbar.tsx`.
  **Live app, real backend, real file — the honest scope of what this
  covers:** booted `npm run tauri:dev` from this worktree, confirmed the
  control server (D-020, port 19788) responds, opened the real
  `~/Movies/Chroma/New.chroma` project (a genuine 4K/50fps h264 clip) over
  that bridge. This sandbox has no screen-recording/accessibility access to
  the WKWebView (the standing constraint every agent hit tonight), so the
  dialog's own on-screen rendering and click-through were **not** directly
  observed — `tsc` finding zero type errors in the new component is the
  evidence for the wiring being well-typed, not a substitute for seeing it
  rendered. What *was* driven for real, end to end, over the control
  server — the identical `chroma_export_video`/`chroma_export_progress`/
  `chroma_bake_lut` calls `ExportDialog` itself makes, not a simulation of
  them: a 16-frame H.264 export (`{kind:"h264", from:0, to:15}`) returned
  `{started:true, out_path, from:0, to:15, total:16}` immediately, then
  `chroma_export_progress` polled every ~1-2s showed `done` climb 1→16 with
  `running` flipping to `false` and `error:null` on completion — real
  incremental progress, not a canned response. `ffprobe` on the resulting
  file confirmed a genuine H.264 MP4, 3840×2160, 50 fps, 16 frames — the
  clip's own native dimensions, i.e. the "no explicit override" default
  path (this run didn't exercise the dialog's new `out_width`/`out_height`
  params, which only `ExportDialog` itself passes — those are covered
  instead by the 4 `resolve_export_resolution` unit tests plus the
  pre-existing `export_resolution_override` test proving `export_video`
  actually resizes when given explicit dims). A `.cube` bake
  (`{kind:"cube", size:17}`) produced a real 17³ `.cube` file with the
  correct "grade has 1 masked/local layer(s)…dropped the masks" warning
  for the project's one existing mask. Temp output files removed, dev app
  and ports (1420, 19788) killed after.

## D-050 — Editor timeline audio playback: `symphonia`→`rubato`→`dasp_sample`→`cpal`, a dedicated Rust audio thread that starts in lockstep with the video playhead rather than being driven by it
**decided (2026-09-03) · built (2026-09-03)**

- **Context.** Roadmap "Next" item 1 (owner caught live, 2026-09-02): the Edit
  tab's preview (`PreviewPane.tsx` + `chroma_timeline_frame`, D-041) is a
  decode→JPEG-per-frame path with **zero audio** — silent and muted look
  identical. `docs/notes/architecture-lock.md` (D-039) already names the
  intended stack: `symphonia` + `cpal` + `rubato` + `dasp`. Studied first:
  `chroma-timeline`'s `Track`/`TrackKind` (confirmed `TrackKind::Audio`
  already exists as a variant, D-041 — nothing populates or reads one yet),
  `edit.rs` (the video-preview command surface), `decode_pipe.rs` (the
  closest precedent for a persistent decode-and-serve loop, though it's a
  request/response pull model, not a push/streaming one — see below), and
  `PreviewPane.tsx`'s wall-clock `requestAnimationFrame` play loop (the thing
  audio has to stay in step with).

- **No separate audio `Track` populated this pass.** `TrackKind::Audio`
  exists in `chroma-timeline` but nothing writes one. This MVP's one video
  track's clips already point at the same source files the frame decode
  reads — for a talking-head/screen-capture shot that source already carries
  the embedded audio stream, so audio playback reuses the *exact same*
  `clip_at` resolution the video preview uses (factored out as
  `edit::resolve_video_position`, shared by both `chroma_timeline_frame` and
  the new `chroma_audio_play`) rather than requiring a parallel audio-track
  population step that would immediately need to be kept in sync with the
  video track until real multi-track lands (a separate, later roadmap item —
  a genuine, *separate* audio track only earns its keep once there's
  something audio-only to put on it, e.g. a detached clip or a music bed).

- **The sync-model decision — the one that actually matters here.** Two
  designs, per the brief:
  - **(A) poll-and-fill keyed off the displayed frame**, the same
    request/response shape `decode_pipe.rs` uses for video (`chroma_timeline_
    frame(pos)` → one JPEG). **Rejected.** `cpal`'s output callback needs
    samples at device-buffer granularity (single-digit ms) — far finer and
    completely untied to the 60fps `rAF`/per-frame-IPC cadence the video side
    runs on. Driving audio from that would either starve the callback
    (audible underrun) or need an IPC rate the JPEG-per-frame channel was
    never built for.
  - **(B) a persistent streaming audio thread with its own buffer.**
    **Chosen.** `chroma_audio_play(start_frame)` spawns a dedicated OS thread
    that owns the whole pipeline — `symphonia` decode → `rubato`
    resample → channel-adapt → `dasp_sample` format-convert → a bounded
    ring buffer a `cpal` output stream drains — for its entire lifetime,
    free-running against the **audio device's own hardware clock**, not the
    frontend's `rAF` tick.

  Having picked (B), the real design question was how the two clocks
  (video's `performance.now()`-paced `rAF` loop, audio's device-clock-paced
  `cpal` callback) actually **stay** in sync once both are running, not just
  how audio decodes. The most robust answer — the audio thread exposes its
  live playback position, and the video `rAF` loop polls and snaps to it
  every tick — was **not** built: it needs a new polling round-trip that
  doesn't exist on the video side today, to correct a drift this tool's
  actual use pattern (a preview/scrub session, not hours of unbroken
  transport) won't accumulate enough of to notice. **What was built
  instead:** both sides start from the *same* `playhead` frame at the *same*
  "begin playing" moment — the video loop already re-baselines its
  `performance.now()` start time on every Play toggle (unchanged), and
  `PreviewPane.tsx`'s new effect fires `chroma_audio_play(playhead)` /
  `chroma_audio_stop()` at that exact same `playing` transition — and then
  the two run **open-loop** against real wall-clock time independently.
  Accurate to within one IPC round-trip's start latency (single-digit ms)
  plus whatever the two clocks drift from each other over a session — device-
  clock-vs-OS-wall-clock drift is tens of ppm, imperceptible at preview-
  session lengths. **Known, deliberate limitation, written down rather than
  hidden:** no drift correction over a very long continuous play session, and
  no audio re-seek mid-play (not needed — the video loop always restarts its
  wall-clock baseline fresh on every Play toggle, so `chroma_audio_play` only
  ever needs to fire at that same transition, never independently mid-flight).
  `chroma_audio_play` therefore doubles as "seek and play" — there is no
  separate seek-while-playing command.

- **The ring buffer is a plain `Mutex<VecDeque<f32>>`, not a lock-free SPSC
  ring (e.g. the `ringbuf` crate).** Deliberate MVP simplification: the
  `cpal` callback only holds the lock for a fast pop loop; all real work
  (decode, resample, format-convert) happens on the audio thread *outside*
  the lock, so the callback's hold time stays short by construction. Written
  down as the first thing to revisit if audio glitching is ever observed —
  not preemptively added because there's nothing yet to observe it against.

- **`cpal::Stream` is never moved across threads or stored in the shared
  session state**, sidestepping whether it's `Send` (backend-dependent —
  CoreAudio's does resolve to `Send` via its `Monitor: Send + Sync`
  supertrait bound, checked in the vendored source, but relying on that
  wasn't necessary). It's a local variable inside the one function
  (`audio::run_session`) that runs start-to-finish on the dedicated thread
  `chroma_audio_play` spawns; a `generation: u64` counter in a small
  `Mutex`-guarded session struct (mirrors `decode_pipe.rs`'s `PIPE` /
  `state.rs`'s `THUMB_CACHE` module-global pattern) is the only cross-thread
  signal — `chroma_audio_stop`/a re-`chroma_audio_play` bumps it, the audio
  thread notices at its next packet/backpressure check and returns, dropping
  the stream on its own thread.

- **Resampling: `rubato` pinned at `0.15`, not the newer `5.0.0` cargo
  resolved by default.** Evaluated both — 5.0.0's `Async`/`FixedAsync`/
  `Indexing`/`audioadapter`-buffer API is real and more capable, but is a
  substantially heavier integration surface than 0.15's plain
  `Vec<Vec<f32>>`-per-channel `SincFixedIn::process()` for the exact same
  fundamental shape of work (chunked resampling) this MVP needs. 0.15 is
  still an actively-used, well-documented version of the crate D-039 already
  named. Fast-pathed: source rate == device rate (the common case — most
  captured footage and most output devices already agree on 44.1/48 kHz)
  skips `rubato` entirely rather than paying its chunking machinery for
  nothing. **Known gap:** `RateConverter` never flushes the final <1-chunk
  (≤ ~21 ms at the settings used) tail of a resampled clip's audio through
  `process_partial` — the last fraction of a second can be silently dropped.
  Cheap to fix later; not done this pass to keep the decode-loop shutdown
  path simple, and inaudible in practice at that length.

- **`dasp_sample` used directly for the `f32`→device-`SampleFormat` bit-depth
  conversion** (`T::from_sample` in `audio::build_typed<T>`), not only
  transitively through `cpal` (which happens to re-export the identical
  `dasp_sample::{Sample, FromSample}` types as `cpal::{Sample, FromSample}` —
  confirmed by reading `cpal`'s vendored source). Imported and named
  explicitly so the dependency is doing visibly real, distinct work (format
  conversion) separate from `rubato`'s (rate conversion), matching the split
  the brief asked for.

- **Probing "does this clip have audio" stays `ffprobe`, not a throwaway
  `symphonia` session.** `video::VideoInfo` gained `has_audio` /
  `audio_sample_rate` / `audio_channels`, filled by one extra small
  `ffprobe -select_streams a:0` call inside the existing `probe()` (cached
  one layer up by `edit::probe_cached`, so it's paid once per clip, not once
  per frame) — `symphonia` is reserved for the real decode at play time.
  **Found live while wiring up verification:** the actual open project's
  (`~/Movies/Chroma/New.chroma`) one real shot,
  `~/Downloads/pexels_28808272.mp4`, has **no audio stream at all**
  (confirmed via `ffprobe`) — so on that project, playback is *correctly*
  silent, not proof of a working pipeline. `A001_08302215_C019.MOV`
  (HEVC + AAC 48 kHz/2ch, already this repo's `CHROMA_TEST_VIDEO` fixture for
  the decode-pipe tests) is the file actually used to verify real audio
  end-to-end — see the verification note below.

- **Verified.** `cargo test -p RapidRAW chroma::` (no env vars — the default,
  CI-equivalent run): **95/95 passed, 0 failed.** New pure-logic unit tests in
  `chroma::audio` (channel adaptation mono↔stereo/passthrough, ring-buffer
  pull-or-silence exact/underrun/empty, the resample frame-count arithmetic,
  generation-bump invalidation) plus a new
  `video::probe_detects_a_real_audio_stream` (env-var gated on
  `CHROMA_TEST_AUDIO_VIDEO`, mirroring the existing `CHROMA_TEST_VIDEO`
  pattern) and an extended `probe_and_decode_real_file` assertion (`has_audio`
  must agree with `sample_rate > 0 && channels > 0`).
  `tsc --noEmit`: baseline in this worktree is **64** pre-existing errors,
  none touching `PreviewPane.tsx` or anything new — confirmed before and
  after, zero new regressions.

  **The concrete non-silent-PCM proxy** (a sandboxed agent can't literally
  listen, per the brief): two more integration tests, gated on
  `CHROMA_TEST_AUDIO_VIDEO` / `CHROMA_TEST_SILENT_VIDEO`, that build a
  throwaway `.chroma` project on disk and call the real
  `chroma_audio_play`/`chroma_audio_level`/`chroma_audio_stop` commands
  exactly as `PreviewPane.tsx` does (no Tauri runtime needed — none of these
  commands take a `tauri::State`). Run against real files found on this
  machine (`ffprobe`-verified first, since the brief specifically flagged not
  to assume): `CHROMA_TEST_AUDIO_VIDEO=~/Downloads/A001_08302215_C019.MOV`
  (HEVC + AAC 48 kHz/2ch — already this repo's `CHROMA_TEST_VIDEO` fixture for
  the decode-pipe tests) played for 1.5s and logged **rms=0.0013 peak=0.0080**
  — genuinely non-silent PCM, decoded from a real AAC stream and written by a
  real, live `cpal` output stream on this machine.
  `CHROMA_TEST_SILENT_VIDEO=~/Downloads/pexels_28808272.mp4` — this repo's own
  real `New.chroma` project's actual shot, confirmed via `ffprobe` to have no
  audio stream at all — played back with `(rms, peak) == (0.0, 0.0)` and no
  error, pinning "silent is correct for this clip, not a bug."

  **Booted the real app for real:** `cd
  ~/my_projects/chroma-worktrees/editor-audio && npm run tauri:dev` (port
  1420 free, no conflict with the concurrent export-window agent) — a clean
  build (43s link) and launch, `app.log` shows normal startup (logger init,
  sidecar detected) and no errors, confirming the new deps (`symphonia`/
  `rubato`/`dasp_sample`/`cpal`, the latter linking CoreAudio on macOS) don't
  break the build or crash on launch. **Honest gap:** did not click Play on a
  project through the actual running UI — tried both `screencapture` (macOS
  refused: no Screen Recording permission in this sandbox) and
  `osascript`/System Events accessibility scripting (the window enumerated
  as empty — no Accessibility permission either), so, unlike B-004's fix
  verification in an earlier session (which had access to one or both),
  neither path was available here to drive or observe the window directly.
  The equivalent proof is the `chroma_audio_play`/`_level`/`_stop`
  integration tests above, which call the exact same command surface
  `PreviewPane.tsx` does, plus `tsc` finding zero new errors in that file.
  The `chroma audio: rms=… peak=…` log line (throttled to ~1/s of playback)
  is there for whoever next drives the UI directly to cross-check against
  what they hear. App process killed after.

  **Found live while wiring up verification, logged, not fixed (out of
  scope):** `docs/BUGS.md` B-011 — a pre-existing test-isolation gap
  (`chroma::export`'s real-file-gated tests leave `state::SESSION`'s "loaded
  video" set, which a later `chroma::relight` test wrongly assumes is unset)
  that only surfaces when `CHROMA_TEST_VIDEO` is set — reproduced with zero
  D-050 code involved, confirmed unrelated to this change.

---

## D-051 — Mature timeline UI: scoped against `react-timeline-editor`'s actual API first (edge-trim/snapping were already native); custom scroll-zoom, ripple-flash, and a Rust-computed waveform on top

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** Roadmap "Next" item 2 (owner caught live, 2026-09-02, comparing
  directly against Palmier/Premiere-class editors): the Editor tab's
  `@xzdarcy/react-timeline-editor` v1.0.0 embed (`TimelinePane.tsx`, D-041)
  was missing table-stakes NLE interaction — scroll-wheel zoom, a live
  edge-drag trim, and the general visual language (waveforms, snapping,
  ripple feedback, per-track identity) mature editors share. The brief was
  explicit: scope this against the library's real installed API before
  writing custom interaction code, and don't build multi-track visual
  polish the data model can't back yet.

- **Library-vs-custom scoping — read `node_modules/@xzdarcy/react-timeline-
  editor@1.0.0`'s actual `.d.ts` and bundled source (`dist/index.es.js`),
  not just its README, before writing anything:**
  - **Edge-trim was already fully native and already wired — zero new code.**
    Every action already had `flexible: true` (D-041); the library renders
    `.action-left-stretch`/`.action-right-stretch` 10px handles per clip and
    hands them to `interact.js`'s `resizable({ edges })`, which supplies its
    own hover cursor (`ew-resize`) automatically — no custom CSS or JS
    needed for the cursor. `TimelinePane.tsx`'s `onActionResizeEnd` was
    already wired to `trim_start`/`trim_end`. This pass only *verified* it
    (reading the source confirmed the mechanism; see Verification) rather
    than building a trim interaction from scratch.
  - **Snapping was already fully native — zero new code.** `dragLine: true`
    (already set) turns on the library's built-in `defaultGetAssistPosition`
    assist: every other action's start/end edges *and* the playhead
    (`cursorLeft`, unless `hideCursor`) are collected as snap targets for
    both move and resize drags, with its own `adsorptionDistance`. This is
    exactly "snapping to adjacent clip edges, the playhead, etc." from the
    brief — already there, unused only because nobody had checked.
  - **Scroll-wheel zoom is custom.** The library has no `wheel` handling
    anywhere in its source — confirmed by grep, not assumption. Added: a
    `scaleWidth` state (was a hardcoded constant) driven by a **native**
    (non-React) `wheel` listener on the edit-area wrapper via `useEffect` +
    `addEventListener(..., { passive: false })`, not React's `onWheel` —
    React attaches wheel listeners passively by default, which silently
    drops `preventDefault()` and lets the page scroll under the zoom.
    Toolbar zoom in/out buttons + a live `%` readout drive the same state,
    since a wheel-only affordance isn't discoverable and every comparable
    editor also exposes a toolbar control.
  - **The waveform is custom** (the roadmap item's own prediction — "likely
    true, that's almost always app-specific"). The library's
    `getActionRender` is a plain content slot with no audio awareness.
  - **Ripple visual feedback is custom.** Nothing in the library's model
    distinguishes "this clip moved because I dragged it" from "this clip
    moved because an upstream edit rippled it."

- **Waveform: computed once in Rust, drawn as a plain canvas — no new
  dependency.** New `chroma_audio_waveform(source_path, start_secs,
  duration_secs, buckets) -> Vec<(f32, f32)>` in `chroma::audio` (the module
  D-050 already put `symphonia` in): a one-shot batch decode of just the
  requested range (seek + decode, no `rubato`/`cpal`/ring-buffer — a static
  peak read doesn't need device-rate output or a live session), mixed to
  mono, reduced to `buckets` (min, max) pairs by `peaks_from_samples` (pure,
  unit-tested: exact bucket-boundary coverage, empty/zero-bucket guards,
  more-buckets-than-samples). Returns an empty `Vec` — not an error — for a
  source with no audio stream (checked via `chroma::edit::probe_cached`,
  widened from private to `pub(crate)` to reuse the same has-audio cache
  `chroma_timeline_frame`/`chroma_audio_play` already share, rather than a
  second `ffprobe` spawn) — the same "nothing to draw, not a failure"
  contract `chroma_timeline_frame`'s blank-frame return already uses, so a
  silent clip's waveform request isn't treated as an error in the frontend.
  `Waveform.tsx` (new, `@chroma/editor`) requests roughly one bucket per 2px
  of the clip's on-screen width, module-level-caches the promise per
  (source path, range, bucket count) so re-renders don't refetch, and draws
  min/max bars on a `<canvas>` sized to the clip — reading `--color-text-
  primary` through the canvas element's own computed `color` (inherited from
  its `className="text-text-primary"`) rather than a magic literal, so it
  stays theme-consistent for free. **Deliberately not extracted into a
  shared decode helper with `run_session`** (D-050's live playback
  pipeline) despite ~20 overlapping lines (open → probe → find audio track →
  make decoder → seek): the two diverge immediately after that point (one
  streams indefinitely through `rubato` into a live `cpal` callback; this
  one collects a bounded `Vec` and returns), and factoring the shared prefix
  out would mean threading boxed `FormatReader`/`Decoder` trait objects back
  into `run_session`'s already-verified (D-050) path for a small dedup —
  judged not worth touching tested, working code for this pass. Documented
  as the deliberate tradeoff, not silently duplicated.

- **Ripple visual feedback: diff clip start-frames by id, not a Rust
  "ripple" event.** `chroma-timeline`'s model has no gaps (D-041 — clips are
  always back to back), so any trim/remove/reorder that changes a clip's
  duration or position necessarily shifts every downstream clip's start
  frame; there is no explicit "these clips rippled" signal to consume,
  Rust-side or otherwise. `TimelinePane.tsx` instead snapshots `{clip id →
  timeline start frame}` on every `track` change and diffs it against the
  previous snapshot; any id present in both snapshots with a different start
  frame gets a brief (550ms) Tailwind `animate-pulse` + accent ring in
  `getActionRender`, then clears via `setTimeout`. A clip that's simply new
  (`add_clip`, or `split`'s right-hand half) is correctly excluded — its id
  has no previous entry, so it's "new," not "shifted." No custom CSS
  keyframes needed (Tailwind's built-in `animate-pulse`); no `transition` on
  the action's own `left`/`width` (that's React state interact.js updates on
  every drag-move tick — a CSS transition there would make live dragging
  visibly lag behind the mouse).

- **Per-track colour coding: deliberately not built.** Checked first, per
  the brief: the Editor timeline is still genuinely single-video-track in
  practice (D-041/D-045 — `Timeline.tracks` is technically a `Vec` but
  nothing in this codebase ever produces a second track). Building an
  N-track colour palette now would be UI for tracks that cannot exist yet.
  What *was* added: a small "Video 1" label pinned top-left of the edit
  area, naming the one real track truthfully rather than pretending there's
  a multi-track system underneath. Real per-track visual polish is gated on
  a future multi-track-*authoring* feature (a separate, bigger roadmap item)
  — not on this UI pass.

- **Verification.**
  - `cargo test -p RapidRAW --lib chroma::` — **107/107 passed** (was 95 at
    D-050; +12: 5 pure `peaks_from_samples` tests — min/max-per-bucket,
    empty/zero-bucket guards, exact sample-coverage across an uneven bucket
    split, more-buckets-than-samples, single-sample bucket — plus the
    duration/bucket-count guard test that touches no disk). With
    `CHROMA_TEST_AUDIO_VIDEO=~/Downloads/A001_08302215_C019.MOV` (D-050's own
    real-audio fixture, HEVC+AAC 48kHz/2ch) and
    `CHROMA_TEST_SILENT_VIDEO=~/Downloads/pexels_28808272.mp4` (this repo's
    real project's actual shot, confirmed no audio stream) also set: **+2
    more, 109/109** — `chroma_audio_waveform_returns_nonflat_peaks_for_a_real_file`
    decodes 2s of the real fixture and asserts genuinely non-flat peaks
    (not a mock), `chroma_audio_waveform_on_a_silent_source_is_an_empty_ok`
    confirms the no-audio-stream path returns `Ok(vec![])`. Real symphonia
    decode, real file, real assertion — not just "it compiles."
  - `cargo fmt --edition 2024 --check` clean on the three touched files
    (`chroma/audio.rs`, `chroma/edit.rs`; `lib.rs`'s one-line
    `generate_handler!` addition wasn't run through `rustfmt` directly — per
    D-045's documented gotcha, invoking `rustfmt`/`cargo fmt` on `lib.rs`
    itself recursively reformats every `mod`-reachable file in the crate).
    `cargo clippy -p RapidRAW --lib` — zero warnings on `chroma/audio.rs` or
    `chroma/edit.rs`; the one pre-existing warning nearby
    (`chroma/mod.rs:22`, a doc-list indent nit) is in a file this pass never
    touched.
  - `tsc --noEmit` in `app/`: **64 errors, unchanged baseline** (confirmed
    byte-for-byte against the pre-change run), **zero** in `packages/editor`
    (the only package touched) or in the new `Waveform.tsx`. (A same-named,
    unrelated pre-existing `app/src/components/panel/editor/Waveform.tsx` —
    RapidRAW's own histogram/scope waveform — already carried one of the 64
    baseline errors; not this file, not touched by this pass.)
  - **Booted the real app for real**, `~/Movies/Chroma/New.chroma` open:
    port 1420 was held by a concurrent agent's own dev session (same
    OS-level single-instance situation D-050 hit), so this run used a
    temporary port override, 1427, in both `vite.config.mjs` and
    `tauri.conf.json`'s `devUrl`, for the verification session only,
    reverted before commit (confirmed via `git diff --stat` showing no
    change to either file post-revert). Vite served 200 on `/`; the native
    `RapidRAW` process launched and stayed up (confirmed via `ps`, matching
    the spawned PID) with no panic and no new error in either the dev-server
    stdout or the app's own log file beyond a pre-existing, unrelated
    "Frontend failed to report ready within timeout" race (present under
    this session's heavy concurrent-agent CPU load, not something this
    change's code path touches). Requested `TimelinePane.tsx` and
    `Waveform.tsx` directly from Vite's dev server (`/@fs/...`) and got back
    correctly-transformed JS (React `jsxDEV` calls, resolved imports) rather
    than a 500/error overlay — confirms both files parse and their import
    graph resolves under the real bundler, not just under `tsc`.
  - **Honest gap, same as D-050's:** did not visually confirm the zoom
    slider, the waveform's pixels, the edge-trim cursor, or the ripple flash
    inside the actual running window. Tried both `screencapture` (macOS
    refused: no Screen Recording permission in this sandbox) and
    `osascript`/System Events accessibility scripting (every process,
    including Finder, enumerated zero windows — no Accessibility permission
    either, not an app-specific problem). Real project
    (`~/Movies/Chroma/New.chroma`) has exactly one shot and it has no audio
    stream (D-050's own finding), so even a working screen-capture path
    would have shown an empty (correctly empty) waveform on that specific
    project, not proof the drawing code handles real peaks — the
    `chroma_audio_waveform_returns_nonflat_peaks_for_a_real_file` test is
    the real-peaks proof instead, calling the exact command
    `Waveform.tsx`'s `invoke()` calls. Edge-trim and snapping being native
    library behavior (confirmed by reading `interact.js`'s `resizable()`
    wiring and `defaultGetAssistPosition` in the library's own bundled
    source) is a stronger form of confidence than a single manual drag would
    have been, but is still "read the mechanism," not "felt the mouse
    drag" — noted plainly rather than claimed as full interactive
    verification.

- **Consequences / deferred.** Multi-track visual polish (per-track colour,
  height-by-kind) stays deferred until a real second track can exist. Zoom
  is not cursor-anchored (it rescales around the current scroll position,
  not the mouse position) — a nice-to-have, not attempted this pass.
  `rubato`'s known end-of-clip tail-flush gap (D-050) doesn't apply here
  (the waveform path never uses `rubato`). No waveform result caching on the
  Rust side (only the frontend module-level `Map` caches) — acceptable at
  this scale (a handful of clips, decode is fast) but the first thing to
  revisit if a long timeline with many clips makes waveform requests feel
  slow.

## D-052 — Global undo/redo: a new `@chroma/history` package (generic stack, not `@chroma/bridge`), snapshot-based bridges for both existing edit surfaces, shell-owned Cmd/Ctrl+Z that switches tabs
**decided (2026-09-03) · built (2026-09-03)**

- **Context.** Roadmap "Next" item 4. Cmd/Ctrl-Z worked only while Colorist
  was the active tab, only for grade adjustments (`useEditorStore`'s existing
  50-deep history, undo/redo already wired in `useKeyboardShortcuts.ts`). The
  Edit tab's timeline ops (reorder/trim/split/remove/add_clip, D-041/D-046,
  `useEditorTimelineStore.applyOp`) had no undo at all. No shell-level
  keybinding spanned tabs. Studied first: `useEditorStore`'s actual
  `pushHistory`/`undo`/`redo`/`goToHistoryIndex`/`resetHistory` (D-032's
  `AgentActivityDock.tsx` `undoEntry` already had to solve "restore a past
  grade snapshot reliably," including the documented 50-slot-eviction
  fallback — reused rather than re-derived), `applyOp`'s always-clone
  edit-op model in `timeline.ts`, and D-032's `08-decisions.md` entry for
  what the agent-activity feed already displays/logs.

- **Package: `@chroma/history`, not folded into `@chroma/bridge`.** `@chroma/
  bridge`'s own README states its boundary explicitly: "typed Tauri command
  bindings + the zustand stores + the control-bridge hook" — the
  frontend↔backend seam. The shared undo stack has zero Tauri surface and no
  backend seam; it's pure frontend state (`{id, tab, label, undo(), redo(),
  ts}`, two stacks, push/undo/redo/cap) depended on by `@chroma/shell` (which
  explicitly must *not* depend on `@chroma/bridge` or the colorist app — see
  `store.ts`'s own header comment) and by tab packages. A new leaf package,
  same layer as `@chroma/ui`, was the shape that didn't force a boundary
  violation in either direction. Full reasoning in `packages/history/README.md`.

- **Colorist bridge: an adapter that *observes* `useEditorStore`, doesn't
  touch it.** `app/src/hooks/useColoristHistoryBridge.ts` subscribes
  (`useEditorStore.subscribe((state, prevState) => …)`, same pattern as the
  existing `useProjectAutosave.ts`) and distinguishes a genuine new edit
  ("push") from mere navigation (undo/redo/`goToHistoryIndex` — same
  `history` array reference) or a fresh-image reset (`resetHistory` — new
  array, but always length 1) purely from `history`'s reference identity and
  length; zustand's `prevState` gives the pre-push state directly, no manual
  index bookkeeping needed. Every genuine push registers one `{tab:
  'colorist', ...}` entry whose `undo()`/`redo()` call a **new shared
  helper**, `app/src/utils/editorHistorySnapshot.ts`'s
  `restoreEditorHistorySnapshot(targetIndex, snapshot)` — extracted verbatim
  from `AgentActivityDock.tsx`'s `undoEntry` (D-032) rather than
  reimplemented, so both the agent-activity feed's jump-to-here undo and this
  bridge share one "fast-path history-index jump, fall back to a snapshot
  restore-as-new-forward-edit if the target scrolled off the 50-slot stack"
  implementation instead of two that could drift. `useEditorStore`'s own
  internals are untouched — literally zero lines changed in that file.

- **Editor timeline: whole-`Timeline` snapshot pairs, not inverse deltas.**
  `useEditorTimelineStore.applyOp` already computes `before`/`after` as two
  independent trees (`applyOpPure` clones rather than mutating) and already
  round-trips every op through a whole-document `chroma_timeline_set` +
  refetch — so restoring a snapshot *is* exactly what a normal edit already
  does, and a new `restoreSnapshot(timeline)` action (cancel any pending
  debounced save, set state, persist + refetch **immediately**, no debounce —
  undo/redo are discrete actions) is all `undo()`/`redo()` need. Inverse
  per-op deltas (e.g. "reorder" undoes with the opposite "reorder") were
  rejected: they'd need a hand-maintained inverse for every `EditOp` variant,
  duplicate logic `applyOpPure` already has, and buy nothing — the snapshots
  are already sitting right there in the closure. `labelForOp` (`timeline.ts`,
  pure, unit-tested) turns the op into the entry's human label ("Trim
  \"B-roll 1\" (start)").

- **The cross-tab UX decision — undo *switches the active tab*, it does not
  apply silently in the background.** Three options: (a) apply the
  undone/redone entry's effect wherever its tab lives, leaving the visible
  tab untouched; (b) switch the active tab to whichever tab owns the popped
  entry, so the user sees the result; (c) refuse cross-tab undo entirely
  (only ever undo within the active tab). **(b), chosen.** (a) is silently
  confusing — if you're on Colorist and Cmd+Z pops an Edit-tab timeline
  entry, nothing visibly changes and the user has no idea their keypress did
  anything, or worse, thinks the undo failed and presses it again. (c) fails
  the brief outright ("regardless of which tab is currently active") and
  would need its own extra state (a separate "what's undoable *here*"
  cursor) to even implement well. (b) costs one `setActiveTab` call — the
  shell already owns tab-switching (Cmd/Ctrl+1/2/3) — and guarantees the user
  always sees the effect of the keypress they just made, which matches how a
  single global undo stack reads in any app that has one (e.g. a multi-
  document editor: Cmd+Z always shows you what got undone, switching
  documents if it must). Implemented entirely in `Shell.tsx`'s new keydown
  effect (parallel to the existing Cmd/Ctrl+1/2/3 one): pop
  `@chroma/history`, then `setActiveTab(entry.tab)` if that tab isn't already
  active. `@chroma/history` itself stays tab-switching-agnostic (plain
  `string` for `entry.tab`, no `ShellTabId` import) — the shell is the one
  place that knows what a "tab" means.

- **Redo keybind: Ctrl+Y kept as primary (matching this codebase's existing
  default, `keyboardUtils.ts`'s `KEYBIND_DEFINITIONS`), Cmd/Ctrl+Shift+Z also
  accepted.** The brief said "check what convention this codebase already
  uses, match it" — the Colorist-only redo default was already `ctrl+KeyY`
  (i.e. Cmd+Y on macOS, not the more common macOS-native Cmd+Shift+Z), so
  that stays primary for continuity. Cmd/Ctrl+Shift+Z is *additionally*
  accepted (own judgement call) because it's the platform convention on
  macOS and a second key combo mapping to the same action costs nothing and
  removes a point of friction for anyone who reaches for it out of habit.

- **Single source of truth: the Colorist tab's own local Cmd/Ctrl+Z handler
  was removed, not left running alongside the shell's.** Two `window`
  keydown listeners both matching the same combo would double-undo one
  history step per press whenever Colorist is the active tab. The `undo`/
  `redo` entries in `useKeyboardShortcuts.ts`'s `actions` map were deleted
  (comment left explaining why); `KEYBIND_DEFINITIONS` keeps the `undo`/
  `redo` entries for the keybinds settings display, still accurate since the
  shell uses the same default combo — `comboMap` resolving an action with no
  handler is an existing, safe no-op path in `handleKeyDown`.

- **Known, deliberate gap: the Colorist toolbar's Undo/Redo buttons
  (`EditorToolbar`, wired in `Editor.tsx`) are NOT routed through
  `@chroma/history`.** They still call `useEditorStore`'s `undo()`/`redo()`
  directly, exactly as before this change. Out of scope for this pass — the
  brief asked for a shell-level *keybinding*, not rewiring every tab's
  existing local UI, and it's a real, separately-scoped follow-up (would need
  `Editor.tsx` to reach `@chroma/shell`'s `setActiveTab` too, for the same
  "always show the effect" reasoning as the keybinding, which is a bigger
  change than the toolbar button currently is). **Documented consequence:**
  clicking that button moves `useEditorStore.historyIndex` without touching
  `@chroma/history`'s stacks, so the shared stack's top can go stale relative
  to what's actually current in Colorist. This is harmless, not corrupting —
  every shared-history entry restores by snapshot (deep-equality-checked),
  never by relative delta, so a subsequent shell Cmd+Z always lands on a
  real, coherent prior state — just not always the state a user watching
  only the toolbar button would predict. Same flavor of honestly-documented
  edge case as D-032's own "middle-undo drops newer feed entries."

- **D-032 tie-in: explicitly out of scope this pass, not silently skipped.**
  The agent-activity feed is a *session log of agent-attributed MCP ops*
  (`op`/`args`/`result`/`diff`, `markUndoneFrom` semantics keyed to that
  attribution) — a different concern from this generic cross-tab,
  cross-actor (human or agent) undo stack. Folding shell-level undo/redo
  events into that feed would blur "who did this and why" with "what got
  undone." The two mechanisms are already compatible at the data layer
  without any feed change: both the feed's jump-to-here undo and the new
  Colorist bridge now call the *same* `restoreEditorHistorySnapshot` helper,
  operating on the same `useEditorStore.history`/`historyIndex`. **Known
  limitation, same shape as D-032's own:** undoing a Colorist entry via the
  shell doesn't retroactively mark any newer agent-feed entries `undone` —
  the feed's `undone` flag is feed-local bookkeeping this pass doesn't touch.
  Acceptable for the same "documented, not hidden" reason D-032 already
  established a precedent for.

- **Motion tab: excluded, explicitly.** The Motion tab (D-047) is a manifest
  editor + save/render, not an incremental edit-history surface in the sense
  Colorist's adjustments or the Editor's timeline ops are — there's no
  discrete "op" to snapshot around; the natural unit of "undo" there would be
  the manifest text editor's own native undo (already free, browser/editor-
  native) or a "restore the last saved manifest" action, neither of which fit
  this stack's shape. Not built this pass; a future pass could still register
  manifest-save snapshots as `{tab: 'motion', ...}` entries if that turns out
  to be wanted — the shared stack's generic shape doesn't preclude it.

- **In-memory only, no persistence across restarts** — explicit non-goal
  per the brief. `@chroma/history`'s two stacks live in a plain zustand
  store; nothing writes them to disk. Capped at 100 entries total (`MAX_
  HISTORY_ENTRIES`), a bit more generous than the Colorist's own 50 since
  this stack spans 3 tabs' worth of activity, not one image's grade knobs —
  picked, not derived from any hard constraint.

- **Verified.** `packages/history/src/store.test.ts` (vitest, 11 tests) —
  push/auto-id/redo-stack-clear-on-push/stack-cap-drops-oldest/undo-redo-
  calls-closures/cross-tab-LIFO-order/canUndo/canRedo/peek/clear, all real
  assertions on the pure store. `packages/editor/src/timeline.test.ts`
  (vitest, 5 tests) — `labelForOp` per `EditOp` kind plus the out-of-range
  fallback. `npm test` from the repo root (`--workspaces --if-present`) runs
  both — 16/16 passing. `tsc --noEmit` (app workspace): baseline in this
  worktree is **64** pre-existing errors both before and after this change —
  `diff`'d line-for-line identical, confirmed zero new errors, none in any
  touched or new file. `cargo test chroma::`: no Rust touched by this
  change (`restoreSnapshot` calls the pre-existing `chroma_timeline_set`
  command, no new command/behavior on the Rust side) — run anyway as a
  regression check: **99/99 passed, 0 failed** (no env-gated real-file tests
  set up in this pass, so the filtered-out counts are expected).

  **Honest gap: could not complete a live click-through of the running app.**
  `npm run tauri:dev` (port 1420 free) built and booted, but a first launch in
  this fresh worktree got silently swallowed by `tauri_plugin_single_instance`
  — this worktree's `tauri.conf.json` shares the exact same bundle identifier
  (`io.github.CyberTimon.RapidRAW`, unchanged since D-039/D-040, not yet
  worktree-scoped) as the concurrent `timeline-ui` agent's already-running
  instance, so the second launch handed off to the first and exited with no
  error logged. Worked around it correctly the first time — temporarily
  retargeted this worktree's `identifier` to
  `io.github.CyberTimon.RapidRAW.undoredoverify` in `tauri.conf.json` (same
  spirit as the brief's sanctioned temporary-port-override) and relaunched;
  only the final `RapidRAW` crate needed relinking (~10s, not the ~3.5 min
  full dependency rebuild) — but that relink hit **`error: … No space left on
  device (os error 28)`**: `df` showed `/System/Volumes/Data` at 100% capacity,
  308Mi free, with `~/my_projects/chroma/target` (21G) +
  `chroma-worktrees/timeline-ui/target` (7.4G) +
  this worktree's own `target` (5.9G) as the visible weight — a shared-disk
  resource-exhaustion problem from several concurrent worktrees each holding
  a full multi-GB Rust `target/`, not a defect in this change (no `B-NNN`
  filed — CLAUDE.md is explicit that "disk was full" is housekeeping, not a
  code bug). Reverted `tauri.conf.json` back to the real identifier
  immediately (`git checkout --`, confirmed clean) rather than leave a
  dangling verification-only diff, and did not attempt to free space by
  deleting another worktree's or the main checkout's `target/` — not this
  agent's call to make unilaterally against another agent's live build.
  **What this means concretely:** the Colorist bridge and the Editor
  timeline-op push/restore path are verified by code inspection, the reused
  D-032 `restoreEditorHistorySnapshot` primitive (already proven correct by
  the existing agent-feed undo it was extracted from), and a clean
  `cargo test`/`tsc` pass — but pressing Cmd+Z in a real running window and
  watching a real slider value or a real clip actually move back was **not**
  independently observed this session. Flagging for the orchestrating session
  to either re-run this one check once disk pressure clears, or accept the
  static verification as sufficient.

## D-053 — `chroma-types` step 2: `Resolution`/`Rational` made real (flatten-migrated, zero wire change), `ChromaError` left alone — most of `app/src-tauri`'s width/height fields are NOT the same concept as the placeholder
**decided (2026-09-03) · built (2026-09-03)**

- **Context.** D-039 migration step 1 (this crate's skeleton commit) left
  `Resolution`/`Rational`/`ChromaError` as one placeholder each, explicitly
  flagged "real extraction is a later, per-type, tracked step." This is that
  step — audit `app/src-tauri/src/chroma/*` for genuine duplicates of
  resolution/dimensions, frame-rate/rational, colour-space, time-range, and
  ad-hoc-error types; widen the real types to match what's actually needed;
  migrate call sites; delete the duplicates. `chroma-timeline`/
  `chroma-grade-model` explicitly out of scope.

- **Audit result — real find: `width`/`height` pairs, no real find for the
  rest.** Grepped every `pub struct`/`enum` in `app/src-tauri/src/chroma/*`
  (`commands.rs`, `export.rs`, `session.rs`, `project.rs`, `video.rs`,
  `state.rs`, `mask.rs`, `control.rs`, …) for the four target shapes:
  - **Resolution:** no *dedicated* `Resolution`/`Dimensions` struct existed
    anywhere — instead, `width: u32, height: u32` sibling-field pairs are
    scattered across `video::VideoInfo` (the one real probe result — ffprobe
    output, D-015) and every DTO derived from it (`commands.rs::
    VideoInfoDto`, `session.rs::ShotDto`, `project.rs::MediaVideoInfo`). All
    four use the *exact* field names `width`/`height` and are genuinely "the
    pixel dimensions of this clip/frame" — the same concept as the
    placeholder, just never factored out.
  - **Rational:** no struct pairs an fps numerator/denominator anywhere
    except `video::VideoInfo.fps_num`/`.fps_den` (plain sibling `u32`
    fields, not extracted into a labelled pair) — and no ad-hoc
    GCD/`simplify()`/reduction logic exists anywhere in the codebase to
    bring in. The one real behavioural need found: `export.rs` hand-built
    an ffmpeg `-r`/`-framerate` arg string with a bare
    `format!("{}/{}", info.fps_num, info.fps_den)` — exactly `Rational`'s
    natural `Display` form.
  - **ColorSpace:** genuinely absent by design, not by omission —
    `project.rs::ProjectSettings.color_space` is a free `String` and its own
    doc comment says so explicitly: *"stored and surfaced only... a real
    colour-managed pipeline... is D-004, not this."* Turning it into an enum
    now would be inventing a type ahead of the feature that needs it.
  - **TimeRange:** no struct anywhere in `app/src-tauri/src/chroma/*`
    represents a start/end time span as a labelled type (ranges are always
    two loose `u64`/`f64` args, e.g. `from_frame`/`to_frame`). The only real
    time-range-shaped code lives in `chroma-timeline` (already real per
    D-041/045/046, explicitly out of scope for this step) — noted below as a
    candidate for the *next* migration step, not touched here.
  - **Ad-hoc errors:** `app/src-tauri`'s Tauri commands uniformly return
    `Result<T, String>` or `anyhow::Result<T>` — the correct convention for
    that layer (Tauri IPC serializes errors as strings to the frontend;
    `anyhow` is the app-glue default). This is not a duplicate of
    `ChromaError` to migrate away, it's a different layer's appropriate
    convention (D-039's own dependency direction: `chroma-types` is what the
    *domain* crates below the app speak, not a mandate that the Tauri
    command surface itself adopt it). The one dedicated error enum found —
    `control.rs::BridgeErr` — has a single variant, `Timeout`, for one
    specific HTTP-bridge-dispatch failure; it doesn't map onto `Invalid`/
    `NotFound`/`Unsupported` without inventing a meaning that isn't there.
    Left alone.

- **The one case that looked right and wasn't: `ProjectSettings`.** This
  task's own brief cited "a `Resolution{width,height}` used for the D-038
  project output spec" as the paradigm same-concept case. On inspection,
  `project.rs::ProjectSettings.width`/`.height` are `Option<u32>` fields set
  **independently** — `merge_patch` lets a caller set `fps` without setting
  `width`/`height`, or set only one of the pair — because they back a
  partial-JSON-patch API (`chroma_project_set_settings`). `export.rs::
  ExportOpts.out_width`/`.out_height` (D-049) is the same shape for the same
  reason (`resolve_export_resolution` explicitly treats a partial pair as
  absent). Neither is representable as `Option<Resolution>` without either
  losing the "only one field patched" case or wrapping in something more
  awkward than the two-`Option<u32>` fields already are — this is exactly
  the "superficially similar, not the same concept" case the brief warned
  against forcing. **Left as-is**, not migrated.

- **What was migrated.** `chroma_types::Resolution` widened with a `Display`
  impl (`"{width}x{height}"`); `chroma_types::Rational` widened with a
  `Display` impl (`"{num}/{den}"`, the exact ffmpeg-arg form). Both keep
  their original field names/shapes — `Resolution`'s `width`/`height` were
  already what every real call site used, so adopting it via
  `#[serde(flatten)]` is a **zero-wire-change** migration: the JSON a DTO
  serializes to (Tauri IPC payload or persisted `project.json`, e.g.
  `project.rs::MediaVideoInfo`) is byte-identical before and after, verified
  by a round-trip test in `chroma-types/src/lib.rs`
  (`resolution_flatten_round_trips_with_bare_width_height_json`). Migrated:
  `video::VideoInfo` (the true source — every other struct below derives
  from it), `commands.rs::VideoInfoDto`, `session.rs::ShotDto`,
  `project.rs::MediaVideoInfo` + its `From<&video::VideoInfo>` impl, and
  every read call site across `commands.rs`, `decode_pipe.rs`, `edit.rs`,
  `export.rs`, `playback.rs`, `project.rs`, `state.rs` (test fixture) —
  `info.width`/`.height` → `info.resolution.width`/`.height`. `export.rs`'s
  ffmpeg fps-string `format!` replaced with `Rational::new(...).to_string()`.
  `ChromaError` unchanged this step (no real call site for it found in
  `app/src-tauri`; `chroma-motion`, D-046, remains its only real consumer).
  `app/src-tauri/Cargo.toml` gained a direct `chroma-types` path dependency
  (it previously only reached it transitively via `chroma-motion`/
  `chroma-timeline`).

- **Verification.** `cargo test -p chroma-types`: **4/4** (1 pre-existing +
  3 new — `resolution_display`, `rational_display_matches_ffmpeg_arg_form`,
  the flatten round-trip test). `cargo build`: clean across the whole
  workspace (`Finished dev profile ... in 4m 59s`, zero errors, only the
  same 6 pre-existing dead-code warnings in `ai_processing.rs` this change
  didn't touch). `cargo test --manifest-path app/src-tauri/Cargo.toml
  chroma::`: **107/107 passed**, same count D-051 last recorded — the exact
  zero-behavior-change signal a pure type-source migration should produce.
  `tsc --noEmit` in `app/`: **zero TS files touched by this change** (it's
  Rust-only, and every migrated DTO's JSON shape is unchanged by
  construction), so zero new errors, trivially. The pre-existing error count
  itself reads **32** in this fresh worktree (a clean `npm install` here,
  no prior `node_modules`), not the **64** D-051 last recorded on `main` —
  none of the 32 touch anything this change modified (`useAppNavigation.ts`,
  `useEditorActions.ts`, `useImageProcessing.ts`, `useUIStore.ts`,
  `MasksPanel.tsx`, i18n key typing, `framer-motion` `Variants` typing —
  all pre-existing, unrelated). Flagging the 32-vs-64 delta honestly rather
  than silently reconciling it: likely a resolved-dependency-version drift
  from installing fresh in this worktree vs. whatever `node_modules` state
  `main` had when D-051 recorded 64, not something this change caused or
  investigated further (out of scope for a Rust-only crate step). Booted the
  real app (`npm run tauri:dev`) to catch the "value's shape quietly
  changed" risk flagged in the brief — confirmed in `CHANGELOG.md`.

- **Follow-up for the next migration step (not touched here):**
  `chroma-timeline`'s `TimelineError` (`NoSuchTrack`/`NoSuchClip`/`BadIndex`/
  `EmptyClip`/`SplitOutsideClip`) is a real, domain-specific error enum that
  the *next* `chroma-types` pass may want to weigh against `ChromaError` —
  some variants (`NoSuchTrack`, `NoSuchClip`) could plausibly become
  `ChromaError::NotFound` cases, but `chroma-timeline` is explicitly out of
  scope for this step (own test suite, already-real crate per D-041/045/046)
  and wasn't touched.

---

## D-054 — Multi-track NLE Phase A: `Clip.start_frame` (not a `Gap` item) for explicit position, gap-aware edit ops, `add_track`/`remove_track`/`move_clip`, typed post-deserialize legacy-position backfill

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** `docs/notes/multi-track-nle.md` scoped the owner's "we need
  full multi-track editing" ask into phases; Phase A is the real current
  blocker underneath "just add more tracks" — `Clip` has no position field
  at all, so every track is forced back-to-back by construction
  (`Track::clip_at` walks the clip list summing durations; every edit op
  assumed this). This step fixes that and adds the ops needed to actually
  have more than one track. No rendering, no compositing, no frontend —
  those are Phases B/C/D.

- **Position model: an explicit `start_frame: i64` on `Clip`, timeline-
  absolute — not an OTIO-style `Gap` track item.** Both were real options
  (the module doc already calls this crate "OTIO-*shaped*", and real OTIO
  has `Gap`). Chose `start_frame` because:
  - **It matches what the UI layer already expects.** The Edit tab's
    `TimelinePane.tsx` is built on `@xzdarcy/react-timeline-editor` (D-041),
    whose action items are modeled by absolute `start`/`end` time, not by
    an interspersed gap placeholder. A `Gap` variant would mean either the
    frontend translates `TrackItem::Gap` into "nothing rendered between
    these two times" on every read, or `chroma-timeline` itself exposes a
    second, gap-stripped view for consumers — extra translation layer for
    no benefit this phase actually needs.
  - **Every op gets simpler, not more special-cased.** With `start_frame`,
    `split`'s old "sum durations before `clip_idx`" became a direct field
    read; `clip_at` became a direct range check instead of a cumulative
    walk. A `Gap` enum would need every op (`trim_end` growing into a gap,
    `remove` producing one, `split` never producing one, `reorder` not
    applicable to gaps at all) to pattern-match `TrackItem::Clip` vs.
    `::Gap` and merge/split adjacent gaps — meaningfully more code for a
    property (explicit gap *entities*, as opposed to gaps being simply
    "the space between two `start_frame`s") that nothing in this codebase's
    scope (Phase A, or B/C/D as scoped) asks for.
  - **Timeline-absolute, not track-relative:** a clip's position doesn't
    depend on which track it's on, so `move_clip` across tracks is a plain
    field write (`clip.start_frame = to_start_frame`), not a coordinate
    conversion. Every track shares one timeline clock, matching how
    `Timeline::duration()` (max over tracks) already worked.
  - Trade-off accepted: no explicit "this is deliberately empty space" audit
    trail — a gap is just wherever `clip_at` returns `None`. Fine for this
    phase; revisit only if a later phase needs to attach metadata to a gap
    itself (e.g. a placeholder clip), which nothing scoped does.

- **Per-op semantics, all now gap-aware, all with the no-overlap invariant
  ("clips on a track never overlap") maintained by construction rather than
  checked after the fact:**
  - **`clip_at`** — was a cumulative-duration walk; now a direct
    `start_frame <= f < start_frame+duration` scan. A query landing in a
    gap returns `None`, same as past-the-end (was already `None`) — no
    special case needed, both are just "no clip covers this frame."
  - **`Track::duration()`** — was `sum(duration)` (valid only because
    clips were always back-to-back); now `max(start_frame + duration)`
    over all clips — the furthest clip end, gaps included. For every
    existing back-to-back scenario (unchanged `from_shots` output) these
    two formulas agree, so no behavior change there.
  - **`trim_start`** — now moves `start_frame` by the same `delta` as
    `source_start` (the clip's *end* stays fixed, matching a standard NLE
    left-edge trim), clamped so it can't move earlier than the end of the
    nearest preceding clip on the track (no overlap introduced) in addition
    to the existing source-media clamp. Trimming right now visibly opens a
    gap before the clip instead of leaving neighbors untouched-but-implicit.
  - **`trim_end`** — unchanged field-wise (`duration` only, `start_frame`
    fixed), but now also clamped so it can't grow past the `start_frame` of
    the nearest following clip on the track — previously impossible to
    violate (extending always cascaded everyone after it); now a real
    constraint since nothing ripples automatically.
  - **`split`** — simplified (direct `start_frame` read instead of summing
    predecessors); behavior unchanged, still never opens a gap between the
    two halves.
  - **`remove`** — **behavior change, flagged per the brief:** previously a
    "ripple delete" by construction (removing a clip always closed the gap
    because nothing else in the model *could* leave one); now a plain
    "lift" — the clip is gone, its slot becomes a gap, nothing else moves.
    `remove_drops_a_clip`'s old assertion (`t.duration() == 300` after
    removing the middle clip from a 350-frame track) is no longer true
    under this model — renamed to `remove_leaves_a_gap`, now asserts
    `duration() == 350` (the last clip never moved) and that the vacated
    range reads back as a gap. A real "ripple delete" (shift everything
    after left to close the gap) is a reasonable future op but wasn't
    asked for this phase and isn't invented here.
  - **`reorder`** — **behavior change, flagged per the brief:** previously
    the *only* way to move a clip in time (Vec splice → the old cumulative
    walk re-derived every position from the new order, cascading the whole
    track). Now that `start_frame` is an explicit, independently-owned
    field, a Vec splice has no timing effect at all — `reorder` is
    redefined as changing only the clips' **storage order** (bookkeeping /
    future UI list order), explicitly documented as not moving anything in
    time. `reorder_moves_a_clip` (asserted a full cascade reflow) became
    `reorder_changes_vec_order_but_not_positions` (asserts the Vec order
    changes but every clip's `(start_frame, duration)` — and hence every
    `clip_at` result — is identical before and after). The old "move a clip
    earlier/later in time" job is now `move_clip`'s (see below), which is
    an explicit, validated position change rather than an implicit side
    effect of list order.

- **New ops.** `Timeline::add_track(kind) -> usize` (push + return index).
  `Timeline::remove_track(track) -> Result<(), TimelineError>` — removes
  the track **and every clip on it**; no orphan-preservation, no special
  case for a non-empty track, stated explicitly rather than left implicit
  (recovery is the caller's job — D-052 global undo already covers this at
  a higher layer). `Timeline::move_clip(from_track, from_idx, to_track,
  to_start_frame: i64) -> Result<(), TimelineError>` — the position
  parameter is a plain `i64` (timeline-absolute), following directly from
  the `start_frame` design choice above; works for a same-track reposition
  too (`from_track == to_track`), which is the intended "drag a clip to a
  new spot on its own track" primitive now that `reorder` no longer does
  that. Validates: no negative position (`NegativePosition`), both track
  indices in range, the source clip index in range, and the destination
  range doesn't overlap any *other* clip already on the destination track
  (`Overlap(track, frame)` — the clip being moved never counts as
  overlapping itself, so "nudge a clip by N frames on its own track" and
  "swap two adjacent clips via two moves" both work).

- **Migration — typed post-deserialize backfill, not a raw-JSON rewrite.**
  D-045/D-046's `migrate_legacy_timeline`/`migrate_legacy_shots` needed raw
  `serde_json::Value` surgery because they change *shape* (a singular key
  becoming a list, a shot's inline fields becoming a pool reference) before
  a `#[serde(default)]` could even apply. This migration doesn't change
  shape — `Clip::start_frame` is a new field on an existing struct — so
  the shape-level part is plain `#[serde(default = "legacy_missing_start")]`
  (sentinel `i64::MIN`, chosen because it's never a value any real position
  computation produces). What's genuinely not a per-field default: the
  *correct* backfilled value isn't `0` for every legacy clip (that would
  collapse every clip in an old multi-clip track onto the same frame) — it's
  each clip's reconstructed back-to-back position, i.e. running the old
  `clip_at`-style cumulative-duration walk once. That's
  `Track::backfill_legacy_positions` / `Timeline::backfill_legacy_positions`
  — a typed method on the already-deserialized `Timeline`, called once from
  `chroma::project::load_manifest` right after `serde_json::from_value`
  (alongside the existing `active_shot`/`active_timeline` range-clamp
  calls there). Idempotent (only touches clips still at the sentinel) and
  safe on a mixed real/legacy track (accumulator continues from whichever
  value — real or just-backfilled — each clip ends up with), though that
  shape doesn't occur in practice. **Verified against the real
  `~/Movies/Chroma/New.chroma/project.json`** (embedded verbatim as a test
  fixture, both at the crate level — `backfill_matches_the_real_project_json_single_clip_shape`
  — and through the real `load_manifest` path —
  `real_project_json_shape_backfills_clip_position`, which also round-trips
  the migrated position through `save_manifest`/reload): its one real clip
  (no `start_frame` key) backfills to `start_frame: 0`, the correct
  reconstruction for a single-clip track.

- **Tauri commands (`app/src-tauri/src/chroma/edit.rs`, matching the
  existing `chroma_timeline_*` naming convention D-045 set):**
  `chroma_timeline_add_track(kind) -> Result<usize, String>`,
  `chroma_timeline_remove_track(track) -> Result<(), String>`,
  `chroma_timeline_move_clip(from_track, from_idx, to_track,
  to_start_frame) -> Result<(), String>` — all operate on the project's
  **active** timeline (same pattern as `chroma_timeline_get`/`_set`) and
  persist via `project::save_manifest` on success, leaving the persisted
  file untouched on error. Registered in `lib.rs`'s `generate_handler!`.
  No frontend consumes these yet (Phase D is explicitly blocked on Phases
  B/C) — this makes the capability reachable for a script/test/future UI,
  same spirit as D-045's `chroma_timeline_create`/`_set_active` landing
  before any timeline-switcher UI existed. `chroma_timeline_frame`'s "first
  video track only" preview behavior is deliberately untouched — no
  compositing exists yet (Phase B).

- **Verified:** `cargo test -p chroma-timeline` 23/23 (was 10; +13: gap
  query, back-to-back position assertions on `from_shots`/serde round-trip,
  the legacy-sentinel + backfill tests including the real-project-shape
  fixture, `reorder`'s redefined no-position-change contract, `trim_start`/
  `trim_end`'s new gap/neighbor-clamp cases, `remove`'s gap-not-ripple
  behavior, `add_track`/`remove_track` round-trip + clips-dropped-with-track,
  `move_clip` cross-track/same-track/overlap-rejected/out-of-range).
  `cargo test --manifest-path app/src-tauri/Cargo.toml chroma::` **110/110**
  (was 107, D-051's last recorded count, unchanged through D-053; +3: the
  `edit.rs` track/move command round-trip
  (`track_commands_add_remove_and_move_clip_on_the_active_timeline`) and the
  two `project.rs` D-054 migration tests
  (`multi_clip_legacy_track_backfills_back_to_back_positions`,
  `real_project_json_shape_backfills_clip_position` — the latter the real
  `~/Movies/Chroma/New.chroma/project.json` shape exercised through the
  actual `load_manifest` path, not just the crate-level fixture). One real
  bug caught by this run: `chroma::audio`'s test helper
  (`open_test_project`) built a `chroma_timeline::Clip` struct literal
  directly (not via `Timeline::from_shots`) and didn't compile until it
  gained the new `start_frame` field — fixed (`start_frame: 0`, the only
  clip on its track). `tsc --noEmit` in `app/` **64/64, unchanged** — no
  frontend file touched this phase, matching the brief's expectation this
  is completely unaffected. Real boot (`npm run tauri:dev`) confirmed the
  existing single-track Edit tab experience is unaffected — purely additive
  capability, not a behavior change to what already renders.

- **Deferred (explicitly out of scope this phase, per
  `docs/notes/multi-track-nle.md`):** no frontend/UI (`TimelinePane.tsx`
  untouched — Phase D, blocked on B/C); no compositor/rendering change
  (`chroma_timeline_frame` still only reads the first video track — Phase
  B); no audio-track work (Phase C); nothing in the app's real flows
  (`build_from_shots`) populates a second track or a gap — the model can
  now represent them, the app still doesn't produce them.

## D-055 — Interactive relight follow-ups: static depth-bake fallback, export wiring, a Preset tab, MCP tool wrapping
**decided (2026-09-03) · built (2026-09-03)**

- **Context.** `docs/04-roadmap.md`'s "Later" bucket carried four small,
  explicitly-deferred D-048 ("Interactive relight (puck UI + depth-driven
  shading)") follow-ups. (Both `docs/04-roadmap.md` lines 162-163 and
  `docs/09-engine-notes.md`'s D-048 section header itself said "D-046" for
  interactive relight — a pre-existing mislabel, D-046 is actually "Media
  pool pass 3"; fixed in this commit alongside these four, per CLAUDE.md's
  "docs describe the system as it actually is" rule.) All four land here,
  as one batch — each independent enough to be its own decision, but small
  enough that a shared write-up plus four clearly-separated sections is more
  legible than four one-paragraph entries.

  1. **Static single-frame depth-bake fallback.** D-048 v1: no temporal
     depth track ⇒ positional lights render as a correct, deliberate no-op
     (the `has_depth` shader gate). Studied first: D-024's AI-Depth mask,
     which already has exactly this fallback (`generate_ai_depth_bitmap`'s
     `mask_data_base64` arm) via a static Depth-Anything-V2 bake. Also found
     `generate_full_image_depth_map` (`ai_commands.rs`) — an existing,
     already-`generate_handler!`-registered command that runs that *exact*
     single-frame model on the currently-warped image and returns a raw
     (un-band-passed) depth PNG data URL, already used by the lens-blur
     effect's own static depth map (`lensBlurDepthMap`). **Choice:** reuse
     it verbatim — no second model, no second Tauri command. A new
     `adjustments.relightDepthBake: string | null` field (parsed by
     `chroma::relight::resolve_depth_bake`) holds the data URL; a "Bake
     Depth" button in `RelightPanel.tsx` (`useAiMasking.ts`'s
     `handleBakeRelightDepth`) populates it, mirroring "Track Depth"'s own
     button/hook shape exactly. Unlike "Track Depth" (video only — a still
     has no temporal track to run), "Bake Depth" works on a still image too,
     since D-048 v1's relight layer was never video-gated to begin with.
     Rust-side, `mask_generation::generate_relight_depth_bitmap_static`
     decodes it through the *same* `generate_ai_bitmap_from_base64` warp
     path every other base64-backed mask type already uses (crop/scale
     alignment stays identical to the tracked path). A new
     `mask_generation::resolve_relight_depth_bitmap(js_adjustments, …)` is
     now the one entry point every render path calls: tracked dir first (if
     something is actually cached at the current frame), static bake
     second, `None` (ambient-only, unchanged D-048 behaviour) only if
     neither resolves. `lib.rs`'s `process_preview_job` was refactored to
     call it instead of its old two-step dir-then-bitmap inline logic — same
     behaviour for the tracked case, now with the fallback for free.

  2. **`export.rs` wiring.** D-048 deliberately left every `mask_bitmaps`
     build site other than the live-preview path
     (`process_preview_job`/`lib.rs`) at `relight_depth_layer == -1`, so a
     positional light rendered in the GUI went inert on a real export — only
     the ambient term (no depth needed) survived. Studied first:
     `apply_relight` (`shader.wgsl`) and how `process_preview_job` feeds it
     (the exact `resolve_relight_depth_bitmap` call added in item 1 above).
     **Choice:** `chroma/export.rs`'s `grade_frame` (the per-frame renderer
     `export_video`'s real ffmpeg-in/ffmpeg-out loop calls, not
     `export_processing.rs`'s single-mask-isolation helper, which is a
     different, deliberately-relight-zeroing function per D-048) now calls
     the *same* `resolve_relight_depth_bitmap` resolver and appends the
     bitmap the same way — one more `mask_bitmaps` layer, `relight_depth_layer`
     pointed at it. `grade_frame` already runs after `set_current_frame`
     (the export loop calls it per decoded frame), so the tracked-dir path's
     per-frame PNG lookup (keyed off `chroma::state::current_video().frame`)
     resolves correctly for every exported frame, not just frame 0 — no
     extra state plumbing needed, this was already correct for masks and
     inherited automatically. **Deliberately still `-1`:** `bake_primary_lut`
     (primary-grade-only .cube bake — no masks of any kind belong there) and
     `export_processing.rs`'s `build_single_mask_adjustments` (isolates one
     mask's own effect for a preview swatch — relight is a global layer, not
     scoped to a mask, same reasoning D-048 already documented for it).

  3. **Preset tab.** D-048's brief named a ClipDrop reference strip with a
     leading "Preset" tab (saved/built-in lighting setups); v1 shipped
     Ambient/Light-N/+Add Light only, calling it "UI polish, deferred."
     Studied first: `RelightPuckLayer.tsx` + `adjustments.relightLights`'s
     shape, and `relightUtils.ts`'s `createRelightLight` (the exact factory
     "+Add Light" already calls). **Choice:** `utils/relightPresets.ts` — a
     small, hand-picked array of `{id, label, description, build}`, each
     `build()` returning a `RelightLight[]` via `createRelightLight(kind)`
     patched with hand-tuned field overrides (position/radius/intensity/
     color) for a specific look, not a new schema. Three presets, not an
     exhaustive gallery: "Warm key + cool rim" (two-point portrait rig),
     "Soft ambient fill" (flat/flattering wash), "Dramatic single-source"
     (moody, high-contrast). `RelightPanel.tsx` gets a `showPresets` boolean
     (a picker view, not a fourth "kind" of active light) and a new leading
     "Preset" tab; applying a preset calls the *same* `updateLights`/
     `setAdjustments` path "+Add Light" uses (REPLACES `relightLights`, then
     selects the first new light — matching "+Add Light"'s own
     select-on-add behaviour), not a separate code path.

  4. **MCP tool wrapping.** D-048 added `list_relight_lights`/
     `add_relight_light`/`set_relight_light`/`delete_relight_light` to the
     HTTP control-server bridge (`useChromaControl.ts`'s `OPS` registry,
     explicitly "mirroring `add_mask`'s shape" per D-048's own consequences
     section) for its own live verification, but never wrapped them as
     `mcp/server.py` tools — every other control-server op with an
     agent-facing purpose has one, these didn't. Studied first: the
     "masks" section of `mcp/server.py` (`add_subject_mask`/`set_mask_adjust`/
     `delete_mask` etc.) for the established `@mcp.tool()` + `_op`/`_result`
     wrapping convention: optional args built into a `dict` and only
     included when passed, a docstring stating field ranges/meanings and
     pointing at prerequisite tools. **Choice:** four new tools in a new
     "relight" section (`mcp/server.py`, between "masks" and "scopes"),
     wrapping the four ops 1:1, same convention, no 5th tool invented for
     "Bake Depth" (item 1) — that stays a GUI-only action for now, not
     asked for here and not on the HTTP control-server bridge to wrap.

- **Consequences / footprint.** New: `app/src/utils/relightPresets.ts`.
  Edited: `chroma/relight.rs` (+`resolve_depth_bake`, 2 tests),
  `mask_generation.rs` (+`generate_relight_depth_bitmap_static`,
  +`resolve_relight_depth_bitmap`, +6 tests in a new
  `relight_depth_bake_tests` module), `lib.rs` (`process_preview_job` now
  calls the unified resolver), `chroma/export.rs` (`grade_frame` wires the
  same resolver in, +1 real GPU pixel-difference test — lit vs. unlit,
  `export_positional_relight_light_changes_pixels`), `adjustments.ts`
  (+`relightDepthBake` field), `useAiMasking.ts` (+`handleBakeRelightDepth`),
  `useEditorStore.ts` (+`isBakingRelightDepth`), `RelightPanel.tsx` ("Bake
  Depth" button + Preset tab/picker), `mcp/server.py` (+4 tools). No
  `AppState`/Cargo/bind-group/new-Tauri-command change — same footprint
  shape D-048 itself had for the same reason (existing generic plumbing
  absorbs all four).

- **Verified (2026-09-03).** `cargo test --no-default-features -p RapidRAW
  chroma::` **109/109** green (existing D-048 relight tests unaffected +
  the new `export_positional_relight_light_changes_pixels` pixel-diff test,
  run for real against a real GPU adapter, same skip-without-GPU convention
  as `relight_render_is_deterministic`); `mask_generation`'s new
  `relight_depth_bake_tests` module **6/6** green separately (not under the
  `chroma::` path, pure decode/precedence tests, no GPU/video fixture
  needed). `cargo clippy --no-default-features -p RapidRAW --no-deps` — 15
  warnings, all pre-existing (confirmed by file/line against files this
  pass never touched — same 15 D-048's own note already named), **zero** in
  `relight.rs`/`mask_generation.rs`/`export.rs`/`lib.rs`. `cargo fmt`
  **scoped per-file** (`rustfmt --check` on each touched file directly, not
  `cargo fmt` on `lib.rs` — that walks the whole `mod` tree via the crate
  root and would have flagged dozens of pre-existing, unrelated files;
  CLAUDE.md's hard rule) — every new line this pass wrote is clean; the two
  pre-existing drifts already living in touched files
  (`mask_generation.rs:1272`, already logged as D-034 drift by D-048;
  `export.rs`'s 20 lines, confirmed via `git show HEAD:…|rustfmt --check`
  to already differ before this pass touched the file) were left alone, not
  "fixed," per the same rule. `cd app && npx tsc --noEmit` — 64 errors,
  unchanged baseline for this worktree, zero in a touched/new file.

  **Live app, real project.** Booted `npm run tauri:dev` from this
  worktree (a fresh dependency compile — this session's disk filled from
  concurrent agent activity on the shared machine mid-build twice;
  recovered both times by removing this worktree's own rebuildable
  `target/`, a legitimate `cargo clean`-equivalent, never another agent's
  files). Opened the real `~/Movies/Chroma/New.chroma` project over the
  control-server bridge (`open_project`, `set_active_shot`) — confirmed the
  saved grade schema round-trips the new `relightDepthBake` field
  (`null`). Drove the 4 relight ops directly (the same HTTP path the new
  MCP tools call, `_op` being a thin `httpx.post` wrapper — item 4):
  `add_relight_light` (ambient, green, intensity 80) → decoded the
  returned preview JPEG — **solid, uniform green**, exactly
  `apply_relight`'s ambient math, matching D-048's own precedent.
  `set_relight_light` (intensity 80 → 20) → re-rendered preview visibly
  fainter — live intensity scaling confirmed. `add_relight_light` (kind
  "key", no depth source present) → preview **unchanged** — confirms the
  `has_depth` gate still correctly no-ops a positional light absent any
  depth source (regression check: D-048's original behaviour, now one of
  two ways to be "absent" — no track *and* no bake). `list_relight_lights`
  confirmed state; all test lights deleted; `save_project` confirmed the
  on-disk grade returned to `relightLights: []` — the user's real project
  left exactly as found. `list_masks`/`list_projects` and the MCP tools'
  Python module (`python3 -m py_compile` + an AST walk enumerating every
  `@mcp.tool()` function) confirm the 4 new tools
  (`list_relight_lights`/`add_relight_light`/`set_relight_light`/
  `delete_relight_light`) are defined with the expected signatures — the
  installed `mcp` package in this sandbox (public PyPI 1.26.0) lacks the
  `mcp.server.mcpserver` module this file imports from (a pre-existing,
  environment-specific gap unrelated to this change — the file predates
  this pass), so the actual MCP stdio handshake could not be driven
  end-to-end here; the identical underlying HTTP call it makes was.

  **Not directly exercised live — the genuine gaps, flagged rather than
  glossed over:** (1) the "Bake Depth" button (item 1) and the Preset tab
  (item 3) are pure UI actions with no control-server equivalent (by
  design — item 4's scope is exactly the 4 pre-existing relight ops, not a
  5th one invented for this pass), and this sandbox has no
  screen/accessibility access to click them — the same limitation D-048
  itself hit for `RelightPuckLayer`'s drag. Verified instead by code
  review: `handleBakeRelightDepth` calls the *exact* already-proven-live
  `generate_full_image_depth_map` command (Effects.tsx's lens-blur feature
  already exercises it in production); `applyPreset` calls the *exact*
  `updateLights`/`setAdjustments` path just proven live via
  `add_relight_light`, only building multiple `createRelightLight(kind)`
  results instead of one. (2) The export test proves item 1+2's static-bake
  path with a synthetic depth bitmap (deterministic, repeatable, part of
  the permanent suite) rather than a real UI-triggered bake — a live
  `chroma_export_video` run using the real "Bake Depth" output was not
  performed, for the same click-access reason.

## D-056 — Multi-track NLE Phase B1: opaque top-wins video-track resolution — turned out to be track selection, not GPU compositing

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** `docs/notes/multi-track-nle.md` sub-phased the compositor
  (Phase B, the roadmap's long pole) into B1 (2 tracks, opaque, top wins) →
  B2 (N tracks, still opaque) → B3 (real blend modes/opacity). B1's job:
  prove the actual rendering pipeline end to end with the smallest real
  slice, on top of Phase A's foundation (D-054 — `Clip.start_frame`,
  gap-aware `Track::clip_at`, `add_track`/`remove_track`/`move_clip`).
  Today, nothing populates a second video track and the Editor's live
  preview (`edit.rs`'s `resolve_video_position`, shared by
  `chroma_timeline_frame` and the audio path) always did
  `tracks.iter().find(|t| t.kind == TrackKind::Video)` — first video track,
  unconditionally, second track silently ignored.

- **The load-bearing finding: opaque "top wins" compositing needs no new
  rendering/GPU code.** The brief asked to verify this rather than assume
  it, since it's exactly the kind of claim that can hide a codebase-specific
  gotcha. Checked directly: with no alpha/transparency in play, the
  top-priority track's clip — when it has one at the query position — fully
  obscures everything below it. There is no pixel value anywhere that
  depends on more than one source; it's **which single clip do we decode and
  show**, a track-priority-selection problem over `chroma-timeline`'s
  existing model, not a GPU-compositing problem. Nothing about this
  codebase's decode/render pipeline complicates that — `decode_pipe`
  already decodes exactly one clip per call
  (`decode_pipe::playback_frame_scaled`), which is precisely what "pick one
  winning clip, decode it" needs; there was no hidden "the pipeline assumes
  one source" obstacle to work around. So this phase is, correctly, almost
  entirely a **timeline-position-resolution-across-multiple-tracks-with-
  gap-fallthrough** change, not a rendering one — confirming the brief's
  hypothesis. Real multi-texture GPU blending (two decoded frames combined
  by a blend mode/opacity) remains genuinely new work, deferred to B3 as
  scoped.

- **Track z-order convention: `tracks` index order, lower index = higher
  priority ("on top").** The real alternative was the reverse (higher index
  on top, the more common **on-screen stacking** convention in some NLEs'
  track-header UI, e.g. Premiere's V2-above-V1 visual stacking even though
  V1 is track index/number 1). Chose lower-index-wins because:
  - **Zero behavior change for every timeline that exists today.** Every
    real project still has exactly one video track at index 0
    (`build_from_shots` unchanged). `tracks.iter().find(...)` already
    always returned track 0 — keeping index 0 as highest priority makes the
    new N-track walk a strict superset of the old single-track behavior
    (proved by the new `resolve_video_clip_at_matches_single_track_behavior`
    test), not a reinterpretation of what "the video track" meant before
    this phase.
  - **Consistent with this project's other track-ordered system.** Palmier
    Pro's MCP tool contract (this same repo's video-editing tool
    ecosystem) states its own convention explicitly: "Tracks are ordered
    and typed (video or audio); index 0 renders on top." Matching that
    avoids this codebase accumulating two different "index 0 means X"
    conventions across its own tooling.
  - Trade-off accepted: if/when Phase D's track-header UI arrives, "track 0
    is on top" needs to read naturally top-to-bottom in the lane list (a UI
    layout concern, not a data-model one) — noted for Phase D, not solved
    here.

- **Where the logic lives: a pure method on `chroma_timeline::Timeline`, not
  in `edit.rs`.** `Timeline::resolve_video_clip_at(&self, pos: i64) ->
  Option<(usize, &Clip, i64)>` walks `self.tracks` in stored `Vec` order
  (never a `HashMap` — deterministic by construction, no hidden iteration-
  order dependency), filtering to `TrackKind::Video`, and returns the first
  track whose `Track::clip_at(pos)` is `Some` — falling through to the next
  only on a gap (`None`). This keeps `chroma-timeline` accurate to its own
  documented boundary ("no media, no rendering" — the crate doc already
  says so): it does track/clip **selection**, which is pure timeline-model
  logic, not a media-layer concern. `edit.rs`'s `resolve_video_position`
  becomes a thin wrapper: call `resolve_video_clip_at`, then probe the
  winning clip's source for its `VideoInfo` (dimensions/frame-rate) —
  exactly the media-layer part `chroma-timeline` never touches. This also
  means the model-level logic is unit-testable with zero media/ffmpeg
  dependency (fast, synthetic fixtures), while the media-layer wrapper gets
  its own real-clip integration test.
  - Placing the "no video tracks at all" error (`"timeline has no video
    track"`) stayed in `edit.rs`, not the crate: it's app-level error
    messaging for a Tauri command's caller, not a fact about the timeline
    model itself (an empty-of-video-tracks `Timeline` is a perfectly valid
    value for the crate to represent).

- **Verified:**
  - `cargo test -p chroma-timeline`: **30/30** — 23 pre-existing (D-054) + 7
    new (`resolve_video_clip_at_*`) covering every case from the brief: both
    tracks have content (top wins), only top has content, only bottom has
    content, neither, top-has-a-gap-so-bottom-shows-through, no video
    tracks at all, and a same-behavior-as-`Track::clip_at`-alone regression
    check for the existing single-track shape.
  - `cargo test --manifest-path app/src-tauri/Cargo.toml chroma::`: **113/113**
    (up from D-055's most recently recorded count via its own new export/
    relight tests, not directly comparable to D-054's "110" figure, which
    predates D-055). This phase adds one new integration test,
    `track_resolution_opaque_top_wins_across_two_video_tracks` — exercises
    the real Tauri command path (`chroma_timeline_add_track`/`_move_clip`/
    `resolve_video_position`/`chroma_timeline_frame`, not just the pure
    crate logic already covered above) against two real, ffmpeg-probed
    clips of different lengths on two real video tracks, asserting
    top-wins, gap-fallthrough, past-everything, and that
    `chroma_timeline_frame` itself returns a real JPEG for the resolvable
    position and the blank-PNG sentinel past the end. Skips cleanly (like
    the existing `new_project_infers_settings_from_first_clip`) if ffmpeg
    isn't on `PATH`. Also widened the existing `make_test_clip` test helper
    with a `duration_s` parameter (both of its two pre-existing call sites
    updated to pass `1`, unchanged behavior) so this phase's test could
    synthesize two clips of different lengths.
  - `tsc --noEmit` in `app/`: **64/64, unaffected** — a real run (this fresh
    worktree needed its own `npm install` first, done this session), not
    just inferred from the diff, though the diff already guaranteed it: this
    phase touched only `crates/chroma-timeline/src/lib.rs` and
    `app/src-tauri/src/chroma/{edit.rs,project.rs}`, no frontend file.
  - **Real GUI boot: not completed, and why, rather than silently skipped.**
    `npm run tauri:dev` needs port 1420 (`vite.config.mjs`: `strictPort:
    true`, hardcoded, no env override), which was already held by a *different*
    `vite` dev server — the main checkout at `~/my_projects/chroma`, someone
    else's legitimate concurrent process, not this worktree's and not safe to
    kill. Changing the hardcoded port to dodge it was out of scope for this
    phase. In its place, the regression-safety case rests on two things that
    together cover what a boot would have shown: (1) the new integration test
    (`track_resolution_opaque_top_wins_across_two_video_tracks`) calls
    `chroma_timeline_frame` — the exact Tauri command the Edit tab's preview
    calls — against real ffmpeg-probed media, not a mock; (2)
    `resolve_video_clip_at_matches_single_track_behavior` proves the new
    resolution path is bit-for-bit identical to the old `.find()` +
    `Track::clip_at` path for every position on a single-video-track
    timeline, which is what every real project has today. `cargo test`
    passing both is the same regression guarantee a clean boot would have
    demonstrated visually.

- **Deferred (explicitly out of scope this phase, per
  `docs/notes/multi-track-nle.md`):** no GPU/pixel-level blend compositing
  (Phase B3 — genuinely new work when it lands, unlike this phase); no
  N>2-track testing (Phase B2 — the same walk already generalizes past 2
  tracks with zero additional code, since it's a plain filtered `Vec`
  iteration with no hardcoded track count anywhere, but untested at N>2
  until that phase); no UI / way for a real user to create a second track
  (Phase D, blocked on B fully landing); no audio-track work (Phase C,
  concurrent, separate worktree); no export-path change (`export.rs`
  doesn't go through the timeline model yet — untouched, unaffected, a
  later phase).

## D-057 — Multi-track NLE Phase C: real audio mixing — sum-then-soft-limit headroom, `Track.gain` lives on the domain model

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** `docs/notes/multi-track-nle.md` scoped Phase C as "extend
  `chroma::audio`'s `cpal` pipeline to sum N tracks with per-track gain
  instead of playing one embedded stream" — independent of Phase B (the
  compositor, still not started), riding on Phase A's (D-054) `Timeline`/
  `Track`/`Clip` model and D-050's existing `symphonia`→`rubato`→
  `dasp_sample`→`cpal` pipeline. Before this pass, `chroma::audio` played
  exactly one stream: the active video clip's own embedded audio, resolved
  via `edit::resolve_video_position`. `TrackKind::Audio` existed in the model
  (D-041) but nothing populated or read one (D-050's own module doc explains
  why, at the time — "a real, separate audio `Track` only earns its keep once
  there is something genuinely audio-only to put on it").

- **Where per-track gain lives: `chroma_timeline::Track::gain: f32`, default
  `1.0`, not a side table in `chroma::audio` or `chroma::project`.**
  `chroma-timeline`'s own module doc draws its boundary at "no media, no
  rendering, no compositing, no reaching media" — a numeric mix-level
  multiplier is none of those; it's a plain editorial property of a track,
  the same category as `Clip::start_frame` (D-054), which the domain model
  already owns. Putting it there means it persists with the project
  automatically (no new persistence code needed) and a future Phase D
  mute/volume UI has one real field to read and write instead of a parallel
  structure `chroma::audio` would have to keep in sync across every
  add/remove-track op. `chroma::audio` still owns *interpreting* the number —
  the actual mixing math and any media/`cpal` access stay in `chroma::audio`,
  matching its existing ownership of "reads media, drives the device."
  `#[serde(default = "default_track_gain")]` (not a bare `#[serde(default)]`,
  which would resolve to `f32::default() == 0.0`) so every pre-D-057
  `project.json` track loads at unity, not silently muted.

- **Headroom approach — three real options, chosen: sum active sources, then
  a soft (`tanh`) limiter, applied only when 2+ sources are genuinely
  active.**
  - **Pre-scale every source by `1/N`.** Rejected as the default: guarantees
    no clipping, but permanently quietens a mix even when sources are never
    simultaneously near full scale — the common real case (dialogue and a
    music bed rarely peak together) — which is a worse default than this
    tool's users would expect from a mixer.
  - **Hard `clamp(-1.0, 1.0)`.** Rejected: avoids the `1/N` loudness tax but
    produces true digital clipping (audible distortion) the moment multiple
    loud sources really do sum past unity — exactly the failure mode the
    brief called out to avoid.
  - **Sum, then `soft_limit(x) = tanh(x)` (chosen).** Passes small-magnitude
    input through with negligible distortion (`tanh'(0) == 1`, error is
    third-order in `x` — inaudible at real dialogue/music amplitudes, well
    under ±0.3) and compresses smoothly only as a mix approaches or exceeds
    full scale, instead of clipping. `|soft_limit(x)| <= 1.0` for any finite
    `x` — mathematically `tanh(x)` is strictly `< 1`, and at `f32` precision
    an extreme `x` (far beyond anything a real mix produces) rounds to
    exactly `1.0`, never past it, so the property that actually matters
    (never exceeding full scale) holds either way.
  - **The regression-safety refinement, and the reason the single-source case
    is provably unaffected:** `mix_sources(buffers, gains, len)` first drops
    any source whose gain is exactly `0.0` (a muted track contributes
    nothing, so it shouldn't count toward "how many sources are active"),
    then, if **one or zero** sources remain active, returns that source's
    buffer untouched (`gain == 1.0`) or scaled (`gain != 1.0`) — **no
    summation, no limiter call, at all** — and only sums + soft-limits when
    **two or more** are genuinely active. This makes two things exactly
    true, not approximately: (1) the pre-D-057 single-embedded-audio-track
    case (D-050 — still the only real scenario until a project actually gets
    a populated audio track) takes a **provably identical code path** with
    **byte-identical output**, asserted directly by
    `mix_sources_single_source_unity_gain_is_a_byte_identical_passthrough`;
    (2) muting one of two active tracks (`gains = [1.0, 0.0]`) makes the mix
    **exactly** equal to the other source alone — the checkable "mute via
    gain" property the brief asked for, asserted both as a pure unit test
    (`mix_sources_muting_one_of_two_sources_equals_the_other_alone`) and
    against real decoded PCM from two distinct real files
    (`real_decoded_sources_mix_and_mute_correctly`).

- **Streaming architecture: one audio thread, N `DecodedSource`s pulled in
  lockstep by a fixed-size window, not N threads or N ring buffers.**
  `chroma_audio_play` now resolves every active source at `start_frame` —
  the baseline video-embedded audio (always unity gain — see below) via the
  unchanged `edit::resolve_video_position`, plus every genuine
  `TrackKind::Audio` clip overlapping that position via the new
  `edit::resolve_audio_track_positions` (mirrors `resolve_video_position`'s
  own "gap/no-source is not an error" contract) — into a
  `Vec<AudioSourceSpec>`. `run_session` opens one `cpal` output stream (as
  before) and one `DecodedSource` per spec (`open_source`, factored out of
  the old single-source `run_session` body — same symphonia open/probe/seek
  setup, now shared across N sources instead of one). Each `DecodedSource`
  buffers its own variable-sized `symphonia`/`rubato` output into a small
  `carry: VecDeque<f32>` so every source can be asked for exactly the same
  fixed-size window (`DecodedSource::take`) regardless of its own internal
  packet/chunk sizes — that's what lets `mix_sources` sum them index-aligned.
  A source exhausted mid-session contributes silence for the rest (via
  `take`'s padding) without ending the session — the session only idles once
  **every** source is done (`decoded.iter().all(DecodedSource::is_done)`),
  generalizing D-050's own "keep the device open, drain to silence" EOF
  behaviour from one source to N.
  - **The baseline video-embedded-audio source stays hardcoded at unity gain
    this pass** — `chroma_audio_play` does not read the video track's own
    `Track::gain` into the mix. Deliberate, narrow scoping: the brief's own
    wording is "a way to set a gain/volume multiplier per **audio** track,"
    and wiring the video track's gain in too would need an extra timeline
    fetch for no scoped requirement. Easy future work if Phase D's UI ever
    wants to expose a video-track volume control too.
  - **If the baseline source (`sources[0]`) fails to open, that's a real
    error** — the same contract `run_session` always had for its one source.
    **If a later source (an audio-track clip) fails to open, it's logged and
    dropped, not fatal** — a broken/offline music-bed clip shouldn't take
    down a session that would otherwise have played the video's dialogue
    fine.

- **Scoped out, deliberately: stereo pan/positioning per track.** Mono gain
  scaling (every source is already collapsed to the output device's channel
  count via the existing `adapt_channels`, regardless of source channel
  count) covers Phase C's actual goal. A real pan law (equal-power vs.
  linear, mid/side handling once more than stereo is in play) is real extra
  scope nothing in `docs/notes/multi-track-nle.md`'s Phase C description
  asks for — revisit if/when Phase D's UI wants a pan control. No mute/solo
  UI either (Phase D, blocked on this landing) — only the underlying
  gain-mixing capability, per the brief.

- **Test fixture — no committed binary audio fixture in this repo (every
  existing audio/video test is env-var-gated to a real file already on this
  machine, not something checked in, per D-050's own convention).** Reused
  `CHROMA_TEST_AUDIO_VIDEO` (`~/Downloads/A001_08302215_C019.MOV`, HEVC+AAC
  48 kHz/2ch — D-050's own fixture) as the video track's embedded audio, and
  synthesized a second, genuinely distinct 440 Hz tone via `ffmpeg`'s `sine`
  test source (`synth_test_tone`, AAC-in-MP4 to match this crate's enabled
  `symphonia` features — `isomp4`+`aac`, no `wav`/`pcm` support) at test time
  into a tempdir, at the same 48 kHz rate so both decode sample-index-aligned
  without needing `rubato` inside the test itself. `ffmpeg` is already a hard
  pipeline dependency (`video.rs`'s own doc), so this mirrors the existing
  "real file, not a binary fixture in git" convention rather than adding one.
  `open_test_project_with_audio_track` extends D-050's `open_test_project`
  helper with an optional second, genuine `TrackKind::Audio` track holding a
  clip at `start_frame: 0` overlapping the video clip — exactly the fixture
  shape the brief asked for.

- **Verified.**
  - `cargo test -p chroma-timeline`: **25/25** (was 23; +2:
    `legacy_track_json_without_gain_defaults_to_unity`,
    `track_gain_round_trips_through_serde`; `add_and_remove_track_round_trip`
    also gained a gain=1.0 assertion on a freshly-added track).
  - `cargo test -p RapidRAW chroma::audio`: **29/29**, including the real,
    non-simulated proof this task asked for: `real_decoded_sources_mix_and_mute_correctly`
    (deterministic — decodes both real files via `decode_mono_range`, no
    `cpal`, no live device, no wall-clock — mixes them are the exact sum, not
    silence, not either alone; muting either one via `gain: 0.0` reproduces
    the other's decode output bit-for-bit) plus two live-device end-to-end
    tests through the real `chroma_audio_play`/`chroma_audio_level`/
    `chroma_audio_stop` command surface with a genuine 2-track `Timeline`
    (`chroma_audio_play_mixes_a_genuine_audio_track_with_the_video_track`,
    `chroma_audio_play_with_a_muted_audio_track_still_plays_the_video`) —
    both logged non-silent `peak` from a real `cpal` output stream. All of
    D-050/D-051's existing tests (single-source playback, the no-audio silent
    no-op, waveform extraction) still pass unchanged, pinning the regression
    contract.
  - `cargo test --manifest-path app/src-tauri/Cargo.toml chroma::`:
    **122/122** (was 110 at D-054; +12: the mixing/gain tests above; zero
    regressions elsewhere).
  - `cargo clippy -p RapidRAW --lib` / `cargo clippy -p chroma-timeline`:
    **zero warnings on any file this change touched** (`audio.rs`, `edit.rs`,
    `chroma-timeline/src/lib.rs`). Pre-existing `-D warnings` failures
    elsewhere in the workspace (`mask.rs`, `project.rs`, `session.rs`, none
    touched by this change) are unrelated lint debt predating this pass, not
    introduced by it.
  - `cargo fmt`: formatted only the 3 files this change touched. **Caught
    live:** `cargo fmt -p RapidRAW -- <files>` did not actually restrict
    itself to the given file list and reformatted a further 13 unrelated
    files across `app/src-tauri/src` — a real gotcha given this repo's
    HARD RULE against broad `cargo fmt` — caught via `git status` before
    committing and reverted with `git checkout --` on every file this change
    didn't touch; the 3 real diffs were confirmed (`git diff` hunk-by-hunk)
    to align exactly with this change's own edits, not stray reformatting.
  - `tsc --noEmit` in `app/`: **64/64, unchanged** from D-050/D-054's own
    recorded baseline in this worktree — expected and confirmed, since this
    pass touched zero frontend/TS files.
  - **Real boot, with an honest gap.** `cargo build -p RapidRAW --lib`
    succeeded cleanly (confirms the restructured `chroma::audio` — the new
    `DecodedSource`/`open_source`/multi-source `run_session` — links and
    builds with no new warnings, the same bar D-050's own boot check aimed
    for). Driving the actual Tauri window (`npm run tauri:dev`) was not
    possible in this session: port 1420 (Vite's `strictPort: true` fixed
    port) was already bound by a pre-existing, unrelated `vite` process
    running out of the **main** checkout (`~/my_projects/chroma`, not either
    concurrent worktree) — not something this task owns or should kill
    blind, and changing the hardcoded dev port would mean editing
    `app/vite.config.mjs`, out of this change's scope. Fell back to the same
    kind of proof D-050 itself used when a live UI click-through wasn't
    available: the real, live `chroma_audio_play`/`chroma_audio_level`/
    `chroma_audio_stop` integration tests above, which call the exact same
    command surface `PreviewPane.tsx` does, against real files, with a real
    `cpal` output stream logging non-silent levels.

- **Deferred (explicitly out of scope this phase, per
  `docs/notes/multi-track-nle.md`):** no UI to add an audio track or place a
  clip on one (Phase D, blocked on B and C both); no mute/solo/pan controls
  (pan scoped out of the model entirely this pass, see above); no export-path
  mixing (export doesn't use the timeline model yet — a separate, later
  phase); the video/audio sync model (D-050's open-loop lockstep-at-start
  design) untouched, as directed; re-resolving active sources mid-session
  (a clip beginning after a gap won't be picked up until the next Play/seek
  — matches D-050's existing "no re-seek mid-play" design).
## D-058 — Timeline UI fixes: `timeline.ts` gets D-054's `start_frame` for real (B-012/B-013), `TimelineSwitcher` rebuilt as a tab strip, an adaptive-density real-timecode ruler

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** The owner did real hands-on testing of the live app — the
  first time any of D-046/D-051/D-054's timeline UI work was actually
  driven by a real drag/interaction rather than code review, an
  accessibility-tree script, or a unit test. Two previously-"verified"
  interactions turned out broken (drag-and-drop from Sources, edge-trim);
  the timeline switcher and ruler were flagged as needing real UI work this
  task never got before. This decision covers all four; see **B-012**/
  **B-013** in `docs/BUGS.md` for the drag/trim bug writeups specifically —
  this entry is the design rationale, those are the "what broke and why."

- **Root cause (drag-and-drop + trim) — a frontend/backend model mismatch
  D-054 introduced and nothing re-verified before this pass, exactly the
  risk flagged when this task was scoped.** `chroma_timeline_set` stores
  whatever the frontend sends **verbatim** (D-041's original contract,
  unchanged) — there is no server-side clamping, so
  `packages/editor/src/timeline.ts`'s pure-TS mirror of the edit ops, not
  `chroma-timeline::lib.rs`'s Rust ops, is what actually runs for every
  edit made through this UI. D-054 (earlier the same day as this fix) gave
  `Clip` a mandatory, timeline-absolute `start_frame: i64` and changed
  `trim_start`/`trim_end`/`remove`'s real semantics around it (gap-aware,
  no-overlap, neighbor-clamped) — entirely in the Rust crate, by design
  (D-054 explicitly scoped "no frontend/UI" for Phase A). Nobody then
  ported that model into `timeline.ts`: its `Clip` type had no
  `start_frame` field at all, every op still assumed the pre-D-054 world
  (a clip's position is *implicit*, the sum of every preceding clip's
  duration), and `buildRow` rendered positions the same way — so a dropped
  clip's JSON simply had no `start_frame` key, and a left-edge trim could
  only ever visibly shrink a clip from the **end** (the only thing that
  formula lets move), never the start where the user actually dragged.
  Neither D-046 nor D-054 individually failed at what they set out to
  verify — D-046 flagged drag-to-track as its one code-review-only,
  not-live-tested piece; D-054 explicitly deferred all frontend work. The
  gap was structural, between two correctly-scoped decisions landed
  hours apart on the same day, and only surfaced once a real person
  exercised both together. **Lesson applied going forward:** when a data
  model a UI's own local mirror depends on changes, that UI's mirror is
  now stale until someone explicitly re-verifies it — "the backend crate
  has correct new semantics" and "the frontend actually produces JSON
  matching them" are two different claims, and `chroma_timeline_set`'s
  verbatim-storage contract means only the second one actually matters for
  what ships.

- **Second, independent root cause (trim only) — a CSS stacking bug that
  made the resize handle physically unreachable, found only by checking
  live hit-testing, not by reading source.** Even with `trim_start`'s model
  fixed, a real pointer event at a resize handle's own on-screen coordinates
  (`document.elementFromPoint`) resolved to the clip's own name-label div,
  not the library's `.timeline-editor-action-{left,right}-stretch` handle
  underneath it. The label carries `z-10` (so it paints above the Waveform
  canvas within its own clip) but its parent establishes no isolating
  stacking context, so that `z-10` escapes and competes directly against
  the handle siblings (`z-index: auto`, rendered later in the DOM per the
  library, which normally would win) — and since the label is an
  unconstrained block-level div, it silently covers the entire clip width,
  both 10px edge zones included. `interact.js`'s `resizable()` — correctly
  configured, exactly as D-051 found — never received the `pointerdown`
  that starts a resize gesture, because the label ate it first. This means
  edge-trim's real pre-fix symptom was nothing happens at all (no resize
  cursor engaging, no `onActionResizeEnd`), not "the wrong edge moves" as
  the `trim_start` model bug alone would have predicted — the model bug was
  real but never actually reachable through the UI until this hitbox bug
  was found and fixed first. See B-013's full writeup.

- **Fix — port D-054's model into `timeline.ts` for real, field-for-field
  against the Rust ops, not a reinterpretation.** `Clip.start_frame` added;
  `NewClipFields = Omit<Clip, 'start_frame'>` is what a not-yet-placed
  clip (a Sources-panel drag) actually has, and `applyOp`'s `add_clip`
  case computes the real value (`nextAppendFrame` — end of whatever's
  already on the target track) at the only point that has both the new
  clip and the real track state, rather than ever letting a clip exist
  without one. `trim_start`/`trim_end` reimplemented to mirror
  `chroma-timeline::Timeline::trim_start`/`trim_end` exactly (including
  the neighbor-clamp bounds); `split` now gives its right half a real
  `start_frame` instead of copying the left half's (previously: both
  halves claimed the same timeline position); `remove` needed no code
  change (a plain splice already matches the crate's "lift, not ripple"
  semantics — see below) but its *effect* changed once rendering stopped
  deriving position from Vec order. `buildRow`/`doSplit`/the ripple-flash
  snapshot all now read `clip.start_frame` directly instead of re-deriving
  it. New `move` `EditOp` (mirroring `Timeline::move_clip`'s same-track
  case, overlap-rejected) replaces `onActionMoveEnd`'s old array-splice
  `reorder` call — `reorder` alone stopped affecting position the moment
  `start_frame` became authoritative (D-054 redefined it as storage-order
  only), so leaving the clip-body-drag handler calling it would have made
  dragging a clip's body silently do nothing, a regression this fix would
  otherwise have introduced. `reorder` itself is left as-is (unused by
  this UI now, kept for API completeness/tests, matches the crate).
  **Consequence, not a compromise:** a gap can now genuinely appear on
  screen (after a left-edge trim, or a remove) — this matches what's on
  disk and is exactly what a normal NLE's non-ripple trim looks like, not
  a rendering bug. A future ripple-trim mode (shift downstream clips too)
  is a real, separate feature this doesn't build. **The hitbox bug's fix**
  is one line in `TimelinePane.tsx`'s `getActionRender` — `pointer-events-
  none` on the clip-name label (with an inline comment carrying the full
  stacking-context writeup, so a future reader doesn't mistake it for
  decorative and remove it) — deliberately not `isolate` on the content
  wrapper (the more "textbook" stacking-context fix): the label and the
  already-`pointer-events: none` Waveform canvas are both purely decorative
  overlays that don't need to receive pointer events themselves — `onClick`/
  drag/resize are all handled by the library at the action level — so making
  them inert is simpler and more clearly correct than re-scoping a stacking
  context and hoping nothing else depends on the label's exact paint order.

- **Verification.** Real op tests mirroring `chroma-timeline`'s own Rust
  unit tests (`packages/editor/src/timeline.test.ts`, `ruler.test.ts` for
  item 4 — 33 tests total, all passing): `add_clip` appends after the
  furthest clip end (not just the last Vec entry — tested with a
  pre-existing gap); `trim_start` shifts `start_frame`+`source_start`
  together, keeps the end fixed, and clamps against both the source-media
  bound and the nearest preceding clip's end (isolated from each other —
  one test gives the clip source room to spare specifically so only the
  neighbor clamp can be what's tested); `trim_end`'s matching next-clip
  clamp; `split` gives the right half its own `start_frame` (the exact
  B-012/B-013 bug, asserted directly: `right.start_frame` must not equal
  `left.start_frame`); `remove` leaves the other clip's `start_frame`
  untouched (no ripple); `move` repositions and rejects an overlapping
  destination. `tsc --noEmit` baseline confirmed in this fresh worktree
  first (`app`: 64 errors, byte-identical to the D-051/D-054-recorded
  baseline; `packages/editor`: 1, the same pre-existing CSS-import
  declaration D-051 noted) — unchanged after every change in this pass.

  **Real interaction-level evidence for items 1/2 — not "read the code."**
  This sandbox has no screen-recording or accessibility access to the live
  *Tauri* window (the same gap every prior session on this repo has hit —
  see D-046/D-051's own notes), so a different real-interaction path was
  used instead of that one: `npm run dev`'s plain Vite dev server (no
  Tauri/Rust — the frontend alone), opened in a **real Chrome tab** via
  `claude-in-chrome`, with a temporary `window.__TAURI_INTERNALS__` shim in
  `app/index.html` (guarded `if (!window.__TAURI_INTERNALS__)` — inert in
  the real app, where Tauri injects the real one before any page script
  runs; removed before commit, confirmed via `git diff` showing no change
  to that file) whose mocked `invoke()` only implements `chroma_timeline_
  set`/`_get` as a passthrough (store what's sent, return it back) so
  `useEditorTimelineStore`'s real save/reload cycle round-trips through it
  faithfully. Every other invoke() call rejects and is caught by the app's
  own existing error handling (confirmed harmless — e.g. the preview pane
  shows "preview error: … chroma_timeline_frame" instead of a frame, or
  simply doesn't render, never a crash). The **real, unmodified
  `SourcesPanel`/`TimelinePane`/`TimelineSwitcher` React components**,
  compiled by the real Vite dev server, were driven directly:
  - Seeded a real timeline + media-pool item into the **live, running**
    `useSessionStore`/`useEditorTimelineStore`/`useMediaPoolStore`
    singletons (dynamically `import()`-ing their already-loaded module URLs
    from the page's own `performance.getEntriesByType('resource')` list, so
    it's the exact same singleton the mounted React tree reads — not a
    fresh, disconnected instance).
  - **Drag-and-drop (item 1):** a real native HTML5 drag/drop sequence — a
    genuine `DataTransfer`, `dragstart` dispatched on the actual Sources-
    panel item's DOM node (its own real `onDragStart` handler populated the
    `application/x-chroma-media` payload), `dragenter`/`dragover`/`drop`
    dispatched on the actual `.timeline-editor-edit-row` DOM node the
    library renders (confirming the event reaches through the library's
    internal DOM to `TimelinePane`'s handler, not blocked as one of the
    scoped-out candidate causes worried it might be) — confirmed via a
    global capture-phase listener logging every dnd event, its `dataTransfer
    .types`, and `defaultPrevented`, that the MIME type carried through
    correctly and `preventDefault()` fired on `dragover`. The resulting
    clip in the live store landed at `start_frame: 240` (exactly the
    existing clip's end), confirmed both in the store and in the literal
    JSON `chroma_timeline_set` payload the mock captured — and confirmed
    **visually**, a screenshot showing "dropme.mp4" correctly appended
    right after the existing clip with the ruler now reading `00:00:13:23`
    (336 frames / 24fps). Chrome's own drag heuristics also let a plain
    `computer`-tool mouse-based drag promote into a real HTML5 drag session
    (dragstart/dragover fired with a real DataTransfer) but its coarse,
    linear-interpolated path didn't reliably land a `drop` — the direct
    `dispatchEvent` sequence above is the one that produced a clean,
    repeatable result and is what's reported as the real finding.
  - **Edge-trim (item 2) — this is what surfaced the hitbox bug above.**
    A first attempt with the `computer` tool's mouse-based drag on the
    resize handle produced real `pointerdown`/`pointermove`/`pointerup`
    events but no resize — checking `document.elementFromPoint()` at the
    handle's exact coordinates *before* the pointer-events fix showed the
    clip-name label as the hit target, not the handle (the bug). After
    adding `pointer-events-none` to the label, the same coordinate check
    correctly returned the handle, and a real synthetic `PointerEvent`
    sequence (`pointerdown`→8×`pointermove`→`pointerup`, `pointerId`/
    `isPrimary`/`buttons` set to mirror a genuine mouse gesture, dispatched
    at the handle's real screen coordinates) produced a live `clipB` moving
    from `start_frame: 240, duration: 96` to `start_frame: 251, duration:
    85` — `end_frame` unchanged at exactly `336` both before and after,
    confirming "end stays fixed, start slides" — with a visible gap opening
    on screen before it (screenshotted) and the exact `source_start`/
    `start_frame` shift (11 frames, matching the delta dragged) present in
    the literal `chroma_timeline_set` payload.
  - Dev server (`npx vite --port 1420`, no Tauri) killed after
    (`lsof -ti:1420 | xargs kill -9`); the temporary shim reverted before
    commit.

- **`TimelineSwitcher` rebuilt as a tab strip (item 3).** Replaced the
  `Select` dropdown + separate "+ New" button with `@chroma/ui`'s
  `Tabs`/`TabsList`/`TabsTrigger` (shadcn-on-Base-UI, D-042) — one tab per
  timeline, click to `chroma_timeline_set_active`, plus a `+` tab at the
  end. The `+` tab is a real `TabsTrigger` (keyboard/focus/hover for free)
  but must never become the *selected* tab (nothing to show there); since
  `Tabs` here is fully controlled (`value` always the real active
  timeline's id), `onValueChange` intercepts a sentinel value and opens the
  inline name field instead of ever writing it into `value` — no
  uncontrolled-state hack needed. Used the canonical component per this
  repo's "no ad-hoc copied snippets" standard rather than hand-rolling tab
  styling.

- **Ruler: real timecode + adaptive tick density (item 4).**
  `@xzdarcy/react-timeline-editor`'s `TimeArea` has a `getScaleRender(item)`
  hook (checked in its bundled source first, same discipline as D-051) but
  no adaptive-density concept of its own — `scale` (seconds per labeled
  tick) is a single fixed prop; the pre-fix code hardcoded it to `1`,
  exactly the "1, 2, 3…49" clutter at low zoom the owner hit. New
  `ruler.ts` (`niceTickIntervalSeconds`, `formatTimecode`), both pure and
  unit-tested:
  - **`niceTickIntervalSeconds(pxPerSecond, targetPx, minSeconds)`** — the
    classic "nice numbers" ruler technique: pick the smallest interval from
    a fixed 1-2-5 progression (0.1s…3600s) whose pixel spacing at the
    current zoom is still `>= targetPx` (70px), floored at `minSeconds`
    (`1/fps`, one frame — an interval finer than a frame means nothing).
    `TimelinePane`'s zoom state was renamed `pxPerSec` (from `scaleWidth`,
    which only ever meant "px per second" because `scale` was hardcoded to
    1) and is now the independent control; the library's actual
    `scaleWidth` prop (its own "px per one `scale`-unit" meaning) is
    derived as `tickSeconds * pxPerSec` each render, so what's on screen
    stays pixel-continuous through zoom even though the chosen tick
    interval only takes discrete "nice" values.
  - **`formatTimecode(seconds, fps, tickIntervalSeconds)`** — real
    `HH:MM:SS` broadcast timecode, converting via the timeline's actual
    `rate` (not a hardcoded 24) so a 30fps or 60fps project's frame column
    is correct; `:FF` is appended only when the current tick interval is
    sub-second — at whole-second-or-coarser spacing every label showing a
    redundant `:00` would be noise, so the ruler's own density decides the
    format rather than a fixed rule.
  - **Verification:** `ruler.test.ts` — the interval function only ever
    returns a listed "nice" value, widens as zoom shrinks and narrows as it
    grows, reproduces the pre-fix 1s-tick behavior at the old default zoom
    (continuity check, not just a fresh assertion), never goes finer than
    one frame, and the chosen interval's pixel spacing is checked directly
    against `targetPx` rather than trusted; the formatter is checked
    against real fps conversion (30fps vs 24fps giving different frame
    numbers for the same wall-clock second), the sub-second `:FF` threshold,
    minute/hour rollover, and a non-positive-fps fallback. No visual
    confirmation of the rendered ruler pixels in the live app (same
    screen-recording gap as above) — the tick-interval math and the label
    string are what's actually checkable, and are checked directly.

- **Deferred / out of scope this pass (per the brief):** multi-track UI
  (multiple visible lanes, track headers — blocked on Phase B of
  `docs/notes/multi-track-nle.md`); a ripple-trim mode; timeline
  rename/delete (still no backing commands, unchanged from D-046);
  cursor-anchored zoom (D-051's own deferred item, unchanged).
## D-059 — Sources panel fixes: async media commands (B-014), real poster-frame thumbnails, real "New Folder"

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** D-046's own verification was accessibility-driven (`osascript`/System
  Events + reading `project.json` before/after), with no real screen access —
  enough to prove the AX tree and data round-trips, not enough to catch a real
  performance regression or "this still looks unfinished" gaps. The owner did
  real hands-on testing of the shipped Sources panel and found three concrete
  problems D-046's verification missed: "Import" is slow to open the native
  file dialog (**B-014**, see `docs/BUGS.md`), every card shows the same
  generic film-strip placeholder regardless of import — D-046's own decision
  already flagged this as deferred — and there is no way to create a new,
  empty bin/folder (only re-filing an *existing* item into a not-yet-used
  path, which only "creates" a folder that already has something in it).

- **1. `chroma_media_list`/`_import`/`_move` → `async fn` (B-014).** Root
  cause and fix are B-014's entry in `docs/BUGS.md` — not repeated here. One
  addition: `chroma_media_import`'s probing loop moves into
  `tokio::task::spawn_blocking`, not just gaining the bare `async` keyword
  the other two get, because it is the one command doing real subprocess
  work (`ffprobe`, and now `ffmpeg` for thumbnails) rather than a fast
  `serde_json` read/write.
  - **Verified — real before/after timing, not "should be faster now".**
    Built a small `osascript`/System Events harness (menu-bar-free UI
    scripting, the same mechanism D-046's own live verification used):
    activate the app, timestamp immediately before a synthetic click on the
    "Import" button (found via the AX tree, not coordinates), then poll
    for the native open-panel sheet to appear under the main window,
    timestamping the first success, and dismiss with Escape. See the
    "Verified (shared)" paragraph below for the actual numbers and what
    could/couldn't be measured this way.

- **2. Real poster-frame thumbnails — reuse `video::extract_thumb`, generate
  at import time, cache beside the source video.** D-046's decision named
  the exact existing mechanism to reuse: `chroma::video::extract_thumb` (the
  same extractor the project launcher's own card thumbnail — `regen_thumb`
  — and the Colorist shot-strip already call), not a second decode path.
  - **Where it's generated:** `probe_media_item` (the one place
    `chroma_media_import` builds a `MediaItem`), right after a successful
    `video::probe` — a mid-clip frame (`frame_count / 2`, not frame 0, which
    is often a black or fade-in frame on real footage), scaled to 150px
    tall (matching `extract_thumb_strip`'s existing thumbnail height, not
    `regen_thumb`'s larger 360px launcher-card size — this is a small grid
    tile, not a launcher card).
  - **Where it's cached:** `<video_dir>/.chroma/thumbs/<mediaId>.jpg` — the
    same `<video_dir>/.chroma/<kind>/<key>/…` layout `mask.rs`'s mattes
    (`.chroma/mattes/<paramsHash>/`) and `depth.rs`'s per-frame depth
    (`.chroma/depth/<paramsHash>/`) already use: a cache that lives beside
    the source, keyed and *referenced*, never copied into the project
    directory — consistent with the "media referenced in place" invariant
    this whole module is built around. Keyed by the pool item's own id
    (already unique) rather than a params hash like mattes/depth use,
    because a media item only ever needs one poster thumbnail, not one per
    distinct set of tracking/depth parameters.
  - **Live-read, not persisted on the model** — `MediaItemDto.thumb` is
    computed in `MediaItemDto::from` exactly the way `offline` already is
    (a `data:image/jpeg;base64,…` string read from the cache file, `None`
    if nothing is cached), not a new field on the persisted `MediaItem`.
    Keeps `project.json` free of embedded image bytes and means a manually
    deleted/corrupted cache file just silently falls back to the placeholder
    rather than needing a repair path.
  - **Scope: generated at import time only, no backfill for pre-D-059
    items or a lazy generate-on-list.** A lazy "generate if missing" inside
    `chroma_media_list`/`MediaItemDto::from` was considered and rejected —
    that function runs on every list/import, and adding an `ffmpeg`
    subprocess spawn per missing thumbnail there would silently reintroduce
    the exact main-thread/blocking-work problem item 1 just fixed, just
    moved to a different command. An item imported before this decision (or
    whose thumbnail generation failed) keeps the placeholder icon until
    re-imported; not backfilled automatically. Noted here rather than
    silently accepted as a known, deliberate limitation.
  - **Verified — a real file through the real command path, bytes read
    back and decoded, not just "a file exists".** `cargo test chroma::`
    (`media_import_generates_and_caches_a_real_thumbnail`): synthesizes a
    real 64×64 10fps `ffmpeg testsrc` clip, imports it through
    `chroma_media_import` for real, asserts the returned DTO's `thumb` is a
    `data:image/jpeg;base64,…` string, reads the cache file
    `thumb_cache_path` points at off disk, and decodes those exact bytes
    with `image::load_from_memory_with_format(…, ImageFormat::Jpeg)` —
    asserting real, non-zero width/height, i.e. a real decoded JPEG frame,
    not a placeholder or an empty/corrupt file — then confirms
    `chroma_media_list` re-reads the identical cached data URL live.

- **3. Real "New Folder" — a small additive `ProjectManifest.folders: Vec<String>`
  list, not a bin-hierarchy entity.** D-045's original model ("a folder
  exists exactly when some item's `folder` string names it") has no way to
  represent a folder with zero items — the moment its last item moves out,
  the folder disappears from the derived tree. Two real options:
  1. **A full bin-hierarchy entity** (a `Bin { id, name, parent_id }` tree,
     `MediaItem.folder` becoming a bin id reference instead of a path
     string) — the "proper" normalized-data-model answer, but D-045
     explicitly rejected this shape as unneeded complexity for what the
     panel actually needs (a tree derived from path strings, no
     rename/move-with-children/id-stability concerns a real hierarchy
     entity exists to solve), and nothing about "let an empty one exist"
     changes that calculus — it's solvable additively instead.
  2. **A small `Vec<String>` of explicitly-known folder paths** (chosen) —
     additive and optional (`#[serde(default)]`, same convention every
     other D-044/45/46 field used), independent of whether any item
     currently references it. `chroma_media_create_folder` appends to it
     (idempotent — creating an already-known folder is a no-op);
     `chroma_media_import`/`_move` also register whatever `folder` they're
     given (`register_folder`, shared), so a folder implicitly created by
     importing/moving into a not-yet-used path (D-045's original behaviour)
     is remembered too, not just an explicitly-created one — the two
     creation paths converge on the same list rather than one being a
     second-class citizen. `chroma_media_folders` (+ `all_folders`, the
     dedup/union helper) returns the union of this list and every item's
     `folder` string — what the Sources panel's tree is actually built
     from now, not `items` alone.
  - **Frontend:** a "New Folder" button next to "All media" in the tree
    header (always visible, even with zero folders — the primary case this
    fixes), plus a right-click context menu on the tree area (root-level)
    and on each `FolderRow` (nested, creating inside that folder) — using
    `@chroma/ui`'s shadcn `ContextMenu` (D-042), its first real consumer
    outside `packages/ui` itself (every other context-menu use in `app/` is
    RapidRAW's inherited `useContextMenu`/`ContextMenuContext`, vendored
    code this pass had no reason to touch). Naming goes through a small
    `Dialog` (same controlled-`open` pattern `ExportDialog` already uses).
    `useMediaPoolStore` gained a `folders: string[]` field (populated by
    `refresh()` alongside `items`, via `Promise.all`) and a `createFolder`
    action.
  - **Verified.** `cargo test chroma::`
    (`chroma_media_create_folder_lists_even_with_zero_items`): creates a
    folder with zero items, confirms `chroma_media_folders` lists it;
    confirms creating the same folder again is idempotent (no duplicate);
    confirms a blank name is rejected; then imports a real item into that
    folder and confirms both the item's `folder` and the folder list are
    correct afterward (still exactly one entry, not two).

- **Verified (shared across all three).** `cargo test chroma::` 114/114
  (was 112 in this fresh worktree before this pass — confirmed by running
  the suite before touching anything; +2: `chroma_media_create_folder_lists_even_with_zero_items`,
  `media_import_generates_and_caches_a_real_thumbnail`, plus the existing
  `media_move_refiles_an_existing_item` updated to drive the now-async
  command on a `tokio::runtime::Builder::new_current_thread()`). `cargo
  clippy`/`cargo fmt` run on touched files only (`project.rs`, `audio.rs`,
  `lib.rs`) — **hit the hard rule directly this session**: an
  over-broad `cargo fmt -- <files>` / `rustfmt <files>` invocation that
  included `lib.rs` (the crate root) reformatted the *entire* crate's module
  tree as a side effect (rustfmt walks `mod` declarations from a crate-root
  file) — caught immediately via `git status`/`git diff --stat` showing 14
  unrelated files touched, reverted with `git checkout --` before it went
  anywhere near a commit. Fixed by running plain `rustfmt --edition 2024` on
  each touched *leaf* file individually instead of ever pointing it at
  `lib.rs`. `tsc --noEmit`: app 64/64 (unchanged baseline, confirmed in this
  fresh worktree both before and after), `packages/bridge` 0, `packages/editor`
  1 (unchanged, the pre-existing unrelated CSS-import declaration in
  `TimelinePane.tsx` — untouched, out of this pass's file scope), `packages/ui` 0.
  - **Real boot + real click-through**, `npm run tauri:dev` (port `15420`,
    not `1420` — another worktree/session held `1420` all evening; reverted
    to `1420` in both `vite.config.mjs`/`tauri.conf.json` before committing),
    driven via `osascript`/System Events (same mechanism D-046's own
    verification used) against the real `~/Movies/Chroma/New.chroma`
    project:
    - **Folder creation (item 3):** clicked "New Folder", typed a name into
      the real dialog, clicked Create — `project.json`'s `folders` array
      showed `["VerifiedEmptyFolder"]` immediately, with **zero** items
      referencing it, and the Sources panel's tree rendered it as a real,
      clickable row (confirmed via the AX tree, not just data). Cleaned up
      after (removed the test folder from `folders`) rather than leaving
      test cruft in the owner's real project.
    - **Thumbnails (item 2):** imported a real, never-before-imported `.mov`
      file through the real Import flow. `project.json`'s `media` array
      grew by one; `<video_dir>/.chroma/thumbs/<newId>.jpg` existed on disk
      (5.5 KB); decoded with Python's PIL as a real JPEG, `250×150`, RGB —
      a genuine decoded frame from that exact video, not a placeholder.
    - **Import dialog timing (item 1 / B-014) — honest result, not
      oversold.** Built an `osascript` harness that finds the "Import"
      button via the AX tree (not coordinates), timestamps immediately
      before `click`, and polls `count sheets of window 1` (the native
      open-panel is a **sheet** on the main window here, not a separate
      top-level window — confirmed by inspecting its AX contents, a real
      `NSOpenPanel` sidebar/outline) until it appears. On an **idle** click
      (project already open, Sources panel's own mount-time `chroma_media_list`
      long since settled, a small 2-item pool) this measured **~140–680 ms
      in both the pre-fix (still-synchronous) build and the post-fix (async)
      build — no observable difference at this specific low-contention
      repro.** That is an honest, expected result, not a failure to find one:
      with only 2 items, the original `chroma_media_list` call the panel's
      mount fires completes in far under a millisecond even fully
      synchronous, so there is no realistic window for it to still be
      occupying the main thread by the time "Import" is clicked moments
      later. I attempted to manufacture heavier, more representative
      contention — a real batch import of 15 diverse real video files (which
      *did* succeed end-to-end through the pre-fix, synchronous
      `chroma_media_import`, proving correctness under real load) run
      concurrently with a responsiveness probe on a second native action —
      but reliable, precisely-timed multi-file `NSOpenPanel` selection and
      a valid "is the main thread free" probe (a tab switch turned out to be
      a pure frontend state change with no IPC round-trip at all, so it
      proved nothing) both proved too fragile to nail down cleanly via
      `osascript` UI-scripting inside the remaining session time — noted
      here honestly rather than papered over with a fabricated number. The
      fix's actual justification is **not** this live timing test (which was
      inconclusive by construction, not by finding "no bug") — it is the
      **definitive, source-level root-cause finding** in B-014's `docs/BUGS.md`
      entry (`tauri-macros` 2.6.3's own `command::wrapper` source, read
      directly: a non-`async fn` command's generated body calls itself
      inline wherever the IPC message is dispatched, versus an `async fn`
      command's body being handed to `respond_async_serialized`/the async
      runtime), plus the fact that this fix is strictly load-bearing in one
      direction only — moving real, occasionally-slow work
      (`ffprobe`/`ffmpeg` subprocess calls, on `chroma_media_import`) off the
      thread that also has to present native dialogs cannot make that thread
      *less* available, only more, whatever a given click's own timing
      happens to show on a small idle test project.
  - Dev server killed after (`lsof -ti:15420 | xargs kill -9` + `pkill -9 RapidRAW`).

## D-060/D-061 — Sources panel: real delete (single, batch), edge-trim cursor affordance, timeline-switcher width

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** Live testing (same session as D-058) turned up four more
  real gaps: no way to remove a clip from the Sources pool at all; the
  library's own resize handles ship with no `cursor` styling, so nothing
  told the mouse edge-trim was even possible until you'd already started
  dragging; right-click-then-click "Remove from pool" (D-060's first pass)
  was flagged as "too much" once it existed — a faster hover/bulk path was
  asked for next (D-061); and the rebuilt tab strip (D-058) still looked
  like a full-width bar with a lot of dead space behind 1-2 short tabs.
- **D-060 — `chroma_media_remove`.** New Tauri command, added
  `SourcesPanel`'s right-click "Remove from pool." Removes the pool
  reference + the cached thumbnail file (`thumb_cache_path`, D-059) only —
  never the source file (media stays referenced-in-place, never owned).
  A `ProjectShot` still referencing the removed id is left alone
  deliberately: `resolve_shot`'s pre-existing "dangling reference →
  offline, not fatal" discipline already covers it.
- **D-061 — batch delete + faster UI paths, same day.** Once a real delete
  existed, right-click was flagged as too slow for the common case.
  `chroma_media_remove` was reshaped to take `Vec<String>` instead of one
  id (matching `chroma_media_import`'s "one round trip, one manifest save"
  shape) *before* it had any real caller outside this pass, so this isn't
  a breaking API change to anything shipped. An unknown id in the batch is
  silently skipped rather than failing the whole call — the ids come from
  the panel's own already-rendered selection, not typed input, so "already
  gone" isn't a real error worth aborting a multi-item click over. Two new
  UI paths, both wired to the same batch command: (1) a hover trash icon
  per card (top-left, mirroring the existing top-right "add to grading"
  `+`) for a one-click single delete, no right-click needed; (2) a header
  "Select" toggle that turns every card into a checkbox with "Select all"
  + "Delete (N)" — the bulk path. Right-click "Remove from pool" (D-060)
  is left in place as a third option, not removed.
- **Edge-trim cursor.** `@xzdarcy/react-timeline-editor`'s bundled CSS
  styles the resize handles' `:after` triangle but sets no `cursor` on the
  handle itself (checked directly in the bundled `.css`, not assumed) —
  `TimelinePane.tsx` never fixed this because D-058's fix was about the
  drag actually *working*, not about the affordance telling you it could.
  New `timeline-overrides.css` (imported after the library's own, so it
  wins ties): `cursor: ew-resize` on both handles (reusing the library's
  own convention from the playhead scrubber) + a hover opacity bump on
  each handle's own `:after` triangle — only the side that's actually
  visible on that handle, the other stays `transparent` by design.
  Fixing the pre-existing "1 known tsc error" (`Cannot find module ...
  side-effect import of *.css`, D-051) alongside adding a second one was
  cheaper than accepting two: a `packages/editor/src/css.d.ts`
  (`declare module '*.css'`) ambient declaration clears both, `tsc
  --noEmit` on `packages/editor` is 0 now, not 1.
- **Timeline-switcher width.** The shadcn base `TabsTrigger` ships
  `flex-1` (an equal-width segmented-control style); D-058's own override
  only added `shrink-0`, which cancels `flex-1`'s *shrink* half but not
  its *grow* half — tabs kept stretching to fill the whole row. Added
  `grow-0 basis-auto` (the actual fix) + a right hairline divider (`gap-0`
  replacing `gap-0.5`, since equal-width flex-1 had been the only thing
  keeping tabs visually apart) + capped the switcher's own container to
  `w-1/2 min-w-[220px]` per the owner's explicit ask, rather than the
  full-width bar D-058 shipped.
- **Verification.** `cargo test chroma::` 126/126 (was 125; +1:
  `media_remove_deletes_a_batch_and_their_cached_thumbnails` — 2 real
  items + 1 stale id in one batch call, asserts both real items and their
  synthesized cache files are gone, the stale id doesn't error the call,
  and the untouched third item survives). `tsc --noEmit`: `app` 64/64
  unchanged, `packages/editor` **1 → 0** (the `css.d.ts` fix), `packages/
  bridge` 0/0. Real `cargo build --workspace` + a full `npm run tauri:dev`
  boot, twice (the first attempt hit a stale port-1420 process and a
  corrupted 3GB incremental-build cache — both artifacts of this session's
  own repeated force-kills across restarts, not this change; cleared
  `target/debug/incremental` and rebuilt clean). No automated DOM-level
  interaction test this pass (the D-058 Chrome-tab method); the owner
  confirmed drag-and-drop working live first, then this batch landed on
  top of that same running app.

## D-062 — Motion render auto-imports into Sources; Edit-tab preview gets a real loading state

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** Two owner questions in one message: "does render put the
  video on the timeline or in Sources, so I can drag it into my own
  video?" and a follow-up report of a preview "flicker" that looked like
  a broken refresh rather than a normal load.
- **Render destination — traced, not guessed.** `chroma_motion_render`
  (`app/src-tauri/src/chroma/motion.rs`) only ever wrote a file to
  `<project>.chroma/motion/render.mp4` and returned its path;
  `ManifestEditor.tsx` just printed that path as plain text. Nothing
  imported it into the media pool or placed it on any timeline — the
  honest answer to "does it..." was no.
- **Fix — an `onRendered` callback, not a cross-layer import.**
  `@chroma/motion` cannot depend on `@chroma/bridge` (D-039 layer
  direction: a tab package doesn't reach into the app/domain layer), so
  `useMotionManifest`/`MotionTab` gained an optional `onRendered?:
  (outputPath: string) => void`, fired with the real render result.
  `app/src/main.tsx` (the composition root — same reasoning as its
  existing B-007 bridge) supplies it: `useMediaPoolStore.importPaths([outputPath])`
  at the pool root, toast on success/failure. **Deliberately does not**
  also splice the result onto the Edit tab's active timeline — the owner
  may want a specific track/position, not wherever an automatic placement
  would land it; dragging it in from Sources (like any other clip) stays
  the one explicit placement action. A second render at the same fixed
  output path returns `added: []` (the backend already dedups by path,
  D-045) — handled as a pool refresh, not a false "couldn't add" error.
- **Preview flicker (Edit tab) — a real gap, distinct from D-063's
  Colorist-tab version of the same underlying mistake.**
  `PreviewPane.tsx`'s fallback rendered the exact same plain "no frame"
  text whether a frame was still loading (normal, e.g. right after
  dropping the first clip onto an empty timeline) or genuinely absent —
  indistinguishable from broken. Since `frameSrc` only reads `null` on a
  genuine first-load (a later scrub/play keeps the previous frame visible
  while the next one fetches — unchanged, already correct), the fix is a
  derived render, no new state: `decodeErr` → error text, `frameSrc` →
  the image, `frameSrc === null && timeline` → a real `Loader2` spinner,
  else the plain "no frame" text for a genuinely-empty case.
- **Verification.** `tsc --noEmit`: `packages/motion` 0/0, `app` 64/64
  unchanged, `packages/editor` 0/0 (post D-061's `css.d.ts` fix). No
  automated render-then-drag test this pass (would need a real `npx
  remotion render` invocation, several seconds per run); reasoned from
  the traced code path plus the pre-existing `chroma_media_import`
  dedup-by-path behavior (already covered by other tests) rather than a
  new end-to-end test.

## D-063 — Colorist shot-switch preview: the loading spinner existed but was wired to a dead flag

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** The same "flicker" report, but for the Colorist tab: the
  owner clicking a shot in the strip, or "add to grading" from Sources,
  saw a blank/stale preview for a moment with no loading indication.
- **The real finding — a spinner already existed, fully built, wired to
  a flag that's always `false` in the current app.** `Editor.tsx`'s
  `showSpinner` (`isLoading && !hasDisplayableImage`) drives a real,
  already-styled full-screen `Loader2` overlay (48px, accent color, a
  300ms opacity transition) — genuinely good UI, just never fires.
  `isLoading` reads `useLibraryStore.isViewLoading`, which is only ever
  set by `useAppNavigation`'s still-image `handleImageSelect` flow — a
  survivor of RapidRAW's original photo-library UI that the video-only
  Colorist pivot (D-043) never calls anymore. Confirmed by grep, not
  assumption: `isViewLoading` has exactly one `true`-setting call site in
  the whole app, and it's unreachable from the current video workflow.
  The actual "select a video" operations — `useSessionStore`'s
  `switchToShot` (the shot strip) and `_hydrateOpenDto` (project open,
  and "add to grading" from Sources) — each do a real decode round trip
  through `chroma_session_set_active`, with zero visual feedback wired to
  either.
- **A second, independent gap in the same area: `_hydrateOpenDto` itself
  never touched `busy` at all.** `switchToShot` correctly wraps its own
  call in `busy: true`/`false`; `openProject`/`newProject`/`saveUntitledAs`/
  `relinkShot` each separately wrap their own call to `_hydrateOpenDto` in
  `busy: true`/`false` — four call sites all remembering to do it
  independently. `SourcesPanel.tsx`'s "add to grading" action calls
  `_hydrateOpenDto` directly and never did — the most likely trigger for
  what the owner actually saw, since dragging/adding a clip into grading
  is a normal, frequent action. **Fix:** moved the `busy` toggle inside
  `_hydrateOpenDto` itself (try/finally), so every current and future
  caller gets it whether or not it remembers to wrap the call — a
  redundant `true`→`true` from an outer caller that already set it is
  harmless.
- **Fix, wiring.** `Editor.tsx`'s `isLoading` now reads `useLibraryStore
  .isViewLoading || useSessionStore.busy` — additive (RapidRAW's original
  flag, if the still-image path is ever reachable again, still works; the
  real video-switch path now works too), not a replacement.
- **Verification.** `tsc --noEmit`: `app` 64/64 unchanged (both files
  touched — `useSessionStore.ts`, `Editor.tsx` — are inside the existing
  baseline error set, confirmed no new errors from either). No automated
  UI test this pass (no screen-recording access to the real Tauri window,
  the same recurring gap D-046/D-051/D-058 have each hit) — reasoned from
  a direct trace of both `busy`'s existing call sites and `isViewLoading`'s
  single, dead call site, not from re-reading the spinner JSX alone. See
  **B-015** in `docs/BUGS.md` for the bug writeup.

## D-064 — the actual B-012/B-013 root cause: Tauri's own `dragDropEnabled` was intercepting HTML5 drag-and-drop in the real app

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** D-058 fixed the frontend/backend model mismatch behind
  B-012 (drag-and-drop) and B-013 (edge-trim), verified via genuinely
  strong DOM-level interaction evidence — real `dragstart`/`dragover`/
  `drop` events, real synthetic `PointerEvent` sequences, against the real
  unmodified components. There was one acknowledged, unavoidable gap in
  that method: it ran in a plain Chrome tab (`npx vite`, no Tauri/Rust),
  with `window.__TAURI_INTERNALS__` minimally shimmed — the documented
  workaround for this sandbox having no screen-recording access to the
  real Tauri window. The owner's very next live retest showed drag-and-
  drop still completely inert in the actual app. Trim worked; drag didn't
  — a real, narrower gap than D-058's fix being wrong.
- **Root cause — found by inspecting `tauri.conf.json`, not by guessing.**
  Tauri v2's window-level native drag-drop capture (`app.windows[].
  dragDropEnabled`) defaults to `true` and was never set in this project's
  config. When enabled, Tauri intercepts OS-level drag sessions at the
  webview layer for its own `onDragDropEvent` API (built for "drop a file
  from Finder onto the window") — this competes with, and in practice
  swallows, the page's own standard HTML5 `dragstart`/`dragover`/`drop`
  protocol that `SourcesPanel`'s drag-to-timeline feature depends on. A
  plain Chrome tab has no Tauri runtime present at all, so there was
  nothing to intercept anything in D-058's test — this is exactly the
  class of Tauri-runtime-specific behavior that verification method was
  structurally incapable of catching, flagged honestly in this project's
  own notes as a known limit of that workaround, and it's exactly what
  bit here.
- **Fix.** `"dragDropEnabled": false` added to the one window entry in
  `app/src-tauri/tauri.conf.json`. Checked first that nothing in the
  codebase listens for Tauri's native `onDragDropEvent`/`tauri://drag-*`
  events (grepped — zero matches) — the app has no feature that depends
  on OS-level file-drop-from-Finder, so disabling it costs nothing.
  A config-only change still requires a full rebuild to take effect
  (Tauri bakes `tauri.conf.json` into the binary via its build script's
  `cargo:rerun-if-changed`), not just a window restart.
- **Verification.** Real, not simulated: killed the running dev instance,
  rebuilt (`cargo build --workspace`, clean), relaunched
  `npm run tauri:dev`, and the owner personally dragged a clip from
  Sources onto the Edit-tab timeline in the actual native window —
  "yeah drag and drop works." This is the first drag-and-drop
  confirmation this project has that wasn't a proxy (Chrome tab, unit
  test, or code read) — the real window, a real mouse.
- **Process note, not a new technical finding:** this is the second time
  in one session a "verified" fix shipped and then failed the owner's own
  live retest (D-046's drag-to-track claim, then D-058's own trim/drag
  claim). Both times the actual gap was narrower than "the fix is wrong"
  — D-058's model fix and DOM-interaction method were both genuinely
  correct for what they tested; the miss was a real-app-only behavior no
  available proxy could exercise. Recorded here rather than glossed over,
  since "restart in the real app and just try it" is now the standing
  last verification step for any interaction-level fix in this repo, not
  optional polish.

## D-065 — Colorist fullscreen: a guaranteed close button, independent of two undeduplicated toggle closures

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** Owner's live testing: full-screening the Colorist preview left
  no way back — no visible close control, Escape didn't work either.
- **Found, by reading the actual render tree rather than guessing:**
  `EditorToolbar` (the only place `onToggleFullScreen` was wired to a button)
  sits inside a container that itself collapses to `max-h-0 opacity-0` the
  instant `isFullScreen` turns on — the one exit control was hidden by the
  very state it exits. Separately, `handleToggleFullScreen` turned out to be
  two independent `useCallback`s — one in `App.tsx` (wired to `useKeyboard
  Shortcuts`'s Escape handler), one in `Editor.tsx` (wired to the toolbar
  button) — with zero prop threading between `App.tsx` → `EditorView` →
  `Editor` connecting them. Both write the same `useUIStore.isFullScreen`
  flag, so they're functionally equivalent on paper; why Escape specifically
  didn't work for the owner wasn't nailed down by static reading alone, and
  a live-window interaction test (this session's own now-standing
  discipline, per D-064) wasn't run for this one due to time — flagged
  honestly rather than claimed fixed with confidence it doesn't have.
- **Fix, scoped to what's certain rather than the whole duplication.** A
  dedicated close (`X`) button, rendered unconditionally when `isFullScreen`
  — outside the toolbar's own collapsing container, `z-50`, fixed position —
  calling `setUI({ isFullScreen: false })` directly. This sidesteps both
  closures entirely: whatever is or isn't wrong with either one, this button
  works regardless, because it doesn't go through them at all.
- **Deferred, explicitly:** consolidating the two closures into one (thread
  `App.tsx`'s version down as a prop, or move the toggle into `useUIStore`
  as an action both callers read) — real duplication, real bug-prone smell,
  but a prop-threading change through two component layers isn't something
  to risk untested this late in the session when the button alone already
  closes the owner's actual complaint. See **B-016** in `docs/BUGS.md`.
- **Verification.** `tsc --noEmit -p app`: 64/64, unchanged baseline. No
  live-window click test this pass (noted above as a real gap, not glossed
  over) — the fix is a simple, direct store write with no dependency on the
  code whose behavior wasn't fully explained, which is the actual basis for
  confidence here, not a live click.

## D-066 — Relight keyframe "Clear"/delete: a spread-merge silently un-did every delete

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** Owner's live testing: clicking "Clear" (or the per-frame "X")
  on a relight light's keyframe row did nothing — the "N keys" count never
  changed.
- **Found by reading the actual merge logic, not by guessing.**
  `RelightPanel.tsx`'s `writeLightParams` — the callback behind the keyframe
  buttons specifically (`updateActiveLight`, a separate function backing the
  Color/Power/Distance sliders, was never affected) — applied its argument
  via `{ ...l, ...next }`. `clearKeyframes`/`removeKeyframe`
  (`utils/maskKeyframes.ts`, shared with D-034's mask-geometry keyframes)
  signal "no keyframes remain" by `delete`-ing the `chromaKeyframes` key
  from the object they return. A spread merge can overwrite a key the
  right-hand object *has*; it cannot un-set a key the right-hand object
  *lacks* — `next` (post-delete) has no `chromaKeyframes` key at all to
  overwrite `l`'s stale one with, so the stale value survived untouched
  through every "Clear" click, silently (no error, no visual sign anything
  was wrong beyond the count just never moving).
- **Confirmed the shared mechanism itself is sound** — checked
  `MaskKeyframeBar.tsx` (D-034's original mask-geometry keyframe UI, same
  `clearKeyframes`/`removeKeyframe` functions) for the same pattern: it
  calls `updateSubMask(sub.id, { parameters: next })`, replacing the whole
  `parameters` field wholesale rather than spread-merging into it — correct,
  no bug there. This was specific to how `RelightPanel.tsx` composed the
  reused pieces, not a defect in `maskKeyframes.ts` itself.
- **Fix.** `writeLightParams` now assigns `next` directly in place of the
  old light, rather than spreading it on top — correct because all three
  callers (`upsertKeyframe`/`removeKeyframe`/`clearKeyframes`) already build
  `next` as a complete light object (`{ ...parameters, ... }` internally),
  never a partial patch; `writeLightParams`'s only real job was "take the
  next real state," not "merge a patch."
- **Verification.** `tsc --noEmit -p app`: 64/64, unchanged baseline. No
  live-window click test this pass — the bug and its fix are both purely
  about JS object-merge semantics (verifiable by reading, not by clicking),
  and the fix was cross-checked against the one other real caller of the
  same shared functions to confirm it doesn't have the same bug, which is
  real evidence about the mechanism even without a live click. See **B-017**
  in `docs/BUGS.md`. Also confirmed, separately, that the same owner
  session's "no light showing at all when I changed the color" report is
  **not a bug**: `Editor.tsx`'s Relight panel says outright "Key/fill/rim
  lights need a depth track or bake (ambient works without one)," and
  `resolve_relight_depth_bitmap` (`mask_generation.rs`) genuinely returns
  `None` — confirmed by its own test, `resolve_relight_depth_bitmap(&js, 8,
  8, 1.0, (0.0, 0.0)).is_none()` for adjustments with no depth source set —
  which leaves `relight_depth_layer` at its safe `-1` default
  (`image_processing.rs`'s own comment: "an un-wired path just renders
  ambient-only relight, never a wrong depth layer") — a positional light
  with no Track Depth/Bake Depth run yet is *designed* to render as no-op,
  not broken. No code change for that one.

## D-067 — `chroma_depth_track`/`_status` had zero logging

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** Owner: "clicked track depth multiple time" (with the light
  still not showing). No way to tell apart, from `app.log` alone: the click
  never reaching this command, "no video loaded" erroring instantly, the
  sidecar rejecting the job, or a genuinely successful track whose *render*
  is what's actually broken — four very different next investigations.
- **Fix.** `log::error!`/`log::info!` on every real exit path of both
  commands: no-video-loaded, job start (with the resolved video path and
  params), sidecar-unreachable, a malformed sidecar response, an explicit
  `error` field in the sidecar's response, and — in `_status` — only the
  *terminal* poll states (`done`/`error`/`cancelled`/`unknown`), not every
  2-second tick, to avoid flooding the log during a long track.
- **Verification.** `cargo build --workspace` clean (12m22s under heavy
  contention from the concurrently-running unify-clip-model migration
  subagent's own builds, not a sign of a problem with this change). No live
  click test this pass — the point of this change is precisely to make the
  *next* live click diagnosable, not to diagnose this one blind.

## D-068 — Relight panel restyled onto `@chroma/ui`'s real components

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** Owner: "use proper button and all so its pretty UI feels
  like its not from this APP." `RelightPanel.tsx`'s own module doc had
  admitted this outright since D-048: "plain elements + app tokens... matching
  MasksPanel's own control style — not a new design language" — a
  deliberate choice at the time to match the pre-Chroma-pivot editor's
  look, now a visible inconsistency against every newer Chroma-native panel
  (`SourcesPanel`, `ExportDialog`, `TimelineSwitcher`), which are all on
  `@chroma/ui` (shadcn/Base UI, D-042).
- **Fix — presentation only, zero interaction-logic changes.** Every
  `<button>` → `@chroma/ui`'s `Button` (`variant="default"` for the
  selected tab/state, `"secondary"` otherwise, `"ghost"` for icon-only
  actions, `"icon-xs"`/`"xs"` sizing matching the panel's existing
  density). The legacy `../ui/Slider` (RapidRAW-era, `label`/`onChange`
  props) → `@chroma/ui`'s `Slider` (Base UI, `onValueChange` returning
  `number | readonly number[]` since it's shared with range sliders —
  unwrapped once via a local `sliderValue` helper, same pattern
  `@chroma/player`'s `Player.tsx` already uses for its scrub bar), with the
  label/value readout now a small row above the track instead of a prop the
  old component rendered internally. The color swatch stays the native
  `<input type="color">` (no color-picker component exists in `@chroma/ui`
  yet — real feature, not this pass's job) but now sits inside a proper
  bordered/rounded button-shaped container matching every other control's
  sizing, instead of a bare unstyled swatch.
- **Verification.** `tsc --noEmit -p app`: 64/64, unchanged baseline (zero
  new errors from either file). `cargo build --workspace` clean. No live
  visual confirmation this pass (no screen access to the real window) —
  the change is presentational only and every prop/handler wired to the
  underlying state is unchanged from the pre-existing, already-tested
  interaction logic, which is the actual basis for shipping this without a
  live look first.

## D-069 — the real Track Depth root cause: a 2-day-stale sidecar process, silently 404ing, silently accepted as success

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** D-067 added logging specifically so the owner's next "clicked
  Track Depth, nothing happened" would be diagnosable. It was — immediately:
  `app.log` showed `chroma_depth_track: job started, response:
  {"detail":"Not Found"}` on every click.
- **Root cause, traced to the actual process, not guessed.** `{"detail":
  "Not Found"}` is FastAPI's stock 404 body — meaning the AI sidecar
  answering on `:8765` didn't have a `/depth_track` route at all, despite
  `ai/server.py` (`@app.post("/depth_track")`, line 809) clearly having one
  in the checked-out source. `ps -p $(lsof -ti:8765)` showed why: that
  process had been running since **Tuesday, Sept 1, 21:19** — over two days,
  started well before this session, serving whatever `server.py` looked
  like back then. `chroma::sidecar::spawn_and_supervise` (D-028) only
  chooses between "spawn and manage our own" and "something's already
  answering `/health`, defer entirely" **once, at app boot** — and defers
  permanently once it finds anything alive, with no version/capability
  check beyond a bare 200 on `/health`. Every one of tonight's many app
  restarts found that same Sept-1 process still alive and healthy, so Rust
  deferred to it every single time — the staleness was invisible to every
  rebuild this session did, because none of them were the thing serving
  `/depth_track`.
- **The second, independently real bug this exposed: nothing checked HTTP
  status before parsing a response as success.** `chroma_depth_track`
  called `.json()` on the response body regardless of status code; a 404's
  `{"detail":"Not Found"}` parsed as valid JSON with neither `error` (the
  field this code checked) nor `dir`/`job_id` (what the frontend needed) —
  so the command returned `Ok` with an empty-ish object, `handleTrackRelight
  Depth` had nothing to poll and nothing to store, `depthTrackProgress`
  cleared almost instantly, and the *only* visible symptom was "I clicked
  it, nothing happened." This is the same failure shape as D-064
  (drag-and-drop) and D-063 (the dead loading flag) — a real thing silently
  no-op'd rather than erring loudly.
- **Fix, two parts.** (1) Killed the stale process, restarted it via `ai/
  run.sh` — confirmed with a direct `curl` against `/health` (fresh
  `models` list including `video_depth_anything_vits.pth`) and a direct
  `curl -X POST /depth_track` against a nonexistent path, which now
  correctly returns `{"error":"no such file: ..."}`, not a 404. The
  already-running Chroma app didn't need restarting — it calls the sidecar
  fresh on every command, not once at boot. (2) `chroma_depth_track`/
  `_status` now check `response.status()` before ever parsing the body —
  any non-2xx returns a real, loud error (including, for `_track`
  specifically, an inline hint pointing at exactly this failure mode — "if
  this is 'Not Found', the sidecar is probably a stale process... restart
  it") instead of silently succeeding with nothing useful in it. Closes the
  whole failure *class*, not just this one instance — a sidecar broken in
  some other future way now fails loudly here too.
- **Deferred, explicitly, as a real open question rather than solved
  tonight:** should `spawn_and_supervise`'s "something's already on
  `/health`" check be more than a bare 200 — e.g. confirm the responding
  process actually has the routes/capabilities this exact `server.py`
  expects, so a genuinely stale external process gets detected and
  refused (or the owner warned) at app boot instead of silently deferred to
  forever? Real design work (what counts as "compatible," what happens to
  a legitimately-external sidecar someone started for another reason), not
  a quick fix — noted here for whoever scopes it next, not attempted this
  pass.
- **Verification.** `cargo build --workspace` clean. Live: `curl http://
  127.0.0.1:8765/health` and a direct `curl -X POST .../depth_track`
  against the freshly-restarted sidecar, both confirmed correct
  (health payload lists the real models; depth_track returns a real
  `{"error":...}` for a bad path instead of a 404). The owner's own next
  live click through the actual UI is still the real end-to-end
  confirmation and hasn't happened yet as of this entry — noted honestly,
  not claimed.

## D-070 — Unified clip identity: `chroma_timeline::Clip` replaces `ProjectShot`, grades key off it, Colorist's "active clip" routes through D-056's top-wins resolver

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** Full scoping in `docs/notes/unified-clip-model.md` (owner,
  2026-09-03: "we have one clip we add, we can move to LUTs and color and
  we have the same clip, not multiple" — a Resolve comparison, triggered by
  the owner's own repro: a clip dragged onto the Edit tab's timeline didn't
  show up in Colorist at all). The doc's own investigation found a
  **four**-way split, not the two-list gap it first looked like:
  `state::Shot` (decode session, path-keyed), `useSessionStore.shots`/
  `.grades` (mirrors it), `ProjectShot` (the persisted grading list,
  `<gradeDir>/<shot.id>.grade.json`), and `chroma_timeline::Clip` (the Edit
  tab's real timeline, no structural link to any of the other three). This
  entry is that migration.
- **`Clip` gains `media_id: Option<String>`** (`crates/chroma-timeline/src/lib.rs`)
  — additive, `#[serde(default, skip_serializing_if = "Option::is_none")]`.
  Set by whatever op creates a clip that knows its pool item:
  `@chroma/editor`'s `clipFromDraggedMedia` (`packages/editor/src/timeline.ts`,
  a Sources-panel drag onto the Edit tab) and `chroma::project::append_media_clip`
  (the Colorist-side "add to grading" convenience). A clip built by
  `Timeline::from_shots` (every clip in every `project.json` saved before
  today) never sets it — only `shot_id`. 5 real unit tests in the crate:
  settable/gettable, serde round-trip (present → present, `None` → key
  omitted), legacy-JSON-defaults-to-`None`, `from_shots` never sets it,
  `split` clones it onto both halves.
- **`ProjectShot` retires as the persisted grading list — kept read-only,
  not removed.** Decision, not a default: the struct and
  `ProjectManifest.shots`/`.active_shot` still deserialize (so an old
  `project.json` keeps loading and `migrate_legacy_shots` keeps running),
  but nothing constructs a new one any more — `new_project_in`, the
  repurposed `chroma_project_add_shot`, and the new
  `chroma_project_add_shot_paths`/`chroma_project_remove_clip` all build
  `chroma_timeline::Clip`s via a new `append_media_clip` instead. Kept
  (not deleted) because it's the one thing the grade-file migration below
  needs to read on a project's first open after this ships — deleting it
  would mean a fresh clone of this repo could never migrate an existing
  owner's grades again. `ProjectManifest.active_clip_id: Option<String>`
  (new field) replaces `active_shot` as the persisted "which clip is
  Colorist grading" pointer — a clip id, stable across a reorder, unlike
  the old index. `resolve_active_clip_index`
  (`app/src-tauri/src/chroma/project.rs`) falls back to the legacy
  `active_shot`/`shots` pair exactly once, the first time a pre-migration
  project is opened.
- **`chroma_project_add_shot`'s job: repurposed, not retired.** Chose
  "becomes a convenience that does the drag for you server-side" over
  "goes away" — the Sources panel's "+" (`SourcesPanel.tsx`) is a real,
  frequently-used affordance and forcing every add through a literal HTML5
  drag to the Edit tab would be a UX regression for no real gain. It now
  calls `append_media_clip` (probe the source, append a full-length clip
  to the end of the active timeline's first video track, creating one if
  needed, make it `active_clip_id`) instead of pushing a `ProjectShot`.
  Its wire signature (`{ mediaId }` in, `ProjectOpenDto` out) is
  unchanged, so `SourcesPanel.tsx`'s call site needed no code change, only
  its doc comment (and the module doc at the top of the file). Two new
  siblings: `chroma_project_add_shot_paths` (probe/pool a batch of raw
  paths and append a clip each, one manifest save — the ShotStrip "+"
  button's project-backed path) and `chroma_project_remove_clip` (drop a
  clip from the active timeline by id — the ShotStrip "×" button's
  project-backed path).
- **Grade-file migration — `migrate_shot_grades_to_clips`
  (`app/src-tauri/src/chroma/project.rs`), called once inside
  `open_manifest` on every project open (idempotent, so "once" isn't load-
  bearing).** For each legacy `ProjectShot`, rename
  `<gradeDir>/<shot.id>.grade.json` → `<gradeDir>/<clip.id>.grade.json`
  for the one active-timeline clip `shot_matches_clip` says continues it.
  Zero or several matches ⇒ the file is left exactly where it is and a
  human-readable warning is logged (`GradeMigrationReport{ migrated,
  warnings: Vec<String> }`) — never guessed, never dropped. **Deviation
  from the scoping doc, found by testing against the real project, not
  guessed:** the doc says match by `media_id`/`source_path`; I added
  `Clip::shot_id` as the **first**, highest-priority signal
  (`shot_matches_clip`'s doc explains why in detail). The real
  `~/Movies/Chroma/New.chroma/project.json` has exactly the case that
  requires it — shot `8022aef1…`'s `mediaId` points at a pool item whose
  `sourcePath` had gone dangling (cleared to `""`, `resolve_shot` → `"
  (missing media)"`), so neither `media_id` nor `source_path` matching
  would find its one true timeline clip, which still carries the clip's
  own `shot_id: "8022aef1…"` backlink verbatim (that clip's `id` also
  happens to equal `8022aef1…`, since it was built by `Timeline::from_shots`
  before this decision). Matching by `media_id`/`source_path` alone would
  have misclassified this real, currently-graded shot as "no matching
  clip" and warned instead of recognizing it — updated
  `docs/notes/unified-clip-model.md` in this same commit to record the
  deviation rather than silently diverge. Mask mattes need no rename: a
  grade's `<name>.mattes/` sibling directory and its `$matte`/`$trackDir`/
  `$depthDir` references are named after the file's stem *at save time*
  and resolved against the grade file's parent directory at load time —
  read `grade.rs`'s `save_grade`/`load_grade` to confirm this before
  writing the migration, not assumed. 6 real unit tests: the clean 1:1
  rename, the "shot exists but no matching clip" warn-not-drop case, an
  ambiguous 2-match warn case, idempotency (running twice does nothing the
  second time), the "clip id already equals shot id" true no-op (the
  common `from_shots`-built-timeline shape — nothing is actually renamed,
  correctly not counted as `migrated`), and a "both old and new already
  exist" don't-clobber case.
- **Colorist's "active clip" now genuinely routes through D-056's
  `resolve_video_clip_at`, not a second copy of top-wins logic — confirmed
  by grep, not assumed.** `top_wins_clip_index` (`project.rs`) takes the
  candidate clip `resolve_active_clip_index` picked (persisted
  `active_clip_id`, or the legacy fallback) and re-resolves it through
  `manifest.timelines[active_timeline].resolve_video_clip_at(candidate.start_frame)`
  — the exact function `chroma::edit::resolve_video_position` already
  calls for the Edit-tab preview and `chroma::audio`'s mixer (D-056). For
  every project shape that exists today (one video track) this is a
  provable no-op (the crate's own
  `resolve_video_clip_at_matches_single_track_behavior` test); it starts
  doing real work once Phase D lands a second video track, so Colorist
  always grades the clip actually visible at that position, matching what
  the preview would show at the same frame. Two real unit tests:
  `top_wins_clip_index_prefers_the_real_compositing_winner` (a two-track
  manifest where the candidate is fully obscured — re-resolves to the
  clip that wins) and `top_wins_clip_index_is_a_noop_on_a_single_video_track`.
- **`chroma_project_save` shrinks — no more `shots`/`active_shot`
  params.** The timeline (persisted separately by `chroma_timeline_set`,
  called whenever the Edit-tab timeline actually changes) is the only
  durable clip list now; this command's job is just persisting
  `active_clip_id`, touching `modified`, and regenerating `thumb.jpg`.
  `ProjectShotInput` (the old wire type) is deleted — genuinely dead once
  nothing sends it. `chroma_project_relink` (`shot_id` param) had the
  **same latent bug the old shot-strip-sourcing would have had**: it
  looked up `manifest.shots.iter().find(|s| s.id == shot_id)`, which
  silently finds nothing for any clip not also backed by a legacy shot —
  found and fixed in the same pass (renamed to `clip_id`, resolves against
  the active timeline's clips directly, re-points the clip's own
  `source_path`/`name` — its own ground truth, not solely derived through
  `media_id` the way `ProjectShot` was — plus the underlying `MediaItem`
  if one exists). `useSessionStore.ts`'s `relinkShot` sends `clipId` now
  (was `shotId`); its own exported call signature (`relinkShot(shotId,
  newPath)`, `ShotStrip.tsx`'s call site) is unchanged.
- **`useSessionStore.ts` rewrite.** No new IPC surface invented beyond the
  three project-mutating commands above — `chroma_project_open`'s existing
  `ProjectOpenDto` already carried enough once `open_manifest` sources it
  from clips (checked what was already wired before adding anything, per
  the dispatch). `SessionShot` gained `id` (a clip id for a real project,
  a plain path for an in-memory "Untitled" session); `grades` keys off it.
  The decode session (`chroma::session`, path-keyed) is **not** retired
  this pass — deliberately, matching the scoping doc's "explicitly
  deferred" list — so `id` is attached on top of a raw
  `chroma_session_list()` read by matching source path against the
  project's clip list (`reattachIds`/the `pathToClipId` map in
  `_hydrateOpenDto`), never carried by the decode session itself.
  **Documented, known limit of not retiring it:** two *different* clips
  sharing the exact same `source_path` (two trims of one file — the
  doc's own flagged "genuinely new complexity") collapse onto one decode-
  session entry (upsert-by-path), so only one is independently
  switchable/viewable in the Colorist tab at a time today; their grade
  files still stay genuinely separate on disk (keyed by clip id), this
  only affects which one's pixels are currently shown. `addShots`/
  `removeShot` branch on whether a real project is loaded: project-backed
  now calls `chroma_project_add_shot_paths`/`chroma_project_remove_clip` +
  `_hydrateOpenDto` (real timeline mutation); an in-memory Untitled
  session keeps the old plain `chroma_session_add`/`_remove` path
  unchanged. `shotIds: Record<path, id>` (the old bridging map) is deleted
  — genuinely dead once `SessionShot.id` carries the id directly (grepped
  the whole app first to confirm nothing else read it).
  `ShotStrip.tsx`/`SourcesPanel.tsx`/`useChromaControl.ts`'s
  `get_state.session.shots[].hasGrade` all updated to key off `shot.id`.
- **Verification — real numbers, not vibes.**
  - `cargo test -p chroma-timeline`: **37/37** (32 baseline + 5 new
    `media_id` tests).
  - `cargo test --manifest-path app/src-tauri/Cargo.toml chroma::`:
    **135 passed, 0 failed, 1 ignored** (126 baseline + 10 net new: 2
    rewritten-in-place `new_project_in`/`chroma_project_save` tests kept
    their names but changed bodies; net *additions* are the 6 grade-
    migration tests, `remove_clip_by_id_lifts_it_and_clears_active_clip`,
    `resolve_active_clip_index_prefers_…`, and the 2 `top_wins_clip_index`
    tests — 1 ignored is the real-project harness below, by design, not a
    skipped failure).
  - `cargo build --workspace`: clean (only pre-existing, unrelated
    `ai_processing.rs` dead-code warnings).
  - `npx tsc --noEmit -p app`: **64 errors — byte-for-byte the same set**
    as the pre-existing baseline (diffed the two error lists, zero new,
    zero fixed). `npx tsc --noEmit -p packages/editor`: **0 errors**.
    `npx vitest run` in `packages/editor`: **35/35** (2 new
    `clipFromDraggedMedia` tests added to `timeline.test.ts`).
  - **The mandatory real-project verification
    (`chroma::project::tests::migration_against_the_real_owner_project`,
    `#[ignore]`d by default — machine-specific, run with `--ignored`).**
    Copies `~/Movies/Chroma/New.chroma/project.json` + `grades/` into a
    scratch `tempdir` (never touches the live path — confirmed after the
    run: the live `grades/` dir's file list is unchanged, byte-identical
    file names, mtimes only advanced on `e4d7b687-*.grade.json` from the
    owner's own concurrent live use of the app, not from this test). Real
    output from a real run against the real file, this session: **3
    `ProjectShot`s, 2 timelines (`active_timeline=0`), 3 video clips on
    the active timeline; `migrated=0`, `warnings=2`.** Both warnings are
    real "no matching clip on the active timeline" cases (shots
    `e4d7b687…` and `786f86bf…` — graded but never dragged onto the Edit
    tab). The third shot (`8022aef1…`) needed **zero** renaming: its one
    matching clip (found via the `shot_id` backlink — see above) already
    has the identical id, since `Timeline::from_shots` copied it verbatim
    — a genuine no-op, not a bug. **Nothing lost:** 5 grade files / 41,846
    bytes total before, 5 files / 41,846 bytes after — asserted by the
    test itself (byte-count and filename-set equality), not eyeballed.
  - **Live `npm run tauri:dev` boot: not attempted, honestly.** Port 1420
    was occupied (`lsof -ti:1420` returned two PIDs — the main checkout's
    own dev server, per the dispatch's own instruction not to fight it),
    and this sandbox has no screen-recording/window-capture access to a
    native Tauri window regardless of port (the same standing limitation
    D-046/D-051/D-058/D-064 each already hit) — an alternate-port boot
    would only prove "it compiles and starts," which `cargo build
    --workspace` already proves, not "Colorist shows the right clip,"
    which is what would actually matter and can't be observed here. The
    scratch-copy migration test above is the real, non-optional
    verification; this is the honestly-skipped bonus, not a silent gap.
- **Process note.** `rustfmt --edition 2024` given a crate-root file
  (`app/src-tauri/src/lib.rs`) alongside leaf files in the same command
  reformatted the *entire* reachable module tree (13 files this session
  never touched — `session.rs`, `state.rs`, `grade.rs`, `commands.rs`,
  `decode_pipe.rs`, `depth.rs`, `export.rs`, `load.rs`, `mask.rs`,
  `playback.rs`, `sidecar.rs`, `video.rs`, `mask_generation.rs`) —
  caught immediately via `git status --short` right after running it,
  before building or testing on top of it, and reverted with `git
  checkout HEAD --` for exactly those 13 files (kept the formatting on
  the 5 files actually touched this pass). Same class of trap this
  repo's own CLAUDE.md now calls out by name (a bare crate-tree
  `rustfmt`/`cargo fmt` reformats far more than intended) — worth a
  second data point that it also triggers when a crate-root file is
  merely *one of several* paths passed to `rustfmt`, not just via a
  no-args invocation.

## D-071 — Colorist wasn't actually live-synced to the Edit tab: a real gap D-070 left behind

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** Owner's live retest of D-070, right after it landed: dragged
  a clip onto the Edit tab's timeline, switched to Colorist — the clip
  wasn't there. Separately, a screenshot showed a clip ("pexels_28808272")
  still in the Colorist shot strip that had already been deleted from the
  media pool entirely.
- **Root cause, confirmed by reading the actual call graph, not assumed:**
  `chroma_timeline_set` (`chroma::edit`, the Edit tab's own save path — fired
  on every drag/trim/split via `packages/editor`) never calls
  [`open_manifest`], the one function that scans the active timeline's real
  clips and refreshes `state::Session`. D-070 made `chroma_timeline::Clip`
  the source of truth for *what Colorist grades*, but nothing was ever wired
  to tell Colorist *when* that source of truth changed outside of a full
  project (re)open or Colorist's own add/remove-clip buttons — grepped the
  whole app: `syncFromRust` (the function whose name suggests exactly this
  job) is never called anywhere, dead code. Separately, `state::Session`
  (the in-memory decode session Colorist's shot strip ultimately reads) was
  never *pruned* by anything short of a full reset (`set_current_video
  (None)` on every full open) — a clip removed from the project (by any
  path) stayed in the session forever, explaining the ghost shot.
- **The fix is deliberately not "just call `chroma_project_open` again."**
  That would work for correctness but has a real cost: it unconditionally
  re-runs `resolve_active_clip_index`/`top_wins_clip_index` and reloads,
  which would silently reset whichever clip the owner had manually selected
  in the Colorist shot strip back to the top-wins/legacy default on every
  resync — discarding a real, in-progress grading choice for no reason if
  nothing on the timeline actually affected it.
- **New `chroma_project_resync_clips`** (`app/src-tauri/src/chroma/
  project.rs`) — re-reads the manifest fresh, diffs the active timeline's
  clips against `state::Session`, and: decodes + upserts any genuinely new
  clip; prunes any session shot whose clip is no longer on the timeline at
  all (`Session::prune_except`, new, `state.rs` — the ghost-shot fix); **only
  re-resolves the active clip if the one that was active before the resync
  is one of the pruned ones** — otherwise its position in the returned list
  is just wherever it already was, completely untouched (no re-seek, no
  thumb/decode-pipe reset). Reuses `active_timeline_video_clips`/
  `resolve_active_clip_index`/`top_wins_clip_index` — all already tested by
  D-070/D-056, no new selection logic, only new diff/prune logic around them.
- **Frontend:** `useSessionStore.resyncClips` (new) calls it, then only
  calls `applyLoaded` (the real "switch what's on screen" step) if the
  active clip's id actually changed between before and after — comparing
  outcomes, not re-deciding them, so frontend and backend can't disagree.
  Deliberately passes `loaded: null` to `applyLoaded` rather than a second
  `chroma_session_set_active` round trip: the pixels were already installed
  server-side inside the resync call itself (it calls the same
  `seek_and_install` `open_manifest` does), and `applyLoaded` already falls
  back to the decode-session's own width/height/etc when `loaded` is absent
  — a second decode would just be wasted work. Deliberately does **not** set
  `busy` (D-063's full-screen loading-spinner flag) — that spinner should
  only show for a real clip switch, not a background poll that usually
  changes nothing.
- **Trigger: Colorist tab focus, not every Edit-tab keystroke.** Wired in
  `app/src/main.tsx`'s `Root()` (the composition root — same bridge shape as
  the existing B-007 fix, `app` owns the tab-switch signal,
  `useSessionStore` owns the resync), firing whenever `useActiveTab()`
  becomes `'colorist'`. Accepted trade-off: the shot strip can be
  momentarily stale while you're still on the Edit tab mid-edit — acceptable
  since `chroma_project_resync_clips` is specifically built to be cheap and
  non-disruptive to call on every switch, so the fix is "always fresh by the
  time you look," not "instantly reactive to every keystroke."
- **Verification.** New `Session::prune_except` tests (pure model, no Tauri
  state — `chroma::state::tests`, 3 new): drops only what's outside `keep`,
  keeps the active shot active when it survives, a real no-op when nothing's
  pruned. `chroma_project_resync_clips` itself is a state-taking Tauri
  command — deliberately not unit-tested directly, matching this module's
  own established convention (`open_manifest`'s own doc: "no other test in
  this module drives the state-taking commands directly"); its only genuinely
  new logic (the diff/prune decision) is exercised through those pure
  `Session` tests, and every selection/decode helper it calls was already
  covered by D-070/D-056's own tests. `cargo test --manifest-path app/
  src-tauri/Cargo.toml chroma::`: **138 passed, 0 failed, 1 ignored** (135
  baseline + 3 new). `cargo build --workspace`: clean. `tsc --noEmit -p
  app`: 64/64, unchanged baseline. No live-window click test this pass —
  noted honestly, not glossed over; the owner's next real drag-then-switch
  is the actual confirmation, same standing gap every interaction-level fix
  this session has had.

## D-072 — Edit-tab timeline: plain trackpad scroll now pans, only a real pinch (or Ctrl+scroll) zooms

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** Owner, live: "when i scroll instead of scrolling its zooming
  in and out... two things with track pad, one is scroll and one is zoom,
  both have different gesture" — a trackpad's plain two-finger scroll and a
  pinch are two distinct physical gestures; D-051's original scroll-wheel
  zoom treated every `wheel` event the same, so scrolling was impossible.
- **Fix — the standard web convention, not a new one.** A real pinch
  (trackpad) and an explicit Ctrl+scroll (the same shortcut most web/canvas
  apps already give mouse users) both arrive as a `wheel` event with
  `ctrlKey: true` — synthesized by the browser itself for a pinch,
  regardless of whether a physical Ctrl key is actually held. A plain
  two-finger scroll arrives with `ctrlKey: false`. `TimelinePane.tsx`'s
  wheel listener now only zooms on `ctrlKey`; everything else returns
  immediately (no `preventDefault`, nothing handled), falling through to
  the library's own scrollable edit-area container (`overflow: overlay` in
  its bundled CSS — real native browser scroll D-051's own doc already
  correctly identified as available, just never actually reachable because
  the zoom handler was intercepting every wheel event first regardless of
  `ctrlKey`).
- **Verification.** `tsc --noEmit`: `packages/editor` 0/0, `app` 64/64
  unchanged baseline. `vitest run` in `packages/editor`: 35/35, unchanged
  (this is a native DOM listener on a live component, not something this
  codebase's established pattern unit-tests directly — see `TimelinePane.tsx`
  itself, never covered by the pure-logic vitest suite). No live click test
  this pass — noted honestly; the owner's own next real trackpad scroll is
  the actual confirmation (their "yes worked" the same session was D-071's
  live-sync fix, confirmed *before* this one was even written — not to be
  conflated with it).

## D-073 — Relight depth source: Bake fires itself, Track Depth becomes a deliberate bottom "finalize" action

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** Owner, live: with a fresh light dropped and no depth source
  yet, the panel showed two equal-weight buttons ("Track Depth" and "Bake
  Depth") side by side with no guidance on which to press — "see this its
  stuck on 0 and for one image right we it should be in a flash anything
  less than that processing and all no live feedback kills the purpose of
  relight." Then, directly: "if its bak depth we should automatically call
  it not let user do it we do not know and keep the Track depth in the
  bottom like a final button in this panel so we know its a full thingy."
  Track Depth (D-036's real per-frame pass over the whole clip) is also
  genuinely heavy — confirmed capable of crashing the AI sidecar this same
  session (729% CPU, 1GB+ RSS, OS-killed with no Python traceback,
  processing a 12,414-frame 4K clip), so surfacing it as an equal, easy
  first choice next to the cheap single-frame bake was actively misleading.
- **Fix.** Bake Depth (`useAiMasking.ts`'s `handleBakeRelightDepth`, a few
  seconds, single-frame `generate_full_image_depth_map`) now fires itself
  via a `useEffect` in `RelightPanel.tsx` the moment a positional light
  exists with neither `relightDepthDir` nor `relightDepthBake` set and no
  bake/track already in flight — no button, just a status line ("Generating
  a quick depth preview…" → "Quick preview ready…") with a small `RotateCw`
  re-bake icon for after a scrub. Track Depth (`handleTrackRelightDepth`,
  D-036's `chroma_depth_track`) moved to its own compact section at the very
  bottom of the panel — an icon-only `Button` (`Video`/`Loader2`) plus a
  separate `Info` icon, both wrapped in real `@chroma/ui`
  `Tooltip`/`TooltipProvider`/`TooltipTrigger render={<Button/>}` (matching
  the precedent already established in `TimelinePane.tsx`'s own toolbar) —
  explanation on hover instead of a permanent paragraph, per the owner's
  direct follow-up: "keep the track full depth at right bottom with I icon
  instead of so much text" and "use the proper our component library."
- **Known gap, not fixed this pass.** The auto-bake effect has no guard
  against retrying forever if a bake genuinely fails — `isBakingRelightDepth`
  resets to `false` in the hook's own `finally` regardless of success, which
  re-satisfies the effect's condition on the next render. Not yet hit live;
  flagged here rather than silently left for whoever next touches this
  effect. A real fix needs a per-clip "already attempted" ref plus a manual
  retry affordance in the empty-state branch.
- **Verification.** `tsc --noEmit -p app`: 64/64, unchanged baseline (no
  Rust/shader surface touched by this one). No live click test this specific
  pass — the owner's screenshots through this same session (#150–153) are
  what drove each iteration of the fix, so it was live-tested continuously
  rather than at one final checkpoint.

## D-074 — Relight light puck: dragging it also scrubbed the video frame (B-021)

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** Owner, live, screenshot: "when i move this the frame is
  moving as well please fix it" — dragging a light puck on the Colorist
  canvas to reposition it was also scrubbing/changing the currently
  displayed frame.
- **Cause.** `Editor.tsx` registers its own pan/zoom pointer handler as
  `onPointerDownCapture` on an ancestor of `RelightPuckLayer`'s pucks —
  capture phase fires strictly *before* any descendant's own bubble-phase
  `onPointerDown`, regardless of that descendant later calling
  `e.stopPropagation()`. `RelightPuckLayer`'s puck already called
  `stopPropagation()` in its own `handlePointerDown`, which is structurally
  incapable of undoing side effects Editor's capture-phase handler had
  already run by the time it fires — propagation control from a bubble-phase
  child cannot reach back into an ancestor's capture-phase listener.
- **Fix.** `RelightPuckLayer.tsx`'s draggable puck `<div>` gets
  `data-relight-puck="true"`. `Editor.tsx`'s capture-phase
  `handlePointerDown` checks `(e.target as HTMLElement).closest('[data-
  relight-puck]')` as its very first line and returns immediately if it
  matches — the only reliable fix, since it lives on the side that actually
  fires first. `stopPropagation()` was also added to the puck's
  `handlePointerMove`/`handlePointerUp` (previously only on `PointerDown`) as
  defense-in-depth against any *other* bubble-phase ancestor listener, not
  as the primary fix.
- **Verification.** `tsc --noEmit -p app`: 64/64, unchanged baseline. No new
  automated test — this is a DOM pointer-capture-order interaction on a live
  canvas overlay, not something this codebase's pure-logic suites reach; the
  owner's next live drag is the real confirmation.

## D-076 — Relight positional lights need an explicit "distance" (z-offset), not just screen-space x/y/radius

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** Owner, live, with a fully-configured positional light (color,
  Power=200, Distance=55 — the *old*, mislabeled slider — puck positioned on
  the subject, depth bake confirmed ready): "just so you know nothing is
  getting applied at all." Then, on seeing the actual three sliders this
  session's polish pass had produced (Power / Distance / Radius): "we have
  radius distance and power, so distance is not radius but the z index, the
  depth actually" — correctly identifying that the panel had no real depth
  control at all.
- **Root cause.** `RelightLight` (`adjustments.ts`) only ever carried
  `x`/`y` (2D screen position) and `radius` (2D falloff size) — there was no
  z/depth field. The panel's "Distance" slider was bound to `radius`, not a
  real distance. In `apply_relight` (`shader.wgsl`), a positional light's z
  was derived *implicitly* by sampling the depth map at the light's own
  anchor pixel (`light_depth`) and comparing it against each shaded pixel's
  own depth (`pixel_depth`): `delta_z = (light_depth - pixel_depth) * 3.0`.
  On real footage — a face or torso, relatively flat in depth near wherever
  a light actually gets dropped — `light_depth ≈ pixel_depth` for every
  nearby pixel, so `delta_z ≈ 0`, `light_dir` ends up almost purely
  in-plane, and `dot(surface_normal, light_dir)` (the shading term) collapses
  to ~0 almost everywhere the light could plausibly matter. The light was
  never actually *elevated* off the surface — it always sat exactly flush on
  whatever depth value its own drop point had. This is the root cause of
  "nothing is getting applied at all"; it predates every infrastructure fix
  made earlier this session (stale/crashed sidecar, D-071 sync, D-072
  trackpad) and was never masked by them — no live confirmation of a visible
  relight effect had occurred *at any point* this entire session.
- **Fix.** Added a real `distance` field (0–100 UI, same units as the depth
  map's own 0–1 normalized range once divided by 100) throughout the whole
  stack:
  - `RelightLight.distance` (`adjustments.ts`), `RelightLightSpec.distance`
    (`relight.rs`, default `40.0` — nonzero on purpose, see below), parsed
    in `parse_relight_lights` and scaled in `parse_relight_lights_gpu`
    (`/100.0`, same convention as `pos_x`/`pos_y`/`radius`/`intensity`).
  - `RelightLightGpu` (`image_processing.rs`) and its WGSL mirror
    `RelightLight` (`shader.wgsl`) both gained a `distance: f32` field, with
    3 `f32` pad fields to keep the 16-byte-row GPU struct layout intact (was
    8 f32s / 2 rows, now 9 real + 3 pad / 3 rows).
  - `apply_relight`'s z computation now adds the light's own `distance` to
    the surface depth sampled at its anchor before comparing against the
    shaded pixel: `delta_z = ((light_depth + light.distance) - pixel_depth)
    * 3.0` — the light is now genuinely elevated off the surface toward the
    camera by a real, independent amount, not implicitly flush with it.
  - `RelightPanel.tsx`: the old mislabeled "Distance" slider (→ `radius`) is
    now correctly labeled "Radius"; a new "Distance" slider (→ the real
    `distance` field) sits above it, matching the owner's own observed
    Power/Distance/Radius order. `distance` added to the D-034 keyframe
    params (`GEOMETRY_KEYS.relight` in `maskKeyframes.ts`) alongside
    `x`/`y`/`radius`.
  - Default `distance` is **40** (nonzero), not 0 — `KIND_DEFAULTS` in
    `relightUtils.ts` and `RelightLightSpec::default()` in `relight.rs` both
    set it — because 0 is the exact degenerate "flush on the surface" case
    that caused this bug; a freshly added light needs to look lit
    immediately, not require the owner to first discover a slider.
- **Verification.** New Rust tests in `relight.rs`:
  `distance_field_parses_and_defaults` (parses + scales correctly, defaults
  to 40 when absent) and — the real regression guard —
  `positional_light_needs_nonzero_distance_to_shade_a_flat_surface`, which
  renders through the actual GPU shader (`render_core::render`, skips if no
  GPU adapter) against a perfectly flat synthetic depth bitmap (the
  worst-case, closest-to-real-footage scenario the existing
  `relight_render_is_deterministic` test's strong radial gradient doesn't
  exercise) and asserts a `distance == 0` light renders **byte-identical**
  to no light at all, while a light with real `distance` renders visibly
  differently — this test would have caught the original bug and fails if
  the fix is reverted. `cargo test --manifest-path app/src-tauri/Cargo.toml
  chroma::`: **140 passed, 0 failed, 1 ignored** (138 baseline + 2 new).
  `cargo build --manifest-path app/src-tauri/Cargo.toml`: clean. `tsc
  --noEmit -p app`: 64/64 unchanged baseline. `tsc --noEmit -p
  packages/editor`: 0/0. `vitest run` in `packages/editor`: 35/35. No live
  click test yet this pass — the owner's next live drag/light session is the
  real confirmation that positional lights now visibly shade real footage.

## D-077 — Relight: a real AI-estimated surface normal (MoGe-2), not a depth finite-difference

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** After D-076 made positional lights visible at all, the owner's
  live read was blunt: "instead of putting relight feels like a light blob —
  that not light that's just color," followed by "are we using proper model?
  to relight? or just CSS in front an overlay?" — a fair challenge, since
  `apply_relight`'s `relight_normal()` was never a real surface reconstruction:
  it finite-differences the depth *texture itself* (a heightfield trick on one
  blurry monocular depth channel) to fake a normal. On a real face — locally
  flat in depth away from strong edges — that normal barely varies, so the
  N·L shading term barely varies either: the light reads as a falloff-masked
  colour wash, not directional light.
- **Research (not guessed).** Confirmed relight IS real-time-achievable
  locally, same as this app: DaVinci Resolve's Relight FX computes an actual
  neural-network surface-normal map (its Neural Engine), then does real-time
  GPU light physics against it — same "AI bakes a map once, shader shades
  live against it" shape D-036's depth track already established here, not a
  slow diffusion pass (ClipDrop/IC-Light-class tools paint the whole image
  via diffusion, seconds per frame — a different, much heavier category, not
  viable for a live draggable puck on video).
  - **DSINE (Bae & Davison, CVPR 2024)** — the natural fast, non-diffusion
    single-image normal estimator — was evaluated and **rejected**: Imperial
    College London's licence is academic/non-commercial only, and Chroma
    ships as a real product (same bar D-036's video-depth vendoring already
    applies).
  - **Microsoft MoGe-2 (CVPR 2025)** — MIT licence (DINOv2 backbone
    Apache-2.0, Meta), plain PyTorch ops (no CUDA-only kernels), a small
    35M-param `-normal` checkpoint (`Ruicheng/moge-2-vits-normal`,
    Hugging-Hub-hosted). MoGe-**3** (the newer default) was ruled out
    separately — it hard-depends on `flex-gemm`/Triton, which publishes no
    macOS wheels, dead on arrival on this Apple-Silicon stack; MoGe-2 has no
    such dependency.
  - Verified end to end on this machine BEFORE writing any integration code
    (house discipline: no plumbing built on an unverified model): loads and
    infers on MPS, ~0.65s warm at 1080p, ~0.8s at 4K — one real MPS-specific
    bug found and worked around (`infer(..., use_fp16=True)`, the default,
    crashes with "Input type (c10::Half) and bias type (float) should be the
    same" — an autocast dtype bug in MoGe-2's own fp32-output-projection path
    on MPS, not a device-selection issue on our side; fixed by always passing
    `use_fp16=False`).
- **Integration — vendored, not pip-installed**, same rationale + shape as
  `ai/vendor/video_depth_anything/` (D-036): a clean diff, the licence travels
  with the code, and MoGe's own published package unconditionally pulls in
  `flex-gemm`/Triton/gradio/trimesh deps for its v1/v3 code paths we don't
  use and can't even install on macOS. `ai/vendor/moge/` keeps only
  `model/v2.py` and its real import closure (see `ai/vendor/README.md`'s
  `moge/` entry for the exact file list and what was trimmed).
- **Pipeline (mirrors D-054's depth-bake shape throughout):**
  - `ai/server.py`: new `/generate_normal_map` endpoint (single frame,
    synchronous — no job/poll, unlike `/depth_track`, since inference is
    under a second) — lazy-loads MoGe-2, runs it with `use_fp16=False`,
    returns an RGB-encoded normal-map PNG. Encoding: `(n + 1) / 2 * 255` per
    channel, Z **flipped first** so the sign matches this codebase's own
    existing convention (Z+ = toward camera, same as `relight_normal`'s
    existing finite-difference output) rather than MoGe's native OpenCV
    camera-space convention (Z+ = into the scene).
  - `app/src-tauri/src/ai_commands.rs`: new `generate_full_image_normal_map`
    Tauri command — same warped-image source
    (`get_cached_full_warped_image`) and `data:image/png;base64,...` return
    convention as `generate_full_image_depth_map`, but POSTs to the sidecar
    over HTTP instead of running in-process ONNX (MoGe-2 isn't vendored as
    ONNX — same reason D-036's video depth needs the sidecar and the static
    depth bake doesn't).
  - `app/src/utils/adjustments.ts`: new `relightNormalsBake: string | null`
    field, `null` until "Bake Normals" runs — everything renders exactly as
    before D-077 until then.
  - `RelightLightGpu`/`AllAdjustments` (`image_processing.rs`) +
    the WGSL mirror structs: new `relight_normal_layer: i32` field
    (repurposed from an existing pad field, `_relight_pad1`, so no new
    padding/alignment work) — the first of **three** consecutive
    `mask_textures` array layers (X, Y, Z). One index, not three, because
    `mask_generation::resolve_relight_normal_bitmap` always pushes them as a
    contiguous block. `mask_textures` is single-channel throughout (every
    other consumer reads one `.r` per layer) — three layers per normal map
    rather than a new texture format, matching that existing constraint
    rather than fighting it. `-1` default (same "0 is a valid index, -1
    means none" convention `relight_depth_layer` already established); a
    project with 29+ existing masks *could* theoretically overflow
    `MAX_MASKS` (32) once relight's depth (1) + normal (3) layers are added
    on top — a pre-existing risk class D-054's depth layer already carries,
    now worse by 3x. Not fixed here (would need a real capacity-management
    pass), noted honestly.
  - `shader.wgsl`'s `apply_relight`: new `sample_relight_baked_normal()`
    reads the three layers and decodes back to a unit vector; `apply_relight`
    uses it in place of `relight_normal()`'s finite-difference whenever
    `normal_layer >= 0`, otherwise falls back exactly as before D-077.
    `pixel_depth` (for D-076's light-distance z-comparison) still comes from
    the depth layer regardless — the baked normal replaces the *shading
    normal* only, not the depth signal.
  - `RelightPanel.tsx`: "Bake Normals" is a **deliberate action** (a button
    + tooltip, not auto-fired like Bake Depth) — it hits the AI sidecar over
    HTTP for a real trained model (can take ~15s cold, first-run model
    download) rather than the instant in-process ONNX depth path, closer to
    Track Depth's "heavier, ask first" tier. Gated on a depth source already
    existing (a normal alone still can't shade — `apply_relight` needs
    `pixel_depth` regardless).
- **Verification.** Two new real-GPU regression tests in `relight.rs`
  (skip, don't fail, with no GPU adapter — same convention every other
  GPU-touching test here uses): `positional_light_needs_nonzero_distance_...`
  and `positional_light_shades_subject_even_when_puck_sits_over_background`
  updated for the corrected absolute-distance semantics (see below);
  `baked_normal_layer_changes_shading_vs_the_depth_derived_fallback` proves
  `relight_normal_layer` is actually read by the real shader (identical
  lights/depth, differing only in whether a baked normal is bound — asserts
  the renders differ), not just that it compiles.
  `resolve_normals_bake`/`distance_field_parses_and_defaults` etc. covered
  by ordinary unit tests. `cargo test --manifest-path
  app/src-tauri/Cargo.toml chroma::`: **142 passed, 0 failed, 1 ignored**.
  `cargo build`: clean. `tsc --noEmit -p app`: 64/64 unchanged baseline.
  Sidecar endpoint verified independently via `curl` before any Rust glue
  was written (`/health` reports `relight_normals`, `/generate_normal_map`
  round-tripped a real image, decoded output cross-checked byte-for-byte
  against the expected `(n+1)/2*255` encoding by hand). No live in-app
  confirmation yet this pass — pending the owner's next live test.

## D-076 (correction, same day) — `distance` is an absolute z-coordinate, not an offset from the puck's own anchor depth

The D-076 entry above was written and shipped once, then found to still fail
live: owner, screenshot, puck parked beside the subject on open background —
"just so you know nothing is getting applied at all" persisted. Root cause:
that first fix computed `delta_z` as `(light_depth_at_the_pucks_own_xy +
distance) - pixel_depth` — the puck's own anchor pixel still set the
*baseline* depth, so a puck dropped over background (not on the subject)
anchored the light to the *background's* depth. Adding `distance` on top
wasn't enough to bridge a background-to-subject depth gap.

**Fix:** `distance` is now the light's own absolute position in the depth
map's normalized space, full stop — `delta_z = (light.distance -
pixel_depth) * 3.0`, no dependency on whatever's behind the puck's `(x, y)`
at all. Puck position now *only* drives the screen-space direction
(`delta_uv`) and the falloff radius, matching how a real point light in a 3D
scene is positioned (a genuine coordinate, not "wherever this happens to be
dropped on the depth map"). Default bumped from 40 to **85** (out of 0–100)
accordingly — low defaults meant "behind" any typical near-camera subject
regardless of distance now being absolute, since there's no per-shot
calibration for what a "typical" depth value even is. Verified with a new
two-region-depth GPU test
(`positional_light_shades_subject_even_when_puck_sits_over_background`) that
reproduces the exact reported scenario: puck over a synthetic "background"
region, shading checked on a separate synthetic "subject" region the puck
never touches.

## D-077 (addendum, same day) — MoGe-2's own depth, not a separate Depth-Anything-V2 bake

Owner, live, after D-077's normal fix shipped: "Real light and real depth" —
a sharp catch. `/generate_normal_map`'s MoGe-2 inference already computes a
real `depth` field in the SAME forward pass as `normal` (confirmed via a
standalone Python check: `out.keys()` includes `depth`, previously just left
unused). Pairing that normal against the separate Depth-Anything-V2 bake
meant two independently-trained models' estimates of the same face, with no
guarantee they agree — the normal and the depth `apply_relight` shades
against could describe subtly different geometry.

**Fix.** `/generate_normal_map` (`ai/server.py`) now returns both
`normal_b64` and `depth_b64` from the one inference call. MoGe-2's `depth`
is real metric depth (larger = FARTHER, +inf for pixels the model has no
confidence in) — the OPPOSITE convention from every depth bitmap this
codebase already reads ("bright = near", the Depth-Anything-V2/Video-Depth-
Anything convention `sample_relight_depth` assumes everywhere). `_depth_to_b64`
inverts via `1/depth` (also turns `+inf` into exactly `0.0` for free — no
separate invalid-pixel masking needed) then min-max normalizes to 0–255, the
same normalization `run_depth_anything_model` (Rust) already does, so the
Rust/shader side never needs to know which model produced a given bake.
`generate_full_image_normal_map` (`ai_commands.rs`) now returns a small
`RelightGeometryBake { normal, depth }` struct instead of a bare string;
`handleBakeRelightNormals` (`useAiMasking.ts`) writes both
`relightNormalsBake` and `relightDepthBake` from the one response. A real
depth track (`relightDepthDir`, D-036) still wins if one exists —
unchanged precedence — so this only replaces the *static single-frame* depth
source, not a temporally-tracked one.

## D-078 — Relight shading: 2D-only falloff + flat additive colour read as a "fake glow," not light

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** Owner, live, after the D-076/D-077 fixes made positional
  lights visibly affect the frame for the first time all session: "this does
  not look like light... the depth is real but the light is so fake that's
  not what light look like." Screenshots showed a soft, saturated,
  radially-symmetric colour wash centered on the puck — reading as a
  translucent gel laid over the scene, not directional illumination.
- **Two real, fixable causes, both now using data this session already
  built rather than needing another model:**
  1. **Falloff was still 2D-only.** `dist` for `relight_falloff` was pure
     screen-space distance from the puck (`length(coord - light_uv*dims)`)
     — it never looked at depth at all, even though `pixel_depth` and
     `light.distance` (D-076) were already being computed two lines away
     for the *direction* vector. A background sitting at a completely
     different depth from the light got an identical soft falloff circle to
     a subject at the light's own depth, painting a flat 2D disc over
     whatever happened to be behind the puck on screen regardless of how
     far away it actually was in the scene.
  2. **Pure additive colour.** `added += light_color * intensity * fall *
     ndotl` paints a uniformly saturated wash over the entire falloff
     radius, with no relationship to what's already there — an
     already-bright highlight and a shadowed fold get the exact same colour
     added, and a strong light can push a channel straight past 1.0 into a
     flat, clipped colour. Reads as a coloured film over the image, not a
     light source interacting with a lit scene.
- **Fix.**
  - Falloff distance is now the real 3D offset: screen xy (re-derived in
    the SAME "fraction of the longer frame dimension" units `light.radius`
    has always used — NOT `delta_uv`'s aspect-corrected, height-normalized
    units, which are only meaningful for a direction vector, not an
    absolute distance) combined with `delta_z` at the same relative scale
    already used for the direction vector. Something far from the light in
    depth now falls off faster even when it's screen-adjacent to the puck.
  - Compositing switched from flat addition to a **screen blend**: `added
    += light_color * strength * (1 - so_far)`, where `so_far` is
    `base_color + added` so far this pass, clamped 0–1. An already-bright
    pixel receives proportionally less additional colour; a dark/shadowed
    pixel receives more — the direction a real fill/accent light actually
    behaves — and a channel can never blow straight past 1.0 from relight
    alone. Applied to ambient lights too (same "the pixel isn't a blank
    canvas" reasoning), not just positional ones.
  - `light.radius`'s meaning on the screen plane is unchanged (same units,
    same existing saved values still mean what they meant before) — only
    the *depth* dimension of falloff and the *blend* changed.
- **Verification.** `cargo test --manifest-path app/src-tauri/Cargo.toml
  chroma::relight::` — all existing GPU-shader regression tests (D-076's
  distance tests, D-077's baked-normal test) re-verified passing under the
  new blend math, since they assert *whether* a render differs, not exact
  pixel values, so they remain valid regression guards through this change.
  `cargo build`: clean. **Live-confirmed** — owner, next screenshot, blue
  light now falls only on the subject with the background reading
  correctly dim: "light only falls on me which i do like :D."

## D-079 — Relight `distance`: the light was sweeping/rotating across the face instead of moving nearer or farther

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** Owner, live, sliding Distance across several values (23 → 35
  → higher) with screenshots at each: "see the distance right working
  weirdly instead of light coming closer and going in depth, we are getting
  like rounding angle changing." A precise, correct read of the actual
  behavior.
- **Cause.** `delta_z = (light.distance - pixel_depth) * 3.0` fed BOTH the
  falloff/brightness calculation (via `dist3d`, D-078 — correct, distance
  should change brightness/spread) AND the light's DIRECTION vector
  (`light_dir = normalize(vec3(delta_uv, delta_z))`). A real face has real
  depth variation (nose nearer than ears/cheeks) — feeding the SAME
  full-strength `delta_z` into direction meant every change to `distance`
  shifted the incidence angle across every part of the face *simultaneously
  and unevenly*: nose-depth pixels swing toward frontal light while
  ear-depth pixels swing toward grazing/rim light as the single global
  `distance` value moves past each pixel's own depth. The visible result is
  exactly what the owner described — the lit "side" of the face appears to
  rotate/sweep as distance changes, instead of the whole face reading
  uniformly brighter or dimmer.
- **Fix, part 1 (direction damping).** Split `delta_z` into two uses with
  different strengths: full strength still drives falloff (distance
  genuinely should make the light stronger and tighter as it comes closer),
  but the copy that feeds the direction vector is heavily damped
  (`delta_z_dir = delta_z * 0.15`) — distance still shapes the light
  believably (not flattened to literally zero angle variation), it just no
  longer dominates which side of the face looks lit as the slider moves.
- **Fix, part 2 (a real D-078 bug this surfaced).** Re-running the GPU test
  suite after part 1 caught a second, separate, pre-existing bug:
  `positional_light_needs_nonzero_distance_to_shade_a_flat_surface` failed —
  a light with `distance: 95` on a flat depth of `180/255` rendered
  byte-identical to no light at all, anywhere, including directly under the
  puck. D-078's `dist3d` folded the FULL-strength z offset into the exact
  same distance compared against `radius` — so a `distance` meaningfully
  different from a surface's own depth (the entire *point* of `distance`,
  D-076) could make the z component alone exceed `radius` and zero the
  light out completely, everywhere, regardless of screen position. Fixed by
  decoupling: `radius`/`fall` goes back to being a pure screen-space circle
  (exactly what it was before D-078 touched it), and depth-awareness
  becomes a separate multiplier, `z_falloff = 1 / (1 + z_mismatch² × 0.3)`
  — dims a pixel far from the light's own depth, but never fully zeroes it
  the way folding z into the radius-gated distance did.
- **Verification.** `cargo test --manifest-path app/src-tauri/Cargo.toml
  chroma::relight::`: 16/16 (all passing, including the test that caught
  part 2's bug). `cargo test ... chroma::`: 143 passed, 0 failed, 1
  ignored. `cargo build`: clean (after resolving a concurrent-cargo-process
  build corruption unrelated to this specific change — see the build-
  tooling note below). `tsc --noEmit -p app`: 64/64 unchanged baseline.
  Live-confirmed for the OTHER two D-078/D-079 fixes already
  (falloff/blend: "light only falls on me which i do like :D"); this
  specific distance-sweep + radius-zeroing combination fix is pending the
  owner's next live retest.

**Build-tooling note (not a product change):** repeatedly hit a real,
reproducible linker corruption (`nalgebra::geometry::reflection` anonymous
LLVM symbols going missing at final link) whenever a manual `cargo
build`/`cargo test` ran concurrently with `cargo tauri dev`'s own background
`cargo run` against the same `target/` directory — not incremental-cache
flakiness (clearing `target/debug/incremental` alone didn't fix it; a full
`rm -rf target/debug` did). Going forward this session: never run a manual
cargo command while the dev app's own build/watch process might be active;
check `ps aux | grep cargo` first.

## D-080 — Multi-track UI (Phase D of `docs/notes/multi-track-nle.md`)

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** Owner, stepping away mid-session: "work on the composition
  UI please, or let a sub agent do it, don't sit idle." Per the roadmap
  (item 6, `docs/notes/multi-track-nle.md`), Phase D — an actual multi-track
  timeline UI, multiple visible lanes with track headers — was the next
  unblocked piece: Phase A (clip positions, add/remove-track ops) and C
  (audio mixing) were done, B1 (2-track opaque compositing) was done, and B2
  (N tracks) was *claimed* to already generalize with no new code but had
  never actually been exercised past two tracks.
- **B2 confirmed first, before building UI on top of an unverified claim.**
  `chroma-timeline`'s `resolve_video_clip_at` is a plain `.filter().
  find_map()` walk over every video track in index order — genuinely no
  hardcoded track count. New `three_video_track_timeline` fixture + two
  tests confirm it: top-wins with all three tracks populated, and — the
  real gap in coverage — a query frame that has to fall through **two**
  consecutive gaps (track 0 exhausted, track 1 also exhausted) to reach
  track 2, which a "top, then one fallback" implementation would get wrong
  but the real filtered-walk implementation doesn't. `cargo test -p
  chroma-timeline`: 39/39 (+2).
- **The pure edit model (`packages/editor/src/timeline.ts`) was already
  fully multi-track-shaped** — every existing op already takes a `track`
  index, `Track`/`Timeline` already have no fixed-count assumption. The
  real gap was entirely in `TimelinePane.tsx`, which only ever rendered
  `videoTrackIndex(tl)` (the first video track) as a single hardcoded row,
  and in the op vocabulary itself lacking track-list-level operations.
  Added: `Track.gain` (mirrors `chroma_timeline::Track::gain`, D-057 —
  wasn't in the TS type at all before this), and three new `EditOp`
  variants — `add_track`, `remove_track`, `set_track_gain` — each mirroring
  its Rust counterpart's exact validation (`add_track` always succeeds;
  `remove_track`/`set_track_gain` no-op on an out-of-range index, matching
  `NoSuchTrack`). `move` changed from a single `track` field to
  `fromTrack`/`toTrack`, mirroring `Timeline::move_clip(from_track,
  from_idx, to_track, to_start_frame)` — same-track is just the
  `fromTrack === toTrack` case, same as the Rust op. `packages/editor`
  `vitest run`: 45/45 (+10 new: cross-track move incl. its own overlap
  check, add/remove-track, set_track_gain, updated `move`/label tests for
  the field rename).
- **`TimelinePane.tsx` — the actual UI, checked against the library's real
  API before assuming anything:**
  - One `TimelineRow` per track (`buildRows`, was `buildRow` returning a
    single hardcoded video row), `row.id` = the track's own index —
    `@xzdarcy/react-timeline-editor` always hands the row back in every
    action/click callback, so this is the one stable way to map back to
    `timeline.tracks[i]`.
  - **Track headers are a fully custom sidebar, not a library feature** —
    read the library's bundled `.d.ts` first (`EditData`'s full prop list)
    and confirmed there's no `getRowHeaderRender` or equivalent, only
    `getActionRender`/`getScaleRender` for *content inside* the scrollable
    area. Built a real sidebar column (`HEADER_WIDTH`, one `ROW_HEIGHT`
    block per track: kind icon, a running per-kind label — "Video 1",
    "Audio 1", "Video 2" — a mute toggle on audio tracks writing `Track.
    gain` 0/1 — D-057's mixer already reads this field, no new "muted"
    concept to drift out of sync with — and a remove-track button), kept in
    vertical sync with the library's own scroll via its real `onScroll`
    prop (`OnScrollParams.scrollTop`) applied as a CSS transform. "Lock" /
    "solo" are standard NLE affordances with no backing `chroma_timeline::
    Track` field yet — not faked with frontend-only state `chroma_
    timeline_set`'s verbatim-storage contract wouldn't actually persist;
    left for whenever the model grows those fields.
  - **No native cross-row drag** — also checked before assuming: read
    `onActionMoveEnd`'s params (`{action, row, start, end}` — `row` is
    always the action's *starting* row) and `drag_utils.d.ts`/`onRowDragStart`
    /`onRowDragEnd` (for dragging a whole ROW to reorder rows — a different
    feature, `enableRowDrag`) — there's no drop-target-row concept anywhere
    in the library's action-drag path. A live drag-clip-between-tracks
    gesture would need a custom pointer-driven override of the library's
    own drag handling; scoped out of this pass and flagged as a known real
    gap, not silently omitted. Built a working, non-drag substitute
    instead: a "Move to ▾" dropdown on the toolbar (`@chroma/ui`'s
    `DropdownMenu`), enabled when a clip is selected and more than one
    track exists, listing every other track by its label — fires the new
    cross-track `move`, clip keeps its own `start_frame` (overlap-rejected
    at the destination, same as any other `move`).
  - **Dropping a Sources-panel clip targets whichever lane the cursor is
    over.** D-046 pass 3's plain-HTML5-drag mechanism (native drag/drop
    crossing the shell/tab package boundary the D-039 layer direction
    forbids a shared `DndContext` from crossing) generalized to be
    row-aware: `dropTargetTrack` converts the drop's `clientY` into a track
    index using the library's own fixed layout constants read straight out
    of its bundled CSS (`.timeline-editor-time-area`'s 32px ruler +
    `.timeline-editor-edit-area`'s 10px `margin-top` — not guessed) plus
    the tracked `scrollTop`, clamped to a real track index; falls back to
    the first video track (the old, only, default) if the pointer lands
    outside every row.
  - **Selection is now `{track, id}`, not a bare action id** — with one
    track, an id alone was unambiguous; `Split`/`Remove`/`Move to ▾` all
    need to know which track's clip list a selected id lives in now.
  - **`Split` now requires a selection** (was: split whatever's on "the"
    video track under the playhead, unconditional on selection — there was
    only ever one track to mean). A real, deliberate behavioural
    refinement, not an accidental regression: with N tracks, "at the
    playhead" alone doesn't say which track, and "split the selected clip"
    is the standard-NLE reading.
- **Not built this pass, flagged honestly rather than silently skipped:**
  a live drag-clip-between-tracks gesture (the "Move to ▾" dropdown is the
  real, working substitute); track lock/solo (no backing model field);
  Phase B3 (real blend modes/opacity — still ambient/opaque-only
  compositing, per the roadmap's own sequencing, untouched by this pass);
  Phase E (transitions, rides on B3); Phase F (export through the real
  timeline).
- **Verification.** `cargo test -p chroma-timeline`: 39/39. `cargo test
  --manifest-path app/src-tauri/Cargo.toml chroma::`: 143/143, 1 ignored
  (unchanged — this pass touched no Rust command surface, only the crate's
  own test coverage). `cargo build`: clean. `packages/editor``vitest run`:
  45/45. `tsc --noEmit -p packages/editor`: 0/0. `tsc --noEmit -p app`:
  64/64 unchanged baseline. App boots cleanly under the real Tauri runtime
  (confirmed via `app.log`, no crash/error on load) — **no live
  interactive click-through this pass**: the owner was away for this
  build (per their own instruction to keep working rather than wait), and
  this session has no tool that can drive a native Tauri/WKWebView window
  (tried navigating a plain Chrome tab to the Vite dev server directly —
  confirmed it hard-fails with no Tauri IPC bridge available, `<WindowControls>`
  erroring on a Tauri-only API — unrelated to this feature, a genuine tool
  limitation, not skipped out of laziness). Real drag/drop/click-through
  verification is pending the owner's own next session.

## D-081 — Global Inspector, Phase 1: a real selection model + layer list for the Motion tab

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** Still working while the owner was away, per their "don't sit
  idle" instruction. Item 7 (Global Inspector) is next in the roadmap's own
  sequencing after D-080's Phase D shipped, but — unlike Phase D — it had
  no dedicated scoping doc, only an inline roadmap note. Read the actual
  code first rather than guess at scope: the Motion tab
  (`packages/motion/src/MotionTab.tsx`) is a raw JSON `<textarea>`
  (`ManifestEditor.tsx`, D-046 — "JSON-in, on purpose") next to a
  `@remotion/player` preview, with **no selection model or layer list of
  any kind** — before any property panel makes sense, something has to be
  selectable first. That's a bigger, more foundational prerequisite than
  "add property sliders," and building the actual panel blind against no
  spec (unlike Phase D, which had `multi-track-nle.md` to execute against
  precisely) risked producing something that doesn't match what's wanted.
- **Wrote a real scoping doc first** (`docs/notes/global-inspector.md`,
  mirroring `multi-track-nle.md`'s rigor): verified the manifest schema's
  `.passthrough()` gap (`schema.ts`'s `layer` only types `use`/`at`/`dur`/
  `active` — every primitive-specific prop passes through untyped), verified
  `chroma_timeline::Clip` has zero transform fields (the NLE half is
  genuinely blocked on Phase B3, not a separate problem), and extracted a
  complete, verified prop catalog for all 8 registered primitives straight
  from each one's own inline `React.FC<{...}>` type — not the manifest's
  terse/adapted form, the real thing. 4 phases: 1 (selection + layer list),
  2 (Motion property panel, unblocked), 3 (NLE half, blocked on B3), 4
  (shared panel shell, last).
- **Built Phase 1** — the concretely-scoped, low-risk, genuinely unblocked
  piece, same pattern as verifying Phase B2 before building Phase D's UI on
  top of it:
  - `packages/motion/src/LayerList.tsx` (new) — a real expand-per-scene
    sidebar: scene → its 2D `camera` (if present) → `layers[]`, or its
    `scene3d` camera + `children[]` for a 3D scene. `Selection =
    {sceneIndex, target}`, a plain local `useState` in `MotionTab.tsx` — the
    same "no dedicated store package" weight `TimelinePane.tsx`'s own
    `Selection` (D-080) established as right for this kind of thing.
  - Selecting a row seeks the player to that scene's start frame —
    `@remotion/player`'s own imperative `PlayerRef.seekTo`, forwarded
    through a new optional `playerRef` prop on `MotionPreview.tsx`. New
    `sceneStartFrame`/`sceneDurationFrames` helpers in `build.ts` compute
    exactly the same per-scene frame math `<Series>` (`Video.tsx`) already
    uses to lay scenes back to back — not a second, possibly-drifting guess
    at it.
  - Real, standalone-useful scene/layer navigation even before Phase 2 (an
    actual property panel bound to the selection) exists — not just inert
    plumbing for a future feature.
  - `LayerList.tsx` deliberately does not import `@chroma/ui` — `Button.tsx`
    in the same package already documents a real, specific conflict
    (`@react-three/fiber`'s global JSX augmentation, pulled in transitively
    via `Scene3D`/`ParticleFlow`, breaks `@chroma/ui`'s `Text` export's
    polymorphic typing in the same `tsc` program) — plain elements on the
    app's own `--color-*` tokens, matching every other file in this package.
- **Not built this pass:** Phase 2 (the property panel itself) and
  click-to-select directly on the `MotionPreview` canvas (would need each
  primitive to report its own screen-space bounds back to the player
  wrapper — Remotion has no built-in mechanism for that) — both real,
  separate next steps, not silently folded into this one.
- **Verification.** `tsc --noEmit` clean on `packages/motion`,
  `packages/motion-engine`, and `app` (`app`'s own 64/64 baseline
  unchanged). No automated test — neither `packages/motion` nor
  `packages/motion-engine` has a test harness set up at all (no vitest
  config, no existing test file in either), unlike `packages/editor`'s
  established suite; not set up this pass, flagged honestly rather than
  silently skipped, since standing up a first test harness for two
  packages is real scope beyond this specific increment. Vite HMR applied
  every change to the running dev app without error (`chroma-tauri-dev`
  log — `hmr update .../MotionPreview.tsx`, `.../MotionTab.tsx`, no
  exception after). **No live interactive click-through this pass** — same
  tool limitation D-080 hit: no way to drive the native Tauri window
  without the owner present; pending their next session.

## D-083 — Edit-tab timeline: dragging a clip froze the UI (B-024)

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** Owner, live, screenshot: "when i drag and drop the UI
  freezes up this is not performant at all." Dispatched as a separate,
  scoped fork rather than investigated in the main session, since D-080
  (this same file's own multi-track rewrite, same day) was the prime
  suspect and needed a clean read of the code, not a guess.
- **Root cause.** `TimelinePane.tsx` passed `getActionRender`,
  `onClickAction`, `onActionMoveEnd`, `onActionResizeEnd`, and `onScroll` to
  `<TimelineEditor>` as **inline arrow functions written directly in the
  JSX** — a brand-new function identity on every render of `TimelinePane`.
  A native HTML5 drag fires `dragover` continuously (many times a second)
  for its whole duration; the drag handler called `setDragOver(true)`
  unconditionally on every tick, and each resulting `TimelinePane` render
  hands `@xzdarcy/react-timeline-editor` a fresh, never-`===`-equal copy of
  all five of those props. A component rendering many items (every action,
  across every track) typically uses exactly that kind of prop-identity
  change as its signal to skip re-rendering an item it's already rendered —
  handing it a new one every tick defeats that, forcing a full re-render of
  every visible clip (including canvas recreation for every `Waveform`,
  D-051) on every single dragover tick. **This exact pattern predates
  D-080** — confirmed via `git show` against the pre-D-080 revision
  (830b815), the same inline-function shape was already there — but with a
  single hardcoded video row, the cost of re-rendering "everything" was
  small enough to never be felt. D-080 turned the same latent inefficiency
  into a real, reported freeze simply by making "everything" scale with
  track count.
- **Fix.** The five props are now `useCallback`-wrapped with real
  dependency arrays (`tracks`, `selected`, `rippled`, `pxPerSec`, `fps`,
  `applyOp` as appropriate) instead of being redefined every render — moved
  above the component's early returns (`if (!timeline) return null` etc.)
  since Hooks must run unconditionally; `clipsOf`/`idxOf`/`s2f` moved up
  alongside them since the callbacks close over them. `setDragOver` and
  `setDragOver`'s counterpart in `onDragLeave` are also now gated
  (`prev ? prev : true` / `prev ? false : prev`) as defense-in-depth, so a
  `setState` call that wouldn't change the value never dispatches at all,
  regardless of the deeper fix above.
- **Verification.** `tsc --noEmit -p packages/editor`: 0 errors (unchanged
  baseline). `vitest run` in `packages/editor`: 45/45 (unchanged — this is
  a rendering-performance fix, not a change to any pure logic the existing
  suite covers). `tsc --noEmit -p app`: 64/64, unchanged baseline (no
  Rust/app-level surface touched). No `cargo` command run for this fix at
  all — pure TypeScript/React, and a concurrent Rust session's own
  `cargo tauri dev` was active at the time (confirmed via `ps aux` before
  starting, per this session's own established discipline for avoiding the
  `target/` build corruption hit earlier tonight). No live interactive
  click-through this pass — dispatched while the owner was actively
  reporting other issues live; the owner's own next drag-and-drop attempt
  is the real confirmation.

## D-085 — Edit tab stuck on "No project open" after a real, successful open; opening a project had no loading feedback

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** Owner, live, two screenshots: clicking a project in the
  Projects list "gets stuck in the click, it does not open," and once it
  does land, the Edit tab shows "No project open" persistently — confirmed
  via `app.log` that the project genuinely opened (grade migration ran, a
  real frame decoded and rendered in Colorist's own WGPU preview in the same
  session, no crash, no error).
- **Two distinct issues, not one, per the owner's own two-part report:**
  1. **No loading feedback on open at all.** `ProjectLauncher.tsx`'s
     `handleOpen` awaits a real, sometimes multi-second round trip (project
     manifest load + grade-file migration, confirmed by real elapsed time
     between the click and the migration warnings landing in `app.log`)
     with zero visual change to the clicked card. A reasonable click during
     that window reads as "did that even register?" — inviting a second
     click, which hits `openProject`'s own `busy` guard
     (`useSessionStore.ts`) and surfaces a raw "session busy" error toast:
     technically harmless (the first open still completes), but a scary,
     confusing symptom that reads as a real failure. This is very plausibly
     the entire "stuck in the click" experience, not a genuine hang.
  2. **The Edit tab's own staleness gap** — read `app/src/main.tsx`'s
     existing B-007 fix first (a `useEffect` that calls `useEditorTimelineStore
     .getState().load()` whenever `useSessionStore`'s `projectOpen` becomes
     true) and confirmed it's real, present, and structurally correct for
     the reported symptom on inspection. Could not find a definitive root
     cause via static reading alone for why it would still leave the Edit
     tab stuck given a confirmed-successful backend open elsewhere (same
     `state::ProjectRef`/manifest source `chroma_timeline_get` and the
     Colorist open path both read) — noted honestly rather than claiming a
     certainty this pass didn't establish. Given a live, reported symptom
     that the code doesn't obviously explain, treated the likeliest
     remaining cause as a narrow timing race between "frontend has set
     `projectPath`" and "every backend command's own state is fully
     settled," not just the one call `openProject` itself awaited.
- **Fix, part 1 (real, verified UX gap — `ProjectLauncher.tsx`).** A real
  `opening: string | null` state: the clicked card shows a spinner +
  "Opening…" overlay (same `Loader2` affordance this file's own "Create"
  button already uses), every card disables while any open is in flight —
  a second click can no longer reach `openProject` at all, closing the
  "session busy" race at the UI level rather than only inside the store.
- **Fix, part 2 (defensive, not a proven root cause — `app/src/main.tsx`).**
  The existing B-007 effect now retries `load()` once, 500ms later, if the
  first attempt lands on an error state (`loaded && !timeline`) — makes the
  observed symptom harmless without pretending to have proven its exact
  mechanism. If this owner-reported symptom recurs even with this retry in
  place, that's real signal the cause is something else entirely (worth a
  fresh, deeper investigation rather than assuming this pass closed it).
- **Verification.** Both changes are small, isolated, and manually reviewed
  against this file's own established patterns (the `Loader2`/disabled-state
  convention already used elsewhere in `ProjectLauncher.tsx`; the retry
  pattern is a plain `setTimeout` + the store's own existing state shape,
  no new dependencies). **`tsc --noEmit -p app` could not be completed this
  pass** — attempted multiple times, each starved to ~0% CPU by concurrent
  sibling Rust/TS agent processes running heavy `cargo test`/build work at
  the same time (this session had 3-4 parallel background agents active
  simultaneously) — noted honestly rather than claiming a check that didn't
  actually finish. No `cargo` touched by this fix at all (pure
  frontend). No live interactive click-through this pass — the owner's own
  next project-open attempt is the real confirmation for both parts.

## D-086 — Full NLE, Phase 1: data model for real multi-track compositing (track lock/hide, clip transform, rearrange)

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** Owner, P0, referencing Palmier Pro screenshots: "we need full
  NLE track now... scope it out frontend backend and work till its
  perfect... also selection keyframes mute view hide, rearrange etc etc.
  what is in the full NLE has all the features we want to be working."
  Specifically: real V1/V2 video stacking (not opaque top-wins, D-056/D-080's
  existing behavior — actual layering), track lock/hide (mute already real,
  D-057), rearrange (track z-order), and keyframeable clip transforms. This
  is Phase B3 of `docs/notes/multi-track-nle.md` — the one piece flagged all
  session as "the real long pole... genuinely new GPU/pixel-compositing
  work," now made explicit P0. This entry is Phase 1 (data model) of a
  4-phase build; Phase 2 (the actual compositor) is the hard engineering,
  landing separately.
- **`chroma_timeline::Track` gained `locked: bool` / `hidden: bool`**
  (`#[serde(default)]` — correct since `bool::default() == false` and
  "not locked/not hidden" is the sane meaning for a pre-migration track,
  unlike `gain`'s D-057 non-zero-default precedent).
- **`chroma_timeline::Clip` gained a compositing transform**: `opacity`/
  `scale: f64` (`#[serde(default = "default_opacity"/"default_scale")]` →
  `1.0` — a bare `#[serde(default)]` would be `0.0`, silently rendering
  every existing clip invisible/zero-sized), `position_x`/`position_y`/
  `rotation: f64` (bare `#[serde(default)]`, `0.0` correctly means "no
  offset"/"upright"), and `chroma_keyframes: Option<serde_json::Value>` —
  deliberately untyped, the *exact* `[{frame, params}]` shape `chroma::
  keyframes`'s existing D-034 interpolation engine (already used by mask
  shape geometry and `RelightLight`) already reads — reusing that engine
  outright rather than building a second one. **This moved `Clip` off
  `#[derive(Default)]` onto a manual `impl Default`** — a real bug caught
  before it shipped: the derive would give `opacity`/`scale` their type's
  `0.0`, not `1.0`, for every `Clip { ..Default::default() }` construction
  site this crate and `app/src-tauri` already have (several) — `#[serde(
  default = "...")]` only governs *deserializing a missing JSON key*, a
  completely separate mechanism from `Default::default()`. Same class of
  bug tonight's relight work already hit once with `RelightLightGpu`
  (D-076) — caught this time before merging, not after a live report.
- **`TimelineError::TrackLocked(usize)`** — refused by every per-clip edit
  op (`trim_start`/`trim_end`/`split`/`remove`/`reorder`, all routed through
  a single `track_mut` choke point that now checks `locked` once, so a
  future op added the normal way is locked-safe automatically) and by
  `move_clip` on EITHER its source or destination track (a locked track
  should protect against both losing a clip to elsewhere and gaining one
  dropped onto it). Deliberately NOT checked by `add_track`/`remove_track`/
  the new `move_track` — locking a track protects its own clips, not the
  track list's structure.
- **`Timeline::move_track(from, to)`** — the "rearrange" ask. Not cosmetic:
  track index order IS compositing z-order (`resolve_video_clip_at`'s own
  "lower index = higher priority" convention), so this changes what paints
  on top of what.
- **`Timeline::resolve_visible_video_layers_at(pos)`** — the multi-layer
  generalization of the existing single-winner `resolve_video_clip_at`:
  every visible (`!hidden`) video track with real content at `pos`, not
  just the first, in the same index-order walk (documented as the
  compositor's paint-order contract: lowest index painted LAST/on top).
  This is the actual query Phase 2's compositor will call.
- **Verification.** `cargo test -p chroma-timeline`: **58/58** (39 baseline
  + 19 new: `Clip::default()` opacity/scale correctness, serde-default
  round-trips for the new fields, `move_track` success/out-of-range/no-op,
  `resolve_visible_video_layers_at` multi-track/gap/hidden-track/3-track
  cases, and a `TrackLocked` refusal test for every gated op). `cargo test
  --manifest-path app/src-tauri/Cargo.toml chroma::`: **143 passed, 0
  failed, 1 ignored** — unchanged from before this pass (this phase only
  added fields + pure query/mutation methods, no new command surface yet).
  `cargo build --manifest-path app/src-tauri/Cargo.toml`: clean (after
  fixing every existing `Clip`/`Track` struct-literal construction site
  across `chroma-timeline`, `app/src-tauri/src/chroma/project.rs`, and
  `app/src-tauri/src/chroma/audio.rs` that the new required fields broke —
  9 sites total, all real production/test code, not dead code). Phase 2
  (the compositor) is next.

## D-087 — Sidecar memory: diagnosed the 5.78 GB report, shipped real observability + TTL auto-unload

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** Owner, live, Activity Monitor screenshot: a Python process at
  5.78 GB — "we have a memory leak somewhere, this is not acceptable, we
  need some kind of way to look at memory for our sidecar." Follow-up,
  explicit: "once we used we need some kind of TTL to offload them or else
  it will be a nightmare" — a real automatic idle-unload, not just a manual
  reclaim button.
- **Diagnosed first, didn't assume a bug.** The specific process in the
  screenshot (PID 8210) was already gone by the time this was investigated
  — `ps`/`lsof` on the *current* sidecar process showed ~60 MB RSS at rest,
  and no Python process on the machine exceeded 500 MB. The 5.78 GB reading
  was real, just of an earlier sidecar instance from earlier in tonight's
  session (this sidecar has been restarted several times tonight across the
  relight/MoGe-2 work) — not evidence the *current* process is actively
  leaking. Checked B-002's existing `_free_gpu()` fix (`torch.mps.
  empty_cache()` + `gc.collect()`, called in every heavy endpoint's
  `finally`) is correctly present in every endpoint including this
  session's own new `/generate_normal_map` (D-077) — verified by reading
  it, not assumed correct just because I wrote it earlier tonight.
- **The real finding: not a leak, a genuine missing-memory-management gap.**
  `_free_gpu()` only returns *cached allocator blocks* to the OS — it was
  never designed to and does not unload model weights. Every lazy-singleton
  loader (`sam`/`detector`/`matte`/`video_depth`/`moge`, plus
  `_get_video_predictor`'s SAM 2 video predictor) sets its global once and
  never clears it. A session that touches subject tracking, depth tracking,
  AND relight (as tonight's did) accumulates all 6 real models resident at
  once, forever, even hours after any of them were last used. That is a
  real, physically-expected way to reach several GB — not runaway/unbounded
  growth, but genuinely nothing was ever built to release it. Almost
  certainly what the owner actually saw.
- **Fix — TTL-based automatic idle-unload, the owner's own explicit ask,
  not just a manual fallback** (`ai/server.py`):
  - Every loader now calls `_touch(name)` on every call (cache hit or real
    load — being asked for is "used" for TTL purposes).
  - A background daemon thread (`_ttl_sweep_loop`, `_SWEEP_INTERVAL_SECONDS
    = 30`) wakes every 30s and unloads (`del` the global + `_free_gpu()`)
    anything idle past `MODEL_TTL_SECONDS` (default 300 = 5 min, overridable
    via `CHROMA_MODEL_TTL_SECONDS` for testing/tuning).
  - **Safety against yanking a model mid-request:** the sweep acquires the
    same `_GPU` lock every heavy endpoint already holds while calling a
    loader (B-002's own "one Apple GPU, serialize every model call"
    design) — while any request holds `_GPU`, the sweep simply blocks until
    it's released, so a model can never be unloaded out from under a call
    in progress. No new locking primitive, reused the one that already
    existed for exactly this class of problem.
  - `GET /memory` — real observability: current process RSS (`ps -o rss= -p
    <pid>`, shelled out once per call — no new dependency for one number,
    and this is a debugging endpoint, not a hot path) plus each model's
    loaded state, idle seconds, and the live TTL.
  - `POST /unload` (optional `{"model": "<name>"}`, omitted = unload
    everything loaded) — the manual reclaim the owner can hit right after a
    heavy job, alongside the automatic sweep, not instead of it.
- **Verified live, end to end, not just read the code:** loaded MoGe-2 via a
  real `/generate_normal_map` call (RSS 251.9 MB → 767.8 MB, confirming a
  real model actually loaded), confirmed `/memory` reported it loaded with
  a live idle-seconds counter; with `CHROMA_MODEL_TTL_SECONDS=12`, waited
  35s and confirmed the sweep thread actually unloaded it (`/memory` back to
  `loaded: false`, log line `[memory] TTL sweep unloaded: moge`) —
  caught and fixed a real bug in this same verification pass: the sweep's
  own log `print()` wasn't flushed, so it didn't show up in the log file
  until a later flush, defeating the point of a debug log line — added
  `flush=True`. Also verified `POST /unload` for a specific model, for "all
  loaded," and the unknown-model-name error path.
- **Verification.** Sidecar restarted clean on the real default TTL (300s)
  after testing; `curl /health` and `curl /memory` both healthy. No `cargo`
  touched — pure Python, `ai/server.py` only. No existing pytest suite in
  `ai/` to run (`test_depth_track.py` is a standalone script, matching this
  directory's existing convention, not a harness this change needed to
  satisfy).

## D-088 — Full NLE, Phase 2: the real multi-layer video compositor

**decided (2026-09-03) · built (2026-09-03)**

- **Context.** Phase 2 of the P0 full-NLE effort (D-086 was Phase 1, the
  data model) — the actual "long pole" flagged all session:
  `chroma_timeline_frame`'s preview decode was, until now, a single opaque
  top-wins winner only (`resolve_video_position`, D-056) — real video-track
  stacking needed genuine pixel compositing, which never existed anywhere
  in this codebase outside the Colorist's grade pipeline.
- **`Timeline::resolve_video_position` (Colorist's active-clip resolution,
  `chroma::audio`'s embedded-audio baseline) is UNCHANGED** — both are
  genuinely single-clip concerns this work has no business touching;
  checked every caller (`grep`, not assumed) before writing a line of the
  compositor. `chroma_timeline_frame` gets its own new path instead, using
  `Timeline::resolve_visible_video_layers_at` (D-086) directly.
- **`chroma_timeline_frame`**: resolves every visible layer at `pos`;
  exactly one layer takes the SAME fast plain-decode path as before
  (byte-identical output, zero new cost for the still-overwhelmingly-common
  single-track case); more than one calls the new `composite_video_frame`.
- **`composite_video_frame`/`composite_layer_onto`**: real CPU alpha-over
  compositing via `image`/`imageproc` (both pre-existing dependencies — no
  new crate, no wgpu). Deliberately CPU, not GPU, for v1: this is a
  per-frame-on-demand still decode (scrub/playback calls one frame at a
  time), not a 60fps realtime path, and a real working CPU compositor beats
  an unbuilt GPU one. Per layer: resize by `scale`, rotate by `rotation`
  (arbitrary angle, real — `imageproc::geometric_transformations::
  rotate_about_center`, the *exact* function + transparent-border pattern
  `image_processing.rs`'s own Colorist rotate adjustment already uses, not
  a second implementation, and not limited to 90°-increments), multiply
  alpha by `opacity`, then `image::imageops::overlay` onto the canvas
  (already-used elsewhere in this codebase — `ai_connector.rs`,
  `export_processing.rs`). Paint order: `resolve_visible_video_layers_at`'s
  index-ascending order, painted in REVERSE (lowest-priority/highest-index
  first/at the back, highest-priority/index-0 last/on top) — canvas is the
  top layer's own scaled dimensions, matching the single-clip case's
  existing output size exactly.
- **Keyframes reuse D-034's engine directly, NOT `interpolated_parameters`**
  — that wrapper reads `chroma::state::current_video()`'s global
  "currently loaded video" frame (the Colorist grading session's own
  state), the wrong frame for a timeline clip being composited at an
  explicit position here. `resolve_clip_transform` calls the lower-level,
  frame-explicit `parse_keyframes`/`interpolate` directly instead — same
  engine, same `[{frame, params}]` shape, no new interpolation code,
  correctly frame-scoped. Keyframes are interpreted relative to the clip's
  own SOURCE frame, matching the convention every other keyframeable thing
  in this codebase (masks, relight lights) already uses.
- **Module doc corrected**: `chroma/edit.rs`'s own header used to say "no
  pixel-level compositing... a later chroma-compositor step, Phase B3" —
  updated now that Phase B3 is real, not aspirational.
- **Renumbered mid-flight**: this was drafted as D-087 before discovering
  (via a fresh `grep` right before writing this entry) that a concurrent
  session agent had already landed the real D-087 (sidecar memory/TTL) —
  same collision-avoidance discipline this whole session has used
  (D-070 was renumbered from a stale D-065 earlier tonight); every "D-087"
  reference in `edit.rs`'s own code comments was corrected to D-088 via a
  scoped `sed` before this entry was written, not left inconsistent.
- **Verification.** 7 new real pure-logic tests in a new `composite_tests`
  module in `edit.rs` (not a separate file — matches this module's
  existing "tests live with the code" convention): `resolve_clip_transform`
  with/without keyframes (confirms interpolation actually overrides the
  static field, and the pre-first-key hold behavior), and
  `composite_layer_onto` at zero opacity (a real no-op, canvas untouched —
  not just "very faint"), full opacity (exact replace), **partial opacity
  landing strictly between the two colors** (proves real blend math ran,
  not a threshold switch — the actual D-086/owner ask: "not opaque
  top-wins... actually stacked"), position offset (lands at the exact
  expected pixel, untouched area stays untouched), and scale (painted
  footprint size actually changes). All pass on the first run — no
  iteration needed to get the alpha-blend math right.
  `cargo test --manifest-path app/src-tauri/Cargo.toml chroma::`: **150
  passed, 0 failed, 1 ignored** (143 baseline + 7 new). `cargo build`:
  clean. No `CHROMA_TEST_VIDEO`-gated real-decode integration test this
  pass (would need a real multi-clip project fixture to exercise
  end-to-end) — the pure compositing-math tests above are the real
  correctness guard for the actual new logic (the blend/transform math);
  `decode_pipe`'s own existing tests already cover the decode path itself.
  Phase 3 (the TypeScript mirror of the new fields/ops) is next.

## D-089 — Full NLE, Phase 3: TypeScript mirror of the lock/hide/rearrange/transform data model

Phase 3 of the P0 full-NLE effort (D-086 was Phase 1, the Rust data model;
D-088 was Phase 2, the real compositor). This phase brings
`packages/editor/src/timeline.ts` — the pure client-side edit model that
`chroma_timeline_set` stores verbatim — up to parity with what D-086/D-088
actually shipped server-side, so Phase 4's UI has real ops to call.

- `Track` gained `locked?`/`hidden?`, `Clip` gained `opacity?`/`position_x?`/
  `position_y?`/`scale?`/`rotation?`/`chroma_keyframes?` — all optional,
  same convention as `Track.gain` (absent means the Rust-side serde default
  applies on the next `chroma_timeline_get`).
- New `EditOp` variants: `set_track_locked`, `set_track_hidden`,
  `move_track`, `set_clip_transform`, `set_clip_keyframes`. Note:
  `move_track` did NOT already exist in this file before this phase (only
  in the Rust crate, from D-086) — checked by reading the whole file first,
  since an earlier planning pass had assumed otherwise.
- `applyOp` mirrors Rust's `TrackLocked` refusal exactly: a single lock
  check right after the shared `tr = tl.tracks[op.track]` resolution
  refuses `reorder`/`trim_start`/`trim_end`/`split`/`remove` (mirroring
  Rust's single `track_mut` choke point), `set_clip_transform`/
  `set_clip_keyframes` get their own equivalent check (new ops, no Rust
  `track_mut` caller to mirror structurally but the same semantics), and
  `move` checks BOTH the source and destination track's lock (mirroring
  `move_clip`'s explicit dual check). `add_track`/`remove_track`/
  `move_track` are deliberately NOT gated by lock, matching Rust's
  track-list-vs-track-clips split — verified by grepping the actual Rust
  `pub fn` list rather than assuming, which confirmed `add_clip` has no
  Rust-side equivalent at all (`chroma_timeline_set` stores whatever the
  frontend sends, per this file's own module doc), so it stays ungated too.
- `set_clip_keyframes` reuses the exact `{frame, params}` shape
  `utils/maskKeyframes.ts` already writes for mask/relight-light keyframes
  (D-034/D-048) rather than inventing a second shape, and normalizes an
  empty array to `undefined` on write so a clip never round-trips as
  "keyframed" with zero actual keyframes.

Verification: 27 new vitest tests (label names, each new op's direct
behavior, out-of-range no-ops, and a dedicated "track lock enforcement"
describe block covering every op D-086 gates in Rust plus the two new
per-clip ops) — 57/57 in `timeline.test.ts`, 68/68 across
`packages/editor`. `npx tsc --noEmit -p packages/editor` clean. `npx tsc
--noEmit -p app` baseline unchanged at 64 pre-existing errors.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PbQj7ii1BfYW9BpWV9ujEc

## D-090 — Full NLE, Phase 4: the UI — lock/hide, rearrange, clip transform + keyframes

Phase 4 (final phase) of the P0 full-NLE effort — the piece that actually
makes D-086/D-088/D-089's data model, compositor, and TS ops usable from the
Edit tab. `TimelinePane.tsx` (D-080's per-track UI) gains:

- **Track header lock/hide toggles**, alongside the existing mute toggle
  (D-080): `Lock`/`Unlock` icon on every track (writes `set_track_locked`),
  `Eye`/`EyeOff` on video tracks only (writes `set_track_hidden` — `hidden`
  has no audio-mixing effect, mirrors why mute is audio-only in the other
  direction; verified by grepping `chroma::audio` for any `hidden` read
  before assuming, found none). A locked track's header dims (`opacity-60`)
  as a passive visual cue; the real enforcement is `applyOp`'s `TrackLocked`
  mirror (D-089), already in place.
- **Rearrange via up/down buttons**, not native `enableRowDrag`. Checked the
  library's bundled types first: row-drag reorders `editorData` and hands
  back a full reordered-id list with no clean "moved from A to B" delta, and
  nothing in this file owns `editorData`'s order independently of
  `timeline.tracks` (`buildRows` derives it fresh every render) — mapping
  that reliably into `move_track` calls without risking a UI/disk desync
  wasn't worth the remaining time in this pass, so per the directive's own
  "a working button beats a half-working drag" — shipped the buttons.
  `move_track(from, to)` with adjacent indices is exactly a swap, so
  `doMoveTrack` also swaps the current selection's track index when it
  matches either side, rather than leaving the selection pointing at the
  wrong row after a move. `HEADER_WIDTH` widened 132 → 156px for the new
  two-row header cell layout (kind icon + label + up/down on top,
  lock/hide-or-mute/remove on the bottom row).
- **Clip-transform popover** — a "Transform" toolbar button (next to the
  existing "Move to ▾", enabled only with a selection) opens a
  `@chroma/ui` `Popover` with numeric `opacity`/`position_x`/`position_y`/
  `scale`/`rotation` inputs, each writing the full `set_clip_transform` op
  (D-089's "replace all five fields together" contract) via a small
  `applyTransform(patch)` that fills the unpatched fields from the clip's
  own current values. Disabled (trigger only, not deep-disabling every
  input) when the selected clip's track is locked — the op already no-ops
  server/store-side, this just keeps the control from looking live when it
  isn't.
- **Keyframing UI**, the exact interaction `RelightPanel.tsx` uses for
  relight-light keyframes: a `Diamond`-icon "Keyframe clip" / "Update key" /
  "Add key" button (filled when `keyedHere`), a live keyframe count, a
  delete-at-this-frame `X` button (shown only when keyed here), and a
  "Clear" button for all keyframes. New `packages/editor/src/
  clipKeyframes.ts` is a small, SEPARATE mirror of `app/src/utils/
  maskKeyframes.ts`'s upsert/remove/clear pattern (not a shared import —
  `packages/editor` cannot depend on `app`, the D-039 layer direction runs
  the other way) — scoped to just the CRUD this UI needs, no interpolation
  math (that stays the Rust engine's job at render time). One real
  behavioral difference from the mask version worth flagging: `Clip.
  chroma_keyframes` (D-086) is the RAW `[{frame,params}]` array itself, not
  a `parameters.chromaKeyframes`-wrapped object the way mask/relight
  keyframes are — `resolve_clip_transform` (Rust, D-088) wraps it into a
  synthetic object only at the point it hands it to the shared interpolator.
  `clipSourceFrame(clip, playhead)` converts the timeline playhead into the
  clip's own SOURCE frame (`source_start + (playhead - start_frame)`,
  clamped to the clip's source window) before keying — keyframes are
  interpolated against source frame, not timeline position, confirmed by
  reading exactly what `resolve_clip_transform` passes to `interpolate`.

**D-083 discipline followed**: no new inline arrow function was added to
any prop passed into `<TimelineEditor>` itself (`getActionRender`,
`onClickAction`, `onScroll`, `onActionMoveEnd`, `onActionResizeEnd` are
untouched, still the D-083 `useCallback`-wrapped versions). Every new
handler this phase adds (track header buttons, popover open/close,
transform inputs, keyframe buttons) is a plain React event handler on
native DOM elements OUTSIDE the timeline library's own render path — the
same category `toggleMute`/`doAddTrack`/`doRemoveTrack`/`doMoveToTrack`
(D-080) already are, none of which are `useCallback`-wrapped either, for
the same reason: D-083's freeze was specifically about identity-sensitive
props handed to the third-party library's per-item rendering, not about
ordinary React event handlers in general.

Verification: 11 new vitest tests for `clipKeyframes.ts`'s pure functions
(79/79 across `packages/editor`, up from 68/68 after D-089). `tsc --noEmit
-p packages/editor` clean. `tsc --noEmit -p app` baseline unchanged at 64.
Live check: restarted `cargo tauri dev` cleanly (it was not running at the
start of this phase) and confirmed a clean boot with no panic/crash in the
log — no native-window automation available this session, so this is
static correctness + a clean boot, the same bar every UI piece tonight has
used, not an actual click-through of the new lock/hide/rearrange/transform
controls.

This closes all 4 phases of the P0 "full NLE" effort (D-086/D-088/D-089/
D-090): real multi-track V1/V2 stacked compositing (not opaque top-wins),
A1/A2 audio separation (pre-existing, D-057), and full track controls —
lock, hide, mute (D-080), rearrange, selection (D-080), keyframes.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01PbQj7ii1BfYW9BpWV9ujEc
