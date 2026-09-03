# Multi-track NLE — scoping (2026-09-03)

Owner: "we need multitrack as we use that... we need full editing... just the NLE, not
something new, whatever a normal NLE has." Standard baseline scope, not a custom
workflow — N video tracks (top wins where it has content), N audio tracks (all mixed,
each with vol/mute/solo/pan), clips placeable anywhere on any track (not forced
back-to-back), drag between tracks, track headers (mute/lock/solo), add/remove tracks,
basic transitions (cross-dissolve), and the composite actually renders in both preview
and export. This is `architecture-lock.md`'s `chroma-compositor` — this note is the
real scoping for it, replacing the one-line placeholder that's stood in for it so far.

## Current state, verified against the actual code (not assumed)

- **The data model already has `Timeline.tracks: Vec<Track>`** (`chroma-timeline`,
  D-041) — structurally not hardcoded to one track. But `Timeline::from_shots` always
  builds exactly `vec![Track { kind: Video, clips }]`, and **there is no `add_track`
  command anywhere in the codebase** — zero capability, backend or UI, to create a
  second track today.
- **Clips have no position field.** A track's clips are placed by walking the list and
  summing durations — always back-to-back, zero gaps, by construction (`Track::clip_at`,
  every edit op in `chroma-timeline/src/lib.rs`). There is no `start_frame` on `Clip`.
  **This is the real structural blocker**, deeper than "just add more tracks" — even
  with a second track today, there'd be no way to place a clip at an arbitrary point in
  time or leave a gap before it. Needs either an explicit position per clip or an
  OTIO-style `Gap` placeholder item (OTIO itself has this; this codebase's "OTIO-shaped"
  model currently doesn't).
- **The Editor's live preview picks the first video track and stops**
  (`edit.rs::chroma_timeline_frame`: `tracks.iter().find(|t| t.kind == TrackKind::Video)`).
  A second video track would be silently ignored, not composited — there is no
  compositing logic anywhere in this path.
- **Audio is deliberately not a separate track** (D-050's own code comment explains
  why) — it reads the video clip's *embedded* audio stream directly. No music/SFX/
  dialogue-as-separate-tracks concept, no per-track volume/mute/pan, no mixing of N
  streams — today's audio pipeline (`chroma::audio`, `symphonia`→`rubato`→
  `dasp_sample`→`cpal`) only ever plays one stream.
- **Export doesn't go through the timeline model at all yet** — still operates on the
  single loaded clip (the Colorist's original single-clip export path), not the Edit
  tab's multi-clip timeline. Flagged as deferred when the Export dialog shipped (D-049).

## The phased build

### Phase A — Data model foundation

**Done, D-054 (2026-09-03).** Added a position field to `Clip` — an explicit,
timeline-absolute `start_frame: i64` (not a `Gap` item; see D-054 for the
full rationale, in short: it matches `TimelinePane.tsx`'s
`@xzdarcy/react-timeline-editor`'s own start/end-time item model, so Phase D
won't need a translation layer). Clips stop being forced back-to-back — a
track's clips can now leave gaps, and `clip_at` returns `None` for a query
landing in one, same as past-the-end. Every existing op reworked for
gaps + a no-overlap invariant (`trim_start`/`trim_end` gained
neighbor-clamping; `remove`/`reorder` changed behavior — flagged explicitly
in D-054, since removing/reordering no longer implicitly ripple-reflows the
track now that position is explicit). Added `Timeline::add_track`/
`remove_track`/`move_clip`, each with real unit tests (round-trip,
cross-track identity preservation, overlap rejection, out-of-range errors).
Wired `chroma_timeline_add_track`/`_remove_track`/`_move_clip` Tauri
commands in `edit.rs`. Legacy `project.json` migration
(`backfill_legacy_positions`, a typed post-deserialize step, not a raw-JSON
rewrite like D-045/D-046's — see D-054) verified against the real
`~/Movies/Chroma/New.chroma/project.json`. `chroma-timeline` 23/23 tests;
no frontend touched, `tsc` baseline unaffected. **Nothing in the app
populates a second track or a gap yet** — `build_from_shots` is unchanged,
one video track, clips still back to back — this phase is "the model *can*
represent it," not "the app now does it." Phase B is next.

### Phase B — The compositor (the real project, not a checkbox)
Actually render N video tracks together: sample every visible track at a given frame,
composite by z-order/opacity, feed the result into *both* the live preview decode path
and export. This is the piece `architecture-lock.md` has called "the long pole" since
before this week's work started, and it still is. Every other feature shipped this week
was "wire an existing capability into a new surface" — real-time GPU rendering already
existed (grading), audio decode already existed, the timeline model already existed.
This is genuinely new: a frame-compositing engine that doesn't exist anywhere in this
codebase yet, video or otherwise, outside the Colorist's single-clip grade pipeline.
**Sizing: several dispatch-and-merge cycles, not one evening** — the one piece of this
whole plan that doesn't decompose into small independent chunks the way this week's work
did, because A/C/D/E/F all sit downstream of it existing. Track count barely changes the
work — a 2-track compositor and an N-track one are nearly the same engineering; the hard
part is the compositing math/pipeline itself, not "how many."

**Sub-phasing this, since it's the long pole:**
- ~~B1 — two tracks, opaque only~~ — **done, D-056 (2026-09-03).** Real finding:
  opaque top-wins compositing needed **no new rendering/GPU code** — with no
  alpha in play, the top track (when it has a clip at the position) fully
  obscures whatever's below, so this reduced entirely to a track-**priority-
  selection** problem, not a compositing one. Landed as
  `chroma_timeline::Timeline::resolve_video_clip_at` (pure model logic: video
  tracks walked in index order, lower index = higher priority/"on top", first
  one with a clip — not a gap — at the position wins, falling through only on
  a gap), with `edit.rs`'s `resolve_video_position` (shared by
  `chroma_timeline_frame` and the audio path) as a thin wrapper that probes
  the winning clip's source. `cargo test -p chroma-timeline` 30/30 (+7 for the
  new resolution logic); `cargo test --manifest-path app/src-tauri/Cargo.toml
  chroma::` 113/113 (+1 real-clip integration test). Still nothing in the app
  populates a second video track (Phase D territory) — this phase proved the
  resolution logic against a `cargo test` fixture built with Phase A's real
  ops (`add_track`/`move_clip`), same as Phase A itself proved its ops against
  tests rather than a UI. See D-056 for the full write-up.
- B2 — N tracks, still opaque-wins. Per D-056: the same walk in
  `resolve_video_clip_at` is a plain filtered `Vec` iteration with no
  hardcoded track count, so it already generalizes past 2 tracks with zero
  additional code — B2 is now mostly "test/confirm N>2," not new engineering.
- B3 — real blend modes / opacity (needed for anything beyond simple video-over-video)
  — this is where the genuinely new GPU/pixel-compositing work still is.

### Phase C — Audio mixing

**Done, D-057 (2026-09-03).** `chroma::audio`'s `cpal` pipeline now sums every active
audio source — the baseline video-embedded audio (unchanged, unity gain, D-050's
existing behaviour) plus every genuine `TrackKind::Audio` clip overlapping the play
position — instead of playing exactly one stream. `chroma_timeline::Track` gained a
`gain: f32` field (default `1.0`, D-057), read by a new mixer (`mix_sources`/
`soft_limit` in `chroma::audio`) that sums the active (nonzero-gain) sources and passes
the result through a soft (`tanh`) limiter — chosen over a hard clamp (real digital
clipping) or a blanket `1/N` pre-scale (needlessly quiet when sources rarely peak
together); with one or zero active sources, summation/limiting is skipped entirely,
which is what keeps the pre-existing single-embedded-track case byte-identical and
makes "mute a track via `gain: 0.0`" an exact, checkable property rather than an
approximation. Streamed via one audio thread pulling N `DecodedSource`s in lockstep by
a fixed-size window (`open_source` factored out of the old single-source `run_session`
body). Pan/stereo positioning deliberately scoped out — mono gain scaling covers this
phase's actual goal, real extra scope nothing here asked for. **Still nothing in the
app populates a real audio track** — this is the mixing *capability*, exercised in
`chroma::audio`'s own tests via a hand-built `Timeline` (a real 2-track project +
`chroma_audio_play`/`_level`/`_stop` through the real command surface, plus a
deterministic decode-and-mix test against two distinct real audio files) — Phase D
(the UI to actually place an audio-track clip) is still not started. See D-057 for the
full writeup (mixing architecture, the three headroom options considered, where
`Track.gain` lives and why).

### Phase D — Multi-track UI

**Done, D-080 (2026-09-03).** Track lanes + headers (mute + remove; lock/solo
deferred, no backing model field) in `TimelinePane.tsx`, add/remove-track
toolbar buttons, a "Move to ▾" dropdown standing in for drag-between-tracks
(the library has no native cross-row action drag). Built once B1+B2 (opaque
top-wins, confirmed at N tracks) and C (audio mixing) existed — did NOT wait
for B3 (real blend modes/opacity): opaque multi-track editing doesn't need
it, and B3 is additive on top of the UI existing, not a prerequisite for it.
**Also sequenced after `docs/notes/unified-clip-model.md`'s migration** (owner-
directed 2026-09-03, done as D-070): once multiple video tracks exist, "which
clip is Colorist grading" needs to resolve to whichever clip wins compositing
at the playhead — that migration built the shared resolution path Phase D's
UI and Colorist both need. See D-080 for the full writeup.

### Phase E — Transitions
A cross-dissolve is two clips composited with a time-varying blend — rides directly on
top of Phase B's compositor (specifically B3's blend-mode support), not separable from
it in practice even though it's listed separately.

### Phase F — Export through the real timeline
Export doesn't use the Editor's timeline model at all today. Wire it through once B
exists (the same compositor renders preview frames and export frames) — mechanical at
that point, not new engineering.

## Sequencing

**A and C are approachable now, genuinely fast, and independent of each other** — both
can be dispatched in parallel without touching B. **B is where the real time goes** and
should be sub-phased (B1→B2→B3) rather than attempted as one giant task, both to have a
working end-to-end pipeline sooner (B1) and to keep each dispatch reviewable. **D, E, F
all follow naturally once B lands** — don't start them earlier, there's nothing for them
to attach to.

## Status

Scoped 2026-09-03. **Phase A done, D-054.** **Phase B1 done, D-056
(2026-09-03)** — see that phase's own section above for what landed and the
load-bearing finding (opaque top-wins needed no new rendering code, just
track-priority selection). **Phase B2 (N tracks) confirmed, D-080
(2026-09-03)** — was claimed to already generalize with no new code but had
never actually been exercised past two tracks until D-080's own scoping pass
checked it first: new `three_video_track_timeline` fixture + two tests prove
the walk falls through *two* consecutive gaps correctly (track 0 exhausted,
track 1 also exhausted, track 2 wins), not just one — the real gap real N>2
coverage would have caught. **Phase C done, D-057 (2026-09-03)** — ran
concurrently with B1 in a separate worktree, per the sequencing plan above;
real N-source audio mixing, `Track.gain`, sum-then-soft-limit headroom.
**Phase D (multi-track UI) done, D-080 (2026-09-03)** — `TimelinePane.tsx`
renders one row per track, a real custom track-header sidebar (kind icon,
per-kind label, mute toggle on `Track.gain`, remove-track), add-track
toolbar buttons, and a "Move to ▾" dropdown standing in for live
drag-between-tracks (the library has no native cross-row action drag —
checked before assuming otherwise). Built ahead of B3 landing, on top of
B1/B2's opaque-only compositing — deliberately, since the roadmap's own
"D needs B" framing meant B1+B2 at minimum, not literally all of B including
B3; opaque multi-track editing is fully usable now, blend-mode/opacity
compositing (B3) is a separate, additive later step, not a blocker for the
UI existing. See D-080 for the full writeup, including a genuinely still-open
gap (a live drag-clip-between-tracks gesture) and what's out of scope
entirely for now (lock/solo — no backing model field). **B3 (real blend
modes / opacity) is the one remaining piece of genuinely new GPU/pixel-
compositing work**, still not started. E (transitions) and F (export through
the real timeline) remain blocked on B3. This note is the scoping record —
update it (or promote pieces of it into `D-NNN` entries) as each phase
actually lands, the same discipline every other feature this week has
followed.
