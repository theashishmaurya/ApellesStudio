//! Silero VAD — the acoustic "is anyone talking right now" model (D-318/D-319).
//!
//! **What this is.** A thin, stateful runner for silero-vad's released ONNX
//! export: 16 kHz mono `f32` samples in, one speech probability per 512-sample
//! hop out. [`crate::silence`] turns that probability track into spans; this
//! module does nothing but drive the model correctly.
//!
//! **What it does NOT do.** It does not decode audio (the caller hands it PCM —
//! `apelles-media` owns decode and resampling), it does not download or locate
//! the model file (the app does, by the same hash-verified pattern as every
//! other ONNX model here — see `ai_processing.rs`), and it has no opinion about
//! timelines or clips.
//!
//! ## The 64-sample context is mandatory, and this is not optional trivia
//!
//! Silero's ONNX graph takes `input` as `[batch, samples]`, and from v5.1
//! onwards the Python wrapper feeds it **64 samples of the previous window
//! followed by the current 512**, i.e. 576 values per step, carrying the tail
//! of each window forward as the next one's context.
//!
//! v5's export tolerated being fed a bare 512-sample window — it produced
//! slightly different but still usable probabilities. **v6's does not.**
//! Measured on a real speech clip while pinning this dependency (D-319):
//!
//! | model | input | frames scored as speech |
//! |---|---|---|
//! | v5.1.2 | bare 512 | 100 / 164 |
//! | v5.1.2 | 64 + 512 | 101 / 164 |
//! | v6.2.1 | bare 512 | **0 / 164** |
//! | v6.2.1 | 64 + 512 | 102 / 164 |
//!
//! A bare window through v6 does not error — it returns probabilities pinned
//! near 0.001, so *everything* reads as silence and a caller would cheerfully
//! delete the entire clip. That failure is silent, which is exactly why it is
//! written down here and covered by [`CONTEXT_SAMPLES`] rather than left as a
//! magic `64` in the loop.

use std::path::Path;

use ndarray::{Array, Array0, Ix2, Ix3};
use ort::session::Session;
use ort::value::Tensor;

use crate::silence::{SilenceParams, Span, silence_spans};

/// The exact model artifact this runner is written against: silero-vad's own
/// released ONNX export, at a pinned upstream tag.
///
/// This is the **upstream repository's own file**, not a re-host or a
/// hand-converted PyTorch checkpoint (D-319). The app fetches it lazily on
/// first use and verifies [`MODEL_SHA256`] before loading it, the same
/// download-once-verify-always pattern `ai_processing.rs` uses for the other
/// seven ONNX models. Moving the pin means re-deriving the hash from the new
/// tag's own file — never hand-edit one of these two constants alone.
pub const MODEL_URL: &str = "https://raw.githubusercontent.com/snakers4/silero-vad/v6.2.1/src/silero_vad/data/silero_vad.onnx";

/// On-disk name for [`MODEL_URL`], versioned so a future re-pin cannot be
/// mistaken for a corrupt copy of this one.
pub const MODEL_FILENAME: &str = "silero_vad_v6.2.1.onnx";

/// sha256 of [`MODEL_URL`] (2,327,524 bytes).
pub const MODEL_SHA256: &str = "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3";

/// The only sample rate this runner uses. Silero's export also accepts 8 kHz,
/// but a second rate would mean a second window size and a second frame
/// duration for no benefit — everything upstream of here can resample.
pub const SAMPLE_RATE: u32 = 16_000;

/// Samples per inference step. Fixed by the model at 16 kHz.
pub const WINDOW_SAMPLES: usize = 512;

/// Samples of the previous window prepended to each input. See the module doc —
/// getting this wrong is silent and catastrophic on v6.
pub const CONTEXT_SAMPLES: usize = 64;

/// Seconds of audio per probability, i.e. the resolution of every span this
/// crate produces. 512 / 16000 = 0.032.
pub const FRAME_SECS: f64 = WINDOW_SAMPLES as f64 / SAMPLE_RATE as f64;

/// Width of the model's recurrent state: `[2, batch, 128]`.
const STATE_WIDTH: usize = 128;

#[derive(Debug, thiserror::Error)]
pub enum VadError {
    #[error("could not load the Silero VAD model at {path}: {source}")]
    Load {
        path: String,
        source: Box<ort::Error>,
    },
    #[error("Silero VAD inference failed: {0}")]
    Inference(Box<ort::Error>),
    #[error("Silero VAD returned a malformed output tensor: {0}")]
    Output(String),
}

/// A loaded Silero VAD session.
///
/// Loading is the expensive part (a few MB of graph); scoring is cheap. Hold
/// one of these and reuse it — the app keeps exactly one behind a `Mutex`, the
/// same shape `ai_processing.rs` uses for every other ONNX model.
pub struct SileroVad {
    session: Session,
}

impl SileroVad {
    /// Load the model from an on-disk `.onnx` file.
    ///
    /// The caller is responsible for that file being the *verified* artifact —
    /// this runner has no way to tell a good graph from a substituted one, so
    /// the sha256 check lives at the download site (D-319).
    pub fn open(model_path: &Path) -> Result<Self, VadError> {
        // Establish the global ORT environment before building a session, the
        // same way `ai_processing.rs` does for every other model here. The
        // result is deliberately discarded: after the first call this reports
        // "already initialised", which is the normal case and not an error.
        let _ = ort::init().with_name("Apelles-VAD").commit();

        let session = Session::builder()
            .and_then(|b| b.commit_from_file(model_path))
            .map_err(|source| VadError::Load {
                path: model_path.display().to_string(),
                source: Box::new(source),
            })?;
        Ok(Self { session })
    }

    /// One speech probability per [`WINDOW_SAMPLES`] hop of `samples`.
    ///
    /// `samples` must be mono `f32` at [`SAMPLE_RATE`]. A trailing partial
    /// window is not scored — it is under 32 ms and cannot change any span
    /// decision — which is why [`silences`] is told the true duration
    /// separately rather than inferring it from the probability count.
    ///
    /// The recurrent state is local to this call, so successive calls are
    /// independent and the same input always yields the same output.
    pub fn speech_probabilities(&mut self, samples: &[f32]) -> Result<Vec<f32>, VadError> {
        if samples.len() < WINDOW_SAMPLES {
            return Ok(Vec::new());
        }

        let frames = samples.len() / WINDOW_SAMPLES;
        let mut probs = Vec::with_capacity(frames);
        let mut state = Array::<f32, Ix3>::zeros((2, 1, STATE_WIDTH));
        let mut context = [0.0_f32; CONTEXT_SAMPLES];
        let mut input = Array::<f32, Ix2>::zeros((1, CONTEXT_SAMPLES + WINDOW_SAMPLES));

        for f in 0..frames {
            let window = &samples[f * WINDOW_SAMPLES..(f + 1) * WINDOW_SAMPLES];
            for (i, v) in context.iter().chain(window.iter()).enumerate() {
                input[[0, i]] = *v;
            }

            let t_input = Tensor::from_array(input.clone()).map_err(boxed_inference)?;
            let t_state = Tensor::from_array(state.clone()).map_err(boxed_inference)?;
            let t_sr = Tensor::from_array(Array0::from_elem((), SAMPLE_RATE as i64))
                .map_err(boxed_inference)?;

            let outputs = self
                .session
                .run(ort::inputs!["input" => t_input, "state" => t_state, "sr" => t_sr])
                .map_err(boxed_inference)?;

            let prob = outputs["output"]
                .try_extract_array::<f32>()
                .map_err(|e| VadError::Output(e.to_string()))?
                .iter()
                .next()
                .copied()
                .ok_or_else(|| VadError::Output("`output` was empty".to_string()))?;
            probs.push(prob);

            let next = outputs["stateN"]
                .try_extract_array::<f32>()
                .map_err(|e| VadError::Output(e.to_string()))?
                .to_owned();
            state = next
                .into_shape_with_order((2, 1, STATE_WIDTH))
                .map_err(|e| {
                    VadError::Output(format!("`stateN` was not [2,1,{STATE_WIDTH}]: {e}"))
                })?;

            // Carry this window's tail forward as the next step's context.
            context.copy_from_slice(&window[WINDOW_SAMPLES - CONTEXT_SAMPLES..]);
        }

        Ok(probs)
    }

    /// The silences in `samples` — [`speech_probabilities`] fed straight into
    /// [`silence_spans`]. The convenience the app actually calls.
    ///
    /// [`speech_probabilities`]: Self::speech_probabilities
    pub fn silences(&mut self, samples: &[f32], p: &SilenceParams) -> Result<Vec<Span>, VadError> {
        let probs = self.speech_probabilities(samples)?;
        let total_secs = samples.len() as f64 / SAMPLE_RATE as f64;
        Ok(silence_spans(&probs, FRAME_SECS, total_secs, p))
    }
}

fn boxed_inference(e: ort::Error) -> VadError {
    VadError::Inference(Box::new(e))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frame duration is load-bearing for every span this crate emits, and
    /// is derived rather than typed — so it gets an assertion.
    #[test]
    fn the_frame_duration_is_32ms() {
        assert!((FRAME_SECS - 0.032).abs() < 1e-12);
    }

    /// Silero's own window/context sizes, pinned so a careless edit is a test
    /// failure rather than a silently wrong probability track (see module doc).
    #[test]
    fn the_window_and_context_match_the_model() {
        assert_eq!(WINDOW_SAMPLES, 512);
        assert_eq!(CONTEXT_SAMPLES, 64);
        assert_eq!(CONTEXT_SAMPLES + WINDOW_SAMPLES, 576);
    }
}
