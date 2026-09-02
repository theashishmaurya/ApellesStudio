# chroma-types

**Layer 0 (foundation).** Shared value types for the whole Chroma workspace:
`Resolution`, `Rational`, `ChromaError` (real, in use). `Frame`, `ColorSpace`,
`TimeRange`, and typed IDs stay undesigned — no real duplicate of any of them
turned up in the `app/src-tauri` audit, see below.

- **Deps:** `serde`, `thiserror`. Nothing heavy — no `wgpu`, no `ffmpeg`, no fs.
- **Depended on by:** every other `chroma-*` crate. It is the root of the
  one-directional dependency graph (D-039). `chroma-motion` (D-046) already
  consumes `ChromaError`; `app/src-tauri` (D-053) now consumes `Resolution`.

## Status

D-039 migration **step 2 (D-053)** — real, in-use types, not a placeholder
skeleton anymore, but still deliberately small:

- **`Resolution { width, height }`** — real, migrated into `app/src-tauri/src/
  chroma/{video,commands,session,project}.rs` (`video::VideoInfo`, its
  `VideoInfoDto`/`ShotDto`/`MediaVideoInfo` DTOs) via `#[serde(flatten)]`.
  Field names (`width`/`height`) deliberately match every call site's
  pre-existing JSON keys exactly, so this was a zero-wire-change migration —
  verified by a round-trip test in `src/lib.rs` and a real `cargo test
  chroma::` pass (107/107, unchanged from the pre-migration baseline).
  Gained a `Display` impl (`"1920x1080"`) along the way.
- **`Rational { num, den }`** — real, used by `export.rs`'s ffmpeg `-r`/
  `-framerate` arg string (`Display` → `"{num}/{den}"`, replacing a bare
  `format!` call). No `simplify()`/GCD-reduction was added — no ad-hoc
  duplicate of that logic was found anywhere in the audit, so it would have
  been speculative, not extracted.
- **`ChromaError`** — still just the D-046 placeholder shape (`Invalid`/
  `NotFound`/`Unsupported`), unchanged this step. `app/src-tauri`'s Tauri
  commands deliberately do **not** adopt it — they return `Result<T, String>`
  (Tauri's own IPC error convention) or `anyhow::Result`, which is the
  *correct* convention for that layer, not a duplicate to migrate away. The
  one dedicated error enum found in `app/src-tauri/src/chroma/*`
  (`control.rs`'s single-variant `BridgeErr::Timeout`) is a distinct concept
  (an HTTP-bridge timeout), not a `ChromaError` case.
- **`ColorSpace`, `TimeRange`, typed IDs** — not added. `app/src-tauri`
  stores colour space as a free `String` deliberately (D-038: "store +
  surface only," real colour management is D-004); no `TimeRange`-shaped
  struct exists outside `chroma-timeline` (out of scope for this step, see
  D-053's note on `chroma-timeline`'s `TimelineError` as a *possible*
  follow-up, not migrated).
- **Deliberately NOT migrated**, despite having `width`/`height`-ish fields:
  `project.rs::ProjectSettings` (D-038's output spec) and `export.rs::
  ExportOpts` — both use *independently*-optional width/height for a
  partial-override/patch model (`merge_patch`, `resolve_export_resolution`),
  which is a genuinely different concept from `Resolution`'s atomicity, not
  a superficial-vs-real distinction. Full reasoning in **D-053**
  (`docs/08-decisions.md`).
