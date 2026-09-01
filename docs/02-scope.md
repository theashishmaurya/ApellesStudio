# 02 — Feature Scope

Three releases. Each is a usable product on its own. Cut ruthlessly toward v1.

Legend: ✅ in RapidRAW already · 🔨 we build · 🧪 AI sidecar · 🔌 MCP surface

---

## v1 — "AI-native talking-head colorist" (the ship target)

The narrowest thing that proves the thesis. One footage type (talking head / explainer),
one platform (macOS ARM), display-referred Rec709.

### Engine / grading (mostly inherited from RapidRAW)
- ✅ GPU render pipeline (wgpu / WGSL)
- ✅ Primary: exposure, contrast, whites/blacks/highlights/shadows, temp/tint, saturation, vibrance
- ✅ Tone curve (master + per-channel RGB)
- ✅ Colour wheels (lift/gamma/gain) with gradient sliders
- ✅ LUT node (apply `.cube`)
- ✅ HSL / colour-range qualifier
- ✅ Adjustment stack (layered, non-destructive)
- 🔨 **Video I/O** — decode (ffmpeg) → per-frame grade → encode ProRes / H.264. Proxy for scrub, full-res on export.
- 🔨 **Shot model** — a "shot" = one source clip + in/out + a grade doc. Multiple shots in a session.
- 🔨 **`.cube` bake** of the primary-only grade (for editor round-trip)

### Masking
- ✅ Shape masks (radial / linear / brush) with feather, per-mask adjustments
- ✅ Depth mask via Depth Anything V2
- 🧪 **SAM 2 subject mask** with video propagation (the gesture-proof matte)
- 🧪 **Matte refinement** (edge-aware / guided filter for hair)
- 🔨 **Mask keyframes** — shape/position/feather animatable; tracked masks write keyframes
- 🔨 **Depth haze preset** — one action: depth-weighted desaturate + black-lift + dehaze + blur

### AI sidecar (Python, local)
- 🧪 SAM 2 (segment + track)
- 🧪 Depth Anything V2 (already wired in RapidRAW for stills — extend to video)
- 🧪 `color-matcher` (Reinhard / MKL / MVGD) for reference matching
- 🧪 sidecar is a local HTTP/socket service; returns mattes (RLE/PNG), depth maps, CDL suggestions

### MCP server
- 🔌 `open_shot`, `list_shots`, `render_still`, `render_range`
- 🔌 `set_primary`, `set_curve`, `set_wheel`, `apply_lut`
- 🔌 `add_mask` (shape / depth / subject), `set_mask_adjust`, `track_mask`
- 🔌 `read_scopes` (waveform / vectorscope / parade / histogram)
- 🔌 `match_to_reference` (image in → CDL/curve moves out, applied)
- 🔌 `apply_haze` (depth preset)
- 🔌 `export` (`.cube` | ProRes | grade.json)
- 🔌 every mutating tool returns `{ rendered_frame, scopes }` for the agent loop

### GUI (fork RapidRAW's, adapt to video)
- 🔨 video canvas + transport (play / scrub / frame-step) — not just a still
- 🔨 timeline strip of shots
- 🔨 scopes panel
- 🔨 "agent activity" surface — what the agent changed, undoable, with a diff
- ✅ all the adjustment/mask panels (inherited)

### Explicitly OUT of v1
Node graph · ACES/HDR · planar tracker · other footage types tuned · Windows/Linux ·
audio · conform/EDL of a full timeline · film-emulation chain · relight · collaboration.

---

## v2 — "General colorist"

- 🔨 Node graph option (parallel + serial nodes, layer mixer) alongside the stack
- 🔨 ACES / scene-linear working space via OpenColorIO; HDR (PQ/HLG) output
- 🧪 CoTracker / TAPIR planar + point tracking, with a tracker GUI
- 🔨 Bezier roto mask + tracking
- 🔨 Film-emulation chain (port ComfyUI-Darkroom's H&D curves / halation / print stock)
- 🔌 `grade_group` (pre-clip / post-clip group nodes), `ripple_grade`, `flag_outliers`
- 🔨 Stills gallery / look library
- 🔨 OTIO round-trip (import a cut, grade per shot, export back)
- 🔨 Multi-footage-type presets (interview, product, screen-cap, drone)
- 🔨 Windows + Linux builds

---

## v3 — "Platform"

- 🔌 A stable public MCP contract others build on
- 🔨 OFX / plugin export (grade node usable in Resolve/Fusion/After Effects) — the gyroflow model
- 🧪 **AI relight** — IC-Light (open-source, diffusion). Add a virtual key/rim light,
  change lighting direction/colour. **Bake-step, not a live grade node** (diffusion is
  slow + non-deterministic — conflicts with the deterministic render path; runs once,
  caches a relit source). Image-first; video temporal consistency is unsolved (D-013).
- 🧪 face-region grading, auto-balance from a colour chart, auto-shot-detection
- 🔨 Batch / headless render farm mode
- 🔨 Web viewer for review + comment
- Collaboration: shared look library, grade review workflow

### The "relight-ish" you get earlier (v1–v2, no diffusion)
Depth + shape masks fake a lot of relighting deterministically: darken one side of the
face, add a warm glow gradient (shape mask + warm exposure lift), lift the shadow side,
push a rim with a linear mask. Not IC-Light quality, but fast, controllable, and it holds
on video. Ships in v1 as part of masked grading.

---

## Anti-scope (never)

- Editing, trimming, transitions, titles, motion graphics — that's the editor's job
  (Palmier / Resolve / Premiere). Chroma hands back a graded clip or a `.cube`.
- Audio, ever.
- Being a "one-click cinematic" filter. The controls stay exposed.
