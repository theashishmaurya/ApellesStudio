# Automatic Clipper: shorts and a trailer from one long video

**Status: design, accepted for build (D-411, 2026-10-27). Phase 0 (§10, timelines that can be shorts) built 2026-10-27; Phases 1-2 (one-call shorts, client judging) built 2026-10-28 — see D-411's build notes for the calls made while building, including where they differ from this note (no heuristic or MMR anywhere, per the owner; `editor_auto_clip` analyses and `editor_propose_clips` builds; captions scaled for a portrait frame; `editor_export_clips` folded into `export_dir`). Phases 3–7 not built.** Roadmap: item 0h in
`docs/04-roadmap.md`. Research notes (gitignored): `scratch/clipper-reference/NOTES.md`, with the
raw Opus Clip help pages in `scratch/clipper-reference/opus/`.

> **Owner decisions, 2026-10-27 (D-411), override this note where they differ:** the **MCP client is the only judge** (no local heuristic picks moments, in the GUI or anywhere; without an agent the panel analyses and shows candidates but cannot propose); shorts live as timelines in the same project; the one call stops at built timelines; media files and long timelines are both sources from Phase 1; Openverse is never automatic.

Owner's ask (2026-10-27): *"Add Automatic Clipper, this finds the best moments and cuts and
convert it into trailer for your long form video, podcast movies, courses etc.. can be converted
to short from just one call and work against it. It should feel fast, fit into reel format, should
be intuitive and all, not just sloppy work."*

Two outputs from one long source (a media file, or a long Edit timeline):

- **Shorts.** Several standalone reels, 9:16 by default (1:1 and 4:5 too). Each one is a
  self-contained moment that opens on a hook and ends on a payoff, reframed on the speaker, with
  burned-in captions.
- **A trailer.** One montage of the best moments for the long-form piece: a cold open, a title,
  3 to 6 beats, a button line and an end card, over an edited music bed.

One MCP call produces both. Then the person, an agent, or both iterate on the results with the
ordinary Edit tools. Human and AI parity is required (CLAUDE.md): every capability below has a
GUI control and an MCP tool built on the same store action.

---

## 1. What the research says (and what it changed)

Detail and sources: `scratch/clipper-reference/NOTES.md`. The findings that shaped the design:

1. **Users complain about the cut more than the pick.** Opus Clip reviews: clips "miss the
   punchline, cut mid-sentence, or start mid-thought" (20 to 40% in one reviewer's estimate),
   "cutting off a joke before the punchline", leaving out "the one sentence that gives a segment
   its meaning". **So:** a deterministic **clean-cut gate** (§3.3) refuses any clip that starts
   or ends mid-sentence, whoever proposed it. Trims snap to sentences, and "add the sentence
   before / after" is one keystroke (Opus's "Add a section").
2. **Every tool's picks get second-guessed** ("you didn't use the good parts"), and the score is
   a bare number: Opus's 0 to 99 Virality Score (hook / flow / value / trend) has no visible
   reasons and no weights the user can change. **So:** the D-380 split. The MCP client judges, and
   the app generates candidates and verifies them. A local heuristic covers the GUI path when no
   agent is connected, and every score carries the reasons behind it.
3. **Descript writes each clip as a new composition** in a "Clips from …" folder in the same
   project, editable like any other. **So:** each built short is a normal **timeline** in the
   same project, grouped and carrying a record of its source (§5).
4. **Opus pulls hooks "from different parts of your video"**, and its editor can prepend or
   append any section of the transcript. **So:** a short is an ordered **list of source
   segments**, not one range, with hook-first ordering as an option.
5. **Reframing.** Premiere's Auto Reframe has *Slower / Default / Faster* motion tracking and
   writes ordinary position keyframes into a new sequence. FCP's Smart Conform reframes on faces
   and turns on **overscan** so the editor sees what was cropped. Google's AutoFlip prefers a
   **stationary** crop per shot, then panning, then tracking. Opus follows the active speaker
   with "gradual camera shifting". **So:** reframe writes editable transform keyframes, holds
   still by default, has a smoothing mode, can be re-run per clip, and shows the full source
   frame outside the crop.
6. **Speed.** In an independent test Opus took 8 minutes to clip a 59-minute episode, in the
   cloud. Our transcript runs locally at 17.6x realtime (Parakeet, D-381), so progressive results
   in well under a minute are reachable (§8).
7. **Captions:** "often full of mistakes", and they clash with subtitles already burned in.
   **So:** captions come from the transcript the person has already reviewed (including D-349
   recoveries and `editor_retranscribe_words` fixes). A source with burned-in subtitles gets a
   warning. Captions are a normal subtitle track, so every cue can be edited.
8. **Trailers:** 30 to 90 s; a raw-tape cold open in the first 5 to 10 s; a premise line; proof
   beats that make sense without context; a call to action; tighter pauses than the episode. This
   matches our own measured teardown (dry cold open, music in on the turn, dry CTA:
   `docs/notes/reference-teardown-lewis-jackson-polymarket.md`).

---

## 2. Inventory: what already exists and what is missing

### Reused as is

| Need | Existing piece | Where |
|---|---|---|
| Word-timed, punctuated transcript per file, cached by path; windowed passes | `editor_get_transcript`, ai-media `/transcribe` (`start_secs`/`end_secs`), Parakeet (D-381) | `ai-media/`, `chroma::transcript` |
| Transcript of a whole timeline in timeline frames | `editor_get_timeline_transcript` (D-329) | `timelineTranscript.ts` |
| Numbered word view + `viewId` + served judging `instructions` + a deterministic gate | `editor_get_word_transcript`, `apelles_speech::proposal` (D-380) | `crates/apelles-speech` |
| Dead air (Silero VAD, cached per range) | `editor_detect_silences` (D-319/D-321/D-343) | `apelles_speech::vad/silence` |
| Retakes inside a moment (gated) | `editor_detect_retakes` (D-382), `editor_propose_retakes` (D-380) | `retakeProposals.ts`, Recut panel |
| Speech the ASR missed | `editor_detect_dark_regions` (D-349) | `darkRegions.ts` |
| Cutting ranges out of a clip, one undo step | `editor_ripple_delete_ranges` (`applyRippleDeleteRanges`) | `timeline.ts` |
| Visual change timestamps (ffmpeg scene detection, deterministic) | step 1 of `editor_analyze_video` (D-189) | `ai-media/video_understand.py` |
| Styled, animated captions | caption presets (D-243: `caption-pill-karaoke`, `caption-kinetic-slam`, …), `editor_add_caption_preset`, `editor_set_caption_style` | `captionPresets.ts`, `captionAnim.ts` |
| Push-ins on punchlines | dynamic zoom (D-234) `editor_set_dynamic_zoom` | `dynamicZoom.ts` |
| Clip transform + keyframes in both renderers | `editor_set_clip_transform`, `editor_set_clip_keyframes` | `clipKeyframes.ts` |
| Several timelines per project | `chroma_timeline_list/create/set_active` (D-045/D-046), `TimelineSwitcher` | `chroma::edit` |
| On-device Apple Vision binding | `objc2-vision` 0.3.2 for OCR (D-397) | `apelles-media::ocr` |
| Person detection, SAM 2 tracking | YOLO seed + SAM 2 (`track_subject`, D-012/D-018) | `ai/` sidecar (Colorist) |
| Title / CTA cards as data | Motion templates (D-407), custom components (D-409) | `packages/motion` |
| Music bed edited on story beats | `editor_propose_music_edits` / `apply` (D-408) | `musicEdits.ts` |
| Openly licensed music search + credits | `editor_search_audio` / `editor_import_audio` (D-400) | `apelles-audio-library` |
| Loudness target | `editor_export(loudness_preset="youtube")` (D-401) | `apelles-media::loudness` |
| Sequential export queue | `exportQueueStore` (D-198), compositor renderer (D-350/D-351) | `packages/editor` |
| Undo for agents and keyboard alike | `undo`/`redo` (D-383), edit journal (D-402) | |

### Gaps (each is a phase item in §10)

1. **The output size is per project, not per timeline.** `ProjectSettings {width,height}`
   (D-038) is the only composition size (`compositionSize.ts`, `chroma_timeline_composition_size`).
   A 9:16 short and the 16:9 long-form cannot share a project today. This is the biggest
   prerequisite.
2. **No MCP tools to list, create, switch, rename or delete timelines,** and no rename/delete
   in the GUI either (`TimelineSwitcher.tsx`: "no rename/delete UI yet"). Every `editor_*` tool
   acts on the *active* timeline, so an agent cannot iterate across N shorts.
3. **Export always renders the active timeline,** and the queue compiles at enqueue from the
   active one. A batch export needs "compile timeline X" without switching the view.
4. **Captions follow one file plus one offset.** `editor_generate_captions_from_transcript`
   groups one file's words and shifts them by `offset_frames`. A short made of several source
   segments needs captions mapped through each clip: captions from the *timeline* transcript.
5. **No face, saliency or active-speaker signal in the Edit tab.** `track_subject` is the
   Colorist SAM 2 matte tracker: pixel masks per shot, GPU-heavy, and not a crop path. YOLO is
   only a seed. `editor_analyze_video`'s VLM step (Qwen3-VL-4B, about 4x realtime and about
   9 GB) is far too slow for an hour of footage and is not needed for clipping.
6. **No sentence or topic segmentation.** Parakeet punctuates, and the cue grouping uses
   segment breaks, but nothing exposes "sentence N, topic T" as a unit.
7. **No speaker diarization.** Parakeet does not label speakers. A two-person podcast needs an
   active-speaker signal (§4.4).
8. **Proposal lists are session state** (retakes, music edits: "not `project.json`; dropped on a
   project switch"). Clip runs cost minutes of analysis and an agent's judgement, so they must
   persist (§5.2).

---

## 3. Moment finding

The core split follows the D-379/D-380 precedent for "who judges content quality": **the app
does the deterministic work (candidates, features, gate) and never claims taste. The judge is
the MCP client when one is connected, and a transparent local heuristic otherwise.**

### 3.1 Units: sentences, then topics

New pure code in `apelles-clipper` (§9). From the word transcript (source seconds):

- **Sentences.** Split at terminal punctuation (`. ? !`, which Parakeet emits) *and* at a VAD
  pause of at least `SENTENCE_PAUSE_S` (0.6 s, the existing `min_silence_ms` "they stopped
  talking" default) when no punctuation arrived. Parakeet places sentence-final punctuation at
  the end of the following silence, so a sentence's end comes from its last *contiguous* token,
  as in D-376. A run-on longer than `MAX_SENTENCE_S` (15 s) splits at its longest internal pause
  or comma.
- **Topics.** TextTiling (Hearst 1997: lexical cohesion between adjacent sentence windows,
  depth-scored valleys), a small, public, deterministic algorithm, so no dependency. Valleys
  that coincide with a long pause or a visual scene change score higher. Topics give chapters
  for the trailer and bound the shorts: a short never spans a strong topic valley unless the
  judge asks for it.

### 3.2 Candidates (deterministic, cheap)

For each requested target length L in {15, 30, 60, 90} s (tolerance -30% / +25%), enumerate
every sentence-aligned window [s_i … s_j] whose duration fits *after* tightening (§3.4).
That is O(sentences x window) at roughly 700 sentences per hour, so milliseconds. Each window
gets a **feature vector**, every feature computed in Rust and deterministic:

| feature | signal | source |
|---|---|---|
| `hook_text` | first sentence is a question, contains a number/stat, second person ("you"), contrast/stakes words ("but", "never", "mistake", "secret", "actually"), imperative, short (<= 12 words) | words |
| `context_dependent_open` (penalty) | opens on a conjunction/pronoun with no antecedent in the window ("And…", "So that's…", "He…", "As I said") | words |
| `payoff` | ends on terminal punctuation, then a pause >= 0.6 s; last sentence not a question unless answered | words + VAD |
| `self_contained` | lexical cohesion of the window vs. its neighbours (TextTiling score inside / across edges) | sentences |
| `energy` | speech rate (words/s) vs. the source's median; RMS loudness variance (emphasis); share of speech vs. dead air | words + PCM |
| `reaction` | non-speech high-energy bursts adjacent to speech (laughter/applause proxy, flagged low-confidence) | VAD + PCM |
| `visual_change` | scene changes inside (B-roll, slides), from ffmpeg scene detection only, no VLM | ffmpeg |
| `focus_match` | overlap with the person's optional focus prompt (keyword/lemma match locally; the client does real semantic matching) | words |
| `asr_confidence` | share of words the transcript harness flagged `low_confidence` | harness |

**Selection** ranks windows by score and picks with maximal marginal relevance (overlap with an
already-picked window counts against a candidate), so results spread across the source instead
of clustering on one great minute. **Overproduce:** Opus returns 23 to 32 clips per hour. We
keep roughly 3x the requested `count` as ranked proposals and build the top `count`.

### 3.3 The clean-cut gate (one gate, every proposer)

Like D-380's coverage gate: **structural and mechanical checks that hold a proposal to the same
standard whether it came from the heuristic, the MCP client or a person dragging a handle.** Each
proposal comes back `verified`, `warned` (passes, with the issues named) or `refused` (with
`reason`, `reasonText` and the offending sentence/word indices, so a client can fix it and
resubmit).

*Refused:*
- a segment edge that is not a sentence boundary. Exception: a clause boundary with a pause of
  at least `CLAUSE_PAUSE_S` (0.4 s) and a comma/colon, allowed only as an *inner* segment edge
  when two segments are stitched;
- an edge inside a word, or padding that reaches into a neighbouring word (padding rules below);
- a total duration outside the target's tolerance after tightening;
- a segment that starts inside a verified retake's deleted take (it would replay the flub);
- a hook segment that is not one to three complete sentences, or longer than `HOOK_MAX_S` (8 s);
- index past the view, `first > last`, overlapping segments within one proposal, a stale `viewId`.

*Warned (shown on the card, never silently fixed):* a context-dependent opener; ending on an
unanswered question; more than 10% low-confidence words; overlap of more than 50% with another
proposal; a source with burned-in subtitles; a crop that has to upscale beyond 1.5x (FCP's
quality caveat: a 1080p source makes at most a 608x1080 vertical without upscaling).

*Padding* (reusing D-380's rule): each outer edge is padded toward the neighbouring word by at
most `EDGE_PAD_MAX_SECS` (0.32 s), never past the gap's midpoint. The head pad is shorter
(0.12 s) so the first syllable lands on frame one. The tail lets the breath finish.

### 3.4 Inside a clip: tightening

Applied when the short is built, all from existing detectors, each as a reported and reversible
list (never a hidden effect):

- **dead air:** silences of at least 0.6 s are shortened to `TIGHT_GAP_S` (0.25 s) (the
  teardown's "jump-cut tight": 6 pauses over 0.6 s in 15 minutes);
- **retakes:** only `verified` / `ai_confirmed` groups from the D-380/D-382 gate are cut; refused
  groups are left in and flagged;
- **fillers:** off by default (a later option, as in Opus's checklist).

Tightening is *the same `applyRippleDeleteRanges` op* on the built timeline, so it shows up in
undo, in the journal and on the timeline.

### 3.5 Who judges

| Path | Judge | When |
|---|---|---|
| GUI, no agent connected | **local heuristic** (§3.2 weights), deterministic, reasons shown | default one-click path |
| MCP client connected | **the client LLM** reads the moment view and proposes; the app gates | `editor_auto_clip(judge:"client")`, or the skill after a heuristic first pass |
| Later, opt-in | a **local LLM** judge (the ai-media sidecar already ships Qwen3-VL-4B for `editor_analyze_video`; a text-only model could score candidates) | only if an eval shows it beats the heuristic (Phase 7) |

The heuristic is the honest baseline: it is good at "clean, self-contained, opens strong" and
weak at "this is the interesting idea". It never presents itself as more than that. The card
shows "Picked by: heuristic", with reasons such as "opens with a question · a number at 0:04 ·
ends on a full stop · fast delivery". The client's judging rules are **served by the app**, as
D-380 serves `JUDGING_RULES` on page 0 of `editor_get_word_transcript`: one place, versioned,
pinned by an eval (§11), and never copied into the skill.

**Moment view** (what a client reads): numbered sentences, each with start/end seconds, the
features above as short tags, topic boundaries marked, retakes and dead air marked, plus the
`instructions` on page 0. That is roughly 700 lines per hour, one or two pages, far smaller
than the word view (2500 words a page).

---

## 4. Each short

### 4.1 Structure and length

- **Targets:** 15 / 30 / 60 / 90 s (chips, more than one allowed; Opus's "Auto 0 to 3 min" maps
  to "let the judge choose within 15 to 90").
- **Hook first** (option, default on for shorts): `none` (play in order), `flash_forward` (the
  hook segment plays first, then the clip from its start; the hook repeats in context, the usual
  Opus/TikTok pattern), or `reorder` (the hook moves to the front and is removed from its place;
  allowed only when the gate finds the remainder still reads cleanly). The default is
  `flash_forward` when the hook is not already the first sentence.
- **Payoff end:** the last segment must end on a payoff sentence (gate: terminal punctuation,
  then a pause).

### 4.2 Reframe to 9:16 / 1:1 / 4:5

**Detector choice** (evaluated; licences checked):

| Option | Licence / cost | Verdict |
|---|---|---|
| **Apple Vision** `VNDetectFaceRectanglesRequest` + `VNDetectFaceLandmarksRequest` (lip points), `VNDetectHumanRectanglesRequest` (upper body when the face turns), `VNGenerateAttentionBasedSaliencyImageRequest` (no-person fallback: products, screens), `VNTrackObjectRequest` | OS framework on every supported Mac (macOS ARM is the v1 platform); **already linked** through `objc2-vision` 0.3.2 for OCR (D-397, Zlib/Apache-2.0/MIT). Needs only extra *features* of the same crate, so `Cargo.lock` gains nothing | **Chosen.** On-device, Neural Engine, no model download, no sidecar |
| YOLO (already in `ai/`) + SAM 2 `track_subject` | Python sidecar, GPU-heavy; SAM 2 produces mattes, not a crop path | Rejected for reframing. SAM 2 stays the Colorist matte tool. Possible manual "track this object" later, like Opus's manual tracker |
| MediaPipe face detector / AutoFlip | Apache-2.0, but a new native or Python dependency and a model download | Rejected: Vision covers it. **AutoFlip's camera policy is adopted as design**, not as code |
| YuNet (OpenCV Zoo) ONNX via `ort` (already a dependency for Silero) | MIT, about 0.3 MB model | Fallback if Apple Vision measures badly on real footage. Not built pre-emptively |
| InsightFace / SCRFD | models non-commercial | Rejected (licence) |

**Camera path planner** (pure, `apelles-clipper::reframe`, AutoFlip's policy):

1. Sample detections at `REFRAME_SAMPLE_FPS` (4 fps) on a 1/4-resolution decode of only the
   clip's own source ranges, never the whole hour. Split at scene cuts.
2. Per shot, choose a **mode**: *stationary* if the subject's centre stays inside a dead zone
   (25% of the crop width) for the whole shot; otherwise *pan* (one linear move); otherwise
   *track* (a critically damped follow, capped speed). The modes map to Premiere's
   Slower / Default / Faster: `smoothing: "steady" | "default" | "follow"`.
3. The crop is the largest target-aspect rectangle inside the frame at `scale` (fill height by
   default), centred on the subject with headroom (eyes at about 1/3 from the top for a face
   box).
4. Write **ordinary keyframes** on the clip (`position_x`/`position_y`/`scale`, the
   `editor_set_clip_keyframes` model), reduced with Ramer-Douglas-Peucker to the fewest keys
   within 1% error, so a person can edit them. Stationary means one static transform and no
   keys at all.
5. Overscan: the preview shows the uncropped source dimmed outside the 9:16 canvas while the clip
   is selected (FCP's overscan view; `CanvasBoundary.tsx` already draws the composition edge),
   so a wrong crop is visible at a glance and draggable with the existing transform overlay.

Reframe is a **general Edit feature**, not clipper-only: the Inspector gets an "Auto reframe"
button on any clip whose aspect differs from its timeline's, and MCP gets `editor_reframe_clip`
(Smart Conform parity). The clipper calls the same function.

**Layout presets** per short: `fill` (reframed crop, default), `fit` (letterboxed with a blurred
copy behind: for screen recordings and slides where cropping loses content), `split`
(two people stacked, §4.4), and `screen_and_face` (a screen recording on top and the face below,
using the D-348 split-screen geometry). Applied as normal clips and transforms on normal tracks.

### 4.3 Captions, title, music, loudness

- **Captions:** generated from the **timeline transcript** of the built short (gap 4), so cues
  follow every cut and tightened pause, using a preset (default `caption-pill-karaoke`, chosen in
  setup and changeable per short or for all). Safe-area aware placement: for 9:16, `position_y`
  sits above the bottom UI band of Reels/Shorts/TikTok, about 20% from the bottom.
- **Hook title** (option, Opus's "Auto headline"): a one-line text clip for the first 2 to 3 s,
  using a caption-style text preset. The client writes the line; the heuristic uses the hook
  sentence trimmed to 8 words or fewer.
- **CTA end card** (option): a Motion template (D-407) filled with `cta_text`/URL and rendered
  through the existing Motion render. Off by default (Motion was held back in the v0.2.0 beta,
  D-391, and ships from v0.4.0, D-417; this degrades to a text clip when the Motion tab is not
  in the build or its render runtime is not installed yet).
- **Music bed** (option, off by default for shorts): a quiet bed under the voice
  (`set_track_duck`, about -19 dB, per `apelles-sound-design` §1), taken from the project's own
  `assets/audio/` first. Openverse is a network call, so it is used only when asked (§12, Q4).
- **Loudness:** export with `loudness_preset: "youtube"` (-14 LUFS / -1 dBTP, D-401). The same
  target fits Instagram and TikTok.
- **Punch-ins** (option, Submagic's "Magic Zoom"): a dynamic zoom (D-234) of 1.08 to 1.15x on the
  sentence the judge marks as the punchline, as ordinary keyframes.

### 4.4 Two-person podcasts

- **One wide camera, two people:** active speaker = the face whose **mouth-opening signal**
  (Vision lip landmarks: inner-lip gap over face height, per sample) correlates best with VAD
  speech over each sentence. No new model, deterministic, measurable. A switch happens only at a
  sentence boundary and only after the new speaker has held for at least `MIN_SHOT_S` (1.5 s), so
  the crop cuts like an editor would instead of jittering. A **switch is a hard cut**: the clip
  is split at the boundary and each piece gets its own static framing. That is visible on the
  timeline, editable, and needs no keyframe-step trick. The `split` layout stacks both faces for
  fast back-and-forth exchanges (option, or automatic when switches would come faster than
  `MIN_SHOT_S`).
- **One camera per person** (separate angle files, or a multi-track Riverside-style recording):
  active speaker = whichever mic track is louder over the sentence. The cut picks that person's
  angle. Detected when the source is a timeline with time-aligned video tracks.
- If lip landmarks prove unreliable (beards, side profiles), the fallback is an active-speaker
  model (TalkNet / Light-ASD family: MIT code, AVA-ActiveSpeaker training data). That needs its
  own D-NNN, with licences checked per checkpoint. Not built pre-emptively.

---

## 5. Data model

### 5.1 Built outputs are timelines (Descript's model)

- **A built short or trailer is a normal `Timeline` in the same project**, so every Edit tool,
  the journal (D-402), undo (D-383), export and the GUI work on it unchanged. The
  "work against it" part of the ask comes free: after the one call, the agent uses the same
  `editor_*` tools on that timeline.
- `Timeline` gains two optional, `#[serde(default)]` fields (`apelles-timeline`):
  - `output: Option<OutputSpec { width, height }>`: a per-timeline composition size that
    overrides `ProjectSettings` (gap 1). `chroma_timeline_composition_size`, the preview canvas,
    `compositionSize.ts` and both export renderers read the active, or exported, timeline's
    override first. A timeline without it behaves exactly as today.
  - `origin: Option<TimelineOrigin>`: provenance, `{kind: "clip_short" | "clip_trailer",
    run_id, proposal_id, source: {media_id | timeline_id}, segments: [{source_path,
    start_s, end_s, role: "hook" | "body" | "beat"}], built_at_view: viewId, settings_hash,
    built_content_hash}`.
- **Clips on a built timeline point at the original media** with `source_start` and `duration`,
  never at a nested timeline (Apelles has no nesting, and Premiere's nest loses transition
  handles). When the source is an Edit timeline, each segment is mapped back through that
  timeline's clips to media ranges (the inverse of the D-329 stitch), and each clip's own
  properties (grade LUT, EQ, gain) are copied onto the new clips. The short therefore matches the
  graded long-form.
- Timelines built from one run are grouped in the switcher ("Shorts · <source name>") using the
  run id in `origin`, with no new container type.

### 5.2 Runs and proposals are persisted review state

- A **clip run** = `{id, source, settings, view_id, created_at, proposals[], trailer?}`, stored
  in the project directory as `clips/<run-id>.json`. It is written through `apelles-project`
  (atomic write, versioned schema), not inside `project.json`, so a 40-proposal run does not
  bloat every manifest save. Unlike retake and music-edit proposals (session state), a run
  survives restarts because it cost minutes of analysis and an agent's judgement.
- A **proposal** = `{id, kind: short | trailer_beat, segments[{first,last}] (sentence indices of
  the run's view) + resolved seconds, hook?, title, reason, score, features, picked_by:
  heuristic | client | person, gate: {status, issues[]}, status: pending | accepted | rejected |
  built | exported, timeline_id?, aspect, layout, captions_preset}`.
- **Cache vs. state:** transcripts, VAD, audio features, scene cuts and face tracks are *caches*
  (keyed by media content hash + analyser version, under the existing media cache), recomputable
  and never authoritative. Runs and built timelines are *state*.

### 5.3 Regenerate one without touching the others

- **Rebuild a short** (`editor_build_clips {ids, rebuild:true}`) rebuilds only that proposal's
  timeline, in place, as one undo step. If the timeline changed since it was built (its content
  hash differs from `origin.built_content_hash`), the rebuild is refused unless `as_new_version`
  (a new timeline "… v2") or `replace_edits: true` is passed. The GUI asks the same question. A
  person's edits are never silently lost.
- **Re-judge** (a new focus prompt, other lengths) creates new proposals in the same run from
  cached features, in milliseconds. Proposals already accepted or built are kept.
- **Stale view:** if the source transcript changes (a retranscribe, a dark-region recovery), the
  run's `view_id` goes stale. Proposals stay readable, and new ones are refused until re-judged,
  as with D-380's `viewId`.

---

## 6. The MCP surface

Both servers (`mcp/server.py`, `crates/apelles-mcp`), parity corpus re-captured. Async pattern
as for transcripts and exports: start → `state` → poll the status tool, with results usable while
still running.

### 6.1 The one call

```
editor_auto_clip(
  source: {media_id | path | timeline_id},      # default: the active timeline
  outputs: "shorts" | "trailer" | "both" = "shorts",
  count: int = 5,                                # shorts to BUILD; ~3x kept as proposals
  durations: [15|30|60|90] = [30, 60],
  aspect: "9:16" | "1:1" | "4:5" = "9:16",
  range: {start_s, end_s}?,                      # Opus "timeframe"
  focus: str?,                                   # "the pricing discussion", "funny moments"
  judge: "auto" | "heuristic" | "client" = "auto",
  style: {hook_first: bool = true, captions: preset_id | "none" = "caption-pill-karaoke",
          hook_title: bool = false, layout: "auto"|"fill"|"fit"|"split" = "auto",
          punch_ins: bool = false, cta: {text, url}?, music: "none"|"project"|"search" = "none"},
  build: bool = true,                            # create the timelines
  export: {dir, loudness_preset}?                # optional: also queue the exports
) -> {run_id, state, progress, proposals_so_far, timelines_built[], view?}
```

- With `judge: "auto"`, the call runs the heuristic and builds immediately, so **one call gives
  usable shorts**. The response also returns page 0 of the moment view (with `instructions`), so
  a connected client can improve the set with `editor_propose_clips` in a second call. The
  `apelles-auto-clip` skill (§6.3) is exactly that loop.
- With `judge: "client"`, nothing is built until the client proposes.
- A cold source (no transcript yet) answers `state: "transcribing"` with progress and any
  provisional proposals from the windows already transcribed (§8). Poll
  `editor_auto_clip_status {run_id}`.

### 6.2 Iteration tools

| tool | does |
|---|---|
| `editor_auto_clip_status(run_id)` | progress per stage, proposals so far, timelines built |
| `editor_get_moment_view(run_id, offset?)` | the numbered sentence view + `instructions` on page 0 + `view_id` |
| `editor_propose_clips(run_id, view_id, clips[], replace=false)` | client proposals (`segments`, `hook`, `title`, `reason`, `score`) → gate verdict per clip; `replace` swaps the run's client set |
| `editor_list_clip_proposals(run_id?)` | runs, or one run's proposals with status / score / reasons / gate / timeline |
| `editor_set_clip_proposal(run_id, id, …)` | accept / reject; nudge an edge by sentences or words (`extend_start: -1` = add the previous sentence); set hook, title, aspect, layout, captions preset. Re-gated on every change |
| `editor_build_clips(run_id, ids?, rebuild?, as_new_version?)` | proposals → timelines (§5.3 rules) |
| `editor_reframe_clip(track, clip, mode, smoothing, subject?)` | Auto reframe on any clip of the active timeline (§4.2); returns the keyframes written and the detection coverage |
| `editor_build_trailer(run_id, beats?, length_s?, music?, title?, cta?)` | builds or rebuilds the trailer timeline (§7); `beats` lets the client choose them |
| `editor_export_clips(run_id \| timeline_ids, dir, preset, loudness_preset)` | queue exports of several timelines, without switching the view (gap 3) |
| `editor_list_timelines()`, `editor_create_timeline(name, width?, height?)`, `editor_set_active_timeline(id)`, `editor_rename_timeline`, `editor_delete_timeline`, `editor_set_timeline_output(id, width, height)` | the timeline management missing today (gap 2); general Edit tools, not clipper-only |

### 6.3 Skill

`.claude/skills/apelles-auto-clip/SKILL.md`, the wrapper around the loop, modelled on
`apelles-retake-review`: call `editor_auto_clip`; read every page of the moment view; judge by
the *served* instructions; `editor_propose_clips`; resolve refusals by narrowing to sentence
boundaries; build; hand back to the person (Clipper panel). It cuts or exports only when asked,
and points to `apelles-sound-design` for trailer music.

---

## 7. Trailer

- **Structure** (from the trailer guides and our teardown):
  1. **Cold open, dry:** the single most provocative line (a stat, a confession, a contrarian
     claim), 3 to 8 s, no music.
  2. **Title card:** a Motion template (or a text clip without Motion), music in on the cut.
  3. **Premise beat:** one line that says what the piece is about.
  4. **3 to 6 proof beats,** 3 to 12 s each, chosen from different topics (the topic
     segmentation), ordered setup → tension → escalation, with the payoff *withheld*. Beats
     accelerate: later ones are shorter.
  5. **Button:** a line that lands, preceded by a 1 s stop-time breath in the music.
  6. **End card, dry CTA:** title, date/URL. Music out.
- **Length:** 30 / 60 / 90 s (default 60). 16:9 by default (the long-form's own aspect), with a
  9:16 version as a second build of the same beats (the reframe is applied per beat).
- **Pacing:** beats are tightened harder than shorts (`TIGHT_GAP_S` 0.15 s). Optional 4 to
  6-frame dip-to-black transitions between beats (existing `dip_to_color`, D-226).
- **Music:** a bed on its own track, ducked about 19 dB under the voice. Beats are edited with
  **D-408 music edits proposed for review:** `dry_open` over the cold open, `breath` before the
  button, `dry_cta` over the end card. The bed comes from project assets, or from Openverse only
  when asked (§12, Q4), with credits recorded (D-400).
- **Judge:** the client chooses beats from the moment view (`editor_build_trailer {beats}`). The
  heuristic chooses the cold open by `hook_text` and short length, and beats by score plus topic
  diversity.
- **GUI:** a storyboard strip of the beats (drag to reorder, swap a beat for another candidate,
  toggle music), then Build.

---

## 8. Performance budget (60-min podcast, Apple Silicon)

Owner's priority order is performance, then stability, then ship speed. Targets, measured in the
phase that ships each step. Each is a pass/fail line in that phase's verification.

| step | cold (no cache) | warm (cached) | how |
|---|---|---|---|
| panel opens, setup shown, source waveform | < 200 ms | < 200 ms | existing waveform cache |
| first provisional proposals visible | **< 45 s** | **< 2 s** | transcribe in 5-min windows, in order (`/transcribe` `start_secs`/`end_secs`, already used by D-349): the first window lands in about 17 s at 17.6x; candidates + heuristic per window are milliseconds |
| full transcript | ≈ 3.5 min | 0 | Parakeet 17.6x realtime; windows can run while the person reviews |
| VAD over the hour | ≈ 10 to 20 s, in parallel | 0 | Silero, cached per range |
| candidates + features + selection (full hour) | < 1 s | < 1 s | pure Rust over about 10k words |
| poster frame per proposal | < 150 ms each | cached | the filmstrip / thumbnail path |
| reframe analysis per 60 s short | < 5 s | cached | Vision at 4 fps on 1/4-res decode, only the clip's ranges, highest-scored first |
| build one short (timeline ops) | < 300 ms | — | ops only, no render |
| export one 30 s 1080x1920 short | ≤ realtime target (measure) | — | compositor renderer (D-350/D-351); sequential queue |

**Progressive rule:** proposals from early windows are marked *provisional* and can be outranked,
but the board **never reorders under the pointer or the keyboard selection**. New cards appear in
a "new" lane until the person scrolls or analysis finishes.

**What a regenerate reuses:** a new focus, count or length re-runs only candidates and selection
(milliseconds). A new aspect re-runs only the crop maths on cached face tracks. Nothing
re-transcribes unless the person retranscribes.

---

## 9. Layers (D-039) and files

| layer | piece | new / changed |
|---|---|---|
| L1 `apelles-media` | `vision_faces` (Vision face rects + lip landmarks + saliency + human rects per sampled frame), audio features (RMS envelope per window) | new modules; extra `objc2-vision` features only |
| L2 `apelles-timeline` | `Timeline.output`, `Timeline.origin` | changed (serde-default fields) |
| L2 **`apelles-clipper`** (new crate, pure, deps: `apelles-types`, `apelles-speech`) | sentences, TextTiling topics, candidates, features, heuristic score + MMR, clean-cut gate, moment-view renderer + `JUDGING_RULES`, trailer planner, reframe camera planner, speaker switching | new; no external deps |
| L2 `apelles-project` | `clips/<run>.json` read/write + schema | changed |
| L4 app `chroma::clipper` | the job (windows → candidates → status), caches, Tauri commands, control-server ops | new |
| tabs `@apelles/editor` | `clipper/` (run store, build ops composing existing timeline ops, `ClipperPanel.tsx` as an 8th library mode with `FilmSlateIcon`, `ClipReviewBoard.tsx`, `TrailerStoryboard.tsx`), captions-from-timeline op, per-timeline output in `compositionSize.ts`, `TimelineSwitcher` rename/delete/grouping, Inspector "Auto reframe" | new + changed |
| MCP | tools in §6 in both servers | new |
| skill | `.claude/skills/apelles-auto-clip/` | new |
| eval | `eval/clipper/` | new |

The build ops are **TS document ops composing existing ops**, like `applyMusicEdits` (D-408):
the TS store is the timeline's one writer (D-051/D-318), so building a short is `create
timeline` + `edit_in` per segment + `ripple_delete_ranges` + `set_clip_keyframes` + captions, as
one history entry per timeline.

---

## 10. Phases

Each phase ships on its own: code, both MCP servers, GUI, tests and docs in the same commits.
They are ordered so **Phase 1 already gives a usable one-call shorts path.**

### Phase 0: Timelines that can be shorts *(Opus: crosses preview, export and the project model)*
- `Timeline.output` per-timeline size, honoured by the preview, `compositionSize.ts`, the
  canvas boundary, both export renderers and FCPXML export. `Timeline.origin`.
- Timeline MCP tools (§6.2 last row) + GUI rename / delete / output size in `TimelineSwitcher`
  and the Project Settings panel ("This timeline: 1080x1920").
- Export a timeline by id without switching (queue compiles from an id).
- Captions from the *timeline* transcript (an op + a button option + an MCP parameter on
  `editor_generate_captions_from_transcript`: `from: "timeline"`).
- Tests: a size-override round trip; a 9:16 export from a 16:9 project is pixel-checked; captions
  follow a cut; the journal replays the new ops. Each is a real, independently useful Edit
  feature.

### Phase 1: One-call shorts, transcript-driven *(Opus for the crate + gate; the rest routine)*
- `apelles-clipper` crate: sentences, topics, candidates, features (text + VAD + RMS), heuristic +
  MMR, clean-cut gate, tightening plan. Unit-tested with fixtures from `eval/retake/transcripts/`.
- `chroma::clipper` job with windowed, progressive transcription; runs persisted.
- MCP: `editor_auto_clip` (judge `heuristic`), `_status`, `editor_list_clip_proposals`,
  `editor_set_clip_proposal` (accept/reject/extend), `editor_build_clips`, `editor_export_clips`.
- Build: one 9:16 timeline per short, **centre-crop static framing** (fill height), tightened
  pauses, verified retakes cut, captions preset.
- GUI: Clipper library mode, setup with defaults (one click), a proposal **list** (poster, title,
  score + reasons, duration), Build selected, Export all.
- Eval scaffold `eval/clipper/` (§11) with the boundary metrics passing at 0 mid-sentence edges.

### Phase 2: The client judges *(Opus: the judging prompt is measured, as in D-379)*
- Moment view + served `JUDGING_RULES` + `editor_get_moment_view` + `editor_propose_clips` (gate
  verdicts, refusal loop), `judge: "client" | "auto"` semantics.
- The `apelles-auto-clip` skill. Blind client runs scored against owner labels (§11).

### Phase 3: Subject-aware reframe *(Opus)*
- `apelles-media::vision_faces`, the camera planner (stationary / pan / track, RDP keys,
  headroom), `editor_reframe_clip`, Inspector "Auto reframe" (any clip), overscan in the preview,
  `fit` (blurred fill) and `screen_and_face` layouts. Measured on the owner's talking-head and
  screen-recording footage.

### Phase 4: The review board *(Opus: the performance and interaction quality is the feature)*
- `ClipReviewBoard.tsx`: progressive grid of 9:16 cards (the poster with the crop applied,
  hover-scrub from filmstrip thumbnails, one live decode for the selected card in the main
  preview), keyboard review (J/K move, Space play, A accept, X reject, `[`/`]` move the in/out
  edge by a sentence, Alt for a word, `Shift+[` "add the sentence before"), a transcript strip with
  sentence-snapping handles and the hook marked, a mini-map of where the moment sits in the
  source, per-card Regenerate ("another like this") and protected rebuild. Board and detail sit
  in a resizable split (`@apelles/ui` `resizable.tsx`).

### Phase 5: Two-person podcasts *(Opus: hard, needs measurement)*
- Lip-motion × VAD active speaker, sentence-aligned hard-cut switching, `split` layout,
  per-angle (multi-camera) mode by mic level. An eval on a real 2-person recording.

### Phase 6: Trailer *(Opus design pass for beat choice; the build is routine)*
- Beat selection (heuristic + client `beats`), structure plan, `editor_build_trailer`, title /
  end cards (Motion template, or a text clip when Motion is not in the build), music bed + D-408
  proposed dropouts, 16:9 + 9:16 builds, storyboard GUI.

### Phase 7: Polish and options *(routine, except the local-LLM eval)*
- Hook title overlay, CTA end card on shorts, an optional music bed on shorts, punch-ins,
  "export all aspects" (9:16 + 1:1 + 4:5 from one proposal), a burned-in-subtitle warning,
  fillers option. An optional local LLM judge, kept only if the eval shows it beats the
  heuristic.

---

## 11. Evaluation (how "not sloppy" is measured)

`eval/clipper/`, built the same way as `eval/retake/`:

- **Mechanical, must be perfect:** 0 clip edges mid-word or mid-sentence, 0 duration misses, 0
  replayed retakes, across every proposal on every fixture. The gate makes this structural; the
  eval proves it.
- **Judgement, tracked:** the owner labels the 5 to 10 "best moments" on 3 sources (a podcast, a
  course segment, a founder talk) as source-second ranges. Metrics: top-5 / top-10 hit rate
  (proposal overlaps a label by at least 50%), hook-sentence agreement, and how many
  "needs the previous sentence" corrections the owner makes in review. Heuristic vs. client (3
  blind runs, as D-379) vs. (Phase 7) local LLM.
- **Reframe:** the share of sampled frames where the face box lies fully inside the crop; crop
  moves per minute (lower is calmer); a contact sheet for the eyeball pass (CLAUDE.md: look
  quality is eyeballed and documented).
- **Speed:** the §8 table, measured on a 60-min file, recorded in the phase's D-NNN.

---

## 12. Open questions for the owner (only the ones that change the design)

1. **No-agent judge in the GUI: heuristic only, or ship a local LLM?** Recommended: **heuristic
   now**, honest about what it is, with reasons on every card. The LLM path is the MCP client.
   A local LLM (2.5 to 9 GB, slower) comes back in Phase 7 only if the eval shows it beats the
   heuristic.
2. **Where shorts live: new timelines in the same project, or one project per short?**
   Recommended: **timelines in the same project** (Descript's model). Shared media pool and
   grades, one place to review. Needs Phase 0's per-timeline size.
3. **Does the one call also render files?** Recommended: **no by default.** It stops at built
   timelines and proposals (seconds, fully editable). `export: {dir}` or "Export all" renders
   when asked, because rendering 5 shorts costs minutes and the person usually wants a pass
   first.
4. **Music from Openverse automatically?** It is a network call, and the invariant is
   local-first. Recommended: **shorts have no music by default. The trailer uses a bed from the
   project's `assets/audio/` if there is one.** Openverse search runs only when the person or
   agent explicitly asks (`music: "search"`), with credits recorded.
5. **Accept a long Edit timeline as the source in Phase 1, or only a media file?** Recommended:
   **both in Phase 1.** A founder's long-form usually already lives as an edited, graded
   timeline, and the mapping back to media exists in reverse (D-329). The short then inherits
   the grade.
