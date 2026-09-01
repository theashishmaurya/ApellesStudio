# 04 — Roadmap

Phased. Each phase ends at a demoable checkpoint. Timelines are rough solo-dev estimates,
not commitments.

---

## Now — the working queue (as of 2026-09-01 EOD)

Done so far: video open/transport, subject tracking end-to-end (SAM 2 propagation +
ViTMatte, D-016/18/19), `render_core` seam (D-014), control server + MCP v1 (D-020).

Next, in order:

1. **Scopes + `inspect_color`** — the #1 enabler for AI grading (see
   `docs/notes/agent-visual-feedback.md` — the agent must grade by the numbers).
   RapidRAW has histogram + 1-channel waveform; add RGB parade + vectorscope + the
   numeric summary (black/white points, per-zone means, warm-cool + green-magenta
   cast, hue histogram), then the MCP `inspect_color(frame?, reference?)` tool with
   the reference→gap. WGSL compute where possible.
2. **Export** — a colour tool must output. `render_core` (D-014) is ready; wire
   ffmpeg decode → grade path → encode (ProRes / H.264) + a `.cube` bake of the
   primary. MCP `export` tool.
3. **`refine_mask` via MCP** — expose the already-built +/− point support
   (`points: [{x,y,label}]`) as an MCP op. Cheap; the canvas click UI comes later.
4. **Depth-haze preset** — completes the Phase 2 checkpoint + the original ask.
   Depth Anything V2 per-frame (RapidRAW has it for stills) + a one-action preset
   (depth-weighted desat + black-lift + dehaze + blur on the background).
5. **`grade.json` schema + load/save** — lock "grade is code" (the differentiator).
   Migrate RapidRAW's `adjustments` ⇄ the schema.

Scope-first MCP discipline (rule 0 in doc 07) gets wired into the tool descriptions
alongside item 1.

---

## Phase 0 — Scaffolding & spikes  ·  ~1 week

- [x] Repo, submodule (RapidRAW → `engine/`), docs
- [x] `CLAUDE.md` working rules
- [x] Read `engine/src-tauri` — first pass (`docs/09-engine-notes.md`): grade path mapped,
      AI stack is ONNX/`ort` in-process (D-009 revised), toolchain gap found (B-001)
- [x] **`rustup update`** (B-001 fixed → rustc 1.98.0); `cargo check` on `engine` passes clean (4m24s, 682 deps)
- [x] Deeper read: `gpu_processing.rs` (WgpuDisplay = D-006 answered), `shader.wgsl` (32-mask array, apply_dehaze, AgX), `mask_generation.rs` (JSON masks, base64 matte hook), frontend map — all in doc 09
- [x] **Spike D-006** — *not needed*: `WgpuDisplay` already renders to a native wgpu surface. Decided.
- [x] App builds (7m18s) + launches — window opens, ONNX runtime loads, no GPU errors. Frontend throws a `<TitleBar>` React error + Clerk auth warnings (the `@clerk/react` community-login dep — strip it early, irrelevant to Chroma).
- [x] ffmpeg decode → 4K Rec709 frame from `C019.MOV` works (`scratch/frame_c019_10s.png`). The frame→grade half is blocked on **D-014** (render core is Tauri-coupled) — moved to Phase 1 task 1.
- [x] **SAM 2 running** (D-012 revised → Python sidecar via `ultralytics`, MPS): `ai/server.py` `/segment` produces a subject matte on the 4K C019 frame. YOLO auto-person + box + multi-point (+/−) prompts. Solves the hands problem (single frame).
- [x] **Matte edge refine** (D-016): SAM 2 staircases at 4K → added trimap → **ViTMatte** stage in `/segment` (`refine: true` default). Clean edge, ~2.8s warm. Worklog: `docs/notes/matte-edge-pipeline/`.
- [x] Fork model decided (D-003): standalone project, hard fork, no upstream coordination.

**Checkpoint:** a graded video frame on screen, the architecture spikes answered.

---

## Phase 1 — Video grading core  ·  ~3–4 weeks

- [x] `src/chroma/video.rs` — ffmpeg probe + single-frame decode (D-015). Tests pass on the real 4K C019 take.
- [x] **Minimal video-open path** — video loads as frame 0 into the existing pipeline; filmstrip + import filter accept video. Built, tests pass. Needs a visual confirm (open C019 in the app).
- [x] **D-014: `render_core` seam** — `src-tauri/src/render_core.rs`: `render(ctx, caches, base, req, …) -> DynamicImage` + `init_gpu_context()` (device+queue, no surface). `process_and_get_dynamic_image_inner` now takes `RenderCaches` not `tauri::State`. GUI path unchanged. Headless API unused until the control/MCP server.
- [ ] Video I/O: proxy cache → per-frame grade → ProRes/H.264 encode
- [x] Transport bar (`ChromaTransport`) — play/step/scrub; `chroma_seek` decodes the frame + re-renders with the grade. Naive stepper (~5-10fps), no proxy yet.
- [x] Timeline view (`ChromaTimeline`) — replaces the filmstrip when a video is loaded: a 48-frame thumbnail strip (`chroma_frame_thumbnails`, cached), click/drag to seek, playhead marker.
- [ ] Smooth playback — persistent decode pipe or pre-rendered proxy
- [ ] Shot / session model + `grade.json` load/save/validate
- [ ] Video canvas + transport in the GUI (play/scrub/step, playhead, in/out)
- [ ] Shot strip (selector)
- [ ] Scopes: waveform, RGB parade, vectorscope, histogram (WGSL compute)
- [ ] `.cube` bake of the primary grade
- [ ] All inherited adjustment/mask panels working against a video frame, not a still

**Checkpoint:** grade a talking-head clip by hand, scrub it, export a `.cube` that matches in Palmier.

---

## Phase 2 — AI sidecar  ·  ~3–4 weeks

- [x] Sidecar service (FastAPI, `ai/`), `/segment` = SAM 2 → trimap → ViTMatte (D-016). Lifecycle: run `ai/run.sh` for now; Rust-managed spawn TBD.
- [ ] Depth Anything V2 for video (extend RapidRAW's still integration; temporal smoothing)
- [x] Engine wiring: `chroma_subject_mask(box)` → sidecar → matte → stored as an `ai-subject` mask (reuses RapidRAW's `AiSubjectMaskParameters` + mask-bitmap path). Box-drag on a loaded video routes here instead of ONNX SAM. `src/chroma/mask.rs` + `chroma_ai_health`.
- [~] Interactive +/− point prompts. **Backend done** — `/segment` + `/track` (sidecar) and `chroma_subject_mask` + `chroma_track_subject` (engine) all take `points: [{x,y,label}]` (1=include, 0=exclude). **Not done:** the canvas konva click UI + a points array persisted on the sub-mask + re-invoke per click. Quick path: expose via MCP first (`refine_mask(mask_id, points)`) so the agent can refine masks by point before the human UI exists.
- [x] Matte refinement pass — ViTMatte, D-016 (was: guided filter / RVM).
- [x] Per-frame subject tracking via **SAM 2 memory propagation** (D-018): prompt once, feed frames, ~180ms/frame mask. Sidecar `/track` (bg job, disk cache) + `/refine_track`.
- [x] **In-app tracking works end to end** (D-019): "Track subject across clip" → scrub → the matte + red overlay + grade follow the frame in lockstep. Matte read from disk at render time; `chromaTrackDir` persists with the project (no re-track on reopen). "Finalize matte" for the full-quality pre-export pass. Sidecar memory bounded (B-002).
- [ ] Multi-subject: two `ai-subject` masks each with their own `chromaTrackDir` should already work (untested); batch N objects into one propagation pass (`max_obj_num > 1`) so they don't each cost a full pass (D-017)
- [ ] `color-matcher` → reference match returns a CDL/curve fragment
- [ ] **Depth haze preset** — one action, depth-weighted desat + black-lift + dehaze + blur
- [ ] Mask keyframes in the data model + GUI handles

**Checkpoint:** click "isolate subject" → tracked matte that holds through hand gestures; "add haze" → depth-graded background separation.

---

## Phase 3 — MCP + the agent loop  ·  ~2–3 weeks

- [x] **Control server + MCP bridge (D-020)** — `src/chroma/control.rs` (in-app HTTP) ⇄ Tauri events ⇄ `useChromaControl` (frontend owns the state). `mcp/` Python stdio server. One shared grade/mask doc: MCP edits move the app's real sliders/history, `get_state` reflects manual edits. v1 ops: primary, curves, wheels, seek, subject mask + track, per-mask grade, invert, delete. Verified with real `curl` + an MCP client against the C019 take.
- [ ] Tools: shot ops, ~~primary, curves, wheels~~, LUT, masks (~~subject~~ / shape/depth), scopes, match_to_reference, apply_haze, export
- [x] Every mutating op returns `{image_b64, histogram, adjustments}` (image is a best-effort `generate_uncropped_preview` re-render — the app renders to a native WGPU surface)
- [ ] `request_human(reason, roi)` handoff + the GUI "agent activity" feed with per-change diff + undo
- [ ] Agent eval: a scripted brief → measure round-trips to an acceptable grade (G1, G2)

**Checkpoint:** a full talking-head grade (primary + tracked subject + depth haze + shot match) done in one Claude Code conversation + <5 min human mask cleanup. **This is v1.**

---

## Phase 4 — Harden & release v1  ·  ~2 weeks

- [ ] OTIO or a simple session import from Palmier (grade the shots the editor cut)
- [ ] ProRes export round-trip verified with `swap_clip_media`
- [ ] Packaging: signed macOS build, the sidecar bundled, models auto-downloaded
- [ ] `docs/` cleaned for external readers; a real README with a 90-second demo
- [ ] Ship. Get one external user. Open the issue tracker.

---

## Beyond v1 (see `docs/02-scope.md` v2/v3)

- Node graph, ACES/HDR (OpenColorIO)
- CoTracker planar tracking + tracker GUI, bezier roto
- Film-emulation chain (port ComfyUI-Darkroom science)
- Windows/Linux, batch/headless mode
- OFX plugin export (the gyroflow model — grade node in Resolve/Fusion/AE)
- Public MCP contract, web review viewer

---

## Risks & how we de-risk

| Risk | Mitigation |
|---|---|
| Tauri video presentation is too slow / too hard | Phase 0 spike D-006 *first*; fallback = separate native window for the canvas |
| SAM 2 matte quality poor on real footage | Phase 0 spike; fallback = SAM2 + heavy matte refinement, or interactive-segmenter click prompts |
| RapidRAW's still-centric architecture fights the video model | Phase 0 code-read; fallback = use its engine as a crate, new video-first shell (Path C) |
| AGPL blocks a direction we want later | decide license intent now (D-002); AGPL is fine for "open project", accept the SaaS limitation |
| Solo-dev bandwidth | v1 scope is deliberately tiny (one footage type, one platform); everything else is later |
| RapidRAW maintainer objects to a fork | it's AGPL, forking is allowed; but reach out first (D-003) — collaboration beats a fork |
