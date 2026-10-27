//! Audio and picture evidence the app measures per source file and hands in:
//! where the VAD hears a voice, how loud each stretch is, where the picture
//! cuts. All optional — the analysis is complete from the transcript alone, and
//! each of these only adds tags (and, for the VAD, keeps the dead-air
//! tightening off speech the recogniser missed).
//!
//! **What it does NOT do.** No measuring: decoding, the VAD and scene
//! detection are the app's (`chroma::clipper`), this is the data they produce.

use serde::{Deserialize, Serialize};

/// A half-open stretch of one source, in its own seconds.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Span {
    pub start_secs: f64,
    pub end_secs: f64,
}

/// A loudness envelope: one dBFS value per `hop_secs`, the first hop starting
/// at `start_secs` of the source.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Loudness {
    pub start_secs: f64,
    pub hop_secs: f64,
    pub db: Vec<f32>,
}

/// The quietest a hop is taken to be, dBFS: digital silence would otherwise
/// be minus infinity and swamp every mean.
pub const LOUDNESS_FLOOR_DB: f64 = -90.0;

impl Loudness {
    /// The power mean over `[a, b)`, in dBFS, or `None` when the envelope does
    /// not cover any of it.
    pub fn mean_db(&self, a: f64, b: f64) -> Option<f64> {
        if self.hop_secs <= 0.0 || b <= a {
            return None;
        }
        let first = ((a - self.start_secs) / self.hop_secs).floor().max(0.0) as usize;
        let last = ((b - self.start_secs) / self.hop_secs).ceil().max(0.0) as usize;
        let hops = self.db.get(first..last.min(self.db.len()))?;
        if hops.is_empty() {
            return None;
        }
        let power: f64 = hops
            .iter()
            .map(|&d| 10f64.powf(f64::from(d).max(LOUDNESS_FLOOR_DB) / 10.0))
            .sum::<f64>()
            / hops.len() as f64;
        Some(10.0 * power.log10())
    }
}

/// Everything measured about one source file. `None` = not measured (yet, or
/// at all — an audio-only file has no scene cuts).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SourceEvidence {
    /// Where the VAD hears speech, in order.
    pub speech: Option<Vec<Span>>,
    pub loudness: Option<Loudness>,
    /// Picture cut instants, in order.
    pub scene_cuts: Option<Vec<f64>>,
}

impl SourceEvidence {
    /// Seconds of VAD speech inside `[a, b)`, or `None` without a VAD pass.
    pub fn speech_secs(&self, a: f64, b: f64) -> Option<f64> {
        let speech = self.speech.as_ref()?;
        Some(
            speech
                .iter()
                .map(|s| (s.end_secs.min(b) - s.start_secs.max(a)).max(0.0))
                .sum(),
        )
    }

    /// Picture cuts inside `[a, b)`, or `None` without a scene pass.
    pub fn scene_cuts_in(&self, a: f64, b: f64) -> Option<usize> {
        let cuts = self.scene_cuts.as_ref()?;
        Some(cuts.iter().filter(|&&t| t >= a && t < b).count())
    }
}

/// One stretch a reviewed retake group deletes (D-380 `verified` or
/// `ai_confirmed`), in the source's own seconds. `source` indexes the view's
/// sources. A short must not start or end inside one (it would replay the
/// flub), and one wholly inside a short is cut when it is built.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RetakeCut {
    pub source: usize,
    pub start_secs: f64,
    pub end_secs: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loudness_is_a_power_mean_over_the_covered_hops() {
        let l = Loudness {
            start_secs: 10.0,
            hop_secs: 0.5,
            db: vec![-20.0, -20.0, -10.0, -10.0],
        };
        let all = l.mean_db(10.0, 12.0).expect("covered");
        // Power mean of two -20 and two -10 hops sits nearer the louder half.
        assert!(all > -15.0 && all < -12.0, "{all}");
        assert!((l.mean_db(10.0, 11.0).expect("first second") + 20.0).abs() < 1e-9);
        assert_eq!(l.mean_db(20.0, 21.0), None);
        assert_eq!(l.mean_db(11.0, 11.0), None);
    }

    #[test]
    fn speech_and_scene_queries_say_none_without_a_pass() {
        let none = SourceEvidence::default();
        assert_eq!(none.speech_secs(0.0, 1.0), None);
        assert_eq!(none.scene_cuts_in(0.0, 1.0), None);
        let e = SourceEvidence {
            speech: Some(vec![
                Span {
                    start_secs: 0.0,
                    end_secs: 1.0,
                },
                Span {
                    start_secs: 2.0,
                    end_secs: 3.0,
                },
            ]),
            loudness: None,
            scene_cuts: Some(vec![0.5, 2.5, 9.0]),
        };
        assert!((e.speech_secs(0.5, 2.5).unwrap_or(0.0) - 1.0).abs() < 1e-9);
        assert_eq!(e.scene_cuts_in(0.0, 3.0), Some(2));
    }
}
