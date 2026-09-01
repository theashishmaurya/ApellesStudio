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

## Fixed

_(none yet)_
