# Visual understanding for the Editor tab

Owner asked 2026-09-02, starting from *"find me where I was driving the car and said
X, bring it to the front."* Reframed after discussion: this isn't one search feature,
it's **a visual-understanding layer the Editor tab needs generally** — search is just
the first consumer of it.

## Two axes, both needed

- **When** — temporal: "find the moment where X happened," B-roll-to-script matching,
  highlight detection.
- **Where** — spatial: what's in frame, exactly where, tracked across frames — reframe
  to vertical, multicam sync, "find every shot with two people," masking.

An editor needs both. The good news: **Chroma already has half of this stack**, just
under-exposed.

## What's already built (the "where" half)

- **SAM 2** (D-016/D-018, `ai/` sidecar) — pixel-precise segmentation + tracking.
  Currently wired only for subject isolation, but it's a general object tracker.
  Answers "where, exactly" at a higher bar than any VLM's box/point output.
- **YOLO** (D-012, `ai/` sidecar) — person detection. Currently just seeds SAM2's
  prompt box; the detections themselves are a reusable primitive (person count, rough
  position).

Both already local, already licence-clean (Apache-2.0 / permissive), already
integrated. Not a gap — just not exposed as general-purpose tools yet.

## What's missing: general scene/temporal understanding (the "when" + "what")

### Local, default — **Qwen3-VL** (Alibaba, Apache-2.0, clean)

- No non-commercial clause found on its own licence (Alibaba's, not inheriting a
  third-party academic-dataset restriction — worth one more explicit check before
  shipping, same discipline as always, but nothing flagged).
- **Built and benchmarked on temporal grounding specifically**: text-based time
  alignment (explicit `<3.0 seconds>`-style tokens, not implicit position), evaluated
  on Charades-STA + generalized moment retrieval, outputs **timestamps as JSON with
  numeric seconds** — a text query in, a time range out.
- **Sizes that fit modest hardware** — the part that matters for "people without a
  beefier machine":

  | size | footprint | fits |
  |---|---|---|
  | **2B** | ~1.9 GB | 4 GB GPUs, **8 GB laptops** — the low-end default |
  | **4B** | ~6 GB (Q4) | 16 GB Macs |
  | 8B | ~12 GB | 16 GB Macs, tighter |

- Real MLX-native builds exist (`mlx-vlm`, quantized checkpoints already on HF) — not
  a llama.cpp-via-Metal fallback. **Recommended default**, sized per-device, same
  "smallest capable open model" discipline as SAM2/ViTMatte/VDA. Runs in the `ai/`
  sidecar (D-009 precedent).

### Molmo 2 (Ai2) — documented, NOT bundled, opt-in at the user's own risk

Re-checked against the actual `allenai/Molmo2-8B` model card, not the blog post:

> License tag: **Apache 2.0**. "Intended for **research and educational use**" per
> Ai2's Responsible Use Guidelines. **"Trained on third party datasets that are
> subject to academic and non-commercial research use only."**

That's the model author stating the intended use, not a licence ambiguity to
"verify later." **Chroma does not ship, bundle, or auto-download Molmo 2, and it is
not the default sidecar model.** Shipping it as part of an OSS project's default code
path is redistribution + implicitly encouraging every downstream user (including any
future commercial use) toward a non-cleared use — that's the actual risk, separate
from any one person's own local experimentation.

**The middle path:** document it as an optional, self-configured model — "point the
sidecar at Molmo 2 yourself if you want to try it" — same shape as any BYO-model
config. Whoever opts in owns that compliance call; Chroma's defaults and its other
users aren't implicated.

**Whether it's even worth opting into, for this specific job:** Molmo 2's benchmarked
edge over other open models (and even over Gemini 3 Pro) is on **video pointing and
tracking** — spatial, "where is this object." Chroma's SAM 2 already answers "where,
exactly" at pixel precision, which is a *higher* bar than Molmo 2's box/point output.
Molmo 2 would be an incremental upgrade on a capability Chroma already has a working
answer for. **Not needed for v1.**

(No published VRAM/speed numbers from Ai2 at all, no MLX port — GGUF-quantized only.
9B actual params. Not the "works on anyone's laptop" tier even setting the licence
aside.)

### Cloud, explicit opt-in — Gemini 3's agentic video understanding (+ 2.5 Pro fallback)

- Gemini 3's dedicated **agentic video understanding** path went live **2026-09-01**:
  sub-second moment retrieval, long-form multi-hour search, anomaly detection,
  counting. Native video upload, up to 1 hour at default res / 3 hours at low res,
  timestamped `MM:SS` output. **~88% fewer tokens, ~7% better accuracy** than plain
  video prompting on video tasks specifically (Google's own numbers), which likely
  makes it cheaper per query than its higher sticker price suggests.
- **Gemini 2.5 Pro** isn't obsolete — general multimodal video Q&A still answers "find
  the moment where X," ~40% cheaper per token, established (paid-only since April
  2026), no brand-new-endpoint availability risk. Same prompt works on either.
- **Recommendation:** Gemini 3's agentic API primary, 2.5 Pro as the fallback.
- Either way: a **network call that uploads footage**. Per `CLAUDE.md`'s local-first
  invariant — *"Any cloud call is an explicit opt-in fallback, never a default"* —
  this is opt-in only, never the default search path. The agent asks first per the
  Explicit-Permission rules before footage leaves the machine.
- (One pricing figure from research — "$0.15/sec of video" — looked like a bad unit
  conversion, not trusted; get real numbers off Google's pricing page before wiring
  any billing logic.)

## Processing-time reality check (owner asked: "what will it take for 5–10 hour-long videos?")

At Qwen3-VL's **default** settings (2 fps sampling, 2,048-frame/~17-min call cap), a
rough linear extrapolation from the only latency data point found (8B, a 10-second
test clip, 21.7 s cold) puts **5–10 hours of footage at ~11–22 hours** of local
indexing — not usable. The default sampling rate is tuned for grounding-precision
benchmarks, not a background job.

**What makes it practical:**
1. **Coarser sampling for the index pass** — 1 frame per 3–5 s instead of 2 fps
   (6–10× fewer frames). Loses split-second action detection, which this feature
   doesn't need — "somewhere in this range" is enough, a human/agent narrows it.
2. **Smaller model for the default pass** — 2B/4B instead of 8B (1.5–3× faster, and
   the size that fits modest hardware anyway).

Combined, a plausible **~30 min – 2 hours of background processing** for 5–10 hours
of footage — a real "kick it off, keep grading elsewhere, it's ready later" job, same
shape as the depth track (D-036) and subject tracking (D-018) precomputes.

**This has not been measured for real.** The number above is reasoned extrapolation
from a mismatched benchmark (a 10-second clip, a separate text-throughput figure),
not a verified end-to-end run. Per the project's playback precedent (D-030/D-031
measured real fps on the actual C019 clip instead of trusting a spec sheet) — **run
Qwen3-VL locally on a real hour-long clip before this becomes a roadmap commitment**,
not before discussing it.

## What this layer unlocks (search is just the first consumer)

- **Search**: "find where I was driving and said X" — Qwen3-VL (when/what) ∩ whisper
  transcript (said X) → `chroma-timeline::reorder` (already built, D-041) to act on it.
- **B-roll auto-tagging** (Eddie AI ships this as a headline feature — real demand
  proof) — Qwen3-VL captions each pool item.
- **Shot classification** — interview vs. B-roll vs. establishing shot.
- **"Find every shot with two people in frame"** — YOLO count (already have the model).
- **Auto-reframe hints for shorts** — SAM2/YOLO subject position → suggested crop.
- **Highlight / best-moment detection** — Qwen3-VL temporal + scene scoring.

## The pipeline (once built)

1. Index each media-pool item (background job, like `/track` / `/depth_track`):
   Qwen3-VL samples frames at the coarse rate → scene/action groundings with
   timestamps → cache to `<clip>/.chroma/search/<key>/grounding.json` (referenced,
   not copied — same pattern as mattes/depth, D-019/D-036). Whisper transcript already
   cached per clip. Model size picked per device.
2. Query → intersect transcript hits (audio) with grounding-index hits (vision) — pure
   data, no new model needed for the intersection.
3. A query needing cloud quality (opt-in) asks first, per the Explicit-Permission rules.
4. Result → `chroma-timeline::reorder` / insert — **already built**, D-041.

## Where it sits

An **Editor-tab** feature (needs the media pool first — roadmap item) + an `ai/`
sidecar addition (Qwen3-VL, sized per device) + exposing SAM2/YOLO as general tools
(not just subject-isolation) + an MCP tool (`search_footage(query) ->
[{media_id, start, end, confidence}]`). Not v1. Molmo 2 stays documented-only, never
bundled. A real local throughput benchmark on an hour-long clip is the first concrete
task when this gets picked up.
