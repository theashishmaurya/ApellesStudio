// overlay: the general path's last step — the prepared box onto the canvas at
// its rounded top-left, opacity multiplied into alpha and rounded first (the
// CPU compositor's opacity pass), then `image`'s source-over. Only the window
// where box and canvas overlap is dispatched.

struct Params {
    canvas_w: u32,
    win_x0: u32,
    win_y0: u32,
    win_w: u32,
    win_h: u32,
    box_w: u32,
    origin_x: i32,
    origin_y: i32,
    opacity: f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> box: array<u32>;
@group(0) @binding(2) var<storage, read_write> canvas: array<u32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= p.win_w || id.y >= p.win_h) {
        return;
    }
    let px = i32(p.win_x0 + id.x);
    let py = i32(p.win_y0 + id.y);
    let w = box[u32(py - p.origin_y) * p.box_w + u32(px - p.origin_x)];
    var c = vec4<u32>(w & 0xffu, (w >> 8u) & 0xffu, (w >> 16u) & 0xffu, w >> 24u);
    if (p.opacity < 1.0) {
        c.w = u32(clamp(round_half_up(f32(c.w) * p.opacity), 0.0, 255.0));
    }
    let i = u32(py) * p.canvas_w + u32(px);
    canvas[i] = blend(canvas[i], c);
}
