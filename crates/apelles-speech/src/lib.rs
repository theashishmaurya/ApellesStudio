//! `apelles-speech` — what was said, and where nobody said anything (D-318).
//!
//! **What this crate is.** The analysis half of "clean up a talking-head
//! recording": find the dead air, and find the retakes. Two detectors that
//! answer two questions a raw camera file cannot answer for itself —
//!
//! - **Silence**, from a real acoustic VAD ([`vad`] + [`silence`]). Speech
//!   probabilities from silero-vad's ONNX export, run on-device, turned into
//!   spans by a hysteresis state machine.
//! - **Retakes**, from the transcript ([`retake`]). Near-duplicate *spans* of
//!   adjacent utterances — not single utterances, because Whisper's segment
//!   boundaries do not line up with a speaker's restarts (D-327) — grouped by
//!   normalised edit distance, with the last take recommended. Two independent
//!   signals feed it: that edit distance ("the same line again"), and
//!   [`phrase`]'s repeated-n-gram test ("the same *phrase* again inside two
//!   different sentences", D-365). A pair matched by either is a retake.
//! - **Dark regions**, from both at once ([`dark`], D-349). Where the VAD hears
//!   a voice and the transcript has no words, the ASR silently dropped a
//!   multi-second utterance — a real, measured failure (Whisper ~once per three
//!   minutes; Parakeet, now the only backend, at a comparable or higher rate)
//!   that is *biased towards retakes* and therefore blinds the detector above
//!   (B-216). This one is a third detector rather than a note on the other two
//!   precisely because neither can see it: the silence detector reads no
//!   transcript, the retake detector reads no audio.
//! - **Retake proposals from the MCP client** ([`proposal`], D-380). Since
//!   D-380 the retake *judgement* is the client's: an LLM reads the
//!   word-indexed transcript [`render_indexed`] prints and answers with groups
//!   of word-index ranges. [`check_and_resolve`] is the app's half — a
//!   deterministic coverage gate that refuses any group whose deleted takes
//!   hold a content word the kept take lacks, and converts the rest to padded
//!   source seconds. It runs no model and judges no take quality; it only
//!   proves nothing said once is offered for deletion.
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

pub mod dark;
pub mod phrase;
pub mod proposal;
pub mod retake;
pub mod silence;
pub mod vad;

pub use dark::{
    DarkInput, DarkParams, DarkRegion, DarkReport, RMS_HOP_SECS, WordSpan, detect_dark_regions,
    rms_envelope,
};
pub use phrase::{PhraseParams, is_phrase_repeat};
pub use proposal::{
    CutRange, GateParams, GroupVerdict, IndexedView, IndexedWord, JUDGING_RULES, ProposedGroup,
    Refusal, RunSpan, TranscriptSegment, TranscriptWord, ViewPiece, check_and_resolve,
    check_and_resolve_waived, index_pieces, index_transcript, is_waivable, render_indexed,
    render_indexed_page, take_from_span, would_cut,
};
pub use retake::{RetakeGroup, RetakeParams, TakeSpan, Utterance, detect_retakes};
pub use silence::{SilenceParams, Span, silence_spans, speech_spans};
pub use vad::{
    FRAME_SECS, MODEL_FILENAME, MODEL_SHA256, MODEL_URL, SAMPLE_RATE, SileroVad, VadError,
};
