//! Still images as timeline sources (D-281).
//!
//! **What it is:** the still-image counterpart of [`crate::video`] — the one
//! place this workspace answers "is this path a still?", "how big is it?" and
//! "give me its pixels", for a PNG/JPEG/TIFF/WebP/BMP a user drops into the
//! Edit tab's media pool.
//!
//! **What it does:**
//! - [`is_image_file`] — the extension gate, mirrored on the TS side by
//!   `@apelles/editor`'s `isStillSource`. Every consumer asks this one
//!   predicate rather than re-spelling an extension list.
//! - [`probe`] — the still's [`Resolution`], read from the file *header* only
//!   (`image::image_dimensions`). No subprocess, no full decode: the media
//!   pool needs this per import and the compositor needs it per frame.
//! - [`decode_scaled`] — the still's pixels as an `Arc<RgbaImage>`, at the
//!   caller's target size, memoised across frames so a 6000×4000 PNG held for
//!   three seconds of timeline is decoded once, not 72 times.
//! - [`thumbnail`] — a height-bounded JPEG data URL, the same wire shape and
//!   the same bound `video::extract_thumb` produces, so the media pool's
//!   thumbnail cache and the Sources panel need no still-specific branch at all.
//!
//! **What it does NOT do:** decode RAW (that is RapidRAW's `image_loader` /
//! `raw_processing`, which lives above this layer in `app/src-tauri` and is
//! Colorist's still path, not the Edit tab's), animate a GIF (a still is one
//! frame by definition — see [`IMAGE_EXTENSIONS`]), or know anything about
//! clips, timelines or durations. A still has no length; deciding what length
//! to *give* it is the timeline's job (`@apelles/editor`'s
//! `DEFAULT_TITLE_SECONDS` / `STILL_SOURCE_SECONDS`).
//!
//! **Why a new module rather than reusing RapidRAW's image loader.** The
//! dependency direction is one-way (`app → … → media → types`, D-039):
//! `app/src-tauri/src/image_loader.rs` sits *above* this crate, so reusing it
//! here would be a cycle. What is shared instead is the thing that matters —
//! the `image` crate itself, already a dependency of this crate for
//! [`crate::video`]'s own PNG round-trip — and [`IMAGE_EXTENSIONS`] is derived
//! from `app/src-tauri/src/formats.rs`'s `NON_RAW_EXTENSIONS` rather than
//! invented. See D-281 for why it is a strict subset of that list.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{Context, Result, anyhow};
use image::RgbaImage;

use apelles_types::Resolution;

/// The still formats the Edit tab accepts as a timeline source.
///
/// **A deliberate subset of `app/src-tauri/src/formats.rs`'s
/// `NON_RAW_EXTENSIONS`** (Colorist's own still list), not a second
/// independently-invented list and not a copy of the whole thing. Two
/// constraints narrow it (D-281):
///
/// 1. **Both engines must read it.** A still on the Edit timeline is decoded by
///    the `image` crate for the preview *and* opened by `ffmpeg` for the
///    export. A format only one of them handles would preview correctly and
///    fail to render — the exact preview/export divergence D-256/D-236 keep
///    this codebase's two engines away from. Every extension here is decoded by
///    both.
/// 2. **A still is one frame.** `gif` is excluded for that reason alone rather
///    than any decoder gap: an animated GIF placed as a "still" would show its
///    first frame and silently drop the rest, which is a wrong answer, not a
///    limitation.
///
/// RAW (`.cr2`, `.arw`, …) is excluded because its decode lives above this
/// layer and `ffmpeg` cannot open it either — widening to RAW is a real
/// feature, not an entry in this list.
pub const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp"];

/// `true` if `path`'s extension names a still this workspace can place on a
/// timeline. Extension-only, exactly like [`crate::video::is_video_file`] —
/// the file's real readability is settled by [`probe`], not guessed here.
pub fn is_image_file<P: AsRef<Path>>(path: P) -> bool {
    path.as_ref()
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTENSIONS.iter().any(|i| i.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

/// A still's probed facts. Deliberately just the resolution: unlike
/// [`crate::video::VideoInfo`] there is no frame rate, no duration, no frame
/// count and no audio to report, and synthesising any of them here would be
/// inventing a fact the file does not contain (D-281).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StillInfo {
    pub resolution: Resolution,
}

/// `path`'s pixel dimensions, read from its header.
///
/// `image::image_dimensions` opens the file and parses only enough of it to
/// answer — it does not decode the pixels — so this is cheap enough to call on
/// every media-pool import and every composited frame. Errors when the file is
/// missing, is not one of [`IMAGE_EXTENSIONS`] as far as the decoder is
/// concerned, or is truncated.
pub fn probe(path: &Path) -> Result<StillInfo> {
    let (w, h) = image::image_dimensions(path)
        .with_context(|| format!("reading image dimensions of {}", path.display()))?;
    if w == 0 || h == 0 {
        return Err(anyhow!("{} has no usable resolution", path.display()));
    }
    Ok(StillInfo {
        resolution: Resolution::new(w, h),
    })
}

/// How many decoded stills stay resident. Small on purpose: each entry is a
/// full-resolution RGBA buffer (a 6000×4000 still is ~96 MB), and the number of
/// *distinct* stills visible at one composited frame is bounded by the number
/// of video tracks. Four covers a stack deeper than anything this editor's
/// multi-track compositor is built for, at a worst case well under what one
/// decoded 4K video frame pool already costs.
const DECODE_CACHE_CAPACITY: usize = 4;

/// A decoded still's cache key: the path, the source's own identity
/// ([`crate::media_cache::source_key`] — path, mtime, length) and the target
/// size it was scaled to.
///
/// The identity is what makes this correct rather than merely fast: a file
/// replaced in place is re-decoded rather than served stale, exactly the
/// contract B-056 gave [`crate::probe::probe_cached`] and B-128 gave the
/// media-pool thumbnail. A third cache with a weaker one would be the same bug
/// a third time.
///
/// The **target size** is part of the key for the reason the whole cache
/// exists: the compositor asks for a still at the preview's current quality,
/// which is constant while the user is watching, so keying on it means one
/// decode+resize for a three-second still rather than 72. It is also what makes
/// the cache safe — an entry can never be served at the wrong size.
type DecodeKey = (PathBuf, String, Option<(u32, u32)>);

/// Most-recently-used first, truncated at [`DECODE_CACHE_CAPACITY`] — the same
/// tiny-LRU shape `chroma::text`'s rasterised-layer cache uses, for the same
/// reason (a handful of large buffers, looked up by an equality key). A `Vec`
/// rather than a `HashMap` precisely because it is tiny: at four entries a
/// linear scan beats hashing a `PathBuf`, and the ordering IS the eviction
/// policy.
type DecodeCache = Mutex<Vec<(DecodeKey, Arc<RgbaImage>)>>;

fn decode_cache() -> &'static DecodeCache {
    static CACHE: OnceLock<DecodeCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

/// `path`'s pixels as RGBA, optionally resized to `target`, memoised (see
/// [`DECODE_CACHE_CAPACITY`]).
///
/// **The still counterpart of [`crate::decode_pipe::playback_frame_scaled`]**,
/// down to the `Option<(u32, u32)>` target the compositor computes with
/// [`crate::decode_pipe::scale_target`] — so a still layer and a video layer are
/// asked for their pixels the same way and arrive at the same size. `None` =
/// full resolution.
///
/// **Why the cache is not optional here.** A still on the timeline is the same
/// file for every frame of its whole duration; without memoisation a 6000×4000
/// PNG held for three seconds would be decoded and resampled 72 times, which is
/// exactly the kind of preview stutter CLAUDE.md's performance-first rule calls
/// a defect. With it, a still costs one decode and then a pointer copy per
/// frame — cheaper than the `ffmpeg` pipe a video layer needs.
///
/// RGBA rather than RGB because that is what the compositor's paint step wants
/// (`image::imageops::overlay` onto an RGBA canvas), and because a PNG/WebP
/// still legitimately carries an alpha channel that must survive to the blend —
/// a still logo over footage is the obvious case.
///
/// Deterministic: `Lanczos3` is a fixed kernel, so the same file at the same
/// target is the same pixels every time (the render-path invariant), on a cold
/// cache and a warm one alike.
///
/// A poisoned cache mutex degrades to an uncached decode rather than
/// propagating: the cache is an optimisation, never a failure mode (the same
/// policy [`crate::decode_pipe`] has for a broken pipe).
pub fn decode_scaled(path: &Path, target: Option<(u32, u32)>) -> Result<Arc<RgbaImage>> {
    let key: DecodeKey = (
        path.to_path_buf(),
        crate::media_cache::source_key(path).unwrap_or_default(),
        target,
    );
    if let Ok(cache) = decode_cache().lock()
        && let Some((_, img)) = cache.iter().find(|(k, _)| *k == key)
    {
        return Ok(Arc::clone(img));
    }
    let decoded = image::open(path)
        .with_context(|| format!("decoding still {}", path.display()))?
        .to_rgba8();
    let img = Arc::new(match target {
        Some((w, h)) if w > 0 && h > 0 && (w, h) != decoded.dimensions() => {
            image::imageops::resize(&decoded, w, h, image::imageops::FilterType::Lanczos3)
        }
        _ => decoded,
    });
    if let Ok(mut cache) = decode_cache().lock() {
        cache.retain(|(k, _)| *k != key);
        cache.insert(0, (key, Arc::clone(&img)));
        cache.truncate(DECODE_CACHE_CAPACITY);
    }
    Ok(img)
}

/// A `data:image/jpeg;base64,…` thumbnail of `path`, scaled to `max_height`
/// with its aspect ratio preserved.
///
/// **The same wire shape AND the same bound [`crate::video::extract_thumb`]
/// uses** (its own `height` parameter compiles to `ffmpeg`'s
/// `scale=-1:<height>`), deliberately: the media pool caches a thumbnail per
/// item as `<video_dir>/.chroma/thumbs/<id>.jpg` (D-059) and the Sources panel
/// renders whatever data URL comes back, so a still needs no thumbnail branch
/// anywhere downstream of this function — only a different way of producing the
/// bytes. Bounding the *height* rather than the long edge is what keeps a
/// portrait still the same row height as a landscape video in that grid.
///
/// The alpha channel is flattened onto black by the RGB conversion, since JPEG
/// has none. That is the honest degradation for a *thumbnail*; the composited
/// picture keeps the real alpha (see [`decode_scaled`]).
pub fn thumbnail(path: &Path, max_height: u32) -> Result<String> {
    use base64::Engine as _;
    use std::io::Cursor;

    let img = image::open(path).with_context(|| format!("decoding still {}", path.display()))?;
    let (w, h) = (img.width().max(1), img.height().max(1));
    let target_h = max_height.min(h).max(1);
    let target_w = ((u64::from(w) * u64::from(target_h)) / u64::from(h)).max(1) as u32;
    // `resize_exact`, not `thumbnail`/`resize`: both of those fit the image
    // *within* the box and derive their own dimensions, which rounds the height
    // down below `max_height` — the aspect ratio is already resolved above, so
    // what is wanted here is the exact pair. `Triangle` is the ordinary
    // downscale filter for a 150 px thumbnail; the full-quality path is
    // `decode_scaled`.
    let thumb = img
        .resize_exact(target_w, target_h, image::imageops::FilterType::Triangle)
        .to_rgb8();
    let mut buf = Vec::new();
    image::DynamicImage::ImageRgb8(thumb)
        .write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Jpeg)
        .with_context(|| format!("encoding a thumbnail for {}", path.display()))?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&buf)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Write a real `w`×`h` PNG into `dir` and return its path.
    fn write_png(dir: &Path, name: &str, w: u32, h: u32) -> PathBuf {
        let path = dir.join(name);
        let img = image::RgbImage::from_fn(w, h, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        });
        img.save(&path).unwrap();
        path
    }

    #[test]
    fn ext_gate_matches_the_documented_list() {
        assert!(is_image_file("a/b/ref.png"));
        assert!(
            is_image_file("a/b/REF.PNG"),
            "case-insensitive, like is_video_file"
        );
        assert!(is_image_file("shot.jpeg"));
        assert!(is_image_file("plate.TIFF"));
        assert!(!is_image_file("clip.mov"), "a video is not a still");
        assert!(!is_image_file("bed.mp3"), "audio is not a still");
        // D-281 — deliberately excluded: one frame is the whole contract.
        assert!(!is_image_file("loop.gif"));
        // Above this layer, and unopenable by ffmpeg — a real feature, not a
        // list entry.
        assert!(!is_image_file("DSC_0001.cr2"));
        assert!(!is_image_file("noext"));
    }

    #[test]
    fn probe_reads_real_dimensions_without_decoding() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write_png(tmp.path(), "ref.png", 64, 48);
        let info = probe(&p).unwrap();
        assert_eq!(info.resolution.width, 64);
        assert_eq!(info.resolution.height, 48);
    }

    #[test]
    fn probe_fails_loudly_on_a_missing_or_unreadable_file() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(probe(&tmp.path().join("nope.png")).is_err());
        let junk = tmp.path().join("junk.png");
        std::fs::write(&junk, b"not a png at all").unwrap();
        assert!(
            probe(&junk).is_err(),
            "a truncated/garbage file is an error, not a 0x0"
        );
    }

    /// The cache must be a pure optimisation: the second call returns the same
    /// pixels, and (the part that actually matters) a file REPLACED IN PLACE is
    /// re-decoded rather than served from the previous entry — B-056/B-128's
    /// contract, applied to this third cache.
    #[test]
    fn decode_scaled_is_transparent_and_revalidates_a_replaced_file() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write_png(tmp.path(), "ref.png", 8, 6);
        let a = decode_scaled(&p, None).unwrap();
        let b = decode_scaled(&p, None).unwrap();
        assert_eq!(a.dimensions(), (8, 6));
        assert_eq!(a.as_raw(), b.as_raw(), "same file ⇒ same pixels");

        // Replace it in place with a different picture, at a different size so
        // a stale hit is unmistakable. `source_key` folds in mtime and length,
        // and both change here.
        std::thread::sleep(std::time::Duration::from_millis(10));
        write_png(tmp.path(), "ref.png", 12, 10);
        let c = decode_scaled(&p, None).unwrap();
        assert_eq!(
            c.dimensions(),
            (12, 10),
            "a replaced still must not serve the old decode"
        );
    }

    /// The target size is part of the cache key, so two different preview
    /// qualities of the same still cannot serve each other's pixels — and the
    /// decode is deterministic at each of them (the render-path invariant).
    #[test]
    fn decode_scaled_honours_and_keys_on_the_target_size() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write_png(tmp.path(), "big.png", 64, 48);
        let full = decode_scaled(&p, None).unwrap();
        let small = decode_scaled(&p, Some((32, 24))).unwrap();
        assert_eq!(full.dimensions(), (64, 48));
        assert_eq!(small.dimensions(), (32, 24));
        // Still full-size on a re-ask: the small entry did not evict the full one's
        // identity.
        assert_eq!(decode_scaled(&p, None).unwrap().dimensions(), (64, 48));
        // Deterministic — same file, same target, same bytes.
        assert_eq!(
            small.as_raw(),
            decode_scaled(&p, Some((32, 24))).unwrap().as_raw()
        );
    }

    /// The same wire shape and the same HEIGHT bound `video::extract_thumb`
    /// produces (`scale=-1:<height>`) — the media pool caches both into the
    /// same slot and the Sources panel renders both in the same grid.
    #[test]
    fn thumbnail_is_a_height_bounded_jpeg_data_url() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write_png(tmp.path(), "big.png", 400, 200);
        let url = thumbnail(&p, 150).unwrap();
        assert!(url.starts_with("data:image/jpeg;base64,"), "{url:.40}");
        let b64 = url.rsplit_once(',').unwrap().1;
        let bytes = {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD
                .decode(b64)
                .unwrap()
        };
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!(
            decoded.height(),
            150,
            "bounded on HEIGHT, like scale=-1:150"
        );
        assert_eq!(decoded.width(), 300, "aspect preserved");

        // A portrait still is bounded the same way, which is the whole point of
        // matching the video path's bound rather than the long edge.
        let tall = write_png(tmp.path(), "tall.png", 100, 400);
        let tall_url = thumbnail(&tall, 150).unwrap();
        let tall_bytes = {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD
                .decode(tall_url.rsplit_once(',').unwrap().1)
                .unwrap()
        };
        let tall_img = image::load_from_memory(&tall_bytes).unwrap();
        assert_eq!(tall_img.height(), 150);
        assert_eq!(tall_img.width(), 37);
    }
}
