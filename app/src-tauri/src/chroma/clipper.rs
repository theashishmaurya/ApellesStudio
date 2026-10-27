//! Tauri bridge for the Automatic Clipper (D-411 Phases 1-2).
//!
//! **What it is.** The app-side half of `apelles_clipper`: thin commands the
//! Edit tab's clipper ops (`editor_auto_clip`, `editor_get_moment_view`,
//! `editor_propose_clips`, …) and the Clipper panel call, so the agent and the
//! person read one analysis and pass one gate.
//!
//! - [`chroma_clipper_analyze`] — the word view (handed in by the op layer as
//!   clip windows onto source transcripts, the D-380 shape) analysed into
//!   sentences, topics, evidence tags and candidates; a page of the moment
//!   view; and its **view id**: a blake3 of the view's identity text (sentence
//!   numbers, times, words) plus each window, so a proposal against a view the
//!   source has since moved away from is refused rather than mapped onto other
//!   words. The evidence measured so far is folded in from this module's
//!   cache.
//! - [`chroma_clipper_check`] — proposals (sentence or word ranges) through
//!   the clean-cut gate, each answered with its verdict, resolved source
//!   ranges and tightening cuts.
//! - [`chroma_clipper_evidence_start`] / [`chroma_clipper_evidence_status`] —
//!   the background passes that measure a source's audio (Silero VAD speech
//!   spans + a loudness envelope, decoded in [`AUDIO_CHUNK_SECS`] windows so an
//!   hour never sits in memory) and picture cuts (`apelles_media::scenes`).
//!   Results are cached in `media_cache` by the file's identity and an
//!   analyser version, so a source is measured once.
//! - `chroma_clip_run_*` — runs persisted as `clips/<run-id>.json` through
//!   `apelles_project::clip_runs`.
//! - [`chroma_clipper_content_hash`] / [`chroma_clipper_copy_grades`] — what a
//!   build needs: the content fingerprint that protects a person's edits from
//!   a rebuild (D-411 §5.3), and a graded long-form clip's grade carried to
//!   the short's new clip id.
//!
//! **What it does NOT do.** Judge (D-411: the MCP client is the only judge —
//! nothing here picks a moment), transcribe (the `@apelles/editor` store owns
//! transcripts and hands their words in, as for retakes), or build a timeline
//! (the TS build composes the existing timeline ops; this module only stores
//! what it is sent).

use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex};

use apelles_clipper::view::{DEFAULT_PAGE_SENTENCES, MAX_PAGE_SENTENCES};
use apelles_clipper::{
    Analysis, AnalysisInput, ClipRun, ClipShape, ClipVerdict, JUDGING_RULES, JUDGING_RULES_VERSION,
    Loudness, RetakeCut, SegmentRef, SourceEvidence, Span, TightenOptions, analyse,
    check_durations, check_proposals, render_identity, render_page,
};
use apelles_media::media_cache;
use apelles_speech::silence::SilenceParams;
use apelles_speech::vad::{FRAME_SECS, SAMPLE_RATE};
use apelles_speech::{
    IndexedView, TranscriptSegment, ViewPiece, index_pieces, rms_envelope, speech_spans,
};
use apelles_timeline::Timeline;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::state;

/// How many hex characters of the blake3 digest a view id keeps (the retake
/// view's rule, D-380).
const VIEW_ID_HEX: usize = 16;

/// The audio pass decodes this many seconds at a time: 16 kHz mono f32 is
/// ~19 MB per window, where a whole hour would be ~230 MB.
pub const AUDIO_CHUNK_SECS: f64 = 300.0;

/// The loudness envelope's hop. Sentence-level means need nothing finer, and
/// an hour is 7200 values.
pub const LOUDNESS_HOP_SECS: f64 = 0.5;

/// The quietest RMS the envelope converts to dB (−120 dBFS), so digital
/// silence is a number.
const RMS_FLOOR: f32 = 1e-6;

/// `media_cache` namespaces, versioned: bump when a pass's output changes.
const AUDIO_NAMESPACE: &str = "clipper-audio-v1";
const SCENES_NAMESPACE: &str = "clipper-scenes-v1";

/// One source's transcript, as the op layer hands it (the store's spliced
/// segments — whole-file pass plus recoveries and applied re-reads).
#[derive(Debug, Clone, Deserialize)]
pub struct SourceWire {
    pub path: String,
    pub segments: Vec<TranscriptSegment>,
}

/// One clip window onto one source, in play order.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PieceWire {
    pub source: usize,
    pub start_secs: f64,
    pub end_secs: f64,
}

/// A reviewed retake's deleted take, in its source's seconds.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetakeCutWire {
    pub source: usize,
    pub start_secs: f64,
    pub end_secs: f64,
}

/// Which tightening a build applies.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TightenWire {
    pub dead_air: bool,
    pub retakes: bool,
}

/// What every analysis is built from.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewRequest {
    pub sources: Vec<SourceWire>,
    pub pieces: Vec<PieceWire>,
    #[serde(default)]
    pub retake_cuts: Vec<RetakeCutWire>,
    pub durations: Vec<u32>,
    #[serde(default)]
    pub focus: Option<String>,
    #[serde(default)]
    pub tighten: Option<TightenWire>,
}

/// [`chroma_clipper_analyze`]'s request.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeRequest {
    #[serde(flatten)]
    pub view: ViewRequest,
    #[serde(default)]
    pub offset: Option<usize>,
    #[serde(default)]
    pub max_sentences: Option<usize>,
    /// Return the sentences, topics and candidates as data (the panel).
    #[serde(default)]
    pub include_analysis: bool,
    /// Render a page of the moment view (the MCP ops).
    #[serde(default)]
    pub render: bool,
}

/// An inclusive range, of sentences or of words.
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct RangeWire {
    pub first: usize,
    pub last: usize,
}

/// One proposal's shape as the op layer forwards it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShapeWire {
    pub segments: Vec<RangeWire>,
    #[serde(default)]
    pub hook: Option<RangeWire>,
    /// `"sentence"` (default — what a client proposes) or `"word"` (a nudged
    /// proposal, already in word indices).
    #[serde(default)]
    pub unit: Option<String>,
}

/// [`chroma_clipper_check`]'s request.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRequest {
    #[serde(flatten)]
    pub view: ViewRequest,
    pub view_id: String,
    pub proposals: Vec<ShapeWire>,
}

/// An analysed view and its id.
struct Built {
    view: IndexedView,
    pieces: Vec<ViewPiece>,
    evidence: Vec<SourceEvidence>,
    retake_cuts: Vec<RetakeCut>,
    durations: Vec<u32>,
    focus: Option<String>,
    tighten: TightenOptions,
    analysis: Analysis,
    view_id: String,
}

impl Built {
    fn input(&self) -> AnalysisInput<'_> {
        AnalysisInput {
            view: &self.view,
            pieces: &self.pieces,
            evidence: &self.evidence,
            retake_cuts: &self.retake_cuts,
            durations: &self.durations,
            focus: self.focus.as_deref(),
            tighten: self.tighten,
        }
    }
}

fn build(req: &ViewRequest) -> Result<Built, String> {
    let durations = check_durations(&req.durations)?;
    let segments: Vec<Vec<TranscriptSegment>> =
        req.sources.iter().map(|s| s.segments.clone()).collect();
    let pieces: Vec<ViewPiece> = req
        .pieces
        .iter()
        .map(|p| ViewPiece {
            source: p.source,
            start_secs: p.start_secs,
            end_secs: p.end_secs,
        })
        .collect();
    let view = index_pieces(&segments, &pieces).map_err(|e| e.to_string())?;
    let evidence: Vec<SourceEvidence> = req
        .sources
        .iter()
        .map(|s| cached_evidence(&s.path))
        .collect();
    let retake_cuts: Vec<RetakeCut> = req
        .retake_cuts
        .iter()
        .map(|c| RetakeCut {
            source: c.source,
            start_secs: c.start_secs,
            end_secs: c.end_secs,
        })
        .collect();
    let tighten = req
        .tighten
        .map_or_else(TightenOptions::default, |t| TightenOptions {
            dead_air: t.dead_air,
            retakes: t.retakes,
        });
    let mut built = Built {
        view,
        pieces,
        evidence,
        retake_cuts,
        durations,
        focus: req.focus.clone().filter(|f| !f.trim().is_empty()),
        tighten,
        analysis: Analysis {
            sentences: Vec::new(),
            sentence_of_word: Vec::new(),
            topics: Vec::new(),
            topic_of_sentence: Vec::new(),
            sentence_tags: Vec::new(),
            candidates: Vec::new(),
            stats: apelles_clipper::SpeakerStats {
                median_wps: 0.0,
                median_db: None,
            },
            source_of_piece: Vec::new(),
            focus_terms: Vec::new(),
        },
        view_id: String::new(),
    };
    built.analysis = analyse(&built.input());
    let mut hasher = blake3::Hasher::new();
    hasher.update(render_identity(&built.analysis).as_bytes());
    for p in &req.pieces {
        let path = req.sources.get(p.source).map_or("", |s| s.path.as_str());
        hasher.update(format!("\n{path}\t{:?}\t{:?}", p.start_secs, p.end_secs).as_bytes());
    }
    built.view_id = hasher
        .finalize()
        .to_hex()
        .as_str()
        .chars()
        .take(VIEW_ID_HEX)
        .collect();
    Ok(built)
}

/// The evidence state of each source, for the status line.
fn evidence_summary(req: &ViewRequest) -> Vec<Value> {
    req.sources
        .iter()
        .map(|s| {
            let st = status_of(&s.path);
            json!({ "path": s.path, "audio": st.audio, "scenes": st.scenes })
        })
        .collect()
}

/// Analyse a source and (optionally) render a page of its moment view.
#[tauri::command]
pub async fn chroma_clipper_analyze(request: AnalyzeRequest) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || analyze_now(&request))
        .await
        .map_err(|e| format!("clipper analysis: {e}"))?
}

fn analyze_now(request: &AnalyzeRequest) -> Result<Value, String> {
    let built = build(&request.view)?;
    let a = &built.analysis;
    let total = a.sentences.len();
    let offset = request.offset.unwrap_or(0).min(total);
    let page = request
        .max_sentences
        .unwrap_or(DEFAULT_PAGE_SENTENCES)
        .clamp(1, MAX_PAGE_SENTENCES);
    let end = (offset + page).min(total);
    let mut out = json!({
        "viewId": built.view_id,
        "totalSentences": total,
        "totalWords": built.view.words.len(),
        "topics": a.topics.len(),
        "candidates": a.candidates.len(),
        "offset": offset,
        "returned": end - offset,
        "nextOffset": if end < total { Value::from(end) } else { Value::Null },
        "rulesVersion": JUDGING_RULES_VERSION,
        "evidence": evidence_summary(&request.view),
    });
    if request.render {
        out["text"] = Value::from(render_page(a, offset, end, built.pieces.len()));
        if offset == 0 {
            out["rules"] = Value::from(JUDGING_RULES);
        }
    }
    if request.include_analysis {
        out["analysis"] = analysis_dto(&built);
    }
    Ok(out)
}

/// The analysis as data, for the Clipper panel.
fn analysis_dto(b: &Built) -> Value {
    let a = &b.analysis;
    let sentences: Vec<Value> = a
        .sentences
        .iter()
        .enumerate()
        .map(|(i, s)| {
            json!({
                "index": i,
                "firstWord": s.first_word,
                "lastWord": s.last_word,
                "piece": s.piece,
                "startSecs": s.start_secs,
                "endSecs": s.end_secs,
                "text": s.text,
                "ending": s.ending,
                "topic": a.topic_of_sentence.get(i).copied().unwrap_or(0),
                "tags": a.sentence_tags.get(i).map(|t| t.iter().map(ToString::to_string).collect::<Vec<_>>()).unwrap_or_default(),
            })
        })
        .collect();
    let topics: Vec<Value> = a
        .topics
        .iter()
        .map(|t| json!({ "firstSentence": t.first_sentence, "lastSentence": t.last_sentence, "keywords": t.keywords }))
        .collect();
    let candidates: Vec<Value> = a
        .candidates
        .iter()
        .map(|c| {
            json!({
                "id": c.id,
                "targetSecs": c.target_secs,
                "firstSentence": c.first_sentence,
                "lastSentence": c.last_sentence,
                "topic": c.topic,
                "rawSecs": c.raw_secs,
                "tightSecs": c.tight_secs,
                "tags": c.tags.iter().map(ToString::to_string).collect::<Vec<_>>(),
                "warnings": c.warnings.iter().map(ToString::to_string).collect::<Vec<_>>(),
            })
        })
        .collect();
    json!({ "sentences": sentences, "topics": topics, "candidates": candidates })
}

/// Convert one wire shape to word refs, or a refusal when a sentence index is
/// past the view (the gate itself speaks words).
fn shape_of(a: &Analysis, w: &ShapeWire) -> Result<ClipShape, (String, Vec<usize>)> {
    let by_word = w.unit.as_deref() == Some("word");
    let convert = |r: RangeWire| -> Result<SegmentRef, (String, Vec<usize>)> {
        if by_word {
            return Ok(SegmentRef {
                first_word: r.first,
                last_word: r.last,
            });
        }
        let n = a.sentences.len();
        let past: Vec<usize> = [r.first, r.last].into_iter().filter(|&s| s >= n).collect();
        if !past.is_empty() {
            return Err((
                format!(
                    "sentence {} is past the view (S0-S{})",
                    past[0],
                    n.saturating_sub(1)
                ),
                Vec::new(),
            ));
        }
        if r.first > r.last {
            return Err((
                format!(
                    "a segment's first sentence S{} is after its last S{}",
                    r.first, r.last
                ),
                Vec::new(),
            ));
        }
        Ok(SegmentRef {
            first_word: a.sentences[r.first].first_word,
            last_word: a.sentences[r.last].last_word,
        })
    };
    Ok(ClipShape {
        hook: w.hook.map(convert).transpose()?,
        segments: w
            .segments
            .iter()
            .copied()
            .map(convert)
            .collect::<Result<_, _>>()?,
    })
}

/// Sentence indices a word range covers.
fn sentences_of(a: &Analysis, s: SegmentRef) -> Value {
    let first = a.sentence_of_word.get(s.first_word).copied();
    let last = a.sentence_of_word.get(s.last_word).copied();
    json!({ "first": first, "last": last, "firstWord": s.first_word, "lastWord": s.last_word })
}

/// Proposals through the clean-cut gate.
#[tauri::command]
pub async fn chroma_clipper_check(request: CheckRequest) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || check_now(&request))
        .await
        .map_err(|e| format!("clipper check: {e}"))?
}

fn check_now(request: &CheckRequest) -> Result<Value, String> {
    let built = build(&request.view)?;
    if built.view_id != request.view_id {
        return Ok(json!({ "stale": true, "viewId": built.view_id }));
    }
    let a = &built.analysis;
    // Shapes that convert go through the gate as one batch (overlap warnings
    // need the batch); a sentence index past the view is answered directly.
    let converted: Vec<Result<ClipShape, (String, Vec<usize>)>> =
        request.proposals.iter().map(|w| shape_of(a, w)).collect();
    let shapes: Vec<ClipShape> = converted
        .iter()
        .filter_map(|c| c.as_ref().ok().cloned())
        .collect();
    let ctx = a.gate(&built.input());
    let mut verdicts = check_proposals(&ctx, &shapes).into_iter();
    let answers: Vec<Value> = converted
        .into_iter()
        .map(|c| match c {
            Err((text, offending)) => json!({
                "verdict": { "verdict": "refused", "reason": { "kind": "sentence_out_of_range" }, "offending": offending },
                "status": "refused",
                "reasonText": text,
                "warnings": [],
            }),
            Ok(shape) => {
                let v = verdicts.next().unwrap_or(ClipVerdict::Refused {
                    reason: apelles_clipper::ClipRefusal::NoSegments,
                    offending: Vec::new(),
                });
                verdict_dto(a, &shape, &v)
            }
        })
        .collect();
    Ok(json!({ "stale": false, "viewId": built.view_id, "verdicts": answers }))
}

fn verdict_dto(a: &Analysis, shape: &ClipShape, v: &ClipVerdict) -> Value {
    let (status, reason_text, warnings, offending_sentences) = match v {
        ClipVerdict::Verified { .. } => ("verified", None, Vec::new(), Vec::new()),
        ClipVerdict::Warned { warnings, .. } => (
            "warned",
            None,
            warnings.iter().map(ToString::to_string).collect(),
            Vec::new(),
        ),
        ClipVerdict::Refused { reason, offending } => {
            let mut s: Vec<usize> = offending
                .iter()
                .filter_map(|&w| a.sentence_of_word.get(w).copied())
                .collect();
            s.dedup();
            ("refused", Some(reason.to_string()), Vec::new(), s)
        }
    };
    json!({
        "shape": shape,
        "verdict": v,
        "status": status,
        "reasonText": reason_text,
        "warnings": warnings,
        "offendingSentences": offending_sentences,
        "sentences": {
            "segments": shape.segments.iter().map(|s| sentences_of(a, *s)).collect::<Vec<_>>(),
            "hook": shape.hook.map(|h| sentences_of(a, h)),
        },
        "text": shape.segments.iter().filter_map(|s| {
            let f = a.sentence_of_word.get(s.first_word).copied()?;
            let l = a.sentence_of_word.get(s.last_word).copied()?;
            Some(a.sentences.get(f..=l)?.iter().map(|x| x.text.as_str()).collect::<Vec<_>>().join(" "))
        }).collect::<Vec<_>>(),
    })
}

// ---------------------------------------------------------------- evidence

/// Where one background pass is.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Pass {
    Idle,
    Running,
    Done,
    Error { error: String },
}

#[derive(Debug, Clone)]
struct FileEvidence {
    audio: Pass,
    scenes: Pass,
    data: SourceEvidence,
}

impl Default for FileEvidence {
    fn default() -> Self {
        Self {
            audio: Pass::Idle,
            scenes: Pass::Idle,
            data: SourceEvidence::default(),
        }
    }
}

/// What the audio pass measures, as cached.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct AudioEvidence {
    speech: Vec<Span>,
    loudness: Loudness,
}

/// Measured evidence per source path, this session. Backed by `media_cache`.
static EVIDENCE: LazyLock<Mutex<HashMap<String, FileEvidence>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn with_evidence<T>(f: impl FnOnce(&mut HashMap<String, FileEvidence>) -> T) -> T {
    let mut guard = EVIDENCE.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut guard)
}

/// The status line of one path.
#[derive(Debug, Clone, Serialize)]
pub struct EvidenceStatus {
    pub audio: Pass,
    pub scenes: Pass,
}

/// A path's status, consulting the disk cache for a pass not yet run here.
fn status_of(path: &str) -> EvidenceStatus {
    hydrate(path);
    with_evidence(|m| {
        let e = m.get(path).cloned().unwrap_or_default();
        EvidenceStatus {
            audio: e.audio,
            scenes: e.scenes,
        }
    })
}

fn cached_evidence(path: &str) -> SourceEvidence {
    hydrate(path);
    with_evidence(|m| m.get(path).map(|e| e.data.clone()).unwrap_or_default())
}

/// Fill an idle pass from `media_cache` when the file was measured before.
fn hydrate(path: &str) {
    let idle = with_evidence(|m| {
        let e = m.entry(path.to_string()).or_default();
        (e.audio == Pass::Idle, e.scenes == Pass::Idle)
    });
    if !(idle.0 || idle.1) {
        return;
    }
    let Ok(key) = media_cache::source_key(Path::new(path)) else {
        return;
    };
    let audio = if idle.0 {
        media_cache::read_json::<AudioEvidence>(AUDIO_NAMESPACE, &key)
    } else {
        None
    };
    let scenes = if idle.1 {
        media_cache::read_json::<Vec<f64>>(SCENES_NAMESPACE, &key)
    } else {
        None
    };
    with_evidence(|m| {
        let e = m.entry(path.to_string()).or_default();
        if let Some(a) = audio
            && e.audio == Pass::Idle
        {
            e.data.speech = Some(a.speech);
            e.data.loudness = Some(a.loudness);
            e.audio = Pass::Done;
        }
        if let Some(s) = scenes
            && e.scenes == Pass::Idle
        {
            e.data.scene_cuts = Some(s);
            e.scenes = Pass::Done;
        }
    });
}

/// Start the audio and/or picture passes for `path` (each at most once at a
/// time; a finished or cached pass is not re-run). Returns the status.
#[tauri::command]
pub async fn chroma_clipper_evidence_start(
    app: tauri::AppHandle,
    path: String,
    audio: bool,
    scenes: bool,
) -> Result<EvidenceStatus, String> {
    hydrate(&path);
    let (run_audio, run_scenes) = with_evidence(|m| {
        let e = m.entry(path.clone()).or_default();
        let ra = audio && matches!(e.audio, Pass::Idle | Pass::Error { .. });
        let rs = scenes && matches!(e.scenes, Pass::Idle | Pass::Error { .. });
        if ra {
            e.audio = Pass::Running;
        }
        if rs {
            e.scenes = Pass::Running;
        }
        (ra, rs)
    });
    if run_audio {
        let (app, p) = (app.clone(), path.clone());
        tauri::async_runtime::spawn(async move {
            let result = audio_pass(&app, &p).await;
            if let Ok(a) = &result
                && let Ok(key) = media_cache::source_key(Path::new(&p))
            {
                media_cache::write_json(AUDIO_NAMESPACE, &key, a);
            }
            with_evidence(|m| {
                let e = m.entry(p.clone()).or_default();
                match result {
                    Ok(a) => {
                        e.data.speech = Some(a.speech);
                        e.data.loudness = Some(a.loudness);
                        e.audio = Pass::Done;
                    }
                    Err(error) => {
                        log::warn!("[clipper] audio pass on {p}: {error}");
                        e.audio = Pass::Error { error };
                    }
                }
            });
        });
    }
    if run_scenes {
        let p = path.clone();
        tauri::async_runtime::spawn(async move {
            let probe_path = p.clone();
            let result = tokio::task::spawn_blocking(move || {
                apelles_media::scenes::detect_scene_cuts(
                    Path::new(&probe_path),
                    apelles_media::scenes::SCENE_THRESHOLD,
                )
            })
            .await
            .map_err(|e| format!("scene pass: {e}"))
            .and_then(|r| r);
            if let Ok(cuts) = &result
                && let Ok(key) = media_cache::source_key(Path::new(&p))
            {
                media_cache::write_json(SCENES_NAMESPACE, &key, cuts);
            }
            with_evidence(|m| {
                let e = m.entry(p.clone()).or_default();
                match result {
                    Ok(cuts) => {
                        e.data.scene_cuts = Some(cuts);
                        e.scenes = Pass::Done;
                    }
                    Err(error) => {
                        log::warn!("[clipper] scene pass on {p}: {error}");
                        e.scenes = Pass::Error { error };
                    }
                }
            });
        });
    }
    Ok(status_of(&path))
}

/// Where each path's passes are.
#[tauri::command]
pub fn chroma_clipper_evidence_status(paths: Vec<String>) -> HashMap<String, EvidenceStatus> {
    paths
        .into_iter()
        .map(|p| {
            let s = status_of(&p);
            (p, s)
        })
        .collect()
}

/// Decode `path` in windows; per window, the loudness envelope and the VAD's
/// speech spans, offset back to source seconds.
async fn audio_pass(app: &tauri::AppHandle, path: &str) -> Result<AudioEvidence, String> {
    let probe_path = path.to_string();
    let refusal = tokio::task::spawn_blocking(move || {
        super::media_understanding::no_audio_message(&probe_path)
    })
    .await
    .map_err(|e| format!("probing {path} for an audio stream: {e}"))?;
    if let Some(message) = refusal {
        return Err(message);
    }
    let session = super::speech::vad_session(app).await?;
    let mut speech: Vec<Span> = Vec::new();
    let mut db: Vec<f32> = Vec::new();
    let mut start = 0.0f64;
    loop {
        let decode_path = path.to_string();
        let samples = tokio::task::spawn_blocking(move || {
            apelles_media::audio::decode_mono_at_rate(
                Path::new(&decode_path),
                start,
                AUDIO_CHUNK_SECS,
                SAMPLE_RATE,
            )
        })
        .await
        .map_err(|e| format!("decoding audio: {e}"))??;
        if samples.is_empty() {
            break;
        }
        let secs = samples.len() as f64 / f64::from(SAMPLE_RATE);
        db.extend(
            rms_envelope(&samples, SAMPLE_RATE, LOUDNESS_HOP_SECS)
                .into_iter()
                .map(|r| 20.0 * r.max(RMS_FLOOR).log10()),
        );
        let probs = tokio::task::spawn_blocking(move || {
            let mut vad = session.lock().map_err(|_| {
                "the VAD session mutex was poisoned by an earlier panic".to_string()
            })?;
            let probs = vad
                .speech_probabilities(&samples)
                .map_err(|e| e.to_string())?;
            Ok::<_, String>(probs)
        })
        .await
        .map_err(|e| format!("running the VAD: {e}"))??;
        for s in speech_spans(&probs, FRAME_SECS, secs, &SilenceParams::default()) {
            let span = Span {
                start_secs: start + s.start_secs,
                end_secs: start + s.end_secs,
            };
            match speech.last_mut() {
                Some(prev) if span.start_secs <= prev.end_secs + FRAME_SECS => {
                    prev.end_secs = prev.end_secs.max(span.end_secs);
                }
                _ => speech.push(span),
            }
        }
        if secs < AUDIO_CHUNK_SECS - LOUDNESS_HOP_SECS {
            break;
        }
        start += AUDIO_CHUNK_SECS;
    }
    Ok(AudioEvidence {
        speech,
        loudness: Loudness {
            start_secs: 0.0,
            hop_secs: LOUDNESS_HOP_SECS,
            db,
        },
    })
}

// ------------------------------------------------------------------- runs

fn current_project_dir() -> Result<std::path::PathBuf, String> {
    state::current_project()
        .map(|p| p.path)
        .ok_or_else(|| "no project open — clip runs are saved inside the project".to_string())
}

/// Save a run (`clips/<run-id>.json`), refused when it fails its schema.
#[tauri::command]
pub fn chroma_clip_run_save(run: ClipRun) -> Result<(), String> {
    apelles_project::clip_runs::save_clip_run(&current_project_dir()?, &run)
}

/// Read one run.
#[tauri::command]
pub fn chroma_clip_run_load(id: String) -> Result<ClipRun, String> {
    apelles_project::clip_runs::load_clip_run(&current_project_dir()?, &id)
}

/// Every run of the open project, newest first, and any unreadable files.
#[tauri::command]
pub fn chroma_clip_run_list() -> Result<Value, String> {
    let (runs, errors) = apelles_project::clip_runs::list_clip_runs(&current_project_dir()?);
    Ok(json!({ "runs": runs, "errors": errors }))
}

/// Delete one run's file (the timelines it built stay).
#[tauri::command]
pub fn chroma_clip_run_delete(id: String) -> Result<(), String> {
    apelles_project::clip_runs::delete_clip_run(&current_project_dir()?, &id)
}

/// A built timeline's content fingerprint: blake3 over its rate, output size,
/// tracks and markers as the backend stores them (name and `origin` left out:
/// renaming a short is not editing it). A rebuild compares it with
/// `origin.built_content_hash` before overwriting anything (D-411 §5.3).
#[tauri::command]
pub fn chroma_clipper_content_hash(timeline: Timeline) -> Result<String, String> {
    content_hash(&timeline)
}

pub(crate) fn content_hash(timeline: &Timeline) -> Result<String, String> {
    let body = json!({
        "rate": timeline.rate,
        "output": timeline.output,
        "tracks": timeline.tracks,
        "markers": timeline.markers,
    });
    let bytes = serde_json::to_vec(&body).map_err(|e| format!("encode timeline: {e}"))?;
    Ok(blake3::hash(&bytes)
        .to_hex()
        .as_str()
        .chars()
        .take(VIEW_ID_HEX)
        .collect())
}

/// One clip id's grade carried to a new clip id.
#[derive(Debug, Clone, Deserialize)]
pub struct GradePair {
    pub from: String,
    pub to: String,
}

/// Copy a long-form clip's grade to the short's clip that plays it, so the
/// short matches the graded long-form (D-411 §5.1). All or nothing.
#[tauri::command]
pub fn chroma_clipper_copy_grades(pairs: Vec<GradePair>) -> Result<usize, String> {
    let pairs: Vec<(String, String)> = pairs.into_iter().map(|p| (p.from, p.to)).collect();
    apelles_project::timeline::copy_clip_grades(&current_project_dir()?, &pairs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(words: &[(&str, f64, f64)]) -> TranscriptSegment {
        TranscriptSegment {
            start: words.first().map_or(0.0, |w| w.1),
            end: words.last().map_or(0.0, |w| w.2),
            words: words
                .iter()
                .map(|(w, s, e)| apelles_speech::TranscriptWord {
                    word: (*w).to_string(),
                    start: *s,
                    end: *e,
                })
                .collect(),
        }
    }

    fn request() -> ViewRequest {
        let mut segs = Vec::new();
        let mut t = 0.0;
        for i in 0..12 {
            let words: Vec<(String, f64, f64)> = (0..6)
                .map(|k| {
                    let w = if k == 5 {
                        format!("done{i}.")
                    } else {
                        format!("word{k}")
                    };
                    let s = t + f64::from(k) * 0.35;
                    (w, s, s + 0.3)
                })
                .collect();
            let refs: Vec<(&str, f64, f64)> =
                words.iter().map(|(w, s, e)| (w.as_str(), *s, *e)).collect();
            segs.push(segment(&refs));
            t += 2.85;
        }
        ViewRequest {
            sources: vec![SourceWire {
                path: "/nonexistent/clipper-test.mov".into(),
                segments: segs,
            }],
            pieces: vec![PieceWire {
                source: 0,
                start_secs: 0.0,
                end_secs: 40.0,
            }],
            retake_cuts: Vec::new(),
            durations: vec![15],
            focus: None,
            tighten: None,
        }
    }

    #[test]
    fn the_view_id_is_stable_and_moves_with_the_words() {
        let a = build(&request()).expect("build");
        let b = build(&request()).expect("build again");
        assert_eq!(a.view_id, b.view_id);
        assert_eq!(a.view_id.len(), VIEW_ID_HEX);
        let mut moved = request();
        moved.sources[0].segments[0].words[0].word = "changed".into();
        assert_ne!(build(&moved).expect("build moved").view_id, a.view_id);
    }

    #[test]
    fn a_stale_view_is_refused_and_sentences_convert_to_words() {
        let req = request();
        let built = build(&req).expect("build");
        let stale = check_now(&CheckRequest {
            view: req.clone(),
            view_id: "0000".into(),
            proposals: Vec::new(),
        })
        .expect("check");
        assert_eq!(stale["stale"], true);
        let answer = check_now(&CheckRequest {
            view: req,
            view_id: built.view_id.clone(),
            proposals: vec![
                ShapeWire {
                    segments: vec![RangeWire { first: 1, last: 5 }],
                    hook: None,
                    unit: None,
                },
                ShapeWire {
                    segments: vec![RangeWire { first: 1, last: 99 }],
                    hook: None,
                    unit: None,
                },
            ],
        })
        .expect("check");
        assert_eq!(answer["stale"], false);
        let v = &answer["verdicts"];
        assert_ne!(v[0]["status"], "refused", "{}", v[0]);
        assert_eq!(v[0]["shape"]["segments"][0]["first_word"], 6);
        assert_eq!(v[0]["sentences"]["segments"][0]["first"], 1);
        assert_eq!(v[1]["status"], "refused");
        assert!(
            v[1]["reasonText"]
                .as_str()
                .unwrap_or_default()
                .contains("past the view")
        );
    }

    #[test]
    fn analysis_pages_and_serves_the_rules_on_page_zero() {
        let req = AnalyzeRequest {
            view: request(),
            offset: None,
            max_sentences: Some(5),
            include_analysis: true,
            render: true,
        };
        let out = analyze_now(&req).expect("analyze");
        assert_eq!(out["totalSentences"], 12);
        assert_eq!(out["nextOffset"], 5);
        assert!(
            out["rules"]
                .as_str()
                .unwrap_or_default()
                .contains("short vertical clips")
        );
        assert!(out["text"].as_str().unwrap_or_default().contains("S4 "));
        assert_eq!(
            out["analysis"]["sentences"].as_array().map(Vec::len),
            Some(12)
        );
        let page2 = analyze_now(&AnalyzeRequest {
            offset: Some(10),
            ..req
        })
        .expect("page 2");
        assert!(page2.get("rules").is_none());
        assert_eq!(page2["nextOffset"], Value::Null);
    }

    #[test]
    fn the_content_hash_ignores_the_name_and_origin() {
        let mut tl = Timeline {
            id: "t".into(),
            name: "Short".into(),
            ..Default::default()
        };
        let h = content_hash(&tl).expect("hash");
        tl.name = "Renamed".into();
        assert_eq!(content_hash(&tl).expect("hash"), h);
        tl.markers.push(apelles_timeline::Marker {
            id: "m".into(),
            frame: 3,
            color: "#ff0000".into(),
            duration_frames: None,
            name: None,
            note: None,
        });
        assert_ne!(content_hash(&tl).expect("hash"), h);
    }
}
