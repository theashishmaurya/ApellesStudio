//! **The real-project export parity check (B-380): the filter path against the
//! compositor path, on a copy of one of the owner's projects.**
//!
//! What it is: one `#[ignore]`d measurement, [`measure_real_project_parity`],
//! the oracle for making the compositor the only export renderer. Point it at a
//! COPY of a `.chroma` project (an APFS clone, `cp -c`; never the original — it
//! writes baked LUTs and the coverage grades into the copy). It:
//!
//! 1. opens the copy as the current project and writes the backend facts the
//!    export compiler needs (the font catalogue, each timeline's composition
//!    size);
//! 2. runs `packages/editor/src/exportParityReal.test.ts` (`plan`), which cuts
//!    short ranges out of the timelines around every effect they carry, adds
//!    whole timelines and a coverage timeline built from the copy's own media,
//!    and lists what must be measured first;
//! 3. writes the coverage grades (primaries; curves + a `.cube`; a radial
//!    mask), bakes every clip's grade through `grade_lut` exactly as an export
//!    does, measures the animated captions' words, and runs the TypeScript half
//!    again (`compile`), which compiles each case with the real
//!    `compileEditorExportArgs` on both renderers, same encoder;
//! 4. renders each case both ways and compares: frame count and duration, the
//!    A/V offset (stream starts and lengths, and the audio's own lag between
//!    the two files), PSNR / SSIM per frame with the worst frames listed and
//!    written out as side-by-side PNGs when they differ, integrated LUFS and
//!    true peak, and a sample-level audio difference. For a graded coverage
//!    clip it also renders the same source frame through the Colorist's own
//!    pipeline (`export::grade_frame`, masks included) and compares both
//!    exports with it.
//!
//! What it does NOT do: assert (it is a measurement to read, like
//! `export_bench`), or keep video: each output is deleted once measured. The
//! report (a JSON line per case, and the PNGs) goes to `APELLES_PARITY_REPORT`.
//!
//! ```text
//! CHROMA_FFMPEG=$PWD/target/debug/ffmpeg CHROMA_FFPROBE=$PWD/target/debug/ffprobe \
//! APELLES_PARITY_PROJECT=/path/to/copy.chroma APELLES_PARITY_REPORT=/path/to/report \
//! APELLES_PARITY_TIMELINES='Voiceover v2' APELLES_PARITY_FULL='Short 1 - …' APELLES_PARITY_COVERAGE=1 \
//! cargo test -p apelles --lib chroma::edit_render::export_parity_real -- --ignored --nocapture
//! ```
//!
//! Environment: `APELLES_PARITY_TIMELINES` / `APELLES_PARITY_FULL` are `|`-separated
//! timeline names (ranges / whole timeline); `APELLES_PARITY_RANGE_SECS` the
//! range length (default 3); `APELLES_PARITY_COVERAGE=1` adds the coverage and
//! Clip-exception timelines; `APELLES_BENCH_MIN_FREE_GB` the disk floor (15).
//! Results: `docs/perf/2026-11-03-export-parity-report.md`.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use apelles_media::ffmpeg_locate;
use apelles_media::loudness;
use apelles_project::manifest::{self, ProjectSettings};
use apelles_timeline::Timeline;
use serde_json::{Value, json};

use super::export_bench::{env_or, require_disk, stream_durations};
use super::parity_tests::{ffmpeg_available, frame_count, run_ffmpeg};
use super::{SegmentedEncodePlan, TimelineRenderRequest, edit, render_timeline};
use crate::chroma::{grade_lut, state, text};

/// The placeholder output path the TypeScript half compiles every argv with.
const OUT_PLACEHOLDER: &str = "/OUT.mp4";
/// Frames below this PSNR (dB) against the filter path are written out as PNGs.
const SCREENSHOT_BELOW_DB: f64 = 40.0;
/// How many worst frames each case lists.
const WORST_FRAMES: usize = 5;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlannedCase {
    timeline: Timeline,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Plan {
    cases: Vec<PlannedCase>,
    coverage_grades: BTreeMap<String, String>,
    caption_requests: Vec<CaptionRequest>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptionRequest {
    font: String,
    font_px: u32,
    words: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompiledCase {
    label: String,
    effects: Vec<String>,
    timeline: Timeline,
    width: u32,
    height: u32,
    fps: f64,
    filter_args: Option<Vec<String>>,
    filter_error: Option<String>,
    pipe_args: Option<Vec<String>>,
    pipe_error: Option<String>,
    pipe_frames: Option<u64>,
    segment_args: Option<Vec<String>>,
    concat_args: Option<Vec<String>>,
    pipe_timeline: Option<Timeline>,
}

#[derive(serde::Deserialize)]
struct Compiled {
    cases: Vec<CompiledCase>,
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Run one stage of the TypeScript half.
fn run_ts_stage(stage: &str, envs: &[(&str, &Path)]) -> Result<(), String> {
    let mut cmd = Command::new("npx");
    cmd.current_dir(repo_root().join("packages/editor"))
        .args(["vitest", "run", "src/exportParityReal.test.ts"])
        .env("APELLES_PARITY_STAGE", stage);
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let out = cmd.output().map_err(|e| format!("spawn npx vitest: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "the TypeScript half ({stage}) failed:\n{}\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

fn write_json(path: &Path, v: &Value) {
    std::fs::write(path, serde_json::to_vec(v).expect("serialise")).expect("write json");
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> T {
    let raw = std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_slice(&raw).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// A 17³ `.cube` with a gentle teal-and-orange look, for the coverage grade's
/// LUT slot. Written into the copy, so the grade names a real file.
fn write_look_cube(path: &Path) {
    let n = 17usize;
    let mut s = String::from("TITLE \"parity look\"\nLUT_3D_SIZE 17\n");
    for b in 0..n {
        for g in 0..n {
            for r in 0..n {
                let (r, g, b) = (r as f64 / 16.0, g as f64 / 16.0, b as f64 / 16.0);
                let l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                let mix = |c: f64, t: f64| (c + (t - c) * 0.25).clamp(0.0, 1.0);
                // shadows toward teal, highlights toward orange
                let (tr, tg, tb) = if l < 0.5 {
                    (0.1, 0.45, 0.5)
                } else {
                    (1.0, 0.7, 0.45)
                };
                s.push_str(&format!(
                    "{:.6} {:.6} {:.6}\n",
                    mix(r, tr),
                    mix(g, tg),
                    mix(b, tb)
                ));
            }
        }
    }
    std::fs::write(path, s).expect("write .cube");
}

/// The coverage grades, as the Colorist writes them: an existing grade file of
/// the copy (every default the Colorist writes) with the coverage values on top.
fn write_coverage_grades(
    project: &Path,
    grades: &BTreeMap<String, String>,
) -> BTreeMap<String, Value> {
    let dir = manifest::grade_dir(project);
    std::fs::create_dir_all(&dir).expect("grades dir");
    let template = std::fs::read_dir(&dir)
        .ok()
        .and_then(|mut it| {
            it.find_map(|e| {
                let p = e.ok()?.path();
                let raw = std::fs::read(&p).ok()?;
                serde_json::from_slice::<Value>(&raw).ok()
            })
        })
        .unwrap_or_else(|| json!({ "schema": "chroma.grade/1", "notes": "", "adjustments": {} }));
    let cube = project.join("parity-look.cube");
    write_look_cube(&cube);
    let mut out = BTreeMap::new();
    for (clip_id, kind) in grades {
        let mut g = template.clone();
        let a = g["adjustments"]
            .as_object_mut()
            .expect("adjustments object");
        a.insert("exposure".into(), json!(0.35));
        a.insert("contrast".into(), json!(18));
        a.insert("saturation".into(), json!(22));
        a.insert("temperature".into(), json!(12));
        a.insert("highlights".into(), json!(-25));
        a.insert("shadows".into(), json!(15));
        a.insert("masks".into(), json!([]));
        if kind == "curves_lut" {
            a.insert(
                "curves".into(),
                json!({
                    "luma": [{"x":0,"y":0},{"x":64,"y":48},{"x":192,"y":210},{"x":255,"y":255}],
                    "red": [{"x":0,"y":0},{"x":128,"y":140},{"x":255,"y":255}],
                    "green": [{"x":0,"y":0},{"x":255,"y":255}],
                    "blue": [{"x":0,"y":0},{"x":128,"y":118},{"x":255,"y":255}]
                }),
            );
            a.insert("lutPath".into(), json!(cube.to_string_lossy()));
            a.insert("lutIntensity".into(), json!(100));
        }
        if kind == "mask" {
            a.insert(
                "masks".into(),
                json!([{
                    "id": "parity-mask", "name": "radial", "visible": true, "invert": false, "opacity": 100,
                    "adjustments": { "exposure": 1.5, "saturation": -60 },
                    "subMasks": [{
                        "id": "parity-sub", "type": "radial", "visible": true, "invert": false, "opacity": 100,
                        "mode": "additive",
                        "parameters": { "centerX": 960.0, "centerY": 540.0, "radiusX": 500.0, "radiusY": 400.0, "rotation": 0.0, "feather": 50.0 }
                    }]
                }]),
            );
        }
        let path = grade_lut::grade_file_for(project, clip_id);
        std::fs::write(&path, serde_json::to_vec_pretty(&g).expect("grade json"))
            .expect("write grade");
        out.insert(clip_id.clone(), g["adjustments"].clone());
    }
    out
}

fn localise(args: &[String], out: &Path) -> Vec<String> {
    args.iter()
        .map(|a| {
            if a == OUT_PLACEHOLDER {
                out.to_string_lossy().into_owned()
            } else {
                a.clone()
            }
        })
        .collect()
}

/// Per-frame PSNR (average over planes, dB) and SSIM (All) of `dist` against
/// `reference`, from ffmpeg's own stats files.
fn per_frame_quality(
    dist: &Path,
    reference: &Path,
    scratch: &Path,
) -> Result<Vec<(f64, f64)>, String> {
    let psnr = scratch.join("psnr.log");
    let ssim = scratch.join("ssim.log");
    let graph = format!(
        "[0:v]format=yuv420p,split[a1][a2];[1:v]format=yuv420p,split[b1][b2];\
         [a1][b1]psnr=stats_file={};[a2][b2]ssim=stats_file={}",
        psnr.display(),
        ssim.display()
    );
    run_ffmpeg(&[
        "-v".into(),
        "error".into(),
        "-i".into(),
        dist.to_string_lossy().into_owned(),
        "-i".into(),
        reference.to_string_lossy().into_owned(),
        "-lavfi".into(),
        graph,
        "-f".into(),
        "null".into(),
        "-".into(),
    ])?;
    let field = |line: &str, key: &str| -> Option<f64> {
        let at = line.find(key)? + key.len();
        let v: String = line[at..]
            .chars()
            .take_while(|c| !c.is_whitespace())
            .collect();
        if v == "inf" {
            Some(99.0)
        } else {
            v.parse().ok()
        }
    };
    let p = std::fs::read_to_string(&psnr).map_err(|e| e.to_string())?;
    let s = std::fs::read_to_string(&ssim).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&psnr);
    let _ = std::fs::remove_file(&ssim);
    Ok(p.lines()
        .zip(s.lines())
        .map(|(pl, sl)| {
            (
                field(pl, "psnr_avg:").unwrap_or(f64::NAN),
                field(sl, "All:").unwrap_or(f64::NAN),
            )
        })
        .collect())
}

/// Decoded frame `n` of `video`, RGB8.
fn decode_frame(video: &Path, n: u64, scratch: &Path) -> Result<image::RgbImage, String> {
    let png = scratch.join(format!("f{n}.png"));
    run_ffmpeg(&[
        "-v".into(),
        "error".into(),
        "-y".into(),
        "-i".into(),
        video.to_string_lossy().into_owned(),
        "-vf".into(),
        format!("select=eq(n\\,{n})"),
        "-frames:v".into(),
        "1".into(),
        png.to_string_lossy().into_owned(),
    ])?;
    let img = image::open(&png).map_err(|e| e.to_string())?.to_rgb8();
    let _ = std::fs::remove_file(&png);
    Ok(img)
}

/// The compositor frame | the filter frame | their difference ×4, side by side.
fn write_side_by_side(c: &image::RgbImage, f: &image::RgbImage, path: &Path) {
    let (w, h) = c.dimensions();
    let mut out = image::RgbImage::new(w * 3, h);
    for (x, y, p) in c.enumerate_pixels() {
        out.put_pixel(x, y, *p);
        let q = f.get_pixel(x.min(f.width() - 1), y.min(f.height() - 1));
        out.put_pixel(x + w, y, *q);
        let d = |i: usize| ((i32::from(p[i]) - i32::from(q[i])).unsigned_abs() * 4).min(255) as u8;
        out.put_pixel(x + 2 * w, y, image::Rgb([d(0), d(1), d(2)]));
    }
    let _ = out.save(path);
}

fn psnr_rgb(a: &image::RgbImage, b: &image::RgbImage) -> f64 {
    let n = a.as_raw().len().min(b.as_raw().len()).max(1);
    let mse = a
        .as_raw()
        .iter()
        .zip(b.as_raw())
        .map(|(x, y)| {
            let d = f64::from(*x) - f64::from(*y);
            d * d
        })
        .sum::<f64>()
        / n as f64;
    if mse == 0.0 {
        99.0
    } else {
        10.0 * (255.0 * 255.0 / mse).log10()
    }
}

/// The audio of `path` as interleaved stereo f32 at 48 kHz.
fn decode_audio(path: &Path) -> Vec<f32> {
    let Ok(mut c) = ffmpeg_locate::ffmpeg() else {
        return Vec::new();
    };
    let out = c
        .args(["-v", "error", "-i"])
        .arg(path)
        .args(["-vn", "-ac", "2", "-ar", "48000", "-f", "f32le", "-"])
        .stderr(Stdio::null())
        .output();
    out.map(|o| {
        o.stdout
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect()
    })
    .unwrap_or_default()
}

/// Audio comparison of `a` (compositor) against `b` (filter): the lag of `a`
/// behind `b` in samples (searched over ±20 ms on the loudest 2 s), and the
/// RMS and peak of the sample difference at that lag, in dBFS.
fn audio_diff(a: &[f32], b: &[f32]) -> (i64, f64, f64, usize, usize) {
    let frames = a.len().min(b.len()) / 2;
    if frames < 4800 {
        return (0, f64::NAN, f64::NAN, a.len() / 2, b.len() / 2);
    }
    // the loudest 2 s window of the reference
    let win = 96_000.min(frames);
    let mut best_start = 0;
    let mut best_e = -1.0f64;
    let mut s = 0;
    while s + win <= frames {
        let e: f64 = (s..s + win)
            .step_by(16)
            .map(|i| f64::from(b[2 * i]).powi(2))
            .sum();
        if e > best_e {
            best_e = e;
            best_start = s;
        }
        s += 24_000;
    }
    let max_lag = 960i64;
    let mut best_lag = 0i64;
    let mut best_err = f64::MAX;
    for lag in -max_lag..=max_lag {
        let mut err = 0.0f64;
        let mut i = best_start as i64 + max_lag;
        let end = (best_start + win) as i64 - max_lag;
        while i < end {
            let j = i + lag;
            if j >= 0 && (j as usize) < frames {
                let d = f64::from(a[2 * j as usize]) - f64::from(b[2 * i as usize]);
                err += d * d;
            }
            i += 4;
        }
        if err < best_err {
            best_err = err;
            best_lag = lag;
        }
    }
    let mut sum = 0.0f64;
    let mut peak = 0.0f64;
    let mut n = 0usize;
    for i in 0..frames {
        let j = i as i64 + best_lag;
        if j < 0 || j as usize >= frames {
            continue;
        }
        for ch in 0..2 {
            let d = (f64::from(a[2 * j as usize + ch]) - f64::from(b[2 * i + ch])).abs();
            sum += d * d;
            peak = peak.max(d);
            n += 1;
        }
    }
    let db = |v: f64| if v <= 0.0 { -200.0 } else { 20.0 * v.log10() };
    (
        best_lag,
        db((sum / n.max(1) as f64).sqrt()),
        db(peak),
        a.len() / 2,
        b.len() / 2,
    )
}

fn stream_start(path: &Path, sel: &str) -> f64 {
    ffmpeg_locate::ffprobe()
        .ok()
        .and_then(|mut c| {
            c.args([
                "-v",
                "error",
                "-select_streams",
                sel,
                "-show_entries",
                "stream=start_time",
                "-of",
                "default=nw=1:nk=1",
            ])
            .arg(path)
            .output()
            .ok()
        })
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
        .unwrap_or(f64::NAN)
}

/// The Colorist's own render of the coverage clip's frame: its source frame
/// through `export::grade_frame` (masks included), sized to the export.
fn colorist_frame(
    source: &Path,
    source_secs: f64,
    adjustments: &Value,
    size: (u32, u32),
    scratch: &Path,
) -> Result<image::RgbImage, String> {
    let png = scratch.join("colorist-src.png");
    run_ffmpeg(&[
        "-v".into(),
        "error".into(),
        "-y".into(),
        "-ss".into(),
        format!("{source_secs:.6}"),
        "-i".into(),
        source.to_string_lossy().into_owned(),
        "-frames:v".into(),
        "1".into(),
        png.to_string_lossy().into_owned(),
    ])?;
    let frame = image::open(&png).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&png);
    let ctx = crate::render_core::init_gpu_context()?;
    let caches = crate::render_core::OwnedRenderCaches::default();
    let graded = super::super::export::grade_frame(&ctx, &caches, frame, 0, adjustments)?;
    Ok(image::imageops::resize(
        &graded,
        size.0,
        size.1,
        image::imageops::FilterType::Triangle,
    ))
}

#[test]
#[ignore = "a live parity measurement on a copy of a real project — see the module doc"]
fn measure_real_project_parity() {
    if !ffmpeg_available() {
        eprintln!("skipping: ffmpeg/ffprobe not found");
        return;
    }
    let _guard = super::super::PROJECT_STATE_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let project = PathBuf::from(
        std::env::var("APELLES_PARITY_PROJECT")
            .expect("APELLES_PARITY_PROJECT names a COPY of a project"),
    );
    let report = PathBuf::from(env_or("APELLES_PARITY_REPORT", "/tmp/apelles-parity"));
    std::fs::create_dir_all(&report).expect("report dir");
    let work = tempfile::tempdir().expect("tempdir");
    require_disk(work.path());

    let man = manifest::load_manifest(&project).expect("load the copy's project.json");
    let settings: ProjectSettings = man.settings.clone();
    state::set_project(Some(state::ProjectRef {
        path: project.clone(),
        name: man.name.clone(),
    }));

    // --- 1. the facts the plan needs --------------------------------------
    let mut comp_sizes = serde_json::Map::new();
    for tl in &man.timelines {
        if let Ok((w, h)) = edit::composition_size(&settings, tl) {
            comp_sizes.insert(tl.id.clone(), json!({ "compWidth": w, "compHeight": h }));
        }
    }
    let graded_on_disk: Vec<String> = man
        .timelines
        .iter()
        .flat_map(|t| {
            t.tracks
                .iter()
                .flat_map(|tr| tr.clips.iter().map(|c| c.id.clone()))
        })
        .filter(|id| grade_lut::grade_file_for(&project, id).is_file())
        .collect();
    let facts_path = work.path().join("facts.json");
    let mut facts = json!({
        "projectJson": project.join("project.json").to_string_lossy(),
        "fonts": text::chroma_text_fonts(),
        "compSizes": comp_sizes,
    });
    write_json(&facts_path, &facts);

    // --- 2. plan ------------------------------------------------------------
    let plan_path = work.path().join("plan.json");
    // Which clips already have a grade on disk: the TypeScript half cannot
    // stat the copy's `grades/` itself.
    let graded_file = work.path().join("graded.txt");
    std::fs::write(&graded_file, graded_on_disk.join("\n")).expect("graded list");
    let mut cmd_envs: Vec<(&str, &Path)> = vec![
        ("APELLES_PARITY_FACTS", facts_path.as_path()),
        ("APELLES_PARITY_GRADED_FILE", graded_file.as_path()),
        ("APELLES_PARITY_OUT", plan_path.as_path()),
    ];
    run_ts_stage("plan", &cmd_envs).expect("plan");
    let plan: Plan = read_json(&plan_path);
    eprintln!("planned {} case(s)", plan.cases.len());

    // --- 3. grades, LUTs, caption words, then compile ------------------------
    let coverage_adjustments = write_coverage_grades(&project, &plan.coverage_grades);
    let mut ids: Vec<String> = plan
        .cases
        .iter()
        .flat_map(|c| {
            c.timeline.tracks.iter().flat_map(|t| {
                t.clips
                    .iter()
                    .filter(|c| !c.is_generated())
                    .map(|c| c.id.clone())
            })
        })
        .collect();
    ids.sort();
    ids.dedup();
    let luts = grade_lut::bake_luts_for_clips(&ids).expect("bake the grades");
    eprintln!(
        "baked {} grade LUT(s); warnings: {:?}",
        luts.luts.len(),
        luts.warnings
    );
    let mut words = serde_json::Map::new();
    for r in &plan.caption_requests {
        let adv = text::chroma_measure_caption_words(r.font.clone(), r.font_px, r.words.clone())
            .unwrap_or_default();
        for (w, a) in r.words.iter().zip(adv) {
            words.insert(format!("{}|{}|{w}", r.font, r.font_px), json!(a));
        }
    }
    for c in &plan.cases {
        if let Ok((w, h)) = edit::composition_size(&settings, &c.timeline) {
            facts["compSizes"][&c.timeline.id] = json!({ "compWidth": w, "compHeight": h });
        }
    }
    facts["gradeLuts"] = serde_json::to_value(&luts).expect("luts");
    facts["captionWords"] = Value::Object(words);
    write_json(&facts_path, &facts);
    let compiled_path = work.path().join("compiled.json");
    cmd_envs = vec![
        ("APELLES_PARITY_FACTS", facts_path.as_path()),
        ("APELLES_PARITY_PLAN", plan_path.as_path()),
        ("APELLES_PARITY_OUT", compiled_path.as_path()),
    ];
    run_ts_stage("compile", &cmd_envs).expect("compile");
    let compiled: Compiled = read_json(&compiled_path);

    // --- 4. render both ways and compare ----------------------------------
    let results_path = report.join("results.jsonl");
    let mut results = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&results_path)
        .expect("results file");
    let project_name = man.name.clone();
    for (ci, case) in compiled.cases.iter().enumerate() {
        require_disk(work.path());
        eprintln!("\n=== [{project_name}] {} — {:?}", case.label, case.effects);
        let mut row = json!({
            "project": project_name, "label": case.label, "effects": case.effects,
            "width": case.width, "height": case.height, "fps": case.fps,
            "filterError": case.filter_error, "pipeError": case.pipe_error,
        });
        let f_out = work.path().join(format!("{ci}-filter.mp4"));
        let c_out = work.path().join(format!("{ci}-compositor.mp4"));
        let filter_ok = match &case.filter_args {
            Some(args) => {
                let t = std::time::Instant::now();
                let r = run_ffmpeg(&localise(args, &f_out));
                row["filterSecs"] = json!(t.elapsed().as_secs_f64());
                if let Err(e) = &r {
                    row["filterError"] = json!(e.chars().take(600).collect::<String>());
                }
                r.is_ok()
            }
            None => false,
        };
        let pipe_ok = match (&case.pipe_args, case.pipe_frames) {
            (Some(args), Some(frames)) => {
                let req = TimelineRenderRequest {
                    args: localise(args, &c_out),
                    width: case.width,
                    height: case.height,
                    frames,
                    segments: match (&case.segment_args, &case.concat_args) {
                        (Some(s), Some(c)) => Some(SegmentedEncodePlan {
                            segment_args: localise(s, &c_out),
                            concat_args: localise(c, &c_out),
                        }),
                        _ => None,
                    },
                    output: Some(c_out.to_string_lossy().into_owned()),
                    loudness: None,
                    timeline_id: None,
                    cancel_token: None,
                };
                let t = std::time::Instant::now();
                // The document the compiler hands the compositor (Clip
                // exceptions applied), as the app's own render command does.
                let drawn = case.pipe_timeline.as_ref().unwrap_or(&case.timeline);
                let r = render_timeline(drawn, &settings, &req);
                row["compositorSecs"] = json!(t.elapsed().as_secs_f64());
                match r {
                    Ok(o) if o.ok => true,
                    Ok(o) => {
                        row["pipeError"] = json!(o.stderr_tail);
                        false
                    }
                    Err(e) => {
                        row["pipeError"] = json!(e);
                        false
                    }
                }
            }
            _ => false,
        };
        if filter_ok && pipe_ok {
            compare_outputs(&mut row, &c_out, &f_out, case, ci, &report, work.path());
            if case.effects.iter().any(|e| e == "grade") && case.label.starts_with("coverage") {
                compare_with_colorist(
                    &mut row,
                    &c_out,
                    &f_out,
                    case,
                    &coverage_adjustments,
                    &report,
                    work.path(),
                );
            }
        }
        let _ = std::fs::remove_file(&f_out);
        let _ = std::fs::remove_file(&c_out);
        eprintln!("{row}");
        let _ = writeln!(results, "{row}");
    }
    state::set_project(None);
}

fn compare_outputs(
    row: &mut Value,
    c_out: &Path,
    f_out: &Path,
    case: &CompiledCase,
    ci: usize,
    report: &Path,
    scratch: &Path,
) {
    let (cf, ff) = (
        frame_count(c_out).unwrap_or(0),
        frame_count(f_out).unwrap_or(0),
    );
    let (cv, ca) = stream_durations(c_out);
    let (fv, fa) = stream_durations(f_out);
    row["frames"] = json!({ "compositor": cf, "filter": ff });
    row["durations"] = json!({ "compositor": [cv, ca], "filter": [fv, fa] });
    row["streamStarts"] = json!({
        "compositor": [stream_start(c_out, "v:0"), stream_start(c_out, "a:0")],
        "filter": [stream_start(f_out, "v:0"), stream_start(f_out, "a:0")],
    });
    match per_frame_quality(c_out, f_out, scratch) {
        Ok(q) => {
            let n = q.len().max(1) as f64;
            let mean_psnr = q.iter().map(|x| x.0.min(99.0)).sum::<f64>() / n;
            let mean_ssim = q.iter().map(|x| x.1).sum::<f64>() / n;
            let mut idx: Vec<usize> = (0..q.len()).collect();
            idx.sort_by(|a, b| q[*a].0.total_cmp(&q[*b].0));
            let worst: Vec<Value> = idx
                .iter()
                .take(WORST_FRAMES)
                .map(|&i| json!({ "frame": i, "psnr": q[i].0, "ssim": q[i].1 }))
                .collect();
            row["psnrMean"] = json!(mean_psnr);
            row["ssimMean"] = json!(mean_ssim);
            row["psnrMin"] = json!(idx.first().map(|&i| q[i].0));
            row["ssimMin"] = json!(q.iter().map(|x| x.1).fold(f64::INFINITY, f64::min));
            row["worst"] = Value::Array(worst);
            let mut shots = Vec::new();
            for &i in idx.iter().take(2) {
                if q[i].0 >= SCREENSHOT_BELOW_DB {
                    continue;
                }
                if let (Ok(a), Ok(b)) = (
                    decode_frame(c_out, i as u64, scratch),
                    decode_frame(f_out, i as u64, scratch),
                ) {
                    let p = report.join(format!(
                        "{}-case{ci}-frame{i}.png",
                        row["project"].as_str().unwrap_or("p").replace(' ', "_")
                    ));
                    write_side_by_side(&a, &b, &p);
                    shots.push(json!(p.to_string_lossy()));
                }
            }
            row["screenshots"] = Value::Array(shots);
            // Is the worst frame the other path's NEIGHBOUR (a timing
            // difference) rather than a different picture?
            if let Some(&i) = idx.first()
                && q[i].0 < SCREENSHOT_BELOW_DB
                && let Ok(c) = decode_frame(c_out, i as u64, scratch)
            {
                let mut near = serde_json::Map::new();
                for d in [-2i64, -1, 0, 1, 2] {
                    let j = i as i64 + d;
                    if j < 0 {
                        continue;
                    }
                    if let Ok(f) = decode_frame(f_out, j as u64, scratch) {
                        near.insert(d.to_string(), json!(psnr_rgb(&c, &f)));
                    }
                }
                row["worstVsFilterNeighbours"] = Value::Object(near);
            }
        }
        Err(e) => row["qualityError"] = json!(e),
    }
    let lufs = |p: &Path| {
        loudness::measure(p)
            .ok()
            .flatten()
            .map(|m| json!([m.integrated_lufs, m.true_peak_dbtp]))
            .unwrap_or(Value::Null)
    };
    row["loudness"] = json!({ "compositor": lufs(c_out), "filter": lufs(f_out) });
    let (lag, rms_db, peak_db, ns_c, ns_f) = audio_diff(&decode_audio(c_out), &decode_audio(f_out));
    row["audio"] = json!({
        "lagSamples": lag, "diffRmsDbfs": rms_db, "diffPeakDbfs": peak_db,
        "samples": [ns_c, ns_f],
    });
    let _ = case;
}

/// For the coverage timeline's graded clips: the Colorist's own render of the
/// same source frame against each export.
fn compare_with_colorist(
    row: &mut Value,
    c_out: &Path,
    f_out: &Path,
    case: &CompiledCase,
    adjustments: &BTreeMap<String, Value>,
    report: &Path,
    scratch: &Path,
) {
    let mut out = Vec::new();
    for (clip_id, adj) in adjustments {
        if clip_id == "cov-grade-xform" {
            continue; // placed under a transform: no full-frame Colorist twin
        }
        let Some(clip) = case
            .timeline
            .tracks
            .iter()
            .flat_map(|t| t.clips.iter())
            .find(|c| &c.id == clip_id)
        else {
            continue;
        };
        // one second into the clip
        let tl_frame = clip.start_frame + (case.fps.round() as i64);
        let src_fps = clip.source_fps.unwrap_or(case.fps);
        let src_secs = (clip.source_start as f64
            + (tl_frame - clip.start_frame) as f64 * src_fps / case.fps)
            / src_fps;
        let Ok(col) = colorist_frame(
            Path::new(&clip.source_path),
            src_secs,
            adj,
            (case.width, case.height),
            scratch,
        ) else {
            continue;
        };
        let (Ok(c), Ok(f)) = (
            decode_frame(c_out, tl_frame as u64, scratch),
            decode_frame(f_out, tl_frame as u64, scratch),
        ) else {
            continue;
        };
        let p = report.join(format!("colorist-{clip_id}.png"));
        write_side_by_side(&c, &col, &p);
        out.push(json!({
            "clip": clip_id, "frame": tl_frame,
            "compositorVsColoristPsnr": psnr_rgb(&c, &col),
            "filterVsColoristPsnr": psnr_rgb(&f, &col),
            "compositorVsFilterPsnr": psnr_rgb(&c, &f),
            "screenshot": p.to_string_lossy(),
        }));
    }
    row["colorist"] = Value::Array(out);
}
