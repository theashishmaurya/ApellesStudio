//! **Optimized media: a source the media engine cannot open, converted once
//! into a `.mov` it can (D-453).**
//!
//! What it is: Final Cut's "optimized media" pattern for the one decode path
//! D-452 left. AVFoundation opens the QuickTime family (`.mov`, `.mp4`,
//! `.m4v`) and nothing else; the importer also accepts Matroska / WebM, AVI,
//! MPEG-TS (`.mts`, `.m2ts`) and MXF. Each of those is converted once, by
//! `ffmpeg` on the hardware HEVC encoder, into
//! `<project>.chroma/optimized-media/<source_key>.mov`, and every decode of the
//! original reads that file instead ([`decode_source`]).
//!
//! What it does:
//! - **[`convert`]** — the conversion itself, one blocking `ffmpeg` run:
//!   `hevc_videotoolbox` at [`QUALITY`] (measured, D-453), video only (`-an`:
//!   the sound still decodes from the original), **the source's own
//!   timestamps kept** (`-copyts`, `-fps_mode passthrough`, the encoder and the
//!   track on the source stream's own time base), so the D-228 grid picks the
//!   same frame for every nominal index, holds of a variable-frame-rate source
//!   included. No B-frames (presentation order is decode order, so no
//!   composition offsets for two readers to disagree about, §16.2) and a sync
//!   sample every second (a seek decodes at most a second forward). 8-bit
//!   sources become HEVC Main 4:2:0, deeper ones Main 10; a source with an
//!   alpha channel (including a VP9 WebM's side-channel alpha) becomes HEVC
//!   with alpha. The hardware encoder is required: a failure is an error that
//!   names the file, never a silent software encode.
//! - **The job queue** ([`request`], [`retry`], [`cancel`], [`status`], [`set_listener`]):
//!   one worker thread converts queued sources in order, reporting progress
//!   to a listener the app installs (which the GUI and `editor_list_media`
//!   read), with a cancel that kills the `ffmpeg` and removes the partial file.
//! - **Where converted files live** ([`set_project_dir`], [`init`]): the open
//!   project's own `optimized-media/` folder, or the app cache's when no project
//!   is open (a loose clip opened in the Colorist). Keyed by
//!   [`crate::media_cache::source_key`] of the original, so a source rewritten in
//!   place is converted again, and the project file itself only ever names the
//!   original — relinking and existing projects need no rewrite.
//!
//! What it does NOT do: decide which sources a project holds (the app asks it to
//! convert its pool and its timeline's sources); decode (that is
//! [`crate::vt_decode`], handed the converted file); convert audio, or a
//! QuickTime-family file (already the media engine's); or fall back to anything.
//! A source that is not converted yet is an error naming the file and the
//! conversion's state — the preview and the export say so rather than draw black.
//!
//! **Fidelity.** The converted file is a second lossy generation of the original's
//! decode: measured against that decode, HEVC at `QUALITY` 75 is 45.6–49.4 dB on
//! the worst frame of textured 1080p sources, the same frames at the same indices
//! (`optimized_media::tests`, `docs/notes/optimized-media.md`).

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, anyhow};
use once_cell::sync::Lazy;
use serde::Serialize;

use crate::video::VideoInfo;

/// VideoToolbox HEVC constant quality (`-q:v`, 1–100). Measured (D-453,
/// `docs/notes/optimized-media.md` §2): against the original's own decode, 75
/// keeps every frame of the textured test sources at or above 45 dB (the
/// visually-lossless line), at 0.5–1.8× the delivery file's size. 70 drops
/// below it on fine detail; 80 costs another 25–30% of size for +2 dB nobody
/// sees in an intermediate.
pub const QUALITY: u32 = 75;

/// The alpha plane's quality for a source with transparency (VideoToolbox's
/// `AlphaChannelQuality`, 0–1), the same 0.75 point as [`QUALITY`].
pub const ALPHA_QUALITY: &str = "0.75";

/// The matrix VideoToolbox codes an HEVC-with-alpha file's BGRA input with
/// (measured: the base layer decodes 42 dB from the source as BT.709, 28 dB as
/// BT.601, whatever matrix the encoder is told; D-453).
const ALPHA_MATRIX: &str = "bt709";

/// One sync sample per this many seconds of source. A seek decodes forward from
/// the sync sample before it, so this bounds a seek at a second of hardware
/// decode; measured 1.6% larger than a 10-second interval.
const KEY_INTERVAL_SECS: f64 = 1.0;

/// The folder, inside a project directory (or the app cache), that holds the
/// converted files.
pub const FOLDER: &str = "optimized-media";

/// The converted file's suffix while `ffmpeg` is still writing it. Renamed to
/// `.mov` only once complete, so a `.mov` in the folder is always a whole file.
const PARTIAL_SUFFIX: &str = "partial.mov";

/// Whether `path` is a video file the media engine cannot open, i.e. one that
/// has to be converted before it can be decoded. (An audio-only file is never
/// handed here: its sound decodes from the original and it has no picture.)
pub fn needs_conversion(path: &Path) -> bool {
    crate::video::is_video_file(path) && !crate::vt_decode::is_engine_container(path)
}

// ------------------------------------------------------------------------- //
// where converted files live
// ------------------------------------------------------------------------- //

/// The app cache's folder, used when no project is open. Set once at startup.
static FALLBACK_ROOT: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));

/// Bind the no-project folder (`<app cache>/optimized-media`). Called once from
/// the app's `setup`, next to `media_cache::init`. Not inside the media cache's
/// own root: that one is pruned to a size budget, and a converted source is
/// not a cache entry that can be thrown away and silently rebuilt mid-edit.
pub fn init(app_cache_dir: &Path) {
    *FALLBACK_ROOT.lock().unwrap_or_else(|e| e.into_inner()) = Some(app_cache_dir.join(FOLDER));
}

/// Make `project_dir`'s `optimized-media/` folder (or, with `None`, the app
/// cache's) the place converted files are written to and read from. Called
/// whenever the open project changes. Switching to a different folder cancels
/// every conversion queued or running for the old one: those files belong to
/// a project that is no longer open, and they are converted again when it is.
pub fn set_project_dir(project_dir: Option<&Path>) {
    let next = project_dir.map(|d| d.join(FOLDER));
    let cancelled = {
        let mut reg = registry();
        if reg.project_root == next {
            return;
        }
        reg.project_root = next;
        reg.queue.clear();
        let running: Vec<_> = reg.running.take().into_iter().collect();
        reg.jobs.clear();
        running
    };
    for job in cancelled {
        job.cancel();
    }
}

/// The folder converted files are in right now.
pub fn root() -> Option<PathBuf> {
    let project = registry().project_root.clone();
    project.or_else(|| {
        FALLBACK_ROOT
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    })
}

/// Where `source`'s converted file is (or will be) in `root`.
pub fn converted_path_in(root: &Path, source: &Path) -> Result<PathBuf, String> {
    let key = crate::media_cache::source_key(source)?;
    Ok(root.join(format!("{key}.mov")))
}

/// `source`'s converted file, if the media engine cannot open `source` and the
/// conversion has finished.
pub fn converted_file(source: &Path) -> Option<PathBuf> {
    if !needs_conversion(source) {
        return None;
    }
    let path = converted_path_in(&root()?, source).ok()?;
    (path.is_file() && facts_path(&path).is_file()).then_some(path)
}

/// What the decoder must assume about a converted file, written beside it
/// (`<key>.json`) when its conversion completes.
///
/// Needed because the file cannot always say it itself: VideoToolbox codes an
/// HEVC-with-alpha file's BGRA input with the BT.709 matrix and writes no
/// matrix tag, and a remux that adds one drops the alpha layer (both measured,
/// D-453). An untagged file is decoded as BT.601 (swscale's default, which the
/// engine follows), so the matrix is recorded here instead. The pixel format
/// is recorded with it, so a decode needs no `ffprobe` of the converted file.
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertedFacts {
    /// The converted file's pixel format as ffprobe names it.
    pub pix_fmt: String,
    /// The Y'CbCr matrix its samples are coded with, as ffprobe names it
    /// (`bt709`, or empty for untagged — decoded as BT.601).
    pub color_space: String,
}

fn facts_path(converted: &Path) -> PathBuf {
    converted.with_extension("json")
}

/// A converted file's [`ConvertedFacts`].
pub fn read_facts(converted: &Path) -> Result<ConvertedFacts> {
    let path = facts_path(converted);
    let bytes = std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_slice(&bytes).with_context(|| format!("parsing {}", path.display()))
}

/// What the decoder opens for `source`, and the facts to decode it with.
pub struct DecodeSource {
    pub path: PathBuf,
    /// `None` when `path` is the source itself; otherwise the source's facts
    /// with the converted file's own pixel format and matrix, since those
    /// describe the bytes the decoder reads (a 4:2:2 source is 4:2:0 once
    /// converted, an RGB one Y'CbCr). The frame rate stays the source's: the
    /// grid is defined by it, and the timestamps it is applied to are the
    /// source's own.
    pub info: Option<VideoInfo>,
}

/// **The decode-side mapping**: the file `vt_decode` opens for `source`.
///
/// A QuickTime-family source is itself. Any other is its converted file, or an
/// error that says why there is none yet. A source that has never been asked
/// for is queued here, so every path that decodes (a loose clip opened in the
/// Colorist included) starts its own conversion; a cancelled or failed one is
/// not restarted behind the user's back.
pub fn decode_source(source: &Path, info: &VideoInfo) -> Result<DecodeSource> {
    if !needs_conversion(source) {
        return Ok(DecodeSource {
            path: source.to_path_buf(),
            info: None,
        });
    }
    if let Some(path) = converted_file(source) {
        let facts = read_facts(&path)?;
        let mut decode_info = info.clone();
        decode_info.pix_fmt = facts.pix_fmt;
        decode_info.color_space = facts.color_space;
        return Ok(DecodeSource {
            path,
            info: Some(decode_info),
        });
    }
    let state = match status(source) {
        Some(s) => s,
        None => {
            request(&[source.to_path_buf()]);
            status(source).unwrap_or(ConversionStatus::queued())
        }
    };
    Err(anyhow!(NotConverted {
        source: source.to_path_buf(),
        status: state,
    }))
}

/// The decode error for a source whose conversion has not finished: says which
/// file, and where its conversion stands.
#[derive(Debug, Clone)]
pub struct NotConverted {
    pub source: PathBuf,
    pub status: ConversionStatus,
}

impl std::fmt::Display for NotConverted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let name = self.source.display();
        match self.status.state {
            ConversionState::Queued => write!(
                f,
                "{name} is waiting to be converted to optimized media; it can be shown once it is"
            ),
            ConversionState::Converting => write!(
                f,
                "{name} is being converted to optimized media ({:.0}%); it can be shown once it is",
                self.status.progress * 100.0
            ),
            ConversionState::Failed => write!(
                f,
                "{name} could not be converted to optimized media: {}",
                self.status.error.as_deref().unwrap_or("no reason given")
            ),
            ConversionState::Cancelled => write!(
                f,
                "{name}'s conversion to optimized media was cancelled; re-probe it to convert it"
            ),
            ConversionState::Ready => write!(f, "{name} is converted"),
        }
    }
}

impl std::error::Error for NotConverted {}

// ------------------------------------------------------------------------- //
// state
// ------------------------------------------------------------------------- //

/// Where one source's conversion stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConversionState {
    Queued,
    Converting,
    Ready,
    Failed,
    Cancelled,
}

/// One source's conversion, as the GUI and `editor_list_media` report it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionStatus {
    pub state: ConversionState,
    /// 0..=1 of the source converted (1 when ready).
    pub progress: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ConversionStatus {
    fn queued() -> Self {
        Self {
            state: ConversionState::Queued,
            progress: 0.0,
            error: None,
        }
    }
    fn ready() -> Self {
        Self {
            state: ConversionState::Ready,
            progress: 1.0,
            error: None,
        }
    }
}

/// The running conversion's handle: the `ffmpeg` to kill, and the flag that
/// tells the worker the kill was a cancel rather than a failure.
struct RunningJob {
    source: PathBuf,
    cancelled: AtomicBool,
    child: Mutex<Option<Child>>,
}

impl RunningJob {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(child) = self
            .child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
        {
            // Already exited is the harmless case.
            let _ = child.kill();
        }
    }
}

type Listener = Box<dyn Fn(&Path, &ConversionStatus) + Send + Sync>;

#[derive(Default)]
struct Registry {
    /// The open project's folder; `None` = the fallback.
    project_root: Option<PathBuf>,
    /// Sources waiting, in order.
    queue: VecDeque<PathBuf>,
    /// Every source this session has asked about that is not simply ready on
    /// disk: queued, converting, failed or cancelled.
    jobs: HashMap<PathBuf, ConversionStatus>,
    running: Option<Arc<RunningJob>>,
    worker: bool,
}

static REGISTRY: Lazy<Mutex<Registry>> = Lazy::new(|| Mutex::new(Registry::default()));
static LISTENER: Lazy<Mutex<Option<Listener>>> = Lazy::new(|| Mutex::new(None));

fn registry() -> std::sync::MutexGuard<'static, Registry> {
    REGISTRY.lock().unwrap_or_else(|e| e.into_inner())
}

/// Install the one listener told about every change of state and every
/// percent of progress (the app forwards it to the GUI as an event).
pub fn set_listener(listener: impl Fn(&Path, &ConversionStatus) + Send + Sync + 'static) {
    *LISTENER.lock().unwrap_or_else(|e| e.into_inner()) = Some(Box::new(listener));
}

fn notify(source: &Path, status: &ConversionStatus) {
    if let Some(l) = LISTENER.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        l(source, status);
    }
}

fn set_state(source: &Path, status: ConversionStatus) {
    {
        let mut reg = registry();
        if status.state == ConversionState::Ready {
            reg.jobs.remove(source);
        } else {
            reg.jobs.insert(source.to_path_buf(), status.clone());
        }
    }
    notify(source, &status);
}

/// Where `source`'s conversion stands, or `None` when it needs none (the media
/// engine opens it as it is). A source that needs one and has never been asked
/// for reports `Queued` only once it is; until then, if its converted file is
/// not on disk, it reports nothing here and [`request`] is what starts it.
pub fn status(source: &Path) -> Option<ConversionStatus> {
    if !needs_conversion(source) {
        return None;
    }
    if let Some(s) = registry().jobs.get(source) {
        return Some(s.clone());
    }
    converted_file(source).map(|_| ConversionStatus::ready())
}

/// Queue every source in `sources` that needs a conversion this session has not
/// been asked for yet and that has none on disk. A source already queued,
/// converting, failed or cancelled is left as it is: an import or a project
/// open must not restart a conversion the user cancelled ([`retry`] does that).
pub fn request(sources: &[PathBuf]) {
    enqueue(sources, false);
}

/// [`request`], and also queue again every source in `sources` whose last
/// conversion failed or was cancelled: the user's "convert this again" (a
/// re-probe of the pool item).
pub fn retry(sources: &[PathBuf]) {
    enqueue(sources, true);
}

fn enqueue(sources: &[PathBuf], restart: bool) {
    let mut queued = Vec::new();
    {
        let mut reg = registry();
        for source in sources {
            if !needs_conversion(source) || !source.is_file() {
                continue;
            }
            let skip = match reg.jobs.get(source).map(|s| s.state) {
                Some(ConversionState::Queued | ConversionState::Converting) => true,
                Some(ConversionState::Failed | ConversionState::Cancelled) => !restart,
                Some(ConversionState::Ready) | None => false,
            };
            if skip {
                continue;
            }
            let root = reg.project_root.clone().or_else(|| {
                FALLBACK_ROOT
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone()
            });
            let Some(root) = root else { continue };
            if converted_path_in(&root, source)
                .is_ok_and(|p| p.is_file() && facts_path(&p).is_file())
            {
                reg.jobs.remove(source);
                continue;
            }
            reg.queue.push_back(source.clone());
            reg.jobs.insert(source.clone(), ConversionStatus::queued());
            queued.push(source.clone());
        }
        if !queued.is_empty() && !reg.worker {
            reg.worker = true;
            if let Err(e) = std::thread::Builder::new()
                .name("apelles-optimize".into())
                .spawn(worker)
            {
                reg.worker = false;
                log::error!("[optimized_media] could not start the conversion thread: {e}");
            }
        }
    }
    for source in queued {
        notify(&source, &ConversionStatus::queued());
    }
}

/// Cancel `source`'s conversion, queued or running. Returns whether there was
/// one to cancel. The partial file is removed by the worker as the run
/// unwinds.
pub fn cancel(source: &Path) -> bool {
    let (was, running) = {
        let mut reg = registry();
        let was = matches!(
            reg.jobs.get(source).map(|s| s.state),
            Some(ConversionState::Queued | ConversionState::Converting)
        );
        if !was {
            return false;
        }
        reg.queue.retain(|q| q != source);
        let running = reg.running.as_ref().filter(|r| r.source == source).cloned();
        (was, running)
    };
    // Reported cancelled at once, so the caller reads back what it asked for;
    // a running job's `ffmpeg` is killed and the worker removes its partial
    // file as it unwinds (and reports `Ready` instead only if the run had
    // already finished, which is then the truth).
    if let Some(job) = running {
        job.cancel();
    }
    set_state(
        source,
        ConversionStatus {
            state: ConversionState::Cancelled,
            progress: 0.0,
            error: None,
        },
    );
    was
}

/// The conversion thread: one source at a time, until the queue is empty.
fn worker() {
    loop {
        let next = {
            let mut reg = registry();
            let root = reg.project_root.clone().or_else(|| {
                FALLBACK_ROOT
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone()
            });
            match (reg.queue.pop_front(), root) {
                (Some(source), Some(root)) => {
                    let job = Arc::new(RunningJob {
                        source: source.clone(),
                        cancelled: AtomicBool::new(false),
                        child: Mutex::new(None),
                    });
                    reg.running = Some(job.clone());
                    Some((source, root, job))
                }
                _ => {
                    reg.worker = false;
                    None
                }
            }
        };
        let Some((source, root, job)) = next else {
            return;
        };
        let outcome = run_job(&source, &root, &job);
        {
            let mut reg = registry();
            if reg.running.as_ref().is_some_and(|r| Arc::ptr_eq(r, &job)) {
                reg.running = None;
            }
            // A project switch cleared the registry under this run: its
            // result belongs to a folder no longer in use, so report nothing.
            if !reg.jobs.contains_key(&source) {
                continue;
            }
        }
        let status = match outcome {
            Ok(()) => ConversionStatus::ready(),
            Err(_) if job.cancelled.load(Ordering::SeqCst) => ConversionStatus {
                state: ConversionState::Cancelled,
                progress: 0.0,
                error: None,
            },
            Err(e) => {
                log::error!("[optimized_media] {e:#}");
                ConversionStatus {
                    state: ConversionState::Failed,
                    progress: 0.0,
                    error: Some(format!("{e:#}")),
                }
            }
        };
        set_state(&source, status);
    }
}

fn run_job(source: &Path, root: &Path, job: &RunningJob) -> Result<()> {
    std::fs::create_dir_all(root)
        .with_context(|| format!("creating the optimized-media folder {}", root.display()))?;
    let dest = converted_path_in(root, source).map_err(|e| anyhow!(e))?;
    let info = crate::probe::probe_cached(source).map_err(|e| anyhow!(e))?;
    let mut last_percent = -1i64;
    set_state(
        source,
        ConversionStatus {
            state: ConversionState::Converting,
            progress: 0.0,
            error: None,
        },
    );
    convert_with(source, &info, &dest, job, |progress| {
        let percent = (progress * 100.0).floor() as i64;
        if percent != last_percent {
            last_percent = percent;
            set_state(
                source,
                ConversionStatus {
                    state: ConversionState::Converting,
                    progress,
                    error: None,
                },
            );
        }
    })
}

/// Remove every converted file in `root` that no source in `keep` maps to (a
/// source rewritten in place, or no longer in the project), and any partial
/// file no conversion is writing. Returns the bytes freed.
pub fn prune(root: &Path, keep: &[PathBuf]) -> u64 {
    let wanted: std::collections::HashSet<PathBuf> = keep
        .iter()
        .filter(|s| needs_conversion(s))
        .filter_map(|s| converted_path_in(root, s).ok())
        .collect();
    let running_partial = registry()
        .running
        .as_ref()
        .and_then(|r| converted_path_in(root, &r.source).ok())
        .map(|p| partial_path(&p));
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    let mut freed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        // A converted file and its facts go together.
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        let owner = if ext == "json" {
            path.with_extension("mov")
        } else {
            path.clone()
        };
        let ours = ext == "mov" || ext == "json";
        if !ours || wanted.contains(&owner) || running_partial.as_ref() == Some(&path) {
            continue;
        }
        let len = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if std::fs::remove_file(&path).is_ok() {
            freed += len;
        }
    }
    freed
}

fn partial_path(dest: &Path) -> PathBuf {
    dest.with_extension(PARTIAL_SUFFIX)
}

// ------------------------------------------------------------------------- //
// the conversion
// ------------------------------------------------------------------------- //

/// What the conversion needs to know about the source's video stream beyond
/// [`VideoInfo`]: which stream, its time base, its start, and whether it
/// carries alpha.
#[derive(Debug, Clone, PartialEq)]
struct StreamFacts {
    index: u64,
    /// The stream's time base denominator over its numerator, reduced: the
    /// track timescale that represents every source timestamp exactly.
    timescale: u64,
    start_secs: f64,
    duration_secs: f64,
    /// Full-range samples (`color_range=pc`, or a `yuvj` format).
    full_range: bool,
    alpha: Alpha,
}

/// How a source carries transparency.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Alpha {
    None,
    /// In the pixel format (`yuva420p`, `rgba`, ProRes 4444, …).
    InPixels,
    /// VP8 / VP9 in WebM with `alpha_mode=1`: the alpha plane is side data only
    /// libvpx's decoder reads, so the input is decoded with it.
    Vpx(&'static str),
}

/// A pixel format with an alpha component.
fn pix_fmt_has_alpha(pix_fmt: &str) -> bool {
    pix_fmt.starts_with("yuva")
        || pix_fmt.starts_with("gbrap")
        || pix_fmt.starts_with("ya")
        || ["rgba", "bgra", "argb", "abgr", "rgb32", "bgr32", "ayuv"]
            .iter()
            .any(|f| pix_fmt.contains(f))
        || pix_fmt.starts_with("pal8")
}

/// A pixel format with more than 8 bits per component.
fn pix_fmt_is_deep(pix_fmt: &str) -> bool {
    ["9", "10", "12", "14", "16", "p010", "p210", "p410"]
        .iter()
        .any(|d| pix_fmt.contains(d))
}

fn stream_facts(source: &Path) -> Result<StreamFacts> {
    let out = crate::ffmpeg_locate::ffprobe()?
        .args([
            "-v",
            "error",
            "-select_streams",
            "v",
            "-show_entries",
            "stream=index,codec_name,time_base,start_time,pix_fmt,color_range:stream_tags=alpha_mode:stream_disposition=attached_pic:format=duration,start_time",
            "-of",
            "json",
        ])
        .arg(source)
        .output()
        .with_context(|| format!("running ffprobe on {}", source.display()))?;
    if !out.status.success() {
        return Err(anyhow!(
            "ffprobe could not read {}: {}",
            source.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let v: serde_json::Value =
        serde_json::from_slice(&out.stdout).context("parsing ffprobe json")?;
    parse_stream_facts(&v).ok_or_else(|| anyhow!("{} has no video stream", source.display()))
}

fn parse_stream_facts(v: &serde_json::Value) -> Option<StreamFacts> {
    let st = v.get("streams")?.as_array()?.iter().find(|st| {
        st.get("disposition")
            .and_then(|d| d.get("attached_pic"))
            .and_then(|a| a.as_i64())
            != Some(1)
    })?;
    let s = |k: &str| st.get(k).and_then(|x| x.as_str()).unwrap_or("");
    let num_secs = |x: Option<&serde_json::Value>| {
        x.and_then(|d| d.as_str())
            .and_then(|d| d.parse::<f64>().ok())
            .filter(|d| d.is_finite())
    };
    let (tb_num, tb_den) = s("time_base")
        .split_once('/')
        .and_then(|(n, d)| Some((n.parse::<u64>().ok()?, d.parse::<u64>().ok()?)))
        .filter(|(n, d)| *n > 0 && *d > 0)?;
    // `n/d` seconds per tick: a timescale of `d / gcd(n, d)` represents every
    // multiple of it exactly (1/1000 → 1000, 1001/30000 → 30000, 1/90000 → 90000).
    let timescale = tb_den / gcd(tb_num, tb_den);
    let fmt = v.get("format");
    let start_secs = num_secs(st.get("start_time"))
        .or_else(|| num_secs(fmt.and_then(|f| f.get("start_time"))))
        .unwrap_or(0.0);
    let duration_secs = num_secs(fmt.and_then(|f| f.get("duration"))).unwrap_or(0.0);
    let alpha_mode = st
        .get("tags")
        .and_then(|t| t.get("alpha_mode"))
        .and_then(|a| a.as_str())
        == Some("1");
    let alpha = match (alpha_mode, s("codec_name")) {
        (true, "vp9") => Alpha::Vpx("libvpx-vp9"),
        (true, "vp8") => Alpha::Vpx("libvpx"),
        _ if pix_fmt_has_alpha(s("pix_fmt")) => Alpha::InPixels,
        _ => Alpha::None,
    };
    Some(StreamFacts {
        index: st.get("index")?.as_u64()?,
        timescale,
        start_secs,
        duration_secs,
        full_range: s("color_range") == "pc" || s("pix_fmt").starts_with("yuvj"),
        alpha,
    })
}

fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 { a.max(1) } else { gcd(b, a % b) }
}

/// The `ffmpeg` arguments that convert `source` into `dest`, progress on stdout.
fn conversion_args(
    source: &Path,
    info: &VideoInfo,
    facts: &StreamFacts,
    dest: &Path,
) -> Vec<String> {
    let fps = info.fps();
    let key_interval = if fps > 0.0 {
        (fps * KEY_INTERVAL_SECS).round().max(1.0) as u64
    } else {
        30
    };
    let mut args: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-nostats",
        "-progress",
        "pipe:1",
        "-copyts",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if let Alpha::Vpx(decoder) = facts.alpha {
        args.extend(["-c:v".into(), decoder.into()]);
    }
    args.push("-i".into());
    args.push(source.to_string_lossy().into_owned());
    args.extend(
        [
            "-map",
            &format!("0:{}", facts.index),
            "-an",
            "-sn",
            "-dn",
            "-map_metadata",
            "-1",
            "-c:v",
            "hevc_videotoolbox",
            "-q:v",
            &QUALITY.to_string(),
            "-bf",
            "0",
            "-g",
            &key_interval.to_string(),
            "-tag:v",
            "hvc1",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    let pixels: &[&str] = match facts.alpha {
        Alpha::None if pix_fmt_is_deep(&info.pix_fmt) => {
            &["-pix_fmt", "p010le", "-profile:v", "main10"]
        }
        Alpha::None => &["-pix_fmt", "nv12", "-profile:v", "main"],
        // HEVC with alpha is fed BGRA. The RGB that goes in is ffmpeg's own
        // conversion of the source (its tagged matrix, BT.601 untagged — the
        // same RGB the decode of the original produced); VideoToolbox codes it
        // back to Y'CbCr with BT.709 whatever it is told, and tags nothing
        // ([`ALPHA_MATRIX`], recorded in the file's [`ConvertedFacts`]).
        Alpha::InPixels | Alpha::Vpx(_) => &["-pix_fmt", "bgra", "-alpha_quality", ALPHA_QUALITY],
    };
    args.extend(pixels.iter().map(|s| s.to_string()));
    if facts.full_range && facts.alpha == Alpha::None {
        // Keep a full-range source (MJPEG, many phone and screen captures)
        // full range: no range squeeze on the way in, and the file says so.
        args.extend(["-color_range".into(), "pc".into()]);
    }
    args.extend(
        [
            "-fps_mode",
            "passthrough",
            "-enc_time_base",
            "demux",
            "-video_track_timescale",
            &facts.timescale.to_string(),
            "-f",
            "mov",
            "-y",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    args.push(dest.to_string_lossy().into_owned());
    args
}

/// A cancel handle for [`convert`]: set `cancel` from any thread and the run's
/// `ffmpeg` is killed.
pub struct CancelToken(RunningJob);

impl CancelToken {
    pub fn new() -> Self {
        Self(RunningJob {
            source: PathBuf::new(),
            cancelled: AtomicBool::new(false),
            child: Mutex::new(None),
        })
    }
    pub fn cancel(&self) {
        self.0.cancel();
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::SeqCst)
    }
}

impl Default for CancelToken {
    fn default() -> Self {
        Self::new()
    }
}

/// **Convert `source` into `dest`** (blocking), calling `on_progress` with
/// 0..=1 as it goes. Writes `dest` only once complete; a failure or a cancel
/// leaves nothing behind.
pub fn convert(
    source: &Path,
    info: &VideoInfo,
    dest: &Path,
    cancel: &CancelToken,
    on_progress: impl FnMut(f64),
) -> Result<()> {
    convert_with(source, info, dest, &cancel.0, on_progress)
}

fn convert_with(
    source: &Path,
    info: &VideoInfo,
    dest: &Path,
    job: &RunningJob,
    mut on_progress: impl FnMut(f64),
) -> Result<()> {
    let name = source.display().to_string();
    let facts = stream_facts(source)?;
    let partial = partial_path(dest);
    let args = conversion_args(source, info, &facts, &partial);
    let mut cmd = crate::ffmpeg_locate::ffmpeg()?;
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .with_context(|| format!("starting ffmpeg to convert {name}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("ffmpeg's progress pipe is unavailable"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("ffmpeg's error pipe is unavailable"))?;
    // Read stderr on its own thread so a chatty failure cannot fill the pipe
    // and stall the progress read.
    let err_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    {
        let mut held = job.child.lock().unwrap_or_else(|e| e.into_inner());
        if job.cancelled.load(Ordering::SeqCst) {
            let _ = child.kill();
        }
        *held = Some(child);
    }
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if let Some(us) = line.strip_prefix("out_time_us=")
            && let Ok(us) = us.trim().parse::<f64>()
            && facts.duration_secs > 0.0
        {
            let done = (us / 1e6 - facts.start_secs) / facts.duration_secs;
            on_progress(done.clamp(0.0, 1.0));
        }
    }
    let status = {
        let mut held = job.child.lock().unwrap_or_else(|e| e.into_inner());
        let status = match held.as_mut() {
            Some(c) => c.wait().context("waiting for ffmpeg")?,
            None => return Err(anyhow!("the conversion's ffmpeg vanished")),
        };
        *held = None;
        status
    };
    let stderr = err_reader.join().unwrap_or_default();
    if job.cancelled.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&partial);
        return Err(anyhow!("the conversion of {name} was cancelled"));
    }
    if !status.success() {
        let _ = std::fs::remove_file(&partial);
        let tail: String = stderr
            .lines()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("; ");
        return Err(anyhow!(
            "converting {name} to optimized media failed on the hardware HEVC encoder \
             (hevc_videotoolbox): {}",
            if tail.is_empty() {
                format!("ffmpeg exited with {status}")
            } else {
                tail
            }
        ));
    }
    // The decode facts first, then the file: a `.mov` in the folder always
    // has its facts beside it.
    let converted = match crate::video::probe(&partial) {
        Ok(p) => p,
        Err(e) => {
            let _ = std::fs::remove_file(&partial);
            return Err(e.context(format!("reading {name}'s converted file back")));
        }
    };
    let decode_facts = ConvertedFacts {
        pix_fmt: converted.pix_fmt,
        color_space: match facts.alpha {
            Alpha::None => converted.color_space,
            Alpha::InPixels | Alpha::Vpx(_) => ALPHA_MATRIX.to_string(),
        },
    };
    // The file exists to be read by the media engine, so the media engine reads
    // it before it counts: a file it cannot open (an `ffmpeg` that writes
    // HEVC-with-alpha AVFoundation refuses — Homebrew's 7.1 does, the bundled
    // 9.0 does not) is an error naming the source now, not a black clip later.
    let mut decode_info = info.clone();
    decode_info.pix_fmt.clone_from(&decode_facts.pix_fmt);
    decode_info
        .color_space
        .clone_from(&decode_facts.color_space);
    let readable = crate::vt_decode::Reader::open(&partial, &decode_info, 0)
        .and_then(|mut r| r.next_frame().map(|_| ()));
    if let Err(e) = readable {
        let _ = std::fs::remove_file(&partial);
        return Err(anyhow!(
            "converting {name} to optimized media wrote a file the media engine cannot read: {e:#}"
        ));
    }
    let facts_file = facts_path(dest);
    std::fs::write(&facts_file, serde_json::to_vec(&decode_facts)?)
        .with_context(|| format!("writing {}", facts_file.display()))?;
    on_progress(1.0);
    std::fs::rename(&partial, dest)
        .with_context(|| format!("moving {name}'s converted file into place"))?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests;
