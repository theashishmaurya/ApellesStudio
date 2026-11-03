//! **grade_lut.rs — a Colorist grade baked into a 3D LUT** (D-256, D-450).
//!
//! What it is: [`BakeSession::bake`] / [`bake_lut3d`] turn a grade document's
//! `adjustments` into a [`Lut3d`] by running an identity RGB lattice through
//! **the real Colorist wgpu pipeline**, and read the result back. That is the
//! Colorist's own "bake this grade to a `.cube`" export
//! (`chroma::export`), a file a person takes to another tool.
//!
//! What it is no longer (D-450): how a grade reaches the Edit tab or its
//! export. Those run the Colorist's shader per frame on the GPU render
//! engine's device (`chroma::grade_pass`), which carries everything the shader
//! does, so the lattice, its per-clip cache and the Export panel's pre-flight
//! that lived here are gone.
//!
//! What it does NOT do: no `.cube` parsing (the app's `lut_processing` owns
//! that direction), no lattice maths (that is `apelles_types::lut3d`, pure and
//! unit-tested there), no timeline knowledge.
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
//! each one it dropped. The grade's *global* part — exposure, contrast,
//! curves, colour wheels, HSL, an applied `.cube`, everything the primary
//! panel does — is carried exactly.
//!
//! ## Determinism (CLAUDE.md's render-path invariant)
//!
//! Same grade document ⇒ same lattice. The bake reads only the grade JSON.

use std::sync::Arc;

use apelles_types::Lut3d;
use image::{DynamicImage, RgbImage};
use serde_json::{Value, json};

use crate::gpu_processing::RenderRequest;
use crate::image_processing::{GpuContext, get_all_adjustments_from_json};
use crate::render_core::{self, OwnedRenderCaches};

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

#[cfg(test)]
mod tests {
    use super::*;
    use apelles_types::lut3d::{DEFAULT_SIZE, IDENTITY_TOL};

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
}
