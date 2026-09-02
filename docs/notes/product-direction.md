# Product direction — under consideration (not decided)

**Status:** captured 2026-09-02, owner is thinking it over. Nothing here overrides
`docs/00-vision.md` yet. Do **not** start building against this without an explicit
go-ahead + a vision-doc rewrite + a decision entry (D-0xx).

## The trigger

Palmier Pro is going **closed-source and commercial**. It's the AI-native NLE the
current workflow leans on for the *cut* (retake/silence/filler removal via word-level
transcript editing, `/palmier-recut`). Several of the "good parts" — real per-word
timestamps (mlx-whisper backend), the transcript-driven edit model — are things we've
already had to build or re-build ourselves in `videoAgent`. Depending on a closed tool
for the middle of the pipeline is the risk the owner wants out of.

## The idea

One **AI-native, local** app, three tabs, covering the whole content pipeline the owner
actually runs (script → cut → motion graphics → grade → music → publish):

1. **Editing** — timeline, transcript-based rough cut, trim/ripple/reorder, cuts +
   simple transitions, audio. The Palmier-replacement surface.
2. **Motion** — the Remotion motion-graphics engine (already exists in `videoAgent` at
   `engine/motion/`, 7 primitives + JSON scene-manifest compiler, `/animate`). Explainer
   cards / overlays as code.
3. **Colorist** — what Chroma is today (the grade pipeline + the agent + scopes +
   tracking + depth + the project model).

AI-native throughout, following "the exact flow we follow" — i.e. an agent can drive
each stage, the human refines.

## Why this is a big deal (the honest cost)

- `docs/00-vision.md` is explicit: *"Not an NLE. No timeline editing, no trimming, no
  transitions, no audio. It grades clips handed to it."* This idea inverts that. The
  vision doc's whole thesis — that the **unclaimed** space is the AI *colorist*, because
  every open-source project is already an editor — would need rethinking.
- RapidRAW (the Chroma base) contributes **zero** editing infrastructure — "No video.
  Zero video deps. No decode, no frames, no timeline, no temporal state" (`docs/09`).
  The editing tab is a ground-up build.
- The Remotion engine lives in a **different repo** (`videoAgent`). A three-tab app means
  either vendoring it, submoduling it, or a monorepo restructure.
- Scope: a credible editing tab alone is months of solo work; Palmier is a team's
  multi-year product.

## The smaller version (if the full thing is too much)

Scope the editing tab to the **actual workflow**, not feature-parity: transcript rough
cut + a multi-shot timeline with trim/ripple/reorder + hard cuts + cross-dissolves.
That covers ~90% of talking-head/explainer needs without chasing multicam / titles /
audio mixing / effects. The project model being built now (D-037) is a shared
foundation either way.

## What's already true and reusable

- **Colorist tab**: Chroma as of D-036 (grade pipeline, agent + MCP, scopes, subject
  tracking, temporal depth track, mask keyframes, multi-shot session, activity feed).
- **Project model**: D-037 (in progress) — `~/Movies/Chroma/<name>.chroma`, saved
  projects, launcher. A three-tab app needs exactly this project container.
- **Motion engine**: `videoAgent` `engine/motion/` — Remotion, done, `/animate` +
  `/motion-primitives`.
- **Transcript / word timestamps**: `videoAgent` `src/transcribe/whisper_transcribe.py
  --word-timestamps` (mlx-whisper backend).
- **The `ai/` sidecar** already hosts SAM 2, ViTMatte, YOLO, Video Depth Anything —
  the AI substrate an editing tab's smart features (silence detection, scene detect,
  auto-reframe) would extend.

## Open questions for when this is revisited

- One repo or three? (monorepo vs Chroma + a motion submodule + shared core)
- Does the editing tab share the wgpu render pipeline with the colorist tab, or is it
  its own compositor?
- OTIO as the interchange format between tabs (cut → grade → motion overlay)?
- Is this still "open-source, local, no cloud"? (the Palmier-going-closed trigger
  suggests yes, emphatically)
- Name / licence / headline (D-002 / D-007 / D-010) all shift under this.

---

## Prior-art research (2026-09-02) — what we could build on

The colorist tab stood on RapidRAW. The question: is there an equivalent base for
the **editing tab** and the timeline/compositor gap.

### Editing tab — three architectural paths

**Path A — Remotion-based (unifies with the Motion tab).**
Chroma's motion engine already *is* Remotion. Reuse candidates:
- **Vanta** (`itsjwill/vanta`, **MIT**, "fork it and rename it") — an OSS Remotion
  editor: multi-track timeline, trim/split/join, keyframes, playhead synced to
  `@remotion/player`, built on `react-timeline-editor` (661★), JSON-exports to
  Remotion sequences. Early (~8 commits) but explicitly a reusable base. Also wires
  WhisperX word-timestamps.
- **Remotion's own** "building-a-timeline" docs + copy-pasteable Timeline component
  (the polished one is Remotion Pro, paid).
- `react-timeline-editor` — the raw timeline UI both use.
- Playback = `@remotion/player` (multi-track via `<Sequence>`); export =
  `@remotion/renderer` (headless Chrome; `@remotion/media` sped this up) **or** emit
  an EDL and assemble with ffmpeg.
- **Licence catch:** Remotion is source-available, free for individuals / non-profits
  / for-profit ≤3 people; **4+ employees → paid company licence** ($100/mo min), and
  "not selling Remotion as a product itself." Shipping an **open-source editor** built
  on Remotion is a grey zone worth a direct read of their licence FAQ — **this already
  affects the Motion tab today.**
- Pros: one engine for Motion + Editing, all React/TS, LLMs write it well, fastest to
  a prototype. Cons: the licence question; headless-Chrome export slower than native;
  a *different* render path from the colorist wgpu grade pipeline (two engines).

**Path B — OpenCut's Rust core (unifies with the colorist wgpu world).**
`OpenCut-app/OpenCut` (**MIT**, ~88k★) is mid-rewrite into a monorepo with a
**platform-agnostic Rust core**: `rust/crates/{compositor, effects, masks (JFA
feathering), gpu, time}` + `rust/wasm/` bindings — a wgpu GPU compositor built to be
embedded in different frontends. Their roadmap: "headless mode, scripting tab, **MCP
server for AI agents**" — the same direction as Chroma.
- Pros: real native GPU compositing (not headless Chrome), **same wgpu foundation as
  RapidRAW's grade shader** → the path to ONE render pipeline for cut+grade; MIT.
- Cons: it's a **pre-release rewrite** — risky to build on *now*; desktop shell is
  **GPUI (Zed's framework), not Tauri** (we'd take the crates, not the app); younger
  and less proven than Remotion. The **classic** OpenCut (Next.js, stable, browser
  render, WASM audio only) is less aligned.
- Realistic play: **track it**, prototype on Path A, adopt the compositor crate when
  its rewrite stabilises.

**Path C — Rust-native, standing on parts.** `wgpu` (already in Chroma) for the
compositor + **OpenTimelineIO** JSON as the timeline model + ffmpeg CLI (already
wired, D-015) for decode/encode/assembly. Most control, most work; Path B's crates
become the reference implementation.

### Transcript-based cut (the Descript-style feature) — low risk, well-trodden
- **CutScript** (`DataAnts-AI/CutScript`) — WhisperX word-level, local, "delete a word
  in the transcript → it's cut from the video." The edit-model to copy.
- **Rescript** (`getrescript`) — OSS, offline, Whisper word-level + speaker labels.
- **OpenScript** — local-first Descript alt.
- We already have the transcription half (`videoAgent` `whisper_transcribe.py
  --word-timestamps`, mlx-whisper); these show the text-edit → EDL layer.

### Timeline interchange — use it regardless of path
**OpenTimelineIO** (ASWF/Pixar, JSON, the modern EDL). Rust bindings exist
(`vfx-rs/opentimelineio-bind`, `opentimelineio` crate) but are **Linux-only** for now
— the JSON schema is usable directly. This should be Chroma's timeline format: it's
how a cut round-trips to/from any other tool, and it's the "the edit is code" parallel
to `grade.json`.

### Full editors worth studying (not necessarily building on)
- **OpenReel Video** (`Augani/openreel-video`, **MIT**) — React + WebCodecs + **WebGPU**,
  multi-track timeline, keyframes, **color grading**, audio effects. Browser, WebGPU —
  conceptually close to our wgpu world.
- **Twick** (`ncounterspecialist/twick`) — React **SDK** (embeddable, not a full app),
  canvas timeline, AI captions, serverless MP4 export. Closest to a drop-in editing
  component.
- **Rust NLE prototype** (dev.to, Mar 2026) — wgpu + GPUI + prompt-based editing;
  proof others are building exactly this.

### Recommendation (for when this is picked up)
1. **Timeline model = OpenTimelineIO JSON** from day one.
2. **Editing-tab UI = a Remotion-based timeline** (Vanta / `react-timeline-editor` /
   Remotion's own) — fastest to a working talking-head MVP, and the Motion tab is
   already Remotion. Resolve the Remotion OSS-licence question first.
3. **Compositor/playback**: `@remotion/player` for the MVP; **watch OpenCut's
   `rust/crates/compositor`** and adopt it (or build the wgpu equivalent sharing the
   grade pipeline) when it stabilises — that's the route to a single render engine.
4. **Transcript cut**: build on the CutScript/Rescript model + the whisper
   word-timestamps we already have.
5. **Export**: OTIO → ffmpeg assembly (ffmpeg already wired).

**Time impact:** reusing a Remotion timeline + a transcript-cut base could pull the
"lean editing tab" estimate from ~3–4 months toward **~6–10 weeks** for a
talking-head-focused MVP. Path B (Rust compositor) is the bigger, later investment
for a unified engine.

### Path D — Diffusion Studio (`diffusionstudio`, YC F24) — added 2026-09-02

The closest thing to "the thing we want to build, already built." Tagline: *"the
video editor your agents can drive."* Compositions as code, canvas ↔ JSX
bidirectional, a `dapi` CLI for agents (works with Claude Code) — nearly identical
philosophy to Chroma's "the grade is code / MCP-driven," applied to **editing**. So:
both a reusable building block **and** a competitor/validator.

- **`diffusionstudio/core`** — **MPL-2.0**, TypeScript **WebCodecs** compositing
  engine built on **Mediabunny** (which `engine/motion/` *already* depends on —
  `mediabunny 1.55.1`). Provides timeline compositions, layered tracks, clips
  (video/image/text), transitions, **masks**, keyframe animation, effects, audio,
  real-time playback **and** render modes. ~1.2k★, active. Hardware decode/encode via
  WebCodecs — **no headless Chrome** (unlike Remotion render). Browser-only, but
  Chroma's Tauri frontend *is* a browser/webview. Free tier stamps a *"Made with
  Diffusion Studio"* watermark on renders; a **one-time** licence key removes it
  (local crypto check, offline) — cleaner than Remotion's company-size fee.
- **`diffusionstudio/editor`** — MPL-2.0, full app: **SolidJS** UI + **Electron**
  shell + Vite, headless runtime engine, JSX authoring, transcript + captions,
  media inspection (waveform / filmstrip / transcription), generative assets,
  export. ~2.3k★, very active (~480 commits). **Different UI framework (Solid, not
  React) and shell (Electron, not Tauri)** — so a *reference* for the transcript /
  media-inspection UX and the JSX-composition model, not a wholesale lift.

**Where it lands vs the other paths:**
- vs **Path A (Remotion)**: `core` is an actual *editing* engine (timeline + tracks +
  playback), not a render framework you bolt a timeline onto. WebCodecs (fast, native
  HW) beats headless-Chrome export. MPL-2.0 + one-time key beats the company-size
  licence. **For the editing tab specifically, `core` looks like the better fit.**
- vs **Path B (OpenCut Rust)**: `core` is TS/WebCodecs — runs in Chroma's existing
  webview, ships now, more mature. OpenCut is Rust/wgpu — native perf, shares the
  colorist wgpu world, but pre-release. `core` = faster path; OpenCut = deeper
  unification later.
- **Risk:** Diffusion is a funded startup building exactly this. Adopting `core`
  means "Diffusion's editing engine + our colorist + our motion in one Tauri app" —
  a legit integration, but track whether their licence / direction stays friendly.

**Revised recommendation:** evaluate `diffusionstudio/core` as the **editing-tab
engine** first (MPL-2.0, WebCodecs, already shares Mediabunny with the Motion tab,
has timeline/tracks/masks/keyframes out of the box). Keep OTIO JSON as the portable
interchange on top. Remotion stays the **Motion** tab. OpenCut's Rust compositor
stays the "watch for a unified native engine" option.

---

## CONSTRAINT LOCK (2026-09-02, owner) — Rust-native, performance-first, small binary

> "our thing is Rust native performance first — we can't afford lags, we need to be
> very very performant, and small size, hence Tauri."

Diffusion Studio, Remotion, OpenCut-web, Vanta were **reference only** — for *what
features exist*, not stacks to adopt. **The editing tab is not a JS/WebCodecs/browser
engine.** No Electron, no headless-Chrome render, no GStreamer runtime bundled (size).
This **rejects Paths A (Remotion) and D (Diffusion) as engines** — Remotion stays the
Motion tab only; the rest are feature references.

### The Rust-native stack that fits

| Layer | Choice | Notes |
|---|---|---|
| **Decode** | **VideoToolbox** (macOS HW) → wgpu texture; ffmpeg CLI fallback (already wired, D-015) | zero-copy on Apple Silicon; no GStreamer bloat. Gyroflow's decode code / `oxivideo` (ex-`gpu-video`, **Apache-2/MIT**, VideoToolbox + wgpu, *pre-release "NOT READY"*) as the reference for VT→wgpu |
| **Compositor** | **wgpu**, extending Chroma's `render_core` (D-014): blend N layers + transitions, then the existing grade pass | ONE engine for cut+grade. **OpenCut `rust/crates/compositor`** (MIT, wgpu, shipping in v0.3.0 — replaced their WebGL renderer) as reference or vendored dep |
| **Timeline model** | plain Rust serde structs, **OTIO-shaped**; exports OTIO / EDL / FCPXML | "the edit is code," parallel to `grade.json`. NOT the heavy OTIO C bindings |
| **Timeline UI** | React in the existing Tauri webview — thin: sends edits, gets frames on the wgpu surface | same pattern as the grade panel today; no new UI framework |
| **Transcript cut** | whisper `--word-timestamps` (already have, mlx) → text edit → ripple ops on the model | CutScript / Rescript as the UX model |
| **Export** | composite → grade per frame → ffmpeg encode pipe (already have, D-022) | already built for the colorist |

### Why this is bounded work

Chroma **already owns** the hard single-clip parts: wgpu context, decode pipe (D-030),
render-to-surface, export pipe, ffmpeg wiring, the grade compute pass. The editing tab
adds: (1) the timeline serde model — small; (2) **multi-layer wgpu compositing** — the
real new work, blend N decoded RGBA layers + transitions on GPU feeding the existing
grade pass; (3) a thin React timeline UI; (4) the transcript-cut UX. No new runtime,
no new UI framework, binary stays Tauri-small.

### Reference projects (Rust-native, study don't necessarily adopt)

- **Gausian** (`gausian-AI/Gausian_native_editor`) — Rust + **egui/wgpu** + VideoToolbox
  + GStreamer + SQLite, AI-video focus, exports FCPXML/EDL. **MPL-2.0 core, commercial
  advanced features.** egui UI (not a frontend fit) but **modular crates**: `timeline`,
  `project`, `media-io`, `renderer`, `native-decoder`, `exporters`, `cli` — potentially
  extractable. Closest existing thing to this tab. ~1k★, young (24 commits).
- **OpenCut v0.3.0** — Rust/wgpu compositor compiled to WASM *and* native (GPUI shell).
  MIT. The compositor crate is the reusable bit.
- **`gstreamer-editing-services`** (GES) Rust bindings — a full mature NLE lib, but
  the GStreamer runtime is a large dependency + macOS packaging pain → **against the
  small-binary lock.** Fallback only if building the compositor proves too costly.
- **`cros_codecs`**, **`oxivideo`** — Rust HW-decode crates to watch.

### libopenshot (`OpenShot/libopenshot`) — evaluated 2026-09-02, **REJECTED as a dependency**

Checked at the owner's request. It's the C++ engine behind the OpenShot app
(OpenShot 3.5, March 2026). Verdict against the constraint lock:

| Constraint | libopenshot |
|---|---|
| Rust-native | ❌ C++. API is C++/Python/Ruby via **SWIG** — no C ABI, **no Rust bindings exist**; you'd hand-write + maintain FFI over a large C++ surface |
| Performance-first, no lag | ❌ **CPU compositing.** HW accel is FFmpeg **decode/encode only**; their own `doc/HW-ACCEL.md` says decoded frames are "copied back to CPU memory for the rest of the pipeline" and RTX perf is "not great." Real-time playback drops frames at 1080p+ without proxies |
| Small binary | ❌ FFmpeg + `libopenshot-audio` (a JUCE fork) + historically Qt / ImageMagick / OpenMP / ZeroMQ |
| wgpu integration | ❌ no GPU compositor to hook into — renders to CPU image buffers |
| Licence | ⚠️ LGPL-3 (lib) — workable, but the dyn-link requirement + C++ ABI churn |

**Even today's Chroma (wgpu grade pipeline) is architecturally ahead of it for
compositing.** Linking libopenshot would import its CPU-bound ceiling and its
dependency weight to get a timeline + transitions + keyframes we can build lighter.

**Still useful as a *reference*:** its `Timeline` / `Clip` / `Keyframe` (Bezier)
headers are a battle-tested model for timeline structure, effect ordering, and
keyframe interpolation — worth reading, not linking.

### Revised estimate (Rust-native)

Lean editing tab (talking-head: transcript cut + multi-shot timeline + trim/ripple +
cuts/dissolves + export): **~2.5–3.5 months** solo. OpenCut's compositor crate, if
cleanly extractable, could shave ~3–4 weeks off the compositing layer. Full parity:
8–12+ months.

### The market pattern worth noting

Palmier → closed. Diffusion Studio → MPL core + paid "advanced." Gausian → MPL core +
paid "advanced." **Every AI-video startup is "open core + paid pro."** A genuinely,
fully-open (AGPL/MPL, no commercial-feature gate) + local + Rust-fast three-tab tool
is an unoccupied position.

## The 2026 market — updated 2026-09-02 (owner asked "who's going big on AI editing")

**"Agentic video editing" became a named category in 2026**, with real money behind it —
this is validation the space is real, and a signal the window for "unclaimed" is closing.

- **a16z published "It's time for agentic video editing"** — a thesis piece, i.e. VCs are
  actively hunting this category.
- **Cardboard** (YC W2026, `cardboard.ai`) — describe a cut in plain English, the agent
  assembles a multi-track timeline. **Highest-upvoted HN launch in its whole YC batch.**
  Built on WebCodecs + Claude Sonnet, browser-based, **commercial/paid, not open**.
- **Mobbi AI** (Vega Labs) — "vibe editing," chains Seedance 2.0 / Sora 2 / Kling 3.0 /
  Veo 3.1 generation models into one conversational workflow. Generation-first, not
  grading/editing-craft-first.
- **Avid** — even the 40-year-old incumbent (Media Composer 2026.8) shipped "agentic
  capabilities" at IBC2026. When the legacy pro tool moves, the category is mainstream.
- **Runway** — not a direct editor competitor, but $544.5M raised total (+$300M more,
  Nvidia/General Atlantic/SoftBank), the ambient signal of how much capital is in
  adjacent AI-video.

**Open-source / local players emerged too — this directly narrows Chroma's "unclaimed"
claim, read carefully:**
- **`MartinDelophy/ai-video-editor`** — "creators and AI agents edit the same real
  timeline," open-source, local-first. **This is Chroma's D-020 shared-state thesis,
  independently arrived at by someone else.**
- **OpenReel Video** (`openreel.video`, MIT) — chat with an agent that controls the full
  timeline, free, local-first.
- **OpenMontage** (`calesthio/OpenMontage`) — "world's first open-source agentic video
  *production* system" — 12 pipelines, 100+ tools, 700+ agent skill/knowledge files,
  local generation models (WAN 2.1, Hunyuan), offline TTS (Piper). Reads as an
  **agent-skills framework** (closer in shape to this repo's own `videoAgent` skills)
  than a GUI app.
- **LTX Desktop** — free/open/local NLE built around the LTX-Video generation model.

**What still differentiates Chroma against all of the above (verified — none of them do
this):**
1. **Colorist depth.** Every one of these is cut-assembly-first or generation-first.
   None have a real grade pipeline — a GPU shader stack, scopes, `match_to_reference`,
   depth-based haze/relight, mask keyframes. That craft depth is still Chroma's alone.
2. **Rust-native, not browser/WebCodecs.** Cardboard and OpenReel are browser-based
   (the class of engine the owner explicitly rejected, D-039's constraint lock). Nobody
   surveyed is building the wgpu-native compositor Chroma's architecture calls for.
3. **One integrated studio, not a point tool.** Edit + Motion + Colorist sharing one
   project is a different shape than "an editor" or "a generator" alone.
4. **MCP, an open standard** — works with any MCP client (Claude Code included), not a
   bespoke chat UI bolted onto one app.

**Read on the timing:** the window to be *first* at "open + local + agentic" is closing —
`MartinDelophy/ai-video-editor` already claims the exact thesis. The window to be *best*
at "open + local + agentic + real colour science + Rust-fast" is still open, because
nobody surveyed is doing the colorist part seriously. That's the wedge to actually defend.
