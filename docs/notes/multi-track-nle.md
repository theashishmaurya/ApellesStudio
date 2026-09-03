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
Add a position field to `Clip` (or a `Gap` item) so clips stop being forced
back-to-back. Add `add_track`/`remove_track`/`move_clip_to_track` ops. Well-scoped,
same shape `chroma-timeline` has absorbed cleanly three times already (D-041/045/046).
**Sizing: one solid subagent pass** — real Rust logic, real unit tests, no rendering
touched.

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
- B1 — two tracks, opaque only (no blend modes, top track with content just wins) —
  proves the actual rendering pipeline end to end, smallest real slice.
- B2 — N tracks, still opaque-wins.
- B3 — real blend modes / opacity (needed for anything beyond simple video-over-video).

### Phase C — Audio mixing
Extend `chroma::audio`'s `cpal` pipeline to sum N tracks with per-track gain instead of
playing one embedded stream. Real DSP work but bounded — `cpal`/`rubato`/`dasp_sample`
are already integrated (D-050), this is a mixer stage on top, not new infrastructure.
**Sizing: moderate**, not a long pole. Independent of Phase B — can run in parallel with
it in a separate worktree.

### Phase D — Multi-track UI
Track lanes, headers (mute/lock/solo), drag-between-tracks in `TimelinePane.tsx`.
**Genuinely blocked on B and C existing** — no point building UI for tracks that can't
render or mix. Once B/C land, back to the "wiring/UI-from-kit" bucket — fast.

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

Scoped 2026-09-03, not yet built. Phase A is the first dispatch. This note is the
scoping record — update it (or promote pieces of it into `D-NNN` entries) as each phase
actually lands, the same discipline every other feature this week has followed.
