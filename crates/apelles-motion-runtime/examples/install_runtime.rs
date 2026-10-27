//! Install the real, pinned Motion runtime into a folder — the same
//! `store::install` the app's "Download" runs, from the real publishers.
//!
//! `cargo run -p apelles-motion-runtime --example install_runtime -- <root>`
//!
//! Prints progress per artifact, the time each step took and the size on disk,
//! then checks the result the way the app does on every launch. Used to verify
//! D-417 end to end; the runtime folder it prints can be passed to the
//! `apelles-motion` render tests as `APELLES_MOTION_RUNTIME_DIR`.

use std::path::PathBuf;
use std::time::Instant;

use apelles_motion_runtime::pins;
use apelles_motion_runtime::store::{self, InstallRequest, InstallState, Source, Step};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("usage: install_runtime <root folder>")?,
    );
    let key = pins::runtime_key();
    println!(
        "installing {key} into {} ({} MB to download)",
        root.display(),
        pins::total_download_bytes() / 1_048_576
    );
    let started = Instant::now();
    let mut step_started = Instant::now();
    let mut last: Option<(Step, Option<pins::ArtifactId>)> = None;
    let mut last_mb = 0;
    let dir = store::install(
        &InstallRequest {
            root: &root,
            key: &key,
            artifacts: &pins::ARTIFACTS,
            source: Source::Pinned,
            free_space: &store::free_bytes,
        },
        |p| {
            let now = (p.step, p.artifact);
            if last != Some(now) {
                if let Some(prev) = last {
                    println!(
                        "  {prev:?} took {:.1}s",
                        step_started.elapsed().as_secs_f64()
                    );
                }
                println!("{:?} {}", p.step, p.label);
                step_started = Instant::now();
                last = Some(now);
            }
            let mb = p.bytes_done / 10_485_760;
            if mb != last_mb {
                last_mb = mb;
                println!(
                    "  {} / {} MB",
                    p.bytes_done / 1_048_576,
                    p.bytes_total / 1_048_576
                );
            }
        },
    )?;
    println!(
        "installed at {} in {:.1}s",
        dir.display(),
        started.elapsed().as_secs_f64()
    );
    println!("on disk: {} MB", store::dir_size(&root) / 1_048_576);
    match store::inspect(&root, &key, &pins::ARTIFACTS) {
        InstallState::Ready { .. } => println!("integrity check: ready"),
        other => return Err(format!("integrity check failed: {other:?}").into()),
    }
    Ok(())
}
