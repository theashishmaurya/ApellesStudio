//! **`Lut3d` — a baked 3D colour lookup table** (D-256): the one portable,
//! deterministic representation of a *global* colour transform that every
//! engine in this workspace can run identically.
//!
//! **What it is:** a `size³` RGB lattice plus the pure maths to sample it
//! (trilinear), to recognise it as a no-op, and to serialise it as an Iridas
//! `.cube` file. Nothing else.
//!
//! **What it does NOT do:** it never bakes itself. Producing the lattice is a
//! *renderer's* job — for Apelles that is the Colorist's own wgpu pipeline,
//! driven through an identity lattice by `chroma::grade_lut` in `app/src-tauri`
//! — and this crate has no GPU, no filesystem and no `image` dependency by
//! design (D-039's L0 rule). It also never parses a `.cube`; the app's
//! `lut_processing::parse_lut_file` already owns that direction, for the GPU
//! upload path, and duplicating it here would be a second parser to keep in
//! step for no consumer.
//!
//! ## Why this type exists (D-256)
//!
//! [`crate::adjustment`]'s own header states the problem this solves, and
//! states it as structural: the Colorist's `adjustments` blob is untyped in
//! Rust and is applied only by RapidRAW's wgpu shader, so "there is no CPU
//! implementation of it anywhere in the workspace" and "the ffmpeg export
//! compiler could not reproduce a wgpu shader at all." That is why D-230's
//! adjustment clip invented a small five-parameter correction of its own
//! instead of reaching for the real grade.
//!
//! A baked lattice dissolves that argument without weakening it. The shader
//! stays the **only** implementation of the grade maths — it is what renders
//! the lattice — and what crosses the engine boundary afterwards is not code
//! but 3×`size³` numbers, which a CPU compositor can interpolate and ffmpeg's
//! own `lut3d` filter can apply natively. Preview and export therefore agree
//! by construction (same lattice, same interpolation mode) rather than by two
//! implementations of one shader happening to match.
//!
//! **The limit is honest and inherent:** a 3D LUT is a pure per-pixel
//! `RGB → RGB` function, so it carries the *global* grade only. Anything
//! spatial — masks, local adjustments, crop, rotation, relight — is not
//! representable and is not silently approximated; the baker strips those and
//! reports them as warnings. See D-256.
//!
//! ## Layout
//!
//! `data` is `3 * size³` floats, red varying fastest, then green, then blue —
//! `((b * size + g) * size + r) * 3` — which is exactly the `.cube` file
//! ordering, so [`Lut3d::to_cube_text`] is a linear walk and no re-indexing
//! step can disagree with the format.

use serde::{Deserialize, Serialize};

/// Smallest lattice edge that is still a lattice (the RGB cube's corners).
pub const MIN_SIZE: u32 = 2;
/// Largest lattice edge accepted. 64 is the `.cube` format's own common upper
/// bound and matches the clamp the app's existing bake already applied.
pub const MAX_SIZE: u32 = 64;
/// The lattice edge Apelles bakes at. 33 is the industry-default `.cube` size
/// (Resolve, Baselight and ffmpeg's own generators all default here): ~36k
/// lattice points, small enough to bake and cache freely, dense enough that
/// trilinear error against a direct shader evaluation is below 8-bit
/// quantisation for a well-behaved primary grade.
pub const DEFAULT_SIZE: u32 = 33;

/// A baked `size³` RGB lookup table. See the module doc.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Lut3d {
    size: u32,
    /// `3 * size³` values in `0.0..=1.0`, red fastest. Private so the size /
    /// length invariant established by [`Lut3d::new`] cannot be broken after
    /// construction — every sampler below indexes without bounds arithmetic.
    data: Vec<f32>,
}

impl Lut3d {
    /// Build a lattice from `size` and `3 * size³` values, red varying fastest.
    ///
    /// Rejects a size outside [`MIN_SIZE`]..=[`MAX_SIZE`] and a `data` length
    /// that does not match, because every sampler here indexes on the strength
    /// of that invariant. Values are clamped to `0.0..=1.0` rather than
    /// rejected: a renderer that hands back `1.0000001` on a corner is not an
    /// error, and a NaN (which no comparison would catch) becomes `0.0` here
    /// rather than poisoning an interpolation later.
    pub fn new(size: u32, data: Vec<f32>) -> Result<Self, String> {
        if !(MIN_SIZE..=MAX_SIZE).contains(&size) {
            return Err(format!("lut size {size} outside {MIN_SIZE}..={MAX_SIZE}"));
        }
        let want = 3 * (size as usize).pow(3);
        if data.len() != want {
            return Err(format!(
                "lut size {size} needs {want} values, got {}",
                data.len()
            ));
        }
        let data = data
            .into_iter()
            .map(|v| if v.is_nan() { 0.0 } else { v.clamp(0.0, 1.0) })
            .collect();
        Ok(Self { size, data })
    }

    /// The identity lattice of edge `size` — the transform that leaves every
    /// colour alone. Used as the baker's input and as the reference
    /// [`Lut3d::is_identity`] measures against.
    pub fn identity(size: u32) -> Result<Self, String> {
        if !(MIN_SIZE..=MAX_SIZE).contains(&size) {
            return Err(format!("lut size {size} outside {MIN_SIZE}..={MAX_SIZE}"));
        }
        let n = size as usize;
        let denom = (size - 1) as f32;
        let mut data = Vec::with_capacity(3 * n * n * n);
        for b in 0..n {
            for g in 0..n {
                for r in 0..n {
                    data.push(r as f32 / denom);
                    data.push(g as f32 / denom);
                    data.push(b as f32 / denom);
                }
            }
        }
        Self::new(size, data)
    }

    /// Lattice edge length.
    pub fn size(&self) -> u32 {
        self.size
    }

    /// The raw lattice, red varying fastest. See the module doc's layout note.
    pub fn data(&self) -> &[f32] {
        &self.data
    }

    /// Does this lattice provably leave every colour alone, to within `tol`?
    ///
    /// **Why a tolerance rather than an equality test.** The lattice comes back
    /// from a GPU render that quantises to 8 bits, so an identity grade's
    /// round trip is `round(i / (size-1) * 255) / 255`, not `i / (size-1)`
    /// exactly. [`IDENTITY_TOL`] is that quantisation step with a little room,
    /// so "the user has a grade file but has not actually graded anything"
    /// resolves to *no LUT at all* and the frame stays byte-identical to an
    /// ungraded one — the same "an untouched effect emits nothing" property
    /// D-230's adjustment clip already has in both engines.
    pub fn is_identity(&self, tol: f32) -> bool {
        let n = self.size as usize;
        let denom = (self.size - 1) as f32;
        for b in 0..n {
            for g in 0..n {
                for r in 0..n {
                    let i = ((b * n + g) * n + r) * 3;
                    let want = [r as f32 / denom, g as f32 / denom, b as f32 / denom];
                    for (c, w) in want.iter().enumerate() {
                        if (self.data[i + c] - w).abs() > tol {
                            return false;
                        }
                    }
                }
            }
        }
        true
    }

    /// Sample the lattice at normalised `rgb` with **trilinear** interpolation.
    ///
    /// Trilinear specifically, and not the arguably-better tetrahedral, because
    /// the other engine that has to agree with this one is ffmpeg's `lut3d`
    /// filter — whose `interp` option offers both, and whose *trilinear* mode
    /// is defined identically to this function. Matching the export exactly
    /// beats being marginally more accurate than it (D-256); the exporter
    /// therefore passes `interp=trilinear` explicitly rather than taking
    /// ffmpeg's tetrahedral default.
    ///
    /// Inputs outside `0.0..=1.0` (and NaN) are clamped into the cube rather
    /// than extrapolated — a 3D LUT's domain *is* the unit cube.
    #[inline]
    pub fn sample_trilinear(&self, rgb: [f32; 3]) -> [f32; 3] {
        let n = self.size as usize;
        let last = n - 1;
        let scale = last as f32;

        let mut lo = [0usize; 3];
        let mut hi = [0usize; 3];
        let mut frac = [0f32; 3];
        for c in 0..3 {
            let v = if rgb[c].is_nan() {
                0.0
            } else {
                rgb[c].clamp(0.0, 1.0)
            } * scale;
            let f = v.floor();
            let i = (f as usize).min(last);
            lo[c] = i;
            hi[c] = (i + 1).min(last);
            frac[c] = v - f;
        }

        // Corner fetch, red fastest — the module doc's layout, written once.
        let at = |r: usize, g: usize, b: usize| -> [f32; 3] {
            let i = ((b * n + g) * n + r) * 3;
            [self.data[i], self.data[i + 1], self.data[i + 2]]
        };
        let lerp = |a: [f32; 3], b: [f32; 3], t: f32| -> [f32; 3] {
            [
                a[0] + (b[0] - a[0]) * t,
                a[1] + (b[1] - a[1]) * t,
                a[2] + (b[2] - a[2]) * t,
            ]
        };

        let c00 = lerp(at(lo[0], lo[1], lo[2]), at(hi[0], lo[1], lo[2]), frac[0]);
        let c01 = lerp(at(lo[0], lo[1], hi[2]), at(hi[0], lo[1], hi[2]), frac[0]);
        let c10 = lerp(at(lo[0], hi[1], lo[2]), at(hi[0], hi[1], lo[2]), frac[0]);
        let c11 = lerp(at(lo[0], hi[1], hi[2]), at(hi[0], hi[1], hi[2]), frac[0]);
        let c0 = lerp(c00, c10, frac[1]);
        let c1 = lerp(c01, c11, frac[1]);
        lerp(c0, c1, frac[2])
    }

    /// Sample for an 8-bit pixel — the form the CPU compositor actually holds.
    ///
    /// `round` on the way out, mirroring [`crate::adjustment::AdjustmentOps::
    /// apply_rgb8`]'s own final quantisation, so the two CPU colour operators
    /// in this workspace round the same way.
    #[inline]
    pub fn apply_rgb8(&self, rgb: [u8; 3]) -> [u8; 3] {
        let out = self.sample_trilinear([
            rgb[0] as f32 / 255.0,
            rgb[1] as f32 / 255.0,
            rgb[2] as f32 / 255.0,
        ]);
        [
            (out[0].clamp(0.0, 1.0) * 255.0).round() as u8,
            (out[1].clamp(0.0, 1.0) * 255.0).round() as u8,
            (out[2].clamp(0.0, 1.0) * 255.0).round() as u8,
        ]
    }

    /// Serialise as an Iridas `.cube` file body — what ffmpeg's `lut3d` filter
    /// reads, and what the Colorist's own "bake a `.cube`" export writes.
    ///
    /// Six decimal places, `DOMAIN_MIN`/`DOMAIN_MAX` stated explicitly and the
    /// lattice written red-fastest: byte-for-byte the format
    /// `chroma::export::bake_primary_lut` emitted before D-256 factored the
    /// writer to here, so an existing baked `.cube` and a new one are the same
    /// file.
    pub fn to_cube_text(&self, title: &str) -> String {
        let n = self.size as usize;
        let mut out = String::with_capacity(n * n * n * 24 + 128);
        out.push_str(&format!("TITLE \"{}\"\n", title.replace('"', "'")));
        out.push_str(&format!("LUT_3D_SIZE {}\n", self.size));
        out.push_str("DOMAIN_MIN 0.0 0.0 0.0\n");
        out.push_str("DOMAIN_MAX 1.0 1.0 1.0\n");
        for triple in self.data.as_chunks::<3>().0 {
            out.push_str(&format!(
                "{:.6} {:.6} {:.6}\n",
                triple[0], triple[1], triple[2]
            ));
        }
        out
    }
}

/// The tolerance [`Lut3d::is_identity`] uses by default: one 8-bit step
/// (`1/255`) plus half again, since the lattice round-trips through an 8-bit
/// GPU render. See that method's own doc.
pub const IDENTITY_TOL: f32 = 1.5 / 255.0;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_lattice_is_identity() {
        let lut = Lut3d::identity(DEFAULT_SIZE).unwrap();
        assert!(lut.is_identity(IDENTITY_TOL));
        assert_eq!(lut.data().len(), 3 * 33 * 33 * 33);
    }

    #[test]
    fn identity_sampling_round_trips_every_8bit_value() {
        // The property that makes "no grade ⇒ no visible change" true, checked
        // exhaustively over the whole 8-bit input domain on one axis.
        let lut = Lut3d::identity(DEFAULT_SIZE).unwrap();
        for v in 0u16..=255 {
            let v = v as u8;
            assert_eq!(lut.apply_rgb8([v, v, v]), [v, v, v], "grey {v}");
        }
    }

    #[test]
    fn samples_lattice_points_exactly() {
        // At a lattice point the interpolation weights are 0/1, so the sample
        // must be the stored value with no interpolation error at all.
        let n = 5usize;
        let mut data = vec![0.0f32; 3 * n * n * n];
        for b in 0..n {
            for g in 0..n {
                for r in 0..n {
                    let i = ((b * n + g) * n + r) * 3;
                    // an arbitrary but deterministic non-identity mapping
                    data[i] = (r as f32 / 4.0).powf(2.0);
                    data[i + 1] = 1.0 - g as f32 / 4.0;
                    data[i + 2] = (b as f32 / 4.0) * 0.5;
                }
            }
        }
        let lut = Lut3d::new(5, data).unwrap();
        for b in 0..n {
            for g in 0..n {
                for r in 0..n {
                    let got =
                        lut.sample_trilinear([r as f32 / 4.0, g as f32 / 4.0, b as f32 / 4.0]);
                    let want = [
                        (r as f32 / 4.0).powf(2.0),
                        1.0 - g as f32 / 4.0,
                        (b as f32 / 4.0) * 0.5,
                    ];
                    for c in 0..3 {
                        assert!(
                            (got[c] - want[c]).abs() < 1e-6,
                            "({r},{g},{b}) ch{c}: {got:?} vs {want:?}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn interpolates_linearly_between_lattice_points() {
        // A lattice that is exactly 2× the identity on red: the midpoint
        // between two lattice points must be the midpoint of their values,
        // which is the whole definition of trilinear.
        let n = 2usize;
        let mut data = vec![0.0f32; 3 * n * n * n];
        for b in 0..n {
            for g in 0..n {
                for r in 0..n {
                    let i = ((b * n + g) * n + r) * 3;
                    data[i] = r as f32;
                    data[i + 1] = g as f32 * 0.25;
                    data[i + 2] = b as f32;
                }
            }
        }
        let lut = Lut3d::new(2, data).unwrap();
        let got = lut.sample_trilinear([0.5, 0.5, 0.5]);
        assert!((got[0] - 0.5).abs() < 1e-6, "{got:?}");
        assert!((got[1] - 0.125).abs() < 1e-6, "{got:?}");
        assert!((got[2] - 0.5).abs() < 1e-6, "{got:?}");
    }

    #[test]
    fn a_real_transform_is_not_identity_and_actually_moves_pixels() {
        // "Half the red" — a lattice a human would recognise as a grade.
        let n = 9usize;
        let mut data = vec![0.0f32; 3 * n * n * n];
        for b in 0..n {
            for g in 0..n {
                for r in 0..n {
                    let i = ((b * n + g) * n + r) * 3;
                    data[i] = (r as f32 / 8.0) * 0.5;
                    data[i + 1] = g as f32 / 8.0;
                    data[i + 2] = b as f32 / 8.0;
                }
            }
        }
        let lut = Lut3d::new(9, data).unwrap();
        assert!(!lut.is_identity(IDENTITY_TOL));
        assert_eq!(lut.apply_rgb8([200, 100, 50]), [100, 100, 50]);
    }

    #[test]
    fn clamps_out_of_range_and_nan_input_into_the_cube() {
        let lut = Lut3d::identity(DEFAULT_SIZE).unwrap();
        assert_eq!(lut.sample_trilinear([2.0, -1.0, f32::NAN]), [1.0, 0.0, 0.0]);
    }

    #[test]
    fn rejects_a_bad_size_or_length() {
        assert!(Lut3d::new(1, vec![0.0; 3]).is_err());
        assert!(Lut3d::new(65, vec![0.0; 3 * 65 * 65 * 65]).is_err());
        assert!(Lut3d::new(4, vec![0.0; 7]).is_err());
    }

    #[test]
    fn cube_text_is_the_iridas_shape_red_fastest() {
        let lut = Lut3d::identity(2).unwrap();
        let text = lut.to_cube_text("Apelles primary grade");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[0], "TITLE \"Apelles primary grade\"");
        assert_eq!(lines[1], "LUT_3D_SIZE 2");
        assert_eq!(lines[2], "DOMAIN_MIN 0.0 0.0 0.0");
        assert_eq!(lines[3], "DOMAIN_MAX 1.0 1.0 1.0");
        // red varies fastest: entry 0 is (0,0,0), entry 1 is (1,0,0)
        assert_eq!(lines[4], "0.000000 0.000000 0.000000");
        assert_eq!(lines[5], "1.000000 0.000000 0.000000");
        assert_eq!(lines.len(), 4 + 8);
    }

    #[test]
    fn sampling_is_deterministic() {
        // CLAUDE.md's render-path invariant, at this type's own level: the same
        // lattice and the same input must give bit-identical output every time.
        let lut = Lut3d::identity(DEFAULT_SIZE).unwrap();
        let probe = [0.137f32, 0.642, 0.911];
        let first = lut.sample_trilinear(probe);
        for _ in 0..64 {
            assert_eq!(lut.sample_trilinear(probe), first);
        }
    }
}
