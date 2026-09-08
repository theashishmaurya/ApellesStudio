//! Caption rasterisation for the Edit tab (D-228, `docs/notes/subtitles.md`).
//!
//! **What it is:** the media-layer half of the subtitle/caption primitive —
//! the rasteriser that turns one [`CaptionCue`] plus its resolved
//! [`CaptionStyle`] into an RGBA layer `chroma::edit`'s compositor can
//! alpha-blend over the finished frame.
//!
//! **What it does:** [`render_caption_layer`] — lay every line of a cue out
//! at the positions [`CaptionLayout`] dictates, draw each line's background
//! box, then draw the glyphs over them, into a canvas-sized buffer that is
//! transparent everywhere else.
//!
//! **What it does NOT do:** no font catalogue of its own (it uses
//! `chroma::text`'s — one catalogue for titles, captions and the export, which
//! is the whole D-212 contract), no compositing, no file parsing, no layout
//! decisions. **Every number that decides where a line goes comes from
//! `chroma_timeline::caption::CaptionLayout`**, which the ffmpeg export
//! compiler reads too; this module only turns those numbers into pixels.
//!
//! ## The one thing to understand here
//!
//! A caption is the first **multi-line** text Chroma draws, and D-211
//! deliberately forbade multi-line titles because inter-line layout is the
//! one thing `ab_glyph` and ffmpeg's `drawtext` genuinely disagree about.
//! This module is allowed to draw multiple lines only because it never asks
//! either engine to lay out a second line: each line is an independent,
//! single-line glyph run at a `y` the shared layout computed. See
//! `chroma_timeline::caption`'s module doc for the measured evidence behind
//! that, and for why `ab_glyph`'s `ScaleFont::ascent()` /
//! `height() + line_gap()` reproduce `drawtext`'s `y_align=font` box exactly.

use std::sync::{Arc, Mutex, OnceLock};

use ab_glyph::{Font, GlyphId, ScaleFont, point};
use chroma_timeline::caption::{CaptionAlign, CaptionCue, CaptionLayout, CaptionStyle};
use image::RgbaImage;

use super::text::{freetype_equivalent_scale, load_font, resolve_font_path};

/// How many rasterised caption layers to keep.
///
/// Larger than `chroma::text`'s four because the case is genuinely bigger:
/// several subtitle tracks can be showing at once (an English and a French
/// track together is the reference frame's own example), each at either of
/// the preview's two decode scales.
const CAPTION_CACHE_CAPACITY: usize = 8;

/// A rasterised caption's cache key — everything [`render_caption_layer`]'s
/// output depends on.
///
/// The style is fingerprinted through its `Debug` rather than being a field
/// of the key, because [`CaptionStyle`] holds `f64`s and so is deliberately
/// not `Hash`/`Eq`. `Debug` is derived, total and deterministic, which is all
/// a cache key needs; the alternative — hand-writing a bit-exact hash over
/// eleven fields — is more code to keep in step with the struct for no gain.
/// One `format!` per visible caption per frame is nothing against rasterising
/// it.
#[derive(PartialEq, Eq, Clone)]
struct CaptionKey {
    text: String,
    style: String,
    canvas: (u32, u32),
}

#[expect(
    clippy::type_complexity,
    reason = "an 8-entry LRU's (key, value) vec — mirrors chroma::text::layer_cache, and naming a type for it would be more indirection than it removes"
)]
fn caption_cache() -> &'static Mutex<Vec<(CaptionKey, Arc<RgbaImage>)>> {
    static CACHE: OnceLock<Mutex<Vec<(CaptionKey, Arc<RgbaImage>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

/// Rasterise `cue` in `style` into a `canvas_w`×`canvas_h` RGBA buffer.
///
/// **The layout is resolved against the CANVAS, not the composition**, and
/// that is what makes the preview resolution-independent: every field of
/// [`CaptionStyle`] that positions or sizes anything is a fraction of the
/// composition, so resolving those fractions against whatever canvas the
/// preview happens to be rendering at produces the same picture, scaled. The
/// export resolves the identical fractions against the full output size. This
/// is the same contract `chroma::text::render_text_layer` already holds to.
///
/// **No position/opacity/fade applied, because a caption has none** — unlike
/// a title, whose `Clip::position_*` and `opacity` the compositor adds
/// afterwards. A caption's geometry is entirely its style's, so this buffer is
/// final and the compositor blends it at full opacity. See
/// `chroma_timeline::Clip::caption`'s own doc for why that line is drawn there.
pub fn render_caption_layer(
    cue: &CaptionCue,
    style: &CaptionStyle,
    canvas_w: u32,
    canvas_h: u32,
) -> Result<Arc<RgbaImage>, String> {
    let key = CaptionKey {
        text: cue.text.clone(),
        style: format!("{style:?}"),
        canvas: (canvas_w, canvas_h),
    };
    if let Ok(cache) = caption_cache().lock()
        && let Some((_, img)) = cache.iter().find(|(k, _)| *k == key)
    {
        return Ok(Arc::clone(img));
    }

    let img = Arc::new(rasterise_caption(cue, style, canvas_w, canvas_h)?);
    if let Ok(mut cache) = caption_cache().lock() {
        cache.insert(0, (key, Arc::clone(&img)));
        cache.truncate(CAPTION_CACHE_CAPACITY);
    }
    Ok(img)
}

/// The uncached body of [`render_caption_layer`].
fn rasterise_caption(
    cue: &CaptionCue,
    style: &CaptionStyle,
    canvas_w: u32,
    canvas_h: u32,
) -> Result<RgbaImage, String> {
    let mut canvas = RgbaImage::new(canvas_w, canvas_h);
    let lines = cue.lines();
    // A cue with nothing in it is a real, ordinary state (a caption clip the
    // moment it is added, before anything is typed) — a fully transparent
    // layer, not an error. Same posture `render_text_layer` takes.
    if lines.is_empty() {
        return Ok(canvas);
    }

    let font = load_font(&resolve_font_path(&style.font)?)?;
    let layout = CaptionLayout::resolve(style, canvas_w, canvas_h, lines.len());
    let scale = freetype_equivalent_scale(&font, layout.font_px as f32);
    let scaled = font.as_scaled(scale);
    // The font's own line box, exactly as ffmpeg's `drawtext` derives it under
    // `y_align=font` — see `chroma_timeline::caption`'s module doc for the
    // measurement that pins these two expressions to ffmpeg's.
    let ascent = scaled.ascent();
    let line_box_h = scaled.height() + scaled.line_gap();

    // Pass 1 — lay every line out and record where it lands. Done before any
    // drawing so that every background box is painted before any glyph is,
    // which is what keeps a descender from line 1 overlapping line 2's box
    // from punching a hole in the descender.
    struct Placed {
        outlines: Vec<ab_glyph::OutlinedGlyph>,
        pen_x: f32,
        baseline: f32,
        advance: f32,
    }
    let mut placed = Vec::with_capacity(lines.len());
    for (line, geom) in lines.iter().zip(layout.lines()) {
        // The same advance-and-kern walk `render_text_layer` performs, and the
        // same one FreeType (so `drawtext`) performs — no shaping beyond it.
        let mut pen = 0.0f32;
        let mut prev: Option<GlyphId> = None;
        let mut outlines = Vec::new();
        for ch in line.chars() {
            let id = font.glyph_id(ch);
            if let Some(p) = prev {
                pen += scaled.kern(p, id);
            }
            if let Some(o) = font.outline_glyph(id.with_scale_and_position(scale, point(pen, 0.0)))
            {
                outlines.push(o);
            }
            pen += scaled.h_advance(id);
            prev = Some(id);
        }
        // The ADVANCE width, not the ink width — ffmpeg's `text_w` is the pen
        // advance (measured directly: a box drawn round "Ag" runs 4 px past
        // the 'g' ink, exactly its right side bearing), so aligning on the ink
        // box here would shift a line by its bearings relative to the export.
        // This is the one place captions deliberately differ from
        // `render_text_layer`, which centres the ink box because D-213's
        // single-line title has no box to line up with.
        let advance = pen;
        let x_anchor = geom.x_anchor as f32;
        let pen_x = match style.align {
            CaptionAlign::Left => x_anchor,
            CaptionAlign::Center => x_anchor - advance / 2.0,
            CaptionAlign::Right => x_anchor - advance,
        };
        placed.push(Placed {
            outlines,
            pen_x,
            baseline: geom.line_top as f32 + ascent,
            advance,
        });
    }

    // Pass 2 — the background boxes, all of them, underneath everything.
    if style.box_enabled {
        let (br, bg, bb) = style.box_rgb();
        let alpha = (style.box_alpha() * 255.0).round().clamp(0.0, 255.0) as u8;
        if alpha > 0 {
            for (p, geom) in placed.iter().zip(layout.lines()) {
                let pad = layout.box_padding as f32;
                fill_rect(
                    &mut canvas,
                    p.pen_x - pad,
                    geom.line_top as f32 - pad,
                    p.advance + pad * 2.0,
                    line_box_h + pad * 2.0,
                    [br, bg, bb, alpha],
                );
            }
        }
    }

    // Pass 3 — one coverage mask for all the glyphs, then a single composite.
    //
    // A mask rather than blending each glyph straight onto the canvas: two
    // glyphs' antialiased edges can overlap by a pixel (a kerned pair), and
    // compositing that pixel twice would draw a visibly darker seam — the same
    // hazard `render_text_layer` avoids with its MAX rule, which is what this
    // mask implements. Doing it in one pass over the mask is also what lets
    // the glyphs blend correctly OVER the semi-transparent box rather than
    // replacing it.
    let mut coverage = vec![0u8; (canvas_w as usize) * (canvas_h as usize)];
    for p in &placed {
        for o in &p.outlines {
            let bounds = o.px_bounds();
            o.draw(|gx, gy, c| {
                let x = bounds.min.x + p.pen_x + gx as f32;
                let y = bounds.min.y + p.baseline + gy as f32;
                if x < 0.0 || y < 0.0 {
                    return;
                }
                let (x, y) = (x as u32, y as u32);
                if x >= canvas_w || y >= canvas_h {
                    return;
                }
                let a = (c.clamp(0.0, 1.0) * 255.0).round() as u8;
                let slot = &mut coverage[y as usize * canvas_w as usize + x as usize];
                *slot = (*slot).max(a);
            });
        }
    }

    let (r, g, b) = style.rgb();
    for (i, &cov) in coverage.iter().enumerate() {
        if cov == 0 {
            continue;
        }
        let x = (i % canvas_w as usize) as u32;
        let y = (i / canvas_w as usize) as u32;
        let px = canvas.get_pixel_mut(x, y);
        *px = over([r, g, b, cov], px.0);
    }
    Ok(canvas)
}

/// Straight-alpha "source over destination".
///
/// Written out rather than reached for from `image` because what is needed
/// here is *straight* alpha over a transparent canvas — `image`'s own blend
/// assumes the destination is opaque, which this canvas is not (it is a layer
/// the compositor will blend over the picture afterwards). Returning
/// premultiplied RGB would show as a dark halo on every antialiased edge once
/// that second blend runs; the same trap `chroma::text`'s module doc records
/// for `imageproc::drawing::draw_text_mut`.
fn over(src: [u8; 4], dst: [u8; 4]) -> image::Rgba<u8> {
    let sa = src[3] as f32 / 255.0;
    let da = dst[3] as f32 / 255.0;
    let out_a = sa + da * (1.0 - sa);
    if out_a <= 0.0 {
        return image::Rgba([0, 0, 0, 0]);
    }
    let chan = |i: usize| {
        let s = src[i] as f32 * sa;
        let d = dst[i] as f32 * da * (1.0 - sa);
        ((s + d) / out_a).round().clamp(0.0, 255.0) as u8
    };
    image::Rgba([
        chan(0),
        chan(1),
        chan(2),
        (out_a * 255.0).round().clamp(0.0, 255.0) as u8,
    ])
}

/// Fill an axis-aligned rect, clipped to the canvas.
///
/// Uses MAX on alpha rather than compositing, so two lines' background boxes
/// touching or overlapping (a style with very tight `line_spacing`) draw as
/// one flat band instead of a darker seam where they meet — the same reasoning
/// as the glyph coverage mask above.
fn fill_rect(canvas: &mut RgbaImage, x: f32, y: f32, w: f32, h: f32, rgba: [u8; 4]) {
    let (cw, ch) = canvas.dimensions();
    let x0 = x.round().max(0.0) as u32;
    let y0 = y.round().max(0.0) as u32;
    let x1 = ((x + w).round().max(0.0) as u32).min(cw);
    let y1 = ((y + h).round().max(0.0) as u32).min(ch);
    for py in y0..y1 {
        for px in x0..x1 {
            let p = canvas.get_pixel_mut(px, py);
            if rgba[3] >= p[3] {
                *p = image::Rgba(rgba);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn style(overrides: impl FnOnce(&mut CaptionStyle)) -> CaptionStyle {
        let mut s = CaptionStyle::default();
        overrides(&mut s);
        s
    }

    /// The bounding box of everything non-transparent, `(x0, y0, x1, y1)`
    /// exclusive. The same measurement the export-side ffmpeg pixel test
    /// performs on a real render, so the two engines are checked against one
    /// written specification rather than against each other — the doctrine
    /// `timelineExportText.ffmpeg.test.ts` established for D-213.
    fn bounds(img: &RgbaImage) -> Option<(u32, u32, u32, u32)> {
        let mut b: Option<(u32, u32, u32, u32)> = None;
        for (x, y, px) in img.enumerate_pixels() {
            if px[3] == 0 {
                continue;
            }
            b = Some(match b {
                None => (x, y, x + 1, y + 1),
                Some((x0, y0, x1, y1)) => (x0.min(x), y0.min(y), x1.max(x + 1), y1.max(y + 1)),
            });
        }
        b
    }

    /// Bounds of the fully-opaque pixels only — i.e. the glyphs, ignoring the
    /// semi-transparent background box.
    fn ink_bounds(img: &RgbaImage) -> Option<(u32, u32, u32, u32)> {
        let mut b: Option<(u32, u32, u32, u32)> = None;
        for (x, y, px) in img.enumerate_pixels() {
            if px[3] < 250 {
                continue;
            }
            b = Some(match b {
                None => (x, y, x + 1, y + 1),
                Some((x0, y0, x1, y1)) => (x0.min(x), y0.min(y), x1.max(x + 1), y1.max(y + 1)),
            });
        }
        b
    }

    #[test]
    fn an_empty_cue_renders_a_fully_transparent_layer() {
        let img = render_caption_layer(
            &CaptionCue::new("  \n "),
            &CaptionStyle::default(),
            320,
            180,
        )
        .expect("render");
        assert_eq!(img.dimensions(), (320, 180));
        assert!(bounds(&img).is_none(), "nothing should have been drawn");
    }

    #[test]
    fn a_one_line_caption_is_horizontally_centred() {
        let img = render_caption_layer(
            &CaptionCue::new("Hello there"),
            &CaptionStyle::default(),
            640,
            360,
        )
        .expect("render");
        let (x0, _, x1, _) = ink_bounds(&img).expect("drew something");
        let centre = (x0 + x1) as f32 / 2.0;
        // Within a pixel of the frame centre: the ink box is centred on the
        // ADVANCE box, whose side bearings are not symmetric, so an exact
        // equality would be asserting the font's bearings rather than the
        // layout.
        assert!(
            (centre - 320.0).abs() <= 4.0,
            "caption centre {centre} should be near 320"
        );
    }

    #[test]
    fn a_two_line_caption_stacks_upward_leaving_the_bottom_line_put() {
        let one = render_caption_layer(
            &CaptionCue::new("second"),
            &CaptionStyle::default(),
            640,
            360,
        )
        .expect("render");
        let two = render_caption_layer(
            &CaptionCue::new("first\nsecond"),
            &CaptionStyle::default(),
            640,
            360,
        )
        .expect("render");
        let (_, _, _, one_bottom) = bounds(&one).expect("drew");
        let (_, two_top, _, two_bottom) = bounds(&two).expect("drew");
        assert_eq!(
            one_bottom, two_bottom,
            "adding a line above must not move the bottom line"
        );
        let (_, one_top, _, _) = bounds(&one).expect("drew");
        assert!(
            two_top < one_top,
            "the second line must extend the caption upward"
        );
    }

    #[test]
    fn the_two_lines_of_a_cue_are_one_line_step_apart() {
        let img = render_caption_layer(
            &CaptionCue::new("AAA\nAAA"),
            &style(|s| s.box_enabled = false),
            640,
            360,
        )
        .expect("render");
        // Two identical lines, so the gap between their ink rows is exactly
        // the layout's own step. Find the empty row band between them.
        let (_, top, _, bottom) = ink_bounds(&img).expect("drew");
        let layout = CaptionLayout::resolve(&CaptionStyle::default(), 640, 360, 2);
        // Total ink height of two identical lines = one line's height + step.
        let one = render_caption_layer(
            &CaptionCue::new("AAA"),
            &style(|s| s.box_enabled = false),
            640,
            360,
        )
        .expect("render");
        let (_, o_top, _, o_bottom) = ink_bounds(&one).expect("drew");
        assert_eq!(
            (bottom - top) as i64,
            (o_bottom - o_top) as i64 + layout.line_step,
            "line spacing must be exactly CaptionLayout::line_step"
        );
    }

    #[test]
    fn the_background_box_is_drawn_and_respects_its_opacity() {
        let with_box = render_caption_layer(
            &CaptionCue::new("Hello"),
            &style(|s| {
                s.box_enabled = true;
                s.box_opacity = 0.5;
            }),
            640,
            360,
        )
        .expect("render");
        let without = render_caption_layer(
            &CaptionCue::new("Hello"),
            &style(|s| s.box_enabled = false),
            640,
            360,
        )
        .expect("render");
        let boxed = bounds(&with_box).expect("drew");
        let bare = bounds(&without).expect("drew");
        assert!(
            boxed.0 < bare.0 && boxed.1 < bare.1 && boxed.2 > bare.2 && boxed.3 > bare.3,
            "the box {boxed:?} must extend past the glyphs {bare:?} on every side"
        );
        // A pixel well inside the box but away from any glyph is the box
        // colour at the box's own alpha, not opaque.
        let px = with_box.get_pixel(boxed.0 + 2, boxed.1 + 2);
        assert_eq!(px[3], 128, "0.5 opacity should round to 128");
        assert_eq!((px[0], px[1], px[2]), (0, 0, 0), "default box is black");
    }

    #[test]
    fn box_disabled_draws_glyphs_only() {
        let img = render_caption_layer(
            &CaptionCue::new("Hello"),
            &style(|s| s.box_enabled = false),
            640,
            360,
        )
        .expect("render");
        // Every non-transparent pixel is glyph coverage; none is the flat
        // semi-transparent slab a box would leave.
        let flat = img
            .pixels()
            .filter(|p| p[3] > 0 && p[3] < 250 && (p[0], p[1], p[2]) == (0, 0, 0))
            .count();
        assert_eq!(flat, 0, "no box pixels should exist");
    }

    #[test]
    fn alignment_moves_the_caption_to_its_anchor() {
        let left = render_caption_layer(
            &CaptionCue::new("Hi"),
            &style(|s| {
                s.align = CaptionAlign::Left;
                s.position_x = 0.1;
                s.box_enabled = false;
            }),
            640,
            360,
        )
        .expect("render");
        let right = render_caption_layer(
            &CaptionCue::new("Hi"),
            &style(|s| {
                s.align = CaptionAlign::Right;
                s.position_x = 0.9;
                s.box_enabled = false;
            }),
            640,
            360,
        )
        .expect("render");
        let (lx0, _, _, _) = ink_bounds(&left).expect("drew");
        let (_, _, rx1, _) = ink_bounds(&right).expect("drew");
        // Left-aligned at 0.1 starts near x = 64; right-aligned at 0.9 ends
        // near x = 576. Tolerances are the glyph side bearings only.
        assert!((lx0 as i64 - 64).abs() <= 4, "left edge was {lx0}");
        assert!((rx1 as i64 - 576).abs() <= 4, "right edge was {rx1}");
    }

    #[test]
    fn the_caption_colour_is_the_styles_colour() {
        let img = render_caption_layer(
            &CaptionCue::new("Hi"),
            &style(|s| {
                s.color = "#FF0000".into();
                s.box_enabled = false;
            }),
            640,
            360,
        )
        .expect("render");
        let opaque = img.pixels().find(|p| p[3] == 255).expect("some ink");
        assert_eq!((opaque[0], opaque[1], opaque[2]), (255, 0, 0));
    }

    #[test]
    fn rendering_is_deterministic_and_the_cache_returns_the_same_pixels() {
        // The render path must be deterministic (a project invariant), and the
        // cache must not be able to hand back a DIFFERENT buffer than a cold
        // render would — the failure mode a keyed cache actually has.
        let cue = CaptionCue::new("Deterministic\ncaption");
        let s = CaptionStyle::default();
        let warm = render_caption_layer(&cue, &s, 320, 180).expect("render");
        let again = render_caption_layer(&cue, &s, 320, 180).expect("render");
        let cold = rasterise_caption(&cue, &s, 320, 180).expect("render");
        assert_eq!(warm.as_raw(), again.as_raw());
        assert_eq!(warm.as_raw(), cold.as_raw());
    }

    #[test]
    fn a_style_change_is_not_served_from_the_cache() {
        let cue = CaptionCue::new("Hi");
        let red = render_caption_layer(&cue, &style(|s| s.color = "#FF0000".into()), 320, 180)
            .expect("render");
        let blue = render_caption_layer(&cue, &style(|s| s.color = "#0000FF".into()), 320, 180)
            .expect("render");
        assert_ne!(red.as_raw(), blue.as_raw());
    }

    #[test]
    fn a_caption_positioned_off_frame_does_not_panic() {
        // Every drawing loop clips; a position dragged past the edge must
        // produce a partly- or fully-empty layer, never an out-of-bounds write.
        for (px, py) in [(-2.0, -2.0), (2.0, 2.0), (0.5, 1.5)] {
            let img = render_caption_layer(
                &CaptionCue::new("Off frame\nboth lines"),
                &style(|s| {
                    s.position_x = px;
                    s.position_y = py;
                }),
                320,
                180,
            )
            .expect("render");
            assert_eq!(img.dimensions(), (320, 180));
        }
    }

    #[test]
    fn a_zero_size_style_still_renders_without_panicking() {
        let img =
            render_caption_layer(&CaptionCue::new("Tiny"), &style(|s| s.size = 0.0), 320, 180)
                .expect("render");
        assert_eq!(img.dimensions(), (320, 180));
    }
}
