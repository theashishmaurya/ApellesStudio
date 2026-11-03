//! **Host-side tables the kernels read** (D-449).
//!
//! What it is: every value a kernel needs that is a function of the layer's
//! geometry alone, not of a pixel: which source texels a column or row of the
//! output reads and with what weight, the inverse rotation matrix, and the
//! adjustment operator's two stages as lookup tables.
//!
//! Why on the CPU: these are exactly the quantities where the CPU compositor
//! worked in `f64` (sample positions, the adjustment operator) or in a specific
//! `f32` order (the `image` crate's Triangle weights, `imageproc`'s matrix
//! product). Computing them here with the very same expressions, and uploading
//! the results, means the GPU never re-derives an index, a weight or a floor:
//! the only arithmetic left on the GPU is the per-pixel weighted sum and the
//! blend. That is what keeps the GPU picture within one code value of the CPU
//! one on every effect (measured: `docs/notes/export-gpu-compositor.md` §15).
//!
//! What it does NOT do: touch a pixel.

use apelles_types::adjustment::AdjustmentOps;

use crate::plan::Layer;

/// One output column (or row) of the fused bilinear path: the two source
/// texels it interpolates between, relative to the crop's origin, and the
/// fraction of the way from the first to the second.
#[derive(Clone, Copy, Debug, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C)]
pub struct Tap {
    pub i0: u32,
    pub i1: u32,
    pub frac: f32,
}

/// The fused path's whole plan for one layer: the canvas window it covers and
/// a [`Tap`] per window column and row.
#[derive(Clone, Debug)]
pub struct SampleTables {
    /// `(x0, y0, x1, y1)`: canvas pixels the layer covers, exclusive.
    pub window: (u32, u32, u32, u32),
    /// The rounded top-left of the box on the canvas.
    pub origin: (i64, i64),
    pub cols: Vec<Tap>,
    pub rows: Vec<Tap>,
}

/// The fused path's taps for `layer` on a `canvas`-sized canvas, or `None`
/// when the layer is entirely off the canvas.
///
/// The expressions are the CPU compositor's `blend_layer_sampled`, in `f64`:
/// the sample position of output pixel `o` is `(o + 0.5) * ratio - 0.5`, the
/// `image` crate's own convention, so at ratio 1 the sample lands exactly on a
/// texel and the layer is copied unchanged. Taps falling outside the crop read
/// its edge texel.
pub fn sample_tables(layer: &Layer, canvas: (u32, u32)) -> Option<SampleTables> {
    let (cw, ch) = canvas;
    let (sw, sh) = layer.size;
    let (ox, oy) = (layer.origin.0.round() as i64, layer.origin.1.round() as i64);
    let vx0 = ox.max(0);
    let vy0 = oy.max(0);
    let vx1 = (ox + i64::from(sw)).min(i64::from(cw));
    let vy1 = (oy + i64::from(sh)).min(i64::from(ch));
    if vx1 <= vx0 || vy1 <= vy0 {
        return None;
    }
    let (cx0, cy0, cx1, cy1) = layer.crop;
    let axis = |v0: i64, v1: i64, o: i64, c0: u32, c1: u32, size: u32| -> Vec<Tap> {
        let ratio = f64::from(c1 - c0) / f64::from(size);
        let last = i64::from(c1) - 1;
        (v0..v1)
            .map(|p| {
                let u = ((p - o) as f64 + 0.5) * ratio - 0.5 + f64::from(c0);
                let fu = u.floor();
                let a = (fu as i64).clamp(i64::from(c0), last);
                let b = (fu as i64 + 1).clamp(i64::from(c0), last);
                Tap {
                    i0: (a - i64::from(c0)) as u32,
                    i1: (b - i64::from(c0)) as u32,
                    frac: (u - fu) as f32,
                }
            })
            .collect()
    };
    Some(SampleTables {
        window: (vx0 as u32, vy0 as u32, vx1 as u32, vy1 as u32),
        origin: (ox, oy),
        cols: axis(vx0, vx1, ox, cx0, cx1, sw),
        rows: axis(vy0, vy1, oy, cy0, cy1, sh),
    })
}

/// One output index of a separable Triangle resample: it reads `count` input
/// texels starting at `left`, with weights `weights[offset..offset + count]`.
#[derive(Clone, Copy, Debug, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C)]
pub struct Span {
    pub left: u32,
    pub count: u32,
    pub offset: u32,
}

/// The Triangle-filter weights for resampling `input` texels to `output`,
/// exactly as `image::imageops::resize` (0.25) computes them for each axis:
/// `ratio = in/out`, support widened by the ratio when minifying, the kernel
/// evaluated at `(i - (centre - 0.5)) / sratio`, normalised by its sum, all in
/// `f32` in that order. When `input == output` this is the identity (weight 1
/// on the texel itself), which is what `resize`'s own same-size copy produces.
pub fn triangle_weights(input: u32, output: u32) -> (Vec<Span>, Vec<f32>) {
    let mut spans = Vec::with_capacity(output as usize);
    let mut weights = Vec::new();
    if input == output {
        for o in 0..output {
            spans.push(Span {
                left: o,
                count: 1,
                offset: weights.len() as u32,
            });
            weights.push(1.0);
        }
        return (spans, weights);
    }
    let ratio = input as f32 / output as f32;
    let sratio = if ratio < 1.0 { 1.0 } else { ratio };
    let src_support = 1.0 * sratio;
    let triangle = |x: f32| if x.abs() < 1.0 { 1.0 - x.abs() } else { 0.0 };
    for o in 0..output {
        let centre = (o as f32 + 0.5) * ratio;
        let left = ((centre - src_support).floor() as i64).clamp(0, i64::from(input) - 1);
        let right = ((centre + src_support).ceil() as i64).clamp(left + 1, i64::from(input));
        let centre = centre - 0.5;
        let start = weights.len();
        let mut sum = 0.0f32;
        for i in left..right {
            let w = triangle((i as f32 - centre) / sratio);
            weights.push(w);
            sum += w;
        }
        for w in &mut weights[start..] {
            *w /= sum;
        }
        spans.push(Span {
            left: left as u32,
            count: (right - left) as u32,
            offset: start as u32,
        });
    }
    (spans, weights)
}

/// The inverse (output → input) affine map for a clockwise rotation of
/// `degrees` about the centre of a `width` × `height` buffer, as the six
/// coefficients `imageproc::geometric_transformations::rotate_about_center`
/// uses: `x_in = m[0] x + m[1] y + m[2]`, `y_in = m[3] x + m[4] y + m[5]`.
///
/// Built the way `imageproc` builds it, in `f32`: the projection is
/// `T(c) · R(θ) · T(-c)` and its inverse is the product of the three inverses
/// in reverse order, through the same 3×3 product. The angle is converted to
/// radians in `f32` exactly as the CPU compositor did.
pub fn rotation_inverse(width: u32, height: u32, degrees: f64) -> [f32; 6] {
    let theta = (degrees as f32) * std::f32::consts::PI / 180.0;
    let (cx, cy) = (width as f32 / 2.0, height as f32 / 2.0);
    let (s, c) = theta.sin_cos();
    let t_pos_inv = [1.0, 0.0, -cx, 0.0, 1.0, -cy, 0.0, 0.0, 1.0];
    let r_inv = [c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0];
    let t_neg_inv = [1.0, 0.0, cx, 0.0, 1.0, cy, 0.0, 0.0, 1.0];
    // (A·B).inverse = B⁻¹·A⁻¹, then ((A·B)·C).inverse = C⁻¹·(A·B)⁻¹.
    let ab_inv = mul3x3(r_inv, t_pos_inv);
    let m = mul3x3(t_neg_inv, ab_inv);
    // `imageproc` normalises by m[8], which is 1 for an affine map.
    [m[0], m[1], m[2], m[3], m[4], m[5]]
}

fn mul3x3(a: [f32; 9], b: [f32; 9]) -> [f32; 9] {
    let [a00, a01, a02, a10, a11, a12, a20, a21, a22] = a;
    let [b00, b01, b02, b10, b11, b12, b20, b21, b22] = b;
    [
        a00 * b00 + a01 * b10 + a02 * b20,
        a00 * b01 + a01 * b11 + a02 * b21,
        a00 * b02 + a01 * b12 + a02 * b22,
        a10 * b00 + a11 * b10 + a12 * b20,
        a10 * b01 + a11 * b11 + a12 * b21,
        a10 * b02 + a11 * b12 + a12 * b22,
        a20 * b00 + a21 * b10 + a22 * b20,
        a20 * b01 + a21 * b11 + a22 * b21,
        a20 * b02 + a21 * b12 + a22 * b22,
    ]
}

/// Fixed-point scale of [`AdjustTables::stage2`]'s entries: 2^18. Large enough
/// that a sum of three terms resolves to 1/262144 of a code value, small enough
/// that `3 × 255 × |m| × 2^18` stays inside `i32` for any saturation matrix
/// entry up to |m| = 10 (the operator's own entries are within ±3).
pub const STAGE2_SHIFT: u32 = 18;

/// D-230's adjustment operator as two lookup tables, so the GPU applies it with
/// the CPU's own `f64` arithmetic and its deliberate floor between stages
/// (`AdjustmentOps::apply_rgb8`), which a WGSL `f32` evaluation cannot reproduce
/// at the floor's boundaries.
///
/// - `stage1[c * 256 + v]` is channel `c`'s 8-bit value after the gain and
///   offset, floored: exactly `apply_rgb8`'s stage 1 for input `v`.
/// - `stage2[(i * 3 + k) * 256 + s]` is `sat[i][k] * s`, in fixed point
///   (`round(x · 2^18)`). The GPU sums the three terms for output channel `i`
///   and rounds; that equals `apply_rgb8`'s `round(clamp(Σ/255, 0, 1) · 255)`
///   except within 2^-18 of a half, which no 8-bit input reaches in practice.
pub struct AdjustTables {
    pub stage1: Vec<u32>,
    pub stage2: Vec<i32>,
}

pub fn adjust_tables(ops: &AdjustmentOps) -> AdjustTables {
    let mut stage1 = Vec::with_capacity(768);
    for c in 0..3 {
        for v in 0..256u32 {
            let x = (f64::from(v) / 255.0 * ops.gain[c] + ops.offset).clamp(0.0, 1.0);
            stage1.push((x * 255.0).floor() as u32);
        }
    }
    let scale = f64::from(1u32 << STAGE2_SHIFT);
    let mut stage2 = Vec::with_capacity(2304);
    for i in 0..3 {
        for k in 0..3 {
            for s in 0..256u32 {
                let v = ops.sat[i][k] * f64::from(s) * scale;
                stage2.push(v.round().clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32);
            }
        }
    }
    AdjustTables { stage1, stage2 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::Source;

    fn layer(crop: (u32, u32, u32, u32), size: (u32, u32), origin: (f64, f64)) -> Layer {
        Layer {
            source: Source::Solid {
                width: crop.2,
                height: crop.3,
                rgba: [0, 0, 0, 255],
            },
            lut: None,
            crop,
            size,
            origin,
            opacity: 1.0,
            corner_radius: 0.0,
            rotation_deg: 0.0,
        }
    }

    #[test]
    fn a_one_to_one_layer_samples_each_texel_exactly() {
        let t = sample_tables(&layer((0, 0, 8, 4), (8, 4), (0.0, 0.0)), (8, 4)).unwrap();
        assert_eq!(t.window, (0, 0, 8, 4));
        for (i, c) in t.cols.iter().enumerate() {
            assert_eq!((c.i0, c.frac), (i as u32, 0.0));
        }
    }

    #[test]
    fn an_off_canvas_layer_has_no_window() {
        assert!(sample_tables(&layer((0, 0, 8, 4), (8, 4), (20.0, 0.0)), (8, 4)).is_none());
    }

    #[test]
    fn taps_stay_inside_the_crop() {
        let t = sample_tables(&layer((2, 2, 6, 6), (16, 16), (0.0, 0.0)), (16, 16)).unwrap();
        for c in t.cols.iter().chain(&t.rows) {
            assert!(c.i0 < 4 && c.i1 < 4);
        }
    }

    #[test]
    fn triangle_weights_sum_to_one_and_cover_the_input() {
        for (i, o) in [(3840u32, 1280u32), (100, 37), (37, 100), (10, 10)] {
            let (spans, w) = triangle_weights(i, o);
            assert_eq!(spans.len(), o as usize);
            for s in &spans {
                assert!(s.left + s.count <= i);
                let sum: f32 = w[s.offset as usize..(s.offset + s.count) as usize]
                    .iter()
                    .sum();
                assert!((sum - 1.0).abs() < 1e-5);
            }
        }
    }

    #[test]
    fn a_zero_rotation_is_the_identity_map() {
        let m = rotation_inverse(100, 50, 0.0);
        assert_eq!(m, [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]);
    }

    #[test]
    fn the_adjust_tables_reproduce_the_operator() {
        let ops = AdjustmentOps {
            gain: [1.1, 0.95, 1.2],
            offset: -0.02,
            sat: [[0.8, 0.15, 0.05], [0.1, 0.85, 0.05], [0.1, 0.1, 0.8]],
        };
        let t = adjust_tables(&ops);
        for &rgb in &[[0u8, 0, 0], [255, 255, 255], [12, 200, 77], [128, 64, 250]] {
            let want = ops.apply_rgb8(rgb);
            let s: Vec<usize> = (0..3)
                .map(|c| t.stage1[c * 256 + rgb[c] as usize] as usize)
                .collect();
            for (i, &w) in want.iter().enumerate() {
                let sum: i64 = (0..3)
                    .map(|k| i64::from(t.stage2[(i * 3 + k) * 256 + s[k]]))
                    .sum();
                let got = ((sum + (1 << (STAGE2_SHIFT - 1))) >> STAGE2_SHIFT).clamp(0, 255);
                assert_eq!(got as u8, w, "{rgb:?} channel {i}");
            }
        }
    }
}
