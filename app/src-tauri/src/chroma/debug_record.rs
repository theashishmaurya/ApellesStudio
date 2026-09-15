//! debug_record.rs — record the running app's own window to a real video
//! file (D-330, `docs/notes/debug-tooling.md` piece 6).
//!
//! What it is: the moving-picture half of D-210's `debug_screenshot`. It
//!   captures the app's WKWebView repeatedly for N seconds and pipes the
//!   frames straight into `ffmpeg`, producing a playable H.264 file. Paired
//!   with `debug_set_fps_overlay` (the frontend half, `@apelles/debug`'s
//!   `fpsOverlay.ts`), the resulting footage carries the app's own measured
//!   frame rate burned into the picture — which is what makes a before/after
//!   recording of a performance fix evidence rather than an impression.
//!
//! Why it extends the screenshot mechanism rather than capturing the screen:
//!   exactly the same reason D-210 exists. macOS gates every system-level
//!   capture API behind the Screen Recording TCC permission, which an agent
//!   process here does not have and cannot grant itself.
//!   `-[WKWebView takeSnapshotWithConfiguration:]` is not screen capture — it
//!   is a webview rendering its own content in the process that owns it — so
//!   it needs no permission, and repeating it is the only permission-free
//!   route to moving pictures of this window.
//!
//! **Real-time accuracy, and how a shortfall is reported rather than
//!   hidden.** The recorder runs on a fixed cadence: frame `i` is due at
//!   `start + i / fps`. If a capture overruns its slot, the recorder does NOT
//!   silently fall behind and then encode at a rate that makes the video play
//!   faster than reality — it emits the previous frame again to fill the slot
//!   it missed and carries on against the original schedule. So:
//!     * the output always has exactly `fps × duration` frames, and its wall
//!       clock always matches the real elapsed time (a 10 s recording is 10 s
//!       of video, and an event 3 s in is 3 s in);
//!     * a capture that could not keep up shows as a briefly frozen frame,
//!       which is honest, and is COUNTED and reported as
//!       `framesDuplicated` rather than left for the viewer to guess at.
//!   `capturedFps` in the result is the rate genuinely achieved. When it is
//!   well below the requested `fps`, the recording is padded and the result
//!   says so.
//!
//! **This measures the app, so it must not BE what the app is busy doing.**
//!   Every capture costs the main thread real time, and the app being
//!   recorded is the one paying it. Two things keep that honest: the capture
//!   is raw pixels with no image codec anywhere in the path (`CapturedRaw` —
//!   PNG encoding a frame costs far more than WebKit spends drawing it), and
//!   `width` asks WebKit for a smaller rasterisation rather than downscaling
//!   a full-size one afterwards. The result reports `captureMsMedian` /
//!   `captureMsP95` so the observer cost is a number in the output, not an
//!   assumption. Read them against `debug_frame_timing` taken over the same
//!   run before trusting a recorded number.
//!
//! What it does NOT do: capture anything outside the webview. Native window
//!   chrome, menus, file dialogs and other apps are all invisible to it, for
//!   the same reason as `debug_screenshot`. One consequence is specific
//!   enough to call out: the **Colorist tab's picture is a native wgpu
//!   surface behind the webview** (B-151) and does NOT appear in a recording.
//!   `debug_screenshot` composites that surface in on demand; doing it per
//!   frame would mean a full decode/re-encode per frame and would wreck the
//!   very timing being recorded. This tool is for the Edit tab's playback,
//!   which is webview content throughout. It also records no audio.
//!
//! Platform: macOS only, deliberately — same reasoning and same explicit
//!   "not supported here" error as `debug_capture`.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use tauri::Runtime;

use super::debug_capture;
use super::ffmpeg_run::{FfmpegRunRequest, FfmpegStdinSink};

/// Default capture cadence. Chosen against what this app's preview actually
/// achieves (D-290/D-325 measured 4–25 fps for real playback): a recorder
/// faster than the thing it records buys nothing but main-thread contention,
/// and 15 fps is comfortably above the top of that range while staying cheap
/// enough not to distort it.
pub const DEFAULT_RECORD_FPS: u32 = 15;

/// Bounds on the requested cadence. The ceiling is not a round number chosen
/// for looks: above roughly 60 the slot period drops below the cost of a
/// single snapshot on any real window, so every frame would be a duplicate.
pub const MIN_RECORD_FPS: u32 = 1;
pub const MAX_RECORD_FPS: u32 = 60;

/// Bounds on the requested duration. The ceiling exists because this call
/// blocks the control server for its whole length (see
/// [`record_window_video`]), so an unbounded duration is a way to wedge the
/// app's entire op surface by typo.
pub const MIN_RECORD_SECS: f64 = 0.1;
pub const MAX_RECORD_SECS: f64 = 120.0;

/// Default output width, in real pixels of the finished video.
///
/// 1280 is a deliberate default rather than "native": on a 2× display the
/// native capture of this window is 2560×1440, i.e. four times the pixels to
/// move per frame, for footage that will be watched in a browser tab or
/// pasted into a review. Measured on the first live run, that difference is
/// the dominant cost of the whole tool — 58.7 ms per capture at native
/// against 15.0 ms at 1280 — which is the difference between a recorder that
/// perturbs what it records and one that does not.
///
/// Callers wanting a full-resolution capture pass `width: 0`.
pub const DEFAULT_RECORD_WIDTH: u32 = 1280;

/// What a finished recording reports. Every field is something MEASURED
/// during the run, not something requested — the point of the tool is to be
/// checkable, so a caller must be able to tell a recording that went to plan
/// from one that limped.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugRecording {
    /// Absolute path of the written video.
    pub path: String,
    /// Which window was recorded (Tauri label).
    pub label: String,
    pub width: u32,
    pub height: u32,
    /// Frames in the output file: always `fps × duration`, by construction.
    pub frames_written: usize,
    /// Of those, how many are a genuinely new capture.
    pub frames_captured: usize,
    /// Of those, how many repeat the previous frame because a capture missed
    /// its slot. A large number here means the recording is padded and the
    /// capture could not keep up — read it before trusting the footage.
    pub frames_duplicated: usize,
    /// The cadence that was asked for.
    pub fps: u32,
    /// New captures per second of wall clock — the rate genuinely achieved.
    pub captured_fps: f64,
    /// Real elapsed wall-clock time of the capture loop.
    pub elapsed_secs: f64,
    /// What one capture cost, in ms. This is the observer cost the recorded
    /// app paid; `debug_frame_timing` over the same window is how you check
    /// whether it mattered.
    pub capture_ms_median: f64,
    pub capture_ms_p95: f64,
    /// The ffmpeg `-pixel_format` the captures actually came back in.
    pub pix_fmt: String,
    /// Whether the window was focused for the whole run. **A non-focused
    /// macOS window has its `requestAnimationFrame` throttled to a stop**
    /// (B-124, D-217), so playback does not really run and any fps in the
    /// footage is a measurement of the throttling, not of the app. Reported
    /// because a recording made this way looks plausible and is worthless.
    pub window_focused: bool,
    /// ffmpeg's own last words — its encode summary on success, its
    /// complaint on failure.
    pub ffmpeg_stderr_tail: String,
}

/// Clamp helpers, kept pure and separate from the AppKit/ffmpeg work so the
/// argument contract is unit-tested without a window or a subprocess.
///
/// Refuse-vs-clamp follows D-216's rule as applied in this repo: a value with
/// an unambiguous intent that merely sits outside the supported range is
/// clamped and reported back (the caller can see what it got), whereas a
/// value that cannot be interpreted at all is an error.
pub(crate) fn clamp_fps(requested: Option<u32>) -> u32 {
    requested
        .unwrap_or(DEFAULT_RECORD_FPS)
        .clamp(MIN_RECORD_FPS, MAX_RECORD_FPS)
}

pub(crate) fn validate_duration(secs: f64) -> Result<f64, String> {
    if !secs.is_finite() {
        return Err("'duration_secs' must be a real number of seconds".to_string());
    }
    if secs < MIN_RECORD_SECS {
        return Err(format!(
            "'duration_secs' must be at least {MIN_RECORD_SECS} (got {secs})"
        ));
    }
    if secs > MAX_RECORD_SECS {
        return Err(format!(
            "'duration_secs' must be at most {MAX_RECORD_SECS} — this call blocks the app's \
             control server for its whole length (got {secs})"
        ));
    }
    Ok(secs)
}

/// Turn a requested output width **in real pixels** into the
/// `WKSnapshotConfiguration.snapshotWidth` **in points** that produces it.
///
/// The two are not the same number, and assuming they were is a bug this
/// tool actually shipped for one measurement: `snapshotWidth` is in points,
/// so on a 2× display a 1280-point window asked for "1280" rasterises at its
/// native 2560 pixels and the setting does nothing at all. The first live run
/// of the recorder came back `2560x1440` with a 58.7 ms median capture for
/// exactly that reason.
///
/// Dividing by the scale factor makes the argument mean what a caller
/// recording a video actually wants it to mean — the width of the resulting
/// video — rather than a unit they would have to know the display's scale to
/// interpret.
///
/// `0` is the caller's way of spelling "native", which is why it is not
/// simply rejected as out of range; `None` (the parameter omitted) takes
/// [`DEFAULT_RECORD_WIDTH`].
pub(crate) fn snapshot_width(requested: Option<u32>, scale_factor: f64) -> Option<f64> {
    let scale = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    match requested.unwrap_or(DEFAULT_RECORD_WIDTH) {
        0 => None,
        w => Some((f64::from(w) / scale).max(1.0)),
    }
}

/// `<shots_dir>/<label>-<timestamp>.mp4`, alongside where screenshots land.
fn generated_path(label: &str) -> PathBuf {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S-%3f");
    debug_capture::shots_dir().join(format!("{label}-{stamp}.mp4"))
}

/// The ffmpeg argv for a raw-frame recording. Pure and unit-tested, for the
/// same reason `ffmpeg_run::build_command` is split out from `run_ffmpeg`:
/// the argv is the part that is easy to get wrong and impossible to see
/// afterwards.
///
/// `-vf pad=...` is not cosmetic: `yuv420p` (what any player can decode)
/// needs even dimensions, and a webview snapshot at an arbitrary window size
/// routinely has an odd one. Padding by at most one pixel is preferable to
/// cropping a column of the UI away.
pub(crate) fn encode_args(
    width: u32,
    height: u32,
    pix_fmt: &str,
    fps: u32,
    out_path: &str,
) -> Vec<String> {
    [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pixel_format",
        pix_fmt,
        "-video_size",
        &format!("{width}x{height}"),
        "-framerate",
        &fps.to_string(),
        "-i",
        "-",
        "-vf",
        "pad=ceil(iw/2)*2:ceil(ih/2)*2",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        // So the file plays immediately in a browser/preview rather than
        // needing the whole thing downloaded to find its index.
        "-movflags",
        "+faststart",
        out_path,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Median and 95th percentile of a set of per-capture costs, in ms. Nearest
/// rank, matching `previewTiming.ts`'s own `quantile` so the two halves of
/// D-330 do not disagree about what a p95 is.
pub(crate) fn cost_percentiles(mut samples: Vec<f64>) -> (f64, f64) {
    if samples.is_empty() {
        return (0.0, 0.0);
    }
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let at = |q: f64| -> f64 {
        let idx = ((q * samples.len() as f64).ceil() as usize)
            .saturating_sub(1)
            .min(samples.len() - 1);
        samples[idx]
    };
    (at(0.5), at(0.95))
}

fn round2(n: f64) -> f64 {
    (n * 100.0).round() / 100.0
}

/// Record `window` for `duration_secs` and write an H.264 file.
///
/// Blocks the calling thread for the whole duration — the capture itself
/// dispatches to the main thread and waits, so this must never run ON the
/// main thread. Both entry points (the control-server op and the Tauri
/// command) call it from a background thread. Note that the control server
/// answers requests one at a time, so a recording in progress delays every
/// other op until it finishes; that is why [`MAX_RECORD_SECS`] exists.
pub fn record_window_video<R: Runtime>(
    app: &tauri::AppHandle<R>,
    window_label: Option<&str>,
    out_path: Option<&str>,
    duration_secs: f64,
    fps: Option<u32>,
    width: Option<u32>,
) -> Result<DebugRecording, String> {
    let duration_secs = validate_duration(duration_secs)?;
    let fps = clamp_fps(fps);

    let window = debug_capture::resolve_capturable_window(app, window_label)?;
    let label = window.label().to_string();
    let window_focused = window.is_focused().unwrap_or(false);
    // The requested width is in output pixels; `snapshotWidth` is in points.
    let snapshot_width = snapshot_width(width, window.scale_factor().unwrap_or(1.0));

    let path = match out_path {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => generated_path(&label),
    };
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let path_str = path.to_string_lossy().into_owned();

    // Capture one frame BEFORE spawning ffmpeg: the encoder's argv needs the
    // real frame size and pixel format, and those are facts about this
    // window that only a capture can tell us. It doubles as a fail-fast — a
    // window that cannot be captured at all should error immediately rather
    // than after spawning a subprocess.
    let first = debug_capture::capture_webview_raw(&window, snapshot_width)?;
    let (frame_w, frame_h, pix_fmt) = (first.width, first.height, first.pix_fmt);
    let frame_bytes =
        frame_w as usize * frame_h as usize * debug_capture::pix_fmt_bytes_per_pixel(pix_fmt);

    let mut sink = FfmpegStdinSink::spawn(&FfmpegRunRequest::new(encode_args(
        frame_w, frame_h, pix_fmt, fps, &path_str,
    )))?;

    let total_frames = ((duration_secs * f64::from(fps)).round() as usize).max(1);
    let period = Duration::from_secs_f64(1.0 / f64::from(fps));
    let start = Instant::now();

    let mut previous = first;
    let mut costs: Vec<f64> = Vec::with_capacity(total_frames);
    let mut frames_captured = 0usize;
    let mut frames_duplicated = 0usize;

    for index in 0..total_frames {
        let due = period.mul_f64(index as f64);
        let now = start.elapsed();

        if now < due {
            std::thread::sleep(due - now);
        } else if now >= due + period && index > 0 {
            // A whole slot late already. Filling it with the previous frame
            // keeps the output's wall clock true instead of letting the
            // recording quietly drift into slow motion — see the module doc.
            sink.write_frame(&previous.bytes)?;
            frames_duplicated += 1;
            continue;
        }

        let before = Instant::now();
        let frame = match debug_capture::capture_webview_raw(&window, snapshot_width) {
            Ok(frame) => frame,
            // One failed capture must not lose the whole recording: emit the
            // previous frame, count it, and carry on. A window that has gone
            // away entirely will simply fill the rest with duplicates, and
            // `framesCaptured` will say so plainly.
            Err(e) => {
                log::warn!("[chroma::debug_record] capture {index} failed: {e}");
                sink.write_frame(&previous.bytes)?;
                frames_duplicated += 1;
                continue;
            }
        };
        costs.push(before.elapsed().as_secs_f64() * 1000.0);

        // A mid-recording window resize would change the frame size, which
        // `-f rawvideo` cannot express — the stream has one fixed geometry.
        // Repeating the previous frame keeps the file valid and the timing
        // true; the alternative is a corrupt video.
        if frame.bytes.len() == frame_bytes {
            sink.write_frame(&frame.bytes)?;
            frames_captured += 1;
            previous = frame;
        } else {
            log::warn!(
                "[chroma::debug_record] frame {index} came back {}x{} ({} bytes, expected {}) \
                 — the window was resized mid-recording; holding the previous frame",
                frame.width,
                frame.height,
                frame.bytes.len(),
                frame_bytes
            );
            sink.write_frame(&previous.bytes)?;
            frames_duplicated += 1;
        }
    }

    let elapsed = start.elapsed().as_secs_f64();
    let outcome = sink.finish()?;
    if !outcome.ok {
        return Err(format!(
            "ffmpeg failed to write {path_str}:\n{}",
            outcome.stderr_tail
        ));
    }

    let (capture_ms_median, capture_ms_p95) = cost_percentiles(costs);

    log::info!(
        "[chroma::debug_record] recorded '{label}' {frame_w}x{frame_h} for {elapsed:.2}s \
         ({frames_captured} captured, {frames_duplicated} duplicated) -> {path_str}"
    );

    Ok(DebugRecording {
        path: path_str,
        label,
        width: frame_w,
        height: frame_h,
        frames_written: frames_captured + frames_duplicated,
        frames_captured,
        frames_duplicated,
        fps,
        captured_fps: if elapsed > 0.0 {
            round2(frames_captured as f64 / elapsed)
        } else {
            0.0
        },
        elapsed_secs: round2(elapsed),
        capture_ms_median: round2(capture_ms_median),
        capture_ms_p95: round2(capture_ms_p95),
        pix_fmt: pix_fmt.to_string(),
        window_focused,
        ffmpeg_stderr_tail: outcome.stderr_tail,
    })
}

// --------------------------------------------------------------------------
// Tauri command.
// --------------------------------------------------------------------------

/// Record the app's own webview to a video file. Runs on a background thread
/// because the capture loop blocks waiting on the main thread's replies.
#[tauri::command]
pub async fn chroma_debug_record_video(
    app: tauri::AppHandle,
    duration_secs: f64,
    out_path: Option<String>,
    window_label: Option<String>,
    fps: Option<u32>,
    width: Option<u32>,
) -> Result<DebugRecording, String> {
    tauri::async_runtime::spawn_blocking(move || {
        record_window_video(
            &app,
            window_label.as_deref(),
            out_path.as_deref(),
            duration_secs,
            fps,
            width,
        )
    })
    .await
    .map_err(|e| format!("recording task panicked: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fps_defaults_and_clamps_into_the_supported_range() {
        assert_eq!(clamp_fps(None), DEFAULT_RECORD_FPS);
        assert_eq!(clamp_fps(Some(24)), 24);
        assert_eq!(clamp_fps(Some(0)), MIN_RECORD_FPS);
        assert_eq!(clamp_fps(Some(10_000)), MAX_RECORD_FPS);
    }

    #[test]
    fn duration_is_refused_rather_than_clamped_and_says_why() {
        assert_eq!(validate_duration(5.0), Ok(5.0));
        // Unlike fps, an out-of-range duration is refused: silently recording
        // 120s when 600 was asked for would look like a successful call and
        // hand back footage that stops five minutes early.
        let too_long = validate_duration(600.0).expect_err("600s must be refused");
        assert!(too_long.contains("at most"), "{too_long}");
        assert!(too_long.contains("control server"), "{too_long}");

        let too_short = validate_duration(0.0).expect_err("0s must be refused");
        assert!(too_short.contains("at least"), "{too_short}");

        assert!(validate_duration(f64::NAN).is_err());
        assert!(validate_duration(f64::INFINITY).is_err());
    }

    #[test]
    fn width_zero_means_native_and_omitted_means_the_default() {
        assert_eq!(snapshot_width(Some(0), 2.0), None);
        assert_eq!(
            snapshot_width(None, 1.0),
            Some(f64::from(DEFAULT_RECORD_WIDTH))
        );
    }

    #[test]
    fn the_requested_width_is_output_pixels_converted_into_snapshot_points() {
        // The bug this pins down was found on the recorder's very first live
        // run: `snapshotWidth` is in POINTS, so on a 2x display asking for
        // "1280" verbatim rasterises a 1280-point window at its native 2560px
        // and the setting silently does nothing at all. 1280 output pixels on
        // a 2x display is 640 points.
        assert_eq!(snapshot_width(Some(1280), 2.0), Some(640.0));
        assert_eq!(snapshot_width(Some(1280), 1.0), Some(1280.0));
        assert_eq!(snapshot_width(Some(1920), 2.0), Some(960.0));
        // A nonsense scale factor must not yield a zero, negative or NaN
        // width — WebKit would reject it and the recording would fail for a
        // reason with nothing to do with what the caller asked for.
        assert_eq!(snapshot_width(Some(800), 0.0), Some(800.0));
        assert_eq!(snapshot_width(Some(800), f64::NAN), Some(800.0));
        assert_eq!(snapshot_width(Some(1), 4.0), Some(1.0));
    }

    #[test]
    fn encode_args_describe_the_raw_input_and_a_playable_output() {
        let args = encode_args(1280, 721, "bgra", 15, "/tmp/out.mp4");
        let joined = args.join(" ");

        // The input side must match the bytes actually written, exactly —
        // a wrong pixel_format here produces a colour-swapped video and a
        // wrong video_size produces a sheared one, neither of which fails.
        assert!(joined.contains("-f rawvideo"), "{joined}");
        assert!(joined.contains("-pixel_format bgra"), "{joined}");
        assert!(joined.contains("-video_size 1280x721"), "{joined}");
        assert!(joined.contains("-framerate 15"), "{joined}");
        assert!(joined.contains("-i -"), "{joined}");

        // The output side must be playable anywhere: yuv420p needs even
        // dimensions, and this input is deliberately 721 tall.
        assert!(joined.contains("pad=ceil(iw/2)*2:ceil(ih/2)*2"), "{joined}");
        assert!(joined.contains("-pix_fmt yuv420p"), "{joined}");
        assert_eq!(args.last().map(String::as_str), Some("/tmp/out.mp4"));
    }

    #[test]
    fn cost_percentiles_are_nearest_rank_and_handle_the_empty_case() {
        assert_eq!(cost_percentiles(vec![]), (0.0, 0.0));
        assert_eq!(cost_percentiles(vec![7.0]), (7.0, 7.0));
        let (median, p95) = cost_percentiles((1..=100).map(f64::from).collect());
        assert_eq!(median, 50.0);
        assert_eq!(p95, 95.0);
    }

    /// The whole encode pipeline for real, with synthetic frames standing in
    /// for captures: build the argv, spawn ffmpeg, stream raw bytes down its
    /// stdin, close it, and check a playable file came out the other end.
    ///
    /// This is the half of the recorder that needs no window, and it is the
    /// half that silently produces garbage when it is wrong — a mismatched
    /// `video_size` or `pixel_format` does not fail, it shears or
    /// colour-swaps the picture. `ffmpeg` is already a hard dependency of
    /// this crate's siblings, so assuming it is present matches
    /// `ffmpeg_run`'s own integration tests.
    #[test]
    fn frames_streamed_down_stdin_become_a_real_playable_video() {
        let dir =
            std::env::temp_dir().join(format!("chroma-debug-record-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let out = dir.join("encoded.mp4");
        let out_str = out.to_string_lossy().into_owned();

        // Deliberately an ODD height, so the `pad` filter is genuinely
        // exercised rather than merely present in the argv: yuv420p cannot
        // represent 33 rows, so a missing pad would fail this test.
        let (width, height, fps, frames) = (64u32, 33u32, 10u32, 20usize);
        let mut sink = FfmpegStdinSink::spawn(&FfmpegRunRequest::new(encode_args(
            width, height, "rgba", fps, &out_str,
        )))
        .expect("spawn ffmpeg");

        let frame_len = width as usize * height as usize * 4;
        for i in 0..frames {
            // A different value per frame so the encoder has real motion to
            // compress and cannot collapse the stream to a single frame.
            let frame = vec![(i * 11) as u8; frame_len];
            sink.write_frame(&frame).expect("write frame");
        }
        let outcome = sink.finish().expect("finish");
        assert!(outcome.ok, "ffmpeg failed: {}", outcome.stderr_tail);

        // Ask ffprobe what actually landed, rather than trusting that a
        // non-empty file is a valid one.
        let probe = std::process::Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height,nb_read_packets",
                "-count_packets",
                "-of",
                "csv=p=0",
                &out_str,
            ])
            .output()
            .expect("run ffprobe");
        assert!(
            probe.status.success(),
            "ffprobe failed: {}",
            String::from_utf8_lossy(&probe.stderr)
        );
        let fields = String::from_utf8_lossy(&probe.stdout).trim().to_string();
        // 33 padded up to 34 — the odd dimension really was handled, not
        // rejected and not cropped down to 32.
        assert_eq!(fields, format!("{width},34,{frames}"), "probe: {fields}");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The frame budget is what makes the output's wall clock true — it is
    /// always `fps × duration`, whatever the capture managed.
    #[test]
    fn the_frame_budget_is_exactly_fps_times_duration() {
        let budget = |secs: f64, fps: u32| ((secs * f64::from(fps)).round() as usize).max(1);
        assert_eq!(budget(10.0, 15), 150);
        assert_eq!(budget(2.5, 24), 60);
        // Never zero: a legal-but-tiny duration must still produce a file.
        assert_eq!(budget(MIN_RECORD_SECS, 1), 1);
    }
}
