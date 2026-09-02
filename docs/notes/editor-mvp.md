# Editor tab MVP (D-041)

The first real cut of the Edit tab — a working timeline. Deliberately bounded.

## In

- **Model** (`crates/chroma-timeline`, made real):
  - `Timeline` / `Track` / `Clip` (serde, our own plain JSON — **not** OTIO yet).
    `Clip` has a stable `id`, an optional `shot_id` back-link, and `source_len`
    (media frame-count ceiling for trims).
  - `Timeline::from_shots(&[(id, source_path, name, source_frame_count)])` — one
    video track, each shot a full-length clip back to back. Caller supplies frame
    counts; the crate probes nothing.
  - Position helpers: `Track::clip_at(timeline_frame) -> Option<(&Clip, source_frame)>`,
    `Timeline::duration()`.
  - Edit ops (each `Result<(), TimelineError>`, each unit-tested): `reorder`,
    `trim_start`, `trim_end`, `split`, `remove`.
- **Bridge** (`app/src-tauri/src/chroma/edit.rs`):
  - `chroma_timeline_get()` — persisted timeline, or build-from-shots (probing
    each source here) + persist.
  - `chroma_timeline_set(timeline)` — replace + persist to `project.json`.
  - `chroma_timeline_frame(pos, max_long_edge?)` — resolve `pos` → `(clip,
    source frame)` → `decode_pipe::playback_frame_scaled` → JPEG q80 → `data:`
    URL. Out-of-range → 1×1 transparent PNG.
  - Persisted **in the `.chroma` project**: `ProjectManifest.timeline:
    Option<Timeline>` (`#[serde(default)]`, additive, schema major unchanged).
    **Superseded by D-045** (2026-09-02): the field is now `timelines:
    Vec<Timeline>` + `active_timeline: usize` — multiple named timelines, one
    active, migrated losslessly from this singular shape. The three commands
    above kept their names/signatures and now transparently target whichever
    timeline is active; behaviour for a single-timeline project (still the
    common case — no UI to make more than one yet) is unchanged.
- **UI** (`packages/editor`):
  - Preview pane: `<img>` fed by `chroma_timeline_frame`, transport bar
    (play/pause, step ±1, timecode, res note), wall-clock rAF play loop with
    frame-dropping.
  - Timeline: `@xzdarcy/react-timeline-editor`, one row. Drag body → `reorder`;
    drag edge → `trim_start` / `trim_end`; "Split at playhead" → `split`; select
    + Delete / "Remove clip" → `remove`. Each edit → `useEditorTimelineStore`
    optimistic op → debounced (~400 ms) `chroma_timeline_set` → `chroma_timeline_get`
    refetch.
  - Empty state when no project is open.

## Deferred (later tracked steps)

- multi-track (video + audio lanes, N video tracks)
- audio (symphonia/cpal/rubato per D-039)
- transitions (cross-dissolve etc.)
- transcript cut (whisper word-timestamps → EDL)
- GPU compositing (`chroma-compositor`)
- grade-in-the-preview (the editor preview stays a plain decode; grade comes with
  the compositor)
- OTIO (`.otio`) interchange export — the model is OTIO-*shaped* but serialises
  as our own JSON for v1
- MCP tools for timeline edits
- editor fps from project `settings.fps` (currently defaults to 24 —
  `from_shots` leaves `rate: None`)
- gaps in the model (clips are strictly back to back)
- `@chroma/bridge` extraction of `useEditorTimelineStore`
