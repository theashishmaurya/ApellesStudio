# AI relight — research refresh (2026-09-02)

Updates **D-013** (AI relight — IC-Light — "v3, bake-step only, held-frame only,
video temporal consistency unsolved"). The owner asked about the ClipDrop-Relight
capability; the tech has moved since D-013 was written.

## What D-013 assumed (and what changed)

| D-013 assumption | 2026 reality |
|---|---|
| "video temporal consistency of a relight is an unsolved research problem" | **No longer true.** Several open 2025 approaches (below). Same arc as depth: single-image IC-Light → temporally-consistent video model, exactly like Depth Anything V2 → Video Depth Anything (D-036). |
| "v3 scope is likely relight a held frame / a slow shot, not any clip" | A whole clip can now be relit with temporal consistency. |
| "diffusion is seconds/frame + non-deterministic → bake step, never a live node" | **Still true** for the diffusion models. The bake-step design (run once, cache a relit source, then grade normally) is still the right call — it just bakes a whole consistent clip now, not one frame. |

## The models (open, 2025)

- **RelightVid** (`Aleafy/RelightVid`, arXiv 2501.16330) — **the video successor to
  IC-Light.** Adds temporal layers + a video lighting dataset (LightAtlas), keeps
  IC-Light's albedo-preserving prior. Conditions on a **background video**, text, or an
  **environment map**. Open source. This is the leading candidate for a Chroma relight
  bake.
- **Light-A-Video** (`bujiazi/light-a-video.github.io`, arXiv 2502.08590) —
  **training-free** video relighting via progressive light fusion over an image
  relighting model + consistency mechanisms. No fine-tune. Lighter to integrate.
- **Lux Post Facto** (arXiv 2503.14485) — portrait video relighting, temporally
  consistent, trained from static OLAT + in-the-wild video. Portrait-specialised.
- **Real-time 3D-aware Portrait Video Relighting** (`GhostCai/PortraitRelighting`,
  CVPR 2024 Highlight) — **~33 fps on consumer hardware**, temporal-consistency network.
  Portrait-only, but the only near-real-time option.
- **Light-X** (arXiv 2512.05115) — generative 4D video rendering with joint camera +
  illumination control. Newer, heavier, more ambitious.

## Revised D-013 position (proposal — fold in after D-038)

- Still **v3 / Platform phase**, still a **bake step**, still **never a live per-frame
  grade node** (diffusion breaks the deterministic render invariant).
- Model: **RelightVid** as the primary (IC-Light lineage + env-map control fits a grading
  tool), **Light-A-Video** as the training-free fallback. Both run in the `ai/` sidecar
  (same place as SAM 2 / ViTMatte / Video Depth Anything — D-009's "stateful video loop
  too fragile for ONNX" logic applies again).
- Scope lifts from "held frame" to "relight a whole shot, consistently." Still expect it
  to be slow (minutes/clip) and best on slower shots — a bake, run once, cached next to
  the source like `.chroma/mattes` / `.chroma/depth`.
- Licence check required before adopting (IC-Light is permissive; RelightVid /
  Light-A-Video / OLAT-trained weights need per-repo verification — same gate as the VDA
  vitb/vitl trap in D-036).
- Meanwhile unchanged: **depth + shape-mask "relight-ish"** (darken one side, warm glow
  gradient, rim via linear mask) ships in v1, deterministic, holds on video — covers most
  talking-head needs without diffusion.

## Where it sits in the three-tab architecture

A relight bake is a `chroma-ai` service producing a relit source clip; `chroma-project`
references it (`.chroma/relight/<key>/`), the Colorist tab grades on top. It is **not** a
compositor or timeline concern. No change to the crate plan in
`architecture-lock.md`.
