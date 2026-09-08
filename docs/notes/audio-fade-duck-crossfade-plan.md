# Practical sound control — fades, crossfade, ducking (scoping + Phase 1 & 2 builds, 2026-09-05)

**Where this came from.** The owner asked for "sound engineer"-style control over audio in
Chroma, and clarified the ask himself: *not* AI emotional understanding — D-139's research pass
already found that is not real, and D-140's plan explicitly scopes it out — but **real, practical
control, "enough for transitions etc."** Then, concretely: *build the fade in and fade out with
bezier curve support.*

So this document does two things, and keeps them clearly apart. §1–§4 are a scoping pass over the
whole "practical sound control" surface: fades, crossfade, ducking, and the MCP shape for each.
§5–§8 are the design that was actually **built** in the same pass (D-147) — Phase 1, fades with
real cubic-bezier curves.

**§4's ducking was then built in a follow-up pass, D-149**, on exactly the primitive §4a said it
would reuse; that section is updated in place below with what actually landed and where the design
changed on contact. Crossfade (§3) remains scoped and deliberately not built, with the reason
named.

**§9 is a third build pass, D-223 (2026-09-08): per-clip `volume` + `pan`** — the level control §1
found missing from the model entirely, now a real pair of `Clip` fields with their own envelope in
the same per-sample-frame pass. It is appended rather than folded into §1–§4 for the same reason
§4c was updated in place: those sections record the design as it was reasoned, this one records
what was built on top of them.

**§11 is a fourth build pass, D-232 (2026-09-08): tape-style audio SCRUBBING +
the viewer's waveform strip** — roadmap item 27. Unlike §9/§10 it is not another
envelope in the existing mixer but a second, *position-driven* playback mode
sharing the same single transport; §11a is the decision that shape rests on.

Same split, and the same rigour bar, as `docs/notes/pacing-audio-assistance-plan.md` (D-140).

---

## 1. What exists today, verified by reading the code

Every claim below was confirmed by reading the real files this pass, not assumed.

> **No longer true as of D-223 (§9), and deliberately left standing** — this
> section is the record of what the code was when this plan was written, and
> the finding below is *why* fades, ducking and now per-clip level all exist.
> Today there are two stored level controls (`Track::gain` and `Clip::volume`)
> plus a `Clip::pan`, and three time-varying envelopes in the mixer. Read §9
> for the current shape.

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

## 4. Ducking — **BUILT (D-149)**, and it did reuse Phase 1's primitive

> **Status: built, 2026-09-05, D-149.** This section was written as a scoping pass and its
> final line said "Not built tonight." That is no longer true and the section is corrected in
> place rather than left to rot. Everything §4a and §4b predicted held on contact — the primitive
> was reused unchanged, the field shape is exactly the one named, and trigger detection stayed a
> model query. **Two things §4b did not anticipate, both recorded in §4c below:** the smoother is
> evaluated in *closed form* rather than as a per-sample recursion (which makes it sample-rate
> independent, a property a recursion cannot have), and the trigger spans have to be **merged**
> across abutting clips or the duck pumps at every cut in a continuous take.

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

### 4c. What actually landed (D-149), and the two places the design moved

**The primitive was reused, not re-invented.** `DuckEnvelope` sits beside `FadeEnvelope` in
`crates/chroma-media/src/audio.rs` with the same `gain_at(session_secs) -> f32` shape, and the two
are applied in **one** per-sample-frame pass (`apply_envelopes`) that multiplies them together,
rather than two passes over the buffer. Multiplication is the only composition under which neither
silently overrides the other — the same argument `resolve_clip_transform` already makes for a fade
against keyframed opacity. `mix_sources` is still completely untouched, so every D-057 headroom
guarantee stands.

**The fields landed exactly as §4b named them**, on `chroma_timeline::Track`: `duck_from:
Option<usize>`, `duck_db`, `duck_attack_ms`, `duck_release_ms`. One migration detail worth
recording because it differs from `gain`'s: `duck_db` takes a **bare** `#[serde(default)]`, and
that is genuinely correct rather than lazy — `f32::default() == 0.0` and **0 dB is unity**. The two
time constants do need named defaults (10 ms / 300 ms), for `gain`'s exact reason: `0.0` there is
instantaneous, which is a step, which is the click the smoother exists to prevent.

**dB, where every other level in this codebase is linear.** Checked rather than assumed: there was
no dB anywhere in the audio path before this — `Track::gain` and `MASTER_VOLUME_BITS` are both
linear multipliers. `duck_db` is dB anyway, because a duck *amount* is the one audio number editors
state in decibels ("duck the bed 12 dB") and it is typed rather than dragged. The conversion is one
function, `db_to_linear`, at the point of use in the mixer — the same "store what the UI speaks,
convert at the consumer" split `crop_pixel_rect` uses for normalised insets.

**Change 1 — the smoother is a closed form, not a per-sample recursion.** §4b said "a one-pole
smoother with separate attack and release coefficients," and a coefficient (`a = 1 − e^(−1/(τ·fs))`)
is a function of the output sample rate. Because the presence input is *piecewise constant* with
finitely many transitions, the recursion has an exact closed form on each piece —
`y(t) = target + (entry − target)·e^(−(t − t₀)/τ)` — so the envelope is precomputed as a short list
of segments (each carrying the value the previous one ended on, which is what makes it continuous)
and evaluated by binary search plus one `exp`. Two things that buys, neither available to a
recursion: the envelope is **identical at 44.1 kHz and 48 kHz**, which is the determinism invariant
this project holds itself to; and `gain_at` is a **pure function**, evaluable out of order and
unaffected by where a chunk boundary falls. A unit test runs the discrete recursion sample by sample
against the closed form to pin that they are the same filter, so "one-pole" is a checked claim
rather than a description.

**Change 2 — abutting trigger clips must merge.** Not anticipated, and it is the difference between
a ducker that works on real footage and one that does not. Two dialogue clips butted end to start
are one continuous stretch of speech; read as two spans they leave a zero-length hole, and the
smoother starts releasing and re-attacking at every cut — an audible pump exactly where an editor
most expects the duck to hold. `Track::clip_spans_from` therefore returns **sorted and merged**
spans, and that merge is load-bearing rather than tidiness. Clips with a *real* gap between them
stay separate, because that gap is real silence and the bed genuinely should come back up.

**One guard §4b did not name:** a track pointing `duck_from` at **itself**. Reachable just by
removing a track above the pair and shifting the indices, and it would attenuate exactly the audio
that triggers it. Ignored at the point of use (`resolve_track_duck`) and rejected outright by the
MCP tool, so an agent is told rather than left with a stored setting that silently does nothing.

**Where the layer split fell**, following D-146/D-147's own line exactly: `chroma-media` owns the
smoother, the dB conversion and the envelope; `app/src-tauri`'s `chroma::audio::duck_for_track`
owns turning a trigger *track* into session-relative *seconds*, because that needs a `Timeline` and
a media crate reaching for one would be reaching up a layer. `chroma-timeline` owns
`clip_spans_from` and nothing else — it never reads the ducking fields, same boundary `gain` keeps.

**Still Phase 2, still not built:** real RMS sidechain detection. The trigger is the clip layout,
not the loudness, so a pause mid-sentence does *not* let the bed back up. That is stated in the MCP
tool text and the track-header UI rather than left for a user to discover.

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
   the model already shaped for it, not blocked by it. **Note the distinct gap that is now
   closed:** the missing *duration* affordance — the on-timeline fade handle every reference NLE
   has, which §7's `set_clip_fade` was always the primitive for ("exactly what a future
   draggable-handle editor manipulates," §5d) — shipped as **D-207**, so a fade's LENGTH is now
   authorable by dragging on the clip. What remains deferred here is only the widget for authoring
   a custom curve SHAPE.
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
5. **Ducking is built (D-149, §4c)** — this line originally read "scoped, not built." What remains
   honest from it: the 10 ms / 300 ms defaults are drawn from standard practice, **not** from
   measurement against the owner's own content, and the duck has not been *heard* (same sandbox
   constraint as gap 2). Its trigger is also still the clip layout rather than the signal, so a
   pause mid-sentence does not let the bed back up — Phase 2, and said out loud in the tool text
   and the UI rather than left to be discovered.
6. **The mid-session re-resolve gap is untouched.** Roadmap item 1's known limitation — a
   multi-clip timeline goes quiet after the first clip until the next Play/seek — is unchanged by
   this pass. A fade on clip 2 is correct when playback starts inside clip 2 and is not heard at
   all when playback runs into it from clip 1, because clip 2 is not a source in that session at
   all. **That is a pre-existing gap, not one this feature introduces**, but it is the most likely
   way a user first sees a fade "not work."

---

## 9. Per-clip level — volume + pan (**BUILT, D-223**, 2026-09-08)

> This document was written as the design for the whole "practical sound
> control" surface, and §1 opened with the finding that shaped everything after
> it: *"Audio has exactly one level control, and it is a static scalar"* —
> `Track::gain`, one number for a whole track. §2's fades and §4's ducking both
> worked around that by inventing time-varying gain. **This section is the
> missing piece of that same sentence**: a level control that belongs to a
> CLIP, so "make this one line quieter" and "put this one clip on the left" stop
> requiring a track of their own.

### 9a. What landed

Two new `chroma_timeline::Clip` fields, both keyframeable, both applying only
to what a clip contributes to the MIX:

| field | unit | default | migration |
|---|---|---|---|
| `volume` | **linear** multiplier, `1.0` unity, floored at 0, no ceiling | `1.0` | `#[serde(default = "default_volume")]` — a bare default would be `0.0`, i.e. every pre-D-223 clip silent |
| `pan` | normalised `-1.0` left … `0.0` centre … `1.0` right | `0.0` | bare `#[serde(default)]` — `0.0` really IS centre, and the law returns exactly `(1,1)` for it |

Linear rather than dB is the same call §4c recorded for `duck_db` in the other
direction, and for the same stated reason: a **fader** is linear (`Track::gain`
was here first and is in series with this one), a duck **amount** is the number
editors say in dB. Two level controls in one chain disagreeing about their unit
is a trap; one number that is typed rather than dragged is not.

### 9b. The pan law, and the one thing it costs

`chroma_types::pan_gains` — constant power (`gl ∝ cos θ`, `gr ∝ sin θ`,
`θ = (pan+1)·π/4`), so a clip does not dip in level as it sweeps off centre.
It lives in **L0**, beside §5b's `fade.rs`, for that section's exact reason: the
mixer that consumes it is L1 `chroma-media` and cannot reach up to L2's `Clip`.

Normalised so the **centre** is unity rather than the extremes: `pan` defaults
to `0.0` on every clip ever authored, so a centre gain of `1/√2` (the textbook
−3 dB-centre form) would have attenuated every existing mix by 3 dB on the day
this shipped. The 3 dB therefore lands at the extremes instead — a hard pan
BOOSTS its destination channel by 3.01 dB. That is the real cost, and it is
stated in the Inspector's own note and the MCP tool text rather than left to be
discovered: for a source already near full scale, lower the clip's `volume`.
`mix_sources`' `tanh` limiter catches it only when ≥2 sources sum (it
deliberately bypasses for a lone source — D-057), so this is not "the limiter
will handle it".

### 9c. Composition — the same multiply, one more stage

```
final = track.gain × clip.volume × fade_envelope × duck_envelope
        then the pan law splits that per channel
```

`LevelEnvelope` joins `FadeEnvelope` (§6b) and `DuckEnvelope` (§4c) in the
**same** per-sample-frame pass — `SourceEnvelopes::apply`, one loop, three
envelopes — not a second pass, for §4c's own stated reason. It is the first of
the three that returns a per-CHANNEL pair, which is why it is its own type
rather than a third `gain_at`.

Three rules `apply` makes explicit, because they are choices and not
consequences:
- channel 0 is left, channel 1 is right, and **only** those two are panned; a
  surround device's further channels get the volume alone (a real surround
  panner is a 2-D position, not this one number);
- a **mono output device** ignores pan entirely — with one channel there is
  nowhere to move to, and applying the left multiplier alone would turn a
  hard-right pan into silence;
- a **mono SOURCE** needs no special case: `adapt_channels` has already
  duplicated it across the output's channels, so panning it makes it
  stereo-positioned mono, which is what an editor means.

### 9d. Keyframes: the machinery that already existed, not a new one

`volume`/`pan` are keyed in the clip's own `chroma_keyframes` array under those
exact names. Nothing about the interpolation is new — `interpolate_param`
(Rust) and `paramValueAt` (TS) have always been generic over the param name,
and D-220 generalised `PropertyRow` over it specifically so this feature could
reuse the row rather than grow a parallel one. The only real addition is
`ClipKeyframeParam = ClipTransformParam | ClipAudioParam`.

The mixer cannot call `interpolate_param` per sample (it runs on its own thread
with no `Timeline`), so `chroma::audio::level_for_clip` converts the clip's keys
ONCE into a clip-local-seconds `LevelCurve::Keys`, which the mixer evaluates
with linear interpolation and flat holds — `interpolate_param`'s own rule for a
numeric param. Its `round6` is not applied (a ≤5e-7 difference in a linear gain,
two orders of magnitude below `f32` audio precision) and its `rotation`
shortest-arc case is unreachable for these two names.

### 9e. Export — the same numbers, and the one filter fork

`timelineExportAudio.ts`'s `buildAudioSourceChain`. A **static** volume folds
into the same single `volume=<n>` node the track gain already used, so a project
using neither feature compiles to byte-identical argv. A real **pan** forks the
chain:

```
aformat=channel_layouts=stereo → channelsplit → volume (per channel) → join
```

**Why not ffmpeg's own `pan` filter**, checked rather than assumed: its
coefficients are parsed once, as numbers — it has no expression evaluation, so
it cannot express a keyframed pan. `stereotools`' `balance_in`/`balance_out` are
static options too. `volume` is the one gain filter in ffmpeg that takes a real
per-frame expression, so the law is written AS an expression
(`√2*cos((clip(p,-1,1)+1)*PI/4)`) — **exact**, like §4c's `exp`-based duck, not
sampled like §5's bezier fade. And the law must be applied to the interpolated
PAN, not interpolated between the two gains: interpolating the gains would cut
the corner off the constant-power arc and dip the level mid-sweep.

### 9f. How it was verified

Per-channel, on real exported files — a whole-file `volumedetect` (every
pre-existing audio test in this repo) literally cannot tell a pan from an
attenuation, so `timelineExport.ffmpeg.test.ts` gained a `channelVolumeStats`
helper (`pan=mono|c0=cN` → `volumedetect`) and seven real-ffmpeg tests:
hard-left measures the right channel at −91 dB and the left +3.0 dB against the
source; a **keyframed** pan measures hard-left in the first half-second and
hard-right in the last; clip volume × track gain measures the full −12.04 dB;
and a centred clip measures both channels equal, which is the migration
property. The pan law's own constant-power invariant (`gl² + gr² == 2`) is
asserted across a 201-point sweep in BOTH implementations, so the two are pinned
to the law rather than to each other's current output.

### 9g. Honest gaps

1. **Not heard.** Same sandbox constraint §8's gap 2 records: this environment
   cannot launch the Tauri window, so the live mixer's half is `cargo test`
   evidence and the export's half is real measured ffmpeg output — neither is a
   demonstration that it *sounds* right.
2. **A panned MONO clip exports 3 dB below what it plays — B-101.** The two
   paths adapt mono→stereo by different laws (`adapt_channels` duplicates at
   unity, libswresample preserves power). Measured, not inferred; filed rather
   than papered over, because the fix belongs to the channel-adaptation layer
   and one of the two options changes the level of every mono source in live
   playback.
3. **No fader/knob UI.** The Inspector rows are numeric fields with the same
   diamond/nav/reset every other property row has — deliberately this repo's own
   established pattern (D-208) rather than Resolve's slider, since every other
   numeric clip property here is a field. A real dB-scaled fader and a pan knob
   are a UI investment on top of a model that is already right for them.
4. **No per-clip EQ yet.** Roadmap 27's EQ item was waiting on exactly these
   fields to hang bands off; it is now unblocked, and untouched.
5. **The mid-session re-resolve gap is unchanged** (§8 gap 6): a level set on
   clip 2 is heard when playback starts inside clip 2, and not at all when
   playback runs into it from clip 1, because clip 2 is not a source in that
   session. Pre-existing, not introduced here, but it is the most likely way a
   user first sees a clip volume "not work".

---

## 10. Per-clip parametric EQ (**BUILT, D-224**, 2026-09-08)

> §9 closed §1's opening finding — that the only level control was a static
> whole-track scalar — by giving a CLIP its own level. This section is the next
> thing in that same chain, and the one §9's own gap 4 named: a clip could be
> made quieter and placed in the stereo field, but nothing could be done about
> its **tone**. No way to take rumble out of dialogue, notch a hum, or cut the
> boxiness out of a room recording without leaving the app.

### 10a. What landed

One new `chroma_timeline::Clip` field, and it is the first per-clip audio
control that is **not** a gain:

| field | shape | default | migration |
|---|---|---|---|
| `eq_bands` | `Vec<EqBand>`, each `{kind, freq_hz, gain_db, q, enabled}` | `[]` (no EQ) | bare `#[serde(default, skip_serializing_if = "Vec::is_empty")]` — empty really IS "no EQ", so unlike `volume` this needs no named default and carries none of its hazard |

**Four bands are AUTHORED, but the model stores a list.** Four is exactly
Resolve's own Clip Equalizer (`scratch/resolve-reference/soundtrack.jpg`, read
as an image: `Band 1`…`Band 4`, each a name button that doubles as that band's
enable, over a shape dropdown, under a ±24 dB response graph), and the strip the
Inspector materialises is Resolve's own reading of it — low shelf 120 Hz, bell
500 Hz, bell 2.5 kHz, high shelf 8 kHz. The stored field is a `Vec` anyway
because every band carries its own `kind`, so a fixed index→role mapping would
be a second source of truth for the same fact; because `Vec::default()` is a
free, correct migration default where a fixed array would be a hard
deserialisation wall on any future band-count change; and because every
consumer is length-agnostic already. D-224 has the full argument.

**"No EQ" is the empty list — and a materialised strip nobody touched is also
inert**, because `EqBand::is_active` is false for a gain-using kind sitting at
exactly 0 dB. That is what lets the Inspector show four real bands from the
first moment without the panel's presence costing the mix anything: selecting a
clip writes nothing, and the first real edit materialises the whole strip rather
than a lone orphan band.

Five kinds, all available on every band: `low_shelf`, `peak` (bell), `high_shelf`,
`high_pass`, `low_pass`. A **notch is not a kind** — it is a bell with a deep
negative gain at a high Q, which is what Resolve's own notch icon draws.

### 10b. The math is the Audio EQ Cookbook's, and it lives in L0

`chroma_types::eq` — beside §5b's `fade.rs` and §9b's `pan.rs`, for those
sections' exact reason: the mixer that runs the filters is L1 `chroma-media` and
cannot reach up to L2's `Clip`. It holds the band type, the five cookbook forms
(peaking, low/high shelf, 2-pole low/high-pass) with
`A = 10^(gain_db/40)`, `w0 = 2π·f0/fs`, `α = sin(w0)/(2Q)` normalised by `a0`,
the magnitude response `20·log10|H(e^jω)|`, and a transposed-direct-form-II
`Biquad` with its own state.

The one design choice inside the math is to parameterise **every** kind by Q
(the cookbook permits it for the shelves too, alongside bandwidth and slope S),
so one field set — frequency / gain / Q — covers all five shapes and the
Inspector never swaps a control out per band kind.

### 10c. Composition — one more stage, and this one does NOT commute

```
eq  →  track.gain × clip.volume × fade × duck  →  pan splits per channel
```

The standard "insert before the fader" topology. §9c's four gain stages commute
with each other because they all multiply; **this one does not**, and that is
worth stating: a biquad is linear but time-INVARIANT, so filtering a signal a
fade has already time-varied is genuinely a different operation from fading a
filtered one. Both engines implement the same order — `SourceEnvelopes::apply`
runs the cascade at the top of its existing single per-sample-frame pass (not a
second pass, for §4c's reason), and `buildAudioSourceChain` emits the band nodes
before its `volume` node — and a `chroma-media` test computes the other order
and asserts the two differ, so the order is pinned rather than assumed.

Three rules the mixer makes explicit, because they are choices:
- **one cascade per output CHANNEL**, with its own state — sharing one across
  channels would cross-feed them, which is a stereo image collapsing rather than
  an equaliser;
- **state persists across chunk boundaries**, which is what makes
  `SourceEnvelopes::apply` take `&mut self`: a filter restarted every
  1024-sample chunk is an audible ~47 Hz buzz;
- **coefficients are built in `run_session`, not by the caller**, because they
  depend on the output device's sample rate, which nothing knows until the
  device is open. `AudioSourceSpec` therefore carries the *bands* — and there is
  deliberately no `eq_for_clip` beside §6b's `fade_for_clip` and §9d's
  `level_for_clip`, because hertz, decibels and Q are not frames and there is
  nothing to convert.

### 10d. Static, not keyframeable — and the reason is the export

The opposite call from §9d's, made on evidence. `volume`/`pan` are keyframeable
because ffmpeg's `volume` filter takes a real per-frame expression (§9e).
ffmpeg's biquad filters do not: `equalizer`, `bass`, `treble`, `highpass`,
`lowpass` and the generic `biquad` all parse their parameters **once, as
numbers**. `sendcmd` can step them at named instants, but a stepped biquad is a
staircase of coefficient jumps — clicks, not a sweep — and the live mixer would
then have to reproduce that exact staircase for "same doc ⇒ same sound" to hold.

So an animated EQ is not renderable, and a preview the export cannot match is
the defect class this repo keeps closing. One EQ per clip; split the clip if it
must change part-way. Said in the field's own doc, in the Inspector (which
renders **no** keyframe diamond on an EQ row rather than three dead buttons),
and in the MCP tool text.

### 10e. Export — ffmpeg's `biquad`, fed OUR coefficients

The measured finding that drove it. Feeding a unit impulse through each filter
and reading the response off it:

- `equalizer`, `highpass`, `lowpass` at `width_type=q` reproduce the cookbook
  **exactly** — matching this module's analytic response to **< 0.0001 dB**.
- `bass`/`treble` do **not**. `bass=f=120:t=q:w=0.707:g=6` realises a biquad
  whose **implied Q is 0.993**, not 0.707, and whose response **overshoots to
  +6.29 dB at 40 Hz** and dips to −0.33 dB at 200 Hz where the cookbook's shelf
  is monotone — 0.25–0.37 dB from the same band in the live mixer.

So `timelineExportAudio.ts`'s `eqFilterChain` compiles every band to ffmpeg's
**generic `biquad`** filter with the coefficients `eq.ts` computes (the exact
mirror of `chroma_types::eq`) rather than naming one of ffmpeg's own EQ filters.
Agreement between the two engines then becomes structural rather than hoped for,
and nothing depends on one ffmpeg build's shelf conventions. Measured back:
**< 0.0001 dB** of the analytic response, for all five kinds.

One consequence, stated rather than hidden: `biquad` takes literal coefficients,
so they must be computed for a KNOWN rate, and this compiler never probes a
source. The chain is therefore preceded by `aresample=48000`
(`EQ_DESIGN_SAMPLE_RATE`), emitted **only** for a clip that actually has an
active band, so a project not using the feature compiles to byte-identical
argv. The live mixer designs at the output DEVICE's rate instead; on the usual
48 kHz device the two are identical, and at 44.1 kHz they differ by the bilinear
warping alone — measured **≤ 0.036 dB across 50 Hz–15 kHz**, asserted as a test.
Standard for any biquad EQ, not a divergence between our two paths.

### 10f. How it was verified

**A frequency response, measured in both engines against one shared table.**
`chroma_types::eq::tests::REFERENCE_RESPONSE_DB` and
`timelineExport.ffmpeg.test.ts`'s own copy carry the same seven `(Hz, dB)` pairs
for the same deliberately-awkward four-band set: a high-pass at 90 Hz, a −6.5 dB
bell at 950 Hz, a +5.5 dB shelf at 6.2 kHz, and a **disabled** +18 dB low shelf
that would break the table by a mile if either engine stopped honouring
`enabled`. The Rust side measures them by pushing a real sine through the real
mixer path in real 1024-frame chunks; the TS side by running the real compiled
filter chain through real ffmpeg and reading `volumedetect`. Both agree to
**< 0.05 dB**. Each of the five kinds separately measures its own textbook value
through real ffmpeg (a bell IS its gain at centre; a shelf is half-gain at its
corner; a Butterworth pass filter is −3.01 dB at its corner), and two further
tests prove the chain reaches a real encoded file.

`cargo test`: `chroma-types` 46, `chroma-timeline` 155, `chroma-media` 114, all
green. `npm test --workspace @chroma/editor` 859/859, including 25 new tests (8
real-DOM Inspector, 12 model/reducer, 5 real-ffmpeg).

### 10g. Honest gaps

1. **Not heard.** Same sandbox constraint §8 gap 2 and §9g gap 1 record: this
   environment cannot launch the Tauri window, so the live mixer's half is
   `cargo test` evidence and the export's half is real measured ffmpeg output.
   Neither is a demonstration that it *sounds* right.
2. ~~**No response CURVE in the Inspector**~~ — **DONE, 2026-09-08 (D-237).**
   `EqResponseGraph.tsx`: Resolve's ±24 dB / log-frequency graph, a numbered
   draggable point per band (horizontal = frequency log-scaled, vertical =
   gain for the gain-using kinds), the combined response as a filled/stroked
   curve sampled from `eqResponseDb` itself, and Q on a scroll-wheel-over-the-
   point gesture (checked against Logic Pro's own Channel EQ convention —
   Resolve's own reference shows no secondary axis for Q). This also closes
   gap 3 below: a point's horizontal drag IS the log-scaled frequency drag,
   so the Freq `PropertyRow`'s own linear 10 Hz step is no longer the only way
   to move it.
3. ~~**No frequency-log drag.**~~ — **DONE, 2026-09-08 (D-237)**, by the graph
   above rather than a change to the Freq field itself (which still steps
   linearly for precise nudging — the two controls are complementary, not one
   replacing the other).
4. **No pitch control.** The same Resolve Inspector shows Clip Pitch
   (semitones + cents) between Pan and the Equalizer. Not built, not started —
   it needs real time-domain pitch shifting in the live mixer, which is a
   different kind of problem from a biquad.
5. **The mid-session re-resolve gap is unchanged** (§8 gap 6, §9g gap 5): an EQ
   set on clip 2 is heard when playback starts inside clip 2 and not at all when
   playback runs into it from clip 1, because clip 2 is not a source in that
   session. Pre-existing, not introduced here.

---

## 11. Tape-style scrubbing + the viewer waveform (**BUILT, D-232**, 2026-09-08)

Roadmap item 27's *"Audio scrubbing + waveform toggle — source-viewer waveform,
tape-style scrub"*. Reference: `scratch/resolve-reference/scrubbing.jpg`, opened
and read before anything was designed (CLAUDE.md's research-first rule).

This is a fourth build pass on this document's subject, and unlike §9/§10 it is
**not** another envelope in the existing mixer: it is a second *playback mode*.
That is the whole design question, and §11a is the answer to it.

### 11a. Scrub is a THIRD request on the ONE transport, not a parallel engine

The existing engine (§1, D-049/D-050) is **time-driven**: `chroma_audio_play`
resolves the sources at one playhead frame, then `run_session` free-runs against
the audio device's own clock until something supersedes it. A scrub is
**position-driven**: there is no clock at all, only "where is the pointer now",
sampled tens of times a second, and the audio has to follow it — including
backwards, including standing still.

Three ways to fit that in were on the table:

1. **Reuse `chroma_audio_play` per pointer move.** Rejected outright: every call
   tears down and rebuilds a `cpal` output stream and re-probes/re-seeks every
   source. D-125 measured that warm-up at hundreds of milliseconds; doing it 60
   times a second is not a slow version of the feature, it is not the feature.
2. **A second, independent audio subsystem** with its own session state.
   Rejected: there is one output device and one thing the user can be hearing, so
   two transports would need a new mutual-exclusion invariant between them —
   exactly the class of implicit, untested ordering assumption that B-047/D-130
   already had to make explicit once for play-vs-stop.
3. **A third request on the existing transport** — chosen. `scrub::begin(seq)`
   calls the same `begin_request` that `play` and `stop` call, takes the same
   generation, and the scrub thread exits on the same `is_current` check. So
   "starting a scrub stops playback" and "pressing Play stops the scrub" are not
   new behaviour that had to be written and could be got wrong; they are the
   single-transport rule that already held, applied to one more caller. The
   frontend's request stamp had to become genuinely shared for this to be true,
   which is why `nextAudioSeq` moved out of `PreviewPane.tsx` into
   `audioTransport.ts` — two counters feeding one high-water mark would let a
   scrub be dropped as "stale" by a play issued before it.

`update(position)` is deliberately **outside** that protocol and carries no
`seq`. The stamps exist because play/stop are *edges* whose effect depends on
which landed last. A position is a *level*: absolute, idempotent,
last-writer-wins — an update that loses a race is one the pointer has already
moved past. Its Tauri command is therefore a plain blocking one (it only stores
into a mutex), which as a bonus keeps updates in issue order for free.

**One thing this design makes load-bearing, found live.** The scrub thread's
`JoinHandle` must be installed on the session (`session_install_join`) exactly as
a play session's is, so the *next* transport claim joins it before opening a
device of its own. The first version did not, and the end-to-end `cpal` test
failed with total silence — an orphaned scrub thread from the previous test was
still holding the output stream. Caught only by running the env-gated real-audio
test for real, which is the same mechanism that caught B-102.

### 11b. What a grain is, and why the pitch does not change

A real tape deck's scrub is *varispeed*: drag faster, the pitch rises. Chroma's
is **granular at constant pitch** — a 60 ms grain read from wherever the playhead
is, with an 8 ms raised-cosine fade at each end, repeated ~17x/second. Stand
still and the same 60 ms repeats (the tape "wow"); drag, and each grain starts
further along.

Varispeed was considered and rejected for this pass, on two grounds, not one: a
variable-ratio resampler in the scrub path is a real DSP subsystem (the existing
`rubato` converter is fixed-ratio, chosen at session start), and the drag-speed
signal you would drive it with — differences between pointer events — is noisy
enough that the pitch would wobble on a steady drag. Constant-pitch granular
scrub is also what Premiere's and Resolve's own playhead drags actually sound
like, so this is the reference behaviour, not a simplification of it.

The fade is not cosmetic: without it each grain boundary is a step discontinuity
in the waveform, i.e. an audible click ~17 times a second.
`apply_grain_envelope` is pure and unit-tested for exactly the properties that
matter (silent at both ends, untouched in the middle, identical gain on every
channel of a frame, and the two fades provably unable to overlap and duck the
grain's own centre).

### 11c. The window — why a scrub is cheap

Naively, each grain is a seek plus a decode. Instead the thread holds a **decoded
window**: 4 seconds of PCM at the output device's own rate/channels, anchored
1.5 s *behind* the requested position so backward drags stay inside it. While the
playhead is in the window a grain is a memcpy; leaving it costs one `open_source`
+ decode (~20-40 ms), absorbed by the ring buffer's 3-grain (~180 ms) cushion.
`RING_GRAINS` is the one number that trades latency against underrun risk, and it
says so at its definition.

Two edge cases have their own tests because both are silent-failure shaped: a
window that came back short because the **source ended** must still count as
covering positions past it (otherwise a playhead parked near the end of a file
re-anchors on every single grain, forever), and a read outside the decoded range
must return silence padded to the full grain length (otherwise the grain size,
and so the scrub's timing, depends on where in the source you happen to be).

### 11d. One source, not a mix — and the frontend resolves it

Two deliberate divergences from `chroma_audio_play`:

- **It monitors one source.** `chroma_audio_play` mixes every active source; a
  scrub would need to re-anchor a separate decoder per source on every window
  crossing, N times the stall, for a monitoring aid whose question is "what is at
  this frame". Priority mirrors playback's own: a real audio track first (topmost
  wins), else the video clip's embedded audio unless it is A/V-linked (D-129).
  One addition: a track muted to `gain: 0` is skipped, because with only one
  source to pick, picking a muted one would make scrub audible where playback is
  silent.
- **The frontend resolves it.** Every other timeline→media conversion in
  `chroma::audio` is app-side because it needs a `Clip`. This one is not: it
  arrives already resolved, in the same "bare source path + source seconds" shape
  `chroma_audio_waveform` has taken since D-051. The reason is cost —
  `resolve_video_position` re-reads and clones the whole active `Timeline` per
  call, and the caller here is a pointer drag — but the reason it is *correct* is
  that `@chroma/editor`'s `clipAt` is already the pointwise mirror of
  `Track::clip_at` and is already what every other Edit-tab UI decision resolves
  through. `scrubSource.ts` is that one resolver, shared by the scrub engine and
  the waveform strip so the two can never disagree about what is under the
  playhead.

### 11e. The waveform toggle — what the reference actually shows

Read off `scrubbing.jpg`: a full-width audio waveform band sitting **between the
picture and the position bar**, with a coloured playhead line drawn through it,
and a visibly brighter region inside a dimmer surround. That placement, that line
and that brightness split are what shipped, as `Player`'s new `waveform` slot
plus a toggle button in the transport (both omitted-not-disabled when the caller
supplies nothing, matching every other optional control on that component).

One deliberate divergence, argued rather than assumed: the strip shows a **fixed
4-second window centred on the playhead**, not a full-duration overview. A whole
real edit across ~900 px is about one pixel per second, which shows nothing you
could scrub *to*; four seconds is ~225 px/s, enough to see a word boundary and
put the playhead on it. The brighter region is the current clip's own trimmed
extent — material outside it exists in the source but is not on your timeline,
which is exactly what the reference's inner highlight conveys.

**It is not a second waveform pipeline.** Peaks come from `Waveform.tsx`'s own
`getPeaks` → `chroma_audio_waveform`, through the same frontend cache and the
same D-128 Rust cache the timeline's per-clip waveforms use. Because the drawn
window slides continuously, requesting *it* would miss that cache on every frame
and pay a full `symphonia` decode per pointer move — literally the defect D-128
found and fixed on the filmstrip side. So the strip fetches a **snapped 12 s
tile** (`waveformTileFor`) and does index arithmetic within it: the request
changes at most once per 4 s of source traversed. That property has its own test,
at the IPC boundary, because it is invisible from the picture.

### 11f. The MCP surface, and the one tool that deliberately does not exist

- `editor_set_waveform_view(open)` — the write half of the toggle, driving the
  same store flag the human's button drives.
- `editor_get_waveform(frame?, window_secs?, buckets?)` — the same envelope the
  strip draws, as numbers: the resolved source, the window (including the
  clip-extent fractions), and `[min, max]` peak pairs.
- `editor_get_state` now reports `waveformView`.

**There is no `editor_scrub` tool, and that is a decision.** Tape-scrub's entire
content is "audio, now, while my hand moves" — an agent cannot hear it, and
`editor_set_playhead` already moves the playhead observably, so a scrub tool
would be an awkward wrapper around a seek. What an agent actually needs from this
capability is the *information* a human gets by ear, and that is
`editor_get_waveform`: where the sound is, whether a cut lands mid-word, whether
a clip is silent at all. CLAUDE.md's "a human AND an AI" rule is met by giving
the agent the equivalent capability, not the same gesture.

### 11g. What is verified, and what needs a human ear

**Verified by test:**

- The grain/window arithmetic, pure and unit-tested in `chroma-media::scrub`:
  grain and fade sizing, the envelope's shape and per-channel equality,
  anchoring and the head-of-file clamp, window coverage including the EOF and
  different-source cases, and read offset / interleaving / silence-padding.
- **A real window decoded from real media holds real, non-silent PCM**, and a
  grain cut from it survives the envelope — env-gated on
  `CHROMA_TEST_AUDIO_VIDEO`, in `chroma-media`. Deliberately separate from the
  end-to-end test below, because "the decode is wrong" and "the device path is
  wrong" are different faults that one silence assertion cannot tell apart —
  and on the first real run they genuinely were different faults.
- **Real, non-silent PCM reaches the real `cpal` output device while scrubbing**
  — `chroma_audio_scrub_produces_non_silent_pcm_end_to_end`, the same
  live-device rms/peak proxy D-049/D-050 introduced, driven through the real
  commands with a real 2.4 s drag that crosses the window boundary twice.
  Measured on a real 44.1 kHz stereo file: `rms=0.0807 peak=0.3783`. Its
  counterpart on a source with no audio stream measures exactly `(0.0, 0.0)`.
- The transport claim: a scrub supersedes a running play session, a stale scrub
  command is dropped like a stale play/stop, and a position update provably
  never touches the transport it is steering.
- The resolver and window/tile arithmetic (`scrubSource.test.ts`): audio-track
  priority, the muted-track skip, D-129 link suppression, generated clips,
  `source_fps` conversion, window centring and head clamping, and the tile's
  stability and coverage.
- The strip and both MCP ops through the **real** `chroma://request` dispatch
  path (`PreviewPane.waveform.dom.test.tsx`), including that the op and the
  human's button mount the same DOM, that the strip fetches the snapped tile
  rather than the sliding window, and — via a recording 2D context — that the
  playhead line and the in/out-of-clip dimming land where the pure math said.

**Needs a human to actually listen** (this environment cannot launch the Tauri
window — the same constraint §8/§9g/§10g record):

1. **Whether it sounds like a scrub.** Every constant in §11b is a judgement
   call — 60 ms grains, 8 ms fades, unity pitch. The tests prove sound comes out;
   only an ear can say the grain length is not too buzzy or too smeared.
2. **Whether the latency feels attached.** `RING_GRAINS = 3` is ~180 ms between
   the pointer and the sound. That is inside the normal range and it is
   deliberate cushion against the re-anchor decode, but "feels attached to my
   hand" is not measurable here.
3. **Whether a re-anchor is audible.** The cushion is sized to absorb a 20-40 ms
   decode; a slow disk or a large container could exceed it, and the symptom
   would be a brief dropout every ~2.5 s of continuous forward drag.
4. **Whether the strip is legible at real size**, and whether 4 s is the right
   window. jsdom can check the geometry the component asked for; it cannot say
   the result reads well.

### 11h. Honest gaps

1. **No varispeed** (§11b) — a stated decision, not an omission.
2. **One source, not the mix** (§11d). Scrubbing over a dialogue track while a
   music bed plays underneath monitors the dialogue only. Roadmap follow-up.
3. **Scrub is the Edit tab's only** — it lives where the transport does. Motion
   and Colorist embed `<Player>` but supply no scrub driver.
4. **The mid-session re-resolve gap does not apply here**, unusually: a scrub
   re-resolves its source on every update by construction, so dragging across a
   cut *does* follow the picture — the one place this mode is better than
   playback (§8 gap 6, §9g gap 5, §10g gap 5).
