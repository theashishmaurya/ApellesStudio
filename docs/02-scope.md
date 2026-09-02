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
- ✅ 38 tools across shot/session, grade, masks, tracking, depth, scopes,
  `match_to_reference`, `apply_haze`, export, project, agent activity/`request_human`
- ✅ every mutating tool returns `{ rendered_frame, scopes }` for the agent loop (D-021)

### GUI (forked from RapidRAW, adapted to video)
- ✅ video canvas + transport (play / scrub / frame-step), native wgpu surface (D-006)
- ✅ shot strip (D-033) — the "timeline strip" line item, shipped as a shot switcher, not
  an edit timeline
- ✅ "agent activity" surface — every agent change, undoable, with a diff (D-032)
- ✅ all the adjustment/mask panels (inherited + extended)
- 🔨 a dedicated live scopes panel (waveform/vectorscope) in the GUI — the scopes
  *computation* is done and agent-facing (D-021, `inspect_color`/`sample`/`sample_region`);
  a persistent on-screen panel showing them live while grading isn't confirmed built

### Explicitly OUT of the Colorist tab's v1
Node graph · ACES/HDR · planar tracker · other footage types tuned · Windows/Linux ·
audio · conform/EDL of a full timeline · film-emulation chain · relight (deterministic
puck relight moved up, see `docs/notes/relight-research.md`; photoreal diffusion bake
stays v3) · collaboration.

---

## Edit tab — MVP scope (D-041, new since D-039)

What's built:
- ✅ a single video track assembled from a project's shots, back to back
- ✅ scrub + play preview via a standalone lightweight decode→jpeg path (independent of
  the Colorist's grade/wgpu path)
- ✅ reorder, trim (head/tail), split, remove — each a unit-tested `chroma-timeline` op
- ✅ the timeline persists in the `.chroma` project (`timelines[]` + `active_timeline`,
  D-045 — supports multiple named timelines per project, model + commands only, no
  switcher UI yet)

Explicitly OUT of the Edit tab's current scope (`docs/04-roadmap.md` tracks these as
Next-queue items, not abandoned):
- Multi-track, transitions
- Audio (the preview is currently silent — flagged live by the owner as a real gap, not
  cosmetic)
- Transcript-driven cutting (whisper word-timestamps exist elsewhere in the repo,
  `videoAgent`'s `/palmier-recut` workflow proved the approach — not yet ported here)
- GPU compositing / grade-in-preview (needs `chroma-compositor`, not yet built)
- OTIO export, MCP tools for the timeline
- A mature multi-track NLE interaction model (zoom-on-scroll, edge-drag trim cursor,
  waveform-on-clip, snapping) — today's embed is functional but minimal

## Motion tab — engine complete, tab scope not started

What's built (as `packages/motion-engine/`, standalone, pre-dates the 3-tab pivot):
- ✅ 7 primitives (`text`, `emphasis`, `matrix`, `graph`, `layers`, `scene3d`,
  `particleflow`)
- ✅ a JSON scene-manifest compiler + CLI render path (`npx remotion render`)
- ✅ the locked dark-Excalidraw visual design system

Explicitly OUT of the Motion tab's current scope (all of it — this is the least-built
tab):
- Any embedded player (`@remotion/player`) inside the app
- A manifest editor of any kind (JSON-in by hand is the only authoring path today)
- A `chroma-motion` crate / render bridge from the app into the engine
- Using a Motion composition as a pool item inside an Edit timeline (nested sequences) —
  flagged as an open question, not designed (`docs/notes/product-direction.md` §9)

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
- 🧪 **AI relight** — interactive depth-driven puck relight ships earlier than originally
  planned (deterministic, real-time — `docs/notes/relight-research.md`); a photoreal
  diffusion bake (IC-Light-style) stays v3, image-first, video temporal consistency
  unsolved (D-013)
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
  Premiere)." That's exactly backwards now — Palmier closing is *why* Chroma has an Edit
  and a Motion tab (D-039). Chroma no longer hands a cut back to an external editor by
  design; it can, because grade/`.cube`/ProRes export still round-trips, but that's an
  interop feature, not a scope boundary.
