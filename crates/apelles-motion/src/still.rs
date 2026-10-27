//! Still frames of a manifest — the preview half of the render bridge (D-403).
//!
//! **What it is:** `motion_preview_frame`'s backend. Renders chosen frames of a
//! manifest to PNG through Remotion's own `still` command, and tiles several into
//! one contact sheet so an agent can SEE a motion (start, middle, settle) in one
//! image. [`build_still_command`] sits beside [`crate::build_command`] and has the
//! same shape: the exact argv is a pure function, unit-tested without spawning.
//!
//! **Why a cached bundle.** `remotion still <entry>` re-bundles the engine with
//! webpack on every call (~18 s here); `remotion still <bundle-dir>` reuses a
//! bundle and takes ~1.5 s. So the engine is bundled once into a cache directory
//! keyed by a content fingerprint of the engine's sources ([`engine_fingerprint`]),
//! and every preview reuses it until a source file changes. The fingerprint is a
//! content hash, never a timestamp, so the same sources always find the same
//! bundle.
//!
//! **Determinism.** No wall clock and no randomness anywhere here: output names
//! derive from the caller's label, the cache key from file contents. The same
//! manifest and frame render the same PNG bytes (checked by a real render twice,
//! recorded in D-403).
//!
//! **What it does NOT do:** validate the manifest (the frontend's zod schema
//! does, before calling), know about scenes (the caller passes ABSOLUTE frames,
//! the same "manifest-shape agnostic" rule as [`crate::RenderRequest`]), or run
//! more than it is asked: one bundle at most, one `still` per frame.

use std::path::{Path, PathBuf};
use std::process::Command;

use apelles_types::ChromaError;

/// Gap between contact-sheet tiles, px.
const SHEET_GAP: u32 = 4;
/// Most tiles per contact-sheet row; more frames wrap to further rows.
const SHEET_MAX_COLUMNS: u32 = 4;
/// Contact-sheet background (the gaps), an opaque near-black.
const SHEET_BG: [u8; 4] = [16, 16, 18, 255];
/// Hex characters of the engine fingerprint used in the bundle directory name.
const FINGERPRINT_CHARS: usize = 16;
const BUNDLE_PREFIX: &str = "bundle-";
/// Serialises bundle builds within this process (see [`ensure_bundle`]).
static BUNDLE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// `npx remotion bundle` — produce a reusable bundle of the engine.
pub fn build_bundle_command(
    engine_dir: &Path,
    out_dir: &Path,
    public_dir: Option<&Path>,
) -> Command {
    let mut cmd = Command::new("npx");
    cmd.current_dir(engine_dir);
    cmd.args([
        "remotion",
        "bundle",
        &format!("--out-dir={}", out_dir.display()),
    ]);
    if let Some(public) = public_dir {
        cmd.arg(format!("--public-dir={}", public.display()));
    }
    cmd
}

/// One still: which bundle, which manifest, which frame, where to.
#[derive(Debug, Clone)]
pub struct StillRequest {
    /// `packages/motion-engine` — where `npx` runs.
    pub engine_dir: PathBuf,
    /// A directory produced by [`build_bundle_command`].
    pub bundle_dir: PathBuf,
    /// Absolute path to the manifest JSON (`--props=`).
    pub manifest_path: PathBuf,
    /// The PNG to write.
    pub output_path: PathBuf,
    /// ABSOLUTE composition frame.
    pub frame: u32,
    /// Remotion `--scale` (1 = the manifest's own resolution).
    pub scale: f64,
    /// Always `"Animation"` for a manifest.
    pub composition_id: String,
}

/// The `npx remotion still` invocation for `req` — pure, the twin of
/// [`crate::build_command`].
pub fn build_still_command(req: &StillRequest) -> Command {
    let mut cmd = Command::new("npx");
    cmd.current_dir(&req.engine_dir);
    cmd.args([
        "remotion",
        "still",
        &req.bundle_dir.to_string_lossy(),
        req.composition_id.as_str(),
        &req.output_path.to_string_lossy(),
        &format!("--props={}", req.manifest_path.display()),
        &format!("--frame={}", req.frame),
        &format!("--scale={}", req.scale),
    ]);
    cmd
}

fn run(mut cmd: Command, what: &str) -> Result<(), ChromaError> {
    let output = cmd
        .output()
        .map_err(|e| ChromaError::Invalid(format!("failed to spawn npx for {what}: {e}")))?;
    if output.status.success() {
        return Ok(());
    }
    let code = output
        .status
        .code()
        .map(|c| c.to_string())
        .unwrap_or_else(|| "signal".to_string());
    Err(ChromaError::Invalid(format!(
        "remotion {what} exited {code}: {}",
        crate::tail(&String::from_utf8_lossy(&output.stderr), 40)
    )))
}

/// Every regular file under `dir`, as paths relative to `root`, sorted.
fn files_under(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let kind = entry.file_type()?;
        if kind.is_dir() {
            files_under(root, &path, out)?;
        } else if kind.is_file()
            && let Ok(rel) = path.strip_prefix(root)
        {
            out.push(rel.to_path_buf());
        }
    }
    Ok(())
}

/// A content hash of everything that goes into a bundle: the engine's `src/`
/// tree, its `package.json` and `remotion.config.ts`, and — when one is used —
/// the NAMES of the files in the public directory (its files are
/// expected to be content-addressed, so a name stands for its content). Test files are part of
/// `src/` and are hashed too; a changed test re-bundles, which is harmless.
pub fn engine_fingerprint(
    engine_dir: &Path,
    public_dir: Option<&Path>,
) -> Result<String, ChromaError> {
    let io = |e: std::io::Error| {
        ChromaError::Invalid(format!("fingerprint {}: {e}", engine_dir.display()))
    };
    let mut files = Vec::new();
    files_under(engine_dir, &engine_dir.join("src"), &mut files).map_err(io)?;
    for top in ["package.json", "remotion.config.ts"] {
        if engine_dir.join(top).is_file() {
            files.push(PathBuf::from(top));
        }
    }
    files.sort();
    let mut hasher = blake3::Hasher::new();
    for rel in &files {
        hasher.update(rel.to_string_lossy().as_bytes());
        hasher.update(&[0]);
        hasher.update(&std::fs::read(engine_dir.join(rel)).map_err(io)?);
        hasher.update(&[0]);
    }
    if let Some(public) = public_dir
        && public.is_dir()
    {
        let mut names = Vec::new();
        files_under(public, public, &mut names).map_err(io)?;
        names.sort();
        hasher.update(b"public\0");
        for n in names {
            hasher.update(n.to_string_lossy().as_bytes());
            hasher.update(&[0]);
        }
    }
    Ok(hasher.finalize().to_hex()[..FINGERPRINT_CHARS].to_string())
}

/// The bundle for the engine as it is now, under `cache_root`: reused when one
/// with the current fingerprint exists, otherwise built (into a staging
/// directory, then renamed into place, so a half-written bundle is never
/// reused) and every older `bundle-*` sibling removed.
pub fn ensure_bundle(
    engine_dir: &Path,
    cache_root: &Path,
    public_dir: Option<&Path>,
) -> Result<PathBuf, ChromaError> {
    // Two previews at once (an agent's and the GUI's) must not both build into
    // the same staging directory; the second waits and then reuses the bundle.
    let _guard = BUNDLE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let fp = engine_fingerprint(engine_dir, public_dir)?;
    let dir = cache_root.join(format!("{BUNDLE_PREFIX}{fp}"));
    if dir.join("index.html").is_file() {
        return Ok(dir);
    }
    std::fs::create_dir_all(cache_root)
        .map_err(|e| ChromaError::Invalid(format!("create {}: {e}", cache_root.display())))?;
    let staging = cache_root.join(format!("staging-{fp}"));
    if staging.exists() {
        std::fs::remove_dir_all(&staging)
            .map_err(|e| ChromaError::Invalid(format!("clear {}: {e}", staging.display())))?;
    }
    run(
        build_bundle_command(engine_dir, &staging, public_dir),
        "bundle",
    )?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir)
            .map_err(|e| ChromaError::Invalid(format!("clear {}: {e}", dir.display())))?;
    }
    std::fs::rename(&staging, &dir)
        .map_err(|e| ChromaError::Invalid(format!("move bundle into {}: {e}", dir.display())))?;
    // Older bundles are dead weight (tens of MB each); a failure to delete one
    // costs disk, not correctness, so it is not an error.
    if let Ok(entries) = std::fs::read_dir(cache_root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(BUNDLE_PREFIX) && entry.path() != dir {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(dir)
}

/// Where the tiles go in a contact sheet of `n` frames: `(columns, rows)`.
pub fn sheet_grid(n: u32) -> (u32, u32) {
    let columns = n.clamp(1, SHEET_MAX_COLUMNS);
    (columns, n.div_ceil(columns))
}

/// Tile `tiles` (equal-sized PNGs, in order) left to right, then down, into
/// one PNG at `out`. Returns `(width, height, columns, rows)`.
pub fn contact_sheet(tiles: &[PathBuf], out: &Path) -> Result<(u32, u32, u32, u32), ChromaError> {
    let first = tiles
        .first()
        .ok_or_else(|| ChromaError::Invalid("contact sheet needs at least one frame".into()))?;
    let load = |p: &Path| {
        image::open(p)
            .map(|i| i.to_rgba8())
            .map_err(|e| ChromaError::Invalid(format!("read still {}: {e}", p.display())))
    };
    let first_img = load(first)?;
    let (tw, th) = first_img.dimensions();
    let n =
        u32::try_from(tiles.len()).map_err(|_| ChromaError::Invalid("too many frames".into()))?;
    let (columns, rows) = sheet_grid(n);
    let width = columns * tw + (columns - 1) * SHEET_GAP;
    let height = rows * th + (rows - 1) * SHEET_GAP;
    let mut sheet = image::RgbaImage::from_pixel(width, height, image::Rgba(SHEET_BG));
    for (i, path) in tiles.iter().enumerate() {
        let img = if i == 0 {
            first_img.clone()
        } else {
            load(path)?
        };
        let i = u32::try_from(i).map_err(|_| ChromaError::Invalid("too many frames".into()))?;
        let x = (i % columns) * (tw + SHEET_GAP);
        let y = (i / columns) * (th + SHEET_GAP);
        image::imageops::overlay(&mut sheet, &img, i64::from(x), i64::from(y));
    }
    sheet
        .save(out)
        .map_err(|e| ChromaError::Invalid(format!("write {}: {e}", out.display())))?;
    Ok((width, height, columns, rows))
}

/// A filename-safe form of a caller's label (a scene id).
fn safe_label(label: &str) -> String {
    let s: String = label
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if s.is_empty() {
        "preview".to_string()
    } else {
        s
    }
}

/// A whole preview: which manifest, which absolute frames, at what scale.
#[derive(Debug, Clone)]
pub struct PreviewRequest {
    pub engine_dir: PathBuf,
    /// Where the cached bundle lives (one `bundle-<fingerprint>` inside).
    pub cache_dir: PathBuf,
    /// Where the PNG (and its transient tiles) are written.
    pub out_dir: PathBuf,
    pub manifest_path: PathBuf,
    pub frames: Vec<u32>,
    pub scale: f64,
    /// Names the output file (`<label>.png`).
    pub label: String,
    /// An optional directory served to the engine as `public/` (`--public-dir`).
    pub public_dir: Option<PathBuf>,
}

/// The finished preview.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PreviewOutcome {
    pub path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub columns: u32,
    pub rows: u32,
}

/// Bundle (or reuse the bundle), render each frame, and tile them. Blocking;
/// the Tauri command runs it on a blocking thread.
pub fn render_preview(req: &PreviewRequest) -> Result<PreviewOutcome, ChromaError> {
    if req.frames.is_empty() {
        return Err(ChromaError::Invalid("no frames to preview".into()));
    }
    if !(req.scale > 0.0 && req.scale <= 1.0) {
        return Err(ChromaError::Invalid(format!(
            "scale must be in (0, 1], got {}",
            req.scale
        )));
    }
    if !req.engine_dir.is_dir() {
        return Err(ChromaError::NotFound(format!(
            "motion engine dir: {}",
            req.engine_dir.display()
        )));
    }
    let bundle_dir = ensure_bundle(&req.engine_dir, &req.cache_dir, req.public_dir.as_deref())?;
    std::fs::create_dir_all(&req.out_dir)
        .map_err(|e| ChromaError::Invalid(format!("create {}: {e}", req.out_dir.display())))?;
    let label = safe_label(&req.label);
    let out = req.out_dir.join(format!("{label}.png"));

    let mut tiles = Vec::with_capacity(req.frames.len());
    for (i, frame) in req.frames.iter().enumerate() {
        let tile = if req.frames.len() == 1 {
            out.clone()
        } else {
            req.out_dir.join(format!("{label}.tile-{i}.png"))
        };
        let still = StillRequest {
            engine_dir: req.engine_dir.clone(),
            bundle_dir: bundle_dir.clone(),
            manifest_path: req.manifest_path.clone(),
            output_path: tile.clone(),
            frame: *frame,
            scale: req.scale,
            composition_id: "Animation".to_string(),
        };
        run(build_still_command(&still), "still")?;
        tiles.push(tile);
    }

    if tiles.len() == 1 {
        let (width, height) = image::image_dimensions(&out)
            .map_err(|e| ChromaError::Invalid(format!("read {}: {e}", out.display())))?;
        return Ok(PreviewOutcome {
            path: out,
            width,
            height,
            columns: 1,
            rows: 1,
        });
    }
    let (width, height, columns, rows) = contact_sheet(&tiles, &out)?;
    for t in &tiles {
        // Transient; a leftover tile is legible and overwritten next time.
        let _ = std::fs::remove_file(t);
    }
    Ok(PreviewOutcome {
        path: out,
        width,
        height,
        columns,
        rows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(cmd: &Command) -> Vec<String> {
        cmd.get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect()
    }

    #[test]
    fn build_still_command_sets_cwd_and_argv() {
        let req = StillRequest {
            engine_dir: "/engine".into(),
            bundle_dir: "/cache/bundle-ab".into(),
            manifest_path: "/tmp/m.json".into(),
            output_path: "/tmp/out.png".into(),
            frame: 42,
            scale: 0.5,
            composition_id: "Animation".into(),
        };
        let cmd = build_still_command(&req);
        assert_eq!(cmd.get_program(), "npx");
        assert_eq!(cmd.get_current_dir(), Some(Path::new("/engine")));
        assert_eq!(
            args(&cmd),
            vec![
                "remotion",
                "still",
                "/cache/bundle-ab",
                "Animation",
                "/tmp/out.png",
                "--props=/tmp/m.json",
                "--frame=42",
                "--scale=0.5",
            ]
        );
    }

    #[test]
    fn build_bundle_command_passes_public_dir_only_when_given() {
        let plain = build_bundle_command(Path::new("/engine"), Path::new("/c/b"), None);
        assert_eq!(args(&plain), vec!["remotion", "bundle", "--out-dir=/c/b"]);
        let with = build_bundle_command(
            Path::new("/engine"),
            Path::new("/c/b"),
            Some(Path::new("/p/assets")),
        );
        assert_eq!(
            args(&with),
            vec![
                "remotion",
                "bundle",
                "--out-dir=/c/b",
                "--public-dir=/p/assets"
            ]
        );
    }

    #[test]
    fn sheet_grid_wraps_at_four_columns() {
        assert_eq!(sheet_grid(1), (1, 1));
        assert_eq!(sheet_grid(3), (3, 1));
        assert_eq!(sheet_grid(4), (4, 1));
        assert_eq!(sheet_grid(5), (4, 2));
        assert_eq!(sheet_grid(12), (4, 3));
    }

    #[test]
    fn contact_sheet_tiles_in_order_with_gaps() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let colours = [
            [255, 0, 0, 255],
            [0, 255, 0, 255],
            [0, 0, 255, 255],
            [255, 255, 0, 255],
            [0, 255, 255, 255],
        ];
        let mut tiles = Vec::new();
        for (i, c) in colours.iter().enumerate() {
            let p = dir.path().join(format!("t{i}.png"));
            image::RgbaImage::from_pixel(10, 6, image::Rgba(*c)).save(&p)?;
            tiles.push(p);
        }
        let out = dir.path().join("sheet.png");
        let (w, h, cols, rows) = contact_sheet(&tiles, &out)?;
        assert_eq!((cols, rows), (4, 2));
        assert_eq!((w, h), (4 * 10 + 3 * SHEET_GAP, 2 * 6 + SHEET_GAP));
        let img = image::open(&out)?.to_rgba8();
        assert_eq!(img.get_pixel(0, 0).0, colours[0]);
        assert_eq!(img.get_pixel(10 + SHEET_GAP, 0).0, colours[1]);
        assert_eq!(img.get_pixel(0, 6 + SHEET_GAP).0, colours[4]);
        assert_eq!(img.get_pixel(10, 0).0, SHEET_BG, "the gap is background");
        Ok(())
    }

    #[test]
    fn fingerprint_is_content_addressed() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        std::fs::create_dir_all(dir.path().join("src/a"))?;
        std::fs::write(dir.path().join("src/a/x.ts"), "one")?;
        std::fs::write(dir.path().join("package.json"), "{}")?;
        let a = engine_fingerprint(dir.path(), None)?;
        assert_eq!(
            a,
            engine_fingerprint(dir.path(), None)?,
            "same content, same key"
        );
        std::fs::write(dir.path().join("src/a/x.ts"), "two")?;
        let b = engine_fingerprint(dir.path(), None)?;
        assert_ne!(a, b, "changed content, new key");
        let public = dir.path().join("public");
        std::fs::create_dir_all(&public)?;
        std::fs::write(public.join("abc.png"), "x")?;
        assert_ne!(
            b,
            engine_fingerprint(dir.path(), Some(&public))?,
            "a new asset re-bundles"
        );
        Ok(())
    }

    #[test]
    fn safe_label_keeps_ids_and_replaces_the_rest() {
        assert_eq!(safe_label("hook-1_a"), "hook-1_a");
        assert_eq!(safe_label("../x y"), "___x_y");
        assert_eq!(safe_label(""), "preview");
    }
}
