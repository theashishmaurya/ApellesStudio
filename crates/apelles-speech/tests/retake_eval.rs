//! **The retake eval's scorer** (D-378): runs the *real* [`detect_retakes`]
//! over every task in `eval/retake/tasks.json` and scores the cut it proposes
//! against hand-labelled ground truth in source-audio seconds.
//!
//! **What it is.** The scoring half of `eval/retake/` — that directory holds
//! the data (task set, labels, control set, baseline) and its README holds the
//! label schema, the labelling rules and every metric's definition. This file
//! implements those definitions and nothing else, so the two must be read
//! together. The scorer is Rust because the thing scored is Rust: calling the
//! detector for real is what keeps this harness free of `eval/`'s own big
//! caveat (an approximate operator, so its absolute scores mean nothing).
//!
//! Since **D-379** it also scores proposals made *outside* the crate — by an
//! MCP client reading the transcript — through [`external_proposals`], against
//! the same labels, which are word-precise and may nest a stutter inside a
//! kept delivery ([`Labels::containers`]).
//!
//! **What it does NOT do.** It does not tune anything, does not pick a backend,
//! and does not decide whether a cut is *good editing* — only whether the
//! speech it removes exists somewhere in what survives (D-318's one-directional
//! rule, stated as an outcome). It does not read audio: every input is JSON.
//!
//! **Why it is built to be hard to satisfy.** The detector has been declared
//! fixed three times on green numbers that measured the wrong thing (B-198 →
//! B-237 → B-238 → B-246). So besides the pinned task table this file proves
//! the eval itself is non-vacuous: a **null** detector (proposes nothing) and a
//! **greedy** one (proposes everything) must both fail, and the labels must
//! clear floors that an empty label file could not.
//!
//! ```sh
//! cargo test -p apelles-speech --test retake_eval -- --nocapture
//! APELLES_RETAKE_EVAL_BASELINE=1 cargo test -p apelles-speech --test retake_eval
//! ```

mod common;

use std::collections::BTreeSet;
use std::path::PathBuf;

use apelles_speech::proposal::{GateParams, INDEXED_VIEW_LEGEND, check_and_resolve_with};
use apelles_speech::{
    GroupVerdict, IndexedWord, JUDGING_RULES, ProposedGroup, Refusal, RetakeGroup, RetakeParams,
    RunSpan, TranscriptSegment, ViewPiece, detect_retakes, index_pieces, index_transcript,
    render_indexed,
};
use common::load_path;
use serde::Deserialize;
use serde_json::{Value, json};

/// Set to `1` to rewrite `eval/retake/baseline.json` from this run instead of
/// comparing against it.
const BASELINE_ENV: &str = "APELLES_RETAKE_EVAL_BASELINE";

/// A label group counts as *found* when at least this much of its non-keeper
/// deliveries is proposed for deletion (README, `group_recall`). Half a second
/// is shorter than any labelled delivery and longer than any rounding.
const GROUP_FOUND_SECS: f64 = 0.5;

/// How far apart independent readings of the same audio put the same
/// boundary, and therefore how precise a label's edge can be. Measured on this
/// corpus while labelling (D-378): the largest disagreement any over-cut sliver
/// rested on was 0.74 s (C040, the end of "doesn't get half ignored": Whisper
/// 44.38 s, Parakeet 45.12 s). A lost run no longer than this that touches a
/// labelled edge is reported as `boundary_slack_secs` instead of
/// `over_cut_secs`; anything longer, or anywhere else, is charged in full.
const BOUNDARY_TOLERANCE_SECS: f64 = 0.75;

/// Floating-point slack for "is this gate at zero". Interval lengths are sums
/// of differences of two-decimal timestamps, so anything below this is noise.
const EPS: f64 = 1e-6;

/// `the_labels_are_not_vacuous`'s floors. A labelled source must carry real
/// retakes, or a detector could pass it by proposing nothing; and its
/// `neutral` escape hatch is capped so labels cannot quietly opt out of being
/// judged (README, "`neutral`, and why it is capped").
const MIN_GROUPS_PER_SOURCE: usize = 5;
const MIN_REDUNDANT_SECS_PER_SOURCE: f64 = 20.0;
const MAX_NEUTRAL_FRACTION: f64 = 0.10;

// ---------------------------------------------------------------------------
// Interval arithmetic over source seconds. Every set here is a sorted,
// disjoint `Vec<Iv>`; `normalise` is the one way to make one.

type Iv = (f64, f64);

fn normalise(mut v: Vec<Iv>) -> Vec<Iv> {
    v.retain(|(s, e)| e > s);
    v.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out: Vec<Iv> = Vec::with_capacity(v.len());
    for (s, e) in v {
        match out.last_mut() {
            Some(last) if s <= last.1 => last.1 = last.1.max(e),
            _ => out.push((s, e)),
        }
    }
    out
}

fn total(v: &[Iv]) -> f64 {
    // A fold from +0.0, not `sum()`: an empty `f64` sum is -0.0, which would
    // print and serialise as "-0.0" for every untouched range.
    v.iter().fold(0.0, |acc, (s, e)| acc + (e - s))
}

fn intersection(a: &[Iv], b: &[Iv]) -> Vec<Iv> {
    let mut out = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        let (s, e) = (a[i].0.max(b[j].0), a[i].1.min(b[j].1));
        if e > s {
            out.push((s, e));
        }
        if a[i].1 < b[j].1 {
            i += 1;
        } else {
            j += 1;
        }
    }
    out
}

fn overlap(a: &[Iv], b: &[Iv]) -> f64 {
    total(&intersection(a, b))
}

fn subtract(a: &[Iv], b: &[Iv]) -> Vec<Iv> {
    let mut out = Vec::new();
    for &(s, e) in a {
        let mut cursor = s;
        for &(bs, be) in b {
            if be <= cursor || bs >= e {
                continue;
            }
            if bs > cursor {
                out.push((cursor, bs));
            }
            cursor = cursor.max(be);
        }
        if cursor < e {
            out.push((cursor, e));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// The data — the shapes `eval/retake/README.md` documents. Free-text fields
// (`note`, `line`, `what_it_is`, …) are for people and are not read here.

#[derive(Debug, Deserialize)]
struct Labels {
    source: String,
    labelled_span: Iv,
    readings: Vec<String>,
    retakes: Vec<LabelGroup>,
    protected: Vec<Protected>,
    neutral: Vec<Neutral>,
}

#[derive(Debug, Deserialize)]
struct LabelGroup {
    id: String,
    keeper: usize,
    keeper_confidence: Confidence,
    deliveries: Vec<Delivery>,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Confidence {
    High,
    Low,
}

#[derive(Debug, Deserialize)]
struct Delivery {
    start: f64,
    end: f64,
}

#[derive(Debug, Deserialize)]
struct Protected {
    id: String,
    start: f64,
    end: f64,
}

#[derive(Debug, Deserialize)]
struct Neutral {
    start: f64,
    end: f64,
    // Read so an unknown reason fails to parse; the vocabulary is the README's.
    #[allow(dead_code)]
    reason: NeutralReason,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum NeutralReason {
    AbandonedRestart,
    Aside,
    UnresolvableBoundary,
}

impl Labels {
    fn span(&self) -> Vec<Iv> {
        normalise(vec![self.labelled_span])
    }
    fn deliveries(&self) -> Vec<Iv> {
        normalise(
            self.retakes
                .iter()
                .flat_map(|g| g.deliveries.iter().map(|d| (d.start, d.end)))
                .collect(),
        )
    }
    fn protected(&self) -> Vec<Iv> {
        normalise(self.protected.iter().map(|p| (p.start, p.end)).collect())
    }
    fn neutral(&self) -> Vec<Iv> {
        normalise(self.neutral.iter().map(|n| (n.start, n.end)).collect())
    }
    /// For each group, the `(group, delivery)` it is nested inside, if any — a
    /// stutter labelled inside another group's delivery (README, "Nested
    /// groups"). A group is nested when every one of its deliveries lies within
    /// one delivery of another group.
    fn containers(&self) -> Vec<Option<(usize, usize)>> {
        self.retakes
            .iter()
            .enumerate()
            .map(|(gi, g)| {
                self.retakes
                    .iter()
                    .enumerate()
                    .filter(|(oi, _)| *oi != gi)
                    .flat_map(|(oi, o)| {
                        o.deliveries
                            .iter()
                            .enumerate()
                            .map(move |(di, d)| (oi, di, d))
                    })
                    .find(|(_, _, d)| {
                        g.deliveries
                            .iter()
                            .all(|x| x.start >= d.start - EPS && x.end <= d.end + EPS)
                    })
                    .map(|(oi, di, _)| (oi, di))
            })
            .collect()
    }
    /// Every edge where unique content meets something labelled — the only
    /// places a boundary tolerance can apply.
    fn edges(&self) -> Vec<f64> {
        let ranges = self
            .retakes
            .iter()
            .flat_map(|g| g.deliveries.iter().map(|d| (d.start, d.end)))
            .chain(self.neutral.iter().map(|n| (n.start, n.end)));
        ranges.flat_map(|(s, e)| [s, e]).collect()
    }
    /// Everything in the span that is neither a delivery nor neutral — speech
    /// said once, by the README's closure rule.
    fn unique(&self) -> Vec<Iv> {
        let labelled = normalise([self.deliveries(), self.neutral()].concat());
        subtract(&self.span(), &labelled)
    }
    /// Σ over groups of (all deliveries − the keeper): the seconds a perfect
    /// detector would propose.
    fn redundant_secs(&self) -> f64 {
        self.retakes
            .iter()
            .map(|g| {
                let all: f64 = g.deliveries.iter().map(|d| d.end - d.start).sum();
                let k = &g.deliveries[g.keeper];
                all - (k.end - k.start)
            })
            .sum()
    }
}

#[derive(Debug, Deserialize)]
struct TaskSet {
    tasks: Vec<Task>,
}

#[derive(Debug, Deserialize)]
struct Task {
    id: String,
    input: TaskInput,
    /// `RetakeParams` is `#[serde(default)]`, so a partial object here is
    /// exactly "these overrides on top of the defaults".
    #[serde(default)]
    params: Option<RetakeParams>,
    goal: Goal,
    #[serde(default)]
    gates: Vec<Limit>,
    expect: Expect,
}

#[derive(Debug, Deserialize)]
struct TaskInput {
    transcript: String,
    labels: String,
}

#[derive(Debug, Deserialize)]
struct Goal {
    checks: Vec<Check>,
}

#[derive(Debug, Deserialize)]
struct Check {
    id: String,
    #[serde(flatten)]
    limit: Limit,
    /// How far past the limit a value may be before this check scores 0 —
    /// `eval/score.mjs`'s `slack`, with the same defaults.
    slack: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct Limit {
    metric: Metric,
    min: Option<f64>,
    max: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Expect {
    Pass,
    Fail,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Metric {
    OverCutSecs,
    ProtectedSecsCut,
    CutPrecision,
    RetakeRecall,
    GroupRecall,
    KeeperAgreement,
    BoundarySlackSecs,
    NeutralCutSecs,
    ProposedSecs,
}

impl Limit {
    /// Exactly one bound, or the task file is malformed.
    fn bound(&self) -> Bound {
        match (self.min, self.max) {
            (Some(m), None) => Bound::Min(m),
            (None, Some(m)) => Bound::Max(m),
            _ => panic!("{:?}: a limit needs exactly one of min / max", self.metric),
        }
    }
}

enum Bound {
    Min(f64),
    Max(f64),
}

fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(rel)
}

fn read_json<T: serde::de::DeserializeOwned>(rel: &str) -> T {
    let path = repo_path(rel);
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parsing {}: {e}", path.display()))
}

fn task_set() -> Vec<Task> {
    read_json::<TaskSet>("eval/retake/tasks.json").tasks
}

// ---------------------------------------------------------------------------
// A proposal: what a detector offers for deletion, in source seconds.

/// One detector group, flattened to time: the take it recommends keeping, and
/// every member of every other take.
struct Proposed {
    kept: Vec<Iv>,
    cut: Vec<Iv>,
}

fn from_detector(groups: &[RetakeGroup]) -> Vec<Proposed> {
    groups
        .iter()
        .map(|g| {
            let members = |first: usize, last: usize| -> Vec<Iv> {
                g.members[first..=last]
                    .iter()
                    .map(|m| (m.start_secs, m.end_secs))
                    .collect()
            };
            let keep = g.takes[g.keep];
            let cut = g
                .takes
                .iter()
                .enumerate()
                .filter(|(ti, _)| *ti != g.keep)
                .flat_map(|(_, t)| members(t.first, t.last))
                .collect();
            Proposed {
                kept: normalise(members(keep.first, keep.last)),
                cut: normalise(cut),
            }
        })
        .collect()
}

/// The two reference detectors that must fail every task they can fail.
#[derive(Debug, Clone, Copy)]
enum Reference {
    /// Proposes nothing — passes every over-cutting gate trivially.
    Null,
    /// Proposes every utterance — finds every retake trivially.
    Greedy,
}

fn reference(kind: Reference, transcript: &str) -> Vec<Proposed> {
    match kind {
        Reference::Null => Vec::new(),
        Reference::Greedy => vec![Proposed {
            kept: Vec::new(),
            cut: normalise(
                load_path(&repo_path(transcript).to_string_lossy())
                    .iter()
                    .map(|u| (u.start_secs, u.end_secs))
                    .collect(),
            ),
        }],
    }
}

// ---------------------------------------------------------------------------
// The metrics — README "The metrics", one for one.

#[derive(Debug, Clone, PartialEq)]
struct Metrics {
    over_cut_secs: f64,
    protected_secs_cut: f64,
    /// `None` when nothing was proposed inside a labelled range — a ratio over
    /// nothing is not 1.0, and treating it as such would let a silent detector
    /// pass a precision check.
    cut_precision: Option<f64>,
    retake_recall: Option<f64>,
    group_recall: Option<f64>,
    keeper_agreement: Option<f64>,
    /// Lost seconds forgiven by [`BOUNDARY_TOLERANCE_SECS`] — reported, never
    /// hidden, so a detector that lives inside the tolerance is visible.
    boundary_slack_secs: f64,
    neutral_cut_secs: f64,
    proposed_secs: f64,
}

impl Metrics {
    fn get(&self, m: Metric) -> Option<f64> {
        match m {
            Metric::OverCutSecs => Some(self.over_cut_secs),
            Metric::ProtectedSecsCut => Some(self.protected_secs_cut),
            Metric::CutPrecision => self.cut_precision,
            Metric::RetakeRecall => self.retake_recall,
            Metric::GroupRecall => self.group_recall,
            Metric::KeeperAgreement => self.keeper_agreement,
            Metric::BoundarySlackSecs => Some(self.boundary_slack_secs),
            Metric::NeutralCutSecs => Some(self.neutral_cut_secs),
            Metric::ProposedSecs => Some(self.proposed_secs),
        }
    }
}

/// Every lost range, named by what it took — the itemised form of
/// `over_cut_secs` (and of `boundary_slack_secs`, flagged `forgiven`), printed
/// by the task table so a failing gate says *where*.
struct LostRange {
    range: Iv,
    what: String,
    forgiven: bool,
}

/// The survivor of a group: the delivery the cut leaves most intact — the
/// smallest cut FRACTION, earliest on a tie. A fraction, not uncut seconds,
/// because a delivery's range may include the pause around it (README, rule 2)
/// and a padded delivery would otherwise "survive" on silence. Its cut seconds
/// are content lost, charged exactly once even when every delivery is cut.
fn survivor(cut: &[Iv], ivs: &[Vec<Iv>]) -> usize {
    let fraction = |i: usize| overlap(cut, &ivs[i]) / total(&ivs[i]);
    let mut best = 0;
    for i in 1..ivs.len() {
        if fraction(i) < fraction(best) - EPS {
            best = i;
        }
    }
    best
}

fn score(labels: &Labels, proposal: &[Proposed]) -> Metrics {
    score_itemised(labels, proposal).0
}

fn score_itemised(labels: &Labels, proposal: &[Proposed]) -> (Metrics, Vec<LostRange>) {
    let span = labels.span();
    let cut = intersection(
        &normalise(proposal.iter().flat_map(|p| p.cut.clone()).collect()),
        &span,
    );

    let mut safe = 0.0;
    // Cut seconds that are content lost, before the boundary tolerance.
    let mut lost: Vec<(Iv, String)> = Vec::new();
    let (mut found, mut kept_right, mut kept_judged) = (0usize, 0usize, 0usize);
    let mut counted = 0usize;
    let containers = labels.containers();
    let ivs_of: Vec<Vec<Vec<Iv>>> = labels
        .retakes
        .iter()
        .map(|g| {
            g.deliveries
                .iter()
                .map(|d| normalise(vec![(d.start, d.end)]))
                .collect()
        })
        .collect();
    let survivor_of: Vec<usize> = ivs_of.iter().map(|ivs| survivor(&cut, ivs)).collect();
    for (gi, g) in labels.retakes.iter().enumerate() {
        let ivs = &ivs_of[gi];
        let s = survivor_of[gi];
        // A nested group (a stutter inside another group's keeper) is judged
        // only where its container delivery survives: inside a cut delivery its
        // seconds are already that delivery's safe seconds.
        let judged = match containers[gi] {
            None => true,
            Some((cg, cd)) => survivor_of[cg] == cd,
        };
        if judged {
            // The groups nested inside this group's survivor judge their own
            // seconds, so a correct stutter cut there is not charged here.
            let nested = normalise(
                containers
                    .iter()
                    .enumerate()
                    .filter(|(_, c)| **c == Some((gi, s)))
                    .flat_map(|(ni, _)| ivs_of[ni].concat())
                    .collect(),
            );
            for (i, d) in ivs.iter().enumerate() {
                if i == s {
                    for r in intersection(&cut, &subtract(d, &nested)) {
                        lost.push((r, format!("{} (every delivery cut)", g.id)));
                    }
                } else {
                    safe += overlap(&cut, d);
                }
            }
        }

        // A nested group whose container was cut is moot — the stutter went
        // with the delivery around it — so it is not a group to find or to
        // pick a keeper for either.
        if !judged {
            continue;
        }
        counted += 1;
        let non_keeper_cut: f64 = ivs
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != g.keeper)
            .map(|(_, d)| overlap(&cut, d))
            .sum();
        if non_keeper_cut >= GROUP_FOUND_SECS {
            found += 1;
            if g.keeper_confidence == Confidence::High {
                kept_judged += 1;
                if detector_keeps(ivs, proposal) == Some(g.keeper) {
                    kept_right += 1;
                }
            }
        }
    }
    for r in intersection(&cut, &labels.unique()) {
        lost.push((r, "unique content".into()));
    }

    // Merge touching pieces into runs — a cut that crosses a delivery's edge
    // into unique content is one loss — then apply the boundary tolerance.
    lost.sort_by(|a, b| a.0.0.total_cmp(&b.0.0));
    let mut runs: Vec<(Iv, Vec<String>)> = Vec::new();
    for (r, what) in lost {
        match runs.last_mut() {
            Some((last, names)) if r.0 <= last.1 + EPS => {
                last.1 = last.1.max(r.1);
                if !names.contains(&what) {
                    names.push(what);
                }
            }
            _ => runs.push((r, vec![what])),
        }
    }
    let edges = labels.edges();
    let touches_edge = |(s, e): Iv| {
        edges
            .iter()
            .any(|x| (s - x).abs() < EPS || (e - x).abs() < EPS)
    };
    let protected = labels.protected();
    let lost: Vec<LostRange> = runs
        .into_iter()
        .map(|(range, names)| {
            let forgiven = range.1 - range.0 <= BOUNDARY_TOLERANCE_SECS && touches_edge(range);
            let mut what = names.join(" + ");
            if overlap(&[range], &protected) > EPS {
                what.push_str(", PROTECTED");
            }
            LostRange {
                range,
                what,
                forgiven,
            }
        })
        .collect();
    let charged: Vec<Iv> = lost
        .iter()
        .filter(|l| !l.forgiven)
        .map(|l| l.range)
        .collect();
    let over = total(&charged);

    let redundant = labels.redundant_secs();
    let ratio = |n: f64, d: f64| (d > EPS).then(|| n / d);
    let metrics = Metrics {
        over_cut_secs: over,
        protected_secs_cut: overlap(&charged, &protected),
        cut_precision: ratio(safe, safe + over),
        retake_recall: ratio(safe, redundant),
        group_recall: ratio(found as f64, counted as f64),
        keeper_agreement: ratio(kept_right as f64, kept_judged as f64),
        boundary_slack_secs: lost
            .iter()
            .filter(|l| l.forgiven)
            .fold(0.0, |acc, l| acc + (l.range.1 - l.range.0)),
        neutral_cut_secs: overlap(&cut, &labels.neutral()),
        proposed_secs: total(&cut),
    };
    (metrics, lost)
}

/// Which labelled delivery the detector recommends keeping, for one label
/// group: take the detector group that overlaps the label group most, and
/// return the delivery its kept take overlaps most. `None` if no detector
/// group touches the label group or its keep touches no delivery.
fn detector_keeps(ivs: &[Vec<Iv>], proposal: &[Proposed]) -> Option<usize> {
    let all = normalise(ivs.concat());
    let best = proposal
        .iter()
        .map(|p| {
            let extent = normalise([p.kept.clone(), p.cut.clone()].concat());
            (overlap(&extent, &all), p)
        })
        .filter(|(o, _)| *o > EPS)
        .max_by(|a, b| a.0.total_cmp(&b.0))?
        .1;
    let (i, o) = ivs
        .iter()
        .enumerate()
        .map(|(i, d)| (i, overlap(&best.kept, d)))
        .max_by(|a, b| a.1.total_cmp(&b.1).then(b.0.cmp(&a.0)))?;
    (o > EPS).then_some(i)
}

// ---------------------------------------------------------------------------
// Judging a task.

struct Outcome {
    metrics: Metrics,
    /// `(check id, met, score in 0..=1)`.
    checks: Vec<(String, bool, f64)>,
    gates_fired: Vec<String>,
    lost: Vec<LostRange>,
    /// Mean check score, zeroed by any gate — `eval/score.mjs`'s rule.
    score: f64,
    /// Every check met and no gate fired.
    passed: bool,
}

fn judge(task: &Task, (metrics, lost): (Metrics, Vec<LostRange>)) -> Outcome {
    let mut checks = Vec::new();
    for c in &task.goal.checks {
        let v = metrics.get(c.limit.metric);
        let (met, s) = match (v, c.limit.bound()) {
            (None, _) => (false, 0.0),
            (Some(v), Bound::Min(m)) => {
                let slack = c.slack.unwrap_or_else(|| (m * 0.1).max(1.0));
                (
                    v >= m - EPS,
                    (1.0 - (m - v).max(0.0) / slack).clamp(0.0, 1.0),
                )
            }
            (Some(v), Bound::Max(m)) => {
                let slack = c.slack.unwrap_or_else(|| m.max(1.0));
                (
                    v <= m + EPS,
                    (1.0 - (v - m).max(0.0) / slack).clamp(0.0, 1.0),
                )
            }
        };
        checks.push((c.id.clone(), met, s));
    }
    let mut gates_fired = Vec::new();
    for g in &task.gates {
        let v = metrics.get(g.metric).unwrap_or(f64::NAN);
        let fired = v.is_nan()
            || match g.bound() {
                Bound::Min(m) => v < m - EPS,
                Bound::Max(m) => v > m + EPS,
            };
        if fired {
            gates_fired.push(format!("{:?}={v:.2}", g.metric));
        }
    }
    let mean = if checks.is_empty() {
        0.0
    } else {
        checks.iter().map(|c| c.2).sum::<f64>() / checks.len() as f64
    };
    let passed = gates_fired.is_empty() && checks.iter().all(|c| c.1);
    Outcome {
        metrics,
        score: if gates_fired.is_empty() { mean } else { 0.0 },
        checks,
        gates_fired,
        lost,
        passed,
    }
}

fn run(task: &Task, proposal: Option<Reference>) -> Outcome {
    let groups = match proposal {
        Some(kind) => reference(kind, &task.input.transcript),
        None => {
            let u = load_path(&repo_path(&task.input.transcript).to_string_lossy());
            from_detector(&detect_retakes(&u, &task.params.unwrap_or_default()))
        }
    };
    run_with(task, &groups)
}

/// Score any proposal against a task's labels — the detector's, a reference
/// detector's, or an external one read by [`external_proposals`].
fn run_with(task: &Task, groups: &[Proposed]) -> Outcome {
    let labels: Labels = read_json(&task.input.labels);
    judge(task, score_itemised(&labels, groups))
}

// ---------------------------------------------------------------------------
// The baseline: today's numbers, rounded so a re-run reproduces them exactly.

fn r3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

fn baseline_row(o: &Outcome) -> Value {
    let m = &o.metrics;
    let opt = |v: Option<f64>| v.map(r3);
    json!({
        "passed": o.passed,
        "score": r3(o.score),
        "gates_fired": o.gates_fired,
        "metrics": {
            "over_cut_secs": r3(m.over_cut_secs),
            "protected_secs_cut": r3(m.protected_secs_cut),
            "cut_precision": opt(m.cut_precision),
            "retake_recall": opt(m.retake_recall),
            "group_recall": opt(m.group_recall),
            "keeper_agreement": opt(m.keeper_agreement),
            "boundary_slack_secs": r3(m.boundary_slack_secs),
            "neutral_cut_secs": r3(m.neutral_cut_secs),
            "proposed_secs": r3(m.proposed_secs),
        }
    })
}

fn fmt(v: Option<f64>) -> String {
    v.map_or_else(|| "   -  ".into(), |v| format!("{v:6.3}"))
}

fn print_header() {
    println!(
        "{:<36} {:>6} {:>5} {:>8} {:>8} {:>6} {:>6} {:>6} {:>6} {:>8}",
        "task", "score", "pass", "over_s", "prot_s", "prec", "recall", "groups", "keeper", "prop_s"
    );
}

/// One task's table row, its missed checks, and every lost range.
fn print_row(id: &str, o: &Outcome) {
    let m = &o.metrics;
    println!(
        "{:<36} {:>6.3} {:>5} {:>8.2} {:>8.2} {} {} {} {} {:>8.2}{}",
        id,
        o.score,
        if o.passed { "yes" } else { "NO" },
        m.over_cut_secs,
        m.protected_secs_cut,
        fmt(m.cut_precision),
        fmt(m.retake_recall),
        fmt(m.group_recall),
        fmt(m.keeper_agreement),
        m.proposed_secs,
        if o.gates_fired.is_empty() {
            String::new()
        } else {
            format!("  GATE: {}", o.gates_fired.join(", "))
        },
    );
    let missed: Vec<&str> = o
        .checks
        .iter()
        .filter(|c| !c.1)
        .map(|c| c.0.as_str())
        .collect();
    if !missed.is_empty() {
        println!("    checks missed: {}", missed.join(", "));
    }
    for l in &o.lost {
        let (s, e) = l.range;
        let tag = if l.forgiven { "forgiven" } else { "LOST" };
        println!("    {tag:<8} {s:7.2}-{e:7.2} ({:5.2}s) {}", e - s, l.what);
    }
}

/// **The task set, scored with the real detector — every verdict pinned by its
/// `expect`, every number pinned by `baseline.json`.**
///
/// A task whose verdict stops matching `expect` fails here, so a B-246 fix
/// cannot land without flipping its `expect`s deliberately, and a regression
/// cannot hide behind an aggregate. Any metric drifting from the baseline fails
/// too: the baseline moves only by being rewritten (`BASELINE_ENV`), in the same
/// commit as the change that moved it, where a reviewer sees the diff.
#[test]
fn the_task_set_scores_as_pinned() {
    let tasks = task_set();
    print_header();
    let mut rows = serde_json::Map::new();
    let mut mismatched = Vec::new();
    let (mut passes, mut sum) = (0, 0.0);
    for t in &tasks {
        let o = run(t, None);
        print_row(&t.id, &o);
        let verdict = if o.passed { Expect::Pass } else { Expect::Fail };
        if verdict != t.expect {
            mismatched.push(format!("{} is {verdict:?}, expected {:?}", t.id, t.expect));
        }
        passes += usize::from(o.passed);
        sum += o.score;
        rows.insert(t.id.clone(), baseline_row(&o));
    }
    println!(
        "rollup: mean={:.3} pass={passes}/{}",
        sum / tasks.len() as f64,
        tasks.len()
    );
    assert!(
        mismatched.is_empty(),
        "verdicts that no longer match their pinned `expect` — flip the `expect` \
         deliberately, in the commit that changed the behaviour:\n{}",
        mismatched.join("\n")
    );

    let now = json!({
        "$comment": "The retake eval's committed floor (D-378): today's scores at RetakeParams::default() unless a task overrides it, B-246 unfixed. NOT a target — see eval/retake/README.md. Regenerate: APELLES_RETAKE_EVAL_BASELINE=1 cargo test -p apelles-speech --test retake_eval",
        "rollup": { "mean": r3(sum / tasks.len() as f64), "pass": passes, "of": tasks.len() },
        "tasks": Value::Object(rows),
    });
    let path = repo_path("eval/retake/baseline.json");
    if std::env::var(BASELINE_ENV).as_deref() == Ok("1") {
        let text = serde_json::to_string_pretty(&now).expect("a json! value always serialises");
        std::fs::write(&path, text + "\n")
            .unwrap_or_else(|e| panic!("writing {}: {e}", path.display()));
        println!("wrote {}", path.display());
        return;
    }
    let pinned: Value = read_json("eval/retake/baseline.json");
    for (id, row) in now["tasks"].as_object().into_iter().flatten() {
        assert_eq!(
            Some(row),
            pinned["tasks"].get(id),
            "{id} no longer matches eval/retake/baseline.json — if the change is \
             intended, rewrite it with {BASELINE_ENV}=1 and commit the diff"
        );
    }
    assert_eq!(
        now, pinned,
        "the task set or rollup changed shape — rewrite the baseline with {BASELINE_ENV}=1"
    );
}

/// **The eval cannot be satisfied by measuring nothing.** A detector that
/// proposes nothing must fail every task that labels a retake (it finds none),
/// and one that proposes every utterance must fail every task (it over-cuts).
/// If either ever passes, a label file or a task's limits have gone vacuous.
#[test]
fn null_and_greedy_detectors_fail() {
    for t in task_set() {
        let labels: Labels = read_json(&t.input.labels);
        if !labels.retakes.is_empty() {
            let o = run(&t, Some(Reference::Null));
            assert!(
                !o.passed,
                "{}: a detector that proposes nothing passes",
                t.id
            );
        }
        let o = run(&t, Some(Reference::Greedy));
        assert!(
            !o.passed,
            "{}: a detector that cuts everything passes",
            t.id
        );
        assert!(
            !o.gates_fired.is_empty(),
            "{}: cutting everything must fire a gate, not merely miss a check",
            t.id
        );
    }
}

/// Set to a directory to score proposals produced OUTSIDE this crate — by an
/// MCP client, a model, a human — instead of the detector. One file per task,
/// named by its id with `/` as `__` (`C040__parakeet.json`), in either of two
/// forms, per group:
///
/// - **seconds**: `{"kept": [[s, e], …], "cut": [[s, e], …]}` in source seconds,
///   scored as given;
/// - **index form** (D-380, the shape an MCP client answers in):
///   `{"takes": [{"first": a, "last": b}, …], "keep": k}` over the task
///   source's word transcript (`eval/retake/transcripts/`), resolved through
///   the real coverage gate, [`apelles_speech::check_and_resolve`] — refused groups are listed
///   and not scored, exactly as the app would not apply them.
///
/// The same scorer and the same labels, so the numbers compare directly with
/// the detector's table; nothing in this mode is pinned, because a proposer
/// outside the crate is not this crate's behaviour (the committed client runs
/// are pinned separately, by [`the_coverage_gate_measures_as_pinned`]).
const PROPOSALS_ENV: &str = "APELLES_RETAKE_EVAL_PROPOSALS";

/// Set to `1` to print the coverage gate's threshold sweep (D-380).
const SWEEP_ENV: &str = "APELLES_RETAKE_GATE_SWEEP";

#[derive(Deserialize)]
struct ProposalFile {
    groups: Vec<ExternalGroup>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ExternalGroup {
    Seconds { kept: Vec<Iv>, cut: Vec<Iv> },
    Indexed { takes: Vec<WordRange>, keep: usize },
}

#[derive(Deserialize)]
struct WordRange {
    first: usize,
    last: usize,
}

/// A source's word transcript (`transcribe.py --backend parakeet` output,
/// D-379), indexed exactly as the app indexes it for a client.
#[derive(Deserialize)]
struct WordTranscript {
    segments: Vec<TranscriptSegment>,
}

fn word_transcript(source: &str) -> (Vec<IndexedWord>, Vec<RunSpan>) {
    let t: WordTranscript = read_json(&format!(
        "eval/retake/transcripts/{source}.parakeet.words.json"
    ));
    index_transcript(&t.segments)
}

/// One group the gate refused, for the report.
struct Refused {
    group: usize,
    reason: Refusal,
    words: String,
}

/// Resolve index-form groups through the gate: the accepted ones as
/// [`Proposed`] (kept = the kept take's own word span, cut = the gate's padded
/// ranges), the refused ones itemised.
fn gated(
    words: &[IndexedWord],
    groups: &[ProposedGroup],
    p: &GateParams,
) -> (Vec<Proposed>, Vec<Refused>) {
    let mut accepted = Vec::new();
    let mut refused = Vec::new();
    for (gi, (g, v)) in groups
        .iter()
        .zip(check_and_resolve_with(words, groups, p))
        .enumerate()
    {
        match v {
            // The eval never waives (no client vouches for anything here), so a
            // `Confirmed` verdict cannot arise; were it to, it is what the app
            // would apply once a human ticked it, so it is scored as applied.
            GroupVerdict::Accepted { cuts } | GroupVerdict::Confirmed { cuts, .. } => {
                let (a, b) = g.takes[g.keep];
                accepted.push(Proposed {
                    kept: normalise(vec![(words[a].start_secs, words[b].end_secs)]),
                    cut: normalise(cuts.iter().map(|c| (c.start_secs, c.end_secs)).collect()),
                });
            }
            GroupVerdict::Refused { reason, offending } => refused.push(Refused {
                group: gi,
                reason,
                words: offending
                    .iter()
                    .filter_map(|&i| words.get(i).map(|w| format!("{i}:{}", w.text)))
                    .collect::<Vec<_>>()
                    .join(" "),
            }),
        }
    }
    (accepted, refused)
}

/// Read an external proposal file into groups the scorer takes. Index-form
/// groups go through the gate against `source`'s word transcript.
fn external_file(
    path: &std::path::Path,
    source: &str,
    p: &GateParams,
) -> (Vec<Proposed>, Vec<Refused>) {
    let raw =
        std::fs::read_to_string(path).unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));
    let file: ProposalFile =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parsing {}: {e}", path.display()));
    let mut seconds = Vec::new();
    let mut indexed = Vec::new();
    for g in file.groups {
        match g {
            ExternalGroup::Seconds { kept, cut } => seconds.push(Proposed {
                kept: normalise(kept),
                cut: normalise(cut),
            }),
            ExternalGroup::Indexed { takes, keep } => indexed.push(ProposedGroup {
                takes: takes.iter().map(|t| (t.first, t.last)).collect(),
                keep,
            }),
        }
    }
    if indexed.is_empty() {
        return (seconds, Vec::new());
    }
    let (words, _) = word_transcript(source);
    let (mut accepted, refused) = gated(&words, &indexed, p);
    accepted.extend(seconds);
    (accepted, refused)
}

fn print_refused(refused: &[Refused]) {
    for r in refused {
        println!(
            "    REFUSED  group {:>2}: {} — {}",
            r.group, r.reason, r.words
        );
    }
}

/// **Scores external proposals** when [`PROPOSALS_ENV`] is set; a no-op
/// otherwise, so the ordinary run is unchanged.
///
/// ```sh
/// APELLES_RETAKE_EVAL_PROPOSALS=/path/to/dir \
///   cargo test -p apelles-speech --test retake_eval external_proposals -- --nocapture
/// ```
#[test]
fn external_proposals() {
    let Ok(dir) = std::env::var(PROPOSALS_ENV) else {
        return;
    };
    print_header();
    let mut scored = 0;
    for t in task_set() {
        let path = PathBuf::from(&dir).join(format!("{}.json", t.id.replace('/', "__")));
        if !path.exists() {
            continue;
        }
        let labels: Labels = read_json(&t.input.labels);
        let (groups, refused) = external_file(&path, &labels.source, &GateParams::default());
        print_row(&t.id, &run_with(&t, &groups));
        print_refused(&refused);
        scored += 1;
    }
    assert!(
        scored > 0,
        "{PROPOSALS_ENV}={dir}: no task's proposal file was found"
    );
}

// ---------------------------------------------------------------------------
// The coverage gate (D-380), measured on the three labelled sources.

/// The Parakeet tasks — the only ones with a word transcript to index.
fn parakeet_tasks() -> Vec<Task> {
    task_set()
        .into_iter()
        .filter(|t| t.id.ends_with("/parakeet"))
        .collect()
}

/// The words whose midpoint falls in `[start, end)` — how a span in source
/// seconds becomes a word-index range. `None` if no word does.
fn word_range(words: &[IndexedWord], start: f64, end: f64) -> Option<(usize, usize)> {
    let inside: Vec<usize> = words
        .iter()
        .enumerate()
        .filter(|(_, w)| {
            let mid = (w.start_secs + w.end_secs) / 2.0;
            mid >= start - EPS && mid < end - EPS
        })
        .map(|(i, _)| i)
        .collect();
    Some((*inside.first()?, *inside.last()?))
}

/// **The oracle**: every labelled group as the right answer — cut every
/// non-keeper delivery, keep the keeper, nested groups as their own groups in
/// label order. A gate that refuses any of these refuses a correct cut.
///
/// A delivery with no word midpoint inside it is one this word transcript did
/// not hear (C038's first `"So quick recap,"` is in a Whisper reading only); it
/// is left out of its group and listed in the second return value, and a group
/// left with fewer than two takes, or without its keeper, is not proposed.
fn oracle(labels: &Labels, words: &[IndexedWord]) -> (Vec<(String, ProposedGroup)>, Vec<String>) {
    let mut out = Vec::new();
    let mut unheard = Vec::new();
    for g in &labels.retakes {
        let mut takes = Vec::new();
        let mut keep = None;
        for (i, d) in g.deliveries.iter().enumerate() {
            match word_range(words, d.start, d.end) {
                Some(r) => {
                    if i == g.keeper {
                        keep = Some(takes.len());
                    }
                    takes.push(r);
                }
                None => unheard.push(format!("{} delivery {i}", g.id)),
            }
        }
        if let (Some(keep), true) = (keep, takes.len() >= 2) {
            out.push((g.id.clone(), ProposedGroup { takes, keep }));
        }
    }
    (out, unheard)
}

/// The old detector's groups as index-form proposals, each paired with what
/// the eval charges it on its own (its over-cut seconds, in the detector's own
/// segment-level seconds).
fn detector_as_proposals(
    task: &Task,
    labels: &Labels,
    words: &[IndexedWord],
) -> Vec<(ProposedGroup, f64)> {
    let u = load_path(&repo_path(&task.input.transcript).to_string_lossy());
    detect_retakes(&u, &task.params.unwrap_or_default())
        .into_iter()
        .filter_map(|g| {
            let charged = score(labels, &from_detector(std::slice::from_ref(&g))).over_cut_secs;
            let takes: Option<Vec<(usize, usize)>> = g
                .takes
                .iter()
                .map(|t| {
                    word_range(
                        words,
                        g.members[t.first].start_secs,
                        g.members[t.last].end_secs,
                    )
                })
                .collect();
            Some((
                ProposedGroup {
                    takes: takes?,
                    keep: g.keep,
                },
                charged,
            ))
        })
        .collect()
}

/// The committed MCP-client runs (D-379's POC): `client_runs/<run>/`.
fn client_runs() -> Vec<String> {
    let dir = repo_path("eval/retake/client_runs");
    let mut runs: Vec<String> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("reading {}: {e}", dir.display()))
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir() && e.file_name() != "input")
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    runs.sort();
    runs
}

/// The three numbers that set the gate's constants, at one setting.
struct GateNumbers {
    /// Oracle groups proposed (label groups this word transcript can express).
    oracle_groups: usize,
    /// Labelled deliveries with no word in this transcript (left out).
    oracle_unheard: Vec<String>,
    /// Over-cut of the oracle as the gate resolves it — what padding costs.
    oracle_gated_over_cut: f64,
    /// Oracle groups refused — the gate refusing a correct cut.
    oracle_refused: Vec<String>,
    /// Detector groups the eval charges that the gate ACCEPTS — a miss.
    detector_missed: Vec<String>,
    /// Detector groups the eval charges, in total.
    detector_charged: usize,
    /// Detector groups the eval does not charge that the gate refuses.
    detector_clean_refused: usize,
    /// Over-cut of the detector's gate-accepted groups, resolved and scored.
    detector_gated_over_cut: f64,
    /// Per POC run and task: (run, task, over-cut, recall, refused groups).
    clients: Vec<(String, String, Outcome, Vec<Refused>)>,
}

fn measure_gate(p: &GateParams) -> GateNumbers {
    let mut n = GateNumbers {
        oracle_groups: 0,
        oracle_unheard: Vec::new(),
        oracle_gated_over_cut: 0.0,
        oracle_refused: Vec::new(),
        detector_missed: Vec::new(),
        detector_charged: 0,
        detector_clean_refused: 0,
        detector_gated_over_cut: 0.0,
        clients: Vec::new(),
    };
    for t in parakeet_tasks() {
        let labels: Labels = read_json(&t.input.labels);
        let (words, _) = word_transcript(&labels.source);

        let (groups, unheard) = oracle(&labels, &words);
        n.oracle_unheard
            .extend(unheard.into_iter().map(|u| format!("{} {u}", t.id)));
        n.oracle_groups += groups.len();
        let proposals: Vec<ProposedGroup> = groups.iter().map(|(_, g)| g.clone()).collect();
        let (resolved, _) = gated(&words, &proposals, p);
        n.oracle_gated_over_cut += score(&labels, &resolved).over_cut_secs;
        for ((id, _), v) in groups
            .iter()
            .zip(check_and_resolve_with(&words, &proposals, p))
        {
            if let GroupVerdict::Refused { reason, offending } = v {
                n.oracle_refused
                    .push(format!("{} {id}: {reason} {offending:?}", t.id));
            }
        }

        let det = detector_as_proposals(&t, &labels, &words);
        let det_groups: Vec<ProposedGroup> = det.iter().map(|(g, _)| g.clone()).collect();
        // Judged one at a time: the question is whether the gate refuses THIS
        // group, not whether an earlier one shadowed it.
        for (g, charged) in &det {
            let accepted = matches!(
                check_and_resolve_with(&words, std::slice::from_ref(g), p).first(),
                Some(GroupVerdict::Accepted { .. })
            );
            if *charged > EPS {
                n.detector_charged += 1;
                if accepted {
                    n.detector_missed
                        .push(format!("{} {:?} charged {charged:.2}s", t.id, g.takes));
                }
            } else if !accepted {
                n.detector_clean_refused += 1;
            }
        }
        let (kept, _) = gated(&words, &det_groups, p);
        n.detector_gated_over_cut += score(&labels, &kept).over_cut_secs;

        for run in client_runs() {
            let path = repo_path(&format!(
                "eval/retake/client_runs/{run}/{}.json",
                t.id.replace('/', "__")
            ));
            let (groups, refused) = external_file(&path, &labels.source, p);
            n.clients
                .push((run, t.id.clone(), run_with(&t, &groups), refused));
        }
    }
    n
}

/// **The coverage gate, measured and pinned (D-380).** Three numbers set its
/// constants: the oracle — the labels' own answer — must be accepted; every
/// detector group the eval charges as over-cut must be refused; and the nine
/// committed MCP-client runs are re-scored as the app would apply them, gated.
/// All pinned in `eval/retake/gate_baseline.json`, rewritten with
/// [`BASELINE_ENV`] like `baseline.json`.
#[test]
fn the_coverage_gate_measures_as_pinned() {
    let n = measure_gate(&GateParams::default());
    println!(
        "oracle: {} groups, {} refused, gated over-cut {:.2}s; deliveries unheard by this transcript: {:?}",
        n.oracle_groups,
        n.oracle_refused.len(),
        n.oracle_gated_over_cut,
        n.oracle_unheard
    );
    for r in &n.oracle_refused {
        println!("    {r}");
    }
    println!(
        "detector groups charged: {}, accepted by the gate (missed): {}, clean groups refused: {}, gated over-cut: {:.2}s",
        n.detector_charged,
        n.detector_missed.len(),
        n.detector_clean_refused,
        n.detector_gated_over_cut
    );
    for m in &n.detector_missed {
        println!("    MISSED {m}");
    }
    print_header();
    let mut rows = serde_json::Map::new();
    for (run, task, o, refused) in &n.clients {
        let id = format!("{run}/{task}");
        print_row(&id, o);
        print_refused(refused);
        let mut row = baseline_row(o);
        row["refused"] = json!(
            refused
                .iter()
                .map(|r| format!("group {}: {} — {}", r.group, r.reason, r.words))
                .collect::<Vec<_>>()
        );
        rows.insert(id, row);
    }
    let now = json!({
        "$comment": "The coverage gate's committed measurement (D-380) at GateParams::default(). Regenerate: APELLES_RETAKE_EVAL_BASELINE=1 cargo test -p apelles-speech --test retake_eval",
        "oracle": {
            "groups": n.oracle_groups,
            "unheard_deliveries": n.oracle_unheard,
            "refused": n.oracle_refused,
            "gated_over_cut_secs": r3(n.oracle_gated_over_cut),
        },
        "detector": {
            "charged": n.detector_charged,
            "missed": n.detector_missed,
            "clean_refused": n.detector_clean_refused,
            "gated_over_cut_secs": r3(n.detector_gated_over_cut),
        },
        "client_runs": Value::Object(rows),
    });
    let path = repo_path("eval/retake/gate_baseline.json");
    if std::env::var(BASELINE_ENV).as_deref() == Ok("1") {
        let text = serde_json::to_string_pretty(&now).expect("a json! value always serialises");
        std::fs::write(&path, text + "\n")
            .unwrap_or_else(|e| panic!("writing {}: {e}", path.display()));
        println!("wrote {}", path.display());
        return;
    }
    let pinned: Value = read_json("eval/retake/gate_baseline.json");
    assert_eq!(
        now, pinned,
        "the coverage gate no longer measures as eval/retake/gate_baseline.json pins — \
         if intended, rewrite it with {BASELINE_ENV}=1 and commit the diff"
    );
}

/// **The threshold sweep behind [`apelles_speech::proposal::FUZZY_MATCH`] and
/// [`apelles_speech::proposal::MAX_UNALIGNED_CONTENT_RUN`]** — printed when [`SWEEP_ENV`] is `1`, a no-op
/// otherwise. Recorded in `docs/notes/retake-detection.md` §11.3.
#[test]
fn coverage_gate_sweep() {
    if std::env::var(SWEEP_ENV).as_deref() != Ok("1") {
        return;
    }
    println!(
        "{:>6} {:>4} {:>7} {:>7} {:>8} {:>9} {:>10} {:>10}",
        "fuzzy", "run", "oracle", "missed", "det_clean", "det_over", "poc_over", "poc_refuse"
    );
    for fuzzy in [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 1.01] {
        for run in [2, 3, 4, usize::MAX] {
            let n = measure_gate(&GateParams {
                fuzzy_match: fuzzy,
                max_unaligned_content_run: run,
            });
            let poc_over: f64 = n.clients.iter().map(|c| c.2.metrics.over_cut_secs).sum();
            let poc_refused: usize = n.clients.iter().map(|c| c.3.len()).sum();
            println!(
                "{fuzzy:>6.2} {:>4} {:>7} {:>7} {:>8} {:>9.2} {:>10.2} {:>10}",
                if run == usize::MAX {
                    "inf".to_string()
                } else {
                    run.to_string()
                },
                n.oracle_refused.len(),
                n.detector_missed.len(),
                n.detector_clean_refused,
                n.detector_gated_over_cut,
                poc_over,
                poc_refused
            );
        }
    }
}

/// **The app's word view is the POC's input, byte for byte** (D-380). Below
/// the legend, `render_indexed` over the committed word transcript must equal
/// the file each POC client read (`client_runs/input/`, header lines aside), so
/// what was measured is what the app hands a client.
#[test]
fn the_indexed_view_is_the_pocs_input() {
    for t in parakeet_tasks() {
        let labels: Labels = read_json(&t.input.labels);
        let (words, runs) = word_transcript(&labels.source);
        let ours = render_indexed(&words, &runs).unwrap_or_else(|e| panic!("{}: {e}", t.id));
        let poc_path = format!(
            "eval/retake/client_runs/input/{}.words.txt",
            t.id.replace('/', "__")
        );
        let poc = std::fs::read_to_string(repo_path(&poc_path))
            .unwrap_or_else(|e| panic!("reading {poc_path}: {e}"));
        let body = |s: &str| s.splitn(4, '\n').nth(3).unwrap_or_default().to_string();
        assert_eq!(
            body(&ours),
            body(&poc),
            "{}: the indexed view drifted from the POC's input",
            t.id
        );
        assert_eq!(&ours[..ours.len() - body(&ours).len()], INDEXED_VIEW_LEGEND);
    }
}

/// The app's track view (D-380 step 2) is a list of clip windows; one clip
/// showing a whole source must give exactly the POC's input too, run numbers
/// and all — the same golden as above, through `index_pieces`.
#[test]
fn a_one_clip_track_view_is_the_pocs_input() {
    for t in parakeet_tasks() {
        let labels: Labels = read_json(&t.input.labels);
        let tr: WordTranscript = read_json(&format!(
            "eval/retake/transcripts/{}.parakeet.words.json",
            labels.source
        ));
        let (words, runs) = index_transcript(&tr.segments);
        let view = index_pieces(
            &[tr.segments],
            &[ViewPiece {
                source: 0,
                start_secs: 0.0,
                end_secs: f64::INFINITY,
            }],
        )
        .unwrap_or_else(|e| panic!("{}: {e}", t.id));
        assert_eq!(view.words, words, "{}", t.id);
        assert_eq!(
            render_indexed(&view.words, &view.runs).ok(),
            render_indexed(&words, &runs).ok(),
            "{}",
            t.id
        );
    }
}

/// The judging rules the app serves with the view are the POC's prompt,
/// verbatim — the rules D-379's 0.00 s was measured under, not a paraphrase.
#[test]
fn the_served_rules_are_the_pocs_prompt() {
    let prompt = std::fs::read_to_string(repo_path("eval/retake/client_runs/prompt.md"))
        .unwrap_or_else(|e| panic!("reading prompt.md: {e}"));
    assert!(
        prompt.contains(JUDGING_RULES),
        "JUDGING_RULES drifted from eval/retake/client_runs/prompt.md"
    );
    assert!(JUDGING_RULES.starts_with("The transcript is of one raw"));
    assert!(
        JUDGING_RULES
            .trim_end()
            .ends_with("far worse than missing a retake.")
    );
}

/// Every label file a task points at, once each.
fn label_files() -> Vec<(String, Labels)> {
    let paths: BTreeSet<String> = task_set().into_iter().map(|t| t.input.labels).collect();
    paths
        .into_iter()
        .map(|p| (p.clone(), read_json(&p)))
        .collect()
}

/// **The labels for a real source carry real retakes and do not opt out.**
/// Floors on group count and redundant seconds, and the `neutral` cap — the
/// README's guard against a label file that hollows the eval out. The
/// synthetic controls are small by design and are judged by their tasks.
#[test]
fn the_labels_are_not_vacuous() {
    for (path, l) in label_files() {
        if !path.starts_with("eval/retake/labels/") {
            continue;
        }
        let span = total(&l.span());
        let neutral = total(&l.neutral());
        println!(
            "{:<20} {:>2} groups, {:>6.2}s redundant, {:>5.2}s neutral ({:.1}%), {} readings",
            l.source,
            l.retakes.len(),
            l.redundant_secs(),
            neutral,
            100.0 * neutral / span,
            l.readings.len()
        );
        assert!(
            l.retakes.len() >= MIN_GROUPS_PER_SOURCE,
            "{path}: {} groups",
            l.retakes.len()
        );
        assert!(
            l.redundant_secs() >= MIN_REDUNDANT_SECS_PER_SOURCE,
            "{path}: {:.2}s redundant",
            l.redundant_secs()
        );
        assert!(
            neutral <= MAX_NEUTRAL_FRACTION * span,
            "{path}: {neutral:.2}s of {span:.2}s is neutral"
        );
        assert!(
            l.readings.len() >= 2,
            "{path}: labels must rest on at least two independent readings (README)"
        );
    }
}

/// **Every label file is well-formed**: each group has two or more
/// deliveries, in spoken order, inside the labelled span, not overlapping each
/// other or anything else labelled, with a valid keeper.
#[test]
fn every_label_file_is_well_formed() {
    for (path, l) in label_files() {
        let (lo, hi) = l.labelled_span;
        let mut all: Vec<(Iv, String)> = Vec::new();
        let containers = l.containers();
        for (gi, g) in l.retakes.iter().enumerate() {
            assert!(g.deliveries.len() >= 2, "{path}/{}: one delivery", g.id);
            assert!(g.keeper < g.deliveries.len(), "{path}/{}: keeper", g.id);
            for w in g.deliveries.windows(2) {
                assert!(w[0].end <= w[1].start, "{path}/{}: out of order", g.id);
            }
            match containers[gi] {
                // Nested: allowed only inside the container's KEEPER (where a
                // stutter cut matters, and where `redundant_secs` stays exact),
                // and only one level deep.
                Some((cg, cd)) => {
                    let c = &l.retakes[cg];
                    assert_eq!(
                        cd, c.keeper,
                        "{path}/{}: nested in {}'s delivery {cd}, which is not its keeper",
                        g.id, c.id
                    );
                    assert!(
                        containers[cg].is_none(),
                        "{path}/{}: nested two levels deep",
                        g.id
                    );
                }
                None => {
                    for d in &g.deliveries {
                        all.push(((d.start, d.end), g.id.clone()));
                    }
                }
            }
        }
        for p in &l.protected {
            all.push(((p.start, p.end), p.id.clone()));
        }
        for n in &l.neutral {
            all.push(((n.start, n.end), format!("neutral@{}", n.start)));
        }
        all.sort_by(|a, b| a.0.0.total_cmp(&b.0.0));
        for ((s, e), id) in &all {
            assert!(s < e, "{path}/{id}: empty range");
            assert!(*s >= lo && *e <= hi, "{path}/{id}: outside labelled_span");
        }
        for w in all.windows(2) {
            assert!(
                w[0].0.1 <= w[1].0.0 + EPS,
                "{path}: {} overlaps {}",
                w[0].1,
                w[1].1
            );
        }
    }
}

/// **`protected` is a named subset of unique content** — which is what makes
/// it redundant with `over_cut_secs` by construction and kept anyway for the
/// better failure message (README).
#[test]
fn every_protected_range_is_unique_content() {
    for (path, l) in label_files() {
        let unique = l.unique();
        for p in &l.protected {
            let r = normalise(vec![(p.start, p.end)]);
            assert!(
                (overlap(&r, &unique) - total(&r)).abs() < EPS,
                "{path}/{}: not wholly unique content",
                p.id
            );
        }
    }
}

/// **Nested groups, worked by hand.** An outer line said twice (0-5, 5-10,
/// keeper 1) whose kept delivery carries a two-copy stutter (6-7, 7-8, keeper
/// 1). Cutting one stutter copy inside the kept delivery is correct and costs
/// nothing; cutting both loses the stutter's words; cutting the whole kept
/// delivery instead of the other one is judged by the outer group alone.
#[test]
fn the_scorer_matches_a_hand_worked_nested_case() {
    let labels: Labels = serde_json::from_value(json!({
        "source": "hand-nested",
        "labelled_span": [0.0, 12.0],
        "readings": ["hand", "hand"],
        "retakes": [
            { "id": "outer", "keeper": 1, "keeper_confidence": "high",
              "deliveries": [{ "start": 0.0, "end": 5.0 }, { "start": 5.0, "end": 10.0 }] },
            { "id": "stutter", "keeper": 1, "keeper_confidence": "high",
              "deliveries": [{ "start": 6.0, "end": 7.0 }, { "start": 7.0, "end": 8.0 }] }
        ],
        "protected": [],
        "neutral": []
    }))
    .expect("a valid hand case");
    assert_eq!(labels.containers(), vec![None, Some((0, 1))]);
    let close = |a: f64, b: f64| (a - b).abs() < EPS;
    let run = |cut: Vec<Iv>| {
        score(
            &labels,
            &[Proposed {
                kept: Vec::new(),
                cut,
            }],
        )
    };

    // The other delivery and one stutter copy: everything cut repeats.
    let m = run(vec![(0.0, 5.0), (6.0, 7.0)]);
    assert!(close(m.over_cut_secs, 0.0), "{}", m.over_cut_secs);
    assert!(close(m.retake_recall.unwrap_or(f64::NAN), 1.0));

    // Both stutter copies: one of them is lost (the earliest, on the tie).
    let m = run(vec![(0.0, 5.0), (6.0, 8.0)]);
    assert!(close(m.over_cut_secs, 1.0), "{}", m.over_cut_secs);

    // The kept delivery instead of the other: the outer group alone judges it,
    // and the stutter inside a cut delivery is not charged a second time.
    let m = run(vec![(5.0, 10.0)]);
    assert!(close(m.over_cut_secs, 0.0), "{}", m.over_cut_secs);
    // ...and the stutter is moot rather than a group found: the outer group's
    // non-keeper is uncut, so recall is 0 of 1. Counting the moot stutter
    // (both copies cut, so "found") would make it 1 of 2.
    assert_eq!(m.group_recall, Some(0.0));
}

/// **The scorer on a case worked by hand**, so the formulas above are tested
/// against answers rather than only against themselves.
///
/// Span 0-20 s. One group, deliveries 0-5 and 5-10, keeper 1. Protected 12-15,
/// neutral 18-19; everything else unique.
#[test]
fn the_scorer_matches_a_hand_worked_case() {
    let labels: Labels = serde_json::from_value(json!({
        "source": "hand",
        "labelled_span": [0.0, 20.0],
        "readings": ["hand", "hand"],
        "retakes": [{ "id": "g", "keeper": 1, "keeper_confidence": "high",
                      "deliveries": [{ "start": 0.0, "end": 5.0 }, { "start": 5.0, "end": 10.0 }] }],
        "protected": [{ "id": "p", "start": 12.0, "end": 15.0 }],
        "neutral": [{ "start": 18.0, "end": 19.0, "reason": "aside" }]
    }))
    .expect("a valid hand case");
    let close = |a: f64, b: f64| (a - b).abs() < EPS;

    // The right answer: cut delivery 0, keep delivery 1.
    let m = score(
        &labels,
        &[Proposed {
            kept: vec![(5.0, 10.0)],
            cut: vec![(0.0, 5.0)],
        }],
    );
    assert!(close(m.over_cut_secs, 0.0) && close(m.protected_secs_cut, 0.0));
    assert_eq!(
        (
            m.cut_precision,
            m.retake_recall,
            m.group_recall,
            m.keeper_agreement
        ),
        (Some(1.0), Some(1.0), Some(1.0), Some(1.0))
    );

    // Cut 3-12.5 and 18.5-19: delivery 1 entirely, delivery 0's tail, 2.5 s of
    // unique speech, 0.5 s of protected and 0.5 s of neutral. Delivery 0 has
    // the smaller cut fraction (2/5 against 5/5) so it survives, and its 2 s
    // cut are lost.
    let m = score(
        &labels,
        &[Proposed {
            kept: vec![(0.0, 3.0)],
            cut: vec![(3.0, 12.5), (18.5, 19.0)],
        }],
    );
    assert!(close(m.over_cut_secs, 2.0 + 2.5), "{}", m.over_cut_secs);
    assert!(close(m.protected_secs_cut, 0.5));
    assert!(close(m.neutral_cut_secs, 0.5));
    assert!(close(m.proposed_secs, 10.0));
    assert!(close(m.cut_precision.unwrap_or(f64::NAN), 5.0 / 9.5));
    assert!(close(m.retake_recall.unwrap_or(f64::NAN), 1.0));
    // Delivery 0 (not the keeper) has 2 s cut, so the group counts as found;
    // the detector kept delivery 0, which disagrees with the label.
    assert_eq!((m.group_recall, m.keeper_agreement), (Some(1.0), Some(0.0)));

    // The boundary tolerance: a 0.5 s sliver of unique content against a
    // delivery's edge is forgiven and reported; the same sliver in the middle of
    // unique content is charged.
    let m = score(
        &labels,
        &[Proposed {
            kept: vec![(5.0, 10.0)],
            cut: vec![(0.0, 5.0), (10.0, 10.5), (16.0, 16.5)],
        }],
    );
    assert!(
        close(m.boundary_slack_secs, 0.5),
        "{}",
        m.boundary_slack_secs
    );
    assert!(close(m.over_cut_secs, 0.5), "{}", m.over_cut_secs);

    // Nothing proposed: no ratio is defined, and none may read as a pass.
    let m = score(&labels, &[]);
    assert_eq!(
        (
            m.cut_precision,
            m.retake_recall,
            m.group_recall,
            m.keeper_agreement
        ),
        (None, Some(0.0), Some(0.0), None)
    );
}
