# crates/ — Chroma's Rust workspace

The **thin-shell / fat-core** structure locked in **D-039** (the Gyroflow model):
the Tauri app is glue; every capability is a library. Domain models are pure Rust
— no `wgpu`, no `ffmpeg` — with GPU + media I/O isolated below them. The
dependency graph is **one-directional and compiler-enforced**:

```
app  →  agent/ai  →  project/timeline/grade-model/motion  →  media/grade/compositor  →  gpu  →  types
```

## The planned crates (D-039)

| layer | crate | exists? | responsibility | deps |
|---|---|---|---|---|
| L0 | `chroma-types` | **yes (stub)** | `Frame` / `Rational` / `Resolution` / `ColorSpace` / `TimeRange`, typed IDs, error enums — zero heavy deps | — |
| L0 | `chroma-gpu` | future | wgpu context (no surface), texture pool, `render_core` (D-014, extracted) | `wgpu`, types |
| L1 | `chroma-media` | future | decode / probe / encode — VideoToolbox→texture, ffmpeg-CLI fallback (D-015), decode pipe (D-030), export encode pipe (D-022) | gpu, types |
| L1 | `chroma-grade` | future | the grade **renderer** — wraps the RapidRAW (`app/`) shader + adjustments↔uniform bridge + masks + scopes (D-021) | gpu, types, `app/` engine |
| L1 | `chroma-compositor` | future | multi-layer wgpu blend + transitions, then `chroma-grade` per output frame — new, for the Edit tab | gpu, media, grade, types |
| L2 | `chroma-timeline` | **yes (stub)** | OTIO-shaped edit model: tracks / clips / gaps / ripple / roll / slip / slide, transcript→EDL. **Pure.** | types |
| L2 | `chroma-grade-model` | **yes, real** (D-143) | the `grade.json` document (D-025) — save/load, schema migration, matte/track/depth-ref externalization. **Pure** (model vs renderer). | — |
| L2 | `chroma-project` | future | the `.chroma` project (D-037) + settings (D-038) | types, grade-model, timeline |
| L2 | `chroma-motion` | **yes** (D-046) | manifest → Remotion bridge: shells out to `npx remotion render` in `packages/motion-engine` rather than reimplementing it | types |
| L3 | `chroma-ai` | future | sidecar client (SAM / ViTMatte / YOLO / depth / whisper) + lifecycle (D-028) | types |
| L3 | `chroma-agent` | future | control server (D-020) + MCP op registry + scope exposure | project, grade-model, timeline, types |
| L4 | `chroma-app` (`app/src-tauri`) | **yes** — the vendored fork, still named `RapidRAW` in its `Cargo.toml` | the Tauri binary — `#[tauri::command]` surface per tab, `RunEvent` hooks, sidecar spawn | all of the above |

`app/` (the vendored RapidRAW fork, D-040) stays the engine; over time these
crates absorb more and RapidRAW shrinks to "grade shader + mask raster". Only
`chroma-grade` will link it.

## Migration status (D-039)

- **Step 1 (this commit):** workspace skeleton — root `Cargo.toml [workspace]`,
  the 3 pure-leaf stub crates above (each `cargo check` clean, one placeholder
  item + `it_builds` test), the Remotion motion engine moved to
  `packages/motion-engine/`. **No real code moved; the app still builds.**
- **Step 2+:** extract per-crate, each its own commit, `cargo test` green,
  roadmap-tracked. Order: leaf pure crates → `chroma-gpu` / `chroma-media` /
  `chroma-project` → `chroma-agent` / `chroma-ai` → `chroma-grade` +
  `chroma-app` thin binary. `chroma-compositor` is greenfield from day one.
