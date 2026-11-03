//! **The export benchmark (B-380): how long an export takes, stage by stage,
//! on a realistic timeline, on both export paths and both encoders.**
//!
//! What it is: one `#[ignore]`d measurement,
//! [`measure_export_benchmark`], over the fixture
//! `packages/editor/src/exportBenchFixture.test.ts` compiles into
//! `tests/fixtures/export-bench.json` — a 60 s explainer-shaped timeline (a
//! jump-cut A-roll with its voice, four B-roll cutaways with a rounded PIP, a
//! crop and a keyframed slide, a lower-third PNG and a moving overlay, a music
//! bed) at 1080p and at 4K. It generates textured media with real ffmpeg (grain,
//! motion, so the encoders do real work: flat colour would flatter every
//! encoder), runs each configuration end to end, and prints, per run:
//!
//! - wall time and the export-to-runtime ratio (the number B-380 is about);
//! - the stages — for the compositor path the renderer's own
//!   [`super::RenderStages`] (decode + composite, resize, waiting on the
//!   encoder, concat, loudness), for the filter path the same argv with the
//!   encoder removed (decode + composite + scale) against the whole run;
//! - average CPU use over the run (this process plus every ffmpeg child, from
//!   `getrusage`), average and peak GPU use (`ioreg`'s IOAccelerator "Device
//!   Utilization %", which covers the GPU, not the separate media engine), and
//!   the peak resident memory of the whole process tree;
//! - the output's frame count, video vs audio duration (A/V sync), and — when
//!   both encoders of one path ran — PSNR / SSIM of the hardware file against the
//!   software one.
//!
//! What it does NOT do: assert anything (it samples a live, shared machine — a
//! measurement to read, as every `measure_*` in `edit_render` is), or keep files:
//! each output is deleted as soon as it has been measured, and the media
//! directory is a temp dir unless `APELLES_BENCH_MEDIA_DIR` names one to reuse.
//!
//! ```text
//! CHROMA_FFMPEG=$PWD/target/debug/ffmpeg CHROMA_FFPROBE=$PWD/target/debug/ffprobe \
//! APELLES_BENCH_SIZE=4k \
//! cargo test -p apelles --lib chroma::edit_render::export_bench -- --ignored --nocapture
//! ```
//!
//! Environment:
//! - `APELLES_BENCH_SIZE` — `1080p` (default) or `4k`.
//! - `APELLES_BENCH_CONFIGS` — comma list from `filter-software`,
//!   `filter-hardware`, `compositor-software`, `compositor-hardware`
//!   (default: all four, in that order).
//! - `APELLES_BENCH_SEGMENTS` — compositor segment counts to sweep, comma list;
//!   `auto` (default) is what the app itself would plan on this machine.
//! - `APELLES_BENCH_REPEATS` — runs per configuration, best kept (default 1).
//! - `APELLES_BENCH_SPLIT=1` — also run the filter path without its encoder.
//! - `APELLES_BENCH_LOUDNESS=1` — run the D-401 loudness pass (-14 LUFS /
//!   -1 dBTP) on each output and time it.
//! - `APELLES_BENCH_MEDIA_DIR` — generate (or reuse) the media there.
//! - `APELLES_BENCH_MIN_FREE_GB` — refuse to start a run below this much free
//!   disk (default 15).
//!
//! The recorded runs and how to read them: `docs/perf/README.md` ("Export").

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use apelles_media::ffmpeg_locate;
use apelles_media::loudness::{self, LoudnessTarget};
use apelles_project::manifest::ProjectSettings;
use apelles_timeline::Timeline;

use super::parity_tests::{
    ffmpeg_available, frame_count, localise_timeline, render_at_segments, run_ffmpeg, sample_tree,
};
use super::{
    SegmentedEncodePlan, TimelineRenderOutcome, TimelineRenderRequest, canvas_plan, edit,
    render_timeline,
};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BenchCase {
    width: u32,
    height: u32,
    filter_args: Vec<String>,
    pipe_args: Vec<String>,
    pipe_frames: u64,
    segment_args: Vec<String>,
    concat_args: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceFrames {
    aroll: u32,
    broll: u32,
    motion: u32,
    music: u32,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BenchFixture {
    fps: f64,
    duration_sec: f64,
    source_frames: SourceFrames,
    timeline: Timeline,
    cases: std::collections::HashMap<String, BenchCase>,
}

fn load_fixture() -> BenchFixture {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/export-bench.json");
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e} — regenerate it with WRITE_EXPORT_BENCH_FIXTURE=1 npx vitest run \
             packages/editor/src/exportBenchFixture.test.ts",
            path.display()
        )
    });
    serde_json::from_str(&raw).expect("export-bench.json is not valid JSON")
}

pub(super) fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

/// Free bytes on the volume holding `dir` (`statvfs`).
pub(super) fn free_bytes(dir: &Path) -> u64 {
    let Ok(c) = std::ffi::CString::new(dir.to_string_lossy().as_bytes()) else {
        return 0;
    };
    // SAFETY: `c` is a valid NUL-terminated path and `st` a zeroed out-param
    // that `statvfs` fills; nothing is read from it unless the call succeeded.
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return 0;
    }
    u64::from(st.f_bavail).saturating_mul(st.f_frsize)
}

pub(super) fn require_disk(dir: &Path) {
    let min_gb: u64 = env_or("APELLES_BENCH_MIN_FREE_GB", "15")
        .parse()
        .unwrap_or(15);
    let free_gb = free_bytes(dir) / 1_000_000_000;
    assert!(
        free_gb >= min_gb,
        "only {free_gb} GB free on the volume holding {} — the benchmark needs {min_gb} GB \
         (APELLES_BENCH_MIN_FREE_GB); stopping rather than filling the disk",
        dir.display()
    );
}

/// Generate the fixture's media at `w`×`h`: textured, moving, grainy picture
/// (camera-like: `testsrc2` + temporal noise, encoded at a camera bitrate with
/// VideoToolbox), a voice-like tone on the A-roll, a music bed, and an alpha PNG.
fn generate_media(dir: &Path, fx: &BenchFixture, w: u32, h: u32) -> Result<(), String> {
    let fps = fx.fps;
    let secs = |frames: u32| frames as f64 / fps;
    // A camera-ish bitrate: ~60 Mb/s at 4K, scaled by pixels.
    let bitrate = format!(
        "{}k",
        (u64::from(w) * u64::from(h) * 60_000 / (3840 * 2160)).max(4000)
    );
    let video = |name: &str, frames: u32, look: &str, voice: bool| -> Result<(), String> {
        let path = dir.join(name);
        if path.exists() {
            return Ok(());
        }
        let mut args: Vec<String> = vec![
            "-v".into(),
            "error".into(),
            "-y".into(),
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            format!(
                "testsrc2=size={w}x{h}:rate={fps}:duration={},{look},noise=alls=6:allf=t",
                secs(frames)
            ),
        ];
        if voice {
            args.extend([
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                format!(
                    "sine=frequency=180:sample_rate=48000:duration={},tremolo=f=3:d=0.7,volume=0.5",
                    secs(frames)
                ),
            ]);
        }
        args.extend(
            [
                "-c:v",
                "h264_videotoolbox",
                "-b:v",
                bitrate.as_str(),
                "-pix_fmt",
                "yuv420p",
            ]
            .map(String::from),
        );
        if voice {
            args.extend(["-c:a", "aac", "-b:a", "192k", "-shortest"].map(String::from));
        }
        args.push(path.to_string_lossy().into_owned());
        run_ffmpeg(&args)
    };
    video(
        "aroll.mp4",
        fx.source_frames.aroll,
        "eq=saturation=0.8",
        true,
    )?;
    video("broll.mp4", fx.source_frames.broll, "hue=h=t*25", false)?;
    video("motion.mp4", fx.source_frames.motion, "negate", false)?;

    let still = dir.join("lower-third.png");
    if !still.exists() {
        run_ffmpeg(&[
            "-v".into(),
            "error".into(),
            "-y".into(),
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            format!("testsrc2=size={}x{}:rate=1:duration=1", w / 2, h / 8),
            "-vf".into(),
            "format=rgba,colorchannelmixer=aa=0.85".into(),
            "-frames:v".into(),
            "1".into(),
            still.to_string_lossy().into_owned(),
        ])?;
    }
    let music = dir.join("music.m4a");
    if !music.exists() {
        run_ffmpeg(&[
            "-v".into(),
            "error".into(),
            "-y".into(),
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            format!(
                "anoisesrc=color=pink:amplitude=0.15:sample_rate=48000:duration={}",
                secs(fx.source_frames.music)
            ),
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            format!(
                "sine=frequency=220:sample_rate=48000:duration={}",
                secs(fx.source_frames.music)
            ),
            "-filter_complex".into(),
            "[0:a][1:a]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo".into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "192k".into(),
            music.to_string_lossy().into_owned(),
        ])?;
    }
    Ok(())
}

/// Rewrite the fixture's placeholders (`OUT`, each bare media name) to this
/// run's paths.
fn localise(args: &[String], dir: &Path, out: &Path) -> Vec<String> {
    const MEDIA: [&str; 5] = [
        "aroll.mp4",
        "broll.mp4",
        "motion.mp4",
        "lower-third.png",
        "music.m4a",
    ];
    args.iter()
        .map(|a| {
            if a == "OUT" {
                out.to_string_lossy().into_owned()
            } else if MEDIA.contains(&a.as_str()) {
                dir.join(a).to_string_lossy().into_owned()
            } else {
                a.clone()
            }
        })
        .collect()
}

/// The filter argv with its encoder removed and its output sent to the null
/// muxer (which takes decoded frames as they are): what decode + composite +
/// scale cost on their own. Drops `-c:v …` up to the `-r` that follows it.
fn without_encoder(args: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut skipping = false;
    for (i, a) in args.iter().enumerate() {
        if a == "-c:v" {
            skipping = true;
        }
        if skipping && a == "-r" {
            skipping = false;
        }
        if skipping {
            continue;
        }
        if i == args.len() - 1 {
            out.extend(["-f", "null", "-"].map(String::from));
        } else {
            out.push(a.clone());
        }
    }
    out
}

/// CPU seconds (user + system) used so far by this process and its reaped
/// children.
fn cpu_seconds() -> f64 {
    let read = |who: libc::c_int| -> f64 {
        // SAFETY: a zeroed `rusage` out-param that `getrusage` fills.
        let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
        if unsafe { libc::getrusage(who, &mut ru) } != 0 {
            return 0.0;
        }
        let tv = |t: libc::timeval| t.tv_sec as f64 + t.tv_usec as f64 / 1e6;
        tv(ru.ru_utime) + tv(ru.ru_stime)
    };
    read(libc::RUSAGE_SELF) + read(libc::RUSAGE_CHILDREN)
}

/// The GPU's "Device Utilization %" from `ioreg`, or `None` when unreadable.
fn gpu_utilisation() -> Option<u32> {
    let out = std::process::Command::new("ioreg")
        .args(["-r", "-d", "1", "-c", "IOAccelerator"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let key = "\"Device Utilization %\"=";
    let at = text.find(key)? + key.len();
    text[at..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .ok()
}

#[derive(Default, Clone)]
struct Probe {
    peak_rss_mb: f64,
    gpu_sum: u64,
    gpu_n: u64,
    gpu_peak: u32,
}

/// Samples the process tree's memory and the GPU every 250 ms while `f` runs.
fn sampled<T>(f: impl FnOnce() -> T) -> (T, Probe, Duration, f64) {
    let stop = Arc::new(AtomicBool::new(false));
    let probe = Arc::new(Mutex::new(Probe::default()));
    let sampler = {
        let (stop, probe) = (stop.clone(), probe.clone());
        std::thread::spawn(move || {
            let me = std::process::id();
            while !stop.load(Ordering::Relaxed) {
                let rss = sample_tree(me).map(|s| s.peak_rss_mb).unwrap_or(0.0);
                let gpu = gpu_utilisation();
                let mut p = probe.lock().unwrap_or_else(|e| e.into_inner());
                p.peak_rss_mb = p.peak_rss_mb.max(rss);
                if let Some(g) = gpu {
                    p.gpu_sum += u64::from(g);
                    p.gpu_n += 1;
                    p.gpu_peak = p.gpu_peak.max(g);
                }
                drop(p);
                std::thread::sleep(Duration::from_millis(250));
            }
        })
    };
    let cpu0 = cpu_seconds();
    let t0 = Instant::now();
    let value = f();
    let wall = t0.elapsed();
    let cpu = cpu_seconds() - cpu0;
    stop.store(true, Ordering::Relaxed);
    let _ = sampler.join();
    let p = probe.lock().unwrap_or_else(|e| e.into_inner()).clone();
    (value, p, wall, cpu)
}

/// Video and audio stream durations, seconds (A/V sync: they should agree to
/// within a frame).
pub(super) fn stream_durations(path: &Path) -> (f64, f64) {
    let read = |sel: &str| -> f64 {
        ffmpeg_locate::ffprobe()
            .ok()
            .and_then(|mut c| {
                c.args([
                    "-v",
                    "error",
                    "-select_streams",
                    sel,
                    "-show_entries",
                    "stream=duration",
                    "-of",
                    "default=nw=1:nk=1",
                ])
                .arg(path)
                .output()
                .ok()
            })
            .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
            .unwrap_or(f64::NAN)
    };
    (read("v:0"), read("a:0"))
}

/// PSNR (average, dB) and SSIM (All) of `dist` against `reference`.
fn psnr_ssim(dist: &Path, reference: &Path) -> (String, String) {
    let run = |filter: &str, key: &str| -> String {
        let out = ffmpeg_locate::ffmpeg().ok().and_then(|mut c| {
            c.args(["-hide_banner", "-i"])
                .arg(dist)
                .arg("-i")
                .arg(reference)
                .args([
                    "-lavfi",
                    &format!("[0:v]format=yuv420p[d];[1:v]format=yuv420p[r];[d][r]{filter}"),
                    "-f",
                    "null",
                    "-",
                ])
                .stdout(Stdio::null())
                .output()
                .ok()
        });
        let text = out
            .map(|o| String::from_utf8_lossy(&o.stderr).into_owned())
            .unwrap_or_default();
        text.rfind(key)
            .map(|at| {
                text[at + key.len()..]
                    .chars()
                    .take_while(|c| {
                        c.is_ascii_digit() || *c == '.' || *c == 'i' || *c == 'n' || *c == 'f'
                    })
                    .collect()
            })
            .unwrap_or_else(|| "?".to_string())
    };
    (run("psnr", "average:"), run("ssim", "All:"))
}

struct RunReport {
    label: String,
    wall: Duration,
    cpu_pct: f64,
    probe: Probe,
    stages: String,
}

fn print_run(r: &RunReport, runtime: f64, baseline_rss: f64) {
    let cores = std::thread::available_parallelism()
        .map(std::num::NonZeroUsize::get)
        .unwrap_or(1);
    eprintln!(
        "{:<28} {:>8.1}s  x{:<5.2}  cpu {:>4.0}% of {cores}  gpu avg {:>3.0}% peak {:>3}%  \
         rss +{:>6.0} MB  {}",
        r.label,
        r.wall.as_secs_f64(),
        r.wall.as_secs_f64() / runtime,
        r.cpu_pct,
        if r.probe.gpu_n > 0 {
            r.probe.gpu_sum as f64 / r.probe.gpu_n as f64
        } else {
            f64::NAN
        },
        r.probe.gpu_peak,
        (r.probe.peak_rss_mb - baseline_rss).max(0.0),
        r.stages,
    );
}

fn cpu_pct(cpu: f64, wall: Duration) -> f64 {
    let cores = std::thread::available_parallelism()
        .map(std::num::NonZeroUsize::get)
        .unwrap_or(1) as f64;
    100.0 * cpu / wall.as_secs_f64().max(1e-9) / cores
}

fn compositor_stages(o: &TimelineRenderOutcome) -> String {
    let s = &o.stages;
    format!(
        "segs {} · render {:.1}s [per-worker sums: decode+composite {:.1}s, resize {:.1}s, \
         wait-on-encoder {:.1}s] · concat {:.1}s",
        o.segments,
        s.render_ms as f64 / 1000.0,
        s.frame_ms as f64 / 1000.0,
        s.resize_ms as f64 / 1000.0,
        s.handoff_wait_ms as f64 / 1000.0,
        s.concat_ms as f64 / 1000.0,
    )
}

/// Check the finished file, run the optional loudness pass, and compare with
/// the reference when one is given. Returns a one-line summary.
fn check_output(path: &Path, frames: u64, fps: f64, reference: Option<&Path>) -> String {
    let counted = frame_count(path).unwrap_or(0);
    let (v, a) = stream_durations(path);
    let mut line = format!(
        "frames {counted}/{frames} · video {v:.3}s audio {a:.3}s (Δ {:.1} frames) · {:.0} MB",
        (v - a).abs() * fps,
        std::fs::metadata(path).map(|m| m.len()).unwrap_or(0) as f64 / 1e6
    );
    if let Some(r) = reference {
        let (psnr, ssim) = psnr_ssim(path, r);
        line.push_str(&format!(" · vs software: PSNR {psnr} dB, SSIM {ssim}"));
    }
    if std::env::var("APELLES_BENCH_LOUDNESS").as_deref() == Ok("1") {
        let t = Instant::now();
        let target = LoudnessTarget {
            integrated_lufs: -14.0,
            true_peak_dbtp: -1.0,
        };
        match loudness::normalise_in_place(path, target) {
            Ok(rep) => line.push_str(&format!(
                " · loudness pass {:.1}s ({} attempt(s)): {:.2} → {:.2} LUFS, peak {:.2} dBTP",
                t.elapsed().as_secs_f64(),
                rep.attempts,
                rep.before
                    .as_ref()
                    .map(|m| m.integrated_lufs)
                    .unwrap_or(f64::NAN),
                rep.after
                    .as_ref()
                    .map(|m| m.integrated_lufs)
                    .unwrap_or(f64::NAN),
                rep.after
                    .as_ref()
                    .map(|m| m.true_peak_dbtp)
                    .unwrap_or(f64::NAN),
            )),
            Err(e) => line.push_str(&format!(" · loudness pass failed: {e}")),
        }
    }
    line
}

/// The time to decode the A-roll's whole runtime the way `decode_pipe` does
/// (VideoToolbox decode, RGB out, piped) — the decode floor of one track.
fn decode_floor(dir: &Path, secs: f64) -> Duration {
    let t = Instant::now();
    let _ = ffmpeg_locate::ffmpeg().map(|mut c| {
        c.args([
            "-v",
            "error",
            "-hwaccel",
            "videotoolbox",
            "-t",
            &secs.to_string(),
            "-i",
        ])
        .arg(dir.join("aroll.mp4"))
        .args(["-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
        .stdout(Stdio::null())
        .status()
    });
    t.elapsed()
}

#[test]
#[ignore = "a live export benchmark, not a pass/fail assertion — see the module doc"]
fn measure_export_benchmark() {
    if !ffmpeg_available() {
        eprintln!("skipping: ffmpeg/ffprobe not found");
        return;
    }
    let _guard = super::super::PROJECT_STATE_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let fx = load_fixture();
    let size = env_or("APELLES_BENCH_SIZE", "1080p");
    let configs = env_or(
        "APELLES_BENCH_CONFIGS",
        "filter-software,filter-hardware,compositor-software,compositor-hardware",
    );
    let segments_plan = env_or("APELLES_BENCH_SEGMENTS", "auto");
    let repeats: usize = env_or("APELLES_BENCH_REPEATS", "1")
        .parse()
        .unwrap_or(1)
        .max(1);
    let split = std::env::var("APELLES_BENCH_SPLIT").as_deref() == Ok("1");

    let tmp = tempfile::tempdir().expect("tempdir");
    let media_dir = std::env::var("APELLES_BENCH_MEDIA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| tmp.path().join("media"));
    std::fs::create_dir_all(&media_dir).expect("media dir");
    let out_dir = tmp.path().join("out");
    std::fs::create_dir_all(&out_dir).expect("out dir");
    require_disk(&out_dir);

    let any = fx
        .cases
        .get(&format!("{size}-software"))
        .unwrap_or_else(|| panic!("no bench case for size {size}"));
    let (w, h) = (any.width, any.height);
    let gen_started = Instant::now();
    generate_media(&media_dir, &fx, w, h).expect("generate media");
    let timeline = localise_timeline(&fx.timeline, &media_dir);
    let settings = ProjectSettings {
        width: Some(w),
        height: Some(h),
        fps: Some(fx.fps),
        color_space: None,
    };
    let runtime = fx.duration_sec;
    let baseline_rss = sample_tree(std::process::id())
        .map(|s| s.peak_rss_mb)
        .unwrap_or(0.0);

    eprintln!(
        "\n=== B-380 export benchmark: {w}x{h} @ {} fps, {runtime:.0} s timeline \
         ({} video tracks, {} clips), media ready in {:.1}s ===",
        fx.fps,
        timeline
            .tracks
            .iter()
            .filter(|t| matches!(t.kind, apelles_timeline::TrackKind::Video))
            .count(),
        timeline.tracks.iter().map(|t| t.clips.len()).sum::<usize>(),
        gen_started.elapsed().as_secs_f64(),
    );
    let floor = decode_floor(&media_dir, runtime);
    eprintln!(
        "decode floor (one track, A-roll {runtime:.0} s, VideoToolbox → rgb24 pipe): {:.1}s  x{:.2}",
        floor.as_secs_f64(),
        floor.as_secs_f64() / runtime
    );
    eprintln!("ffmpeg: {:?}", ffmpeg_locate::ffmpeg_path());

    // The software output of each path is kept until its hardware twin has been
    // compared with it, then both are deleted.
    let mut reference: Option<(String, PathBuf)> = None;
    for config in configs.split(',').map(str::trim).filter(|c| !c.is_empty()) {
        let (path_kind, encoder) = config
            .split_once('-')
            .unwrap_or_else(|| panic!("bad config {config}"));
        let case = fx
            .cases
            .get(&format!("{size}-{encoder}"))
            .unwrap_or_else(|| panic!("no bench case {size}-{encoder}"));
        let seg_list: Vec<String> = if path_kind == "compositor" {
            segments_plan
                .split(',')
                .map(|s| s.trim().to_string())
                .collect()
        } else {
            vec!["-".to_string()]
        };
        for segs in seg_list {
            let mut best: Option<(RunReport, PathBuf)> = None;
            for rep in 0..repeats {
                require_disk(&out_dir);
                let out = out_dir.join(format!("{config}-{segs}-{rep}.mp4"));
                let (stages, probe, wall, cpu) = match path_kind {
                    "filter" => {
                        let args = localise(&case.filter_args, &media_dir, &out);
                        let ((), probe, wall, cpu) =
                            sampled(|| run_ffmpeg(&args).expect("the filter path"));
                        (String::new(), probe, wall, cpu)
                    }
                    "compositor" => {
                        let plan = SegmentedEncodePlan {
                            segment_args: localise(&case.segment_args, &media_dir, &out),
                            concat_args: localise(&case.concat_args, &media_dir, &out),
                        };
                        let req = TimelineRenderRequest {
                            args: localise(&case.pipe_args, &media_dir, &out),
                            width: w,
                            height: h,
                            frames: case.pipe_frames,
                            segments: Some(plan.clone()),
                            output: Some(out.to_string_lossy().into_owned()),
                            loudness: None,
                            timeline_id: None,
                            cancel_token: None,
                        };
                        let (outcome, probe, wall, cpu) = sampled(|| {
                            if segs == "auto" {
                                render_timeline(&timeline, &settings, &req)
                            } else {
                                let n: usize = segs.parse().expect("segment count");
                                let comp = edit::composition_size(&settings, &timeline)
                                    .expect("composition size");
                                render_at_segments(
                                    &timeline,
                                    &settings,
                                    &req,
                                    &plan,
                                    n,
                                    (w, h),
                                    canvas_plan(comp, (w, h)),
                                )
                            }
                        });
                        let outcome = outcome.expect("the compositor path");
                        (compositor_stages(&outcome), probe, wall, cpu)
                    }
                    other => panic!("unknown path {other}"),
                };
                let report = RunReport {
                    label: format!(
                        "{config}{}",
                        if segs == "-" {
                            String::new()
                        } else {
                            format!(" [{segs}]")
                        }
                    ),
                    wall,
                    cpu_pct: cpu_pct(cpu, wall),
                    probe,
                    stages,
                };
                let keep = best.as_ref().is_none_or(|(b, _)| wall < b.wall);
                if keep {
                    if let Some((_, old)) = best.take() {
                        let _ = std::fs::remove_file(old);
                    }
                    best = Some((report, out));
                } else {
                    let _ = std::fs::remove_file(&out);
                }
            }
            let Some((report, out)) = best else { continue };
            print_run(&report, runtime, baseline_rss);
            let reference_path = reference
                .as_ref()
                .filter(|(p, _)| p == path_kind && encoder == "hardware")
                .map(|(_, f)| f.clone());
            eprintln!(
                "    {}",
                check_output(&out, case.pipe_frames, fx.fps, reference_path.as_deref())
            );
            if encoder == "software" && segs == seg_list_first(&segments_plan, path_kind) {
                if let Some((_, old)) = reference.take() {
                    let _ = std::fs::remove_file(old);
                }
                reference = Some((path_kind.to_string(), out));
            } else {
                let _ = std::fs::remove_file(&out);
            }
        }
        if path_kind == "filter" && split {
            let out = out_dir.join(format!("{config}-null"));
            let args = without_encoder(&localise(&case.filter_args, &media_dir, &out));
            let ((), probe, wall, cpu) =
                sampled(|| run_ffmpeg(&args).expect("the filter path without its encoder"));
            print_run(
                &RunReport {
                    label: format!("{config} (no encode)"),
                    wall,
                    cpu_pct: cpu_pct(cpu, wall),
                    probe,
                    stages: "decode + composite + scale only".to_string(),
                },
                runtime,
                baseline_rss,
            );
        }
    }
    if let Some((_, old)) = reference.take() {
        let _ = std::fs::remove_file(old);
    }
    eprintln!(
        "\n(x = export time ÷ the timeline's runtime; under 1.00 is faster than real time. \
         {} logical cores, {:.0} GB free after the run.)\n",
        std::thread::available_parallelism()
            .map(std::num::NonZeroUsize::get)
            .unwrap_or(0),
        free_bytes(&out_dir) as f64 / 1e9
    );
}

/// The segment entry whose software output is kept as the reference: the
/// first one listed for that path.
fn seg_list_first(plan: &str, path_kind: &str) -> String {
    if path_kind == "compositor" {
        plan.split(',').next().unwrap_or("auto").trim().to_string()
    } else {
        "-".to_string()
    }
}

#[test]
fn without_encoder_drops_the_codec_tail_and_writes_to_null() {
    let args: Vec<String> = [
        "-i",
        "a.mp4",
        "-map",
        "[outv]",
        "-c:v",
        "h264_videotoolbox",
        "-q:v",
        "70",
        "-pix_fmt",
        "yuv420p",
        "-r",
        "30",
        "-t",
        "60",
        "OUT",
    ]
    .map(String::from)
    .to_vec();
    assert_eq!(
        without_encoder(&args),
        [
            "-i", "a.mp4", "-map", "[outv]", "-r", "30", "-t", "60", "-f", "null", "-"
        ]
        .map(String::from)
        .to_vec()
    );
}

#[test]
fn the_bench_fixture_has_both_encoders_at_both_sizes() {
    let fx = load_fixture();
    for key in [
        "1080p-software",
        "1080p-hardware",
        "4k-software",
        "4k-hardware",
    ] {
        let c = fx
            .cases
            .get(key)
            .unwrap_or_else(|| panic!("missing case {key}"));
        assert_eq!(c.pipe_frames, (fx.duration_sec * fx.fps).round() as u64);
    }
    assert!(
        fx.cases["4k-hardware"]
            .pipe_args
            .iter()
            .any(|a| a == "h264_videotoolbox")
    );
    assert!(
        fx.cases["4k-software"]
            .pipe_args
            .iter()
            .any(|a| a == "libx264")
    );
}
