//! The Edit timeline's write-ahead journal: the command surface (B-274, D-402).
//!
//! **What it is.** The two commands the Edit tab's timeline store calls around
//! its debounced save: [`chroma_edit_journal_append`] (every edit, the moment it
//! is made) and [`chroma_edit_journal_read`] (once, when a page first loads a
//! project's timeline, to replay what the last page did not get to save). The
//! file format and its rules are `apelles_project::journal`; the save side
//! (recording the included sequence, compacting) is [`record_save`], called by
//! `chroma::edit::chroma_timeline_set`.
//!
//! **What it does NOT do.** Apply an entry: they are the frontend's ops
//! (`@apelles/editor`'s `editJournal.ts` replays them through the same reducer
//! that made them). It journals nothing on its own; only the store writes here.

use std::path::Path;

use serde::Serialize;

use super::project;
use super::state;

fn current_project_dir() -> Result<std::path::PathBuf, String> {
    state::current_project()
        .map(|p| p.path)
        .ok_or_else(|| "no project open".to_string())
}

/// What a freshly loaded page needs to replay: the sequence the saved timeline
/// includes, and every entry still on disk (the frontend filters and orders).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditJournalState {
    pub saved_seq: Option<u64>,
    pub entries: Vec<serde_json::Value>,
}

/// Append one timeline edit to the open project's journal. `async` + a
/// blocking task so the write never sits on the main thread; entries carry
/// their own `seq`, so the order in which concurrent appends land on disk does
/// not matter (replay sorts).
#[tauri::command]
pub async fn chroma_edit_journal_append(entry: serde_json::Value) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        apelles_project::journal::append(&current_project_dir()?, &entry)
    })
    .await
    .map_err(|e| format!("journal append task: {e}"))?
}

/// The open project's journal and the sequence its saved timeline includes.
#[tauri::command]
pub async fn chroma_edit_journal_read() -> Result<EditJournalState, String> {
    tokio::task::spawn_blocking(|| {
        let dir = current_project_dir()?;
        read_state(&dir)
    })
    .await
    .map_err(|e| format!("journal read task: {e}"))?
}

fn read_state(dir: &Path) -> Result<EditJournalState, String> {
    let manifest = project::load_manifest(dir).map_err(|e| e.to_string())?;
    Ok(EditJournalState {
        saved_seq: manifest.edit_journal_seq,
        entries: apelles_project::journal::read(dir)?,
    })
}

/// The journal half of a timeline save, applied to `manifest` BEFORE it is
/// written so the recorded sequence lands atomically with the timeline.
///
/// `Some(seq)`: the saved timeline includes every entry up to `seq`. `None`: a
/// save from a caller that does not journal (a test, the harness, a page whose
/// journal read failed) is authoritative, so it supersedes every entry now on
/// disk; replaying those onto it would apply edits twice. Returns the sequence
/// to compact through once the save has landed.
pub(crate) fn record_save(
    dir: &Path,
    manifest: &mut project::ProjectManifest,
    journal_seq: Option<u64>,
) -> Option<u64> {
    let through = match journal_seq {
        Some(seq) => Some(seq),
        None => match apelles_project::journal::read(dir) {
            Ok(entries) => entries
                .iter()
                .filter_map(|e| e.get("seq").and_then(serde_json::Value::as_u64))
                .max(),
            Err(e) => {
                log::warn!("edit journal unreadable while saving the timeline: {e}");
                None
            }
        },
    }?;
    let recorded = manifest
        .edit_journal_seq
        .map_or(through, |s| s.max(through));
    manifest.edit_journal_seq = Some(recorded);
    Some(recorded)
}

/// Drop the entries a landed save includes. Housekeeping only (replay already
/// ignores them), so a failure is logged, never returned.
pub(crate) fn compact_after_save(dir: &Path, through: u64) {
    if let Err(e) = apelles_project::journal::compact(dir, through) {
        log::warn!("edit journal compaction after a save failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let d =
            std::env::temp_dir().join(format!("apelles_edit_journal_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("scratch dir");
        d
    }

    #[test]
    fn a_journalled_save_records_its_sequence() {
        let dir = scratch("seq");
        let mut m = project::ProjectManifest::fresh("t");
        assert_eq!(record_save(&dir, &mut m, Some(7)), Some(7));
        assert_eq!(m.edit_journal_seq, Some(7));
        // Never backwards: an older sequence cannot un-include an entry.
        assert_eq!(record_save(&dir, &mut m, Some(3)), Some(7));
        assert_eq!(m.edit_journal_seq, Some(7));
    }

    #[test]
    fn an_unjournalled_save_supersedes_every_entry_on_disk() {
        let dir = scratch("supersede");
        for seq in [4, 9, 6] {
            apelles_project::journal::append(&dir, &json!({ "seq": seq })).expect("append");
        }
        let mut m = project::ProjectManifest::fresh("t");
        assert_eq!(record_save(&dir, &mut m, None), Some(9));
        assert_eq!(m.edit_journal_seq, Some(9));
        compact_after_save(&dir, 9);
        assert!(
            apelles_project::journal::read(&dir)
                .expect("read")
                .is_empty()
        );
    }

    #[test]
    fn an_unjournalled_save_with_no_journal_records_nothing() {
        let dir = scratch("none");
        let mut m = project::ProjectManifest::fresh("t");
        assert_eq!(record_save(&dir, &mut m, None), None);
        assert_eq!(m.edit_journal_seq, None);
    }
}
