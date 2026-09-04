//! Video probe + single-frame decode, via the `ffmpeg` / `ffprobe` CLIs (D-015).
//!
//! What it is: the thinnest possible "a video is a source of frames" layer.
//! What it does: `probe()` reads stream metadata — video stream facts as before,
//!   plus (D-049) whether the container has an audio stream and its sample
//!   rate / channel count, so `audio.rs` can decide whether there is anything
//!   to play without opening a second (symphonia) decode session just to ask;
//!   `decode_frame()` returns one video frame as an `image::DynamicImage`
//!   (8-bit RGB) at a given time or frame index.
//! What it does NOT do: playback, audio *decode* (that's `audio.rs`, via
//!   symphonia — this module only reports whether/what audio exists),
//!   seeking optimisation, proxy caching, colour management. Those are higher
//!   layers.
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
///
/// `resolution` is `chroma_types::Resolution` (D-053) via `#[serde(flatten)]`
/// — same `width`/`height` JSON keys as before this decision, zero wire
/// change; call sites read `info.resolution.width`/`.height` (or
/// `info.resolution` whole) instead of the old flat `info.width`/`.height`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct VideoInfo {
    #[serde(flatten)]
    pub resolution: chroma_types::Resolution,
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
    /// Whether the container has a decodeable audio stream (D-049). `false`
    /// for a silent source (e.g. this repo's own `pexels_28808272.mp4` test
    /// clip) — not an error, `audio.rs` just plays nothing for it.
    pub has_audio: bool,
    /// The audio stream's sample rate in Hz, or `0` if `has_audio` is `false`.
    pub audio_sample_rate: u32,
    /// The audio stream's channel count, or `0` if `has_audio` is `false`.
    pub audio_channels: u16,
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

    let (has_audio, audio_sample_rate, audio_channels) = probe_audio_stream(path);

    Ok(VideoInfo {
        resolution: chroma_types::Resolution::new(width, height),
        fps_num,
        fps_den,
        duration_secs,
        frame_count,
        codec: get("codec_name"),
        pix_fmt: get("pix_fmt"),
        color_primaries: get("color_primaries"),
        color_transfer: get("color_transfer"),
        color_space: get("color_space"),
        has_audio,
        audio_sample_rate,
        audio_channels,
    })
}

/// Whether `path`'s first audio stream exists, and if so its sample rate /
/// channel count (D-049). A separate, small `ffprobe` call (rather than
/// folding `a:0` into the video `-select_streams` query above) so the
/// existing video-field parsing above is untouched — probing is cached one
/// layer up (`edit::probe_cached`), so this is paid once per clip, not once
/// per frame. Any failure (no audio stream, unreadable file) is reported as
/// `(false, 0, 0)`, not an error — a source with no audio is a normal case
/// `audio.rs` handles by simply not opening a device stream.
fn probe_audio_stream(path: &Path) -> (bool, u32, u16) {
    let out = Command::new(ffprobe_bin())
        .args([
            "-v", "error",
            "-select_streams", "a:0",
            "-show_entries", "stream=sample_rate,channels",
            "-of", "json",
        ])
        .arg(path)
        .output();

    let Ok(out) = out else { return (false, 0, 0) };
    if !out.status.success() {
        return (false, 0, 0);
    }
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else {
        return (false, 0, 0);
    };
    let Some(st) = v.get("streams").and_then(|s| s.get(0)) else {
        return (false, 0, 0);
    };
    let sample_rate = st
        .get("sample_rate")
        .and_then(|x| x.as_str())
        .and_then(|x| x.parse::<u32>().ok())
        .unwrap_or(0);
    let channels = st.get("channels").and_then(|x| x.as_u64()).unwrap_or(0) as u16;
    if sample_rate == 0 || channels == 0 {
        (false, 0, 0)
    } else {
        (true, sample_rate, channels)
    }
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

/// Extract ~`count` evenly-spaced thumbnails within `[start_secs, start_secs +
/// duration_secs)` of `path` (D-119 — the Edit-tab timeline's clip filmstrips).
/// Same one-decode-pass `select`+`scale` MJPEG-pipe technique as
/// [`extract_thumb_strip`], but scoped to a clip's real trimmed range instead
/// of always spanning the whole source file — a timeline clip almost always
/// represents a sub-range (`source_start`/`duration`) of its source, not the
/// entire file, and thumbnails outside that range would be actively wrong
/// (frames the clip never actually shows). Fast-seeks to `start_secs` via
/// `-ss` before `-i` (same "adequate for scrub/preview, not frame-exact"
/// tradeoff [`decode_frame`]'s doc already documents for this codebase), then
/// runs the `select` filter over frame indices *relative to that seek point*.
/// Returned `frame` values are absolute indices into the source's own frame
/// count (`start_frame + local_index * step`), matching the convention every
/// other frame-index API in this module already uses.
/// Pure frame-index arithmetic behind [`extract_thumb_strip_range`], pulled
/// out so it has a real correct/incorrect answer independent of any actual
/// `ffmpeg` process — the same "pure logic separated and unit tested, I/O
/// not" discipline this module's sibling extractors ([`extract_thumb_strip`],
/// [`extract_thumb`]) never got real coverage for either: this file's own
/// `CHROMA_TEST_VIDEO`-gated tests (see the `tests` module below) need a
/// real file path supplied via env var at run time, not a checked-in
/// fixture, and neither var is set in this environment — so this at least
/// gets the one part of the range variant that *can* have a provable answer
/// independent of that covered.
#[derive(Debug, PartialEq)]
struct RangeThumbPlan {
    /// absolute frame index into the source where the requested range begins
    start_frame: u64,
    /// how many frames the requested range spans, at least 1
    local_total: u64,
    /// stride (in local frame units) between selected thumbnails, at least 1
    step: u64,
}

fn plan_range_thumbs(start_secs: f64, duration_secs: f64, fps: f64, count: u32) -> RangeThumbPlan {
    let fps = fps.max(0.001);
    let start_secs = start_secs.max(0.0);
    let start_frame = (start_secs * fps).round() as u64;
    let local_total = ((duration_secs.max(0.0) * fps).round() as u64).max(1);
    let step = (local_total / count.max(1) as u64).max(1);
    RangeThumbPlan { start_frame, local_total, step }
}

pub fn extract_thumb_strip_range(
    path: &Path,
    info: &VideoInfo,
    start_secs: f64,
    duration_secs: f64,
    count: u32,
) -> Result<Vec<(u64, String)>> {
    let fps = info.fps().max(0.001);
    let RangeThumbPlan { start_frame, local_total, step } =
        plan_range_thumbs(start_secs, duration_secs, fps, count);
    let start_secs = start_secs.max(0.0);

    // `-ss`/`-t` as INPUT options (before `-i`) bound how much of the source
    // ffmpeg reads/decodes at all — critical for a short clip trimmed out of
    // a long source file, where processing "the rest of the file" after the
    // seek point would be wasted work. `-t` takes wall-clock duration, not a
    // frame count, so pad it slightly (+2 frames worth) past `duration_secs`
    // to guarantee `select`'s own step math always has a full `local_total`
    // frames to choose from — an exact `-t duration_secs` can occasionally
    // land a hair short after the approximate `-ss` seek and silently starve
    // the last bucket.
    let read_secs = duration_secs.max(0.0) + (2.0 / fps);
    let run = |hwaccel: bool| -> Result<std::process::Output> {
        let mut cmd = Command::new(ffmpeg_bin());
        cmd.args(["-hide_banner", "-loglevel", "error"]);
        if hwaccel {
            // Apple Silicon hardware HEVC/H.264 decode — measured live
            // against the owner's real 4K HEVC footage: 393% CPU / ~5s
            // software vs. 38% CPU / ~3s with this flag, for one 8s clip.
            // That gap is the real, direct cause of the owner's concurrent-
            // ffmpeg-burst overload (D-119's own follow-up) — several
            // clips' worth of *software* HEVC decode is enough to starve
            // the whole machine even with a concurrency cap in place.
            cmd.args(["-hwaccel", "videotoolbox"]);
        }
        cmd.arg("-ss")
            .arg(format!("{start_secs:.6}"))
            .arg("-t")
            .arg(format!("{read_secs:.6}"))
            .arg("-i")
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
            .stderr(Stdio::piped());
        cmd.output()
            .with_context(|| format!("running ffmpeg ranged thumb strip on {}", path.display()))
    };

    let mut out = run(true)?;
    if !out.status.success() {
        // Real fallback, not assumed-safe: `-hwaccel videotoolbox` doesn't
        // cover every codec/pixel format a source file might use, and a
        // decode this feature treats as "nice to have" should degrade to
        // software rather than leave a clip with no thumbnail at all and no
        // trace of why (the exact silent-failure shape this whole pass is
        // fixing on the frontend side too).
        log::warn!(
            "chroma_clip_thumbnails: hwaccel decode failed for {}, retrying in software: {}",
            path.display(),
            String::from_utf8_lossy(&out.stderr)
        );
        out = run(false)?;
    }

    if !out.status.success() {
        return Err(anyhow!(
            "ffmpeg ranged thumb strip failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }

    let jpegs = split_mjpeg(&out.stdout);
    let b64 = base64::engine::general_purpose::STANDARD;
    Ok(jpegs
        .into_iter()
        .enumerate()
        .map(|(i, bytes)| {
            let local_frame = (i as u64 * step).min(local_total.saturating_sub(1));
            let frame = (start_frame + local_frame).min(info.frame_count.saturating_sub(1));
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
    fn plan_range_thumbs_typical_clip() {
        // 10s clip at 30fps, want 20 thumbnails: 300 local frames / 20 = step 15.
        let plan = plan_range_thumbs(5.0, 10.0, 30.0, 20);
        assert_eq!(plan, RangeThumbPlan { start_frame: 150, local_total: 300, step: 15 });
    }

    #[test]
    fn plan_range_thumbs_more_requested_than_frames_steps_at_least_one() {
        // 1s clip at 30fps (30 frames), asking for 64 thumbnails - step floors
        // at 1, never 0 (a step of 0 would be a `mod 0` div-by-zero in the
        // ffmpeg filter expression this feeds).
        let plan = plan_range_thumbs(0.0, 1.0, 30.0, 64);
        assert_eq!(plan.local_total, 30);
        assert_eq!(plan.step, 1);
    }

    #[test]
    fn plan_range_thumbs_zero_duration_or_count_never_panics_or_divides_by_zero() {
        let a = plan_range_thumbs(0.0, 0.0, 30.0, 10);
        assert_eq!(a.local_total, 1); // clamped, not 0
        let b = plan_range_thumbs(0.0, 5.0, 30.0, 0);
        assert_eq!(b.step, b.local_total); // count clamped to 1 -> one bucket spanning everything
    }

    #[test]
    fn plan_range_thumbs_negative_start_clamps_to_zero() {
        let plan = plan_range_thumbs(-3.0, 2.0, 25.0, 5);
        assert_eq!(plan.start_frame, 0);
    }

    #[test]
    fn plan_range_thumbs_zero_fps_never_divides_by_zero() {
        // guards the same class of bug `resampled_frame_count` in audio.rs
        // tests for on its own rate-conversion math.
        let plan = plan_range_thumbs(0.0, 5.0, 0.0, 10);
        assert!(plan.local_total > 0);
        assert!(plan.step >= 1);
    }

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
        assert!(info.resolution.width > 0 && info.resolution.height > 0);
        assert!(info.fps() > 0.0);
        let img = decode_frame(path, FramePos::Secs(1.0), &info).expect("decode");
        assert_eq!(img.width(), info.resolution.width);
        assert_eq!(img.height(), info.resolution.height);
        // D-049: the has_audio flag and the sample rate / channel count it
        // gates must agree — whichever way CHROMA_TEST_VIDEO's audio stream
        // (or lack of one) happens to go.
        eprintln!(
            "probe_and_decode_real_file: has_audio={} sample_rate={} channels={}",
            info.has_audio, info.audio_sample_rate, info.audio_channels
        );
        assert_eq!(
            info.has_audio,
            info.audio_sample_rate > 0 && info.audio_channels > 0
        );
    }

    // Integration test — only runs if CHROMA_TEST_AUDIO_VIDEO points at a real
    // file known to have an embedded audio stream (CHROMA_TEST_VIDEO, used
    // above, is this repo's usual fixture and is silent — see D-049).
    #[test]
    fn probe_detects_a_real_audio_stream() {
        let Ok(p) = std::env::var("CHROMA_TEST_AUDIO_VIDEO") else {
            eprintln!("skip: set CHROMA_TEST_AUDIO_VIDEO to run");
            return;
        };
        let info = probe(Path::new(&p)).expect("probe");
        assert!(info.has_audio, "{p} was expected to have an audio stream");
        assert!(info.audio_sample_rate > 0);
        assert!(info.audio_channels > 0);
    }
}
