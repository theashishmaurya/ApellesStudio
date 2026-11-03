// prepare: a layer's source → its crop, as packed RGBA8.
//
// Widens an RGB8 source (decode_pipe's format) to RGBA on the GPU and fills a
// solid plate. A source already on the GPU (`Source::Gpu`, e.g. a clip graded
// by the Colorist's shader, D-450) is read as RGBA8 with its own row stride
// as `src_w`. Only the crop is produced.

struct Params {
    src_w: u32,     // the source's row length in pixels (its stride)
    kind: u32,      // 0 = RGBA8, 1 = RGB8, 2 = solid
    crop_x0: u32,
    crop_y0: u32,
    crop_w: u32,
    crop_h: u32,
    solid: u32,
    _pad: u32,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;

fn src_byte(i: u32) -> u32 {
    return (src[i >> 2u] >> ((i & 3u) * 8u)) & 0xffu;
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
    dst[id.y * p.crop_w + id.x] = pack(c);
}
