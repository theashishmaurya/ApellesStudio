//! **In-process VideoToolbox encode of frames the GPU engine wrote, into a
//! video-only movie file (D-452).**
//!
//! What it is: [`SegmentEncoder`], one `VTCompressionSession` on the Mac's
//! media engine (hardware required) feeding one `AVAssetWriter`. The caller
//! takes an IOSurface-backed `CVPixelBuffer` from the session's own pool
//! ([`SegmentEncoder::pixel_buffer`]), has the GPU engine write the finished
//! frame into it (`apelles_compositor::Engine::submit_into`), and hands it back
//! here ([`SegmentEncoder::encode`]). No frame is read back to the CPU.
//!
//! What it does:
//! - **H.264** at VideoToolbox's constant quality, the settings D-446 measured
//!   equal to libx264 CRF 18 through ffmpeg's `h264_videotoolbox -q:v 70`
//!   (quality 0.70, High profile, no B-frames, a key frame every 12 frames),
//!   fed Rec.709 video-range 4:2:0 converted on the GPU.
//! - **ProRes 422 HQ** (`apch`), fed BGRA, which VideoToolbox converts to its
//!   own 4:2:2 10-bit (D-446 measured that input as the correct one).
//! - Tags the stream Rec.709 (primaries, transfer, matrix), so a player
//!   decodes it with the matrix it was encoded with.
//! - Writes the compressed samples unchanged (`AVAssetWriterInput` with no
//!   output settings) into an `.mp4` or `.mov`, frame `n` at `n / fps`.
//!
//! What it does NOT do: audio, joining segments, or loudness. Those stay on
//! ffmpeg as a remux (`-c:v copy`), where it is the right tool: one argv the
//! export compiler builds for the audio mix (D-197) over every segment
//! (`chroma::edit_render`). And it never falls back: a Mac whose media engine
//! cannot start the session gets an error saying so.

use std::collections::VecDeque;
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::ptr::NonNull;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_av_foundation::{
    AVAssetWriter, AVAssetWriterInput, AVAssetWriterStatus, AVFileTypeMPEG4,
    AVFileTypeQuickTimeMovie, AVMediaTypeVideo,
};
use objc2_core_foundation::{CFDictionary, CFRetained, CFString, CFType};
use objc2_core_media::{CMSampleBuffer, CMTime, kCMTimeInvalid};
use objc2_core_video::{CVPixelBuffer, CVPixelBufferPool};
use objc2_foundation::{NSDictionary, NSNumber, NSString, NSURL};
use objc2_video_toolbox::{VTCompressionSession, VTEncodeInfoFlags, VTSessionSetProperty};

use crate::vt_decode::PixelBuffer;

/// What a segment is compressed as.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum VideoCodec {
    /// H.264 at VideoToolbox's constant `quality` (0..1).
    H264 { quality: f32 },
    /// Apple ProRes 422 HQ.
    ProResHq,
}

/// D-446's measured H.264 quality: ffmpeg's `h264_videotoolbox -q:v 70` sets
/// `kVTCompressionPropertyKey_Quality` to 70 / 100, the value whose PSNR,
/// SSIM and VMAF matched libx264 CRF 18.
pub const H264_QUALITY: f32 = 0.70;

/// The key-frame interval ffmpeg's `h264_videotoolbox` used (its default
/// group of pictures, 12 frames), kept so an H.264 export is the same stream
/// shape D-446 measured.
const H264_KEY_FRAME_INTERVAL: i32 = 12;

/// How long `finishWriting` may take before the file is given up on.
const FINISH_TIMEOUT: Duration = Duration::from_secs(120);

/// How long one compressed frame may wait for the writer to accept it.
const APPEND_TIMEOUT: Duration = Duration::from_secs(60);

/// The pixel buffers the engine writes into for `codec`: their CoreVideo
/// format (`420v` or `BGRA`).
pub fn input_pixel_format(codec: VideoCodec) -> u32 {
    match codec {
        VideoCodec::H264 { .. } => {
            objc2_core_video::kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        }
        VideoCodec::ProResHq => objc2_core_video::kCVPixelFormatType_32BGRA,
    }
}

/// Compressed samples the session's callback has produced and not yet
/// handed to the writer, or the error it reported. Boxed and pinned for the
/// session's lifetime: its address is the callback's refcon.
#[derive(Default)]
struct Outbox {
    samples: Mutex<VecDeque<std::result::Result<Sample, String>>>,
}

/// A compressed sample crossing from VideoToolbox's thread.
struct Sample(CFRetained<CMSampleBuffer>);
// SAFETY: a finished CMSampleBuffer is immutable and its retain / release are
// atomic; it is handed over once, from the encoder's thread to ours.
unsafe impl Send for Sample {}

/// VideoToolbox's output callback: queue the sample (or the error).
///
/// # Safety
///
/// `refcon` is the `Outbox` the session was created with, alive for as long
/// as the session is (it is freed only after the session is invalidated).
unsafe extern "C-unwind" fn on_encoded(
    refcon: *mut c_void,
    _frame_refcon: *mut c_void,
    status: i32,
    _flags: VTEncodeInfoFlags,
    sample: *mut CMSampleBuffer,
) {
    // SAFETY: see the function's contract.
    let outbox = unsafe { &*(refcon as *const Outbox) };
    let item = if status != 0 {
        Err(format!(
            "the media engine failed to encode a frame ({status})"
        ))
    } else {
        // SAFETY: VideoToolbox passes a valid sample (or null for a dropped
        // frame); retaining keeps it past the callback.
        match NonNull::new(sample) {
            Some(s) => Ok(Sample(unsafe { CFRetained::retain(s) })),
            None => return,
        }
    };
    outbox
        .samples
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push_back(item);
}

/// One video-only movie file being written.
pub struct SegmentEncoder {
    session: CFRetained<VTCompressionSession>,
    pool: CFRetained<CVPixelBufferPool>,
    writer: Retained<AVAssetWriter>,
    /// Created from the first compressed sample's format description.
    input: Option<Retained<AVAssetWriterInput>>,
    outbox: Box<Outbox>,
    path: PathBuf,
    /// `(num, den)`: frames per second.
    fps: (i64, i32),
    frames: u64,
    finished: bool,
}

// SAFETY: the session, pool, writer and input are only ever used from the one
// thread that owns the encoder at a time (it is moved, never shared); Apple
// documents each as usable from any thread when not used concurrently.
unsafe impl Send for SegmentEncoder {}

impl SegmentEncoder {
    /// Start writing `path` (`.mp4` or `.mov`, from its extension) at
    /// `width` × `height`, `fps_num / fps_den` frames per second.
    pub fn create(
        path: &Path,
        codec: VideoCodec,
        (width, height): (u32, u32),
        (fps_num, fps_den): (u32, u32),
    ) -> Result<Self> {
        if fps_num == 0 || fps_den == 0 || width == 0 || height == 0 {
            return Err(anyhow!("an encoder needs a size and a frame rate"));
        }
        let file_type = match path
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("mov") => unsafe { AVFileTypeQuickTimeMovie },
            _ => unsafe { AVFileTypeMPEG4 },
        }
        .ok_or_else(|| anyhow!("AVFoundation has no file type for {}", path.display()))?;
        // AVAssetWriter refuses to overwrite.
        if path.exists() {
            std::fs::remove_file(path)?;
        }
        let url = NSURL::from_file_path(path)
            .ok_or_else(|| anyhow!("not a file path: {}", path.display()))?;
        // SAFETY: a file URL and a file type constant.
        let writer = unsafe { AVAssetWriter::assetWriterWithURL_fileType_error(&url, file_type) }
            .map_err(|e| {
            anyhow!(
                "cannot write {}: {}",
                path.display(),
                e.localizedDescription()
            )
        })?;

        let (codec_type, spec, attributes) = session_dictionaries(codec, width, height);
        let outbox = Box::<Outbox>::default();
        let mut session: *mut VTCompressionSession = std::ptr::null_mut();
        // SAFETY: valid dictionaries, a callback whose refcon (`outbox`)
        // outlives the session (see `Drop`), and an out-pointer to fill.
        let status = unsafe {
            VTCompressionSession::create(
                None,
                width as i32,
                height as i32,
                codec_type,
                Some(&spec),
                Some(&attributes),
                None,
                Some(on_encoded),
                &*outbox as *const Outbox as *mut c_void,
                NonNull::from(&mut session),
            )
        };
        let session = NonNull::new(session)
            .filter(|_| status == 0)
            .ok_or_else(|| {
                anyhow!(
                    "the Mac's media engine could not start a {} encoder at {width}x{height} \
                 ({status}); hardware encoding is required and there is no software fallback",
                    match codec {
                        VideoCodec::H264 { .. } => "H.264",
                        VideoCodec::ProResHq => "ProRes 422 HQ",
                    }
                )
            })?;
        // SAFETY: VTCompressionSessionCreate returns +1.
        let session = unsafe { CFRetained::from_raw(session) };
        configure(&session, codec, (fps_num, fps_den))?;
        // SAFETY: plain calls on the session just made.
        unsafe { session.prepare_to_encode_frames() };
        let pool = unsafe { session.pixel_buffer_pool() }
            .ok_or_else(|| anyhow!("the encoder has no pixel buffer pool"))?;
        Ok(Self {
            session,
            pool,
            writer,
            input: None,
            outbox,
            path: path.to_path_buf(),
            fps: (i64::from(fps_den), fps_num as i32),
            frames: 0,
            finished: false,
        })
    }

    /// A buffer from the encoder's own pool for the next frame, IOSurface-
    /// backed and Metal-compatible, in [`input_pixel_format`]'s layout.
    pub fn pixel_buffer(&self) -> Result<PixelBuffer> {
        let mut out: *mut CVPixelBuffer = std::ptr::null_mut();
        // SAFETY: a valid pool and an out-pointer CoreVideo fills.
        let status = unsafe {
            CVPixelBufferPool::create_pixel_buffer(None, &self.pool, NonNull::from(&mut out))
        };
        let buffer = NonNull::new(out)
            .filter(|_| status == 0)
            .ok_or_else(|| anyhow!("the encoder's pixel buffer pool is exhausted ({status})"))?;
        // SAFETY: CVPixelBufferPoolCreatePixelBuffer returns +1.
        Ok(PixelBuffer::new(unsafe { CFRetained::from_raw(buffer) }))
    }

    /// Compress `buffer` as the next frame. The GPU must have finished
    /// writing it.
    pub fn encode(&mut self, buffer: &PixelBuffer) -> Result<()> {
        let (den, num) = self.fps;
        let pts = unsafe { CMTime::new(self.frames as i64 * den, num) };
        let duration = unsafe { CMTime::new(den, num) };
        // SAFETY: a buffer from this session's pool, written and no longer
        // touched by the GPU; VideoToolbox retains it as long as it needs.
        let status = unsafe {
            self.session.encode_frame(
                buffer.as_cv(),
                pts,
                duration,
                None,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if status != 0 {
            return Err(anyhow!(
                "the media engine refused frame {} ({status})",
                self.frames
            ));
        }
        self.frames += 1;
        self.drain()
    }

    /// Frames handed to [`Self::encode`] so far.
    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// Flush the encoder and finish the file.
    pub fn finish(mut self) -> Result<PathBuf> {
        // SAFETY: completing every pending frame of this session.
        let status = unsafe { self.session.complete_frames(kCMTimeInvalid) };
        if status != 0 {
            return Err(anyhow!(
                "the media engine could not finish encoding ({status})"
            ));
        }
        self.drain()?;
        let input = self
            .input
            .as_ref()
            .ok_or_else(|| anyhow!("no frame was encoded into {}", self.path.display()))?;
        // SAFETY: marking the one input finished, then finishing the writer
        // with a completion block that only signals a channel.
        unsafe { input.markAsFinished() };
        // The file ends where the last frame's interval does, so its duration
        // is exactly `frames / fps` (and the concat of segments adds up).
        let (den, num) = self.fps;
        unsafe {
            self.writer
                .endSessionAtSourceTime(CMTime::new(self.frames as i64 * den, num))
        };
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let done = RcBlock::new(move || {
            let _ = tx.send(());
        });
        unsafe { self.writer.finishWritingWithCompletionHandler(&done) };
        rx.recv_timeout(FINISH_TIMEOUT)
            .map_err(|_| anyhow!("{} did not finish writing", self.path.display()))?;
        self.finished = true;
        // SAFETY: status / error reads on the finished writer.
        match unsafe { self.writer.status() } {
            AVAssetWriterStatus::Completed => Ok(self.path.clone()),
            _ => Err(anyhow!(
                "writing {} failed: {}",
                self.path.display(),
                unsafe { self.writer.error() }
                    .map(|e| e.localizedDescription().to_string())
                    .unwrap_or_else(|| "no reason given".to_string())
            )),
        }
    }

    /// Hand every compressed sample produced so far to the writer.
    fn drain(&mut self) -> Result<()> {
        loop {
            let next = self
                .outbox
                .samples
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .pop_front();
            let Some(item) = next else { return Ok(()) };
            let Sample(sample) = item.map_err(|e| anyhow!(e))?;
            let input = match &self.input {
                Some(i) => i.clone(),
                None => self.start_writing(&sample)?,
            };
            let started = Instant::now();
            // SAFETY: readiness polls and an append on the writer's input.
            // Not real-time: the writer asks for data at its own pace, and
            // waiting here is the backpressure.
            while !unsafe { input.isReadyForMoreMediaData() } {
                if started.elapsed() > APPEND_TIMEOUT {
                    return Err(anyhow!("{} stopped accepting frames", self.path.display()));
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            if !unsafe { input.appendSampleBuffer(&sample) } {
                return Err(anyhow!(
                    "writing a frame to {} failed: {}",
                    self.path.display(),
                    unsafe { self.writer.error() }
                        .map(|e| e.localizedDescription().to_string())
                        .unwrap_or_else(|| "no reason given".to_string())
                ));
            }
        }
    }

    /// The writer's input, made from the first sample's format description
    /// (the encoder's own parameter sets), and the writing session started.
    fn start_writing(&mut self, first: &CMSampleBuffer) -> Result<Retained<AVAssetWriterInput>> {
        let video = unsafe { AVMediaTypeVideo }.ok_or_else(|| anyhow!("no video media type"))?;
        // SAFETY: getters and setup calls on objects this encoder owns.
        unsafe {
            let hint = first.format_description();
            let input =
                AVAssetWriterInput::assetWriterInputWithMediaType_outputSettings_sourceFormatHint(
                    video,
                    None,
                    hint.as_deref(),
                );
            input.setExpectsMediaDataInRealTime(false);
            // The track's clock is the frame rate's own denominator, so frame
            // `n` is exactly at `n · den / num` (AVFoundation's default of 600
            // ticks a second would round 29.97 fps onto a 20-tick grid).
            input.setMediaTimeScale(self.fps.1);
            self.writer.setMovieTimeScale(self.fps.1);
            if !self.writer.canAddInput(&input) {
                return Err(anyhow!(
                    "{} cannot hold this video stream",
                    self.path.display()
                ));
            }
            self.writer.addInput(&input);
            if !self.writer.startWriting() {
                return Err(anyhow!(
                    "cannot start writing {}: {}",
                    self.path.display(),
                    self.writer
                        .error()
                        .map(|e| e.localizedDescription().to_string())
                        .unwrap_or_else(|| "no reason given".to_string())
                ));
            }
            self.writer
                .startSessionAtSourceTime(CMTime::new(0, self.fps.1));
            self.input = Some(input.clone());
            Ok(input)
        }
    }
}

impl Drop for SegmentEncoder {
    fn drop(&mut self) {
        // SAFETY: ending the session before its callback's refcon (`outbox`,
        // dropped after this body) is freed; cancelling an unfinished file.
        unsafe {
            self.session.invalidate();
            if !self.finished && self.input.is_some() {
                self.writer.cancelWriting();
            }
        }
    }
}

/// `(codec type, encoder specification, source buffer attributes)`.
fn session_dictionaries(
    codec: VideoCodec,
    width: u32,
    height: u32,
) -> (u32, CFRetained<CFDictionary>, CFRetained<CFDictionary>) {
    use objc2_core_video as cv;
    let codec_type = match codec {
        VideoCodec::H264 { .. } => objc2_core_media::kCMVideoCodecType_H264,
        VideoCodec::ProResHq => objc2_core_media::kCMVideoCodecType_AppleProRes422HQ,
    };
    let yes = NSNumber::new_bool(true);
    // SAFETY: the key statics are valid for the process's lifetime.
    let spec = dictionary(&[(
        unsafe {
            objc2_video_toolbox::kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder
        },
        &yes,
    )]);
    let format = NSNumber::new_u32(input_pixel_format(codec));
    let w = NSNumber::new_u32(width);
    let h = NSNumber::new_u32(height);
    let iosurface: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::new();
    let attributes = unsafe {
        dictionary(&[
            (cv::kCVPixelBufferPixelFormatTypeKey, &format),
            (cv::kCVPixelBufferWidthKey, &w),
            (cv::kCVPixelBufferHeightKey, &h),
            (cv::kCVPixelBufferIOSurfacePropertiesKey, &iosurface),
            (cv::kCVPixelBufferMetalCompatibilityKey, &yes),
        ])
    };
    (codec_type, spec, attributes)
}

/// A CFDictionary of CFString keys to (toll-free bridged) objects.
fn dictionary(entries: &[(&'static CFString, &AnyObject)]) -> CFRetained<CFDictionary> {
    let keys: Vec<&NSString> = entries.iter().map(|(k, _)| ns_string(k)).collect();
    let values: Vec<&AnyObject> = entries.iter().map(|(_, v)| *v).collect();
    let dict = NSDictionary::from_slices(&keys, &values);
    // SAFETY: NSDictionary is toll-free bridged to CFDictionary; the retain is
    // transferred to the CF wrapper.
    unsafe {
        let raw = Retained::into_raw(dict) as *mut CFDictionary;
        CFRetained::from_raw(NonNull::new_unchecked(raw))
    }
}

fn ns_string(s: &'static CFString) -> &'static NSString {
    // SAFETY: CFString is toll-free bridged to NSString.
    unsafe { &*(s as *const CFString as *const NSString) }
}

fn cf<T: objc2::Message>(object: &T) -> &CFType {
    // SAFETY: every Foundation object passed here (NSNumber, NSString) is
    // toll-free bridged to its CF type, and CFType is the CF root.
    unsafe { &*(object as *const T as *const CFType) }
}

/// The session's properties: rate control, stream shape and colour tags.
fn configure(session: &VTCompressionSession, codec: VideoCodec, fps: (u32, u32)) -> Result<()> {
    use objc2_core_video as cv;
    use objc2_video_toolbox as vt;
    let set = |key: &CFString, value: &CFType| -> Result<()> {
        // SAFETY: a valid session, a property key VideoToolbox defines and a
        // value of the type that key takes.
        let status = unsafe { VTSessionSetProperty(session, key, Some(value)) };
        if status == 0 {
            Ok(())
        } else {
            Err(anyhow!("the encoder refused {key} ({status})"))
        }
    };
    // SAFETY (all statics below): valid for the process's lifetime.
    unsafe {
        let no = NSNumber::new_bool(false);
        let rate = NSNumber::new_f64(f64::from(fps.0) / f64::from(fps.1));
        set(vt::kVTCompressionPropertyKey_RealTime, cf(&*no))?;
        set(vt::kVTCompressionPropertyKey_ExpectedFrameRate, cf(&*rate))?;
        if let VideoCodec::H264 { quality } = codec {
            let q = NSNumber::new_f32(quality);
            let gop = NSNumber::new_i32(H264_KEY_FRAME_INTERVAL);
            set(vt::kVTCompressionPropertyKey_Quality, cf(&*q))?;
            set(
                vt::kVTCompressionPropertyKey_ProfileLevel,
                cf(vt::kVTProfileLevel_H264_High_AutoLevel),
            )?;
            set(vt::kVTCompressionPropertyKey_AllowFrameReordering, cf(&*no))?;
            set(vt::kVTCompressionPropertyKey_MaxKeyFrameInterval, cf(&*gop))?;
        }
        set(
            vt::kVTCompressionPropertyKey_ColorPrimaries,
            cf(cv::kCVImageBufferColorPrimaries_ITU_R_709_2),
        )?;
        set(
            vt::kVTCompressionPropertyKey_TransferFunction,
            cf(cv::kCVImageBufferTransferFunction_ITU_R_709_2),
        )?;
        set(
            vt::kVTCompressionPropertyKey_YCbCrMatrix,
            cf(cv::kCVImageBufferYCbCrMatrix_ITU_R_709_2),
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
