//! `apelles-speech` — what was said, and where nobody said anything (D-318).
//!
//! **What this crate is.** The analysis half of "clean up a talking-head
//! recording": find the dead air, and find the retakes. Two detectors that
//! answer two questions a raw camera file cannot answer for itself —
//!
//! - **Silence**, from a real acoustic VAD ([`vad`] + [`silence`]). Speech
//!   probabilities from silero-vad's ONNX export, run on-device, turned into
//!   spans by a hysteresis state machine.
//! - **Retakes**, from the transcript ([`retake`]). Near-duplicate utterances
//!   grouped by normalised edit distance, with the last take recommended.
//!
//! **What this crate does NOT do — and this is the whole design (D-318).**
//!
//! - **It never cuts anything.** Both detectors are strictly read-only: they
//!   return *candidates*, and applying one is the timeline's job, through the
//!   ordinary split/remove/ripple ops that already existed and are already
//!   tested. Apelles is not an auto-editor (`docs/00-vision.md`); a tool that
//!   silently deleted takes would be one.
//! - **It never reads a file.** No ffmpeg, no symphonia, no paths except the
//!   model's. Callers hand it decoded PCM and transcript text — `apelles-media`
//!   owns decode and resampling, and the frontend store owns the transcript
//!   cache. That is what keeps every interesting decision in here unit-testable
//!   against fixtures with known-correct answers.
//! - **It knows nothing about timelines.** Spans come back in **seconds**;
//!   converting to a clip's source frames needs an fps, and an fps is the
//!   timeline's business, not this crate's.
//!
//! **Layering.** L2, alongside `apelles-timeline` — above `apelles-media`
//! (which decodes the audio it is fed) and below the app. It deliberately does
//! *not* depend on `apelles-media`: taking `&[f32]` instead of a path is what
//! makes the tests real, and nothing here needs a decoder.

pub mod retake;
pub mod silence;
pub mod vad;

pub use retake::{RetakeGroup, RetakeParams, Utterance, detect_retakes};
pub use silence::{SilenceParams, Span, silence_spans, speech_spans};
pub use vad::{
    FRAME_SECS, MODEL_FILENAME, MODEL_SHA256, MODEL_URL, SAMPLE_RATE, SileroVad, VadError,
};
