# chroma-grade-model

**Layer 2 (domain model).** The `grade.json` document (D-025) as typed Rust:
the versioned wrapper around `adjustments`, mask geometry, keyframes (D-034),
and the externalised matte refs (`$matte` / `$trackDir` / `$depthDir`).

- **Deps:** `chroma-types`, `serde`, `serde_json`. **Pure** — no `wgpu`, no
  `ffmpeg`, no store.
- **Model vs renderer:** this crate is the *document*. `chroma-grade` (future,
  L1) is the *renderer* that links the RapidRAW shader. Same split as
  `chroma-timeline` vs `chroma-compositor`.

## Status

D-039 migration **step 1 skeleton** — a `Grade` wrapper that mirrors
`grade.json` (D-025). The full document + migration gate are extracted from
`app/src-tauri/src/chroma/grade.rs` in a later, tracked step.
