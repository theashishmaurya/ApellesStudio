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
