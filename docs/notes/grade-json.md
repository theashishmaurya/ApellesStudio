# notes/grade-json.md — `grade.json` save / load

Roadmap "Now" item 5. Built 2026-09-01. See `docs/08-decisions.md` **D-025** (the
"wrapper not stack" call + matte externalization), `docs/06-grade-format.md` (the
shape), D-020 (the frontend owns `adjustments`), D-019 (tracked matte at render
time).

## What shipped

`app/src-tauri/src/chroma/grade.rs` — new, self-contained. Pure `serde_json` +
`std::fs`. No GPU, no `AppState`, no store mutation.

| item | signature |
|---|---|
| `chroma_save_grade` (cmd) | `(path: String, grade: Value) -> Result<SaveResult, String>` |
| `chroma_load_grade` (cmd) | `(path: String) -> Result<Value, String>` |
| `SaveResult` | `{ path, matteFiles: [rel…], trackDirs: [rel-or-abs…] }` |

Frontend `src/hooks/useChromaControl.ts`: `assembleGrade()`, `defaultGradePath()`,
ops `get_grade` / `save_grade` / `load_grade`. `mcp/server.py`: `get_grade`,
`save_grade`, `load_grade`.

## The v1 shape

```jsonc
{
  "schema": "chroma.grade/1",
  "shot": { "source": "clip.MOV", "width": 1080, "height": 1920,
            "fps": 29.773, "frameCount": 525, "colorSpace": "bt709", "reference": null },
  "adjustments": { …RapidRAW Adjustments verbatim, mattes externalized… },
  "notes": ""
}
```

**Why a wrapper, not `docs/06`'s ordered `stack`:** the running grade is
RapidRAW's flat `adjustments`, owned by `useEditorStore` (D-020). The `stack`
re-model is the v2 node-graph data model (D-005); building it in v1 = a lossy
two-way `stack ⇄ adjustments` map for no user gain. `chroma.grade/2` carries the
`stack` when the node graph lands. Full rationale: D-025.

## Matte externalization

Walk `adjustments.masks[].subMasks[].parameters` on save:

| param | → in JSON | file |
|---|---|---|
| `maskDataBase64` or `mask_data_base64` (PNG data-URL) | `{ "$matte": "<name>.mattes/<subMaskId>.png" }` | `<gradeDir>/<name>.mattes/<subMaskId>.png` |
| `chromaTrackDir` (per-frame matte folder, D-019) | `{ "$trackDir": "<rel-or-abs>" }` | — (referenced only) |
| `chromaDepthDir` (per-frame depth folder, D-036) | `{ "$depthDir": "<rel-or-abs>" }` | — (referenced only) |

- `<name>` = grade filename minus `.grade.json` / `.json`.
- `$trackDir` / `$depthDir` relative when they sit under the grade dir, else absolute.
- Load reverses all three: `$matte` → `data:image/png;base64,…` back in the same
  key; `$trackDir` / `$depthDir` → absolute (join grade dir if relative).
- Both frontend camelCase (`maskDataBase64`) and engine snake_case
  (`mask_data_base64`) keys are handled — different engine paths use each.

### Moving a project

`grade.json` + its `<name>.mattes/` dir travel together (same folder). A
**tracked** mask's `$trackDir` points at the clip's `.chroma/mattes/<key>/`
(hundreds of per-frame PNGs) which is **not** copied into the grade — a project
move must bring `.chroma/mattes/` too, or the tracked mask loads with no frames.

### Grade location inside a project (D-037)

When a shot is part of a **project** (`<name>.chroma/`, D-037), its grade is
saved to `<name>.chroma/grades/<shotId>.grade.json` — **inside the project**,
not as a sidecar next to the source clip. The grade belongs to the project (the
media is only *referenced* by absolute path and may be read-only / on a scratch
disk / shared between projects). Everything else is identical: `grades/` gets the
`<shotId>.mattes/` PNGs beside each grade, and `$trackDir` / `$depthDir` still
resolve to `.chroma/mattes|depth/` next to the **source clip** (per-clip
precomputes, not per-project). The frontend writes these via the same
`chroma_save_grade` command with an explicit `path`. A loose clip with no
project still saves beside itself as `<clip>.grade.json` (the default). See
`docs/notes/project-model.md`.

## Mask keyframes (D-034) — inline, no externalisation

A shape sub-mask can carry `parameters.chromaKeyframes` — an ordered
`[{ frame, params: { …geometry subset… } }]` that the engine interpolates per
source frame at render time (radial centre/radii/rotation/feather, linear
endpoints/range, brush `lines`). These are **tiny numbers**, so unlike mattes
they stay **inline** in `grade.json` — no `$matte` / `$trackDir`-style
externalisation. `save_grade` / `load_grade` round-trip them verbatim as part of
`parameters`; the matte-externalisation walk ignores them. A sub-mask with no
`chromaKeyframes` key is unchanged (static). Detail: `docs/notes/mask-keyframes.md`.

## Schema migration

`load` parses `schema` as `chroma.grade/<major>`:

- `major == 1` or missing → `migrate_v1` (identity + stamps the tag). This is the
  seam: a future `chroma.grade/2` adds a `match` arm that transforms the doc up
  one major so the rest of `load` stays version-blind.
- `major > 1` → `Err("… newer than this build supports (chroma.grade/1) …")`
- unknown → `Err("unknown grade.json schema major: …")`

## Frontend flow

- `get_grade` → `assembleGrade()`: schema tag + `shot` (from `useChromaStore.videoInfo`
  or `selectedImage`) + `useEditorStore.getState().adjustments` verbatim + `notes:""`.
  READ_ONLY (no settle).
- `save_grade({path?})` → default `<clip dir>/<clip basename>.grade.json` →
  `invoke('chroma_save_grade', { path, grade: assembleGrade() })`. READ_ONLY.
- `load_grade({path})` → `invoke('chroma_load_grade', {path})` →
  `setAdjustments(() => normalizeLoadedAdjustments(grade.adjustments))` →
  `bumpFrameNonce()`. **Mutating** (settle + re-render). Returns
  `{applied, shot, sourceMismatch}`. **v1 does not switch clips** — if
  `shot.source` ≠ the open clip's basename you get
  `sourceMismatch: {expected, open}` and the grade is applied anyway.

## Verification (2026-09-01, live bridge, 1080×1920 talking-head clip)

1. `cargo check --no-default-features` clean; `cargo test chroma::grade` 3/3
   (`round_trip_externalises_and_inlines_matte`, `rejects_newer_major`,
   `grade_name_strips_both_suffixes`).
2. `set_primary {exposure 0.35, contrast 8, temperature 6}` + `add_subject_mask` +
   `set_mask_adjust {exposure 0.5, vibrance 15}` → `save_grade({})` →
   `/Users/…/010BEB07-….grade.json` (25 009 bytes). `schema: "chroma.grade/1"`,
   `shot.source: "010BEB07-….MOV"`, every `maskDataBase64` →
   `{"$matte": "010BEB07-….mattes/<subId>.png"}`, the tracked sub →
   `{"$trackDir": ".chroma/mattes/72ff67e8cafb"}` (relative). `.mattes/` = three
   `1080×1920 8-bit grayscale` PNGs.
3. Neutralize (`exposure -1`, delete the new mask) → `blackPoint 8, meanRGB
   [70.6,67.2,67.6], warmCool 5.7`. `load_grade({path})` → `blackPoint 21,
   whitePoint 254, meanRGB [136.6,122.7,109.1], warmCool 25.5, saturation 0.35`,
   `list_masks` = 3 (incl. the tracked one); a second `inspect_color` returns the
   identical numbers (deterministic).
4. `git init` a scratch repo, `save_grade` → commit; `set_primary {exposure 0.4}`
   → `save_grade` → `git diff` = a single `-  "exposure": 0.35` / `+  "exposure":
   0.4` hunk. The "reviewable" claim.
5. Tracked round-trip: the loaded `$trackDir` resolved to
   `/Users/…/Downloads/.chroma/mattes/72ff67e8cafb` (527 frame PNGs); `seek`
   200/400 OK; re-`save_grade` keeps `$trackDir` relative (idempotent).

## Relationship to the multi-shot session (D-033)

`grade.json` is unchanged by the session model. It is still **the** per-shot
document: one grade per clip, saved to `<clip>.grade.json` beside it. The session
(D-033) adds an *ordered list of shots* + an in-memory grade cache so switching
shots keeps each grade live without a disk round-trip — it does **not** bundle
grades into one file, and there is no `.chroma` project format. `save_grade` /
`load_grade` act on the **active** shot.

## Open / follow-ups

- `load_grade` doesn't switch clips (v1) — only warns. Auto-load each shot's
  `grade.json` on `add_shots` is a small follow-up (D-033 deferred list) now
  that the session model exists.
- Clip in/out points — still open (the roadmap "Shot / session model" tail).
- No `meta.history` audit trail yet (v2 / the node graph — D-025).
- Save doesn't garbage-collect a stale `.mattes/` PNG whose sub-mask was deleted
  — harmless, but a cleanup pass would be tidy.
- Stills: `shot.fps` is `null`, `frameCount` 1 — untested end-to-end (the bridge
  test clip is a video).
