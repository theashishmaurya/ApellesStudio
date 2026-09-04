# Real A/V linking — scoped 2026-09-04, **built 2026-09-04 (D-129)**

Roadmap item 13, priority #3 per `docs/notes/timeline-feature-audit.md` (D-105).

**Status: Phase 1 (the `link_group` model) and the link-aware ops are built and
shipped as D-129, together with the thing this doc originally listed as a
blocking prerequisite** — turning D-050's embedded video audio into a real,
separate, linkable `Clip`. The scoping below is kept, annotated, because the
reference research behind it is still the justification for the shape that
landed; where the implementation deliberately departs from the original
recommendation, that's called out inline and in D-129.

## The real gap, precisely (as it was before D-129)

Chroma's model had exactly two states, both all-or-nothing:
- **Audio embedded inside a video clip** (D-050) — inseparable. Always plays
  together, can never be independently trimmed, moved, or selected. There was
  no "audio half" to address at all; not a second `Clip`, just a stream
  `chroma::audio` read directly off the video clip's own source file.
- **A fully independent audio-track clip** (D-057) — zero relationship to any
  video clip. Nothing in the app ever created one.

Neither state could represent an L-cut or J-cut, and neither could give the
owner what every real NLE does by default: **drop a clip on V1, get its audio
on a linked A1.**

## Real references checked (not assumed)

- **Premiere Pro.** A clip imported to the timeline has "audio and video …
  [on] their independent track, but they are linked together. All the editing
  you do will be on the linked clip; if you click on either and drag, the
  linked clips will move as one." Track targeting patches a dropped clip to
  **V1 and A1** by default. `Clip > Unlink` (⌘L) breaks the pair. The Razor
  Tool on a linked clip "cuts both tracks at once"; to cut only one you
  "unlink the clip first." Premiere additionally has a **global Linked
  Selection toggle** plus an Option/Alt per-gesture override — real UI surface
  Chroma does not have.
- **DaVinci Resolve.** "When clips are linked, any changes made to one (such
  as **moving, trimming, or deleting**) will automatically apply to the
  other." Unlink via right-click → *Unlink Clips*, ⌘⇧L, or the chain-link
  **Linked Selection** toggle above the timeline; relink by selecting both and
  choosing *Link Clips*. "Unlinking lets you trim, delete, or reposition
  either component without touching the other … essential for techniques like
  L-cuts."
- **Palmier Pro's `manage_clip_links`** (its real MCP tool description, loaded
  directly — this repo's own stated feature bar): `link` "merges the complete
  existing groups touched by clipIds and requires at least two clips of
  different media types"; `unlink` "accepts one or more members and dissolves
  each member's **complete** link group." Two facts worth designing around:
  linking is **group-based, not pairwise**, and unlink dissolves the whole
  group rather than peeling one clip out of it.

Two things the references settle that this doc originally left open:
1. **The audio half is a genuinely separate, independently-editable `Clip`**
   that unlink makes fully independent — not a sub-part of the video clip.
   That is what made "make the audio a real `Clip`" the right model change
   rather than a workaround.
2. **Trims propagate by default.** This doc's Phase 3 originally recommended
   that trimming NOT propagate, with unlink as the only route to an L-cut.
   Resolve's own documentation says the opposite in as many words ("moving,
   trimming, or deleting"). **D-129 follows the reference, not the original
   recommendation** — see "What was built" below.

## What was built (D-129)

### The model — `link_group: Option<String>` on `Clip`

As originally recommended: group-based (matching Palmier's "complete existing
groups"), the same `Option<String>` back-link shape `Clip::media_id` already
uses, `#[serde(default, skip_serializing_if = "Option::is_none")]` so a
pre-D-129 clip has no key and deserializes to `None`. Mirrored in
`packages/editor/src/timeline.ts` as `link_group?: string | null`.

**One thing the scoping did not anticipate:** on a *video* clip the field also
means "**this clip's audio has been externalized — do not play its embedded
stream**." That is what resolves the collision with D-050: without it, a
dropped clip's audio would play twice (once from the video clip's own embedded
decode, once from the linked audio clip) and sum with itself. It is not two
concepts in one flag — "this video clip's sound lives in a separate, linked
clip" is a single fact, and it is exactly what a linked A/V pair means in
either reference. See `chroma::audio::chroma_audio_play`.

The suppression is **unconditional**, not conditional on the linked half
actually covering the playhead: if the user slipped the audio half away (an
L-cut), the picture is correctly silent there; if they deleted it, the clip
stays silent — which is precisely what Premiere and Resolve do with a deleted
audio half. `unlink` is the way back to embedded playback.

### Creating the pair — the drop path

`@chroma/editor`'s `linkedClipsFromDraggedMedia` builds **two** `Clip`s from
one dragged pool item when the source has audio, sharing one `link_group`;
`applyOp`'s `add_clip` op takes the audio half as `linkedAudio` and places it
itself. **One op, not two chained ones** — one history entry, one undo, and
never a half-linked timeline in between.

Track selection/creation reuses the real `add_track` shape (D-095/096/117),
not a second mechanism: `ensureAudioTrackWithRoom` takes the first unlocked
audio track free at the landing frame, and appends a new one only when none
is. A fresh track is always free, so **there is no failure branch** — a
dropped clip's audio half always lands somewhere valid. When the video
insert ripples, the audio track (sync-locked by default, D-106) has already
been rippled by the same amount, so the existing track is normally reused
rather than a new one piling up.

The same pairing was added to `chroma::project::append_media_clip`, the
Rust-side clip-creation path (Colorist's "add to grading", the ShotStrip "+"),
so which entry point created a clip never changes whether it has an audio half.

### The missing signal — `MediaVideoInfo::has_audio`

D-097 explicitly flagged that `MediaItem`/`DraggedMedia` carried **no**
audio-vs-video signal and that fixing it needed "a real backend model change."
That change is here: `has_audio: Option<bool>` on `MediaVideoInfo`, set at
import, surfaced through `MediaItemDto` → `@chroma/bridge`'s `MediaItem` →
the Sources-panel drag payload. `None` is a real "never probed" sentinel (a
bare `bool` would read every pre-D-129 pool item as *silent*), resolved once
by `backfill_has_audio` on the next `chroma_media_list` and persisted.

### Link-aware ops — lockstep or reject

`move_clip`, `trim_start`, `trim_end`, `split` and `remove` each apply to
**every** member of a clip's group or to none of it, in both the Rust crate
and `timeline.ts`, mirrored field-for-field as every other op is:

| op | behaviour | reference |
| --- | --- | --- |
| `move` | every member shifts by the same delta, each staying on its own track | Premiere "click either and drag, the linked clips move as one" |
| `trim_start` / `trim_end` | every member takes the identical clamped delta | Resolve "trimming … automatically applies to the other" |
| `split` | every member cut at the same frame; the two halves are two *intact* pairs (left keeps the group, right halves move to `{group}·{frame}`) | Premiere "the Razor Tool cuts both tracks at once" |
| `remove` | every member deleted; each emptied track pruned | Resolve "…or deleting…" |
| `unlink` | dissolves the **complete** group | Palmier's own `unlink` semantics; Premiere `Clip > Unlink`; Resolve *Unlink Clips* |

**When an op cannot be applied identically to every member it is rejected
whole** (`TimelineError::LinkDesync`, a no-op on the TS side) rather than
partially applied: a trim that would clamp differently on one half, a landing
that would overlap something on a sibling's track, a split frame not inside
every member. That is the same reject-rather-than-corrupt discipline B-033
established after auto-split silently fragmented a real project. `unlink`
first if divergence is what's actually wanted — which is exactly what unlink
exists for in both references.

Validation happens **before any mutation**, using `start_after_ripple` to
predict where a pending ripple will leave each clip, so no rollback or
whole-timeline clone is needed. Siblings are then repositioned by their stable
`Clip::id`, never by an index captured before the mutation invalidated it.

### Interaction model — option (b), as recommended

This doc's Phase-3 open question (Premiere's global Linked-Selection toggle +
modifier override, vs. permanent-link-with-explicit-unlink) was resolved as
recommended: **option (b)**. Linked clips always move/trim/split/delete
together; `unlink` is the only escape hatch, surfaced as a real toolbar action
that appears only when the selection is actually linked. Selecting one half
paints a dashed accent outline on the other (`linkedClipIds`), deliberately a
different visual from the sync-lock highlight — sync-lock means "these tracks
ripple together," an A/V link means "these clips *are* one shot."

The "deleting one member" question this doc left open is answered by the
references rather than invented: deleting one member deletes the whole group.

### Backward compatibility

- **Existing clips**: no `link_group` key → `None` → every op behaves exactly
  as it did before D-129, and `chroma_audio_play` takes the unchanged D-050
  embedded path. Covered by real tests on both sides. **No migration pass, and
  deliberately none**: retroactively splitting every existing video clip's
  audio onto a new track would rewrite the user's timeline layout without
  being asked, which is a much bigger imposition than leaving old clips as
  they are. Re-dropping a clip is the (real, cheap) way to opt one in.
- **Existing pool items**: `has_audio: None` → backfilled once, automatically,
  on the next media list (see above), so an existing project's media starts
  producing linked audio halves on drop with no manual re-import.
- **`selectedGap`**: `timelineStore` used to remap a selected gap's track index
  across a prune. A linked delete can prune two tracks at indices the op never
  names, so that remap has no sound basis any more and a gap selection is now
  cleared on any track-count change. Clip selections still follow the prune —
  by stable id now, which is correct for any op. Deliberate contract change,
  documented in the store and its tests.

## Deferred, with reasons

- **A manual `link` op** (link two already-independent clips into a group,
  Palmier's own `link` / Premiere's `Clip > Link`). The model is group-shaped
  and ready for it; nothing in the owner's ask needed it, and `unlink` is the
  half that a shipped feature genuinely can't do without. Roadmap item.
- **Relink after unlink** — same thing, same reason.
- **A ripple-insert of a linked pair onto a track whose audio side is NOT
  sync-locked.** It rejects rather than guessing at room that was never made.
  Turning sync-lock back on, or closing the gap manually, both work today.
- **Premiere's global Linked-Selection toggle + per-gesture Option/Alt
  override.** Real UI surface Chroma has nowhere else; option (b) is a
  strictly smaller increment and this doc's own recommendation. If the
  unlink/relink dance turns out to be too slow in the owner's real editing,
  the toggle is a clean follow-up on top of the `link_group` model, not a
  redesign.
- **An MCP/Tauri `unlink` command.** The frontend's `applyOp` +
  `chroma_timeline_set` is the real edit path; the Rust `Timeline::unlink` is
  built and tested, so exposing it is a one-liner when the MCP surface wants it.
