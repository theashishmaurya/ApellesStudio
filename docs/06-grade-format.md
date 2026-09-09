# 06 — The grade document (`grade.json`)

Status: **v1 built** (2026-09-01, roadmap "Now" item 5, **D-025**). What shipped is
below. The aspirational ordered-`stack` model that used to live here has moved to
"## v2" at the bottom — it pairs with the node graph (D-005) and is not v1.

## Principle

**The grade is code.** One `grade.json` per shot. It is a versioned, documented,
git-committable document. The GUI mutates the grade, the MCP layer mutates it, and
`grade.json` is how that grade is saved, shared, diffed, and replayed. It lives in
the user's project repo, next to the footage.

Why this matters:
- `git diff` a look change → reviewable (a one-knob change is a one-line diff)
- generate a grade from a prompt → it's just JSON
- replay a grade months later → same doc + same frame ⇒ same pixels
- a series' "reference grade" is a file you copy, not a screenshot you eyeball

## v1 shape — a versioned wrapper around RapidRAW's `adjustments`

v1 is **not** a re-model of the grade into an ordered `stack`. It is a thin,
versioned, documented envelope around the exact `adjustments` blob the frontend
`useEditorStore` already owns (D-020), plus shot context, plus externalized
mattes. Doing the honest wrapper now (and the `stack` re-model with the v2 node
graph) keeps v1 small and keeps one source of truth — see **D-025**.

```jsonc
{
  "schema": "chroma.grade/1",          // chroma.grade/<major>; a newer major is rejected on load
  "shot": {
    "source": "010BEB07-….MOV",        // basename, relative to the grade.json's dir
    "width": 1080, "height": 1920,
    "fps": 29.773, "frameCount": 525,
    "colorSpace": "bt709",
    "reference": null                  // optional path, for match_to_reference later
  },
  "adjustments": { … },                // RapidRAW's Adjustments verbatim — every mask matte externalized (below)
  "notes": ""
}
```

`adjustments` is whatever `useEditorStore.getState().adjustments` holds: the
primary grade, curves, colour wheels, HSL, effects, LUT ref, and
`adjustments.masks[]` (each a `MaskContainer` with its own `MaskAdjustments` +
`subMasks[]`). Apelles does **not** reinterpret it — the renderer already reads it.

### Matte externalization

A mask matte can be megabytes of base64 — inlining it makes `grade.json`
un-diffable. So on **save** (`chroma_save_grade`, `app/src-tauri/src/chroma/grade.rs`):

| in `adjustments.masks[].subMasks[].parameters` | becomes | file written |
|---|---|---|
| `maskDataBase64` / `mask_data_base64` (a static PNG data-URL) | `{ "$matte": "<name>.mattes/<subMaskId>.png" }` | `<gradeDir>/<name>.mattes/<subMaskId>.png` |
| `chromaTrackDir` (a per-frame matte folder, D-019) | `{ "$trackDir": "<path>" }` | **nothing — referenced, not copied** |

- `<name>` = the grade.json's filename without `.grade.json` / `.json`.
- `$trackDir` is stored **relative to the grade.json dir** when it sits under it,
  else absolute.
- On **load** (`chroma_load_grade`) the reverse: `$matte` files are read back to a
  `data:image/png;base64,…` string in the same param key; `$trackDir` is resolved
  back to an absolute path.

**Caveat — moving a project:** the `.mattes/` sidecar dir travels *with*
`grade.json` (same dir). A **tracked** matte lives in the clip's
`.chroma/mattes/<key>/` folder (hundreds of PNGs) — that is *not* copied into the
grade, only referenced, so a project move must bring `.chroma/mattes/` too or the
tracked mask loads with no frames.

## Save / load

- Rust: `chroma_save_grade(path, grade) -> { path, matteFiles, trackDirs }` and
  `chroma_load_grade(path) -> <grade json>`. Pure JSON + fs, no GPU, no store.
- Frontend (`useChromaControl` ops): `get_grade` (assemble the v1 doc from the live
  store), `save_grade({path?})` (default `<clip dir>/<clip name>.grade.json`),
  `load_grade({path})` → `setAdjustments(() => normalizeLoadedAdjustments(g.adjustments))`
  → `bumpFrameNonce()`. **v1 does not auto-switch clips**: if `shot.source` ≠ the
  open clip, `load_grade` returns a `sourceMismatch` and applies the grade anyway.
- MCP: `get_grade`, `save_grade(path?)`, `load_grade(path)`.

## Schema migration

`chroma_load_grade` parses `schema` as `chroma.grade/<major>`:
- `major == 1` (or missing) → `migrate_v1` (identity today; the seam for future bumps)
- `major > 1` → hard error ("newer than this build supports")
- otherwise → hard error (unknown major)

A future `chroma.grade/2` adds a `match` arm that transforms the doc up one major
so the rest of `load` stays version-blind.

## Rules

- **`grade.json` is the single source of truth for a look**, but the *running*
  source of truth is still `useEditorStore` (D-020). `grade.json` is its
  serialization. Save writes the store out; load reads a doc in through the same
  `setAdjustments` a slider drag uses — so undo/history/the UI all see it.
- **Deterministic.** Save→load→render is byte-stable (verified: neutralize, load,
  `inspect_color` twice → identical scope numbers).
- **A malformed doc fails loud** with the offending path — never renders wrong
  silently.
- **`.cube` export** is separate (`chroma_bake_lut`, D-022) — it flattens the
  primary grade only; masked/local layers can't bake to a 3D LUT.

## v2 — ordered stack + node graph (not v1)

The original draft of this doc modelled the grade as an **ordered `stack[]`** of
typed entries (`primary`, `curve`, `wheels`, `lut`, `masked`, `compound`) with a
separate `masks{}` map keyed by id, per-entry `enabled`, and a `meta.history`
audit trail. That model is real and still the plan — but it belongs with the **v2
node graph** (D-005), where "ordered, non-destructive layers" and "parallel +
serial + layer mixer" are the actual data model, not a translation layer over
RapidRAW's flat `adjustments`. Re-modelling in v1 would mean maintaining a
lossy two-way map between the `stack` and `adjustments` for zero user benefit
(D-025). When the node graph lands, `chroma.grade/2` carries the `stack`.

Sketch of the v2 entry types (for reference):

```jsonc
"stack": [
  { "id": "primary", "type": "primary", "params": { "exposure": 0.13, … } },
  { "id": "curve-master", "type": "curve", "channel": "master", "points": [[0,0.04],…] },
  { "id": "wheels", "type": "wheels", "params": { "lift": {…}, "gamma": {…}, "gain": {…} } },
  { "id": "look", "type": "lut", "path": "luts/food-pop.cube", "strength": 0.3 },
  { "id": "subject-pop", "type": "masked", "mask": "m_subject",
    "adjust": { "type": "primary", "params": { "exposure": 0.15, "vibrance": 0.2 } } }
]
```

with masks as data (`shape` = geometry, `subject`/`depth` = a cached matte ref,
human `corrections` layered on top) and `meta.history` as the agent+human audit
trail powering the GUI activity feed + undo.
