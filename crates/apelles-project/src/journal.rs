//! The Edit timeline's write-ahead journal on disk (B-274, D-402).
//!
//! **What it is.** `<project>/edit-journal.jsonl`: one JSON object per line,
//! each a change the Edit tab's timeline store made, appended the moment it was
//! made. The store saves the whole timeline on a debounce; the journal is what
//! covers the edits made since that save if the web content process dies before
//! it (macOS replaces it under memory pressure, with no chance to run anything).
//! [`ProjectManifest::edit_journal_seq`](crate::ProjectManifest::edit_journal_seq)
//! records, atomically with the saved timeline, the last entry that save
//! includes, so `project.json` + the entries numbered after it is the timeline
//! the store last held.
//!
//! **What it does.** [`append`] one entry, [`read`] them all back (a torn last
//! line from a process dying mid-write is dropped, not an error), and
//! [`compact`] away the entries a save has made redundant.
//!
//! **What it does NOT do.** Interpret an entry. Entries are the frontend's
//! timeline ops (`@apelles/editor`'s `editJournal.ts`), which only the
//! frontend's reducer can apply; this module only needs each one's `seq`. It
//! does not `fsync` an append: the threat is a process dying (the web content
//! process, or this one), and a completed `write` is in the kernel's page cache
//! by then. An OS crash or power loss can lose the newest lines; the manifest's
//! own save is fsynced, so what was saved stays saved.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The journal's file name inside a `.chroma` project directory.
pub const JOURNAL_FILE: &str = "edit-journal.jsonl";

/// Serialises appends and compactions in this process, so two concurrent
/// appends never interleave their bytes and a compaction never drops a line
/// appended while it was rewriting the file.
static JOURNAL_LOCK: Mutex<()> = Mutex::new(());

fn journal_path(project_dir: &Path) -> PathBuf {
    project_dir.join(JOURNAL_FILE)
}

/// The `seq` of one entry, if it has a usable one (a positive integer).
fn entry_seq(entry: &serde_json::Value) -> Option<u64> {
    entry
        .get("seq")
        .and_then(serde_json::Value::as_u64)
        .filter(|s| *s > 0)
}

/// Append `entry` as one line. Refused (never written) without a positive
/// integer `seq`, because an entry [`compact`] and the frontend's replay cannot
/// order is worse than no entry.
pub fn append(project_dir: &Path, entry: &serde_json::Value) -> Result<(), String> {
    if entry_seq(entry).is_none() {
        return Err("a journal entry needs a positive integer `seq`".to_string());
    }
    let mut line =
        serde_json::to_string(entry).map_err(|e| format!("encode journal entry: {e}"))?;
    line.push('\n');
    let _guard = JOURNAL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = journal_path(project_dir);
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    // One `write_all` of the whole line: with O_APPEND the line lands at the
    // end in one piece unless the process dies inside the call, which leaves a
    // torn last line that [`read`] drops.
    f.write_all(line.as_bytes())
        .map_err(|e| format!("append to {}: {e}", path.display()))
}

/// Every parseable entry in the journal, in file order. No journal is an empty
/// list. A line that does not parse, or has no usable `seq`, is skipped: the
/// only way one gets there is a process dying mid-append, which tears the last
/// line, and dropping that one edit is the honest outcome.
pub fn read(project_dir: &Path) -> Result<Vec<serde_json::Value>, String> {
    let path = journal_path(project_dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<serde_json::Value>(line) {
            Ok(v) if entry_seq(&v).is_some() => out.push(v),
            Ok(_) => log::warn!(
                "{}: line {} has no usable seq; skipped",
                path.display(),
                i + 1
            ),
            Err(e) => log::warn!(
                "{}: line {} is torn or malformed ({e}); skipped",
                path.display(),
                i + 1
            ),
        }
    }
    Ok(out)
}

/// Drop every entry numbered `through` or lower: a save recorded in the
/// manifest includes them, so they can never be replayed again. Rewritten
/// atomically (a staging file renamed over the journal); a journal left empty
/// is removed. Only housekeeping: replay already ignores entries at or below
/// the manifest's recorded sequence, so a compaction that never runs costs
/// disk, not correctness.
pub fn compact(project_dir: &Path, through: u64) -> Result<(), String> {
    let _guard = JOURNAL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = journal_path(project_dir);
    let kept: Vec<serde_json::Value> = read(project_dir)?
        .into_iter()
        .filter(|e| entry_seq(e).is_some_and(|s| s > through))
        .collect();
    if kept.is_empty() {
        return match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("remove {}: {e}", path.display())),
        };
    }
    let mut body = String::new();
    for e in &kept {
        body.push_str(&serde_json::to_string(e).map_err(|e| format!("encode journal entry: {e}"))?);
        body.push('\n');
    }
    let tmp = project_dir.join(format!(".{JOURNAL_FILE}.{}.tmp", std::process::id()));
    std::fs::write(&tmp, body).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("replace {}: {e}", path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("apelles_journal_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("scratch dir");
        d
    }

    #[test]
    fn appends_read_back_in_order_and_a_missing_journal_is_empty() {
        let dir = scratch("roundtrip");
        assert!(read(&dir).expect("read").is_empty());
        for seq in 1..=3 {
            append(
                &dir,
                &json!({ "seq": seq, "timelineId": "t", "kind": "op", "op": { "kind": "x" } }),
            )
            .expect("append");
        }
        let seqs: Vec<u64> = read(&dir)
            .expect("read")
            .iter()
            .filter_map(entry_seq)
            .collect();
        assert_eq!(seqs, vec![1, 2, 3]);
    }

    #[test]
    fn an_entry_without_a_seq_is_refused() {
        let dir = scratch("noseq");
        assert!(append(&dir, &json!({ "kind": "op" })).is_err());
        assert!(append(&dir, &json!({ "seq": 0 })).is_err());
        assert!(read(&dir).expect("read").is_empty());
    }

    /// A process killed inside `write` leaves a partial last line. It is the
    /// one lost edit, never a reason to lose the rest.
    #[test]
    fn a_torn_last_line_is_dropped_not_fatal() {
        let dir = scratch("torn");
        append(&dir, &json!({ "seq": 1, "kind": "op" })).expect("append");
        let mut f = OpenOptions::new()
            .append(true)
            .open(journal_path(&dir))
            .expect("open");
        f.write_all(br#"{"seq":2,"kind":"o"#).expect("torn write");
        let seqs: Vec<u64> = read(&dir)
            .expect("read")
            .iter()
            .filter_map(entry_seq)
            .collect();
        assert_eq!(seqs, vec![1]);
    }

    #[test]
    fn compact_drops_what_a_save_includes_and_removes_an_empty_journal() {
        let dir = scratch("compact");
        for seq in 1..=4 {
            append(&dir, &json!({ "seq": seq })).expect("append");
        }
        compact(&dir, 2).expect("compact");
        let seqs: Vec<u64> = read(&dir)
            .expect("read")
            .iter()
            .filter_map(entry_seq)
            .collect();
        assert_eq!(seqs, vec![3, 4]);
        compact(&dir, 4).expect("compact");
        assert!(!journal_path(&dir).exists());
        compact(&dir, 9).expect("compacting no journal is fine");
    }
}
