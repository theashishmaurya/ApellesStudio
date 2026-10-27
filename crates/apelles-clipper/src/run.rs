//! A clip run: one source, its settings, and the proposals judged against its
//! moment view — the persisted review state behind the Clipper panel
//! (D-411 §5.2), stored as `clips/<run-id>.json` in the project by
//! `apelles-project`.
//!
//! **Why persisted, unlike retake and music-edit proposals.** Those are
//! session state, cheap to redo. A run cost an analysis and an agent's
//! judgement; losing it on a restart would lose the work. Analyses themselves
//! are caches and recomputed (`crate::analysis`); only the run is state.
//!
//! **Who writes it.** The Edit tab's clipper store (TypeScript) owns the run
//! and writes it whole; these types are its schema, checked on every save and
//! load ([`ClipRun::validate`]), so a malformed file is refused with a named
//! reason instead of half-loading.

use serde::{Deserialize, Serialize};

use crate::analysis::check_durations;
use crate::evidence::Span;
use crate::gate::{ClipShape, ClipVerdict};
use crate::tighten::TightenOptions;

/// The schema version a run file is written at.
pub const CLIP_RUN_SCHEMA: u32 = 1;
/// The longest run or proposal id.
pub const MAX_ID_LEN: usize = 64;
/// The most shorts one run may be asked to build.
pub const MAX_COUNT: u32 = 20;

/// What a run is cut from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RunSource {
    /// A media-pool item, analysed whole (or within `settings.range`).
    Media {
        media_id: String,
        path: String,
        name: String,
    },
    /// A long Edit timeline: the clips on one track, in play order.
    Timeline {
        timeline_id: String,
        track: usize,
        name: String,
    },
}

/// The frame a short is built at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Aspect {
    #[serde(rename = "9:16")]
    Portrait,
    #[serde(rename = "1:1")]
    Square,
    #[serde(rename = "4:5")]
    Vertical,
}

impl Aspect {
    /// The delivery size: the platforms' upload sizes, 1080 wide.
    pub fn output(self) -> (u32, u32) {
        match self {
            Self::Portrait => (1080, 1920),
            Self::Square => (1080, 1080),
            Self::Vertical => (1080, 1350),
        }
    }
}

/// How a run's shorts are built.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunSettings {
    /// Target lengths in seconds (each one of `gate::ALLOWED_DURATIONS`).
    pub durations: Vec<u32>,
    /// How many shorts the person asked for.
    pub count: u32,
    pub aspect: Aspect,
    /// `"brand"` (the project's active brand kit's captions, or the default
    /// preset when no kit is set), a caption preset id, or `"none"`.
    pub captions: String,
    /// Play a proposal's hook first when it has one.
    pub hook_first: bool,
    pub tighten: TightenOptions,
    /// Analyse only this stretch of a media source.
    #[serde(default)]
    pub range: Option<Span>,
    /// What the person wants clips about, passed to the client and matched as
    /// evidence.
    #[serde(default)]
    pub focus: Option<String>,
}

/// Who chose a proposal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PickedBy {
    /// The MCP client (D-411: the only automatic judge).
    Client,
    /// A person, from the Clipper panel's candidate list.
    Person,
}

/// Where a proposal is in review.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalStatus {
    Pending,
    Accepted,
    Rejected,
    Built,
}

/// One proposed short.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClipProposal {
    pub id: String,
    pub shape: ClipShape,
    pub title: String,
    pub reason: String,
    #[serde(default)]
    pub hook_line: Option<String>,
    pub picked_by: PickedBy,
    /// The moment view the shape's indices belong to.
    pub view_id: String,
    pub rules_version: u32,
    /// The gate's latest answer (re-run on every change).
    pub verdict: ClipVerdict,
    /// The gate's refusal reason or warnings in words, as `Display` wrote them
    /// when it ran — what the panel and `editor_list_clip_proposals` show.
    #[serde(default)]
    pub gate_notes: Vec<String>,
    pub status: ProposalStatus,
    /// The timeline it was built as.
    #[serde(default)]
    pub timeline_id: Option<String>,
    #[serde(default)]
    pub built_at: Option<String>,
}

/// One run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClipRun {
    pub schema: u32,
    pub id: String,
    /// RFC 3339.
    pub created_at: String,
    pub source: RunSource,
    pub settings: RunSettings,
    /// The moment view the latest proposals were judged against.
    #[serde(default)]
    pub view_id: Option<String>,
    #[serde(default)]
    pub proposals: Vec<ClipProposal>,
}

/// Is `id` safe as a file stem and as a JSON key: 1..=[`MAX_ID_LEN`] of
/// `[a-z0-9-]`, not starting with `-`.
pub fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && !id.starts_with('-')
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

impl ClipRun {
    /// Every rule a stored run must meet, each refusal naming the field.
    pub fn validate(&self) -> Result<(), String> {
        if self.schema != CLIP_RUN_SCHEMA {
            return Err(format!(
                "clip run schema {} is not supported (this build reads {CLIP_RUN_SCHEMA})",
                self.schema
            ));
        }
        if !is_valid_id(&self.id) {
            return Err(format!(
                "clip run id {:?} must be 1-{MAX_ID_LEN} characters of a-z, 0-9 and -",
                self.id
            ));
        }
        check_durations(&self.settings.durations)?;
        if self.settings.count == 0 || self.settings.count > MAX_COUNT {
            return Err(format!(
                "count must be 1-{MAX_COUNT}, got {}",
                self.settings.count
            ));
        }
        if let Some(r) = self.settings.range
            && (!(r.start_secs.is_finite() && r.end_secs.is_finite() && r.start_secs >= 0.0)
                || r.end_secs <= r.start_secs)
        {
            return Err("range must be a finite, non-negative start before its end".into());
        }
        let mut ids: Vec<&str> = Vec::with_capacity(self.proposals.len());
        for p in &self.proposals {
            if !is_valid_id(&p.id) {
                return Err(format!("proposal id {:?} is not a valid id", p.id));
            }
            if ids.contains(&p.id.as_str()) {
                return Err(format!("proposal id {:?} appears twice", p.id));
            }
            ids.push(&p.id);
            if p.status == ProposalStatus::Built && p.timeline_id.is_none() {
                return Err(format!("proposal {} is built but names no timeline", p.id));
            }
        }
        Ok(())
    }
}
