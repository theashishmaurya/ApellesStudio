//! The user's Motion template library on disk (D-407).
//!
//! **What it is:** one JSON file per template, `<dir>/<id>.json`, where `dir`
//! is `<app data>/motion/templates`. [`load_library`] reads every `*.json` in
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

use std::io::Write;
use std::path::{Path, PathBuf};

use apelles_types::ChromaError;
use serde::Serialize;
use serde_json::Value;

/// `<app data>/motion/templates`.
pub fn templates_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("motion").join("templates")
}

/// The id rule (`TEMPLATE_ID_PATTERN` in `templateDef.ts`): `[a-z0-9]`, then up
/// to 63 of `[a-z0-9-]`. Being a safe file stem is what makes it one here.
pub fn is_template_id(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    id.len() <= 64
        && (first.is_ascii_lowercase() || first.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// One template file as read: its file name and its JSON.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LoadedEntry {
    pub file: String,
    pub template: Value,
}

/// One file that could not be used, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LoadError {
    pub file: String,
    pub error: String,
}

/// The library: what parsed, and what did not.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Library {
    pub entries: Vec<LoadedEntry>,
    pub errors: Vec<LoadError>,
}

/// Read every `*.json` in `dir`, sorted by file name. An absent folder is an
/// empty library (nobody has saved one yet), not an error. Leftover `.part`
/// files from an interrupted write and anything else that is not `*.json` are
/// ignored.
pub fn load_library(dir: &Path) -> Result<Library, ChromaError> {
    let mut library = Library::default();
    if !dir.is_dir() {
        return Ok(library);
    }
    let read = std::fs::read_dir(dir)
        .map_err(|e| ChromaError::Invalid(format!("read {}: {e}", dir.display())))?;
    let mut files: Vec<PathBuf> = read
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| p.is_file() && p.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    for path in files {
        let file = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        match read_entry(&path, &file) {
            Ok(template) => library.entries.push(LoadedEntry { file, template }),
            Err(error) => library.errors.push(LoadError { file, error }),
        }
    }
    Ok(library)
}

fn read_entry(path: &Path, file: &str) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("read: {e}"))?;
    let value: Value = serde_json::from_str(&text).map_err(|e| format!("not valid JSON: {e}"))?;
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "no string \"id\"".to_string())?;
    let stem = file.strip_suffix(".json").unwrap_or(file);
    if id != stem {
        return Err(format!(
            "its id is \"{id}\", so the file must be named {id}.json"
        ));
    }
    Ok(value)
}

/// Write `template` to `<dir>/<id>.json` atomically, creating `dir`. Returns
/// the path written.
pub fn save_template(dir: &Path, template: &Value) -> Result<PathBuf, ChromaError> {
    let id = template
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| ChromaError::Invalid("template has no string \"id\"".into()))?;
    if !is_template_id(id) {
        return Err(ChromaError::Invalid(format!(
            "template id \"{id}\" must be lowercase letters, digits and hyphens (at most 64)"
        )));
    }
    std::fs::create_dir_all(dir)
        .map_err(|e| ChromaError::Invalid(format!("create {}: {e}", dir.display())))?;
    let target = dir.join(format!("{id}.json"));
    let part = dir.join(format!("{id}.json.part"));
    let pretty = serde_json::to_string_pretty(template)
        .map_err(|e| ChromaError::Invalid(format!("serialise {id}: {e}")))?;
    {
        let mut f = std::fs::File::create(&part)
            .map_err(|e| ChromaError::Invalid(format!("create {}: {e}", part.display())))?;
        f.write_all(pretty.as_bytes())
            .and_then(|()| f.write_all(b"\n"))
            .and_then(|()| f.sync_all())
            .map_err(|e| ChromaError::Invalid(format!("write {}: {e}", part.display())))?;
    }
    std::fs::rename(&part, &target)
        .map_err(|e| ChromaError::Invalid(format!("move into {}: {e}", target.display())))?;
    Ok(target)
}

/// Remove `<dir>/<id>.json`. `Ok(false)` when there was no such template.
pub fn delete_template(dir: &Path, id: &str) -> Result<bool, ChromaError> {
    if !is_template_id(id) {
        return Err(ChromaError::Invalid(format!(
            "\"{id}\" is not a template id"
        )));
    }
    let target = dir.join(format!("{id}.json"));
    if !target.is_file() {
        return Ok(false);
    }
    std::fs::remove_file(&target)
        .map_err(|e| ChromaError::Invalid(format!("remove {}: {e}", target.display())))?;
    Ok(true)
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
