# notes/project-model.md — the Apelles project launcher + `<name>.chroma`

Built 2026-09-02. See **D-037** (the decision), **D-033** (the multi-shot
`Session` this loads into), **D-025** (`grade.json`, unchanged), `docs/09` §
Divergence log.

Replaces RapidRAW's inherited folder-browser + photo-grid **Library view** as
the default landing screen with a **project launcher** — a grid of saved Apelles
projects, click to open.

## What shipped

### Rust — `app/src-tauri/src/chroma/project.rs` (new, self-contained)

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
| `chroma_project_set_settings(path?, partial)` | **(D-038)** partial-merge `partial` (`{width?, height?, fps?, colorSpace?}`; explicit `null` clears a field) into the manifest's `settings`, save `project.json`, return the merged `ProjectSettings`. |

`state.rs` gains a `ProjectRef { path, name }` module-global (`set_project` /
`current_project`) so save knows where to write. `current_video()` is unchanged.

Upstream footprint: `chroma/mod.rs` +2, `lib.rs` +8 `generate_handler!` lines.

### Frontend — `app/src/`

- **`components/chroma/ProjectLauncher.tsx`** — "Welcome to Apelles" + "My
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
  **(D-039 step 6c)** → `'editor'`: the launcher is shell-level now, not a view
  inside the Colorist tab, so `<App/>` always has a project open.
- **`App.tsx`** — one routing conditional: `activeView === 'projects'` renders
  `<ProjectLauncher/>`, everything else keeps rendering `<LibraryView/>`. The
  editor "back" button (`useAppNavigation`) returns to `'projects'`.
  **(D-039 step 6c)** — the `'projects'` branch is gone; `App.tsx` renders
  `<LibraryView/>` directly and "back" → `'library'`.

> **Update (D-039 step 6c, 2026-09-02):** the launcher moved **out of the
> Colorist tab up to `@apelles/shell`**. The app opens on `<ProjectLauncher/>`
> full-window with no tab bar; `useSessionStore.projectPath` (or `projectName`
> for an Untitled quick-open) being set flips `<Shell>` into the 3-tab layout,
> and a chrome-bar "‹ Projects" button calls the new `useSessionStore.closeProject()`
> to come back. `<Shell>` takes `projectOpen` / `launcher` / `onCloseProject`
> props (the shell never imports `ProjectLauncher` — app → shell only); the
> routing lives in a small `Root` in `app/src/main.tsx`. Tab panels stay mounted
> under the launcher so the MCP control bridge keeps serving `open_project`.
- **`hooks/useChromaControl.ts`** — ops `list_projects` (READ_ONLY),
  `open_project` / `new_project` (NAV), `save_project` (READ_ONLY);
  `get_state().project`. **(D-038)** op `set_project_settings` (READ_ONLY);
  `get_state().project.settings`.
- **`components/chroma/ShotStrip.tsx`** — offline shots render as amber "media
  offline" cards with a Relink button; a "Save project" pill when the session is
  Untitled. **(D-038)** a "Settings" gear (real projects only) opens
  `ProjectSettingsModal`.
- **`components/chroma/ProjectSettingsModal.tsx`** **(D-038)** — resolution
  (preset / custom W×H / "match first clip"), fps (preset / custom / match),
  colour-space dropdown with a "display / metadata only for now" hint. Calls
  `setProjectSettings(partial)`.
- **`store/useSessionStore.ts`** **(D-038)** — `ProjectSettings` type,
  `projectSettings` state (hydrated from `_hydrateOpenDto`'s `dto.settings`),
  `setProjectSettings(partial)` thunk (→ `chroma_project_set_settings`).

### MCP — `mcp/server.py`

`list_projects` / `open_project(name_or_path)` / `new_project(name,
media_paths?)` / `save_project()` (D-037). **(D-038)**
`set_project_settings(width?, height?, fps?, color_space?)` — partial merge.
**33 → 37 → 38 tools.**

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
  "settings": {
    // D-038 — per-project output spec. Every field optional; absent/omitted =
    // clip-derived (the pre-D-038 behaviour everywhere). A fresh project seeds
    // width/height/fps by probing the first shot's clip.
    "width": 3840,
    "height": 2160,
    "fps": 23.976,
    "colorSpace": "rec709"   // stored + surfaced ONLY — colour management is D-004
  }
}
```

- Versioned + a `chroma.project/<major>` gate (untagged → v1; newer major →
  "Upgrade Apelles"), same as `grade.json`. **D-038's `settings` shape is additive
  — schema major stays `1`.** `ProjectSettings` deserializes leniently: a legacy
  `settings: {}` or `settings: { "fps": 24 }` still loads (missing keys → `None`,
  unknown keys ignored).
- **`settings` (D-038)** — `{ width?, height?, fps?, colorSpace? }`, all optional.
  Export resizes the graded composite to `width`×`height` as its final step and
  uses `fps` as the encoder timebase; with no settings the export is
  byte-identical to before. `colorSpace` (`rec709`/`rec2020`/`dci-p3`/`srgb`) is
  stored + shown in the "Project settings" modal but does not affect grade math —
  a colour-managed pipeline is D-004. Set via `chroma_project_set_settings` /
  MCP `set_project_settings` / the shot-strip gear.
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
11. **(D-038)** New Project from a 4K clip → open the shot-strip **Settings**
    gear → resolution/fps are pre-filled from that clip, colour space `Rec.709`.
12. **(D-038)** Set resolution to `1920 × 1080`, Save → `project.json`
    `settings.width/height` = `1920/1080`. Export a short range → the output MP4
    is 1920×1080 (`ffprobe`).
13. **(D-038)** Set resolution back to "Match first clip", Save → `settings.width`
    gone → export matches the clip's native resolution again.
14. **(D-038)** MCP `set_project_settings(fps=25)` → merged settings returned;
    `get_state().project.settings.fps` = 25; an export with no explicit fps uses
    25 as the encoder rate.

> If a fresh `chroma_project_set_settings` isn't reachable from the running app,
> the dev binary has a stale cargo incremental fingerprint — `cargo clean -p
> RapidRAW` + restart the dev server.

## Deferred (roadmap follow-ups)

- Project rename / delete / duplicate from the launcher; a project search box.
- Drag a clip onto the window → Untitled quick-open.
- A "Projects folder" row inside the big `SettingsPanel` (the launcher has its
  own control for now).
- Batch the open-time per-shot decode (v1 decodes each online shot once on open).
- ShotStrip currently hides when every shot is offline (no active clip) — relink
  from that state is only reachable via the launcher reopening the project.
