# 05 — Research: the landscape

Done 2026-09-01. The question: **does an AI-native local color grading tool already
exist?** Answer: **no.** This documents what was checked and what was found, so we don't
re-derive it.

## Method

- GitHub repo search (stars, recency, topic) across ~25 query variants
- Web search on "AI color grading", "MCP color grading", "depth mask grading", edition/API
  limitations
- Direct hands-on trials in Palmier Pro's MCP (the only editor we have with live
  agent-driven masking) to establish what an agent *can* actually do today

## What exists

### Closed pro tools — do everything, can't be built on

| Tool | Relevant capability | Why not |
|---|---|---|
| DaVinci Resolve (free & Studio) | AI Color Match, Magic Mask, **Depth Map node**, Face Refinement — all local | closed; **color page not scriptable** (no windows/qualifiers/mask/tracker via API); external scripting **Studio-only since v19.1** (Nov 2024) |
| Premiere Pro | AI masks, auto colour | closed, subscription |
| Colourlab Ai | AI colorist, shot match | closed, plugin to Resolve |

### Open-source NLEs — editing-first, grading is thin

| Tool | Note |
|---|---|
| **OpenShot 4.0** (GPL) | ONNX object masks, click-prompt, tracked across frames, masks reusable for Color Grade/Blur — closest OSS AI-masking, but basic grading, no agent |
| Kdenlive / Shotcut (MLT engine) | frei0r colour plugins, no AI masks, no agent |
| OpenCut (MIT) | CapCut clone, an emerging "MCP surface" mentioned, grading minimal |

### Open-source grading *components* — no GUI, no video, no agent

| Repo | ★ | What | Role for us |
|---|---|---|---|
| [`hahnec/color-matcher`](https://github.com/hahnec/color-matcher) | 665 | auto colour-transfer between images (Reinhard, MKL, MVGD, HM) | **shot-match-to-reference** |
| [`jeremieLouvaert/ComfyUI-Darkroom`](https://github.com/jeremieLouvaert/ComfyUI-Darkroom) | 101 | 161 film stocks, physics H&D curves, halation, print-stock chain | **film-emulation science** (v2) |
| [`ozwaldorf/lutgen-rs`](https://github.com/ozwaldorf/lutgen-rs) | 589 | fast LUT gen/apply, **Rust** | LUT ops |
| `ZHKKKe/NeuralPreset` | 353 | real-time 4K neural colour style transfer (CVPR'23) | look transfer (maybe) |
| **libplacebo** (`haasn/libplacebo`) | 776 | mpv's colour-managed GPU render core, HDR, shader hooks, **C** | the render engine *if we don't fork RapidRAW* |
| **OpenColorIO** | 2090 | colour management standard (ACES, transforms, LUTs), C++ | v2 colour management |

### AI models (all local, run on Apple Silicon MPS)

- **SAM 2** — segment + **video propagation**. The gesture-proof subject mask.
- **Depth Anything V2** — monocular depth. (Already integrated in RapidRAW for stills.)
- **CoTracker / TAPIR** — point + planar tracking (v2, drives shape-mask keyframes).
- **RobustVideoMatting** / guided filter — matte edge refinement.

### MCP servers that touch this space

| Repo | ★ | Note |
|---|---|---|
| [`samuelgursky/davinci-resolve-mcp`](https://github.com/samuelgursky/davinci-resolve-mcp) | 2350 | mature, MIT, 36/353 tools — but **Resolve's color page isn't scriptable**, so it's edit/render/CDL only; free-edition support is a fragile console-bridge hack |
| `iwaju-labs/luttie-mcp-plugin` | 0 | Luttie = LUT catalog + AI-LUT-*generation* service, image-only, no masks |
| `artokun/comfyui-mcp` | 707 | agent control of ComfyUI — node graph + local models, but ComfyUI is batch-oriented, no video scrub, no scopes, not a grading GUI |
| `ahujasid/blender-mcp` | 26k | Blender, not a grading tool |

## The Palmier trials (what an agent can actually do today)

Ran live on a real talking-head project in Palmier Pro's MCP:

- ✅ Create ellipse/rect/linear masks (free), grade *inside* them (`apply_color` +
  `maskTargets`), effect inside them (`apply_effect` + `maskTargets`), blur a masked
  region, invert a mask for background isolation.
- ✅ The agent iteration loop works: `apply_color → inspect_timeline (rendered frame) →
  read the result → adjust`. The agent is **not blind** — it reads rendered frames.
- ✅ Zero credits for shape masks + grading.
- ❌ **Shape masks can't hug a body.** Subject ellipse + inverted-bg ellipse gave a
  decent moody separation, but the moment the forearms splay wide they fall into the
  "background" mask and get darkened/muddied. Confirmed visually.
- ❌ **No depth mask** in Palmier — can't do atmospheric haze / grade-by-distance.
- ❌ **Mask geometry can't be keyframed via MCP** (only position/scale/crop/blur/etc.) —
  a shape mask sits still, can't track a moving subject.
- ❌ Magic Mask (SAM-based, tracks properly) **costs credits**.

**These four ❌ are the product.** They're not Palmier bugs — they're the ceiling of
shape-mask grading, and exactly what Resolve solves and no OSS tool does.

## The find: RapidRAW

[`CyberTimon/RapidRAW`](https://github.com/CyberTimon/RapidRAW) — 9.7k★, **Rust + wgpu +
Tauri**, AGPL-3.0, one very active solo dev (commits ~daily, Aug 2026).

Non-destructive GPU **image** editor that already has, per its changelog:
- custom **direct WGPU renderer** (WGSL) — 2026-04-18
- **depth masking via Depth Anything V2** — 2026-04-01
- **AI masks** + edge-aware refinement, intersect/duplicate/flow modes — 2026-04..08
- **AI Lens Blur** (depth-of-field background blur) — 2026-07-26
- colour grading wheels w/ gradient sliders, curves, WB picker, LUTs, auto-adjust
- presets/copy-paste carrying masks & crops
- touch support, mobile builds

**~70% of the engine we need, in Rust, open source.** Gaps: it's photo-only (no video,
no timeline, no tracking), no node graph (layer stack instead — fine for grading), no
MCP/agent, no scopes, no shot-match. Those gaps ≈ the layer we want to own.

## Decision

Nothing open-source does this. The pro tools that do are closed and un-scriptable on the
color page. The components exist but nobody's assembled them with an agent in front.

**Build it. Fork RapidRAW as the engine base** (Path A in `docs/03-architecture.md`).
Fallbacks documented: libplacebo + own GUI (Path B), RapidRAW-as-crate + new shell
(Path C).
