# Real A/V linking — scoping (2026-09-04)

Roadmap item 13, priority #3 per `docs/notes/timeline-feature-audit.md` (D-105) —
"bigger than 11/12," scoped properly here rather than improvised inline, per the audit's
own recommendation.

## The real gap, precisely

Chroma's current model (confirmed by grep across both `crates/chroma-timeline/src/lib.rs`
and `packages/editor/src/timeline.ts` — no `link`/`linked_clip`/`link_group` field
anywhere) has exactly two states, both all-or-nothing:
- **Audio embedded inside a video clip** (D-050) — inseparable. Always plays together,
  can never be independently trimmed, moved, or selected. There is no "audio half" to
  address at all; it's not a second `Clip`, just a stream `chroma::audio` reads directly
  off the video clip's own source file.
- **A fully independent audio-track clip** (D-057) — zero relationship to any video clip.
  Moving, trimming, or deleting one never affects the other, even if a user intends them
  to represent "this line of dialogue" as a conceptual pair.

Neither state can represent an L-cut or J-cut (the video and audio start/end at
*different* points, deliberately, while still being understood as "the same shot's
picture and sound" for every other purpose — select one, get both; move one, both move;
but trim one independently when you want the cut).

## Real references checked (not assumed)

- **Premiere Pro's Linked Selection** (confirmed via Adobe's own docs and search-indexed
  excerpts — one live fetch of Adobe's linking-clips page itself timed out, same real
  limitation the audit doc already disclosed for a different Adobe URL; cross-checked
  against multiple independent descriptions of the same documented feature rather than
  treated as unconfirmed) is a **two-layer system, not one flag**:
  1. **A permanent link relationship** between specific clips, set/cleared via `Clip >
     Link` / `Clip > Unlink` — this is the real, durable data relationship.
  2. **A separate, global "Linked Selection" UI toggle** (a button in the Timeline panel)
     controlling whether the app *automatically* selects/moves/trims every member of a
     link together during ordinary interaction, **plus a per-action modifier-key override**
     (Option/Alt) that temporarily treats a linked pair as unlinked for exactly one
     gesture, without touching the underlying permanent link. An L-cut/J-cut is created
     by using the override (or toggling Linked Selection off) to drag/trim one side
     independently — **the link itself is not broken by doing this**, the pair is simply
     temporarily positioned out of sync while still logically linked for every other
     purpose (select one → get both, in the next ordinary interaction).
- **Palmier Pro's `manage_clip_links`** (its real MCP tool description, loaded directly —
  this repo's own stated feature bar): `link` "merges the complete existing groups
  touched by clipIds and requires at least two clips of different media types"; `unlink`
  "accepts one or more members and dissolves each member's complete link group." Two real,
  concrete facts worth designing around: **linking is group-based, not just pairwise**
  ("merges the complete existing groups" — implies a link can already contain more than
  two clips, and linking touches the *whole* group each member belongs to, not just the
  two clips named in the call), and **a link requires clips of different media types**
  (an explicit validation rule — you can't "link" two video clips together, only
  video+audio). Its own guidance: "use unlink before independently trimming... relink
  afterward" — the same permanent-unlink-then-relink shape as Premiere's `Clip > Unlink`,
  without a documented equivalent of Premiere's *temporary* modifier-key override (not
  confirmed absent, just not present in the tool's own description — a real open
  question, see below).

## The real model, phased

### Phase 1 — the data model: `link_group` on `Clip`

**Group-based, not pairwise** — matching Palmier's real "complete existing groups" shape
rather than a simpler two-clip-only relationship, since a pairwise model would need
retrofitting the moment a real 3-way link (e.g. two audio takes synced to one video)
comes up, and the group shape costs nothing extra to build correctly the first time.
Recommend `link_group: Option<String>` on `Clip` (a group id, `None` = unlinked) — the
same `Option<String>` back-link shape `Clip.media_id` already uses (D-070), a real,
already-proven pattern in this exact struct for "this clip optionally belongs to a
broader relationship," not a new kind of field. `#[serde(default, skip_serializing_if =
"Option::is_none")]` — a pre-this-feature clip has no key, deserializes to `None`
(unlinked), zero migration needed, matching `media_id`'s own precedent exactly.

**Where does a link_group get created?** The real, common case per every reference:
**automatically, at clip-creation time**, when a video clip's audio is a *separate* clip
by construction rather than embedded — e.g. if a future "split embedded audio out to its
own track" operation is ever built (not currently possible — D-050's embedded audio has
no such split today), or if two clips are explicitly linked after the fact via a real
`link`/`unlink` op mirroring Palmier's own two actions. **This phase does not need to
solve "how does embedded (D-050) audio become an independent, linkable clip"** — that's
a separate, real prerequisite gap (D-050's audio literally isn't a second `Clip` today,
so there's nothing to *link* to yet) worth flagging explicitly rather than assumed away:
**A/V linking as scoped here only applies to two already-independent clips** (e.g. a
video-only clip on a video track + its own separately-placed audio clip on an audio
track) choosing to behave as linked. Turning D-050's embedded-audio model into something
with a real, separate, linkable `Clip` is out of scope for this phase — flagged as a real
prerequisite for the *fuller* vision (linking any video clip to its own native audio) but
not blocking this phase's real, smaller, still-useful scope (linking independently-placed
clips deliberately).

### Phase 2 — the two real ops, mirroring Palmier's own shape exactly

`link(clip_ids: [String])` — merges the complete existing groups touched by every named
clip (create a new shared group id if none of them had one; if some already belong to
different groups, merge those groups into one) — and `unlink(clip_ids: [String])` —
dissolves each named clip's *complete* group, not just removing that one clip from it
(matching Palmier's own documented "dissolves each member's complete link group," not a
softer "just this clip leaves the group" reading — worth being precise here since the two
readings behave very differently and only one matches the real reference). Both mirrored
field-for-field in Rust and TS, same discipline as every other op this session built.
**Validation**: reject linking same-media-type clips (Palmier's own explicit rule —
"requires at least two clips of different media types"); real question whether Chroma
should enforce *exactly* one video + one audio per group or allow richer groups (Palmier's
"complete existing groups" phrasing suggests groups can be richer than a strict pair) —
recommend allowing any group of 2+ clips spanning at least one video and one audio type,
not hard-coding a strict pairwise cap, matching the real reference's own apparent
flexibility rather than a narrower assumption.

### Phase 3 — the interaction model: default-linked selection/move, with an override

**Real open design question, needs the owner's call, not silently decided here**:
Premiere's two-layer model (a global Linked-Selection toggle + a per-gesture modifier-key
override) is real UI surface Chroma doesn't have anywhere yet, and building a *global
toggle* is a meaningfully bigger UI commitment than Palmier's own tool surface implies is
strictly necessary (Palmier's `manage_clip_links` only exposes permanent link/unlink,
with no documented equivalent of a temporary per-gesture override — genuinely unclear
whether that's because Palmier's MCP surface just doesn't expose a modifier-key concept
to a tool-calling agent, or because Palmier's actual UI genuinely has no such toggle;
this is a real gap in what could be checked from the tool description alone). Two real
options: **(a) match Premiere fully** — a global toggle + Option/Alt override, real UI
work, most power; **(b) a simpler default** — linked clips always move/select together
(no global toggle), with `unlink`/`link` (Phase 2's ops, already real UI-affordance-worthy
on their own) as the *only* way to do an L-cut/J-cut edit — permanently unlink, do the
independent trim, relink afterward. **Recommend (b) for a first pass** — it's the exact
shape Palmier's own tool surface (this repo's real feature bar) already suggests is
sufficient, avoids inventing UI surface no real reference in this codebase's own toolkit
confirms is necessary, and is a strictly smaller, safer increment than building a global
toggle + modifier-key system whose real value here is unconfirmed. If the owner's own
real editing workflow later shows the permanent-unlink-then-relink dance is too slow for
frequent L-cuts, (a) becomes a real, well-scoped follow-up with this phase's own
link_group model already in place underneath it — not a redesign.

**What "selecting/moving a linked clip" means once Phase 1's model exists**: selecting
one member of a `link_group` selects every member (once `docs/notes/multi-select.md`'s
`Selection` is array-shaped — this phase is a real, direct consumer of that model, not
just "sequenced after" it as a courtesy); moving one member (same-track reposition or
cross-track move, D-100's unified `ClipBody` mechanism) moves every member by the same
delta, each landing via its own `resolveClipLanding` against its own track's contents
(members can be on different tracks with different existing clips around the landing
point — each needs its own valid landing, not a shared one). Trimming one edge of one
member does **not** propagate to the other member at all under option (b) — trimming is
exactly the operation `unlink` exists to enable working around; a linked clip's trim
handles behave completely normally, independent of its link, until explicitly unlinked
if the user wants position (not just trim) independence too. Deleting one member: real
open question left for implementation to decide with the owner's input at that point —
does removing one member dissolve the whole group's link (matching `unlink`'s own "the
complete group" semantics extended to an implicit removal) or just remove that one clip
while the rest of the group stays linked? Flagged, not answered, here.

## Backward compatibility

`link_group: Option<String>` with `#[serde(default, skip_serializing_if =
"Option::is_none")]` — a pre-this-feature `project.json` has no clip with this key,
deserializes to `None` (unlinked) for every existing clip, zero behavior change for any
project that predates this feature. No migration pass needed, unlike `sync_locked`'s
doc — this field's absence *is* its own correct default, not a sentinel needing a
backfill step.

## Sequencing

**Third, after both `docs/notes/multi-select.md` (Phase 1) and
`docs/notes/cross-track-ripple-sync-lock.md`** — this doc's own Phase 3 (linked
select/move) is a real, direct consumer of multi-select's array-shaped `Selection`, and a
linked A/V pair spanning a video track and an audio track is exactly the kind of thing
cross-track sync-lock should keep moving together when either track ripples (a real
cross-reference worth building once sync-lock exists, not a hard blocking dependency for
*this* doc's Phase 1/2, which are independent data-model work that could start earlier if
there were a reason to reorder — there isn't; the audit's own priority order (multi-select
→ sync-lock → A/V linking) is the right sequence and this doc doesn't find a reason to
override it).

## Status

Scoped 2026-09-04, not built. Real references checked and cited (Premiere, Palmier's own
`manage_clip_links` tool). One real open design question (global-toggle-with-override vs.
permanent-link-with-explicit-unlink) needs the owner's call before Phase 3 — recommend
option (b), the simpler permanent-link model, as the default unless the owner has a
specific reason to want Premiere's fuller toggle+override system. Phases 1/2 (the model +
the two ops) don't depend on that answer and are the safe starting point.
