// to_f16: a source's pixels into an Rgba16Float texture, for a pass that
// reads one (the Colorist's grade shader, D-450).
//
// Each 8-bit channel becomes the half-float nearest to `v / 255`: the value
// `image`'s `to_rgba32f` followed by `half::f16::from_f32` gives on the CPU,
// which is how the Colorist itself fills this texture
// (`gpu_processing::to_rgba_f16`). The 256 possible values are rounded on the
// CPU and looked up here (`half_of_u8`), because the GPU's own float-to-half
// store does not round to nearest (measured on Apple silicon: it truncates,
// one ulp low on 1,599 of 4,096 test values). A value that is already a
// half-float is stored exactly whatever the hardware's rounding.

struct Params {
    src_w: u32,     // the source's row length in pixels
    kind: u32,      // 0 = RGBA8, 1 = RGB8
    width: u32,
    height: u32,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var<storage, read> half_of_u8: array<f32, 256>;

fn src_byte(i: u32) -> u32 {
    return (src[i >> 2u] >> ((i & 3u) * 8u)) & 0xffu;
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= p.width || id.y >= p.height) {
        return;
    }
    var c: vec4<u32>;
    if (p.kind == 0u) {
        let w = src[id.y * p.src_w + id.x];
        c = vec4<u32>(w & 0xffu, (w >> 8u) & 0xffu, (w >> 16u) & 0xffu, w >> 24u);
    } else {
        let b = (id.y * p.src_w + id.x) * 3u;
        c = vec4<u32>(src_byte(b), src_byte(b + 1u), src_byte(b + 2u), 255u);
    }
    textureStore(dst, id.xy, vec4<f32>(half_of_u8[c.x], half_of_u8[c.y], half_of_u8[c.z], half_of_u8[c.w]));
}
