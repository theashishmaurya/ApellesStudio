//! Still frames of a manifest — the preview half of the render bridge (D-403) —
//! and the engine bundle every render path renders from.
//!
//! **What it is:** `motion_preview_frame`'s backend. Renders chosen frames of a
//! manifest to PNG through the engine's renderer (`scripts/render.mts still`,
//! D-417), and tiles several into one contact sheet so an agent can SEE a
//! motion (start, middle, settle) in one image. [`build_still_command`] sits
//! beside [`crate::build_command`] and has the same shape: the exact argv is a
//! pure function, unit-tested without spawning.
//!
//! **The bundle ([`ensure_bundle`]).** Remotion renders a BUNDLE (the engine
//! compiled to a static site). A release app ships one, prebuilt, in its engine
//! pack (D-417); a developer checkout builds one from its sources with
//! `remotion bundle` (~18 s), cached under a content fingerprint of the sources
//! ([`engine_fingerprint`]) so it is built once per source change. A project's
//! assets (images, custom-component modules, D-404/D-409) are layered on top as
//! a DERIVED bundle: a copy of the base (APFS clones it, so it costs no space)
//! with the asset folder copied into its `public/`, keyed by the base and the
//! asset names. Keys are content hashes, never timestamps, so the same sources
//! and assets always find the same bundle.
//!
//! **Determinism.** No wall clock and no randomness in any output: output names
//! derive from the caller's label, cache keys from file contents. The same
//! manifest and frame render the same PNG bytes (checked by a real render twice,
//! recorded in D-403 and re-checked through the D-417 renderer).
//!
//! **What it does NOT do:** validate the manifest (the frontend's zod schema
//! does, before calling), know about scenes (the caller passes ABSOLUTE frames,
//! the same "manifest-shape agnostic" rule as [`crate::RenderRequest`]), or run
//! more than it is asked: one bundle at most, one still per frame.

use std::path::{Path, PathBuf};
use std::process::Command;

use apelles_types::ChromaError;

use crate::{MotionRuntime, runner_command};

/// Gap between contact-sheet tiles, px.
const SHEET_GAP: u32 = 4;
/// Most tiles per contact-sheet row; more frames wrap to further rows.
const SHEET_MAX_COLUMNS: u32 = 4;
/// Contact-sheet background (the gaps), an opaque near-black.
const SHEET_BG: [u8; 4] = [16, 16, 18, 255];
/// Hex characters of the engine fingerprint used in the bundle directory name.
const FINGERPRINT_CHARS: usize = 16;
const BUNDLE_PREFIX: &str = "bundle-";
/// Another bundle is deleted only once nothing has used it for this long. A
/// preview reads its bundle for seconds (at most 12 stills of ~1.5 s), and a
/// concurrent preview can carry a different fingerprint (a different asset
/// folder, or engine code changed in between); deleting every other bundle at
/// once removed one still in use (a 404 / EISDIR mid-preview, found 2026-10-27).
const BUNDLE_STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(10 * 60);
/// Serialises bundle builds within this process (see [`ensure_bundle`]).
static BUNDLE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The release engine pack's manifest (`scripts/build-pack.mts` writes it);
/// its `bundleKey` names the prebuilt bundle's content.
pub const PACK_MANIFEST: &str = "pack.json";
/// The Remotion CLI, relative to a `node_modules` folder (development only:
/// the release pack has no bundler).
const REMOTION_CLI: &str = "@remotion/cli/remotion-cli.js";

/// The Remotion CLI the engine at `engine_dir` would `require` — the first
/// `node_modules/@remotion/cli` up the folder tree (Node's own lookup).
pub fn remotion_cli(engine_dir: &Path) -> Option<PathBuf> {
    engine_dir
        .ancestors()
        .map(|d| d.join("node_modules").join(REMOTION_CLI))
        .find(|p| p.is_file())
}

/// `node <remotion-cli> bundle --out-dir=<out_dir>` in the engine folder —
/// building a bundle from the engine's sources (development builds; a release
/// ships its bundle prebuilt). `remotion.config.ts` is read from the engine
/// folder, so the bundler settings (Rspack) are the CLI's.
pub fn build_bundle_command(rt: &MotionRuntime, out_dir: &Path) -> Result<Command, ChromaError> {
    let cli = remotion_cli(&rt.engine_dir).ok_or_else(|| {
        ChromaError::NotFound(format!(
            "no {REMOTION_CLI} above {} to bundle the engine with (run npm ci)",
            rt.engine_dir.display()
        ))
    })?;
    let mut cmd = Command::new(&rt.node);
    cmd.current_dir(&rt.engine_dir);
    cmd.arg(cli);
    cmd.args(["bundle", &format!("--out-dir={}", out_dir.display())]);
    Ok(cmd)
}

/// One still: which bundle, which manifest, which frame, where to.
#[derive(Debug, Clone)]
pub struct StillRequest {
    /// The located runtime (D-417).
    pub runtime: MotionRuntime,
    /// A bundle from [`ensure_bundle`].
    pub bundle_dir: PathBuf,
    /// Absolute path to the manifest JSON (`--props=`).
    pub manifest_path: PathBuf,
    /// The PNG to write.
    pub output_path: PathBuf,
    /// ABSOLUTE composition frame.
    pub frame: u32,
    /// Render scale (1 = the manifest's own resolution).
    pub scale: f64,
    /// Always `"Animation"` for a manifest.
    pub composition_id: String,
}

/// The still render of `req` — pure, the twin of [`crate::build_command`].
pub fn build_still_command(req: &StillRequest) -> Command {
    let mut cmd = runner_command(&req.runtime, "still");
    cmd.args([
        format!("--serve-url={}", req.bundle_dir.display()),
        format!("--composition={}", req.composition_id),
        format!("--props={}", req.manifest_path.display()),
        format!("--output={}", req.output_path.display()),
        format!("--frame={}", req.frame),
        format!("--scale={}", req.scale),
    ]);
    cmd
}

/// Render one still (on its own port, B-278).
pub fn render_still(req: &StillRequest) -> Result<(), ChromaError> {
    finish(
        crate::output_with_own_port(|| build_still_command(req))?,
        "still",
    )
}

/// D-409 — every frame of `frames` (inclusive, absolute) as a PNG image
/// sequence in ONE renderer process: what certification's in-order pass and
/// the live player's proxy frames use. `concurrency: Some(1)` renders every
/// frame in one browser tab, in order — the pass that would expose state a
/// component carries from one frame to the next.
#[derive(Debug, Clone)]
pub struct SequenceRequest {
    pub runtime: MotionRuntime,
    pub bundle_dir: PathBuf,
    pub manifest_path: PathBuf,
    /// The folder the PNGs are written into.
    pub out_dir: PathBuf,
    pub frames: (u32, u32),
    pub scale: f64,
    pub concurrency: Option<u32>,
}

/// The image-sequence render of `req` — pure.
pub fn build_sequence_command(req: &SequenceRequest) -> Command {
    let mut cmd = runner_command(&req.runtime, "frames");
    cmd.args([
        format!("--serve-url={}", req.bundle_dir.display()),
        format!("--props={}", req.manifest_path.display()),
        format!("--output={}", req.out_dir.display()),
        format!("--frames={}-{}", req.frames.0, req.frames.1),
        format!("--scale={}", req.scale),
    ]);
    if let Some(n) = req.concurrency {
        cmd.arg(format!("--concurrency={n}"));
    }
    cmd
}

/// Render `req` (on its own port, B-278) and return the PNGs it wrote, keyed
/// by the frame number in each file name, sorted by frame.
///
/// Remotion's CLI refused an image-sequence folder whose path contains a `.`
/// ANYWHERE (`getExtensionOfFilename` splits the whole path on dots), and real
/// paths here do: `<project>.chroma/…`, an app-data folder named by a bundle
/// identifier. Such a folder is still rendered into a dot-free scratch folder
/// under the system temp dir and its frames moved into `out_dir` afterwards,
/// which keeps every path the renderer sees free of that ambiguity.
pub fn render_sequence(req: &SequenceRequest) -> Result<Vec<(u32, PathBuf)>, ChromaError> {
    std::fs::create_dir_all(&req.out_dir)
        .map_err(|e| ChromaError::Invalid(format!("create {}: {e}", req.out_dir.display())))?;
    let has_dot = |p: &Path| p.to_string_lossy().contains('.');
    if !has_dot(&req.out_dir) {
        finish(
            crate::output_with_own_port(|| build_sequence_command(req))?,
            "render --sequence",
        )?;
        return sequence_frames(&req.out_dir);
    }
    static SCRATCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SCRATCH.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let scratch = std::env::temp_dir().join(format!("apelles-sequence-{}-{n}", std::process::id()));
    if has_dot(&scratch) {
        return Err(ChromaError::Invalid(format!(
            "remotion cannot write an image sequence under {} (a '.' in the path) and the temp folder {} has one too",
            req.out_dir.display(),
            scratch.display()
        )));
    }
    if scratch.exists() {
        std::fs::remove_dir_all(&scratch)
            .map_err(|e| ChromaError::Invalid(format!("clear {}: {e}", scratch.display())))?;
    }
    let staged = SequenceRequest {
        out_dir: scratch.clone(),
        ..req.clone()
    };
    let rendered = finish(
        crate::output_with_own_port(|| build_sequence_command(&staged))?,
        "render --sequence",
    )
    .and_then(|()| sequence_frames(&scratch));
    let moved = rendered.and_then(|frames| {
        frames
            .into_iter()
            .map(|(frame, from)| {
                let to = req.out_dir.join(from.file_name().unwrap_or_default());
                std::fs::rename(&from, &to)
                    .or_else(|_| std::fs::copy(&from, &to).map(|_| ()))
                    .map_err(|e| ChromaError::Invalid(format!("move {}: {e}", from.display())))?;
                Ok((frame, to))
            })
            .collect::<Result<Vec<_>, ChromaError>>()
    });
    // Scratch only; a leftover costs disk, not correctness.
    let _ = std::fs::remove_dir_all(&scratch);
    moved
}

/// The PNGs in a `--sequence` output folder, by the frame number Remotion puts
/// at the end of each file name (`element-042.png` → 42), sorted.
pub fn sequence_frames(dir: &Path) -> Result<Vec<(u32, PathBuf)>, ChromaError> {
    let mut out = Vec::new();
    let entries = std::fs::read_dir(dir)
        .map_err(|e| ChromaError::Invalid(format!("read {}: {e}", dir.display())))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "png") {
            continue;
        }
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let digits: String = stem
            .chars()
            .rev()
            .take_while(char::is_ascii_digit)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        if let Ok(frame) = digits.parse::<u32>() {
            out.push((frame, path));
        }
    }
    out.sort_by_key(|(f, _)| *f);
    Ok(out)
}

fn run(mut cmd: Command, what: &str) -> Result<(), ChromaError> {
    let output = cmd
        .output()
        .map_err(|e| ChromaError::Invalid(format!("failed to spawn node for {what}: {e}")))?;
    finish(output, what)
}

/// Turn a finished renderer run into `Ok` or a named error with its stderr tail.
fn finish(output: std::process::Output, what: &str) -> Result<(), ChromaError> {
    if output.status.success() {
        return Ok(());
    }
    let code = output
        .status
        .code()
        .map(|c| c.to_string())
        .unwrap_or_else(|| "signal".to_string());
    Err(ChromaError::Invalid(format!(
        "motion {what} exited {code}: {}",
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

/// A content hash of everything that goes into a bundle built from the
/// engine's sources: its `src/` tree, its `package.json` and
/// `remotion.config.ts`. Test files are part of `src/` and are hashed too; a
/// changed test re-bundles, which is harmless.
pub fn engine_fingerprint(engine_dir: &Path) -> Result<String, ChromaError> {
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
    Ok(hasher.finalize().to_hex()[..FINGERPRINT_CHARS].to_string())
}

/// A key for a public folder's contents: the NAMES of its files (they are
/// content-addressed, so a name stands for its content).
pub fn public_fingerprint(public_dir: &Path) -> Result<String, ChromaError> {
    let mut names = Vec::new();
    files_under(public_dir, public_dir, &mut names)
        .map_err(|e| ChromaError::Invalid(format!("fingerprint {}: {e}", public_dir.display())))?;
    names.sort();
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"public\0");
    for n in names {
        hasher.update(n.to_string_lossy().as_bytes());
        hasher.update(&[0]);
    }
    Ok(hasher.finalize().to_hex()[..FINGERPRINT_CHARS].to_string())
}

/// The prebuilt bundle's key, from the pack manifest beside it.
fn pack_bundle_key(engine_dir: &Path) -> Result<String, ChromaError> {
    let path = engine_dir.join(PACK_MANIFEST);
    let text = std::fs::read_to_string(&path).map_err(|e| {
        ChromaError::NotFound(format!("engine pack manifest {}: {e}", path.display()))
    })?;
    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| ChromaError::Invalid(format!("{}: {e}", path.display())))?;
    v.get("bundleKey")
        .and_then(serde_json::Value::as_str)
        .map(|k| k.chars().take(FINGERPRINT_CHARS).collect())
        .ok_or_else(|| ChromaError::Invalid(format!("{} has no bundleKey", path.display())))
}

/// The bundle to render the engine with, as it is now (see the module doc):
/// the prebuilt one in a release pack, or one built from the checkout's sources
/// into `cache_root`; and, when `public_dir` is a folder, a derived copy of
/// that bundle with its files in `public/`. A bundle is built or copied into a
/// staging directory and renamed into place, so a half-written one is never
/// reused; other `bundle-*` siblings unused for `BUNDLE_STALE_AFTER` are removed.
pub fn ensure_bundle(
    rt: &MotionRuntime,
    cache_root: &Path,
    public_dir: Option<&Path>,
) -> Result<PathBuf, ChromaError> {
    // Two previews at once (an agent's and the GUI's) must not both build into
    // the same staging directory; the second waits and then reuses the bundle.
    let _guard = BUNDLE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (base, base_key) = match &rt.prebuilt_bundle {
        Some(prebuilt) => {
            if !prebuilt.join("index.html").is_file() {
                return Err(ChromaError::NotFound(format!(
                    "the engine's prebuilt bundle is missing: {}",
                    prebuilt.display()
                )));
            }
            (prebuilt.clone(), pack_bundle_key(&rt.engine_dir)?)
        }
        None => {
            let key = engine_fingerprint(&rt.engine_dir)?;
            let dir = cache_root.join(format!("{BUNDLE_PREFIX}{key}"));
            if !dir.join("index.html").is_file() {
                let staging = fresh_staging(cache_root, &key)?;
                run(build_bundle_command(rt, &staging)?, "bundle")?;
                move_into_place(&staging, &dir)?;
            }
            (dir, key)
        }
    };
    // A base built here stays in use while bundles are derived from it, even
    // when every render goes through a derived copy.
    if base.starts_with(cache_root) {
        mark_used(&base);
    }
    let chosen = match public_dir.filter(|d| d.is_dir()) {
        None => base,
        Some(public) => {
            let key = format!("{base_key}-{}", public_fingerprint(public)?);
            let dir = cache_root.join(format!("{BUNDLE_PREFIX}{key}"));
            if !dir.join("index.html").is_file() {
                let staging = fresh_staging(cache_root, &key)?;
                copy_tree(&base, &staging)?;
                copy_tree(public, &staging.join("public"))?;
                move_into_place(&staging, &dir)?;
            }
            dir
        }
    };
    if chosen.starts_with(cache_root) {
        mark_used(&chosen);
    }
    prune_stale(cache_root, &chosen);
    Ok(chosen)
}

/// An empty `staging-<key>` folder under `cache_root`.
fn fresh_staging(cache_root: &Path, key: &str) -> Result<PathBuf, ChromaError> {
    std::fs::create_dir_all(cache_root)
        .map_err(|e| ChromaError::Invalid(format!("create {}: {e}", cache_root.display())))?;
    let staging = cache_root.join(format!("staging-{key}"));
    if staging.exists() {
        std::fs::remove_dir_all(&staging)
            .map_err(|e| ChromaError::Invalid(format!("clear {}: {e}", staging.display())))?;
    }
    Ok(staging)
}

/// Rename a finished staging folder onto `dir` (replacing a half-made one).
fn move_into_place(staging: &Path, dir: &Path) -> Result<(), ChromaError> {
    if dir.exists() {
        std::fs::remove_dir_all(dir)
            .map_err(|e| ChromaError::Invalid(format!("clear {}: {e}", dir.display())))?;
    }
    std::fs::rename(staging, dir)
        .map_err(|e| ChromaError::Invalid(format!("move bundle into {}: {e}", dir.display())))
}

/// Copy every file under `from` to the same place under `to`. `std::fs::copy`
/// clones on APFS, so a derived bundle shares its base's blocks.
fn copy_tree(from: &Path, to: &Path) -> Result<(), ChromaError> {
    let mut files = Vec::new();
    files_under(from, from, &mut files)
        .map_err(|e| ChromaError::Invalid(format!("read {}: {e}", from.display())))?;
    for rel in files {
        let dest = to.join(&rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| ChromaError::Invalid(format!("create {}: {e}", parent.display())))?;
        }
        std::fs::copy(from.join(&rel), &dest)
            .map_err(|e| ChromaError::Invalid(format!("copy {}: {e}", rel.display())))?;
    }
    Ok(())
}

/// Older bundles are dead weight (tens of MB each), but one may still be in
/// use by a concurrent preview, so only those unused for `BUNDLE_STALE_AFTER`
/// go. A failure to delete one costs disk, not correctness: not an error.
fn prune_stale(cache_root: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(cache_root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age >= BUNDLE_STALE_AFTER);
        if name.starts_with(BUNDLE_PREFIX) && entry.path() != keep && stale {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Record that `dir` was just used, so pruning leaves it alone for a while.
/// Best effort: a failure only makes the bundle eligible for pruning sooner.
fn mark_used(dir: &Path) {
    let _ = std::fs::File::open(dir).and_then(|f| f.set_modified(std::time::SystemTime::now()));
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
    /// The located runtime (D-417).
    pub runtime: MotionRuntime,
    /// Where the cached bundles live (`bundle-<fingerprint>` inside).
    pub cache_dir: PathBuf,
    /// Where the PNG (and its transient tiles) are written.
    pub out_dir: PathBuf,
    pub manifest_path: PathBuf,
    pub frames: Vec<u32>,
    pub scale: f64,
    /// Names the output file (`<label>.png`).
    pub label: String,
    /// An optional directory served to the engine as `public/`.
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
    if !req.runtime.engine_dir.is_dir() {
        return Err(ChromaError::NotFound(format!(
            "motion engine dir: {}",
            req.runtime.engine_dir.display()
        )));
    }
    let bundle_dir = ensure_bundle(&req.runtime, &req.cache_dir, req.public_dir.as_deref())?;
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
            runtime: req.runtime.clone(),
            bundle_dir: bundle_dir.clone(),
            manifest_path: req.manifest_path.clone(),
            output_path: tile.clone(),
            frame: *frame,
            scale: req.scale,
            composition_id: "Animation".to_string(),
        };
        render_still(&still)?;
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
            runtime: crate::tests::dev_runtime("/engine"),
            bundle_dir: "/cache/bundle-ab".into(),
            manifest_path: "/tmp/m.json".into(),
            output_path: "/tmp/out.png".into(),
            frame: 42,
            scale: 0.5,
            composition_id: "Animation".into(),
        };
        let cmd = build_still_command(&req);
        assert_eq!(cmd.get_program(), "/usr/bin/node");
        assert_eq!(cmd.get_current_dir(), Some(Path::new("/engine")));
        assert_eq!(
            args(&cmd),
            vec![
                "/engine/scripts/render.mts",
                "still",
                "--serve-url=/cache/bundle-ab",
                "--composition=Animation",
                "--props=/tmp/m.json",
                "--output=/tmp/out.png",
                "--frame=42",
                "--scale=0.5",
            ]
        );
    }

    #[test]
    fn build_sequence_command_renders_frames_in_one_process() {
        let req = SequenceRequest {
            runtime: crate::tests::managed_runtime(),
            bundle_dir: "/c/bundle-ab".into(),
            manifest_path: "/m.json".into(),
            out_dir: "/out".into(),
            frames: (0, 29),
            scale: 0.5,
            concurrency: Some(1),
        };
        let a = args(&build_sequence_command(&req));
        assert_eq!(
            &a[..2],
            ["/App/Resources/motion-engine/scripts/render.mts", "frames"]
        );
        assert!(a.contains(&"--frames=0-29".to_string()));
        assert!(a.contains(&"--output=/out".to_string()));
        assert_eq!(a.last().map(String::as_str), Some("--concurrency=1"));
        assert!(a.contains(&"--browser-executable=/rt/chrome/chrome-headless-shell".to_string()));
    }

    #[test]
    fn a_checkout_bundles_with_the_remotion_cli_above_it() -> Result<(), Box<dyn std::error::Error>>
    {
        let root = tempfile::tempdir()?;
        let engine = root.path().join("packages/motion-engine");
        std::fs::create_dir_all(&engine)?;
        let rt = crate::tests::dev_runtime(&engine.to_string_lossy());
        assert!(
            build_bundle_command(&rt, Path::new("/c/b")).is_err(),
            "no CLI, a named error"
        );
        let cli = root.path().join("node_modules").join(REMOTION_CLI);
        std::fs::create_dir_all(cli.parent().ok_or("no parent")?)?;
        std::fs::write(&cli, "")?;
        let cmd = build_bundle_command(&rt, Path::new("/c/b"))?;
        assert_eq!(cmd.get_program(), "/usr/bin/node");
        assert_eq!(
            args(&cmd),
            vec![
                cli.to_string_lossy().to_string(),
                "bundle".into(),
                "--out-dir=/c/b".into()
            ]
        );
        Ok(())
    }

    /// A release pack's bundle is used in place; a project's assets make a
    /// derived copy with them in `public/`, reused while the asset names hold.
    #[test]
    fn a_prebuilt_bundle_is_used_as_is_and_assets_make_a_derived_copy()
    -> Result<(), Box<dyn std::error::Error>> {
        let tmp = tempfile::tempdir()?;
        let pack = tmp.path().join("motion-engine");
        let bundle = pack.join("bundle");
        std::fs::create_dir_all(bundle.join("sub"))?;
        std::fs::write(bundle.join("index.html"), "<html>")?;
        std::fs::write(bundle.join("sub/chunk.js"), "js")?;
        std::fs::write(
            pack.join(PACK_MANIFEST),
            r#"{"bundleKey":"0123456789abcdef0123"}"#,
        )?;
        let mut rt = crate::tests::managed_runtime();
        rt.engine_dir = pack.clone();
        rt.prebuilt_bundle = Some(bundle.clone());
        let cache = tmp.path().join("cache");

        assert_eq!(
            ensure_bundle(&rt, &cache, None)?,
            bundle,
            "no assets: the pack's own bundle"
        );

        let assets = tmp.path().join("assets");
        std::fs::create_dir_all(&assets)?;
        std::fs::write(assets.join("abc.png"), "png")?;
        let derived = ensure_bundle(&rt, &cache, Some(&assets))?;
        assert!(derived.starts_with(&cache));
        assert!(
            derived
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("bundle-0123456789abcdef-"))
        );
        assert_eq!(std::fs::read_to_string(derived.join("sub/chunk.js"))?, "js");
        assert_eq!(
            std::fs::read_to_string(derived.join("public/abc.png"))?,
            "png"
        );
        assert_eq!(
            ensure_bundle(&rt, &cache, Some(&assets))?,
            derived,
            "reused"
        );

        std::fs::write(assets.join("def.png"), "png2")?;
        let next = ensure_bundle(&rt, &cache, Some(&assets))?;
        assert_ne!(next, derived, "a new asset is a new derived bundle");
        assert!(next.join("public/def.png").is_file());
        Ok(())
    }

    #[test]
    fn a_missing_prebuilt_bundle_is_a_named_error() -> Result<(), Box<dyn std::error::Error>> {
        let tmp = tempfile::tempdir()?;
        let mut rt = crate::tests::managed_runtime();
        rt.prebuilt_bundle = Some(tmp.path().join("bundle"));
        let err = ensure_bundle(&rt, &tmp.path().join("c"), None)
            .err()
            .ok_or("accepted")?;
        assert!(
            err.to_string().contains("prebuilt bundle is missing"),
            "{err}"
        );
        Ok(())
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
        let a = engine_fingerprint(dir.path())?;
        assert_eq!(a, engine_fingerprint(dir.path())?, "same content, same key");
        std::fs::write(dir.path().join("src/a/x.ts"), "two")?;
        assert_ne!(
            a,
            engine_fingerprint(dir.path())?,
            "changed content, new key"
        );

        let public = dir.path().join("public");
        std::fs::create_dir_all(&public)?;
        std::fs::write(public.join("abc.png"), "x")?;
        let p1 = public_fingerprint(&public)?;
        std::fs::write(public.join("abc.png"), "y")?;
        assert_eq!(
            p1,
            public_fingerprint(&public)?,
            "names, not bytes (content-addressed)"
        );
        std::fs::write(public.join("def.png"), "x")?;
        assert_ne!(p1, public_fingerprint(&public)?, "a new asset, a new key");
        Ok(())
    }

    #[test]
    fn safe_label_keeps_ids_and_replaces_the_rest() {
        assert_eq!(safe_label("hook-1_a"), "hook-1_a");
        assert_eq!(safe_label("../x y"), "___x_y");
        assert_eq!(safe_label(""), "preview");
    }
}
