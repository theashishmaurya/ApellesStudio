# notes/project-model.md — the Chroma project launcher + `<name>.chroma`

Built 2026-09-02. See **D-037** (the decision), **D-033** (the multi-shot
`Session` this loads into), **D-025** (`grade.json`, unchanged), `docs/09` §
Divergence log.

Replaces RapidRAW's inherited folder-browser + photo-grid **Library view** as
the default landing screen with a **project launcher** — a grid of saved Chroma
projects, click to open.

## What shipped

### Rust — `engine/src-tauri/src/chroma/project.rs` (new, self-contained)

Pure `serde_json` + `std::fs`. No GPU, no `AppState`, no store mutation — same
discipline as `grade.rs`.

| command | does |
|---|---|
| `chroma_project_list()` | scan the projects folder → `[{name, path, modified, modifiedEpoch, shotCount, thumb?}]`, newest first. `thumb` is an inlined `data:` URL of `thumb.jpg` (no asset-protocol scope change). |
| `chroma_project_open(path)` | read `project.json`, probe each shot, load the online ones into the D-033 `Session`, install the active shot's frame. Returns every shot (manifest order) with `offline` flagged + `gradeDir`. |
| `chroma_project_new(name, mediaPaths)` | sanitise the name → `<name>.chroma/` + `grades/` + `project.json` (one shot per path) → then `open` it. Errors if the name is taken. |
| `chroma_project_save(path?, shots, activeShot)` | rewrite `project.json` (`modified` bumped), then regenerate `thumb.jpg` from the active shot's current frame (`video::extract_thumb`, 360 px, best-effort). `path` defaults to the loaded project (`state::ProjectRef`). |
| `chroma_project_relink(path?, shotId, newPath)` | rewrite that shot's `sourcePath` in the manifest, then reopen. |
| `chroma_project_current()` | `{name, path}` of the loaded project, or `null` — backs `get_state().project`. |
| `chroma_project_settings_dir()` / `chroma_project_set_dir(dir)` | read / set the projects-folder override (persisted to `~/.chroma/config.json`). |

`state.rs` gains a `ProjectRef { path, name }` module-global (`set_project` /
`current_project`) so save knows where to write. `current_video()` is unchanged.

Upstream footprint: `chroma/mod.rs` +2, `lib.rs` +8 `generate_handler!` lines.

### Frontend — `engine/src/`

- **`components/chroma/ProjectLauncher.tsx`** — "Welcome to Chroma" + "My
  Projects" grid of `ProjectCard`s (thumb + name + `relTime(modified)` + shot
  count), a "＋ New Project" card (name field + multi-select video picker), and a
  "Projects folder" control (shows the path, directory picker → `set_dir`).
  App tokens, styled like `ShotStrip` / `AgentActivityDock`.
- **`hooks/useProjectAutosave.ts`** — mounted once in `App.tsx`. Subscribes to
  `useEditorStore.adjustments` + `useSessionStore` shots/active; once a
  non-Untitled project is loaded, a 1.5 s debounced `saveProject()` writes
  `project.json` + the active shot's `grade.json` + `thumb.jpg`.
- **`store/useSessionStore.ts`** (D-033) extends with `projectPath` /
  `projectName` / `gradeDir` / `dirty` / `shotIds` (path→id) / `offlineShots`
  and thunks `openProject` / `newProject` / `saveProject` / `saveUntitledAs` /
  `relinkShot` / `markDirty` / `_hydrateOpenDto`. `switchToShot` now also
  flushes the outgoing shot's `grade.json`; `addShots` / `removeShot` keep
  `shotIds` in sync + mark dirty.
- **`store/useUIStore.ts`** — default `activeView: 'library'` → `'projects'`.
- **`App.tsx`** — one routing conditional: `activeView === 'projects'` renders
  `<ProjectLauncher/>`, everything else keeps rendering `<LibraryView/>`. The
  editor "back" button (`useAppNavigation`) returns to `'projects'`.
- **`hooks/useChromaControl.ts`** — ops `list_projects` (READ_ONLY),
  `open_project` / `new_project` (NAV), `save_project` (READ_ONLY);
  `get_state().project`.
- **`components/chroma/ShotStrip.tsx`** — offline shots render as amber "media
  offline" cards with a Relink button; a "Save project" pill when the session is
  Untitled.

### MCP — `mcp/server.py`

`list_projects` / `open_project(name_or_path)` / `new_project(name,
media_paths?)` / `save_project()`. **33 → 37 tools.**

## The v1 project shape

```
~/Movies/Chroma/<name>.chroma/
  project.json
  thumb.jpg
  grades/
    <shotId>.grade.json          # D-025 format, verbatim
    <shotId>.mattes/<subId>.png  # static mask mattes (D-025 $matte externalisation)
```

```jsonc
// project.json
{
  "schema": "chroma.project/1",
  "name": "Beach shoot",
  "created":  "2026-09-02T10:00:00+00:00",
  "modified": "2026-09-02T14:33:07+00:00",
  "shots": [
    { "id": "9f1c…", "sourcePath": "/Volumes/RAID/beach/A001.mov", "frame": 0, "name": "A001.mov" }
  ],
  "activeShot": 0,
  "settings": {}
}
```

- Versioned + a `chroma.project/<major>` gate (untagged → v1; newer major →
  "Upgrade Chroma"), same as `grade.json`.
- **Media is referenced, never copied.** `sourcePath` is absolute.
- **Grades live in the project** (`grades/<shotId>.grade.json`), not beside the
  clip — the grade belongs to the project, the media might be read-only / shared.
  D-025's `$trackDir` / `$depthDir` still point at `.chroma/mattes|depth/` next
  to the **source clip** (per-clip precomputes, not per-project).

### Media offline but grade intact

A shot whose `sourcePath` no longer resolves: kept in the manifest, shown as a
"media offline" card, **not** loaded into the Rust `Session`. Its
`grades/<id>.grade.json` is left alone. **Relink** (`chroma_project_relink`)
rewrites `sourcePath` and reopens — the grade reattaches by shot id.

## Quick-open (no ceremony)

A loose clip via the file picker or MCP `open(path)` with no project loaded → an
in-memory **"Untitled"** session. Seeks / plays / exports / tracks exactly as
before (D-033). `saveUntitledAs(name)` turns it into a real project from the
loaded shots. Autosave is off until then.

## Open manual smoke test

The `useEffect([])` bridge listener doesn't hot-reload and the running app was
not driven — verify by hand:

1. Launch → the launcher lists `~/Movies/Chroma/*.chroma`, newest first, with
   thumbnails.
2. **New Project** → name + pick 2 clips → opens in the editor, shot strip shows
   both, active = the first.
3. Grade shot 1 (exposure + WB). Wait ~2 s → `project.json` `modified` bumps,
   `grades/<id1>.grade.json` written, `thumb.jpg` regenerated.
4. Switch to shot 2, grade it, switch back → shot 1's grade restored;
   `grades/<id2>.grade.json` written on the switch.
5. Back to launcher → the card's timestamp is "just now" and the thumb updated.
6. Quit + relaunch → open the project → both shots + both grades + the active
   shot restored.
7. Move/rename one source file on disk → reopen → that shot is "media offline";
   **Relink** to the moved file → it loads, its grade is back.
8. `Change` the projects folder → the grid rescans the new location.
9. MCP: `list_projects` → the grid; `open_project("Beach shoot")` → editor;
   `new_project("test", ["/x.mov"])` → created + opened; `save_project()` → ok.
10. MCP `open("/loose/clip.mov")` with no project → `get_state().project` is
    `{name:"Untitled", …}`; seek / export still work.

## Deferred (roadmap follow-ups)

- Project rename / delete / duplicate from the launcher; a project search box.
- Drag a clip onto the window → Untitled quick-open.
- A "Projects folder" row inside the big `SettingsPanel` (the launcher has its
  own control for now).
- Batch the open-time per-shot decode (v1 decodes each online shot once on open).
- ShotStrip currently hides when every shot is offline (no active clip) — relink
  from that state is only reachable via the launcher reopening the project.
