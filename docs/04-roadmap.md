# 04 — Roadmap

Phased. Each phase ends at a demoable checkpoint. Timelines are rough solo-dev estimates,
not commitments.

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
- [ ] **D-014: extract `render_core`** — Tauri-free `render(gpu, base, req) -> DynamicImage` + `init_gpu_context()`; needed for headless render + the MCP server, not for the GUI video path.
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
- [ ] Interactive +/− point prompts on the canvas (sidecar already takes `points`; needs konva click UI + a points array in the submask params + re-invoke per click)
- [x] Matte refinement pass — ViTMatte, D-016 (was: guided filter / RVM).
- [x] Per-frame subject tracking via **SAM 2 memory propagation** (D-018): prompt once, feed frames, ~180ms/frame mask. Sidecar `/track` (bg job, disk cache) + `/refine_track`; engine `chroma_track_subject` / `_track_status` / `_subject_matte_for_frame` / `_refine_tracked_frame` (all per sub-mask id, D-017); "Track subject across clip" + "Finalize matte" buttons; seek-swaps every tracked sub-mask. **fast/quality** — guided-filter edge on the pass, ViTMatte on the visible frame + the finalize pass.
- [ ] Batch multiple objects into one propagation pass (`max_obj_num > 1`) so N subjects don't each cost a full pass
- [ ] `color-matcher` → reference match returns a CDL/curve fragment
- [ ] **Depth haze preset** — one action, depth-weighted desat + black-lift + dehaze + blur
- [ ] Mask keyframes in the data model + GUI handles

**Checkpoint:** click "isolate subject" → tracked matte that holds through hand gestures; "add haze" → depth-graded background separation.

---

## Phase 3 — MCP + the agent loop  ·  ~2–3 weeks

- [ ] MCP server (D-008), wired to the core over the local socket
- [ ] Tools: shot ops, primary, curves, wheels, LUT, masks (shape/depth/subject), scopes, match_to_reference, apply_haze, export
- [ ] Every mutating tool returns `{rendered_frame, scopes}`
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
