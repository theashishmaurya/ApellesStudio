//! Certify a custom component from its source, spec and proof plan, through the
//! same functions the app's Tauri commands call (D-409): the Node static check
//! (`check_source`), `write_draft`, the three-pass proof (`prove`) and
//! `certify`. This is how the shipped built-ins in
//! `packages/motion-engine/components/` were produced from
//! `tests/fixtures/components/<id>/` (whose `proof-plan.json` the frontend's
//! `proofPlan` wrote, pinned by `packages/motion/src/customOps.e2e.test.ts`).
//!
//! ```text
//! cargo run -p apelles-motion --example certify_component -- \
//!     crates/apelles-motion/tests/fixtures/components/bar-line-chart \
//!     packages/motion-engine/components
//! ```
//!
//! Needs Node, the engine's `node_modules` and a headless Chrome, like every
//! render. Not shipped; a developer tool.

use std::path::{Path, PathBuf};

use apelles_motion::components::{self, ProofPlan};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let (Some(src), Some(root)) = (args.next(), args.next()) else {
        return Err("usage: certify_component <component fixture dir> <library root>".into());
    };
    let src = PathBuf::from(src);
    let root = PathBuf::from(root);
    let engine = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/motion-engine");
    let runtime = apelles_motion::MotionRuntime::developer(&engine)
        .ok_or("no Node 22.18+ found (PATH, APELLES_MOTION_NODE)")?;

    let source = std::fs::read_to_string(src.join("component.tsx"))?;
    let spec: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(src.join("spec.json"))?)?;
    let plan: ProofPlan =
        serde_json::from_str(&std::fs::read_to_string(src.join("proof-plan.json"))?)?;

    let report = components::check_source(&runtime, &source)?;
    if !report.ok {
        return Err(format!(
            "static check failed: {}",
            serde_json::to_string_pretty(&report.issues)?
        )
        .into());
    }
    let draft = components::write_draft(None, &root, &spec, &source, &report)?;
    println!("draft {}@{} at {}", draft.id, draft.version, draft.dir);

    let cache = std::env::temp_dir().join("apelles-component-certify-cache");
    let outcome = components::prove(&runtime, &cache, Path::new(&draft.dir), &plan)?;
    println!("{}", serde_json::to_string_pretty(&outcome.proof)?);
    if outcome.proof.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err("the certification check did not pass".into());
    }
    let meta = components::certify(Path::new(&draft.dir))?;
    println!(
        "certified {}@{} source {} module {}",
        draft.id, draft.version, meta["certified"]["sourceHash"], meta["certified"]["codeHash"]
    );
    Ok(())
}
