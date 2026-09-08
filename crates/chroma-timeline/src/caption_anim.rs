//! # Animated caption presets — the per-word model and its evaluation (D-241)
//!
//! **What it is:** the animation half of the caption primitive. D-229 gave a
//! caption a static [`CaptionStyle`] and a shared line layout; this module adds
//! the **word** as a unit — when each word of a cue is "spoken", and what a
//! renderer should draw for it at a given moment.
//!
//! **What it does NOT do:** no rasterising, no font loading, no glyph
//! measurement, no ffmpeg. It never opens a font. Like
//! [`crate::caption::CaptionLayout`] it is pure arithmetic that BOTH renderers
//! consume — `chroma::caption_render` for the live preview, `@chroma/editor`'s
//! `timelineExport.ts` for the ffmpeg export.
//!
//! ## Why the vocabulary is this small, and deliberately excludes scale
//!
//! The recurring defect class this repo keeps closing is a preview that offers
//! something the export silently cannot reproduce (B-053, B-088, B-090,
//! B-094), and D-211/D-229 both drew an explicit scope line for exactly that
//! reason. An animated caption has to be drawn twice — once by `ab_glyph`,
//! once by ffmpeg's `drawtext` — so the animation vocabulary is restricted to
//! properties ffmpeg can evaluate **per frame, per node, without changing its
//! own text layout**:
//!
//! | property | preview | export | in v1? |
//! |---|---|---|---|
//! | alpha | glyph coverage multiply | `drawtext` `alpha=` expression | yes |
//! | dx / dy | pen offset | `drawtext` `x=` / `y=` expression | yes |
//! | fill colour | chosen per word | one `drawtext` node per colour phase, each `enable`d over its own window | yes |
//! | highlight box | filled rect behind the word | `drawbox` with expression `x/y/w/h` | yes |
//! | **scale** | trivial | `fontsize=` **changes the advance width**, moving the word's own `x` and every following word's — and the two engines' advances agree only because both are measured at a FIXED em (D-212) | **no** |
//!
//! Scale is the property an author reaches for first (a "pop" is a scale pop),
//! and it is excluded on purpose: `fontsize` is the input to the very
//! measurement that makes the two engines agree, so animating it re-opens the
//! divergence D-212/D-229 closed. A word that pops by moving and fading is
//! reproducible in both engines; one that pops by scaling is not. See D-241.
//!
//! ## Per-word timing is derived from the cue, not from a transcript
//!
//! A `.srt` cue carries no word timings — only its own in/out. So word windows
//! are **derived**: each word takes a share of the cue's duration proportional
//! to its length in characters (a longer word is spoken for longer). It is
//! plain arithmetic over integers both engines hold, so both derive identical
//! windows.
//!
//! This is deliberately NOT yet wired to the real word timings the transcript
//! feature can produce — a named follow-up in D-241. The model is already
//! shaped for it: [`CaptionWord::start`]/[`CaptionWord::end`] are just numbers,
//! so a transcript-driven path substitutes better ones without changing a
//! single renderer.

use serde::{Deserialize, Serialize};

use crate::caption::CaptionStyle;

/// What an animated caption does, per word.
///
/// One flat enum rather than a composable effect graph, for the reason the
/// module doc gives: every kind here is implemented **twice**, pixel-
/// compatibly, and a closed set of five is auditable where an open-ended
/// effect language is not.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptionAnimKind {
    /// No animation — D-229's static, whole-cue caption, drawn one `drawtext`
    /// per LINE. The default, and what every pre-D-241 project deserialises
    /// to.
    #[default]
    None,
    /// The whole line stays on screen; the word being spoken gets a filled
    /// box swept in behind it.
    ///
    /// The box is SQUARE, not rounded: ffmpeg's `drawbox` has no corner
    /// radius, so a rounded one would be a preview the export cannot
    /// reproduce. See D-241's deferral list.
    Highlight,
    /// The whole line stays on screen; each word switches colour as it is
    /// spoken, and the active word may additionally carry a pill.
    Karaoke,
    /// One word at a time, alone on the frame, sliding in from an alternating
    /// side.
    Slam,
    /// The line builds word by word: each rises and fades into place, then
    /// stays for the rest of the cue.
    Build,
}

impl CaptionAnimKind {
    /// Whether this kind draws the cue **word by word** rather than line by
    /// line.
    ///
    /// The one branch every renderer keys off: [`Self::None`] takes D-229's
    /// original per-line path unchanged — which is what keeps every existing
    /// project rendering byte-identically — and everything else takes the
    /// per-word path.
    pub fn is_per_word(self) -> bool {
        !matches!(self, Self::None)
    }

    /// Whether this kind shows **only the active word**, rather than the whole
    /// line with one word emphasised.
    pub fn is_single_word(self) -> bool {
        matches!(self, Self::Slam)
    }
}

/// Default per-word entrance duration, in seconds.
pub const DEFAULT_CAPTION_ENTER_SECS: f64 = 0.12;

/// Default rise distance for an entering word, as a fraction of the resolved
/// font size. Positive = the word rises INTO place from below.
pub const DEFAULT_CAPTION_ENTER_RISE: f64 = 0.22;

/// Default extra tracking between words, as a fraction of the resolved font
/// size — the per-word path's stand-in for a space, since it positions each
/// word itself rather than letting either engine lay out a line.
///
/// A fraction of the font size rather than the face's own space advance
/// because a space advance is a **font metric**, and no font metric is allowed
/// to decide layout here (see [`crate::caption::CaptionLayout`]'s own doc).
pub const DEFAULT_CAPTION_WORD_GAP: f64 = 0.28;

/// Default horizontal padding of the active-word box, as a fraction of the
/// resolved font size.
pub const DEFAULT_CAPTION_ACTIVE_BOX_PAD_X: f64 = 0.15;

/// Default vertical padding of the active-word box, as a fraction of the
/// resolved font size.
pub const DEFAULT_CAPTION_ACTIVE_BOX_PAD_Y: f64 = 0.075;

fn default_enter_secs() -> f64 {
    DEFAULT_CAPTION_ENTER_SECS
}
fn default_enter_rise() -> f64 {
    DEFAULT_CAPTION_ENTER_RISE
}
fn default_word_gap() -> f64 {
    DEFAULT_CAPTION_WORD_GAP
}
fn default_active_box_pad_x() -> f64 {
    DEFAULT_CAPTION_ACTIVE_BOX_PAD_X
}
fn default_active_box_pad_y() -> f64 {
    DEFAULT_CAPTION_ACTIVE_BOX_PAD_Y
}
fn default_active_box_opacity() -> f64 {
    1.0
}

/// How an animated caption behaves — the animation half of a caption's look.
///
/// Carried by [`CaptionStyle::animation`], so it resolves through the identical
/// cue-override → track-style → defaults chain the static style already does.
/// **A preset is nothing more than a `CaptionStyle` with one of these on it**,
/// which is why a preset needs no new storage anywhere and why every value a
/// preset sets stays editable afterwards: it is data, applied through the
/// existing `set_caption_style` op (owner, 2026-09-08: "keep the style
/// configurable as much as possible").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CaptionAnimation {
    /// Which animation this is. [`CaptionAnimKind::None`] means D-229's
    /// original static rendering, unchanged.
    #[serde(default)]
    pub kind: CaptionAnimKind,
    /// Fill colour of the word currently being spoken, `#RGB`/`#RRGGBB`.
    /// `None` = the style's own [`CaptionStyle::color`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_color: Option<String>,
    /// Fill colour of words already spoken. `None` = the style's own colour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spoken_color: Option<String>,
    /// Fill colour of words not yet spoken. `None` = the style's own colour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upcoming_color: Option<String>,
    /// Colour of the box drawn behind the active word. `None` = no box, which
    /// is what distinguishes a pure recolour karaoke from a highlight.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_box_color: Option<String>,
    /// Opacity of the active-word box, `0.0..=1.0`.
    #[serde(default = "default_active_box_opacity")]
    pub active_box_opacity: f64,
    /// Horizontal padding of the active-word box, as a fraction of the font
    /// size.
    #[serde(default = "default_active_box_pad_x")]
    pub active_box_pad_x: f64,
    /// Vertical padding of the active-word box, as a fraction of the font
    /// size.
    #[serde(default = "default_active_box_pad_y")]
    pub active_box_pad_y: f64,
    /// How long one word's entrance takes, in seconds.
    #[serde(default = "default_enter_secs")]
    pub enter_secs: f64,
    /// How far an entering word rises into place, as a fraction of the font
    /// size. `0.0` = a pure fade.
    #[serde(default = "default_enter_rise")]
    pub enter_rise: f64,
    /// Extra tracking between words, as a fraction of the font size.
    #[serde(default = "default_word_gap")]
    pub word_gap: f64,
}

impl Default for CaptionAnimation {
    /// Manual, mirroring the `#[serde(default = …)]` functions field for
    /// field, for the same reason [`CaptionStyle`]'s is: most of these
    /// defaults are not their type's zero value, and a value built in code
    /// must equal one deserialised from a project carrying none of these keys.
    fn default() -> Self {
        Self {
            kind: CaptionAnimKind::default(),
            active_color: None,
            spoken_color: None,
            upcoming_color: None,
            active_box_color: None,
            active_box_opacity: default_active_box_opacity(),
            active_box_pad_x: default_active_box_pad_x(),
            active_box_pad_y: default_active_box_pad_y(),
            enter_secs: default_enter_secs(),
            enter_rise: default_enter_rise(),
            word_gap: default_word_gap(),
        }
    }
}

impl CaptionAnimation {
    /// [`Self::active_box_opacity`] clamped to `0.0..=1.0`, non-finite → `1.0`
    /// — the same degradation rule [`CaptionStyle::box_alpha`] uses.
    pub fn active_box_alpha(&self) -> f64 {
        if self.active_box_opacity.is_finite() {
            self.active_box_opacity.clamp(0.0, 1.0)
        } else {
            1.0
        }
    }

    /// [`Self::active_box_color`] parsed to `(r, g, b)`, or `None` when the
    /// preset names no box at all.
    ///
    /// A malformed colour degrades to black rather than dropping the box,
    /// matching [`CaptionStyle::box_rgb`]: a visibly wrong box is fixable, a
    /// silently missing one reads as a broken preset.
    pub fn active_box_rgb(&self) -> Option<(u8, u8, u8)> {
        self.active_box_color
            .as_deref()
            .map(|c| crate::parse_hex_rgb(c).unwrap_or((0, 0, 0)))
    }
}

/// One word of a cue, with the time window it owns.
///
/// `start`/`end` are **clip-local seconds** — measured from the cue's own in
/// point, not from the session timeline — so a cue that is moved or rippled
/// keeps its word timings unchanged, exactly as its `line_top` is unchanged by
/// a move.
#[derive(Debug, Clone, PartialEq)]
pub struct CaptionWord {
    /// Index of this word within its LINE.
    pub index: usize,
    /// Index of the line this word belongs to.
    pub line: usize,
    /// The word's text, with no surrounding whitespace.
    pub text: String,
    /// When this word becomes the active one, in clip-local seconds.
    pub start: f64,
    /// When this word stops being the active one, in clip-local seconds.
    pub end: f64,
}

/// Split a cue's already-split lines into words with derived time windows.
///
/// **The derivation** (module doc): every word's share of `dur_secs` is
/// proportional to its character count, taken over the whole cue rather than
/// per line, so a two-line cue reads at one rate instead of speeding up on the
/// shorter line.
///
/// A non-positive or non-finite `dur_secs` yields words whose windows are all
/// `0.0..0.0`; every renderer then treats the LAST word as active, a stable,
/// visible degradation rather than a division by zero.
pub fn caption_words(lines: &[&str], dur_secs: f64) -> Vec<CaptionWord> {
    let mut words: Vec<CaptionWord> = Vec::new();
    for (line_index, line) in lines.iter().enumerate() {
        for (word_index, w) in line.split_whitespace().enumerate() {
            words.push(CaptionWord {
                index: word_index,
                line: line_index,
                text: w.to_string(),
                start: 0.0,
                end: 0.0,
            });
        }
    }
    if words.is_empty() {
        return words;
    }
    let total_chars: usize = words.iter().map(|w| w.text.chars().count().max(1)).sum();
    if !dur_secs.is_finite() || dur_secs <= 0.0 || total_chars == 0 {
        return words;
    }
    // Cumulative INTEGER character counts, converted to seconds only at the
    // end — so the windows tile the cue exactly with no accumulated float
    // drift, and the last word's `end` is exactly `dur_secs`.
    let mut consumed = 0usize;
    for w in words.iter_mut() {
        let start = consumed;
        consumed += w.text.chars().count().max(1);
        w.start = dur_secs * (start as f64) / (total_chars as f64);
        w.end = dur_secs * (consumed as f64) / (total_chars as f64);
    }
    words
}

/// Which of the three colour states a word is in at a moment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptionWordPhase {
    /// Not yet spoken.
    Upcoming,
    /// Currently being spoken — the emphasised word.
    Active,
    /// Already spoken.
    Spoken,
}

/// What to draw for one word at one moment — the value both renderers consume.
///
/// Deliberately holds no resolved colour, only a [`CaptionWordPhase`]: the
/// export resolves a phase to a **separate `drawtext` node** rather than to a
/// value (module doc — `fontcolor` is not an ffmpeg expression), so handing it
/// an already-resolved RGB would be strictly more work for both sides.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CaptionWordState {
    /// Whether the word is drawn at all.
    pub visible: bool,
    /// Fill/ink alpha, `0.0..=1.0`.
    pub alpha: f64,
    /// Vertical offset from the word's laid-out position, in **fractions of
    /// the font size**; positive is DOWN, so an entering word starts positive
    /// and rises to `0.0`.
    pub dy: f64,
    /// Horizontal offset, in fractions of the font size. Non-zero only for
    /// [`CaptionAnimKind::Slam`], whose words alternate their entry side.
    pub dx: f64,
    /// Which colour this word takes.
    pub phase: CaptionWordPhase,
    /// Alpha of the highlight box behind this word, `0.0..=1.0`. `0.0`
    /// whenever no box should be drawn at all.
    pub box_alpha: f64,
}

/// Cubic ease-out — `1 - (1 - t)^3`, GSAP's `power3.out`.
///
/// The one easing curve in this module, written out rather than pulled from a
/// curve library on purpose: it has to be evaluated identically in Rust, in
/// TypeScript, and as an ffmpeg expression **string**, and a closed-form
/// polynomial is the only shape that is obviously the same function in all
/// three. `t` is clamped, so callers need not.
pub fn ease_out_cubic(t: f64) -> f64 {
    if !t.is_finite() {
        return 1.0;
    }
    let t = t.clamp(0.0, 1.0);
    let inv = 1.0 - t;
    1.0 - inv * inv * inv
}

/// Index of the word active at clip-local `t_secs`.
///
/// "The last word whose window has opened" rather than "the word containing
/// `t`", so a `t` past the end of the cue keeps the final word active instead
/// of blanking the caption — which matters because a clip's last frame lands
/// exactly on its own duration.
pub fn caption_active_word(words: &[CaptionWord], t_secs: f64) -> usize {
    let t = if t_secs.is_finite() { t_secs } else { 0.0 };
    words.iter().rposition(|w| t >= w.start).unwrap_or(0)
}

/// Evaluate the state of `words[index]` at clip-local time `t_secs`.
///
/// **This function is the contract.** `chroma::caption_render` calls it per
/// frame; `@chroma/editor`'s `captionAnim.ts` mirrors it exactly, and the
/// export compiler turns the same arithmetic into ffmpeg expressions. Its
/// fixtures are asserted on both sides (this module's tests and
/// `captionAnim.test.ts`), so a drift in either is a failing test rather than
/// a silently different render.
pub fn caption_word_state(
    words: &[CaptionWord],
    index: usize,
    anim: &CaptionAnimation,
    t_secs: f64,
) -> CaptionWordState {
    let fallback = CaptionWordState {
        visible: false,
        alpha: 0.0,
        dy: 0.0,
        dx: 0.0,
        phase: CaptionWordPhase::Upcoming,
        box_alpha: 0.0,
    };
    let Some(word) = words.get(index) else {
        return fallback;
    };
    let t = if t_secs.is_finite() { t_secs } else { 0.0 };
    let enter = if anim.enter_secs.is_finite() && anim.enter_secs > 0.0 {
        anim.enter_secs
    } else {
        0.0
    };

    let active_index = caption_active_word(words, t);
    let phase = match index.cmp(&active_index) {
        std::cmp::Ordering::Less => CaptionWordPhase::Spoken,
        std::cmp::Ordering::Equal => CaptionWordPhase::Active,
        std::cmp::Ordering::Greater => CaptionWordPhase::Upcoming,
    };

    // How far into its own entrance this word is. A word that has not started
    // has not entered; `enter == 0` snaps straight to fully entered.
    let since_start = t - word.start;
    let entered = if enter <= 0.0 {
        if since_start >= 0.0 { 1.0 } else { 0.0 }
    } else {
        ease_out_cubic(since_start / enter)
    };

    match anim.kind {
        // Never reached by a renderer (both branch on `is_per_word` first),
        // but defined so the function is total.
        CaptionAnimKind::None => CaptionWordState {
            visible: true,
            alpha: 1.0,
            dy: 0.0,
            dx: 0.0,
            phase,
            box_alpha: 0.0,
        },
        // Only the active word exists at all; it enters, holds, and is gone
        // the moment the next word opens.
        CaptionAnimKind::Slam => {
            let visible = phase == CaptionWordPhase::Active;
            // Alternate the entry side by word index — what makes a run of
            // slams read as kinetic rather than as one repeated move.
            let side = if index.is_multiple_of(2) { -1.0 } else { 1.0 };
            CaptionWordState {
                visible,
                alpha: if visible { entered } else { 0.0 },
                dy: 0.0,
                dx: if visible {
                    side * (1.0 - entered) * 0.6
                } else {
                    0.0
                },
                phase,
                box_alpha: 0.0,
            }
        }
        // The line builds: a word is invisible until its window opens, then
        // rises into place and stays for the rest of the cue.
        CaptionAnimKind::Build => {
            let visible = since_start >= 0.0;
            CaptionWordState {
                visible,
                alpha: if visible { entered } else { 0.0 },
                dy: if visible {
                    (1.0 - entered) * anim.enter_rise
                } else {
                    anim.enter_rise
                },
                dx: 0.0,
                phase,
                box_alpha: 0.0,
            }
        }
        // The whole line is up from the first frame; the active word carries
        // the box (Highlight) and/or the colour change (Karaoke).
        CaptionAnimKind::Highlight | CaptionAnimKind::Karaoke => {
            // BINARY, not ramped with `entered`: ffmpeg's `drawbox` takes a
            // colour string, not a per-frame alpha expression, so a box that
            // faded in here could not be reproduced in the export. The
            // reference's scaleX sweep is a named deferral in D-241; what both
            // engines CAN do exactly is "on for the active word's window".
            let box_alpha = if phase == CaptionWordPhase::Active && anim.active_box_color.is_some()
            {
                anim.active_box_alpha()
            } else {
                0.0
            };
            CaptionWordState {
                visible: true,
                alpha: 1.0,
                dy: 0.0,
                dx: 0.0,
                phase,
                box_alpha,
            }
        }
    }
}

/// The fill colour one word takes, resolved to `(r, g, b)`.
///
/// **The one place a word's colour is decided**, so the preview, the export
/// compiler and the panel's thumbnail cannot disagree about what "spoken"
/// looks like. Mirrored by `captionWordColor` in `@chroma/editor`'s
/// `captionAnim.ts`.
///
/// A phase the animation does not override falls back to the style's own
/// colour, so a preset that recolours only the active word leaves the rest of
/// the line exactly as the static style drew it. A malformed colour degrades
/// to white, the same rule [`CaptionStyle::rgb`] follows — a visibly wrong
/// colour is fixable, a frame that fails to decode is not.
pub fn caption_word_rgb(
    phase: CaptionWordPhase,
    anim: &CaptionAnimation,
    style: &CaptionStyle,
) -> (u8, u8, u8) {
    let pick = match phase {
        CaptionWordPhase::Active => anim.active_color.as_deref(),
        CaptionWordPhase::Spoken => anim.spoken_color.as_deref(),
        CaptionWordPhase::Upcoming => anim.upcoming_color.as_deref(),
    };
    crate::parse_hex_rgb(pick.unwrap_or(&style.color)).unwrap_or((255, 255, 255))
}

impl CaptionStyle {
    /// The style's animation, or the static default when it carries none.
    ///
    /// Every renderer goes through this rather than reading the `Option`
    /// directly, so "no animation key in the project file" and "an explicit
    /// `kind: none`" are provably the same render.
    pub fn animation_or_default(&self) -> CaptionAnimation {
        self.animation.clone().unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anim(kind: CaptionAnimKind) -> CaptionAnimation {
        CaptionAnimation {
            kind,
            active_box_color: Some("#FF1745".into()),
            ..Default::default()
        }
    }

    #[test]
    fn words_tile_the_cue_exactly_and_in_order() {
        let lines = vec!["hello big", "world"];
        let ws = caption_words(&lines, 4.0);
        assert_eq!(ws.len(), 3);
        assert_eq!(ws[0].text, "hello");
        assert_eq!(ws[1].text, "big");
        assert_eq!(ws[2].text, "world");
        assert_eq!((ws[0].line, ws[1].line, ws[2].line), (0, 0, 1));
        // per-line word indices restart
        assert_eq!((ws[0].index, ws[1].index, ws[2].index), (0, 1, 0));
        // windows tile [0, dur] with no gap and no overlap
        assert_eq!(ws[0].start, 0.0);
        assert_eq!(ws[0].end, ws[1].start);
        assert_eq!(ws[1].end, ws[2].start);
        assert!((ws[2].end - 4.0).abs() < 1e-12);
        // proportional to character count: 5 + 3 + 5 = 13
        assert!((ws[0].end - 4.0 * 5.0 / 13.0).abs() < 1e-12);
    }

    #[test]
    fn zero_duration_degrades_rather_than_dividing_by_zero() {
        let ws = caption_words(&["a b"], 0.0);
        assert_eq!(ws.len(), 2);
        assert!(ws.iter().all(|w| w.start == 0.0 && w.end == 0.0));
        // With every window at 0 the LAST word is active and nothing panics.
        let st = caption_word_state(&ws, 1, &anim(CaptionAnimKind::Highlight), 0.0);
        assert_eq!(st.phase, CaptionWordPhase::Active);
    }

    #[test]
    fn empty_text_yields_no_words() {
        assert!(caption_words(&[], 3.0).is_empty());
        assert!(caption_words(&["   "], 3.0).is_empty());
    }

    #[test]
    fn an_out_of_range_index_is_not_drawn_rather_than_panicking() {
        let ws = caption_words(&["a"], 1.0);
        let st = caption_word_state(&ws, 9, &anim(CaptionAnimKind::Build), 0.5);
        assert!(!st.visible);
    }

    #[test]
    fn highlight_keeps_the_line_up_and_moves_only_the_box() {
        let ws = caption_words(&["one two three"], 3.0);
        let a = anim(CaptionAnimKind::Highlight);
        let t = (ws[1].start + ws[1].end) / 2.0;
        let states: Vec<_> = (0..ws.len())
            .map(|i| caption_word_state(&ws, i, &a, t))
            .collect();
        // every word drawn, full alpha, unmoved — only the box moves
        assert!(states.iter().all(|s| s.visible && s.alpha == 1.0));
        assert!(states.iter().all(|s| s.dx == 0.0 && s.dy == 0.0));
        assert_eq!(states[0].phase, CaptionWordPhase::Spoken);
        assert_eq!(states[1].phase, CaptionWordPhase::Active);
        assert_eq!(states[2].phase, CaptionWordPhase::Upcoming);
        // exactly one box, on the active word
        assert_eq!(states[0].box_alpha, 0.0);
        assert!(states[1].box_alpha > 0.0);
        assert_eq!(states[2].box_alpha, 0.0);
    }

    #[test]
    fn no_box_colour_means_no_box_at_all() {
        let ws = caption_words(&["one two"], 2.0);
        let a = CaptionAnimation {
            kind: CaptionAnimKind::Karaoke,
            active_box_color: None,
            ..Default::default()
        };
        let st = caption_word_state(&ws, 0, &a, 0.2);
        assert_eq!(st.phase, CaptionWordPhase::Active);
        assert_eq!(st.box_alpha, 0.0);
    }

    #[test]
    fn slam_shows_exactly_one_word_at_a_time() {
        let ws = caption_words(&["alpha beta gamma"], 3.0);
        let a = anim(CaptionAnimKind::Slam);
        for probe in [0.1_f64, 1.4, 2.6] {
            let visible = (0..ws.len())
                .filter(|i| caption_word_state(&ws, *i, &a, probe).visible)
                .count();
            assert_eq!(visible, 1, "exactly one word visible at t={probe}");
        }
    }

    #[test]
    fn slam_alternates_its_entry_side() {
        let ws = caption_words(&["alpha beta"], 2.0);
        let a = anim(CaptionAnimKind::Slam);
        let s0 = caption_word_state(&ws, 0, &a, ws[0].start);
        let s1 = caption_word_state(&ws, 1, &a, ws[1].start);
        assert!(s0.dx < 0.0, "even words enter from the left");
        assert!(s1.dx > 0.0, "odd words enter from the right");
    }

    #[test]
    fn build_accumulates_words_and_never_removes_one() {
        let ws = caption_words(&["a b c"], 3.0);
        let a = anim(CaptionAnimKind::Build);
        let count_at = |t: f64| {
            (0..ws.len())
                .filter(|i| caption_word_state(&ws, *i, &a, t).visible)
                .count()
        };
        assert_eq!(count_at(0.0), 1);
        assert_eq!(count_at(1.5), 2);
        assert_eq!(count_at(2.5), 3);
        assert!(count_at(2.9) >= count_at(1.5));
    }

    #[test]
    fn an_entering_word_rises_to_its_laid_out_position() {
        let ws = caption_words(&["a b"], 2.0);
        let a = CaptionAnimation {
            kind: CaptionAnimKind::Build,
            enter_secs: 0.2,
            enter_rise: 0.5,
            ..Default::default()
        };
        let at_start = caption_word_state(&ws, 0, &a, 0.0);
        let settled = caption_word_state(&ws, 0, &a, 0.4);
        assert!((at_start.dy - 0.5).abs() < 1e-12, "starts fully displaced");
        assert_eq!(at_start.alpha, 0.0);
        assert_eq!(settled.dy, 0.0, "settles exactly on its laid-out position");
        assert_eq!(settled.alpha, 1.0);
    }

    #[test]
    fn a_zero_length_entrance_snaps_instead_of_dividing_by_zero() {
        let ws = caption_words(&["a b"], 2.0);
        let a = CaptionAnimation {
            kind: CaptionAnimKind::Build,
            enter_secs: 0.0,
            ..Default::default()
        };
        let st = caption_word_state(&ws, 0, &a, 0.0);
        assert_eq!(st.alpha, 1.0);
        assert_eq!(st.dy, 0.0);
    }

    #[test]
    fn past_the_end_of_the_cue_the_last_word_stays_active() {
        let ws = caption_words(&["a b c"], 3.0);
        let a = anim(CaptionAnimKind::Highlight);
        let st = caption_word_state(&ws, 2, &a, 99.0);
        assert_eq!(st.phase, CaptionWordPhase::Active);
    }

    #[test]
    fn ease_is_the_documented_polynomial_and_is_clamped() {
        assert_eq!(ease_out_cubic(0.0), 0.0);
        assert_eq!(ease_out_cubic(1.0), 1.0);
        assert_eq!(ease_out_cubic(-5.0), 0.0);
        assert_eq!(ease_out_cubic(5.0), 1.0);
        assert!((ease_out_cubic(0.5) - 0.875).abs() < 1e-12);
    }

    /// The fixture `captionAnim.test.ts` asserts number-for-number. If either
    /// side's arithmetic drifts, exactly one of the two tests fails.
    #[test]
    fn state_numbers_are_the_documented_arithmetic() {
        let ws = caption_words(&["Every great video"], 3.0);
        // 5 + 5 + 5 = 15 chars, so the windows are exact thirds.
        assert!((ws[0].end - 1.0).abs() < 1e-12);
        assert!((ws[1].start - 1.0).abs() < 1e-12);
        assert!((ws[2].start - 2.0).abs() < 1e-12);

        let a = CaptionAnimation {
            kind: CaptionAnimKind::Build,
            enter_secs: 0.5,
            enter_rise: 0.4,
            ..Default::default()
        };
        // 0.25s into word 1's entrance: since_start = 0.25, ratio 0.5,
        // ease_out_cubic(0.5) = 0.875.
        let st = caption_word_state(&ws, 1, &a, 1.25);
        assert!((st.alpha - 0.875).abs() < 1e-12);
        assert!((st.dy - 0.05).abs() < 1e-12);
    }

    #[test]
    fn animation_round_trips_through_serde_with_no_keys_set() {
        let a: CaptionAnimation = serde_json::from_str("{}").expect("empty object is a default");
        assert_eq!(a, CaptionAnimation::default());
        assert_eq!(a.kind, CaptionAnimKind::None);
        let s = serde_json::to_string(&a).expect("serialises");
        let back: CaptionAnimation = serde_json::from_str(&s).expect("round trips");
        assert_eq!(back, a);
    }

    #[test]
    fn a_style_with_no_animation_key_is_the_static_default() {
        let s: CaptionStyle = serde_json::from_str("{}").expect("empty style");
        assert_eq!(s.animation, None);
        assert_eq!(s.animation_or_default().kind, CaptionAnimKind::None);
        assert!(!s.animation_or_default().kind.is_per_word());
    }

    #[test]
    fn a_malformed_box_colour_degrades_to_black_rather_than_no_box() {
        let a = CaptionAnimation {
            kind: CaptionAnimKind::Highlight,
            active_box_color: Some("not-a-colour".into()),
            ..Default::default()
        };
        assert_eq!(a.active_box_rgb(), Some((0, 0, 0)));
    }
}
