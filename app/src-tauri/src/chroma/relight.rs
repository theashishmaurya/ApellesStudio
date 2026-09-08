//! Interactive relight (D-048) — deterministic, real-time depth-driven light
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
//! feature entirely (see `docs/notes/relight-research.md` and D-048).
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
//!
//! Static depth-bake fallback (D-054, follow-up to D-048's deferred item):
//! [`resolve_depth_bake`] reads `adjustments.relightDepthBake` — a raw,
//! un-band-passed depth-map PNG baked once by the same single-frame
//! Depth-Anything-V2 model D-024's AI-Depth mask and the lens-blur depth map
//! already share (`generate_full_image_depth_map`), stored as a plain base64
//! data URL exactly like `AiDepthMaskParameters.mask_data_base64`. It is
//! consulted by `mask_generation::resolve_relight_depth_bitmap` ONLY when no
//! temporal track (`relightDepthDir`) is present or nothing is cached yet at
//! the current frame — a tracked directory always wins when both exist.

use crate::image_processing::{MAX_RELIGHT_LIGHTS, RelightLightGpu};
use serde_json::Value;

/// A parsed, defaulted relight light — the pure intermediate between the raw
/// JSON and the GPU uniform. Kept separate from `RelightLightGpu` so the unit
/// tests below exercise plain Rust values, not `bytemuck` bit patterns.
#[derive(Debug, Clone, PartialEq)]
pub struct RelightLightSpec {
    /// "key" | "fill" | "rim" | "ambient". Only "ambient" changes the shading
    /// math (uniform tint, no position/normal/falloff) — the other three are
    /// UI labels/presets today (D-048 v1 scope).
    pub kind: String,
    /// 0–100, percentage of frame width/height. Ignored for `kind == "ambient"`.
    pub x: f32,
    pub y: f32,
    /// 0–100, percentage of the longer frame dimension — screen-space
    /// falloff size only.
    pub radius: f32,
    /// 0–100. The light's own absolute position in the depth map's
    /// normalized "bright = near" space (D-076) — an independent z dial, NOT
    /// sampled from whatever's directly behind the puck's own x/y. See
    /// `RelightLightGpu`'s doc comment in `image_processing.rs` for the full
    /// history: a first version derived z from the depth *at the puck's own
    /// anchor*, which broke as soon as the puck sat off the subject (over
    /// open background, a completely normal place to park a point light) —
    /// the background caught light, the subject didn't.
    pub distance: f32,
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
            distance: 85.0,
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
                distance: get_f32("distance", default.distance),
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
            distance: spec.distance / 100.0,
            _pad0: 0.0,
            _pad1: 0.0,
            _pad2: 0.0,
        };
    }
    (lights, specs.len() as u32)
}

/// `adjustments.relightDepthDir` — the per-frame Video-Depth-Anything track
/// directory the Relight layer shades against (D-036's tracking mechanism,
/// triggered from the Relight panel's own "Track Depth" button rather than a
/// mask's). `None` when absent/empty — the caller then falls back to
/// [`resolve_depth_bake`]'s static bake, and only renders ambient-only (no
/// positional-light shading, no crash; see `apply_relight`'s WGSL gate) when
/// neither exists.
pub fn resolve_depth_dir(js_adjustments: &Value) -> Option<String> {
    js_adjustments
        .get("relightDepthDir")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// `adjustments.relightDepthBake` — a static single-frame depth-map PNG (data
/// URL), the D-054 fallback for a clip with no temporal depth track. `None`
/// when absent/empty. See the module header for how this relates to
/// [`resolve_depth_dir`].
pub fn resolve_depth_bake(js_adjustments: &Value) -> Option<String> {
    js_adjustments
        .get("relightDepthBake")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// `adjustments.relightNormalsBake` (D-077) — a single-frame, RGB-encoded
/// surface-normal-map PNG (data URL) from MoGe-2, via
/// `generate_full_image_normal_map` (the AI sidecar's `/generate_normal_map`,
/// `ai/vendor/moge/`). `None` when absent/empty, same absent/empty contract
/// [`resolve_depth_bake`] and [`resolve_depth_dir`] already have — the caller
/// then falls back to `apply_relight`'s depth-derived normal, unchanged from
/// before D-077.
pub fn resolve_normals_bake(js_adjustments: &Value) -> Option<String> {
    js_adjustments
        .get("relightNormalsBake")
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

    /// D-076. `distance` defaults to a nonzero value (40.0) when absent —
    /// distance == 0 is the degenerate "flush on the surface" case that
    /// caused relight to look like it did nothing, so a light with no
    /// explicit `distance` field (older saved grades, or a bare test
    /// fixture) still gets real directional shading.
    #[test]
    fn distance_field_parses_and_defaults() {
        let adj = json!({
            "relightLights": [
                { "kind": "key", "distance": 75.0 },
                { "kind": "fill" },
            ]
        });
        let lights = parse_relight_lights(&adj);
        assert_eq!(lights[0].distance, 75.0);
        assert_eq!(lights[1].distance, 85.0);

        let (gpu, _) = parse_relight_lights_gpu(&adj);
        assert_eq!(gpu[0].distance, 0.75);
        assert_eq!(gpu[1].distance, 0.85);
    }

    #[test]
    fn gpu_conversion_scales_percentages_to_unit_range() {
        let adj = json!({
            "relightLights": [
                { "kind": "key", "x": 50.0, "y": 25.0, "radius": 40.0, "distance": 60.0, "intensity": 100.0, "color": "#ffffff" },
                { "kind": "ambient", "intensity": 20.0, "color": "#0000ff" },
            ]
        });
        let (lights, count) = parse_relight_lights_gpu(&adj);
        assert_eq!(count, 2);
        assert_eq!(lights[0].pos_x, 0.5);
        assert_eq!(lights[0].pos_y, 0.25);
        assert_eq!(lights[0].radius, 0.4);
        assert_eq!(lights[0].distance, 0.6);
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

    /// D-054: the static-bake resolver mirrors `resolve_depth_dir`'s absent/
    /// empty handling exactly — same contract, different field.
    #[test]
    fn depth_bake_absent_or_empty_is_none() {
        assert!(resolve_depth_bake(&json!({})).is_none());
        assert!(resolve_depth_bake(&json!({ "relightDepthBake": "" })).is_none());
        assert_eq!(
            resolve_depth_bake(&json!({ "relightDepthBake": "data:image/png;base64,abc" })),
            Some("data:image/png;base64,abc".to_string())
        );
    }

    /// D-077: the normals-bake resolver mirrors the depth one's absent/empty
    /// contract exactly — same shape, different field.
    #[test]
    fn normals_bake_absent_or_empty_is_none() {
        assert!(resolve_normals_bake(&json!({})).is_none());
        assert!(resolve_normals_bake(&json!({ "relightNormalsBake": "" })).is_none());
        assert_eq!(
            resolve_normals_bake(&json!({ "relightNormalsBake": "data:image/png;base64,xyz" })),
            Some("data:image/png;base64,xyz".to_string())
        );
    }

    /// D-034 reuse: a keyframed light interpolates `x`/`y`/`radius` for the
    /// "current frame" — but these pure-parsing tests run with no video
    /// loaded, so `interpolated_parameters` returns `None` and the raw
    /// (un-interpolated) light object is used as-is. The interpolation math
    /// itself is exhaustively tested in `chroma::keyframes` already (D-034);
    /// this just confirms the hook wiring doesn't panic / drop fields when
    /// `chromaKeyframes` is present but there is nothing to interpolate against.
    ///
    /// **B-105 — "with no video loaded" is now ESTABLISHED here, not assumed.**
    /// `current_video()` is process-global and several tests in other modules
    /// set it; this test's entire premise is that it is `None`, so it takes
    /// `PROJECT_STATE_LOCK` and says so outright rather than inheriting whatever
    /// the last test to touch it happened to leave. Fixing only the leaking
    /// side would leave this passing by luck; a test that depends on a global
    /// should set it.
    #[test]
    fn keyframed_light_without_a_loaded_video_falls_back_to_raw_fields() {
        let _guard = super::super::PROJECT_STATE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        crate::chroma::state::set_current_video(None);
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

    /// D-076 regression test. `relight_render_is_deterministic` above uses a
    /// strong radial depth gradient across the *whole* frame, which is enough
    /// depth variation to mask the bug this test targets: real footage (a
    /// face, a torso) is relatively FLAT in depth near where a light actually
    /// gets dropped, and on a flat depth surface `distance == 0` (the only
    /// value that existed before D-076) makes `ndotl` collapse to exactly
    /// zero everywhere — "nothing is getting applied at all", confirmed live
    /// on real footage. This test uses a perfectly flat depth bitmap (the
    /// worst case for the old code) and asserts a light with `distance == 0`
    /// renders byte-identical to no light at all, while a light with a real
    /// `distance` produces a visibly different image — proving `distance` is
    /// what makes positional lights actually shade a flat/near-flat surface.
    #[test]
    fn positional_light_needs_nonzero_distance_to_shade_a_flat_surface() {
        use crate::gpu_processing::RenderRequest;
        use crate::image_processing::get_all_adjustments_from_json;
        use crate::render_core::{self, OwnedRenderCaches};
        use image::{DynamicImage, GrayImage, Luma, RgbImage};

        let Ok(ctx) = render_core::init_gpu_context() else {
            eprintln!(
                "skip: no GPU adapter available for positional_light_needs_nonzero_distance_to_shade_a_flat_surface"
            );
            return;
        };

        const W: u32 = 64;
        const H: u32 = 64;

        let base = DynamicImage::ImageRgb8(RgbImage::from_fn(W, H, |x, y| {
            image::Rgb([((x * 4) % 255) as u8, ((y * 4) % 255) as u8, 128])
        }));

        // Perfectly flat depth — every pixel the same value, like a plain
        // patch of a face or torso far from any background depth edge.
        let flat_depth = GrayImage::from_pixel(W, H, Luma([180]));

        let render_with = |light_json: Value| -> Vec<u8> {
            let js = json!({ "relightLights": [light_json] });
            let mut adjustments = get_all_adjustments_from_json(&js, false, None);
            let mut mask_bitmaps = Vec::new();
            adjustments.relight_depth_layer = mask_bitmaps.len() as i32;
            mask_bitmaps.push(flat_depth.clone());

            render_core::render(
                &ctx,
                OwnedRenderCaches::default().as_ref(),
                &base,
                1,
                RenderRequest {
                    adjustments,
                    mask_bitmaps: &mask_bitmaps,
                    lut: None,
                    roi: None,
                },
                "relight_flat_surface_distance_test",
                false,
                None,
            )
            .expect("relight render")
            .to_rgba8()
            .into_raw()
        };

        let flush = render_with(json!({
            "kind": "key", "x": 50.0, "y": 50.0, "radius": 60.0, "distance": 0.0,
            "intensity": 150.0, "color": "#ffffff", "visible": true,
        }));
        let unlit = render_with(json!({
            "kind": "key", "x": 50.0, "y": 50.0, "radius": 60.0, "distance": 0.0,
            "intensity": 0.0, "color": "#ffffff", "visible": true,
        }));
        assert_eq!(
            flush, unlit,
            "a light at distance == 0 shaded a flat surface — expected exactly zero contribution"
        );

        let elevated = render_with(json!({
            "kind": "key", "x": 50.0, "y": 50.0, "radius": 60.0, "distance": 95.0,
            "intensity": 150.0, "color": "#ffffff", "visible": true,
        }));
        assert_ne!(
            elevated, unlit,
            "a light with real distance still made no visible difference on a flat surface"
        );
    }

    /// D-076 follow-up regression test, added after the first `distance` fix
    /// still failed live: a puck dropped beside the subject, over open
    /// background (a completely normal place to park a point light, and
    /// exactly what the owner did), must still shade the subject. An earlier
    /// version of the fix sampled the depth map *at the puck's own anchor
    /// pixel* and added `distance` on top of that — which meant the puck's
    /// z was implicitly whatever was directly behind it on screen: fine if
    /// dropped right on the subject, but a puck over background anchored the
    /// light to the *background's* depth, so the actual subject (elsewhere
    /// in frame, much nearer to camera) got zero shading regardless of
    /// `distance`. This test uses a depth map with two distinct flat
    /// regions — a far "background" (left half, low depth) where the puck
    /// sits, and a near "subject" (right half, high depth) where shading is
    /// checked — and asserts the subject region differs from unlit even
    /// though the puck never touches it.
    #[test]
    fn positional_light_shades_subject_even_when_puck_sits_over_background() {
        use crate::gpu_processing::RenderRequest;
        use crate::image_processing::get_all_adjustments_from_json;
        use crate::render_core::{self, OwnedRenderCaches};
        use image::{DynamicImage, GrayImage, Luma, RgbImage};

        let Ok(ctx) = render_core::init_gpu_context() else {
            eprintln!(
                "skip: no GPU adapter available for positional_light_shades_subject_even_when_puck_sits_over_background"
            );
            return;
        };

        const W: u32 = 64;
        const H: u32 = 64;

        let base = DynamicImage::ImageRgb8(RgbImage::from_fn(W, H, |x, y| {
            image::Rgb([((x * 4) % 255) as u8, ((y * 4) % 255) as u8, 128])
        }));

        // Left half (x < W/2, where the puck sits at x=15%) is far
        // background (low depth); right half (x >= W/2, checked for
        // shading) is a near subject (high depth). Both halves individually
        // flat, so any shading difference there is purely from `distance`,
        // not from an in-region depth gradient.
        let two_region_depth = GrayImage::from_fn(W, H, |x, _y| {
            if x < W / 2 { Luma([40]) } else { Luma([220]) }
        });

        let render_with = |light_json: Value| -> Vec<u8> {
            let js = json!({ "relightLights": [light_json] });
            let mut adjustments = get_all_adjustments_from_json(&js, false, None);
            let mut mask_bitmaps = Vec::new();
            adjustments.relight_depth_layer = mask_bitmaps.len() as i32;
            mask_bitmaps.push(two_region_depth.clone());

            render_core::render(
                &ctx,
                OwnedRenderCaches::default().as_ref(),
                &base,
                1,
                RenderRequest {
                    adjustments,
                    mask_bitmaps: &mask_bitmaps,
                    lut: None,
                    roi: None,
                },
                "relight_puck_over_background_test",
                false,
                None,
            )
            .expect("relight render")
            .to_rgba8()
            .into_raw()
        };

        // Puck at x=15% (left half — over the "background"), a large radius
        // so falloff alone doesn't explain any lack of effect on the right
        // half, and the default distance (85) an "Add Light" would actually
        // ship with.
        let lit = render_with(json!({
            "kind": "key", "x": 15.0, "y": 50.0, "radius": 90.0, "distance": 85.0,
            "intensity": 150.0, "color": "#ffffff", "visible": true,
        }));
        let unlit = render_with(json!({
            "kind": "key", "x": 15.0, "y": 50.0, "radius": 90.0, "distance": 85.0,
            "intensity": 0.0, "color": "#ffffff", "visible": true,
        }));

        // Compare only the right half (the "subject" the puck never sits
        // over) — the left half legitimately differs too, that's not what
        // this test is checking.
        let rgba = |buf: &[u8]| -> Vec<[u8; 4]> {
            buf.chunks_exact(4).map(|p| [p[0], p[1], p[2], p[3]]).collect()
        };
        let lit_px = rgba(&lit);
        let unlit_px = rgba(&unlit);
        let mut subject_half_differs = false;
        for y in 0..H {
            for x in (W / 2)..W {
                let i = (y * W + x) as usize;
                if lit_px[i] != unlit_px[i] {
                    subject_half_differs = true;
                    break;
                }
            }
        }
        assert!(
            subject_half_differs,
            "a light parked over background produced zero shading on the subject elsewhere in frame"
        );
    }

    /// D-077 regression test: `relight_normal_layer` actually changes the
    /// shading in the real shader, not just compiles. Builds two renders with
    /// IDENTICAL lights and depth, differing only in whether a baked normal
    /// (X/Y/Z, three extra `mask_bitmaps` layers) is bound — a flat depth map
    /// (so the depth-derived fallback normal is uniformly straight-on) paired
    /// with a baked normal that leans hard to one side proves the shader is
    /// really reading the baked layers, not silently falling back.
    #[test]
    fn baked_normal_layer_changes_shading_vs_the_depth_derived_fallback() {
        use crate::gpu_processing::RenderRequest;
        use crate::image_processing::get_all_adjustments_from_json;
        use crate::render_core::{self, OwnedRenderCaches};
        use image::{DynamicImage, GrayImage, Luma, RgbImage};

        let Ok(ctx) = render_core::init_gpu_context() else {
            eprintln!(
                "skip: no GPU adapter available for baked_normal_layer_changes_shading_vs_the_depth_derived_fallback"
            );
            return;
        };

        const W: u32 = 64;
        const H: u32 = 64;

        let base = DynamicImage::ImageRgb8(RgbImage::from_fn(W, H, |x, y| {
            image::Rgb([((x * 4) % 255) as u8, ((y * 4) % 255) as u8, 128])
        }));
        // Flat depth: the fallback normal (`relight_normal`'s finite
        // difference) is uniformly (0, 0, 1) — straight at the camera.
        let flat_depth = GrayImage::from_pixel(W, H, Luma([180]));
        // A baked normal leaning hard toward +X (right), encoded the same
        // way `ai/server.py`'s `_normal_to_b64` does: (n + 1) / 2 * 255.
        // (nx, ny, nz) = (0.8, 0.0, 0.6), a real unit vector, clearly NOT
        // straight-on — if the shader reads this instead of the flat
        // fallback, the render must differ.
        let normal_x = GrayImage::from_pixel(W, H, Luma([((0.8 + 1.0) / 2.0 * 255.0) as u8]));
        let normal_y = GrayImage::from_pixel(W, H, Luma([((0.0 + 1.0) / 2.0 * 255.0) as u8]));
        let normal_z = GrayImage::from_pixel(W, H, Luma([((0.6 + 1.0) / 2.0 * 255.0) as u8]));

        let light_js = json!({
            "relightLights": [
                { "kind": "key", "x": 30.0, "y": 50.0, "radius": 80.0, "distance": 85.0,
                  "intensity": 150.0, "color": "#ffffff", "visible": true },
            ]
        });

        let render = |with_baked_normal: bool| -> Vec<u8> {
            let mut adjustments = get_all_adjustments_from_json(&light_js, false, None);
            let mut mask_bitmaps = vec![flat_depth.clone()];
            adjustments.relight_depth_layer = 0;
            if with_baked_normal {
                adjustments.relight_normal_layer = mask_bitmaps.len() as i32;
                mask_bitmaps.push(normal_x.clone());
                mask_bitmaps.push(normal_y.clone());
                mask_bitmaps.push(normal_z.clone());
            }

            render_core::render(
                &ctx,
                OwnedRenderCaches::default().as_ref(),
                &base,
                1,
                RenderRequest {
                    adjustments,
                    mask_bitmaps: &mask_bitmaps,
                    lut: None,
                    roi: None,
                },
                "relight_baked_normal_test",
                false,
                None,
            )
            .expect("relight render")
            .to_rgba8()
            .into_raw()
        };

        let with_fallback_normal = render(false);
        let with_baked_normal = render(true);
        assert_ne!(
            with_fallback_normal, with_baked_normal,
            "binding a baked normal map produced identical output to the depth-derived \
             fallback — relight_normal_layer isn't actually being read"
        );
    }
}
