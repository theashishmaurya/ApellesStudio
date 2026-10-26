//! The credits ledger (D-400): every clip of audio pulled from Openverse gets a
//! line in `<project>/assets/audio/CREDITS.json`, and [`youtube_text`] turns the
//! ledger into the text a video description needs.
//!
//! **Why a ledger.** CC BY is a promise to credit the creator wherever the work
//! is published. Nothing else records that an imported sound came from
//! somewhere that asked for it, so the import writes the record in the same step
//! as the file, and the credits tool reads it back; nothing depends on anybody
//! remembering.
//!
//! **What it does NOT do:** decide whether a clip is used on the timeline (a
//! credit for a sound later deleted is harmless; a missing one is not), or talk
//! to the network.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::model::{AudioHit, licence_label};

/// One imported sound.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditEntry {
    pub openverse_id: String,
    pub title: String,
    #[serde(default)]
    pub creator: Option<String>,
    #[serde(default)]
    pub creator_url: Option<String>,
    pub license: String,
    #[serde(default)]
    pub license_version: Option<String>,
    #[serde(default)]
    pub license_url: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub landing_url: Option<String>,
    /// Openverse's own attribution sentence, kept verbatim.
    pub attribution: String,
    /// The imported file, relative to the project directory.
    pub file: String,
}

impl CreditEntry {
    /// The entry for a search/detail hit saved as `file` (project-relative).
    pub fn from_hit(hit: &AudioHit, file: &str) -> Self {
        Self {
            openverse_id: hit.id.clone(),
            title: hit.title.clone(),
            creator: hit.creator.clone(),
            creator_url: hit.creator_url.clone(),
            license: hit.license.clone(),
            license_version: hit.license_version.clone(),
            license_url: hit.license_url.clone(),
            source: hit.source.clone(),
            landing_url: hit.landing_url.clone(),
            attribution: hit.attribution.clone(),
            file: file.to_owned(),
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
struct Ledger {
    #[serde(default)]
    credits: Vec<CreditEntry>,
}

/// The ledger at `path`; absent means no credits yet.
pub fn load(path: &Path) -> Result<Vec<CreditEntry>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str::<Ledger>(&text)
            .map(|l| l.credits)
            .map_err(|e| format!("{} is not a credits file: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

/// Add `entry` to the ledger at `path`, replacing an earlier entry for the same
/// Openverse id (re-importing a sound is not a second credit). Written whole to
/// a sibling file and renamed over, so a crash never leaves half a ledger.
pub fn record(path: &Path, entry: CreditEntry) -> Result<(), String> {
    let mut credits = load(path)?;
    match credits
        .iter_mut()
        .find(|c| c.openverse_id == entry.openverse_id)
    {
        Some(existing) => *existing = entry,
        None => credits.push(entry),
    }
    let text = serde_json::to_string_pretty(&Ledger { credits })
        .map_err(|e| format!("serialise credits: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text + "\n").map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("replace {}: {e}", path.display()))
}

/// One credit line: `"Title" by Creator (landing page) — CC BY 4.0 (licence url)`.
pub fn credit_line(c: &CreditEntry) -> String {
    let by = c
        .creator
        .as_deref()
        .map(|n| format!(" by {n}"))
        .unwrap_or_default();
    let page = c
        .landing_url
        .as_deref()
        .map(|u| format!(" ({u})"))
        .unwrap_or_default();
    let licence = licence_label(&c.license, c.license_version.as_deref());
    let url = c
        .license_url
        .as_deref()
        .map(|u| format!(" ({u})"))
        .unwrap_or_default();
    format!("\"{}\"{by}{page} — {licence}{url}", c.title)
}

/// The ledger as ready-to-paste video-description text. CC BY entries (which
/// *require* the credit) come first, then the no-credit-needed ones, each
/// group in import order. Empty ledger gives an empty string.
pub fn youtube_text(credits: &[CreditEntry]) -> String {
    if credits.is_empty() {
        return String::new();
    }
    let needs_credit = |c: &&CreditEntry| !matches!(c.license.as_str(), "cc0" | "pdm");
    let mut lines = vec!["Audio credits".to_owned()];
    lines.extend(credits.iter().filter(needs_credit).map(credit_line));
    let free: Vec<&CreditEntry> = credits.iter().filter(|c| !needs_credit(c)).collect();
    if !free.is_empty() {
        lines.push(String::new());
        lines.push("Public domain (credit appreciated, not required)".to_owned());
        lines.extend(free.into_iter().map(credit_line));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, title: &str, licence: &str) -> CreditEntry {
        CreditEntry {
            openverse_id: id.into(),
            title: title.into(),
            creator: Some("Ada".into()),
            creator_url: None,
            license: licence.into(),
            license_version: Some(if licence == "cc0" { "1.0" } else { "4.0" }.into()),
            license_url: Some(format!(
                "https://creativecommons.org/licenses/{licence}/4.0/"
            )),
            source: Some("freesound".into()),
            landing_url: Some(format!("https://freesound.org/s/{id}")),
            attribution: "…".into(),
            file: format!("assets/audio/{id}.mp3"),
        }
    }

    #[test]
    fn a_cc_by_line_names_title_creator_page_and_licence() {
        assert_eq!(
            credit_line(&entry("1", "Heavy Rain", "by")),
            "\"Heavy Rain\" by Ada (https://freesound.org/s/1) — CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)"
        );
    }

    #[test]
    fn description_text_lists_required_credits_before_public_domain() {
        let text = youtube_text(&[entry("1", "Thunder", "cc0"), entry("2", "Rain", "by")]);
        let rain = text.find("\"Rain\"").expect("rain line");
        let thunder = text.find("\"Thunder\"").expect("thunder line");
        assert!(text.starts_with("Audio credits\n"));
        assert!(rain < thunder, "{text}");
        assert!(text.contains("Public domain"));
        assert_eq!(youtube_text(&[]), "");
    }

    #[test]
    fn the_ledger_round_trips_and_a_reimport_replaces_rather_than_duplicates() {
        let dir = std::env::temp_dir().join(format!("apelles-credits-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("CREDITS.json");
        let _ = std::fs::remove_file(&path);
        assert_eq!(load(&path).expect("absent is empty"), vec![]);
        record(&path, entry("1", "Rain", "by")).expect("first");
        record(&path, entry("2", "Wind", "cc0")).expect("second");
        let mut again = entry("1", "Rain (renamed)", "by");
        again.file = "assets/audio/other.mp3".into();
        record(&path, again).expect("re-import");
        let all = load(&path).expect("load");
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].title, "Rain (renamed)");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
