//! Tauri bridge for retake proposals made by the MCP client (D-380 step 2).
//!
//! **What it is.** The app-side half of `apelles_speech::proposal`: thin
//! `#[tauri::command]`s that the Edit tab's ops (`editor_get_word_transcript`,
//! `editor_propose_retakes`, `editor_retranscribe_words`) and the Recut panel
//! call, so the agent and the human see one view, one gate and one answer.
//!
//! - [`chroma_retake_word_view`] — the word-indexed view of a track (a list of
//!   clip windows onto source transcripts), a page of it rendered, and its
//!   **view id**: a blake3 of the whole rendered view plus each clip window, so
//!   a proposal made against a view the timeline has since moved away from is
//!   recognised and refused rather than mapped onto the wrong words.
//! - [`chroma_check_retake_proposals`] — a client's groups against that view,
//!   through the coverage gate, with its per-word confirmations (waivers); each
//!   verdict carries the cut ranges in source seconds and the clip window they
//!   fall in.
//! - [`chroma_gate_detected_retakes`] — **D-382**: the deterministic
//!   detector's groups (takes in source seconds) mapped onto the same view by
//!   word midpoint and put through the same gate, so `editor_detect_retakes`
//!   and the Recut panel's detector rows carry the same verified / refused
//!   status as a client's proposal. The detector itself is unchanged.
//!
//! **What it does NOT do.** No judgement and no model: which stretches are
//! retakes is the MCP client's call, and whether a cut loses words is the
//! crate's deterministic gate. No timeline knowledge either — the caller hands
//! in the clip windows and maps the answer back to clips and frames
//! (`packages/editor/src/retakeWordView.ts`), exactly as `speech.rs`'s
//! detectors leave frames to the op layer (D-318). Nothing is cut here or by
//! any caller of these commands; cutting is `ripple_delete_ranges`.

use std::collections::BTreeSet;

use apelles_speech::proposal::{
    GroupVerdict, IndexedView, JUDGING_RULES, ProposedGroup, Refusal, TranscriptSegment, ViewPiece,
    check_and_resolve, check_and_resolve_waived, index_pieces, is_waivable, render_indexed,
    render_indexed_page, take_from_span, would_cut,
};
use serde::Deserialize;
use serde_json::{Value, json};

/// Words served per page when the caller does not say. An MCP client's tool
/// output is capped (Claude Code's is ~25k tokens); one numbered word line is
/// ~6-8 tokens, so 2500 words is ~15-20k tokens with headroom for the rest of
/// the response. A long recording is read in a few pages.
pub const DEFAULT_PAGE_WORDS: usize = 2500;

/// The most words one page may hold, whatever is asked — the same cap's other
/// side: a page a client cannot receive is worse than two it can.
pub const MAX_PAGE_WORDS: usize = 4000;

/// How many hex characters of the blake3 digest a view id keeps. 64 bits: a
/// collision between two views of one track is not a realistic event, and a
/// shorter id is easier for a client to carry back verbatim.
const VIEW_ID_HEX: usize = 16;

/// One source file's transcript, as the view commands are handed it — the
/// store's spliced segments (whole-file pass plus any isolated re-reads).
#[derive(Debug, Clone, Deserialize)]
pub struct ViewSource {
    pub path: String,
    pub segments: Vec<TranscriptSegment>,
}

/// One clip's window onto one source, in play order. `source` indexes the
/// `sources` list; seconds are that source's own.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewPieceWire {
    pub source: usize,
    pub start_secs: f64,
    pub end_secs: f64,
}

/// One take, inclusive word indices into the view.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct TakeWire {
    pub first: usize,
    pub last: usize,
}

/// One proposed group as the op layer forwards it: the client's takes and
/// keep, and the word indices its justification covers (`waive`, empty for an
/// unconfirmed group).
#[derive(Debug, Clone, Deserialize)]
pub struct ProposalWire {
    pub takes: Vec<TakeWire>,
    pub keep: usize,
    #[serde(default)]
    pub waive: Vec<usize>,
}

/// One take of a detector group, in its source's own seconds.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpanTakeWire {
    pub start_secs: f64,
    pub end_secs: f64,
}

/// One detector group as the op layer forwards it (D-382): which source its
/// takes are in (an index into `sources`), its takes, and its suggested keep.
#[derive(Debug, Clone, Deserialize)]
pub struct DetectedGroupWire {
    pub source: usize,
    pub takes: Vec<SpanTakeWire>,
    pub keep: usize,
}

/// A view, built and identified.
struct BuiltView {
    view: IndexedView,
    view_id: String,
}

/// Index the pieces into one view and fingerprint it. The id covers the whole
/// rendered view — every word, its time and its run — and each piece's source
/// path and window, so anything that changes what an index means changes it.
fn build_view(sources: &[ViewSource], pieces: &[ViewPieceWire]) -> Result<BuiltView, String> {
    let segments: Vec<Vec<TranscriptSegment>> =
        sources.iter().map(|s| s.segments.clone()).collect();
    let crate_pieces: Vec<ViewPiece> = pieces
        .iter()
        .map(|p| ViewPiece {
            source: p.source,
            start_secs: p.start_secs,
            end_secs: p.end_secs,
        })
        .collect();
    let view = index_pieces(&segments, &crate_pieces).map_err(|e| e.to_string())?;
    let text = render_indexed(&view.words, &view.runs).map_err(|e| e.to_string())?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(text.as_bytes());
    for p in pieces {
        let path = sources.get(p.source).map_or("", |s| s.path.as_str());
        hasher.update(format!("\n{path}\t{:?}\t{:?}", p.start_secs, p.end_secs).as_bytes());
    }
    let hex = hasher.finalize().to_hex();
    Ok(BuiltView {
        view,
        view_id: hex.as_str().chars().take(VIEW_ID_HEX).collect(),
    })
}

/// Every word of a view, compact, for the op layer to map indices back to
/// clips and frames: `{text, start, end, piece}`.
fn words_json(v: &IndexedView) -> Vec<Value> {
    v.words
        .iter()
        .zip(&v.piece_of_word)
        .map(|(w, &piece)| {
            json!({ "text": w.text, "start": w.start_secs, "end": w.end_secs, "piece": piece })
        })
        .collect()
}

/// A page of the word view. Pure; the command wraps it.
pub fn word_view(
    sources: &[ViewSource],
    pieces: &[ViewPieceWire],
    offset: usize,
    max_words: Option<usize>,
    include_words: bool,
) -> Result<Value, String> {
    let built = build_view(sources, pieces)?;
    let total = built.view.words.len();
    let per_page = max_words
        .unwrap_or(DEFAULT_PAGE_WORDS)
        .clamp(1, MAX_PAGE_WORDS);
    let from = offset.min(total);
    let to = from.saturating_add(per_page).min(total);
    let text = render_indexed_page(&built.view.words, &built.view.runs, from, to)
        .map_err(|e| e.to_string())?;
    let mut out = json!({
        "viewId": built.view_id,
        "totalWords": total,
        "offset": from,
        "returned": to - from,
        "nextOffset": if to < total { json!(to) } else { Value::Null },
        "text": text,
    });
    if from == 0 {
        out["rules"] = json!(JUDGING_RULES);
    }
    if include_words {
        out["words"] = json!(words_json(&built.view));
    }
    Ok(out)
}

/// The wire form of one refusal reason: `{kind, group?}` as the crate
/// serialises it, plus the human sentence.
fn reason_json(r: Refusal) -> (Value, String) {
    (
        serde_json::to_value(r).unwrap_or(Value::Null),
        r.to_string(),
    )
}

/// Cut ranges with the piece each one falls in (a cut range never crosses a
/// run, so never a piece).
fn cuts_json(v: &IndexedView, cuts: &[apelles_speech::CutRange]) -> Vec<Value> {
    cuts.iter()
        .map(|c| {
            json!({
                "first": c.first,
                "last": c.last,
                "startSecs": c.start_secs,
                "endSecs": c.end_secs,
                "piece": v.piece_of_word.get(c.first).copied().unwrap_or(0),
            })
        })
        .collect()
}

/// Judge a client's groups against the CURRENT view. Pure; the command wraps
/// it. A `view_id` that no longer matches answers `stale: true` and judges
/// nothing — the indices were read off a different transcript.
pub fn check_proposals(
    sources: &[ViewSource],
    pieces: &[ViewPieceWire],
    view_id: &str,
    groups: &[ProposalWire],
) -> Result<Value, String> {
    let built = build_view(sources, pieces)?;
    if built.view_id != view_id {
        return Ok(json!({ "stale": true, "viewId": built.view_id }));
    }
    let proposed: Vec<ProposedGroup> = groups
        .iter()
        .map(|g| ProposedGroup {
            takes: g.takes.iter().map(|t| (t.first, t.last)).collect(),
            keep: g.keep,
        })
        .collect();
    let waivers: Vec<BTreeSet<usize>> = groups
        .iter()
        .map(|g| g.waive.iter().copied().collect())
        .collect();
    let verdicts =
        check_and_resolve_waived(&built.view.words, &proposed, &waivers, &Default::default());
    let verdicts: Vec<Value> = verdicts
        .iter()
        .zip(&proposed)
        .map(|(v, g)| match v {
            GroupVerdict::Accepted { cuts } => json!({
                "verdict": "accepted",
                "cuts": cuts_json(&built.view, cuts),
            }),
            GroupVerdict::Confirmed { cuts, waived } => json!({
                "verdict": "confirmed",
                "cuts": cuts_json(&built.view, cuts),
                "waived": waived,
            }),
            GroupVerdict::Refused { reason, offending } => {
                let (kind, text) = reason_json(*reason);
                // A content refusal is one a person who listens may overrule,
                // so the ranges it WOULD cut travel with it; a malformed or
                // conflicting group has nothing sound to offer.
                let would = if is_waivable(*reason) {
                    cuts_json(&built.view, &would_cut(&built.view.words, g))
                } else {
                    Vec::new()
                };
                json!({
                    "verdict": "refused",
                    "reason": kind,
                    "reasonText": text,
                    "offending": offending,
                    "waivable": is_waivable(*reason),
                    "wouldCut": would,
                })
            }
        })
        .collect();
    Ok(json!({
        "stale": false,
        "viewId": built.view_id,
        "verdicts": verdicts,
        "words": words_json(&built.view),
    }))
}

/// The words of a take, `{index, word}`, for a reviewer to read.
fn take_words(v: &IndexedView, (a, b): (usize, usize)) -> Vec<Value> {
    (a..=b)
        .filter_map(|i| {
            v.words
                .get(i)
                .map(|w| json!({ "index": i, "word": w.text }))
        })
        .collect()
}

/// **D-382: the detector's groups through the coverage gate.** Each take is
/// mapped to the view words of its own source whose midpoint lies inside it
/// (`take_from_span`); a take holding no word is dropped and the keep
/// re-indexed; a group left with fewer than two takes, or without its keeper,
/// cannot be judged and is answered `unmapped` — which the op layer treats as
/// refused, because a cut nobody could check is the over-cut D-318 forbids.
/// The mapped groups are judged together, in the detector's order, with no
/// waivers: nothing vouches for a detector. Pure; the command wraps it.
pub fn gate_detected(
    sources: &[ViewSource],
    pieces: &[ViewPieceWire],
    groups: &[DetectedGroupWire],
) -> Result<Value, String> {
    let built = build_view(sources, pieces)?;
    let v = &built.view;
    let source_of = |i: usize| {
        v.piece_of_word
            .get(i)
            .and_then(|&p| pieces.get(p))
            .map(|p| p.source)
    };
    // Per detector take, the word range it maps to (`None`: no word inside).
    let ranges: Vec<Vec<Option<(usize, usize)>>> = groups
        .iter()
        .map(|g| {
            g.takes
                .iter()
                .map(|t| {
                    take_from_span(&v.words, t.start_secs, t.end_secs, |i| {
                        source_of(i) == Some(g.source)
                    })
                })
                .collect()
        })
        .collect();
    let mapped: Vec<Option<ProposedGroup>> = groups
        .iter()
        .zip(&ranges)
        .map(|(g, rs)| {
            let mut takes = Vec::new();
            let mut keep = None;
            for (ti, r) in rs.iter().enumerate() {
                let Some(r) = *r else { continue };
                if ti == g.keep {
                    keep = Some(takes.len());
                }
                takes.push(r);
            }
            match (keep, takes.len() >= 2) {
                (Some(keep), true) => Some(ProposedGroup { takes, keep }),
                _ => None,
            }
        })
        .collect();
    let judged: Vec<ProposedGroup> = mapped.iter().flatten().cloned().collect();
    let mut verdicts = check_and_resolve(&v.words, &judged).into_iter();
    let word = |i: usize| {
        v.words
            .get(i)
            .map(|w| json!({ "index": i, "word": w.text }))
    };
    let out: Vec<Value> = mapped
        .iter()
        .zip(&ranges)
        .map(|(m, rs)| {
            // Aligned with the DETECTOR's takes, so the op layer can mark each
            // of its rows: `null` for a take that holds no word.
            let takes: Vec<Value> = rs
                .iter()
                .map(|r| r.map_or(Value::Null, |(a, b)| json!(take_words(v, (a, b)))))
                .collect();
            if m.is_none() {
                return json!({ "verdict": "unmapped", "takeWords": takes });
            }
            match verdicts.next() {
                Some(GroupVerdict::Accepted { .. }) => {
                    json!({ "verdict": "accepted", "takeWords": takes })
                }
                Some(GroupVerdict::Refused { reason, offending }) => {
                    let (kind, text) = reason_json(reason);
                    let offending: Vec<Value> = offending.iter().filter_map(|&i| word(i)).collect();
                    json!({
                        "verdict": "refused",
                        "takeWords": takes,
                        "reason": kind,
                        "reasonText": text,
                        "offending": offending,
                        "waivable": is_waivable(reason),
                    })
                }
                // No waivers are passed, so `Confirmed` cannot arise; were it
                // to, it is not a proof, so it is never reported as verified.
                Some(GroupVerdict::Confirmed { .. }) | None => {
                    json!({ "verdict": "unmapped", "takeWords": takes })
                }
            }
        })
        .collect();
    Ok(json!({ "groups": out }))
}

/// The deterministic detector's groups through the coverage gate (D-382) —
/// see [`gate_detected`]. Answers one verdict per group, in order.
#[tauri::command]
pub async fn chroma_gate_detected_retakes(
    sources: Vec<ViewSource>,
    pieces: Vec<ViewPieceWire>,
    groups: Vec<DetectedGroupWire>,
) -> Result<Value, String> {
    gate_detected(&sources, &pieces, &groups)
}

/// The word-indexed view of a track, one page of it, and its view id
/// (D-380 step 2). `sources` are the transcripts (each once), `pieces` the
/// visible clip windows in play order. `rules` — the judging rules a client is
/// served, verbatim from the POC's prompt — come with the page at offset 0;
/// `words` (every word, compact) only when `include_words`.
#[tauri::command]
pub async fn chroma_retake_word_view(
    sources: Vec<ViewSource>,
    pieces: Vec<ViewPieceWire>,
    offset: Option<usize>,
    max_words: Option<usize>,
    include_words: Option<bool>,
) -> Result<Value, String> {
    word_view(
        &sources,
        &pieces,
        offset.unwrap_or(0),
        max_words,
        include_words.unwrap_or(false),
    )
}

/// A client's retake groups through the coverage gate, against the view the
/// same `sources`/`pieces` build now (D-380 step 2). Answers `stale: true`
/// without judging when `view_id` is not the current view's.
#[tauri::command]
pub async fn chroma_check_retake_proposals(
    sources: Vec<ViewSource>,
    pieces: Vec<ViewPieceWire>,
    view_id: String,
    groups: Vec<ProposalWire>,
) -> Result<Value, String> {
    check_proposals(&sources, &pieces, &view_id, &groups)
}

#[cfg(test)]
mod tests {
    use super::*;
    use apelles_speech::proposal::{INDEXED_VIEW_LEGEND, TranscriptWord};

    /// One source, one segment, words 0.5 s apart.
    fn source(path: &str, text: &str) -> ViewSource {
        let words: Vec<TranscriptWord> = text
            .split_whitespace()
            .enumerate()
            .map(|(i, w)| TranscriptWord {
                word: format!(" {w}"),
                start: i as f64 * 0.5,
                end: i as f64 * 0.5 + 0.4,
            })
            .collect();
        let end = words.last().map_or(0.0, |w| w.end);
        ViewSource {
            path: path.into(),
            segments: vec![TranscriptSegment {
                start: 0.0,
                end,
                words,
            }],
        }
    }

    fn whole(source: usize) -> ViewPieceWire {
        ViewPieceWire {
            source,
            start_secs: 0.0,
            end_secs: 1e9,
        }
    }

    fn group(takes: &[(usize, usize)], keep: usize, waive: &[usize]) -> ProposalWire {
        ProposalWire {
            takes: takes
                .iter()
                .map(|&(first, last)| TakeWire { first, last })
                .collect(),
            keep,
            waive: waive.to_vec(),
        }
    }

    fn view_id(v: &Value) -> String {
        v["viewId"].as_str().unwrap_or_default().to_string()
    }

    #[test]
    fn pages_serve_the_rules_once_and_chain_by_next_offset() {
        let s = [source("/a.mov", "one two three four five")];
        let p0 = word_view(&s, &[whole(0)], 0, Some(3), false).unwrap_or_else(|e| panic!("{e}"));
        assert!(
            p0["text"]
                .as_str()
                .is_some_and(|t| t.starts_with(INDEXED_VIEW_LEGEND))
        );
        assert_eq!(p0["rules"].as_str(), Some(JUDGING_RULES));
        assert_eq!(p0["nextOffset"], json!(3));
        assert_eq!(p0["totalWords"], json!(5));
        let p1 = word_view(&s, &[whole(0)], 3, Some(3), true).unwrap_or_else(|e| panic!("{e}"));
        assert!(p1.get("rules").is_none());
        assert_eq!(p1["nextOffset"], Value::Null);
        assert_eq!(p1["returned"], json!(2));
        assert_eq!(view_id(&p0), view_id(&p1), "one view, whatever the page");
        assert_eq!(p1["words"].as_array().map(Vec::len), Some(5));
    }

    #[test]
    fn the_view_id_moves_with_the_words_and_with_the_windows() {
        let a = [source("/a.mov", "one two three")];
        let base = view_id(&word_view(&a, &[whole(0)], 0, None, false).unwrap_or_default());
        let again = view_id(&word_view(&a, &[whole(0)], 0, None, false).unwrap_or_default());
        assert_eq!(base, again, "deterministic");
        assert_eq!(base.len(), VIEW_ID_HEX);
        let reworded = [source("/a.mov", "one two tree")];
        let moved = view_id(&word_view(&reworded, &[whole(0)], 0, None, false).unwrap_or_default());
        assert_ne!(base, moved);
        // Same words, a different window that still holds all of them.
        let wider = ViewPieceWire {
            source: 0,
            start_secs: 0.0,
            end_secs: 2e9,
        };
        let rewindowed = view_id(&word_view(&a, &[wider], 0, None, false).unwrap_or_default());
        assert_ne!(base, rewindowed);
    }

    #[test]
    fn a_stale_view_id_is_answered_without_judging() {
        let s = [source("/a.mov", "the cache the cache")];
        let out = check_proposals(
            &s,
            &[whole(0)],
            "not-this-view",
            &[group(&[(0, 1), (2, 3)], 1, &[])],
        )
        .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(out["stale"], json!(true));
        assert!(out.get("verdicts").is_none());
    }

    #[test]
    fn verdicts_carry_cuts_waivers_and_what_a_refusal_would_cut() {
        let s = [source("/a.mov", "the cache the cache final bin final bill")];
        let id = view_id(&word_view(&s, &[whole(0)], 0, None, false).unwrap_or_default());
        let out = check_proposals(
            &s,
            &[whole(0)],
            &id,
            &[
                group(&[(0, 1), (2, 3)], 1, &[]),
                group(&[(4, 5), (6, 7)], 1, &[5]),
                group(&[(2, 3), (4, 5)], 1, &[]),
                group(&[(0, 1)], 0, &[]),
            ],
        )
        .unwrap_or_else(|e| panic!("{e}"));
        let v = &out["verdicts"];
        assert_eq!(v[0]["verdict"], json!("accepted"));
        assert_eq!(v[0]["cuts"][0]["piece"], json!(0));
        assert_eq!(v[1]["verdict"], json!("confirmed"));
        assert_eq!(v[1]["waived"], json!([5]));
        // A group cutting group 0's kept take is a conflict, never waivable.
        assert_eq!(v[2]["verdict"], json!("refused"));
        assert_eq!(v[2]["reason"]["kind"], json!("cuts_kept_take_of"));
        assert_eq!(v[2]["waivable"], json!(false));
        assert_eq!(v[3]["reason"]["kind"], json!("too_few_takes"));
        assert_eq!(v[3]["wouldCut"], json!([]));
        assert_eq!(out["words"].as_array().map(Vec::len), Some(8));
    }

    #[test]
    fn a_content_refusal_offers_its_cut_to_a_listener() {
        let s = [source("/a.mov", "final bin final bill")];
        let id = view_id(&word_view(&s, &[whole(0)], 0, None, false).unwrap_or_default());
        let out = check_proposals(&s, &[whole(0)], &id, &[group(&[(0, 1), (2, 3)], 1, &[])])
            .unwrap_or_else(|e| panic!("{e}"));
        let r = &out["verdicts"][0];
        assert_eq!(r["reason"]["kind"], json!("content_absent_from_kept_take"));
        assert_eq!(r["offending"], json!([1]));
        assert_eq!(r["waivable"], json!(true));
        assert_eq!(r["wouldCut"][0]["first"], json!(0));
        assert!(r["reasonText"].as_str().is_some_and(|t| !t.is_empty()));
    }

    fn span(start_secs: f64, end_secs: f64) -> SpanTakeWire {
        SpanTakeWire {
            start_secs,
            end_secs,
        }
    }

    #[test]
    fn detector_groups_are_gated_by_word_midpoint() {
        // Words every 0.5 s: "the cache the cache final bin final bill".
        let s = [source("/a.mov", "the cache the cache final bin final bill")];
        let out = gate_detected(
            &s,
            &[whole(0)],
            &[
                // 0.0-0.9 / 1.0-1.9: the cache x2 — verified.
                DetectedGroupWire {
                    source: 0,
                    takes: vec![span(0.0, 0.95), span(1.0, 1.95)],
                    keep: 1,
                },
                // bin / bill — refused, with the word named.
                DetectedGroupWire {
                    source: 0,
                    takes: vec![span(2.0, 2.95), span(3.0, 3.95)],
                    keep: 1,
                },
                // A take on silence holds no word: one take left, unmapped.
                DetectedGroupWire {
                    source: 0,
                    takes: vec![span(20.0, 21.0), span(3.0, 3.95)],
                    keep: 1,
                },
                // The wrong source: no words of it in the view.
                DetectedGroupWire {
                    source: 1,
                    takes: vec![span(0.0, 0.95), span(1.0, 1.95)],
                    keep: 1,
                },
            ],
        )
        .unwrap_or_else(|e| panic!("{e}"));
        let g = &out["groups"];
        assert_eq!(g[0]["verdict"], json!("accepted"));
        assert_eq!(
            g[0]["takeWords"][0][1],
            json!({ "index": 1, "word": "cache" })
        );
        assert_eq!(g[1]["verdict"], json!("refused"));
        assert_eq!(g[1]["offending"], json!([{ "index": 5, "word": "bin" }]));
        assert_eq!(g[2]["verdict"], json!("unmapped"));
        assert_eq!(g[2]["takeWords"][0], Value::Null);
        assert_eq!(g[3]["verdict"], json!("unmapped"));
    }

    #[test]
    fn an_unknown_source_is_an_error_not_a_panic() {
        let s = [source("/a.mov", "one")];
        assert!(word_view(&s, &[whole(3)], 0, None, false).is_err());
    }
}
