//! The conversion against the original's own decode (D-453): every container
//! the media engine cannot open is converted, decoded through VideoToolbox, and
//! compared with ffmpeg's conformed decode of the ORIGINAL (the decode the
//! deleted pipe made). Same frame count to the end, the same picture at every
//! nominal index, and the pixels within a stated tolerance: the conversion is a
//! second lossy generation, so this is a PSNR floor, not an equality.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::*;
use crate::vt_decode::{Reader, read_plane};

/// Every frame's luma must be at least this close to the original's decode
/// (8-bit PSNR). Measured 47–52 dB on these fixtures at `QUALITY` 75; the
/// floor leaves room for encoder variation across Macs without letting a wrong
/// frame (≈ 12–20 dB against a neighbour on `testsrc2`) or a range/matrix error
/// (≈ 25–30 dB) through.
const MIN_FRAME_PSNR_DB: f64 = 40.0;

/// The registry is process-global: the tests that drive it take turns.
static QUEUE_TESTS: Mutex<()> = Mutex::new(());

/// Take a turn with the process-global conversion registry (the pool test that
/// converts a source takes one too).
pub(crate) fn queue_turn() -> std::sync::MutexGuard<'static, ()> {
    QUEUE_TESTS.lock().unwrap_or_else(|e| e.into_inner())
}

fn synth(dir: &Path, name: &str, lavfi: &str, extra: &[&str]) -> PathBuf {
    let out = dir.join(name);
    let status = crate::ffmpeg_locate::ffmpeg()
        .expect("an ffmpeg to build the fixture")
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", lavfi])
        .args(extra)
        .arg(&out)
        .status()
        .expect("running ffmpeg to synthesize a fixture");
    assert!(status.success(), "ffmpeg could not build {name}");
    out
}

/// The four container families the importer accepts and AVFoundation does
/// not, each in the codec it is usually found with.
fn fixtures(dir: &Path) -> Vec<PathBuf> {
    let src = "testsrc2=size=320x240:rate=30:duration=3";
    vec![
        // H.264 in Matroska, tagged BT.709, with B-frames.
        synth(
            dir,
            "h264.mkv",
            src,
            &[
                "-c:v",
                "libx264",
                "-crf",
                "16",
                "-pix_fmt",
                "yuv420p",
                "-colorspace",
                "bt709",
                "-color_primaries",
                "bt709",
                "-color_trc",
                "bt709",
            ],
        ),
        // VP9 in WebM, untagged (BT.601 by swscale's default), the web's format.
        synth(
            dir,
            "vp9.webm",
            src,
            &[
                "-c:v",
                "libvpx-vp9",
                "-crf",
                "20",
                "-b:v",
                "0",
                "-deadline",
                "realtime",
                "-cpu-used",
                "8",
                "-pix_fmt",
                "yuv420p",
            ],
        ),
        // MJPEG in AVI: full-range 4:2:2, every frame a key frame.
        synth(dir, "mjpeg.avi", src, &["-c:v", "mjpeg", "-q:v", "2"]),
        // H.264 in MPEG-TS, the AVCHD shape: timestamps start at 1.4 s.
        synth(
            dir,
            "h264.mts",
            src,
            &[
                "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", "-f", "mpegts",
            ],
        ),
    ]
}

/// ffmpeg's conformed decode of `path` (the D-228 grid, from frame `start`),
/// `n` frames or to the end, as planar 8-bit luma or 16-bit luma.
fn ffmpeg_luma(
    path: &Path,
    info: &VideoInfo,
    start: u64,
    n: Option<usize>,
    deep: bool,
) -> Vec<Vec<u8>> {
    let grid = crate::conform::from_frame(info, start);
    let mut cmd = crate::ffmpeg_locate::ffmpeg().expect("ffmpeg");
    cmd.args(["-v", "error"])
        .args(&grid.input_args)
        .arg("-i")
        .arg(path)
        .args(["-an", "-sn"]);
    // The luma plane's own code values: `extractplanes` copies them, where a
    // conversion to `gray` would stretch a video-range plane to full range.
    let fmt = if deep { "gray10le" } else { "gray" };
    let vf = grid
        .vf(["extractplanes=y"])
        .unwrap_or_else(|| "extractplanes=y".into());
    cmd.args(["-vf", &vf, "-fps_mode", "passthrough"]);
    if let Some(n) = n {
        cmd.args(["-frames:v", &n.to_string()]);
    }
    let out = cmd
        .args(["-f", "rawvideo", "-pix_fmt", fmt, "-"])
        .output()
        .expect("ffmpeg decode");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let plane =
        (info.resolution.width * info.resolution.height) as usize * if deep { 2 } else { 1 };
    out.stdout.chunks(plane).map(<[u8]>::to_vec).collect()
}

/// The media engine's decode of `source` through its converted file, from
/// `start`, `n` frames or to the end.
fn engine_luma(
    source: &Path,
    info: &VideoInfo,
    converted: &Path,
    start: u64,
    n: Option<usize>,
) -> Vec<Vec<u8>> {
    let facts = read_facts(converted).expect("the converted file's facts");
    let mut decode_info = info.clone();
    decode_info.pix_fmt = facts.pix_fmt;
    decode_info.color_space = facts.color_space;
    let mut reader = Reader::open(converted, &decode_info, start).expect("open the converted file");
    let mut frames = Vec::new();
    while n.is_none_or(|n| frames.len() < n) {
        match reader.next_frame() {
            Ok(f) => {
                assert_eq!(
                    f.index,
                    start + frames.len() as u64,
                    "{}: the grid index runs on by one",
                    source.display()
                );
                frames.push(read_plane(&f.buffer, 0).0);
            }
            Err(_) if n.is_none() => break,
            Err(e) => panic!("{}: {e}", source.display()),
        }
    }
    frames
}

/// PSNR of plane `a` against plane `b`. With `deep`, both are 16-bit little
/// endian holding a 10-bit code, `a` in the high bits (the engine's P010
/// planes) and `b` in the low bits (ffmpeg's `gray16le` of a 10-bit source);
/// otherwise both are 8-bit.
fn psnr(a: &[u8], b: &[u8], deep: bool) -> f64 {
    assert_eq!(a.len(), b.len(), "plane sizes");
    let (sum, count, peak) = if deep {
        let px = |s: &[u8], shift: u32| {
            s.chunks(2)
                .map(|c| f64::from(u16::from_le_bytes([c[0], c[1]]) >> shift))
                .collect::<Vec<_>>()
        };
        let (x, y) = (px(a, 6), px(b, 0));
        let sum: f64 = x.iter().zip(&y).map(|(p, q)| (p - q).powi(2)).sum();
        (sum, x.len() as f64, 1023.0)
    } else {
        let sum: f64 = a
            .iter()
            .zip(b)
            .map(|(p, q)| (f64::from(*p) - f64::from(*q)).powi(2))
            .sum();
        (sum, a.len() as f64, 255.0)
    };
    let mse = sum / count;
    if mse == 0.0 {
        99.0
    } else {
        10.0 * (peak * peak / mse).log10()
    }
}

/// Every frame of `got` is within tolerance of the same index of `want`, and
/// closer to it than to either neighbour (so it is that frame, not one over).
fn assert_same_frames(
    name: &str,
    got: &[Vec<u8>],
    want: &[Vec<u8>],
    start: u64,
    deep: bool,
) -> f64 {
    assert_eq!(got.len(), want.len(), "{name} from {start}: frame count");
    let mut worst = f64::INFINITY;
    for (i, (g, w)) in got.iter().zip(want).enumerate() {
        let here = psnr(g, w, deep);
        worst = worst.min(here);
        assert!(
            here >= MIN_FRAME_PSNR_DB,
            "{name}: frame {} is {here:.1} dB from the original's decode",
            start + i as u64
        );
        for j in [i.wrapping_sub(1), i + 1] {
            if let Some(n) = want.get(j)
                && n != w
            {
                let there = psnr(g, n, deep);
                assert!(
                    here > there,
                    "{name}: frame {} is closer to the original's frame {} ({there:.1} dB) than to its own ({here:.1} dB)",
                    start + i as u64,
                    start + j as u64
                );
            }
        }
    }
    worst
}

fn convert_fixture(source: &Path, dir: &Path) -> (VideoInfo, PathBuf) {
    let info = crate::video::probe(source).expect("probe the original");
    let dest = dir.join(format!(
        "{}.converted.mov",
        source.file_name().and_then(|n| n.to_str()).unwrap_or("x")
    ));
    convert(source, &info, &dest, &CancelToken::new(), |_| {}).expect("convert");
    (info, dest)
}

#[test]
fn every_container_converts_to_a_mov_that_decodes_to_the_originals_frames() {
    let dir = tempfile::tempdir().expect("tempdir");
    for source in fixtures(dir.path()) {
        let name = source.display().to_string();
        assert!(needs_conversion(&source), "{name} must need converting");
        let (info, converted) = convert_fixture(&source, dir.path());
        assert!(crate::vt_decode::is_engine_container(&converted));
        // To the end, from the start: the same number of grid slots.
        let want = ffmpeg_luma(&source, &info, 0, None, false);
        let got = engine_luma(&source, &info, &converted, 0, None);
        let worst = assert_same_frames(&name, &got, &want, 0, false);
        eprintln!("{name}: {} frames, worst {worst:.1} dB", got.len());
        // And from points inside, which is what a seek is.
        for start in [1u64, 29, 45] {
            let want = ffmpeg_luma(&source, &info, start, Some(15), false);
            let got = engine_luma(&source, &info, &converted, start, Some(want.len()));
            assert_same_frames(&name, &got, &want, start, false);
        }
    }
}

#[test]
fn a_held_frame_of_a_vfr_source_is_held_for_the_same_slots_after_conversion() {
    let dir = tempfile::tempdir().expect("tempdir");
    // Frames 30..89 dropped with their timestamps kept: frame 29 is on screen
    // for two seconds (the decode_pipe / vt_decode VFR shape), in Matroska.
    let source = synth(
        dir.path(),
        "vfr.mkv",
        "testsrc2=size=160x120:rate=30:duration=4",
        &[
            "-vf",
            "select='not(between(n,30,89))'",
            "-fps_mode",
            "passthrough",
            "-c:v",
            "libx264",
            "-crf",
            "16",
            "-pix_fmt",
            "yuv420p",
            "-bf",
            "0",
        ],
    );
    let (info, converted) = convert_fixture(&source, dir.path());
    for start in [0u64, 28, 29, 30, 45, 89, 90, 91] {
        let want = ffmpeg_luma(&source, &info, start, Some(12), false);
        let got = engine_luma(&source, &info, &converted, start, Some(want.len()));
        assert_same_frames("vfr.mkv", &got, &want, start, false);
    }
    let want = ffmpeg_luma(&source, &info, 0, None, false);
    let got = engine_luma(&source, &info, &converted, 0, None);
    assert_eq!(got.len(), want.len(), "the same number of slots to the end");
}

#[test]
fn a_ten_bit_source_stays_ten_bit() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = synth(
        dir.path(),
        "ten.mkv",
        "testsrc2=size=320x240:rate=30:duration=1",
        &["-pix_fmt", "yuv420p10le", "-c:v", "ffv1"],
    );
    let (info, converted) = convert_fixture(&source, dir.path());
    assert_eq!(
        read_facts(&converted).expect("facts").pix_fmt,
        "yuv420p10le",
        "HEVC Main 10"
    );
    let want = ffmpeg_luma(&source, &info, 0, None, true);
    let got = engine_luma(&source, &info, &converted, 0, None);
    let worst = assert_same_frames("ten.mkv", &got, &want, 0, true);
    eprintln!("ten.mkv: worst {worst:.1} dB (10-bit)");
}

/// RGBA of frame `index` of `path` as ffmpeg decodes it (its alpha included).
/// With `matrix`, the file's samples are converted by that matrix rather than
/// by its own tag.
fn ffmpeg_rgba(
    path: &Path,
    decoder: Option<&str>,
    matrix: Option<&str>,
    index: usize,
    w: u32,
    h: u32,
) -> Vec<u8> {
    let mut vf = format!("select=eq(n\\,{index})");
    if let Some(m) = matrix {
        vf.push_str(&format!(",scale=in_color_matrix={m}"));
    }
    let mut cmd = crate::ffmpeg_locate::ffmpeg().expect("ffmpeg");
    cmd.args(["-v", "error"]);
    if let Some(d) = decoder {
        cmd.args(["-c:v", d]);
    }
    let out = cmd
        .arg("-i")
        .arg(path)
        .args(["-vf", &vf, "-frames:v", "1"])
        .args(["-f", "rawvideo", "-pix_fmt", "rgba", "-"])
        .output()
        .expect("ffmpeg decode");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(out.stdout.len(), (w * h * 4) as usize);
    out.stdout
}

/// The major version of the ffmpeg these tests run (`ffmpeg_locate`'s answer).
fn ffmpeg_major() -> u32 {
    let out = crate::ffmpeg_locate::ffmpeg()
        .expect("ffmpeg")
        .arg("-version")
        .output()
        .expect("ffmpeg -version");
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .nth(2)
        .and_then(|v| v.split(['.', '-']).next())
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

#[test]
fn a_source_with_alpha_becomes_hevc_with_alpha() {
    let dir = tempfile::tempdir().expect("tempdir");
    // A VP9 WebM with an alpha ramp: the alpha is side data only libvpx reads.
    let source = synth(
        dir.path(),
        "alpha.webm",
        "testsrc2=size=320x240:rate=30:duration=1,format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='X*255/W'",
        &[
            "-c:v",
            "libvpx-vp9",
            "-crf",
            "20",
            "-b:v",
            "0",
            "-deadline",
            "realtime",
            "-cpu-used",
            "8",
            "-auto-alt-ref",
            "0",
        ],
    );
    let info = crate::video::probe(&source).expect("probe");
    let converted = dir.path().join("alpha.mov");
    if let Err(e) = convert(&source, &info, &converted, &CancelToken::new(), |_| {}) {
        // An ffmpeg older than the bundled one (Homebrew's 7.1) writes an
        // HEVC-with-alpha file AVFoundation refuses: that must be refused at
        // conversion, clearly, and never on the ffmpeg the app ships.
        let major = ffmpeg_major();
        assert!(
            major < 8,
            "ffmpeg {major} must convert an alpha source: {e:#}"
        );
        let msg = format!("{e:#}");
        assert!(
            msg.contains("alpha.webm") && msg.contains("cannot read"),
            "{msg}"
        );
        assert!(!converted.exists() && !partial_path(&converted).exists());
        eprintln!("alpha.webm: refused on ffmpeg {major}: {msg}");
        return;
    }
    let orig = ffmpeg_rgba(&source, Some("libvpx-vp9"), None, 10, 320, 240);
    let matrix = read_facts(&converted).expect("facts").color_space;
    let conv = ffmpeg_rgba(&converted, None, Some(&matrix), 10, 320, 240);
    let alpha = |px: &[u8]| px.chunks(4).map(|p| p[3]).collect::<Vec<_>>();
    let rgb = |px: &[u8]| {
        px.chunks(4)
            .flat_map(|p| [p[0], p[1], p[2]])
            .collect::<Vec<_>>()
    };
    // The alpha as the media engine (AVFoundation) decodes it: not every ffmpeg
    // decodes HEVC's alpha layer (7.1 does not, 9.0 does).
    let (engine_bgra, width) = crate::vt_decode::bgra_frame(&converted, 10).expect("BGRA decode");
    assert_eq!(width, 320);
    let (a0, a1) = (alpha(&orig), alpha(&engine_bgra));
    assert!(
        a0.iter().any(|&a| a < 16) && a0.iter().any(|&a| a > 240),
        "the fixture has an alpha ramp"
    );
    let alpha_db = psnr(&a1, &a0, false);
    let rgb_db = psnr(&rgb(&conv), &rgb(&orig), false);
    eprintln!("alpha.webm: alpha {alpha_db:.1} dB, colour {rgb_db:.1} dB");
    assert!(
        alpha_db >= MIN_FRAME_PSNR_DB,
        "the alpha plane survives: {alpha_db:.1} dB"
    );
    // RGB through two matrices (the original's BT.601, the converted file's
    // BT.709) and 4:2:0 chroma twice: a looser floor than luma alone. The
    // converted file is untagged, so ffmpeg is told its matrix, exactly as the
    // engine is through the facts.
    assert!(rgb_db >= 35.0, "the colour survives: {rgb_db:.1} dB");
    let facts = read_facts(&converted).expect("facts");
    assert_eq!(
        facts.color_space, "bt709",
        "the matrix VideoToolbox coded it with"
    );
    // The media engine reads its base layer like any other HEVC file.
    let mut info = crate::video::probe(&converted).expect("probe");
    info.color_space = facts.color_space;
    let mut reader = Reader::open(&converted, &info, 0).expect("open");
    assert_eq!(reader.next_frame().expect("frame").index, 0);
}

#[test]
fn converting_the_same_source_twice_gives_the_same_pictures() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = synth(
        dir.path(),
        "det.mkv",
        "testsrc2=size=320x240:rate=30:duration=2",
        &["-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p"],
    );
    let info = crate::video::probe(&source).expect("probe");
    let a = dir.path().join("a.mov");
    let b = dir.path().join("b.mov");
    convert(&source, &info, &a, &CancelToken::new(), |_| {}).expect("first");
    convert(&source, &info, &b, &CancelToken::new(), |_| {}).expect("second");
    let la = engine_luma(&source, &info, &a, 0, None);
    let lb = engine_luma(&source, &info, &b, 0, None);
    assert!(
        la == lb,
        "two conversions of one source decode to the same planes"
    );
    let same_bytes = std::fs::read(&a).ok() == std::fs::read(&b).ok();
    eprintln!("det.mkv: byte-identical files: {same_bytes}");
}

#[test]
fn a_cancelled_conversion_leaves_nothing_behind() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = synth(
        dir.path(),
        "long.mkv",
        "testsrc2=size=1280x720:rate=30:duration=20",
        &[
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
        ],
    );
    let info = crate::video::probe(&source).expect("probe");
    let dest = dir.path().join("long.mov");
    let token = std::sync::Arc::new(CancelToken::new());
    let canceller = token.clone();
    let result = convert(&source, &info, &dest, &token, move |p| {
        if p > 0.05 {
            canceller.cancel();
        }
    });
    assert!(token.is_cancelled());
    assert!(result.is_err(), "a cancelled conversion is not a success");
    assert!(!dest.exists(), "no converted file");
    assert!(!partial_path(&dest).exists(), "no partial file");
}

#[test]
fn the_queue_converts_reports_and_maps_the_decode_to_the_converted_file() {
    let _turn = queue_turn();
    let dir = tempfile::tempdir().expect("tempdir");
    let project = dir.path().join("p.chroma");
    std::fs::create_dir_all(&project).expect("project dir");
    set_project_dir(Some(&project));
    let source = synth(
        dir.path(),
        "q.mkv",
        "testsrc2=size=320x240:rate=30:duration=2",
        &["-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p"],
    );
    let info = crate::video::probe(&source).expect("probe");
    let (tx, rx) = std::sync::mpsc::channel::<ConversionStatus>();
    let tx = Mutex::new(tx);
    set_listener(move |_, s| {
        let _ = tx.lock().unwrap_or_else(|e| e.into_inner()).send(s.clone());
    });

    // Not asked for yet: nothing to report, and a decode says why and queues it.
    assert_eq!(status(&source), None);
    let err = decode_source(&source, &info)
        .err()
        .expect("not converted yet");
    assert!(
        err.to_string().contains("q.mkv"),
        "the error names the file: {err}"
    );
    let mut seen = Vec::new();
    loop {
        let s = rx
            .recv_timeout(std::time::Duration::from_secs(60))
            .expect("progress");
        seen.push(s.state);
        if s.state == ConversionState::Ready || s.state == ConversionState::Failed {
            assert_eq!(s.state, ConversionState::Ready, "{:?}", s.error);
            break;
        }
    }
    assert!(seen.contains(&ConversionState::Queued) && seen.contains(&ConversionState::Converting));
    assert_eq!(
        status(&source).map(|s| s.state),
        Some(ConversionState::Ready)
    );
    let mapped = decode_source(&source, &info).expect("converted");
    assert!(
        mapped.path.starts_with(project.join(FOLDER)),
        "in the project's folder"
    );
    assert!(mapped.info.is_some());
    // Asking again is a no-op: it is on disk.
    request(std::slice::from_ref(&source));
    assert_eq!(
        status(&source).map(|s| s.state),
        Some(ConversionState::Ready)
    );

    // A source rewritten in place is a different key: the old file is pruned.
    let other = synth(
        dir.path(),
        "q2.mkv",
        "testsrc2=size=320x240:rate=30:duration=1",
        &["-c:v", "libx264", "-pix_fmt", "yuv420p"],
    );
    let size = |p: &Path| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    let expected = size(&mapped.path) + size(&mapped.path.with_extension("json"));
    assert_eq!(prune(&project.join(FOLDER), &[other]), expected);
    assert!(!mapped.path.exists() && !mapped.path.with_extension("json").exists());
    set_project_dir(None);
}

#[test]
fn a_queued_conversion_can_be_cancelled_and_asked_for_again() {
    let _turn = queue_turn();
    let dir = tempfile::tempdir().expect("tempdir");
    let project = dir.path().join("c.chroma");
    std::fs::create_dir_all(&project).expect("project dir");
    set_project_dir(Some(&project));
    // A long one first, so the second is still queued when it is cancelled.
    let long = synth(
        dir.path(),
        "busy.mkv",
        "testsrc2=size=1280x720:rate=30:duration=20",
        &[
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
        ],
    );
    let short = synth(
        dir.path(),
        "wait.mkv",
        "testsrc2=size=320x240:rate=30:duration=1",
        &["-c:v", "libx264", "-pix_fmt", "yuv420p"],
    );
    request(&[long.clone(), short.clone()]);
    assert_eq!(
        status(&short).map(|s| s.state),
        Some(ConversionState::Queued)
    );
    assert!(cancel(&short));
    assert_eq!(
        status(&short).map(|s| s.state),
        Some(ConversionState::Cancelled)
    );
    // The running one too: its ffmpeg is killed and nothing is left.
    assert!(cancel(&long));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while status(&long).map(|s| s.state) != Some(ConversionState::Cancelled) {
        assert!(
            std::time::Instant::now() < deadline,
            "the running cancel lands"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let leftovers: Vec<_> = std::fs::read_dir(project.join(FOLDER))
        .map(|d| d.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();
    assert!(leftovers.is_empty(), "nothing half-written: {leftovers:?}");
    // A decode does not restart a cancelled conversion behind the user's back…
    let info = crate::video::probe(&short).expect("probe");
    let err = decode_source(&short, &info).err().expect("cancelled");
    assert!(err.to_string().contains("cancelled"), "{err}");
    assert_eq!(
        status(&short).map(|s| s.state),
        Some(ConversionState::Cancelled)
    );
    // …asking for it does.
    request(std::slice::from_ref(&short));
    let asked = status(&short).map(|s| s.state);
    assert!(
        asked.is_some_and(|s| s != ConversionState::Cancelled),
        "asked for again: {asked:?}"
    );
    cancel(&short);
    set_project_dir(None);
}

#[test]
fn stream_facts_pick_the_timescale_start_and_alpha() {
    let v: serde_json::Value = serde_json::json!({
        "streams": [
            {"index": 0, "codec_name": "mjpeg", "time_base": "1/90000", "pix_fmt": "yuvj420p",
             "disposition": {"attached_pic": 1}},
            {"index": 1, "codec_name": "vp9", "time_base": "1/1000", "start_time": "0.000000",
             "pix_fmt": "yuv420p", "tags": {"alpha_mode": "1"}, "disposition": {"attached_pic": 0}}
        ],
        "format": {"duration": "4.000000", "start_time": "0.000000"}
    });
    let f = parse_stream_facts(&v).expect("facts");
    assert_eq!(
        (f.index, f.timescale),
        (1, 1000),
        "the cover art is skipped"
    );
    assert_eq!(f.alpha, Alpha::Vpx("libvpx-vp9"));
    let ntsc = serde_json::json!({
        "streams": [{"index": 0, "codec_name": "h264", "time_base": "1001/30000",
                     "start_time": "1.400000", "pix_fmt": "yuv422p10le"}],
        "format": {"duration": "10.0"}
    });
    let f = parse_stream_facts(&ntsc).expect("facts");
    assert_eq!(f.timescale, 30000);
    assert!((f.start_secs - 1.4).abs() < 1e-9);
    assert_eq!(f.alpha, Alpha::None);
    assert!(pix_fmt_is_deep("yuv422p10le") && !pix_fmt_is_deep("yuv420p"));
    assert!(
        pix_fmt_has_alpha("yuva420p") && pix_fmt_has_alpha("rgba") && !pix_fmt_has_alpha("yuv420p")
    );
}

#[test]
fn a_quicktime_family_file_is_its_own_decode_source() {
    let info = VideoInfo {
        resolution: apelles_types::Resolution::new(16, 16),
        fps_num: 30,
        fps_den: 1,
        duration_secs: 1.0,
        frame_count: 30,
        codec: "h264".into(),
        pix_fmt: "yuv420p".into(),
        color_primaries: String::new(),
        color_transfer: String::new(),
        color_space: String::new(),
        has_audio: false,
        audio_sample_rate: 0,
        audio_channels: 0,
    };
    for name in ["/x/a.mov", "/x/b.MP4", "/x/c.m4v"] {
        let ds = decode_source(Path::new(name), &info).expect("itself");
        assert_eq!(ds.path, Path::new(name));
        assert!(ds.info.is_none());
        assert_eq!(status(Path::new(name)), None);
    }
    for name in ["a.mkv", "a.webm", "a.avi", "a.mts", "a.m2ts", "a.mxf"] {
        assert!(needs_conversion(Path::new(name)), "{name}");
    }
}
