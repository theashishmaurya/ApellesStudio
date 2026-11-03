// sample: the fused path (D-217) — crop, bilinear magnify, rounded corners,
// opacity and source-over in one pass over the canvas pixels the box covers.
//
// The taps (which two texels, and how far between them) come from the host
// (`tables::sample_tables`, the CPU compositor's own f64 expressions), so this
// kernel only interpolates and blends.

struct Params {
    canvas_w: u32,
    win_x0: u32,
    win_y0: u32,
    win_w: u32,
    win_h: u32,
    layer_w: u32,   // the prepared crop's width (its row stride)
    origin_x: i32,
    origin_y: i32,
    box_w: f32,
    box_h: f32,
    opacity: f32,
    radius: f32,    // <= 0: square
};

struct Tap {
    i0: u32,
    i1: u32,
    frac: f32,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> layer: array<u32>;
@group(0) @binding(2) var<storage, read> cols: array<Tap>;
@group(0) @binding(3) var<storage, read> rows: array<Tap>;
@group(0) @binding(4) var<storage, read_write> canvas: array<u32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= p.win_w || id.y >= p.win_h) {
        return;
    }
    let c = cols[id.x];
    let r = rows[id.y];
    let p00 = unpack(layer[r.i0 * p.layer_w + c.i0]);
    let p10 = unpack(layer[r.i0 * p.layer_w + c.i1]);
    let p01 = unpack(layer[r.i1 * p.layer_w + c.i0]);
    let p11 = unpack(layer[r.i1 * p.layer_w + c.i1]);
    let top = p00 + (p10 - p00) * c.frac;
    let bot = p01 + (p11 - p01) * c.frac;
    let o = top + (bot - top) * r.frac;

    let px = i32(p.win_x0 + id.x);
    let py = i32(p.win_y0 + id.y);
    var cov = 1.0;
    if (p.radius > 0.0) {
        cov = coverage(f32(px - p.origin_x), f32(py - p.origin_y), p.box_w, p.box_h, p.radius);
    }
    let a = u32(clamp(round_half_up(max(o.w * p.opacity * cov, 0.0)), 0.0, 255.0));
    if (a == 0u) {
        return;
    }
    let rgb = to_u8(o);
    let i = u32(py) * p.canvas_w + u32(px);
    canvas[i] = blend(canvas[i], vec4<u32>(rgb.xyz, a));
}
