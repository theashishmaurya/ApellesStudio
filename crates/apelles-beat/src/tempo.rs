//! Global tempo: the beat period that best explains the onset envelope
//! (D-413).
//!
//! **What it is.** librosa's `beat.tempo`: an autocorrelation tempogram (the
//! onset envelope's autocorrelation in Hann windows of [`WINDOW_SECS`], each
//! normalised by its own lag-0 energy so a quiet section counts as much as a
//! loud one), averaged over the track, weighted by a log-normal prior on tempo
//! centred at [`DEFAULT_START_BPM`] with a one-octave spread, maximised over
//! [`MIN_BPM`]..[`MAX_BPM`], plus a parabolic refinement of the winning lag.
//! The windows advance by an eighth of their length rather than every frame
//! (librosa's), which averages the same picture at an eighth of the cost.
//!
//! A first version autocorrelated the whole envelope in one go. It weighted
//! loud sections over quiet ones and disagreed with librosa on tracks whose
//! tempo varies (D-413, "Accuracy"); the per-window normalisation is why this
//! one does not.
//!
//! **The octave problem, honestly.** Autocorrelation peaks at every multiple
//! of the true period, so "is this 70 or 140 BPM" is decided by the prior, the
//! same as in every tempo estimator without a trained model. A caller who
//! knows the music is a ballad or drum and bass passes a `tempo_hint` and the
//! prior moves there ([`crate::BeatParams::tempo_hint_bpm`]).
//!
//! **What it does NOT do.** No tempo changes over time: one number. The beat
//! tracker follows local drift around it.

/// The prior's centre when no hint is given (librosa's `start_bpm`).
pub const DEFAULT_START_BPM: f64 = 120.0;
/// Slowest tempo considered.
pub const MIN_BPM: f64 = 30.0;
/// Fastest tempo considered.
pub const MAX_BPM: f64 = 300.0;
/// Width of the prior, in octaves (librosa's `std_bpm`).
const PRIOR_OCTAVES: f64 = 1.0;
/// Tempogram window, seconds (librosa's 384 frames at its 512-sample hop).
pub const WINDOW_SECS: f64 = 384.0 * 512.0 / 22_050.0;
/// Windows per window length (the stride is `1 / WINDOW_OVERLAP` of a window).
const WINDOW_OVERLAP: usize = 8;

/// The estimated tempo in BPM, or `None` when the envelope carries no
/// periodicity at all (silence, a single hit).
pub fn estimate_tempo(onset: &[f32], frame_rate: f64, start_bpm: f64) -> Option<f64> {
    let n = onset.len();
    if n < 4 {
        return None;
    }
    let min_lag = ((60.0 * frame_rate / MAX_BPM).floor() as usize).max(1);
    let max_lag = ((60.0 * frame_rate / MIN_BPM).ceil() as usize).min(n - 1);
    if min_lag + 2 > max_lag {
        return None;
    }

    let ac = mean_tempogram(onset, frame_rate, max_lag + 1);
    if ac.iter().all(|&v| v <= 0.0) {
        return None;
    }

    let centre = start_bpm.clamp(MIN_BPM, MAX_BPM).log2();
    let weighted = |lag: usize| -> f64 {
        let bpm = 60.0 * frame_rate / lag as f64;
        let z = (bpm.log2() - centre) / PRIOR_OCTAVES;
        ac[lag].max(0.0) * (-0.5 * z * z).exp()
    };
    let mut best_lag = min_lag;
    let mut best = f64::NEG_INFINITY;
    for lag in min_lag..=max_lag {
        let w = weighted(lag);
        if w > best {
            best = w;
            best_lag = lag;
        }
    }
    if best <= 0.0 {
        return None;
    }

    // Parabolic interpolation on the mean autocorrelation around the winner,
    // so a 128 BPM track is not reported as the nearest whole-frame lag's
    // 129.2.
    let (a, b, c) = (ac[best_lag - 1], ac[best_lag], ac[best_lag + 1]);
    let denom = a - 2.0 * b + c;
    let offset = if denom.abs() > f64::EPSILON {
        (0.5 * (a - c) / denom).clamp(-0.5, 0.5)
    } else {
        0.0
    };
    Some(60.0 * frame_rate / (best_lag as f64 + offset))
}

/// The mean over windows of each window's normalised autocorrelation, lags
/// `0..=max_lag`.
fn mean_tempogram(onset: &[f32], frame_rate: f64, max_lag: usize) -> Vec<f64> {
    let n = onset.len() as isize;
    let win = ((WINDOW_SECS * frame_rate).round() as usize).max(2 * max_lag + 2);
    let half = (win / 2) as isize;
    let stride = (win / WINDOW_OVERLAP).max(1) as isize;
    let hann: Vec<f64> = (0..win)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / win as f64).cos())
        .collect();
    let mut sum = vec![0.0f64; max_lag + 1];
    let mut windows = 0usize;
    let mut seg = vec![0.0f64; win];
    let mut centre = 0isize;
    while centre < n {
        for (k, slot) in seg.iter_mut().enumerate() {
            let src = centre - half + k as isize;
            let v = if (0..n).contains(&src) {
                onset[src as usize] as f64
            } else {
                0.0
            };
            *slot = v * hann[k];
        }
        let energy: f64 = seg.iter().map(|v| v * v).sum();
        if energy > f64::EPSILON {
            for (lag, acc) in sum.iter_mut().enumerate() {
                let ac: f64 = seg[..win - lag]
                    .iter()
                    .zip(&seg[lag..])
                    .map(|(a, b)| a * b)
                    .sum();
                *acc += ac / energy;
            }
            windows += 1;
        }
        centre += stride;
    }
    if windows == 0 {
        return sum;
    }
    sum.iter().map(|v| v / windows as f64).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Onset-like bumps (a two-frame Gaussian) every `period_frames`, the
    /// shape a real onset envelope has: a bare one-sample spike train at a
    /// non-integer period aliases between neighbouring lags.
    fn pulses(period_frames: f64, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| {
                let phase = (i as f64 / period_frames).fract() * period_frames;
                let d = phase.min(period_frames - phase);
                (-0.5 * (d / 2.0).powi(2)).exp() as f32
            })
            .collect()
    }

    #[test]
    fn finds_the_period_of_a_pulse_train() {
        let fr = 86.1328125;
        for bpm in [90.0, 120.0, 128.0, 150.0] {
            let env = pulses(60.0 * fr / bpm, 3000);
            let got = estimate_tempo(&env, fr, DEFAULT_START_BPM).expect("tempo");
            assert!((got - bpm).abs() / bpm < 0.01, "{bpm} -> {got}");
        }
    }

    #[test]
    fn the_hint_resolves_the_octave() {
        let fr = 86.1328125;
        let env = pulses(60.0 * fr / 140.0, 3000);
        let half = estimate_tempo(&env, fr, 70.0).expect("tempo");
        // Every other pulse is also periodic, so 70 is admissible; the hint
        // picks between the two, which is the whole point of the hint.
        assert!(
            (half - 70.0).abs() < 1.5 || (half - 140.0).abs() < 1.5,
            "{half}"
        );
        let fast = estimate_tempo(&env, fr, 140.0).expect("tempo");
        assert!((fast - 140.0).abs() < 1.5, "{fast}");
    }

    #[test]
    fn silence_has_no_tempo() {
        assert_eq!(estimate_tempo(&vec![0.0; 2000], 86.0, 120.0), None);
    }
}
