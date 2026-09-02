//! grade.rs — the `grade.json` document: save, load, versioned schema
//! (roadmap "Now" item 5, D-025).
//!
//! What it is: read/write for Chroma's one git-committable grade document. v1 is
//!   a **versioned, documented wrapper** around RapidRAW's live `adjustments`
//!   blob plus shot context, with every mask matte externalised to a sidecar
//!   file so the JSON stays diff-able. It is deliberately NOT doc 06's
//!   aspirational ordered `stack` — that re-model pairs with the v2 node graph
//!   (D-005). See D-025.
//! What it does: `chroma_save_grade` takes the assembled grade from the frontend
//!   (which holds the live `adjustments` — D-020), writes the `<name>.mattes/`
//!   PNGs, rewrites each mask param to a `{"$matte": …}` / `{"$trackDir": …}`
//!   reference, and pretty-prints `grade.json`. `chroma_load_grade` reverses it
//!   and runs a schema migration (stub past v1; rejects a newer major).
//! What it does NOT do: any grade math, GPU work, or store mutation. The
//!   frontend applies the returned `adjustments` through the same
//!   `setAdjustments` a slider drag uses. No `stack` re-model (that's v2). It
//!   does not copy a tracked-matte folder — only references it (D-019).
//!
//! Fork hygiene (D-003): all new code; upstream footprint is `pub mod grade;` in
//! `chroma/mod.rs` + two `generate_handler!` lines in `lib.rs`.

use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::Value;

/// Current schema tag. `chroma.grade/<major>` — bump the major only on a
/// breaking change; `chroma_load_grade` rejects a file with a newer major.
pub const SCHEMA: &str = "chroma.grade/1";
const CURRENT_MAJOR: u64 = 1;

/// keys a static matte can live under — the frontend params carry camelCase
/// (`maskDataBase64`, from the serde `rename_all` on `AiSubjectMaskParameters`)
/// but some engine paths read the snake_case form, so handle both.
const MATTE_KEYS: [&str; 2] = ["maskDataBase64", "mask_data_base64"];

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub path: String,
    /// sidecar PNGs written, relative to the grade.json's directory
    pub matte_files: Vec<String>,
    /// tracked-matte folders the doc now references (NOT copied — moving the
    /// project needs these `.chroma/mattes/` dirs too)
    pub track_dirs: Vec<String>,
}

// --------------------------------------------------------------------------- //
// save
// --------------------------------------------------------------------------- //

/// Write `grade` (the v1 wrapper the frontend assembled, carrying the live
/// `adjustments`) to `path`, externalising every mask matte to a sidecar file.
#[tauri::command]
pub async fn chroma_save_grade(path: String, grade: Value) -> Result<SaveResult, String> {
    save_grade(&path, grade)
}

fn save_grade(path: &str, grade: Value) -> Result<SaveResult, String> {
    let out_path = PathBuf::from(path);
    let grade_dir = out_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let name = grade_name(&out_path);
    let mattes_rel = format!("{name}.mattes");
    let mattes_dir = grade_dir.join(&mattes_rel);

    let mut grade = grade;
    if !grade.get("schema").map(Value::is_string).unwrap_or(false) {
        grade["schema"] = Value::String(SCHEMA.to_string());
    }

    let mut matte_files = Vec::new();
    let mut track_dirs = Vec::new();

    if let Some(masks) = grade
        .get_mut("adjustments")
        .and_then(|a| a.get_mut("masks"))
        .and_then(|m| m.as_array_mut())
    {
        for mask in masks.iter_mut() {
            let Some(subs) = mask.get_mut("subMasks").and_then(|s| s.as_array_mut()) else {
                continue;
            };
            for (i, sub) in subs.iter_mut().enumerate() {
                let sub_id = sub
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("submask-{i}"));
                let Some(params) = sub.get_mut("parameters").and_then(|p| p.as_object_mut()) else {
                    continue;
                };

                // static matte (can be MB of base64) -> <name>.mattes/<subId>.png
                for key in MATTE_KEYS {
                    let raw = match params.get(key) {
                        Some(Value::String(s)) if !s.is_empty() => s.clone(),
                        _ => continue,
                    };
                    let b64 = raw.rsplit_once(',').map(|(_, b)| b).unwrap_or(&raw);
                    let bytes = STANDARD
                        .decode(b64.trim())
                        .map_err(|e| format!("mask {sub_id}: decode {key}: {e}"))?;
                    std::fs::create_dir_all(&mattes_dir)
                        .map_err(|e| format!("create {}: {e}", mattes_dir.display()))?;
                    let rel = format!("{mattes_rel}/{sub_id}.png");
                    std::fs::write(grade_dir.join(&rel), &bytes)
                        .map_err(|e| format!("write {rel}: {e}"))?;
                    params.insert(key.to_string(), serde_json::json!({ "$matte": rel }));
                    matte_files.push(rel);
                }

                // tracked-matte folder (D-019): reference only, never copy.
                // Relative to the grade dir when possible, else absolute.
                if let Some(Value::String(dir)) = params.get("chromaTrackDir").cloned() {
                    let stored = relativize(Path::new(&dir), &grade_dir);
                    params.insert(
                        "chromaTrackDir".into(),
                        serde_json::json!({ "$trackDir": stored }),
                    );
                    track_dirs.push(stored);
                }

                // depth-track folder (D-036): same rule — reference, never copy.
                if let Some(Value::String(dir)) = params.get("chromaDepthDir").cloned() {
                    let stored = relativize(Path::new(&dir), &grade_dir);
                    params.insert(
                        "chromaDepthDir".into(),
                        serde_json::json!({ "$depthDir": stored }),
                    );
                    track_dirs.push(stored);
                }
            }
        }
    }

    let pretty = serde_json::to_string_pretty(&grade).map_err(|e| e.to_string())?;
    std::fs::write(&out_path, format!("{pretty}\n"))
        .map_err(|e| format!("write {}: {e}", out_path.display()))?;

    Ok(SaveResult {
        path: out_path.to_string_lossy().to_string(),
        matte_files,
        track_dirs,
    })
}

// --------------------------------------------------------------------------- //
// load
// --------------------------------------------------------------------------- //

/// Read + parse `grade.json`, migrate its schema to the current version, inline
/// the `$matte` sidecars back to base64 and resolve `$trackDir` to an absolute
/// path. Returns the grade JSON with a plain `adjustments` object ready to apply.
#[tauri::command]
pub async fn chroma_load_grade(path: String) -> Result<Value, String> {
    load_grade(&path)
}

fn load_grade(path: &str) -> Result<Value, String> {
    let in_path = PathBuf::from(path);
    let grade_dir = in_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let text = std::fs::read_to_string(&in_path)
        .map_err(|e| format!("read {}: {e}", in_path.display()))?;
    let mut grade: Value =
        serde_json::from_str(&text).map_err(|e| format!("parse {}: {e}", in_path.display()))?;

    // ---- schema gate + migration ---------------------------------------- //
    let schema = grade.get("schema").and_then(|s| s.as_str()).unwrap_or("");
    let major = schema
        .strip_prefix("chroma.grade/")
        .and_then(|m| m.split('.').next())
        .and_then(|m| m.parse::<u64>().ok());
    match major {
        // None = an untagged file; treat as v1.
        None | Some(1) => migrate_v1(&mut grade),
        Some(m) if m > CURRENT_MAJOR => {
            return Err(format!(
                "grade.json is schema '{schema}' — newer than this build supports \
                 (chroma.grade/{CURRENT_MAJOR}). Upgrade Chroma."
            ));
        }
        Some(m) => return Err(format!("unknown grade.json schema major: {m}")),
    }

    // ---- inline the externalised mattes -------------------------------- //
    if let Some(masks) = grade
        .get_mut("adjustments")
        .and_then(|a| a.get_mut("masks"))
        .and_then(|m| m.as_array_mut())
    {
        for mask in masks.iter_mut() {
            let Some(subs) = mask.get_mut("subMasks").and_then(|s| s.as_array_mut()) else {
                continue;
            };
            for sub in subs.iter_mut() {
                let Some(params) = sub.get_mut("parameters").and_then(|p| p.as_object_mut()) else {
                    continue;
                };

                for key in MATTE_KEYS {
                    let rel = params
                        .get(key)
                        .and_then(|v| v.get("$matte"))
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                    if let Some(rel) = rel {
                        let file = grade_dir.join(&rel);
                        let bytes = std::fs::read(&file)
                            .map_err(|e| format!("read matte {}: {e}", file.display()))?;
                        params.insert(
                            key.to_string(),
                            Value::String(format!(
                                "data:image/png;base64,{}",
                                STANDARD.encode(bytes)
                            )),
                        );
                    }
                }

                let td = params
                    .get("chromaTrackDir")
                    .and_then(|v| v.get("$trackDir"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                if let Some(td) = td {
                    params.insert(
                        "chromaTrackDir".into(),
                        Value::String(resolve(&td, &grade_dir)),
                    );
                }

                let dd = params
                    .get("chromaDepthDir")
                    .and_then(|v| v.get("$depthDir"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                if let Some(dd) = dd {
                    params.insert(
                        "chromaDepthDir".into(),
                        Value::String(resolve(&dd, &grade_dir)),
                    );
                }
            }
        }
    }

    Ok(grade)
}

// --------------------------------------------------------------------------- //
// helpers
// --------------------------------------------------------------------------- //

/// `<dir>/clip.grade.json` -> `clip`; `<dir>/look.json` -> `look`.
fn grade_name(path: &Path) -> String {
    let file = path.file_name().and_then(|s| s.to_str()).unwrap_or("grade");
    let stem = file.strip_suffix(".json").unwrap_or(file);
    stem.strip_suffix(".grade").unwrap_or(stem).to_string()
}

/// v1 is the current schema — identity, minus stamping the tag on an untagged
/// file. A future `chroma.grade/2` migration lands here, transforming the doc up
/// one major so the rest of `load` stays version-blind.
fn migrate_v1(grade: &mut Value) {
    if grade.get("schema").and_then(|s| s.as_str()) != Some(SCHEMA) {
        grade["schema"] = Value::String(SCHEMA.to_string());
    }
}

fn relativize(p: &Path, base: &Path) -> String {
    p.strip_prefix(base)
        .map(|r| r.to_string_lossy().to_string())
        .unwrap_or_else(|_| p.to_string_lossy().to_string())
}

fn resolve(s: &str, base: &Path) -> String {
    let p = Path::new(s);
    if p.is_absolute() {
        s.to_string()
    } else {
        base.join(p).to_string_lossy().to_string()
    }
}

// --------------------------------------------------------------------------- //
// tests
// --------------------------------------------------------------------------- //

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // a 1x1 transparent PNG
    const PNG_1PX: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    fn sample_grade() -> Value {
        json!({
            "schema": "chroma.grade/1",
            "shot": { "source": "clip.mov", "width": 1080, "height": 1920, "fps": 30.0, "frameCount": 100 },
            "adjustments": {
                "exposure": 0.25,
                "masks": [{
                    "id": "m1", "name": "Subject", "visible": true, "invert": false, "opacity": 100,
                    "adjustments": { "exposure": 0.4 },
                    "subMasks": [{
                        "id": "s1", "type": "ai-subject", "mode": "additive",
                        "parameters": {
                            "maskDataBase64": format!("data:image/png;base64,{PNG_1PX}"),
                            "chromaTrackDir": "/abs/project/.chroma/mattes/key"
                        }
                    }]
                }]
            },
            "notes": ""
        })
    }

    #[test]
    fn round_trip_externalises_and_inlines_matte() {
        let dir = std::env::temp_dir().join(format!("chroma_grade_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let gp = dir.join("clip.grade.json");

        let saved = save_grade(&gp.to_string_lossy(), sample_grade()).expect("save");
        assert_eq!(saved.matte_files, vec!["clip.mattes/s1.png".to_string()]);
        assert!(dir.join("clip.mattes/s1.png").exists());

        // on disk: the base64 is gone, replaced by a $matte ref
        let on_disk = std::fs::read_to_string(&gp).unwrap();
        assert!(on_disk.contains("\"$matte\": \"clip.mattes/s1.png\""));
        assert!(on_disk.contains("\"$trackDir\""));
        assert!(!on_disk.contains(PNG_1PX));

        // load: the matte comes back inline, the track dir resolves absolute
        let loaded = load_grade(&gp.to_string_lossy()).expect("load");
        let sub = &loaded["adjustments"]["masks"][0]["subMasks"][0]["parameters"];
        assert_eq!(
            sub["maskDataBase64"].as_str().unwrap(),
            format!("data:image/png;base64,{PNG_1PX}")
        );
        assert_eq!(
            sub["chromaTrackDir"].as_str().unwrap(),
            "/abs/project/.chroma/mattes/key"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_newer_major() {
        let dir = std::env::temp_dir().join(format!("chroma_grade_ver_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let gp = dir.join("x.grade.json");
        std::fs::write(&gp, r#"{"schema":"chroma.grade/2","adjustments":{}}"#).unwrap();

        let err = load_grade(&gp.to_string_lossy()).unwrap_err();
        assert!(err.contains("newer than this build"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn grade_name_strips_both_suffixes() {
        assert_eq!(grade_name(Path::new("/a/clip.grade.json")), "clip");
        assert_eq!(grade_name(Path::new("/a/series-look.json")), "series-look");
    }
}
