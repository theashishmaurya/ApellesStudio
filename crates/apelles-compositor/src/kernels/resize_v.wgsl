// resize_v: the general path's separable Triangle resample, `image::imageops::
// resize` (0.25) pass for pass. Vertical first, from the 8-bit crop into an f32
// intermediate (no rounding between passes, as `image` keeps it), then
// horizontal into the box-sized 8-bit buffer, rounded (`FloatNearest`) after a
// clamp. The weights are the host's (`tables::triangle_weights`), summed in the
// same order the CPU sums them.
//
// The horizontal pass also rounds the box's corners (D-344), because that is
// the next thing the CPU did to the same buffer: alpha × coverage, rounded.

struct Params {
    in_w: u32,      // the source rows' width (vertical: crop width; horizontal: intermediate width)
    out_w: u32,
    out_h: u32,
    radius: f32,    // horizontal pass only; <= 0: square
};

struct Span {
    left: u32,
    count: u32,
    offset: u32,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> spans: array<Span>;
@group(0) @binding(2) var<storage, read> weights: array<f32>;

// --- vertical: packed RGBA8 → vec4<f32> ------------------------------------
@group(0) @binding(3) var<storage, read> v_in: array<u32>;
@group(0) @binding(4) var<storage, read_write> v_out: array<vec4<f32>>;

@compute @workgroup_size(16, 16)
fn vertical(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= p.out_w || id.y >= p.out_h) {
        return;
    }
    let s = spans[id.y];
    var t = vec4<f32>(0.0);
    for (var i = 0u; i < s.count; i++) {
        t += unpack(v_in[(s.left + i) * p.in_w + id.x]) * weights[s.offset + i];
    }
    v_out[id.y * p.out_w + id.x] = t;
}
