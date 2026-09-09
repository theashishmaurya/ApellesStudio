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
2. **Dependency-light core.** `apelles-timeline`, `apelles-project`, `apelles-grade-model`
   are pure data + logic — **no wgpu, no ffmpeg**. GPU and media I/O are separate crates
   the model layer does not depend on.
3. **One-directional dependency graph, compiler-enforced.** `app → tabs → services →
   domain → media/gpu → types`. No cycles. An illegal import is a build error.
4. **The RapidRAW fork stays a vendored engine** (`engine/` submodule, D-003). Only
   `apelles-grade` links it. Over time Apelles crates absorb more and RapidRAW shrinks to
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
| `apelles-types` | shared value types: `Frame`, `Rational` (fps), `Resolution`, `ColorSpace`, `TimeRange`, typed IDs, error enums. serde. **Zero heavy deps.** | — |
| `apelles-gpu` | the wgpu context (device+queue, no surface), texture pool, bind-group helpers, the headless render entry (`render_core`, D-014, extracted) | `wgpu`, `apelles-types` |

### Layer 1 — media & compositing (pixels)
| crate | responsibility | depends on |
|---|---|---|
| `apelles-media` | **real, D-146.** decode / probe. VideoToolbox (macOS HW) → wgpu texture; ffmpeg-CLI fallback (D-015); the persistent decode pipe (D-030); the source-keyed disk cache (D-128); the LOD filmstrip (D-128/D-134); the Edit-tab audio engine + waveforms (D-049/D-051/D-057). ffmpeg is a **subprocess, never linked.** The export encode pipe (D-022) has **not** moved — it is still `chroma/export.rs`, which imports six fork modules (`crate-extraction-plan.md` §2.7). | `apelles-types` — **not `apelles-gpu`**: this table predicted that edge, and the real extracted code has none (everything moved is CPU/subprocess). It becomes real if and when VideoToolbox→texture lands. |
| `apelles-grade` | the colour grade **renderer** — wraps the RapidRAW `engine/` shader + `AllAdjustments` ↔ uniform bridge + masks + `structure_blur` + scopes (D-021) | `apelles-gpu`, `apelles-types`, `engine` |
| `apelles-compositor` | multi-layer wgpu compositing: blend N `apelles-media` layers + transitions, then `apelles-grade` per output frame. **The new work for the editing tab.** | `apelles-gpu`, `apelles-media`, `apelles-grade`, `apelles-types` |

### Layer 2 — domain models (pure data + logic, NO gpu/media deps)
| crate | responsibility | depends on |
|---|---|---|
| `apelles-timeline` | the OTIO-shaped edit model: tracks, clips, gaps, edits (ripple/roll/slip/slide), transcript→EDL ops. serde ↔ OTIO JSON. **Pure.** | `apelles-types` |
| `apelles-grade-model` | the `grade.json` document (D-025): adjustments, mask geometry, keyframes (D-034), `$matte`/`$trackDir`/`$depthDir` refs. serde. **Pure** — the *model*; `apelles-grade` is the *renderer* | none — real extraction (D-143) found zero fork/types edges, corrected from this table's earlier `apelles-types` guess |
| `apelles-project` | **real, D-148.** the `.chroma` project (D-037): the `project.json` manifest + every schema migration, settings (D-038), the media pool + bins (D-044/D-045/D-059), thumbnails, media-offline / relink, the D-070 unified clip identity + grade-file migration, and the project's **timeline lifecycle** (`ensure_timeline` / `resolve_timeline`, lifted out of `chroma/edit.rs` where they had been wearing an Edit-tab name). `open_manifest` + the 20 `#[tauri::command]`s stay in `app/src-tauri` — every one of them takes `tauri::State<'_, AppState>` (`crate-extraction-plan.md` §1). | `apelles-types`, `apelles-timeline`, **`apelles-media`**. Two corrections on contact, same as D-143/D-146 each made for their own slice: this table listed a `apelles-grade-model` edge the real code does not have (grade *files* are renamed by the D-070 migration, never parsed), and omitted the `apelles-media` one it does (`video::probe`, `video::extract_thumb`, `probe::probe_cached`). L2 → L1 is legal in the graph above; the table simply did not say so. |

> **Note on "NO gpu/media deps" above.** That heading holds for `apelles-timeline`,
> `apelles-grade-model` and `apelles-motion`, which are genuinely pure. It does not hold
> for `apelles-project`, and never could have: a project references media files, and
> answering "how long is this clip / what does its poster frame look like / is it
> offline" is a media question. The layering rule that matters is the **direction**
> (L2 → L1 is down the graph, and `apelles-media` has no edge back), not the purity of
> every L2 crate. D-148.
| `apelles-motion` | the manifest → Remotion bridge (spawn render, read frames as an overlay layer). Thin. | `apelles-types` |

### Layer 3 — services
| crate | responsibility | depends on |
|---|---|---|
| `apelles-ai` | sidecar client: SAM / ViTMatte / YOLO / depth / whisper HTTP bridges + the sidecar lifecycle supervisor (D-028) | `apelles-types` |
| `apelles-agent` | the in-app control server (D-020) + the MCP-facing op registry + scope exposure | `apelles-project`, `apelles-grade-model`, `apelles-timeline`, `apelles-types` |

### Layer 4 — the app
| crate | responsibility | depends on |
|---|---|---|
| `apelles-app` (`src-tauri`) | the Tauri binary — wires everything, the `#[tauri::command]` surface per tab, `RunEvent` hooks, sidecar spawn | all of the above |

`engine/` (the RapidRAW submodule) stays as-is; only `apelles-grade` (→ transitively
`apelles-app`) links it.

## Frontend workspace — `chroma/packages/`

| package | responsibility |
|---|---|
| `@apelles/tokens` | design tokens + theme (from RapidRAW's CSS vars) |
| `@apelles/ui` | shared component kit — buttons, sliders, dropdowns, modals (RapidRAW `components/ui/`) |
| `@apelles/bridge` | typed Tauri command bindings + the zustand stores + the control-bridge hook (D-020) |
| `@apelles/colorist` | the **Colorist tab** — adjustment panels, scopes, mask editor (RapidRAW's adjustment UI, adapted) |
| `@apelles/editor` | the **Editing tab** (new) — timeline strip (`react-timeline-editor` based), transcript pane, trim/ripple UI |
| `@apelles/motion` | the **Motion tab** — `@remotion/player` embed + manifest editor |
| `@apelles/motion-engine` | the Remotion project itself, moved in from `videoAgent/engine/motion/` (7 primitives + the manifest compiler) |
| `@apelles/shell` | app shell — tab switcher, project launcher (D-037), window chrome, routing |
| `apps/desktop` | the Vite entry that composes shell + tabs; what `src-tauri` serves |

## Migration strategy — incremental, test-green throughout

1. **Now:** create the skeleton — `Cargo.toml [workspace]`, `crates/*/` with stub `lib.rs`
   + a `README.md` each, `packages/*/` stubs. Lock in `03-architecture.md` + D-039. **No
   code moves yet.**
2. Extract the **leaf pure crates** first — `apelles-types`, `apelles-grade-model`,
   `apelles-timeline` (greenfield). Low risk, no wgpu.
3. `apelles-gpu` (extract `render_core`), `apelles-media` (decode pipe + `video` mod),
   `apelles-project` (move `src/chroma/project.rs`). **All three done — D-144, D-146,
   D-148.** Two corrections this step made to the sentence above: `grade.rs`'s model
   went to `apelles-grade-model` (D-143), not `apelles-project`, and **`state.rs` does
   not move at all** — it is a process-global that `mask_generation.rs` reads directly,
   i.e. app-layer by design (`crate-extraction-plan.md` §2.2/§2.3).
4. `apelles-ai` (move `sidecar.rs` + the `mask.rs`/`depth.rs` HTTP clients) — **done,
   D-145.** `apelles-agent` is **rescoped out** of this wave: `control.rs` is 164 lines of
   `tauri::AppHandle` event plumbing with no Tauri-free core, and the op registry it
   would host lives in the frontend, not in Rust (`crate-extraction-plan.md` §2.6).
5. `apelles-grade` wraps `engine/`. `apelles-app` becomes the thin binary.
6. The editing tab's `apelles-compositor` + `@apelles/editor` are **greenfield inside the
   structure** from day one.
7. Each extraction = its own commit, `cargo test` green, roadmap-tracked, divergence log
   updated. Frontend packages split the same way (`@apelles/ui` + `@apelles/bridge` first).

## Doc hygiene status (answering "are you still writing into bugs / decisions / …")

| doc | status |
|---|---|
| `08-decisions.md` (D-NNN) | **current** — maintained every task, D-021 → D-038 |
| `04-roadmap.md` | **current** — every item ticked with its D-NNN + deferred lists |
| `CHANGELOG.md` | **current** |
| `BUGS.md` | maintained for real defects (B-002, B-003 this session). The **"Known engine constraints"** list is stale — it names solved items (static masks → D-034, per-frame depth flicker → D-036, Tauri-coupled render → D-014). Refresh due. |
| `03-architecture.md` | **STALE since Phase 0** (2026-09-01). Describes a 4-component scaffold, no mention of D-014/D-020/D-030/D-033/D-036/D-037 or any crate structure. **This lock fixes it.** |
| `09-engine-notes.md` divergence log | current |
