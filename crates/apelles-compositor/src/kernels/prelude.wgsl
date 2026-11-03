// apelles-compositor (D-449): helpers shared by every kernel.
//
// Pixels live in storage buffers as packed RGBA8 words, red in the low byte,
// which is the byte order of an `image::RgbaImage` read as little-endian u32.
// No texture samplers anywhere: hardware samplers quantise their filter weights
// to fixed point, and every weight here has to be the CPU compositor's own.

const WG: u32 = 16u;

fn unpack(p: u32) -> vec4<f32> {
    return vec4<f32>(
        f32(p & 0xffu),
        f32((p >> 8u) & 0xffu),
        f32((p >> 16u) & 0xffu),
        f32(p >> 24u),
    );
}

fn pack(c: vec4<u32>) -> u32 {
    return c.x | (c.y << 8u) | (c.z << 16u) | (c.w << 24u);
}

// Rust's `f32::round` (half away from zero) for x >= 0. WGSL's `round` rounds
// half to even, which would disagree with the CPU on every exact .5.
fn round_half_up(x: f32) -> f32 {
    let f = floor(x);
    return select(f, f + 1.0, x - f >= 0.5);
}

// `(v.round().clamp(0, 255)) as u8`, per channel.
fn to_u8(v: vec4<f32>) -> vec4<u32> {
    return vec4<u32>(
        u32(clamp(round_half_up(max(v.x, 0.0)), 0.0, 255.0)),
        u32(clamp(round_half_up(max(v.y, 0.0)), 0.0, 255.0)),
        u32(clamp(round_half_up(max(v.z, 0.0)), 0.0, 255.0)),
        u32(clamp(round_half_up(max(v.w, 0.0)), 0.0, 255.0)),
    );
}

// `image::Rgba<u8>::blend` (image 0.25), the source-over the CPU compositor
// used everywhere: straight (not premultiplied) alpha, every channel divided
// by 255 first, and the result TRUNCATED back to u8, not rounded.
fn blend(dst: u32, src: vec4<u32>) -> u32 {
    if (src.w == 0u) {
        return dst;
    }
    if (src.w == 255u) {
        return pack(src);
    }
    let bg = unpack(dst) / 255.0;
    let fg = vec4<f32>(src) / 255.0;
    let a = bg.w + fg.w - bg.w * fg.w;
    if (a == 0.0) {
        return dst;
    }
    let out_r = (fg.x * fg.w + bg.x * bg.w * (1.0 - fg.w)) / a;
    let out_g = (fg.y * fg.w + bg.y * bg.w * (1.0 - fg.w)) / a;
    let out_b = (fg.z * fg.w + bg.z * bg.w * (1.0 - fg.w)) / a;
    return pack(vec4<u32>(
        u32(255.0 * out_r),
        u32(255.0 * out_g),
        u32(255.0 * out_b),
        u32(255.0 * a),
    ));
}

// `apelles_types::shape::rounded_box_coverage` (D-344): the rounded-box signed
// distance field, a one-pixel linear ramp across the edge.
fn coverage(x: f32, y: f32, w: f32, h: f32, radius: f32) -> f32 {
    let r = min(max(radius, 0.0), min(w, h) / 2.0);
    let qx = abs(x + 0.5 - w / 2.0) - (w / 2.0 - r);
    let qy = abs(y + 0.5 - h / 2.0) - (h / 2.0 - r);
    let sd = length(vec2<f32>(max(qx, 0.0), max(qy, 0.0))) + min(max(qx, qy), 0.0) - r;
    return clamp(0.5 - sd, 0.0, 1.0);
}
