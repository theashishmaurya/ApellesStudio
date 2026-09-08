//! **Adjustment layers** — the five-parameter primary correction an
//! *adjustment clip* carries, and the colour operator behind it (D-230).
//!
//! **What it is:** [`AdjustmentLayer`] (the stored shape of
//! `chroma_timeline::Clip::adjustment`) plus the pure maths that turns those
//! five numbers into the two-stage operator [`AdjustmentOps`], which is *the*
//! definition of what an adjustment clip does to a picture.
//!
//! **What it does NOT do:** it never touches a pixel buffer, a canvas, a track
//! or a timeline. It answers "what operator does this layer mean", and the two
//! consumers that own pixels apply it: `chroma::edit`'s live-preview compositor
//! (`app/src-tauri`) per pixel, and `@chroma/editor`'s ffmpeg export compiler as
//! two filter nodes. Same one-model/two-consumers shape [`crate::fade`],
//! [`crate::pan`] and [`crate::eq`] already have, and it lives in L0 for their
//! reason: the operator is a property of the *values*, not of the timeline, so
//! a future L1 compositor crate can reach it without depending on L2's `Clip`.
//!
//! ## Why this is not the Colorist grade (D-230)
//!
//! The obvious "effect" for an adjustment clip would be Chroma's real grading
//! stack. It cannot be, and the reason is structural rather than a matter of
//! effort: the Colorist's `adjustments` blob is **deliberately untyped in Rust**
//! (D-020/D-025 — "the canonical shape is owned by the frontend
//! `useEditorStore` and a typed Rust mirror would just drift") and is applied
//! only by RapidRAW's **wgpu shader**. There is no CPU implementation of it
//! anywhere in the workspace, and the Edit tab's preview compositor is
//! explicitly GPU-free (`chroma::edit`'s own header: "no `wgpu`, no colour
//! grade"). Worse, the ffmpeg export compiler could not reproduce a wgpu shader
//! at all — which would have made every adjustment clip a guaranteed
//! preview-vs-export divergence, exactly the B-090/B-095/B-098 class of defect
//! this repo has fixed three times already.
//!
//! So the effect is a small primary correction that **both** engines can run
//! *identically*, named in the Colorist's own vocabulary (`exposure`,
//! `contrast`, `saturation`, `temperature`, `tint`) so nothing here reads as a
//! second, parallel effects language. See D-230 for the options weighed.
//!
//! **D-256 found the third option this reasoning had missed, and it does not
//! change anything above.** The paragraph before last is still exactly true —
//! there is still no CPU implementation of the grading stack, this compositor
//! still holds no GPU handle, and ffmpeg still cannot run a wgpu shader — but
//! the grade can nonetheless cross into both engines as **data**: a lattice
//! baked by running an identity RGB cube through that very shader, once
//! ([`crate::lut3d`]). That is how a *clip's own* Colorist grade now reaches
//! the Edit preview and the ffmpeg export identically.
//!
//! It is not a replacement for this module, because the two answer different
//! questions. A baked lattice is a fixed function of one clip's saved
//! `grade.json`; an **adjustment clip** is a live, keyframeable operator on
//! whatever happens to be composited *beneath it*, which no pre-baked table
//! can express — the layers under it change with the edit, and its `mix`
//! animates. Both exist, and the split is what each one is *for*, not an
//! accident of what was reachable. See D-256.
//!
//! ## The operator — two stages, and why exactly two
//!
//! Conceptually the correction is three steps, in this order:
//!
//! 1. **exposure + white balance**, as per-channel gains;
//! 2. **contrast**, as a scale about the 0.5 pivot;
//! 3. **saturation**, as a Rec.709 luma-weighted matrix.
//!
//! Steps 1 and 2 are both per-channel affine, so they fold into one:
//! `out = gain[c]·v + offset`. Step 3 is a pure 3×3 matrix. That leaves two
//! stages, and the split is not arbitrary — **it is the split ffmpeg can
//! execute**, which is the whole reason the export can match the preview:
//!
//! | stage | ffmpeg filter | why that one |
//! |---|---|---|
//! | 1 — per-channel affine | `lutrgb` | expression-based, so **no coefficient limit**, and it is a 256-entry LUT computed once at init rather than per pixel |
//! | 2 — saturation matrix | `colorchannelmixer` | a real 3×3 matrix filter, SIMD, and the matrix provably never leaves its ±2 range (see [`SAT_COEFF_MAX`]) |
//!
//! An earlier draft of this module folded all three steps into a **single**
//! matrix (a saturation matrix maps grey to itself, so the pivot offset
//! survives the fold), which is mathematically tidier and compiles to one
//! `colorchannelmixer`. It was rejected after its own corner-case test caught
//! the reason: `colorchannelmixer` caps every coefficient at ±2, and the folded
//! matrix blows past that at *ordinary* settings — contrast `0.6` with
//! saturation `0.8` already clamps, crushing mid-grey to `0.196` instead of
//! leaving it at `0.5`. Splitting the gain out into `lutrgb`, where there is no
//! cap, removes that ceiling entirely: the full documented range of all five
//! parameters is usable, and stage 2 alone can never reach the cap.
//!
//! Neither engine re-derives the steps — both consume the [`AdjustmentOps`]
//! this module builds — so neither can drift in step order, pivot, or luma
//! weights.
//!
//! ## Measured, not assumed
//!
//! Per this repo's own B-098 discipline ("checked empirically instead of
//! assumed"), every claim above was verified against real ffmpeg before any of
//! it was written (D-230 records the runs):
//!
//! - **8-bit rounding differs between the two filters.** `lutrgb` **truncates**
//!   (`val*0.5+20` at `val=3` gives `21`, not `22`); `colorchannelmixer`
//!   rounds. [`AdjustmentOps::apply_rgb8`] mirrors each one at its own stage —
//!   hence the `floor` in stage 1 and the `round` in stage 2, which look
//!   inconsistent and are not.
//! - **Reference vs. real ffmpeg**: ≤ **1/255** across 6 swatches × 4 parameter
//!   sets chosen at the corners of the space, including a gain of 5.2 the
//!   single-matrix design could not represent at all.
//! - **Speed**: the exact-but-general alternative `geq` is **~39× slower**
//!   (76.9 s vs 1.95 s for 6 s of 1080p30). That is what rules it out, despite
//!   it being the one filter that could run the whole operator verbatim.

use serde::{Deserialize, Serialize};

/// Rec.709 luma weights — the same primaries the rest of the app works in
/// (v1 is Rec709 throughout, `docs/02-scope.md`). Used only by the saturation
/// stage, which needs a grey axis to rotate colour about.
pub const LUMA_R: f64 = 0.2126;
pub const LUMA_G: f64 = 0.7152;
pub const LUMA_B: f64 = 0.0722;

/// The largest magnitude any stage-2 coefficient can reach, over the whole
/// documented parameter range — `s + (1-s)·LUMA_B` at `s = 2`, i.e. maximum
/// saturation on the blue diagonal.
///
/// It matters because ffmpeg's `colorchannelmixer` refuses a coefficient
/// outside ±2, and this is the proof that stage 2 never asks it to: **1.928 <
/// 2**, with no clamp anywhere in this module. `coefficients_never_reach_the_
/// ffmpeg_limit` is the test that keeps it true.
pub const SAT_COEFF_MAX: f64 = 2.0 - (2.0 - 1.0) * LUMA_B;

/// The ±2 headroom claim above, checked **at compile time** rather than by a
/// test — it is a statement about two constants, so it can be, and a build that
/// broke it should not compile rather than fail a test run. The runtime test
/// `coefficients_never_reach_the_ffmpeg_limit` covers the other half (that no
/// *built* matrix exceeds this bound across the parameter space).
const _: () = assert!(SAT_COEFF_MAX < 2.0);

/// How far `temperature` / `tint` at full deflection push their channels. A
/// gentle number on purpose: an adjustment clip sits over *everything* below
/// it, so its controls want a usable range across their whole travel rather
/// than a violent one at the ends.
const WB_STRENGTH: f64 = 0.3;

/// The five-parameter primary correction an adjustment clip applies to
/// everything composited beneath it (D-230).
///
/// Every field is `0.0` at identity, so a freshly-added adjustment clip is a
/// guaranteed no-op until the user (or an MCP call) moves something — the same
/// "adding it changes nothing until you say so" property Resolve's own
/// adjustment clip has.
///
/// Ranges are the *documented* ones each field's own comment gives;
/// [`AdjustmentLayer::normalised`] clamps to them, and every consumer resolves
/// through that rather than trusting stored values, matching the
/// "the model stores what the UI wrote and the consumer decides what it means"
/// rule `Clip::crop_left` and `Clip::opacity` already follow.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct AdjustmentLayer {
    /// Stops of exposure, `-1.0..=1.0`. Applied as a linear gain of
    /// `2^exposure`, so `+1` is one stop brighter and `-1` one stop darker.
    #[serde(default)]
    pub exposure: f64,
    /// Contrast about the 0.5 pivot, `-1.0..=1.0`. `-1` is fully flat (every
    /// pixel collapses to mid-grey), `+1` is double contrast.
    #[serde(default)]
    pub contrast: f64,
    /// Saturation, `-1.0..=1.0`. `-1` is fully desaturated (Rec.709 luma),
    /// `+1` is double saturation.
    #[serde(default)]
    pub saturation: f64,
    /// Warm/cool balance, `-1.0..=1.0`. Positive is **warmer** (red up, blue
    /// down); negative is cooler.
    #[serde(default)]
    pub temperature: f64,
    /// Green/magenta balance, `-1.0..=1.0`. Positive is **magenta** (green
    /// down); negative is greener.
    #[serde(default)]
    pub tint: f64,
}

impl Default for AdjustmentLayer {
    fn default() -> Self {
        Self::IDENTITY
    }
}

impl AdjustmentLayer {
    /// The do-nothing correction — what a newly added adjustment clip carries.
    pub const IDENTITY: Self = Self {
        exposure: 0.0,
        contrast: 0.0,
        saturation: 0.0,
        temperature: 0.0,
        tint: 0.0,
    };

    /// This layer with every field clamped to its documented range and any
    /// non-finite value (a `NaN` that reached the document through a bad edit
    /// or hand-written JSON) replaced by identity for that field.
    ///
    /// Every consumer goes through here, so a malformed document degrades to
    /// "that parameter does nothing" rather than to a `NaN` operator that would
    /// paint the whole frame black.
    pub fn normalised(&self) -> Self {
        let f = |v: f64| {
            if v.is_finite() {
                v.clamp(-1.0, 1.0)
            } else {
                0.0
            }
        };
        Self {
            exposure: f(self.exposure),
            contrast: f(self.contrast),
            saturation: f(self.saturation),
            temperature: f(self.temperature),
            tint: f(self.tint),
        }
    }

    /// Whether this layer provably changes nothing, so a consumer can skip it
    /// entirely — the preview skips a per-pixel pass, and the export emits no
    /// filter node at all (keeping a no-op adjustment clip byte-identical to
    /// having none, the same "the common case costs nothing" property
    /// `composite_video_frame`'s single-layer fast path has).
    pub fn is_identity(&self) -> bool {
        self.normalised() == Self::IDENTITY
    }
}

/// The resolved colour operator — two stages, applied in order:
///
/// 1. `v = clamp01(gain[c] · v + offset)`  (per channel)
/// 2. `v = clamp01(sat · v)`               (3×3 matrix)
///
/// with `v` normalised RGB in `0.0..=1.0`. Produced only by
/// [`AdjustmentOps::build`]; both engines consume this and neither recomputes
/// it from the parameters, which is what guarantees they agree — see the module
/// header.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AdjustmentOps {
    /// Stage 1's per-channel multiplier, in R/G/B order — exposure × white
    /// balance × contrast, folded.
    pub gain: [f64; 3],
    /// Stage 1's uniform offset (the contrast pivot), in normalised `0.0..=1.0`
    /// units. The exporter scales it by 255 for `lutrgb`, which works in 8-bit
    /// code values.
    pub offset: f64,
    /// Stage 2's saturation matrix, row-major: `sat[out_channel][in_channel]`,
    /// i.e. `sat[0]` is the row that produces **red**. Matches
    /// `colorchannelmixer`'s own `rr`/`rg`/`rb` naming (first letter = output
    /// channel) so the export compiler's mapping is a direct transcription with
    /// no transpose to get wrong.
    pub sat: [[f64; 3]; 3],
}

impl AdjustmentOps {
    /// The operator that leaves every pixel exactly as it was.
    pub const IDENTITY: Self = Self {
        gain: [1.0, 1.0, 1.0],
        offset: 0.0,
        sat: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
    };

    /// Build the operator for `layer`, mixed `mix` of the way from identity
    /// (`0.0` = no effect at all, `1.0` = the full correction).
    ///
    /// `mix` is where an adjustment clip's own **opacity** enters — the
    /// standard NLE reading of "how much of this layer is applied". It is
    /// applied **per stage**, each toward that stage's own identity, rather
    /// than to the composed operator: at `0.0` and `1.0` the two readings agree
    /// exactly (which is all that has to be true), and per-stage keeps the
    /// result expressible as the same two filter nodes at every mix value, so a
    /// half-strength adjustment costs the export nothing extra. Both engines
    /// call this one function, so there is no second interpretation to drift
    /// from.
    pub fn build(layer: &AdjustmentLayer, mix: f64) -> Self {
        let a = layer.normalised();
        let mix = if mix.is_finite() {
            mix.clamp(0.0, 1.0)
        } else {
            1.0
        };

        // Stage 1 — exposure × white balance × contrast, folded per channel.
        let ge = 2f64.powf(a.exposure);
        let c = 1.0 + a.contrast;
        let full_gain = [
            c * ge * (1.0 + WB_STRENGTH * a.temperature),
            c * ge * (1.0 - WB_STRENGTH * a.tint),
            c * ge * (1.0 - WB_STRENGTH * a.temperature),
        ];
        let mut gain = [0.0f64; 3];
        for (g, full) in gain.iter_mut().zip(full_gain) {
            *g = 1.0 + (full - 1.0) * mix;
        }
        let offset = 0.5 * (1.0 - c) * mix;

        // Stage 2 — the saturation matrix, `s·I + (1-s)·(luma broadcast)`.
        let s = 1.0 + a.saturation;
        let w = [LUMA_R, LUMA_G, LUMA_B];
        let mut sat = [[0.0f64; 3]; 3];
        for (i, row) in sat.iter_mut().enumerate() {
            for (j, cell) in row.iter_mut().enumerate() {
                let ident = if i == j { 1.0 } else { 0.0 };
                let full = s * ident + (1.0 - s) * w[j];
                *cell = ident * (1.0 - mix) + full * mix;
            }
        }

        Self { gain, offset, sat }
    }

    /// Whether this operator provably leaves every pixel alone.
    pub fn is_identity(&self) -> bool {
        *self == Self::IDENTITY
    }

    /// Apply the operator to one normalised RGB triple, clamping after each
    /// stage — the clamp points are part of the definition, not an
    /// implementation detail, because ffmpeg's filters clamp at exactly these
    /// two places and the preview has to as well.
    pub fn apply_rgb(&self, rgb: [f64; 3]) -> [f64; 3] {
        let mut stage1 = [0.0f64; 3];
        for (i, v) in stage1.iter_mut().enumerate() {
            *v = (rgb[i] * self.gain[i] + self.offset).clamp(0.0, 1.0);
        }
        let mut out = [0.0f64; 3];
        for (i, o) in out.iter_mut().enumerate() {
            let row = self.sat[i];
            *o = (row[0] * stage1[0] + row[1] * stage1[1] + row[2] * stage1[2]).clamp(0.0, 1.0);
        }
        out
    }

    /// Apply the operator to one 8-bit RGB triple — the form the CPU
    /// compositor actually has, and the one that has to match ffmpeg.
    ///
    /// **The intermediate quantisation is deliberate.** ffmpeg runs stage 1 and
    /// stage 2 as two separate 8-bit filters, so the value between them is
    /// rounded to 8 bits; doing stage 1 in `f64` and carrying full precision
    /// into stage 2 would be *more* accurate and would therefore disagree with
    /// the export. `floor` for stage 1 and `round` for stage 2 mirror the two
    /// filters' own measured behaviour (see the module header) — they are not
    /// an oversight.
    pub fn apply_rgb8(&self, rgb: [u8; 3]) -> [u8; 3] {
        let mut stage1 = [0u8; 3];
        for (i, v) in stage1.iter_mut().enumerate() {
            let x = (rgb[i] as f64 / 255.0 * self.gain[i] + self.offset).clamp(0.0, 1.0);
            *v = (x * 255.0).floor() as u8;
        }
        let mut out = [0u8; 3];
        for (i, o) in out.iter_mut().enumerate() {
            let row = self.sat[i];
            let y =
                (row[0] * stage1[0] as f64 + row[1] * stage1[1] as f64 + row[2] * stage1[2] as f64)
                    / 255.0;
            *o = (y.clamp(0.0, 1.0) * 255.0).round() as u8;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-9, "{a} != {b}");
    }

    #[test]
    fn identity_layer_builds_the_identity_operator() {
        let ops = AdjustmentOps::build(&AdjustmentLayer::IDENTITY, 1.0);
        assert!(ops.is_identity());
        assert_eq!(ops.apply_rgb8([12, 200, 77]), [12, 200, 77]);
    }

    #[test]
    fn zero_mix_is_the_identity_however_extreme_the_layer() {
        let layer = AdjustmentLayer {
            exposure: 1.0,
            contrast: 1.0,
            saturation: -1.0,
            temperature: 1.0,
            tint: -1.0,
        };
        assert!(AdjustmentOps::build(&layer, 0.0).is_identity());
    }

    #[test]
    fn exposure_is_a_power_of_two_gain() {
        let ops = AdjustmentOps::build(
            &AdjustmentLayer {
                exposure: 1.0,
                ..AdjustmentLayer::IDENTITY
            },
            1.0,
        );
        approx(ops.offset, 0.0);
        approx(ops.gain[0], 2.0);
        assert_eq!(ops.apply_rgb8([50, 60, 70]), [100, 120, 140]);
    }

    #[test]
    fn full_desaturation_maps_every_channel_to_rec709_luma() {
        let ops = AdjustmentOps::build(
            &AdjustmentLayer {
                saturation: -1.0,
                ..AdjustmentLayer::IDENTITY
            },
            1.0,
        );
        let out = ops.apply_rgb([1.0, 0.0, 0.0]);
        approx(out[0], LUMA_R);
        approx(out[1], LUMA_R);
        approx(out[2], LUMA_R);
    }

    #[test]
    fn contrast_pivots_about_mid_grey_and_leaves_it_alone() {
        for contrast in [-0.75, -0.25, 0.4, 1.0] {
            let ops = AdjustmentOps::build(
                &AdjustmentLayer {
                    contrast,
                    ..AdjustmentLayer::IDENTITY
                },
                1.0,
            );
            let out = ops.apply_rgb([0.5, 0.5, 0.5]);
            for v in out {
                approx(v, 0.5);
            }
        }
    }

    #[test]
    fn contrast_pivot_holds_with_saturation_also_in_play() {
        // This is the case that killed the single-matrix design (D-230): the
        // folded matrix hit `colorchannelmixer`'s ±2 cap here and crushed
        // mid-grey to 0.196. With the gain split out into its own uncapped
        // stage, mid-grey stays exactly where the pivot says it should.
        let ops = AdjustmentOps::build(
            &AdjustmentLayer {
                contrast: 0.6,
                saturation: 0.8,
                ..AdjustmentLayer::IDENTITY
            },
            1.0,
        );
        for v in ops.apply_rgb([0.5, 0.5, 0.5]) {
            approx(v, 0.5);
        }
    }

    #[test]
    fn positive_temperature_warms_and_negative_cools() {
        let warm = AdjustmentOps::build(
            &AdjustmentLayer {
                temperature: 1.0,
                ..AdjustmentLayer::IDENTITY
            },
            1.0,
        )
        .apply_rgb8([120, 120, 120]);
        assert!(warm[0] > 120 && warm[2] < 120, "warming: {warm:?}");

        let cool = AdjustmentOps::build(
            &AdjustmentLayer {
                temperature: -1.0,
                ..AdjustmentLayer::IDENTITY
            },
            1.0,
        )
        .apply_rgb8([120, 120, 120]);
        assert!(cool[0] < 120 && cool[2] > 120, "cooling: {cool:?}");
    }

    #[test]
    fn positive_tint_pushes_magenta_by_dropping_green() {
        let out = AdjustmentOps::build(
            &AdjustmentLayer {
                tint: 1.0,
                ..AdjustmentLayer::IDENTITY
            },
            1.0,
        )
        .apply_rgb8([120, 120, 120]);
        assert!(out[1] < 120, "green should fall toward magenta: {out:?}");
    }

    #[test]
    fn coefficients_never_reach_the_ffmpeg_limit() {
        // Stage 2 is the only stage ffmpeg caps (`colorchannelmixer`, ±2).
        // Prove the cap is unreachable across the whole parameter space, at
        // every mix — that proof is why this module contains no clamp, and why
        // the export needs no fallback path.
        for &s in &[-1.0, -0.5, 0.0, 0.5, 1.0] {
            for &mix in &[0.0, 0.25, 1.0] {
                let ops = AdjustmentOps::build(
                    &AdjustmentLayer {
                        saturation: s,
                        ..AdjustmentLayer::IDENTITY
                    },
                    mix,
                );
                for row in ops.sat {
                    for v in row {
                        assert!(v.abs() <= SAT_COEFF_MAX, "{v} exceeds {SAT_COEFF_MAX}");
                    }
                }
            }
        }
    }

    #[test]
    fn a_non_finite_parameter_degrades_to_identity_not_a_nan_operator() {
        let layer = AdjustmentLayer {
            exposure: f64::NAN,
            contrast: f64::INFINITY,
            ..AdjustmentLayer::IDENTITY
        };
        assert!(layer.is_identity());
        assert!(AdjustmentOps::build(&layer, 1.0).is_identity());
        assert_eq!(
            AdjustmentOps::build(&layer, 1.0).apply_rgb8([9, 9, 9]),
            [9, 9, 9]
        );
    }

    #[test]
    fn out_of_range_parameters_clamp_rather_than_run_away() {
        let wild = AdjustmentLayer {
            exposure: 12.0,
            ..AdjustmentLayer::IDENTITY
        };
        let clamped = AdjustmentLayer {
            exposure: 1.0,
            ..AdjustmentLayer::IDENTITY
        };
        assert_eq!(
            AdjustmentOps::build(&wild, 1.0),
            AdjustmentOps::build(&clamped, 1.0)
        );
    }

    #[test]
    fn mix_interpolates_between_identity_and_the_full_correction() {
        let layer = AdjustmentLayer {
            exposure: 1.0,
            ..AdjustmentLayer::IDENTITY
        };
        let half = AdjustmentOps::build(&layer, 0.5);
        approx(half.gain[0], 1.5);
        assert_eq!(half.apply_rgb8([100, 100, 100]), [150, 150, 150]);
    }

    #[test]
    fn output_is_clamped_into_range_rather_than_wrapping() {
        let ops = AdjustmentOps::build(
            &AdjustmentLayer {
                exposure: 1.0,
                ..AdjustmentLayer::IDENTITY
            },
            1.0,
        );
        assert_eq!(ops.apply_rgb8([200, 255, 250]), [255, 255, 255]);
    }

    /// D-230 — the numbers below were produced by running **real ffmpeg**
    /// (`lutrgb` → `colorchannelmixer`, fed the coefficients this module
    /// builds) over a swatch image, and are pasted here verbatim. This is the
    /// unit-level half of the preview/export parity claim: if someone changes
    /// the maths here, this test fails against what ffmpeg would still do, and
    /// the two engines would have silently diverged — the B-090/B-095/B-098
    /// failure mode. The end-to-end half lives in `chroma::edit`'s
    /// `preview_adjustment_tests` and `@chroma/editor`'s ffmpeg pixel suite.
    #[test]
    fn matches_real_ffmpeg_output_within_one_code_value() {
        /// One measured sample: the input colour, and what real ffmpeg
        /// actually produced for it.
        type Sample = ([u8; 3], [u8; 3]);
        /// One parameter set plus the four samples measured under it.
        type Case = (AdjustmentLayer, [Sample; 4]);

        let cases: [Case; 2] = [
            (
                AdjustmentLayer {
                    exposure: 0.3,
                    contrast: 0.25,
                    saturation: -0.5,
                    temperature: 0.4,
                    tint: -0.2,
                },
                [
                    ([128, 128, 128], [182, 176, 159]),
                    ([200, 60, 40], [180, 85, 63]),
                    ([30, 140, 210], [91, 179, 207]),
                    ([90, 30, 160], [88, 35, 118]),
                ],
            ),
            (
                AdjustmentLayer {
                    exposure: 0.6,
                    contrast: 0.8,
                    saturation: 0.8,
                    temperature: 0.0,
                    tint: 0.0,
                },
                [
                    ([128, 128, 128], [248, 247, 247]),
                    ([200, 60, 40], [255, 32, 0]),
                    ([30, 140, 210], [0, 255, 255]),
                    ([90, 30, 160], [218, 0, 255]),
                ],
            ),
        ];
        for (layer, samples) in cases {
            let ops = AdjustmentOps::build(&layer, 1.0);
            for (input, ffmpeg) in samples {
                let got = ops.apply_rgb8(input);
                for ch in 0..3 {
                    let d = got[ch] as i32 - ffmpeg[ch] as i32;
                    assert!(
                        d.abs() <= 1,
                        "{input:?} -> ours {got:?} vs ffmpeg {ffmpeg:?} (channel {ch})"
                    );
                }
            }
        }
    }
}
