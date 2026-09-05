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
| L0 | `chroma-gpu` | **yes, partial (D-144)** | headless wgpu device/queue/limits (`init_gpu_context`, D-014, extracted). No display surface, no texture pool yet, no `render()` — those stay app-side / gated on `chroma-grade` | `wgpu`, `pollster`, `log` |
| L1 | `chroma-media` | **yes, real (D-146)** | `video` (ffmpeg-CLI probe + decode, D-015), `decode_pipe` (D-030/D-125), `media_cache` (D-128), `probe` (the two-layer probe cache, lifted out of `chroma/edit.rs`), `filmstrip` (D-128/D-134), `audio` (symphonia→rubato→cpal engine + waveforms, D-049/D-051/D-057). Export encode (D-022) is still in `chroma/export.rs`; VideoToolbox→texture is future | types (**no `gpu` edge yet** — nothing extracted so far needs one; the lock doc's table predicted one) |
| L1 | `chroma-grade` | future | the grade **renderer** — wraps the RapidRAW (`app/`) shader + adjustments↔uniform bridge + masks + scopes (D-021) | gpu, types, `app/` engine |
| L1 | `chroma-compositor` | future | multi-layer wgpu blend + transitions, then `chroma-grade` per output frame — new, for the Edit tab | gpu, media, grade, types |
| L2 | `chroma-timeline` | **yes (stub)** | OTIO-shaped edit model: tracks / clips / gaps / ripple / roll / slip / slide, transcript→EDL. **Pure.** | types |
| L2 | `chroma-grade-model` | **yes, real** (D-143) | the `grade.json` document (D-025) — save/load, schema migration, matte/track/depth-ref externalization. **Pure** (model vs renderer). | — |
| L2 | `chroma-project` | future | the `.chroma` project (D-037) + settings (D-038) | types, grade-model, timeline |
| L2 | `chroma-motion` | **yes** (D-046) | manifest → Remotion bridge: shells out to `npx remotion render` in `packages/motion-engine` rather than reimplementing it | types |
| L3 | `chroma-ai` | **yes** (D-145) | sidecar client: lifecycle (spawn/health/hash, D-028/D-101), `/segment`+`/track`+`/refine_track` (D-016/D-018/D-019), `/depth_track` (D-036) wire plumbing | (none — no chroma-types dependency yet; whisper is not wired in this pass) |
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
- **`chroma-gpu` (D-144, 2026-09-05):** `render_core::init_gpu_context()` moved
  verbatim (device + queue + limits, headless). `render_core::render()` did
  **not** move — it is a pass-through into
  `gpu_processing::process_and_get_dynamic_image_inner`, whose signature is
  entirely RapidRAW-core types (`GpuContext`'s `display` field,
  `RenderCaches`, `RenderRequest`), and moving it is `chroma-grade`, later.
  Resolved the one open question from D-141's scoping pass: `GpuContext`
  *does* split into two structs — this crate's headless one, and the app's
  own `image_processing::GpuContext` (unchanged) which wraps it plus a
  `display: Arc<Mutex<Option<WgpuDisplay>>>` for the on-screen present path.
  `render_core.rs` keeps its old `init_gpu_context()` signature as a thin
  wrapper, so the 6 `render_core::` call sites in `chroma/export.rs`,
  `chroma/playback.rs`, `chroma/relight.rs` need zero changes.
- **`chroma-media` (D-146, 2026-09-05):** the widest slice of the plan, in its
  three required ordered commits. `video.rs` + `decode_pipe.rs` +
  `media_cache.rs` moved verbatim; `probe_cached` was lifted out of
  `chroma/edit.rs` into a `probe` module of its own (it is the *composition* of
  `video::probe` with `media_cache`'s two layers, not part of either) — it had
  to move first, or this crate would depend on `app/src-tauri`, a cycle;
  `filmstrip.rs` moved whole minus its command wrapper. **`audio.rs` split
  rather than moved**: its symphonia→rubato→cpal engine, the D-130 session
  ordering protocol, the waveform path and `AudioSourceSpec` are media, but
  `chroma_audio_play`'s *timeline resolution*
  (`edit::resolve_video_position` / `resolve_audio_track_positions`) is a layer
  above media and stayed in `app/src-tauri` — the command is now
  `begin_play` → *(app resolves)* → `start`, which preserves the exact ordering
  D-125's skew compensation depends on. **B-056** (the in-memory probe cache
  never invalidated) and **B-057** (`CHUNK_LOCKS` leaked on a failed
  extraction) were fixed inside the commits already rewriting that code, each
  with a regression test confirmed to fail pre-fix. Correction to the table
  above: this crate has **no `chroma-gpu` edge** — everything extracted so far
  is CPU/subprocess work; the predicted edge becomes real only if
  VideoToolbox→texture lands. See its own `README.md` for the `test-support`
  feature and why it is a feature rather than a `#[doc(hidden)] pub`.
