//! Real Remotion renders through `still::render_preview` (D-403): the same
//! manifest and frame give the same PNG bytes, every time (CLAUDE.md's render
//! determinism rule), and several frames come back as one contact sheet.
//!
//! `#[ignore]`d because they need Node, the engine's `node_modules` and a
//! headless Chrome — none of which a plain `cargo test` may assume. Run with
//! `cargo test -p apelles-motion --test preview_render -- --ignored`.
//! Fixtures live in `tests/fixtures/`; each is rendered twice into separate
//! directories and the two PNGs' SHA-256 compared (printed for the record).

use std::path::{Path, PathBuf};

use apelles_motion::still::{PreviewRequest, render_preview};

fn engine_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/motion-engine")
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn sha256_hex(path: &Path) -> String {
    // `shasum` is what the decision record quotes; the comparison itself only
    // needs equality, so hashing in-process with blake3 would do as well, but
    // printing the same digest the docs cite keeps the record checkable.
    let out = std::process::Command::new("shasum")
        .args(["-a", "256"])
        .arg(path)
        .output()
        .expect("run shasum");
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_string()
}

/// Render `manifest` at `frames` twice; return the two digests and the first
/// outcome's grid.
fn render_twice(
    manifest: &Path,
    frames: &[u32],
    public_dir: Option<PathBuf>,
) -> (String, String, (u32, u32)) {
    let work = tempfile::tempdir().expect("tempdir");
    let cache = std::env::temp_dir().join("apelles-motion-preview-test-cache");
    let mut digests = Vec::new();
    let mut grid = (0, 0);
    for run in 0..2 {
        let req = PreviewRequest {
            engine_dir: engine_dir(),
            cache_dir: cache.clone(),
            out_dir: work.path().join(format!("run{run}")),
            manifest_path: manifest.to_path_buf(),
            frames: frames.to_vec(),
            scale: 0.25,
            label: "fixture".into(),
            public_dir: public_dir.clone(),
        };
        let outcome = render_preview(&req).expect("preview renders");
        grid = (outcome.columns, outcome.rows);
        digests.push(sha256_hex(&outcome.path));
    }
    (digests[0].clone(), digests[1].clone(), grid)
}

#[test]
#[ignore = "needs Node + the engine's node_modules + headless Chrome"]
fn the_sample_frame_renders_identically_twice() {
    let (a, b, grid) = render_twice(&fixture("sample.json"), &[60], None);
    println!("sample.json frame 60: {a}");
    assert_eq!(a, b, "same manifest + frame must give identical pixels");
    assert_eq!(grid, (1, 1));
}

#[test]
#[ignore = "needs Node + the engine's node_modules + headless Chrome"]
fn several_frames_come_back_as_one_deterministic_contact_sheet() {
    let (a, b, grid) = render_twice(&fixture("sample.json"), &[0, 30, 90, 150, 200], None);
    println!("sample.json contact sheet: {a}");
    assert_eq!(a, b);
    assert_eq!(grid, (4, 2));
}
