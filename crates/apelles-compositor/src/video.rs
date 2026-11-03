//! **Decoded video frames in, and finished frames out, as IOSurface textures
//! (D-452).**
//!
//! What it is: the Metal interop between CoreVideo's IOSurface-backed
//! `CVPixelBuffer`s and this engine's wgpu device. A decoded frame's planes
//! become textures through a `CVMetalTextureCache` made on the engine's own
//! `MTLDevice` and `wgpu::hal::metal::Device::texture_from_raw` +
//! `Device::create_texture_from_hal`; the same route gives the encoder's target
//! buffers as textures the engine writes into. No pixel is copied on the CPU
//! either way.
//!
//! What it does NOT do: own the buffers (the decoder and the encoder do), or
//! decide colour: [`ycbcr_params`] turns a [`YcbcrLayout`] into the kernel's
//! uniform, and the layout comes from the decoder.
//!
//! **Lifetime rule.** A texture made here aliases the buffer's IOSurface. The
//! `CVMetalTexture` and the buffer are kept with the frame's submission
//! (`Imported`), so a recycled decoder buffer can never be written while the
//! GPU still reads it.

use std::ptr::NonNull;

use apelles_types::video_frame::{PixelBuffer, YcbcrLayout};
use objc2_core_foundation::CFRetained;
use objc2_core_video::{CVMetalTexture, CVMetalTextureCache, CVMetalTextureGetTexture};
use objc2_metal::{MTLPixelFormat, MTLTextureType};

use crate::engine::ComposeError;

/// The engine's texture cache, on its device.
pub(crate) struct TextureCache(CFRetained<CVMetalTextureCache>);

// SAFETY: CVMetalTextureCache is documented as safe to use from any thread;
// CoreFoundation retain / release are atomic.
unsafe impl Send for TextureCache {}
// SAFETY: as above.
unsafe impl Sync for TextureCache {}

/// One imported plane: the wgpu texture and what keeps its IOSurface valid.
pub(crate) struct Imported {
    pub texture: wgpu::Texture,
    _cv: CvTexture,
    _buffer: PixelBuffer,
}

struct CvTexture(#[allow(dead_code)] CFRetained<CVMetalTexture>);
// SAFETY: a retained CF object only released, never used, off its thread.
unsafe impl Send for CvTexture {}
// SAFETY: as above.
unsafe impl Sync for CvTexture {}

impl TextureCache {
    pub(crate) fn new(device: &wgpu::Device) -> Result<Self, ComposeError> {
        // SAFETY: the hal device is only borrowed for this call.
        let hal = unsafe { device.as_hal::<wgpu::hal::api::Metal>() }
            .ok_or_else(|| ComposeError::NoDevice("the engine's device is not Metal".into()))?;
        let mut out: *mut CVMetalTextureCache = std::ptr::null_mut();
        // SAFETY: a valid MTLDevice and an out-pointer CoreVideo fills.
        let status = unsafe {
            CVMetalTextureCache::create(None, None, hal.raw_device(), None, NonNull::from(&mut out))
        };
        let cache = NonNull::new(out).filter(|_| status == 0).ok_or_else(|| {
            ComposeError::NoDevice(format!("CVMetalTextureCacheCreate failed ({status})"))
        })?;
        // SAFETY: CVMetalTextureCacheCreate returns a +1 reference.
        Ok(Self(unsafe { CFRetained::from_raw(cache) }))
    }

    /// Plane `plane` of `buffer` as a `width` × `height` texture of `format`.
    pub(crate) fn import(
        &self,
        device: &wgpu::Device,
        buffer: &PixelBuffer,
        plane: usize,
        (width, height): (u32, u32),
        format: wgpu::TextureFormat,
        usage: wgpu::TextureUsages,
    ) -> Result<Imported, ComposeError> {
        let mtl_format = mtl_format(format)?;
        let mut out: *mut CVMetalTexture = std::ptr::null_mut();
        // SAFETY: an IOSurface-backed pixel buffer, a plane it has, and that
        // plane's size; CoreVideo fills the out-pointer.
        let status = unsafe {
            CVMetalTextureCache::create_texture_from_image(
                None,
                &self.0,
                buffer.as_cv(),
                None,
                mtl_format,
                width as usize,
                height as usize,
                plane,
                NonNull::from(&mut out),
            )
        };
        let cv = NonNull::new(out).filter(|_| status == 0).ok_or_else(|| {
            ComposeError::Gpu(format!(
                "a video frame's plane {plane} could not be made a Metal texture ({status})"
            ))
        })?;
        // SAFETY: CVMetalTextureCacheCreateTextureFromImage returns +1.
        let cv = unsafe { CFRetained::from_raw(cv) };
        let raw = CVMetalTextureGetTexture(&cv)
            .ok_or_else(|| ComposeError::Gpu("CoreVideo returned no Metal texture".into()))?;
        let extent = wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        };
        // SAFETY: `raw` is a 2D texture of `format` and `extent` on the
        // engine's own MTLDevice (the cache was made on it), with one mip and
        // one layer, as the descriptor below states.
        let texture = unsafe {
            let hal_texture = wgpu::hal::metal::Device::texture_from_raw(
                raw,
                format,
                MTLTextureType::Type2D,
                1,
                1,
                wgpu::hal::CopyExtent {
                    width,
                    height,
                    depth: 1,
                },
            );
            device.create_texture_from_hal::<wgpu::hal::api::Metal>(
                hal_texture,
                &wgpu::TextureDescriptor {
                    label: Some("apelles-compositor video plane"),
                    size: extent,
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format,
                    usage,
                    view_formats: &[],
                },
            )
        };
        Ok(Imported {
            texture,
            _cv: CvTexture(cv),
            _buffer: buffer.clone(),
        })
    }

    /// Let CoreVideo release textures nobody holds any more.
    pub(crate) fn flush(&self) {
        self.0.flush(0);
    }
}

fn mtl_format(format: wgpu::TextureFormat) -> Result<MTLPixelFormat, ComposeError> {
    use wgpu::TextureFormat as T;
    Ok(match format {
        T::R8Uint => MTLPixelFormat::R8Uint,
        T::Rg8Uint => MTLPixelFormat::RG8Uint,
        T::R16Uint => MTLPixelFormat::R16Uint,
        T::Rg16Uint => MTLPixelFormat::RG16Uint,
        T::Bgra8Unorm => MTLPixelFormat::BGRA8Unorm,
        other => {
            return Err(ComposeError::Gpu(format!(
                "{other:?} is not a video plane format"
            )));
        }
    })
}

/// The texture formats of a decoded frame's luma and chroma planes.
pub(crate) fn plane_formats(layout: &YcbcrLayout) -> (wgpu::TextureFormat, wgpu::TextureFormat) {
    if layout.bits > 8 {
        (wgpu::TextureFormat::R16Uint, wgpu::TextureFormat::Rg16Uint)
    } else {
        (wgpu::TextureFormat::R8Uint, wgpu::TextureFormat::Rg8Uint)
    }
}

/// `ycbcr.wgsl`'s parameters.
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
#[repr(C)]
pub(crate) struct YcbcrParams {
    pub crop_x0: u32,
    pub crop_y0: u32,
    pub crop_w: u32,
    pub crop_h: u32,
    pub shift_x: u32,
    pub shift_y: u32,
    pub sample_shift: u32,
    pub _pad: u32,
    pub y_off: f32,
    pub y_scale: f32,
    pub c_off: f32,
    pub c_scale: f32,
    pub r_cr: f32,
    pub g_cb: f32,
    pub g_cr: f32,
    pub b_cb: f32,
    pub chroma_x0: f32,
    pub chroma_y0: f32,
    pub _pad2: [f32; 2],
}

/// The conversion for `layout`, over the crop `(x0, y0, x1, y1)`.
///
/// Range: video range is luma 16..235 and chroma 16..240 at 8 bits (scaled by
/// 4 at 10); full range is 0..255 (0..1023). Matrix: the standard
/// Y'CbCr → R'G'B' inverse for `(Kr, Kb)`. Chroma siting: horizontally
/// co-sited with the even luma column (the H.264 / HEVC default "left"
/// location), vertically centred between the two luma rows of 4:2:0.
pub(crate) fn ycbcr_params(layout: &YcbcrLayout, crop: (u32, u32, u32, u32)) -> YcbcrParams {
    let (x0, y0, x1, y1) = crop;
    let max = f64::from((1u32 << layout.bits) - 1);
    let scale = f64::from(1u32 << (layout.bits - 8));
    let (y_off, y_range, c_off, c_range) = if layout.full_range {
        (0.0, max, 128.0 * scale, max)
    } else {
        (16.0 * scale, 219.0 * scale, 128.0 * scale, 224.0 * scale)
    };
    let (kr, kb) = layout.matrix.coefficients();
    let kg = 1.0 - kr - kb;
    // Cb, Cr are in -0.5..0.5 after scaling by `c_range`, hence the 2·(1-K).
    let r_cr = 2.0 * (1.0 - kr);
    let b_cb = 2.0 * (1.0 - kb);
    let g_cb = -b_cb * kb / kg;
    let g_cr = -r_cr * kr / kg;
    YcbcrParams {
        crop_x0: x0,
        crop_y0: y0,
        crop_w: x1 - x0,
        crop_h: y1 - y0,
        shift_x: u32::from(layout.chroma_shift.0),
        shift_y: u32::from(layout.chroma_shift.1),
        sample_shift: if layout.bits > 8 {
            16 - u32::from(layout.bits)
        } else {
            0
        },
        _pad: 0,
        y_off: y_off as f32,
        y_scale: (1.0 / y_range) as f32,
        c_off: c_off as f32,
        c_scale: (1.0 / c_range) as f32,
        r_cr: r_cr as f32,
        g_cb: g_cb as f32,
        g_cr: g_cr as f32,
        b_cb: b_cb as f32,
        chroma_x0: 0.0,
        chroma_y0: 0.0,
        _pad2: [0.0; 2],
    }
}
