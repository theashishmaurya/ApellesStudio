//! # Subtitles / captions — the model and the layout spec (D-229)
//!
//! **What it is:** the data a caption carries ([`CaptionCue`]), the style a
//! subtitle track (or one overriding cue) draws it with ([`CaptionStyle`]),
//! and — the load-bearing part — the **shared layout arithmetic**
//! ([`CaptionLayout`]) that decides where every line of a cue lands on the
//! composition.
//!
//! **What it does NOT do:** no rasterising, no font loading, no file parsing.
//! It never opens a font (it carries a font *key*, exactly as
//! [`crate::TextLayer`] does — see [`crate::DEFAULT_TEXT_FONT`]) and never
//! measures a glyph. Reading `.srt`/`.vtt`/`.ttml` is
//! [`crate::subtitle_import`]; drawing is `chroma::text` (`app/src-tauri`) for
//! the live preview and `@apelles/editor`'s `timelineExport.ts` for the export.
//!
//! ## Why this module exists at all: the two-engine parity problem
//!
//! Apelles renders every picture twice, in two different engines — the live
//! preview rasterises with `ab_glyph`, the export rasterises with ffmpeg's
//! `drawtext`/libfreetype — and a silent divergence between the two is the
//! recurring defect class this repo keeps closing (B-053, B-088, B-090,
//! B-094). D-211's single-line title dodged the hardest part of it by
//! **forbidding multi-line text**, on the honest grounds that inter-line
//! layout is the one thing the two engines genuinely disagree about.
//!
//! A caption cannot dodge it: real `.srt` files are full of two-line cues, and
//! silently joining them onto one line would mishandle the format. So the
//! divergence is closed rather than avoided, by making the line layout **ours
//! instead of either engine's**:
//!
//! 1. Every line of a cue is drawn as its own independent **single-line**
//!    draw — one `drawtext` node per line on the export side, one glyph run
//!    per line on the preview side. Neither engine is ever asked to lay out a
//!    second line, so neither engine's own multi-line rules are ever consulted.
//! 2. The vertical step between lines is [`CaptionLayout::line_step`] — plain
//!    integer arithmetic over the composition height and the style's own
//!    numbers, with no font metric in it at all. Both engines are handed the
//!    same integers.
//! 3. Each line is anchored by the **top of its font line box**, which is
//!    ffmpeg's `drawtext` `y_align=font` mode: measured across five
//!    font/size combinations, that mode puts the box top at exactly `y`
//!    regardless of what the string contains ("Ag", "xx" and "Wy" all
//!    produced an identical box), which is what makes a per-line `y` mean the
//!    same thing in both engines no matter which glyphs a line happens to have.
//!
//! ## The measured fact underneath (D-229)
//!
//! `drawtext` renders at **em = `fontsize` pixels**, and derives its
//! `y_align=font` line box from the face's own `hhea` table:
//!
//! ```text
//! line box height = (ascender - descender + lineGap) / unitsPerEm * fontsize
//! baseline offset =  ascender                        / unitsPerEm * fontsize
//! ```
//!
//! Verified directly against ffmpeg 7.1 for Arial / Arial Bold / Impact /
//! Times New Roman at 60–100 px: predicted 68.99 / 114.99 / 73.18 / 91.99,
//! measured 69 / 115 / 73 / 92. `ab_glyph`, scaled through
//! `chroma::text::freetype_equivalent_scale` (D-212), reports exactly those
//! same two numbers as `ScaleFont::ascent()` and
//! `ScaleFont::height() + ScaleFont::line_gap()` — because that function's
//! whole job is to cancel `ab_glyph`'s ascent-descent-based `PxScale` back to
//! an em-based one. So the preview reproduces ffmpeg's line box **from the
//! same font tables**, not from a fudge factor.
//!
//! That is why the box in [`CaptionStyle::box_enabled`] can be a real,
//! uniform-height band in both engines: ffmpeg draws it itself from those
//! metrics under `y_align=font`, and `chroma::text` computes the identical
//! rectangle from `ab_glyph`.
//!
//! ## What this module deliberately does not carry
//!
//! A caption cue is **not** a transformable clip. It has no `scale`, no
//! `rotation`, no crop, no opacity and no fade — its geometry comes entirely
//! from its resolved [`CaptionStyle`]. That is a deliberate scope line, for
//! the same reason D-211 drew one: `drawtext` can place and colour a text box
//! but cannot scale, rotate or crop one, so a preview offering any of those
//! would render something the export cannot reproduce. See D-229.

use serde::{Deserialize, Serialize};

/// Default font family **key** for a caption — see [`crate::DEFAULT_TEXT_FONT`]
/// for why this is a key into `chroma::text`'s catalogue rather than a path or
/// a system family name.
pub const DEFAULT_CAPTION_FONT: &str = "sans-bold";

/// Default cap size as a fraction of the COMPOSITION's height.
///
/// `0.055` is ~59 px in a 1080p frame — a real subtitle size (broadcast
/// practice is roughly 1/20th of picture height), and deliberately much
/// smaller than [`crate::DEFAULT_TEXT_SIZE`]'s `0.12`, which is a *title*
/// size. A fraction rather than pixels for exactly the reason that constant
/// documents: the preview renders at whatever `max_long_edge` the caller
/// asked for while the export renders at full composition resolution.
pub const DEFAULT_CAPTION_SIZE: f64 = 0.055;

/// Default fill colour, `#RRGGBB`. White — the subtitle convention, and the
/// colour that reads on the widest range of footage.
pub const DEFAULT_CAPTION_COLOR: &str = "#FFFFFF";

/// Default background-box colour, `#RRGGBB`. Black, at
/// [`DEFAULT_CAPTION_BOX_OPACITY`].
pub const DEFAULT_CAPTION_BOX_COLOR: &str = "#000000";

/// Default background-box opacity, `0.0..=1.0`. `0.6` is legible over both a
/// bright sky and a dark interior without fully hiding the picture — the
/// value the reference frame in `scratch/resolve-reference/captioning.jpg`
/// visibly uses.
pub const DEFAULT_CAPTION_BOX_OPACITY: f64 = 0.6;

/// Default background-box padding, as a fraction of the resolved font size
/// (not of the composition) — so the box keeps its proportions when the
/// caption size changes.
pub const DEFAULT_CAPTION_BOX_PADDING: f64 = 0.22;

/// Default extra leading between lines of one cue, as a fraction of the
/// resolved font size. The step between consecutive lines is therefore
/// `size * (1 + line_spacing)`.
///
/// `0.25` is not arbitrary: a face's own line box is about `1.15 × fontsize`
/// for the catalogue's fonts (Arial's `hhea` gives 68.99/60), so a `1.25 ×`
/// step leaves a small, visible gap between two lines' background boxes
/// rather than letting them touch or overlap.
pub const DEFAULT_CAPTION_LINE_SPACING: f64 = 0.25;

/// Default normalised horizontal anchor — the centre of the frame.
pub const DEFAULT_CAPTION_POSITION_X: f64 = 0.5;

/// Default normalised vertical anchor: where the **last** line's font line box
/// begins, as a fraction of composition height. `0.82` puts a one-line caption
/// in the lower sixth of the frame, the subtitle convention and what the
/// reference frame shows.
pub const DEFAULT_CAPTION_POSITION_Y: f64 = 0.82;

/// Horizontal alignment of each line of a cue against the style's
/// [`CaptionStyle::position_x`] anchor.
///
/// Note this aligns **each line independently** — a two-line centred cue has
/// both lines individually centred, which is the subtitle convention and what
/// `scratch/resolve-reference/captioning.jpg` shows.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptionAlign {
    /// The anchor is the line's left edge.
    Left,
    /// The anchor is the line's centre. The default, and the subtitle norm.
    #[default]
    Center,
    /// The anchor is the line's right edge.
    Right,
}

fn default_caption_font() -> String {
    DEFAULT_CAPTION_FONT.to_string()
}

fn default_caption_size() -> f64 {
    DEFAULT_CAPTION_SIZE
}

fn default_caption_color() -> String {
    DEFAULT_CAPTION_COLOR.to_string()
}

fn default_caption_box_color() -> String {
    DEFAULT_CAPTION_BOX_COLOR.to_string()
}

fn default_caption_box_opacity() -> f64 {
    DEFAULT_CAPTION_BOX_OPACITY
}

fn default_caption_box_padding() -> f64 {
    DEFAULT_CAPTION_BOX_PADDING
}

fn default_caption_line_spacing() -> f64 {
    DEFAULT_CAPTION_LINE_SPACING
}

fn default_caption_position_x() -> f64 {
    DEFAULT_CAPTION_POSITION_X
}

fn default_caption_position_y() -> f64 {
    DEFAULT_CAPTION_POSITION_Y
}

fn default_box_enabled() -> bool {
    true
}

/// How a caption is drawn — font, size, colour, the background box, and where
/// on the frame it sits.
///
/// **Lives on the TRACK, and optionally on one cue** (D-229). A subtitle track
/// carries the style every one of its cues uses
/// ([`crate::Track::caption_style`]); a cue that needs to differ carries its
/// own ([`CaptionCue::style`]). That is Resolve's own split — its Inspector has
/// a "Track Style" tab and a per-caption "Use Track Style" checkbox — and it
/// is the shape the job actually wants: a whole imported `.srt` is styled once,
/// not cue by cue.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CaptionStyle {
    /// Font-family **key** into `chroma::text`'s catalogue (`sans`,
    /// `sans-bold`, …) — never a path or a system family name. Both renderers
    /// resolve the key to the same font FILE, which is what makes them draw
    /// the same glyphs (D-212).
    #[serde(default = "default_caption_font")]
    pub font: String,
    /// Cap size as a fraction of the composition's height — see
    /// [`DEFAULT_CAPTION_SIZE`].
    #[serde(default = "default_caption_size")]
    pub size: f64,
    /// Fill colour, `#RGB` or `#RRGGBB`. See [`Self::rgb`].
    #[serde(default = "default_caption_color")]
    pub color: String,
    /// Whether to draw the background box behind each line.
    #[serde(default = "default_box_enabled")]
    pub box_enabled: bool,
    /// Background-box colour, `#RGB` or `#RRGGBB`.
    #[serde(default = "default_caption_box_color")]
    pub box_color: String,
    /// Background-box opacity, clamped to `0.0..=1.0` by [`Self::box_alpha`].
    #[serde(default = "default_caption_box_opacity")]
    pub box_opacity: f64,
    /// Background-box padding as a fraction of the resolved font size.
    #[serde(default = "default_caption_box_padding")]
    pub box_padding: f64,
    /// Extra leading between lines, as a fraction of the resolved font size —
    /// see [`DEFAULT_CAPTION_LINE_SPACING`].
    #[serde(default = "default_caption_line_spacing")]
    pub line_spacing: f64,
    /// Horizontal alignment of each line against [`Self::position_x`].
    #[serde(default)]
    pub align: CaptionAlign,
    /// Normalised horizontal anchor (fraction of composition width).
    #[serde(default = "default_caption_position_x")]
    pub position_x: f64,
    /// Normalised vertical anchor (fraction of composition height) — the top
    /// of the **last** line's font line box. Extra lines of a multi-line cue
    /// stack *upward* from it, so a cue growing from one line to two keeps its
    /// bottom line in place. That is the subtitle convention (and why this is
    /// a single normalised number rather than a top/middle/bottom enum — see
    /// D-229).
    #[serde(default = "default_caption_position_y")]
    pub position_y: f64,
    /// D-243 — how this caption ANIMATES, or `None` for D-229's original
    /// static rendering.
    ///
    /// An `Option` rather than a defaulted
    /// [`crate::caption_anim::CaptionAnimation`] so a project saved before
    /// D-243 round-trips byte-identically (the field is skipped when absent),
    /// and so "no animation" is representable without writing eleven default
    /// keys onto every one of a 400-cue `.srt`'s styles. Read it through
    /// [`CaptionStyle::animation_or_default`], never directly — that is what
    /// makes an absent key and an explicit `kind: none` provably the same
    /// render.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub animation: Option<crate::caption_anim::CaptionAnimation>,
}

impl Default for CaptionStyle {
    /// Manual, for the same reason [`crate::TextLayer`]'s is: almost every
    /// field's meaningful default is not its type's zero value (`size` of
    /// `0.0` renders nothing, `box_enabled` of `false` is not the default
    /// look). Mirrors the `#[serde(default = …)]` functions field for field,
    /// so a style built in code and one deserialised from a project with none
    /// of these keys are the same style.
    fn default() -> Self {
        Self {
            font: default_caption_font(),
            size: default_caption_size(),
            color: default_caption_color(),
            box_enabled: default_box_enabled(),
            box_color: default_caption_box_color(),
            box_opacity: default_caption_box_opacity(),
            box_padding: default_caption_box_padding(),
            line_spacing: default_caption_line_spacing(),
            align: CaptionAlign::default(),
            position_x: default_caption_position_x(),
            position_y: default_caption_position_y(),
            animation: None,
        }
    }
}

impl CaptionStyle {
    /// [`Self::color`] parsed to `(r, g, b)`, falling back to opaque white.
    ///
    /// **Degrades rather than erroring**, exactly as [`crate::TextLayer::rgb`]
    /// does and for the identical reason: `chroma_timeline_set` stores
    /// whatever the UI wrote, so every consumer has to cope. A caption that
    /// renders white because its colour string was malformed is visible and
    /// fixable; one that fails the whole frame decode is not.
    pub fn rgb(&self) -> (u8, u8, u8) {
        crate::parse_hex_rgb(&self.color).unwrap_or((255, 255, 255))
    }

    /// [`Self::box_color`] parsed to `(r, g, b)`, falling back to opaque
    /// black — the box's own default, so a malformed value degrades to the
    /// standard look rather than to a white slab over the picture.
    pub fn box_rgb(&self) -> (u8, u8, u8) {
        crate::parse_hex_rgb(&self.box_color).unwrap_or((0, 0, 0))
    }

    /// [`Self::box_opacity`] clamped to `0.0..=1.0`, with a non-finite value
    /// (a `NaN` that survived a JSON round trip) treated as fully opaque
    /// rather than propagating into a renderer's alpha arithmetic.
    pub fn box_alpha(&self) -> f64 {
        if self.box_opacity.is_finite() {
            self.box_opacity.clamp(0.0, 1.0)
        } else {
            1.0
        }
    }
}

/// One caption — the text shown for the span of the [`crate::Clip`] carrying
/// it.
///
/// **A `Clip` on a [`crate::TrackKind::Subtitle`] track** (D-229). The cue's
/// timing is the clip's own `start_frame`/`duration`, so a caption moves and
/// trims through the exact same ops as any other clip — which is what
/// Blackmagic's own copy promises ("can be moved and trimmed like any other
/// media") and what lets every existing edit op work on captions for free.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CaptionCue {
    /// The caption text. **May contain `\n`** — unlike [`crate::TextLayer`],
    /// which is single-line by construction. Real `.srt` cues are routinely
    /// two lines, and the module doc explains how that is rendered
    /// identically in both engines rather than avoided.
    pub text: String,
    /// `Some` = this cue overrides its track's style (Resolve's per-caption
    /// "Use Track Style" checkbox, unticked). `None` = it uses
    /// [`crate::Track::caption_style`], which is the overwhelmingly common
    /// case and the reason this is an `Option` rather than a materialised
    /// copy on every cue.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<CaptionStyle>,
}

impl CaptionCue {
    /// A cue with `text` and no per-cue style override.
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            style: None,
        }
    }

    /// The cue's text split into the lines both renderers will draw.
    ///
    /// Splits on `\n`, tolerates CRLF (`.srt` files from Windows tooling are
    /// the norm, not the exception), and drops leading/trailing blank lines
    /// while **keeping** a blank line between two non-blank ones — a cue
    /// authored with a deliberate gap keeps it, but the stray trailing
    /// newline nearly every `.srt` cue ends with does not silently become an
    /// empty extra line that shifts the whole cue upward.
    pub fn lines(&self) -> Vec<&str> {
        let all: Vec<&str> = self
            .text
            .split('\n')
            .map(|l| l.strip_suffix('\r').unwrap_or(l))
            .collect();
        let first = all.iter().position(|l| !l.trim().is_empty());
        let last = all.iter().rposition(|l| !l.trim().is_empty());
        match (first, last) {
            (Some(f), Some(l)) => all[f..=l].to_vec(),
            _ => Vec::new(),
        }
    }

    /// Characters in the cue, newlines excluded — Resolve's Inspector shows
    /// exactly this next to the caption text box ("25 Characters" in
    /// `scratch/resolve-reference/captioning.jpg`), and its
    /// characters-per-second readout is derived from it.
    pub fn char_count(&self) -> usize {
        self.text
            .chars()
            .filter(|c| *c != '\n' && *c != '\r')
            .count()
    }

    /// Characters per second over `secs` — the reference Inspector's `CPS`
    /// column, the standard subtitle readability metric.
    ///
    /// `None` for a non-positive or non-finite duration rather than an
    /// infinity: a zero-length cue has no meaningful reading rate, and the UI
    /// should show nothing rather than `inf`.
    pub fn chars_per_second(&self, secs: f64) -> Option<f64> {
        if secs.is_finite() && secs > 0.0 {
            Some(self.char_count() as f64 / secs)
        } else {
            None
        }
    }
}

/// One line of a laid-out cue, in **composition pixels**.
///
/// Produced by [`CaptionLayout::lines`]. Both renderers consume exactly this:
/// `chroma::text` draws the glyph run with its pen at (`x_anchor`, baseline)
/// and the box at the rect below; `@apelles/editor`'s export compiler emits a
/// `drawtext` whose `y` is [`Self::line_top`] under `y_align=font`, with the
/// same `x` anchor rule.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CaptionLine {
    /// Index of this line within the cue.
    pub index: usize,
    /// Top of this line's **font line box** — `drawtext`'s `y` under
    /// `y_align=font`, and the top of the background box before padding.
    pub line_top: i64,
    /// Normalised horizontal anchor in composition pixels, before the
    /// alignment rule is applied to the line's measured advance width. Each
    /// renderer subtracts `0`, `advance/2` or `advance` from this per
    /// [`CaptionStyle::align`], using its own measurement of the same font.
    pub x_anchor: i64,
}

/// The resolved, font-independent geometry of one cue on one composition
/// (D-229) — the numbers **both** renderers are handed.
///
/// Every value here is plain arithmetic over the composition size and the
/// style's own fields, with **no font metric in it**. That is the point: the
/// two engines measure glyphs differently in the last fractional pixel, so
/// nothing that decides *where a line goes* is allowed to depend on a
/// measurement. What each engine still does for itself is measure one line's
/// advance width (to apply [`CaptionStyle::align`]) and derive the font's own
/// line-box height for the background — and those two, uniquely, are
/// provably the same number in both, from the same `hhea` table (see the
/// module doc).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CaptionLayout {
    /// Font size in composition pixels — `drawtext`'s `fontsize`, and the
    /// em `chroma::text` scales `ab_glyph` to.
    pub font_px: i64,
    /// Vertical distance between consecutive lines' [`CaptionLine::line_top`].
    pub line_step: i64,
    /// Background-box padding in composition pixels — `drawtext`'s
    /// `boxborderw`, and the inset `chroma::text` expands its rect by.
    pub box_padding: i64,
    /// How many lines this cue has.
    pub line_count: usize,
    /// Normalised horizontal anchor in composition pixels.
    x_anchor: i64,
    /// [`CaptionLine::line_top`] of line 0.
    first_line_top: i64,
}

impl CaptionLayout {
    /// Resolve `style` against a composition of `comp_w × comp_h` pixels for a
    /// cue of `line_count` lines.
    ///
    /// **Every rounding here is deliberate and mirrored exactly** in
    /// `@apelles/editor`'s `caption.ts` (`captionLayout`) — a single
    /// `f64::round()` per value, in this order, so the Rust preview and the
    /// TypeScript export compiler cannot produce different integers for the
    /// same cue. `caption.test.ts` and this module's own tests assert the same
    /// fixtures on both sides.
    ///
    /// A non-finite or negative style value degrades to its default rather
    /// than poisoning the arithmetic — same "the model stores what the UI
    /// wrote, the consumer decides what it means" contract every other field
    /// in this crate follows.
    pub fn resolve(style: &CaptionStyle, comp_w: u32, comp_h: u32, line_count: usize) -> Self {
        let w = comp_w as f64;
        let h = comp_h as f64;
        let size = finite_or(style.size, DEFAULT_CAPTION_SIZE).max(0.0);
        let font_px = (size * h).round().max(1.0) as i64;
        let spacing = finite_or(style.line_spacing, DEFAULT_CAPTION_LINE_SPACING).max(0.0);
        let line_step = (size * (1.0 + spacing) * h).round().max(1.0) as i64;
        let padding = finite_or(style.box_padding, DEFAULT_CAPTION_BOX_PADDING).max(0.0);
        let box_padding = (padding * font_px as f64).round().max(0.0) as i64;
        let x_anchor = (finite_or(style.position_x, DEFAULT_CAPTION_POSITION_X) * w).round() as i64;
        // The anchor fixes the LAST line; earlier lines stack upward, so a cue
        // gaining a second line keeps its bottom line where it was.
        let last_line_top =
            (finite_or(style.position_y, DEFAULT_CAPTION_POSITION_Y) * h).round() as i64;
        let first_line_top = last_line_top - (line_count.max(1) as i64 - 1) * line_step;
        Self {
            font_px,
            line_step,
            box_padding,
            line_count,
            x_anchor,
            first_line_top,
        }
    }

    /// The laid-out lines, in draw order (top to bottom).
    pub fn lines(&self) -> Vec<CaptionLine> {
        (0..self.line_count)
            .map(|index| CaptionLine {
                index,
                line_top: self.first_line_top + index as i64 * self.line_step,
                x_anchor: self.x_anchor,
            })
            .collect()
    }
}

/// `value` if it is finite, else `fallback` — the one place this module
/// launders a `NaN`/`inf` that survived a JSON round trip, so no renderer
/// downstream has to.
fn finite_or(value: f64, fallback: f64) -> f64 {
    if value.is_finite() { value } else { fallback }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_style_matches_its_serde_defaults() {
        // The manual `Default` and the `#[serde(default = …)]` functions are
        // two hand-written mirrors of one intent; a project saved before a
        // field existed must load as the same style one built in code is.
        let from_empty: CaptionStyle = serde_json::from_str("{}").expect("empty object");
        assert_eq!(from_empty, CaptionStyle::default());
    }

    #[test]
    fn style_round_trips_through_json() {
        let style = CaptionStyle {
            font: "impact".into(),
            size: 0.07,
            color: "#FF0000".into(),
            box_enabled: false,
            box_color: "#101010".into(),
            box_opacity: 0.4,
            box_padding: 0.3,
            line_spacing: 0.5,
            align: CaptionAlign::Left,
            position_x: 0.1,
            position_y: 0.9,
            // D-243 — a style carrying a real animation, so this round trip
            // also covers the nested `CaptionAnimation`, not just the static
            // fields it had before.
            animation: Some(crate::caption_anim::CaptionAnimation {
                kind: crate::caption_anim::CaptionAnimKind::Highlight,
                active_box_color: Some("#FF1745".into()),
                ..Default::default()
            }),
        };
        let json = serde_json::to_string(&style).expect("serialize");
        let back: CaptionStyle = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, style);
    }

    #[test]
    fn align_serialises_lowercase() {
        // The TS mirror and the MCP tool both speak these strings.
        assert_eq!(
            serde_json::to_string(&CaptionAlign::Center).expect("ser"),
            "\"center\""
        );
        assert_eq!(
            serde_json::to_string(&CaptionAlign::Left).expect("ser"),
            "\"left\""
        );
    }

    #[test]
    fn malformed_colours_degrade_rather_than_erroring() {
        let style = CaptionStyle {
            color: "not a colour".into(),
            box_color: "#zzz".into(),
            ..CaptionStyle::default()
        };
        assert_eq!(style.rgb(), (255, 255, 255));
        // The box degrades to BLACK, not white — see `box_rgb`'s own doc.
        assert_eq!(style.box_rgb(), (0, 0, 0));
    }

    #[test]
    fn box_alpha_clamps_and_launders_nan() {
        let over = CaptionStyle {
            box_opacity: 4.0,
            ..CaptionStyle::default()
        };
        assert_eq!(over.box_alpha(), 1.0);
        let under = CaptionStyle {
            box_opacity: -1.0,
            ..CaptionStyle::default()
        };
        assert_eq!(under.box_alpha(), 0.0);
        let nan = CaptionStyle {
            box_opacity: f64::NAN,
            ..CaptionStyle::default()
        };
        assert_eq!(nan.box_alpha(), 1.0);
    }

    #[test]
    fn lines_drops_surrounding_blanks_but_keeps_an_interior_one() {
        let cue = CaptionCue::new("\nfirst\n\nthird\n\n");
        assert_eq!(cue.lines(), vec!["first", "", "third"]);
    }

    #[test]
    fn lines_tolerates_crlf() {
        let cue = CaptionCue::new("first\r\nsecond\r\n");
        assert_eq!(cue.lines(), vec!["first", "second"]);
    }

    #[test]
    fn lines_of_an_empty_cue_is_empty_not_one_blank_line() {
        // A cue with nothing in it must lay out ZERO lines — one blank line
        // would still reserve vertical space and draw an empty background box.
        assert!(CaptionCue::new("").lines().is_empty());
        assert!(CaptionCue::new("\n \n").lines().is_empty());
    }

    #[test]
    fn char_count_excludes_line_breaks() {
        assert_eq!(CaptionCue::new("ab\ncd").char_count(), 4);
        assert_eq!(CaptionCue::new("ab\r\ncd").char_count(), 4);
    }

    #[test]
    fn chars_per_second_is_none_for_a_zero_length_cue() {
        let cue = CaptionCue::new("hello");
        assert_eq!(cue.chars_per_second(2.0), Some(2.5));
        assert_eq!(cue.chars_per_second(0.0), None);
        assert_eq!(cue.chars_per_second(f64::NAN), None);
    }

    #[test]
    fn layout_anchors_the_last_line_so_lines_stack_upward() {
        let style = CaptionStyle::default();
        let one = CaptionLayout::resolve(&style, 1920, 1080, 1);
        let two = CaptionLayout::resolve(&style, 1920, 1080, 2);
        let one_lines = one.lines();
        let two_lines = two.lines();
        // The bottom line does not move when a second line is added.
        assert_eq!(
            one_lines[0].line_top, two_lines[1].line_top,
            "adding a line must not shift the bottom line"
        );
        assert_eq!(two_lines[1].line_top - two_lines[0].line_top, two.line_step);
    }

    #[test]
    fn layout_numbers_are_the_documented_arithmetic() {
        let style = CaptionStyle::default();
        let l = CaptionLayout::resolve(&style, 1920, 1080, 2);
        // font_px = round(0.055 * 1080) = 59
        assert_eq!(l.font_px, 59);
        // line_step = round(0.055 * 1.25 * 1080) = round(74.25) = 74
        assert_eq!(l.line_step, 74);
        // box_padding = round(0.22 * 59) = round(12.98) = 13
        assert_eq!(l.box_padding, 13);
        // x_anchor = round(0.5 * 1920) = 960
        assert_eq!(l.lines()[0].x_anchor, 960);
        // last line top = round(0.82 * 1080) = round(885.6) = 886
        assert_eq!(l.lines()[1].line_top, 886);
        assert_eq!(l.lines()[0].line_top, 886 - 74);
    }

    #[test]
    fn layout_degrades_non_finite_style_values_to_defaults() {
        let style = CaptionStyle {
            size: f64::NAN,
            line_spacing: f64::INFINITY,
            position_y: f64::NAN,
            ..CaptionStyle::default()
        };
        let l = CaptionLayout::resolve(&style, 1920, 1080, 1);
        let d = CaptionLayout::resolve(&CaptionStyle::default(), 1920, 1080, 1);
        assert_eq!(l, d);
    }

    #[test]
    fn layout_never_produces_a_zero_font_size_or_step() {
        // A style whose size was dragged to zero must still be renderable —
        // a `fontsize=0` is a hard ffmpeg failure, not a blank frame.
        let style = CaptionStyle {
            size: 0.0,
            ..CaptionStyle::default()
        };
        let l = CaptionLayout::resolve(&style, 1920, 1080, 3);
        assert!(l.font_px >= 1);
        assert!(l.line_step >= 1);
    }

    #[test]
    fn layout_line_count_zero_still_resolves_without_underflow() {
        let l = CaptionLayout::resolve(&CaptionStyle::default(), 1920, 1080, 0);
        assert!(l.lines().is_empty());
        assert!(l.font_px >= 1);
    }
}
