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

use apelles_motion::MotionRuntime;
use apelles_motion::still::{PreviewRequest, render_preview};

fn engine_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/motion-engine")
}

/// The runtime these renders use: the developer's Node and Remotion's own
/// browser, or — with `APELLES_MOTION_RUNTIME_DIR=<an installed runtime folder>`
/// — the downloaded runtime (its Node, Chrome Headless Shell and compositor).
/// `APELLES_MOTION_PACK_DIR=<an engine pack from scripts/build-pack.mts>` renders
/// from the pack's prebuilt bundle and files instead of the checkout; with both
/// set, these tests run exactly what an installed app runs (D-417).
fn runtime() -> MotionRuntime {
    use apelles_motion_runtime::Layout;
    let layout = match std::env::var_os("APELLES_MOTION_PACK_DIR") {
        Some(pack) => Layout::Packaged {
            pack_dir: PathBuf::from(pack),
            runtime_root: PathBuf::new(),
        },
        None => Layout::Dev {
            engine_dir: engine_dir(),
            runtime_root: PathBuf::new(),
        },
    };
    match std::env::var_os("APELLES_MOTION_RUNTIME_DIR") {
        Some(dir) => apelles_motion_runtime::locate::managed(&layout, Path::new(&dir)),
        None => {
            let mut rt =
                MotionRuntime::developer(layout.engine_dir()).expect("a Node 22.18+ on PATH");
            rt.prebuilt_bundle = layout.prebuilt_bundle();
            rt
        }
    }
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
            runtime: runtime(),
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
        // To LOOK at what was rendered (the hashes only prove it is stable):
        // `APELLES_PREVIEW_KEEP=<dir>` copies each first-run PNG there.
        if let (0, Ok(keep)) = (run, std::env::var("APELLES_PREVIEW_KEEP")) {
            let stem = manifest
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let frames_label: Vec<String> = frames.iter().map(u32::to_string).collect();
            let dest = Path::new(&keep).join(format!("{stem}-{}.png", frames_label.join("_")));
            std::fs::copy(&outcome.path, dest).expect("keep a copy");
        }
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

/// D-404 — a temp project asset folder holding the fixture logo, imported the
/// real way (`assets::import_asset`), and its id.
fn asset_folder() -> (tempfile::TempDir, PathBuf, String) {
    let dir = tempfile::tempdir().expect("tempdir");
    let assets = dir.path().join("p.chroma/motion/assets");
    let record = apelles_motion::assets::import_asset(&fixture("logo.svg"), &assets)
        .expect("import the logo");
    (dir, assets, record.id)
}

/// D-405 — each new primitive (image, icon, shape, counter, group) is one scene
/// of `brand-primitives.json`; render one frame of each twice and compare.
#[test]
#[ignore = "needs Node + the engine's node_modules + headless Chrome"]
fn each_brand_primitive_renders_identically_twice() {
    let (dir, assets, logo_id) = asset_folder();
    let hash = logo_id
        .trim_start_matches("sha256:")
        .trim_end_matches(".svg")
        .to_string();
    let text = std::fs::read_to_string(fixture("brand-primitives.json"))
        .expect("read fixture")
        .replace("LOGO_HASH", &hash);
    let manifest = dir.path().join("brand-primitives.json");
    std::fs::write(&manifest, text).expect("write manifest");
    // Scenes are 1 s at 30 fps, in this order; frame 20 of each is mid-entrance
    // or mid-animation, where a non-deterministic input would show.
    for (i, name) in ["image", "icon", "shape", "counter", "group"]
        .iter()
        .enumerate()
    {
        let frame = u32::try_from(i).expect("index") * 30 + 20;
        let (a, b, _) = render_twice(&manifest, &[frame], Some(assets.clone()));
        println!("{name} (frame {frame}): {a}");
        assert_eq!(a, b, "{name}: same frame twice must be identical");
    }
}

/// D-405 — the end-to-end proof's second half: the document
/// `packages/motion/src/brandScene.e2e.test.ts` built through the op layer is
/// rendered for real (a contact sheet of the reveal, the count and the icon
/// row), twice.
#[test]
#[ignore = "needs Node + the engine's node_modules + headless Chrome"]
fn the_agent_built_brand_scene_renders_identically_twice() {
    let (_dir, assets, logo_id) = asset_folder();
    let text = std::fs::read_to_string(fixture("brand-scene.json")).expect("read fixture");
    assert!(
        text.contains(&logo_id),
        "the op layer's asset id must be the Rust importer's id for the same file"
    );
    // Scene "brand" starts at frame 30; 0.4 s / 1.6 s / 3.5 s into it.
    let (a, b, grid) = render_twice(&fixture("brand-scene.json"), &[42, 78, 135], Some(assets));
    println!("brand-scene.json contact sheet: {a}");
    assert_eq!(a, b);
    assert_eq!(grid, (3, 1));
}

/// D-407 — every built-in template, instantiated with its defaults by
/// `packages/motion/src/templateOps.e2e.test.ts` (pinned as
/// `builtin-templates.json`: a 0.5 s lead-in, then one scene per template),
/// renders identically twice. Frame = scene start + 3 s, after the entrances.
#[test]
#[ignore = "needs Node + the engine's node_modules + headless Chrome"]
fn each_builtin_template_renders_identically_twice() {
    let manifest = fixture("builtin-templates.json");
    // Scene starts at 30 fps: lead-in 15 frames, then 4, 5, 4, 6, 5, 4 s.
    let templates: [(&str, u32); 6] = [
        ("logo-reveal", 15),
        ("feature-callout", 135),
        ("stat-counter", 285),
        ("testimonial", 405),
        ("pricing-card", 585),
        ("cta-end-card", 735),
    ];
    for (name, start) in templates {
        let frame = start + 90;
        let (a, b, _) = render_twice(&manifest, &[frame], None);
        println!("{name} (frame {frame}): {a}");
        assert_eq!(a, b, "{name}: same frame twice must be identical");
    }
}

/// D-407 — the end-to-end proof's second half: the stat counter an agent
/// filled through `motion_instantiate_template` (custom number, label, icon,
/// colour and the imported logo) renders for real, twice. Scene
/// "stat-counter" starts at frame 30; 0.5 s / 1.2 s / 3.5 s into it.
#[test]
#[ignore = "needs Node + the engine's node_modules + headless Chrome"]
fn the_agent_filled_stat_counter_renders_identically_twice() {
    let (_dir, assets, logo_id) = asset_folder();
    let text =
        std::fs::read_to_string(fixture("template-stat-counter.json")).expect("read fixture");
    assert!(
        text.contains(&logo_id),
        "the op layer's asset id must be the Rust importer's id for the same file"
    );
    let (a, b, grid) = render_twice(
        &fixture("template-stat-counter.json"),
        &[45, 66, 135],
        Some(assets),
    );
    println!("template-stat-counter.json contact sheet: {a}");
    assert_eq!(a, b);
    assert_eq!(grid, (3, 1));
}

/// D-413 — a soundtrack never changes a pixel: the sample document rendered
/// with no soundtrack, with one that is only monitored (`render` unset, the
/// default) and with one that is rendered in (`render: true`) gives the same
/// contact sheet bytes.
#[test]
#[ignore = "needs Node + the engine's node_modules + headless Chrome"]
fn a_soundtrack_never_changes_pixels() {
    let dir = tempfile::tempdir().expect("tempdir");
    let assets = dir.path().join("p.chroma/motion/assets");
    // Two seconds of a quiet 440 Hz tone as a 16-bit mono WAV.
    let rate = 22_050u32;
    let samples: Vec<i16> = (0..rate * 2)
        .map(|i| ((i as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin() * 3000.0) as i16)
        .collect();
    let mut wav = Vec::new();
    let data_len = (samples.len() * 2) as u32;
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&rate.to_le_bytes());
    wav.extend_from_slice(&(rate * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        wav.extend_from_slice(&s.to_le_bytes());
    }
    let song = dir.path().join("song.wav");
    std::fs::write(&song, wav).expect("write wav");
    let record = apelles_motion::assets::import_asset(&song, &assets).expect("import the song");

    let base: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(fixture("sample.json")).expect("read sample"),
    )
    .expect("parse sample");
    let frames = [0, 30, 90];
    let mut digests = Vec::new();
    for (label, soundtrack) in [
        ("none", None),
        (
            "monitored",
            Some(serde_json::json!({"src": record.id, "volume": 0.5})),
        ),
        (
            "rendered",
            Some(serde_json::json!({"src": record.id, "volume": 0.5, "render": true})),
        ),
    ] {
        let mut doc = base.clone();
        if let (Some(st), Some(obj)) = (soundtrack, doc.as_object_mut()) {
            obj.insert("soundtrack".into(), st);
        }
        let path = dir.path().join(format!("soundtrack-{label}.json"));
        std::fs::write(&path, doc.to_string()).expect("write manifest");
        let (a, b, _) = render_twice(&path, &frames, Some(assets.clone()));
        println!("soundtrack {label}: {a}");
        assert_eq!(a, b, "{label}: same frames twice must be identical");
        digests.push(a);
    }
    assert_eq!(
        digests[0], digests[1],
        "a monitored soundtrack changed pixels"
    );
    assert_eq!(
        digests[0], digests[2],
        "a rendered-in soundtrack changed pixels"
    );
}

/// D-416 — a document a brand kit was applied to (`brand-kit.json`, pinned by
/// `packages/motion/src/brandKit.e2e.test.ts` through the real applier): its theme
/// is generated from the kit and loads the kit's own font FILE (`brand-font.ttf`,
/// CC0) from the asset folder with `FontFace`, the logo too. Imported the real way,
/// rendered twice, compared.
#[test]
#[ignore = "needs Node + the engine's node_modules + headless Chrome"]
fn a_brand_kit_document_renders_identically_twice() {
    let (_dir, assets, logo_id) = asset_folder();
    let font = apelles_motion::assets::import_asset(&fixture("brand-font.ttf"), &assets)
        .expect("import the font");
    let text = std::fs::read_to_string(fixture("brand-kit.json")).expect("read fixture");
    assert!(
        text.contains(&logo_id) && text.contains(&font.id),
        "the applier's asset ids must be the Rust importer's ids for the same files"
    );
    let (a, b, grid) = render_twice(&fixture("brand-kit.json"), &[42, 78, 135], Some(assets));
    println!("brand-kit.json contact sheet: {a}");
    assert_eq!(a, b);
    assert_eq!(grid, (3, 1));
}
