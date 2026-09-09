# apelles-grade-model

**Layer 2 (domain model).** The `grade.json` document (D-025): save, load,
the versioned schema migration gate, and matte/track/depth-ref
externalization — extracted verbatim from
`app/src-tauri/src/chroma/grade.rs` (D-143).

- **Deps:** `serde`, `serde_json`, `base64`. **Zero fork deps** — no
  `apelles-types`, no `wgpu`, no `ffmpeg`, no store. The real code never
  imported anything but `std::path`/`base64`/`serde_json`; the extraction
  found this table wrong in `docs/notes/architecture-lock.md` (which listed a
  `apelles-types` edge) and corrected it rather than adding an unused
  dependency to match a stale doc.
- **Model vs renderer:** this crate is the *document*. `apelles-grade`
  (future, L1) is the *renderer* that links the RapidRAW shader. Same split
  as `apelles-timeline` vs `apelles-compositor`.
- **Untyped by design:** the document is `serde_json::Value` past the
  `schema`/`shot`/`notes` envelope — no typed `adjustments`/mask schema. The
  canonical shape is owned by the frontend `useEditorStore` (D-020); a typed
  Rust mirror would just drift. This is D-025's own reasoning for rejecting
  the ordered `stack` model in v1, not a shortcut taken here.

## API

- `SCHEMA` / `MATTE_KEYS` — the current schema tag (`chroma.grade/1`) and the
  camelCase/snake_case static-matte parameter keys.
- `SaveResult { path, matte_files, track_dirs }` — what `save_grade` wrote.
- `save_grade(path: &str, grade: Value) -> Result<SaveResult, String>` —
  writes `grade` to `path`, externalising every mask matte to
  `<name>.mattes/<subId>.png` and rewriting `chromaTrackDir`/`chromaDepthDir`
  to `{"$trackDir"/"$depthDir": …}` references (never copies the folder).
- `load_grade(path: &str) -> Result<Value, String>` — reads + migrates +
  inlines the mattes back to base64, resolving track/depth dirs to absolute
  paths.

## Status

**Real extraction landed, D-143 (2026-09-05).** Supersedes this crate's
original D-039-step-1 skeleton (a placeholder typed `Grade`/`ShotRef` pair
that predated this extraction and was never wired to any caller — replaced
outright, not kept alongside the real code). The 2 `#[tauri::command]`
wrappers (`chroma_save_grade` / `chroma_load_grade`) stay in
`app/src-tauri/src/chroma/grade.rs` per the "commands do not move" rule
(D-141) and just call `save_grade`/`load_grade` here.
