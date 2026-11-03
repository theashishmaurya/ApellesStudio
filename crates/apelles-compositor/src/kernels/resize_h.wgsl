// resize_h: the second (horizontal) pass of the general path's Triangle
// resample — see resize_v.wgsl for the whole contract. vec4<f32> rows in,
// packed RGBA8 box out: each channel clamped to 0..255 and rounded half away
// from zero (`image`'s `FloatNearest`), then the corner coverage multiplied
// into alpha and rounded, exactly the CPU compositor's next step.

struct Params {
    in_w: u32,
    out_w: u32,
    out_h: u32,
    radius: f32,
};

struct Span {
    left: u32,
    count: u32,
    offset: u32,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> spans: array<Span>;
@group(0) @binding(2) var<storage, read> weights: array<f32>;
@group(0) @binding(3) var<storage, read> h_in: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> h_out: array<u32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= p.out_w || id.y >= p.out_h) {
        return;
    }
    let s = spans[id.x];
    var t = vec4<f32>(0.0);
    for (var i = 0u; i < s.count; i++) {
        t += h_in[id.y * p.in_w + s.left + i] * weights[s.offset + i];
    }
    var c = vec4<u32>(
        u32(round_half_up(clamp(t.x, 0.0, 255.0))),
        u32(round_half_up(clamp(t.y, 0.0, 255.0))),
        u32(round_half_up(clamp(t.z, 0.0, 255.0))),
        u32(round_half_up(clamp(t.w, 0.0, 255.0))),
    );
    if (p.radius > 0.0) {
        let cov = coverage(f32(id.x), f32(id.y), f32(p.out_w), f32(p.out_h), p.radius);
        if (cov < 1.0) {
            c.w = u32(clamp(round_half_up(f32(c.w) * cov), 0.0, 255.0));
        }
    }
    h_out[id.y * p.out_w + id.x] = pack(c);
}
