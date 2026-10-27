//! Custom components rendered for real (D-409).
//!
//! - Each shipped built-in (`packages/motion-engine/components/<id>/<v>/`) is
//!   re-checked (the Node static check compiles its source to the exact module
//!   bytes it certified) and re-proved: the three-pass proof passes again and
//!   every sampled frame's pixel hash equals the one recorded at certification,
//!   in a separate run — so certification is reproducible, not a one-off.
//! - The document an agent built through the ops
//!   (`fixtures/custom-components.json`, pinned by
//!   `packages/motion/src/customOps.e2e.test.ts`: a particle burst, and the chart
//!   inside a group with a keyframed colour) renders identically twice, with the
//!   two renders running AT THE SAME TIME (B-278: own ports, shared bundle
//!   cache), after the built-ins are installed into a temp project the real way.
//!
//! `#[ignore]`d: needs Node, the engine's `node_modules` and a headless Chrome.
//! `cargo test -p apelles-motion --test component_render -- --ignored --nocapture`.
//! `APELLES_PREVIEW_KEEP=<dir>` keeps the rendered PNGs to look at.

use std::path::{Path, PathBuf};

use apelles_motion::components::{self, ProofPlan};
use apelles_motion::still::{PreviewRequest, render_preview};
use serde_json::Value;

fn engine_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/motion-engine")
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

const BUILTINS: [&str; 4] = [
    "particle-logo-burst",
    "bar-line-chart",
    "sketch-callout",
    "stat-bars",
];

fn builtin_dir(id: &str) -> PathBuf {
    components::builtin_components_dir(&engine_dir())
        .join(id)
        .join("1")
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).expect("create copy");
    for entry in std::fs::read_dir(from).expect("read built-in") {
        let entry = entry.expect("entry");
        std::fs::copy(entry.path(), to.join(entry.file_name())).expect("copy file");
    }
}

#[test]
#[ignore = "needs Node + the engine's node_modules + headless Chrome"]
fn each_builtin_recompiles_to_its_certified_module_and_reproves_with_the_same_pixels() {
    for id in BUILTINS {
        let dir = builtin_dir(id);
        let files = components::read_version(&dir).expect("read built-in");
        assert_eq!(files.meta["status"], "certified", "{id} ships certified");

        let report = components::check_source(&engine_dir(), &files.source).expect("check runs");
        assert!(report.ok, "{id}: {:?}", report.issues);
        let shipped = std::fs::read_to_string(dir.join(components::CODE_FILE)).expect("module");
        assert_eq!(
            report.code.as_deref(),
            Some(shipped.as_str()),
            "{id} compiles to its certified bytes"
        );

        let work = tempfile::tempdir().expect("tempdir");
        let copy = work.path().join(id).join("1");
        copy_dir(&dir, &copy);
        let plan: ProofPlan = serde_json::from_str(
            &std::fs::read_to_string(fixture(&format!("components/{id}/proof-plan.json")))
                .expect("plan"),
        )
        .expect("parse plan");
        let cache = std::env::temp_dir().join("apelles-component-render-test-cache");
        let outcome = components::prove(&engine_dir(), &cache, &copy, &plan).expect("prove");
        assert!(!outcome.recorded, "a certified version is never written to");
        assert_eq!(outcome.proof["ok"], true, "{id}: {}", outcome.proof);
        let now: Vec<&Value> = outcome.proof["frames"]
            .as_array()
            .expect("frames")
            .iter()
            .collect();
        let then: Vec<&Value> = files.meta["proof"]["frames"]
            .as_array()
            .expect("recorded frames")
            .iter()
            .collect();
        assert_eq!(now.len(), then.len());
        for (a, b) in now.iter().zip(then.iter()) {
            // The fresh stills are bit-exact (the in-order pass is compared within
            // the rasterizer tolerance, so its own hash is not pinned).
            assert_eq!(
                a["hashes"][1], b["hashes"][1],
                "{id} frame {} differs from certification",
                a["frame"]
            );
        }
        println!(
            "{id}: {} frames reproduced, first {}",
            now.len(),
            now[0]["hashes"][1]
        );
    }
}

#[test]
#[ignore = "needs Node + the engine's node_modules + headless Chrome"]
fn the_agent_built_document_renders_identically_in_two_parallel_renders() {
    let project = tempfile::tempdir().expect("tempdir");
    let assets = project.path().join("p.chroma/motion/assets");
    for id in BUILTINS {
        components::install_into_project(&builtin_dir(id), &assets).expect("install");
    }
    let manifest = fixture("custom-components.json");
    let cache = std::env::temp_dir()
        .join("apelles-component-render-test-cache")
        .join("preview");
    // Scene 0 (particles, 3 s) at 1 s; scene 1 (the chart in its group) at 1 s and 2.5 s.
    let frames = vec![30, 120, 165];
    let render = |run: usize| {
        let req = PreviewRequest {
            engine_dir: engine_dir(),
            cache_dir: cache.clone(),
            out_dir: project.path().join(format!("run{run}")),
            manifest_path: manifest.clone(),
            frames: frames.clone(),
            scale: 0.25,
            label: "custom".into(),
            public_dir: Some(assets.clone()),
        };
        render_preview(&req).expect("preview renders")
    };
    // Bundle once first, so the two parallel runs exercise the shared cache.
    apelles_motion::still::ensure_bundle(&engine_dir(), &cache, Some(&assets)).expect("bundle");
    let (a, b) = std::thread::scope(|s| {
        let a = s.spawn(|| render(0));
        let b = s.spawn(|| render(1));
        (a.join().expect("run 0"), b.join().expect("run 1"))
    });
    let digest = |p: &Path| apelles_motion::assets::sha256_file(p).expect("hash");
    let (da, db) = (digest(&a.path), digest(&b.path));
    println!("custom-components.json contact sheet: {da}");
    assert_eq!(
        da, db,
        "two parallel renders of the same document give identical bytes"
    );
    assert_eq!((a.columns, a.rows), (3, 1));
    if let Ok(keep) = std::env::var("APELLES_PREVIEW_KEEP") {
        std::fs::copy(&a.path, Path::new(&keep).join("custom-components.png")).expect("keep");
    }
}

/// The live player's proxy frames: the one-layer document the frontend builds
/// (`fixtures/custom-proxy.json`, pinned by `customOps.e2e.test.ts`) renders to
/// one transparent PNG per frame, and a second request is served from cache.
#[test]
#[ignore = "needs Node + the engine's node_modules + headless Chrome"]
fn a_custom_layer_renders_to_cached_transparent_proxy_frames() {
    let project = tempfile::tempdir().expect("tempdir");
    let assets = project.path().join("p.chroma/motion/assets");
    components::install_into_project(&builtin_dir("bar-line-chart"), &assets).expect("install");
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(fixture("custom-proxy.json")).expect("read"))
            .expect("parse");
    let req = components::ProxyRequest {
        engine_dir: engine_dir(),
        bundle_cache: std::env::temp_dir()
            .join("apelles-component-render-test-cache")
            .join("preview"),
        out_root: project.path().join("proxy"),
        manifest,
        public_dir: Some(assets),
        scale: 0.25,
    };
    let first = components::render_proxy(&req).expect("proxy renders");
    assert!(!first.cached);
    assert_eq!(first.files.len(), 30, "one frame per frame of the layer");
    let last = image::open(first.files.last().expect("a frame"))
        .expect("decode")
        .to_rgba8();
    assert_eq!(
        last.dimensions(),
        (400, 225),
        "the layer's box at the proxy scale"
    );
    if let Ok(keep) = std::env::var("APELLES_PREVIEW_KEEP") {
        last.save(Path::new(&keep).join("custom-proxy-last.png"))
            .expect("keep");
    }
    assert_eq!(
        last.get_pixel(0, 0).0[3],
        0,
        "transparent outside what the component draws"
    );
    let second = components::render_proxy(&req).expect("cached");
    assert!(second.cached);
    assert_eq!(second.files, first.files);
}

/// The proof catches what the static check cannot: a component that keeps
/// state between renders (a module-level counter) passes every AST rule, but
/// its in-order frames differ from fresh stills, so it cannot be certified.
#[test]
#[ignore = "needs Node + the engine's node_modules + headless Chrome"]
fn a_component_that_keeps_state_between_frames_fails_its_proof() {
    let source = r#"import { AbsoluteFill, useCurrentFrame } from "remotion";
import type { ComponentProps } from "@apelles/component";

let renders = 0;

export default function Stateful({ theme }: ComponentProps) {
  const frame = useCurrentFrame();
  renders += 1;
  return <AbsoluteFill style={{ background: renders % 3 === 0 ? theme.accent : theme.bg, opacity: frame >= 0 ? 1 : 0 }} />;
}
"#;
    let report = components::check_source(&engine_dir(), source).expect("check runs");
    assert!(
        report.ok,
        "the static check cannot see state: {:?}",
        report.issues
    );
    let lib = tempfile::tempdir().expect("tempdir");
    let spec = serde_json::json!({"id": "stateful", "name": "Stateful", "props": [], "size": {"w": 320, "h": 180}, "duration": 1});
    let draft = components::write_draft(None, lib.path(), &spec, source, &report).expect("draft");
    let code_hash = draft.meta["codeHash"].as_str().expect("hash").to_string();
    let source_hash = draft.meta["sourceHash"].as_str().expect("hash").to_string();
    let mut def = spec.clone();
    def["version"] = 1.into();
    def["codeHash"] = code_hash.clone().into();
    def["sourceHash"] = source_hash.clone().into();
    def["code"] = format!("sha256:{code_hash}.js").into();
    def["source"] = format!("sha256:{source_hash}.tsx").into();
    let plan: ProofPlan = serde_json::from_value(serde_json::json!({
        "manifest": {
            "title": "proof", "width": 320, "height": 180, "fps": 30, "grain": false, "vignette": false,
            "components": {"stateful@1": def},
            "scenes": [{"id": "proof-defaults", "dur": 1, "layers": [{"use": "custom", "id": "component", "component": "stateful@1", "x": 0, "y": 0}]}]
        },
        "variants": [{"name": "defaults", "frames": [0, 10, 20, 29]}],
        "scale": 1.0
    }))
    .expect("plan");
    let cache = std::env::temp_dir().join("apelles-component-render-test-cache");
    let outcome =
        components::prove(&engine_dir(), &cache, Path::new(&draft.dir), &plan).expect("prove runs");
    assert_eq!(outcome.proof["ok"], false, "{}", outcome.proof);
    assert!(
        components::certify(Path::new(&draft.dir)).is_err(),
        "a failed proof does not certify"
    );
    println!("stateful proof rows: {}", outcome.proof["frames"]);
}
