//! Beat tracking by dynamic programming (Ellis 2007), the algorithm behind
//! librosa's `beat_track` (D-413).
//!
//! **What it is.** Given the onset envelope and a tempo, choose the sequence
//! of frames that maximises "onset strength at every chosen frame" minus a
//! penalty, `TIGHTNESS · ln(gap / period)²`, for every gap that is not the
//! period. One pass forward fills each frame's best cumulative score and a
//! back-link to the beat before it; the last beat is the last strong local
//! maximum of that score; following the back-links gives the whole grid.
//! Near-silent beats at the very start and end (before the music starts,
//! after it fades) are trimmed, and each beat is refined to a fraction of a
//! frame by a parabola through the smoothed onset score around it.
//!
//! **Where this differs from librosa, on purpose.** librosa trims every end
//! beat below the average beat strength, which drops a quiet intro's beats
//! (a soft piano before the drums come in): exactly where a title reveal is
//! often timed. Here only beats below [`TRIM_FRACTION`] of the RMS beat score
//! are trimmed, i.e. silence. librosa reports whole frames; the sub-frame
//! refinement is ours (its hop is 23 ms, ours 11.6 ms, and still a beat should
//! not wobble by a frame between bars at 30 fps).
//!
//! The result is a grid that follows tempo drift and rubato within the
//! penalty, snaps to real onsets, and keeps counting through a bar of silence
//! (the penalty prefers the period over a gap, which is what a musician does).
//!
//! **What it does NOT do.** No tempo estimate of its own (it is handed one),
//! no downbeats (that is [`crate::meter`]).

/// How strongly the grid prefers the period over following onsets (librosa's
/// default `tightness`).
pub const TIGHTNESS: f64 = 100.0;

/// End beats scoring below this fraction of the RMS beat score are trimmed.
pub const TRIM_FRACTION: f64 = 0.1;

/// The tracked grid: integer frames (for indexing envelopes) and the refined
/// fractional positions (for reporting times), ascending, the same length.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TrackedBeats {
    pub frames: Vec<usize>,
    pub positions: Vec<f64>,
}

/// The chosen beats. Empty when the envelope is silent.
pub fn track_beats(onset: &[f32], frame_rate: f64, bpm: f64) -> TrackedBeats {
    let n = onset.len();
    if n == 0 || !bpm.is_finite() || bpm <= 0.0 {
        return TrackedBeats::default();
    }
    let period = 60.0 * frame_rate / bpm;
    if period < 1.0 {
        return TrackedBeats::default();
    }

    // Normalise by the standard deviation (librosa does the same) so the
    // penalty's scale does not depend on how loud the track is.
    let mean = onset.iter().map(|&v| v as f64).sum::<f64>() / n as f64;
    let var = onset
        .iter()
        .map(|&v| (v as f64 - mean).powi(2))
        .sum::<f64>()
        / n as f64;
    let std = var.sqrt();
    if std <= f64::EPSILON {
        return TrackedBeats::default();
    }
    let norm: Vec<f64> = onset.iter().map(|&v| v as f64 / std).collect();

    let local = local_score(&norm, period);
    let local_max = local.iter().copied().fold(f64::NEG_INFINITY, f64::max);

    // Admissible gaps to the previous beat: half a period to two periods.
    let lo = (period / 2.0).round().max(1.0) as usize;
    let hi = (2.0 * period).round() as usize;
    let mut cum = vec![0.0f64; n];
    let mut back: Vec<Option<usize>> = vec![None; n];
    let mut first_beat = true;
    for i in 0..n {
        let mut best = f64::NEG_INFINITY;
        let mut best_prev = None;
        for gap in lo..=hi {
            let penalty = -TIGHTNESS * (gap as f64 / period).ln().powi(2);
            let candidate = match i.checked_sub(gap) {
                Some(p) => cum[p] + penalty,
                None => penalty,
            };
            if candidate > best {
                best = candidate;
                best_prev = i.checked_sub(gap);
            }
        }
        cum[i] = local[i] + best;
        if first_beat && local[i] < 0.01 * local_max {
            back[i] = None;
        } else {
            back[i] = best_prev;
            first_beat = false;
        }
    }

    let Some(tail) = last_beat(&cum) else {
        return TrackedBeats::default();
    };
    let mut beats = vec![tail];
    let mut at = tail;
    while let Some(prev) = back[at] {
        beats.push(prev);
        at = prev;
    }
    beats.reverse();
    let frames = trim_weak_ends(&local, beats);
    let positions = frames.iter().map(|&f| refine(&local, f)).collect();
    TrackedBeats { frames, positions }
}

/// The vertex of the parabola through `local` at `f - 1, f, f + 1`, clamped to
/// half a frame either way (the frame itself at an edge or a flat top).
fn refine(local: &[f64], f: usize) -> f64 {
    if f == 0 || f + 1 >= local.len() {
        return f as f64;
    }
    let (a, b, c) = (local[f - 1], local[f], local[f + 1]);
    let denom = a - 2.0 * b + c;
    if denom >= -f64::EPSILON {
        return f as f64;
    }
    f as f64 + (0.5 * (a - c) / denom).clamp(-0.5, 0.5)
}

/// The onset envelope smoothed by a Gaussian a period wide (σ = period / 32),
/// so a beat is scored by the onset energy right around it.
fn local_score(norm: &[f64], period: f64) -> Vec<f64> {
    let half = period.round() as isize;
    let kernel: Vec<f64> = (-half..=half)
        .map(|k| (-0.5 * (k as f64 * 32.0 / period).powi(2)).exp())
        .collect();
    let n = norm.len() as isize;
    (0..n)
        .map(|i| {
            let mut acc = 0.0;
            for (j, w) in kernel.iter().enumerate() {
                let src = i + j as isize - half;
                if (0..n).contains(&src) {
                    acc += w * norm[src as usize];
                }
            }
            acc
        })
        .collect()
}

/// The last frame whose cumulative score is a local maximum above half the
/// median of all such maxima (librosa's `__last_beat`).
fn last_beat(cum: &[f64]) -> Option<usize> {
    let n = cum.len();
    let is_max = |i: usize| -> bool {
        let left = i == 0 || cum[i] > cum[i - 1];
        let right = i + 1 >= n || cum[i] >= cum[i + 1];
        left && right
    };
    let mut maxima: Vec<f64> = (0..n).filter(|&i| is_max(i)).map(|i| cum[i]).collect();
    if maxima.is_empty() {
        return None;
    }
    maxima.sort_by(f64::total_cmp);
    let median = maxima[maxima.len() / 2];
    (0..n).rev().find(|&i| is_max(i) && 2.0 * cum[i] > median)
}

/// Drops leading and trailing beats whose local score is below
/// [`TRIM_FRACTION`] of the RMS local score over all beats.
fn trim_weak_ends(local: &[f64], beats: Vec<usize>) -> Vec<usize> {
    if beats.is_empty() {
        return beats;
    }
    let at: Vec<f64> = beats.iter().map(|&b| local[b]).collect();
    let rms = (at.iter().map(|v| v * v).sum::<f64>() / at.len() as f64).sqrt();
    let threshold = TRIM_FRACTION * rms;
    let first = at.iter().position(|&v| v > threshold);
    let last = at.iter().rposition(|&v| v > threshold);
    match (first, last) {
        (Some(a), Some(b)) if a <= b => beats[a..=b].to_vec(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pulse_env(period: f64, start: f64, n: usize) -> Vec<f32> {
        let mut v = vec![0.0f32; n];
        let mut t = start;
        while (t.round() as usize) < n {
            v[t.round() as usize] = 1.0;
            t += period;
        }
        v
    }

    #[test]
    fn tracks_every_pulse_of_a_steady_train() {
        let fr = 86.1328125;
        let period = 60.0 * fr / 120.0; // 43.07 frames
        let env = pulse_env(period, 20.0, 2000);
        let beats = track_beats(&env, fr, 120.0).frames;
        let truth: Vec<usize> = (0..)
            .map(|k| (20.0 + k as f64 * period).round() as usize)
            .take_while(|&f| f < 2000)
            .collect();
        assert_eq!(beats.len(), truth.len(), "{beats:?}");
        for (b, t) in beats.iter().zip(&truth) {
            assert!((*b as isize - *t as isize).abs() <= 1, "{b} vs {t}");
        }
    }

    #[test]
    fn keeps_counting_through_a_missing_beat() {
        let fr = 86.1328125;
        let period = 60.0 * fr / 100.0;
        let mut env = pulse_env(period, 10.0, 2500);
        // Silence one pulse in the middle.
        let gap = (10.0 + 12.0 * period).round() as usize;
        env[gap] = 0.0;
        let beats = track_beats(&env, fr, 100.0).frames;
        assert!(
            beats
                .iter()
                .any(|&b| (b as isize - gap as isize).abs() <= 1),
            "no beat near {gap}"
        );
    }

    #[test]
    fn silence_gives_no_beats() {
        assert!(track_beats(&vec![0.0; 1000], 86.0, 120.0).frames.is_empty());
    }
}
