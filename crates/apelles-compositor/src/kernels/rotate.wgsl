// rotate: the general path's rotation about the box's centre, `imageproc::
// geometric_transformations::rotate_about_center` with bilinear interpolation
// and a transparent border, on the box as rgba32f (u8 / 255), converted back to
// RGBA8 as `image`'s `to_rgba8` does (clamp, × 255, round). The output buffer is
// the input's size, so corners rotated out of it are cut, as on the CPU. The
// inverse map comes from the host (`tables::rotation_inverse`).

struct Params {
    w: u32,
    h: u32,
    _pad0: u32,
    _pad1: u32,
    m0: f32,
    m1: f32,
    m2: f32,
    m3: f32,
    m4: f32,
    m5: f32,
    _pad2: f32,
    _pad3: f32,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> r_in: array<u32>;
@group(0) @binding(2) var<storage, read_write> r_out: array<u32>;

fn texel(x: i32, y: i32) -> vec4<f32> {
    if (x < 0 || y < 0 || x >= i32(p.w) || y >= i32(p.h)) {
        return vec4<f32>(0.0);
    }
    return unpack(r_in[u32(y) * p.w + u32(x)]) / 255.0;
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= p.w || id.y >= p.h) {
        return;
    }
    let x = f32(id.x);
    let y = f32(id.y);
    let sx = p.m0 * x + p.m1 * y + p.m2;
    let sy = p.m3 * x + p.m4 * y + p.m5;
    let left = floor(sx);
    let top = floor(sy);
    let rw = sx - left;
    let bw = sy - top;
    let l = i32(left);
    let t = i32(top);
    let tl = texel(l, t);
    let tr = texel(l + 1, t);
    let bl = texel(l, t + 1);
    let br = texel(l + 1, t + 1);
    let upper = (1.0 - rw) * tl + rw * tr;
    let lower = (1.0 - rw) * bl + rw * br;
    let v = (1.0 - bw) * upper + bw * lower;
    let c = clamp(v, vec4<f32>(0.0), vec4<f32>(1.0)) * 255.0;
    r_out[id.y * p.w + id.x] = pack(vec4<u32>(
        u32(round_half_up(c.x)),
        u32(round_half_up(c.y)),
        u32(round_half_up(c.z)),
        u32(round_half_up(c.w)),
    ));
}
