//! Project assets addressed by content hash (D-404).
//!
//! **What it is:** how a file (a logo, a screenshot) becomes something a Motion
//! manifest can name. [`import_asset`] hashes the file's bytes with SHA-256 and
//! copies it into the project's asset folder as `<hex>.<ext>`; the manifest then
//! holds `sha256:<hex>.<ext>` — never a path. The same id always means the same
//! bytes on any machine, so a render cannot change because some file elsewhere on
//! disk did (CLAUDE.md's render determinism rule), and importing the same file
//! twice is a no-op that returns the same id.
//!
//! **What it does NOT do:** resolve an id to a URL (the engine does that,
//! `packages/motion-engine/src/lib/assets.tsx`), garbage-collect assets no
//! manifest references any more, or accept anything but the image formats the
//! engine can draw.

use std::io::Read;
use std::path::{Path, PathBuf};

use apelles_types::ChromaError;
use sha2::{Digest, Sha256};

/// The extensions an image asset may have — the engine's `ASSET_IMAGE_EXTENSIONS`.
pub const IMAGE_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "webp", "gif", "svg"];

/// `<project>.chroma/motion/assets`.
pub fn assets_dir(project_dir: &Path) -> PathBuf {
    project_dir.join("motion").join("assets")
}

/// One imported asset.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRecord {
    /// What a manifest writes: `sha256:<hex>.<ext>`.
    pub id: String,
    /// The file inside the asset folder: `<hex>.<ext>`.
    pub file_name: String,
    /// Its absolute path.
    pub path: PathBuf,
    pub bytes: u64,
    /// `false` when the same content was already in the folder.
    pub copied: bool,
    /// Pixel size for a raster image, when it can be read.
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// SHA-256 of a file's bytes, streamed, as lowercase hex.
pub fn sha256_file(path: &Path) -> Result<String, ChromaError> {
    let mut file = std::fs::File::open(path)
        .map_err(|e| ChromaError::NotFound(format!("{}: {e}", path.display())))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| ChromaError::Invalid(format!("read {}: {e}", path.display())))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// The file's extension, lowercased, if it is one the engine can draw.
fn image_extension(path: &Path) -> Result<String, ChromaError> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        Ok(ext)
    } else {
        Err(ChromaError::Unsupported(format!(
            "{}: not an image asset (expected one of {})",
            path.display(),
            IMAGE_EXTENSIONS.join(", ")
        )))
    }
}

/// Hash `source` and copy it into `assets_dir` as `<sha256>.<ext>` (atomically:
/// written to a `.part` sibling, then renamed). Already present ⇒ nothing is
/// written and the same record comes back with `copied: false`.
pub fn import_asset(source: &Path, assets_dir: &Path) -> Result<AssetRecord, ChromaError> {
    if !source.is_file() {
        return Err(ChromaError::NotFound(format!(
            "{}: no such file",
            source.display()
        )));
    }
    let ext = image_extension(source)?;
    let hex = sha256_file(source)?;
    let file_name = format!("{hex}.{ext}");
    let dest = assets_dir.join(&file_name);
    std::fs::create_dir_all(assets_dir)
        .map_err(|e| ChromaError::Invalid(format!("create {}: {e}", assets_dir.display())))?;
    let copied = if dest.is_file() {
        false
    } else {
        let part = assets_dir.join(format!("{file_name}.part"));
        std::fs::copy(source, &part)
            .map_err(|e| ChromaError::Invalid(format!("copy into {}: {e}", part.display())))?;
        std::fs::rename(&part, &dest)
            .map_err(|e| ChromaError::Invalid(format!("move into {}: {e}", dest.display())))?;
        true
    };
    let bytes = std::fs::metadata(&dest)
        .map_err(|e| ChromaError::Invalid(format!("stat {}: {e}", dest.display())))?
        .len();
    let (width, height) = if ext == "svg" {
        (None, None)
    } else {
        match image::image_dimensions(&dest) {
            Ok((w, h)) => (Some(w), Some(h)),
            Err(_) => (None, None),
        }
    };
    Ok(AssetRecord {
        id: format!("sha256:{file_name}"),
        file_name,
        path: dest,
        bytes,
        copied,
        width,
        height,
    })
}

/// SHA-256 of `bytes` as lowercase hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// D-409 — put `bytes` into `assets_dir` as `<sha256>.<ext>` (atomically, a
/// `.part` sibling then a rename) and return the `sha256:<hex>.<ext>` id and
/// whether anything was written. How a certified custom component's compiled
/// module (`js`) and source (`tsx`) reach a project: content-addressed beside
/// its images, so the render serves them from the same `--public-dir` and the
/// preview bundle's cache key (which names that folder's files) changes with
/// them. `ext` is the caller's; only the two component kinds use this.
pub fn store_bytes(
    bytes: &[u8],
    ext: &str,
    assets_dir: &Path,
) -> Result<(String, bool), ChromaError> {
    if ext != "js" && ext != "tsx" {
        return Err(ChromaError::Unsupported(format!(
            "store_bytes is for component modules (js, tsx), not .{ext}"
        )));
    }
    let file_name = format!("{}.{ext}", sha256_hex(bytes));
    let dest = assets_dir.join(&file_name);
    std::fs::create_dir_all(assets_dir)
        .map_err(|e| ChromaError::Invalid(format!("create {}: {e}", assets_dir.display())))?;
    if dest.is_file() {
        return Ok((format!("sha256:{file_name}"), false));
    }
    let part = assets_dir.join(format!("{file_name}.part"));
    std::fs::write(&part, bytes)
        .map_err(|e| ChromaError::Invalid(format!("write {}: {e}", part.display())))?;
    std::fs::rename(&part, &dest)
        .map_err(|e| ChromaError::Invalid(format!("move into {}: {e}", dest.display())))?;
    Ok((format!("sha256:{file_name}"), true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn importing_names_the_file_by_its_content_and_is_idempotent()
    -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let src = dir.path().join("Logo Final.PNG");
        image::RgbaImage::from_pixel(3, 2, image::Rgba([1, 2, 3, 255]))
            .save_with_format(&src, image::ImageFormat::Png)?;
        let assets = dir.path().join("p.chroma/motion/assets");
        let first = import_asset(&src, &assets)?;
        let hex = sha256_file(&src)?;
        assert_eq!(first.id, format!("sha256:{hex}.png"));
        assert_eq!(first.file_name, format!("{hex}.png"));
        assert!(first.copied);
        assert_eq!((first.width, first.height), (Some(3), Some(2)));
        assert_eq!(std::fs::read(&first.path)?, std::fs::read(&src)?);

        let again = import_asset(&src, &assets)?;
        assert_eq!(again.id, first.id, "same bytes, same id");
        assert!(!again.copied, "nothing re-written");
        Ok(())
    }

    #[test]
    fn different_bytes_get_a_different_id() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let a = dir.path().join("a.svg");
        let b = dir.path().join("b.svg");
        std::fs::write(&a, "<svg/>")?;
        std::fs::write(&b, "<svg />")?;
        let assets = dir.path().join("assets");
        assert_ne!(import_asset(&a, &assets)?.id, import_asset(&b, &assets)?.id);
        Ok(())
    }

    #[test]
    fn refuses_non_images_and_missing_files() {
        let dir = std::env::temp_dir();
        assert!(matches!(
            import_asset(Path::new("/no/such/file.png"), &dir),
            Err(ChromaError::NotFound(_))
        ));
        let txt = dir.join(format!("apelles-asset-test-{}.txt", std::process::id()));
        let _ = std::fs::write(&txt, "x");
        assert!(matches!(
            import_asset(&txt, &dir),
            Err(ChromaError::Unsupported(_))
        ));
        let _ = std::fs::remove_file(&txt);
    }

    #[test]
    fn sha256_matches_a_known_vector() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let p = dir.path().join("abc.png");
        std::fs::write(&p, "abc")?;
        assert_eq!(
            sha256_file(&p)?,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        Ok(())
    }
}
