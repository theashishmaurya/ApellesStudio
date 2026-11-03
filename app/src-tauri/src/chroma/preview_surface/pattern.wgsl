// The prototype's GPU test pattern (D-451): stands in for the render engine
// so the presenter can be measured with frames that never touch the CPU.
// Colour bars, a white bar that moves one step per frame (judder and dropped
// frames are visible), and the frame index as 16 binary blocks along the top
// (a still screenshot says which frame is on screen).

struct Params {
    size: vec2<u32>,
    frame: u32,
    _pad: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var out_tex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<storage, read_write> out_buf: array<u32>;

const BARS = array<vec3<f32>, 7>(
    vec3<f32>(0.75, 0.75, 0.75),
    vec3<f32>(0.75, 0.75, 0.0),
    vec3<f32>(0.0, 0.75, 0.75),
    vec3<f32>(0.0, 0.75, 0.0),
    vec3<f32>(0.75, 0.0, 0.75),
    vec3<f32>(0.75, 0.0, 0.0),
    vec3<f32>(0.0, 0.0, 0.75),
);

fn shade(p: vec2<u32>) -> vec4<f32> {
    let w = params.size.x;
    let h = params.size.y;
    var c = BARS[min(p.x * 7u / w, 6u)];
    // A grey ramp in the bottom quarter.
    if p.y > h * 3u / 4u {
        c = vec3<f32>(f32(p.x) / f32(w));
    }
    // The moving bar: 1/120 of the width per frame, 1/60 wide.
    let bar_x = (params.frame * w / 120u) % w;
    if p.x >= bar_x && p.x < bar_x + max(w / 60u, 2u) {
        c = vec3<f32>(1.0);
    }
    // The frame index, bit 15 first, as blocks along the top.
    let block = max(h / 20u, 4u);
    if p.y < block && p.x < block * 16u {
        let bit = 15u - p.x / block;
        let on = (params.frame >> bit) & 1u;
        c = select(vec3<f32>(0.0), vec3<f32>(1.0), on == 1u);
    }
    return vec4<f32>(c, 1.0);
}

@compute @workgroup_size(16, 16)
fn to_texture(@builtin(global_invocation_id) id: vec3<u32>) {
    if id.x >= params.size.x || id.y >= params.size.y {
        return;
    }
    textureStore(out_tex, vec2<i32>(id.xy), shade(id.xy));
}

@compute @workgroup_size(16, 16)
fn to_buffer(@builtin(global_invocation_id) id: vec3<u32>) {
    if id.x >= params.size.x || id.y >= params.size.y {
        return;
    }
    out_buf[id.y * params.size.x + id.x] = pack4x8unorm(shade(id.xy));
}
