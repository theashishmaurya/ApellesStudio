# Pacing / audio-assistance research (2026-09-05)

Research pass only — **no feature design, no phased build plan**. The owner's ask, verbatim:
*"we need to understand video, understand emotion, manage beats, sync transitions, etc — all
those things sound engineers do."* This is new territory for Apelles; nothing in `docs/` covers
the audio/rhythm/pacing side today. The one adjacent roadmap item, "Visual understanding for the
Editor tab" (`docs/04-roadmap.md`, Later section), is about *visual* footage understanding
(Qwen3-VL search, B-roll tagging, shot classification, auto-reframe, highlight detection) — not
duplicated here. A separate Opus pass will use these findings to scope an actual v1; that
scoping is explicitly out of scope for this document.

Organized by the five questions asked. Real vs. research-grade is called out per finding, not
just in a summary — that distinction is the point of this doc.

---

## 1. Beat / onset detection — what's real and usable today

**Yes, this is solid, mature technology.** Detecting beats/onsets in a music track is one of
the oldest, best-studied problems in music information retrieval (MIR); it is not a research
gap.

### The libraries

- **`librosa`** (Python, BSD-3, huge install base) — `librosa.beat.beat_track()` uses Ellis's
  dynamic-programming beat tracker (2007): onset-strength envelope → tempo estimate via
  autocorrelation → DP picks beat positions consistent with that tempo. Simple to call, well
  documented, the default choice in almost every hobbyist/DJ/video tool that does this in
  Python. Not deep-learning-based, so it's fast and dependency-light, but its accuracy trails
  modern neural approaches on genres with a weak or syncopated pulse.
- **`aubio`** (C library, Python/Rust/other bindings) — designed for **causal, low-latency**
  onset/beat/tempo/pitch detection, i.e. it can run on a live stream, not just after-the-fact on
  a whole file. That's not what Apelles needs (Apelles always has the whole track available
  up-front — a bake, not a live input), so aubio's headline strength doesn't buy anything extra
  here. **License: GPL-3.0** — copyleft, distribution-triggering; needs the same kind of check
  Apelles already runs on every new dependency (D-NNN per `CLAUDE.md`), and is a meaningfully
  different license posture than a permissive dep even though the `app/` fork itself is AGPL.
- **`essentia`** (C++ with Python/JS bindings, from the Music Technology Group, Barcelona) — a
  much broader MIR toolkit; ships multiple beat trackers (`BeatTrackerDegara` — fast, tuned for
  batch processing of large audio collections; `BeatTrackerMultiFeature` — combines several
  detection functions, higher accuracy, slower). **License: AGPL-3.0** for the code (compatible
  in spirit with Apelles' own AGPL posture at `app/`), but its **pretrained models are
  CC-BY-NC-ND** (non-commercial, no-derivatives) — a real gate if Apelles ever ships a commercial
  build using any essentia *model* (as opposed to just its signal-processing algorithms, which
  don't need the models). Essentia is C++/Python only; no native Rust essentia exists (only
  essentia.js, a WASM build for the browser, not directly usable from a Rust/Tauri backend).
- **`madmom`** (Python, from Johannes Kepler University Linz) — the neural-network beat/downbeat
  tracker most MIR papers still benchmark against; recognized as state-of-the-art or
  near-state-of-the-art through the late 2010s and still a standard baseline in 2025 papers.
  **License is split**: source code is BSD (permissive), but the *pretrained model/data files*
  are **CC-BY-NC-SA-4.0 — non-commercial only**, with an explicit note to contact the author for
  a commercial license. This is a hard blocker for shipping madmom's actual trained weights in a
  commercial local-first app without a separate agreement — the same shape of gate Apelles' own
  `docs/notes/relight-research.md` and `04-roadmap.md` (Molmo 2 exclusion) have already hit and
  documented for other models.
- **Newer transformer-based trackers** (2024–2025 papers, e.g. "Beat this! Accurate beat
  tracking without DBN postprocessing," BeatNet, BEAST) push F-measure higher still — one
  October 2025 result reports **89.2% Beat F1** on a standard benchmark set, versus madmom-class
  baselines in the 70s–80s. These are research-repo releases (PyTorch checkpoints on GitHub),
  workable to self-host, but each needs its own license check per-repo before use — no blanket
  answer.

### Real accuracy numbers (found)

Beat-tracking accuracy is conventionally reported as **F-measure at a ±70ms tolerance window**
against human-annotated ground truth. On typical benchmark sets (mixed genre, e.g. GTZAN/Ballroom
style collections): classical DP-based trackers (librosa's Ellis algorithm, essentia's
Degara) land roughly in the **60–80% F-measure** range depending on genre — strong on music with
a clear, steady pulse (pop, EDM, hip-hop — exactly the genres a solo creator is most likely to
use as background/BGM), noticeably weaker on rubato, freeform, or highly syncopated material.
Modern neural trackers (madmom-class and newer transformer models) push into the **80–90%+**
range on the same kind of benchmarks. **Downbeat** (which beat in the bar is beat 1) is
consistently and substantially harder than plain beat detection — the BEAST paper reports beat
F1 ~80% vs. downbeat F1 ~53% for the *same* system, and that gap shows up across the literature,
not just that one paper. **Practical takeaway for Apelles:** plain beat detection on typical
BGM/stock-music tracks is reliable enough to build on; downbeat/meter detection is meaningfully
less reliable and should be treated as a stretch goal, not a v1 assumption.

### Can it run local/offline, and where (Python sidecar vs. native Rust)?

- **All four Python options run fully offline, no network call** — this is standard, mature
  desktop/server MIR tooling, not a cloud API. That satisfies Apelles' local-first invariant
  trivially.
- **Python sidecar (`ai/`)**: straightforward. Apelles already runs a FastAPI Python sidecar for
  vision models (SAM 2, ViTMatte, Video Depth Anything, MoGe-2 — confirmed by reading
  `ai/server.py` and `ai/requirements.txt`). It currently has **zero audio dependencies** —
  adding `librosa` (or essentia) would be a new dependency *category* for that sidecar, not an
  extension of an existing one, worth flagging even though mechanically trivial (one new route,
  one new pip package).
- **Native Rust, avoiding the sidecar round-trip entirely**: real options exist but are
  meaningfully less mature than the Python side.
  - `aubio-rs` — safe Rust bindings to the C aubio library. Inherits aubio's GPL-3.0 license
    (see above) and its causal/streaming design bias (not a problem for a bake, just not the
    library's showcase use case).
  - Pure-Rust crates written by individual maintainers, not MIR labs: `bpm-analyzer` (wavelet +
    autocorrelation BPM estimation, ~11 GitHub stars, small/young project, its own docs note
    accuracy degrades outside 40–240 BPM and on polyrhythmic material), `beat-detector`
    (`no_std`-compatible, built for live-audio beat detection on embedded-ish targets, not
    tuned for offline file analysis), `cascade-rhythm` (spectral-flux onset + autocorrelated
    BPM, built as the audio-analysis core of a terminal rhythm *game*, not a general-purpose
    library — usable in principle, not built or vetted for editorial accuracy work).
  - **Honest read**: there is no Rust-native library with anything like librosa/essentia/madmom's
    track record, benchmark coverage, or maintenance backing. A native-Rust beat detector today
    means either wrapping aubio (GPL) or trusting a small single-maintainer crate with no
    published accuracy numbers. The mature, well-benchmarked path is Python.

### Processing speed for a 5-minute track

**Could not find hard, citable wall-clock benchmarks** for librosa or essentia processing a
5-minute audio file specifically — this is a real gap in what's findable via search, not
something to paper over with a fabricated number. What is well established in the docs and
general MIR practice: these are all lightweight signal-processing pipelines (STFT + onset
envelope + autocorrelation/DP, no GPU, no large neural forward pass for the classical trackers)
operating on mono/low-samplerate-downsampled audio — the kind of workload that runs many times
faster than real-time on ordinary CPU hardware (i.e. a 5-minute track should analyze in low
single-digit seconds, not minutes) — but that is an informed expectation from the algorithm's
computational shape, not a verified benchmark, and should be labeled as such if it ends up in
downstream planning. Essentia's own docs note `BeatTrackerDegara` is explicitly the
faster-but-slightly-less-accurate option, "reasonable to apply for batch processing of large
amounts of audio" — a relative claim, not an absolute number. **A real local throughput
benchmark, if this direction is pursued, is a first concrete task** — the same posture the
roadmap already takes for the visual-understanding item ("current numbers are extrapolated, not
measured").

### MCP angle

Beat detection is the cleanest, most obviously agent-scriptable capability in this whole
research pass. A tool shaped like `detect_beats(clip_id) -> { beats: [seconds...], tempo_bpm,
confidence }` (returning positions, not making edit decisions) is a natural fit for Apelles'
existing MCP design rules (`docs/07-mcp-surface.md`: reads are cheap and side-effect-free, tools
return numbers not vibes) — an agent could call it, then place cuts or `Timeline::link`-style
ops at those positions itself, exactly the "agent sets intent, precise placement is a tool call"
division of labor the vision doc already argues for elsewhere.

---

## 2. Cut-to-beat / auto-editing — what real tools actually do

Every real tool found does **one of two things**: (a) mark beat positions on the timeline for a
human to snap to, or (b) auto-place/auto-trim cuts at beats with a sensitivity/density dial. None
found does anything resembling AI *creative* judgment about *which* beats matter — it's all
signal-processing-driven marker placement, sometimes wired to an editing action.

- **Adobe Premiere Pro — "Audio Beat Detection" (Essential Sound panel)**: select an audio
  track → the panel adds **markers** at detected beats, with a density control (**"Fewer" /
  "More" / "All markers"**). That's it — it does not cut anything itself. The workflow is
  manual: drag a clip, it snaps to the nearest marker. This is squarely "mark beats, human
  places cuts" — approach (a). There's also a **third-party plugin ecosystem** doing the same
  job with more polish (BeatEdit, BeatMarker, Blinkl's Beat Detector) — the existence of a
  multi-vendor plugin market around "detect beats and drop markers" is itself a signal that
  Premiere's native version is felt as basic/limited by working editors, and that the underlying
  capability (beat markers on a timeline) is considered valuable enough to pay for.
- **CapCut — "Auto Beat" / "Beat Sync"**: closer to approach (b). Auto Beat detects markers
  (with a sensitivity slider to control density, same shape as Premiere's "fewer/more/all").
  Turning on **Beat Sync** goes further — it actively **trims clips to align cut points with the
  beat markers**, i.e. it does perform the edit, not just mark it. Documented user guidance is
  explicit that this is a blunt instrument: "keep your clips slightly longer than you think you
  need, Beat Sync will trim them" and "if too many markers, lower sensitivity or manually delete
  excess ones" — i.e. real users routinely fight its over- and under-triggering by hand. This is
  the most automated real example found, and its own documentation concedes it needs manual
  correction, not that it's a solved, hands-off feature.
- **Descript**: detects beats in a background-music track and **suggests cut points in the
  transcript** to tighten pacing in rhythm with the soundtrack — notable because Descript's whole
  editing model is text-based (edit video by editing a transcript), so its beat feature is
  transcript-cut-suggestion, not timeline-marker placement — a genuinely different UX shape worth
  noting since Apelles' own footage-editing model is closer to a traditional timeline than
  Descript's. Its separate Audiogram feature (waveform pulsing to the beat) is a visual-effect
  application of the same beat data, not an editing decision.
- **Kapwing**: no beat-sync-specific feature found in search results; nothing to report as a
  positive finding here (a gap in what's findable, not a confirmed absence — didn't find
  documentation either way).

**Reading across all of these**: none does the sci-fi "understands the song's structure and
recomposes your footage" thing. They all reduce to "run a beat detector, expose the timestamps as
markers or snap points, optionally auto-trim clip boundaries to the nearest one." That is a
scoped, well-understood UX pattern, not a research problem — the hard part elsewhere in the
literature (musical structure, downbeat/meter, "which beat matters more") is exactly the part
none of these consumer tools attempt.

### MCP angle

Given the finding above, the natural Apelles-shaped tool isn't `auto_edit_to_beat()` (that's the
CapCut/blunt-instrument shape, and its own users report needing to correct it) — it's closer to
`detect_beats` (§1) feeding a second, separate, human-or-agent-driven step that actually places
cuts, mirroring Premiere's "detect, then a human/agent snaps to it" model more than CapCut's
"just do it" model. Consistent with the vision doc's explicit "not an auto-editor" non-goal.

---

## 3. Emotional / pacing analysis of footage — how real is this, honestly

**Mixed, and the honest split matters.** Several of the individual *signals* that would feed a
pacing analysis are real and measurable today with existing open tools. The *synthesis* into
something that understands "emotional arc" is not — that part is marketing language or
research-paper territory, not a shipped, usable capability.

### Real, measurable, buildable-today signals

- **Shot-length / cut-frequency analysis**: real and old. **PySceneDetect** (Python, open
  source, actively maintained) does content-aware shot-cut detection — rolling HSL-colorspace
  difference thresholding — and is explicitly built for batch processing with published
  speed/accuracy benchmarks on its own site. This directly gives "average shot length," "cuts per
  minute," "shot-length variance over time" — real, quantifiable pacing signals, not
  speculation. This same underlying task (detecting hard cuts in a video) is closely related to
  what the film-studies field calls **"Cinemetrics"** — quantitative shot-length analysis has
  been an academic practice for over a decade; it's not a new idea, just not previously wired
  into an editing tool's assistance layer.
- **Audio loudness / energy curve**: real and standard sound-engineering practice, and already
  adjacent to what Apelles' own sibling project (videoAgent's `/music-score` skill) documents in
  concrete terms — LUFS measurement, RMS/short-term loudness over time. Plotting a track's
  loudness envelope is bog-standard audio engineering (any DAW, `ffmpeg`'s `loudnorm`/`astats`
  filters, or a few lines of librosa RMS), not research-grade.
- **Tempo curve**: real, if less commonly done — beat tracking (§1) with a sliding window gives
  a "does the music speed up/slow down" signal directly.
- **Motion intensity from the picture itself**: real, existing, standard computer-vision
  technique — optical flow magnitude (Farneback, RAFT, etc.) or simple frame-difference energy
  gives a genuine "how much is moving on screen" signal per frame, cheaply, without any
  exotic model. This is a much lower bar than the vision-side items already scoped on Apelles'
  own roadmap (Qwen3-VL semantic search) — it's classical CV, not an LLM/VLM call.

### Research-grade, not practical today

- **"Emotional arc" understanding** in the sense the owner's phrasing implies — a system that
  watches footage and *understands* the emotional trajectory the way a human editor feels it —
  is not a shipped, usable capability anywhere found in this search. Search results turned up
  a "Berkeley Audio Lab study demonstrating 95% accuracy in beat detection across genres" and an
  "MIT Media Lab" emotion-aware-content claim, both from a single content-marketing blog post
  (reelmind.ai) with no linkable paper, no named authors, no methodology — this reads as
  unverifiable marketing copy, not a real citation, and is called out here specifically so it
  doesn't get treated as a real finding downstream. It is being explicitly flagged as **not
  credible** rather than silently omitted, per the instruction to be honest about what wasn't
  found.
- Genuine academic work exists on emotion recognition from video (facial micro-expression
  models, audio-affect classifiers) but it targets *recognizing emotion in the footage's
  subject* (a speaker's face, a scene's mood classification) for research/analytics purposes —
  not "recompose my edit to build tension," and none of it showed up as an integrated,
  practical, locally-runnable open tool aimed at editorial pacing assistance. This is the
  sci-fi end the task explicitly asked to be honest about, and the honest answer is: **not
  practical today**, full stop — the individual signals above are real, but nothing stitches
  them into "understand the emotion" today, and nothing found suggests that's close.

### MCP angle

The real signals above (shot-length distribution from PySceneDetect-style detection, loudness/
energy curve, tempo curve, motion-intensity curve) are each independently exposable as a
read-only inspection tool in the same shape as Apelles' existing `inspect_color` — e.g.
`inspect_pacing(clip_id) -> { cuts_per_minute, shot_length_curve, loudness_curve,
motion_intensity_curve }` — numbers an agent (or a human) can reason about, not a verdict the
tool hands down. That mirrors design rule 0 in `docs/07-mcp-surface.md` almost exactly: "grade
by the numbers, not the vibe" — the same discipline applied to pacing instead of color.

---

## 4. What a genuinely useful, appropriately-scoped v1 looks like

Not a design — the Opus scoping pass owns that — but the technical grounding for judging one:

**The real, buildable floor**, based on everything above: detect beats in a background-music
track (librosa in the Python sidecar — mature, offline, license-clean, fast enough by
algorithmic shape even without a verified benchmark) and surface them as **markers/snap points**
on the timeline, the same UX Premiere and CapCut both already ship, not novel invention. This is
concretely valuable to exactly the owner's own real workflow (talking-head/explainer solo
content in `projects/youtube-ashishmaurya/` in the sibling videoAgent repo, where `/music-score`
already places a music bed by hand) — it removes "listen to the track and manually mark where the
beats fall" busywork, a real, named step in that skill's own documented workflow, without
claiming to make editorial decisions for the creator.

**The real, buildable ceiling before hitting research territory**: layer in the other
*measurable* signals from §3 (shot-length/cut-frequency from PySceneDetect-style detection,
loudness envelope, motion-intensity curve) as additional read-only inspection data an agent or
the human can reason about — "your cuts are getting longer right when the music is building" is
a real, calculable statement, not a vibe. Auto-*placing* cuts to match (CapCut's Beat Sync shape)
is a meaningfully bigger and riskier step — the real tools that do it concede it needs manual
correction — and downbeat/meter detection (knowing which beat is "beat 1") is measurably less
reliable than plain beat detection, so anything depending on musical *structure* rather than
raw pulse timing is shakier ground.

**Past the ceiling, into research-grade**: anything claiming to understand "emotional arc" and
recompose footage accordingly. Nothing found in this research is a real, usable, practical
implementation of that today — see §3.

---

## 5. MCP/agent-control angle — summary across findings

Collected here for the scoping pass, not re-derived per section above:

| Real capability | Rough MCP tool shape | Notes |
|---|---|---|
| Beat detection on a music track | `detect_beats(clip_id) -> {beats: [sec...], tempo_bpm, confidence}` | Read-only, cheap, side-effect-free — fits design rule 3 in `07-mcp-surface.md` directly. An agent can call this then script cuts/markers itself. |
| Shot-length / cut-frequency analysis | `inspect_pacing(clip_id) -> {cuts_per_minute, shot_length_curve}` | Same "numbers, not vibes" shape as `inspect_color`. |
| Loudness / energy envelope | folds into `inspect_pacing` or a sibling `inspect_audio_energy` | Standard audio engineering, cheap to compute. |
| Motion-intensity curve | folds into `inspect_pacing` or computed alongside the roadmap's existing visual-understanding item | Classical CV (optical flow / frame-diff), no new model class needed. |
| Auto-cut-to-beat (CapCut-style) | *if ever built*, something like `snap_clip_to_beat(clip_id, beat_index)` — a precise, single-clip, human/agent-approved op | Explicitly not `auto_edit_to_beat()` — the real tools that do blunt auto-cutting are the ones users report fighting; a scriptable single-cut primitive lets an agent make the same kind of considered, one-at-a-time decision Apelles' other MCP tools already model (`match_to_reference`'s damped-iteration pattern is the closest existing precedent for "agent nudges toward a target, doesn't just yank the value there"). |

None of these need new architectural surface beyond what Apelles already has for other AI
sidecar calls (`ai/server.py` FastAPI routes → `mcp/server.py` tool wrappers, the same shape
`depth_track`/`add_subject_mask` already use) — this is a new *dependency and route*, not a new
*pattern*.

---

## What I could not find good information on

- **Hard wall-clock benchmark numbers** for librosa/essentia/madmom processing a real 5-minute
  audio file on ordinary consumer hardware — searched directly, found none. Flagged above as a
  real first task if this direction is pursued, not papered over.
- **Kapwing's** beat-sync capabilities specifically — no documentation surfaced either
  confirming or denying a feature.
- Any **credible, citable, real-world study or shipped tool** for "emotional arc" understanding
  of edited video — actively searched for this per the task's explicit ask to be honest about a
  negative result, not just to stop looking. The one hit (reelmind.ai blog citing an unnamed
  "Berkeley Audio Lab" study and "MIT Media Lab" work) does not stand up to scrutiny — no
  authors, no paper link, no verifiable claim — and is called out above as non-credible rather
  than cited as a finding.
