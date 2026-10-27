//! A project's own copy of its active brand kit (D-416).
//!
//! **What it is:** `<project>.chroma/brand/kit.json` plus `brand/assets/`, the
//! snapshot every tab reads when it applies the brand. [`install`] copies a kit
//! document and every asset it names out of the library store into the project
//! (each asset re-hashed first, so a library file edited by hand is refused rather
//! than copied under an id it no longer matches), then writes `kit.json`
//! atomically, last, so a failed copy never leaves a kit naming a missing file.
//! [`read`] and [`clear`] are the other two halves.
//!
//! **Copy semantics, decided (the D-407/D-409 rule).** The project never reads the
//! library: deleting or editing a library kit changes no project until the kit is
//! set again, and a project moved to another machine carries its brand with it.
//! Old asset files are left in `brand/assets/` when a different kit is set (a grade
//! or a theme applied earlier may still name them; they are content-addressed, so
//! keeping them is never wrong).

use std::path::{Path, PathBuf};

use apelles_motion::assets::sha256_file;
use apelles_motion::library::write_atomic;
use apelles_types::ChromaError;
use serde::Serialize;
use serde_json::Value;

use crate::assets::{asset_ids_in, copy_into, file_name_of_id};

/// `<project>.chroma/brand`.
pub fn brand_dir(project_dir: &Path) -> PathBuf {
    project_dir.join("brand")
}

/// `<project>.chroma/brand/kit.json`.
pub fn kit_path(project_dir: &Path) -> PathBuf {
    brand_dir(project_dir).join("kit.json")
}

/// `<project>.chroma/brand/assets`.
pub fn project_assets_dir(project_dir: &Path) -> PathBuf {
    brand_dir(project_dir).join("assets")
}

/// What [`install`] did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    /// The `kit.json` written.
    pub kit_path: PathBuf,
    /// The project's brand asset folder.
    pub assets_dir: PathBuf,
    /// Every asset id the kit names.
    pub assets: Vec<String>,
    /// How many of them were newly copied (the rest were already there).
    pub copied: usize,
}

/// Copy `kit` and its assets from `library_assets` into the project, then write
/// `kit.json`. An asset the project already holds is not copied again (the same
/// id is the same bytes); one that is in neither place is an error naming it.
pub fn install(
    kit: &Value,
    library_assets: &Path,
    project_dir: &Path,
) -> Result<InstallReport, ChromaError> {
    if !kit.get("id").is_some_and(Value::is_string) {
        return Err(ChromaError::Invalid(
            "brand kit has no string \"id\"".into(),
        ));
    }
    let assets_dir = project_assets_dir(project_dir);
    let ids = asset_ids_in(kit);
    let mut copied = 0;
    for id in &ids {
        let file_name = file_name_of_id(id)
            .ok_or_else(|| ChromaError::Invalid(format!("\"{id}\" is not a brand asset id")))?;
        if assets_dir.join(file_name).is_file() {
            continue;
        }
        let source = library_assets.join(file_name);
        if !source.is_file() {
            return Err(ChromaError::NotFound(format!(
                "brand asset {id} is not in the brand library ({}) — import it again",
                library_assets.display()
            )));
        }
        let hex = file_name.split('.').next().unwrap_or_default();
        if sha256_file(&source)? != hex {
            return Err(ChromaError::Invalid(format!(
                "brand asset {} was changed on disk after it was imported; import the file again",
                source.display()
            )));
        }
        if copy_into(&source, &assets_dir, file_name)? {
            copied += 1;
        }
    }
    let target = kit_path(project_dir);
    std::fs::create_dir_all(brand_dir(project_dir)).map_err(|e| {
        ChromaError::Invalid(format!("create {}: {e}", brand_dir(project_dir).display()))
    })?;
    let pretty = serde_json::to_string_pretty(kit)
        .map_err(|e| ChromaError::Invalid(format!("serialise brand kit: {e}")))?;
    write_atomic(
        &brand_dir(project_dir).join("kit.json.part"),
        &target,
        pretty.as_bytes(),
    )?;
    Ok(InstallReport {
        kit_path: target,
        assets_dir,
        assets: ids,
        copied,
    })
}

/// The project's kit, or `None` when it has none. A file that is not JSON is an
/// error naming it (never silently "no kit").
pub fn read(project_dir: &Path) -> Result<Option<Value>, ChromaError> {
    let path = kit_path(project_dir);
    if !path.is_file() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| ChromaError::Invalid(format!("read {}: {e}", path.display())))?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| ChromaError::Invalid(format!("{} is not valid JSON: {e}", path.display())))
}

/// Remove the project's kit (its assets stay, see the module doc). `Ok(false)`
/// when it had none.
pub fn clear(project_dir: &Path) -> Result<bool, ChromaError> {
    let path = kit_path(project_dir);
    if !path.is_file() {
        return Ok(false);
    }
    std::fs::remove_file(&path)
        .map_err(|e| ChromaError::Invalid(format!("remove {}: {e}", path.display())))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::import_asset;
    use serde_json::json;

    struct Fixture {
        _root: tempfile::TempDir,
        library: PathBuf,
        project: PathBuf,
        logo_id: String,
    }

    fn fixture() -> Fixture {
        let root = tempfile::tempdir().expect("tempdir");
        let library = root.path().join("lib-assets");
        let project = root.path().join("p.chroma");
        std::fs::create_dir_all(&project).expect("project");
        let logo = root.path().join("logo.png");
        std::fs::write(&logo, b"not really a png").expect("write");
        let logo_id = import_asset(&logo, &library).expect("import").id;
        Fixture {
            _root: root,
            library,
            project,
            logo_id,
        }
    }

    #[test]
    fn install_copies_the_kit_and_its_assets_and_the_project_keeps_its_copy() {
        let f = fixture();
        let kit = json!({"id": "acme", "version": 3, "logos": {"light": f.logo_id}});
        let report = install(&kit, &f.library, &f.project).expect("install");
        assert_eq!(report.assets, vec![f.logo_id.clone()]);
        assert_eq!(report.copied, 1);
        assert_eq!(read(&f.project).expect("read"), Some(kit.clone()));
        let file = file_name_of_id(&f.logo_id).expect("id");
        assert!(project_assets_dir(&f.project).join(file).is_file());

        // The library changing (or vanishing) does not touch the snapshot.
        std::fs::remove_dir_all(&f.library).expect("drop library");
        assert_eq!(read(&f.project).expect("read"), Some(kit.clone()));

        // Re-installing a kit whose assets the project already holds needs no library.
        let v4 = json!({"id": "acme", "version": 4, "logos": {"light": f.logo_id}});
        assert_eq!(install(&v4, &f.library, &f.project).expect("v4").copied, 0);
        assert_eq!(read(&f.project).expect("read").expect("kit")["version"], 4);
        assert!(!brand_dir(&f.project).join("kit.json.part").exists());
    }

    #[test]
    fn a_missing_or_tampered_asset_refuses_and_writes_no_kit() {
        let f = fixture();
        let missing = format!("sha256:{}.png", "b".repeat(64));
        let err = install(
            &json!({"id": "x", "logos": {"light": missing}}),
            &f.library,
            &f.project,
        )
        .expect_err("missing");
        assert!(err.to_string().contains("import it again"));
        assert_eq!(read(&f.project).expect("read"), None);

        let file = file_name_of_id(&f.logo_id).expect("id");
        std::fs::write(f.library.join(file), b"edited").expect("tamper");
        let err = install(
            &json!({"id": "x", "logo": f.logo_id}),
            &f.library,
            &f.project,
        )
        .expect_err("tampered");
        assert!(err.to_string().contains("changed on disk"));
        assert_eq!(read(&f.project).expect("read"), None);
    }

    #[test]
    fn clear_and_a_bad_file() {
        let f = fixture();
        assert!(!clear(&f.project).expect("nothing"));
        install(&json!({"id": "x"}), &f.library, &f.project).expect("install");
        assert!(clear(&f.project).expect("clear"));
        assert_eq!(read(&f.project).expect("read"), None);
        std::fs::write(kit_path(&f.project), "{").expect("write");
        assert!(read(&f.project).is_err());
        assert!(install(&json!({"name": "no id"}), &f.library, &f.project).is_err());
    }
}
