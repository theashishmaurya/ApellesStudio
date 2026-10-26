//! # OCR — the words in a picture, and where they are (D-397)
//!
//! **What it is:** [`recognize_image`], which reads an encoded image (PNG/JPEG)
//! and returns every line and word of text Apple's Vision framework finds, each
//! with a bounding box as FRACTIONS of the image (origin top-left, the same
//! convention as `Clip.highlights`' `box`) and Vision's confidence.
//!
//! **What it does:** runs `VNRecognizeTextRequest` (accurate level, language
//! correction on) through the `objc2-vision` bindings, then asks each recognised
//! line for the box of each of its words. Pure helpers ([`word_spans`],
//! [`flip_vision_rect`]) carry the two fiddly bits (UTF-16 word ranges, Vision's
//! bottom-left origin) so they are testable without the framework.
//!
//! **What it does NOT do:** no matching against a transcript and no highlight
//! logic (that is `@apelles/editor`'s `highlightSuggest.ts`), no language
//! choice (Vision's automatic detection), no network and no model download —
//! Vision runs on-device, which is the point (CLAUDE.md: local-first). On a
//! non-macOS target [`recognize_image`] returns an error naming the platform;
//! the app is macOS-only (D-039 v1 scope) so nothing else is promised.
//!
//! **Why Vision and not Tesseract:** the app does not ship Tesseract and must
//! not shell out to a Homebrew one. Vision is already on every Mac the app
//! runs on, is accurate on screen text, and returns per-word boxes. D-397.

use anyhow::Result;
use serde::Serialize;

/// One recognised word. `bbox` is `[x0, y0, x1, y1]` as fractions of the image,
/// origin top-left.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OcrWord {
    pub text: String,
    pub bbox: [f64; 4],
    pub confidence: f32,
}

/// One recognised line of text and the words that make it up, in reading order.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OcrLine {
    pub text: String,
    pub bbox: [f64; 4],
    pub confidence: f32,
    pub words: Vec<OcrWord>,
}

/// A whitespace-separated word of a line: its text and its UTF-16 range, which
/// is the unit `NSString`/`NSRange` (and so Vision's per-range box query) uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WordSpan {
    pub text: String,
    /// Offset in UTF-16 code units.
    pub start: usize,
    /// Length in UTF-16 code units.
    pub len: usize,
}

/// Split `line` into its whitespace-separated words, with each word's range in
/// UTF-16 code units. A character outside the BMP counts as two units, exactly
/// as `NSString` counts it, so a range handed to Vision lands on the right
/// characters.
pub fn word_spans(line: &str) -> Vec<WordSpan> {
    let mut spans = Vec::new();
    let mut offset = 0usize;
    let mut current: Option<(usize, String)> = None;
    for ch in line.chars() {
        let units = ch.len_utf16();
        if ch.is_whitespace() {
            if let Some((start, text)) = current.take() {
                spans.push(WordSpan {
                    len: offset - start,
                    start,
                    text,
                });
            }
        } else {
            match current.as_mut() {
                Some((_, text)) => text.push(ch),
                None => current = Some((offset, ch.to_string())),
            }
        }
        offset += units;
    }
    if let Some((start, text)) = current {
        spans.push(WordSpan {
            len: offset - start,
            start,
            text,
        });
    }
    spans
}

/// Convert a Vision rectangle (`x`, `y` of the BOTTOM-left corner, `w`, `h`,
/// all fractions) to `[x0, y0, x1, y1]` with a top-left origin, clamped to
/// `0..=1`.
pub fn flip_vision_rect(x: f64, y: f64, w: f64, h: f64) -> [f64; 4] {
    let c = |v: f64| v.clamp(0.0, 1.0);
    [c(x), c(1.0 - (y + h)), c(x + w), c(1.0 - y)]
}

#[cfg(target_os = "macos")]
mod vision {
    use super::{OcrLine, OcrWord, flip_vision_rect, word_spans};
    use anyhow::{Result, anyhow};
    use objc2::rc::Retained;
    use objc2::{AnyThread, msg_send};
    use objc2_foundation::{NSArray, NSData, NSDictionary, NSError, NSRange};
    use objc2_vision::{
        VNImageRequestHandler, VNRecognizeTextRequest, VNRecognizedText, VNRectangleObservation,
        VNRequest, VNRequestTextRecognitionLevel,
    };

    fn ns_error(e: &NSError) -> anyhow::Error {
        anyhow!("Vision: {}", e.localizedDescription())
    }

    /// The box of `range` within a recognised line, as top-left fractions.
    fn range_box(text: &VNRecognizedText, range: NSRange) -> Option<[f64; 4]> {
        // SAFETY: `-[VNRecognizedText boundingBoxForRange:error:]` takes an
        // `NSRange` by value and returns a nullable `VNRectangleObservation`,
        // reporting failure through the trailing `NSError **`, which is the
        // shape `msg_send!`'s `error: _` form handles. `objc2-vision` 0.3 does
        // not generate a binding for this one method, hence the raw send; the
        // receiver is a live `VNRecognizedText` borrowed for the call.
        let observation: Result<Retained<VNRectangleObservation>, Retained<NSError>> =
            unsafe { msg_send![text, boundingBoxForRange: range, error: _] };
        let observation = observation.ok()?;
        // SAFETY: `boundingBox` is a plain getter on a live observation.
        let rect = unsafe { observation.boundingBox() };
        Some(flip_vision_rect(
            rect.origin.x,
            rect.origin.y,
            rect.size.width,
            rect.size.height,
        ))
    }

    pub fn recognize(encoded: &[u8]) -> Result<Vec<OcrLine>> {
        let data = NSData::with_bytes(encoded);
        let handler = VNImageRequestHandler::initWithData_options(
            VNImageRequestHandler::alloc(),
            &data,
            &NSDictionary::new(),
        );
        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        request.setUsesLanguageCorrection(true);
        let requests: Retained<NSArray<VNRequest>> = NSArray::from_slice(&[&*request]);
        handler
            .performRequests_error(&requests)
            .map_err(|e| ns_error(&e))?;

        let mut lines = Vec::new();
        let Some(results) = request.results() else {
            return Ok(lines);
        };
        for observation in results.iter() {
            let candidates = observation.topCandidates(1);
            let Some(top) = candidates.iter().next() else {
                continue;
            };
            let line_text = top.string().to_string();
            // SAFETY: plain getter on a live observation.
            let rect = unsafe { observation.boundingBox() };
            let bbox = flip_vision_rect(
                rect.origin.x,
                rect.origin.y,
                rect.size.width,
                rect.size.height,
            );
            let confidence = top.confidence();
            let words = word_spans(&line_text)
                .into_iter()
                .filter_map(|span| {
                    let b = range_box(
                        &top,
                        NSRange {
                            location: span.start,
                            length: span.len,
                        },
                    )?;
                    Some(OcrWord {
                        text: span.text,
                        bbox: b,
                        confidence,
                    })
                })
                .collect();
            lines.push(OcrLine {
                text: line_text,
                bbox,
                confidence,
                words,
            });
        }
        Ok(lines)
    }
}

/// Recognise the text in an encoded image (PNG, JPEG, ...). Lines come back in
/// Vision's reading order. An image with no text is `Ok(vec![])`, not an error.
pub fn recognize_image(encoded: &[u8]) -> Result<Vec<OcrLine>> {
    #[cfg(target_os = "macos")]
    {
        vision::recognize(encoded)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = encoded;
        anyhow::bail!(
            "text recognition uses the macOS Vision framework and is not available on this platform"
        )
    }
}

/// Recognise the text in a media file's picture: a still is read as it is, a
/// video is decoded at `source_frame` (the same frame the preview and the export
/// show for that index, `video::decode_frame`) and handed to Vision as a PNG.
pub fn recognize_media(path: &std::path::Path, source_frame: u64) -> Result<Vec<OcrLine>> {
    use anyhow::Context;
    if crate::still::is_image_file(path) {
        let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
        return recognize_image(&bytes);
    }
    let info = crate::video::probe(path)?;
    let frame =
        crate::video::decode_frame(path, crate::video::FramePos::Index(source_frame), &info)?;
    let mut png = std::io::Cursor::new(Vec::new());
    frame
        .write_to(&mut png, image::ImageFormat::Png)
        .context("encode the frame for text recognition")?;
    recognize_image(png.get_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_split_on_whitespace_with_utf16_ranges() {
        let spans = word_spans("  Breach  of trust ");
        assert_eq!(
            spans,
            vec![
                WordSpan {
                    text: "Breach".into(),
                    start: 2,
                    len: 6
                },
                WordSpan {
                    text: "of".into(),
                    start: 10,
                    len: 2
                },
                WordSpan {
                    text: "trust".into(),
                    start: 13,
                    len: 5
                },
            ]
        );
    }

    #[test]
    fn ranges_count_utf16_units_not_chars_or_bytes() {
        // "é" is 2 UTF-8 bytes / 1 UTF-16 unit; the emoji is 4 bytes / 2 units.
        let spans = word_spans("café 😀 ok");
        assert_eq!(
            spans[0],
            WordSpan {
                text: "café".into(),
                start: 0,
                len: 4
            }
        );
        assert_eq!(
            spans[1],
            WordSpan {
                text: "😀".into(),
                start: 5,
                len: 2
            }
        );
        assert_eq!(
            spans[2],
            WordSpan {
                text: "ok".into(),
                start: 8,
                len: 2
            }
        );
    }

    #[test]
    fn an_empty_or_blank_line_has_no_words() {
        assert!(word_spans("").is_empty());
        assert!(word_spans("   \t ").is_empty());
    }

    #[test]
    fn vision_rects_flip_to_a_top_left_origin_and_clamp() {
        // Bottom-left (0.1, 0.2), 0.5 wide, 0.1 tall -> top edge at 1 - 0.3.
        let b = flip_vision_rect(0.1, 0.2, 0.5, 0.1);
        assert!((b[0] - 0.1).abs() < 1e-12 && (b[2] - 0.6).abs() < 1e-12);
        assert!((b[1] - 0.7).abs() < 1e-12 && (b[3] - 0.8).abs() < 1e-12);
        let clamped = flip_vision_rect(-0.1, 0.95, 0.3, 0.2);
        assert_eq!((clamped[0], clamped[1]), (0.0, 0.0));
        assert!((clamped[2] - 0.2).abs() < 1e-12 && (clamped[3] - 0.05).abs() < 1e-12);
    }
}
