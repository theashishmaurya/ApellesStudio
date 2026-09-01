# 04 — Roadmap

Phased. Each phase ends at a demoable checkpoint. Timelines are rough solo-dev estimates,
not commitments.

---

## Working queue — round 2 (to v1)

Round 1 done (D-021…D-025): scopes/`inspect_color`, export + `.cube`, mask
composition ops, depth-haze, `grade.json`. Round 2, in order:

1. [x] **`match_to_reference` auto-apply** (D-026, 2026-09-01) — the gap already
   computes (D-021); this closes the loop: measure the scope gap to a reference
   image, apply a **damped** primary correction (exposure / temperature / tint /
   contrast / saturation) with per-step ceilings + roll-back-on-worse +
   best-snapshot, re-measure, iterate. `match_reference` op in
   `useChromaControl.ts`; MCP `match_to_reference(reference, strength?, max_iters?,
   tolerance?)`. Primary only (a match is a balance) — creative/curve/mask work is
   separate. Detail: `docs/notes/match-reference.md`.
2. **Per-mask blur** — a blur field on `MaskAdjustments` + shader wiring (or drive a
   global lens-blur pass off a mask). Completes depth-haze (background defocus) and
   unblocks "blur the background" as a mask op.
3. **Rust-managed sidecar spawn** — the app starts/monitors `ai/` (venv-aware), no
   manual `ai/run.sh`. `chroma_ai_health` already exists; add spawn + restart-on-crash.
4. **Strip `@clerk/react`** — remove the community-login dep from the frontend
   (auth stubs, the `<TitleBar>` error, the dev-key warnings). Irrelevant to Chroma.
5. **Smooth playback / proxy** — a persistent ffmpeg decode pipe (or a pre-rendered
   half-res proxy) so scrub + play aren't ~5–10 fps and export doesn't decode from
   frame 0. (D-015 flagged this.)

Round 3 (after): `request_human` + a GUI "agent activity" feed (per-change diff +
undo), multi-shot session model + shot strip, multi-subject batch tracking (D-017),
mask keyframes, agent eval harness. Then Phase 4 release (packaging/signing,
external-reader docs + README + demo, decide name/license/headline — D-002/D-007/D-010).

---

## Round 1 — done (2026-09-01)

1. [x] **Scopes + `inspect_color`** (D-021, 2026-09-01) — `engine/src/utils/scopes.ts`,
   pure JS off the captured preview (not WGSL — the agent path, separate from the
   UI's Rust waveform). `computeScopes` (black/white points, luma + per-channel
   clip %, per-zone means, warm-cool + green-magenta cast, 12-bin hue histogram,
   mean saturation), parade + vectorscope PNGs, `computeGap` (reference→knob
   hints). MCP `inspect_color(frame?, reference?)` + `sample` / `sample_region`;
   every mutating op response now also carries `scopes`. Scope-first discipline in
   the tool docstrings + `mcp/README.md`. Detail: `docs/notes/scopes.md`.
2. [x] **Export** (D-022, 2026-09-01) — `engine/src-tauri/src/chroma/export.rs`:
   one `ffmpeg -f rawvideo` decode pipe → `render_core::render` per frame (one
   GPU ctx + `OwnedRenderCaches` for the run; `transform_hash = frame`) → one
   `ffmpeg` encode pipe. ProRes 422 HQ (`prores_ks -profile:v 3`) / H.264
   (`libx264 -crf 18`). Per-frame tracked matte via `state::set_current_frame`
   before each grade (D-019). `bake_primary_lut` — `size³` identity lattice
   through the primary grade only → `.cube` (warns on dropped masked layers).
   Commands `chroma_export_video` (bg + `chroma_export_progress` poll) /
   `chroma_bake_lut`; frontend `export` / `export_progress` bridge ops; MCP
   `export(kind, path?, from?, to?)`. Detail: `docs/notes/export.md`.
3. [x] **Mask refinement = RapidRAW's composition** (D-023, 2026-09-01) —
   NOT a +/− point mechanism. "Subtract from Mask → Subject" already does
   edge-aware SAM exclude. MCP exposes it: `add_subject_mask(mode)`,
   `add_component(mask_id, type, mode)` (add a Subject/Radial/Linear/Brush
   sub-mask to an existing container, default subtractive), `set_submask_mode`.
   No +/− point UI built; the sidecar/engine `points` support stays unused.
4. [x] **Depth-haze preset** (D-024, 2026-09-01) — one action → a "Depth Haze"
   mask: a full-range `ai-depth` sub-mask **inverted** (mask value == distance),
   graded with negative `dehaze` (adds haze) + `saturation -25` + `blacks +10` +
   `shadows +8`, all × `amount`. Depth is a **static** bake (per-frame /
   temporal smoothing deferred); `chroma_seek` busts `ai_state.depth_map` so a
   re-apply on a new frame is correct. `useAiMasking.handleAddDepthHaze`, an
   "Add depth haze" button, MCP `apply_haze({amount?, protect_subject?})`. Also
   landed: `useChromaControl` mounted app-level + `open(path)` op. Detail:
   `docs/notes/depth-haze.md`.
5. [x] **`grade.json` schema + load/save** (D-025, 2026-09-01) —
   `engine/src-tauri/src/chroma/grade.rs`. v1 = a **versioned, documented wrapper**
   around RapidRAW's `adjustments` (`{schema:"chroma.grade/1", shot, adjustments,
   notes}`), NOT `docs/06`'s ordered `stack` (that's the v2 node graph, D-005).
   Mask mattes externalized: static → `<name>.mattes/<subId>.png` (`{"$matte"}`),
   tracked → `{"$trackDir"}` (referenced, not copied). `chroma_save_grade` /
   `chroma_load_grade` + a `chroma.grade/<major>` migration gate. Frontend
   `get_grade` / `save_grade` / `load_grade` ops; MCP 3 tools. One grade per open
   clip — full session/shot model still open. Detail: `docs/notes/grade-json.md`.

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
- [x] Video I/O: per-frame grade → ProRes/H.264 encode (D-022, 2026-09-01). Proxy
      cache still pending (decode is from-frame-0 per export — a bake, not scrub).
- [x] Transport bar (`ChromaTransport`) — play/step/scrub; `chroma_seek` decodes the frame + re-renders with the grade. Naive stepper (~5-10fps), no proxy yet.
- [x] Timeline view (`ChromaTimeline`) — replaces the filmstrip when a video is loaded: a 48-frame thumbnail strip (`chroma_frame_thumbnails`, cached), click/drag to seek, playhead marker.
- [ ] Smooth playback — persistent decode pipe or pre-rendered proxy
- [~] Shot / session model + `grade.json` load/save/validate — **`grade.json` done**
      (D-025, `chroma/grade.rs`: save/load, versioned schema, matte externalization).
      Full session/shot model (multiple shots, in/out, shot strip) still open.
- [ ] Video canvas + transport in the GUI (play/scrub/step, playhead, in/out)
- [ ] Shot strip (selector)
- [ ] Scopes: waveform, RGB parade, vectorscope, histogram (WGSL compute)
- [x] `.cube` bake of the primary grade (D-022, 2026-09-01 — `bake_primary_lut`)
- [ ] All inherited adjustment/mask panels working against a video frame, not a still

**Checkpoint:** grade a talking-head clip by hand, scrub it, export a `.cube` that matches in Palmier.

---

## Phase 2 — AI sidecar  ·  ~3–4 weeks

- [x] Sidecar service (FastAPI, `ai/`), `/segment` = SAM 2 → trimap → ViTMatte (D-016). Lifecycle: run `ai/run.sh` for now; Rust-managed spawn TBD.
- [~] Depth Anything V2 for video (extend RapidRAW's still integration; temporal smoothing)
      — per-frame works: `chroma_seek` busts the depth cache (D-024), so a depth mask
      re-generated on frame N grades frame N's depth. **Static bake** in the preset;
      keyframed track + temporal smoothing still open.
- [x] Engine wiring: `chroma_subject_mask(box)` → sidecar → matte → stored as an `ai-subject` mask (reuses RapidRAW's `AiSubjectMaskParameters` + mask-bitmap path). Box-drag on a loaded video routes here instead of ONNX SAM. `src/chroma/mask.rs` + `chroma_ai_health`.
- [x] Mask include/exclude refinement — **via RapidRAW's Add/Subtract/Intersect composition, not +/− points** (**D-023**). "Subtract from Mask → Subject" already does edge-aware SAM exclude. MCP: `add_subject_mask(mode)`, `add_component`, `set_submask_mode`. No point UI; `ai/` + engine `points` support stays unused.
- [x] Matte refinement pass — ViTMatte, D-016 (was: guided filter / RVM).
- [x] Per-frame subject tracking via **SAM 2 memory propagation** (D-018): prompt once, feed frames, ~180ms/frame mask. Sidecar `/track` (bg job, disk cache) + `/refine_track`.
- [x] **In-app tracking works end to end** (D-019): "Track subject across clip" → scrub → the matte + red overlay + grade follow the frame in lockstep. Matte read from disk at render time; `chromaTrackDir` persists with the project (no re-track on reopen). "Finalize matte" for the full-quality pre-export pass. Sidecar memory bounded (B-002).
- [ ] Multi-subject: two `ai-subject` masks each with their own `chromaTrackDir` should already work (untested); batch N objects into one propagation pass (`max_obj_num > 1`) so they don't each cost a full pass (D-017)
- [ ] `color-matcher` → reference match returns a CDL/curve fragment
- [x] **Depth haze preset** (D-024, 2026-09-01) — one action, depth-weighted desat +
      black-lift + dehaze (blur deferred — no per-mask blur field). `docs/notes/depth-haze.md`
- [ ] Mask keyframes in the data model + GUI handles

**Checkpoint:** click "isolate subject" → tracked matte that holds through hand gestures; "add haze" → depth-graded background separation.

---

## Phase 3 — MCP + the agent loop  ·  ~2–3 weeks

- [x] **Control server + MCP bridge (D-020)** — `src/chroma/control.rs` (in-app HTTP) ⇄ Tauri events ⇄ `useChromaControl` (frontend owns the state). `mcp/` Python stdio server. One shared grade/mask doc: MCP edits move the app's real sliders/history, `get_state` reflects manual edits. v1 ops: primary, curves, wheels, seek, subject mask + track, per-mask grade, invert, delete. Verified with real `curl` + an MCP client against the C019 take.
- [ ] Tools: shot ops, ~~primary, curves, wheels~~, LUT, masks (~~subject~~ / shape / ~~depth (via `apply_haze`)~~), ~~scopes~~, match_to_reference, ~~apply_haze~~ (D-024), ~~export~~ (D-022), ~~open~~
- [x] Every mutating op returns `{image_b64, histogram, adjustments}` (image is a best-effort `generate_uncropped_preview` re-render — the app renders to a native WGPU surface)
- [ ] `request_human(reason, roi)` handoff + the GUI "agent activity" feed with per-change diff + undo
- [ ] Agent eval: a scripted brief → measure round-trips to an acceptable grade (G1, G2)

**Checkpoint:** a full talking-head grade (primary + tracked subject + depth haze + shot match) done in one Claude Code conversation + <5 min human mask cleanup. **This is v1.**

---

## Phase 4 — Harden & release v1  ·  ~2 weeks

- [ ] Strip the `@clerk/react` community-login dep from the frontend (irrelevant to Chroma; noted since Phase 0)
- [ ] Rust-managed sidecar lifecycle — spawn/monitor `ai/` from the app, no manual `ai/run.sh`
- [x] Control-server bridge: mount `useChromaControl` at app level (2026-09-01, D-024) —
      moved from `Editor` to `App`; `/op` now works before a file is open. Paired with a
      new `open(path)` op so a clip can be loaded headlessly.
- [ ] OTIO or a simple session import from Palmier (grade the shots the editor cut)
- [ ] ProRes export round-trip verified with `swap_clip_media`
- [ ] Packaging: signed macOS build, the sidecar + its Python bundled, models auto-downloaded
- [ ] `docs/` cleaned for external readers; a real README with a 90-second demo
- [ ] Decide: name (**D-010**), license (**D-002**), v1 headline feature (**D-007**)
- [ ] Ship. Get one external user. Open the issue tracker.

**v1 = done when:** the Phase 3 checkpoint (full talking-head grade in one Claude
conversation + <5 min human cleanup) passes on 3 real clips, export round-trips to
Palmier, and it's a signed installable build.

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
