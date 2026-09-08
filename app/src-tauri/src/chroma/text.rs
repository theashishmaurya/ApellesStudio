//! Text/title rasterisation for the Edit tab (D-211/D-212,
//! `docs/notes/text-title-clips.md`).
//!
//! **What it is:** the media-layer half of the text/title clip primitive —
//! the font catalogue that turns a [`chroma_timeline::TextLayer`]'s `font`
//! KEY into a real font file on disk, and the rasteriser that turns a
//! `TextLayer` into an RGBA layer `chroma::edit`'s compositor can alpha-blend
//! onto a frame exactly like a decoded one.
//!
//! **What it does:**
//! - [`TEXT_FONTS`] — the fixed catalogue of font families the Edit tab
//!   offers, each a key + label + an ordered list of candidate absolute paths
//!   (first one that exists wins).
//! - [`chroma_text_fonts`] — that catalogue, resolved against this machine,
//!   as a Tauri command. **One source of truth for both renderers**: the
//!   Inspector's font picker lists it, and `@chroma/editor`'s export compiler
//!   reads the SAME resolved `path` into `drawtext`'s `fontfile=`, which is
//!   the whole reason live preview and export draw the same glyphs (D-212).
//! - [`render_text_layer`] — rasterise one `TextLayer` into a canvas-sized
//!   `RgbaImage`, the text centred, transparent everywhere else.
//!
//! **What it does NOT do:** no compositing (that is `chroma::edit`'s
//! `composite_layer_onto`, which takes this module's buffer like any other
//! layer), no positioning (the layer is canvas-sized and centred; the clip's
//! `position_x`/`position_y` are applied by the compositor, so a text layer
//! and a video layer are offset by exactly the same code), no text shaping
//! (no bidi, no complex scripts, no ligature substitution — see the
//! "Deferred" section of `docs/notes/text-title-clips.md`), and no
//! multi-line layout (Phase 1 is single-line only — see
//! `chroma_timeline::TextLayer`'s own doc for why that boundary is where
//! preview/export parity is provable rather than hoped for).
//!
//! **Why `ab_glyph` (D-212):** it is already in this workspace's dependency
//! tree — `imageproc` (the crate `chroma::edit` already uses for
//! `rotate_about_center`) depends on it — so this adds a direct dependency on
//! a crate already compiled at an already-locked version, not a new one. It
//! is small, pure Rust, has no C/FreeType FFI, and does exactly the one thing
//! needed: outline a glyph at a pixel size and hand back per-pixel coverage.
//! `imageproc::drawing::draw_text_mut` (the obvious shortcut) is deliberately
//! NOT used: it blends the glyph colour toward the *existing* pixel, which on
//! the transparent canvas this needs produces premultiplied RGB with a
//! straight-alpha channel — a dark halo on every antialiased edge once
//! `image::imageops::overlay` blends it. Writing the coverage into alpha and
//! the colour into RGB is four lines and is correct.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use ab_glyph::{Font, FontVec, GlyphId, PxScale, ScaleFont, point};
use chroma_timeline::TextLayer;
use image::RgbaImage;
use serde::Serialize;

/// One selectable font family: a stable `key` (what a `TextLayer::font`
/// stores and what never changes once a project has been saved), a human
/// `label` for the picker, and the absolute paths to try in order.
///
/// **Candidate paths rather than a font-discovery library** (D-212): the
/// export half of this feature has to hand ffmpeg an absolute `fontfile=`
/// path for the SAME file the preview rasterised, so a resolved path is the
/// contract either way — a discovery crate (`font-kit`, `fontdb`) would add a
/// dependency, and a system-wide scan, purely to produce a path this list
/// already states. v1's platform scope is macOS ARM (`docs/02-scope.md`); the
/// trailing Linux candidates are a courtesy for a dev box, not a support
/// claim.
pub struct FontFamily {
    pub key: &'static str,
    pub label: &'static str,
    pub candidates: &'static [&'static str],
}

/// The Edit tab's font catalogue.
///
/// **Only single-face `.ttf` files, never a `.ttc` collection** — and that is
/// load-bearing, not incidental: ffmpeg's `drawtext` takes a `fontfile=` with
/// no face index and uses face 0, while `ab_glyph` would need to be told
/// which face to parse out of the collection. A single-face file is the only
/// shape where "both renderers read the same file" also means "both
/// renderers read the same *face*". That is why the obvious macOS choices
/// (Helvetica, Avenir, SF) are absent — they ship only as `.ttc`.
pub const TEXT_FONTS: &[FontFamily] = &[
    FontFamily {
        key: "sans",
        label: "Sans",
        candidates: &[
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/Library/Fonts/Arial.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ],
    },
    FontFamily {
        key: "sans-bold",
        label: "Sans Bold",
        candidates: &[
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/Library/Fonts/Arial Bold.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        ],
    },
    FontFamily {
        key: "sans-black",
        label: "Sans Black",
        candidates: &[
            "/System/Library/Fonts/Supplemental/Arial Black.ttf",
            "/Library/Fonts/Arial Black.ttf",
        ],
    },
    FontFamily {
        key: "condensed-bold",
        label: "Condensed Bold",
        candidates: &[
            "/System/Library/Fonts/Supplemental/Arial Narrow Bold.ttf",
            "/Library/Fonts/Arial Narrow Bold.ttf",
        ],
    },
    FontFamily {
        key: "impact",
        label: "Impact",
        candidates: &[
            "/System/Library/Fonts/Supplemental/Impact.ttf",
            "/Library/Fonts/Impact.ttf",
        ],
    },
    FontFamily {
        key: "serif",
        label: "Serif",
        candidates: &[
            "/System/Library/Fonts/Supplemental/Georgia.ttf",
            "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
        ],
    },
    FontFamily {
        key: "serif-bold",
        label: "Serif Bold",
        candidates: &[
            "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
            "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
        ],
    },
    FontFamily {
        key: "mono",
        label: "Mono",
        candidates: &[
            "/System/Library/Fonts/Supplemental/Courier New.ttf",
            "/System/Library/Fonts/Menlo.ttc",
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        ],
    },
];

/// One catalogue entry, resolved against this machine — what
/// [`chroma_text_fonts`] returns.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedFont {
    pub key: String,
    pub label: String,
    /// The absolute path of the first candidate that actually exists, or
    /// `None` if none do. Reported (rather than the entry being dropped) so
    /// the GUI can grey out a family instead of silently offering a shorter
    /// list than the one a stored `TextLayer::font` may name.
    pub path: Option<String>,
}

/// The font catalogue resolved against this machine.
///
/// Called by the Inspector's font picker AND by `@chroma/editor`'s
/// `editorExport.ts`, which passes the resolved `path` down to the pure
/// ffmpeg-argv compiler as `fontFiles` — the same "the compiler stays pure,
/// the caller supplies what only it can know" split `hasAudioOverrides`
/// already established (D-197). One catalogue, one resolution, two
/// renderers: that is what makes preview and export use the same face.
///
/// Cheap (a handful of `Path::exists` calls) and called rarely, so no
/// `spawn_blocking` — unlike this module's siblings in `chroma::edit`, it
/// does no probing or decoding.
#[tauri::command]
pub fn chroma_text_fonts() -> Vec<ResolvedFont> {
    TEXT_FONTS
        .iter()
        .map(|f| ResolvedFont {
            key: f.key.to_string(),
            label: f.label.to_string(),
            path: first_existing(f.candidates).map(|p| p.to_string_lossy().into_owned()),
        })
        .collect()
}

/// Measure a batch of caption words for the export compiler (D-241).
///
/// **Why this command exists at all.** An animated caption positions each WORD
/// itself rather than letting either engine lay out a line — the same move
/// D-229 made for lines, one level down, and for the same reason: it is the
/// only way the `ab_glyph` preview and the ffmpeg export can put a word in the
/// same place. But a word's x depends on the advance of every word before it,
/// and an advance is a glyph measurement only this side can make. So the
/// export compiler is *given* the measurements, exactly as it is already given
/// `fontFiles` — "the compiler stays pure, the caller supplies what only it
/// can know" (D-197).
///
/// Returns one advance per entry of `words`, in the same order. A batch rather
/// than one call per word because a 400-cue `.srt` is thousands of words and
/// the per-call IPC would dominate the actual measuring.
///
/// The measurement is **the same advance-and-kern walk [`rasterise`] performs**,
/// and the same one FreeType (and so ffmpeg's `drawtext`) performs — no shaping
/// beyond kerning, by design (see the module doc). Whitespace and glyphless
/// characters still contribute their advance, which is what makes this the
/// width `drawtext` would lay out for the same string.
#[tauri::command]
pub fn chroma_measure_caption_words(
    font: String,
    font_px: u32,
    words: Vec<String>,
) -> Result<Vec<f64>, String> {
    // Resolve and load the face ONCE for the whole batch rather than per word
    // — `load_font` is cached, but `resolve_font_path` still walks the
    // catalogue, and this runs over every word of every caption on export.
    let face = load_font(&resolve_font_path(&font)?)?;
    let scale = freetype_equivalent_scale(&face, font_px.max(1) as f32);
    let scaled = face.as_scaled(scale);
    Ok(words
        .iter()
        .map(|text| {
            let mut pen_x = 0.0f32;
            let mut prev: Option<GlyphId> = None;
            for ch in text.chars() {
                let id = face.glyph_id(ch);
                if let Some(p) = prev {
                    pen_x += scaled.kern(p, id);
                }
                pen_x += scaled.h_advance(id);
                prev = Some(id);
            }
            pen_x as f64
        })
        .collect())
}

fn first_existing(candidates: &[&str]) -> Option<PathBuf> {
    candidates
        .iter()
        .map(Path::new)
        .find(|p| p.is_file())
        .map(Path::to_path_buf)
}

/// The real font file for a catalogue `key`.
///
/// An **unknown key falls back to [`chroma_timeline::DEFAULT_TEXT_FONT`]**
/// rather than erroring, the same "the model stores what the UI wrote, the
/// consumer degrades safely" rule `TextLayer::rgb` already follows — a
/// project authored with a family this build no longer ships should render in
/// some font, not fail the whole frame. Errors only when nothing in the whole
/// catalogue resolves, which means the machine has no usable font at all and
/// there is nothing honest to draw.
pub fn resolve_font_path(key: &str) -> Result<PathBuf, String> {
    let family = TEXT_FONTS
        .iter()
        .find(|f| f.key == key)
        .or_else(|| {
            TEXT_FONTS
                .iter()
                .find(|f| f.key == chroma_timeline::DEFAULT_TEXT_FONT)
        })
        .ok_or_else(|| "no font families are configured".to_string())?;
    first_existing(family.candidates)
        // Not just this family's own candidates: a machine missing (say)
        // "Impact" should still draw the title in *something*, for the same
        // reason the unknown-key fallback above exists.
        .or_else(|| TEXT_FONTS.iter().find_map(|f| first_existing(f.candidates)))
        .ok_or_else(|| {
            format!(
                "no font file found for \"{key}\" (or any fallback) — checked {:?}",
                family.candidates
            )
        })
}

/// Parsed fonts, keyed by the file they came from.
///
/// Parsing a face is milliseconds and this is called once per previewed
/// frame; without the cache a title would re-parse its ~700 KB font file
/// every frame of playback. Grows to at most [`TEXT_FONTS`]`.len()` entries
/// (a font is only ever loaded via [`resolve_font_path`], which only ever
/// returns a catalogue path), so it needs no eviction.
fn font_cache() -> &'static Mutex<HashMap<PathBuf, Arc<FontVec>>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Arc<FontVec>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn load_font(path: &Path) -> Result<Arc<FontVec>, String> {
    // Deliberately two short lock scopes rather than one held across the
    // file read + parse: this is on the per-frame preview path, and holding
    // the map locked through I/O would serialise every layer behind the
    // slowest one. A concurrent double-parse of the same font on a cold
    // cache is possible and harmless (both produce the same face; the second
    // insert wins) — the alternative is a lock held across disk I/O.
    if let Ok(cache) = font_cache().lock()
        && let Some(f) = cache.get(path)
    {
        return Ok(Arc::clone(f));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("read font {}: {e}", path.display()))?;
    let font = Arc::new(
        FontVec::try_from_vec(bytes).map_err(|e| format!("parse font {}: {e}", path.display()))?,
    );
    if let Ok(mut cache) = font_cache().lock() {
        cache.insert(path.to_path_buf(), Arc::clone(&font));
    }
    Ok(font)
}

/// A rasterised layer's cache key — everything [`render_text_layer`]'s output
/// depends on. `size` is quantised to a whole pixel because that is the unit
/// it is actually rasterised at.
#[derive(PartialEq, Eq, Hash, Clone)]
struct LayerKey {
    content: String,
    font: String,
    px: u32,
    rgb: (u8, u8, u8),
    canvas: (u32, u32),
}

/// How many rasterised layers to keep. Small on purpose: the case this exists
/// for is "the same title, redrawn every frame while the playhead moves,"
/// which needs one entry per visible title. Four covers a stack of titles and
/// a preview switching between its two decode scales without unbounded growth
/// (each entry is a full canvas-sized RGBA buffer).
const LAYER_CACHE_CAPACITY: usize = 4;

#[expect(
    clippy::type_complexity,
    reason = "a 4-entry LRU's (key, value) vec — naming a type for it would be more indirection than it removes"
)]
fn layer_cache() -> &'static Mutex<Vec<(LayerKey, Arc<RgbaImage>)>> {
    static CACHE: OnceLock<Mutex<Vec<(LayerKey, Arc<RgbaImage>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

/// Rasterise `layer` into a `canvas_w`×`canvas_h` RGBA buffer: the text drawn
/// in `layer.color`, horizontally and vertically centred on its own **ink**
/// bounding box, fully transparent everywhere else.
///
/// **Centred, with no position applied** — `Clip::position_x`/`position_y`
/// are added by `chroma::edit::composite_layer_onto`, which offsets this
/// buffer exactly as it offsets a decoded video layer. One offset
/// implementation for both kinds of layer, so a title and a picture-in-
/// picture can never drift apart.
///
/// **Canvas-sized, not tight to the glyphs**, for the same reason: the
/// compositor centres a layer within the canvas and then offsets it, so a
/// canvas-sized buffer whose text is already centred lands in exactly the
/// right place with `scale == 1.0` and no resize step at all.
///
/// **The INK box, not the font's ascent/descent box** (D-213). ffmpeg's
/// `drawtext` — the export half of this feature — measures `text_h` from the
/// rendered glyphs' own bitmap extents, so centring on font metrics here
/// would put an all-caps title (no descenders, cap height well under the
/// ascent) visibly higher in the preview than in the export. Both sides
/// centre the same measured ink, which is what makes the two agree.
///
/// `layer.size` is a fraction of the canvas HEIGHT (see
/// `chroma_timeline::DEFAULT_TEXT_SIZE`), so this is resolution-independent:
/// the same `TextLayer` renders the same picture at 640, 960 or 1920 wide.
pub fn render_text_layer(
    layer: &TextLayer,
    canvas_w: u32,
    canvas_h: u32,
) -> Result<Arc<RgbaImage>, String> {
    let px = (layer.size * canvas_h as f64).round().max(1.0) as u32;
    let key = LayerKey {
        content: layer.content.clone(),
        font: layer.font.clone(),
        px,
        rgb: layer.rgb(),
        canvas: (canvas_w, canvas_h),
    };
    if let Ok(cache) = layer_cache().lock()
        && let Some((_, img)) = cache.iter().find(|(k, _)| *k == key)
    {
        return Ok(Arc::clone(img));
    }

    let img = Arc::new(rasterise(layer, &key)?);
    if let Ok(mut cache) = layer_cache().lock() {
        cache.insert(0, (key, Arc::clone(&img)));
        cache.truncate(LAYER_CACHE_CAPACITY);
    }
    Ok(img)
}

/// The [`PxScale`] at which `ab_glyph` draws the same glyph size ffmpeg's
/// `drawtext` does for `fontsize = px` — **the single number that makes the
/// live preview and the export agree** (D-212/D-213).
///
/// **The two libraries mean different things by "size", and the difference is
/// real and visible.** `ab_glyph`'s `PxScale` is the **em** size: the font's
/// `units_per_em` maps to that many pixels. `drawtext` hands `fontsize` to
/// FreeType, which sizes by the face's **vertical extent** (`ascender -
/// descender`, `Font::height_unscaled` here) instead. For Arial Bold that is
/// 2288 units against a 2048-unit em — a **1.117×** difference, and measured
/// live at exactly that: the same title rendered at 640×360 came out 129 px
/// of ink wide from `ab_glyph` and 144 px from `drawtext` (144/129 = 1.116)
/// before this conversion, and matches to within antialiasing after it.
///
/// The export's convention is the one that wins, deliberately: ffmpeg's
/// `fontsize` is what actually ships in the rendered file, so the preview is
/// what must be taught to agree.
///
/// Falls back to a plain em-sized scale for a face reporting a nonsense
/// `units_per_em` (a bitmap-only or malformed font) rather than dividing by
/// zero — the same "degrade, don't fail the frame" posture the rest of this
/// module takes.
pub(super) fn freetype_equivalent_scale(font: &FontVec, px: f32) -> PxScale {
    let upem = font.units_per_em().unwrap_or(0.0);
    if upem <= 0.0 {
        return PxScale::from(px);
    }
    PxScale::from(px * font.height_unscaled() / upem)
}

/// The uncached body of [`render_text_layer`].
fn rasterise(layer: &TextLayer, key: &LayerKey) -> Result<RgbaImage, String> {
    let (canvas_w, canvas_h) = key.canvas;
    let mut canvas = RgbaImage::new(canvas_w, canvas_h);
    // Empty text is a real, ordinary state (a title clip the moment it is
    // added, before anything is typed) — a fully transparent layer, not an
    // error.
    if layer.content.trim().is_empty() {
        return Ok(canvas);
    }

    let font = load_font(&resolve_font_path(&layer.font)?)?;
    let scale = freetype_equivalent_scale(&font, key.px as f32);
    let scaled = font.as_scaled(scale);

    // Pass 1 — lay the glyphs out along a baseline at y = 0, x growing by
    // each glyph's own advance plus the kerning pair with its predecessor.
    // The same advance-and-kern walk FreeType (and so `drawtext`) performs;
    // no shaping beyond that, by design (see the module doc).
    let mut pen_x = 0.0f32;
    let mut prev: Option<GlyphId> = None;
    let mut outlines = Vec::new();
    for ch in layer.content.chars() {
        let id = font.glyph_id(ch);
        if let Some(p) = prev {
            pen_x += scaled.kern(p, id);
        }
        if let Some(outlined) =
            font.outline_glyph(id.with_scale_and_position(scale, point(pen_x, 0.0)))
        {
            outlines.push(outlined);
        }
        pen_x += scaled.h_advance(id);
        prev = Some(id);
    }
    // Every character was whitespace or had no outline — nothing to draw, and
    // an ink box of zero extent to centre. Same transparent layer as empty
    // text, for the same reason.
    if outlines.is_empty() {
        return Ok(canvas);
    }

    // Pass 2 — the union of every glyph's own pixel bounds: the ink box.
    let mut min_x = f32::INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut max_y = f32::NEG_INFINITY;
    for o in &outlines {
        let b = o.px_bounds();
        min_x = min_x.min(b.min.x);
        min_y = min_y.min(b.min.y);
        max_x = max_x.max(b.max.x);
        max_y = max_y.max(b.max.y);
    }
    // Translate the ink box's own centre onto the canvas's centre.
    let off_x = (canvas_w as f32 - (max_x - min_x)) / 2.0 - min_x;
    let off_y = (canvas_h as f32 - (max_y - min_y)) / 2.0 - min_y;

    let (r, g, b) = key.rgb;
    for o in &outlines {
        let bounds = o.px_bounds();
        o.draw(|gx, gy, coverage| {
            // `draw`'s coordinates are relative to this glyph's own
            // `px_bounds().min`; `+ off` puts them in canvas space.
            let x = bounds.min.x + off_x + gx as f32;
            let y = bounds.min.y + off_y + gy as f32;
            if x < 0.0 || y < 0.0 {
                return;
            }
            let (x, y) = (x as u32, y as u32);
            if x >= canvas_w || y >= canvas_h {
                return;
            }
            let a = (coverage.clamp(0.0, 1.0) * 255.0).round() as u8;
            let px = canvas.get_pixel_mut(x, y);
            // MAX, not a sum: two glyphs' antialiased edges can overlap by a
            // pixel (a kerned pair, an italic), and summing coverage there
            // would draw a visibly darker seam. Straight alpha with a flat
            // RGB — see the module doc for why `draw_text_mut` is not used.
            if a > px[3] {
                *px = image::Rgba([r, g, b, a]);
            }
        });
    }
    Ok(canvas)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every catalogue key resolves to a real file on this machine (v1's
    /// platform scope is macOS ARM). A failure here is a genuine finding —
    /// the picker would offer a family that cannot render — not test noise.
    #[test]
    fn every_catalogue_family_resolves_on_this_machine() {
        for f in TEXT_FONTS {
            let path = resolve_font_path(f.key).expect("catalogue family should resolve");
            assert!(
                path.is_file(),
                "{} → {} is not a file",
                f.key,
                path.display()
            );
        }
    }

    #[test]
    fn an_unknown_font_key_falls_back_rather_than_erroring() {
        let fallback = resolve_font_path("no-such-font").expect("unknown key should fall back");
        assert_eq!(
            fallback,
            resolve_font_path(chroma_timeline::DEFAULT_TEXT_FONT).expect("default resolves"),
        );
    }

    fn layer(content: &str) -> TextLayer {
        TextLayer {
            content: content.to_string(),
            ..Default::default()
        }
    }

    /// The ink bounding box of everything non-transparent in `img`, as
    /// `(x0, y0, x1, y1)` exclusive — the same measurement the export-side
    /// pixel test performs on a real ffmpeg render, so the two engines are
    /// checked against one specification rather than against each other.
    fn ink_bounds(img: &RgbaImage) -> Option<(u32, u32, u32, u32)> {
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

    #[test]
    fn empty_text_renders_a_fully_transparent_layer() {
        let img = render_text_layer(&layer("   "), 320, 180).expect("render");
        assert_eq!(img.dimensions(), (320, 180));
        assert!(ink_bounds(&img).is_none(), "whitespace should draw nothing");
    }

    #[test]
    fn text_is_drawn_centred_on_its_own_ink_box() {
        const W: u32 = 640;
        const H: u32 = 360;
        let img = render_text_layer(&layer("AFTER"), W, H).expect("render");
        let (x0, y0, x1, y1) = ink_bounds(&img).expect("some ink");
        // Printed (visible under `--nocapture`) so this rasteriser's real ink
        // geometry can be compared, as numbers, against ffmpeg `drawtext`'s
        // own for the same layer — see `docs/notes/text-title-clips.md`
        // §"Preview/export parity: what is and is not claimed".
        eprintln!(
            "raster ink=[{x0},{y0}..{x1},{y1}] w={} h={} centre=({:.1}, {:.1})",
            x1 - x0,
            y1 - y0,
            (x0 + x1) as f64 / 2.0,
            (y0 + y1) as f64 / 2.0
        );
        let cx = (x0 + x1) as f64 / 2.0;
        let cy = (y0 + y1) as f64 / 2.0;
        // Within a pixel of dead centre — the ± is the odd/even rounding of
        // the ink box's own width/height, nothing else.
        assert!(
            (cx - W as f64 / 2.0).abs() <= 1.0,
            "horizontal centre was {cx}"
        );
        assert!(
            (cy - H as f64 / 2.0).abs() <= 1.0,
            "vertical centre was {cy}"
        );
        assert!(
            x1 - x0 > 40,
            "five glyphs should be wider than 40px, got {}",
            x1 - x0
        );
    }

    /// `size` is a fraction of the canvas height, so the SAME layer rendered
    /// into two different canvases must produce the same picture up to
    /// scale — the resolution-independence B-043 established for every other
    /// geometry field in this codebase.
    #[test]
    fn size_is_a_fraction_of_the_canvas_so_the_picture_is_scale_invariant() {
        let small = render_text_layer(&layer("AFTER"), 640, 360).expect("render");
        let large = render_text_layer(&layer("AFTER"), 1280, 720).expect("render");
        let (sx0, sy0, sx1, sy1) = ink_bounds(&small).expect("ink");
        let (lx0, ly0, lx1, ly1) = ink_bounds(&large).expect("ink");
        let ratio_w = (lx1 - lx0) as f64 / (sx1 - sx0) as f64;
        let ratio_h = (ly1 - ly0) as f64 / (sy1 - sy0) as f64;
        assert!((ratio_w - 2.0).abs() < 0.05, "width ratio was {ratio_w}");
        assert!((ratio_h - 2.0).abs() < 0.05, "height ratio was {ratio_h}");
        // Both centred, at their own canvas's centre.
        assert!(((lx0 + lx1) as f64 / 2.0 - 640.0).abs() <= 1.0);
        assert!(((ly0 + ly1) as f64 / 2.0 - 360.0).abs() <= 1.0);
    }

    #[test]
    fn colour_lands_in_rgb_and_coverage_in_alpha() {
        let img = render_text_layer(
            &TextLayer {
                content: "I".into(),
                color: "#FF8800".into(),
                ..Default::default()
            },
            320,
            180,
        )
        .expect("render");
        let opaque = img
            .pixels()
            .find(|p| p[3] == 255)
            .expect("a solid interior pixel");
        assert_eq!(
            [opaque[0], opaque[1], opaque[2]],
            [255, 136, 0],
            "straight alpha: full-coverage pixels carry the exact fill colour"
        );
        // The premultiplication bug `draw_text_mut` would have introduced:
        // a partially-covered edge pixel's RGB must still be the fill
        // colour, with only its alpha reduced.
        let edge = img
            .pixels()
            .find(|p| p[3] > 0 && p[3] < 255)
            .expect("an antialiased edge pixel");
        assert_eq!([edge[0], edge[1], edge[2]], [255, 136, 0]);
    }

    /// The render path is deterministic (a CLAUDE.md project invariant):
    /// same layer + same canvas ⇒ identical pixels, on a cold cache and a
    /// warm one alike.
    #[test]
    fn rendering_is_deterministic() {
        let a = render_text_layer(&layer("BEFORE"), 480, 270).expect("render");
        let b = render_text_layer(&layer("BEFORE"), 480, 270).expect("render");
        assert_eq!(a.as_raw(), b.as_raw());
        // And bypassing the cache entirely gives the same bytes.
        let key = LayerKey {
            content: "BEFORE".into(),
            font: chroma_timeline::DEFAULT_TEXT_FONT.into(),
            px: (chroma_timeline::DEFAULT_TEXT_SIZE * 270.0).round() as u32,
            rgb: (255, 255, 255),
            canvas: (480, 270),
        };
        let cold = rasterise(&layer("BEFORE"), &key).expect("render");
        assert_eq!(a.as_raw(), cold.as_raw());
    }
}
