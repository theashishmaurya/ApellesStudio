//! The media-engine decoder against ffmpeg, the oracle it replaces (D-452):
//! the same nominal frame index must be the same picture. Compared on the
//! luma plane, which both decoders produce bit-exactly for H.264 / HEVC, so
//! "the same frame" is an equality, not a threshold.

use std::path::{Path, PathBuf};

use super::*;

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

/// 30 fps CFR, 3 s, H.264 4:2:0.
fn cfr(dir: &Path) -> PathBuf {
    synth(
        dir,
        "cfr.mp4",
        "testsrc2=size=320x240:rate=30:duration=3",
        &[
            "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-g", "24",
        ],
    )
}

/// The same VFR-with-a-hold shape `decode_pipe`'s own tests use: frames
/// 30..89 of a 30 fps source dropped and timestamps kept, so frame 29 is on
/// screen for two seconds. No B-frames, as in the screen recordings that are
/// the real VFR sources: with B-frames AND a two-second gap, ffmpeg's mp4
/// muxer writes composition offsets that ffmpeg and AVFoundation read back as
/// different presentation times for the frames around the gap, so the file
/// would have no single correct answer to test against.
fn vfr_hold(dir: &Path) -> PathBuf {
    synth(
        dir,
        "vfr_hold.mp4",
        "testsrc2=size=160x120:rate=30:duration=4",
        &[
            "-vf",
            "select='not(between(n,30,89))'",
            "-fps_mode",
            "passthrough",
            "-c:v",
            "libx264",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-g",
            "12",
            "-bf",
            "0",
        ],
    )
}

/// What ffmpeg's conformed decode (the `decode_pipe` command, in software)
/// gives as luma for nominal frames `start..start + n`.
fn ffmpeg_luma(path: &Path, info: &VideoInfo, start: u64, n: usize) -> Vec<Vec<u8>> {
    let grid = crate::conform::from_frame(info, start);
    let mut cmd = crate::ffmpeg_locate::ffmpeg().expect("ffmpeg");
    cmd.args(["-v", "error"])
        .args(&grid.input_args)
        .arg("-i")
        .arg(path)
        .args(["-an", "-sn"]);
    if let Some(vf) = grid.vf(None) {
        cmd.args(["-vf", &vf]);
    }
    let out = cmd
        .args(["-fps_mode", "passthrough", "-frames:v"])
        .arg(n.to_string())
        .args(["-f", "rawvideo", "-pix_fmt", "yuv420p", "-"])
        .output()
        .expect("ffmpeg decode");
    assert!(out.status.success());
    // yuv420p: the luma plane, then the two quarter-size chroma planes.
    let luma = (info.resolution.width * info.resolution.height) as usize;
    out.stdout
        .chunks(luma * 3 / 2)
        .map(|f| f[..luma].to_vec())
        .collect()
}

fn engine_luma(path: &Path, info: &VideoInfo, start: u64, n: usize) -> Vec<Vec<u8>> {
    let mut reader = Reader::open(path, info, start).expect("open");
    (0..n)
        .map(|i| {
            let f = reader.next_frame().expect("frame");
            assert_eq!(f.index, start + i as u64, "the grid index runs on by one");
            read_plane(&f.buffer, 0).0
        })
        .collect()
}

fn assert_same(got: &[u8], want: &[u8], frame: u64, start: u64) {
    assert_eq!(got.len(), want.len(), "frame {frame}: plane size");
    let diff: u64 = got
        .iter()
        .zip(want)
        .map(|(a, b)| u64::from(a.abs_diff(*b)))
        .sum();
    assert!(
        got == want,
        "frame {frame} from start {start} differs: mean |d| {:.3}",
        diff as f64 / got.len() as f64
    );
}

#[test]
fn a_cfr_source_decodes_to_ffmpegs_frames_from_any_start() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = cfr(dir.path());
    let info = crate::video::probe(&path).expect("probe");
    for start in [0u64, 1, 23, 24, 50] {
        let want = ffmpeg_luma(&path, &info, start, 20);
        let got = engine_luma(&path, &info, start, want.len());
        for (i, (g, w)) in got.iter().zip(&want).enumerate() {
            assert_same(g, w, start + i as u64, start);
        }
    }
}

#[test]
fn a_held_frame_is_held_for_every_slot_it_covers_wherever_the_read_starts() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = vfr_hold(dir.path());
    let info = crate::video::probe(&path).expect("probe");
    for start in [0u64, 28, 29, 30, 45, 89, 90, 91] {
        let want = ffmpeg_luma(&path, &info, start, 12);
        let got = engine_luma(&path, &info, start, want.len());
        for (i, (g, w)) in got.iter().zip(&want).enumerate() {
            assert_same(g, w, start + i as u64, start);
        }
    }
}

#[test]
fn the_stream_ends_where_ffmpegs_conform_ends_it() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = cfr(dir.path());
    let info = crate::video::probe(&path).expect("probe");
    let want = ffmpeg_luma(&path, &info, 80, 100).len();
    let mut reader = Reader::open(&path, &info, 80).expect("open");
    let mut got = 0;
    while reader.next_frame().is_ok() {
        got += 1;
    }
    assert_eq!(got, want, "frames to the end of the source");
}

#[test]
fn layouts_name_the_biplanar_format_for_the_source() {
    let l = YcbcrLayout::for_source("yuv420p", "bt709", false);
    assert_eq!((l.bits, l.chroma_shift, l.full_range), (8, (1, 1), false));
    assert_eq!(l.matrix, YcbcrMatrix::Bt709);
    let l = YcbcrLayout::for_source("yuv422p10le", "", false);
    assert_eq!((l.bits, l.chroma_shift), (10, (1, 0)));
    assert_eq!(l.matrix, YcbcrMatrix::Bt601);
    assert!(YcbcrLayout::for_source("yuvj420p", "", false).full_range);
}
