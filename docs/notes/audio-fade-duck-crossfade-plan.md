# Practical sound control — fades, crossfade, ducking (scoping + Phase 1 build, 2026-09-05)

**Where this came from.** The owner asked for "sound engineer"-style control over audio in
Chroma, and clarified the ask himself: *not* AI emotional understanding — D-139's research pass
already found that is not real, and D-140's plan explicitly scopes it out — but **real, practical
control, "enough for transitions etc."** Then, concretely: *build the fade in and fade out with
bezier curve support.*

So this document does two things, and keeps them clearly apart. §1–§4 are a scoping pass over the
whole "practical sound control" surface: fades, crossfade, ducking, and the MCP shape for each.
§5–§8 are the design that was actually **built** in this same pass (D-147) — Phase 1, fades with
real cubic-bezier curves. Everything else here is scoped and deliberately not built, with the
reason named each time.

Same split, and the same rigour bar, as `docs/notes/pacing-audio-assistance-plan.md` (D-140).

---

## 1. What exists today, verified by reading the code

Every claim below was confirmed by reading the real files this pass, not assumed.

**Audio has exactly one level control, and it is a static scalar.** `chroma_timeline::Track::gain`
(D-057) — one `f32` per track, `1.0` unity. `chroma::audio::chroma_audio_play` resolves it once,
at the moment Play is pressed, into an `AudioSourceSpec { path, start_secs, duration_secs, gain }`
per active source. `run_session` then hands `mix_chunk` a `gains: &[f32]` that never changes for
the life of the session. `mix_sources(buffers, gains, len)` multiplies each source's buffer by its
scalar and sums. **There is no time-varying gain anywhere in the audio path.** That single fact is
the shape of everything below: fades need it, ducking needs it, and neither can be expressed by
`Track::gain`.

There is a second, unrelated level: `MASTER_VOLUME_BITS` (D-126), a lock-free `AtomicU32` read
inside the live `cpal` callback. Its own doc is explicit that it is monitoring volume, not project
data. It is not a candidate for any of this.

**`Clip` had no fade fields at all.** Confirmed by reading `crates/chroma-timeline/src/lib.rs`'s
`Clip` struct in full before this pass: `id`, `shot_id`, `media_id`, `link_group`, `name`,
`source_path`, `source_start`, `duration`, `source_len`, `start_frame`, the D-082 transform
(`opacity`, `position_*`, `scale`, `rotation`), the D-132 crop insets, `chroma_keyframes`. Nothing
else. (A roadmap note once claimed otherwise and has been corrected in place.)

**There is no easing or curve math in this repo.** `grep -riE 'bezier|easing|ease-in|smoothstep'`
across `crates/`, `app/src-tauri/`, `packages/editor/`, `packages/inspector/`, `packages/ui/`
returns nothing. `chroma::keyframes` (D-034) — the one interpolation engine, shared by mask
geometry, relight lights and clip transforms — is **purely linear**, with two documented special
cases that are not easing: `rotation`'s shortest-arc, and a nearest-key *snap* for anything that
isn't a finite number or a same-shape array/object. So a bezier evaluator is genuinely new math
here, not an extension of something that already existed. (§5 says what was built and why it did
not go into `chroma::keyframes`.)

**Clips cannot overlap. At all.** `Timeline::move_clip`'s own doc comment states it plainly, and
the code matches:

```rust
// D-104 — overlap is rejected for EVERY move now, same-track or
// cross-track alike ... This reverses D-096's "cross-track overlap allowed"
let overlaps = dest.clips.iter().enumerate().any(|(i, c)| {
    if from_track == to_track && i == from_idx { return false; }
    to_start_frame < c.end_frame() && new_end > c.start_frame
});
if overlaps && (!ripple || straddles || sync_straddles) {
    return Err(TimelineError::Overlap(to_track, to_start_frame));
}
```

`ripple: true` is not an exception — it *makes room* by shifting later clips, it does not permit
the overlap. `trim_start`/`trim_end` enforce the same invariant against their neighbours. D-096
originally *did* allow cross-track overlap, on the correct reasoning that
`resolve_visible_video_layers_at` composites every visible track together; D-104 reversed it after
live testing, for a UX reason ("landing directly on top of another clip should never be a
reachable outcome of a plain move"), not a correctness one. **That distinction is load-bearing for
§3.**

**The render and mix paths, by contrast, are already N-source.**
`Timeline::resolve_visible_video_layers_at` returns *every* visible video track's clip at a
position and `composite_video_frame` alpha-blends them; `resolve_audio_track_positions` walks
every audio track and `mix_sources` sums N buffers. Neither has any two-clips-at-once problem.
The blend a crossfade needs already works. Only the model forbids the arrangement that would
feed it.

---

## 2. Fade in / out per clip — Phase 1, built (§5–§8)

The owner's explicit ask, and the only part of this document with code behind it. Design,
implementation and test evidence are in §5–§8.

One scoping point belongs here rather than there, because it is a product decision and not an
implementation one: **what a fade fades.**

Premiere and Resolve do not have a single "fade" concept. Each has one *gesture* — a handle at the
top corner of a clip in the timeline — whose meaning depends on the clip: on a video clip it
drives opacity, on an audio clip it drives volume. They are not two settings the user picks
between; they are one setting whose effect follows what the clip actually contributes.

Chroma's model already carries that structure. A clip on a `TrackKind::Audio` track contributes
only samples. A clip on a `TrackKind::Video` track contributes pixels and — unless D-129 has
externalised its sound into a linked audio clip — its own embedded audio too. So:

> **One `fade_in`/`fade_out` pair per clip. It multiplies into every output that clip produces:
> opacity for picture, gain for sound.**

That is the argued call, not a compromise. The alternative — separate `fade_in_video` /
`fade_in_audio` fields — is four fields, two Inspector sections and a "which one did I set?"
question, to buy a case D-129 already solves better: a user who genuinely wants the picture and
the sound to fade differently unlinks the A/V pair, and then they are two clips with two
independent fades. That is exactly the workflow both reference NLEs push you toward.

The one honest asymmetry, stated rather than hidden: a linear *amplitude* ramp and a linear
*opacity* ramp do not read as equally "even" to a human, because perceived loudness is roughly
logarithmic in amplitude while perceived brightness is not. A perceptually even audio fade-in is
closer to `ease-in` (slow near silence, fast near unity) than to `linear`. The response to that is
**not** to silently apply a different curve to audio — that would make one stored number mean two
different things, the exact hidden divergence this repo refuses. It is to make the curve a real,
visible, per-clip choice (which is what "bezier curve support" gets you) and to say this in the
MCP tool text and the field docs, so the caller picks with the property stated rather than
guessing.

---

## 3. Crossfade — the honest ceiling, and the one real path through it

### 3a. The scoped-down "no-overlap crossfade" does not work. This is arithmetic, not taste.

The tempting cheap version: no overlap, just a fade-out on the outgoing clip's tail and a fade-in
on the incoming clip's head, timed to meet at the cut. Worth reasoning through properly, because
it *sounds* like it should be close enough.

It is not. Clip A occupies `[.., F)` and clip B occupies `[F, ..)`. At frame `F-1`, B does not
exist, so the output is A alone, at the end of its fade-out — near zero. At frame `F`, A no longer
exists, so the output is B alone, at the start of its fade-in — near zero. There is no frame at
which both contribute, so there is no frame at which anything is blended.

What that produces is a **dip to black / dip to silence**: full A → hole → full B. It is a real
transition and Premiere ships it under exactly that name, but it is not a crossfade and it does
not look or sound like one. On audio the hole is plainly audible; on video it is a black flash.

No choice of curve rescues it. To avoid the hole you would need the two clips' gains to sum to
roughly unity *at the same instant*, and there is no such instant. Complementary curves change the
hole's shape, not its existence. **A true crossfade requires the two time ranges to actually
overlap.** That is a property of the timeline model, and no amount of curve design substitutes for
it.

### 3b. What is actually blocked, and how much

The blocker is precisely one invariant — D-104's unconditional overlap rejection — and *not* the
renderer or the mixer, both of which already handle N simultaneous sources (§1). That is worth
stating clearly because it makes the remaining work much smaller than it first looks, and it also
makes it much easier to get wrong by underestimating it.

Relaxing the invariant **same-track** is the big version and is not on the table tonight. It
touches `move_clip`, `trim_start`, `trim_end`, the frontend's `applyOp` mirror of all three,
`computeInsertion`/`resolveClipLanding`, and — the one that actually decides it —
`Track::clip_at`, which is a `.find()`: it returns the *first* clip covering a frame. Under
same-track overlap that silently drops the second clip everywhere in the app, including in the
audio resolver and the Colorist's active-clip lookup. Making that correct means changing what
"the clip at this frame" means across the whole codebase, plus `@xzdarcy/react-timeline-editor`'s
per-row layout, which has no notion of two actions occupying one span. That is a model change with
its own `D-NNN`, not a feature.

### 3c. The real path, named as a proposal and not built

**Cross-track overlap is a much smaller change, and it yields a genuine crossfade.** A on V1 and B
on V2, overlapping by N frames, A fading out over its last N and B fading in over its first N:
`resolve_visible_video_layers_at` returns both, `composite_video_frame` alpha-blends them, and the
picture really does dissolve. Same on the audio side across two audio tracks. `Track::clip_at` is
untouched — there is still only ever one clip per track at any frame, so the `.find()` stays
correct by construction.

This is not a new idea; it is **D-096's original policy**, which D-104 reversed for a UX reason
(see §1). That reason survives intact here: a *plain move* landing on top of another clip should
still be rejected. What is being proposed is a separate, explicit op — `create_crossfade(clip_a,
clip_b, frames)` — that deliberately overlaps two clips on adjacent tracks and writes the two
complementary fades in one action. The user never "accidentally overlaps"; they ask for a
crossfade and get one.

**Deliberately not built tonight**, for two reasons that are about honesty rather than effort:
it needs the owner's call on reversing a UX decision he made live (D-104), and the fades it
composes have to exist and be trusted first. §7's `set_clip_fade` is exactly the primitive it
would be built from.

**The complementary-curve detail this will hit, recorded now so it is not rediscovered as a bug.**
Two `linear` fades crossing produce a **−3 dB dip** at the midpoint on audio, because two
uncorrelated sources at amplitude 0.5 sum to ≈0.707, not 1.0. That is why every real NLE offers
"Constant Power" as a *separate* audio crossfade from "Constant Gain." Constant power is
`sin(πt/2)` / `cos(πt/2)`, which is **not** exactly representable as a cubic bezier — the closest
fit is roughly `cubic-bezier(0.4, 0.0, 0.6, 1.0)` on each side and it is a fit, not an identity.
So a real crossfade feature needs either an accepted small approximation, stated as such, or a
second curve *kind* alongside bezier. That is a real design question for that pass, and pretending
the bezier model already answers it would be wrong.

---

## 4. Ducking — buildable, and it reuses Phase 1's primitive

### 4a. It cannot ride `Track::gain`, and the reason is the same one fades hit

Ducking is "lower the music while the dialogue is speaking." That is a gain that changes *during*
a session, driven by another track's content. `Track::gain` is a static scalar resolved once at
`chroma_audio_play` and never re-read; `mix_sources` takes `&[f32]`. There is no seam in D-057's
mechanism where a duck could be applied without inventing time-varying gain.

**Which is exactly what Phase 1 builds.** The fade envelope in §6 is deliberately shaped as *"give
me a gain multiplier at output-sample-frame position N"*, applied per sample-frame in `mix_chunk`
before `mix_sources` — not as fade-specific arithmetic inlined into the mixer. A duck envelope is
the same interface with a different function behind it, multiplied into the same place. **So yes:
ducking reuses Phase 1's primitive directly, and this is the concrete reason it was built that way
rather than as the two-line special case a fade alone would have needed.**

### 4b. The real shape, if it is built

**Trigger detection — the model, not the signal, for v1.** The cheapest correct trigger is a pure
timeline-model query: *is there a clip on the nominated dialogue track covering this frame?* It is
exact, deterministic, free, needs no decode and no analysis, and it is what an editor means when
they point at a track and say "duck under this." Real sidechain detection (actual RMS of the
dialogue, so a pause mid-sentence lets the music back up) is the Phase 2 refinement, and it should
reuse the `waveform` peaks already cached in `media_cache` (D-140 §6b reached the same conclusion
for loudness in `inspect_pacing`) rather than decoding again.

**Attack/release smoothing is not optional.** A raw presence signal is a step function; applied
directly it is an audible click at every clip boundary. The standard fix is a one-pole smoother
over the presence signal with separate attack and release coefficients — fast attack (~10 ms, so
the duck is already down when the first word lands) and slow release (~300–500 ms, so the music
does not pump between words). Those two numbers are the whole feel of a ducker and they belong in
the MCP surface as real numbers, not as a "strength" dial.

**Where it would live.** A `Track`-level field pair, because ducking is a relationship between
tracks, not a property of a clip: `duck_from: Option<usize>` (which track triggers) plus
`duck_db`, `duck_attack_ms`, `duck_release_ms`. `#[serde(default)]` throughout — absent means no
ducking, and every existing project keeps mixing byte-identically, the same migration discipline
`crop_left` and the new fade fields use.

**One thing that does *not* block it**, checked rather than assumed: roadmap item 1's known gap
("a source's set is fixed at the moment `chroma_audio_play` is called") is not in the way. A duck
envelope is a deterministic function of the timeline over the session's range, so it can be
computed up front at play time exactly like the fade envelopes are, and needs no mid-session
re-resolution.

**Not built tonight.** It is a real, separate feature with its own model fields, its own UI
(a track-header control, not a clip Inspector one) and its own `D-NNN`. What Phase 1 owed it was
a primitive it can stand on without a rewrite, and that is what it got.

---

## 5. The curve model — what was built

### 5a. Cubic bezier, in the CSS/After Effects sense

The owner asked for bezier curve support specifically, and explicitly not a fixed set of easing
presets. So the stored thing is a **curve**, and the presets are named points on it.

The model is the one CSS `cubic-bezier(x1,y1,x2,y2)` and After Effects keyframe easing both use: a
cubic bezier with `P0 = (0,0)` and `P3 = (1,1)` fixed, and two free control points `P1 = (x1,y1)`,
`P2 = (x2,y2)`. `x` is normalised progress through the fade window, `y` is the multiplier. It was
chosen over inventing something because it is the model every tool a user might come from already
speaks, it is four numbers, and it is exactly what a future draggable-handle editor manipulates.

### 5b. Why this is not an extension of `chroma::keyframes`

The instruction was to reuse existing curve math if any existed. None does (§1) — D-034's engine
is strictly linear. The remaining question was whether to *put* the new math there.

No, and for a concrete reason rather than a stylistic one. `chroma::keyframes` interpolates
**between two authored keys** in an untyped `serde_json::Map`, and it lives in `app/src-tauri`. A
fade curve interpolates **within one clip's own fade window**, has no keys, and is read by two
consumers that both need it (`chroma::edit`'s compositor and `chroma::audio`'s mixer). CLAUDE.md's
rule is explicit — *"if two places need it, extract it"* — and `Clip::end_frame()` is the standing
precedent for arithmetic that lives on the model because two `app/src-tauri` consumers were
otherwise going to re-spell it.

So: **`crates/chroma-types/src/fade.rs`**. Pure math, no I/O, no dependencies beyond `serde`.
Easing the D-034 engine itself is a separate and much larger question (it would change how every
existing mask and relight keyframe interpolates) and is untouched.

> **Where this landed, vs. where this plan first put it.** This section was written against the
> pre-D-146 tree, where both consumers were `app/src-tauri` modules and the crate that owns `Clip`
> was the natural shared home. D-146 then moved the mixer out into **`chroma-media`, which is L1 —
> *below* `chroma-timeline` (L2)** — so the two consumers no longer sit on one layer, and D-039's
> one-way dependency graph forbids the mixer reaching up for the solver. The module therefore lives
> in **L0 `chroma-types`**, which both consumers can see, and `chroma-timeline` re-exports
> `FadeCurve`/`fade_gain` so every path this plan names still resolves. `Clip`'s fade *fields* and
> `Clip::fade_multiplier_at` stay on the model, unchanged. Full argument in D-147's reconciliation
> section.

### 5c. The evaluator: Newton–Raphson with a bisection fallback

The subtlety in this curve model, and the reason it is more than a polynomial evaluation: you are
given `x` (progress through the fade) and need `y`, but the curve is *parametric* — both `x` and
`y` are functions of a hidden parameter `t`. So it is an inverse problem: solve `x(t) = X` for
`t`, then evaluate `y(t)`.

De Casteljau's algorithm, the other obvious candidate, evaluates a bezier at a given `t`. It does
not solve for `t` given `x`, so on its own it does not answer the question being asked. It would
have to be wrapped in a search anyway, at which point the search *is* the algorithm.

What was built is WebKit's `UnitBezier` approach, which is what browsers actually ship for CSS
easing: Newton–Raphson on `x(t) - X` using the analytic derivative, capped at 8 iterations, with a
guarded fall-through to bisection when the derivative is too small to trust or Newton escapes
`[0,1]`. Newton converges in about four iterations on ordinary curves; bisection guarantees
termination and a bounded error for pathological control points — `x1 = x2 = 0` gives a vertical
start tangent where `x'(0) = 0` and Newton alone would divide by ~zero.

**Determinism** (a project invariant, `CLAUDE.md`): pure `f64`, fixed iteration caps, an
epsilon-bounded exit that depends only on the inputs. No wall clock, no RNG, no iteration order
dependence. Same inputs, same bits, always.

**Clamping, at the point of use, matching the existing discipline.** `x1`/`x2` are clamped to
`[0,1]` inside the evaluator because a control point outside that range makes `x(t)`
non-monotonic, and then the inverse is not unique and the solve is meaningless. `y1`/`y2` are
**not** clamped in storage — CSS allows overshoot, and a future "bounce" curve is a legitimate
thing to want — but the final multiplier is clamped to `[0,1]` where it is consumed, exactly as
`composite_layer_onto` already clamps `opacity` and `crop_pixel_rect` clamps its insets. The model
stores what the UI wrote; the consumer decides what it means. That is `Clip::crop_left`'s own
stated rule, followed rather than re-litigated.

### 5d. The presets are real control points, not labels

| Preset | Control points | Note |
|---|---|---|
| `linear` | `(0.333333, 0.333333, 0.666667, 0.666667)` | the exact identity — see below |
| `ease-in` | `(0.42, 0.0, 1.0, 1.0)` | CSS `ease-in` |
| `ease-out` | `(0.0, 0.0, 0.58, 1.0)` | CSS `ease-out` |
| `ease-in-out` | `(0.42, 0.0, 0.58, 1.0)` | CSS `ease-in-out` |

**`linear` is `(1/3, 1/3, 2/3, 2/3)` rather than CSS's own `(0, 0, 1, 1)`, and the reason is
numeric, not geometric.** Worth recording precisely, because the plausible-sounding version of
this claim is wrong and the unit test caught it: *any* control points on the `y = x` diagonal give
the straight line, so `(0,0,1,1)` and `(1/3,1/3,2/3,2/3)` trace **the same curve** — they differ
only in how `t` is distributed along it. What `1/3, 2/3` buys is the *uniform* parameterisation:
with `P0=0, P3=1` the cubic is `B(t) = 3(1-t)²t·P1 + 3(1-t)t²·P2 + t³`, which for `P1=1/3, P2=2/3`
collapses to exactly `B(t) = t`. So `x(t) = t`, the solver's initial guess `t = x` is already the
exact root, and the default curve — evaluated per output sample-frame for every un-set fade in the
app — costs one residual check and exits. CSS's `(0,0,1,1)` has `x'(0) = 0`, a degenerate tangent
that puts the solver on its bisection path near the start of every fade. Same line, cheaper and
better-conditioned. A unit test asserts both are the identity, so the wrong intuition cannot be
re-derived into the constant later.

`linear` is the default: an unset curve should mean the least surprising thing, and a straight
ramp is the only shape a user can predict without opening a curve editor.

**No preset name is stored.** The four control points are the only truth; the UI matches a stored
curve back to a preset name for display. Storing a name *and* points would be two sources of truth
that can disagree the moment a custom curve is dragged.

---

## 6. Where the fade is evaluated

### 6a. Video — the compositor

`chroma::edit::resolve_clip_transform(clip, source_frame)` already resolves the static-or-
keyframed transform for one frame. The fade multiplies into `opacity` there, *after* keyframe
resolution, so a keyframed opacity animation and the clip's fade compose multiplicatively — which
is what a real NLE does (clip opacity keyframes × the fade handle), and is the only composition
order under which neither silently overrides the other.

Position within the clip comes free and exactly: `frames_into_clip = source_frame -
clip.source_start`, straight out of `Track::clip_at`'s own definition
(`source_start + (timeline_frame - start_frame)`). No signature change, no new plumbing.

`ClipTransform::is_identity()` needed no change either, and that is worth checking rather than
assuming: it tests `opacity >= 1.0`, and the fade has already been folded into `opacity` by the
time it is called — so a faded clip correctly fails the fast path and goes through the compositor,
which is exactly the D-132/B-053 lesson about a lone clip's transform being silently discarded.

### 6b. Audio — the mixer, per sample-frame

This is the larger half. `AudioSourceSpec` gains an `Option<FadeEnvelope>`; `mix_chunk` applies it
to each source's buffer *before* `mix_sources`, so **`mix_sources` itself is completely
untouched** — every one of D-057's headroom guarantees and its byte-identical single-source
passthrough test stand unchanged.

**Per sample-frame, not per chunk.** A chunk is 1024 frames ≈ 21 ms at 48 kHz; stepping the gain
once per chunk is a staircase, and a staircase on a gain envelope is zipper noise. All channels of
one sample-frame share one gain, as any real mixer does.

The envelope is expressed in **seconds**, not video frames, so it needs no fps at evaluation time
— and seconds rather than sample-frames because it is built before the device is open and its
sample rate is known, matching `AudioSourceSpec`'s own `start_secs`/`duration_secs`. `apply`
converts to sample-frames once per chunk, from the rate it is handed:

```rust
pub struct FadeEnvelope {   // crates/chroma-media/src/audio.rs, beside AudioSourceSpec
    pub offset_secs: f64,   // from the clip's start to this session's first sample
    pub len_secs: f64,      // the clip's full length
    pub fade_in_secs: f64,
    pub fade_out_secs: f64,
    pub in_curve: FadeCurve,
    pub out_curve: FadeCurve,
}
```

The frames→seconds conversion needs a `Clip` and its probed `VideoInfo`, so it stays app-side, in
`chroma::audio::fade_for_clip` — the same layer, and the same reason, that kept
`chroma_audio_play`'s timeline resolution out of the crate in D-146.

`offset_secs` is what makes a mid-clip Play correct: pressing Play in the middle of a clip that is
fading out must start part-way down the ramp, not at the top of it.

The session tracks one `pos_frames` counter, advanced by every `mix_chunk` **and by
`discard_samples`** — D-125's skew compensation discards samples that *should already have
played*, so they consume real timeline time and the envelope has to advance through them or the
fade drifts by the whole warm-up.

Frames → seconds → sample-frames goes through the same `VideoInfo::frame_to_secs` the clip
out-point arithmetic (B-048/D-130) already uses. That inherits the model's existing assumption
that a clip's source fps equals the timeline's; it does not introduce a new one.

---

## 7. The MCP surface

Two tools, and one of them is a prerequisite rather than a feature.

| Tool | Params | Returns |
|---|---|---|
| `get_timeline` | — | `{ id, name, durationFrames, tracks: [{ index, kind, gain, locked, hidden, clips: [{ index, id, name, sourcePath, startFrame, duration, sourceStart, sourceLen, fadeInFrames, fadeOutFrames, fadeInCurve, fadeOutCurve }] }] }` |
| `set_clip_fade` | `track`, `clip`, `fade_in_frames`, `fade_out_frames`, `fade_in_curve?`, `fade_out_curve?` | `{ ok, clip: {…the four fade fields as stored…} }` |

**`get_timeline` is not scope creep.** `mcp-tool-coverage.md` records a verified **zero** Edit-tab
tools, so `set_clip_fade(track, clip, …)` would be unusable — an agent has no way to learn a track
or clip index. It is read-only, cheap and side-effect-free, and it is scoped to exactly this need;
it is not an attempt to close the Edit-tab MCP gap, which stays its own tracked item. D-140 §6a
identified the same prerequisite independently for `detect_beats`, and this is that tool, landing
first because this feature needed it first.

**A curve is passed as either a preset name or four numbers** — `"ease-in"` or
`[0.42, 0, 1, 1]` — and is *always returned* as four numbers plus the matched preset name if there
is one. An agent that reads a curve back and writes it again gets exactly what it read; a name is
a convenience on input and never the stored truth (§5d).

**Tool text carries the discipline**, mirroring `inspect_color`'s "grade by the numbers": fades are
in **frames**, not seconds or percentages, because frames are the unit every other Edit-tab number
is in; the curve is stated as a straight multiplier on amplitude/alpha, with the note from §2 that
a perceptually even *audio* fade is nearer `ease-in` than `linear`, so the caller picks with the
property in front of them; and a fade on a video clip affects picture **and** its embedded sound
together (§2), which an agent grading a shot needs to know before it sets one.

**Which code path it takes.** `applyOp` through `useEditorTimelineStore`, per D-140 §6c's already-
settled answer — not the Rust `chroma_timeline_*` commands. `applyOp` pushes a before/after pair
onto the shared `@chroma/history` stack (D-051); the Rust commands do not. Going direct would
produce an agent edit the user cannot undo, which breaks MCP design rule 7 and the vision doc's
"reviewable and undoable, not a black box." This is the first mutating Edit-tab MCP tool, so it is
the first time that answer is actually exercised rather than written down.

---

## 8. Honest gaps

1. **No custom-curve UI.** The Inspector ships the four §5d presets as a real select. The data
   model, the evaluator, the MCP surface and the wire format all take arbitrary control points
   today — a custom curve set via MCP round-trips correctly through the GUI and renders correctly
   — but there is no draggable-handle widget, so a human cannot author one from the app. That is a
   real, self-contained UI investment (a small SVG curve editor with two handles), deferred with
   the model already shaped for it, not blocked by it.
2. **Not seen in the assembled app.** This sandbox cannot launch the Tauri window — the same
   disclosed constraint every entry since D-125 carries. Every claim here is `cargo test` /
   `vitest` evidence and type-checking, not a demonstration. Specifically unverified by eye: that a
   fade *looks* right in the preview, and that it *sounds* smooth (the per-sample-frame choice in
   §6b is the reasoned defence against zipper noise, not a measurement of its absence).
3. **Fade + `discard_samples` is reasoned, not measured.** §6b advances the envelope through
   D-125's skew compensation on the argument that those samples consume real timeline time. That
   is right by construction, but the skew path only fires on a real device warm-up, which this
   environment has no way to exercise.
4. **Crossfade is genuinely blocked** on a model change (§3), and the constant-power dip (§3c) is
   a real design question the bezier model does not answer on its own.
5. **Ducking is scoped, not built** (§4), and its attack/release numbers are drawn from standard
   practice, not from measurement against the owner's own content.
6. **The mid-session re-resolve gap is untouched.** Roadmap item 1's known limitation — a
   multi-clip timeline goes quiet after the first clip until the next Play/seek — is unchanged by
   this pass. A fade on clip 2 is correct when playback starts inside clip 2 and is not heard at
   all when playback runs into it from clip 1, because clip 2 is not a source in that session at
   all. **That is a pre-existing gap, not one this feature introduces**, but it is the most likely
   way a user first sees a fade "not work."
