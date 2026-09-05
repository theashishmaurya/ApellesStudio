# chroma-ai

**Layer 2 (domain).** The Chroma AI sidecar client — everything about talking
to the `ai/` FastAPI sidecar that doesn't need Tauri (D-145,
`docs/notes/crate-extraction-plan.md` §2.5).

- **Deps:** `serde` + `serde_json`, `log`, `sha2` (content-hash staleness,
  D-101), `image` (matte/depth PNG decode), `reqwest` (json + rustls, no
  default features). **No `tauri`, no `wgpu`, no fork types.**
- **What it is:** three modules, one per source file it came from:
  - `sidecar` — spawn/health/backoff/respawn lifecycle for the `ai/` FastAPI
    process (SAM 2 → ViTMatte, D-012/D-016/D-028), plus the D-101
    content-`sha256` staleness check for an externally-run sidecar.
  - `depth` — the `/depth_track` + `/depth_track/<id>` HTTP client and
    per-frame tracked-depth-PNG lookup (Video Depth Anything, D-036).
  - `mask` — the `/segment`, `/track`, `/track/<id>`, `/refine_track`,
    `/health` HTTP client and per-frame tracked-matte-PNG lookup (D-016).
- **What it does NOT do:** own any `#[tauri::command]` — a real
  `tauri-macros` constraint (D-039 §1: a command's macros are exported at its
  *defining* crate's root, so a crate hosting one needs a real `tauri`
  dependency, which would pull Tauri into the domain layer and, for any
  command taking `tauri::State<AppState>`, create a crate → app cycle).
  `app/src-tauri/src/chroma/{sidecar,depth,mask}.rs` keep every command as a
  thin wrapper around this crate. It also does not know the frontend's
  mask-parameter JSON shape (`chromaDepthDir` / `chromaTrackDir` extraction
  stays app-side, next to the fork types — `AiDepthMaskParameters`,
  `AiSubjectMaskParameters` — that define those params) and does not fetch or
  encode video frames (`chroma_subject_mask`'s
  `get_cached_full_warped_image` + PNG-encode stays app-side).

## The two real signature changes (D-145)

The original `depth::tracked_depth_map` / `mask::tracked_full_mask` each read
`chroma::state::current_video()?.frame` — a fork-side global this crate
cannot see. Split in two:

- [`depth::depth_map_at`] / [`mask::mask_at`] take the frame index as a plain
  `u64` argument instead of reading the global — a strictly better signature:
  no global, unit-testable in isolation (see each module's tests).
- The app-side function of the old name (`chroma::depth::tracked_depth_map`,
  `chroma::mask::tracked_full_mask`) keeps its old `(&serde_json::Value)`
  signature, resolves the dir + frame from the params value and
  `chroma::state::current_video()` internally, and calls in.
  `mask_generation.rs`'s three call sites needed no edits.

## Status

D-145 — moved ~900 lines out of `app/src-tauri/src/chroma/{sidecar,depth,mask}.rs`
(704 + ~200) into this crate. See `docs/notes/crate-extraction-plan.md` §2.5 for
the scoping pass this followed and `docs/08-decisions.md` D-145 for the decision
record.
