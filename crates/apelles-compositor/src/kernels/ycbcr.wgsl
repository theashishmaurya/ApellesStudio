// ycbcr (D-452): a decoded video frame's two Y'CbCr planes → the crop of it, as
// packed RGBA8 (the layout every other kernel reads).
//
// The planes are the decoder's own IOSurface, imported as unsigned-integer
// textures (8-bit, or 10-bit in the high bits of 16), so every sample is the
// exact code value; no sampler touches them. Chroma is reconstructed with a
// bilinear fetch at the sample's position (`chroma_x0`/`chroma_y0` are the
// siting offsets in chroma samples), the matrix and range are the source's,
// and the result rounds half away from zero, as every kernel here does.

struct Params {
    crop_x0: u32,
    crop_y0: u32,
    crop_w: u32,
    crop_h: u32,
    // log2 of the chroma subsampling per axis (4:2:0 = 1, 1).
    shift_x: u32,
    shift_y: u32,
    // Right shift turning a stored sample into its code value (6 for 10-bit
    // in 16, 0 for 8-bit).
    sample_shift: u32,
    _pad: u32,
    // y' = (Y - y_off) * y_scale, c' = (C - c_off) * c_scale, in code values.
    y_off: f32,
    y_scale: f32,
    c_off: f32,
    c_scale: f32,
    // R = y' + r_cr·cr', G = y' + g_cb·cb' + g_cr·cr', B = y' + b_cb·cb'.
    r_cr: f32,
    g_cb: f32,
    g_cr: f32,
    b_cb: f32,
    // Chroma siting: the luma position of chroma sample 0, in chroma samples
    // (0 = co-sited, -0.25 = the 4:2:0 vertical centre between two rows).
    chroma_x0: f32,
    chroma_y0: f32,
    _pad2: vec2<f32>,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var luma: texture_2d<u32>;
@group(0) @binding(2) var chroma: texture_2d<u32>;
@group(0) @binding(3) var<storage, read_write> dst: array<u32>;

fn chroma_at(x: i32, y: i32) -> vec2<f32> {
    let size = vec2<i32>(textureDimensions(chroma));
    let c = textureLoad(chroma, clamp(vec2<i32>(x, y), vec2<i32>(0), size - 1), 0);
    return vec2<f32>(f32(c.x >> p.sample_shift), f32(c.y >> p.sample_shift));
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= p.crop_w || id.y >= p.crop_h) {
        return;
    }
    let x = p.crop_x0 + id.x;
    let y = p.crop_y0 + id.y;
    let yv = f32(textureLoad(luma, vec2<u32>(x, y), 0).x >> p.sample_shift);

    // This pixel's position in chroma samples, then a bilinear fetch.
    let cx = (f32(x) + 0.5) / f32(1u << p.shift_x) - 0.5 + p.chroma_x0;
    let cy = (f32(y) + 0.5) / f32(1u << p.shift_y) - 0.5 + p.chroma_y0;
    let fx = floor(cx);
    let fy = floor(cy);
    let tx = cx - fx;
    let ty = cy - fy;
    let ix = i32(fx);
    let iy = i32(fy);
    let c00 = chroma_at(ix, iy);
    let c10 = chroma_at(ix + 1, iy);
    let c01 = chroma_at(ix, iy + 1);
    let c11 = chroma_at(ix + 1, iy + 1);
    let top = c00 + (c10 - c00) * tx;
    let bottom = c01 + (c11 - c01) * tx;
    let c = top + (bottom - top) * ty;

    let yy = (yv - p.y_off) * p.y_scale;
    let cb = (c.x - p.c_off) * p.c_scale;
    let cr = (c.y - p.c_off) * p.c_scale;
    let rgb = vec3<f32>(
        yy + p.r_cr * cr,
        yy + p.g_cb * cb + p.g_cr * cr,
        yy + p.b_cb * cb,
    );
    let o = vec3<u32>(
        u32(round_half_up(clamp(rgb.x, 0.0, 1.0) * 255.0)),
        u32(round_half_up(clamp(rgb.y, 0.0, 1.0) * 255.0)),
        u32(round_half_up(clamp(rgb.z, 0.0, 1.0) * 255.0)),
    );
    dst[id.y * p.crop_w + id.x] = pack(vec4<u32>(o, 255u));
}
