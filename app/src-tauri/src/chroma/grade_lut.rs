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
//! that direction), no lattice maths (that is `apelles_types::lut3d`, pure and
//! unit-tested there), no timeline knowledge, no filtergraph knowledge. It does
//! **not** carry the spatial half of a grade — see "What a LUT cannot carry"
//! below; that is a documented, warned-about limit, not an oversight.
//!
//! ## Why a baked lattice, and not the shader itself (D-256)
//!
//! `apelles_types::adjustment`'s header states the obstacle this module removes,
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
//! compositor is 3×33³ numbers, interpolated per pixel
//! (`apelles_types::Lut3d::sample_trilinear`). The Edit preview and the export
//! are drawn by that one compositor (D-448), so they agree *by construction*.
//! (Until D-448 an ffmpeg filter-graph export read the same lattice as a
//! `.cube` through `lut3d`; that path is gone.)
//!
//! ## What a LUT cannot carry
//!
//! A 3D LUT is a pure per-pixel `RGB → RGB` function. Everything **spatial** in
//! a grade is outside that by definition: mask layers / local adjustments,
//! crop, rotation/flips, depth-driven relight, and (B-381) every effect that
//! reads a pixel's neighbours or its place in the frame ([`SPATIAL_EFFECTS`]:
//! sharpening, clarity, vignette, grain …). [`bake_lut3d`] strips those
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

use apelles_types::Lut3d;
use apelles_types::lut3d::{DEFAULT_SIZE, IDENTITY_TOL};
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

/// B-381 — the grade's adjustments (by `grade.json` key, with the Colorist
/// panel's own name for the warning) that depend on a pixel's neighbours or its
/// position in the frame, and so cannot be part of a per-pixel 3D LUT. Every
/// other adjustment the primary panel offers is a per-pixel colour function and
/// is baked exactly. `lensBlurEnabled` is a toggle; the rest are amounts whose
/// neutral value is 0.
const SPATIAL_EFFECTS: &[(&str, &str)] = &[
    ("sharpness", "sharpening"),
    ("clarity", "clarity"),
    ("structure", "structure"),
    ("dehaze", "dehaze"),
    ("centré", "centre"),
    ("lumaNoiseReduction", "luma noise reduction"),
    ("colorNoiseReduction", "colour noise reduction"),
    ("vignetteAmount", "vignette"),
    ("grainAmount", "grain"),
    ("chromaticAberrationRedCyan", "chromatic aberration"),
    ("chromaticAberrationBlueYellow", "chromatic aberration"),
    ("glowAmount", "glow"),
    ("halationAmount", "halation"),
    ("flareAmount", "flare"),
    ("lensBlurEnabled", "lens blur"),
];

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
        let size = size.clamp(
            apelles_types::lut3d::MIN_SIZE,
            apelles_types::lut3d::MAX_SIZE,
        );
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
                    "its Colorist grade has {visible} mask layer(s); the Edit tab and the export apply the clip's overall grade only, not the masked adjustments"
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
                "its Colorist grade has a crop; the Edit tab and the export frame the clip with its own crop instead"
                    .into(),
            );
        }
        for k in ["masks", "lutPath", "crop"] {
            if let Some(obj) = primary.as_object_mut() {
                obj.remove(k);
            }
        }
        // B-381 — the neighbourhood and position effects. Each of these reads
        // a pixel's neighbours or its place in the frame, so run over the
        // lattice image they would bake its layout into the colours (a
        // vignette darkening the lattice's edge entries, grain adding noise to
        // single entries). They are zeroed for the bake and named, never
        // baked wrongly or dropped silently.
        let spatial: Vec<&str> = SPATIAL_EFFECTS
            .iter()
            .filter(|(key, _)| {
                primary.get(*key).is_some_and(|v| {
                    v.as_f64().is_some_and(|n| n.abs() > f64::EPSILON) || v.as_bool() == Some(true)
                })
            })
            .map(|(_, label)| *label)
            .collect();
        if let Some(w) = local_tone_warning(&primary) {
            warnings.push(w);
        }
        if !spatial.is_empty() {
            warnings.push(format!(
                "its Colorist grade uses {}; these work on neighbouring pixels or the frame position, so the Edit tab and the export show the grade without them",
                spatial.join(", ")
            ));
            if let Some(obj) = primary.as_object_mut() {
                for (key, _) in SPATIAL_EFFECTS {
                    if let Some(v) = obj.get_mut(*key) {
                        *v = if v.is_boolean() {
                            json!(false)
                        } else {
                            json!(0)
                        };
                    }
                }
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

/// B-381 — contrast, shadows, highlights, whites and blacks are LOCAL tone
/// operators in the grade shader: each reads a blur of the pixel's
/// neighbourhood (`tonal_blur_texture`). A 3D LUT carries their response on a
/// flat area of each colour exactly (`the_lattice_matches_the_grade_shader_on_
/// flat_colour`), but not the part that depends on the detail around a pixel,
/// so on textured footage the Edit tab and the export differ from the
/// Colorist. They stay in the bake (dropping them would be further from the
/// Colorist, not nearer); the warning says what is approximated.
fn local_tone_warning(adjustments: &Value) -> Option<String> {
    const LOCAL_TONE: [(&str, &str); 5] = [
        ("contrast", "contrast"),
        ("shadows", "shadows"),
        ("highlights", "highlights"),
        ("whites", "whites"),
        ("blacks", "blacks"),
    ];
    let used: Vec<&str> = LOCAL_TONE
        .iter()
        .filter(|(k, _)| {
            adjustments
                .get(*k)
                .and_then(Value::as_f64)
                .is_some_and(|v| v.abs() > f64::EPSILON)
        })
        .map(|(_, label)| *label)
        .collect();
    (!used.is_empty()).then(|| {
        format!(
            "its Colorist grade uses {}, which the Colorist applies with local detail; the Edit tab and the export apply their flat-area response, so textured areas can look a little different",
            used.join(", ")
        )
    })
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
    apelles_project::grade_dir(project_dir).join(format!("{clip_id}.grade.json"))
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
/// `session` lets a batch caller (the export's [`check_clip_grades`]) share
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
/// `apelles_grade_model::load_grade`, the same loader the Colorist itself uses,
/// so schema migration happens exactly once in exactly one place.
pub fn bake_clip_grade(
    grade_path: &Path,
    size: u32,
    session: Option<&BakeSession>,
) -> Result<BakedGrade, String> {
    let grade = apelles_grade_model::load_grade(&grade_path.to_string_lossy())?;
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
// the export side: every graded clip baked, and what a LUT cannot carry named
// --------------------------------------------------------------------------- //

/// What [`check_clip_grades`] hands the frontend.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GradeCheck {
    /// The clips that have a real, non-identity grade — the ones the
    /// compositor will grade. A clip absent from this list has nothing to
    /// apply, which is exactly what the preview does for it too.
    pub graded: Vec<String>,
    /// Everything baking had to leave out (masks, a Colorist crop, the spatial
    /// effects), already prefixed with the clip — shown in the Export panel
    /// before the export runs, because these are the cases where the file
    /// legitimately will NOT match the Colorist tab and the user has to know.
    pub warnings: Vec<String>,
}

/// Bake every graded clip in `clip_ids` into the process-wide lattice cache
/// the compositor reads ([`resolve_clip_lut`]), and report what each grade
/// could not carry — the export's pre-flight (D-256; D-448 dropped the `.cube`
/// files the deleted ffmpeg filter path read).
///
/// **One [`BakeSession`] for the whole batch**: `init_gpu_context` is the
/// expensive part of a bake, and a 30-clip timeline must not mean 30 GPU
/// devices.
///
/// Errors rather than skipping. A clip that HAS a grade whose bake failed comes
/// back as `Err`, so the export is refused instead of shipping a file that
/// silently disagrees with the preview; the render checks again before it
/// draws ([`super::edit_render`]'s grade pre-flight), for a grade edited while
/// the job waited in the queue.
pub fn check_clip_grades(clip_ids: &[String]) -> Result<GradeCheck, String> {
    let Some(project) = state::current_project() else {
        return Ok(GradeCheck {
            graded: Vec::new(),
            warnings: Vec::new(),
        });
    };
    // Nothing to do at all unless at least one clip actually has a grade file —
    // the common case, and worth not creating a GPU device for.
    let with_file: Vec<&String> = clip_ids
        .iter()
        .filter(|id| grade_file_for(&project.path, id).is_file())
        .collect();
    // Built lazily: every clip may already be memoised from the preview, in
    // which case this whole call touches no GPU at all.
    let mut session: Option<BakeSession> = None;
    let mut graded = Vec::new();
    let mut warnings = Vec::new();
    for clip_id in with_file {
        if session.is_none() && !is_memoised(&project.path, clip_id) {
            session = Some(BakeSession::new()?);
        }
        let grade = resolve_clip_lut(clip_id, session.as_ref())
            .map_err(|e| format!("clip {clip_id}: {e}"))?;
        warnings.extend(
            grade
                .warnings
                .iter()
                .map(|w| format!("clip {clip_id}: {w}")),
        );
        if grade.lut.is_some() {
            graded.push(clip_id.clone());
        }
    }
    Ok(GradeCheck { graded, warnings })
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

/// Bake the grades an Edit-tab export draws, for the clips the caller names,
/// and report what they cannot carry. See [`check_clip_grades`].
///
/// Off the Tauri main thread (`spawn_blocking`) for `chroma_timeline_frame`'s
/// reason — a cold batch is real GPU work and the window's event loop must not
/// wait on it.
#[tauri::command]
pub async fn chroma_timeline_grade_luts(clip_ids: Vec<String>) -> Result<GradeCheck, String> {
    tokio::task::spawn_blocking(move || check_clip_grades(&clip_ids))
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
/// here rather than in `apelles-types` so that L0 crate keeps its zero-heavy-deps
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

    /// B-381 — the lattice IS the shader on a flat area. Contrast, shadows,
    /// highlights, whites and blacks read a blur of the neighbourhood; on a
    /// flat patch of one colour that blur is the colour itself, so the shader's
    /// answer there is exactly what a per-pixel LUT has to reproduce. (On
    /// textured footage the Colorist's answer also depends on the detail
    /// around each pixel, which no LUT can carry — the warning
    /// `local_tone_warning` names.)
    #[test]
    fn the_lattice_matches_the_grade_shader_on_flat_colour() {
        if !gpu_or_skip("the_lattice_matches_the_grade_shader_on_flat_colour") {
            return;
        }
        let grade = json!({
            "exposure": 0.35, "contrast": 18, "saturation": 22, "temperature": 12,
            "highlights": -25, "shadows": 15, "whites": 10, "blacks": -10,
        });
        let session = BakeSession::new().expect("gpu");
        let baked = session.bake(&grade, DEFAULT_SIZE, true).expect("bake");
        let adjustments = get_all_adjustments_from_json(&grade, false, None);
        let mut worst = 0i32;
        for (i, c) in [
            [30u8, 40, 50],
            [128, 100, 80],
            [200, 190, 170],
            [90, 160, 60],
        ]
        .into_iter()
        .enumerate()
        {
            let patch = RgbImage::from_pixel(64, 64, image::Rgb(c));
            let shaded = render_core::render(
                &session.ctx,
                session.caches.as_ref(),
                &DynamicImage::ImageRgb8(patch),
                (i + 1) as u64,
                RenderRequest {
                    adjustments,
                    mask_bitmaps: &[],
                    lut: None,
                    roi: None,
                },
                BAKE_CALLER,
                false,
                None,
            )
            .expect("render")
            .to_rgb8();
            let want = shaded.get_pixel(32, 32).0;
            let got = baked.lut.apply_rgb8(c);
            for ch in 0..3 {
                worst = worst.max((i32::from(want[ch]) - i32::from(got[ch])).abs());
            }
        }
        // The lattice's own trilinear interpolation between 33 entries.
        assert!(
            worst <= 3,
            "the baked LUT is {worst} codes from the shader on flat colour"
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
            baked.warnings.iter().any(|w| w.contains("mask layer")),
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

    /// B-381 — a vignette and grain are named and left out of the lattice,
    /// which comes out exactly as the same grade without them: the lattice
    /// image's layout must not leak into the colours.
    #[test]
    fn spatial_effects_are_named_and_kept_out_of_the_lattice() {
        if !gpu_or_skip("spatial_effects_are_named_and_kept_out_of_the_lattice") {
            return;
        }
        let plain = json!({ "exposure": 0.3, "contrast": 15 });
        let with =
            json!({ "exposure": 0.3, "contrast": 15, "vignetteAmount": -60, "grainAmount": 40 });
        let a = bake_lut3d(&plain, DEFAULT_SIZE, true).expect("bake");
        let b = bake_lut3d(&with, DEFAULT_SIZE, true).expect("bake");
        let w = b.warnings.join(" ");
        assert!(w.contains("vignette") && w.contains("grain"), "{w}");
        assert!(
            !a.warnings.iter().any(|w| w.contains("vignette")),
            "{:?}",
            a.warnings
        );
        assert_eq!(a.lut.data(), b.lut.data());
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
