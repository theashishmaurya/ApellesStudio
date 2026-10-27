//! The user's brand-kit library: one `<id>.json` per kit under
//! `<app data>/brand/kits` (D-416).
//!
//! Load, save (atomic) and delete through [`apelles_motion::library`], the same
//! per-file rule the template library follows: a file that cannot be read, is
//! not JSON, has no string `id`, or is not named after its id drops itself with a
//! named error and the rest still load. The kit schema (and the `version` bump on
//! every save) is the frontend's (`@apelles/brand`'s `kit.ts`).

use std::path::{Path, PathBuf};

use apelles_motion::library;
use apelles_types::ChromaError;
use serde::Serialize;
use serde_json::Value;

const NOUN: &str = "brand kit";

/// `<app data>/brand/kits`.
pub fn kits_dir(app_data_dir: &Path) -> PathBuf {
    crate::brand_root(app_data_dir).join("kits")
}

/// One kit file as read.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LoadedKit {
    pub file: String,
    pub kit: Value,
}

/// The library: what parsed, and what did not.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Library {
    pub kits: Vec<LoadedKit>,
    pub errors: Vec<library::LoadError>,
}

/// Every `*.json` in `dir`, sorted by file name; an absent folder is empty.
pub fn load_library(dir: &Path) -> Result<Library, ChromaError> {
    let (entries, errors) = library::load_dir(dir)?;
    Ok(Library {
        kits: entries
            .into_iter()
            .map(|e| LoadedKit {
                file: e.file,
                kit: e.value,
            })
            .collect(),
        errors,
    })
}

/// Write one kit to `<dir>/<id>.json` atomically; returns the path.
pub fn save_kit(dir: &Path, kit: &Value) -> Result<PathBuf, ChromaError> {
    library::save_entry(dir, kit, NOUN)
}

/// Remove one kit; `Ok(false)` when there was none.
pub fn delete_kit(dir: &Path, id: &str) -> Result<bool, ChromaError> {
    library::delete_entry(dir, id, NOUN)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn save_load_replace_delete() {
        let dir = tmp();
        let path = save_kit(dir.path(), &json!({"id": "acme", "version": 1})).expect("save");
        assert_eq!(path, dir.path().join("acme.json"));
        assert!(!dir.path().join("acme.json.part").exists());
        save_kit(dir.path(), &json!({"id": "acme", "version": 2})).expect("save v2");
        let lib = load_library(dir.path()).expect("load");
        assert_eq!(lib.kits.len(), 1);
        assert_eq!(lib.kits[0].kit["version"], 2);
        assert!(delete_kit(dir.path(), "acme").expect("delete"));
        assert!(!delete_kit(dir.path(), "acme").expect("delete again"));
    }

    #[test]
    fn a_bad_file_drops_itself_with_a_named_error() {
        let dir = tmp();
        save_kit(dir.path(), &json!({"id": "good"})).expect("save");
        std::fs::write(dir.path().join("broken.json"), "{").expect("write");
        std::fs::write(dir.path().join("moved.json"), r#"{"id":"elsewhere"}"#).expect("write");
        let lib = load_library(dir.path()).expect("load");
        assert_eq!(lib.kits.len(), 1);
        let files: Vec<&str> = lib.errors.iter().map(|e| e.file.as_str()).collect();
        assert_eq!(files, ["broken.json", "moved.json"]);
        assert!(lib.errors[1].error.contains("elsewhere.json"));
    }

    #[test]
    fn unsafe_ids_are_refused_with_the_kit_noun() {
        let dir = tmp();
        let err = save_kit(dir.path(), &json!({"id": "../x"})).expect_err("unsafe");
        assert!(err.to_string().contains("brand kit id"));
        assert!(delete_kit(dir.path(), "A").is_err());
    }
}
