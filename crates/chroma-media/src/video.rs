//! Video probe + single-frame decode, via the `ffmpeg` / `ffprobe` CLIs (D-015).
//!
//! Moved verbatim out of `app/src-tauri/src/chroma/video.rs` in D-146
//! (`docs/notes/crate-extraction-plan.md` §2.2). The one thing left behind is
//! the `engine_treats_video_as_loadable_media` test — it asserts
//! `crate::formats::is_supported_image_file("clip.mov")`, i.e. it tests *the
//! fork's* routing hook rather than anything in this file, so it stays in
//! `app/src-tauri` as the integration guard it actually is.
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
/// `Deserialize` alongside `Serialize` (D-128): a probe is two `ffprobe`
/// subprocesses, and `super::media_cache` persists the result across app
/// restarts, so this type has to survive a JSON round trip.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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

/// B-089's other half — a real, importable SFX/music source with NO video
/// track at all (mp3/wav/flac/m4a/aac/ogg). Deliberately a SEPARATE list from
/// [`VIDEO_EXTENSIONS`], not a merge into it: `is_video_file`'s other callers
/// (`image_loader.rs`, `session.rs`, `formats.rs`) genuinely need the
/// video-vs-not distinction for picking a decode path, and must keep
/// reporting `false` for a pure-audio file. Only [`is_media_file`] — the
/// media-POOL's own "is this importable at all" gate — needs the union.
pub const AUDIO_EXTENSIONS: &[&str] = &["mp3", "wav", "flac", "m4a", "aac", "ogg"];

pub fn is_video_file<P: AsRef<Path>>(path: P) -> bool {
    path.as_ref()
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| VIDEO_EXTENSIONS.iter().any(|v| v.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

/// B-089 — video OR audio: what the media pool's own "is this a real,
/// importable source" gate (`chroma_project::media_item_is_online`,
/// `probe_media_item`) should use instead of [`is_video_file`] alone, so a
/// pure-audio SFX/music file is treated as a normal online pool item rather
/// than permanently offline before `probe`/`probe_audio_only` ever runs.
pub fn is_media_file<P: AsRef<Path>>(path: P) -> bool {
    let path = path.as_ref();
    is_video_file(path)
        || path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| AUDIO_EXTENSIONS.iter().any(|a| a.eq_ignore_ascii_case(e)))
            .unwrap_or(false)
}

pub(crate) fn ffprobe_bin() -> String {
    std::env::var("CHROMA_FFPROBE").unwrap_or_else(|_| "ffprobe".to_string())
}
pub(crate) fn ffmpeg_bin() -> String {
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
    let fmt = v.get("format");
    // B-089 — `-select_streams v:0` legitimately returns an EMPTY `streams`
    // array for a real, readable, pure-audio source (SFX/music with no video
    // track at all) — this used to be treated as a probe FAILURE (`Err`),
    // which `chroma_media_import`'s own caller then surfaces as `offline:
    // true`, permanently blocking `editor_add_clip` from ever placing a
    // genuine audio-only clip. `format.duration` is still populated even with
    // zero matching streams (confirmed live against a real mp3), so an
    // audio-only source is probed as a real, online item here instead of an
    // error — see `probe_audio_only` below for the actual field-by-field
    // reasoning.
    let Some(st) = v.get("streams").and_then(|s| s.get(0)) else {
        return probe_audio_only(path, fmt);
    };

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

/// B-089 — a pure-audio source (no video stream at all) still returns a real
/// [`VideoInfo`], not an error: `width`/`height` are genuinely `0` (there IS
/// no frame), `fps_num`/`fps_den` are a NOMINAL `24/1` — not measured, since
/// there is no frame rate to measure, but a real, fixed reference rate a
/// `Clip.source_fps` can convert against exactly like any other clip (the
/// same "every clip needs a frame-rate axis for `EditOp`/keyframe frame
/// bookkeeping" contract `crates/chroma-timeline`'s own `DEFAULT_FPS = 24.0`
/// already uses for a timeline with no clips to derive one from). `frame_count`
/// is `duration_secs * 24` rounded — not a real frame boundary, just this
/// nominal rate's own unit, exactly as precise as it needs to be for placing
/// and trimming an audio clip on a 24fps-native timeline. `codec`/`pix_fmt`/
/// `color_*` are empty (no picture to describe); `has_audio`/
/// `audio_sample_rate`/`audio_channels` come from the same real
/// [`probe_audio_stream`] every other source uses.
fn probe_audio_only(path: &Path, fmt: Option<&serde_json::Value>) -> Result<VideoInfo> {
    const NOMINAL_FPS: f64 = 24.0;
    let duration_secs = fmt
        .and_then(|f| f.get("duration"))
        .and_then(|d| d.as_str())
        .and_then(|d| d.parse::<f64>().ok())
        .unwrap_or(0.0);
    let frame_count = (duration_secs * NOMINAL_FPS).round().max(0.0) as u64;
    let (has_audio, audio_sample_rate, audio_channels) = probe_audio_stream(path);
    if !has_audio {
        return Err(anyhow!("no video or audio stream in {}", path.display()));
    }
    Ok(VideoInfo {
        resolution: chroma_types::Resolution::new(0, 0),
        fps_num: NOMINAL_FPS as u32,
        fps_den: 1,
        duration_secs,
        frame_count,
        codec: String::new(),
        pix_fmt: String::new(),
        color_primaries: String::new(),
        color_transfer: String::new(),
        color_space: String::new(),
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
/// Built through [`crate::conform`] (D-228), so the frame this returns for index
/// `N` is the same picture [`crate::decode_pipe`] and the export produce for
/// `N` — the one on screen at `N / source_fps` seconds. This function is the
/// pipe's own fallback when a pipe errors, so "the same picture" is a hard
/// requirement, not a nicety: before B-104 a fallback could silently swap in a
/// different frame mid-playback.
///
/// A `FramePos::Secs` query is resolved to the grid slot *holding* that instant
/// rather than being seeked to directly, for the same reason — there is one
/// grid, and every answer comes off it.
pub fn decode_frame(path: &Path, at: FramePos, info: &VideoInfo) -> Result<DynamicImage> {
    let frame = match at {
        FramePos::Secs(s) => crate::conform::frame_at_secs(info, s),
        FramePos::Index(f) => f,
    };
    let grid = crate::conform::from_frame(info, frame);

    let mut cmd = Command::new(ffmpeg_bin());
    cmd.args(["-hide_banner", "-loglevel", "error"])
        .args(&grid.input_args)
        .arg("-i")
        .arg(path);
    if let Some(vf) = grid.vf(None::<&str>) {
        cmd.args(["-vf", &vf]);
    }
    let mut child = cmd
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
        return Err(anyhow!(
            "ffmpeg decode failed (frame {frame}, t={:.3}s): {err}",
            info.frame_to_secs(frame)
        ));
    }

    image::load_from_memory(&buf).context("decoding the PNG frame ffmpeg produced")
}

/// Extract ~`count` evenly-spaced thumbnails in ONE decode pass (fast) as small
/// JPEGs. Returns `(frame_index, "data:image/jpeg;base64,...")`.
///
/// One `ffmpeg` invocation with a `select` filter + `scale`, piping concatenated
/// MJPEG which we split on the JPEG SOI marker. This is O(one linear read of the
/// file) instead of O(count) seeks+decodes.
///
/// D-228: the source is conformed to its nominal grid *first*, which is what
/// makes the `select` below legitimate — it filters on the filter graph's own
/// frame counter `n`, and only after the conform does `n` mean "source frame
/// `n`" as the rest of Chroma defines it. On a VFR source it previously meant
/// "the `n`th coded frame", so every returned index labelled a picture that
/// lives somewhere else (B-104).
pub fn extract_thumb_strip(
    path: &Path,
    info: &VideoInfo,
    count: u32,
) -> Result<Vec<(u64, String)>> {
    let total = info.frame_count.max(1);
    let step = (total / count as u64).max(1);
    let grid = crate::conform::whole_source(info);
    let pick = format!("select=not(mod(n\\,{step}))");
    let vf = grid.vf([pick.as_str(), "scale=-2:150"]).unwrap_or_default();

    let out = Command::new(ffmpeg_bin())
        .args(["-hide_banner", "-loglevel", "error"])
        .args(&grid.input_args)
        .arg("-i")
        .arg(path)
        .args([
            "-vf", &vf,
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
pub(crate) const THUMB_STRIP_HEIGHT: u32 = 104;

/// Fallback keyframe interval, in seconds, when [`probe_keyframe_interval`]
/// can't measure one (an unreadable file, an `ffprobe` that returns no
/// keyframe packets in its sample window). D-124's own fixed
/// `KEYFRAME_SAMPLE_MIN_SECS` constant, kept as the conservative default:
/// real measured intervals on the owner's own two clips were 0.87s
/// (`A001…MOV`, 4K HEVC) and 2.67s (`Screen Recording…mov`, only **3**
/// keyframes over 8s), so 4s is above anything plausible and a
/// keyframe-only decode gated on it can't visibly repeat frames.
pub const DEFAULT_KEYFRAME_INTERVAL_SECS: f64 = 4.0;

/// How many seconds from the start of the file [`probe_keyframe_interval`]
/// samples. Long enough for a stable reading (35 keyframes on the owner's
/// A001 footage), short enough to be free.
const KEYFRAME_PROBE_WINDOW_SECS: u32 = 30;

/// The **largest** gap between consecutive keyframes in the first
/// [`KEYFRAME_PROBE_WINDOW_SECS`] of `path`, in seconds.
///
/// D-128. This replaces D-124's fixed 4-second "is keyframe-only sampling
/// safe?" threshold with the file's own real number, and it is the single
/// biggest lever on filmstrip decode cost — measured on the owner's own
/// `A001_08302215_C019.MOV` (4K HEVC, 0.875s keyframe interval), extracting
/// a 64-tile chunk at a 1-second tile spacing costs **1.69s** with
/// `-skip_frame nokey` and **~16s** without it, and D-124's fixed threshold
/// forced the expensive path for every spacing under 4s.
///
/// Reads **packets**, not frames (`-show_entries packet=...`): nothing is
/// decoded, so this is a metadata scan. Measured on that same 2.3 GB file:
/// **0.23s**, versus 7.5s for the equivalent frame-level probe (which does
/// decode). The max gap, not the mean, so a file with irregular keyframes
/// (VFR screen recordings, which the owner has) is judged on its worst case.
pub fn probe_keyframe_interval(path: &Path) -> Result<f64> {
    let out = Command::new(ffprobe_bin())
        .args([
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "packet=pts_time,flags",
            "-read_intervals", &format!("%+{KEYFRAME_PROBE_WINDOW_SECS}"),
            "-of", "csv=p=0",
        ])
        .arg(path)
        .output()
        .with_context(|| format!("running ffprobe keyframe scan on {}", path.display()))?;

    if !out.status.success() {
        return Err(anyhow!(
            "ffprobe keyframe scan failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }

    let text = String::from_utf8_lossy(&out.stdout);
    Ok(max_keyframe_gap(&text))
}

/// The pure half of [`probe_keyframe_interval`] — parse `ffprobe`'s
/// `pts_time,flags` CSV and return the largest gap between keyframe packets.
/// Split out so the parsing has a real correct/incorrect answer in a unit
/// test without an `ffprobe` process.
fn max_keyframe_gap(csv: &str) -> f64 {
    let mut times: Vec<f64> = Vec::new();
    for line in csv.lines() {
        let mut fields = line.split(',');
        let Some(pts) = fields.next().and_then(|s| s.trim().parse::<f64>().ok()) else {
            continue;
        };
        // `flags` is a field like `K__` / `K_C` for a keyframe, `___` otherwise.
        if fields.any(|f| f.contains('K')) {
            times.push(pts);
        }
    }
    if times.len() < 2 {
        return DEFAULT_KEYFRAME_INTERVAL_SECS;
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let gap = times
        .windows(2)
        .map(|w| w[1] - w[0])
        .fold(0.0f64, f64::max);
    if gap > 0.0 {
        gap
    } else {
        DEFAULT_KEYFRAME_INTERVAL_SECS
    }
}

/// Decode `tiles` evenly-spaced filmstrip thumbnails, `step_secs` apart,
/// starting at `start_secs` of `path`, and return the **raw concatenated
/// MJPEG bytes** exactly as `ffmpeg` produced them (D-128).
///
/// Raw bytes, not data-URLs: this is what [`super::filmstrip`] writes to and
/// reads back from the persistent disk cache, and base64 would inflate every
/// cached chunk by a third for no benefit — the encode is done at the edge,
/// once per response, in `filmstrip.rs`.
///
/// The chunk is a **contiguous range of the source file**, indexed from the
/// file's own t=0 rather than any clip's trim point. That is the whole point
/// of the chunked shape: two clips trimmed differently out of one source, or
/// the same clip at a different scroll position, land on the same chunks and
/// share the same cache entries.
///
/// `keyframe_only` is the caller's decision (it holds the file's measured
/// [`probe_keyframe_interval`]); this function just runs what it is told.
pub fn extract_thumb_chunk(
    path: &Path,
    info: &VideoInfo,
    start_secs: f64,
    step_secs: f64,
    tiles: u32,
    keyframe_only: bool,
) -> Result<Vec<u8>> {
    let fps = info.fps().max(0.001);
    let step_secs = step_secs.max(1e-6);
    let start_secs = start_secs.max(0.0);
    let tiles = tiles.max(1);
    // `-t` takes wall-clock duration, not a frame count, so pad it slightly
    // (+2 frames worth) past the span so the last sample always has a real
    // frame to land on — an exact `-t` can land a hair short after the
    // approximate `-ss` seek and starve it (D-124).
    let read_secs = tiles as f64 * step_secs + (2.0 / fps);
    let began = std::time::Instant::now();

    // `-ss`/`-t` as INPUT options (before `-i`) bound how much of the source
    // ffmpeg reads/decodes at all — the entire reason a windowed filmstrip
    // costs a fraction of a whole-clip one.
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
            // Throw every non-keyframe away *before* decoding it (D-124).
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
                // `fps=` (a rate) rather than a frame-index stride: it samples
                // evenly in *time*, which is what a filmstrip means (the
                // owner's screen recording is genuinely VFR), it yields
                // exactly the requested count, and it is what makes
                // `-skip_frame nokey` usable at all — keyframes arrive at
                // irregular indices but correct timestamps (D-124).
                &format!("fps={:.9},scale=-2:{THUMB_STRIP_HEIGHT}", 1.0 / step_secs),
                "-frames:v", &tiles.to_string(),
                "-q:v", "6",
                "-f", "image2pipe",
                "-c:v", "mjpeg",
                "-",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd.output()
            .with_context(|| format!("running ffmpeg thumb chunk on {}", path.display()))
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
            "ffmpeg thumb chunk failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }

    // D-124 — a real decode leaves a trace, at `info` not `debug`. A cache
    // hit (memory or disk) never reaches here, so this is one line per real
    // extraction, not per render.
    log::info!(
        "chroma_clip_thumbnails: {} [{:.2}s step {:.4}s x{}] -> {} bytes in {:.2}s (keyframe_only={})",
        path.display(),
        start_secs,
        step_secs,
        tiles,
        out.stdout.len(),
        began.elapsed().as_secs_f64(),
        keyframe_only,
    );
    Ok(out.stdout)
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
pub(crate) fn split_mjpeg(data: &[u8]) -> Vec<&[u8]> {
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
    fn max_keyframe_gap_reads_ffprobes_real_csv_shape() {
        // Verbatim shape of `ffprobe -show_entries packet=pts_time,flags
        // -of csv=p=0` output, measured against the owner's own
        // `A001_08302215_C019.MOV`: keyframes every 0.875s, non-keyframes in
        // between, trailing comma from the two-field select.
        let csv = "0.000000,K__\n0.041667,___\n0.875000,K__\n1.750000,K__\n1.791667,___\n";
        assert!((max_keyframe_gap(csv) - 0.875).abs() < 1e-9);
    }

    #[test]
    fn max_keyframe_gap_takes_the_worst_case_not_the_average() {
        // A file whose keyframes are irregular (the owner's VFR screen
        // recording is exactly this) must be judged on its widest gap, or a
        // keyframe-only decode gated on the mean would repeat frames across
        // the sparse stretch.
        let csv = "0.0,K__\n0.5,K__\n1.0,K__\n5.0,K__\n";
        assert!((max_keyframe_gap(csv) - 4.0).abs() < 1e-9);
    }

    #[test]
    fn max_keyframe_gap_falls_back_when_there_is_nothing_to_measure() {
        assert_eq!(max_keyframe_gap(""), DEFAULT_KEYFRAME_INTERVAL_SECS);
        // one keyframe is not a gap
        assert_eq!(max_keyframe_gap("0.0,K__\n"), DEFAULT_KEYFRAME_INTERVAL_SECS);
        // garbage lines are skipped, not parsed into a bogus time
        assert_eq!(max_keyframe_gap("side_data\nN/A,K__\n"), DEFAULT_KEYFRAME_INTERVAL_SECS);
    }

    #[test]
    fn max_keyframe_gap_ignores_non_keyframe_packets_entirely() {
        // All non-keyframes: no keyframe times at all, so the fallback stands
        // rather than a gap computed from the wrong packets.
        let csv = "0.0,___\n1.0,___\n2.0,___\n";
        assert_eq!(max_keyframe_gap(csv), DEFAULT_KEYFRAME_INTERVAL_SECS);
    }

    #[test]
    fn ext_check() {
        assert!(is_video_file("a/b/C019.MOV"));
        assert!(is_video_file("x.mp4"));
        assert!(!is_video_file("x.png"));
        assert!(!is_video_file("x"));
    }

    /// **B-089, the extension-gate half.** `is_media_file` must accept a real
    /// audio-only source `is_video_file` alone always rejected — this is the
    /// gate `media_item_is_online` uses, and probing an audio file never even
    /// runs if this says no first. `is_video_file` itself must stay
    /// unchanged: its OTHER callers (image/video decode-path branching)
    /// genuinely need "audio doesn't count".
    #[test]
    fn is_media_file_accepts_audio_is_video_file_rejects_b089() {
        assert!(is_media_file("sfx/click.mp3"));
        assert!(is_media_file("music/bed.flac"));
        assert!(is_media_file("a/b/C019.MOV"), "still accepts real video");
        assert!(!is_media_file("x.png"), "an image is neither");
        assert!(!is_video_file("sfx/click.mp3"), "is_video_file itself must stay video-only");
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

    /// D-128 — the real decode behind the chunked filmstrip, not just the
    /// arithmetic around it. Env-gated on `CHROMA_TEST_VIDEO` in the same
    /// style as the probe/decode tests above, because the file it needs is
    /// real footage kept outside the repo, not a fixture.
    ///
    /// Exercises **both** decode paths against the same file: a coarse chunk
    /// (keyframe-only, the cheap path that made windowing affordable) and a
    /// fine one (every-frame). What matters either way is that the frames
    /// come back, come back as the number asked for, and come back distinct —
    /// a repeated frame is exactly what a too-aggressive `-skip_frame nokey`
    /// would produce, and exactly the "stretched/smeared tiles" symptom this
    /// decision set out to remove.
    #[test]
    fn extract_thumb_chunk_returns_real_distinct_frames_on_both_decode_paths() {
        let Ok(p) = std::env::var("CHROMA_TEST_VIDEO") else {
            eprintln!("skip: set CHROMA_TEST_VIDEO to run");
            return;
        };
        let path = Path::new(&p);
        let info = probe(path).expect("probe");
        let dur = info.duration_secs;
        assert!(dur > 0.0, "{p} has no duration to sample");

        let kf = probe_keyframe_interval(path).expect("keyframe probe");
        assert!(kf > 0.0 && kf.is_finite(), "keyframe interval must be a real number, got {kf}");
        eprintln!("extract_thumb_chunk: {p} keyframe interval {kf:.3}s");

        let distinct_ratio = |bytes: &[u8]| -> (usize, usize) {
            let frames = split_mjpeg(bytes);
            let uniq: std::collections::HashSet<&[u8]> = frames.iter().copied().collect();
            (uniq.len(), frames.len())
        };

        // Coarse: a step comfortably past this file's own keyframe interval,
        // so `keyframe_only` is both safe and what the real caller would pick.
        let coarse_step = (kf * 2.0).max(1.0);
        let coarse_tiles = ((dur / coarse_step).floor() as u32).clamp(2, 64);
        let coarse = extract_thumb_chunk(path, &info, 0.0, coarse_step, coarse_tiles, true)
            .expect("coarse chunk");
        let (uniq, total) = distinct_ratio(&coarse);
        assert_eq!(
            total, coarse_tiles as usize,
            "asked for {coarse_tiles} tiles, got {total}"
        );
        assert!(
            uniq * 4 >= total * 3,
            "expected mostly-distinct frames, got {uniq} unique of {total}"
        );

        // Fine: a short window at a sub-keyframe step, the every-frame path.
        let fine_step = (kf / 4.0).max(0.05);
        let fine_tiles = 8u32;
        let fine = extract_thumb_chunk(path, &info, 0.0, fine_step, fine_tiles, false)
            .expect("fine chunk");
        let (funiq, ftotal) = distinct_ratio(&fine);
        assert_eq!(ftotal, fine_tiles as usize, "fine chunk tile count");
        assert!(funiq * 4 >= ftotal * 3, "fine chunk frames must differ too");

        // Every emitted tile is a real JPEG (SOI marker), not a truncated one.
        for f in split_mjpeg(&coarse).iter().chain(split_mjpeg(&fine).iter()) {
            assert!(f.len() > 128, "a tile must be a real JPEG, got {} bytes", f.len());
            assert_eq!(&f[..3], &[0xFF, 0xD8, 0xFF], "tile must start with a JPEG SOI marker");
        }
    }

    /// **B-089, the regression test.** A real, pure-audio file (no video
    /// stream at all — exactly an SFX/music source) must probe successfully,
    /// not error out. Confirmed to fail against the pre-fix code with
    /// `Err("no video stream in ...")`, live against a real downloaded mp3
    /// this session, before this fix.
    #[test]
    fn probe_succeeds_on_a_real_audio_only_source_b089() {
        let path = std::env::temp_dir().join(format!(
            "chroma_probe_audio_only_b089_{}_{:?}.mp3",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_file(&path);
        let out = Command::new(ffmpeg_bin())
            .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i"])
            .arg("sine=frequency=440:duration=2")
            .arg(&path)
            .output();
        let Ok(out) = out else {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        };
        if !out.status.success() {
            eprintln!("skip: ffmpeg synth failed: {}", String::from_utf8_lossy(&out.stderr));
            return;
        }

        let info = probe(&path).expect("a pure-audio source must probe successfully, not error");
        assert_eq!(info.resolution.width, 0, "no video stream means no real width");
        assert_eq!(info.resolution.height, 0);
        assert!((info.duration_secs - 2.0).abs() < 0.1, "got {}", info.duration_secs);
        assert_eq!(info.fps(), 24.0, "nominal reference rate for frame bookkeeping");
        assert!(
            (info.frame_count as i64 - 48).abs() <= 2,
            "~2s at the nominal 24fps reference rate, got {}",
            info.frame_count
        );
        assert!(info.has_audio, "a sine-wave source has a real audio stream");
        assert!(info.audio_sample_rate > 0);

        let _ = std::fs::remove_file(&path);
    }
}
