//! **The Edit preview's scrub latency, measured (D-452).**
//!
//! What it is: one `#[ignore]`d measurement, [`measure_scrub_latency`], of what
//! a scrub costs the preview: the time from asking for a timeline position to
//! having its finished picture (`render_timeline_frame`, the body of
//! `chroma_timeline_frame` before the JPEG), on generated 1080p and 4K H.264
//! with grain, two stacked video tracks (a full-frame base and a scaled
//! picture-in-picture), at the preview's 1280 px long edge. Three access
//! patterns: a drag (forward steps of a few frames), a jump (anywhere), and a
//! drag backwards. It also counts the `ffmpeg` processes alive under this
//! process after the run, which is what "a scrub starts an ffmpeg process"
//! means in practice.
//!
//! What it does NOT do: assert (a shared machine), or include the JPEG and the
//! IPC (constant per frame, measured in D-217).
//!
//! ```text
//! cargo test -p apelles --lib chroma::scrub_bench -- --ignored --nocapture
//! ```

use std::path::{Path, PathBuf};
use std::time::Instant;

use apelles_project::manifest::ProjectSettings;
use apelles_timeline::{Clip, Timeline, Track, TrackKind};

use super::decode_pipe;
use super::edit::{self, FrameIntent};

fn synth(dir: &Path, name: &str, size: &str) -> PathBuf {
    let out = dir.join(name);
    let status = apelles_media::ffmpeg_locate::ffmpeg()
        .expect("ffmpeg")
        .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
        .arg(format!(
            "testsrc2=size={size}:rate=30:duration=20,noise=alls=6:allf=t"
        ))
        .args([
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-g", "60",
        ])
        .args(["-pix_fmt", "yuv420p"])
        .arg(&out)
        .status()
        .expect("ffmpeg");
    assert!(status.success());
    out
}

fn timeline(path: &str) -> Timeline {
    let clip = |id: &str, scale: f64| Clip {
        id: id.into(),
        name: id.into(),
        source_path: path.into(),
        source_start: 0,
        duration: 600,
        source_len: 600,
        start_frame: 0,
        scale,
        ..Default::default()
    };
    Timeline {
        rate: None,
        tracks: vec![
            Track {
                kind: TrackKind::Video,
                clips: vec![clip("pip", 0.4)],
                ..Default::default()
            },
            Track {
                kind: TrackKind::Video,
                clips: vec![clip("base", 1.0)],
                ..Default::default()
            },
        ],
        ..Default::default()
    }
}

fn ffmpeg_children() -> usize {
    let out = std::process::Command::new("pgrep")
        .args(["-P", &std::process::id().to_string(), "ffmpeg"])
        .output();
    out.map(|o| String::from_utf8_lossy(&o.stdout).lines().count())
        .unwrap_or(0)
}

fn percentile(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(f64::total_cmp);
    v[((v.len() - 1) as f64 * p).round() as usize]
}

#[test]
#[ignore = "a live latency measurement, not a pass/fail assertion"]
fn measure_scrub_latency() {
    let dir = tempfile::tempdir().expect("tempdir");
    for (label, size, w, h) in [
        ("1080p", "1920x1080", 1920, 1080),
        ("4K", "3840x2160", 3840, 2160),
    ] {
        let path = synth(dir.path(), &format!("scrub-{label}.mp4"), size);
        let tl = timeline(&path.to_string_lossy());
        let settings = ProjectSettings {
            width: Some(w),
            height: Some(h),
            fps: Some(30.0),
            color_space: None,
        };
        decode_pipe::reset();
        let frame = |pos: u64| -> f64 {
            let t = Instant::now();
            edit::render_timeline_frame(
                &tl,
                &settings,
                pos,
                Some(1280),
                FrameIntent::Single,
                decode_pipe::PipeLane::LIVE,
            )
            .expect("frame")
            .expect("a picture");
            t.elapsed().as_secs_f64() * 1000.0
        };
        let _ = frame(0);
        // A drag forward: +3 frames per move, like a slow mouse drag.
        let mut drag: Vec<f64> = (1..=60).map(|i| frame(i * 3)).collect();
        // Jumps: a deterministic walk all over the clip.
        let mut jumps: Vec<f64> = (0..30u64).map(|i| frame((i * 197 + 61) % 590)).collect();
        // A drag backwards: -2 frames per move.
        let mut back: Vec<f64> = (0..40u64).map(|i| frame(500 - i * 2)).collect();
        let alive = ffmpeg_children();
        eprintln!(
            "{label}: drag fwd p50 {:.1} p95 {:.1} ms · jump p50 {:.1} p95 {:.1} ms · drag back p50 {:.1} p95 {:.1} ms · ffmpeg children alive {alive}",
            percentile(&mut drag, 0.5),
            percentile(&mut drag, 0.95),
            percentile(&mut jumps, 0.5),
            percentile(&mut jumps, 0.95),
            percentile(&mut back, 0.5),
            percentile(&mut back, 0.95),
        );
        decode_pipe::reset();
    }
}
