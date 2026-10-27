//! `apelles-beat` — where the beats are in a piece of music (D-413).
//!
//! **What this crate is.** The analysis half of "time the edit / the motion to
//! the music": for an audio signal it answers the tempo, the beat grid, which
//! beats start a bar (downbeats) and how hard each beat hits. The Edit tab
//! draws the grid on the timeline and snaps cuts to it; the Motion tab maps
//! named moves ("reveal on downbeat 1, land the scale on the next strong
//! beat") to keyframe times from it. Both reach it through one Tauri command,
//! `chroma_detect_beats`, so a person and an agent read the same grid.
//!
//! The pipeline, one module each:
//!
//! 1. [`spectrum`] — centred STFT → mel filterbank → dB (librosa's defaults);
//! 2. [`onset`] — spectral flux, full band and low band;
//! 3. [`tempo`] — autocorrelation of the onset envelope under a tempo prior;
//! 4. [`track`] — Ellis' dynamic-programming beat tracker;
//! 5. [`meter`] — bar phase (low-band onsets + harmonic change) and accents;
//! 6. [`source`] — decode a file, hash its bytes, and cache the answer.
//!
//! **Why written here and not called from Python (D-413, "Options").** librosa
//! is installed in the AI env and implements steps 1–4; it is the reference
//! this crate is measured against (`examples/beat_eval.rs` +
//! `eval/beats/compare_librosa.py`). It is not the runtime because the AI env
//! is an optional, separately bootstrapped Python install (not in the beta
//! bundle), a Python process costs seconds of import per call, and a beat grid
//! is an input to keyframe times, which the render-path determinism rule
//! wants computed by code this repo pins. madmom (CC BY-NC-SA models), essentia
//! (AGPL, a large C++ build) and BeatNet (built on madmom's features) were
//! ruled out for licence or weight; aubio (GPL, C) for its build.
//!
//! **What this crate does NOT do.**
//! - **It never edits anything.** Times out, in seconds. Mapping a beat to a
//!   timeline frame or a scene time needs a timeline or a manifest, which the
//!   frontend op layer owns.
//! - **No time-signature detection, no tempo map.** The meter is a parameter;
//!   the tempo is one number (the tracker still follows drift).
//! - **No network, no model files.** Pure DSP on the CPU.

pub mod meter;
pub mod onset;
pub mod source;
pub mod spectrum;
pub mod tempo;
pub mod track;

use serde::{Deserialize, Serialize};

/// Bumped whenever the algorithm or the output shape changes, so every cached
/// answer from an older build is a clean miss (it is part of the cache key).
pub const ALGORITHM_VERSION: u32 = 1;

/// The meters the analysis accepts: beats per bar.
pub const METERS: std::ops::RangeInclusive<u32> = 2..=7;

/// Default beats per bar.
pub const DEFAULT_METER: u32 = 4;

#[derive(Debug, thiserror::Error)]
pub enum BeatError {
    #[error("{0}")]
    InvalidParams(String),
    #[error("{0}")]
    Decode(String),
    #[error("{0}")]
    Analysis(String),
    #[error("{0}")]
    Io(String),
}

/// What to analyse with. Both fields are part of the cache key.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatParams {
    /// Beats per bar, in [`METERS`].
    pub meter: u32,
    /// Where the tempo prior is centred, BPM. `None` = 120. Pass the tempo
    /// you expect when the track is much slower or faster than 120 and the
    /// first answer came back at half or double speed.
    pub tempo_hint_bpm: Option<f64>,
}

impl Default for BeatParams {
    fn default() -> Self {
        Self {
            meter: DEFAULT_METER,
            tempo_hint_bpm: None,
        }
    }
}

impl BeatParams {
    pub fn validate(&self) -> Result<(), BeatError> {
        if !METERS.contains(&self.meter) {
            return Err(BeatError::InvalidParams(format!(
                "meter must be {}..={} beats per bar, got {}",
                METERS.start(),
                METERS.end(),
                self.meter
            )));
        }
        if let Some(h) = self.tempo_hint_bpm
            && (!h.is_finite() || !(tempo::MIN_BPM..=tempo::MAX_BPM).contains(&h))
        {
            return Err(BeatError::InvalidParams(format!(
                "tempo_hint_bpm must be {}..={} BPM, got {h}",
                tempo::MIN_BPM,
                tempo::MAX_BPM
            )));
        }
        Ok(())
    }
}

/// One beat.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Beat {
    /// Seconds from the start of the analysed audio.
    pub time: f64,
    /// Bar number, 1-based from the first downbeat; `0` for pickup beats
    /// before it.
    pub bar: u32,
    /// Position in the bar, `1..=meter` (1 is the downbeat).
    pub beat: u32,
    pub downbeat: bool,
    /// How hard the beat hits relative to the track, `0..=1`.
    pub strength: f32,
    /// A downbeat, or strength ≥ [`meter::STRONG_ACCENT`].
    pub strong: bool,
}

/// The whole answer for one signal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatAnalysis {
    pub algorithm_version: u32,
    /// Seconds of audio analysed.
    pub duration: f64,
    /// Estimated tempo, BPM (0 when no beat was found).
    pub tempo_bpm: f64,
    pub meter: u32,
    pub beats: Vec<Beat>,
}

/// Round to 0.1 ms / 3 decimals so the serialised answer is stable and short.
fn round_to(x: f64, places: i32) -> f64 {
    let k = 10f64.powi(places);
    (x * k).round() / k
}

/// Analyse mono PCM at [`spectrum::SAMPLE_RATE`].
pub fn analyze(samples: &[f32], params: &BeatParams) -> Result<BeatAnalysis, BeatError> {
    params.validate()?;
    let duration = round_to(samples.len() as f64 / spectrum::SAMPLE_RATE as f64, 4);
    let empty = BeatAnalysis {
        algorithm_version: ALGORITHM_VERSION,
        duration,
        tempo_bpm: 0.0,
        meter: params.meter,
        beats: Vec::new(),
    };
    let spec = spectrum::mel_spectrogram(samples)?;
    let onsets = onset::onset_envelopes(&spec);
    let fr = spectrum::frame_rate();
    let start_bpm = params.tempo_hint_bpm.unwrap_or(tempo::DEFAULT_START_BPM);
    let Some(bpm) = tempo::estimate_tempo(&onsets.full, fr, start_bpm) else {
        return Ok(empty);
    };
    let tracked = track::track_beats(&onsets.full, fr, bpm);
    let frames = &tracked.frames;
    if frames.is_empty() {
        return Ok(empty);
    }
    let meter = params.meter as usize;
    let phase = meter::downbeat_phase(frames, &onsets.low, &spec, meter);
    let strengths = meter::accent_strengths(frames, &onsets.full);
    let beats = tracked
        .positions
        .iter()
        .enumerate()
        .map(|(i, &pos)| {
            let (bar, beat) = if i >= phase {
                (
                    ((i - phase) / meter) as u32 + 1,
                    ((i - phase) % meter) as u32 + 1,
                )
            } else {
                (0, (meter - (phase - i)) as u32 + 1)
            };
            let downbeat = beat == 1 && bar > 0;
            let strength = (strengths[i] * 1000.0).round() / 1000.0;
            Beat {
                time: round_to(pos / fr, 4),
                bar,
                beat,
                downbeat,
                strength,
                strong: downbeat || strength >= meter::STRONG_ACCENT,
            }
        })
        .collect();
    Ok(BeatAnalysis {
        algorithm_version: ALGORITHM_VERSION,
        duration,
        tempo_bpm: round_to(bpm, 2),
        meter: params.meter,
        beats,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn params_are_checked() {
        assert!(BeatParams::default().validate().is_ok());
        assert!(
            BeatParams {
                meter: 1,
                tempo_hint_bpm: None
            }
            .validate()
            .is_err()
        );
        assert!(
            BeatParams {
                meter: 4,
                tempo_hint_bpm: Some(10.0)
            }
            .validate()
            .is_err()
        );
        assert!(
            BeatParams {
                meter: 4,
                tempo_hint_bpm: Some(f64::NAN)
            }
            .validate()
            .is_err()
        );
    }

    #[test]
    fn silence_is_an_empty_answer_not_an_error() {
        let a = analyze(
            &vec![0.0; spectrum::SAMPLE_RATE as usize * 3],
            &BeatParams::default(),
        )
        .expect("analysis");
        assert!(a.beats.is_empty());
        assert_eq!(a.tempo_bpm, 0.0);
        assert!((a.duration - 3.0).abs() < 1e-9);
    }
}
