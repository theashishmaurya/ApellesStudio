# Product direction — decided (D-039), this is the research record

**Status: DECIDED.** Chroma is a 3-tab AI-native video app — **Edit / Motion /
Colorist** — locked as **D-039** (`docs/08-decisions.md`) and under active
construction (`docs/04-roadmap.md`). This file is the **research and rationale
archive** that led there and keeps accumulating as the build continues — not an
open question anymore. If anything here conflicts with `08-decisions.md`, the
decision doc wins; update this file to match.

---

## 1. The trigger

**Palmier Pro — the AI-native NLE this pipeline leaned on for the cut — is going
closed-source and commercial.** The genuinely valuable parts (real word-level
transcript timestamps, the transcript-driven edit model) are things already
rebuilt independently in `videoAgent` (`whisper_transcribe.py --word-timestamps`,
mlx-whisper). Depending on a closing tool for the middle of the pipeline was the
risk to remove.

## 2. The decision (D-039)

One AI-native, **local** app, three tabs, covering the whole pipeline this project
actually runs — script → cut → motion graphics → grade → publish:

1. **Editing** — timeline, transcript-based rough cut, trim/ripple/reorder, cuts +
   transitions, audio. The Palmier-replacement surface.
2. **Motion** — the Remotion motion-graphics engine, moved in from `videoAgent`
   as `packages/motion-engine/` (7 primitives + JSON manifest compiler — already
   built, just needs a tab UI wired to it).
3. **Colorist** — Chroma as it existed pre-pivot: the grade pipeline, the agent,
   scopes, tracking, depth, the project model.

**Constraint lock (owner, non-negotiable):** Rust-native, performance-first
("can't afford lags"), small binary — **hence Tauri**. This explicitly **rejects**
JS/WebCodecs/headless-Chrome editing engines (Remotion-as-editor, Diffusion
Studio, OpenCut-web) and heavy C++ runtimes (libopenshot). Remotion stays *only*
as the Motion tab's engine — never the editing engine.

**Architecture:** thin-shell/fat-core Rust workspace (`crates/`) + a matching
frontend package workspace (`packages/`), monorepo (`app/` = the vendored
RapidRAW fork, submodule dropped D-040). Full crate/package table, dependency
layers, and the migration plan live in `docs/notes/architecture-lock.md` — not
duplicated here.

## 3. Why this is genuinely hard (say it plainly)

- `docs/00-vision.md` originally said *"Not an NLE."* That thesis — the
  unclaimed space is the AI **colorist**, because every open project is already
  an editor — is now superseded, not forgotten. It's *why* the Colorist tab still
  gets the deepest craft investment even inside a 3-tab app (§6).
- RapidRAW contributed **zero** editing infrastructure — "No video, no timeline,
  no temporal state" was the honest starting line for the Editor tab.
- The Motion engine lives in a different repo's history (`videoAgent`) — now
  resolved by the monorepo move, but was a real seam.
- A credible **editing tab alone** is months of work solo; see §5 for the actual
  numbers, twice (once naive, once recalibrated against what we've actually
  shipped with Claude).

## 4. Reuse — what to build on, and what got rejected

### 4.1 Editing-tab engine — four paths considered

| path | what | verdict |
|---|---|---|
| **A — Remotion-as-editor** | `react-timeline-editor` / Vanta / Remotion's own timeline component | **Rejected as the engine** (JS/WebCodecs, against the constraint lock). `react-timeline-editor` still used as the **UI widget** — it's a control surface, not a render path, so it doesn't violate the lock (Editor MVP, D-041). |
| **B — OpenCut's Rust compositor** | `OpenCut-app/OpenCut` (MIT, ~88k★), mid-rewrite to a wgpu compositor in `rust/crates/` (compositor/effects/masks/gpu/time), shipping since v0.3.0 | **Watch, adopt when it stabilises.** Same wgpu foundation as Chroma's grade shader — the path to one render engine for cut+grade. Pre-release risk today. |
| **C — Rust-native from parts** | `wgpu` (already in Chroma) + OTIO-shaped serde timeline + ffmpeg CLI (already wired, D-015) | **The actual chosen path** (see `architecture-lock.md`'s `chroma-compositor`). Path B's crates are the reference implementation to study. |
| **D — Diffusion Studio** | `diffusionstudio/core`, MPL-2.0, WebCodecs, built on Mediabunny (already a `motion-engine` dep) | **Rejected as the engine** (browser/WebCodecs, against the lock). Genuinely the closest philosophical match (*"the video editor your agents can drive"*) — reference for feature completeness, not a dependency. |

**libopenshot** — evaluated separately, **rejected outright**: C++, SWIG-only API
(no Rust bindings), **CPU compositing** (HW accel is ffmpeg decode/encode only —
their own docs admit the GPU↔CPU round-trip is the bottleneck), heavy deps
(JUCE audio, historically Qt/ImageMagick). Even today's Chroma (wgpu grade
pipeline) is architecturally ahead of it. Keep its `Timeline`/`Clip`/`Keyframe`
headers as a *reading* reference only.

### 4.2 The Rust-native stack that fits the lock

| layer | pick | why |
|---|---|---|
| Decode | `re_video` (Rerun, MIT/Apache) or native VideoToolbox → wgpu texture; ffmpeg-CLI fallback (D-015, already wired) | zero-copy on Apple Silicon, no GStreamer bloat |
| Compositor | `chroma-compositor` on `wgpu`, extending `render_core` (D-014); OpenCut's crate as reference | one engine for cut + grade |
| Timeline model | OTIO-shaped serde structs (not the OTIO C bindings) | "the edit is code," parallel to `grade.json`; `chroma-timeline` (D-041) already started this |
| Timeline UI | `react-timeline-editor` (MIT) | a control surface — video never flows through it, so it's perf-neutral despite being JS |
| Transcript cut | whisper `--word-timestamps` (already have) + the CutScript/Rescript edit-model | low risk, well-trodden |
| Audio | `symphonia` + `cpal` + `rubato` + `dasp` | native Rust, no runtime cost |
| UI kit | `@chroma/ui` on **shadcn/ui + Base UI** (D-042, built) | canonical, not hand-rolled — see D-042 |

### 4.3 Why the editing tab is *bounded* work, not greenfield

Chroma already owns the hard single-clip parts: wgpu context, decode pipe
(D-030), render-to-surface, export pipe (D-022), the grade compute pass, 30fps
playback (D-031). The Editor tab is an *extension* of proven code — the
multi-layer compositor is the one genuinely new system.

## 5. Timelines — two takes, and which one to trust

### 5.1 The "what does a full NLE cost" breakdown (solo-human baseline)

| system | solo-human effort |
|---|---|
| Timeline & edit model | 1.5–2 mo |
| **Playback / multi-track compositor** ← the long pole | 3–4 mo |
| Audio subsystem | 2–3 mo |
| Transitions & effects | 2–3 mo |
| Media management | 1 mo |
| Export / render | 1–1.5 mo |
| Timeline UI (the most complex widget in any NLE) | 2–3 mo |
| Interop (OTIO/EDL) | 3–4 wk |
| Project/session | 2–3 wk |

**Tiers:** Lean (your actual workflow) ~2–3 mo solo · Creator-complete ~10–14 mo
solo · Pro-parity (Premiere/Resolve) ~3–5 years solo, **don't chase this one**.

### 5.2 Recalibrated against what's actually shipped with Claude + subagents (2026-09-02)

Speedup is **not uniform** — it depends on work type:

| work type | speedup vs. solo-human |
|---|---|
| Wiring, CRUD, refactors, UI-from-a-kit, tests, docs, known-pattern model integration | ~3–4× |
| Real-time/GPU/timing debugging, cross-boundary integration bugs | ~1.3–1.5× |
| Novel algorithm design (compositor blend math, audio sync) | ~1.3–1.7× |
| UX taste calls against real footage | ~1× (that's still you) |

**Recalibrated tiers:** Lean editing tab **~4–7 weeks** calendar (if engaged
near-daily) · Creator-complete **~4–6 months** · Pro-parity still **2–3+ years**
— Claude doesn't change "this is a company-sized product."

**What actually determines the calendar number:** your hours/day and turnaround
speed on testing + decisions (proven today — fast replies = fast progress),
session rate limits (hit twice in one day already), and whether the compositor/
audio/playback debugging gets gnarly (those estimates are the softest). Speed
without the docs discipline (`CLAUDE.md`'s hard rule) accrues cleanup debt that
eats the gains — that's *why* the rule exists, not decoration.

## 6. What's already true and reusable (as of 2026-09-02)

- **Colorist tab** — the pre-pivot Chroma: grade pipeline, agent + MCP (38+
  tools), scopes, subject tracking (SAM2+ViTMatte), temporal depth track (VDA),
  mask keyframes, multi-shot session, activity feed, eval harness.
- **Project model (D-037/38)** — `~/Movies/Chroma/<name>.chroma`, the container
  all three tabs share.
- **Motion engine** — `packages/motion-engine/`, fully functional, needs only a
  tab UI (`@remotion/player` embed + manifest editor) — **currently the
  single biggest gap in the active roadmap queue**, see `04-roadmap.md`.
- **Transcript / word timestamps** — `videoAgent`'s mlx-whisper backend.
- **`@chroma/ui`** — shadcn/Base UI, themed, 18 structural components (D-042).
- **3-tab shell, launcher-as-entry-screen, Editor MVP** — all live (D-039
  migration log).

## 7. The 2026 market — why the window narrowed, and where the wedge still is

**"Agentic video editing" became a named, funded category in 2026** — not
unclaimed anymore, but validated at scale:

- **a16z** published *"It's time for agentic video editing"* (VC thesis piece).
- **Cardboard** (YC W2026) — describe a cut, agent assembles a multi-track
  timeline. Highest-upvoted HN launch in its batch. WebCodecs + Claude Sonnet,
  browser, **paid, closed**.
- **Mobbi AI** — "vibe editing," chains Seedance/Sora/Kling/Veo generation
  models. Generation-first, not editing/grading-craft-first.
- **Avid** shipped agentic features at IBC2026 — when a 40-year incumbent moves,
  the category's mainstream.
- **Runway** — $544.5M+ raised, ambient signal of capital in adjacent AI-video.
- **Eddie AI** (`heyeddie.ai`) — closest *feature* shape to Chroma's ambition:
  rough-cut, transcription + soundbite ID, **B-roll auto-tagging with visual
  descriptions** (real proof-of-demand for the visual-search feature, see
  `docs/notes/video-search.md`), colour grading, AI music, multicam, MCP-callable.
  But a **companion/logging tool**, not a standalone NLE — preps footage, hands
  off to Premiere/FCP/Resolve to finish. Cloud, credits, 50k+ users, closed.
  (An "Anthropic-affiliated" read off their page was **unverified** — likely a
  misread of their MCP/Claude integration; don't repeat as fact.)

**Open-source, local competitors also emerged — the part that actually narrows
the "unclaimed" claim:**
- **`MartinDelophy/ai-video-editor`** — "creators and AI agents edit the same
  real timeline," open-source, local-first. **This is Chroma's exact D-020
  shared-state thesis, arrived at independently.**
- **OpenReel Video** (MIT) — chat-driven timeline agent, free, local.
- **OpenMontage** — "world's first open-source agentic video *production*
  system," reads more like an agent-skills framework (closer to `videoAgent`'s
  own skill set) than a GUI app.
- **LTX Desktop** — free/local NLE built around the LTX-Video generation model.

**What still differentiates Chroma, checked against all of the above:**
1. **Real colour science** — none of them have a grade pipeline this deep (GPU
   shader stack, scopes, `match_to_reference`, depth-based haze/relight, mask
   keyframes). Still Chroma's alone.
2. **Rust-native, not browser** — Cardboard/OpenReel/Diffusion Studio are all
   WebCodecs-in-browser, the exact class rejected on performance grounds.
   Nobody surveyed is building the wgpu-native compositor Chroma's architecture
   calls for.
3. **One integrated studio**, not a point tool.
4. **MCP**, an open standard — any MCP client, not a bespoke chat UI.

**The honest read:** the window to be *first* at "open + local + agentic"
already closed (`MartinDelophy/ai-video-editor` has that exact tagline). The
window to be *best* at "open + local + agentic + real colour science +
Rust-fast" is still open — nobody surveyed takes the colorist part seriously.
**That's the wedge to defend, not the category label.**

## 8. Business — is this worth money (owner asked 2026-09-02)

Short version, not financial advice:

- **Real value:** agent-native architecture (not bolted-on AI), local + no
  credits (every well-funded competitor is cloud + metered), the colorist depth
  gap, and the owner's own YouTube channel as a distribution flywheel most solo
  OSS devs don't have.
- **Hard truths:** the editing tab alone is a multi-month build against free
  incumbents (Resolve, CapCut); pure OSS doesn't pay — every comparable project
  is "open core + paid pro" (Diffusion Studio, Gausian; Palmier just closed
  entirely); distribution is the real 80% of the problem, not the build.
- **Realistic paths:** open-core + paid Pro (cloud model hosting, team/collab,
  org licence — Remotion's model) · the colorist alone as a focused paid tool ·
  services · sponsorship/acquisition as outcomes, not plans.
- **Recommendation:** nail the colorist first (focused, unclaimed, finishable),
  ship OSS to build audience, monetise open-core later. Don't spread thin
  across all three tabs before any one of them is genuinely good. Matches the
  owner's own framing: *"just want my life to be easy first, then we'll see."*

## 9. Open questions still genuinely open

- Name (D-010) / licence (D-002, leaning AGPL) / v1 headline feature (D-007) —
  all shift under the 3-tab framing, not yet re-decided.
- Does the Editor tab's compositor eventually *replace* the Colorist's grade
  path, or do they stay two passes (composite → grade)? Leaning two-pass for
  now (`chroma-compositor` → `chroma-grade`, per `architecture-lock.md`), not
  re-litigated since.
- Multi-timeline / nested-sequence support (a Motion composition as a pool
  item) — flagged, deferred, not designed.
- Whether `chroma-motion`'s manifest editor becomes visual or stays
  JSON-in/agent-driven for v1 — not decided, no strong signal either way yet.
