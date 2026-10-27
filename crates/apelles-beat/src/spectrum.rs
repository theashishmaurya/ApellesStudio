//! Log-mel spectrogram: the one time–frequency picture every other module
//! reads (D-413).
//!
//! **What it is.** A centred short-time Fourier transform (Hann window,
//! [`N_FFT`]-point, hop [`HOP`], zero padding of half a window at both ends),
//! power spectrum, a Slaney-style mel filterbank of [`N_MELS`] bands from 0 Hz
//! to Nyquist, then decibels with an 80 dB floor below the loudest cell. These
//! are librosa's `melspectrogram` + `power_to_db` defaults, chosen so the
//! onset envelope built on top behaves like the reference implementation it is
//! measured against (D-413, "Accuracy").
//!
//! **What it does NOT do.** No decoding and no resampling: it takes mono PCM
//! already at [`SAMPLE_RATE`]. No onset or beat logic.
//!
//! **Determinism.** Every loop runs in a fixed order over fixed-size buffers;
//! the FFT plan depends only on [`N_FFT`]. The same samples give the same
//! bits on the same machine, which is what the cache and the render-path rule
//! need (a beat grid is an input to keyframe times).

use realfft::RealFftPlanner;

use crate::BeatError;

/// The rate analysis runs at. 22.05 kHz keeps everything a beat lives in (kick
/// fundamentals to hi-hat transients) and halves the work of 44.1 kHz.
pub const SAMPLE_RATE: u32 = 22_050;
/// Window length in samples (~93 ms): long enough to resolve a kick's pitch.
pub const N_FFT: usize = 2048;
/// Hop in samples (~11.6 ms, 86 frames a second). Half librosa's default, so a
/// beat lands within a quarter of a 30 fps video frame of where it was heard.
pub const HOP: usize = 256;
/// Mel bands.
pub const N_MELS: usize = 128;
/// Below this the dB value is floored (librosa's `amin`).
const AMIN: f32 = 1e-10;
/// Dynamic range kept below the loudest cell (librosa's `top_db`).
const TOP_DB: f32 = 80.0;

/// Frames per second of every envelope derived from the spectrogram.
pub fn frame_rate() -> f64 {
    SAMPLE_RATE as f64 / HOP as f64
}

/// `frames × N_MELS` decibel values, row-major by frame.
#[derive(Debug, Clone)]
pub struct MelSpectrogram {
    pub frames: usize,
    pub db: Vec<f32>,
    /// Centre frequency of each band, Hz.
    pub centres_hz: Vec<f32>,
}

impl MelSpectrogram {
    /// One frame's bands.
    pub fn frame(&self, f: usize) -> &[f32] {
        &self.db[f * N_MELS..(f + 1) * N_MELS]
    }
}

/// Slaney's mel scale (linear below 1 kHz, logarithmic above), as librosa's
/// default `htk=False`.
fn hz_to_mel(hz: f64) -> f64 {
    let f_sp = 200.0 / 3.0;
    let min_log_hz = 1000.0;
    let min_log_mel = min_log_hz / f_sp;
    let logstep = (6.4f64).ln() / 27.0;
    if hz >= min_log_hz {
        min_log_mel + (hz / min_log_hz).ln() / logstep
    } else {
        hz / f_sp
    }
}

fn mel_to_hz(mel: f64) -> f64 {
    let f_sp = 200.0 / 3.0;
    let min_log_hz = 1000.0;
    let min_log_mel = min_log_hz / f_sp;
    let logstep = (6.4f64).ln() / 27.0;
    if mel >= min_log_mel {
        min_log_hz * (logstep * (mel - min_log_mel)).exp()
    } else {
        f_sp * mel
    }
}

/// One triangular filter: its first FFT bin and the weights from there on
/// (every bin outside is zero, so it is never multiplied).
struct MelFilter {
    first_bin: usize,
    weights: Vec<f32>,
}

/// Triangular filters, area-normalised ("slaney" norm), stored sparsely: a
/// dense `N_MELS × (N_FFT/2 + 1)` product was 98 % multiplications by zero and
/// most of the analysis time.
fn mel_filterbank() -> (Vec<MelFilter>, Vec<f32>) {
    let n_bins = N_FFT / 2 + 1;
    let sr = SAMPLE_RATE as f64;
    let fft_freqs: Vec<f64> = (0..n_bins).map(|k| k as f64 * sr / N_FFT as f64).collect();
    let mel_max = hz_to_mel(sr / 2.0);
    let edges: Vec<f64> = (0..N_MELS + 2)
        .map(|i| mel_to_hz(mel_max * i as f64 / (N_MELS + 1) as f64))
        .collect();
    let mut bank = Vec::with_capacity(N_MELS);
    let mut centres = Vec::with_capacity(N_MELS);
    for m in 0..N_MELS {
        let (lo, mid, hi) = (edges[m], edges[m + 1], edges[m + 2]);
        let enorm = 2.0 / (hi - lo);
        let row: Vec<f32> = fft_freqs
            .iter()
            .map(|&f| {
                let up = (f - lo) / (mid - lo);
                let down = (hi - f) / (hi - mid);
                (up.min(down).max(0.0) * enorm) as f32
            })
            .collect();
        let first_bin = row.iter().position(|&w| w > 0.0).unwrap_or(0);
        let last_bin = row.iter().rposition(|&w| w > 0.0).unwrap_or(0);
        let weights = if last_bin >= first_bin && row[first_bin] > 0.0 {
            row[first_bin..=last_bin].to_vec()
        } else {
            Vec::new()
        };
        bank.push(MelFilter { first_bin, weights });
        centres.push(mid as f32);
    }
    (bank, centres)
}

/// A periodic Hann window (librosa's `get_window('hann', n, fftbins=True)`).
fn hann(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| {
            let x = std::f64::consts::PI * 2.0 * i as f64 / n as f64;
            (0.5 - 0.5 * x.cos()) as f32
        })
        .collect()
}

/// The log-mel spectrogram of `samples` (mono, [`SAMPLE_RATE`]).
///
/// Frame `f` is centred on sample `f * HOP`, so it describes time
/// `f / frame_rate()` seconds. An empty input gives zero frames.
pub fn mel_spectrogram(samples: &[f32]) -> Result<MelSpectrogram, BeatError> {
    if samples.is_empty() {
        return Ok(MelSpectrogram {
            frames: 0,
            db: Vec::new(),
            centres_hz: mel_filterbank().1,
        });
    }
    let half = N_FFT / 2;
    let mut padded = vec![0.0f32; samples.len() + 2 * half];
    padded[half..half + samples.len()].copy_from_slice(samples);
    let frames = 1 + samples.len() / HOP;

    let window = hann(N_FFT);
    let (bank, centres_hz) = mel_filterbank();
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(N_FFT);
    let mut input = fft.make_input_vec();
    let mut spectrum = fft.make_output_vec();
    let mut power = vec![0.0f32; N_FFT / 2 + 1];

    let mut mel = vec![0.0f32; frames * N_MELS];
    for f in 0..frames {
        let start = f * HOP;
        for (i, slot) in input.iter_mut().enumerate() {
            *slot = padded.get(start + i).copied().unwrap_or(0.0) * window[i];
        }
        fft.process(&mut input, &mut spectrum)
            .map_err(|e| BeatError::Analysis(format!("fft: {e}")))?;
        for (p, c) in power.iter_mut().zip(spectrum.iter()) {
            *p = c.re * c.re + c.im * c.im;
        }
        let row = &mut mel[f * N_MELS..(f + 1) * N_MELS];
        for (m, filter) in bank.iter().enumerate() {
            row[m] = filter
                .weights
                .iter()
                .zip(&power[filter.first_bin..])
                .map(|(w, p)| w * p)
                .sum();
        }
    }

    let mut db: Vec<f32> = mel.iter().map(|&v| 10.0 * v.max(AMIN).log10()).collect();
    let peak = db.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let floor = peak - TOP_DB;
    for v in &mut db {
        if *v < floor {
            *v = floor;
        }
    }
    Ok(MelSpectrogram {
        frames,
        db,
        centres_hz,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mel_scale_round_trips() {
        for hz in [0.0, 120.0, 999.0, 1000.0, 4000.0, 11025.0] {
            let back = mel_to_hz(hz_to_mel(hz));
            assert!((back - hz).abs() < 1e-6, "{hz} -> {back}");
        }
    }

    #[test]
    fn a_pure_tone_lands_in_the_band_around_its_frequency() {
        let n = SAMPLE_RATE as usize;
        let tone: Vec<f32> = (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / SAMPLE_RATE as f32).sin())
            .collect();
        let spec = mel_spectrogram(&tone).expect("spectrogram");
        let mid = spec.frame(spec.frames / 2);
        let loudest = (0..N_MELS)
            .max_by(|&a, &b| mid[a].total_cmp(&mid[b]))
            .expect("bands");
        let centre = spec.centres_hz[loudest];
        assert!(
            (centre - 440.0).abs() < 40.0,
            "loudest band centred at {centre} Hz"
        );
    }

    #[test]
    fn frame_count_and_empty_input() {
        assert_eq!(mel_spectrogram(&[]).expect("empty").frames, 0);
        let spec = mel_spectrogram(&vec![0.0; HOP * 10]).expect("silence");
        assert_eq!(spec.frames, 11);
    }
}
