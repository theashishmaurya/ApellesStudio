//! Waveform loudness envelope in dBFS (B-327, D-428).
//!
//! **What this is.** The measurement half of "audio is the authority": a
//! per-hop RMS level, in decibels relative to full scale, of the decoded audio
//! of one analysed range. The Edit tab's silence detector reads it to (a) find
//! silences straight from the waveform (`basis: "energy"`) and (b) correct a
//! transcribed word whose timestamp sits over measured silence, before any
//! word-aware trimming.
//!
//! **What it does NOT do.** It chooses no threshold, finds no silence and reads
//! no transcript. Those decisions are knob-driven (`threshold_db`,
//! `auto_threshold`, `merge_gap_ms`, ...) and live in `@apelles/editor`
//! (`silenceAudio.ts`), where an agent can vary them per call without the audio
//! being decoded again — this crate only hands over the envelope.
//!
//! Deterministic by construction: plain `f64` sums in a fixed order, no
//! parallelism, no randomness — same samples, same envelope.

use crate::dark::rms_envelope;

/// Seconds per envelope entry. 20 ms resolves the attack of a word and the end
/// of its decay while keeping an hour of audio at 180 000 numbers.
pub const ENERGY_HOP_SECS: f64 = 0.02;

/// Level reported for digital silence (RMS of exactly 0), instead of `-inf`,
/// which would not survive JSON.
pub const ENERGY_FLOOR_DB: f32 = -100.0;

/// Per-hop RMS level of `samples` in dBFS (full-scale sine ≈ −3 dB, a full-scale
/// square wave 0 dB), one entry per `hop_secs`, never below
/// [`ENERGY_FLOOR_DB`]. Empty for empty input or a non-positive hop.
pub fn rms_db_envelope(samples: &[f32], sample_rate: u32, hop_secs: f64) -> Vec<f32> {
    rms_envelope(samples, sample_rate, hop_secs)
        .into_iter()
        .map(|rms| {
            if rms <= 0.0 {
                ENERGY_FLOOR_DB
            } else {
                (20.0 * rms.log10()).max(ENERGY_FLOOR_DB)
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 16_000;

    /// A sine of `amp` for `secs` seconds.
    fn tone(amp: f32, secs: f64) -> Vec<f32> {
        (0..(secs * RATE as f64) as usize)
            .map(|i| amp * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / RATE as f32).sin())
            .collect()
    }

    #[test]
    fn tone_then_silence_reads_loud_then_floor() {
        let mut audio = tone(0.5, 1.0);
        audio.extend(std::iter::repeat_n(0.0, RATE as usize));
        let env = rms_db_envelope(&audio, RATE, ENERGY_HOP_SECS);
        assert_eq!(env.len(), 100);
        // A 0.5-amplitude sine has RMS 0.5/sqrt(2): about -9 dBFS.
        assert!((env[10] - -9.03).abs() < 0.2, "got {}", env[10]);
        assert_eq!(env[60], ENERGY_FLOOR_DB);
    }

    #[test]
    fn quiet_noise_sits_between_tone_and_floor() {
        let audio = tone(0.003, 0.5);
        let env = rms_db_envelope(&audio, RATE, ENERGY_HOP_SECS);
        assert!(env.iter().all(|&d| d < -45.0 && d > -60.0), "{env:?}");
    }

    #[test]
    fn same_input_same_envelope() {
        let audio = tone(0.2, 0.7);
        assert_eq!(
            rms_db_envelope(&audio, RATE, ENERGY_HOP_SECS),
            rms_db_envelope(&audio, RATE, ENERGY_HOP_SECS)
        );
    }

    #[test]
    fn degenerate_input_is_empty() {
        assert!(rms_db_envelope(&[], RATE, ENERGY_HOP_SECS).is_empty());
        assert!(rms_db_envelope(&[0.1], RATE, 0.0).is_empty());
        assert!(rms_db_envelope(&[0.1], 0, ENERGY_HOP_SECS).is_empty());
    }
}
