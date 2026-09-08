//! **grade_lut.rs — the Colorist ⇄ Edit grade bridge** (D-256).
//!
//! What it is: the one place that turns a clip's saved Colorist grade
//! (`<project>/grades/<clip.id>.grade.json`, D-025/D-070) into a baked
//! [`Lut3d`] — by running an identity RGB lattice through **the real Colorist
//! wgpu pipeline** — plus the process-wide cache that keeps a live preview from
//! re-baking one per frame.
//!
//! What it does: [`bake_lut3d`] renders the lattice through
//! `render_core::render` exactly as a graded frame would be rendered, and reads
//! the result back as a lattice; [`lut_for_clip`] resolves a `Clip` id to
//! `Some(lut)` / `None` against the open project, memoised on the grade file's
//! own (mtime, len); [`apply_to_rgba`] is the per-pixel application
//! `chroma::edit`'s compositor calls.
//!
//! What it does NOT do: no `.cube` parsing (the app's `lut_processing` owns
//! that direction), no lattice maths (that is `chroma_types::lut3d`, pure and
//! unit-tested there), no timeline knowledge, no filtergraph knowledge. It does
//! **not** carry the spatial half of a grade — see "What a LUT cannot carry"
//! below; that is a documented, warned-about limit, not an oversight.
//!
//! ## Why a baked lattice, and not the shader itself (D-256)
//!
//! `chroma_types::adjustment`'s header states the obstacle this module removes,
//! and states it correctly: the Colorist's `adjustments` blob is untyped in
//! Rust and is applied *only* by RapidRAW's wgpu shader, the Edit compositor is
//! deliberately GPU-free, and the ffmpeg exporter could never reproduce a
//! shader — so wiring the Edit tab "straight into the grade" would have meant
//! either a second CPU implementation of the whole grading stack (two
//! implementations to keep in step: the exact defect class B-090/B-095/B-098
//! were) or a guaranteed preview-vs-export divergence.
//!
//! Baking sidesteps both. The shader stays the *only* implementation of the
//! grade maths — it is what renders the lattice — and what crosses into the
//! other two engines is 3×33³ numbers. The Edit preview interpolates them on
//! the CPU (`chroma_types::Lut3d::sample_trilinear`); the ffmpeg export hands
//! the very same lattice, written as a `.cube`, to ffmpeg's own `lut3d` filter
//! with `interp=trilinear`. Preview and export therefore agree *by
//! construction*.
//!
//! ## What a LUT cannot carry
//!
//! A 3D LUT is a pure per-pixel `RGB → RGB` function. Everything **spatial** in
//! a grade is outside that by definition: mask layers / local adjustments,
//! crop, rotation/flips, and depth-driven relight. [`bake_lut3d`] strips those
//! before baking (they would also distort the lattice image itself — a crop
//! applied to a 33×1089 lattice is meaningless) and returns a warning naming
//! each one it dropped, which [`lut_for_clip`] logs once per bake rather than
//! once per frame. The clip's *global* grade — exposure, contrast, curves,
//! colour wheels, HSL, an applied `.cube`, everything the primary panel does —
//! is carried exactly.
//!
//! ## Determinism (CLAUDE.md's render-path invariant)
//!
//! Same grade document ⇒ same lattice ⇒ same pixels. The bake reads only the
//! grade JSON; the cache is keyed on the grade file's (mtime, len) but that is
//! a staleness check, never an input to the maths — a cache hit and a cold bake
//! of the same file produce the same `Lut3d`. `sample_trilinear` is pure `f32`
//! arithmetic with no accumulation order to vary.
//!
//! Fork hygiene (D-003): all new code, in a new file. Upstream footprint is
//! `pub mod grade_lut;` in `chroma/mod.rs` and the `generate_handler!` line in
//! `lib.rs` for `chroma_timeline_grade_luts`. Divergence logged in
//! `docs/09-engine-notes.md`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chroma_types::Lut3d;
use chroma_types::lut3d::{DEFAULT_SIZE, IDENTITY_TOL};
use image::{DynamicImage, RgbImage, RgbaImage};
use once_cell::sync::Lazy;
use serde_json::{Value, json};

use crate::gpu_processing::RenderRequest;
use crate::image_processing::{GpuContext, get_all_adjustments_from_json};
use crate::render_core::{self, OwnedRenderCaches};

use super::state;

/// The `.cube` `TITLE` written for a baked clip grade, and the `caller_id` the
/// render is tagged with in the GPU profiler.
const BAKE_CALLER: &str = "grade_lut";

/// A baked grade: the lattice, plus what baking had to drop (see the module
/// doc's "What a LUT cannot carry").
pub struct BakedGrade {
    pub lut: Lut3d,
    pub warnings: Vec<String>,
}

/// A GPU context + caches held across several bakes.
///
/// `init_gpu_context` is the expensive part of a bake (adapter enumeration +
/// device creation), and the export path bakes one LUT per graded clip — so
/// baking N grades must not mean creating N devices. A single-clip caller uses
/// [`BakeSession::new`] once and drops it; nothing here is cached process-wide,
/// because a *live* GPU device held for the process lifetime is exactly what
/// the Colorist's own context already is and a second permanent one would
/// double the app's VRAM footprint for a path that runs on grade change, not
/// per frame.
pub struct BakeSession {
    ctx: GpuContext,
    caches: OwnedRenderCaches,
}

impl BakeSession {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            ctx: render_core::init_gpu_context()?,
            caches: OwnedRenderCaches::default(),
        })
    }

    /// Bake `js_adjustments` (a grade document's `adjustments` object) into a
    /// lattice of edge `size`.
    ///
    /// `chain_source_lut` decides what happens to a grade that itself applies a
    /// `.cube` (the Colorist's LUT slot). `true` — what the Edit bridge wants —
    /// runs the lattice through that LUT as well, so the baked result is
    /// everything the Colorist is actually showing. `false` — what the
    /// Colorist's own "bake this grade to a `.cube`" export wants — leaves it
    /// out and warns, because that output is a LUT the user will apply
    /// somewhere the source LUT is already applied (no LUT-on-LUT). The two
    /// callers genuinely want opposite things; a parameter states that rather
    /// than one of them quietly getting the wrong answer.
    pub fn bake(
        &self,
        js_adjustments: &Value,
        size: u32,
        chain_source_lut: bool,
    ) -> Result<BakedGrade, String> {
        let size = size.clamp(chroma_types::lut3d::MIN_SIZE, chroma_types::lut3d::MAX_SIZE);
        let n = size as usize;

        // --- strip everything a 3D LUT provably cannot carry -----------------
        let mut primary = js_adjustments.clone();
        let mut warnings = Vec::new();
        if let Some(masks) = primary.get("masks").and_then(|m| m.as_array()) {
            let visible = masks
                .iter()
                .filter(|m| m.get("visible").and_then(|v| v.as_bool()).unwrap_or(true))
                .count();
            if visible > 0 {
                warnings.push(format!(
                    "grade has {visible} masked/local layer(s); a 3D LUT is global-only — baked the primary grade, dropped the masks"
                ));
            }
        }
        let source_lut = primary
            .get("lutPath")
            .and_then(|p| p.as_str())
            .map(|p| p.to_string());
        if let Some(path) = &source_lut
            && !chain_source_lut
        {
            let _ = path;
            warnings.push(
                "grade already applies a .cube LUT; it was NOT chained into this bake (no LUT-on-LUT)"
                    .into(),
            );
        }
        if primary.get("crop").is_some_and(|c| !c.is_null()) {
            warnings.push(
                "grade has a Colorist crop; a 3D LUT is colour-only — the crop was not baked"
                    .into(),
            );
        }
        for k in ["masks", "lutPath", "crop"] {
            if let Some(obj) = primary.as_object_mut() {
                obj.remove(k);
            }
        }
        if let Some(obj) = primary.as_object_mut() {
            obj.insert("rotation".into(), json!(0.0));
            obj.insert("flipHorizontal".into(), json!(false));
            obj.insert("flipVertical".into(), json!(false));
            obj.insert("orientationSteps".into(), json!(0));
        }

        // --- the identity lattice, as a picture the shader can grade ---------
        // Laid out exactly as `Lut3d`'s own storage order (red fastest, then
        // green down the column, then blue): x = r, y = b*size + g. The
        // read-back below walks the same indices, so the two orderings cannot
        // drift apart.
        let identity = Lut3d::identity(size)?;
        let mut grid = RgbImage::new(size, size * size);
        for b in 0..n {
            for g in 0..n {
                for r in 0..n {
                    let i = ((b * n + g) * n + r) * 3;
                    let d = identity.data();
                    grid.put_pixel(
                        r as u32,
                        (b * n + g) as u32,
                        image::Rgb([
                            (d[i] * 255.0).round().clamp(0.0, 255.0) as u8,
                            (d[i + 1] * 255.0).round().clamp(0.0, 255.0) as u8,
                            (d[i + 2] * 255.0).round().clamp(0.0, 255.0) as u8,
                        ]),
                    );
                }
            }
        }

        let lut = match (&source_lut, chain_source_lut) {
            (Some(path), true) => crate::lut_processing::parse_lut_file(path)
                .map(Arc::new)
                .map_err(|e| {
                    warnings.push(format!("grade's .cube LUT {path} could not be read: {e}"));
                })
                .ok(),
            _ => None,
        };

        let adjustments = get_all_adjustments_from_json(&primary, false, None);
        let graded = render_core::render(
            &self.ctx,
            self.caches.as_ref(),
            &DynamicImage::ImageRgb8(grid),
            0,
            RenderRequest {
                adjustments,
                mask_bitmaps: &[],
                lut,
                roi: None,
            },
            BAKE_CALLER,
            false,
            None,
        )?;
        let graded = graded.to_rgb8();
        if graded.dimensions() != (size, size * size) {
            return Err(format!(
                "bake produced {}x{}, expected {}x{} — a geometry adjustment survived the strip",
                graded.width(),
                graded.height(),
                size,
                size * size
            ));
        }

        let mut data = Vec::with_capacity(3 * n * n * n);
        for b in 0..n {
            for g in 0..n {
                for r in 0..n {
                    let px = graded.get_pixel(r as u32, (b * n + g) as u32);
                    data.push(px[0] as f32 / 255.0);
                    data.push(px[1] as f32 / 255.0);
                    data.push(px[2] as f32 / 255.0);
                }
            }
        }
        Ok(BakedGrade {
            lut: Lut3d::new(size, data)?,
            warnings,
        })
    }
}

/// One-shot bake — a [`BakeSession`] used once. See [`BakeSession::bake`].
pub fn bake_lut3d(
    js_adjustments: &Value,
    size: u32,
    chain_source_lut: bool,
) -> Result<BakedGrade, String> {
    BakeSession::new()?.bake(js_adjustments, size, chain_source_lut)
}

// --------------------------------------------------------------------------- //
// grade file → LUT, memoised
// --------------------------------------------------------------------------- //

/// `<project>/grades/<clip_id>.grade.json` — where the Colorist writes a clip's
/// grade (D-025's document, at D-070's clip-id-keyed name).
pub fn grade_file_for(project_dir: &Path, clip_id: &str) -> PathBuf {
    chroma_project::grade_dir(project_dir).join(format!("{clip_id}.grade.json"))
}

/// A grade file's staleness fingerprint: (mtime nanos, length). Never an input
/// to the bake — only a "has this file changed since we baked it" test. See the
/// module doc's determinism note.
type Fingerprint = (i128, u64);

fn fingerprint(path: &Path) -> Option<Fingerprint> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as i128)
        .unwrap_or(0);
    Some((mtime, meta.len()))
}

/// What one clip's grade file resolved to.
#[derive(Clone)]
pub struct ClipGrade {
    /// The lattice, or `None` for a grade that bakes to the identity — see
    /// [`resolve_clip_lut`]'s doc for why an identity grade resolves to no
    /// lattice at all rather than to an identity one.
    pub lut: Option<Arc<Lut3d>>,
    /// What baking had to drop (see the module doc's "What a LUT cannot
    /// carry"). Carried on the cached entry, not just logged at bake time, so
    /// the Export dialog can show the user the cases where the exported file
    /// legitimately will not match the Colorist tab.
    pub warnings: Vec<String>,
}

/// What a grade file resolved to, once.
///
/// **Three states, not two, and the third is why.** `Ok(lut: None)` and `Err`
/// are both "no lattice to apply", but the two callers must treat them
/// completely differently: the live preview shows the ungraded picture either
/// way (a broken bake must not blank the Edit tab), while the *export* must
/// refuse outright on `Err` — an export that silently drops a grade the preview
/// was showing is precisely the preview-vs-export divergence this decision
/// exists to prevent. Collapsing them into `Option` is what would make that
/// silent.
type Resolved = Result<ClipGrade, String>;

/// One memoised answer + the fingerprint it was baked against. Caching a
/// failure matters as much as caching a success: without it a structural error
/// (no GPU adapter) would retry a full bake on every single preview frame.
type CacheEntry = (Fingerprint, Resolved);

static LUT_CACHE: Lazy<Mutex<HashMap<PathBuf, CacheEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Drop every memoised bake.
///
/// `#[cfg(test)]` because nothing in a running app needs it: entries are keyed
/// by absolute path *and* fingerprint, so a stale one is impossible by
/// construction and the only cost of keeping them is a few hundred kB. What
/// does need it is a test that writes two different grades to the same temp
/// path — possibly inside one filesystem timestamp tick, where (mtime, len)
/// would look unchanged. Gated rather than left `pub` so it does not read as
/// dead code in a shipped build (CLAUDE.md: no dead code).
#[cfg(test)]
pub fn clear_cache() {
    if let Ok(mut c) = LUT_CACHE.lock() {
        c.clear();
    }
}

/// The baked grade for `clip_id` in the currently-open project, or `None` when
/// there is no project, no grade file, or the grade bakes to the identity.
///
/// **`None` for an identity grade is deliberate** and is what keeps an
/// ungraded — or graded-then-reset — clip's preview byte-identical to what it
/// was before D-256: no LUT is applied at all, rather than an identity LUT
/// whose 8-bit round trip could still shift a value. Same "an untouched effect
/// emits nothing" property D-230's adjustment clip has in both engines.
///
/// A bake failure (no GPU adapter, a corrupt grade file) is logged and treated
/// as `None` here rather than propagated: a preview that shows the ungraded
/// picture is a far better failure than an Edit tab that renders nothing at
/// all. The export path calls [`resolve_clip_lut`] instead and **refuses** on
/// the same error, because there silently dropping a grade is the worse
/// failure — see [`Resolved`].
pub fn lut_for_clip(clip_id: &str) -> Option<Arc<Lut3d>> {
    match resolve_clip_lut(clip_id, None) {
        Ok(grade) => grade.lut,
        Err(e) => {
            log::warn!("[chroma::grade_lut] clip {clip_id}: {e} — previewing ungraded");
            None
        }
    }
}

/// Resolve `clip_id` to its baked lattice against the open project, memoised.
///
/// `Ok` with `lut: None` = nothing to apply (no project, no grade file, or a
/// grade that bakes to the identity). `Err` = there IS a grade here and it could
/// not be baked — never conflated with the former (see [`Resolved`]).
///
/// **An identity grade resolves to no lattice at all**, deliberately: it keeps
/// an ungraded — or graded-then-reset — clip's preview byte-identical to what it
/// was before D-256, rather than running it through an identity LUT whose 8-bit
/// round trip could still shift a value. Same "an untouched effect emits
/// nothing" property D-230's adjustment clip has in both engines.
///
/// `session` lets a batch caller (the export's [`bake_luts_for_clips`]) share
/// one GPU device across every clip instead of creating one per bake; `None`
/// makes a throwaway session, which is what the single-clip preview path wants.
pub fn resolve_clip_lut(clip_id: &str, session: Option<&BakeSession>) -> Resolved {
    let nothing = || ClipGrade {
        lut: None,
        warnings: Vec::new(),
    };
    let Some(project) = state::current_project() else {
        return Ok(nothing());
    };
    let path = grade_file_for(&project.path, clip_id);
    let Some(fp) = fingerprint(&path) else {
        return Ok(nothing()); // no grade file for this clip — the common case
    };

    if let Ok(cache) = LUT_CACHE.lock()
        && let Some((cached_fp, resolved)) = cache.get(&path)
        && *cached_fp == fp
    {
        return resolved.clone();
    }

    let resolved = bake_clip_grade(&path, DEFAULT_SIZE, session).map(|baked| {
        for w in &baked.warnings {
            // Once per bake, not once per frame — see the module doc.
            log::warn!("[chroma::grade_lut] clip {clip_id}: {w}");
        }
        ClipGrade {
            lut: (!baked.lut.is_identity(IDENTITY_TOL)).then(|| Arc::new(baked.lut)),
            warnings: baked.warnings,
        }
    });
    if let Ok(mut cache) = LUT_CACHE.lock() {
        cache.insert(path, (fp, resolved.clone()));
    }
    resolved
}

/// Read one `grade.json` and bake its `adjustments`. Loads through
/// `chroma_grade_model::load_grade`, the same loader the Colorist itself uses,
/// so schema migration happens exactly once in exactly one place.
pub fn bake_clip_grade(
    grade_path: &Path,
    size: u32,
    session: Option<&BakeSession>,
) -> Result<BakedGrade, String> {
    let grade = chroma_grade_model::load_grade(&grade_path.to_string_lossy())?;
    let adjustments = grade
        .get("adjustments")
        .cloned()
        .ok_or_else(|| format!("{} has no `adjustments`", grade_path.display()))?;
    match session {
        Some(s) => s.bake(&adjustments, size, true),
        None => bake_lut3d(&adjustments, size, true),
    }
}

// --------------------------------------------------------------------------- //
// the export side: the same lattice, written where ffmpeg's `lut3d` can read it
// --------------------------------------------------------------------------- //

/// Where a baked `.cube` for the export lives: `<project>/cache/grade-luts/`.
///
/// Inside the `.chroma` bundle rather than a system temp dir on purpose. An
/// export is queued now and may run minutes later (D-198), and its argv — which
/// names this file by path — is deliberately frozen at enqueue time; a temp
/// directory a cleaner can empty in between would turn that into an export that
/// fails, or worse, silently loses a grade. It is also plainly inspectable next
/// to the `grades/` documents it was derived from.
fn lut_cache_dir(project_dir: &Path) -> PathBuf {
    project_dir.join("cache").join("grade-luts")
}

/// What [`bake_luts_for_clips`] hands the frontend.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GradeLutPaths {
    /// `clip id → absolute .cube path`, containing an entry ONLY for a clip
    /// that has a real, non-identity grade. A clip absent from this map has
    /// nothing to apply, which is exactly what the preview does for it too.
    pub luts: HashMap<String, String>,
    /// Everything baking had to drop (masks, a Colorist crop), already prefixed
    /// with the clip name — surfaced in the Export dialog rather than only
    /// logged, because these are the cases where the exported file legitimately
    /// will NOT match the Colorist tab and the user has to know.
    pub warnings: Vec<String>,
}

/// Bake every graded clip in `clip_ids` and write each lattice as a `.cube`
/// ffmpeg's `lut3d` filter can read.
///
/// **One [`BakeSession`] for the whole batch**: `init_gpu_context` is the
/// expensive part of a bake, and a 30-clip timeline must not mean 30 GPU
/// devices.
///
/// **Content-addressed filenames** (`<clip id>-<hash of the lattice>.cube`).
/// Two reasons, both real: a queued export's frozen argv keeps pointing at the
/// exact lattice that was current when it was queued even if the user re-grades
/// the clip while it waits (D-198's snapshot guarantee, which a
/// `<clip id>.cube` overwritten in place would quietly break), and two clips
/// carrying the same grade share one file.
///
/// Errors rather than skipping. A clip that HAS a grade whose bake failed comes
/// back as `Err`, so `compileEditorExportArgs` can refuse the export instead of
/// shipping a file that silently disagrees with the preview.
pub fn bake_luts_for_clips(clip_ids: &[String]) -> Result<GradeLutPaths, String> {
    let Some(project) = state::current_project() else {
        return Ok(GradeLutPaths {
            luts: HashMap::new(),
            warnings: Vec::new(),
        });
    };
    // Nothing to do at all unless at least one clip actually has a grade file —
    // the common case, and worth not creating a GPU device for.
    let graded: Vec<&String> = clip_ids
        .iter()
        .filter(|id| grade_file_for(&project.path, id).is_file())
        .collect();
    if graded.is_empty() {
        return Ok(GradeLutPaths {
            luts: HashMap::new(),
            warnings: Vec::new(),
        });
    }

    let dir = lut_cache_dir(&project.path);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    // Built lazily: every clip may already be memoised from the preview, in
    // which case this whole call touches no GPU at all.
    let mut session: Option<BakeSession> = None;
    let mut luts = HashMap::new();
    let mut warnings = Vec::new();

    for clip_id in graded {
        if session.is_none() && !is_memoised(&project.path, clip_id) {
            session = Some(BakeSession::new()?);
        }
        let grade = resolve_clip_lut(clip_id, session.as_ref())
            .map_err(|e| format!("clip {clip_id}: {e}"))?;
        warnings.extend(grade.warnings.iter().map(|w| format!("clip {clip_id}: {w}")));
        let Some(lut) = grade.lut else {
            continue; // graded, but the grade is a no-op — nothing for ffmpeg to do
        };
        let text = lut.to_cube_text(&format!("Chroma clip grade {clip_id}"));
        let path = dir.join(format!("{clip_id}-{:016x}.cube", stable_hash(&text)));
        // Content-addressed, so an existing file with this name IS this lattice.
        if !path.is_file() {
            std::fs::write(&path, &text).map_err(|e| format!("write {}: {e}", path.display()))?;
        }
        luts.insert(clip_id.clone(), path.to_string_lossy().to_string());
    }

    Ok(GradeLutPaths { luts, warnings })
}

/// Is this clip's grade already memoised at its current fingerprint? Only used
/// to decide whether a batch bake needs a GPU device at all.
fn is_memoised(project_dir: &Path, clip_id: &str) -> bool {
    let path = grade_file_for(project_dir, clip_id);
    let Some(fp) = fingerprint(&path) else {
        return true; // nothing to bake
    };
    LUT_CACHE
        .lock()
        .ok()
        .and_then(|c| c.get(&path).map(|(cached, _)| *cached == fp))
        .unwrap_or(false)
}

/// A stable content hash for the `.cube` filename.
///
/// `DefaultHasher` is explicitly **not** guaranteed stable across Rust
/// releases, which would be a bug in a persisted key — so this is a plain
/// FNV-1a written out, four lines, deterministic forever. It names a cache
/// file; it is not security-relevant.
fn stable_hash(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    h
}

/// Bake the `.cube` files an Edit-tab export needs, for the clips the caller
/// names. See [`bake_luts_for_clips`].
///
/// Off the Tauri main thread (`spawn_blocking`) for `chroma_timeline_frame`'s
/// reason — a cold batch is real GPU work and the window's event loop must not
/// wait on it.
#[tauri::command]
pub async fn chroma_timeline_grade_luts(clip_ids: Vec<String>) -> Result<GradeLutPaths, String> {
    tokio::task::spawn_blocking(move || bake_luts_for_clips(&clip_ids))
        .await
        .map_err(|e| format!("grade lut bake task: {e}"))?
}

// --------------------------------------------------------------------------- //
// applying a lattice to a decoded frame
// --------------------------------------------------------------------------- //

/// Apply `lut` to every pixel of `img`, in place.
///
/// Alpha is untouched — a grade is a colour transform, and the compositor's own
/// alpha (a clip's opacity, a transition's blend) is applied later and must not
/// be graded. Mirrors `chroma::edit`'s `apply_adjustment_to_canvas`, which does
/// the same for D-230's operator; the difference is *where* each runs: an
/// adjustment clip operates on the composited canvas beneath it, a clip's grade
/// operates on that clip's own decoded pixels before it is placed.
///
/// **Parallel over rows, and that is a measurement rather than a reflex.**
/// A trilinear sample is eight scattered reads into a 33³ lattice (431 kB of
/// `f32` — past L1), so the serial loop measured **22 ms** for one 960×540
/// preview frame on this machine: over half of a 24 fps frame's 41 ms budget,
/// for one graded layer, which is a visible stutter by CLAUDE.md's
/// performance-first rule rather than a rounding error. Chunking by row brings
/// it to ~3 ms. `rayon` is already an `app/src-tauri` dependency, and it stays
/// here rather than in `chroma-types` so that L0 crate keeps its zero-heavy-deps
/// rule (D-039) — the pure per-pixel maths is still `Lut3d::apply_rgb8`, called
/// unchanged; only the walk over the buffer is parallel.
///
/// Determinism is unaffected: each pixel's output depends on that pixel alone,
/// so the split into rows cannot change a single value.
pub fn apply_to_rgba(img: &mut RgbaImage, lut: &Lut3d) {
    use rayon::prelude::*;

    let width = img.width() as usize;
    img.as_mut().par_chunks_mut(width * 4).for_each(|row| {
        for px in row.as_chunks_mut::<4>().0 {
            let [r, g, b] = lut.apply_rgb8([px[0], px[1], px[2]]);
            px[0] = r;
            px[1] = g;
            px[2] = b;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gpu_or_skip(what: &str) -> bool {
        if render_core::init_gpu_context().is_err() {
            eprintln!("skip: no GPU adapter available for {what}");
            return false;
        }
        true
    }

    /// The bake's contract with `Lut3d`: an EMPTY grade must come back as the
    /// identity lattice, or every ungraded clip in the Edit tab would pick up a
    /// LUT and shift colour for no reason.
    #[test]
    fn an_empty_grade_bakes_to_the_identity() {
        if !gpu_or_skip("an_empty_grade_bakes_to_the_identity") {
            return;
        }
        let baked = bake_lut3d(&json!({}), DEFAULT_SIZE, true).expect("bake");
        assert!(
            baked.lut.is_identity(IDENTITY_TOL),
            "an empty grade did not bake to the identity"
        );
        assert!(baked.warnings.is_empty());
    }

    /// A real grade must bake to a lattice that provably moves pixels — and in
    /// the direction the adjustment names.
    #[test]
    fn a_real_grade_bakes_to_a_lattice_that_moves_pixels() {
        if !gpu_or_skip("a_real_grade_bakes_to_a_lattice_that_moves_pixels") {
            return;
        }
        let baked = bake_lut3d(&json!({ "exposure": 1.5 }), DEFAULT_SIZE, true).expect("bake");
        assert!(
            !baked.lut.is_identity(IDENTITY_TOL),
            "+1.5 EV baked to a no-op"
        );
        let mid = baked.lut.apply_rgb8([128, 128, 128]);
        assert!(
            mid[0] > 150 && mid[1] > 150 && mid[2] > 150,
            "+1.5 EV should brighten mid grey, got {mid:?}"
        );
    }

    /// CLAUDE.md's render-path invariant at the bake's own level.
    #[test]
    fn baking_the_same_grade_twice_gives_the_same_lattice() {
        if !gpu_or_skip("baking_the_same_grade_twice_gives_the_same_lattice") {
            return;
        }
        let js = json!({ "exposure": 0.6, "contrast": 25.0, "saturation": -15.0 });
        let a = bake_lut3d(&js, DEFAULT_SIZE, true).expect("bake a");
        let b = bake_lut3d(&js, DEFAULT_SIZE, true).expect("bake b");
        assert_eq!(
            a.lut, b.lut,
            "the same grade baked to two different lattices"
        );
    }

    /// The spatial half of a grade is dropped LOUDLY, never silently.
    #[test]
    fn masked_and_cropped_grades_warn_about_what_they_dropped() {
        if !gpu_or_skip("masked_and_cropped_grades_warn_about_what_they_dropped") {
            return;
        }
        let js = json!({
            "exposure": 0.2,
            "masks": [{ "visible": true, "adjustments": { "exposure": 2.0 } }],
            "crop": { "x": 0.0, "y": 0.0, "width": 10.0, "height": 10.0 },
        });
        let baked = bake_lut3d(&js, DEFAULT_SIZE, true).expect("bake");
        assert!(
            baked.warnings.iter().any(|w| w.contains("masked/local")),
            "no mask warning: {:?}",
            baked.warnings
        );
        assert!(
            baked.warnings.iter().any(|w| w.contains("crop")),
            "no crop warning: {:?}",
            baked.warnings
        );
        // and the crop did NOT reach the lattice geometry
        assert_eq!(baked.lut.size(), DEFAULT_SIZE);
    }

    /// `apply_to_rgba` leaves alpha alone (the compositor owns it) and really
    /// does change colour.
    #[test]
    fn apply_to_rgba_changes_colour_and_preserves_alpha() {
        // "half the red", built by hand — no GPU needed for this one.
        let n = 5usize;
        let mut data = vec![0.0f32; 3 * n * n * n];
        for b in 0..n {
            for g in 0..n {
                for r in 0..n {
                    let i = ((b * n + g) * n + r) * 3;
                    data[i] = (r as f32 / 4.0) * 0.5;
                    data[i + 1] = g as f32 / 4.0;
                    data[i + 2] = b as f32 / 4.0;
                }
            }
        }
        let lut = Lut3d::new(5, data).unwrap();
        let mut img = RgbaImage::from_pixel(4, 4, image::Rgba([200, 100, 50, 128]));
        apply_to_rgba(&mut img, &lut);
        let px = img.get_pixel(0, 0);
        assert_eq!(px[0], 100, "red should halve");
        assert_eq!(px[1], 100);
        assert_eq!(px[2], 50);
        assert_eq!(px[3], 128, "alpha must be untouched");
    }

    /// **The preview has to stay snappy** (CLAUDE.md: performance first).
    ///
    /// Applying the lattice is the one genuinely new per-frame cost D-256 adds
    /// to the Edit preview, and it is per PIXEL, so it needs a real number
    /// rather than a shrug. 960×540 is `PreviewPane`'s scrubbing decode size —
    /// the largest frame this path sees — and the budget is a small fraction of
    /// a 24 fps frame's 41 ms, next to a decode that costs tens of ms on its
    /// own.
    ///
    /// Note this cost is paid ONLY by a clip that actually carries a grade;
    /// `lut_for_clip` returns `None` for every other clip before any pixel is
    /// touched.
    ///
    /// Measured here at **3 ms** (parallel). The budget is set well above that
    /// rather than at it, so a slower machine does not fail the suite — but far
    /// enough below the **22 ms** the serial loop measured that losing the
    /// parallel walk (see [`apply_to_rgba`]) trips this test instead of
    /// quietly reaching the user as a stuttering preview.
    #[test]
    fn applying_a_lattice_to_a_preview_frame_stays_inside_the_budget() {
        if !gpu_or_skip("applying_a_lattice_to_a_preview_frame_stays_inside_the_budget") {
            return;
        }
        const BUDGET_MS: u128 = 15;
        let baked = bake_lut3d(
            &json!({ "exposure": 0.8, "contrast": 20.0 }),
            DEFAULT_SIZE,
            true,
        )
        .expect("bake");
        let mut img = RgbaImage::from_fn(960, 540, |x, y| {
            image::Rgba([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8, 255])
        });
        let start = std::time::Instant::now();
        apply_to_rgba(&mut img, &baked.lut);
        let ms = start.elapsed().as_millis();
        eprintln!("grade LUT over a 960x540 preview frame: {ms} ms");
        assert!(
            ms < BUDGET_MS,
            "{ms} ms to apply a {DEFAULT_SIZE}³ LUT to one 960x540 frame exceeds \
             the {BUDGET_MS} ms budget — the preview would visibly stutter on a graded clip"
        );
    }

    #[test]
    fn grade_file_path_is_the_d070_clip_keyed_name() {
        let p = grade_file_for(Path::new("/tmp/My.chroma"), "clip-abc");
        assert_eq!(
            p,
            PathBuf::from("/tmp/My.chroma/grades/clip-abc.grade.json")
        );
    }
}
