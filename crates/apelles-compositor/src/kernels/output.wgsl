// output (D-452): the finished canvas → the planes of an encoder's pixel
// buffer, written into row-padded staging buffers the frame then copies into
// the buffer's IOSurface textures (`copy_buffer_to_texture` needs rows of a
// multiple of 256 bytes, which a video width need not be).
//
// - `luma` / `chroma`: Rec.709 Y'CbCr, video range, 4:2:0, chroma the mean of
//   each 2×2 block (centred, as the decoder side reconstructs it). Each word of
//   `y_out` is 4 luma bytes; each word of `c_out` is 2 CbCr pairs.
// - `bgra`: the canvas with red and blue swapped, for the ProRes encoder,
//   which converts to its own 4:2:2 10-bit itself.

struct Params {
    width: u32,
    height: u32,
    // Row pitch of the destination plane, in 32-bit words.
    pitch_words: u32,
    _pad: u32,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> canvas: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;

const KR: f32 = 0.2126;
const KB: f32 = 0.0722;
const KG: f32 = 0.7152;

fn rgb_at(x: u32, y: u32) -> vec3<f32> {
    let c = unpack(canvas[min(y, p.height - 1u) * p.width + min(x, p.width - 1u)]);
    return c.xyz / 255.0;
}

fn luma_code(c: vec3<f32>) -> u32 {
    let y = KR * c.x + KG * c.y + KB * c.z;
    return u32(clamp(round_half_up(16.0 + 219.0 * y), 0.0, 255.0));
}

// One invocation writes four luma samples (one word).
@compute @workgroup_size(16, 16)
fn luma(@builtin(global_invocation_id) id: vec3<u32>) {
    let x0 = id.x * 4u;
    if (x0 >= p.width || id.y >= p.height) {
        return;
    }
    var word = 0u;
    for (var i = 0u; i < 4u; i++) {
        word = word | (luma_code(rgb_at(x0 + i, id.y)) << (8u * i));
    }
    dst[id.y * p.pitch_words + id.x] = word;
}

fn chroma_pair(cx: u32, cy: u32) -> u32 {
    let x = cx * 2u;
    let y = cy * 2u;
    let c = (rgb_at(x, y) + rgb_at(x + 1u, y) + rgb_at(x, y + 1u) + rgb_at(x + 1u, y + 1u)) / 4.0;
    let yy = KR * c.x + KG * c.y + KB * c.z;
    let cb = (c.z - yy) / (2.0 * (1.0 - KB));
    let cr = (c.x - yy) / (2.0 * (1.0 - KR));
    let ucb = u32(clamp(round_half_up(128.0 + 224.0 * cb), 0.0, 255.0));
    let ucr = u32(clamp(round_half_up(128.0 + 224.0 * cr), 0.0, 255.0));
    return ucb | (ucr << 8u);
}

// One invocation writes two CbCr pairs (one word) of the half-size plane.
@compute @workgroup_size(16, 16)
fn chroma(@builtin(global_invocation_id) id: vec3<u32>) {
    let cw = (p.width + 1u) / 2u;
    let ch = (p.height + 1u) / 2u;
    let cx0 = id.x * 2u;
    if (cx0 >= cw || id.y >= ch) {
        return;
    }
    var word = chroma_pair(cx0, id.y);
    if (cx0 + 1u < cw) {
        word = word | (chroma_pair(cx0 + 1u, id.y) << 16u);
    }
    dst[id.y * p.pitch_words + id.x] = word;
}

@compute @workgroup_size(16, 16)
fn bgra(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= p.width || id.y >= p.height) {
        return;
    }
    let c = canvas[id.y * p.width + id.x];
    let swapped = (c & 0xff00ff00u) | ((c & 0xffu) << 16u) | ((c >> 16u) & 0xffu);
    dst[id.y * p.pitch_words + id.x] = swapped;
}
