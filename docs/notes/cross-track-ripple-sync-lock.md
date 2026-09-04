# Cross-track ripple / sync-lock — scoping (2026-09-04)

Roadmap item 11, priority #2 per `docs/notes/timeline-feature-audit.md` (D-105): the
single most-cited real gap against every reference checked. Today's ripple (`add_clip`'s
insertion ripple, D-104's `move` ripple, D-105's `remove_gap`) only ever shifts clips on
the ONE track being directly edited — confirmed again, precisely, while writing this doc
(`crates/chroma-timeline/src/lib.rs::remove_gap`, line 822: `let t = self.track_mut(track)?;
... for c in t.clips.iter_mut() { if c.start_frame >= gap_end { c.start_frame -= shift; }
}` — one `Track`, one loop, no other track ever touched; the TS mirror in
`packages/editor/src/timeline.ts` is field-for-field identical).

## Real references checked (not assumed) — the exact semantics that matter

- **DaVinci Resolve's Sync Lock** (confirmed via Blackmagic's own support docs and the
  20.2 release notes, not memory): **on by default for every track**, lives in the track
  header. **Per-track, independently on video and audio.** The critical semantic, worth
  stating precisely since it's easy to get backwards: sync lock controls whether **that
  track participates in / receives** a ripple shift, **not** whether an edit *on* that
  track is allowed to ripple at all — an edit on any track propagates to every *other*
  track whose own sync-lock is on, regardless of the edited track's own lock state.
  **A genuinely more sophisticated real behavior worth knowing about, not necessarily
  copying**: when a ripple would shift a sync-locked track and a clip on that track
  straddles the shift point, Resolve **automatically adds a cut point (splits the clip)**
  at that moment rather than rejecting the whole ripple — see "Open design question 2"
  below, this is a real fork in the road for Chroma's own design, not an obvious default.
- **Palmier Pro's `manage_tracks`** — a `syncLocked` field, on by default, described in
  its own tool surface (loaded directly, this repo's own stated feature bar per
  `CLAUDE.md`) as "whether ripple edits shift this track along." Same per-track,
  default-on shape as Resolve.
- **Premiere Pro's ripple edit tool** (Adobe's own help docs, already cited in the audit)
  — "Trim trailing clips in all unlocked tracks." Premiere's version is closer to a binary
  per-track *lock* (does this track ripple at all) rather than a dedicated sync-lock
  concept distinct from the ordinary track-lock, but the practical effect — some tracks
  shift, some don't, controlled per track — is the same shape.

**Conclusion for Chroma's design**: match Resolve/Palmier's shape exactly (a dedicated
per-track boolean, separate from the existing `Track.locked` edit-guard, default `true`)
rather than Premiere's overload of the ordinary lock — Chroma already has a distinct
`Track.locked` (D-082, blocks *edits* to that track's own clips) that means something
different from "does this track receive other tracks' ripple shifts." Reusing `locked`
for both would conflate two real, independent concepts this codebase already keeps
separate elsewhere (see `Track.hidden` vs. `Track.gain == 0.0` mute — the same "don't
fold two different concepts into one flag" discipline D-082's own doc comment argues for).

## Current state, verified against the actual code

- **`Track` (`crates/chroma-timeline/src/lib.rs`, line 79) has `kind`, `clips`, `gain`,
  `locked`, `hidden`** — no sync-lock field or concept anywhere, not even a stub (matches
  the audit's "Don't have" finding exactly). The TS mirror (`packages/editor/src/
  timeline.ts`) has the identical field set.
- **Correction (D-107, found while implementing this doc): no `Timeline::add_clip` Rust
  method exists at all** — `grep -n "fn add_clip"` on `chroma-timeline/src/lib.rs` finds
  nothing. `add_clip` is a TypeScript/frontend-only op; `chroma_timeline_set` stores
  whatever the frontend computes verbatim (this crate's own module doc: "no
  server-side clamping"), so there's no Rust-side ripple call site for it to generalize.
  The Rust side only ever needed `move_clip` and `remove_gap` touched; TS needed all
  three (`add_clip`/`move`/`remove_gap`). This doc's line below is left as originally
  written (with this correction) rather than silently edited, so the record of what was
  initially assumed — and caught — stays visible.
- **Three real ripple call sites, all single-track, all needing the same generalization**:
  1. ~~`Timeline::add_clip`'s insertion ripple (`chroma-timeline`)~~ — TS-only, see the
     correction above. `applyOp`'s `'add_clip'`
     case with `ripple: true` (`timeline.ts`) — D-095/D-100.
  2. `Timeline::move_clip`'s ripple (`chroma-timeline`) / `applyOp`'s `'move'` case with
     `ripple: true` (`timeline.ts`) — D-104, including its own straddle-rejection guard
     (a clip that straddles the landing point can't be cleared by a same-track ripple and
     is rejected rather than left overlapping — see "Open design question 2" below, the
     exact same shape of problem recurs for cross-track).
  3. `Timeline::remove_gap` / `applyOp`'s `'remove_gap'` case — D-105 (this session's own
     immediately-preceding pass).
  All three share the identical real shape: compute a `(threshold_frame, shift_amount)`
  pair, then `for c in <the one track's clips> { if c.start_frame >= threshold { c.start_frame
  -= shift } }`. Generalizing to sync-lock is mechanically the same loop applied to every
  sync-locked track, not new ripple mechanics — the audit's own framing ("reuses proven
  shift-by-delta math") holds up under this closer read.

## The real design, phased

### Phase 1 — the `Track.sync_locked` field

`#[serde(default = "default_sync_locked")]` returning `true` (mirroring `Track.gain`'s
existing non-zero-default migration pattern, D-057's own doc comment on why a bare
`#[serde(default)]` would be wrong here too — `bool::default() == false` would silently
turn sync-lock **off** for every existing project on load, the opposite of matching
Resolve/Palmier's real default). TS mirror: `sync_locked?: boolean` defaulting to `true`
wherever a `Track` is constructed or migrated, same discipline as the Rust side. A track
header toggle (a small icon next to lock/hide/mute, matching where Resolve puts it) —
UI-only, no ripple-logic change yet. This phase alone is low-risk and independently
useful (visible, toggleable, testable state) before touching any ripple call site.

### Phase 2 — generalize the three ripple call sites

Extract the shared "shift every clip at/after `threshold` on track `T` by `delta`" loop
(currently duplicated three times in both Rust and TS — a real, pre-existing duplication
this phase should clean up while it's in there, not add a fourth copy) into one real
helper, then call it once per sync-locked track: the edited track always (unconditional,
matching today's behavior), plus every *other* track where `sync_locked == true` —
**regardless of the edited track's own `sync_locked` value**, per the real Resolve/Palmier
semantics confirmed above. `sync_locked == false` on the edited track itself does not
suppress the edit's own ripple on its own track; it's irrelevant there. `Track.locked`
(the existing edit-guard) still applies exactly as today — a locked track can't be the
*source* of an edit at all, independent of this feature.

### Open design questions, real decisions to make before implementation, not deferred silently

1. **Does sync-lock apply to every ripple call site equally, or only some?** Resolve's own
   Sync Lock applies uniformly to ripple trim/delete/insert. Recommend the same here —
   apply to all three call sites in Phase 2 (`add_clip` insert, `move` ripple,
   `remove_gap`) rather than picking a subset, for consistency and because there's no
   real reference suggesting a reason to differ between them.
2. **A clip on another sync-locked track straddles the shift point — split it (Resolve's
   real behavior) or reject the whole op (matching D-104's own existing same-track
   straddle-rejection)?** This is the one place Chroma's existing precedent and the real
   reference diverge, and it's a genuine product decision, not a technical one:
   auto-splitting is more powerful (never blocks a ripple) but silently creates a new
   clip boundary the user didn't explicitly ask for, on a track they may not have even
   been looking at. **Recommend starting with reject-the-whole-op** (matching D-104's
   already-shipped, already-understood-by-the-owner precedent, and simpler/safer to
   implement and reason about), with auto-split flagged as a real, deliberate v2 — don't
   silently split a clip on an unrelated track as a first-pass default without the
   owner's explicit sign-off, since that's a more surprising/harder-to-undo outcome than
   a rejected op with a clear reason.
3. **Does a `remove_gap` on track A require every sync-locked track to have a *matching*
   gap at the same frame, or does it ripple them regardless of what's there?** Real
   answer from Resolve's own behavior (confirmed via the search above): ripples
   regardless — the whole point of sync-lock is that other tracks may have long,
   unrelated clips (a music bed, room tone) spanning straight through the edit point,
   and Resolve's answer is exactly the straddle-handling in question 2, not "only ripple
   if there's a matching gap." Chroma's `remove_gap` specifically requires *finding* a
   real gap on the *edited* track (`gapAt`/`gap_at`) — that requirement stays exactly as
   is for the edited track; it's the *other* sync-locked tracks that need the shift
   applied unconditionally (modulo question 2's straddle handling), not gap-gated.

## Backward compatibility

A pre-this-feature `project.json`'s tracks have no `sync_locked` key — the migration
default (`true`) means every existing project's tracks behave as sync-locked from the
moment this ships, matching what a *new* project would default to and what Resolve/
Palmier both do. This is a real behavior change for existing projects (ripple operations
that previously only affected one track now affect every track, since all default to
locked) — worth being explicit about rather than treating "backward compatible" as
"nothing changes." The alternative (defaulting existing tracks to `sync_locked: false` to
preserve today's exact single-track-ripple behavior) would mean every *new* track a user
creates going forward defaults differently from every *existing* one, which is its own
kind of surprising inconsistency — recommend the `true` default uniformly, matching the
real references, and treat "ripple now affects more tracks than it used to" as the
intended, visible behavior change this feature is *for*, not a regression to avoid.

## Sequencing

**After Phase 1 of `docs/notes/multi-select.md`** (a real, already-existing array-shaped
`Selection` changes what "select clips across these tracks, then ripple them" could mean
for a future batch operation — though note this doc's own ripple generalization doesn't
actually *require* multi-select to exist; it's about tracks receiving a shift from a
single edited clip's ripple, not about a multi-clip selection driving it). **Independent
of `docs/notes/av-linking.md`** at the model level, though in practice a linked A/V pair
sitting on two different (video + audio) tracks is exactly the kind of thing sync-lock
should keep together when either half ripples — worth a cross-reference once both exist,
not a hard dependency for building either first.

## Status

**Built, D-107 (2026-09-04).** All three open design questions above resolved by the
owner: question 1 (uniform across all ripple sites) and 3 (unconditional propagation,
no matching-gap requirement) adopted exactly as recommended; question 2 (straddling-clip
handling) went the OTHER way from this doc's own first-pass recommendation — **auto-split
(Resolve's real behavior), not reject** — see D-107's own entry in `docs/08-decisions.md`
for the owner's reasoning (reject would make sync-lock block ripples constantly in its
own headline use case, a straddling music bed). The silent-split concern this doc raised
is real but mitigated, not ignored: the new split clip's id is picked up by the existing
D-051 ripple-flash animation, so an auto-split is automatic but never silent. `Track.
sync_locked`, the shared shift/auto-split helpers, and the track-header toggle are all
real and shipped — 73/73 Rust + 115/115 TS tests, both including the exact straddle case
this doc's own question 2 was about.
