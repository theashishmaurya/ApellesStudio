# Multi-shot session + shot strip (D-033)

Round-3 item 2. Chroma held one clip; a grading job is N shots from one shoot,
each with its own grade, flip-between-able, grade-copyable.

> **Update (D-037, 2026-09-02):** the "no session file / deferred
> `.chroma/session.json`" call below is superseded. Sessions now persist as a
> **project** — a `<name>.chroma` directory (`project.json` + `thumb.jpg` +
> `grades/<shotId>.grade.json`), opened from a **project launcher** that
> replaces RapidRAW's Library view as the home screen. The in-memory `Session`
> here is unchanged — it's the *loaded form* of a project. Per-shot grades now
> live **inside the project** (`grades/`), not as a sidecar next to the clip.
> See `docs/notes/project-model.md` and **D-037**.

## Decision: lightweight, in-memory

See D-033 for the full lightweight-vs-bundle analysis. Short version: a `.chroma`
project bundle is a subsystem (format + serializer + migrator + save/open UX +
conflict rules with the `grade.json` sidecars that already exist). The project's
bias ("cheapest thing that works", minimal fork diff, docs-as-truth, one shared
state) points hard at the small build. So:

- a process-global **`Session { shots: Vec<Shot>, active }`** in `chroma/state.rs`
- **per-shot grade** = the existing `grade.json` sidecar (D-025), plus an
  in-memory `useSessionStore.grades[path]` cache so switching doesn't need a disk
  round-trip
- **no session file** yet — reopening a session (a `.chroma/session.json` that is
  *just a shot-path list*) is a deferred follow-up, not a bundle

## Data model

### Rust — `chroma/state.rs`

```
Shot        = CurrentVideo { path, info: VideoInfo, frame }   (name kept for the
                                                               D-015…D-032 callers)
Session     = { shots: Vec<Shot>, active: usize }
```

- `current_video() -> Option<Shot>` — **unchanged signature**, returns
  `shots[active]`. Every legacy caller (`chroma_seek`, `export`, `mask`,
  `playback`) keeps working with no edit.
- `set_current_video(Some(shot))` — **upsert by path**: a path already in the
  session is replaced in place and made active (a seek, a re-open); a new path is
  appended and made active. Returns whether the *active clip path* changed.
- `set_current_video(None)` — clears the whole session.
- thumb cache + `decode_pipe::reset()` fire iff the active clip path changed —
  same trigger as the single-clip days, now off the session.
- `Session` is a pure struct with unit tests (`upsert` / `set_active` / `remove`
  clamp semantics); the module-global wrappers add the cache invalidation so the
  pure model stays parallel-test-safe.

`remove(index)`: the active index clamps toward 0 so it keeps pointing at the
same shot where possible; removing the last shot empties the session.

### Rust — `chroma/session.rs` (commands)

| command | does |
|---|---|
| `chroma_session_list()` | `{shots: [ShotDto], active, count}` |
| `chroma_session_add(paths)` | probe + append each, switch to the last, decode its frame 0 |
| `chroma_session_set_active(index)` | flip active, decode that shot's playhead frame into `AppState.original_image` |
| `chroma_session_remove(index)` | drop a shot; decode the new active (or report empty) |
| `chroma_session_thumbnail(index, height?)` | one small preview JPEG (data URL) for the strip |

`add` funnels through `load::load_video_frame` (same path the file picker uses) —
opening a second clip through the normal flow already appends a shot, so `add`
is mostly for the MCP agent and the strip's "+" button.

### Frontend

- **`store/useSessionStore.ts`** — `shots`, `activeIndex`, `grades: Record<path,
  Adjustments>` (fills as you switch away from a shot), and thunks:
  `syncFromRust` (reconcile after the normal open flow), `switchToShot`,
  `addShots`, `removeShot`, `copyGrade(from, to)`.
  - `switchToShot`: stash the live editor grade under the outgoing shot's path →
    `chroma_session_set_active` → `setEditor({adjustments})` + `resetHistory` with
    the target's stashed grade (or `INITIAL_ADJUSTMENTS`) → refresh
    `useChromaStore.videoInfo` → `useAgentStore.scopeToShot(path)` →
    `bumpFrameNonce`.
- **`store/useAgentStore.ts`** — `+ activeShotKey`, `+ shotFeeds: Record<path,
  entry[]>`, `+ scopeToShot(key)`: parks the current feed under the old key,
  restores the target's (empty if unseen). The D-032 feed is now per-shot.
- **`components/chroma/ShotStrip.tsx`** — a horizontal strip: thumbnail +
  filename + an accent dot when the shot has a non-neutral grade; click to
  switch, `×` to remove (only shown when >1 shot), `→` on the active card to copy
  its grade to the next shot, `+` to add clips (file dialog → `addShots`). Plain
  elements + app tokens, like `ChromaTimeline`. Rendered by `BottomBar` above the
  filmstrip whenever the session is non-empty.
- **`hooks/useChromaControl.ts`** — ops `list_shots` (READ_ONLY), `set_active_shot`
  / `add_shots` (NAV — not logged to the feed, a switch restores that shot's own
  feed); `get_state` returns `session: {shots, active}`.

## MCP

`list_shots()`, `set_active_shot(index?, path?)`, `add_shots(paths)` — thin
wrappers over the bridge ops. Grade shot by shot in one session:

```
add_shots(["/shoot/A001.mov", "/shoot/A002.mov", "/shoot/A003.mov"])
# ...grade the active shot (A003)...
set_active_shot(0)   # -> A001, its feed + grade restored (neutral first time)
# ...grade A001, save_grade()...
set_active_shot(1)   # -> A002
```

24 → 27 tools.

## Single-shot: no regression

Opening one clip = a session of one shot. `current_video()` returns it; seek /
playback / export / tracking / the activity feed / `grade.json` are byte-for-byte
the same path. `export.rs`'s per-frame `set_current_video(... frame: n)` matches
the active shot's path → updates in place, no reset, restores after.

## Verification

- `cargo check --no-default-features` — clean.
- `cargo test --no-default-features chroma::` — **23/23** (18 baseline + 5 new).
- `npx tsc --noEmit` — 74 pre-existing unrelated errors, baseline unchanged, none
  in a new/touched file.
- `python3 -m py_compile mcp/server.py` + `import server` — clean, 27 tools.

## Manual smoke test (open — bridge listener + app not driven)

1. Open a clip → shot strip shows one shot, `+` button, no `×`.
2. `+` → pick two more clips → strip shows three, active = the last, its grade neutral.
3. Grade shot 3 (exposure + WB). Switch to shot 1 → strip highlights shot 1, the
   canvas reloads shot 1 at neutral, the agent-activity dock is empty.
4. Grade shot 1 differently. Switch back to shot 3 → shot 3's grade + its feed
   entries are back; switch to shot 1 → shot 1's grade is back. Each grade
   persisted across the switches.
5. Active shot 1, click `→` on its card → shot 2 gets shot 1's grade (dot appears);
   switch to shot 2 and confirm.
6. `save_grade()` on the active shot → `<clip>.grade.json` written beside it.
7. Export the active shot (`export("h264")`) → only that shot renders.
8. `×` on a non-active shot → it disappears, active stays put. `×` on the active
   shot → a neighbour loads.
9. MCP: `list_shots` → the three; `set_active_shot(1)` → canvas switches, feed
   scopes; `add_shots(["/x.mov"])` → appended + active.
10. Open a single still after — `ShotStrip` hides (video shots only), the editor
    behaves as before.

## Deferred (roadmap follow-ups)

- `.chroma/session.json` — a shot-path list for reopening a session (still no bundle).
- Drag-drop shot reorder.
- Copy-grade to any shot (a picker), not just the next one.
- Auto-load each shot's `grade.json` on `add_shots` (v1 loads neutral; `load_grade` is manual).
- Still images as session shots.
- Batch per-shot thumbnails in one ffmpeg pass (v1 is one spawn per shot).
