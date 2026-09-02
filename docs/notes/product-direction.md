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
