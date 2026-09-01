# BUGS

Bug + issue tracker. Move to GitHub Issues once public; keep this as the working log
until then.

Format per entry:

```
## B-NNN — short title
- **status:** open | investigating | fixed | wontfix | duplicate
- **severity:** blocker | high | medium | low
- **area:** engine | video-io | masks | ai-sidecar | mcp | gui | build | docs
- **found:** YYYY-MM-DD (phase N)
- **repro:** …
- **expected:** …
- **actual:** …
- **notes / cause:** …
- **fix:** commit / PR ref
```

---

## Known upstream (RapidRAW) constraints to watch

Not bugs in our code — architectural facts to design around. Verify each during the
Phase 0 code-read.

- **U-001** — RapidRAW is single-image; no video decode, no timeline, no temporal
  anything. Adding video is our Phase 1.
- **U-002** — masks are (assumed) static per image — no keyframe/tracking model. We add
  keyframes to the data model + GUI.
- **U-003** — Depth Anything V2 integration is for stills; per-frame video depth needs
  temporal smoothing or it will flicker.
- **U-004** — Tauri webview cannot receive full-res frames over IPC at scrub speed
  (D-006). Presentation path TBD.
- **U-005** — adjustment model is a stack, not nodes (D-005) — fine, but any doc/tool
  that assumes a node graph is wrong for v1.

---

## Open bugs

## B-001 — Rust toolchain too old to build engine
- **status:** fixed (2026-09-01)
- **severity:** blocker
- **area:** build
- **found:** 2026-09-01 (phase 0)
- **repro:** `cd engine/src-tauri && cargo build`
- **actual:** `Cargo.toml` requires `rust-version = "1.98"` + `edition 2024`; machine had rustc 1.72.1
- **fix:** `rustup update stable` → rustc 1.98.0. `cargo check` on the engine then passes
  clean in 4m24s (682 deps, ONNX runtime dylib auto-downloaded + verified). See D-011.

## B-002 — disk almost full
- **status:** mitigated (2026-09-01) — 3.6 GiB → 38 GiB free after cleanup; not blocking. Ceiling still low.
- **severity:** was blocker, now low
- **area:** build
- **found:** 2026-09-01 (phase 0)
- **actual:** `~` volume is **100% full — 3.6 GiB free of 460 GiB**. `engine/src-tauri/target`
  is already 1.3 GB after `cargo check`; a full `cargo build` roughly doubles it, a release
  build again, plus ONNX models (~0.5–1 GB), plus the frontend build. Will fail mid-build
  with `No space left on device`.
- **fix:** user needs to free ~20–30 GB before Phase 1. Candidates: old `target/` dirs in
  other Rust projects (`cargo clean`), the `videoAgent` repo's `.venv*` (several GB) and
  `mlx_models/` / `models/`, `~/Library/Caches`, `~/Library/Developer/Xcode/DerivedData`,
  Docker images, old iOS simulators. `du -sh ~/* ~/Library/* 2>/dev/null | sort -h` to find hogs.
- **workaround meanwhile:** don't run full/release builds; `cargo check` (needs less) is OK.

## Fixed

_(none yet)_
