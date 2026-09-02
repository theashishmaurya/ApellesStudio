//! Video probe + single-frame decode, via the `ffmpeg` / `ffprobe` CLIs (D-015).
//!
//! What it is: the thinnest possible "a video is a source of frames" layer.
//! What it does: `probe()` reads stream metadata; `decode_frame()` returns one frame
//!   as an `image::DynamicImage` (8-bit RGB) at a given time or frame index.
//! What it does NOT do: playback, audio, seeking optimisation, proxy caching,
//!   colour management. Those are higher layers.
//! Why a subprocess and not `ffmpeg-next` bindings: zero C/pkg-config build surface,
//!   ffmpeg is already a hard dep of this repo's workflow, deterministic, trivially
//!   swappable later. Cost: ~10–30 ms spawn per frame — fine for load + proxied scrub;
//!   smooth playback will need a persistent pipe or a pre-rendered proxy.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};

use anyhow::{anyhow, Context, Result};
use base64::Engine as _;
use image::DynamicImage;

/// Container/stream facts we need. Colour tags are best-effort (may be empty).
#[derive(Debug, Clone, serde::Serialize)]
pub struct VideoInfo {
    pub width: u32,
    pub height: u32,
    /// exact frame rate as a rational (avg_frame_rate)
    pub fps_num: u32,
    pub fps_den: u32,
    pub duration_secs: f64,
    /// nb_frames if the container reports it, else estimated from duration * fps
    pub frame_count: u64,
    pub codec: String,
    pub pix_fmt: String,
    pub color_primaries: String,
    pub color_transfer: String,
    pub color_space: String,
}

impl VideoInfo {
    pub fn fps(&self) -> f64 {
        if self.fps_den == 0 {
            0.0
        } else {
            self.fps_num as f64 / self.fps_den as f64
        }
    }

    /// project frame index -> presentation time in seconds
    pub fn frame_to_secs(&self, frame: u64) -> f64 {
        let fps = self.fps();
        if fps <= 0.0 {
            0.0
        } else {
            frame as f64 / fps
        }
    }
}

/// Where in the clip to grab a frame.
#[derive(Debug, Clone, Copy)]
pub enum FramePos {
    #[allow(dead_code)] // used by tests + the future proxied-scrub path
    Secs(f64),
    /// used by the transport/scrub layer (playhead frame -> time)
    #[allow(dead_code)]
    Index(u64),
}

pub const VIDEO_EXTENSIONS: &[&str] = &[
    "mov", "mp4", "m4v", "mkv", "webm", "avi", "mts", "m2ts", "mxf", "braw", "r3d",
];

pub fn is_video_file<P: AsRef<Path>>(path: P) -> bool {
    path.as_ref()
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| VIDEO_EXTENSIONS.iter().any(|v| v.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

fn ffprobe_bin() -> String {
    std::env::var("CHROMA_FFPROBE").unwrap_or_else(|_| "ffprobe".to_string())
}
fn ffmpeg_bin() -> String {
    std::env::var("CHROMA_FFMPEG").unwrap_or_else(|_| "ffmpeg".to_string())
}

/// Parse "30000/1001" style rationals; falls back to (0, 1) on garbage.
fn parse_rational(s: &str) -> (u32, u32) {
    let mut it = s.split('/');
    let n = it.next().and_then(|x| x.trim().parse::<u32>().ok());
    let d = it.next().and_then(|x| x.trim().parse::<u32>().ok());
    match (n, d) {
        (Some(n), Some(d)) if d != 0 => (n, d),
        (Some(n), None) if n != 0 => (n, 1),
        _ => (0, 1),
    }
}

pub fn probe(path: &Path) -> Result<VideoInfo> {
    let out = Command::new(ffprobe_bin())
        .args([
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries",
            "stream=width,height,avg_frame_rate,r_frame_rate,nb_frames,codec_name,pix_fmt,color_primaries,color_transfer,color_space:format=duration",
            "-of", "json",
        ])
        .arg(path)
        .output()
        .with_context(|| format!("running ffprobe on {}", path.display()))?;

    if !out.status.success() {
        return Err(anyhow!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }

    let v: serde_json::Value = serde_json::from_slice(&out.stdout).context("parsing ffprobe json")?;
    let st = v
        .get("streams")
        .and_then(|s| s.get(0))
        .ok_or_else(|| anyhow!("no video stream in {}", path.display()))?;
    let fmt = v.get("format");

    let get = |k: &str| st.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();

    let width = st.get("width").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    let height = st.get("height").and_then(|x| x.as_u64()).unwrap_or(0) as u32;

    // prefer avg_frame_rate; fall back to r_frame_rate
    let (mut fps_num, mut fps_den) = parse_rational(&get("avg_frame_rate"));
    if fps_num == 0 {
        let (n, d) = parse_rational(&get("r_frame_rate"));
        fps_num = n;
        fps_den = d;
    }

    let duration_secs = fmt
        .and_then(|f| f.get("duration"))
        .and_then(|d| d.as_str())
        .and_then(|d| d.parse::<f64>().ok())
        .unwrap_or(0.0);

    let nb_frames = st
        .get("nb_frames")
        .and_then(|x| x.as_str())
        .and_then(|x| x.parse::<u64>().ok())
        .filter(|&n| n > 0);
    let fps = if fps_den == 0 { 0.0 } else { fps_num as f64 / fps_den as f64 };
    let frame_count = nb_frames.unwrap_or_else(|| (duration_secs * fps).round().max(0.0) as u64);

    Ok(VideoInfo {
        width,
        height,
        fps_num,
        fps_den,
        duration_secs,
        frame_count,
        codec: get("codec_name"),
        pix_fmt: get("pix_fmt"),
        color_primaries: get("color_primaries"),
        color_transfer: get("color_transfer"),
        color_space: get("color_space"),
    })
}

/// Decode exactly one frame to an 8-bit RGB `DynamicImage`.
///
/// `-ss` before `-i` = fast (keyframe-accurate) seek; adequate for load + proxied
/// scrub. Frame-exact seeking (slow: decode from the prior keyframe) is a later
/// concern for the playback path.
pub fn decode_frame(path: &Path, at: FramePos, info: &VideoInfo) -> Result<DynamicImage> {
    let secs = match at {
        FramePos::Secs(s) => s,
        FramePos::Index(f) => info.frame_to_secs(f),
    }
    .max(0.0);

    let mut child = Command::new(ffmpeg_bin())
        .args(["-hide_banner", "-loglevel", "error", "-ss"])
        .arg(format!("{secs:.6}"))
        .arg("-i")
        .arg(path)
        .args([
            "-frames:v", "1",
            "-f", "image2pipe",
            "-vcodec", "png",
            "-pix_fmt", "rgb24",
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("spawning ffmpeg to decode {}", path.display()))?;

    let mut buf = Vec::new();
    child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("ffmpeg stdout unavailable"))?
        .read_to_end(&mut buf)?;
    let status = child.wait()?;

    if !status.success() || buf.is_empty() {
        let mut err = String::new();
        if let Some(mut s) = child.stderr.take() {
            let _ = s.read_to_string(&mut err);
        }
        return Err(anyhow!("ffmpeg decode failed (t={secs:.3}s): {err}"));
    }

    image::load_from_memory(&buf).context("decoding the PNG frame ffmpeg produced")
}

/// Extract ~`count` evenly-spaced thumbnails in ONE decode pass (fast) as small
/// JPEGs. Returns `(frame_index, "data:image/jpeg;base64,...")`.
///
/// One `ffmpeg` invocation with a `select` filter + `scale`, piping concatenated
/// MJPEG which we split on the JPEG SOI marker. This is O(one linear read of the
/// file) instead of O(count) seeks+decodes.
pub fn extract_thumb_strip(
    path: &Path,
    info: &VideoInfo,
    count: u32,
) -> Result<Vec<(u64, String)>> {
    let total = info.frame_count.max(1);
    let step = (total / count as u64).max(1);

    let out = Command::new(ffmpeg_bin())
        .args(["-hide_banner", "-loglevel", "error", "-i"])
        .arg(path)
        .args([
            "-vf",
            &format!("select=not(mod(n\\,{step})),scale=-2:150"),
            "-fps_mode", "passthrough",
            "-q:v", "5",
            "-f", "image2pipe",
            "-c:v", "mjpeg",
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .with_context(|| format!("running ffmpeg thumb strip on {}", path.display()))?;

    if !out.status.success() {
        return Err(anyhow!(
            "ffmpeg thumb strip failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }

    let jpegs = split_mjpeg(&out.stdout);
    let b64 = base64::engine::general_purpose::STANDARD;
    Ok(jpegs
        .into_iter()
        .enumerate()
        .map(|(i, bytes)| {
            let frame = (i as u64 * step).min(total.saturating_sub(1));
            (frame, format!("data:image/jpeg;base64,{}", b64.encode(bytes)))
        })
        .collect())
}

/// A single thumbnail (data-URL JPEG) for `frame`, scaled to `height` px tall.
/// Used by the multi-shot shot strip (D-033) — one small preview per shot.
pub fn extract_thumb(path: &Path, info: &VideoInfo, frame: u64, height: u32) -> Result<String> {
    let frame = frame.min(info.frame_count.saturating_sub(1));
    let ts = info.frame_to_secs(frame);
    let out = Command::new(ffmpeg_bin())
        .args(["-hide_banner", "-loglevel", "error", "-ss"])
        .arg(format!("{ts:.6}"))
        .args(["-i"])
        .arg(path)
        .args([
            "-frames:v", "1",
            "-vf", &format!("scale=-2:{}", height.max(2)),
            "-q:v", "5",
            "-f", "image2pipe",
            "-c:v", "mjpeg",
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .with_context(|| format!("running ffmpeg thumb on {}", path.display()))?;
    if !out.status.success() || out.stdout.is_empty() {
        return Err(anyhow!(
            "ffmpeg thumb failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let b64 = base64::engine::general_purpose::STANDARD;
    Ok(format!("data:image/jpeg;base64,{}", b64.encode(&out.stdout)))
}

/// Split a concatenated MJPEG byte stream into individual JPEG frames on the
/// `FF D8 FF` start-of-image marker.
fn split_mjpeg(data: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 2 < data.len() {
        if data[i] == 0xFF && data[i + 1] == 0xD8 && data[i + 2] == 0xFF {
            starts.push(i);
            i += 3;
        } else {
            i += 1;
        }
    }
    starts
        .iter()
        .enumerate()
        .map(|(k, &s)| {
            let end = starts.get(k + 1).copied().unwrap_or(data.len());
            &data[s..end]
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ext_check() {
        assert!(is_video_file("a/b/C019.MOV"));
        assert!(is_video_file("x.mp4"));
        assert!(!is_video_file("x.png"));
        assert!(!is_video_file("x"));
    }

    #[test]
    fn engine_treats_video_as_loadable_media() {
        // the formats.rs hook must route videos into the load path
        assert!(crate::formats::is_supported_image_file("clip.mov"));
        assert!(crate::formats::is_supported_image_file("A001_C019.MOV"));
        assert!(!crate::formats::is_supported_image_file("notes.txt"));
    }

    #[test]
    fn rational_parse() {
        assert_eq!(parse_rational("30000/1001"), (30000, 1001));
        assert_eq!(parse_rational("24/1"), (24, 1));
        assert_eq!(parse_rational("0/0"), (0, 1));
        assert_eq!(parse_rational("garbage"), (0, 1));
    }

    // Integration test — only runs if CHROMA_TEST_VIDEO points at a real file.
    #[test]
    fn probe_and_decode_real_file() {
        let Ok(p) = std::env::var("CHROMA_TEST_VIDEO") else {
            eprintln!("skip: set CHROMA_TEST_VIDEO to run");
            return;
        };
        let path = Path::new(&p);
        let info = probe(path).expect("probe");
        assert!(info.width > 0 && info.height > 0);
        assert!(info.fps() > 0.0);
        let img = decode_frame(path, FramePos::Secs(1.0), &info).expect("decode");
        assert_eq!(img.width(), info.width);
        assert_eq!(img.height(), info.height);
    }
}
