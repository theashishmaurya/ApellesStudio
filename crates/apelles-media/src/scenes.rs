//! Picture cuts in a video file: ffmpeg's own scene-change score, on a small
//! decode (D-411 — evidence for the Automatic Clipper).
//!
//! **What it is.** One `ffmpeg` pass with `select='gt(scene,T)',showinfo` over
//! a [`SCENE_DECODE_WIDTH`]-pixel-wide decode of the whole file, its
//! `pts_time` values parsed from stderr. The same deterministic classical-CV
//! signal `ai-media/video_understand.py`'s step 1 uses (D-189), without its
//! model: the clipper needs only "where does the picture cut", and a
//! 160-pixel decode answers that as well as a full one.
//!
//! **What it does NOT do.** Hold the ffmpeg gate ([`crate::ffmpeg_gate`]): that
//! bounds short one-shot extractions, and a whole-file pass held for minutes
//! would starve the filmstrip. One pass per source, started by the caller;
//! cache the answer (`media_cache`) — this function always runs ffmpeg.

use std::path::Path;
use std::process::Stdio;

use crate::ffmpeg_locate;

/// The decode width the score is computed on. Scene scores compare whole
/// frames; detail below this changes nothing a cut is made of.
pub const SCENE_DECODE_WIDTH: u32 = 160;

/// ffmpeg's `scene` score above which a frame counts as a cut. Higher than
/// `video_understand.py`'s 0.12 (which looks for any visible change to ask a
/// model about): this one wants real cuts — B-roll, a slide, another camera.
pub const SCENE_THRESHOLD: f64 = 0.3;

/// The `pts_time:` values in ffmpeg `showinfo` output, in order.
pub fn parse_showinfo_times(stderr: &str) -> Vec<f64> {
    let mut out: Vec<f64> = stderr
        .lines()
        .filter(|l| l.contains("Parsed_showinfo"))
        .filter_map(|l| {
            let rest = &l[l.find("pts_time:")? + "pts_time:".len()..];
            let token = rest.split_whitespace().next()?;
            token.parse::<f64>().ok().filter(|t| t.is_finite())
        })
        .collect();
    out.sort_by(f64::total_cmp);
    out.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    out
}

/// Every picture cut in `path`, in seconds. Errors name the file and ffmpeg's
/// last lines.
pub fn detect_scene_cuts(path: &Path, threshold: f64) -> Result<Vec<f64>, String> {
    let mut cmd = ffmpeg_locate::ffmpeg().map_err(|e| e.to_string())?;
    let filter = format!(
        "scale={SCENE_DECODE_WIDTH}:-2,select='gt(scene\\,{threshold})',showinfo"
    );
    let output = cmd
        .arg("-hide_banner")
        .arg("-nostdin")
        .arg("-i")
        .arg(path)
        .args(["-an", "-sn", "-dn", "-vf", &filter, "-f", "null", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("running ffmpeg on {}: {e}", path.display()))?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        let tail: Vec<&str> = stderr.lines().rev().take(4).collect();
        return Err(format!(
            "ffmpeg scene detection failed on {}: {}",
            path.display(),
            tail.into_iter().rev().collect::<Vec<_>>().join(" | ")
        ));
    }
    Ok(parse_showinfo_times(&stderr))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn showinfo_times_are_parsed_sorted_and_unique() {
        let stderr = "\
[Parsed_showinfo_2 @ 0x1] n:   0 pts:  12345 pts_time:4.1 duration: 1 fmt:yuv420p\n\
[Parsed_showinfo_2 @ 0x1] n:   1 pts:  99999 pts_time:33.366667 duration: 1\n\
frame=  100 fps=0.0 q=-0.0 size=N/A time=00:00:40.00\n\
[Parsed_showinfo_2 @ 0x1] n:   2 pts:  12345 pts_time:4.1 duration: 1\n\
[Parsed_showinfo_2 @ 0x1] n:   3 pts:  1 pts_time:nan duration: 1\n";
        assert_eq!(parse_showinfo_times(stderr), vec![4.1, 33.366667]);
        assert!(parse_showinfo_times("").is_empty());
    }
}
