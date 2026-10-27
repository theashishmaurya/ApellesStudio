//! Bars and accents: which beats are downbeats, and how hard each beat hits
//! (D-413).
//!
//! **Downbeats.** With the meter given (4 by default; 3 for a waltz), the only
//! unknown is the phase: which of the first `meter` beats starts a bar. Each
//! phase is scored by the mean, over the beats it would make downbeats, of two
//! z-scored cues that are classic in the downbeat literature (Goto 2001; Davies
//! & Plumbley 2006):
//!
//! - **low-band onset** at the beat (a kick or a bass note on the one), and
//! - **harmonic change** into the beat: the cosine distance between the mean
//!   mid-band spectrum of the beat interval starting here and the one before
//!   (chords change on bar lines far more often than inside a bar).
//!
//! The best-scoring phase wins. This is a heuristic, not a trained model, and
//! it is said so wherever it is shown: it is right on music that marks its bar
//! lines (most pop, rock, electronic, hip-hop) and can be a beat or two off on
//! music that does not (syncopated, ambient, beat-less). The person, or the
//! agent, can always move by whole beats (`bar N beat M` addressing).
//!
//! **Accent strength.** The onset envelope's maximum within one frame of the
//! beat, divided by the 95th percentile of that value over all beats and
//! clamped to `0..=1`: a relative "how hard does this beat hit in this track".
//! A beat is **strong** when it is a downbeat or its strength is at least
//! [`STRONG_ACCENT`].
//!
//! **What it does NOT do.** No time-signature detection (the meter is a
//! parameter) and no meter changes inside a track.

use crate::spectrum::{MelSpectrogram, N_MELS};

/// Strength at or above which a non-downbeat still counts as a strong beat.
pub const STRONG_ACCENT: f32 = 0.75;

/// Mid band for harmonic change, Hz: above the kick, below the cymbals.
const CHANGE_BAND_HZ: (f32, f32) = (200.0, 4000.0);

/// Index (0-based, into `beats`) of the first downbeat: the bar phase.
pub fn downbeat_phase(
    beats: &[usize],
    low_onset: &[f32],
    spec: &MelSpectrogram,
    meter: usize,
) -> usize {
    if meter < 2 || beats.len() < meter {
        return 0;
    }
    let low: Vec<f64> = beats
        .iter()
        .map(|&b| peak_near(low_onset, b) as f64)
        .collect();
    let change = harmonic_change(beats, spec);
    let (low_z, change_z) = (zscores(&low), zscores(&change));
    let mut best_phase = 0;
    let mut best = f64::NEG_INFINITY;
    for phase in 0..meter {
        let picked: Vec<usize> = (phase..beats.len()).step_by(meter).collect();
        if picked.is_empty() {
            continue;
        }
        let score =
            picked.iter().map(|&i| low_z[i] + change_z[i]).sum::<f64>() / picked.len() as f64;
        // Strict `>`: on an exact tie the earliest phase wins, deterministically.
        if score > best {
            best = score;
            best_phase = phase;
        }
    }
    best_phase
}

/// Per-beat accent strength in `0..=1` (see the module doc).
pub fn accent_strengths(beats: &[usize], onset: &[f32]) -> Vec<f32> {
    let raw: Vec<f32> = beats.iter().map(|&b| peak_near(onset, b)).collect();
    let mut sorted = raw.clone();
    sorted.sort_by(f32::total_cmp);
    let p95 = sorted
        .get(((sorted.len() as f64 - 1.0) * 0.95).round() as usize)
        .copied()
        .unwrap_or(0.0);
    if p95 <= f32::EPSILON {
        return vec![0.0; raw.len()];
    }
    raw.iter().map(|&v| (v / p95).clamp(0.0, 1.0)).collect()
}

/// The envelope's maximum within one frame either side of `at`.
fn peak_near(env: &[f32], at: usize) -> f32 {
    let lo = at.saturating_sub(1);
    let hi = (at + 1).min(env.len().saturating_sub(1));
    env.get(lo..=hi)
        .map(|w| w.iter().copied().fold(0.0f32, f32::max))
        .unwrap_or(0.0)
}

/// Cosine distance between the mean mid-band spectrum of each beat interval
/// and the previous one; 0 for the first beat.
fn harmonic_change(beats: &[usize], spec: &MelSpectrogram) -> Vec<f64> {
    let bands: Vec<usize> = (0..N_MELS)
        .filter(|&b| {
            let c = spec.centres_hz[b];
            c >= CHANGE_BAND_HZ.0 && c <= CHANGE_BAND_HZ.1
        })
        .collect();
    if bands.is_empty() || spec.frames == 0 {
        return vec![0.0; beats.len()];
    }
    // dB values are negative; shift each so the quietest is 0 and the vector
    // describes spectral SHAPE, which is what a chord change changes.
    let floor = spec.db.iter().copied().fold(f32::INFINITY, f32::min);
    let mean_of = |from: usize, to: usize| -> Vec<f64> {
        let to = to.min(spec.frames).max(from + 1).min(spec.frames);
        let from = from.min(to.saturating_sub(1));
        let count = (to - from).max(1) as f64;
        bands
            .iter()
            .map(|&b| {
                (from..to)
                    .map(|f| (spec.frame(f)[b] - floor) as f64)
                    .sum::<f64>()
                    / count
            })
            .collect()
    };
    let intervals: Vec<Vec<f64>> = beats
        .iter()
        .enumerate()
        .map(|(i, &b)| {
            let end = beats.get(i + 1).copied().unwrap_or(spec.frames);
            mean_of(b, end)
        })
        .collect();
    (0..beats.len())
        .map(|i| {
            if i == 0 {
                0.0
            } else {
                cosine_distance(&intervals[i - 1], &intervals[i])
            }
        })
        .collect()
}

fn cosine_distance(a: &[f64], b: &[f64]) -> f64 {
    let dot: f64 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let na = a.iter().map(|x| x * x).sum::<f64>().sqrt();
    let nb = b.iter().map(|x| x * x).sum::<f64>().sqrt();
    if na <= f64::EPSILON || nb <= f64::EPSILON {
        0.0
    } else {
        1.0 - dot / (na * nb)
    }
}

fn zscores(x: &[f64]) -> Vec<f64> {
    if x.is_empty() {
        return Vec::new();
    }
    let mean = x.iter().sum::<f64>() / x.len() as f64;
    let std = (x.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / x.len() as f64).sqrt();
    if std <= f64::EPSILON {
        return vec![0.0; x.len()];
    }
    x.iter().map(|v| (v - mean) / std).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strengths_are_relative_and_clamped() {
        let env = vec![0.0, 1.0, 0.0, 0.0, 2.0, 0.0, 0.0, 4.0, 0.0];
        let s = accent_strengths(&[1, 4, 7], &env);
        assert_eq!(s.len(), 3);
        assert!((s[2] - 1.0).abs() < 1e-6);
        assert!(s[0] < s[1] && s[1] < s[2]);
    }

    #[test]
    fn zscore_of_a_constant_is_zero() {
        assert_eq!(zscores(&[3.0, 3.0]), vec![0.0, 0.0]);
    }
}
