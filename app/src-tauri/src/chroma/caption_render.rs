//! Caption rasterisation for the Edit tab (D-229, `docs/notes/subtitles.md`).
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
use chroma_timeline::caption_anim::{
    CaptionAnimation, CaptionWordState, caption_active_word, caption_word_rgb, caption_word_state,
    caption_words,
};
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
    /// D-243 — `Some` only for an ANIMATED caption; see the key's construction
    /// in [`render_caption_layer`] for why a static one stays time-free.
    time: Option<(i64, i64)>,
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
    time: CaptionTime,
) -> Result<Arc<RgbaImage>, String> {
    let animated = style.animation_or_default().kind.is_per_word();
    let key = CaptionKey {
        text: cue.text.clone(),
        style: format!("{style:?}"),
        canvas: (canvas_w, canvas_h),
        // D-243 — the time is part of the key ONLY for an animated caption.
        // A static caption is the same pixels at every frame, so keeping its
        // key time-free preserves D-229's cache behaviour exactly (one entry
        // serves the cue's whole span); an animated one genuinely differs per
        // frame, and a key that ignored that would serve the first frame's
        // pixels for the entire cue.
        time: if animated {
            Some(time.quantised())
        } else {
            None
        },
    };
    if let Ok(cache) = caption_cache().lock()
        && let Some((_, img)) = cache.iter().find(|(k, _)| *k == key)
    {
        return Ok(Arc::clone(img));
    }

    let img = Arc::new(rasterise_caption(cue, style, canvas_w, canvas_h, time)?);
    if let Ok(mut cache) = caption_cache().lock() {
        cache.insert(0, (key, Arc::clone(&img)));
        cache.truncate(CAPTION_CACHE_CAPACITY);
    }
    Ok(img)
}

/// Where in its own clip a caption is being drawn (D-243).
///
/// Both numbers are **clip-local seconds**, so a cue that is moved or rippled
/// animates identically — the same reason `CaptionWord`'s own windows are
/// clip-local.
///
/// A static (D-229) caption ignores this entirely, which is why
/// [`CaptionTime::STATIC`] exists: a caller with no timing to offer (a
/// thumbnail, a test) names it explicitly rather than passing zeroes whose
/// meaning is not obvious at the call site.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CaptionTime {
    /// How far into the clip this frame is, in seconds.
    pub t_secs: f64,
    /// The clip's whole duration, in seconds — what the per-word windows are
    /// derived from.
    pub dur_secs: f64,
}

impl CaptionTime {
    /// The time a caption with no animation is drawn at. Renders exactly what
    /// D-229 rendered.
    pub const STATIC: Self = Self {
        t_secs: 0.0,
        dur_secs: 0.0,
    };

    /// The cache key's view of this time — milliseconds, rounded.
    ///
    /// Quantised rather than used raw because an `f64` is not `Eq`/`Hash` and
    /// because two frames that round to the same millisecond genuinely are the
    /// same picture at any frame rate this app supports (1 ms is 1/40th of a
    /// 24 fps frame).
    fn quantised(self) -> (i64, i64) {
        let ms = |v: f64| {
            if v.is_finite() {
                (v * 1000.0).round() as i64
            } else {
                0
            }
        };
        (ms(self.t_secs), ms(self.dur_secs))
    }
}

/// The uncached body of [`render_caption_layer`].
fn rasterise_caption(
    cue: &CaptionCue,
    style: &CaptionStyle,
    canvas_w: u32,
    canvas_h: u32,
    time: CaptionTime,
) -> Result<RgbaImage, String> {
    let mut canvas = RgbaImage::new(canvas_w, canvas_h);
    let lines = cue.lines();
    // A cue with nothing in it is a real, ordinary state (a caption clip the
    // moment it is added, before anything is typed) — a fully transparent
    // layer, not an error. Same posture `render_text_layer` takes.
    if lines.is_empty() {
        return Ok(canvas);
    }

    let anim = style.animation_or_default();
    if anim.kind.is_per_word() {
        return rasterise_animated_caption(&lines, style, &anim, canvas, canvas_w, canvas_h, time);
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

/// The per-word body of [`rasterise_caption`] (D-243).
///
/// **What makes this different from the static path:** the static path hands a
/// whole LINE to one glyph run and lets its advance decide the line's width.
/// This path positions every WORD itself — one level further down the same
/// move D-229 made for lines, for the same reason: it is the only way this
/// rasteriser and ffmpeg's `drawtext` put a word in the same place. Each word
/// is an independent single-word draw at an x this function computes, so
/// neither engine is ever asked to lay out a run of words.
///
/// The measurement it uses (`ab_glyph` advance + kern) is the same one
/// `chroma::text::chroma_measure_caption_words` hands the export compiler, so
/// both sides compute the identical x from the identical advances.
fn rasterise_animated_caption(
    lines: &[&str],
    style: &CaptionStyle,
    anim: &CaptionAnimation,
    mut canvas: RgbaImage,
    canvas_w: u32,
    canvas_h: u32,
    time: CaptionTime,
) -> Result<RgbaImage, String> {
    let font = load_font(&resolve_font_path(&style.font)?)?;
    // `Slam` shows one word alone, so it lays out as a SINGLE line regardless
    // of how the cue is broken — the cue's line breaks are a reading aid for a
    // whole-line caption and mean nothing when only one word is on screen.
    let line_count = if anim.kind.is_single_word() {
        1
    } else {
        lines.len()
    };
    let layout = CaptionLayout::resolve(style, canvas_w, canvas_h, line_count);
    let scale = freetype_equivalent_scale(&font, layout.font_px as f32);
    let scaled = font.as_scaled(scale);
    let ascent = scaled.ascent();
    let line_box_h = scaled.height() + scaled.line_gap();
    let font_px = layout.font_px as f32;

    let words = caption_words(lines, time.dur_secs);
    if words.is_empty() {
        return Ok(canvas);
    }
    let gap_px = (anim.word_gap.max(0.0) as f32) * font_px;

    // One measured advance per word — the same walk `advance_width` performs.
    let advance_of = |text: &str| -> f32 {
        let mut pen = 0.0f32;
        let mut prev: Option<GlyphId> = None;
        for ch in text.chars() {
            let id = font.glyph_id(ch);
            if let Some(p) = prev {
                pen += scaled.kern(p, id);
            }
            pen += scaled.h_advance(id);
            prev = Some(id);
        }
        pen
    };
    let advances: Vec<f32> = words.iter().map(|w| advance_of(&w.text)).collect();

    /// One word, placed and evaluated — everything the draw passes need.
    struct PlacedWord {
        index: usize,
        pen_x: f32,
        baseline: f32,
        line_top: f32,
        advance: f32,
        state: CaptionWordState,
    }

    let mut placed: Vec<PlacedWord> = Vec::with_capacity(words.len());

    if anim.kind.is_single_word() {
        // Only the active word exists. It is centred on the anchor by the
        // style's own alignment rule, exactly as a one-word line would be —
        // which is what makes its x reproducible in ffmpeg from `text_w`
        // alone, with no cross-word measurement at all.
        let active = caption_active_word(&words, time.t_secs);
        let state = caption_word_state(&words, active, anim, time.t_secs);
        if state.visible {
            let all_lines = layout.lines();
            let geom = *all_lines
                .last()
                .ok_or_else(|| "caption layout produced no lines".to_string())?;
            let advance = advances[active];
            let x_anchor = geom.x_anchor as f32;
            let base_x = match style.align {
                CaptionAlign::Left => x_anchor,
                CaptionAlign::Center => x_anchor - advance / 2.0,
                CaptionAlign::Right => x_anchor - advance,
            };
            placed.push(PlacedWord {
                index: active,
                pen_x: base_x + (state.dx as f32) * font_px,
                baseline: geom.line_top as f32 + (state.dy as f32) * font_px + ascent,
                line_top: geom.line_top as f32 + (state.dy as f32) * font_px,
                advance,
                state,
            });
        }
    } else {
        // Whole-line modes: walk each line's words, accumulating x from the
        // measured advances plus the style's own word gap.
        for (line_index, geom) in layout.lines().into_iter().enumerate() {
            let on_line: Vec<usize> = words
                .iter()
                .enumerate()
                .filter(|(_, w)| w.line == line_index)
                .map(|(i, _)| i)
                .collect();
            if on_line.is_empty() {
                continue;
            }
            // The line's total width is OURS — the sum of the word advances
            // plus one gap between each pair — so alignment lands identically
            // in both engines.
            let total: f32 = on_line.iter().map(|i| advances[*i]).sum::<f32>()
                + gap_px * (on_line.len().saturating_sub(1)) as f32;
            let x_anchor = geom.x_anchor as f32;
            let mut cursor = match style.align {
                CaptionAlign::Left => x_anchor,
                CaptionAlign::Center => x_anchor - total / 2.0,
                CaptionAlign::Right => x_anchor - total,
            };
            for wi in on_line {
                let state = caption_word_state(&words, wi, anim, time.t_secs);
                let advance = advances[wi];
                placed.push(PlacedWord {
                    index: wi,
                    pen_x: cursor + (state.dx as f32) * font_px,
                    baseline: geom.line_top as f32 + (state.dy as f32) * font_px + ascent,
                    line_top: geom.line_top as f32 + (state.dy as f32) * font_px,
                    advance,
                    state,
                });
                cursor += advance + gap_px;
            }
        }
    }

    // Pass 1 — the style's own per-LINE background box, underneath everything,
    // spanning the words actually on that line. Drawn before any glyph for the
    // same reason the static path does it: so a descender is never punched
    // through by a later line's box.
    if style.box_enabled {
        let (br, bg, bb) = style.box_rgb();
        let alpha = (style.box_alpha() * 255.0).round().clamp(0.0, 255.0) as u8;
        if alpha > 0 {
            let pad = layout.box_padding as f32;
            // Group the placed words by the line they landed on.
            let mut by_line: std::collections::BTreeMap<i64, (f32, f32, f32)> =
                std::collections::BTreeMap::new();
            for p in placed.iter().filter(|p| p.state.visible) {
                let key = p.line_top.round() as i64;
                let entry =
                    by_line
                        .entry(key)
                        .or_insert((f32::INFINITY, f32::NEG_INFINITY, p.line_top));
                entry.0 = entry.0.min(p.pen_x);
                entry.1 = entry.1.max(p.pen_x + p.advance);
                entry.2 = p.line_top;
            }
            for (min_x, max_x, line_top) in by_line.into_values() {
                if !min_x.is_finite() || !max_x.is_finite() || max_x <= min_x {
                    continue;
                }
                fill_rect(
                    &mut canvas,
                    min_x - pad,
                    line_top - pad,
                    (max_x - min_x) + pad * 2.0,
                    line_box_h + pad * 2.0,
                    [br, bg, bb, alpha],
                );
            }
        }
    }

    // Pass 2 — the active word's highlight box.
    //
    // A SQUARE rect, deliberately: ffmpeg's `drawbox` has no corner radius, so
    // a rounded box here would be a preview the export cannot reproduce —
    // exactly the divergence class D-211/D-229 refused to open. A real rounded
    // highlight needs a rounded-rect primitive in BOTH engines and is a named
    // follow-up in D-243.
    if let Some((hr, hg, hb)) = anim.active_box_rgb() {
        let pad_x = (anim.active_box_pad_x.max(0.0) as f32) * font_px;
        let pad_y = (anim.active_box_pad_y.max(0.0) as f32) * font_px;
        for p in &placed {
            if !p.state.visible || p.state.box_alpha <= 0.0 {
                continue;
            }
            let a = (p.state.box_alpha * 255.0).round().clamp(0.0, 255.0) as u8;
            if a == 0 {
                continue;
            }
            fill_rect(
                &mut canvas,
                p.pen_x - pad_x,
                p.line_top - pad_y,
                p.advance + pad_x * 2.0,
                line_box_h + pad_y * 2.0,
                [hr, hg, hb, a],
            );
        }
    }

    // Pass 3 — the glyphs, one word at a time.
    //
    // Per WORD rather than one mask for everything, because each word can carry
    // its own colour (a karaoke's spoken/active/upcoming) and its own alpha (a
    // build's entrance). The MAX-coverage rule within a word is what the static
    // path's single mask exists for — two kerned glyphs' antialiased edges
    // overlapping must not composite twice — and it still applies here; across
    // words there is always a real gap, so no seam is possible between them.
    let mut coverage = vec![0u8; (canvas_w as usize) * (canvas_h as usize)];
    for p in &placed {
        if !p.state.visible || p.state.alpha <= 0.0 {
            continue;
        }
        let word = &words[p.index];
        // Lay this word's glyphs out from its own pen and record the touched
        // span, so the shared buffer is cleared over that span only rather
        // than being reallocated per word.
        let mut touched: Vec<usize> = Vec::new();
        let mut pen = 0.0f32;
        let mut prev: Option<GlyphId> = None;
        for ch in word.text.chars() {
            let id = font.glyph_id(ch);
            if let Some(prev_id) = prev {
                pen += scaled.kern(prev_id, id);
            }
            if let Some(o) = font.outline_glyph(id.with_scale_and_position(scale, point(pen, 0.0)))
            {
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
                    let i = y as usize * canvas_w as usize + x as usize;
                    if coverage[i] == 0 {
                        touched.push(i);
                    }
                    coverage[i] = coverage[i].max(a);
                });
            }
            pen += scaled.h_advance(id);
            prev = Some(id);
        }

        let (r, g, b) = caption_word_rgb(p.state.phase, anim, style);
        let word_alpha = p.state.alpha.clamp(0.0, 1.0);
        for i in touched {
            let cov = coverage[i];
            coverage[i] = 0;
            if cov == 0 {
                continue;
            }
            let cov = ((cov as f64) * word_alpha).round().clamp(0.0, 255.0) as u8;
            if cov == 0 {
                continue;
            }
            let x = (i % canvas_w as usize) as u32;
            let y = (i / canvas_w as usize) as u32;
            let px = canvas.get_pixel_mut(x, y);
            *px = over([r, g, b, cov], px.0);
        }
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
    use chroma_timeline::caption_anim::CaptionAnimKind;

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
            CaptionTime::STATIC,
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
            CaptionTime::STATIC,
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
            CaptionTime::STATIC,
        )
        .expect("render");
        let two = render_caption_layer(
            &CaptionCue::new("first\nsecond"),
            &CaptionStyle::default(),
            640,
            360,
            CaptionTime::STATIC,
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
            CaptionTime::STATIC,
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
            CaptionTime::STATIC,
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
            CaptionTime::STATIC,
        )
        .expect("render");
        let without = render_caption_layer(
            &CaptionCue::new("Hello"),
            &style(|s| s.box_enabled = false),
            640,
            360,
            CaptionTime::STATIC,
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
            CaptionTime::STATIC,
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
            CaptionTime::STATIC,
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
            CaptionTime::STATIC,
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
            CaptionTime::STATIC,
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
        let warm = render_caption_layer(&cue, &s, 320, 180, CaptionTime::STATIC).expect("render");
        let again = render_caption_layer(&cue, &s, 320, 180, CaptionTime::STATIC).expect("render");
        let cold = rasterise_caption(&cue, &s, 320, 180, CaptionTime::STATIC).expect("render");
        assert_eq!(warm.as_raw(), again.as_raw());
        assert_eq!(warm.as_raw(), cold.as_raw());
    }

    #[test]
    fn a_style_change_is_not_served_from_the_cache() {
        let cue = CaptionCue::new("Hi");
        let red = render_caption_layer(
            &cue,
            &style(|s| s.color = "#FF0000".into()),
            320,
            180,
            CaptionTime::STATIC,
        )
        .expect("render");
        let blue = render_caption_layer(
            &cue,
            &style(|s| s.color = "#0000FF".into()),
            320,
            180,
            CaptionTime::STATIC,
        )
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
                CaptionTime::STATIC,
            )
            .expect("render");
            assert_eq!(img.dimensions(), (320, 180));
        }
    }

    #[test]
    fn a_zero_size_style_still_renders_without_panicking() {
        let img = render_caption_layer(
            &CaptionCue::new("Tiny"),
            &style(|s| s.size = 0.0),
            320,
            180,
            CaptionTime::STATIC,
        )
        .expect("render");
        assert_eq!(img.dimensions(), (320, 180));
    }

    // ---------------------------------------------------------------------- //
    // D-243 — the ANIMATED (per-word) path
    //
    // The preview half of the parity story. `captionAnimExport.ffmpeg.test.ts`
    // asserts the same contract on the export side by rendering real pixels,
    // and `caption_anim`'s own tests pin the arithmetic both share. What is
    // checked here is that this rasteriser actually consults the model: that a
    // build accumulates ink over time, that a slam shows one word and moves it,
    // that a highlight paints its box on the ACTIVE word, and — the regression
    // guard for the whole decision — that a static caption still renders
    // exactly what D-229 rendered.
    // ---------------------------------------------------------------------- //

    fn animated(kind: CaptionAnimKind, f: impl FnOnce(&mut CaptionAnimation)) -> CaptionStyle {
        let mut a = CaptionAnimation {
            kind,
            ..Default::default()
        };
        f(&mut a);
        style(|s| {
            s.animation = Some(a.clone());
            s.box_enabled = false;
            s.size = 0.1;
        })
    }

    /// How many pixels of any ink at all — the coarse "is there more on screen
    /// now than there was" measure the build/slam tests need.
    fn ink_count(img: &RgbaImage) -> usize {
        img.pixels().filter(|p| p[3] > 0).count()
    }

    /// Pixels matching a colour exactly at full alpha — used to find the
    /// highlight BOX, which is a flat fill and so is exact, unlike antialiased
    /// glyph edges.
    fn count_rgb(img: &RgbaImage, rgb: (u8, u8, u8)) -> usize {
        img.pixels()
            .filter(|p| p[3] == 255 && (p[0], p[1], p[2]) == rgb)
            .count()
    }

    /// Leftmost column holding ink of at least `min_alpha`.
    ///
    /// Needed alongside [`ink_bounds`], which requires a fully opaque pixel: a
    /// word that is still MOVING is, by construction, also still fading, since
    /// this model drives alpha and dx from the same easing. Measuring a slide
    /// therefore has to accept partly-transparent ink.
    fn ink_left(img: &RgbaImage, min_alpha: u8) -> Option<u32> {
        let mut best: Option<u32> = None;
        for (x, _y, p) in img.enumerate_pixels() {
            if p[3] >= min_alpha && best.is_none_or(|b| x < b) {
                best = Some(x);
            }
        }
        best
    }

    /// Leftmost column holding a pixel of exactly `rgb`.
    fn leftmost_rgb(img: &RgbaImage, rgb: (u8, u8, u8)) -> Option<u32> {
        let mut best: Option<u32> = None;
        for (x, _y, p) in img.enumerate_pixels() {
            if p[3] == 255 && (p[0], p[1], p[2]) == rgb && best.is_none_or(|b| x < b) {
                best = Some(x);
            }
        }
        best
    }

    #[test]
    fn a_static_caption_ignores_the_time_entirely() {
        // The regression guard: adding animation must not have changed what a
        // caption WITHOUT one renders, at any moment of its span.
        let cue = CaptionCue::new("Hello there");
        let s = CaptionStyle::default();
        let at_zero =
            render_caption_layer(&cue, &s, 320, 180, CaptionTime::STATIC).expect("render");
        let mid = render_caption_layer(
            &cue,
            &s,
            320,
            180,
            CaptionTime {
                t_secs: 1.5,
                dur_secs: 3.0,
            },
        )
        .expect("render");
        assert_eq!(at_zero.as_raw(), mid.as_raw());
    }

    #[test]
    fn a_build_accumulates_ink_as_its_words_land() {
        let cue = CaptionCue::new("alpha bravo charlie");
        let s = animated(CaptionAnimKind::Build, |a| {
            a.enter_secs = 0.05;
            a.enter_rise = 0.0;
        });
        let at = |t: f64| {
            ink_count(
                &render_caption_layer(
                    &cue,
                    &s,
                    640,
                    360,
                    CaptionTime {
                        t_secs: t,
                        dur_secs: 3.0,
                    },
                )
                .expect("render"),
            )
        };
        let early = at(0.4);
        let mid = at(1.4);
        let late = at(2.6);
        assert!(early > 0, "the first word is drawn");
        assert!(mid > early, "a second word has landed by 1.4s");
        assert!(late > mid, "the third word has landed by 2.6s");
    }

    #[test]
    fn a_slam_shows_one_word_and_moves_it_while_entering() {
        let cue = CaptionCue::new("alpha bravo charlie");
        let s = {
            let mut st = animated(CaptionAnimKind::Slam, |a| {
                // Longer than one word's own window, so both samples land
                // mid-slide rather than after it has settled.
                a.enter_secs = 2.0;
                a.enter_rise = 0.0;
            });
            // Big type, so the offset (a fraction of the font size) is many
            // pixels rather than one or two — and lifted off the default
            // subtitle position, which at this size would push a 72px em off
            // the bottom of a 360-tall canvas.
            st.size = 0.2;
            st.position_y = 0.4;
            st
        };
        let img_at = |t: f64| {
            render_caption_layer(
                &cue,
                &s,
                640,
                360,
                CaptionTime {
                    t_secs: t,
                    dur_secs: 3.0,
                },
            )
            .expect("render")
        };
        // BOTH samples must sit inside word 0's own window, which for
        // "alpha bravo charlie" over 3s ends at 3*5/17 = 0.88s — past that the
        // next word is active and this one is gone, which is the behaviour the
        // visibility assertion below relies on.
        let a = img_at(0.45);
        let b = img_at(0.85);
        // One word only — far less ink than the whole line would be.
        // The reference is the SAME cue at the SAME size, fully built — so the
        // comparison is one word against three, not one type size against
        // another.
        let whole_line = ink_count(
            &render_caption_layer(
                &cue,
                &{
                    let mut st = animated(CaptionAnimKind::Build, |x| x.enter_secs = 0.0);
                    st.size = 0.2;
                    st.position_y = 0.4;
                    st
                },
                640,
                360,
                CaptionTime {
                    t_secs: 2.9,
                    dur_secs: 3.0,
                },
            )
            .expect("render"),
        );
        assert!(
            ink_count(&a) < whole_line / 2,
            "a slam draws one word, not the line"
        );
        // And it MOVES: word 0 enters from the left (dx < 0) and eases to 0, so
        // its ink shifts right as it settles.
        let left_a = ink_left(&a, 60).expect("drew");
        let left_b = ink_left(&b, 60).expect("drew");
        assert!(
            left_b > left_a,
            "the word should slide right as it settles ({left_a} -> {left_b})"
        );
    }

    #[test]
    fn a_highlight_paints_its_box_and_moves_it_word_to_word() {
        let cue = CaptionCue::new("alpha bravo charlie");
        let red = (255u8, 23u8, 69u8);
        let s = animated(CaptionAnimKind::Highlight, |a| {
            a.active_box_color = Some("#FF1745".into());
            a.enter_secs = 0.05;
        });
        let img_at = |t: f64| {
            render_caption_layer(
                &cue,
                &s,
                640,
                360,
                CaptionTime {
                    t_secs: t,
                    dur_secs: 3.0,
                },
            )
            .expect("render")
        };
        let first = img_at(0.4);
        let second = img_at(1.4);
        let third = img_at(2.6);
        for (i, img) in [&first, &second, &third].iter().enumerate() {
            assert!(
                count_rgb(img, red) > 0,
                "a highlight box should be drawn at sample {i}"
            );
        }
        // The box travels left to right, one word at a time.
        let x0 = leftmost_rgb(&first, red).expect("box 1");
        let x1 = leftmost_rgb(&second, red).expect("box 2");
        let x2 = leftmost_rgb(&third, red).expect("box 3");
        assert!(x1 > x0, "the box moves to the second word ({x0} -> {x1})");
        assert!(x2 > x1, "and then to the third ({x1} -> {x2})");
    }

    #[test]
    fn a_karaoke_recolours_the_active_word_only() {
        let cue = CaptionCue::new("alpha bravo charlie");
        let s = animated(CaptionAnimKind::Karaoke, |a| {
            a.active_color = Some("#00FF00".into());
            a.spoken_color = Some("#FF0000".into());
            a.upcoming_color = Some("#0000FF".into());
            a.enter_secs = 0.0;
        });
        // Mid-cue: one word spoken, one active, one upcoming — all three
        // colours present at once, which is the whole point of a karaoke.
        let img = render_caption_layer(
            &cue,
            &s,
            640,
            360,
            CaptionTime {
                t_secs: 1.4,
                dur_secs: 3.0,
            },
        )
        .expect("render");
        assert!(count_rgb(&img, (255, 0, 0)) > 0, "a spoken word");
        assert!(count_rgb(&img, (0, 255, 0)) > 0, "the active word");
        assert!(count_rgb(&img, (0, 0, 255)) > 0, "an upcoming word");
    }

    #[test]
    fn an_animated_caption_is_not_served_a_stale_frame_from_the_cache() {
        // The cache key carries the time only for an animated caption; without
        // that, every frame of the cue would be served the first one's pixels.
        let cue = CaptionCue::new("alpha bravo charlie");
        let s = animated(CaptionAnimKind::Build, |a| a.enter_secs = 0.05);
        let a = render_caption_layer(
            &cue,
            &s,
            320,
            180,
            CaptionTime {
                t_secs: 0.2,
                dur_secs: 3.0,
            },
        )
        .expect("render");
        let b = render_caption_layer(
            &cue,
            &s,
            320,
            180,
            CaptionTime {
                t_secs: 2.8,
                dur_secs: 3.0,
            },
        )
        .expect("render");
        assert_ne!(a.as_raw(), b.as_raw(), "different frames, different pixels");
    }

    #[test]
    fn animated_rendering_is_deterministic() {
        // The render path's standing invariant: same input, same pixels.
        let cue = CaptionCue::new("alpha bravo charlie");
        let s = animated(CaptionAnimKind::Highlight, |a| {
            a.active_box_color = Some("#FF1745".into());
        });
        let t = CaptionTime {
            t_secs: 1.1,
            dur_secs: 3.0,
        };
        let a = render_caption_layer(&cue, &s, 320, 180, t).expect("render");
        let b = render_caption_layer(&cue, &s, 320, 180, t).expect("render");
        assert_eq!(a.as_raw(), b.as_raw());
    }

    #[test]
    fn an_animated_cue_with_no_words_renders_transparent_rather_than_panicking() {
        let s = animated(CaptionAnimKind::Slam, |_| {});
        let img = render_caption_layer(
            &CaptionCue::new("   "),
            &s,
            320,
            180,
            CaptionTime {
                t_secs: 1.0,
                dur_secs: 3.0,
            },
        )
        .expect("render");
        assert_eq!(ink_count(&img), 0);
    }
}
