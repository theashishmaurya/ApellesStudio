//! Onset strength: "how much new sound starts here", one value per frame
//! (D-413).
//!
//! **What it is.** Spectral flux over the log-mel spectrogram: for each frame,
//! the mean over bands of the positive part of the dB increase from the frame
//! before (librosa's `onset_strength` with its defaults). Two envelopes come
//! out of the same pass: the full band, which the tempo estimate and the beat
//! tracker read, and the low band (bands centred at or below
//! [`LOW_BAND_MAX_HZ`]), where kicks and bass notes live, which the bar-phase
//! choice in [`crate::meter`] reads.
//!
//! **Alignment.** A centred window starts to "see" a sound half a window
//! before its frame is centred on it, so raw flux peaks early. The envelope is
//! shifted later by `N_FFT / (4 * HOP)` frames (23 ms). Measured over the
//! synthetic metronomes in `tests/click_tracks.rs` (283 beats, five tempos):
//! this shift puts beats a mean 2.8 ms early (worst 4.5 ms); `N_FFT / (2 *
//! HOP)` (librosa's shift, 46 ms at this hop) put them 20.4 ms late, no shift
//! 26.0 ms early. `beats_land_on_the_clicks` pins it.
//!
//! **What it does NOT do.** No peak picking: beats are chosen globally by the
//! tracker, not by thresholding this curve.

use crate::spectrum::{HOP, MelSpectrogram, N_FFT, N_MELS};

/// Bands centred at or below this are the "low band" (kick drum, bass).
pub const LOW_BAND_MAX_HZ: f32 = 160.0;

/// Frames the flux is shifted later by (see the module doc).
const ALIGN_FRAMES: usize = N_FFT / (4 * HOP);

/// Both onset envelopes, the same length as the spectrogram.
#[derive(Debug, Clone)]
pub struct Onsets {
    pub full: Vec<f32>,
    pub low: Vec<f32>,
}

/// Spectral flux of `spec`, full band and low band.
pub fn onset_envelopes(spec: &MelSpectrogram) -> Onsets {
    let n = spec.frames;
    let low_bands = spec
        .centres_hz
        .iter()
        .take_while(|&&c| c <= LOW_BAND_MAX_HZ)
        .count()
        .max(1);
    let mut full_raw = vec![0.0f32; n];
    let mut low_raw = vec![0.0f32; n];
    for f in 1..n {
        let (prev, cur) = (spec.frame(f - 1), spec.frame(f));
        let mut sum = 0.0f32;
        let mut low = 0.0f32;
        for b in 0..N_MELS {
            let d = (cur[b] - prev[b]).max(0.0);
            sum += d;
            if b < low_bands {
                low += d;
            }
        }
        full_raw[f] = sum / N_MELS as f32;
        low_raw[f] = low / low_bands as f32;
    }
    Onsets {
        full: shift_later(&full_raw, ALIGN_FRAMES),
        low: shift_later(&low_raw, ALIGN_FRAMES),
    }
}

/// `x` delayed by `by` frames, zero-filled at the front, same length.
fn shift_later(x: &[f32], by: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; x.len()];
    for (i, v) in x.iter().enumerate() {
        if let Some(slot) = out.get_mut(i + by) {
            *slot = *v;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spectrum::{SAMPLE_RATE, frame_rate, mel_spectrogram};

    #[test]
    fn a_click_peaks_on_its_own_frame() {
        let mut x = vec![0.0f32; SAMPLE_RATE as usize];
        let at = SAMPLE_RATE as usize / 2;
        for (i, s) in x[at..at + 200].iter_mut().enumerate() {
            *s = (1.0 - i as f32 / 200.0) * if i % 2 == 0 { 1.0 } else { -1.0 };
        }
        let on = onset_envelopes(&mel_spectrogram(&x).expect("spec"));
        let peak = (0..on.full.len())
            .max_by(|&a, &b| on.full[a].total_cmp(&on.full[b]))
            .expect("frames");
        let peak_secs = peak as f64 / frame_rate();
        assert!(
            (peak_secs - 0.5).abs() <= 1.5 / frame_rate(),
            "peak at {peak_secs}"
        );
    }

    #[test]
    fn shift_is_zero_filled() {
        assert_eq!(shift_later(&[1.0, 2.0, 3.0], 2), vec![0.0, 0.0, 1.0]);
    }
}
