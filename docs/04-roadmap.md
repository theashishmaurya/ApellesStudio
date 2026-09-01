# 04 — Roadmap

Phased. Each phase ends at a demoable checkpoint. Timelines are rough solo-dev estimates,
not commitments.

---

## Phase 0 — Scaffolding & spikes  ·  ~1 week

- [x] Repo, submodule (RapidRAW → `engine/`), docs
- [ ] Build RapidRAW locally on Apple Silicon, confirm the wgpu renderer runs
- [ ] Read `engine/src-tauri` — map the render pipeline, the adjustment model, the mask code, the Depth Anything integration
- [ ] **Spike D-006**: can wgpu render to a native surface under the Tauri webview? Prototype a video frame on screen with UI chrome over it.
- [ ] **Spike**: ffmpeg decode → feed one frame into RapidRAW's existing grade graph → render it graded. Proves the "video is just per-frame stills" premise.
- [ ] **Spike**: SAM 2 on Apple Silicon MPS — segment + propagate one 10s clip, measure fps, look at matte quality on the hands problem.
- [ ] Decide: fork hard vs. talk to the RapidRAW maintainer (D-003)

**Checkpoint:** a graded video frame on screen, the architecture spikes answered.

---

## Phase 1 — Video grading core  ·  ~3–4 weeks

- [ ] Video I/O: decode → proxy cache → per-frame grade → ProRes/H.264 encode
- [ ] Shot / session model + `grade.json` load/save/validate
- [ ] Video canvas + transport in the GUI (play/scrub/step, playhead, in/out)
- [ ] Shot strip (selector)
- [ ] Scopes: waveform, RGB parade, vectorscope, histogram (WGSL compute)
- [ ] `.cube` bake of the primary grade
- [ ] All inherited adjustment/mask panels working against a video frame, not a still

**Checkpoint:** grade a talking-head clip by hand, scrub it, export a `.cube` that matches in Palmier.

---

## Phase 2 — AI sidecar  ·  ~3–4 weeks

- [ ] Sidecar service (FastAPI), process lifecycle managed by the Rust core
- [ ] Depth Anything V2 for video (extend RapidRAW's still integration; temporal smoothing)
- [ ] SAM 2 subject mask + video propagation → per-frame matte into a `subject` mask type
- [ ] Matte refinement pass (guided filter / RVM) for edges
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
