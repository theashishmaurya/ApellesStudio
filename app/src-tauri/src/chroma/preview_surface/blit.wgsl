// The preview presenter's one pass (D-451): place the frame in its picture box
// inside the drawable and fill the rest with the preview background. The
// frame's bytes are display-referred 8-bit R'G'B' and are written to the
// (non-sRGB) drawable unchanged; the layer's colour space tag says how the
// window server interprets them. Two entry points, one per source kind
// (`FrameSource` in presenter.rs); each pipeline binds only its own resources.

struct Params {
    // The picture box in drawable pixels: x, y, width, height. It can extend
    // past the drawable when the preview is zoomed in.
    picture: vec4<f32>,
    // The background, as 0-1 display-referred values (the preview pane's own
    // background colour).
    background: vec4<f32>,
    // The source frame's size in pixels (packed-buffer source only).
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

fn picture_uv(pos: vec4<f32>) -> vec2<f32> {
    return (pos.xy - params.picture.xy) / params.picture.zw;
}

fn outside(uv: vec2<f32>) -> bool {
    return uv.x < 0.0 || uv.y < 0.0 || uv.x >= 1.0 || uv.y >= 1.0;
}

// ---- source: a texture (Rgba8Unorm, filterable) ----------------------------

@group(0) @binding(1) var src_tex: texture_2d<f32>;
@group(0) @binding(2) var src_smp: sampler;

@fragment
fn fs_texture(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let uv = picture_uv(pos);
    if outside(uv) {
        return params.background;
    }
    let c = textureSampleLevel(src_tex, src_smp, uv, 0.0);
    return vec4<f32>(c.rgb, 1.0);
}

// ---- source: the engine's packed canvas (one u32 per pixel, R in the low
// byte, row-major, no row padding — `apelles-compositor`'s canvas buffer) ---

@group(0) @binding(3) var<storage, read> src_buf: array<u32>;

fn texel(x: i32, y: i32) -> vec4<f32> {
    let w = i32(params.src_size.x);
    let h = i32(params.src_size.y);
    let cx = clamp(x, 0, w - 1);
    let cy = clamp(y, 0, h - 1);
    return unpack4x8unorm(src_buf[u32(cy * w + cx)]);
}

@fragment
fn fs_packed(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let uv = picture_uv(pos);
    if outside(uv) {
        return params.background;
    }
    // Bilinear, texel centres at +0.5, clamped at the edges: the same filter
    // the texture path's linear sampler applies.
    let p = uv * vec2<f32>(params.src_size) - 0.5;
    let base = floor(p);
    let f = p - base;
    let x0 = i32(base.x);
    let y0 = i32(base.y);
    let top = mix(texel(x0, y0), texel(x0 + 1, y0), f.x);
    let bottom = mix(texel(x0, y0 + 1), texel(x0 + 1, y0 + 1), f.x);
    let c = mix(top, bottom, f.y);
    return vec4<f32>(c.rgb, 1.0);
}
