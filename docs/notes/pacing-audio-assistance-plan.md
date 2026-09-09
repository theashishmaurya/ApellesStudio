# Pacing & audio assistance — technical plan (scoping, 2026-09-05)

**Input:** `docs/notes/pacing-audio-assistance-research.md` (D-139) — the research pass that
found what is real vs. research-grade here. Read that first; this document does not repeat its
findings, it builds on them.

**This is a scoping/planning pass. No feature code was written.** Same shape as
`docs/notes/on-canvas-transform.md` and `docs/notes/multi-track-nle.md` before their builds.

**Why this is a separate file from the research doc.** They answer different questions and have
different lifetimes. D-139's doc is a findings record — its accuracy claims, licence gates and
"could not find" admissions stay true (and stay auditable) whether or not any of this ships. This
one is a build plan whose sections get ticked, revised and eventually superseded by the code. The
repo already keeps that split (`relight-research.md` vs. `depth-haze.md`; `video-search.md` is
research-only precisely because nothing was scoped from it yet). Folding them would make the
research findings look like design decisions, which is the exact confusion D-139 wrote its
"real vs. research-grade" callouts to prevent.

---

## 1. What exists today, verified by reading the code

Everything below was confirmed in this pass, not assumed.

**The AI sidecar** (`ai/server.py`, `app/src-tauri/src/chroma/sidecar.rs`). FastAPI, spawned and
supervised from Rust, content-hash staleness detection (D-101), TTL model unload (D-084), one
`_GPU` lock serialising every model call, a `_jobs` dict + polling endpoints for long passes
(`/track`, `/depth_track`). **Zero audio dependencies today** — `ultralytics`, `torch`,
`transformers`, `opencv`, `scipy`, `einops`. Rust reaches it over plain HTTP
(`sidecar_base_url()` in `mask.rs` / `depth.rs`), with a shared `unreachable_hint`.

**The media cache** (`chroma::media_cache`, D-128/D-134). `app_cache_dir()/chroma/<ns>/<aa>/<key>`,
key = `blake3(abs path ‖ mtime_nanos ‖ len)`, atomic writes, 1 GB LRU budget, **every failure is a
miss, never an error**. Existing namespaces: `filmstrip`, `probe`, `waveform`,
`keyframe-interval`. `chroma::audio`'s `cached_peaks` is the exact three-tier pattern this feature
wants: memory `HashMap` → `media_cache` JSON → real decode, with the *caller's* display resolution
deliberately kept out of the key.

**The timeline model** (`crates/apelles-timeline`). `Timeline { id, name, rate, tracks }`,
`Track { kind, clips, gain, locked, hidden, sync_locked }`,
`Clip { id, source_path, source_start, duration, source_len, start_frame, link_group, transform… }`.
`chroma_timeline_set` stores whatever it is sent **verbatim** — so any new field on these structs
persists into `project.json` for free, and equally, anything put there is project data the user
owns forever. **There is no marker concept anywhere in the model, the store, or the UI.** Checked
by grep across the crate and `packages/editor` — the only hit is an unrelated comment.

**Timeline snapping** (`packages/editor/src/timeline.ts`). Two pure, tested functions own every
snap decision Apelles actually controls: `computeInsertion` (Sources-panel drop → nearest clip edge
within `snapFrames`, then the D-100 clip-half fallback) and `resolveClipLanding` (dnd-kit clip move,
D-104, delegates to `computeInsertion`). `TimelinePane.tsx` derives `snapFrames` from a fixed
`INSERT_SNAP_PX = 28` at the current zoom.

**Edge-trim snapping is NOT ours.** It is `@xzdarcy/react-timeline-editor`'s `dragLine` prop, and
its type is `dragLine?: boolean` — checked in the bundled `interface/timeline.d.ts`. There is no
custom snap-target array, no snap callback. The library snaps to other actions' edges and the
playhead, full stop. **This is load-bearing for the phasing below.**

**The MCP bridge** (`mcp/server.py` → `chroma::control` → `useChromaControl.ts`). 42 tools,
**all Colorist** — `docs/notes/mcp-tool-coverage.md` records a verified **zero** Edit-tab tools.
Two facts that matter here: `useChromaControl()` is mounted **app-level in `App.tsx`**, not inside
the Colorist editor, so an Edit-tab op is reachable today; and `app` already depends on
`@apelles/editor`, so the bridge can call `timelineStore`'s actions directly.

**The owner's real content.** `projects/prompt-caching-explained/` (the videoAgent sibling repo):
a single continuous 4K HEVC talking-head take (`A001_08302215_C019.MOV`, 517s) plus hand-generated
CassetteAI music beds — `score-02-explainer-bed.wav`, `score-03-build-payoff.wav`,
`hook-A-braaam-drive.wav`. That is the real target content, and §7 treats it as a risk, not a
convenience.

---

## 2. Scope — what v1 is, and what it deliberately is not

D-139 found a real floor (beat detection → markers/snap points, what Premiere and CapCut both
ship) and a real ceiling (read-only pacing-signal inspection). This plan takes the floor as
**Phase 1** and the ceiling as **Phase 2**, and stops there.

**In scope**

- Beat/onset detection on a clip's audio, offline, cached, exposed as timeline guides.
- Snap-to-beat wherever Apelles already owns the snap decision.
- Read-only pacing signals an agent or a human can reason about numerically.
- Full MCP parity for both, designed at the same level of care as the GUI.

**Explicitly out, with reasons**

- **Auto-cut-to-beat** (CapCut's Beat Sync shape). D-139 found its own documentation concedes it
  needs manual correction, and `docs/00-vision.md`'s non-goals say "Not an auto-editor" in as many
  words. The agent-scriptable single-clip primitive (`snap_clip_to_beat`) covers the same need
  under human/agent judgement, which is D-139's own recommendation.
- **Downbeat / meter detection.** D-139: beat F1 ~80% vs. downbeat F1 ~53% for the same system,
  a gap consistent across the literature. Nothing here may depend on knowing which beat is beat 1.
  The `fewer` density mode (§4) is explicitly *decimation, not downbeat detection*, and its tool
  text says so.
- **"Emotional arc" understanding / auto-recomposition.** D-139 searched for this specifically and
  found nothing credible. Not scoped, not deferred to "v2" — there is no evidence it is coming.
- **A persisted marker model.** See §3.

---

## 3. Data model — where beat positions live

Two distinct kinds of data, kept apart on purpose.

### 3a. The analysis result: derived, cached, never project data

A beat set is a pure function of (source file, density, analysed range). It is exactly the same
*kind* of thing as a waveform envelope or a filmstrip chunk, so it goes exactly where those go:

```
media_cache namespace: "beats"
key: peaks_cache_key-shaped — "{source_key}-d{density}-s{start_ms}-e{end_ms}"
value: BeatAnalysis (JSON)
```

`source_key` already invalidates on mtime/size change. A miss recomputes. Nothing about this
belongs in `project.json`, and putting it there would mean a stale beat set surviving a re-encode
of the source — the exact failure `media_cache`'s keying exists to prevent.

In front of it, a `Lazy<Mutex<HashMap<String, Arc<BeatAnalysis>>>>` memory tier, capped and
cleared wholesale, copying `chroma::audio`'s `PEAKS_MEM` verbatim (same reason: the timeline
re-renders many times a second and must not touch the filesystem for this).

### 3b. Timeline display: derived live, no new model field

A beat's position on screen is a pure function of the analysis and the clip's own trim:

```
timelineFrame = clip.start_frame + round(beatSecs * fps) - clip.source_start
```

kept only when it falls inside `[clip.start_frame, clip.end_frame())`. That is the identical
mapping `Waveform.tsx` and `Filmstrip.tsx` already use to place source-space data on a trimmed
clip. So **Phase 1 adds no field to `Clip`, `Track` or `Timeline`.**

**Rejected: `Timeline::markers` in Phase 1.** It is the obvious shape, and it is wrong for the
first slice. It would (a) make a derived, re-computable artefact into permanent project data that
goes stale silently when the source is replaced, (b) force the "beat marker vs. chapter marker vs.
manual named marker vs. comment marker" taxonomy decision immediately, before anyone has used the
feature, and (c) put a hundreds-of-entries array into every `chroma_timeline_set` round-trip, which
is a whole-document write on a 400ms debounce. A real marker model is Phase 3, *if* the owner wants
manual/named markers — a genuinely different feature that happens to be able to consume beats.

**Which clips show beats** is unpersisted UI state in `timelineStore` (a `Set<clipId>`), the same
class as selection and zoom. Honest consequence: the toggle resets on reopen. The *analysis* is on
disk, so re-enabling it is a cache hit, not a re-analysis. Named as an open question in §8 rather
than fixed by quietly adding `Clip.show_beats`.

---

## 4. Backend — where detection actually runs

### The call: the `ai/` Python sidecar, with the coupling named

D-139's finding is unambiguous: there is no Rust-native beat tracker with librosa/essentia/madmom's
track record; the credible native option is `aubio-rs` (GPL-3.0, and Apelles' licence is still an
open product decision — D-002) or a single-maintainer crate with no published accuracy numbers.
The mature path is Python, and Apelles already runs a supervised Python sidecar.

**Library: `librosa` (BSD-3, no model weights).** `essentia` and `madmom` are both excluded on the
licence gate D-139 found — their *pretrained models* are non-commercial (CC-BY-NC-ND and
CC-BY-NC-SA respectively), the same class of gate that already excludes Molmo 2 from shipping
(`04-roadmap.md`) and VDA's vitb/vitl checkpoints (`ai/server.py`'s own comment). librosa's beat
tracker is pure DSP with no weights, so there is nothing to be licensed.

**Real cost, stated up front:** librosa pulls `numba`, `scikit-learn`, `soxr`, `pooch`,
`lazy_loader`, `msgpack`, `decorator`. `scipy`/`numpy` are already there. That is a real install-size
increase and a real **first-call numba JIT warm-up** the sidecar's other endpoints do not have —
the cheapest mitigation is a warm-up call on a 1-second synthetic buffer at import, the same
"warm the model" move `_track_worker` already makes for ViTMatte. Phase 0 measures whether it is
worth it.

**Decode: `ffmpeg`, not `soundfile`.** librosa's own loader cannot read the owner's MOV/AAC
sources (libsndfile has no AAC; the `audioread` fallback is gone in librosa ≥0.10). ffmpeg is
already a hard dependency of this app (`chroma::video`, `filmstrip.rs`, `export.rs`). The route
shells `ffmpeg -i <path> -ss X -t Y -ac 1 -ar 22050 -f f32le -` into a numpy array. This also
means the route takes a **path**, exactly like `/track` and `/depth_track`, instead of shipping
tens of MB of base64 PCM across localhost.

**Two specific integration details that are easy to get wrong:**

1. **Do not take the `_GPU` lock.** This is CPU DSP. Holding `_GPU` would serialise beat detection
   behind a running depth track for no reason, and vice versa. Every existing heavy endpoint takes
   it because every existing heavy endpoint is a torch model; this one is the first that is not.
2. **No `_MODEL_REGISTRY` entry.** There is no model to unload, so nothing to TTL-sweep. `/memory`'s
   report stays accurate without a change.

### The route

```
POST /detect_beats
  { path: str, from_secs: float = 0.0, to_secs: float = -1.0,
    density: "fewer" | "beats" | "all" = "beats" }
->{ beats_secs: [float], tempo_bpm: float | null, pulse_steadiness: float,
    density: str, analyzed: [float, float], sr: int, elapsed_ms: int }
  | { error: str }
```

**`density` is a three-value enum, not a float**, mirroring Premiere's own
"Fewer / More / All markers" exactly rather than inventing a continuous dial that pretends to a
precision the tracker does not have:

- `beats` (default) — `librosa.beat.beat_track` on the onset-strength envelope.
- `fewer` — every second tracked beat. **This is decimation, not downbeat detection**, and both the
  docstring and the MCP tool text must say so — D-139's downbeat finding is the reason.
- `all` — beats ∪ `librosa.onset.onset_detect`, deduped within one output frame.

**`pulse_steadiness` — a defined number, not a confidence score.** librosa hands back no
confidence, and inventing one would be exactly the "vibes" this repo's MCP design rule 0 forbids.
So: `1 - clamp(stdev(inter-beat intervals) / mean(inter-beat intervals), 0, 1)`. A steady 4/4 bed
reads ~0.9+; a rubato ambient swell reads low. It measures **how regular the detected pulse is**,
which is a real, checkable property — it is *not* a probability the beats are correct, and every
docstring and tool description must state that distinction rather than let a caller assume it.
`< ~0.5` is the honest "this track may not have a usable pulse; look before trusting these" signal.

### The Rust side: a new `chroma::pacing` module

`app/src-tauri/src/chroma/pacing.rs`, following `depth.rs`'s shape (async reqwest to
`sidecar_base_url()`, shared `unreachable_hint`, `chroma/mod.rs` +1 `pub mod`, `lib.rs`
+`generate_handler!` lines, divergence logged in `docs/09-engine-notes.md` per D-003).

```rust
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BeatAnalysis {
    /// Beat positions in SOURCE seconds, ascending. Source seconds — not
    /// timeline frames — because this is cached against the source file and
    /// must survive the clip being retrimmed, moved or duplicated.
    pub beats_secs: Vec<f64>,
    pub tempo_bpm: Option<f64>,
    /// Inter-beat-interval regularity, 0..1. NOT an accuracy estimate.
    pub pulse_steadiness: f64,
    pub density: String,
    pub analyzed_range: (f64, f64),
    pub source_duration_secs: f64,
}

#[tauri::command]
pub async fn chroma_detect_beats(
    source_path: String, from_secs: Option<f64>, to_secs: Option<f64>,
    density: Option<String>,
) -> Result<BeatAnalysis, String>;
```

Read-through cached (memory → `media_cache` "beats" → sidecar), and — like
`chroma_audio_waveform` — it logs on a real analysis and stays silent on a cache hit, so "slow"
and "not running at all" can never look identical from outside (D-124's own lesson, restated in
`media-cache.md` §1).

**Blocking-async, not a polling job — with a stated trigger to change that.** `/track` and
`/depth_track` are job-shaped because they are minutes. D-139's informed expectation for a
5-minute track is low single-digit seconds, and it is explicit that this is an expectation from
the algorithm's shape, not a benchmark. So: **Phase 0 measures it.** If a 10-minute source exceeds
~5s wall-clock, promote to the `_jobs` + `chroma_detect_beats_status` shape before building the
UI on top. That is a decision with a real trigger, not a guess left to be discovered by a user.

---

## 5. Frontend

### Pure logic first: `packages/editor/src/beats.ts` (+ `beats.test.ts`)

This package's entire test surface is pure functions in `.ts` files with the JSX kept thin
(`timeline.ts`, `ruler.ts`, `marquee.ts`, `filmstrip.ts`). Same here:

```ts
/** Source-space beat seconds -> this clip's timeline frames, clipped to its trim window. */
export function beatFramesForClip(clip: Clip, beatsSecs: number[], fps: number): number[];

/** Union of every armed clip's beat frames, deduped and sorted — the snap-target set. */
export function beatFrames(tracks: Track[], armed: Set<string>, analyses: Map<string, number[]>, fps: number): number[];

/** Nearest beat within `snapFrames`, or null. Ties resolve to the earlier beat (deterministic). */
export function snapToBeat(frame: number, beats: number[], snapFrames: number): number | null;
```

Real edge cases these tests must pin, all of which the trim mapping makes reachable: a beat before
`source_start`, a beat past the out-point, `source_start > 0` (an L-cut audio half), two clips cut
from the same source at different offsets (their beat sets must land at different timeline frames,
which is the whole reason the cache is keyed in source space), fps that is not an integer.

### Rendering

Full-height guide lines across the edit area, plus per-clip ticks on the armed clip's own lane.
The precedent to follow is D-137's marquee overlay: **hold the positions in timeline units and
convert at render time**, so a ctrl-wheel zoom keeps the guides attached to their content instead
of stranding them at stale pixels (D-137 §14 verified exactly this for the marquee band).

Arming a clip: a "Detect beats" action in `ClipInspectorPanel` for a clip whose source has audio
(`VideoInfo::has_audio` already exists and `Waveform.tsx` already relies on it), plus a toolbar
`Beats` toggle for global show/hide.

### Snapping — and the honest limit

Beat frames join the existing snap-target set in the two functions Apelles owns:
`computeInsertion` and `resolveClipLanding` gain an optional `beatFrames: number[]` argument,
merged into the same "nearest target within `snapFrames`" scan that already handles clip edges and
0. One scan, one tie-break rule, no second snapping system — and the existing tests keep passing
unchanged because the argument defaults to empty.

Playhead: a `snapToBeat` pass on the ruler-drag / seek path.

**What Phase 1 cannot do: edge-trim snapping.** Edge-trim is interact.js inside
`@xzdarcy/react-timeline-editor`, driven by `dragLine?: boolean` — verified above, there is no
custom snap-target API. Trimming a clip's edge will not snap to a beat. The three ways out are all
real work of their own: fork/patch the library, replace it (already a live question since D-051),
or draw a beat guide the user aims at manually. **Phase 1 ships without it and says so in the UI's
own terms**, rather than promising snapping that silently does not apply to the one gesture an
editor uses most when cutting to music. This is the single biggest known gap in the plan.

---

## 6. The MCP surface — designed, not appended

D-139 called beat detection "the cleanest, most obviously agent-scriptable capability in this
whole research pass," and the owner's directive is that MCP is not an afterthought. Two things
follow.

### 6a. A prerequisite this feature cannot dodge

`detect_beats(clip_id)` is unusable if an agent has no way to learn a clip id. `mcp-tool-coverage.md`
records a verified **zero** Edit-tab tools. So Phase 1 ships a minimal read op alongside the
feature:

| Tool | Params | Returns |
|---|---|---|
| `get_timeline` | — | `{ id, name, fps, durationFrames, tracks: [{ index, kind, gain, locked, hidden, clips: [{ id, name, sourcePath, startFrame, duration, sourceStart, sourceLen, linkGroup }] }] }` |

Read-only, cheap, side-effect-free (design rule 3), a straight shaping of the existing
`chroma_timeline_get` through the control-server bridge. It is scoped to *this* need — it is not
an attempt to close the whole Edit-tab MCP gap, which is its own tracked item.

### 6b. The tools

**Phase 1**

| Tool | Params | Returns |
|---|---|---|
| `detect_beats` | `clip_id` **or** `source_path`; `density?` (`"beats"` default), `from_secs?`, `to_secs?` | `{ beats_frames: [int], beats_secs: [float], tempo_bpm: float\|null, pulse_steadiness: float, density, analyzed_range, cached: bool, elapsed_ms }` |

- **Both frames and seconds.** `beats_secs` is the cache-level truth (source space, survives
  retrimming); `beats_frames` is the timeline space every edit op speaks, computed through the same
  `beatFramesForClip` mapping the UI uses, so the agent and the GUI can never disagree about where
  a beat is. Only returned when addressed by `clip_id` — a bare `source_path` has no timeline
  position to map into, and returning a fabricated one would be worse than omitting it.
- **Tool text carries the discipline.** Mirroring `inspect_color`'s "grade by the numbers": state
  that `pulse_steadiness` is inter-beat-interval regularity and *not* an accuracy estimate; that
  below ~0.5 the caller should render a still or hand back to the human before acting on the
  positions; and that `density: "fewer"` is decimation, **not** downbeat detection, so nothing may
  be built on "this is beat 1 of the bar."
- `cached: true` makes a re-call free and visibly so.

**Phase 2**

| Tool | Params | Returns |
|---|---|---|
| `inspect_pacing` | `from_frame?`, `to_frame?`, `track?` | `{ range, cuts: { count, per_minute, shot_lengths_secs, mean, median, stdev }, loudness: { window_secs, rms_db: [float], peak_db: [float] }, motion: { window_secs, intensity: [float] } \| null, beats: { tempo_bpm, pulse_steadiness } \| null }` |
| `snap_clip_to_beat` | `track`, `clip_id`, `beat_frame` **or** `beat_index`, `edge?` (`"start"`\|`"end"`) | `{ moved: { from, to, deltaFrames }, timeline }` |

- **`inspect_pacing` computes cut frequency from the timeline model, not from scene detection.**
  This is the plan's other significant departure from the research doc's framing, and it is a
  simplification, not a compromise: D-139 reached for PySceneDetect because it was thinking about
  analysing a finished video file. Apelles *owns the edit* — every cut is a `Clip` boundary in
  `apelles-timeline`. Shot lengths, cuts-per-minute and their variance are arithmetic over
  `Track.clips`, exact by construction, instant, and needing no new dependency at all.
  PySceneDetect only becomes relevant for an *imported, already-cut* video, which is not a v1
  scenario. **Loudness** likewise reuses the `waveform` cache that already exists (`chroma::audio`,
  128 peaks/sec on disk) — an RMS/peak-dB envelope is a reduction over data the app has already
  computed. **Motion intensity** is the only genuinely new compute, and it is the one signal that
  may be dropped if it does not earn its keep; `motion: null` is a valid return.
- **`snap_clip_to_beat` is deliberately the single-clip primitive, not `auto_edit_to_beat`** —
  D-139's own recommendation, and the same "agent nudges toward a target" posture
  `match_to_reference` established.

### 6c. Which code path a mutating Edit-tab tool takes — answering an open question

`mcp-tool-coverage.md` explicitly left this open: does an Edit-tab MCP tool call the dedicated Rust
commands (`chroma_timeline_move_clip`) or replicate the GUI's `applyOp` + `chroma_timeline_set`?

**Answer: replicate the GUI path — call `timelineStore.applyOp` through the bridge.** The reason is
concrete, not stylistic. `timelineStore.applyOp` pushes a before/after snapshot pair onto the shared
`@apelles/history` undo stack (D-051); `chroma_timeline_move_clip` does not. Going direct to the Rust
command would produce an agent edit the user cannot undo — a straight violation of MCP design rule 7
("one shared state… the UI and the agent never diverge") and of the vision doc's "each pass
reviewable and undoable, not a black box." The bridge is mounted app-level and `app` already depends
on `@apelles/editor`, so this needs no new plumbing. Recorded here so the next Edit-tab tool does not
re-litigate it.

---

## 7. Phasing

### Phase 0 — the benchmark D-139 named, before any UI (half a day)

D-139's own "what I could not find" list leads with: no hard wall-clock number for librosa on a
real 5-minute track. Measure it here, on this machine, and measure the thing that actually matters
more:

1. Wall-clock `beat_track` on a 5-min and a 10-min source, cold and warm (numba JIT).
2. **Run it on the owner's own music beds** — `score-02-explainer-bed.wav`,
   `score-03-build-payoff.wav`, `hook-A-braaam-drive.wav` — and on a conventional 4/4 BGM track for
   contrast. Record `pulse_steadiness` and eyeball the beat grid against the audio.
3. Install-size delta for librosa's dependency tree.

**Gates.** >5s on a 10-min source ⇒ job-shaped command (§4). If `pulse_steadiness` on the owner's
real beds is uniformly low and the grids are visibly wrong, **the feature's premise is wrong for
this user's content** and Phase 1 should be re-scoped or dropped before anything is built — see §8.

### Phase 1 — the smallest real, complete slice

- `ai/server.py`: `/detect_beats` + librosa in `requirements.txt` (a `D-NNN` for the dependency,
  per `CLAUDE.md`: what it's for, alternatives, licence, maintenance).
- `chroma::pacing`: `chroma_detect_beats`, `media_cache` `"beats"` namespace, memory tier.
- `packages/editor/src/beats.ts` + tests; guide rendering in `TimelinePane.tsx`; "Detect beats" in
  `ClipInspectorPanel`; a `Beats` toolbar toggle.
- Snap-to-beat merged into `computeInsertion` / `resolveClipLanding` / the playhead.
- MCP: `get_timeline`, `detect_beats` (+ their control-server ops), `mcp-tool-coverage.md` updated.

That is a feature a person can use end to end and an agent can drive end to end. Nothing in it is
a stub.

### Phase 2 — the read-only pacing inspector

`chroma_inspect_pacing` (timeline-derived cuts, waveform-derived loudness, optional motion
intensity), the `inspect_pacing` MCP tool, `snap_clip_to_beat`, and a small Inspector readout so
the numbers are visible to the human too, not agent-only.

### Phase 3 — only if asked

A real `Timeline::markers` model (named/manual markers, beats committable into it), persisted
per-clip beat arming, and edge-trim snapping — which is blocked behind the timeline-library
question (§5) and should be decided as part of that, not bolted on.

### Never, on current evidence

Auto-cut-to-beat; downbeat/meter; emotional-arc understanding. §2 has the reasons.

---

## 8. Risks and unknowns this plan cannot resolve without building

1. **The owner's own music is the worst case for the chosen tracker — and this is the biggest
   risk in the plan.** D-139's 60–80% F-measure for classical DP trackers is on *mixed-genre
   benchmarks*, strong on pop/EDM/hip-hop and explicitly "noticeably weaker on rubato, freeform, or
   highly syncopated material." The owner's real beds are CassetteAI-generated cinematic tension
   scores — braaams, swells, a build-and-payoff arc. That is closer to the weak-pulse end than to
   the benchmark's strong-pulse end. The general accuracy numbers may simply not transfer to this
   user's content. Only Phase 0, on those exact files, answers it.
2. **No throughput benchmark exists.** D-139 searched and found none; §4's blocking-vs-job choice
   rests on an expectation from the algorithm's shape. Phase 0's gate exists because of this.
3. **librosa's dependency weight and numba warm-up.** A real install-size increase and a real
   first-call latency the sidecar's other routes do not have. Mitigable (import-time warm-up) but
   unmeasured.
4. **This couples the Edit tab to sidecar health for the first time.** Today the Edit tab needs no
   sidecar at all. The mitigation is that beats are purely additive — sidecar down means the
   "Detect beats" action reports `unreachable_hint` and everything else works exactly as before —
   but the coupling is new, and the sidecar has a real history here (D-069 stale process, D-084
   memory, D-101 staleness detection all exist because of it).
5. **Edge-trim snapping is genuinely blocked** by `dragLine?: boolean`. Verified, not assumed. The
   ways out are all larger than this feature.
6. **`inspect_pacing`'s cut metric says nothing about unedited footage.** Computing it from the
   timeline is correct and cheap, but the owner's source is one continuous take — cut frequency is
   meaningful only once an edit exists. That is the right behaviour and it is also a real limit on
   how useful the signal is on day one.
7. **`pulse_steadiness` is a defined proxy, not ground truth.** It can be high on a confidently
   *wrong* grid (a tracker locked at double- or half-time is perfectly regular). It must never be
   presented to an agent as an accuracy estimate, which is why §4 and §6b both insist on the
   wording.
8. **Unverified in the assembled app.** Same disclosed constraint every entry since D-125 carries:
   this environment cannot launch the Tauri window, so any UI claim here is a design intent, not a
   demonstration.

---

## 9. Open questions for the owner

1. **Phase 0 first?** This plan says measure before building, on your own music. Cheap, and it can
   invalidate the premise. Confirm that is the order you want.
2. **Is beat arming per-clip UI state (resets on reopen) acceptable for v1**, or does it need to
   persist — which means a real model field and a migration?
3. **Motion intensity in Phase 2** — worth the only genuinely new compute in the pacing inspector,
   or drop it and ship cuts + loudness (both nearly free)?
4. **Edge-trim snapping** matters enough to reopen the timeline-library question, or is aiming at a
   visible guide good enough?
