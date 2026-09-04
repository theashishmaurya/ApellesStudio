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

/// Rendered height of a filmstrip thumbnail, in px (D-124). The Edit-tab
/// timeline row this tiles into is 52px tall (`TimelinePane.tsx`'s
/// `ROW_HEIGHT`), so this is exactly 2x it — enough for a Retina panel and
/// nothing beyond it. D-119 inherited [`extract_thumb_strip`]'s `150`, which
/// is Colorist's *poster-frame* size (a much larger on-screen element), not
/// this one's: owner, live — "for thumbnail you dont have to take all the
/// frame in high quality right so do the optimization."
const THUMB_STRIP_HEIGHT: u32 = 104;

/// Only sample keyframes when consecutive thumbnails are at least this many
/// seconds apart (D-124). Real measured keyframe intervals on the owner's own
/// two clips: 0.87s (`A001…MOV`, 4K HEVC — 592 keyframes over 517s) and 2.67s
/// (`Screen Recording…mov`, H.264 — only **3** keyframes over 8s). So a
/// keyframe-only decode is visually lossless when we want a frame less often
/// than every 4s (each requested sample still lands on a distinct keyframe),
/// and would visibly repeat frames if used for finer sampling than that —
/// which is exactly why this is a threshold and not an unconditional flag.
/// It is also self-limiting in the right direction: fine sampling only ever
/// happens on a short range, where a full decode is cheap anyway.
const KEYFRAME_SAMPLE_MIN_SECS: f64 = 4.0;

/// Pure sampling arithmetic behind [`extract_thumb_strip_range`], pulled out
/// so it has a real correct/incorrect answer independent of any actual
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
    /// thumbnails actually emitted — `count`, but never more than the range
    /// really holds (a 0.5s range cannot yield 64 distinct frames, and asking
    /// `fps` for them would just duplicate one frame several times over)
    count: u32,
    /// seconds between consecutive thumbnails
    step_secs: f64,
    /// wall-clock seconds ffmpeg is allowed to read past `start_secs`
    read_secs: f64,
    /// whether this sampling density is coarse enough for `-skip_frame nokey`
    keyframe_only: bool,
}

fn plan_range_thumbs(start_secs: f64, duration_secs: f64, fps: f64, count: u32) -> RangeThumbPlan {
    let fps = fps.max(0.001);
    let start_secs = start_secs.max(0.0);
    let duration_secs = duration_secs.max(0.0);
    let start_frame = (start_secs * fps).round() as u64;
    let local_total = ((duration_secs * fps).round() as u64).max(1);
    // Never ask for more thumbnails than the range holds frames.
    let count = count.max(1).min(local_total.min(u32::MAX as u64) as u32);
    let step_secs = duration_secs / count as f64;
    // `-t` takes wall-clock duration, not a frame count, so pad it slightly
    // (+2 frames worth) past `duration_secs` to guarantee the last sample
    // always has a real frame to land on — an exact `-t duration_secs` can
    // land a hair short after the approximate `-ss` seek and starve it.
    let read_secs = duration_secs + (2.0 / fps);
    RangeThumbPlan {
        start_frame,
        count,
        step_secs,
        read_secs,
        keyframe_only: step_secs >= KEYFRAME_SAMPLE_MIN_SECS,
    }
}

pub fn extract_thumb_strip_range(
    path: &Path,
    info: &VideoInfo,
    start_secs: f64,
    duration_secs: f64,
    count: u32,
) -> Result<Vec<(u64, String)>> {
    let fps = info.fps().max(0.001);
    let plan = plan_range_thumbs(start_secs, duration_secs, fps, count);
    let RangeThumbPlan { start_frame, count, step_secs, read_secs, keyframe_only } = plan;
    let start_secs = start_secs.max(0.0);
    let began = std::time::Instant::now();

    // `-ss`/`-t` as INPUT options (before `-i`) bound how much of the source
    // ffmpeg reads/decodes at all — critical for a short clip trimmed out of
    // a long source file, where processing "the rest of the file" after the
    // seek point would be wasted work.
    let run = |hwaccel: bool| -> Result<std::process::Output> {
        let mut cmd = Command::new(ffmpeg_bin());
        cmd.args(["-hide_banner", "-loglevel", "error"]);
        if hwaccel {
            // Apple Silicon hardware HEVC/H.264 decode — measured live
            // against the owner's real 4K HEVC footage: 393% CPU / ~5s
            // software vs. 38% CPU / ~3s with this flag, for one 8s clip.
            cmd.args(["-hwaccel", "videotoolbox"]);
        }
        if keyframe_only {
            // D-124, the single biggest real win in this pass: tell the
            // decoder to throw away every non-keyframe *before* decoding it.
            // Measured on the owner's own `A001…MOV` (517s of 4K HEVC, the
            // whole-clip filmstrip): 105.5s -> 6.7s wall clock. The old code
            // fully decoded all 12,414 frames and then had `select` discard
            // ~99.5% of them — paying for every frame to use 64.
            cmd.args(["-skip_frame", "nokey"]);
        }
        cmd.arg("-ss")
            .arg(format!("{start_secs:.6}"))
            .arg("-t")
            .arg(format!("{read_secs:.6}"))
            .arg("-i")
            .arg(path)
            .args([
                "-vf",
                // `fps=` (a rate, in Hz) rather than D-119's
                // `select=not(mod(n,step))` (a frame-index stride). Two real
                // reasons, not a rewrite for its own sake: (1) it samples
                // evenly in *time*, which is what a filmstrip means — the
                // owner's screen recording is genuinely variable-frame-rate
                // (`r_frame_rate` 60 vs `avg_frame_rate` 20.49), so an index
                // stride puts its thumbnails at uneven real timestamps; and
                // (2) it yields exactly `count` frames, where the stride form
                // returned `count + 1` (measured: 65 for a requested 64).
                // It is also what makes `-skip_frame nokey` above usable at
                // all — keyframes arrive at irregular indices but correct
                // timestamps, which is precisely what `fps=` keys off.
                &format!("fps={:.9},scale=-2:{THUMB_STRIP_HEIGHT}", 1.0 / step_secs.max(1e-6)),
                "-q:v", "6",
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
        // trace of why.
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
    // D-124 — a real decode leaves a trace, at `info` not `debug`. The whole
    // reason this feature took three rounds to diagnose is that a slow (not
    // failing) decode was indistinguishable from one that never ran: D-121
    // logged only the hwaccel-failure path, so a strip that simply took 105
    // seconds produced no evidence of any kind. A cache hit never reaches
    // here, so this is one line per real extraction, not per render.
    log::info!(
        "chroma_clip_thumbnails: {} [{:.2}s +{:.2}s] -> {} frames in {:.2}s (keyframe_only={})",
        path.display(),
        start_secs,
        duration_secs,
        jpegs.len(),
        began.elapsed().as_secs_f64(),
        keyframe_only,
    );
    let b64 = base64::engine::general_purpose::STANDARD;
    Ok(jpegs
        .into_iter()
        .enumerate()
        .map(|(i, bytes)| {
            // Absolute source frame index, derived from the sample's real
            // timestamp — `fps=` sampling has no frame *stride* to multiply,
            // and under `-skip_frame nokey` the delivered frames' own indices
            // are not evenly spaced anyway. Time is the honest common unit.
            let local_frame = ((i as f64 * step_secs) * fps).round() as u64;
            let frame = (start_frame + local_frame).min(info.frame_count.saturating_sub(1));
            (frame, format!("data:image/jpeg;base64,{}", b64.encode(bytes)))
        })
        .take(count as usize)
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
        // 10s clip starting at 5s, 30fps, want 20 thumbnails: one every 0.5s.
        let plan = plan_range_thumbs(5.0, 10.0, 30.0, 20);
        assert_eq!(plan.start_frame, 150);
        assert_eq!(plan.count, 20);
        assert!((plan.step_secs - 0.5).abs() < 1e-9);
        // 0.5s apart is far finer than any real keyframe interval, so a
        // keyframe-only decode here would visibly repeat frames.
        assert!(!plan.keyframe_only);
    }

    #[test]
    fn plan_range_thumbs_more_requested_than_frames_is_clamped_to_what_exists() {
        // 1s clip at 30fps (30 frames), asking for 64 thumbnails - there are
        // only 30 real frames, and asking `fps=` for 64 would just duplicate.
        let plan = plan_range_thumbs(0.0, 1.0, 30.0, 64);
        assert_eq!(plan.count, 30);
        assert!(plan.step_secs > 0.0);
    }

    #[test]
    fn plan_range_thumbs_zero_duration_or_count_never_panics_or_divides_by_zero() {
        let a = plan_range_thumbs(0.0, 0.0, 30.0, 10);
        assert_eq!(a.count, 1); // clamped, not 0
        assert!(a.read_secs > 0.0);
        let b = plan_range_thumbs(0.0, 5.0, 30.0, 0);
        assert_eq!(b.count, 1); // count clamped to 1 -> one sample
        assert!(b.step_secs.is_finite());
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
        assert!(plan.count >= 1);
        assert!(plan.step_secs.is_finite() && plan.step_secs >= 0.0);
        assert!(plan.read_secs.is_finite());
    }

    /// D-124 — the real regression guard for the 105s-decode bug. Both clips
    /// are the owner's own, verbatim from `~/Movies/Chroma/New.chroma`.
    #[test]
    fn plan_range_thumbs_picks_keyframe_mode_only_for_coarse_sampling() {
        // `A001_08302215_C019.MOV`: 517.25s of 4K HEVC, 64 thumbnails wanted
        // -> 8.08s apart, far coarser than its real 0.87s keyframe interval.
        let long = plan_range_thumbs(0.0, 517.25, 24.005, 64);
        assert_eq!(long.count, 64);
        assert!(long.step_secs > KEYFRAME_SAMPLE_MIN_SECS);
        assert!(long.keyframe_only, "the 105s-decode case must use keyframes");

        // `Screen Recording 2026-08-10…mov`: 6.92s, 11 thumbnails wanted ->
        // 0.63s apart. It only has THREE keyframes in total, so keyframe mode
        // here would repeat frames - and a full decode of 7s costs 0.5s.
        let short = plan_range_thumbs(0.0, 6.9167, 20.494, 11);
        assert_eq!(short.count, 11);
        assert!(!short.keyframe_only, "fine sampling must decode every frame");
    }

    #[test]
    fn plan_range_thumbs_read_window_covers_the_last_sample() {
        // The last sample sits at `(count - 1) * step_secs`; ffmpeg must be
        // allowed to read past it or the strip comes back one frame short.
        let plan = plan_range_thumbs(2.0, 10.0, 30.0, 8);
        let last_sample = (plan.count as f64 - 1.0) * plan.step_secs;
        assert!(plan.read_secs > last_sample);
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

    /// D-124 — the real decode, not just the arithmetic around it. D-119 chose
    /// not to add this because it had no way to run it; this pass did, against
    /// the owner's own two clips, so it exists now. Still env-gated on
    /// `CHROMA_TEST_VIDEO` in the same style as the two tests above, because
    /// the file it needs is real footage kept outside the repo, not a fixture.
    ///
    /// The two ranges below deliberately straddle `KEYFRAME_SAMPLE_MIN_SECS`,
    /// so on a long enough source this exercises BOTH decode paths — the
    /// keyframe-only one (the 105s -> 6.7s win) and the every-frame one — and
    /// checks the thing that actually matters either way: that the frames come
    /// back, come back distinct, and come back the number we asked for.
    #[test]
    fn extract_thumb_strip_range_returns_real_distinct_frames() {
        let Ok(p) = std::env::var("CHROMA_TEST_VIDEO") else {
            eprintln!("skip: set CHROMA_TEST_VIDEO to run");
            return;
        };
        let path = Path::new(&p);
        let info = probe(path).expect("probe");
        let dur = info.duration_secs;
        assert!(dur > 0.0, "{p} has no duration to sample");

        // Coarse: the whole file, 64 frames. On a multi-minute source this is
        // the keyframe-only path.
        let coarse = extract_thumb_strip_range(path, &info, 0.0, dur, 64).expect("coarse strip");
        let want = plan_range_thumbs(0.0, dur, info.fps(), 64).count as usize;
        assert_eq!(coarse.len(), want, "asked for {want} frames, got {}", coarse.len());
        assert!(
            coarse.iter().all(|(_, u)| u.starts_with("data:image/jpeg;base64,") && u.len() > 64),
            "every entry must be a real, non-empty JPEG data URL"
        );
        // Distinct pictures, not one frame repeated - the exact failure mode a
        // too-aggressive `-skip_frame nokey` would produce.
        let distinct: std::collections::HashSet<&String> = coarse.iter().map(|(_, u)| u).collect();
        assert!(
            distinct.len() * 4 >= coarse.len() * 3,
            "expected mostly-distinct frames, got {} unique of {}",
            distinct.len(),
            coarse.len()
        );
        // Frame indices are absolute, ascending, and inside the source.
        assert!(coarse.windows(2).all(|w| w[0].0 <= w[1].0), "frame indices ascend");
        assert!(coarse.iter().all(|(f, _)| *f < info.frame_count.max(1)));

        // Fine: a short sub-range, which is always the every-frame path.
        let fine_dur = dur.min(4.0);
        let fine = extract_thumb_strip_range(path, &info, 0.0, fine_dur, 8).expect("fine strip");
        assert!(!fine.is_empty(), "a short sub-range must still yield frames");
        assert!(fine.iter().all(|(_, u)| u.starts_with("data:image/jpeg;base64,")));
    }
}
