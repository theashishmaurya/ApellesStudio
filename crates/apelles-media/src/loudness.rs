//! loudness.rs — measure a finished file's loudness and normalise its audio to
//! a target integrated loudness and true-peak ceiling (D-401, roadmap 0c).
//!
//! **What it is:** the one place Apelles knows what "-14 LUFS / -1 dBTP" means
//! as `ffmpeg` work. [`measure`] runs EBU R128 (`ebur128=peak=true`) over a
//! file's first audio stream; [`normalise_in_place`] makes the file hit a
//! [`LoudnessTarget`] and reports before/after as a [`LoudnessReport`].
//!
//! **What it does:** a two-stage, measured correction rather than a one-pass
//! guess. It measures the mix, applies one linear gain (`target - measured`)
//! followed by a lookahead limiter run at 4x the export rate (so the limiter
//! sees inter-sample peaks, which is what a true-peak ceiling is about), then
//! MEASURES THE RESULT and, if the first attempt missed the target (the limiter
//! engaging costs a little loudness; AAC overshoots a little peak), corrects the
//! gain/ceiling from the measurement and re-encodes from the ORIGINAL file —
//! never a generation of AAC on top of AAC. The video stream is `-c:v copy`,
//! always: this module cannot re-encode a picture.
//!
//! **Why not ffmpeg's `loudnorm`:** its linear mode silently falls back to a
//! dynamic (compressing) mode whenever the needed gain would push the true peak
//! over the ceiling — exactly the case a quiet, peaky mix hits — and then lands
//! wherever it lands. A measured gain + limiter has one behaviour, and the
//! after-measurement tells the caller whether it worked. See D-401.
//!
//! **What it does NOT do:** know about timelines, presets (the preset table is
//! `packages/editor/src/loudness.ts`; this takes numbers), or tauri. It does
//! not touch a file with no audio or with silent audio (reported as `skipped`),
//! and it does not replace the original unless a result was actually produced.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::ffmpeg_locate;

/// Loudest integrated target accepted. Anything above this is not a delivery
/// spec, it is a typo — and a limiter asked to deliver it would be crushing the
/// mix.
pub const MAX_TARGET_LUFS: f64 = -5.0;
/// Quietest integrated target accepted (below this ebur128's absolute gate at
/// -70 LUFS starts to interfere with the measurement itself).
pub const MIN_TARGET_LUFS: f64 = -40.0;
/// True-peak ceiling range accepted, dBTP.
pub const MIN_CEILING_DBTP: f64 = -9.0;
pub const MAX_CEILING_DBTP: f64 = 0.0;

/// ebur128 reports an all-gated (silent) programme as -70 LUFS; at or below
/// this there is nothing to normalise toward, and a gain would only amplify
/// the noise floor.
const SILENCE_FLOOR_LUFS: f64 = -69.0;
/// How far the first attempt's limiter ceiling sits under the requested one, to
/// absorb the small peak overshoot the AAC encode adds. The loop below corrects
/// from the MEASURED result, so this only makes the first attempt likely to be
/// the last.
const CODEC_HEADROOM_DB: f64 = 0.2;
/// A result within this many LU of the target counts as on target. Tighter than
/// the +-0.5 LU the broadcast specs allow, loose enough that the loop does not
/// chase the measurement's own noise.
const TOLERANCE_LU: f64 = 0.2;
/// Measure-and-correct attempts before the closest one is accepted.
const MAX_ATTEMPTS: u32 = 4;
/// The limiter runs at this multiple of the file's sample rate, so a peak that
/// lies BETWEEN two samples is seen as the peak it will reconstruct to.
const LIMITER_OVERSAMPLE: u32 = 4;
/// Re-encoded audio bitrate. A transparent rate for stereo AAC-LC; the
/// exporter's own default (128k) would be a quality step down from the mix.
const AUDIO_BITRATE: &str = "192k";
/// `alimiter` accepts a linear limit no lower than this (about -24 dB).
const ALIMITER_MIN_LIMIT: f64 = 0.0625;

/// What to hit: integrated loudness and the true-peak ceiling.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessTarget {
    pub integrated_lufs: f64,
    pub true_peak_dbtp: f64,
}

impl LoudnessTarget {
    /// Refuse a target no delivery spec could mean.
    pub fn validate(&self) -> Result<(), String> {
        if !(MIN_TARGET_LUFS..=MAX_TARGET_LUFS).contains(&self.integrated_lufs) {
            return Err(format!(
                "loudness target must be between {MIN_TARGET_LUFS} and {MAX_TARGET_LUFS} LUFS, got {}",
                self.integrated_lufs
            ));
        }
        if !(MIN_CEILING_DBTP..=MAX_CEILING_DBTP).contains(&self.true_peak_dbtp) {
            return Err(format!(
                "true-peak ceiling must be between {MIN_CEILING_DBTP} and {MAX_CEILING_DBTP} dBTP, got {}",
                self.true_peak_dbtp
            ));
        }
        Ok(())
    }
}

/// One EBU R128 reading of a file's audio.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Measurement {
    pub integrated_lufs: f64,
    pub true_peak_dbtp: f64,
    pub loudness_range_lu: f64,
}

/// What a normalisation did, for the export result and status.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessReport {
    pub target: LoudnessTarget,
    /// The mix as rendered, before any correction. `None` only when the file
    /// has no audio to measure.
    pub before: Option<Measurement>,
    /// The file as delivered, measured again. `None` when nothing was applied.
    pub after: Option<Measurement>,
    /// The net linear gain applied, dB (positive = louder). `0` when skipped.
    pub gain_db: f64,
    /// How many encode-and-measure attempts it took.
    pub attempts: u32,
    /// Whether `after` is within [`TOLERANCE_LU`] of the integrated target AND
    /// under the true-peak ceiling. `false` is reported, not hidden.
    pub target_met: bool,
    /// Why the file was left untouched, when it was.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<String>,
}

fn run_ffmpeg(args: &[String]) -> Result<String, String> {
    let output = ffmpeg_locate::ffmpeg()
        .map_err(|e| e.to_string())?
        .args(args)
        .output()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if output.status.success() {
        Ok(stderr)
    } else {
        let tail: Vec<&str> = stderr.lines().rev().take(8).collect();
        Err(tail.into_iter().rev().collect::<Vec<_>>().join("\n"))
    }
}

/// The first number after `label` on the first line that starts with it,
/// within the text of ebur128's closing summary.
fn summary_value(summary: &str, label: &str) -> Option<f64> {
    summary.lines().find_map(|line| {
        let rest = line.trim_start().strip_prefix(label)?;
        rest.split_whitespace().next()?.parse::<f64>().ok()
    })
}

/// Parse the `Summary:` block `ebur128=peak=true` prints when the stream ends.
///
/// Reads the LAST `Summary:` so the per-frame `framelog` lines (which carry the
/// same labels) can never be mistaken for it.
pub fn parse_summary(stderr: &str) -> Option<Measurement> {
    let summary = &stderr[stderr.rfind("Summary:")?..];
    Some(Measurement {
        integrated_lufs: summary_value(summary, "I:")?,
        true_peak_dbtp: summary_value(summary, "Peak:")?,
        loudness_range_lu: summary_value(summary, "LRA:")?,
    })
}

/// Measure `path`'s first audio stream. `Ok(None)` means the file has no audio.
pub fn measure(path: &Path) -> Result<Option<Measurement>, String> {
    let args: Vec<String> = [
        "-hide_banner",
        "-nostats",
        "-i",
        &path.to_string_lossy(),
        "-map",
        "0:a:0",
        "-vn",
        "-af",
        "ebur128=peak=true:framelog=quiet",
        "-f",
        "null",
        "-",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect();
    match run_ffmpeg(&args) {
        Ok(stderr) => parse_summary(&stderr)
            .map(Some)
            .ok_or_else(|| "ffmpeg's ebur128 printed no summary".to_string()),
        // `-map 0:a:0` on a file with no audio stream is the one failure that
        // is an answer, not an error.
        Err(e) if e.contains("matches no streams") => Ok(None),
        Err(e) => Err(format!("could not measure loudness: {e}")),
    }
}

fn db_to_linear(db: f64) -> f64 {
    10f64.powf(db / 20.0)
}

/// The audio filter chain for one attempt: a linear gain, then the limiter at
/// an oversampled rate, then back to the file's own rate.
pub fn filter_chain(gain_db: f64, limiter_ceiling_dbtp: f64, sample_rate: u32) -> String {
    let limit = db_to_linear(limiter_ceiling_dbtp).clamp(ALIMITER_MIN_LIMIT, 1.0);
    format!(
        "volume={gain_db:.3}dB,aresample={},alimiter=limit={limit:.5}:attack=5:release=50:level=0,aresample={sample_rate}",
        sample_rate * LIMITER_OVERSAMPLE
    )
}

/// The `-c:a` codec args for `path`'s container, or an error naming the
/// containers this module will rewrite.
fn audio_codec_args(path: &Path) -> Result<Vec<String>, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match ext.as_str() {
        "mp4" | "m4v" | "mov" | "mkv" => Ok(vec![
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            AUDIO_BITRATE.into(),
        ]),
        other => Err(format!(
            "loudness normalisation rewrites the audio of an .mp4/.m4v/.mov/.mkv file; \
             this export is .{other}"
        )),
    }
}

/// `<stem>.loudness-tmp.<ext>` beside `path`, so the final rename never crosses
/// a filesystem and the muxer is still inferred from the extension.
fn sibling_temp(path: &Path) -> PathBuf {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("export");
    let name = match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => format!("{stem}.loudness-tmp.{ext}"),
        None => format!("{stem}.loudness-tmp"),
    };
    path.with_file_name(name)
}

/// `<stem>.loudness-best.<ext>` beside `path`: the best attempt so far, kept
/// because the next attempt overwrites [`sibling_temp`].
fn best_path(path: &Path) -> PathBuf {
    path.with_extension(format!(
        "loudness-best.{}",
        path.extension().and_then(|e| e.to_str()).unwrap_or("mp4")
    ))
}

/// Re-mux `src` into `dst` with `chain` applied to its audio and the video
/// stream copied bit for bit.
fn encode_attempt(src: &Path, dst: &Path, chain: &str, codec: &[String]) -> Result<(), String> {
    let mut args: Vec<String> = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-i".into(),
        src.to_string_lossy().into_owned(),
        "-map".into(),
        "0:v?".into(),
        "-map".into(),
        "0:a:0".into(),
        "-c:v".into(),
        "copy".into(),
        "-af".into(),
        chain.to_string(),
    ];
    args.extend(codec.iter().cloned());
    args.push(dst.to_string_lossy().into_owned());
    run_ffmpeg(&args)
        .map(|_| ())
        .map_err(|e| format!("loudness re-mux failed: {e}"))
}

fn skipped(target: LoudnessTarget, before: Option<Measurement>, why: &str) -> LoudnessReport {
    LoudnessReport {
        target,
        before,
        after: None,
        gain_db: 0.0,
        attempts: 0,
        target_met: false,
        skipped: Some(why.to_string()),
    }
}

fn meets(m: &Measurement, target: &LoudnessTarget) -> bool {
    (m.integrated_lufs - target.integrated_lufs).abs() <= TOLERANCE_LU
        && m.true_peak_dbtp <= target.true_peak_dbtp
}

/// The next attempt's gain and limiter ceiling, from what the last one measured.
///
/// The gain moves by the loudness error (the limiter engaging is what makes the
/// first attempt land short, and more gain into it is what closes the gap); the
/// limiter ceiling moves down by exactly the peak overshoot, with a hair of
/// margin so the correction does not land back on the line.
fn correct(
    gain_db: f64,
    ceiling_db: f64,
    got: &Measurement,
    target: &LoudnessTarget,
) -> (f64, f64) {
    let gain = gain_db + (target.integrated_lufs - got.integrated_lufs);
    let overshoot = got.true_peak_dbtp - target.true_peak_dbtp;
    let ceiling = if overshoot > 0.0 {
        ceiling_db - overshoot - 0.05
    } else {
        ceiling_db
    };
    (gain, ceiling)
}

/// Normalise `path`'s audio to `target`, replacing the file in place.
///
/// The original is left untouched unless an attempt produced a file; a failure
/// removes the temporary and returns the error, so a failed normalisation never
/// costs the caller their export.
pub fn normalise_in_place(path: &Path, target: LoudnessTarget) -> Result<LoudnessReport, String> {
    target.validate()?;
    let Some(before) = measure(path)? else {
        return Ok(skipped(target, None, "the export has no audio track"));
    };
    if before.integrated_lufs <= SILENCE_FLOOR_LUFS {
        return Ok(skipped(
            target,
            Some(before),
            "the audio is silent, so there is no loudness to normalise",
        ));
    }
    let codec = audio_codec_args(path)?;
    let info = crate::video::probe(path).map_err(|e| format!("could not probe the export: {e}"))?;
    if info.audio_sample_rate == 0 {
        return Err("the export's audio sample rate is unknown".to_string());
    }
    let rate = info.audio_sample_rate;

    let tmp = sibling_temp(path);
    let keep = best_path(path);
    let mut gain = target.integrated_lufs - before.integrated_lufs;
    let mut ceiling = target.true_peak_dbtp - CODEC_HEADROOM_DB;
    let mut best: Option<(Measurement, f64, u32)> = None;

    for attempt in 1..=MAX_ATTEMPTS {
        let chain = filter_chain(gain, ceiling, rate);
        let step = encode_attempt(path, &tmp, &chain, &codec).and_then(|()| {
            measure(&tmp)?.ok_or_else(|| "the re-muxed file lost its audio".to_string())
        });
        let got = match step {
            Ok(m) => m,
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return Err(e);
            }
        };
        let done = meets(&got, &target);
        // The attempt that is closest in loudness while under the ceiling wins;
        // an over-ceiling attempt only wins when nothing better exists.
        let better = match &best {
            None => true,
            Some((b, _, _)) => {
                let (gu, bu) = (
                    got.true_peak_dbtp <= target.true_peak_dbtp,
                    b.true_peak_dbtp <= target.true_peak_dbtp,
                );
                if gu != bu {
                    gu
                } else {
                    (got.integrated_lufs - target.integrated_lufs).abs()
                        < (b.integrated_lufs - target.integrated_lufs).abs()
                }
            }
        };
        if better {
            // Keep the file itself, not just its numbers: the next attempt
            // overwrites `tmp`.
            if let Err(e) = std::fs::copy(&tmp, &keep) {
                let _ = std::fs::remove_file(&tmp);
                return Err(format!("could not keep the loudness result: {e}"));
            }
            best = Some((got, gain, attempt));
        }
        if done {
            break;
        }
        (gain, ceiling) = correct(gain, ceiling, &got, &target);
    }
    let _ = std::fs::remove_file(&tmp);

    let Some((after, gain_db, attempts)) = best else {
        return Err("no loudness attempt produced a file".to_string());
    };
    std::fs::rename(&keep, path).map_err(|e| {
        let _ = std::fs::remove_file(&keep);
        format!("could not replace the export with the normalised file: {e}")
    })?;

    Ok(LoudnessReport {
        target,
        before: Some(before),
        after: Some(after),
        gain_db: (gain_db * 100.0).round() / 100.0,
        attempts,
        target_met: meets(&after, &target),
        skipped: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_SUMMARY: &str = "\
[Parsed_ebur128_0 @ 0x1] t: 0.1  M: -23.0 S: -120.7 I: -70.0 LUFS LRA: 0.0 LU
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -21.6 LUFS
    Threshold: -31.6 LUFS

  Loudness range:
    LRA:         7.4 LU
    Threshold: -41.6 LUFS
    LRA low:   -26.0 LUFS
    LRA high:  -18.6 LUFS

  True peak:
    Peak:       -6.5 dBFS
";

    #[test]
    fn parses_the_closing_summary() {
        let m = parse_summary(SAMPLE_SUMMARY).expect("summary parses");
        assert_eq!(m.integrated_lufs, -21.6);
        assert_eq!(m.true_peak_dbtp, -6.5);
        assert_eq!(m.loudness_range_lu, 7.4);
    }

    #[test]
    fn a_log_with_no_summary_is_not_a_measurement() {
        assert_eq!(parse_summary("size=N/A time=00:00:01"), None);
    }

    #[test]
    fn silence_parses_as_negative_infinity_peak() {
        let s = SAMPLE_SUMMARY.replace("-6.5 dBFS", "-inf dBFS");
        let m = parse_summary(&s).expect("summary parses");
        assert!(m.true_peak_dbtp.is_infinite() && m.true_peak_dbtp < 0.0);
    }

    #[test]
    fn target_validation_rejects_values_no_spec_means() {
        let ok = LoudnessTarget {
            integrated_lufs: -14.0,
            true_peak_dbtp: -1.0,
        };
        assert!(ok.validate().is_ok());
        assert!(
            LoudnessTarget {
                integrated_lufs: 3.0,
                ..ok
            }
            .validate()
            .is_err()
        );
        assert!(
            LoudnessTarget {
                integrated_lufs: -60.0,
                ..ok
            }
            .validate()
            .is_err()
        );
        assert!(
            LoudnessTarget {
                true_peak_dbtp: 2.0,
                ..ok
            }
            .validate()
            .is_err()
        );
    }

    #[test]
    fn the_filter_chain_limits_at_an_oversampled_rate() {
        let chain = filter_chain(12.5, -1.2, 48_000);
        assert_eq!(
            chain,
            "volume=12.500dB,aresample=192000,alimiter=limit=0.87096:attack=5:release=50:level=0,aresample=48000"
        );
    }

    #[test]
    fn the_correction_follows_the_measurement() {
        let target = LoudnessTarget {
            integrated_lufs: -14.0,
            true_peak_dbtp: -1.0,
        };
        let got = Measurement {
            integrated_lufs: -14.6,
            true_peak_dbtp: -0.7,
            loudness_range_lu: 3.0,
        };
        let (gain, ceiling) = correct(7.0, -1.2, &got, &target);
        assert!(
            (gain - 7.6).abs() < 1e-9,
            "gain closes the 0.6 LU shortfall"
        );
        assert!(
            (ceiling - (-1.2 - 0.3 - 0.05)).abs() < 1e-9,
            "ceiling drops by the 0.3 dB overshoot"
        );
    }

    #[test]
    fn an_unrewritable_container_is_named() {
        let err = audio_codec_args(Path::new("/tmp/x.webm")).expect_err("webm is refused");
        assert!(err.contains(".webm"));
    }

    // ---- measured tests: the bundled ffmpeg's own ebur128 is the judge ----

    /// A small mp4: testsrc video + pink noise of `amplitude` (so a real, peaky
    /// programme rather than a pure tone), `secs` long. `None` when no ffmpeg.
    fn fixture(dir: &Path, name: &str, amplitude: f64, secs: u32) -> Option<PathBuf> {
        ffmpeg_locate::ffmpeg_path().ok()?;
        let out = dir.join(name);
        let args: Vec<String> = [
            "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", &format!("testsrc=size=160x120:rate=10:duration={secs}"),
            "-f", "lavfi", "-i", &format!("anoisesrc=color=pink:amplitude={amplitude}:seed=7:sample_rate=48000:duration={secs}"),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
            "-shortest",
        ]
        .iter()
        .map(|s| (*s).to_string())
        .chain(std::iter::once(out.to_string_lossy().into_owned()))
        .collect();
        run_ffmpeg(&args).ok()?;
        Some(out)
    }

    fn video_packets_md5(path: &Path) -> String {
        let out = ffmpeg_locate::ffmpeg()
            .expect("ffmpeg resolved above")
            .args(["-v", "error", "-i"])
            .arg(path)
            .args(["-map", "0:v", "-c", "copy", "-f", "md5", "-"])
            .output()
            .expect("md5 run");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn youtube_preset_lands_within_half_an_lu_and_under_the_ceiling() {
        let dir = tempfile::tempdir().expect("tempdir");
        let Some(file) = fixture(dir.path(), "quiet.mp4", 0.05, 12) else {
            eprintln!("skip: no ffmpeg found");
            return;
        };
        let target = LoudnessTarget {
            integrated_lufs: -14.0,
            true_peak_dbtp: -1.0,
        };
        let video_before = video_packets_md5(&file);

        let report = normalise_in_place(&file, target).expect("normalises");
        let before = report.before.expect("before measured");
        let after = report.after.expect("after measured");
        eprintln!(
            "loudness test: before {before:?} -> after {after:?} (gain {} dB, {} attempts)",
            report.gain_db, report.attempts
        );

        // Judge by an independent measurement of the delivered file, not by
        // the report's own claim.
        let re = measure(&file).expect("measures").expect("has audio");
        assert!(
            (re.integrated_lufs - -14.0).abs() <= 0.5,
            "integrated {} LUFS",
            re.integrated_lufs
        );
        assert!(
            re.true_peak_dbtp <= -1.0,
            "true peak {} dBTP",
            re.true_peak_dbtp
        );
        assert!(report.target_met);
        assert!(before.integrated_lufs < -20.0, "the fixture starts quiet");
        assert_eq!(
            video_packets_md5(&file),
            video_before,
            "the video stream must be copied untouched"
        );
        assert!(!sibling_temp(&file).exists(), "no temporary left behind");
    }

    #[test]
    fn a_loud_peaky_mix_is_pulled_down_to_the_target() {
        let dir = tempfile::tempdir().expect("tempdir");
        let Some(file) = fixture(dir.path(), "loud.mp4", 0.9, 12) else {
            eprintln!("skip: no ffmpeg found");
            return;
        };
        let target = LoudnessTarget {
            integrated_lufs: -23.0,
            true_peak_dbtp: -1.0,
        };
        let report = normalise_in_place(&file, target).expect("normalises");
        let re = measure(&file).expect("measures").expect("has audio");
        eprintln!("loudness test (broadcast): {:?} -> {re:?}", report.before);
        assert!(
            (re.integrated_lufs - -23.0).abs() <= 0.5,
            "integrated {} LUFS",
            re.integrated_lufs
        );
        assert!(
            re.true_peak_dbtp <= -1.0,
            "true peak {} dBTP",
            re.true_peak_dbtp
        );
        assert!(report.gain_db < 0.0, "a loud mix is turned down");
    }

    #[test]
    fn a_file_with_no_audio_is_left_alone() {
        let dir = tempfile::tempdir().expect("tempdir");
        if ffmpeg_locate::ffmpeg_path().is_err() {
            eprintln!("skip: no ffmpeg found");
            return;
        }
        let file = dir.path().join("silent-video.mp4");
        let args: Vec<String> = [
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=160x120:rate=10:duration=2",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
        ]
        .iter()
        .map(|s| (*s).to_string())
        .chain(std::iter::once(file.to_string_lossy().into_owned()))
        .collect();
        run_ffmpeg(&args).expect("fixture");
        let before = std::fs::read(&file).expect("read");
        let target = LoudnessTarget {
            integrated_lufs: -14.0,
            true_peak_dbtp: -1.0,
        };
        let report = normalise_in_place(&file, target).expect("skips cleanly");
        assert!(report.skipped.is_some());
        assert_eq!(
            std::fs::read(&file).expect("read"),
            before,
            "the file is byte-identical"
        );
    }
}
