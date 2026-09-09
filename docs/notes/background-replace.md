# AI background replacement — believable, not "cut-out" (owner asked 2026-09-02)

*"Now that we can separate the subject — can we also change the background without
making it feel unreal?"*

**Yes, and Apelles is unusually well-positioned for it** — because the hard part of a
believable comp is **not the matte** (we have that: SAM 2 track + ViTMatte, D-016 / D-018
/ D-019). The hard part is **integration** — matching light, colour, focus, grain — which
is exactly the grading + relight + depth work Apelles already has or is building.

## The pieces

| piece | Apelles status |
|---|---|
| **Subject matte** (per-frame, temporally stable) | ✅ D-016/18/19 |
| **New background** — a still, a video plate, or **AI-generated** (a Flux/SDXL-class image model + prompt for the static case; the owner's ref looks generated) | new — a `apelles-ai` generate step, or "bring your own plate" |
| **Composite** — matte the subject over the BG | `apelles-compositor` (roadmap / architecture-lock) |
| **Camera match** — a moving-camera plate needs the BG to move too (tracked parallax) | needs camera solve; **v1 = static-camera only** |

## The "not unreal" layer — this is the actual feature

Established VFX believability techniques, each mapped to a Apelles capability:

1. **Light wrap** — the BG's light spills slightly onto the FG edge (matched temperature
   + intensity). A shader pass: sample blurred BG at the matte edge, blend into the FG
   edge band. New, small (~a `apelles-grade` / `apelles-compositor` stage).
2. **Grade match** — grade the subject toward the BG's colour/exposure stats. **Already
   exists** — `match_to_reference` (D-026), pointed at the BG instead of a reference
   still.
3. **Relight the subject to the BG's light** — the single biggest believability lever.
   The depth-driven puck relight (D-013 refresh, `docs/notes/relight-research.md`): the
   agent analyses the BG for apparent light sources (bright regions, warm/cool split) and
   **auto-places relight pucks** to match. Deterministic, real-time, holds on video.
4. **Defocus match** — blur the BG to the plate's aperture. **Already exists** — per-mask
   blur (D-027) + the depth track (D-036) for a graded falloff.
5. **Grain match** — one grain pass over the *whole composite* so FG + BG share a noise
   floor (kills "pasted-on sharpness"). RapidRAW's `grainAmount` already does this,
   applied after the comp.
6. **Contact shadow / ambient bounce** — hard, usually skipped for a standing talking
   head; a soft floor gradient is a cheap approximation. Deferred.

## The Apelles differentiation

**The agent does the integration.** "Replace the background with a warm-lit study, keep
it believable" → the agent: generates/loads the BG → comps → analyses BG light → places
relight pucks → runs `match_to_reference` against the BG → dials in light wrap + defocus +
grain. No open tool does the *integration* end automatically — consumer AI-BG tools
(YouTube's, Higgsfield, Unscreen…) mostly skip 1/3/5/6, which is why they read as fake.
References worth studying: **Beeble / SwitchLight** (subject relight-to-environment is
their whole thing).

## Where it sits

A **Colorist-tab** feature — a "Background" layer + the integration stack, all
grade-adjacent. **v2/v3** — needs `apelles-compositor` first, and the relight puck work
(D-013), and ideally the BG-generate step. Not v1.

Roadmap: added under "Beyond v1". Own decision when it's picked up (D-0xx).
