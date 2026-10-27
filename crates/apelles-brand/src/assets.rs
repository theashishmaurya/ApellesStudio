//! The brand asset store: files a kit names, addressed by content hash (D-416).
//!
//! **What it is:** how a logo, a font file, a LUT, a reference image or video, or a
//! sonic logo becomes something a kit can hold. [`import_asset`] hashes the file
//! (SHA-256, streamed, [`apelles_motion::assets::sha256_file`]) and copies it into
//! an asset folder as `<hex>.<ext>`; the kit then holds `sha256:<hex>.<ext>`. It is
//! the D-404 rule with a wider set of kinds, and deliberately the SAME id shape:
//! when a kit is applied to Motion, its font and logo files are imported into the
//! project's Motion asset folder and keep their ids.
//!
//! **What it does NOT do:** decide what a file is used for (the kit's fields do),
//! read image sizes, or garbage-collect files no kit names any more.

use std::path::{Path, PathBuf};

use apelles_motion::assets::{AUDIO_EXTENSIONS, FONT_EXTENSIONS, IMAGE_EXTENSIONS, sha256_file};
use apelles_types::ChromaError;
use serde::Serialize;
use serde_json::Value;

/// Video references (a person's own reel, a reference spot).
pub const VIDEO_EXTENSIONS: [&str; 4] = ["mp4", "mov", "m4v", "webm"];
/// A Colorist look: a 3D LUT file.
pub const LUT_EXTENSIONS: [&str; 1] = ["cube"];

/// `<app data>/brand/assets`.
pub fn library_assets_dir(app_data_dir: &Path) -> PathBuf {
    crate::brand_root(app_data_dir).join("assets")
}

/// What a brand asset is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BrandAssetKind {
    Image,
    Video,
    Font,
    Lut,
    Audio,
}

/// One imported asset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandAsset {
    /// What a kit writes: `sha256:<hex>.<ext>`.
    pub id: String,
    /// The file inside the asset folder: `<hex>.<ext>`.
    pub file_name: String,
    /// Its absolute path.
    pub path: PathBuf,
    pub bytes: u64,
    pub kind: BrandAssetKind,
    /// `false` when the same content was already in the folder.
    pub copied: bool,
    /// The file name it was imported from, for display (`logo-dark.svg`).
    pub source_name: String,
}

/// The kind an extension (lowercase, no dot) names, if it is one a kit can hold.
pub fn kind_of_extension(ext: &str) -> Option<BrandAssetKind> {
    if IMAGE_EXTENSIONS.contains(&ext) {
        Some(BrandAssetKind::Image)
    } else if VIDEO_EXTENSIONS.contains(&ext) {
        Some(BrandAssetKind::Video)
    } else if FONT_EXTENSIONS.contains(&ext) {
        Some(BrandAssetKind::Font)
    } else if LUT_EXTENSIONS.contains(&ext) {
        Some(BrandAssetKind::Lut)
    } else if AUDIO_EXTENSIONS.contains(&ext) {
        Some(BrandAssetKind::Audio)
    } else {
        None
    }
}

/// `sha256:<64 lowercase hex>.<ext>` with an extension a kit can hold → the file
/// name inside an asset folder. `None` for anything else, including a path.
pub fn file_name_of_id(id: &str) -> Option<&str> {
    let rest = id.strip_prefix("sha256:")?;
    let (hex, ext) = rest.split_once('.')?;
    let ok = hex.len() == 64
        && hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && kind_of_extension(ext).is_some();
    ok.then_some(rest)
}

/// Every asset id a kit document names, anywhere in it, sorted and de-duplicated.
/// Schema-agnostic on purpose: a field added to the kit later is covered without
/// touching this crate.
pub fn asset_ids_in(kit: &Value) -> Vec<String> {
    fn walk(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::String(s) if file_name_of_id(s).is_some() => out.push(s.clone()),
            Value::Array(items) => items.iter().for_each(|i| walk(i, out)),
            Value::Object(map) => map.values().for_each(|i| walk(i, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(kit, &mut out);
    out.sort();
    out.dedup();
    out
}

/// Hash `source` and copy it into `dir` as `<sha256>.<ext>` (atomically, a `.part`
/// sibling then a rename). Already present ⇒ nothing is written, `copied: false`.
pub fn import_asset(source: &Path, dir: &Path) -> Result<BrandAsset, ChromaError> {
    if !source.is_file() {
        return Err(ChromaError::NotFound(format!(
            "{}: no such file",
            source.display()
        )));
    }
    let ext = source
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let kind = kind_of_extension(&ext).ok_or_else(|| {
        ChromaError::Unsupported(format!(
            "{}: a brand kit holds images ({}), videos ({}), fonts ({}), LUTs ({}) and audio ({})",
            source.display(),
            IMAGE_EXTENSIONS.join(", "),
            VIDEO_EXTENSIONS.join(", "),
            FONT_EXTENSIONS.join(", "),
            LUT_EXTENSIONS.join(", "),
            AUDIO_EXTENSIONS.join(", ")
        ))
    })?;
    let hex = sha256_file(source)?;
    let file_name = format!("{hex}.{ext}");
    let copied = copy_into(source, dir, &file_name)?;
    let path = dir.join(&file_name);
    let bytes = std::fs::metadata(&path)
        .map_err(|e| ChromaError::Invalid(format!("stat {}: {e}", path.display())))?
        .len();
    Ok(BrandAsset {
        id: format!("sha256:{file_name}"),
        file_name,
        path,
        bytes,
        kind,
        copied,
        source_name: source
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
    })
}

/// Copy `source` to `<dir>/<file_name>` unless it is already there; `true` when
/// something was written.
pub(crate) fn copy_into(source: &Path, dir: &Path, file_name: &str) -> Result<bool, ChromaError> {
    let dest = dir.join(file_name);
    if dest.is_file() {
        return Ok(false);
    }
    std::fs::create_dir_all(dir)
        .map_err(|e| ChromaError::Invalid(format!("create {}: {e}", dir.display())))?;
    let part = dir.join(format!("{file_name}.part"));
    std::fs::copy(source, &part)
        .map_err(|e| ChromaError::Invalid(format!("copy into {}: {e}", part.display())))?;
    std::fs::rename(&part, &dest)
        .map_err(|e| ChromaError::Invalid(format!("move into {}: {e}", dest.display())))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn importing_names_the_file_by_its_content_and_is_idempotent() {
        let src = tempfile::tempdir().expect("tempdir");
        let store = tempfile::tempdir().expect("tempdir");
        let logo = src.path().join("Logo.SVG");
        std::fs::write(&logo, b"<svg/>").expect("write");
        let a = import_asset(&logo, store.path()).expect("import");
        assert!(a.copied);
        assert_eq!(a.kind, BrandAssetKind::Image);
        assert!(a.id.starts_with("sha256:") && a.id.ends_with(".svg"));
        assert_eq!(a.source_name, "Logo.SVG");
        let b = import_asset(&logo, store.path()).expect("again");
        assert!(!b.copied);
        assert_eq!(a.id, b.id);
        assert!(!store.path().join(format!("{}.part", a.file_name)).exists());
    }

    #[test]
    fn every_kind_and_a_refusal() {
        for (ext, kind) in [
            ("otf", BrandAssetKind::Font),
            ("cube", BrandAssetKind::Lut),
            ("mov", BrandAssetKind::Video),
            ("wav", BrandAssetKind::Audio),
        ] {
            assert_eq!(kind_of_extension(ext), Some(kind));
        }
        let src = tempfile::tempdir().expect("tempdir");
        let doc = src.path().join("brief.docx");
        std::fs::write(&doc, b"x").expect("write");
        assert!(import_asset(&doc, src.path()).is_err());
        assert!(import_asset(&src.path().join("missing.png"), src.path()).is_err());
    }

    #[test]
    fn ids_are_found_anywhere_and_paths_are_not_ids() {
        let hex = "a".repeat(64);
        let kit = json!({
            "logos": {"light": format!("sha256:{hex}.png"), "dark": format!("sha256:{hex}.png")},
            "typography": {"display": {"file": format!("sha256:{hex}.ttf")}},
            "references": [{"asset": format!("sha256:{hex}.mp4"), "note": "sha256:not-an-id"}],
            "look": {"lut": "/Users/me/look.cube"},
        });
        assert_eq!(
            asset_ids_in(&kit),
            vec![
                format!("sha256:{hex}.mp4"),
                format!("sha256:{hex}.png"),
                format!("sha256:{hex}.ttf"),
            ]
        );
        assert_eq!(file_name_of_id(&format!("sha256:{hex}.exe")), None);
        assert_eq!(
            file_name_of_id(&format!("sha256:{}.png", "A".repeat(64))),
            None
        );
    }
}
