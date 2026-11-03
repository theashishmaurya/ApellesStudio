// prepare: a layer's source → its crop, as packed RGBA8, graded.
//
// Widens an RGB8 source (decode_pipe's format) to RGBA on the GPU, fills a
// solid plate, and applies the clip's baked Colorist grade (D-256) exactly as
// `Lut3d::apply_rgb8` does: /255, clamp, trilinear in f32 with red fastest,
// clamp, x255, round. Only the crop is produced: a 3D LUT is per-pixel, so
// grading the crop is grading the whole picture and then cropping it.

struct Params {
    src_w: u32,
    kind: u32,      // 0 = RGBA8, 1 = RGB8, 2 = solid
    crop_x0: u32,
    crop_y0: u32,
    crop_w: u32,
    crop_h: u32,
    lut_n: u32,     // 0 = no grade
    solid: u32,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read> lut: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<u32>;

fn src_byte(i: u32) -> u32 {
    return (src[i >> 2u] >> ((i & 3u) * 8u)) & 0xffu;
}

fn lattice(r: u32, g: u32, b: u32) -> vec3<f32> {
    let n = p.lut_n;
    let i = ((b * n + g) * n + r) * 3u;
    return vec3<f32>(lut[i], lut[i + 1u], lut[i + 2u]);
}

fn grade(c: vec3<u32>) -> vec3<u32> {
    let last = p.lut_n - 1u;
    let scale = f32(last);
    var lo: vec3<u32>;
    var hi: vec3<u32>;
    var fr: vec3<f32>;
    for (var k = 0u; k < 3u; k++) {
        let v = clamp(f32(c[k]) / 255.0, 0.0, 1.0) * scale;
        let f = floor(v);
        let i = min(u32(f), last);
        lo[k] = i;
        hi[k] = min(i + 1u, last);
        fr[k] = v - f;
    }
    let c00 = mix_exact(lattice(lo.x, lo.y, lo.z), lattice(hi.x, lo.y, lo.z), fr.x);
    let c01 = mix_exact(lattice(lo.x, lo.y, hi.z), lattice(hi.x, lo.y, hi.z), fr.x);
    let c10 = mix_exact(lattice(lo.x, hi.y, lo.z), lattice(hi.x, hi.y, lo.z), fr.x);
    let c11 = mix_exact(lattice(lo.x, hi.y, hi.z), lattice(hi.x, hi.y, hi.z), fr.x);
    let c0 = mix_exact(c00, c10, fr.y);
    let c1 = mix_exact(c01, c11, fr.y);
    let o = mix_exact(c0, c1, fr.z);
    return vec3<u32>(
        u32(round_half_up(clamp(o.x, 0.0, 1.0) * 255.0)),
        u32(round_half_up(clamp(o.y, 0.0, 1.0) * 255.0)),
        u32(round_half_up(clamp(o.z, 0.0, 1.0) * 255.0)),
    );
}

// `a + (b - a) * t`, the CPU's lerp, spelled out rather than `mix` (which a
// backend may evaluate as `a * (1 - t) + b * t`).
fn mix_exact(a: vec3<f32>, b: vec3<f32>, t: f32) -> vec3<f32> {
    return a + (b - a) * t;
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= p.crop_w || id.y >= p.crop_h) {
        return;
    }
    let sx = p.crop_x0 + id.x;
    let sy = p.crop_y0 + id.y;
    var c: vec4<u32>;
    if (p.kind == 0u) {
        let w = src[sy * p.src_w + sx];
        c = vec4<u32>(w & 0xffu, (w >> 8u) & 0xffu, (w >> 16u) & 0xffu, w >> 24u);
    } else if (p.kind == 1u) {
        let b = (sy * p.src_w + sx) * 3u;
        c = vec4<u32>(src_byte(b), src_byte(b + 1u), src_byte(b + 2u), 255u);
    } else {
        let w = p.solid;
        c = vec4<u32>(w & 0xffu, (w >> 8u) & 0xffu, (w >> 16u) & 0xffu, w >> 24u);
    }
    if (p.lut_n > 1u) {
        let g = grade(c.xyz);
        c = vec4<u32>(g, c.w);
    }
    dst[id.y * p.crop_w + id.x] = pack(c);
}
