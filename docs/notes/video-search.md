# Natural-language video search — "find me where I was driving and said X, bring it to the front"

Owner asked 2026-09-02. Short answer: **not yet, but the models exist now and the
editing half is already built.**

## The three pieces

1. **"where I was driving the car"** — visual scene/action understanding. We have
   nothing for this today. Whisper's transcript is *audio*, not vision.
2. **"and said X"** — spoken-word search. **Already solved** — whisper word-level
   timestamps (`videoAgent`'s `whisper_transcribe.py --word-timestamps`, mlx-whisper).
   A text query over an existing JSON transcript.
3. **"bring it to the front"** — a timeline reorder. **Already solved** —
   `chroma-timeline`'s `reorder` op (D-041) is exactly this, once the agent has
   `(source_path, start_frame, end_frame)`.

So the actual gap is narrow: **one video-understanding model** that turns "driving a
car" into a time range, intersected with the transcript search for "said X."

## The models (2026 moved fast — checked 2026-09-02)

### Molmo 2 (Ai2) — re-checked 2026-09-02, license verdict: **do not use, not cleared**

Pulled the actual `allenai/Molmo2-8B` model card (not just the blog post) — the card's
own words, not a summary:

> License tag: **Apache 2.0**. "Intended for **research and educational use**" per Ai2's
> Responsible Use Guidelines. **"Trained on third party datasets that are subject to
> academic and non-commercial research use only."**

That is not a licence ambiguity to "verify later" — it's the model author **stating
in the card itself** that the intended use is research/educational, and that the
training data is non-commercial-only. A permissive *code* licence sitting on top of
that doesn't clear a shipped product (open-source or not) to use the *weights*
commercially — an Apache tag on the repo doesn't override a training-data restriction
the model was built from, and "open-source, no paid tier" doesn't make a distribution
"non-commercial" the way these clauses usually mean it. **Verdict: exclude Molmo 2
from Chroma entirely** unless Ai2 explicitly clears it (their own Responsible Use
Guidelines / a direct answer would be the bar) — don't build against it and don't
revisit without that. Harder stop than the D-036 vitb/vitl case (that one had a clean
sibling checkpoint to fall back to; here the restriction is on Molmo 2 itself).

**Performance, for the record (matters less now it's excluded):** the "8B" HF repo is
actually **9B params** (Qwen3-8B base + SigLIP2 vision), no VRAM/speed numbers published
by Ai2 at all, no MLX port. Quantized GGUF builds exist for llama.cpp/Ollama/LM
Studio — so it's *runnable* on Metal via llama.cpp, but a 9B VLM is not the "works on
anyone's laptop" tier the owner asked for, separately from the licence problem.

### Local, default — **Qwen3-VL instead** (Alibaba, Apache-2.0, clean)

No non-commercial clause found on Qwen3-VL's own licence (Apache-2.0, Alibaba's, not
inheriting a third-party academic dataset restriction the way Molmo 2 does — worth one
more explicit check before shipping, same discipline, but nothing flagged so far).
**Sizes that actually fit modest hardware** (this is the part that matters for "people
without a beefier machine"):

| size | footprint | fits |
|---|---|---|
| **2B** | ~1.9 GB | 4 GB GPUs, **8 GB laptops** — the low-end target |
| **4B** | ~6 GB (Q4) | 16 GB Macs |
| 8B | ~12 GB | 16 GB Macs, tighter |

MLX builds exist (Qwen3-VL ships gguf **and** mlx formats) — real Apple-Silicon-native
inference, not llama.cpp-via-Metal as a fallback. Weaker than Molmo 2 specifically on
fine-grained video-pointing benchmarks (per the earlier comparison), but it's licence-clean
and the 2B tier is the one that actually serves someone on a base MacBook Air — which is
the constraint that matters more than winning a grounding benchmark. **This is the
recommended default**, sized per-device (2B on modest hardware, 4B/8B when more RAM is
available) — same "pick the smallest capable open model" discipline as SAM2/ViTMatte/VDA.
Runs in the `ai/` sidecar (D-009's "stateful/complex model → Python sidecar" precedent).

### Cloud, explicit opt-in — **Gemini 3's agentic video understanding**
- Went live **2026-09-01** (literally the day before this note) in the Gemini API /
  AI Studio. Built for precisely this job — Google lists four modes: **sub-second
  moment retrieval**, **long-form search across multi-hour video**, anomaly detection,
  and counting.
- Native video upload, 1M context — **up to 1 hour at default resolution, 3 hours at
  low resolution**. Timestamped output (`MM:SS`) directly usable as a timeline
  position.
- Best quality, especially for anything long or subtle the local model might miss — but
  it's a **network call that uploads footage**. Per `CLAUDE.md`'s local-first
  invariant: *"Any cloud call is an explicit opt-in fallback, never a default, and is
  documented as such."* This qualifies — opt-in only, never the default search path.

## The pipeline (once built)

1. Index each media item in the pool (background job, like `/track` or `/depth_track`):
   **Qwen3-VL** samples frames, produces scene/action groundings with timestamps →
   cache to `<clip>/.chroma/search/<key>/grounding.json` (same referenced-not-copied
   pattern as mattes/depth, D-019/D-036). The whisper transcript is already cached per
   clip. Model size picked per device (2B default / 4B-8B if the machine has the RAM).
2. Query: `"find where I was driving the car and said <X>"` → the agent (a) greps the
   transcript for `<X>` → candidate time ranges from audio; (b) queries the visual
   grounding index for "driving a car" → candidate ranges from vision; (c) intersects
   them. No new model needed for the intersection — that's just data.
3. If the query needs Gemini 3 (opt-in, e.g. "summarize the whole shoot and find the
   best 10 seconds"), the agent asks first per the Explicit-Permission rules — footage
   leaves the machine.
4. Result → the agent calls `chroma-timeline::reorder` (or an insert) — **already
   built**, D-041.

## Where it sits

An **Editor-tab** feature (the media pool needs to exist first — roadmap item) +
an `ai/` sidecar addition (**Qwen3-VL**, sized 2B/4B/8B per device) + an MCP tool
(`search_footage(query) -> [{media_id, start, end, confidence}]`). Not v1 — depends on
the media pool landing. **Molmo 2 is excluded** (licence, see above) — don't revisit it
without an explicit clearance from Ai2.
