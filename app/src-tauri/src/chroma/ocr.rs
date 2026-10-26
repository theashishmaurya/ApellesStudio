//! Tauri bridge for on-device text recognition (D-397).
//!
//! What it is: the one `#[tauri::command]`, `chroma_ocr_media`, that
//! `@apelles/editor`'s highlight suggester (`editor_suggest_clip_highlights`,
//! and the Inspector's "Suggest from transcript" button) calls to learn where
//! the words in a clip's picture are.
//! What it does NOT do: any recognition (that is `apelles_media::ocr`, over the
//! macOS Vision framework), any matching against a transcript (the editor
//! package), and any caching: a suggestion is a rare, user-initiated call, and a
//! cache here would only be a way for a stale answer to outlive an edited file.
//!
//! Runs on a blocking thread: Vision is synchronous and a screenshot takes a
//! few hundred milliseconds, which must not sit on the async runtime.

use apelles_media::ocr::{OcrLine, recognize_media};

/// Every line and word of text in `source_path`'s picture, with boxes as
/// top-left fractions of the image. A still is read as it is; a video is decoded
/// at `source_frame` first.
#[tauri::command]
pub async fn chroma_ocr_media(
    source_path: String,
    source_frame: u64,
) -> Result<Vec<OcrLine>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        recognize_media(std::path::Path::new(&source_path), source_frame)
            .map_err(|e| format!("text recognition failed for {source_path}: {e}"))
    })
    .await
    .map_err(|e| format!("text recognition task failed: {e}"))?
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use crate::chroma::text;
    use apelles_timeline::TextLayer;

    /// A real round trip through the real Vision framework: rasterise a
    /// headline with the app's own text engine, black on white, and read it
    /// back. The words must be found, in order, with boxes that sit where the
    /// ink is (centred, so around the middle of the picture) and that are
    /// ordered left to right.
    #[test]
    fn vision_finds_the_words_and_their_boxes_in_a_rendered_headline() {
        let layer = TextLayer {
            content: "Breach of customer trust".into(),
            font: text::chroma_text_fonts()
                .first()
                .map(|f| f.key.clone())
                .unwrap_or_default(),
            size: 0.2,
            color: "#000000".into(),
        };
        let ink = text::render_text_layer(&layer, 1200, 300).expect("rasterise");
        let mut page = image::RgbaImage::from_pixel(1200, 300, image::Rgba([255, 255, 255, 255]));
        image::imageops::overlay(&mut page, &*ink, 0, 0);
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(page)
            .write_to(&mut png, image::ImageFormat::Png)
            .expect("encode");

        let lines = apelles_media::ocr::recognize_image(png.get_ref()).expect("vision");
        let words: Vec<_> = lines.iter().flat_map(|l| l.words.iter()).collect();
        let spoken: Vec<String> = words.iter().map(|w| w.text.to_lowercase()).collect();
        assert_eq!(spoken, ["breach", "of", "customer", "trust"], "{lines:#?}");
        for pair in words.windows(2) {
            assert!(
                pair[0].bbox[0] < pair[1].bbox[0],
                "words are left to right: {pair:?}"
            );
        }
        for w in &words {
            let [x0, y0, x1, y1] = w.bbox;
            assert!(x1 > x0 && y1 > y0 && (0.0..=1.0).contains(&x0) && x1 <= 1.0 && y1 <= 1.0);
            // The headline is vertically centred in a 300 px canvas.
            assert!(y0 > 0.2 && y1 < 0.8, "box sits around the middle: {w:?}");
        }
    }

    #[test]
    fn a_picture_with_no_text_returns_no_lines() {
        let blank = image::RgbaImage::from_pixel(200, 120, image::Rgba([240, 240, 240, 255]));
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(blank)
            .write_to(&mut png, image::ImageFormat::Png)
            .expect("encode");
        assert!(
            apelles_media::ocr::recognize_image(png.get_ref())
                .expect("vision")
                .is_empty()
        );
    }
}
