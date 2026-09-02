//! Interactive relight (D-046) — deterministic, real-time depth-driven light
//! pucks. This module owns the pure, testable pieces: parsing the "Relight"
//! grade layer (`adjustments.relightLights` + `adjustments.relightDepthDir`)
//! out of the frontend's JSON adjustments blob into GPU-ready uniforms, and
//! resolving which depth source to shade against.
//!
//! It does NOT do the shading itself — that is the WGSL `apply_relight` pass
//! in `shaders/shader.wgsl`, driven by the `RelightLightGpu` array + the depth
//! bitmap this module resolves (rasterized by
//! `mask_generation::generate_relight_depth_bitmap`, same infra D-024's
//! depth-haze mask already uses). It does NOT do subject tracking, matte
//! refinement, or the diffusion "bake" mode — that is out of scope for this
//! feature entirely (see `docs/notes/relight-research.md` and D-046).
//!
//! Design in one line: the Relight layer is a **sibling top-level adjustment
//! layer**, not a mask container — it carries its own depth-source reference
//! (`relightDepthDir`, the exact same tracked-directory shape D-036's AI Depth
//! mask uses) rather than living inside `adjustments.masks`.
//!
//! Keyframing (D-034 reuse): each light's own JSON object may carry a
//! `chromaKeyframes` array in the *same* `[{frame, params}]` shape a shape
//! sub-mask's geometry uses. `chroma::keyframes::interpolated_parameters` is
//! generic over any params `Value` — this module calls it per-light before
//! extracting `x`/`y`/`radius`, exactly mirroring the one-hook pattern
//! `generate_sub_mask_bitmap` uses for mask geometry. No new interpolation
//! code. The frontend mirror reuses `utils/maskKeyframes.ts` the same way
//! (`GEOMETRY_KEYS.relight = ['x', 'y', 'radius']`).

use crate::image_processing::{MAX_RELIGHT_LIGHTS, RelightLightGpu};
use serde_json::Value;

/// A parsed, defaulted relight light — the pure intermediate between the raw
/// JSON and the GPU uniform. Kept separate from `RelightLightGpu` so the unit
/// tests below exercise plain Rust values, not `bytemuck` bit patterns.
#[derive(Debug, Clone, PartialEq)]
pub struct RelightLightSpec {
    /// "key" | "fill" | "rim" | "ambient". Only "ambient" changes the shading
    /// math (uniform tint, no position/normal/falloff) — the other three are
    /// UI labels/presets today (D-046 v1 scope).
    pub kind: String,
    /// 0–100, percentage of frame width/height. Ignored for `kind == "ambient"`.
    pub x: f32,
    pub y: f32,
    /// 0–100, percentage of the longer frame dimension.
    pub radius: f32,
    /// 0–200 UI percentage; 100 = the shader's baseline light strength.
    pub intensity: f32,
    /// `#rrggbb`, straight off the `<input type="color">` swatch.
    pub color: [f32; 3],
}

impl Default for RelightLightSpec {
    fn default() -> Self {
        Self {
            kind: "key".to_string(),
            x: 50.0,
            y: 50.0,
            radius: 35.0,
            intensity: 100.0,
            color: [1.0, 1.0, 1.0],
        }
    }
}

/// `#rrggbb` (with or without the leading `#`) -> linear-ish 0–1 RGB.
/// Malformed input (wrong length, non-hex digits, empty) falls back to white
/// rather than erroring — a bad swatch value should never take the whole
/// render down, just render as a colourless light.
pub fn parse_hex_color(hex: &str) -> [f32; 3] {
    // Byte-indexed on purpose (not `&s[i..i+2]` string slicing): a malformed
    // value could be non-ASCII, and slicing on a non-char-boundary byte index
    // panics rather than falling back. `is_ascii()` up front makes every
    // later byte index safe.
    let s = hex.strip_prefix('#').unwrap_or(hex);
    if s.len() != 6 || !s.is_ascii() {
        return [1.0, 1.0, 1.0];
    }
    let bytes = s.as_bytes();
    let hex_pair = |i: usize| -> Option<u8> {
        let hi = (bytes[i] as char).to_digit(16)?;
        let lo = (bytes[i + 1] as char).to_digit(16)?;
        Some((hi * 16 + lo) as u8)
    };
    match (hex_pair(0), hex_pair(2), hex_pair(4)) {
        (Some(r), Some(g), Some(b)) => [r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0],
        _ => [1.0, 1.0, 1.0],
    }
}

/// Reads `adjustments.relightLights`, applying D-034-style keyframe
/// interpolation per light first, and returns defaulted specs — visible
/// lights only, capped at `MAX_RELIGHT_LIGHTS`. Never errors: a missing/
/// malformed field falls back to `RelightLightSpec::default()`'s value for
/// that field, an absent/malformed array yields `[]`.
pub fn parse_relight_lights(js_adjustments: &Value) -> Vec<RelightLightSpec> {
    let Some(raw_lights) = js_adjustments
        .get("relightLights")
        .and_then(|v| v.as_array())
    else {
        return Vec::new();
    };

    raw_lights
        .iter()
        .filter(|l| l.get("visible").and_then(|v| v.as_bool()).unwrap_or(true))
        .take(MAX_RELIGHT_LIGHTS)
        .map(|raw| {
            // D-034 reuse: a keyframed light's `x`/`y`/`radius` are interpolated
            // for the current source frame before anything else reads them.
            let light = crate::chroma::keyframes::interpolated_parameters(raw)
                .unwrap_or_else(|| raw.clone());

            let default = RelightLightSpec::default();
            let get_f32 = |key: &str, fallback: f32| {
                light
                    .get(key)
                    .and_then(|v| v.as_f64())
                    .map(|v| v as f32)
                    .unwrap_or(fallback)
            };

            RelightLightSpec {
                kind: light
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&default.kind)
                    .to_string(),
                x: get_f32("x", default.x),
                y: get_f32("y", default.y),
                radius: get_f32("radius", default.radius).max(0.0),
                intensity: get_f32("intensity", default.intensity),
                color: light
                    .get("color")
                    .and_then(|v| v.as_str())
                    .map(parse_hex_color)
                    .unwrap_or(default.color),
            }
        })
        .collect()
}

/// [`parse_relight_lights`] converted straight to the fixed-size GPU array +
/// count `AllAdjustments` carries. UI percentages (0–100) become shader-space
/// 0–1 fractions here — the single place that scaling happens.
pub fn parse_relight_lights_gpu(
    js_adjustments: &Value,
) -> ([RelightLightGpu; MAX_RELIGHT_LIGHTS], u32) {
    let specs = parse_relight_lights(js_adjustments);
    let mut lights = [RelightLightGpu::default(); MAX_RELIGHT_LIGHTS];
    for (slot, spec) in lights.iter_mut().zip(specs.iter()) {
        *slot = RelightLightGpu {
            pos_x: spec.x / 100.0,
            pos_y: spec.y / 100.0,
            radius: spec.radius / 100.0,
            intensity: spec.intensity / 100.0,
            color_r: spec.color[0],
            color_g: spec.color[1],
            color_b: spec.color[2],
            kind: if spec.kind == "ambient" { 1.0 } else { 0.0 },
        };
    }
    (lights, specs.len() as u32)
}

/// `adjustments.relightDepthDir` — the per-frame Video-Depth-Anything track
/// directory the Relight layer shades against (D-036's tracking mechanism,
/// triggered from the Relight panel's own "Track Depth" button rather than a
/// mask's). `None` when absent/empty — the caller then renders ambient-only
/// (no positional-light shading, no crash; see `apply_relight`'s WGSL gate).
/// v1 does not fall back to a static single-frame bake (unlike D-024's AI
/// Depth mask) — deferred, `docs/04-roadmap.md`.
pub fn resolve_depth_dir(js_adjustments: &Value) -> Option<String> {
    js_adjustments
        .get("relightDepthDir")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hex_color_parses_rgb() {
        assert_eq!(parse_hex_color("#ff8000"), [1.0, 128.0 / 255.0, 0.0]);
        assert_eq!(parse_hex_color("00ff00"), [0.0, 1.0, 0.0]); // no leading '#'
    }

    #[test]
    fn hex_color_malformed_falls_back_to_white() {
        assert_eq!(parse_hex_color("#fff"), [1.0, 1.0, 1.0]); // 3-digit shorthand unsupported
        assert_eq!(parse_hex_color("not-a-color"), [1.0, 1.0, 1.0]);
        assert_eq!(parse_hex_color(""), [1.0, 1.0, 1.0]);
    }

    #[test]
    fn no_relight_lights_key_is_empty() {
        assert!(parse_relight_lights(&json!({})).is_empty());
        assert!(parse_relight_lights(&json!({ "relightLights": "not-an-array" })).is_empty());
    }

    #[test]
    fn parses_fields_and_defaults_missing_ones() {
        let adj = json!({
            "relightLights": [
                { "kind": "key", "x": 20.0, "y": 30.0, "radius": 40.0, "intensity": 150.0, "color": "#ff0000", "visible": true },
                { "kind": "ambient" },
            ]
        });
        let lights = parse_relight_lights(&adj);
        assert_eq!(lights.len(), 2);
        assert_eq!(lights[0].x, 20.0);
        assert_eq!(lights[0].color, [1.0, 0.0, 0.0]);
        assert_eq!(lights[1].kind, "ambient");
        assert_eq!(lights[1].x, RelightLightSpec::default().x); // missing -> default
    }

    #[test]
    fn invisible_lights_are_excluded() {
        let adj = json!({
            "relightLights": [
                { "kind": "key", "visible": false },
                { "kind": "fill", "visible": true },
            ]
        });
        let lights = parse_relight_lights(&adj);
        assert_eq!(lights.len(), 1);
        assert_eq!(lights[0].kind, "fill");
    }

    #[test]
    fn caps_at_max_relight_lights() {
        let raw: Vec<Value> = (0..MAX_RELIGHT_LIGHTS + 5)
            .map(|_| json!({ "kind": "key" }))
            .collect();
        let adj = json!({ "relightLights": raw });
        assert_eq!(parse_relight_lights(&adj).len(), MAX_RELIGHT_LIGHTS);
    }

    #[test]
    fn gpu_conversion_scales_percentages_to_unit_range() {
        let adj = json!({
            "relightLights": [
                { "kind": "key", "x": 50.0, "y": 25.0, "radius": 40.0, "intensity": 100.0, "color": "#ffffff" },
                { "kind": "ambient", "intensity": 20.0, "color": "#0000ff" },
            ]
        });
        let (lights, count) = parse_relight_lights_gpu(&adj);
        assert_eq!(count, 2);
        assert_eq!(lights[0].pos_x, 0.5);
        assert_eq!(lights[0].pos_y, 0.25);
        assert_eq!(lights[0].radius, 0.4);
        assert_eq!(lights[0].intensity, 1.0);
        assert_eq!(lights[0].kind, 0.0);
        assert_eq!(lights[1].kind, 1.0);
        assert_eq!(lights[1].intensity, 0.2);
        // Unused slots stay at the zeroed default.
        assert_eq!(lights[2], RelightLightGpu::default());
    }

    #[test]
    fn depth_dir_absent_or_empty_is_none() {
        assert!(resolve_depth_dir(&json!({})).is_none());
        assert!(resolve_depth_dir(&json!({ "relightDepthDir": "" })).is_none());
        assert_eq!(
            resolve_depth_dir(&json!({ "relightDepthDir": "/tmp/x" })),
            Some("/tmp/x".to_string())
        );
    }

    /// D-034 reuse: a keyframed light interpolates `x`/`y`/`radius` for the
    /// "current frame" — but these pure-parsing tests run with no video
    /// loaded, so `interpolated_parameters` returns `None` and the raw
    /// (un-interpolated) light object is used as-is. The interpolation math
    /// itself is exhaustively tested in `chroma::keyframes` already (D-034);
    /// this just confirms the hook wiring doesn't panic / drop fields when
    /// `chromaKeyframes` is present but there is nothing to interpolate against.
    #[test]
    fn keyframed_light_without_a_loaded_video_falls_back_to_raw_fields() {
        let adj = json!({
            "relightLights": [
                {
                    "kind": "key", "x": 10.0, "y": 10.0,
                    "chromaKeyframes": [
                        { "frame": 0, "params": { "x": 10.0, "y": 10.0, "radius": 20.0 } },
                        { "frame": 30, "params": { "x": 80.0, "y": 10.0, "radius": 20.0 } },
                    ],
                },
            ]
        });
        let lights = parse_relight_lights(&adj);
        assert_eq!(lights.len(), 1);
        assert_eq!(lights[0].x, 10.0);
    }

    /// Render-path determinism (CLAUDE.md invariant: same doc + same frame =>
    /// identical pixels). Builds the exact request shape `process_preview_job`
    /// (`lib.rs`) constructs for a live relight edit — a real `AllAdjustments`
    /// from JSON, a synthetic depth bitmap appended to `mask_bitmaps` at
    /// `relight_depth_layer` — and runs it through the real GPU compute shader
    /// (`render_core::render`, D-014) twice, on fresh caches each time, and
    /// diffs the raw output bytes. Skips (does not fail) if no GPU adapter is
    /// available — matches this file's other GPU-touching tests skipping on a
    /// missing `CHROMA_TEST_VIDEO` fixture rather than failing CI machines with
    /// no GPU.
    #[test]
    fn relight_render_is_deterministic() {
        use crate::gpu_processing::RenderRequest;
        use crate::image_processing::get_all_adjustments_from_json;
        use crate::render_core::{self, OwnedRenderCaches};
        use image::{DynamicImage, GrayImage, Luma, RgbImage};

        let Ok(ctx) = render_core::init_gpu_context() else {
            eprintln!("skip: no GPU adapter available for relight_render_is_deterministic");
            return;
        };

        const W: u32 = 64;
        const H: u32 = 64;

        // A base image with real per-pixel variation (a diagonal gradient), not
        // a flat fill — a flat input can't reveal a shading bug that only shows
        // up where colours actually differ pixel-to-pixel.
        let base = DynamicImage::ImageRgb8(RgbImage::from_fn(W, H, |x, y| {
            image::Rgb([((x * 4) % 255) as u8, ((y * 4) % 255) as u8, 128])
        }));

        // A synthetic depth bitmap — a radial "near in the middle" gradient, so
        // `relight_normal`'s finite-difference has real gradients to read.
        let depth = GrayImage::from_fn(W, H, |x, y| {
            let dx = x as f32 - (W as f32 / 2.0);
            let dy = y as f32 - (H as f32 / 2.0);
            let dist = (dx * dx + dy * dy).sqrt() / ((W as f32).hypot(H as f32) / 2.0);
            Luma([(255.0 * (1.0 - dist.min(1.0))) as u8])
        });

        let js = json!({
            "relightLights": [
                { "kind": "key", "x": 30.0, "y": 40.0, "radius": 55.0, "intensity": 130.0, "color": "#ff8040", "visible": true },
                { "kind": "ambient", "intensity": 15.0, "color": "#4080ff", "visible": true },
            ]
        });

        let render_once = || -> Vec<u8> {
            let mut adjustments = get_all_adjustments_from_json(&js, false, None);
            let mut mask_bitmaps = Vec::new();
            assert!(
                adjustments.relight_light_count > 0,
                "test fixture should parse >0 lights"
            );
            adjustments.relight_depth_layer = mask_bitmaps.len() as i32;
            mask_bitmaps.push(depth.clone());

            let caches = OwnedRenderCaches::default();
            let out = render_core::render(
                &ctx,
                caches.as_ref(),
                &base,
                1,
                RenderRequest {
                    adjustments,
                    mask_bitmaps: &mask_bitmaps,
                    lut: None,
                    roi: None,
                },
                "relight_determinism_test",
                false,
                None,
            )
            .expect("relight render");
            out.to_rgba8().into_raw()
        };

        let a = render_once();
        let b = render_once();
        assert_eq!(
            a.len(),
            b.len(),
            "output dimensions changed between identical renders"
        );
        assert_eq!(
            a, b,
            "same grade + same frame produced different pixels — determinism violated"
        );

        // Sanity: relight actually did something — a render with the same
        // lights but light_count forced to 0 (relight fully disabled) should
        // differ from the lit render, otherwise this test would trivially pass
        // by rendering nothing.
        let mut unlit_adjustments = get_all_adjustments_from_json(&json!({}), false, None);
        unlit_adjustments.relight_depth_layer = -1;
        let unlit = render_core::render(
            &ctx,
            OwnedRenderCaches::default().as_ref(),
            &base,
            1,
            RenderRequest {
                adjustments: unlit_adjustments,
                mask_bitmaps: &[],
                lut: None,
                roi: None,
            },
            "relight_determinism_test_unlit",
            false,
            None,
        )
        .expect("unlit render")
        .to_rgba8()
        .into_raw();
        assert_ne!(
            a, unlit,
            "relight lights made no visible difference to the render"
        );
    }
}
