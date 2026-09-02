# chroma-types

**Layer 0 (foundation).** Shared value types for the whole Chroma workspace:
`Resolution`, `Rational`, `Frame`, `ColorSpace`, `TimeRange`, typed IDs, and the
`ChromaError` enum.

- **Deps:** `serde`, `thiserror`. Nothing heavy — no `wgpu`, no `ffmpeg`, no fs.
- **Depended on by:** every other `chroma-*` crate. It is the root of the
  one-directional dependency graph (D-039).

## Status

D-039 migration **step 1 skeleton** — placeholder types only (`Resolution`,
`Rational`, `ChromaError`). Real types are extracted per-item in later steps
(from `app/src-tauri/src/chroma/*` and greenfield).
