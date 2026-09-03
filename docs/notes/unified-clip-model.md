# Unified clip identity — Edit ↔ Colorist (+ Phase D + the global Inspector)

Scoped 2026-09-03, owner-directed: "look at Resolve — we have one clip we add, we
can move to LUTs and color and we have the same clip, not multiple." Verified
against real code before writing anything below, same discipline as
`multi-track-nle.md`.

## Why this blocks Phase D and the global Inspector, not just a UX nit

The owner's own live testing surfaced this as "Colorist shows nothing even though
I have a shot selected [on the Edit tab]" — reads like a state-sync bug, but it's
structural: there is no single "the clip I'm working on" concept in this app today.
Both Phase D (multi-track UI) and the global Inspector (Motion + NLE property
panel, `docs/notes/` TBD) need to answer "what am I looking at" unambiguously; on
the current model that question has multiple, disconnected answers depending on
which tab asked it. Fixing this first means Phase D and the Inspector get built on
the model they'll actually need, not on the current split with a rewrite later.

## Current state — four representations of "a clip," verified against real code

1. **`state::Shot` (Rust, `app/src-tauri/src/chroma/state.rs` + `session.rs`)** —
   the in-memory decode session: an ordered `Vec<Shot>`, each **keyed by source
   path** (a plain string), plus which index is active. Ephemeral — no
   persistence file of its own (`session.rs`'s own doc: "no session-file
   persistence yet, deferred").
2. **`useSessionStore.shots` / `.grades` (frontend, `app/src/store/useSessionStore.ts`)**
   — mirrors #1 (`shots: SessionShot[]`), plus an in-memory `grades: Record<sourcePath, Adjustments>`
   **keyed by path**, so an "Untitled" session (no project on disk) still has
   working per-shot grades in memory even with nothing persisted.
3. **`ProjectShot` (Rust, `ProjectManifest.shots`, `chroma/project.rs`)** — the
   *persisted* grading list: `{ id, media_id, frame }`. References a `MediaItem`
   by id. This is what `chroma_project_add_shot` ("+ Add to grading" in Sources)
   appends to, and what `_hydrateOpenDto` reads to repopulate #1/#2 on open. Grade
   files persist as `<gradeDir>/<ProjectShot.id>.grade.json` — **keyed by shot id**,
   a third key scheme alongside #1/#2's path-keying.
4. **`chroma-timeline::Clip` (Rust, `crates/chroma-timeline/src/lib.rs`, the Edit
   tab's timeline)** — `{ id, shot_id?, name, source_path, source_start, duration,
   source_len, start_frame }`. Has its own `id` and an *optional* `shot_id`
   back-link, but **references media by a raw `source_path` string, not
   `media_id`** — no structural link to `MediaItem` at all, so a clip already on
   the Edit timeline and a `ProjectShot` for the same underlying file are two
   independently-created records unless something explicitly wires `shot_id`.

**Consequence, confirmed by the owner's own repro:** dragging a clip from Sources
onto the Edit tab's timeline creates a `chroma-timeline::Clip` (#4) — it does **not**
touch `ProjectShot` (#3) at all. Colorist's empty state is gated on `useEditorStore
.selectedImage`, populated only by `applyLoaded`, only reachable via `switchToShot`
(#1/#2) or `_hydrateOpenDto` (#3 → #1/#2). A clip that only exists as #4 is
structurally invisible to Colorist — not a bug in any one of these four, a gap
*between* them, same shape as every other real bug found this session (D-058's
frontend/backend model mismatch, D-063's dead-flag wiring).

## Target model (Resolve-shaped)

One clip identity, flowing through both tabs:

- **The Edit tab's active timeline's clips (#4, `chroma-timeline::Clip`) become
  the single source of truth for "what clips exist in this project."** No
  separate "add to grading" step. `ProjectShot` (#3) is retired as a parallel
  list — its two jobs (referencing a pool item, and being a stable grade-file
  key) move onto `Clip` directly.
- **`Clip` gains `media_id: Option<String>`** (nullable — a clip can exist before
  its source is even in the pool, e.g. a fresh drag that hasn't round-tripped
  through `chroma_media_import` yet; `source_path` stays the ground truth,
  `media_id` is an index/link, same "reference, don't require" discipline
  `folder`/D-045 already uses).
- **Grade storage keys off `Clip.id` directly** — `<gradeDir>/<Clip.id>.grade.json`.
  This is the one genuinely new piece of complexity Resolve's model also has to
  solve: two different trims of the same source file are two different `Clip`s
  with two different ids, so **they grade independently by default** (matches
  Resolve's default "instance" grading — a project-level "apply this grade to
  every clip from this source" action is a real, separate feature, not this
  pass's job, noted as a deferred follow-up below).
- **Colorist grades whichever clip is active at the current Edit-tab playhead
  position** — for a single video track this is unambiguous; **once Phase D
  ships multiple video tracks, "active" means whichever clip wins the existing
  top-wins compositing resolution (`Timeline::resolve_video_clip_at`, D-056)** —
  the same function Phase D's UI needs for rendering, not new logic. This is the
  concrete reason this migration sequences *before* Phase D: building Phase D's
  UI against the current split model (where "gradable" and "on the timeline"
  disagree) would need rework the moment this lands anyway.
- **The shot strip (`ShotStrip.tsx`) becomes a timeline-clip strip** — same visual
  shape (thumbnail + name + a dot for a non-neutral grade), but reads from the
  active `chroma-timeline::Timeline`'s clips instead of `useSessionStore.shots`.
  Click a clip → Colorist grades it. "Add shots" (today: opens a file picker,
  imports + appends to the session) becomes secondary to drag-from-Sources,
  which already does the real job on the Edit tab.

## Migration — real steps, in order

1. **`chroma-timeline::Clip.media_id: Option<String>`** — additive, `#[serde
   (default)]`, no migration needed for existing `project.json` (absent = `None`,
   resolved lazily by path if ever needed, same discipline `Clip.shot_id` already
   uses).
2. **Grade-file migration, one-time, on project open.** For each existing
   `ProjectShot`, find the `chroma-timeline::Clip`(s) referencing the same
   `media_id`/`source_path` on the active timeline. If exactly one match: rename/
   copy `<gradeDir>/<ProjectShot.id>.grade.json` → `<gradeDir>/<Clip.id>.grade.json`.
   If zero or multiple matches (a shot with no corresponding timeline clip yet —
   real for any project graded before this pass shipped, since "add to grading"
   never required the clip to also be on the Edit timeline): **surface these
   explicitly to the owner** (a migration report, not a silent drop) rather than
   guessing or discarding a real grade. This is the one genuinely risky step —
   test against the owner's real `~/Movies/Chroma/New.chroma` project.json before
   calling it done, not just synthetic fixtures.
3. **`useSessionStore` rewrite.** `shots`/`switchToShot`/`addShots`/`removeShot`
   swap their source from `state::Session` (path-keyed) to the active
   `chroma-timeline::Timeline`'s clips (id-keyed, already has `start_frame`/
   `duration`/trim state Phase A gave it). `grades` keys off `Clip.id`. The
   in-memory decode session (#1, `state::Shot`) likely still exists underneath
   (something has to hold decoded frames/GPU state) but stops being the
   *authoritative* list — it becomes a cache keyed by clip id, populated on
   demand.
4. **`ShotStrip.tsx` → reads the active timeline's clips.** "Add to grading" (the
   `+` on a Sources card, `chroma_project_add_shot`) either goes away (drag-to-
   Edit-timeline is now the one real "this clip exists in my project" action) or
   becomes a convenience shortcut that does the drag for you — decide during
   implementation, not a blocker for the scoping doc itself.
5. **Multi-track interaction (ties to Phase D).** Once more than one video track
   exists, Colorist's "active clip" resolution calls `resolve_video_clip_at` at
   the current playhead, same as the preview does — build this as one shared
   function both the preview *and* Colorist call, not two copies that can drift.

## Explicitly deferred, not this pass

- **"Apply this grade to every clip from the same source"** (Resolve's source-
  level grade vs per-instance grade) — real feature, real UI (a toggle or a
  right-click action), not required for the base unification.
- **The `state::Shot`/decode-session layer's own possible retirement** — once
  everything reads off `chroma-timeline::Clip`, whether the in-memory decode
  session still needs its own parallel `Vec` or can be a plain per-clip-id cache
  is an implementation detail worth revisiting once the rewrite is in front of
  someone, not decided here.
- **Colorist working on a clip that isn't on any Edit-tab timeline at all**
  (a bare loose-clip "Untitled" session, opened by picking a file directly, no
  project) — stays supported as its own thing, same as today; this migration is
  about the *project* case where an Edit timeline exists.

## Sequencing (confirmed with the owner, 2026-09-03)

1. **This doc's migration** — data model + `useSessionStore` rewrite +
   grade-file migration. Blocks the other two cleanly.
2. **Phase D (multi-track UI)** — track lanes/headers/drag-between-tracks. Now
   built against the real "active clip = compositing winner" model instead of
   something that'll need rework.
3. **Global Inspector** — Motion-side can start in parallel with either of the
   above (its property surface doesn't depend on this migration at all — see the
   Inspector's own scoping note). NLE-side Inspector needs both this migration
   (a stable clip identity to attach properties to) *and* Phase B3 (real
   position/scale/rotation/opacity compositing — `Clip` has zero transform
   fields today, confirmed by reading the struct directly) — the two are the
   same underlying compositor work, not separable.
