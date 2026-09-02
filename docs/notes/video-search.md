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

### Local, default — **Molmo 2** (Ai2)
- Open weights **+ data + training code** (Ai2 does genuinely-open releases, not
  "open-weight" gated). Three sizes: **4B** (recommended for local — "nearly identical
  to 8B on video QA"), 8B, 8B-O (fully-open-stack variant).
- Built for exactly this: **point-driven temporal grounding** — "point out instances
  where [X] happens" → returns coordinates + **timestamps** per event, with tracking
  across frames.
- State-of-the-art **among open models** on video grounding/pointing/tracking — beats
  Qwen3-VL on video counting (35.5 vs 29.6), and even **beats proprietary Gemini 3 Pro**
  on video pointing (38.4 vs 20.0 F1) and video tracking (56.2 vs 41.1 J&F). Qwen3-VL
  (the other open contender, Apache-2.0, 2B/4B/8B, MLX-portable, fits a 16GB Mac) is the
  fallback if Molmo 2 doesn't port cleanly.
- **⚠️ License trap to verify before adopting — same shape as D-036's VDA vitb/vitl
  gotcha.** Ai2 states the code/weights are Apache-2.0, but also that Molmo 2 is
  "trained on third-party datasets that are subject to academic and non-commercial
  research use only." That clause needs a real read (Ai2's model card + licence FAQ) —
  it may or may not bind the *released weights'* usage rights. **Do not ship this
  without resolving that**, exactly the discipline D-036 established.
- No confirmed MLX port yet (Qwen3-VL, which Molmo 2's 4B/8B are built on, does have
  one — a port is plausible, not verified). Runs in the `ai/` sidecar, same place as
  SAM2/ViTMatte/VDA (D-009's "stateful/complex model → Python sidecar" precedent).

### Cloud, explicit opt-in — **Gemini 3's agentic video understanding**
- Went live **2026-09-01** (literally the day before this note) in the Gemini API /
  AI Studio. Built for precisely this job — Google lists four modes: **sub-second
  moment retrieval**, **long-form search across multi-hour video**, anomaly detection,
  and counting.
- Native video upload, 1M context — **up to 1 hour at default resolution, 3 hours at
  low resolution**. Timestamped output (`MM:SS`) directly usable as a timeline
  position.
- Best quality, especially for anything long or subtle Molmo-2-local might miss — but
  it's a **network call that uploads footage**. Per `CLAUDE.md`'s local-first
  invariant: *"Any cloud call is an explicit opt-in fallback, never a default, and is
  documented as such."* This qualifies — opt-in only, never the default search path.

## The pipeline (once built)

1. Index each media item in the pool (background job, like `/track` or `/depth_track`):
   Molmo 2 samples frames, produces scene/action groundings with timestamps → cache to
   `<clip>/.chroma/search/<key>/grounding.json` (same referenced-not-copied pattern as
   mattes/depth, D-019/D-036). The whisper transcript is already cached per clip.
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
an `ai/` sidecar addition (Molmo 2) + an MCP tool (`search_footage(query) ->
[{media_id, start, end, confidence}]`). Not v1 — depends on the media pool landing.
Verify the Molmo 2 licence clause before implementation; that's the one hard blocker,
not the modelling.
