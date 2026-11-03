// adjust: an adjustment clip's colour operator (D-230) over the whole canvas,
// in place, from the host's tables (`tables::adjust_tables`): stage 1 is a
// per-channel table lookup (the CPU's f64 gain/offset, floored), stage 2 a sum
// of three fixed-point products, rounded. Alpha is untouched.

const STAGE2_SHIFT: u32 = 18u;

struct Params {
    pixels: u32,
    row_w: u32,
    _pad0: u32,
    _pad1: u32,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> stage1: array<u32>;
@group(0) @binding(2) var<storage, read> stage2: array<i32>;
@group(0) @binding(3) var<storage, read_write> canvas: array<u32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let i = id.y * p.row_w + id.x;
    if (id.x >= p.row_w || i >= p.pixels) {
        return;
    }
    let w = canvas[i];
    let s = vec3<u32>(
        stage1[w & 0xffu],
        stage1[256u + ((w >> 8u) & 0xffu)],
        stage1[512u + ((w >> 16u) & 0xffu)],
    );
    var out: vec3<u32>;
    for (var ch = 0u; ch < 3u; ch++) {
        let base = ch * 3u * 256u;
        let sum = stage2[base + s.x] + stage2[base + 256u + s.y] + stage2[base + 512u + s.z];
        let r = (sum + (1 << (STAGE2_SHIFT - 1u))) >> STAGE2_SHIFT;
        out[ch] = u32(clamp(r, 0, 255));
    }
    canvas[i] = out.x | (out.y << 8u) | (out.z << 16u) | (w & 0xff000000u);
}
