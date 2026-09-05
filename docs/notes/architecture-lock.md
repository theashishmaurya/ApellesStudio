# Architecture lock — the crate / package structure (draft for D-039)

**Status:** proposed 2026-09-02. To be folded into `docs/03-architecture.md` (which is
stale since Phase 0) + recorded as **D-039** once the in-flight D-038 lands. The
migration is **incremental**, not a big-bang refactor.

Context: the three-tab direction (`docs/notes/product-direction.md`) + the owner's ask
to "create packages like core / engine / etc. so each code structure is separated and
clean, reusable." Constraint lock still applies: **Rust-native, performance-first, small
binary, Tauri.**

## Principles (locked)

1. **Thin shell, fat core** — the Gyroflow model. Gyroflow Core "handles as much as it
   can so the outer layers (the GUI) can be as thin as possible" and is "free of any
   large external dependencies." The Tauri app is glue; every real capability is a library.
2. **Dependency-light core.** `chroma-timeline`, `chroma-project`, `chroma-grade-model`
   are pure data + logic — **no wgpu, no ffmpeg**. GPU and media I/O are separate crates
   the model layer does not depend on.
3. **One-directional dependency graph, compiler-enforced.** `app → tabs → services →
   domain → media/gpu → types`. No cycles. An illegal import is a build error.
4. **The RapidRAW fork stays a vendored engine** (`engine/` submodule, D-003). Only
   `chroma-grade` links it. Over time Chroma crates absorb more and RapidRAW shrinks to
   "the grade shader + the mask raster."
5. **Frontend mirrors the backend** — a `packages/` workspace, one package per tab +
   shared `ui` / `bridge` / `shell`.
6. **Monorepo.** `chroma/` is the home. The Remotion motion engine
   (`videoAgent/engine/motion/`) moves in as `packages/motion-engine/`.
7. **Rebuild-time is a design input** — a timeline-UI change must not recompile the grade
   shader; a shader change must not recompile the timeline model.

## Rust workspace — `chroma/crates/`

### Layer 0 — foundation
| crate | responsibility | depends on |
|---|---|---|
| `chroma-types` | shared value types: `Frame`, `Rational` (fps), `Resolution`, `ColorSpace`, `TimeRange`, typed IDs, error enums. serde. **Zero heavy deps.** | — |
| `chroma-gpu` | the wgpu context (device+queue, no surface), texture pool, bind-group helpers, the headless render entry (`render_core`, D-014, extracted) | `wgpu`, `chroma-types` |

### Layer 1 — media & compositing (pixels)
| crate | responsibility | depends on |
|---|---|---|
| `chroma-media` | **real, D-146.** decode / probe. VideoToolbox (macOS HW) → wgpu texture; ffmpeg-CLI fallback (D-015); the persistent decode pipe (D-030); the source-keyed disk cache (D-128); the LOD filmstrip (D-128/D-134); the Edit-tab audio engine + waveforms (D-049/D-051/D-057). ffmpeg is a **subprocess, never linked.** The export encode pipe (D-022) has **not** moved — it is still `chroma/export.rs`, which imports six fork modules (`crate-extraction-plan.md` §2.7). | `chroma-types` — **not `chroma-gpu`**: this table predicted that edge, and the real extracted code has none (everything moved is CPU/subprocess). It becomes real if and when VideoToolbox→texture lands. |
| `chroma-grade` | the colour grade **renderer** — wraps the RapidRAW `engine/` shader + `AllAdjustments` ↔ uniform bridge + masks + `structure_blur` + scopes (D-021) | `chroma-gpu`, `chroma-types`, `engine` |
| `chroma-compositor` | multi-layer wgpu compositing: blend N `chroma-media` layers + transitions, then `chroma-grade` per output frame. **The new work for the editing tab.** | `chroma-gpu`, `chroma-media`, `chroma-grade`, `chroma-types` |

### Layer 2 — domain models (pure data + logic, NO gpu/media deps)
| crate | responsibility | depends on |
|---|---|---|
| `chroma-timeline` | the OTIO-shaped edit model: tracks, clips, gaps, edits (ripple/roll/slip/slide), transcript→EDL ops. serde ↔ OTIO JSON. **Pure.** | `chroma-types` |
| `chroma-grade-model` | the `grade.json` document (D-025): adjustments, mask geometry, keyframes (D-034), `$matte`/`$trackDir`/`$depthDir` refs. serde. **Pure** — the *model*; `chroma-grade` is the *renderer* | none — real extraction (D-143) found zero fork/types edges, corrected from this table's earlier `chroma-types` guess |
| `chroma-project` | **real, D-148.** the `.chroma` project (D-037): the `project.json` manifest + every schema migration, settings (D-038), the media pool + bins (D-044/D-045/D-059), thumbnails, media-offline / relink, the D-070 unified clip identity + grade-file migration, and the project's **timeline lifecycle** (`ensure_timeline` / `resolve_timeline`, lifted out of `chroma/edit.rs` where they had been wearing an Edit-tab name). `open_manifest` + the 20 `#[tauri::command]`s stay in `app/src-tauri` — every one of them takes `tauri::State<'_, AppState>` (`crate-extraction-plan.md` §1). | `chroma-types`, `chroma-timeline`, **`chroma-media`**. Two corrections on contact, same as D-143/D-146 each made for their own slice: this table listed a `chroma-grade-model` edge the real code does not have (grade *files* are renamed by the D-070 migration, never parsed), and omitted the `chroma-media` one it does (`video::probe`, `video::extract_thumb`, `probe::probe_cached`). L2 → L1 is legal in the graph above; the table simply did not say so. |

> **Note on "NO gpu/media deps" above.** That heading holds for `chroma-timeline`,
> `chroma-grade-model` and `chroma-motion`, which are genuinely pure. It does not hold
> for `chroma-project`, and never could have: a project references media files, and
> answering "how long is this clip / what does its poster frame look like / is it
> offline" is a media question. The layering rule that matters is the **direction**
> (L2 → L1 is down the graph, and `chroma-media` has no edge back), not the purity of
> every L2 crate. D-148.
| `chroma-motion` | the manifest → Remotion bridge (spawn render, read frames as an overlay layer). Thin. | `chroma-types` |

### Layer 3 — services
| crate | responsibility | depends on |
|---|---|---|
| `chroma-ai` | sidecar client: SAM / ViTMatte / YOLO / depth / whisper HTTP bridges + the sidecar lifecycle supervisor (D-028) | `chroma-types` |
| `chroma-agent` | the in-app control server (D-020) + the MCP-facing op registry + scope exposure | `chroma-project`, `chroma-grade-model`, `chroma-timeline`, `chroma-types` |

### Layer 4 — the app
| crate | responsibility | depends on |
|---|---|---|
| `chroma-app` (`src-tauri`) | the Tauri binary — wires everything, the `#[tauri::command]` surface per tab, `RunEvent` hooks, sidecar spawn | all of the above |

`engine/` (the RapidRAW submodule) stays as-is; only `chroma-grade` (→ transitively
`chroma-app`) links it.

## Frontend workspace — `chroma/packages/`

| package | responsibility |
|---|---|
| `@chroma/tokens` | design tokens + theme (from RapidRAW's CSS vars) |
| `@chroma/ui` | shared component kit — buttons, sliders, dropdowns, modals (RapidRAW `components/ui/`) |
| `@chroma/bridge` | typed Tauri command bindings + the zustand stores + the control-bridge hook (D-020) |
| `@chroma/colorist` | the **Colorist tab** — adjustment panels, scopes, mask editor (RapidRAW's adjustment UI, adapted) |
| `@chroma/editor` | the **Editing tab** (new) — timeline strip (`react-timeline-editor` based), transcript pane, trim/ripple UI |
| `@chroma/motion` | the **Motion tab** — `@remotion/player` embed + manifest editor |
| `@chroma/motion-engine` | the Remotion project itself, moved in from `videoAgent/engine/motion/` (7 primitives + the manifest compiler) |
| `@chroma/shell` | app shell — tab switcher, project launcher (D-037), window chrome, routing |
| `apps/desktop` | the Vite entry that composes shell + tabs; what `src-tauri` serves |

## Migration strategy — incremental, test-green throughout

1. **Now:** create the skeleton — `Cargo.toml [workspace]`, `crates/*/` with stub `lib.rs`
   + a `README.md` each, `packages/*/` stubs. Lock in `03-architecture.md` + D-039. **No
   code moves yet.**
2. Extract the **leaf pure crates** first — `chroma-types`, `chroma-grade-model`,
   `chroma-timeline` (greenfield). Low risk, no wgpu.
3. `chroma-gpu` (extract `render_core`), `chroma-media` (decode pipe + `video` mod),
   `chroma-project` (move `src/chroma/project.rs`). **All three done — D-144, D-146,
   D-148.** Two corrections this step made to the sentence above: `grade.rs`'s model
   went to `chroma-grade-model` (D-143), not `chroma-project`, and **`state.rs` does
   not move at all** — it is a process-global that `mask_generation.rs` reads directly,
   i.e. app-layer by design (`crate-extraction-plan.md` §2.2/§2.3).
4. `chroma-ai` (move `sidecar.rs` + the `mask.rs`/`depth.rs` HTTP clients) — **done,
   D-145.** `chroma-agent` is **rescoped out** of this wave: `control.rs` is 164 lines of
   `tauri::AppHandle` event plumbing with no Tauri-free core, and the op registry it
   would host lives in the frontend, not in Rust (`crate-extraction-plan.md` §2.6).
5. `chroma-grade` wraps `engine/`. `chroma-app` becomes the thin binary.
6. The editing tab's `chroma-compositor` + `@chroma/editor` are **greenfield inside the
   structure** from day one.
7. Each extraction = its own commit, `cargo test` green, roadmap-tracked, divergence log
   updated. Frontend packages split the same way (`@chroma/ui` + `@chroma/bridge` first).

## Doc hygiene status (answering "are you still writing into bugs / decisions / …")

| doc | status |
|---|---|
| `08-decisions.md` (D-NNN) | **current** — maintained every task, D-021 → D-038 |
| `04-roadmap.md` | **current** — every item ticked with its D-NNN + deferred lists |
| `CHANGELOG.md` | **current** |
| `BUGS.md` | maintained for real defects (B-002, B-003 this session). The **"Known engine constraints"** list is stale — it names solved items (static masks → D-034, per-frame depth flicker → D-036, Tauri-coupled render → D-014). Refresh due. |
| `03-architecture.md` | **STALE since Phase 0** (2026-09-01). Describes a 4-component scaffold, no mention of D-014/D-020/D-030/D-033/D-036/D-037 or any crate structure. **This lock fixes it.** |
| `09-engine-notes.md` divergence log | current |
