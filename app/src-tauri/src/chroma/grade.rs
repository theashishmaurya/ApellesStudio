//! grade.rs — the Tauri command bridge for the `grade.json` document
//! (roadmap "Now" item 5, D-025; the model extracted to `apelles-grade-model`
//! in D-143).
//!
//! What it is: the 2 `#[tauri::command]` wrappers for save/load, per the
//!   "commands do not move" rule (D-141) — `#[tauri::command]`'s macro
//!   expansion + `generate_handler!`'s path-matching only work with the
//!   function at its original module path, so the real logic moved to
//!   `apelles-grade-model` but these thin wrappers stay here.
//! What it does: `chroma_save_grade` / `chroma_load_grade` call straight
//!   into `apelles_grade_model::save_grade` / `load_grade` and translate the
//!   crate's plain `Result<_, String>` into the command's own — i.e. no
//!   translation at all, they're already the same shape.
//! What it does NOT do: any grade math, GPU work, store mutation, matte I/O,
//!   or schema migration — all of that is `apelles-grade-model` now. See that
//!   crate's doc comment / README for the full behaviour.
//!
//! Fork hygiene (D-003): all new code. Upstream footprint is `pub mod grade;` in
//! `chroma/mod.rs` + two `generate_handler!` lines in `lib.rs`.

use serde_json::Value;

pub use apelles_grade_model::SaveResult;

/// Write `grade` (the v1 wrapper the frontend assembled, carrying the live
/// `adjustments`) to `path`, externalising every mask matte to a sidecar file.
#[tauri::command]
pub async fn chroma_save_grade(path: String, grade: Value) -> Result<SaveResult, String> {
    apelles_grade_model::save_grade(&path, grade)
}

/// Read + parse `grade.json`, migrate its schema to the current version, inline
/// the `$matte` sidecars back to base64 and resolve `$trackDir` to an absolute
/// path. Returns the grade JSON with a plain `adjustments` object ready to apply.
#[tauri::command]
pub async fn chroma_load_grade(path: String) -> Result<Value, String> {
    apelles_grade_model::load_grade(&path)
}

/// Every grade that exists for `clip_ids`, in ONE round trip (D-334).
///
/// The open path used to call [`chroma_load_grade`] once per clip with the
/// `await` inside the loop — 75 sequential round trips on the owner's real
/// recut, 72 of them for files that do not exist and so came back as thrown
/// errors. Clips with no grade are simply absent from the returned map; a clip
/// whose grade file exists but cannot be read or parsed is present with its
/// error string, so a real failure still surfaces instead of silently reading
/// as "ungraded" (see `apelles_grade_model::load_grades`).
///
/// `spawn_blocking` because this is N file reads plus, for any clip with
/// mattes, N base64 inlines — real blocking I/O that a plain `async` command
/// would run on a runtime worker.
#[tauri::command]
pub async fn chroma_load_grades(
    grade_dir: String,
    clip_ids: Vec<String>,
) -> Result<LoadedGrades, String> {
    let loaded = tokio::task::spawn_blocking(move || {
        apelles_grade_model::load_grades(&grade_dir, &clip_ids)
    })
    .await
    .map_err(|e| e.to_string())?;

    // Split the crate's `Result`-per-id into two flat maps rather than letting
    // serde put `{"Ok": …}`/`{"Err": …}` on the wire: the frontend reads
    // "present in `grades`" and "present in `errors`" directly, and neither
    // side has to know serde's externally-tagged enum shape.
    let mut out = LoadedGrades::default();
    for (id, result) in loaded {
        match result {
            Ok(grade) => {
                out.grades.insert(id, grade);
            }
            Err(e) => {
                out.errors.insert(id, e);
            }
        }
    }
    Ok(out)
}

/// The result of [`chroma_load_grades`]: the grades that loaded, and the ones
/// that exist but could not be read.
///
/// A clip with no grade file at all appears in NEITHER map — that is the
/// ordinary "not graded yet" state, and conflating it with a read failure is
/// exactly what the per-clip `catch` this replaced used to do.
#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedGrades {
    pub grades: std::collections::HashMap<String, Value>,
    pub errors: std::collections::HashMap<String, String>,
}
