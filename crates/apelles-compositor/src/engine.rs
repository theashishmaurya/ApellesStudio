//! **The engine: one wgpu device, the kernels, and the buffers they use**
//! (D-449).
//!
//! What it is: [`Engine::render`] turns a [`FramePlan`] into finished RGBA8
//! pixels. One call is one command buffer and one submission: the layers are
//! uploaded, each step's kernels are recorded in paint order, the canvas is
//! copied to a staging buffer, and the call waits for that submission alone
//! (other threads' frames on the same device are not waited for).
//!
//! What it does NOT do: decode, rasterise text, or know what a clip is. It
//! does not fall back to anything: a device that cannot be opened, a plan that
//! exceeds the device's limits, a validation error or a GPU that does not
//! answer within [`GPU_TIMEOUT`] is a [`ComposeError`] the caller surfaces.
//!
//! **Thread-safe by design, and why that matters here.** The live preview and
//! every export segment worker draw through one process-wide engine at the same
//! time. Each call takes its buffers out of the pool for its own exclusive use
//! and returns them only after its submission has completed, so two calls never
//! share a buffer mid-frame; the queue's `write_buffer` uploads are ordered
//! before any later submission, whichever thread makes it.
//!
//! **Deterministic.** Every kernel writes each output pixel exactly once, from
//! inputs it does not write, with a fixed summation order: no atomics, no
//! reductions across invocations, nothing scheduled. The same plan on the same
//! device gives the same bytes (`a_frame_renders_to_the_same_bytes_every_time`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use image::RgbaImage;
use wgpu::util::DeviceExt as _;

use crate::plan::{Background, FramePlan, Layer, Source, Step};
use crate::tables;

/// How long one frame may take on the GPU before the device is considered
/// hung. A 4K frame takes a few milliseconds; this is three orders of magnitude
/// above that, so it only ever fires on a real fault.
pub const GPU_TIMEOUT: Duration = Duration::from_secs(20);

/// The bytes the shared-source cache (titles and stills kept on
/// the GPU while the caller keeps them) may hold. A 4K title is 33 MB.
const SHARED_CACHE_BYTES: u64 = 512 * 1024 * 1024;

/// The bytes of idle pooled buffers kept for reuse. Past this the oldest are
/// released. Sized for two export segments at 4K plus the preview.
const POOL_BYTES: u64 = 1536 * 1024 * 1024;

/// Pooled buffers are allocated in multiples of this, so frames of slightly
/// different shapes reuse each other's buffers.
const POOL_GRANULE: u64 = 1024 * 1024;

/// Why a frame could not be drawn.
#[derive(Debug, thiserror::Error)]
pub enum ComposeError {
    #[error("no GPU is available for the compositor: {0}")]
    NoDevice(String),
    #[error("the frame is too large for this GPU: {0}")]
    TooLarge(String),
    #[error("the GPU rejected the frame: {0}")]
    Gpu(String),
    #[error("the GPU did not finish the frame within {0:?}; the device may have hung")]
    Timeout(Duration),
}

struct Kernels {
    prepare: wgpu::ComputePipeline,
    sample: wgpu::ComputePipeline,
    resize_v: wgpu::ComputePipeline,
    resize_h: wgpu::ComputePipeline,
    rotate: wgpu::ComputePipeline,
    overlay: wgpu::ComputePipeline,
    adjust: wgpu::ComputePipeline,
    fill: wgpu::ComputePipeline,
    to_f16: wgpu::ComputePipeline,
    /// D-452 — a decoded frame's Y'CbCr planes to RGBA.
    #[cfg(target_os = "macos")]
    ycbcr: wgpu::ComputePipeline,
    /// D-452 — the finished canvas into a pixel buffer's planes.
    #[cfg(target_os = "macos")]
    out_luma: wgpu::ComputePipeline,
    #[cfg(target_os = "macos")]
    out_chroma: wgpu::ComputePipeline,
    #[cfg(target_os = "macos")]
    out_bgra: wgpu::ComputePipeline,
}

struct PooledBuffer {
    buffer: wgpu::Buffer,
    size: u64,
    usage: wgpu::BufferUsages,
}

#[derive(Default)]
struct Pool {
    free: Vec<PooledBuffer>,
}

/// A source the caller holds in its own cache (a title, a still),
/// kept on the GPU while the caller still shares it.
struct SharedEntry {
    // Holding the Arc is what makes the pointer key sound: the allocation it
    // names cannot be freed and reused while this entry exists.
    _keep: Arc<dyn std::any::Any + Send + Sync>,
    buffer: wgpu::Buffer,
    bytes: u64,
    last_used: u64,
}

#[derive(Default)]
struct SharedCache {
    entries: HashMap<usize, SharedEntry>,
    clock: u64,
}

/// The GPU compositor. Create one per process and share it (`Arc`).
pub struct Engine {
    device: Arc<wgpu::Device>,
    queue: Arc<wgpu::Queue>,
    max_binding: u64,
    kernels: Kernels,
    pool: Mutex<Pool>,
    shared: Mutex<SharedCache>,
    dummy: wgpu::Buffer,
    /// `tables::half_of_u8`, for `to_f16.wgsl`.
    half_of_u8: wgpu::Buffer,
    /// `write_f16_texture`'s source buffer, kept for the next frame of the same
    /// size or smaller. Reusing it is safe because `queue.write_buffer` is
    /// ordered after every submission already on the queue (the previous
    /// frame's conversion reads it first), and it spares a fresh 25 MB
    /// mapped allocation per 4K frame.
    f16_source: Mutex<Option<wgpu::Buffer>>,
    counters: Counters,
    /// D-452 — the CoreVideo texture cache on this device, made on first use.
    #[cfg(target_os = "macos")]
    textures: Mutex<Option<Arc<crate::video::TextureCache>>>,
}

/// Running totals since the engine opened, summed over every thread that
/// drew through it (B-380's per-stage export timing reads the difference
/// across a render).
#[derive(Default)]
struct Counters {
    frames: AtomicU64,
    record_ns: AtomicU64,
    gpu_ns: AtomicU64,
    readback_ns: AtomicU64,
    upload_bytes: AtomicU64,
    readback_bytes: AtomicU64,
}

/// A snapshot of [`Engine::stats`]. Durations are summed across threads, so
/// with several callers at once they can exceed wall time.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct EngineStats {
    /// Frames drawn.
    pub frames: u64,
    /// Recording a frame: building its tables, uploading its sources
    /// (`write_buffer` copies them into the GPU's staging memory) and encoding
    /// its passes.
    pub record: Duration,
    /// From submitting a frame until the GPU has finished it.
    pub gpu: Duration,
    /// Copying the finished frame out of the mapped staging buffer.
    pub readback: Duration,
    pub upload_bytes: u64,
    pub readback_bytes: u64,
}

impl EngineStats {
    /// `self - earlier`, field by field.
    pub fn since(&self, earlier: &EngineStats) -> EngineStats {
        EngineStats {
            frames: self.frames.saturating_sub(earlier.frames),
            record: self.record.saturating_sub(earlier.record),
            gpu: self.gpu.saturating_sub(earlier.gpu),
            readback: self.readback.saturating_sub(earlier.readback),
            upload_bytes: self.upload_bytes.saturating_sub(earlier.upload_bytes),
            readback_bytes: self.readback_bytes.saturating_sub(earlier.readback_bytes),
        }
    }
}

fn add(counter: &AtomicU64, since: Instant) {
    let ns = u64::try_from(since.elapsed().as_nanos()).unwrap_or(u64::MAX);
    counter.fetch_add(ns, Ordering::Relaxed);
}

/// Bytes of a uniform: the params structs are all `u32`/`i32`/`f32` fields,
/// padded to a multiple of 16 in the WGSL and here.
fn uniform_bytes<T: bytemuck::Pod>(v: &T) -> &[u8] {
    bytemuck::bytes_of(v)
}

#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C)]
struct PrepareParams {
    src_w: u32,
    kind: u32,
    crop_x0: u32,
    crop_y0: u32,
    crop_w: u32,
    crop_h: u32,
    solid: u32,
    _pad: u32,
}

#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C)]
struct ToF16Params {
    src_w: u32,
    kind: u32,
    width: u32,
    height: u32,
}

#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C)]
struct SampleParams {
    canvas_w: u32,
    win_x0: u32,
    win_y0: u32,
    win_w: u32,
    win_h: u32,
    layer_w: u32,
    origin_x: i32,
    origin_y: i32,
    box_w: f32,
    box_h: f32,
    opacity: f32,
    radius: f32,
}

#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C)]
struct ResizeParams {
    in_w: u32,
    out_w: u32,
    out_h: u32,
    radius: f32,
}

#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C)]
struct RotateParams {
    w: u32,
    h: u32,
    _pad0: u32,
    _pad1: u32,
    m: [f32; 6],
    _pad2: [f32; 2],
}

#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C)]
struct OverlayParams {
    canvas_w: u32,
    win_x0: u32,
    win_y0: u32,
    win_w: u32,
    win_h: u32,
    box_w: u32,
    origin_x: i32,
    origin_y: i32,
    opacity: f32,
    _pad: [f32; 3],
}

#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C)]
struct CanvasParams {
    pixels: u32,
    row_w: u32,
    value: u32,
    _pad: u32,
}

const PRELUDE: &str = include_str!("kernels/prelude.wgsl");

#[cfg(target_os = "macos")]
const OUTPUT: &str = include_str!("kernels/output.wgsl");

/// D-452 — the pixel layout of an encoder's target buffer.
#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputFormat {
    /// `420v`: Rec.709 Y'CbCr, video range, 4:2:0, two planes (H.264).
    Nv12Rec709,
    /// `BGRA`: 8-bit B, G, R, A (the ProRes encoder converts it itself).
    Bgra,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C)]
struct OutputParams {
    width: u32,
    height: u32,
    pitch_words: u32,
    _pad: u32,
}

/// `copy_buffer_to_texture`'s row alignment.
#[cfg(target_os = "macos")]
fn padded_row(bytes: u32) -> u32 {
    bytes.next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
}

fn kernel(device: &wgpu::Device, name: &str, body: &str, entry: &str) -> wgpu::ComputePipeline {
    let source = format!("{PRELUDE}\n{body}");
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some(name),
        source: wgpu::ShaderSource::Wgsl(source.into()),
    });
    device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some(name),
        layout: None,
        module: &module,
        entry_point: Some(entry),
        compilation_options: Default::default(),
        cache: None,
    })
}

/// Workgroups to cover `n` invocations at the kernels' 16-wide workgroup.
fn groups(n: u32) -> u32 {
    n.div_ceil(16)
}

/// The work one [`Engine::render`] call records before it submits.
struct Frame<'e> {
    engine: &'e Engine,
    encoder: wgpu::CommandEncoder,
    taken: Vec<PooledBuffer>,
    /// What must outlive the submission besides the pooled buffers (D-452).
    keep: Keep,
}

/// Resources a submission reads or writes that the engine does not own (an
/// imported video plane, whose IOSurface must not be recycled by the decoder
/// or handed to an encoder while the GPU still uses it; anything a
/// [`FrameOutput`] terminal hands over), released only once the submission
/// has finished (D-452).
#[derive(Default)]
struct Keep {
    items: Vec<Box<dyn std::any::Any + Send + Sync>>,
}

impl Keep {
    fn push(&mut self, item: impl std::any::Any + Send + Sync) {
        self.items.push(Box::new(item));
    }
}

/// **The finished canvas of a frame, lent to a [`FrameOutput`] terminal**
/// (D-452): packed RGBA8 words, red in the low byte, `width` × `height`, rows
/// unpadded. Valid for reading by passes recorded on the terminal's encoder.
pub struct Canvas<'a> {
    pub buffer: &'a wgpu::Buffer,
    pub width: u32,
    pub height: u32,
}

/// **What a terminal of [`Engine::submit_with`] records with** (D-452): the
/// frame's own command encoder (so its passes are in the same submission,
/// after the frame), scratch buffers from the engine's pool, and a place to
/// keep anything the GPU reads or writes until the submission has finished.
pub struct FrameOutput<'f, 'e>(&'f mut Frame<'e>);

impl FrameOutput<'_, '_> {
    /// The frame's command encoder.
    pub fn encoder(&mut self) -> &mut wgpu::CommandEncoder {
        &mut self.0.encoder
    }

    /// A buffer of at least `bytes` from the engine's pool, returned to it
    /// once the submission has finished.
    pub fn buffer(
        &mut self,
        bytes: u64,
        usage: wgpu::BufferUsages,
    ) -> Result<wgpu::Buffer, ComposeError> {
        self.0.buffer(bytes, usage)
    }

    /// Keep `item` alive until the submission has finished.
    pub fn keep(&mut self, item: impl std::any::Any + Send + Sync) {
        self.0.keep.push(item);
    }
}

impl<'e> Frame<'e> {
    fn buffer(
        &mut self,
        bytes: u64,
        usage: wgpu::BufferUsages,
    ) -> Result<wgpu::Buffer, ComposeError> {
        let b = self.engine.take(bytes, usage)?;
        let handle = b.buffer.clone();
        self.taken.push(b);
        Ok(handle)
    }

    /// A storage buffer holding `data` (padded to a 4-byte multiple).
    fn upload(&mut self, data: &[u8]) -> Result<wgpu::Buffer, ComposeError> {
        let buf = self.buffer(
            (data.len() as u64).max(4),
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        )?;
        write_padded(&self.engine.queue, &buf, data);
        self.engine.count_upload(data.len());
        Ok(buf)
    }

    fn dispatch(
        &mut self,
        pipeline: &wgpu::ComputePipeline,
        params: &[u8],
        buffers: &[&wgpu::Buffer],
        size: (u32, u32),
    ) {
        if size.0 == 0 || size.1 == 0 {
            return;
        }
        let device = &self.engine.device;
        let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("apelles-compositor params"),
            contents: params,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let mut entries = vec![wgpu::BindGroupEntry {
            binding: 0,
            resource: uniform.as_entire_binding(),
        }];
        for (i, b) in buffers.iter().enumerate() {
            entries.push(wgpu::BindGroupEntry {
                binding: i as u32 + 1,
                resource: b.as_entire_binding(),
            });
        }
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipeline.get_bind_group_layout(0),
            entries: &entries,
        });
        let mut pass = self
            .encoder
            .begin_compute_pass(&wgpu::ComputePassDescriptor::default());
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(groups(size.0), groups(size.1), 1);
    }
}

impl Frame<'_> {
    /// [`Frame::dispatch`] with arbitrary bindings after the uniform (D-452:
    /// the video planes are textures, not buffers).
    #[cfg(target_os = "macos")]
    fn dispatch_resources(
        &mut self,
        pipeline: &wgpu::ComputePipeline,
        params: &[u8],
        resources: Vec<wgpu::BindingResource<'_>>,
        size: (u32, u32),
    ) {
        if size.0 == 0 || size.1 == 0 {
            return;
        }
        let device = &self.engine.device;
        let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("apelles-compositor params"),
            contents: params,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let mut entries = vec![wgpu::BindGroupEntry {
            binding: 0,
            resource: uniform.as_entire_binding(),
        }];
        for (i, resource) in resources.into_iter().enumerate() {
            entries.push(wgpu::BindGroupEntry {
                binding: i as u32 + 1,
                resource,
            });
        }
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipeline.get_bind_group_layout(0),
            entries: &entries,
        });
        let mut pass = self
            .encoder
            .begin_compute_pass(&wgpu::ComputePassDescriptor::default());
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(groups(size.0), groups(size.1), 1);
    }
}

/// `queue.write_buffer` needs a 4-byte-multiple length; an RGB8 frame need
/// not be one, so its tail word is written padded.
fn write_padded(queue: &wgpu::Queue, buf: &wgpu::Buffer, data: &[u8]) {
    let whole = data.len() & !3;
    if whole > 0 {
        queue.write_buffer(buf, 0, &data[..whole]);
    }
    if whole < data.len() {
        let mut tail = [0u8; 4];
        tail[..data.len() - whole].copy_from_slice(&data[whole..]);
        queue.write_buffer(buf, whole as u64, &tail);
    }
}

impl Engine {
    /// Open the device (`apelles_gpu::init_gpu_context`, D-014/D-144) and
    /// compile the kernels.
    pub fn new() -> Result<Self, ComposeError> {
        let ctx = apelles_gpu::init_gpu_context().map_err(ComposeError::NoDevice)?;
        Ok(Self::with_device(ctx.device, ctx.queue))
    }

    /// Build the engine on an existing device.
    pub fn with_device(device: Arc<wgpu::Device>, queue: Arc<wgpu::Queue>) -> Self {
        let k = |name: &str, body: &str| kernel(&device, name, body, "main");
        let kernels = Kernels {
            prepare: k("prepare", include_str!("kernels/prepare.wgsl")),
            sample: k("sample", include_str!("kernels/sample.wgsl")),
            resize_v: kernel(
                &device,
                "resize_v",
                include_str!("kernels/resize_v.wgsl"),
                "vertical",
            ),
            resize_h: k("resize_h", include_str!("kernels/resize_h.wgsl")),
            rotate: k("rotate", include_str!("kernels/rotate.wgsl")),
            overlay: k("overlay", include_str!("kernels/overlay.wgsl")),
            adjust: k("adjust", include_str!("kernels/adjust.wgsl")),
            fill: k("fill", include_str!("kernels/fill.wgsl")),
            to_f16: k("to_f16", include_str!("kernels/to_f16.wgsl")),
            #[cfg(target_os = "macos")]
            ycbcr: k("ycbcr", include_str!("kernels/ycbcr.wgsl")),
            #[cfg(target_os = "macos")]
            out_luma: kernel(&device, "out_luma", OUTPUT, "luma"),
            #[cfg(target_os = "macos")]
            out_chroma: kernel(&device, "out_chroma", OUTPUT, "chroma"),
            #[cfg(target_os = "macos")]
            out_bgra: kernel(&device, "out_bgra", OUTPUT, "bgra"),
        };
        let limits = device.limits();
        let max_binding = limits
            .max_storage_buffer_binding_size
            .min(limits.max_buffer_size);
        let half_of_u8 = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("apelles-compositor half of u8"),
            contents: bytemuck::cast_slice(&tables::half_of_u8()),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let dummy = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("apelles-compositor unused binding"),
            size: 16,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        Self {
            device,
            queue,
            max_binding,
            kernels,
            pool: Mutex::new(Pool::default()),
            shared: Mutex::new(SharedCache::default()),
            dummy,
            half_of_u8,
            f16_source: Mutex::new(None),
            counters: Counters::default(),
            #[cfg(target_os = "macos")]
            textures: Mutex::new(None),
        }
    }

    /// The device and queue the engine draws on. A pass that hands the engine
    /// GPU-resident pixels ([`crate::Source::Gpu`], D-450) must allocate them
    /// here.
    pub fn device_and_queue(&self) -> (&Arc<wgpu::Device>, &Arc<wgpu::Queue>) {
        (&self.device, &self.queue)
    }

    fn count_upload(&self, bytes: usize) {
        self.counters
            .upload_bytes
            .fetch_add(bytes as u64, Ordering::Relaxed);
    }

    /// Totals since the engine opened. Take two and [`EngineStats::since`].
    pub fn stats(&self) -> EngineStats {
        let c = &self.counters;
        let d = |a: &AtomicU64| Duration::from_nanos(a.load(Ordering::Relaxed));
        EngineStats {
            frames: c.frames.load(Ordering::Relaxed),
            record: d(&c.record_ns),
            gpu: d(&c.gpu_ns),
            readback: d(&c.readback_ns),
            upload_bytes: c.upload_bytes.load(Ordering::Relaxed),
            readback_bytes: c.readback_bytes.load(Ordering::Relaxed),
        }
    }

    fn take(&self, bytes: u64, usage: wgpu::BufferUsages) -> Result<PooledBuffer, ComposeError> {
        let bytes = bytes.max(16);
        if bytes > self.max_binding {
            return Err(ComposeError::TooLarge(format!(
                "a {bytes}-byte buffer is over this device's {}-byte limit",
                self.max_binding
            )));
        }
        {
            let mut pool = self.pool.lock().unwrap_or_else(|e| e.into_inner());
            let best = pool
                .free
                .iter()
                .enumerate()
                .filter(|(_, b)| {
                    b.usage == usage && b.size >= bytes && b.size <= bytes * 2 + POOL_GRANULE
                })
                .min_by_key(|(_, b)| b.size)
                .map(|(i, _)| i);
            if let Some(i) = best {
                return Ok(pool.free.swap_remove(i));
            }
        }
        let size = bytes.div_ceil(POOL_GRANULE) * POOL_GRANULE;
        let size = size.min(self.max_binding).max(bytes);
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("apelles-compositor pooled"),
            size,
            usage,
            mapped_at_creation: false,
        });
        Ok(PooledBuffer {
            buffer,
            size,
            usage,
        })
    }

    fn give_back(&self, buffers: Vec<PooledBuffer>) {
        let mut pool = self.pool.lock().unwrap_or_else(|e| e.into_inner());
        pool.free.extend(buffers);
        let mut total: u64 = pool.free.iter().map(|b| b.size).sum();
        // Oldest first: buffers returned earlier sit at the front.
        while total > POOL_BYTES && !pool.free.is_empty() {
            let b = pool.free.remove(0);
            total -= b.size;
        }
    }

    /// The GPU copy of a source the caller shares through its own cache,
    /// uploading it the first time. `key` is the address of the caller's
    /// allocation, kept alive by the entry.
    fn shared_buffer(
        &self,
        key: usize,
        keep: Arc<dyn std::any::Any + Send + Sync>,
        data: &[u8],
    ) -> Result<wgpu::Buffer, ComposeError> {
        let mut cache = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        cache.clock += 1;
        let now = cache.clock;
        if let Some(e) = cache.entries.get_mut(&key) {
            e.last_used = now;
            return Ok(e.buffer.clone());
        }
        let bytes = (data.len() as u64).max(16).next_multiple_of(4);
        if bytes > self.max_binding {
            return Err(ComposeError::TooLarge(format!(
                "a {bytes}-byte source is over this device's {}-byte limit",
                self.max_binding
            )));
        }
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("apelles-compositor shared source"),
            size: bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        write_padded(&self.queue, &buffer, data);
        self.count_upload(data.len());
        cache.entries.insert(
            key,
            SharedEntry {
                _keep: keep,
                buffer: buffer.clone(),
                bytes,
                last_used: now,
            },
        );
        Ok(buffer)
    }

    /// Release cached sources nobody else holds any more, then the least
    /// recently used until the cache fits its budget.
    fn trim_shared(&self) {
        // D-452 — and let CoreVideo drop the textures of video frames no
        // submission holds any more.
        #[cfg(target_os = "macos")]
        if let Some(textures) = self
            .textures
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            textures.flush();
        }
        let mut cache = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        cache.entries.retain(|_, e| Arc::strong_count(&e._keep) > 1);
        let mut total: u64 = cache.entries.values().map(|e| e.bytes).sum();
        while total > SHARED_CACHE_BYTES {
            let Some((&key, _)) = cache.entries.iter().min_by_key(|(_, e)| e.last_used) else {
                break;
            };
            if let Some(e) = cache.entries.remove(&key) {
                total -= e.bytes;
            }
        }
    }

    /// Draw `plan` and return its pixels: [`Self::submit`], then
    /// [`PendingFrame::wait`].
    pub fn render(self: &Arc<Self>, plan: &FramePlan) -> Result<RgbaImage, ComposeError> {
        self.submit(plan)?.wait()
    }

    /// Record `plan`, hand it to the GPU and return at once. The frame is
    /// drawn while the caller does other work (decodes the next frame); its
    /// pixels come from [`PendingFrame::wait`]. A validation error in the plan
    /// is reported here; a device fault or a hang is reported by `wait`.
    ///
    /// D-452 — the read-back terminal of [`Self::submit_with`].
    pub fn submit(self: &Arc<Self>, plan: &FramePlan) -> Result<PendingFrame, ComposeError> {
        let (w, h) = (plan.width, plan.height);
        let px = u64::from(w) * u64::from(h);
        let (gpu, staging) = self.submit_with(plan, |out, canvas| {
            let staging = out.buffer(
                px * 4,
                wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            )?;
            out.encoder()
                .copy_buffer_to_buffer(canvas.buffer, 0, &staging, 0, px * 4);
            Ok(staging)
        })?;
        let (index, taken, keep) = gpu.into_parts();
        let (tx, rx) = std::sync::mpsc::channel();
        staging
            .slice(..px * 4)
            .map_async(wgpu::MapMode::Read, move |r| {
                let _ = tx.send(r);
            });
        Ok(PendingFrame {
            inner: Some(Pending {
                engine: self.clone(),
                staging,
                index,
                taken,
                keep,
                px,
                size: (w, h),
                mapped: Some(rx),
            }),
        })
    }

    /// D-452 — record `plan`, then convert the finished canvas into `target`,
    /// an IOSurface-backed `CVPixelBuffer` of the plan's size laid out as
    /// `format`, and submit: the IOSurface terminal of [`Self::submit_with`].
    /// No pixel is read back; the buffer holds the frame once
    /// [`PendingGpu::wait`] returns (the export hands it to its encoder then).
    ///
    /// A target of another size than the plan's is the export's aspect-change
    /// stretch (`chroma::edit_render::canvas_plan`): the canvas is resampled to
    /// it with the separable Triangle filter the general layer path uses
    /// (`image::imageops::resize`'s, which the CPU did this with before).
    #[cfg(target_os = "macos")]
    pub fn submit_into(
        self: &Arc<Self>,
        plan: &FramePlan,
        target: &apelles_types::video_frame::PixelBuffer,
        format: OutputFormat,
    ) -> Result<PendingGpu, ComposeError> {
        let (w, h) = target.dimensions();
        if w == 0 || h == 0 {
            return Err(ComposeError::TooLarge("the target buffer is empty".into()));
        }
        let cache = self.texture_cache()?;
        let (gpu, ()) = self.submit_with(plan, |out, canvas| {
            let frame = &mut *out.0;
            let storage = wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC;
            let resized;
            let src: &wgpu::Buffer = if (canvas.width, canvas.height) == (w, h) {
                canvas.buffer
            } else {
                resized = self.record_resize(
                    frame,
                    canvas.buffer,
                    (canvas.width, canvas.height),
                    (w, h),
                )?;
                &resized
            };
            let copy = wgpu::TextureUsages::COPY_DST;
            // (plane, its size, its texture format, bytes per pixel)
            let planes: Vec<(usize, (u32, u32), wgpu::TextureFormat, u32)> = match format {
                OutputFormat::Nv12Rec709 => vec![
                    (0, (w, h), wgpu::TextureFormat::R8Uint, 1),
                    (
                        1,
                        (w.div_ceil(2), h.div_ceil(2)),
                        wgpu::TextureFormat::Rg8Uint,
                        2,
                    ),
                ],
                OutputFormat::Bgra => vec![(0, (w, h), wgpu::TextureFormat::Bgra8Unorm, 4)],
            };
            for (plane, (pw, ph), texture_format, bytes_per_px) in planes {
                let row = padded_row(pw * bytes_per_px);
                let staging = frame.buffer(u64::from(row) * u64::from(ph), storage)?;
                let p = OutputParams {
                    width: w,
                    height: h,
                    pitch_words: row / 4,
                    _pad: 0,
                };
                let (kernel, groups_x) = match (format, plane) {
                    (OutputFormat::Nv12Rec709, 0) => (&self.kernels.out_luma, pw.div_ceil(4)),
                    (OutputFormat::Nv12Rec709, _) => (&self.kernels.out_chroma, pw.div_ceil(2)),
                    (OutputFormat::Bgra, _) => (&self.kernels.out_bgra, pw),
                };
                frame.dispatch(kernel, uniform_bytes(&p), &[src, &staging], (groups_x, ph));
                let texture =
                    cache.import(&self.device, target, plane, (pw, ph), texture_format, copy)?;
                frame.encoder.copy_buffer_to_texture(
                    wgpu::TexelCopyBufferInfo {
                        buffer: &staging,
                        layout: wgpu::TexelCopyBufferLayout {
                            offset: 0,
                            bytes_per_row: Some(row),
                            rows_per_image: Some(ph),
                        },
                    },
                    wgpu::TexelCopyTextureInfo {
                        texture: &texture.texture,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    wgpu::Extent3d {
                        width: pw,
                        height: ph,
                        depth_or_array_layers: 1,
                    },
                );
                frame.keep.push(texture);
            }
            Ok(())
        })?;
        Ok(gpu)
    }

    /// Resample a packed RGBA buffer of `from` pixels to `to` (D-452): the
    /// general layer path's two passes, square corners, no rotation.
    #[cfg(target_os = "macos")]
    fn record_resize(
        &self,
        frame: &mut Frame<'_>,
        src: &wgpu::Buffer,
        (fw, fh): (u32, u32),
        (tw, th): (u32, u32),
    ) -> Result<wgpu::Buffer, ComposeError> {
        let storage = wgpu::BufferUsages::STORAGE;
        let (vspans, vweights) = tables::triangle_weights(fh, th);
        let (hspans, hweights) = tables::triangle_weights(fw, tw);
        let vs = frame.upload(bytemuck::cast_slice(&vspans))?;
        let vw = frame.upload(bytemuck::cast_slice(&vweights))?;
        let hs = frame.upload(bytemuck::cast_slice(&hspans))?;
        let hw = frame.upload(bytemuck::cast_slice(&hweights))?;
        let mid = frame.buffer(u64::from(fw) * u64::from(th) * 16, storage)?;
        let out = frame.buffer(u64::from(tw) * u64::from(th) * 4, storage)?;
        let pv = ResizeParams {
            in_w: fw,
            out_w: fw,
            out_h: th,
            radius: 0.0,
        };
        frame.dispatch(
            &self.kernels.resize_v,
            uniform_bytes(&pv),
            &[&vs, &vw, src, &mid],
            (fw, th),
        );
        let ph = ResizeParams {
            in_w: fw,
            out_w: tw,
            out_h: th,
            radius: 0.0,
        };
        frame.dispatch(
            &self.kernels.resize_h,
            uniform_bytes(&ph),
            &[&hs, &hw, &mid, &out],
            (tw, th),
        );
        Ok(out)
    }

    /// **The one "frame finished on the GPU" step (D-452).** Records `plan`
    /// into the canvas, lets `terminal` record what happens to the finished
    /// canvas on the same command encoder — a staging copy for a read-back
    /// ([`Self::submit`]), the conversion into an IOSurface
    /// ([`Self::submit_into`]), or a presenter's pass into a drawable (D-451) —
    /// and submits it all as one command buffer. Returns at once with the
    /// submission in flight ([`PendingGpu`]) and what the terminal returned.
    ///
    /// A recording error returns `Err` with nothing submitted. A validation or
    /// out-of-memory error from the device returns `Err` too, after the
    /// submission was made: its buffers go back to the pool only once it has
    /// finished.
    pub fn submit_with<T>(
        self: &Arc<Self>,
        plan: &FramePlan,
        terminal: impl FnOnce(&mut FrameOutput<'_, '_>, &Canvas<'_>) -> Result<T, ComposeError>,
    ) -> Result<(PendingGpu, T), ComposeError> {
        let (w, h) = (plan.width, plan.height);
        if w == 0 || h == 0 {
            return Err(ComposeError::TooLarge(
                "a frame needs a non-zero size".to_string(),
            ));
        }
        let px = u64::from(w) * u64::from(h);
        let started = Instant::now();
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let oom = self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let mut frame = Frame {
            engine: self,
            encoder: self
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("apelles-compositor frame"),
                }),
            taken: Vec::new(),
            keep: Keep::default(),
        };
        let recorded = self.record(&mut frame, plan, px).and_then(|canvas| {
            terminal(
                &mut FrameOutput(&mut frame),
                &Canvas {
                    buffer: &canvas,
                    width: w,
                    height: h,
                },
            )
        });
        let Frame {
            encoder,
            taken,
            keep,
            ..
        } = frame;
        let output = match recorded {
            Ok(o) => o,
            Err(e) => {
                drop(oom.pop());
                drop(scope.pop());
                self.give_back(taken);
                return Err(e);
            }
        };
        let index = self.queue.submit(Some(encoder.finish()));
        add(&self.counters.record_ns, started);
        let oom = pollster::block_on(oom.pop());
        let invalid = pollster::block_on(scope.pop());
        let pending = PendingGpu {
            engine: self.clone(),
            index: Some(index),
            taken,
            keep,
        };
        match oom.or(invalid) {
            // Dropped, not waited on by the caller: `PendingGpu`'s drop waits
            // for the submission before its buffers go back to the pool.
            Some(e) => {
                drop(pending);
                Err(ComposeError::Gpu(e.to_string()))
            }
            None => Ok((pending, output)),
        }
    }

    fn read_back(
        &self,
        staging: &wgpu::Buffer,
        index: wgpu::SubmissionIndex,
        px: u64,
        size: (u32, u32),
    ) -> Result<RgbaImage, ComposeError> {
        let (tx, rx) = std::sync::mpsc::channel();
        staging
            .slice(..px * 4)
            .map_async(wgpu::MapMode::Read, move |r| {
                let _ = tx.send(r);
            });
        self.finish_map(staging, index, &rx, px, size)
    }

    /// Wait for submission `index`, then for `staging`'s map, and copy the
    /// frame out.
    fn finish_map(
        &self,
        staging: &wgpu::Buffer,
        index: wgpu::SubmissionIndex,
        mapped: &std::sync::mpsc::Receiver<Result<(), wgpu::BufferAsyncError>>,
        px: u64,
        (w, h): (u32, u32),
    ) -> Result<RgbaImage, ComposeError> {
        let waited = Instant::now();
        match self.device.poll(wgpu::PollType::Wait {
            submission_index: Some(index),
            timeout: Some(GPU_TIMEOUT),
        }) {
            Ok(_) => {}
            Err(wgpu::PollError::Timeout) => return Err(ComposeError::Timeout(GPU_TIMEOUT)),
            Err(e) => return Err(ComposeError::Gpu(e.to_string())),
        }
        // The submission is done, but the map callback for this slice may be
        // delivered by another thread's poll; wait for it rather than assume.
        match mapped.recv_timeout(GPU_TIMEOUT) {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(ComposeError::Gpu(e.to_string())),
            Err(_) => return Err(ComposeError::Timeout(GPU_TIMEOUT)),
        }
        add(&self.counters.gpu_ns, waited);
        let copied = Instant::now();
        let slice = staging.slice(..px * 4);
        let bytes = slice.get_mapped_range().to_vec();
        staging.unmap();
        add(&self.counters.readback_ns, copied);
        RgbaImage::from_raw(w, h, bytes)
            .ok_or_else(|| ComposeError::Gpu("the read-back frame has the wrong size".to_string()))
    }

    /// Record every step of `plan`; returns the canvas buffer.
    fn record(
        &self,
        frame: &mut Frame<'_>,
        plan: &FramePlan,
        px: u64,
    ) -> Result<wgpu::Buffer, ComposeError> {
        let (w, h) = (plan.width, plan.height);
        let canvas = frame.buffer(
            px * 4,
            wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_SRC
                | wgpu::BufferUsages::COPY_DST,
        )?;
        let canvas_params = |value: u32| CanvasParams {
            pixels: px as u32,
            row_w: w,
            value,
            _pad: 0,
        };
        match &plan.background {
            Background::Solid(rgba) => {
                let p = canvas_params(u32::from_le_bytes(*rgba));
                let k = &self.kernels.fill;
                frame.dispatch(k, uniform_bytes(&p), &[&canvas], (w, h));
            }
            Background::Image(img) => {
                if img.dimensions() != (w, h) {
                    return Err(ComposeError::TooLarge(
                        "the background image is not the canvas's size".to_string(),
                    ));
                }
                write_padded(&self.queue, &canvas, img.as_raw());
                self.count_upload(img.as_raw().len());
            }
        }
        for step in &plan.steps {
            match step {
                Step::Paint(layer) => self.record_layer(frame, layer, &canvas, (w, h))?,
                Step::Adjust(ops) => {
                    let t = tables::adjust_tables(ops);
                    let s1 = frame.upload(bytemuck::cast_slice(&t.stage1))?;
                    let s2 = frame.upload(bytemuck::cast_slice(&t.stage2))?;
                    let p = canvas_params(0);
                    let k = &self.kernels.adjust;
                    frame.dispatch(k, uniform_bytes(&p), &[&s1, &s2, &canvas], (w, h));
                }
            }
        }
        Ok(canvas)
    }

    /// The source's GPU buffer and its kind for `prepare.wgsl`.
    fn source_buffer(
        &self,
        frame: &mut Frame<'_>,
        source: &Source,
    ) -> Result<(wgpu::Buffer, u32, u32), ComposeError> {
        Ok(match source {
            Source::Rgba(img) => {
                let buf = if Arc::strong_count(img) > 1 {
                    let key = Arc::as_ptr(img) as usize;
                    let keep: Arc<dyn std::any::Any + Send + Sync> = img.clone();
                    self.shared_buffer(key, keep, img.as_raw())?
                } else {
                    frame.upload(img.as_raw())?
                };
                (buf, 0, 0)
            }
            Source::Rgb(img) => (frame.upload(img.as_raw())?, 1, 0),
            Source::Solid { rgba, .. } => (self.dummy.clone(), 2, u32::from_le_bytes(*rgba)),
            // Already on this device (D-450), packed RGBA8 like `Rgba`, read
            // with its own row stride.
            Source::Gpu(g) => (g.buffer.clone(), 0, 0),
            // Converted by `record_video` instead; never read as a buffer.
            #[cfg(target_os = "macos")]
            Source::Video(_) => {
                return Err(ComposeError::Gpu(
                    "a video frame has no buffer form; it is read through record_video".into(),
                ));
            }
        })
    }

    /// Record the prepare pass for `source`: its crop, as packed RGBA8.
    fn record_prepare(
        &self,
        frame: &mut Frame<'_>,
        source: &Source,
        crop: (u32, u32, u32, u32),
    ) -> Result<wgpu::Buffer, ComposeError> {
        // D-452 — a decoded video frame's crop, converted from its planes, is
        // already the prepared layer.
        #[cfg(target_os = "macos")]
        if let Source::Video(video) = source {
            return self.record_video(frame, video, crop);
        }
        let (src, kind, solid) = self.source_buffer(frame, source)?;
        let src_w = source.row_pixels();
        let (cx0, cy0, cx1, cy1) = crop;
        let (crop_w, crop_h) = (cx1 - cx0, cy1 - cy0);
        let out = frame.buffer(
            u64::from(crop_w) * u64::from(crop_h) * 4,
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        )?;
        let p = PrepareParams {
            src_w,
            kind,
            crop_x0: cx0,
            crop_y0: cy0,
            crop_w,
            crop_h,
            solid,
            _pad: 0,
        };
        let k = &self.kernels.prepare;
        frame.dispatch(k, uniform_bytes(&p), &[&src, &out], (crop_w, crop_h));
        Ok(out)
    }

    /// The engine's CoreVideo texture cache, made on first use (D-452).
    #[cfg(target_os = "macos")]
    fn texture_cache(&self) -> Result<Arc<crate::video::TextureCache>, ComposeError> {
        let mut slot = self.textures.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(c) = slot.as_ref() {
            return Ok(c.clone());
        }
        let cache = Arc::new(crate::video::TextureCache::new(&self.device)?);
        *slot = Some(cache.clone());
        Ok(cache)
    }

    /// D-452 — import `video`'s planes and convert its `crop` to packed RGBA8.
    #[cfg(target_os = "macos")]
    fn record_video(
        &self,
        frame: &mut Frame<'_>,
        video: &apelles_types::video_frame::VideoFrame,
        crop: (u32, u32, u32, u32),
    ) -> Result<wgpu::Buffer, ComposeError> {
        let cache = self.texture_cache()?;
        let (w, h) = video.buffer.dimensions();
        let (sx, sy) = video.layout.chroma_shift;
        let chroma_size = (w.div_ceil(1 << sx), h.div_ceil(1 << sy));
        let (luma_format, chroma_format) = crate::video::plane_formats(&video.layout);
        let usage = wgpu::TextureUsages::TEXTURE_BINDING;
        let luma = cache.import(&self.device, &video.buffer, 0, (w, h), luma_format, usage)?;
        let chroma = cache.import(
            &self.device,
            &video.buffer,
            1,
            chroma_size,
            chroma_format,
            usage,
        )?;
        let (cx0, cy0, cx1, cy1) = crop;
        let out = frame.buffer(
            u64::from(cx1 - cx0) * u64::from(cy1 - cy0) * 4,
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        )?;
        let p = crate::video::ycbcr_params(&video.layout, crop);
        let luma_view = luma
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let chroma_view = chroma
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        frame.dispatch_resources(
            &self.kernels.ycbcr,
            uniform_bytes(&p),
            vec![
                wgpu::BindingResource::TextureView(&luma_view),
                wgpu::BindingResource::TextureView(&chroma_view),
                out.as_entire_binding(),
            ],
            (cx1 - cx0, cy1 - cy0),
        );
        frame.keep.push(luma);
        frame.keep.push(chroma);
        Ok(out)
    }

    fn record_layer(
        &self,
        frame: &mut Frame<'_>,
        layer: &Layer,
        canvas: &wgpu::Buffer,
        (cw, ch): (u32, u32),
    ) -> Result<(), ComposeError> {
        let opacity = layer.opacity.clamp(0.0, 1.0);
        let (cx0, cy0, cx1, cy1) = layer.crop;
        let (sw, sh) = layer.size;
        if opacity <= 0.0 || cx1 <= cx0 || cy1 <= cy0 || sw == 0 || sh == 0 {
            return Ok(());
        }
        let (src_w, src_h) = layer.source.dimensions();
        if cx1 > src_w || cy1 > src_h {
            return Err(ComposeError::TooLarge(format!(
                "crop {:?} is outside the {src_w}x{src_h} source",
                layer.crop
            )));
        }
        let (crop_w, crop_h) = (cx1 - cx0, cy1 - cy0);

        if layer.fused() {
            let Some(t) = tables::sample_tables(layer, (cw, ch)) else {
                return Ok(());
            };
            let prepared = self.record_prepare(frame, &layer.source, layer.crop)?;
            let cols = frame.upload(bytemuck::cast_slice(&t.cols))?;
            let rows = frame.upload(bytemuck::cast_slice(&t.rows))?;
            let (wx0, wy0, wx1, wy1) = t.window;
            let p = SampleParams {
                canvas_w: cw,
                win_x0: wx0,
                win_y0: wy0,
                win_w: wx1 - wx0,
                win_h: wy1 - wy0,
                layer_w: crop_w,
                origin_x: t.origin.0 as i32,
                origin_y: t.origin.1 as i32,
                box_w: sw as f32,
                box_h: sh as f32,
                opacity,
                radius: layer.corner_radius as f32,
            };
            let k = &self.kernels.sample;
            frame.dispatch(
                k,
                uniform_bytes(&p),
                &[&prepared, &cols, &rows, canvas],
                (wx1 - wx0, wy1 - wy0),
            );
            return Ok(());
        }

        // The general path. Skip it entirely when the box cannot reach the
        // canvas, as the CPU's `overlay` did.
        let (ox, oy) = (layer.origin.0.round() as i64, layer.origin.1.round() as i64);
        let wx0 = ox.max(0);
        let wy0 = oy.max(0);
        let wx1 = (ox + i64::from(sw)).min(i64::from(cw));
        let wy1 = (oy + i64::from(sh)).min(i64::from(ch));
        if wx1 <= wx0 || wy1 <= wy0 {
            return Ok(());
        }
        let prepared = self.record_prepare(frame, &layer.source, layer.crop)?;
        let storage = wgpu::BufferUsages::STORAGE;
        let (vspans, vweights) = tables::triangle_weights(crop_h, sh);
        let (hspans, hweights) = tables::triangle_weights(crop_w, sw);
        let vs = frame.upload(bytemuck::cast_slice(&vspans))?;
        let vw = frame.upload(bytemuck::cast_slice(&vweights))?;
        let hs = frame.upload(bytemuck::cast_slice(&hspans))?;
        let hw = frame.upload(bytemuck::cast_slice(&hweights))?;
        let mid = frame.buffer(u64::from(crop_w) * u64::from(sh) * 16, storage)?;
        let boxed = frame.buffer(u64::from(sw) * u64::from(sh) * 4, storage)?;
        let pv = ResizeParams {
            in_w: crop_w,
            out_w: crop_w,
            out_h: sh,
            radius: 0.0,
        };
        frame.dispatch(
            &self.kernels.resize_v,
            uniform_bytes(&pv),
            &[&vs, &vw, &prepared, &mid],
            (crop_w, sh),
        );
        let ph = ResizeParams {
            in_w: crop_w,
            out_w: sw,
            out_h: sh,
            radius: layer.corner_radius.max(0.0) as f32,
        };
        frame.dispatch(
            &self.kernels.resize_h,
            uniform_bytes(&ph),
            &[&hs, &hw, &mid, &boxed],
            (sw, sh),
        );
        let placed = if layer.rotation_deg != 0.0 {
            let rotated = frame.buffer(u64::from(sw) * u64::from(sh) * 4, storage)?;
            let pr = RotateParams {
                w: sw,
                h: sh,
                _pad0: 0,
                _pad1: 0,
                m: tables::rotation_inverse(sw, sh, layer.rotation_deg),
                _pad2: [0.0; 2],
            };
            frame.dispatch(
                &self.kernels.rotate,
                uniform_bytes(&pr),
                &[&boxed, &rotated],
                (sw, sh),
            );
            rotated
        } else {
            boxed
        };
        let po = OverlayParams {
            canvas_w: cw,
            win_x0: wx0 as u32,
            win_y0: wy0 as u32,
            win_w: (wx1 - wx0) as u32,
            win_h: (wy1 - wy0) as u32,
            box_w: sw,
            origin_x: ox as i32,
            origin_y: oy as i32,
            opacity,
            _pad: [0.0; 3],
        };
        frame.dispatch(
            &self.kernels.overlay,
            uniform_bytes(&po),
            &[&placed, canvas],
            ((wx1 - wx0) as u32, (wy1 - wy0) as u32),
        );
        Ok(())
    }

    /// Write `source`'s pixels into `target`, an `Rgba16Float` texture of the
    /// same size with `STORAGE_BINDING` usage, as `v / 255` per channel
    /// (`to_f16.wgsl`): the input the Colorist's grade shader reads (D-450).
    /// Recorded and submitted at once, so a later submission on this queue
    /// (the grade itself) sees the result. Only a decoded picture (RGB8 or
    /// RGBA8 on the CPU) can be written.
    pub fn write_f16_texture(
        &self,
        source: &Source,
        target: &wgpu::Texture,
    ) -> Result<(), ComposeError> {
        let (w, h) = source.dimensions();
        if target.width() != w || target.height() != h {
            return Err(ComposeError::TooLarge(format!(
                "a {w}x{h} source into a {}x{} texture",
                target.width(),
                target.height()
            )));
        }
        let (bytes, kind) = match source {
            Source::Rgba(img) => (img.as_raw().as_slice(), 0),
            Source::Rgb(img) => (img.as_raw().as_slice(), 1),
            #[cfg(target_os = "macos")]
            Source::Video(video) => return self.write_f16_from_video(video, target),
            Source::Solid { .. } | Source::Gpu(_) => {
                return Err(ComposeError::Gpu(
                    "only a decoded picture can be written to a half-float texture".to_string(),
                ));
            }
        };
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let need = (bytes.len() as u64).div_ceil(4).max(1) * 4;
        let src = {
            let mut slot = self.f16_source.lock().unwrap_or_else(|e| e.into_inner());
            match slot.as_ref() {
                Some(b) if b.size() >= need => b.clone(),
                _ => {
                    if need > self.max_binding {
                        return Err(ComposeError::TooLarge(format!(
                            "a {need}-byte frame is over this device's {}-byte limit",
                            self.max_binding
                        )));
                    }
                    let b = self.device.create_buffer(&wgpu::BufferDescriptor {
                        label: Some("apelles-compositor to_f16 source"),
                        size: need,
                        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                        mapped_at_creation: false,
                    });
                    *slot = Some(b.clone());
                    b
                }
            }
        };
        write_padded(&self.queue, &src, bytes);
        self.count_upload(bytes.len());
        let p = ToF16Params {
            src_w: w,
            kind,
            width: w,
            height: h,
        };
        let uniform = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("apelles-compositor to_f16 params"),
                contents: uniform_bytes(&p),
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let view = target.create_view(&wgpu::TextureViewDescriptor::default());
        let k = &self.kernels.to_f16;
        let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &k.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: src.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: self.half_of_u8.as_entire_binding(),
                },
            ],
        });
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("apelles-compositor to_f16"),
            });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
            pass.set_pipeline(k);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(groups(w), groups(h), 1);
        }
        self.queue.submit(Some(encoder.finish()));
        match pollster::block_on(scope.pop()) {
            Some(e) => Err(ComposeError::Gpu(e.to_string())),
            None => Ok(()),
        }
    }

    /// D-452 — [`Self::write_f16_texture`] for a decoded video frame: its
    /// planes converted to RGBA on the GPU (`ycbcr.wgsl`, the conversion every
    /// layer gets), then to half float, in one submission. Waits for it, so
    /// the decoder's buffer can be recycled as soon as this returns.
    #[cfg(target_os = "macos")]
    fn write_f16_from_video(
        &self,
        video: &apelles_types::video_frame::VideoFrame,
        target: &wgpu::Texture,
    ) -> Result<(), ComposeError> {
        let (w, h) = video.buffer.dimensions();
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut frame = Frame {
            engine: self,
            encoder: self
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("apelles-compositor video to_f16"),
                }),
            taken: Vec::new(),
            keep: Keep::default(),
        };
        let rgba = match self.record_video(&mut frame, video, (0, 0, w, h)) {
            Ok(b) => b,
            Err(e) => {
                drop(scope.pop());
                self.give_back(frame.taken);
                return Err(e);
            }
        };
        let p = ToF16Params {
            src_w: w,
            kind: 0,
            width: w,
            height: h,
        };
        let view = target.create_view(&wgpu::TextureViewDescriptor::default());
        let half = self.half_of_u8.clone();
        frame.dispatch_resources(
            &self.kernels.to_f16,
            uniform_bytes(&p),
            vec![
                rgba.as_entire_binding(),
                wgpu::BindingResource::TextureView(&view),
                half.as_entire_binding(),
            ],
            (w, h),
        );
        let Frame {
            encoder,
            taken,
            keep,
            ..
        } = frame;
        let index = self.queue.submit(Some(encoder.finish()));
        if let Some(e) = pollster::block_on(scope.pop()) {
            std::mem::forget(keep);
            return Err(ComposeError::Gpu(e.to_string()));
        }
        match self.device.poll(wgpu::PollType::Wait {
            submission_index: Some(index),
            timeout: Some(GPU_TIMEOUT),
        }) {
            Ok(_) => {
                self.give_back(taken);
                drop(keep);
                Ok(())
            }
            Err(wgpu::PollError::Timeout) => {
                std::mem::forget(keep);
                Err(ComposeError::Timeout(GPU_TIMEOUT))
            }
            Err(e) => {
                std::mem::forget(keep);
                Err(ComposeError::Gpu(e.to_string()))
            }
        }
    }

    /// Copy a [`GpuImage`] back to the CPU, exactly, for the one caller that
    /// must draw on a graded picture before it is composited (a clip's
    /// highlighter strokes, D-396, rasterised on the CPU). Waits for the GPU.
    pub fn read_gpu_image(&self, image: &crate::GpuImage) -> Result<RgbaImage, ComposeError> {
        let (w, h) = (image.width, image.height);
        let row = u64::from(image.row_pixels) * 4;
        let bytes = row * u64::from(h);
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let staging = self.take(
            bytes,
            wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        )?;
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("apelles-compositor read gpu image"),
            });
        encoder.copy_buffer_to_buffer(&image.buffer, 0, &staging.buffer, 0, bytes);
        let index = self.queue.submit(Some(encoder.finish()));
        if let Some(e) = pollster::block_on(scope.pop()) {
            return Err(ComposeError::Gpu(e.to_string()));
        }
        let px = bytes / 4;
        let padded = self.read_back(&staging.buffer, index, px, (image.row_pixels, h));
        match padded {
            Ok(full) => {
                self.give_back(vec![staging]);
                let mut out = RgbaImage::new(w, h);
                let stride = row as usize;
                let width_bytes = w as usize * 4;
                for (y, dst) in out.as_mut().chunks_mut(width_bytes).enumerate() {
                    dst.copy_from_slice(&full.as_raw()[y * stride..y * stride + width_bytes]);
                }
                Ok(out)
            }
            Err(e) => Err(e),
        }
    }
}

/// **A submission in flight (D-452)**: what [`Engine::submit_with`] hands
/// back. `Send`, so another thread can wait for it (the export's encoder
/// thread waits for a frame written into its pixel buffer). Dropped without
/// [`Self::wait`], it still waits (bounded by [`GPU_TIMEOUT`]) before its
/// buffers return to the pool and what it keeps is released.
pub struct PendingGpu {
    engine: Arc<Engine>,
    /// `None` once waited for, or taken apart.
    index: Option<wgpu::SubmissionIndex>,
    taken: Vec<PooledBuffer>,
    keep: Keep,
}

impl PendingGpu {
    /// Wait until the GPU has finished the submission.
    pub fn wait(mut self) -> Result<(), ComposeError> {
        let Some(index) = self.index.take() else {
            return Ok(());
        };
        let waited = Instant::now();
        let done = self.engine.device.poll(wgpu::PollType::Wait {
            submission_index: Some(index),
            timeout: Some(GPU_TIMEOUT),
        });
        if let Err(e) = done {
            // Leaked, not released: the GPU may still be using them.
            std::mem::forget(std::mem::take(&mut self.keep));
            std::mem::forget(std::mem::take(&mut self.taken));
            return Err(match e {
                wgpu::PollError::Timeout => ComposeError::Timeout(GPU_TIMEOUT),
                other => ComposeError::Gpu(other.to_string()),
            });
        }
        add(&self.engine.counters.gpu_ns, waited);
        self.engine.counters.frames.fetch_add(1, Ordering::Relaxed);
        self.engine.give_back(std::mem::take(&mut self.taken));
        self.keep = Keep::default();
        self.engine.trim_shared();
        Ok(())
    }

    /// The submission's parts, for a terminal that finishes it its own way
    /// (the read-back's [`PendingFrame`]).
    fn into_parts(mut self) -> (wgpu::SubmissionIndex, Vec<PooledBuffer>, Keep) {
        let index = self
            .index
            .take()
            .unwrap_or_else(|| unreachable!("a fresh submission has its index"));
        (
            index,
            std::mem::take(&mut self.taken),
            std::mem::take(&mut self.keep),
        )
    }
}

impl Drop for PendingGpu {
    fn drop(&mut self) {
        let Some(index) = self.index.take() else {
            return;
        };
        let done = self.engine.device.poll(wgpu::PollType::Wait {
            submission_index: Some(index),
            timeout: Some(GPU_TIMEOUT),
        });
        if done.is_err() {
            std::mem::forget(std::mem::take(&mut self.keep));
            std::mem::forget(std::mem::take(&mut self.taken));
            return;
        }
        self.engine.give_back(std::mem::take(&mut self.taken));
    }
}

/// A frame handed to the GPU by [`Engine::submit`] and not yet read back.
///
/// `Send` and `'static`, so the waiting can happen on another thread: the
/// export hands it to its encoder-writer thread, which waits while the render
/// worker decodes the next frame. Dropped without [`Self::wait`], it still
/// waits (bounded by [`GPU_TIMEOUT`]) before its buffers return to the pool,
/// since the GPU may still be writing them.
pub struct PendingFrame {
    inner: Option<Pending>,
}

struct Pending {
    engine: Arc<Engine>,
    staging: wgpu::Buffer,
    index: wgpu::SubmissionIndex,
    taken: Vec<PooledBuffer>,
    keep: Keep,
    px: u64,
    size: (u32, u32),
    /// The staging buffer's map callback; `None` for a frame that failed
    /// validation and was never mapped.
    mapped: Option<std::sync::mpsc::Receiver<Result<(), wgpu::BufferAsyncError>>>,
}

impl PendingFrame {
    /// The frame's pixels, once the GPU has drawn them.
    pub fn wait(mut self) -> Result<RgbaImage, ComposeError> {
        let Some(p) = self.inner.take() else {
            return Err(ComposeError::Gpu("the frame was already read".to_string()));
        };
        let e = &p.engine;
        let result = match &p.mapped {
            Some(rx) => e.finish_map(&p.staging, p.index.clone(), rx, p.px, p.size),
            None => Err(ComposeError::Gpu("the frame was never mapped".to_string())),
        };
        // A failed wait may leave the staging buffer's map pending, so its
        // buffers are released rather than pooled.
        if result.is_ok() {
            e.give_back(p.taken);
        }
        e.trim_shared();
        if result.is_ok() {
            e.counters.frames.fetch_add(1, Ordering::Relaxed);
            e.counters
                .readback_bytes
                .fetch_add(p.px * 4, Ordering::Relaxed);
        }
        result
    }
}

impl Drop for PendingFrame {
    fn drop(&mut self) {
        if let Some(p) = self.inner.take() {
            // Its buffers may still be in use by the GPU: wait for this
            // submission before they can be handed to another frame. A device
            // that does not answer keeps them (a leak bounded by the frame),
            // rather than risk two frames writing one buffer.
            let done = p.engine.device.poll(wgpu::PollType::Wait {
                submission_index: Some(p.index.clone()),
                timeout: Some(GPU_TIMEOUT),
            });
            if done.is_err() {
                // Leaked rather than released: the GPU may still be using
                // the imported planes, and a decoder buffer recycled under it
                // would be written while it is read.
                std::mem::forget(p.keep);
                return;
            }
            // The staging buffer's map was requested at submit; it must have
            // landed and be undone before the buffer can serve another frame
            // (a frame submitted with a still-mapped buffer is a validation
            // error).
            if let Some(rx) = &p.mapped {
                match rx.recv_timeout(GPU_TIMEOUT) {
                    Ok(Ok(())) => p.staging.unmap(),
                    // Never mapped, or the device did not answer: keep the
                    // buffers out of the pool.
                    _ => return,
                }
            }
            p.engine.give_back(p.taken);
        }
    }
}
