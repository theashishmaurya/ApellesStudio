//! # `chroma::viewer_space` — what the app's two native viewers are tagged as (D-457)
//!
//! **What it is:** the one definition of the colour space a native viewer's
//! `CAMetalLayer` is tagged with, shared by the Edit preview
//! (`preview_surface::native_view`, D-454) and the Colorist's full-window
//! surface (`gpu_processing::WgpuDisplay`, B-006). Both draw 8-bit R'G'B'
//! bytes into a non-sRGB drawable unchanged, so the layer's tag alone says
//! what those bytes mean, and the window server (ColorSync) converts from it
//! to the display's profile.
//!
//! **What it does:**
//! - [`ViewerSpace::of_source`] names the space of what a viewer shows: a
//!   video's frames are the timeline's Rec.709 R'G'B' (what the export encodes
//!   and tags), a still image is sRGB (what the RapidRAW-inherited still path
//!   develops into, and what an untagged image file means);
//! - [`ViewerSpace::tag`] / [`ViewerSpace::tag_surface`] set it on a layer
//!   (one we created, or the one wgpu made for a window surface);
//! - [`ViewerSpace::ui_colour`] re-encodes a UI colour (sRGB, as the webview
//!   paints it) into the layer's space through ColorSync itself, so a viewer's
//!   letterbox shows as the very colour of the panel around it rather than a
//!   lighter or darker one;
//! - [`ViewerSpace::of_layer`] (debug builds) reads a layer's tag back, so the
//!   debug tools can show what the window server is really told.
//!
//! **What it does NOT do:** convert any picture (a frame's bytes are never
//! touched; only the tag and the letterbox colour follow the space), manage
//! colour inside the grade or the engine, or offer a "broadcast" display mode
//! (D-454 §10.4).
//!
//! **What ColorSync does with the tag, measured** (macOS 26.2, 2026-11-04,
//! `CGColorCreateCopyByMatchingToColorSpace`): `kCGColorSpaceITUR_709` decodes
//! with a pure 2.4 power (BT.1886 with a zero black level), not the inverse of
//! the BT.709 camera OETF: a 709-tagged code value of 24 is shown as sRGB 11,
//! 128 as sRGB 121. So a Rec.709 viewer shows the shadows of the same bytes
//! somewhat darker than an sRGB tag would, and a 24-grey UI colour has to be
//! written as 36 to show as 24 (`a_ui_colour_shows_as_itself_in_a_rec709_layer`).

#[cfg(target_os = "macos")]
use objc2_core_graphics::{CGColor, CGColorRenderingIntent, CGColorSpace};
#[cfg(target_os = "macos")]
use objc2_quartz_core::{CAMetalLayer, CATransaction};

/// The colour space of the bytes a native viewer draws.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ViewerSpace {
    /// ITU-R BT.709: a video's frames, the timeline, the export (D-452 tags
    /// the encoded file the same way).
    Rec709,
    /// IEC 61966-2-1 sRGB: a still image opened on its own, and the UI.
    Srgb,
}

impl ViewerSpace {
    /// The space of `path`'s pictures as a viewer shows them: a video file's
    /// are Rec.709, anything else (a still image, a camera raw developed by
    /// the RapidRAW-inherited path) is sRGB. An image's embedded ICC profile
    /// is not read anywhere in the app, so an image is always taken as sRGB.
    pub(crate) fn of_source(path: &std::path::Path) -> Self {
        if apelles_media::video::is_video_file(path) {
            ViewerSpace::Rec709
        } else {
            ViewerSpace::Srgb
        }
    }

    /// A short name for logs and debug reports.
    pub(crate) fn name(self) -> &'static str {
        match self {
            ViewerSpace::Rec709 => "rec709",
            ViewerSpace::Srgb => "srgb",
        }
    }

    #[cfg(target_os = "macos")]
    fn colour_space(self) -> Result<impl std::ops::Deref<Target = CGColorSpace>, String> {
        // SAFETY: CoreGraphics constants, valid for the life of the process.
        let name = unsafe {
            match self {
                ViewerSpace::Rec709 => objc2_core_graphics::kCGColorSpaceITUR_709,
                ViewerSpace::Srgb => objc2_core_graphics::kCGColorSpaceSRGB,
            }
        };
        CGColorSpace::with_name(Some(name))
            .ok_or_else(|| format!("CoreGraphics has no {} colour space", self.name()))
    }

    /// Tag `layer`: the window server converts what it shows from this space
    /// to the display's. Inside its own Core Animation transaction with
    /// implicit animations off, so it lands at once from any thread.
    #[cfg(target_os = "macos")]
    pub(crate) fn tag(self, layer: &CAMetalLayer) -> Result<(), String> {
        let space = self.colour_space()?;
        CATransaction::begin();
        CATransaction::setDisableActions(true);
        layer.setColorspace(Some(&space));
        CATransaction::commit();
        Ok(())
    }

    /// [`Self::tag`] the `CAMetalLayer` wgpu presents `surface` into (for a
    /// surface made from a window, the layer wgpu-hal created inside the
    /// window's view; `wgpu::Surface::as_hal` is wgpu's own access to it).
    #[cfg(target_os = "macos")]
    pub(crate) fn tag_surface(self, surface: &wgpu::Surface<'_>) -> Result<(), String> {
        // SAFETY: the guard is only used to read the layer handle and set one
        // of its properties for the duration of this call; no wgpu-hal
        // resource is created, destroyed or used by the GPU through it.
        let hal = unsafe { surface.as_hal::<wgpu::hal::api::Metal>() }
            .ok_or("the surface is not a Metal surface")?;
        let layer = hal.render_layer().lock();
        self.tag(&layer)
    }

    /// `srgb`, a 0-1 RGBA colour as the webview paints it, re-encoded so that
    /// a layer tagged with this space shows it as that same colour: the
    /// conversion is ColorSync's own (`CGColorCreateCopyByMatchingToColorSpace`),
    /// the one the window server applies to the layer, so the letterbox and
    /// the panel around it cannot disagree. Alpha is kept.
    #[cfg(target_os = "macos")]
    pub(crate) fn ui_colour(self, srgb: [f32; 4]) -> [f32; 4] {
        if self == ViewerSpace::Srgb {
            return srgb;
        }
        match self.match_from(ViewerSpace::Srgb, srgb) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[viewer_space] {e}; the letterbox is drawn unconverted");
                srgb
            }
        }
    }

    /// [`Self::ui_colour`] off macOS: no layer, nothing to match.
    #[cfg(not(target_os = "macos"))]
    pub(crate) fn ui_colour(self, srgb: [f32; 4]) -> [f32; 4] {
        srgb
    }

    /// `colour` (in `from`) as ColorSync shows it in this space.
    #[cfg(target_os = "macos")]
    fn match_from(self, from: ViewerSpace, colour: [f32; 4]) -> Result<[f32; 4], String> {
        let source = from.colour_space()?;
        let target = self.colour_space()?;
        let comps = colour.map(f64::from);
        // SAFETY: `comps` holds the source space's three components plus
        // alpha, the count `CGColorCreate` reads for an RGB space.
        let c = unsafe { CGColor::new(Some(&source), comps.as_ptr()) }
            .ok_or("CoreGraphics could not make the colour")?;
        // SAFETY: no options dictionary.
        let matched = unsafe {
            CGColor::new_copy_by_matching_to_color_space(
                Some(&target),
                CGColorRenderingIntent::RenderingIntentDefault,
                Some(&c),
                None,
            )
        }
        .ok_or("ColorSync could not match the colour")?;
        if CGColor::number_of_components(Some(&matched)) != 4 {
            return Err("the matched colour is not RGBA".to_string());
        }
        let ptr = CGColor::components(Some(&matched));
        if ptr.is_null() {
            return Err("the matched colour has no components".to_string());
        }
        // SAFETY: four components, checked above, owned by `matched`, which
        // outlives this read.
        let out = unsafe { std::slice::from_raw_parts(ptr, 4) };
        Ok([
            out[0].clamp(0.0, 1.0) as f32,
            out[1].clamp(0.0, 1.0) as f32,
            out[2].clamp(0.0, 1.0) as f32,
            out[3].clamp(0.0, 1.0) as f32,
        ])
    }

    /// **Debug builds only:** what `layer` is really tagged as: a space's
    /// [`Self::name`], `"untagged"`, or CoreGraphics' own name for anything
    /// else.
    #[cfg(all(target_os = "macos", debug_assertions))]
    pub(crate) fn of_layer(layer: &CAMetalLayer) -> String {
        let Some(space) = layer.colorspace() else {
            return "untagged".to_string();
        };
        let name = CGColorSpace::name(Some(&space)).map(|n| n.to_string());
        for known in [ViewerSpace::Rec709, ViewerSpace::Srgb] {
            let known_name = known
                .colour_space()
                .ok()
                .and_then(|s| CGColorSpace::name(Some(&s)))
                .map(|n| n.to_string());
            if name.is_some() && name == known_name {
                return known.name().to_string();
            }
        }
        name.unwrap_or_else(|| "unnamed".to_string())
    }

    /// **Debug builds only:** [`Self::of_layer`] for a wgpu surface's layer.
    #[cfg(all(target_os = "macos", debug_assertions))]
    pub(crate) fn of_surface(surface: &wgpu::Surface<'_>) -> String {
        // SAFETY: as in `tag_surface`: a read of the layer handle only.
        match unsafe { surface.as_hal::<wgpu::hal::api::Metal>() } {
            Some(hal) => Self::of_layer(&hal.render_layer().lock()),
            None => "not a Metal surface".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_video_is_rec709_and_a_still_is_srgb() {
        use std::path::Path;
        assert_eq!(
            ViewerSpace::of_source(Path::new("/a/b.mov")),
            ViewerSpace::Rec709
        );
        assert_eq!(
            ViewerSpace::of_source(Path::new("/a/B.MP4")),
            ViewerSpace::Rec709
        );
        assert_eq!(
            ViewerSpace::of_source(Path::new("/a/b.jpg")),
            ViewerSpace::Srgb
        );
        assert_eq!(
            ViewerSpace::of_source(Path::new("/a/b.png")),
            ViewerSpace::Srgb
        );
        assert_eq!(
            ViewerSpace::of_source(Path::new("/a/b.cr3")),
            ViewerSpace::Srgb
        );
    }

    /// The letterbox colour written into a Rec.709 layer shows, through
    /// ColorSync, as the UI colour it came from; and that colour is the 2.4
    /// power ColorSync decodes `kCGColorSpaceITUR_709` with (a 24 grey is
    /// written as ~36), which is what the module doc states.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_ui_colour_shows_as_itself_in_a_rec709_layer() {
        for v in [0.0f32, 24.0, 35.0, 128.0, 200.0, 255.0] {
            let ui = [v / 255.0, v / 255.0, v / 255.0, 1.0];
            let written = ViewerSpace::Rec709.ui_colour(ui);
            let shown = ViewerSpace::Srgb
                .match_from(ViewerSpace::Rec709, written)
                .expect("ColorSync matches");
            for c in 0..3 {
                assert!((shown[c] - ui[c]).abs() < 1e-3, "{v}: shown {shown:?}");
            }
            assert_eq!(written[3], 1.0);
        }
        let grey = ViewerSpace::Rec709.ui_colour([24.0 / 255.0, 24.0 / 255.0, 24.0 / 255.0, 1.0]);
        let linear = ((24.0f32 / 255.0 + 0.055) / 1.055).powf(2.4);
        assert!((grey[0] - linear.powf(1.0 / 2.4)).abs() < 2e-3, "{grey:?}");
        assert_eq!(
            ViewerSpace::Srgb.ui_colour([0.1, 0.2, 0.3, 1.0]),
            [0.1, 0.2, 0.3, 1.0]
        );
    }
}
