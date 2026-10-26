//! What an Openverse audio search returns, parsed and filtered (D-400).
//!
//! Parsing is tolerant on purpose: Openverse results carry dozens of fields,
//! many nullable and some added over time, so a hit is read by the handful this
//! tool needs and a result missing one of the essentials (an id, a title, an
//! audio URL, a licence) is dropped and counted, never a failed search.
//!
//! The licence filter runs here as well as in the query: the `license=`
//! parameter is the server's promise, this is the check that does not depend on
//! it.

use serde::Serialize;
use serde_json::Value;

use crate::licence::LicencePolicy;

/// What the caller wants to find. Openverse's own `category` is unreliable for
/// effects (Freesound items mostly carry none), so `Sfx` is "anything that is
/// not music or speech", decided here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Music,
    Sfx,
    Any,
}

impl Kind {
    /// `"music"`, `"sfx"` or `"any"` (the empty string too).
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_lowercase().as_str() {
            "music" => Ok(Self::Music),
            "sfx" | "sound_effect" | "effect" => Ok(Self::Sfx),
            "any" | "" => Ok(Self::Any),
            other => Err(format!(
                "kind must be \"music\", \"sfx\" or \"any\", not {other:?}"
            )),
        }
    }

    /// The `category=` filter the server can apply for this kind. Only music is
    /// reliably categorised.
    pub fn server_category(self) -> Option<&'static str> {
        match self {
            Self::Music => Some("music"),
            Self::Sfx | Self::Any => None,
        }
    }

    fn admits(self, category: Option<&str>) -> bool {
        match self {
            Self::Any => true,
            Self::Music => category == Some("music"),
            Self::Sfx => !matches!(
                category,
                Some("music" | "podcast" | "audiobook" | "news" | "sermon" | "pronunciation")
            ),
        }
    }
}

/// The client-side half of a search request.
#[derive(Debug, Clone)]
pub struct HitFilter {
    pub kind: Kind,
    pub min_secs: Option<f64>,
    pub max_secs: Option<f64>,
    pub policy: LicencePolicy,
}

/// One audio result, in the shape handed to the caller.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioHit {
    pub id: String,
    pub title: String,
    pub creator: Option<String>,
    pub creator_url: Option<String>,
    /// The licence slug (`cc0`, `by`, ...), and its version.
    pub license: String,
    pub license_version: Option<String>,
    pub license_url: Option<String>,
    /// The upstream catalogue (`freesound`, `jamendo`, ...).
    pub source: Option<String>,
    pub category: Option<String>,
    pub duration_secs: Option<f64>,
    /// The audio file itself (a preview-quality MP3 for most sources).
    pub preview_url: String,
    pub filetype: Option<String>,
    /// The page a human credits and checks the licence on.
    pub landing_url: Option<String>,
    /// The ready-to-paste credit line.
    pub attribution: String,
}

/// Why results were left out of a page, so an empty list can be explained.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub licence: u32,
    pub too_short: u32,
    pub too_long: u32,
    pub wrong_kind: u32,
    pub unusable: u32,
}

/// One page of filtered results.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    /// Openverse's total match count for the query (before client filtering).
    pub total: u64,
    pub page: u64,
    pub page_count: u64,
    pub hits: Vec<AudioHit>,
    pub skipped: Skipped,
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// Read one result object, `None` when an essential field is missing.
pub fn parse_hit(v: &Value) -> Option<AudioHit> {
    let id = text(v, "id")?;
    let title = text(v, "title")?;
    let preview_url = text(v, "url")?;
    let license = text(v, "license")?.to_lowercase();
    let license_version = text(v, "license_version");
    let creator = text(v, "creator");
    let attribution = text(v, "attribution").unwrap_or_else(|| {
        compose_attribution(
            &title,
            creator.as_deref(),
            &license,
            license_version.as_deref(),
        )
    });
    Some(AudioHit {
        id,
        title,
        creator,
        creator_url: text(v, "creator_url"),
        license,
        license_version,
        license_url: text(v, "license_url"),
        source: text(v, "source"),
        category: text(v, "category"),
        duration_secs: v
            .get("duration")
            .and_then(Value::as_f64)
            .map(|ms| ms / 1000.0),
        preview_url,
        filetype: text(v, "filetype"),
        landing_url: text(v, "foreign_landing_url"),
        attribution,
    })
}

/// `"Title" by Creator is licensed under CC BY 4.0.` for a result Openverse
/// sent no attribution string for.
pub fn compose_attribution(
    title: &str,
    creator: Option<&str>,
    license: &str,
    version: Option<&str>,
) -> String {
    let by = creator.map(|c| format!(" by {c}")).unwrap_or_default();
    format!(
        "\"{title}\"{by} is licensed under {}.",
        licence_label(license, version)
    )
}

/// `CC BY 4.0`, `CC0 1.0`, `CC BY-SA 4.0`, `Public Domain Mark 1.0`.
pub fn licence_label(license: &str, version: Option<&str>) -> String {
    let v = version.map(|v| format!(" {v}")).unwrap_or_default();
    match license {
        "cc0" => format!("CC0{v}"),
        "pdm" => format!("Public Domain Mark{v}"),
        other => format!("CC {}{v}", other.to_uppercase()),
    }
}

/// Parse a `/v1/audio/` search body and apply `filter`.
pub fn parse_search(body: &str, filter: &HitFilter) -> Result<SearchPage, String> {
    let root: Value = serde_json::from_str(body)
        .map_err(|e| format!("Openverse sent a body that is not JSON: {e}"))?;
    let results = root
        .get("results")
        .and_then(Value::as_array)
        .ok_or("Openverse's answer has no `results` list")?;
    let mut skipped = Skipped::default();
    let mut hits = Vec::new();
    for raw in results {
        let Some(hit) = parse_hit(raw) else {
            skipped.unusable += 1;
            continue;
        };
        if !filter.policy.admits(&hit.license) {
            skipped.licence += 1;
        } else if !filter.kind.admits(hit.category.as_deref()) {
            skipped.wrong_kind += 1;
        } else if matches!((filter.min_secs, hit.duration_secs), (Some(min), Some(d)) if d < min) {
            skipped.too_short += 1;
        } else if matches!((filter.max_secs, hit.duration_secs), (Some(max), Some(d)) if d > max) {
            skipped.too_long += 1;
        } else {
            hits.push(hit);
        }
    }
    let count = |key: &str| root.get(key).and_then(Value::as_u64).unwrap_or(0);
    Ok(SearchPage {
        total: count("result_count"),
        page: count("page"),
        page_count: count("page_count"),
        hits,
        skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real response recorded from `GET /v1/audio/?q=rain&license=cc0,by,by-sa,
    /// by-nc,by-nd,by-nc-sa,by-nc-nd&page_size=20` (2026-10-26): 20 results
    /// across every licence family, Freesound effects with no category and
    /// Jamendo music. No test here touches the network.
    const RECORDED: &str = include_str!("../tests/fixtures/search_rain_all_licences.json");

    fn filter(kind: Kind, licences: Option<&[&str]>) -> HitFilter {
        let req: Option<Vec<String>> =
            licences.map(|l| l.iter().map(|s| (*s).to_owned()).collect());
        HitFilter {
            kind,
            min_secs: None,
            max_secs: None,
            policy: LicencePolicy::from_request(req.as_deref()).expect("policy"),
        }
    }

    #[test]
    fn the_default_policy_keeps_only_cc0_and_by_from_a_mixed_page() {
        let page = parse_search(RECORDED, &filter(Kind::Any, None)).expect("parse");
        assert_eq!(page.total, 240);
        assert_eq!(page.page, 1);
        assert!(!page.hits.is_empty());
        for hit in &page.hits {
            assert!(
                matches!(hit.license.as_str(), "cc0" | "by"),
                "{} {}",
                hit.license,
                hit.title
            );
        }
        // 20 results: 12 are cc0/by (10 `by`, 2 `cc0`... counted from the page),
        // the other 8 are share-alike / NC / ND and counted, not hidden.
        let kept = page.hits.len() as u32;
        assert_eq!(kept + page.skipped.licence, 20);
        assert!(
            page.skipped.licence >= 6,
            "NC/ND/SA rows must be counted: {:?}",
            page.skipped
        );
    }

    #[test]
    fn a_hit_carries_its_credit_and_provenance() {
        let page = parse_search(RECORDED, &filter(Kind::Any, None)).expect("parse");
        let first = &page.hits[0];
        assert_eq!(first.id, "6b072076-066b-45b6-9695-367a6260c96d");
        assert_eq!(first.title, "Rain, Moderate, C.wav");
        assert_eq!(first.creator.as_deref(), Some("InspectorJ"));
        assert_eq!(first.license, "by");
        assert_eq!(first.license_version.as_deref(), Some("4.0"));
        assert_eq!(first.source.as_deref(), Some("freesound"));
        assert_eq!(first.duration_secs, Some(60.116));
        assert!(first.preview_url.ends_with(".mp3"));
        assert!(first.attribution.contains("CC BY 4.0"));
        assert_eq!(
            first.landing_url.as_deref(),
            Some("https://freesound.org/people/InspectorJ/sounds/401275")
        );
    }

    #[test]
    fn nc_and_nd_never_pass_even_if_the_server_returned_them() {
        let page = parse_search(RECORDED, &filter(Kind::Any, Some(&["cc0", "by", "by-sa"])))
            .expect("parse");
        assert!(
            page.hits
                .iter()
                .all(|h| !h.license.contains("nc") && !h.license.contains("nd"))
        );
        // share-alike appears only because it was asked for
        assert!(page.hits.iter().any(|h| h.license == "by-sa"));
    }

    #[test]
    fn kind_and_duration_filters_apply_client_side() {
        let music = parse_search(
            RECORDED,
            &filter(Kind::Music, Some(&["cc0", "by", "by-sa"])),
        )
        .expect("parse");
        assert!(
            music
                .hits
                .iter()
                .all(|h| h.category.as_deref() == Some("music"))
        );
        let sfx = parse_search(RECORDED, &filter(Kind::Sfx, None)).expect("parse");
        assert!(
            sfx.hits
                .iter()
                .all(|h| h.category.as_deref() != Some("music"))
        );
        assert!(!sfx.hits.is_empty());

        let mut short = filter(Kind::Any, None);
        short.max_secs = Some(70.0);
        let page = parse_search(RECORDED, &short).expect("parse");
        assert!(
            page.hits
                .iter()
                .all(|h| h.duration_secs.is_some_and(|d| d <= 70.0))
        );
        assert!(page.skipped.too_long > 0);

        let mut long = filter(Kind::Any, None);
        long.min_secs = Some(120.0);
        let page = parse_search(RECORDED, &long).expect("parse");
        assert!(
            page.hits
                .iter()
                .all(|h| h.duration_secs.is_some_and(|d| d >= 120.0))
        );
        assert!(page.skipped.too_short > 0);
    }

    #[test]
    fn an_incomplete_result_is_counted_not_fatal() {
        let body = r#"{"result_count":2,"page":1,"page_count":1,"results":[
            {"id":"a","title":"No audio url","license":"by"},
            {"id":"b","title":"Ok","url":"https://x/y.mp3","license":"cc0","license_version":"1.0"}]}"#;
        let page = parse_search(body, &filter(Kind::Any, None)).expect("parse");
        assert_eq!(page.hits.len(), 1);
        assert_eq!(page.skipped.unusable, 1);
        assert_eq!(
            page.hits[0].attribution,
            "\"Ok\" is licensed under CC0 1.0."
        );
    }

    #[test]
    fn a_body_that_is_not_a_search_answer_is_an_error() {
        assert!(parse_search("not json", &filter(Kind::Any, None)).is_err());
        assert!(parse_search("{}", &filter(Kind::Any, None)).is_err());
    }

    #[test]
    fn kind_parses_its_three_words() {
        assert_eq!(Kind::parse("music"), Ok(Kind::Music));
        assert_eq!(Kind::parse("SFX"), Ok(Kind::Sfx));
        assert_eq!(Kind::parse("any"), Ok(Kind::Any));
        assert!(Kind::parse("podcast").is_err());
    }
}
