//! **audio_library.rs — the Tauri commands behind `editor_search_audio`,
//! `editor_import_audio` and `editor_get_credits`** (D-400).
//!
//! What it is: the thin shell around `apelles-audio-library` that gives it the
//! open project's directory. The commands are invoked by the Edit tab's control
//! ops (`useEditorControl.ts`), which is how an MCP call reaches them; there is
//! no GUI panel for this (D-400 records why).
//!
//! What it does: a search; a download of one result into
//! `<project>/assets/audio/` with its credit appended to `CREDITS.json` in the
//! same step; and a read of that ledger as video-description text.
//!
//! What it does NOT do: import the file into the media pool or place a clip
//! (the frontend op does that with the existing pool and timeline paths), or
//! run on its own. These are the only network calls in the Edit path, each an
//! explicit tool call, and nothing in the render or grade path links here.

use std::path::{Path, PathBuf};

use apelles_audio_library::client::{
    Client, DEFAULT_PAGE_SIZE, SearchRequest, file_extension, file_stem,
};
use apelles_audio_library::credits::{self, CreditEntry};
use apelles_audio_library::licence::{LicencePolicy, check_slug};
use apelles_audio_library::model::{Kind, SearchPage};
use serde::Serialize;

use super::state;

/// Project-relative folder every import lands in, and its ledger.
const AUDIO_DIR: &str = "assets/audio";
const CREDITS_FILE: &str = "CREDITS.json";

fn project_dir() -> Result<PathBuf, String> {
    state::current_project().map(|p| p.path).ok_or_else(|| {
        "no project open — open one first (audio is saved inside the project)".to_string()
    })
}

fn credits_path(project: &Path) -> PathBuf {
    project.join(AUDIO_DIR).join(CREDITS_FILE)
}

/// Search Openverse for audio. A network call, made only because a tool asked.
#[tauri::command]
pub async fn chroma_audio_search(
    query: String,
    kind: Option<String>,
    min_secs: Option<f64>,
    max_secs: Option<f64>,
    licenses: Option<Vec<String>>,
    page: Option<u32>,
    page_size: Option<u32>,
) -> Result<SearchPage, String> {
    let kind = Kind::parse(kind.as_deref().unwrap_or("any"))?;
    let policy = LicencePolicy::from_request(licenses.as_deref()).map_err(|e| e.to_string())?;
    for (name, v) in [("min_secs", min_secs), ("max_secs", max_secs)] {
        if v.is_some_and(|n| !n.is_finite() || n < 0.0) {
            return Err(format!("{name} must be a non-negative number of seconds"));
        }
    }
    if let (Some(min), Some(max)) = (min_secs, max_secs)
        && min > max
    {
        return Err("min_secs is greater than max_secs".into());
    }
    let client = Client::new()?;
    client
        .search(&SearchRequest {
            query,
            kind,
            min_secs,
            max_secs,
            policy,
            page: page.unwrap_or(1),
            page_size: page_size.unwrap_or(DEFAULT_PAGE_SIZE),
        })
        .await
}

/// What a finished download reports to the op that asked for it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedAudio {
    /// Absolute path of the saved file, for the media pool.
    pub path: String,
    /// The same, relative to the project (what `CREDITS.json` records).
    pub project_file: String,
    pub title: String,
    pub creator: Option<String>,
    pub license: String,
    pub duration_secs: Option<f64>,
    /// The credit line recorded for it.
    pub credit: String,
    /// `false` when the file was already in the project (not downloaded again).
    pub downloaded: bool,
}

/// Download one Openverse result into the project and record its credit.
///
/// The licence is checked on the record Openverse returns for this id, not on
/// what the caller believes: a non-commercial or no-derivatives sound is
/// refused here with the reason, whatever search found it.
#[tauri::command]
pub async fn chroma_audio_download(openverse_id: String) -> Result<DownloadedAudio, String> {
    let project = project_dir()?;
    let client = Client::new()?;
    let hit = client.detail(&openverse_id).await?;
    check_slug(&hit.license).map_err(|e| e.to_string())?;

    let dir = project.join(AUDIO_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let stem = file_stem(&hit.title, &hit.id);

    // Reuse a file an earlier import of this id already saved, whatever its
    // container, rather than downloading it twice.
    let existing = std::fs::read_dir(&dir).ok().and_then(|rd| {
        rd.filter_map(Result::ok).map(|e| e.path()).find(|p| {
            p.file_stem().is_some_and(|s| *s == *stem) && p.extension().is_some_and(|e| e != "part")
        })
    });
    let (dest, downloaded) = match existing {
        Some(path) => (path, false),
        None => {
            // Pick the extension from the response when the record does not say.
            let provisional = dir.join(format!(
                "{stem}.{}",
                file_extension(hit.filetype.as_deref(), &hit.preview_url, None)
            ));
            let (_, content_type) = client.download(&hit.preview_url, &provisional).await?;
            let ext = file_extension(
                hit.filetype.as_deref(),
                &hit.preview_url,
                content_type.as_deref(),
            );
            let dest = dir.join(format!("{stem}.{ext}"));
            if dest != provisional {
                std::fs::rename(&provisional, &dest)
                    .map_err(|e| format!("rename {}: {e}", provisional.display()))?;
            }
            (dest, true)
        }
    };

    let file_name = dest
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("{} has no usable file name", dest.display()))?;
    let project_file = format!("{AUDIO_DIR}/{file_name}");
    let entry = CreditEntry::from_hit(&hit, &project_file);
    let credit = credits::credit_line(&entry);
    credits::record(&credits_path(&project), entry)?;

    Ok(DownloadedAudio {
        path: dest.to_string_lossy().into_owned(),
        project_file,
        title: hit.title,
        creator: hit.creator,
        license: hit.license,
        duration_secs: hit.duration_secs,
        credit,
        downloaded,
    })
}

/// The project's credits ledger, with the video-description text built from it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditsReport {
    pub count: usize,
    /// Ready to paste into a video description; empty when there are none.
    pub text: String,
    pub entries: Vec<CreditEntry>,
    /// Project-relative path of the ledger.
    pub ledger: String,
}

#[tauri::command]
pub fn chroma_audio_credits() -> Result<CreditsReport, String> {
    let project = project_dir()?;
    let entries = credits::load(&credits_path(&project))?;
    Ok(CreditsReport {
        count: entries.len(),
        text: credits::youtube_text(&entries),
        entries,
        ledger: format!("{AUDIO_DIR}/{CREDITS_FILE}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ledger_lives_beside_the_audio() {
        assert_eq!(
            credits_path(Path::new("/p/Demo.chroma")),
            PathBuf::from("/p/Demo.chroma/assets/audio/CREDITS.json")
        );
    }

    #[test]
    fn a_search_names_the_licence_it_refuses_before_any_request() {
        let err = futures_block(chroma_audio_search(
            "rain".into(),
            None,
            None,
            None,
            Some(vec!["by-nc".into()]),
            None,
            None,
        ))
        .expect_err("NC is refused");
        assert!(err.contains("NonCommercial"), "{err}");
    }

    #[test]
    fn a_reversed_duration_window_is_refused_before_any_request() {
        let err = futures_block(chroma_audio_search(
            "rain".into(),
            None,
            Some(30.0),
            Some(5.0),
            None,
            None,
            None,
        ))
        .expect_err("min > max");
        assert!(err.contains("min_secs"), "{err}");
    }

    /// Both rejections happen before the client is built, so the future
    /// resolves without a runtime or a socket; a minimal executor is enough.
    fn futures_block<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(f)
    }
}
