// The preview presenter's two passes (D-451, D-454; presenter.rs).
//
// - `fs_unpack`: the engine's packed canvas (one u32 per pixel, R in the low
//   byte, row-major, no row padding) into the presenter's retained frame
//   texture of the same size, pixel for pixel, bytes unchanged.
// - `fs_present`: the retained frame into its picture box inside the
//   drawable, with a linear filter, and the preview background around it.
//
// The frame's bytes are display-referred 8-bit R'G'B' and reach the
// (non-sRGB) drawable unchanged; the layer's colour space tag (Rec.709) says
// how the window server interprets them.

struct Params {
    // The picture box in target pixels: x, y, width, height. It can extend
    // past the drawable when the preview is zoomed in.
    picture: vec4<f32>,
    // The background, as 0-1 display-referred values.
    background: vec4<f32>,
    // The source frame's size in pixels.
    src_size: vec2<u32>,
    _pad: vec2<u32>,
};

@group(0) @binding(0) var<uniform> params: Params;

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    // One triangle covering the whole target.
    let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
    let y = f32(i & 2u) * 2.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

// ---- the retained frame into the drawable ----------------------------------

@group(0) @binding(1) var src_tex: texture_2d<f32>;
@group(0) @binding(2) var src_smp: sampler;

@fragment
fn fs_present(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let uv = (pos.xy - params.picture.xy) / params.picture.zw;
    if uv.x < 0.0 || uv.y < 0.0 || uv.x >= 1.0 || uv.y >= 1.0 {
        return params.background;
    }
    let c = textureSampleLevel(src_tex, src_smp, uv, 0.0);
    return vec4<f32>(c.rgb, 1.0);
}

// ---- the engine's canvas into the retained frame ----------------------------

@group(0) @binding(3) var<storage, read> src_buf: array<u32>;

@fragment
fn fs_unpack(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    // `pos.xy` is the pixel centre (x + 0.5, y + 0.5) of a target exactly the
    // canvas's size, so this is the canvas's own pixel.
    let x = u32(pos.x);
    let y = u32(pos.y);
    let c = unpack4x8unorm(src_buf[y * params.src_size.x + x]);
    return vec4<f32>(c.rgb, 1.0);
}
