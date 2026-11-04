//! **In-process VideoToolbox decode, frame `N` straight into an IOSurface
//! (D-452).**
//!
//! What it is: [`Reader`], one sequential decode of one source from nominal
//! frame `N` onwards, through AVFoundation's `AVAssetReader` (which demuxes the
//! QuickTime family and decodes on VideoToolbox, the Mac's media engine), each
//! frame an IOSurface-backed, Metal-compatible `CVPixelBuffer` in the source's
//! own two-plane YCbCr layout. The GPU engine (`apelles-compositor`) imports
//! those buffers as textures and converts them to RGB itself, so no decoded
//! pixel crosses the CPU.
//!
//! What it does:
//! - **Conforms the stream to the nominal frame grid (D-228)** exactly as
//!   [`crate::conform`]'s `fps=…:round=up` does for ffmpeg: grid slot `k` is
//!   the last decoded frame whose presentation time is `<= k / fps` (and the
//!   first frame for slots before it), held for as many slots as it covers, a
//!   frame the grid has no slot for dropped. Compared in exact integer
//!   arithmetic on the `CMTime`s, so no float can move a frame across a slot.
//! - **Decodes ahead on its own thread** into a small bounded queue
//!   ([`READ_AHEAD`]): opening a reader starts the seek at once, which is what
//!   lets `decode_pipe`'s cut-boundary prefetch (D-324) prime a standby that
//!   seeks while the outgoing clip still plays, and a running reader decodes
//!   frame `N + 1` while the engine draws frame `N`.
//! - **Reports the layout the engine converts with** ([`YcbcrLayout`]): the
//!   matrix ffmpeg itself would use for this source (its probed
//!   `color_space`, BT.601 when untagged, as swscale defaults), the range, the
//!   chroma subsampling and the bit depth.
//!
//! What it does NOT do: convert colour, scale, or read audio; read containers
//! AVFoundation cannot open (Matroska / WebM, AVI, MPEG-TS, MXF: see
//! [`is_engine_container`] and `decode_pipe`, which still serves those through
//! ffmpeg pending the owner's decision); or fall back to anything. A source the
//! media engine cannot decode is an error naming the file.
//!
//! **Why `AVAssetReader` and not a bare `VTDecompressionSession`.** A
//! decompression session needs a demuxer to feed it compressed samples and a
//! presentation-order reorder buffer behind it; `AVAssetReader` is Apple's own
//! demuxer and decoder pipeline over the same VideoToolbox decoders, hands
//! frames out in presentation order, honours edit lists, and starts a read at a
//! time by decoding forward from the sync sample before it. Writing those
//! three things ourselves would be a second, worse copy of it.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use anyhow::{Context, Result, anyhow};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_av_foundation::{
    AVAssetReader, AVAssetReaderStatus, AVAssetReaderTrackOutput, AVAssetTrack, AVMediaTypeVideo,
    AVURLAsset,
};
use objc2_core_foundation::{CFBoolean, CFString};
use objc2_core_media::{
    CMFormatDescription, CMTime, CMTimeFlags, CMTimeRange,
    kCMFormatDescriptionExtension_FullRangeVideo, kCMTimePositiveInfinity,
};
use objc2_core_video::{
    kCVPixelBufferIOSurfacePropertiesKey, kCVPixelBufferMetalCompatibilityKey,
    kCVPixelBufferPixelFormatTypeKey,
};
use objc2_foundation::{NSArray, NSDictionary, NSError, NSNumber, NSString, NSURL};
use once_cell::sync::Lazy;

use crate::video::VideoInfo;
pub use apelles_types::video_frame::{PixelBuffer, VideoFrame, YcbcrLayout, YcbcrMatrix};

/// Frames a reader decodes ahead of the one asked for. Each is one decoded
/// frame in an IOSurface (12 MB at 4K 4:2:0 8-bit), so this times the open
/// readers bounds the memory the decode side can hold. Two is enough to keep
/// the media engine busy while the GPU engine draws: decode and draw overlap
/// by one frame either way.
pub const READ_AHEAD: usize = 2;

/// The container extensions AVFoundation opens: the QuickTime file family.
/// Everything else the importer accepts (`video::VIDEO_EXTENSIONS`) is
/// decoded by `decode_pipe`'s ffmpeg pipe until the owner decides between
/// refusing those sources and conforming them on import (D-452).
const ENGINE_CONTAINERS: &[&str] = &["mov", "mp4", "m4v"];

/// Whether `path` is decoded by the media engine (this module) rather than
/// by ffmpeg.
pub fn is_engine_container(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| ENGINE_CONTAINERS.iter().any(|c| c.eq_ignore_ascii_case(e)))
}

/// The biplanar CoreVideo pixel format holding exactly `layout`.
pub fn pixel_format(layout: &YcbcrLayout) -> u32 {
    use objc2_core_video as cv;
    match (layout.chroma_shift, layout.bits, layout.full_range) {
        ((1, 1), 8, false) => cv::kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        ((1, 1), 8, true) => cv::kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
        ((1, 1), _, false) => cv::kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange,
        ((1, 1), _, true) => cv::kCVPixelFormatType_420YpCbCr10BiPlanarFullRange,
        ((1, 0), 8, false) => cv::kCVPixelFormatType_422YpCbCr8BiPlanarVideoRange,
        ((1, 0), 8, true) => cv::kCVPixelFormatType_422YpCbCr8BiPlanarFullRange,
        ((1, 0), _, false) => cv::kCVPixelFormatType_422YpCbCr10BiPlanarVideoRange,
        ((1, 0), _, true) => cv::kCVPixelFormatType_422YpCbCr10BiPlanarFullRange,
        (_, 8, false) => cv::kCVPixelFormatType_444YpCbCr8BiPlanarVideoRange,
        (_, 8, true) => cv::kCVPixelFormatType_444YpCbCr8BiPlanarFullRange,
        (_, _, false) => cv::kCVPixelFormatType_444YpCbCr10BiPlanarVideoRange,
        (_, _, true) => cv::kCVPixelFormatType_444YpCbCr10BiPlanarFullRange,
    }
}

/// Plane `index`'s bytes, rows packed (no row padding), with its row length in
/// bytes and its height. Test-only: a CPU copy is exactly what the production
/// path never makes.
#[cfg(any(test, feature = "test-support"))]
pub fn read_plane(buffer: &PixelBuffer, index: usize) -> (Vec<u8>, usize, usize) {
    use objc2_core_video as cv;
    let pb = buffer.as_cv();
    let lock = cv::CVPixelBufferLockFlags::ReadOnly;
    let eight_bit = matches!(
        cv::CVPixelBufferGetPixelFormatType(pb),
        cv::kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
            | cv::kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
            | cv::kCVPixelFormatType_422YpCbCr8BiPlanarVideoRange
            | cv::kCVPixelFormatType_422YpCbCr8BiPlanarFullRange
            | cv::kCVPixelFormatType_444YpCbCr8BiPlanarVideoRange
            | cv::kCVPixelFormatType_444YpCbCr8BiPlanarFullRange
    );
    let bytes_per_px = if index == 0 { 1 } else { 2 } * if eight_bit { 1 } else { 2 };
    // SAFETY: lock / read / unlock on a valid pixel buffer; every copied row is
    // within the plane's height × bytes-per-row.
    unsafe {
        cv::CVPixelBufferLockBaseAddress(pb, lock);
        // A one-plane format (BGRA, an encoder's ProRes input) has no planes.
        let planar = cv::CVPixelBufferGetPlaneCount(pb) > 0;
        let (base, stride, h, row) = if planar {
            (
                cv::CVPixelBufferGetBaseAddressOfPlane(pb, index) as *const u8,
                cv::CVPixelBufferGetBytesPerRowOfPlane(pb, index),
                cv::CVPixelBufferGetHeightOfPlane(pb, index),
                cv::CVPixelBufferGetWidthOfPlane(pb, index) * bytes_per_px,
            )
        } else {
            (
                cv::CVPixelBufferGetBaseAddress(pb) as *const u8,
                cv::CVPixelBufferGetBytesPerRow(pb),
                cv::CVPixelBufferGetHeight(pb),
                cv::CVPixelBufferGetWidth(pb) * 4,
            )
        };
        let mut out = Vec::with_capacity(row * h);
        for y in 0..h {
            out.extend_from_slice(std::slice::from_raw_parts(base.add(y * stride), row));
        }
        cv::CVPixelBufferUnlockBaseAddress(pb, lock);
        (out, row, h)
    }
}

/// Sources already reported as decoded without a hardware decoder, so the
/// warning is said once per source rather than per seek.
static SOFTWARE_DECODE_REPORTED: Lazy<Mutex<std::collections::HashSet<std::path::PathBuf>>> =
    Lazy::new(|| Mutex::new(std::collections::HashSet::new()));

/// One sequential decode of one source, from a nominal frame onwards.
pub struct Reader {
    rx: Receiver<Result<VideoFrame, String>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    /// The nominal index [`Self::next_frame`] returns next.
    next_index: u64,
}

impl Reader {
    /// Start decoding `path` at nominal frame `start`. Returns at once; the
    /// seek and the first decodes run on the reader's own thread.
    pub fn open(path: &Path, info: &VideoInfo, start: u64) -> Result<Self> {
        if info.fps_num == 0 || info.fps_den == 0 {
            return Err(anyhow!(
                "{} has no nominal frame rate to decode against",
                path.display()
            ));
        }
        let (tx, rx) = std::sync::mpsc::sync_channel(READ_AHEAD);
        let stop = Arc::new(AtomicBool::new(false));
        let job = ReadJob {
            path: path.to_path_buf(),
            pix_fmt: info.pix_fmt.clone(),
            color_space: info.color_space.clone(),
            fps: (u64::from(info.fps_num), u64::from(info.fps_den)),
            start,
            stop: stop.clone(),
        };
        let thread = std::thread::Builder::new()
            .name("apelles-vt-decode".to_string())
            .spawn(move || job.run(&tx))
            .context("starting a decode thread")?;
        Ok(Self {
            rx,
            stop,
            thread: Some(thread),
            next_index: start,
        })
    }

    /// The nominal index the next [`Self::next_frame`] returns.
    pub fn next_index(&self) -> u64 {
        self.next_index
    }

    /// The next frame on the grid, waiting for it if it is still decoding.
    pub fn next_frame(&mut self) -> Result<VideoFrame> {
        match self.rx.recv() {
            Ok(Ok(frame)) => {
                self.next_index = frame.index + 1;
                Ok(frame)
            }
            Ok(Err(e)) => Err(anyhow!(e)),
            Err(_) => Err(anyhow!("the decode ended before frame {}", self.next_index)),
        }
    }
}

impl Drop for Reader {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        // Unblock a thread waiting to hand over a frame, then wait for it so
        // its AVAssetReader is cancelled before the file can be replaced.
        while self.rx.try_recv().is_ok() {}
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

struct ReadJob {
    path: std::path::PathBuf,
    pix_fmt: String,
    color_space: String,
    /// `(num, den)`: frames per second as a rational.
    fps: (u64, u64),
    start: u64,
    stop: Arc<AtomicBool>,
}

/// A decoded frame and its presentation time, before the conform.
struct Decoded {
    pts: CMTime,
    buffer: PixelBuffer,
}

impl ReadJob {
    fn run(self, tx: &SyncSender<Result<VideoFrame, String>>) {
        if let Err(e) = self.decode(tx) {
            let _ = tx.send(Err(format!("{}: {e:#}", self.path.display())));
        }
    }

    /// Hand `frame` to the consumer; `false` when it has gone (the reader was
    /// dropped), which ends the decode.
    fn deliver(&self, tx: &SyncSender<Result<VideoFrame, String>>, frame: VideoFrame) -> bool {
        let mut item = Ok(frame);
        loop {
            if self.stop.load(Ordering::Relaxed) {
                return false;
            }
            match tx.try_send(item) {
                Ok(()) => return true,
                Err(TrySendError::Disconnected(_)) => return false,
                Err(TrySendError::Full(back)) => {
                    item = back;
                    // The consumer is a frame behind: the queue is the
                    // read-ahead bound, so waiting here IS the backpressure.
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
            }
        }
    }

    fn decode(&self, tx: &SyncSender<Result<VideoFrame, String>>) -> Result<()> {
        let url = NSURL::from_file_path(&self.path)
            .ok_or_else(|| anyhow!("not a file path the media engine can open"))?;
        // SAFETY: a plain file URL and no options.
        let asset = unsafe { AVURLAsset::URLAssetWithURL_options(&url, None) };
        let track = load_video_track(&asset)?;
        let (codec, full_range) = track_format(&track)?;
        let layout = YcbcrLayout::for_source(&self.pix_fmt, &self.color_space, full_range);
        self.report_decoder(codec);
        // Where the stream ends: the track's last sample's presentation
        // interval ends here, which is where ffmpeg's `fps` filter stops
        // emitting grid slots. (Decoded sample buffers carry no duration, so
        // the last frame's own end is not available from the samples.)
        // SAFETY: a property read on a loaded track.
        let range = unsafe { track.timeRange() };
        let stream_end = add(range.start, range.duration);
        let empty = empty_edits(&track);

        // SAFETY: `asset` is a live AVAsset; the error is surfaced, not ignored.
        let reader = unsafe { AVAssetReader::assetReaderWithAsset_error(&asset) }
            .map_err(|e| anyhow!("the media engine cannot read this file: {}", describe(&e)))?;
        let settings = output_settings(pixel_format(&layout));
        // SAFETY: `track` belongs to `asset`, and `settings` holds only the
        // uncompressed-video keys AVVideoSettings.h allows for a track output.
        let output = unsafe {
            AVAssetReaderTrackOutput::assetReaderTrackOutputWithTrack_outputSettings(
                &track,
                Some(&settings),
            )
        };
        // SAFETY: plain property set / add on objects this thread owns.
        unsafe {
            output.setAlwaysCopiesSampleData(false);
            if !reader.canAddOutput(&output) {
                return Err(anyhow!(
                    "the media engine cannot decode this video track to {:?}",
                    layout
                ));
            }
            reader.addOutput(&output);
            reader.setTimeRange(CMTimeRange::new(self.seek_time(), kCMTimePositiveInfinity));
            if !reader.startReading() {
                return Err(anyhow!(
                    "the media engine could not start decoding: {}",
                    reader
                        .error()
                        .map(|e| describe(&e))
                        .unwrap_or_else(|| "no reason given".to_string())
                ));
            }
        }

        let next = || -> Result<Option<Decoded>> {
            loop {
                // SAFETY: the output is attached to a reader that is reading.
                let Some(sample) = (unsafe { output.copyNextSampleBuffer() }) else {
                    // SAFETY: status / error reads on the live reader.
                    return match unsafe { reader.status() } {
                        AVAssetReaderStatus::Completed => Ok(None),
                        _ => Err(anyhow!(
                            "the media engine stopped decoding: {}",
                            unsafe { reader.error() }
                                .map(|e| describe(&e))
                                .unwrap_or_else(|| "no reason given".to_string())
                        )),
                    };
                };
                // SAFETY: getters on a valid sample buffer.
                let (pts, image) =
                    unsafe { (sample.presentation_time_stamp(), sample.image_buffer()) };
                // A sample with no picture (an empty edit, a marker) has no
                // frame for the grid.
                let Some(image) = image else { continue };
                if !pts.flags.contains(CMTimeFlags::Valid) {
                    continue;
                }
                // A frame AVAssetReader synthesizes for an empty edit is not a
                // source frame (B-384).
                if empty.iter().any(|r| within(pts, r)) {
                    continue;
                }
                return Ok(Some(Decoded {
                    pts,
                    buffer: PixelBuffer::new(image),
                }));
            }
        };

        // The conform (D-228), `fps=N/D:start_time=0:round=up` then
        // `select=gte(n, start)`: slot `k` shows the last frame presented at
        // or before `k / fps`; a slot before the first frame shows the first.
        let mut current: Option<Decoded> = None;
        let mut pending: Option<Decoded> = next()?;
        let mut slot = self.start;
        loop {
            if self.stop.load(Ordering::Relaxed) {
                break;
            }
            while let Some(p) = pending.as_ref() {
                if self.at_or_before(p.pts, slot) {
                    current = pending.take();
                    pending = next()?;
                } else {
                    break;
                }
            }
            let shown = match (&current, &pending) {
                (Some(c), _) => c,
                (None, Some(first)) => first,
                (None, None) => {
                    return Err(anyhow!("the video track has no frames to decode"));
                }
            };
            if pending.is_none() && !self.before(slot, stream_end) {
                // Past the last frame's presentation interval: the end of the
                // stream, as ffmpeg's `fps` filter ends it.
                break;
            }
            let frame = VideoFrame {
                buffer: shown.buffer.clone(),
                layout,
                index: slot,
            };
            if !self.deliver(tx, frame) {
                break;
            }
            slot += 1;
        }
        // SAFETY: cancelling a reader this thread started.
        unsafe { reader.cancelReading() };
        Ok(())
    }

    /// Half a frame before the first slot, the time `conform::from_frame`
    /// seeks to: the reader starts at the sync sample before it and hands out
    /// every frame whose presentation interval reaches past it, so the frame
    /// on screen at the first slot is always among the first delivered.
    fn seek_time(&self) -> CMTime {
        let (num, den) = self.fps;
        // (start - 0.5) / fps = (2·start - 1)·den / (2·num); a timescale of
        // 2·num keeps it exact.
        let value = (2 * self.start).saturating_sub(1) * den;
        let timescale = i32::try_from(2 * num).unwrap_or(i32::MAX);
        let value = i64::try_from(value).unwrap_or(i64::MAX);
        // SAFETY: CMTimeMake with a positive timescale.
        unsafe { CMTime::new(if self.start == 0 { 0 } else { value }, timescale) }
    }

    /// `t <= slot / fps`, exactly.
    fn at_or_before(&self, t: CMTime, slot: u64) -> bool {
        let (num, den) = self.fps;
        // t.value / t.timescale <= slot·den / num
        i128::from(t.value) * i128::from(num)
            <= i128::from(slot) * i128::from(den) * i128::from(t.timescale)
    }

    /// `slot / fps < t`, exactly.
    fn before(&self, slot: u64, t: CMTime) -> bool {
        !self.at_or_before(t, slot)
    }

    /// Say once per source when no hardware decoder exists for its codec, so
    /// a slow decode is never silent (D-452: VideoToolbox's own software
    /// decoder runs it; there is no ffmpeg fallback).
    fn report_decoder(&self, codec: u32) {
        // SAFETY: a pure capability query.
        let hardware = unsafe { objc2_video_toolbox::VTIsHardwareDecodeSupported(codec) };
        if hardware {
            return;
        }
        let mut seen = SOFTWARE_DECODE_REPORTED
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if seen.insert(self.path.clone()) {
            log::warn!(
                "media engine: {} ({}) has no hardware decoder on this Mac; VideoToolbox decodes \
                 it in software",
                self.path.display(),
                fourcc(codec)
            );
        }
    }
}

/// `a + b` for two times in possibly different timescales, exactly (in the
/// product timescale when they differ).
fn add(a: CMTime, b: CMTime) -> CMTime {
    if a.timescale == b.timescale {
        return CMTime {
            value: a.value + b.value,
            ..a
        };
    }
    let ts = i64::from(a.timescale) * i64::from(b.timescale);
    let value = a.value * i64::from(b.timescale) + b.value * i64::from(a.timescale);
    match i32::try_from(ts) {
        Ok(ts) => CMTime {
            value,
            timescale: ts,
            ..a
        },
        // Out of range for a CMTime timescale: fall back to a's timescale,
        // rounding b into it (both are tick-exact in practice).
        Err(_) => CMTime {
            value: a.value + b.value * i64::from(a.timescale) / i64::from(b.timescale),
            ..a
        },
    }
}

fn fourcc(code: u32) -> String {
    code.to_be_bytes()
        .iter()
        .map(|&b| if b.is_ascii_graphic() { b as char } else { '?' })
        .collect()
}

fn describe(e: &NSError) -> String {
    e.localizedDescription().to_string()
}

/// The asset's first video track, loaded through the asynchronous API.
fn load_video_track(asset: &AVURLAsset) -> Result<Retained<AVAssetTrack>> {
    /// The loaded tracks crossing from AVFoundation's queue to this thread.
    struct Loaded(std::result::Result<Retained<NSArray<AVAssetTrack>>, String>);
    // SAFETY: an immutable NSArray of tracks, handed over once and read on
    // one thread; AVAssetTrack is documented as safe to use from any thread.
    unsafe impl Send for Loaded {}

    let (tx, rx) = std::sync::mpsc::channel::<Loaded>();
    let handler = RcBlock::new(
        move |tracks: *mut NSArray<AVAssetTrack>, error: *mut NSError| {
            // SAFETY: AVFoundation passes either a valid array or a valid error,
            // both autoreleased; retaining them keeps them past the block.
            let loaded = match unsafe { Retained::retain(tracks) } {
                Some(t) => Ok(t),
                None => Err(unsafe { Retained::retain(error) }
                    .map(|e| describe(&e))
                    .unwrap_or_else(|| "the tracks could not be loaded".to_string())),
            };
            let _ = tx.send(Loaded(loaded));
        },
    );
    let video = unsafe { AVMediaTypeVideo }
        .ok_or_else(|| anyhow!("AVFoundation has no video media type"))?;
    // SAFETY: the block only sends on a channel, which is thread-safe.
    unsafe { asset.loadTracksWithMediaType_completionHandler(video, &handler) };
    let tracks = rx
        .recv_timeout(std::time::Duration::from_secs(30))
        .map_err(|_| anyhow!("the media engine did not open the file within 30 s"))?
        .0
        .map_err(|e| anyhow!("the media engine cannot open this file: {e}"))?;
    tracks
        .firstObject()
        .ok_or_else(|| anyhow!("the file has no video track the media engine can read"))
}

/// The track-time ranges of the track's empty edits: where the file presents no
/// media (a delayed start, a gap). AVAssetReader hands out a synthesized black
/// frame for one; ffmpeg's demuxer presents nothing there, so its conform holds
/// the neighbouring real frame (the first one, for a leading empty edit). The
/// decoder drops frames presented inside these ranges so the grid sees what
/// ffmpeg's does (B-384).
fn empty_edits(track: &AVAssetTrack) -> Vec<CMTimeRange> {
    // SAFETY: property reads on a loaded track and its segments.
    unsafe {
        track
            .segments()
            .iter()
            .filter(|segment| segment.isEmpty())
            .map(|segment| segment.timeMapping().target)
            .collect()
    }
}

/// `a` compared with `b`, exactly, across timescales.
fn compare(a: CMTime, b: CMTime) -> std::cmp::Ordering {
    (i128::from(a.value) * i128::from(b.timescale))
        .cmp(&(i128::from(b.value) * i128::from(a.timescale)))
}

/// Whether `t` falls in `[range.start, range.start + range.duration)`.
fn within(t: CMTime, range: &CMTimeRange) -> bool {
    compare(t, range.start).is_ge() && compare(t, add(range.start, range.duration)).is_lt()
}

/// The track's codec (`CMVideoCodecType`) and whether it declares full-range
/// video.
fn track_format(track: &AVAssetTrack) -> Result<(u32, bool)> {
    // SAFETY: a property read on a loaded track.
    let descriptions = unsafe { track.formatDescriptions() };
    let first = descriptions
        .firstObject()
        .ok_or_else(|| anyhow!("the video track has no format description"))?;
    // SAFETY: AVAssetTrack.formatDescriptions is documented as an array of
    // CMFormatDescriptionRef; the object is that CF type, toll-free carried in
    // an NSArray, and outlives this borrow through `first`.
    let desc: &CMFormatDescription =
        unsafe { &*(Retained::as_ptr(&first) as *const CMFormatDescription) };
    // SAFETY: plain getters on a valid format description.
    let codec = unsafe { desc.media_sub_type() };
    let full_range = unsafe { desc.extension(kCMFormatDescriptionExtension_FullRangeVideo) }
        .and_then(|v| v.downcast_ref::<CFBoolean>().map(CFBoolean::as_bool))
        .unwrap_or(false);
    Ok((codec, full_range))
}

/// Track-output settings: this pixel format, in an IOSurface a Metal texture
/// can wrap.
fn output_settings(pixel_format: u32) -> Retained<NSDictionary<NSString, AnyObject>> {
    let key = |k: &'static CFString| -> &'static NSString {
        // SAFETY: CFString is toll-free bridged to NSString.
        unsafe { &*(k as *const CFString as *const NSString) }
    };
    let format = NSNumber::new_u32(pixel_format);
    let yes = NSNumber::new_bool(true);
    let iosurface: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::new();
    // SAFETY: the key statics are valid for the process's lifetime.
    let keys = unsafe {
        [
            key(kCVPixelBufferPixelFormatTypeKey),
            key(kCVPixelBufferIOSurfacePropertiesKey),
            key(kCVPixelBufferMetalCompatibilityKey),
        ]
    };
    let values: [&AnyObject; 3] = [&format, &iosurface, &yes];
    NSDictionary::from_slices(&keys, &values)
}

#[cfg(test)]
mod tests;
