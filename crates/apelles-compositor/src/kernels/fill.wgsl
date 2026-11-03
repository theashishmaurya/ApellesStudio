// fill: every canvas pixel set to one packed RGBA8 value (the opaque-black
// start of every timeline frame).

struct Params {
    pixels: u32,
    row_w: u32,
    value: u32,
    _pad0: u32,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read_write> canvas: array<u32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let i = id.y * p.row_w + id.x;
    if (id.x >= p.row_w || i >= p.pixels) {
        return;
    }
    canvas[i] = p.value;
}
