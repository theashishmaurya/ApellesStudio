# 02 — Feature Scope

> **2026-09-02 correction (D-039).** This file originally scoped a grading-only product.
> The v1 Colorist scope below is **still accurate as the Colorist tab's own scope** — the
> `CLAUDE.md` invariant ("v1 scope is deliberately tiny: one footage type, macOS ARM,
> Rec709, adjustment stack not nodes") was written for exactly this tab and still holds
> for it. What changed is that Colorist is no longer the *whole* product — it's one of
> three tabs. This rewrite keeps the Colorist section (updating status marks against what's
> actually shipped, per `docs/04-roadmap.md`) and adds the Edit and Motion tabs' own scope
> alongside it, plus fixes the old "Anti-scope" section, which flatly contradicted the
> pivot (it named editing/motion-graphics as explicitly out-of-scope, "that's the editor's
> job — Palmier/Resolve/Premiere" — the trigger for D-039 was Palmier closing).

> **2026-09-08 reconciliation (D-231).** The D-039 correction above is unchanged and still
> right. What was stale six days later was **feature status**: the Edit tab's section still
> described D-041's single-track MVP and listed multi-track/audio/transitions/MCP as out of
> scope (all shipped), and the Motion tab's section listed the entire tab as out of scope
> (it has been a real tab since D-047 and a real *authoring* tab since D-151–D-182). Both
> sections are rewritten below against `docs/04-roadmap.md` and the code. Two Colorist
> items were also stale and are corrected in place: the live scopes panel and relight, both
> of which are built.

Legend: ✅ shipped · 🔨 planned, not yet built · 🧪 AI sidecar · 🔌 MCP surface

---

## Colorist tab — "AI-native talking-head colorist" (the original v1 ship target)

The narrowest thing that proves the grading thesis. One footage type (talking head /
explainer), one platform (macOS ARM), display-referred Rec709. **This scope is unchanged
by D-039** — it's still the Colorist tab's own v1, and per `docs/notes/product-direction.md`
§8 it's still the nearest-term thing worth finishing first.

### Engine / grading
- ✅ GPU render pipeline (wgpu / WGSL) — inherited from RapidRAW
- ✅ Primary: exposure, contrast, whites/blacks/highlights/shadows, temp/tint, saturation, vibrance
- ✅ Tone curve (master + per-channel RGB)
- ✅ Colour wheels (lift/gamma/gain) with gradient sliders
- ✅ LUT node (apply `.cube`)
- ✅ HSL / colour-range qualifier
- ✅ Adjustment stack (layered, non-destructive)
- ✅ **Video I/O** — ffmpeg decode/probe/encode (D-015), a persistent decode pipe for
  scrub (D-030), a fused decode+grade+scale command for ≥30 fps playback (D-031), a
  persistent-pipe export path (D-022)
- ✅ **Shot / session model** — generalized beyond "one shot" into a multi-shot `Session`
  (D-033) persisted as a `<name>.chroma` project (D-037)
- ✅ **`.cube` bake** of the primary-only grade (D-022)

### Masking
- ✅ Shape masks (radial / linear / brush) with feather, per-mask adjustments, plus a
  per-mask `blur` (D-027)
- ✅ Depth mask via Depth Anything V2 (in-process ONNX, D-009)
- ✅ **SAM 2 subject mask** with video propagation (D-018) — the gesture-proof matte
- ✅ **Matte refinement** — SAM → trimap → ViTMatte edge-aware refine (D-016)
- ✅ **Mask keyframes** — shape/position/feather animatable at authored source frames,
  interpolated at render time (D-034); a tracked mask (SAM2) still writes its own
  per-frame matte independently
- ✅ **Depth haze preset** — one action: depth-weighted desaturate + black-lift + dehaze +
  blur, now with an optional temporal depth track for moving cameras (D-036)

### AI sidecar (Python, local, `ai/`)
- ✅ SAM 2.1 (segment + track), Rust-supervised lifecycle (D-028)
- ✅ Depth Anything V2 — in-process ONNX in Rust, not the sidecar (D-009 revised the
  original plan)
- ✅ Video Depth Anything-vits (temporal depth track, D-036)
- 🔨 `color-matcher` (Reinhard / MKL / MVGD) as a standalone reference-match transform —
  superseded in practice by the closed-loop primary-slider nudge (D-026), which shipped
  instead and covers the same use case; a true colour-science transform is still open if
  the nudge approach proves insufficient

### MCP server
- ✅ **42 tools** across shot/session, grade, masks, tracking, depth, relight, scopes,
  `match_to_reference`, `apply_haze`, export, project, agent activity/`request_human`
  (re-counted from `mcp/server.py` 2026-09-08 — the "38" here was the 2026-09-02 number)
- ✅ every mutating tool returns `{ rendered_frame, scopes }` for the agent loop (D-021)

### GUI (forked from RapidRAW, adapted to video)
- ✅ video canvas + transport (play / scrub / frame-step), native wgpu surface (D-006)
- ✅ shot strip (D-033) — the "timeline strip" line item, shipped as a shot switcher, not
  an edit timeline
- ✅ "agent activity" surface — every agent change, undoable, with a diff (D-032)
- ✅ all the adjustment/mask panels (inherited + extended)
- ✅ a dedicated live scopes panel in the GUI — **confirmed built** (2026-09-08, D-231): a
  resizable panel in `ControlsPanel.tsx` rendering `Waveform.tsx` with five display modes
  (luma / RGB / parade / **vectorscope** / histogram). The scopes *computation* is separately
  agent-facing (D-021, `inspect_color`/`sample`/`sample_region`)
- ✅ **interactive relight** — draggable depth-driven light pucks, deterministic and
  real-time (`RelightPanel.tsx` + `RelightPuckLayer.tsx`; D-048, made physically real by
  D-077/D-078/D-079's surface normals + 3D falloff), with 4 MCP tools

### Explicitly OUT of the Colorist tab's v1
Node graph · ACES/HDR · planar tracker · other footage types tuned · Windows/Linux ·
audio · conform/EDL of a full timeline · film-emulation chain · collaboration.
**Relight is no longer on this list** — the deterministic depth-driven puck relight
shipped (D-048/D-077/D-078/D-079, see the GUI section above and
`docs/notes/relight-research.md`); only the photoreal diffusion bake stays v3 (D-013).

---

## Edit tab — a real multi-track NLE (D-041 origin; scope reconciled 2026-09-08, D-231)

> This section was written on 2026-09-02 against D-041's single-track MVP. Nearly every
> 🔨 in it shipped within the following week. Rewritten against the real roadmap and code.

### Timeline model + editing
- ✅ **Multi-track** — video, audio and (D-229) subtitle tracks (`TrackKind`), stacked with
  a real alpha-over compositor (D-086/D-088), not opaque top-wins
- ✅ track lock / hide / mute / gain / reorder (D-088, D-214), and an emptied track
  auto-decommissions (D-123)
- ✅ reorder, trim (head/tail), split, remove, **ripple**, **roll**, **slip** (D-195),
  slide, **swap media** (D-195) — unit-tested `apelles-timeline` ops
- ✅ gap select + ripple-close (D-105), **multi-select** + marquee (D-107/D-137),
  **cross-track ripple / sync-lock** (D-107), **real A/V linking** (D-138)
- ✅ **timeline markers** — colour-coded, titled, frame-anchored, undoable, persisted (D-222)
- ✅ **transitions** — `cross_dissolve` + `dip_to_color`, dragged onto an edit point from a
  palette; a transition *bridges* the cut and reads handle media, clips never overlap (D-226/D-227)
- ✅ multiple named timelines per project + a `TimelineSwitcher` (D-045/D-046)

### Source kinds the Edit tab accepts
The Colorist section above scopes v1 to **one footage type**, and that line is still
its own. The Edit tab's media pool has always held more than that, and **D-281
(2026-09-10) added a fourth kind, deliberately widening this part of v1** — see that
decision for why now rather than v2:
- ✅ **video** — the ordinary case
- ✅ **audio-only** files (SFX/music, B-089), on their own tracks
- ✅ **generated clips** with no source file at all — titles (D-211) and adjustment
  clips (D-230)
- ✅ **still images** (D-281) — `.png`/`.jpg`/`.jpeg`/`.webp`/`.tif`/`.tiff`/`.bmp`, as
  ordinary video-track clips with a *synthesized* duration (a still has no length of
  its own). Video tracks only; a still has no audio stream.
  🔨 **not** animated GIF (not one frame) and **not** camera RAW (decodes above the
  media layer, and `ffmpeg` cannot open it) — either is a real feature, not a list entry
- Colorist's own **shot list** is unchanged by all of this: it takes video, and the
  project-creation picker still offers video only.

### Compositing + animation
- ✅ per-clip transform: position, uniform `scale`, **independent width/height** (D-193),
  rotation, opacity, **crop** (D-132) — all as fractions of the output composition
- ✅ **per-property keyframes** + per-property reset (D-208/D-209)
- ✅ **on-canvas transform handles** (D-136), **click the picture to select** (D-204),
  a real output-canvas boundary overlay + canvas-size control (D-199), preview zoom/pan (D-218)
- ✅ **text/title clips** — an ordinary clip on an ordinary video track, burned into both
  the live preview and the export (D-211/D-212/D-213)
- ✅ fades with real bezier `FadeCurve`s + on-clip drag handles (D-147/D-207)

### Audio
- ✅ real device playback during Play (`symphonia`→`rubato`→`dasp_sample`→`cpal`, D-050)
- ✅ **per-clip volume + pan** (constant-power law, D-223) and **track gain** + **ducking** (D-149)
- ✅ **per-clip 4-band parametric EQ** — real Audio EQ Cookbook biquads, identical
  coefficients in the live mixer and the ffmpeg export (D-224). Static by design, not
  keyframeable: ffmpeg's biquads parse their parameters once
- ✅ the export **mixes real audio** — gain/duck/fade/volume/pan/EQ replicated in the
  filtergraph, not reinvented (D-197)

### Preview, export, interchange
- ✅ scrub + play preview through a CPU compositor, independent of the Colorist's
  grade/wgpu path (D-217 — binary IPC payload, not base64)
- ✅ **video export** of the whole multi-track timeline, plus a real GUI Export button /
  dialog / sequential queue wired through the same code path as the MCP tool (D-198)
- ✅ **FCPXML 1.7** interchange export, DTD-verified (D-196)
- ✅ **media understanding** — word-level transcript + ffmpeg-scene-detect visual analysis
  via the `ai-media/` sidecar (D-189). 🔌 **agent-facing only** — 4 MCP tools and a store;
  no GUI surface consumes it yet
- 🔌 **41 Edit-tab MCP tools** + the 4 above (D-183 and successors) — an agent can drive
  essentially the whole tab

### Explicitly OUT of the Edit tab's current scope
Tracked in `docs/04-roadmap.md` (mostly item 27), not abandoned:
- 🔨 **GPU compositing** — the compositor is CPU today; `apelles-compositor` is unbuilt
- ✅ **grade-in-preview** — landed as **D-256** (2026-09-09): a clip's saved Colorist grade
  now renders in the Edit preview *and* in the Edit export, carried across as a 33³ 3D LUT
  baked by running an identity lattice through the Colorist's own wgpu pipeline. The two
  engines are still two passes, but they no longer disagree — measured equal, pixel for
  pixel. **The global grade only**: masks / local layers / the Colorist crop / relight are
  inherently outside a 3D LUT and are dropped with a warning (Export dialog +
  `editor_get_grade_status`), never silently. Carrying those needs `apelles-grade` +
  `apelles-compositor`, which is what remains of roadmap item 8.
  `docs/notes/colorist-edit-grade-bridge.md`
- 🔨 **OTIO export** — FCPXML shipped instead (D-196); XMEML/Premiere also unbuilt
- ✅ **subtitles / captions** — landed on `main` as **D-229** while this reconciliation pass
  was in flight: their own `TrackKind`, with multi-line layout owned by us so it renders
  identically in the preview and the export
- 🔨 **adjustment clips** — one effect applied top-down over every clip beneath it. Still
  ⬜ in item 27 as of 2026-09-08
- 🔨 **transcript-driven cutting** — the transcript exists (above); nothing turns it into edits
- 🔨 timeline **curve editor**, **context-sensitive trim tool**, **speed-ramp curves** (a
  flat export-time speed override exists, a ramp does not), the **seven edit types on
  drop**, **dynamic zoom**, **audio scrubbing**
- 🔨 the **EQ response-curve UI** — deliberately scoped out of D-224; the model, both
  engines and the exact dB curve function are already in place, only the interactive plot
  is missing

## Motion tab — a real authoring tab (MVP D-047; scope reconciled 2026-09-08, D-231)

> This section claimed "engine complete, tab scope not started" and listed the entire tab
> as out of scope. That has been wrong since D-047 (2026-09-02) and is very wrong after
> D-151–D-182. Rewritten.

### The engine (`packages/motion-engine/`, Remotion)
- ✅ **8 layer primitives** — `text`, `emphasis`, `matrix`, `graph`, `layers`,
  `particleflow`, `labelbox`, `layerstack` (counted from the engine's own `zod` `use` enum;
  the "7 primitives" list in older docs wrongly counted `scene3d`, which is a *scene*
  container, not a layer `use`)
- ✅ a **multi-scene** JSON manifest (`scenes: [...]`, each optionally 3D) + compiler, and
  the CLI render path
- ✅ the locked dark-Excalidraw visual design system

### The tab
- ✅ a `@remotion/player` **live preview** + transport (D-047)
- ✅ **scene management** — `+ Add scene` (D-179), selecting a scene previews/scrubs it as
  its own 0:00-start clip (D-181), and Render exports **every scene as its own video
  file** (D-180)
- ✅ a **layer list** with drag-to-reorder and real per-layer thumbnails (D-177)
- ✅ a browsable primitive **Catalog** that actually creates layers (D-151 — before it, the
  tab could edit everything and create nothing)
- ✅ a typed property **Inspector** bound to a real selection model (D-081/D-099/D-103)
- ✅ **on-canvas** select / drag / resize / marquee / group-move, in world coordinates
  (D-155–D-158)
- ✅ a per-row **keyframe timeline** — drag keys, box-select, nudge, and a real **bezier
  ease-curve editor** (D-160–D-164)
- ✅ a `zod`-validated JSON manifest editor, collapsed behind a `</>` toggle by default
  (D-153/D-173)
- ✅ Save (project-scoped `<project>.chroma/motion/manifest.json`) and Render via the
  `apelles-motion` crate → `npx remotion render`, **auto-imported into Sources** afterwards
  (D-047, D-062)

### Explicitly OUT of the Motion tab's current scope
- 🔌 **MCP tools — 0, and this is the tab's sharpest gap.** The 18 `motion_*` ops exist and
  were live-verified on the in-app control-server bridge (D-167–D-171), but the Python
  `mcp/server.py` wrappers were never written, so no MCP client can call them. Recorded in
  D-170's own closing note and in `docs/notes/mcp-tool-coverage.md`
- 🔨 undo/redo inside the tab (D-052 deferred it; the discrete named ops that make it
  possible now exist — roadmap item 16.4)
- 🔨 multi-manifest per project (one per project by choice, D-046 — waiting on a real need)
- 🔨 a Motion composition as a **nested sequence** inside an Edit timeline; render-and-import
  is the path today (D-062)
- 🔨 a packaged-build story for the engine (render shells out to `npx` in the repo)

---

## v2 — "General colorist" (Colorist-tab-specific, unchanged)

- 🔨 Node graph option (parallel + serial nodes, layer mixer) alongside the stack
- 🔨 ACES / scene-linear working space via OpenColorIO; HDR (PQ/HLG) output
- 🧪 CoTracker / TAPIR planar + point tracking, with a tracker GUI
- 🔨 Bezier roto mask + tracking
- 🔨 Film-emulation chain (port ComfyUI-Darkroom's H&D curves / halation / print stock)
- 🔌 `grade_group` (pre-clip / post-clip group nodes), `ripple_grade`, `flag_outliers`
- 🔨 Stills gallery / look library
- 🔨 OTIO round-trip (import a cut, grade per shot, export back) — now doubly relevant
  since the Edit tab is the natural source of that cut
- 🔨 Multi-footage-type presets (interview, product, screen-cap, drone)
- 🔨 Windows + Linux builds

## v3 — "Platform"

- 🔌 A stable public MCP contract others build on — across all three tabs, not just
  Colorist
- 🔨 OFX / plugin export (grade node usable in Resolve/Fusion/After Effects) — the
  gyroflow model
- 🧪 **AI relight** — the interactive depth-driven puck relight ✅ **shipped in v1**
  (deterministic, real-time — D-048, D-077/D-078/D-079, `docs/notes/relight-research.md`).
  What remains v3 is only the photoreal diffusion bake (IC-Light-style): image-first, video
  temporal consistency unsolved (D-013)
- 🧪 face-region grading, auto-balance from a colour chart, auto-shot-detection
- 🔨 Batch / headless render farm mode
- 🔨 Web viewer for review + comment
- Collaboration: shared look library, grade review workflow

### The "relight-ish" you get earlier (v1–v2, no diffusion)
Depth + shape masks fake a lot of relighting deterministically: darken one side of the
face, add a warm glow gradient (shape mask + warm exposure lift), lift the shadow side,
push a rim with a linear mask. Not IC-Light quality, but fast, controllable, and it holds
on video. Ships as part of masked grading.

---

## Anti-scope (never)

- Being a "one-click cinematic" filter on any tab. The controls stay exposed — cuts,
  motion primitives, and grade adjustments alike.
- Live/broadcast grading or editing, real-time collaboration, a plugin marketplace.
- A generation-first "vibe editing" tool chaining Sora/Veo/Kling-style models to conjure
  footage instead of working with what was shot (contrast: Mobbi AI,
  `docs/notes/product-direction.md` §7).
- **No longer anti-scope, corrected 2026-09-02:** editing, trimming, transitions, and
  motion graphics were previously listed here as "the editor's job (Palmier / Resolve /
  Premiere)." That's exactly backwards now — Palmier closing is *why* Apelles has an Edit
  and a Motion tab (D-039). Apelles no longer hands a cut back to an external editor by
  design; it can, because grade/`.cube`/ProRes export still round-trips, but that's an
  interop feature, not a scope boundary.
