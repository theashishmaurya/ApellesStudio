//! # Unsaved-edit recovery copy for the Motion manifest (D-415)
//!
//! **What it is:** one file, `<project>/motion/manifest.recovery.json`, holding
//! the Motion tab's *unsaved* manifest text so a page reload or a terminated web
//! content process (B-274, B-277) does not lose it. The Edit tab's equivalent is
//! the op journal of D-402; the Motion manifest is one small JSON document, so
//! this keeps a snapshot of it instead of a log of ops.
//!
//! **What it does:** [`write`] replaces the copy atomically (a staging file
//! renamed over it, so a death mid-write leaves the previous copy intact),
//! stamping it with a hash of the saved `manifest.json` it was made against;
//! [`read`] returns the copy and whether the saved manifest has changed since
//! ([`Recovery::stale`]); [`clear`] removes it. An explicit save clears it
//! (`chroma_motion_save_manifest` calls [`clear`] after the manifest is written).
//!
//! **What it does NOT do:** it never touches `manifest.json`: the person's
//! explicit Save stays the only thing that writes the saved manifest. Nothing
//! that renders reads this file (a render takes the manifest it is handed, or
//! its own job snapshot, see `job.rs`). No parsing of the text: it may be an
//! unfinished edit that is not valid JSON, and is returned exactly as written.
//! No wall clock, no randomness.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The recovery copy's file name, beside the saved `manifest.json`.
pub const RECOVERY_FILE: &str = "manifest.recovery.json";
/// The saved manifest's file name (the document the copy is made against).
const MANIFEST_FILE: &str = "manifest.json";
/// Bumped on any incompatible change; another value reads as no copy at all.
const RECOVERY_SCHEMA: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
struct Envelope {
    schema: u32,
    /// Hash of the saved `manifest.json` when the copy was written; empty when
    /// the project had no saved manifest yet.
    base: String,
    text: String,
}

/// A recovery copy read back from disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recovery {
    /// The unsaved manifest text, exactly as it was written.
    pub text: String,
    /// True when the saved manifest changed (or appeared, or vanished) after
    /// this copy was made: saving the recovered text would overwrite that.
    pub stale: bool,
}

fn recovery_path(motion_dir: &Path) -> PathBuf {
    motion_dir.join(RECOVERY_FILE)
}

/// Hash of the saved manifest's bytes, or empty when there is none.
fn saved_manifest_hash(motion_dir: &Path) -> Result<String, String> {
    let path = motion_dir.join(MANIFEST_FILE);
    match std::fs::read(&path) {
        Ok(bytes) => Ok(blake3::hash(&bytes).to_hex().to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

/// Replace the recovery copy with `text`, atomically.
pub fn write(motion_dir: &Path, text: &str) -> Result<(), String> {
    std::fs::create_dir_all(motion_dir)
        .map_err(|e| format!("create {}: {e}", motion_dir.display()))?;
    let envelope = Envelope {
        schema: RECOVERY_SCHEMA,
        base: saved_manifest_hash(motion_dir)?,
        text: text.to_string(),
    };
    let body = serde_json::to_string(&envelope).map_err(|e| format!("encode recovery: {e}"))?;
    let path = recovery_path(motion_dir);
    let tmp = motion_dir.join(format!(".{RECOVERY_FILE}.{}.tmp", std::process::id()));
    std::fs::write(&tmp, body).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("replace {}: {e}", path.display())
    })
}

/// The recovery copy, or `None` when there is none (or it is a schema this
/// build does not know).
pub fn read(motion_dir: &Path) -> Result<Option<Recovery>, String> {
    let path = recovery_path(motion_dir);
    let body = match std::fs::read_to_string(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    let envelope: Envelope =
        serde_json::from_str(&body).map_err(|e| format!("parse {}: {e}", path.display()))?;
    if envelope.schema != RECOVERY_SCHEMA {
        return Ok(None);
    }
    let stale = envelope.base != saved_manifest_hash(motion_dir)?;
    Ok(Some(Recovery {
        text: envelope.text,
        stale,
    }))
}

/// Remove the recovery copy; a missing one is not an error.
pub fn clear(motion_dir: &Path) -> Result<(), String> {
    let path = recovery_path(motion_dir);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove {}: {e}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn no_copy_reads_as_none() {
        let d = dir();
        assert_eq!(read(d.path()).unwrap(), None);
    }

    #[test]
    fn written_text_reads_back_exactly_even_when_it_is_not_json() {
        let d = dir();
        let text = "{\n  \"scenes\": [ half typed";
        write(d.path(), text).unwrap();
        let r = read(d.path()).unwrap().unwrap();
        assert_eq!(r.text, text);
        assert!(!r.stale);
    }

    #[test]
    fn a_second_write_replaces_the_first_and_leaves_no_staging_file() {
        let d = dir();
        write(d.path(), "one").unwrap();
        write(d.path(), "two").unwrap();
        assert_eq!(read(d.path()).unwrap().unwrap().text, "two");
        let names: Vec<String> = std::fs::read_dir(d.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec![RECOVERY_FILE.to_string()]);
    }

    #[test]
    fn clear_removes_the_copy_and_is_idempotent() {
        let d = dir();
        write(d.path(), "x").unwrap();
        clear(d.path()).unwrap();
        assert_eq!(read(d.path()).unwrap(), None);
        clear(d.path()).unwrap();
    }

    #[test]
    fn a_copy_made_with_no_saved_manifest_is_stale_once_one_appears() {
        let d = dir();
        write(d.path(), "x").unwrap();
        assert!(!read(d.path()).unwrap().unwrap().stale);
        std::fs::write(d.path().join(MANIFEST_FILE), "{}").unwrap();
        assert!(read(d.path()).unwrap().unwrap().stale);
    }

    #[test]
    fn a_saved_manifest_changed_after_the_copy_makes_it_stale() {
        let d = dir();
        std::fs::write(d.path().join(MANIFEST_FILE), "{\"a\":1}").unwrap();
        write(d.path(), "x").unwrap();
        assert!(!read(d.path()).unwrap().unwrap().stale);
        std::fs::write(d.path().join(MANIFEST_FILE), "{\"a\":2}").unwrap();
        assert!(read(d.path()).unwrap().unwrap().stale);
    }

    #[test]
    fn writing_never_touches_the_saved_manifest() {
        let d = dir();
        std::fs::write(d.path().join(MANIFEST_FILE), "saved").unwrap();
        write(d.path(), "unsaved").unwrap();
        assert_eq!(
            std::fs::read_to_string(d.path().join(MANIFEST_FILE)).unwrap(),
            "saved"
        );
    }

    #[test]
    fn an_unknown_schema_reads_as_no_copy() {
        let d = dir();
        std::fs::write(
            recovery_path(d.path()),
            r#"{"schema":99,"base":"","text":"x"}"#,
        )
        .unwrap();
        assert_eq!(read(d.path()).unwrap(), None);
    }

    #[test]
    fn a_corrupt_copy_is_an_error_not_a_panic() {
        let d = dir();
        std::fs::write(recovery_path(d.path()), "not json").unwrap();
        assert!(read(d.path()).is_err());
    }
}
