# apelles-project

**Layer 2 (project document).** The saved `.chroma` project the launcher opens
(D-037) and everything that reads or rewrites its `project.json` — with no
opinion about Tauri, the GPU, or which project happens to be open right now
(D-148, `docs/notes/crate-extraction-plan.md` §2.3).

- **Deps:** `apelles-types` (`Resolution`), `apelles-timeline` (`Timeline` /
  `Clip` / `Track`), **`apelles-media`** (probe + thumbnail extraction),
  `serde`/`serde_json`, `base64`, `chrono`, `log`, `once_cell`, `uuid`.
  **No `tauri`, no `wgpu`, no `AppState`, no fork types.**
- **Modules:**
  - `manifest` — the model, re-exported at the crate root because it *is* the
    crate: `ProjectManifest` / `ProjectSettings` / `MediaItem` / `ProjectShot`,
    `load_manifest` (+ the D-114 mtime-validated `load_manifest_cached`),
    the atomic `save_manifest` (B-034/D-112), every schema migration
    (`migrate_legacy_timeline`, `migrate_legacy_shots`, the D-136 normalised-
    geometry pass), the media pool + bins (D-044/D-045/D-059) including its two probed source
    kinds (`MediaItem.video` / `MediaItem.image`, mutually exclusive — D-281),
    `migrate_shot_grades_to_clips` and the D-070 unified-clip-identity
    resolution (`resolve_active_clip_index`, `top_wins_clip_index`),
    `list_projects_in` / `new_project_in` / `infer_settings_from_clip`.
  - `timeline` — the project's timeline lifecycle: `ensure_timeline`,
    `load_and_ensure_timeline`, `resolve_timeline`,
    `resolve_timeline_and_settings`. Lifted out of `chroma/edit.rs`, where it
    had been living under an Edit-tab name since D-041 — see that module's doc
    for the call-graph evidence.

## The `apelles-project → apelles-media` edge

`docs/notes/architecture-lock.md`'s dependency table listed this crate as
depending on `types, grade-model, timeline`. The real code also probes and
thumbnails the media it references — `video::probe`, `video::extract_thumb`,
`probe::probe_cached`, and (D-281) `still::probe` / `still::thumbnail` for a
still-image pool item — which after D-146 is `apelles-media`. The edge is
**legal** in the locked graph (L2 `project` → L1 `media`); the table simply
did not list it. D-141's scoping pass found it, D-148 landed it, and the lock
doc's table is corrected. There is **no** `apelles-grade-model` edge: this
crate moves grade *files* around by name during the D-070 migration and never
parses one.

## What it does NOT do

- **Own any `#[tauri::command]`.** Doubly settled here. The general rule is a
  `tauri-macros` constraint (the attribute emits `#[macro_export]`ed macros at
  the *defining* crate's root, so `generate_handler![chroma::project::foo]`
  looks for them at a path they are not at, and the wrapper body expands
  `::tauri::ipc::private::*`) — see `docs/notes/crate-extraction-plan.md` §1.
  On top of that, **all 20** of this module's commands take
  `tauri::State<'_, AppState>`, and `AppState` lives in `app/src-tauri`; a
  crate hosting them would depend on the app crate, a cycle. They stay in
  `app/src-tauri/src/chroma/project.rs` alongside `open_manifest`, which is
  the one function that binds the model to the app's session globals.
- **Hold any process global.** "Which project is open" is `chroma::state` and
  stays app-side (`mask_generation.rs` reads it directly). Every function here
  is handed the project directory. That is why `resolve_timeline(dir, persist)`
  gained a parameter when it moved: `chroma::edit` keeps a wrapper at the old
  signature that supplies `current_project_dir()?`.
- **Decode, grade, or touch the GPU.** Thumbnail regeneration and clip probing
  go out through `apelles-media`.

## Tests

The 59 tests that were in `chroma/project.rs` split by what they actually
exercise, not by where they happened to sit:

- **48 moved here** — the model: manifest round-trips, every schema migration,
  the atomic-save race, the D-114 cache's measured speedup, media-pool /
  folder logic, `has_audio` backfill, the D-070 grade-file migration and clip
  resolution, plus the `#[ignore]`d one-off against the owner's real
  `~/Movies/Chroma/New.chroma`.
- **11 stayed in `app/src-tauri`** — they drive the *command surface*
  end-to-end (`chroma_media_import`, `chroma_media_move`,
  `chroma_media_remove`, `chroma_media_create_folder`,
  `chroma_project_save`, and the `super::super::edit::chroma_timeline_*`
  commands) or the `chroma::state` process globals. That is where they belong;
  a crate cannot reach a `#[tauri::command]`, and it should not want to.
- 5 new tests here cover the `timeline` module directly — it never had unit
  tests of its own while it lived in `edit.rs`.

`make_test_clip` (a `testsrc` fixture via `ffmpeg`) is duplicated between this
crate's tests and the app's. That is pre-existing practice — `chroma/export.rs`
and `apelles_media::probe` each carry their own copy — and consolidating all
four into one `apelles-media` test fixture is flagged in the extraction plan's
§4 rather than done opportunistically here.
