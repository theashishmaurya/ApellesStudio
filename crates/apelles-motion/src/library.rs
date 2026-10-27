//! A per-file JSON library on disk: one `<id>.json` per entry (D-407, generalised
//! by D-416).
//!
//! **What it is:** the storage rule D-407 wrote for the template library, now
//! shared by every library that keeps one document per file — the Motion template
//! library ([`crate::templates`]) and the brand-kit library (`apelles-brand`).
//! [`load_dir`] reads every `*.json` in a folder and returns the parsed documents
//! plus one error per file that could not be read or parsed, so a bad file drops
//! itself and never takes the library down with it. [`save_entry`] writes one
//! document atomically (a `.part` sibling, flushed, then renamed over the target),
//! so a crash mid-write leaves the old file or the new one, never half of either.
//! [`delete_entry`] removes one.
//!
//! **What it does NOT do:** validate a document's shape. Each library's schema is
//! zod in TypeScript, the one source of truth, and the frontend checks each entry
//! against it. This module checks only what the file system needs: the id is a
//! safe file stem ([`is_entry_id`]) and a file's stem matches the `id` inside it.
//! `noun` ("template", "brand kit") only words the errors.

use std::io::Write;
use std::path::{Path, PathBuf};

use apelles_types::ChromaError;
use serde::Serialize;
use serde_json::Value;

/// The longest id a library entry may have.
pub const MAX_ENTRY_ID_LEN: usize = 64;

/// The id rule: `[a-z0-9]`, then up to 63 of `[a-z0-9-]`. Being a safe file stem
/// is what makes it one here.
pub fn is_entry_id(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    id.len() <= MAX_ENTRY_ID_LEN
        && (first.is_ascii_lowercase() || first.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// One file as read: its file name and its JSON.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LoadedFile {
    pub file: String,
    pub value: Value,
}

/// One file that could not be used, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LoadError {
    pub file: String,
    pub error: String,
}

/// Read every `*.json` in `dir`, sorted by file name. An absent folder is an
/// empty library (nobody has saved one yet), not an error. Leftover `.part` files
/// from an interrupted write and anything else that is not `*.json` are ignored.
pub fn load_dir(dir: &Path) -> Result<(Vec<LoadedFile>, Vec<LoadError>), ChromaError> {
    let mut entries = Vec::new();
    let mut errors = Vec::new();
    if !dir.is_dir() {
        return Ok((entries, errors));
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
        match read_file(&path, &file) {
            Ok(value) => entries.push(LoadedFile { file, value }),
            Err(error) => errors.push(LoadError { file, error }),
        }
    }
    Ok((entries, errors))
}

fn read_file(path: &Path, file: &str) -> Result<Value, String> {
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

/// Write `value` to `<dir>/<id>.json` atomically, creating `dir`. Returns the
/// path written.
pub fn save_entry(dir: &Path, value: &Value, noun: &str) -> Result<PathBuf, ChromaError> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| ChromaError::Invalid(format!("{noun} has no string \"id\"")))?;
    if !is_entry_id(id) {
        return Err(ChromaError::Invalid(format!(
            "{noun} id \"{id}\" must be lowercase letters, digits and hyphens (at most {MAX_ENTRY_ID_LEN})"
        )));
    }
    std::fs::create_dir_all(dir)
        .map_err(|e| ChromaError::Invalid(format!("create {}: {e}", dir.display())))?;
    let target = dir.join(format!("{id}.json"));
    let part = dir.join(format!("{id}.json.part"));
    let pretty = serde_json::to_string_pretty(value)
        .map_err(|e| ChromaError::Invalid(format!("serialise {id}: {e}")))?;
    write_atomic(&part, &target, pretty.as_bytes())?;
    Ok(target)
}

/// Write `bytes` (plus a trailing newline) to `part`, flush it to disk, then
/// rename it over `target`.
pub fn write_atomic(part: &Path, target: &Path, bytes: &[u8]) -> Result<(), ChromaError> {
    {
        let mut f = std::fs::File::create(part)
            .map_err(|e| ChromaError::Invalid(format!("create {}: {e}", part.display())))?;
        f.write_all(bytes)
            .and_then(|()| f.write_all(b"\n"))
            .and_then(|()| f.sync_all())
            .map_err(|e| ChromaError::Invalid(format!("write {}: {e}", part.display())))?;
    }
    std::fs::rename(part, target)
        .map_err(|e| ChromaError::Invalid(format!("move into {}: {e}", target.display())))
}

/// Remove `<dir>/<id>.json`. `Ok(false)` when there was no such entry.
pub fn delete_entry(dir: &Path, id: &str, noun: &str) -> Result<bool, ChromaError> {
    if !is_entry_id(id) {
        return Err(ChromaError::Invalid(format!("\"{id}\" is not a {noun} id")));
    }
    let target = dir.join(format!("{id}.json"));
    if !target.is_file() {
        return Ok(false);
    }
    std::fs::remove_file(&target)
        .map_err(|e| ChromaError::Invalid(format!("remove {}: {e}", target.display())))?;
    Ok(true)
}
