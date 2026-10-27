//! `apelles-clipper` — the Automatic Clipper's mechanics (D-411).
//!
//! **What this crate is.** Everything deterministic about cutting shorts from
//! one long source, over data it is handed:
//!
//! - [`sentence`] — the transcript cut into sentences, the unit every clip
//!   edge snaps to;
//! - [`topic`] — TextTiling topic breaks (Hearst 1997), hints and the bound of
//!   the candidate list;
//! - [`features`] — explainable evidence tags (hook text, context-dependent
//!   openers, payoff, pace, loudness, picture cuts, focus words);
//! - [`candidate`] — every clean, in-length window per (sentence, target);
//! - [`gate`] — the clean-cut gate every proposal passes, whoever made it:
//!   sentence edges, no edge inside a word, no replayed retake, length within
//!   tolerance, a whole-sentence hook;
//! - [`tighten`] — the dead air and reviewed retakes a build cuts inside each
//!   clip, as a reported list;
//! - [`view`] — the numbered moment view an MCP client reads, its paging, its
//!   identity text, and the judging rules the app serves with it;
//! - [`run`] — the persisted clip run (`clips/<run-id>.json`) schema.
//!
//! **What it does NOT do — the design (D-411, owner decision 2026-10-27).**
//!
//! - **It picks nothing.** The MCP client is the only judge of which moments
//!   are worth a short. There is no score, no ranking and no heuristic pick
//!   anywhere in here: candidates are listed in source order, tags are facts.
//! - **It reads no file and runs no model.** The word view comes from
//!   `apelles-speech` (the same indexing the retake and music-edit tools use,
//!   so a word index means one word everywhere); the VAD, loudness and
//!   picture-cut evidence are measured by the app and handed in.
//! - **It builds nothing.** A gated proposal resolves to source ranges and
//!   tightening cuts; turning them into a timeline is the Edit tab's
//!   (`@apelles/editor`'s clipper build, composing the existing timeline ops).
//!
//! **Layering.** L2, beside `apelles-speech` (its only in-workspace
//! dependency) and `apelles-timeline`; below the app.

pub mod analysis;
pub mod candidate;
pub mod evidence;
pub mod features;
pub mod gate;
pub mod run;
pub mod sentence;
pub mod text;
pub mod tighten;
pub mod topic;
pub mod view;

pub use analysis::{Analysis, AnalysisInput, analyse, check_durations};
pub use candidate::Candidate;
pub use evidence::{Loudness, RetakeCut, SourceEvidence, Span};
pub use features::{SpeakerStats, Tag};
pub use gate::{
    ALLOWED_DURATIONS, ClipRefusal, ClipShape, ClipVerdict, ClipWarning, GateContext, Resolved,
    ResolvedRange, Role, SegmentRef, check, check_proposals,
};
pub use run::{
    Aspect, CLIP_RUN_SCHEMA, ClipProposal, ClipRun, PickedBy, ProposalStatus, RunSettings,
    RunSource,
};
pub use sentence::{Ending, Sentence};
pub use tighten::{CutKind, TightCut, TightenOptions};
pub use topic::Topic;
pub use view::{JUDGING_RULES, JUDGING_RULES_VERSION, render_identity, render_page};
