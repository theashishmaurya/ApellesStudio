//! The user's Motion template library on disk (D-407).
//!
//! **What it is:** one JSON file per template, `<dir>/<id>.json`, where `dir`
//! is `<app data>/motion/templates`. The storage itself is [`crate::library`]
//! (extracted by D-416 so the brand-kit library shares it). [`load_library`] reads every `*.json` in
//! the folder and returns the parsed documents plus one error per file that
//! could not be read or parsed — a bad file drops itself and never takes the
//! library down with it (D-399's robustness rule, per file). [`save_template`]
//! writes one template atomically (a `.part` sibling, flushed, then renamed
//! over the target), so a crash mid-write leaves the old file or the new one,
//! never half of either. [`delete_template`] removes one.
//!
//! **What it does NOT do:** validate a template's shape. The schema
//! (`packages/motion-engine/src/templateDef.ts`) is zod in TypeScript, the one
//! source of truth, and the frontend's `sanitizeLoadedTemplates` checks each
//! entry against it and reports what fails. This module checks only what the
//! file system needs: the id is a safe file stem (`TEMPLATE_ID_PATTERN`'s
//! rule, restated: lowercase kebab, at most 64) and a file's stem matches the
//! `id` inside it.

use std::path::{Path, PathBuf};

use apelles_types::ChromaError;
use serde::Serialize;
use serde_json::Value;

use crate::library;

/// What the errors call one entry.
const NOUN: &str = "template";

/// `<app data>/motion/templates`.
pub fn templates_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("motion").join("templates")
}

/// The id rule (`TEMPLATE_ID_PATTERN` in `templateDef.ts`): `[a-z0-9]`, then up
/// to 63 of `[a-z0-9-]`. Being a safe file stem is what makes it one here
/// ([`library::is_entry_id`], the rule every per-file library shares).
pub fn is_template_id(id: &str) -> bool {
    library::is_entry_id(id)
}

/// One template file as read: its file name and its JSON.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LoadedEntry {
    pub file: String,
    pub template: Value,
}

/// One file that could not be used, and why.
pub type LoadError = library::LoadError;

/// The library: what parsed, and what did not.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Library {
    pub entries: Vec<LoadedEntry>,
    pub errors: Vec<LoadError>,
}

/// Read every `*.json` in `dir`, sorted by file name ([`library::load_dir`]).
pub fn load_library(dir: &Path) -> Result<Library, ChromaError> {
    let (entries, errors) = library::load_dir(dir)?;
    Ok(Library {
        entries: entries
            .into_iter()
            .map(|e| LoadedEntry {
                file: e.file,
                template: e.value,
            })
            .collect(),
        errors,
    })
}

/// Write `template` to `<dir>/<id>.json` atomically, creating `dir`. Returns
/// the path written.
pub fn save_template(dir: &Path, template: &Value) -> Result<PathBuf, ChromaError> {
    library::save_entry(dir, template, NOUN)
}

/// Remove `<dir>/<id>.json`. `Ok(false)` when there was no such template.
pub fn delete_template(dir: &Path, id: &str) -> Result<bool, ChromaError> {
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
    fn an_absent_folder_is_an_empty_library() {
        let dir = tmp();
        let lib = load_library(&dir.path().join("nope")).expect("load");
        assert_eq!(lib, Library::default());
    }

    #[test]
    fn save_then_load_round_trips_and_leaves_no_part_file() {
        let dir = tmp();
        let t = json!({"schemaVersion": 1, "id": "stat-blue", "name": "Stat", "version": 1});
        let path = save_template(dir.path(), &t).expect("save");
        assert_eq!(path, dir.path().join("stat-blue.json"));
        assert!(!dir.path().join("stat-blue.json.part").exists());
        let lib = load_library(dir.path()).expect("load");
        assert_eq!(lib.entries.len(), 1);
        assert_eq!(lib.entries[0].file, "stat-blue.json");
        assert_eq!(lib.entries[0].template, t);
        assert!(lib.errors.is_empty());
    }

    #[test]
    fn saving_again_replaces_the_file() {
        let dir = tmp();
        save_template(dir.path(), &json!({"id": "a", "version": 1})).expect("v1");
        save_template(dir.path(), &json!({"id": "a", "version": 2})).expect("v2");
        let lib = load_library(dir.path()).expect("load");
        assert_eq!(lib.entries.len(), 1);
        assert_eq!(lib.entries[0].template["version"], 2);
    }

    #[test]
    fn a_bad_file_drops_itself_and_the_rest_still_load() {
        let dir = tmp();
        save_template(dir.path(), &json!({"id": "good", "version": 1})).expect("save");
        std::fs::write(dir.path().join("broken.json"), "{ not json").expect("write");
        std::fs::write(dir.path().join("renamed.json"), r#"{"id": "other"}"#).expect("write");
        std::fs::write(dir.path().join("noid.json"), r#"{"name": "x"}"#).expect("write");
        std::fs::write(dir.path().join("half.json.part"), "{").expect("write");
        std::fs::write(dir.path().join("notes.txt"), "hi").expect("write");
        let lib = load_library(dir.path()).expect("load");
        assert_eq!(lib.entries.len(), 1);
        assert_eq!(lib.entries[0].file, "good.json");
        let files: Vec<&str> = lib.errors.iter().map(|e| e.file.as_str()).collect();
        assert_eq!(files, ["broken.json", "noid.json", "renamed.json"]);
        assert!(lib.errors[0].error.contains("not valid JSON"));
        assert!(lib.errors[1].error.contains("no string \"id\""));
        assert!(lib.errors[2].error.contains("other.json"));
    }

    #[test]
    fn unsafe_ids_are_refused() {
        let dir = tmp();
        for id in ["../escape", "Upper", "", "a/b", "-lead", &"x".repeat(65)] {
            assert!(
                save_template(dir.path(), &json!({ "id": id })).is_err(),
                "{id:?}"
            );
            assert!(delete_template(dir.path(), id).is_err(), "{id:?}");
        }
        assert!(save_template(dir.path(), &json!({"name": "no id"})).is_err());
        assert!(is_template_id("cta-end-card-2"));
    }

    #[test]
    fn delete_reports_whether_there_was_one() {
        let dir = tmp();
        save_template(dir.path(), &json!({"id": "gone"})).expect("save");
        assert!(delete_template(dir.path(), "gone").expect("delete"));
        assert!(!delete_template(dir.path(), "gone").expect("delete again"));
        assert!(load_library(dir.path()).expect("load").entries.is_empty());
    }
}
