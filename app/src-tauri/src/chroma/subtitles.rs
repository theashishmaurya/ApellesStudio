//! Subtitle file I/O for the Edit tab (D-229, `docs/notes/subtitles.md`).
//!
//! **What it is:** the thin shell around
//! [`apelles_timeline::subtitle_import`] — read a `.srt`/`.vtt` file off disk,
//! parse it, and hand the frontend cues already converted to the **project's
//! own timebase**; and the reverse, write the active timeline's captions back
//! out as a `.srt` or `.vtt` file.
//!
//! **What it does NOT do:** no parsing of its own (that is the pure,
//! unit-tested crate function — this module would otherwise be a second
//! grammar to keep in step), no timeline mutation (the frontend's
//! `import_subtitles` op is what actually places the track, so the GUI and the
//! MCP path share one reducer and one undo entry), and no rendering.
//!
//! **Why the conversion to frames happens HERE and not in TypeScript.** A cue's
//! milliseconds meet the project's frame rate exactly once, in
//! [`apelles_timeline::subtitle_import::cues_to_clips`]. Doing it on this side
//! means the GUI importer and `editor_import_subtitles` cannot round
//! differently — the same "one op underneath both interfaces" rule CLAUDE.md
//! states for every feature.

use std::path::{Path, PathBuf};

use apelles_timeline::subtitle_import::{
    ImportedCue, cues_to_clips, cues_to_srt, cues_to_vtt, parse_subtitles,
};
use serde::{Deserialize, Serialize};

use super::edit;

/// One imported cue, already on the project's timebase — what the frontend's
/// `import_subtitles` op consumes verbatim.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportedCaption {
    /// Stable clip id, assigned here so a re-import is idempotent per file
    /// rather than producing a fresh set of random ids each time.
    pub id: String,
    /// TIMELINE frame the cue starts at.
    pub start_frame: i64,
    /// Length in timeline frames, always at least 1 (see `cues_to_clips`).
    pub duration: i64,
    /// The cue's text. May contain `\n`.
    pub text: String,
}

/// The result of reading a subtitle file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubtitleImport {
    pub cues: Vec<ImportedCaption>,
    /// The file's own name, so the UI can say what it imported without
    /// re-deriving it from a path it was the one to pass in.
    pub source_name: String,
}

/// Which subtitle formats this build actually reads. Returned to the frontend
/// so the file picker's filter and the MCP tool's error message are generated
/// from the same list rather than hardcoded twice.
///
/// **TTML is deliberately absent** — see
/// [`apelles_timeline::subtitle_import`]'s module doc and D-229 for why a
/// subset parser was refused rather than shipped.
pub const SUBTITLE_EXTENSIONS: &[&str] = &["srt", "vtt"];

/// Read and parse a subtitle file, converting its cues onto the **active**
/// project's timebase.
///
/// `offset_frames` shifts every cue — for dropping a subtitle file at the
/// playhead rather than at 00:00, which is what a real NLE does when you drag
/// one into the middle of a timeline.
///
/// Does **not** touch the timeline: the caller applies the returned cues
/// through the frontend's `import_subtitles` op, so the GUI and MCP paths
/// share one reducer, one validation and one undo entry.
#[tauri::command]
pub fn chroma_import_subtitles(
    path: String,
    offset_frames: Option<i64>,
) -> Result<SubtitleImport, String> {
    let path = PathBuf::from(&path);
    check_supported_extension(&path)?;
    let text = read_subtitle_file(&path)?;
    let cues = parse_subtitles(&text).map_err(|e| e.to_string())?;

    let timeline = edit::resolve_timeline(false)?;
    let fps = timeline.fps();

    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "subtitles".to_string());
    // The id prefix is the file's own stem, so two imported languages produce
    // visibly distinct, stable ids rather than two random sets.
    let prefix = format!("cap-{}-", sanitise_id(&stem));
    let clips = cues_to_clips(&cues, fps, offset_frames.unwrap_or(0), &prefix);

    Ok(SubtitleImport {
        cues: clips
            .into_iter()
            .map(|c| ImportedCaption {
                id: c.id,
                start_frame: c.start_frame,
                duration: c.duration,
                text: c.caption.map(|cue| cue.text).unwrap_or_default(),
            })
            .collect(),
        source_name: stem,
    })
}

/// Write the captions on subtitle track `track` of the **active** timeline out
/// as a `.srt` or `.vtt` file.
///
/// The other half of the round trip Blackmagic's own copy promises —
/// "[subtitles] can be rendered into the final video **or exported as separate
/// TTMLs, SRT or VTT files**". Rendering-into-the-video is the export
/// compiler's `drawtext` path; this is the sidecar-file half.
///
/// The format is chosen by `path`'s extension, falling back to SubRip — the
/// same "degrade to the common case rather than erroring" posture the rest of
/// this feature takes, and `.srt` is what a user typing a bare filename means.
#[tauri::command]
pub fn chroma_export_subtitles(track: usize, path: String) -> Result<usize, String> {
    let timeline = edit::resolve_timeline(false)?;
    let fps = timeline.fps();
    let tr = timeline
        .tracks
        .get(track)
        .ok_or_else(|| format!("no track {track}"))?;
    if tr.kind != apelles_timeline::TrackKind::Subtitle {
        return Err(format!("track {track} is not a subtitle track"));
    }

    // Sorted by position, not by the `Vec`'s bookkeeping order — a `.srt`
    // file's cues are expected to be in time order, and `Track.clips` is
    // explicitly documented not to be (see `Timeline::reorder`).
    let mut clips: Vec<_> = tr.clips.iter().filter(|c| c.is_caption()).collect();
    clips.sort_by_key(|c| c.start_frame);

    let cues: Vec<ImportedCue> = clips
        .iter()
        .filter_map(|c| {
            let cue = c.caption.as_ref()?;
            Some(ImportedCue {
                start_ms: frames_to_ms(c.start_frame, fps),
                end_ms: frames_to_ms(c.end_frame_at(fps), fps),
                text: cue.text.clone(),
            })
        })
        .collect();

    let path = PathBuf::from(&path);
    let is_vtt = path
        .extension()
        .map(|e| e.eq_ignore_ascii_case("vtt"))
        .unwrap_or(false);
    let body = if is_vtt {
        cues_to_vtt(&cues)
    } else {
        cues_to_srt(&cues)
    };
    std::fs::write(&path, body).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(cues.len())
}

/// Refuse a file this build cannot honestly read, **naming the format**.
///
/// Worth doing rather than letting the parser fail: handing a `.ttml` to the
/// SubRip grammar produces "no subtitle cues found", which reads like a
/// corrupt file and sends the user looking in the wrong place. TTML is a
/// format we deliberately do not support (see
/// [`apelles_timeline::subtitle_import`]'s module doc and D-229), and saying so
/// is the difference between a limitation and a bug.
///
/// A file with no extension at all is allowed through to the parser: the
/// content is what actually decides, and plenty of real subtitle files arrive
/// without one.
fn check_supported_extension(path: &Path) -> Result<(), String> {
    let Some(ext) = path.extension().map(|e| e.to_string_lossy().to_lowercase()) else {
        return Ok(());
    };
    if SUBTITLE_EXTENSIONS.contains(&ext.as_str()) {
        return Ok(());
    }
    if matches!(ext.as_str(), "ttml" | "dfxp" | "xml" | "itt") {
        return Err(format!(
            ".{ext} is a TTML-family timed-text file, which Apelles deliberately does not read \
             (its cue times depend on ttp:timeBase/ttp:frameRate, and a partial parser would \
             import real files with silently wrong timings). Convert it to .srt first."
        ));
    }
    Err(format!(
        "unsupported subtitle format .{ext} — expected one of {}",
        SUBTITLE_EXTENSIONS.join(", ")
    ))
}

/// Read a subtitle file as text, tolerating the encodings these files actually
/// arrive in.
///
/// **UTF-8 is read strictly; anything else falls back to Latin-1 rather than
/// failing.** Subtitle files are frequently produced by old tooling in a
/// single-byte codepage, and `String::from_utf8_lossy` would replace every
/// accented character with `U+FFFD` — turning "à la plage" into visible
/// mojibake burnt into the picture. Latin-1 is the overwhelmingly common such
/// codepage and its decode is total (every byte maps to a code point), so the
/// text is at worst wrong in the same way the file is, never silently
/// destroyed.
fn read_subtitle_file(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    match String::from_utf8(bytes) {
        Ok(s) => Ok(s),
        Err(e) => Ok(e.into_bytes().into_iter().map(|b| b as char).collect()),
    }
}

/// A file stem reduced to characters safe in a clip id.
fn sanitise_id(stem: &str) -> String {
    stem.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_lowercase()
}

fn frames_to_ms(frames: i64, fps: f64) -> i64 {
    let fps = if fps.is_finite() && fps > 0.0 {
        fps
    } else {
        apelles_timeline::DEFAULT_FPS
    };
    (frames as f64 * 1000.0 / fps).round() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_latin1_file_decodes_to_real_characters_not_replacement_chars() {
        // "à" is 0xE0 in Latin-1, which is not valid UTF-8 on its own.
        let dir = std::env::temp_dir().join("chroma-subs-latin1-test");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("latin1.srt");
        let mut bytes = b"1\n00:00:01,000 --> 00:00:02,000\n".to_vec();
        bytes.extend_from_slice(&[0xE0]);
        bytes.extend_from_slice(b" la plage\n");
        std::fs::write(&path, &bytes).expect("write");
        let text = read_subtitle_file(&path).expect("read");
        assert!(text.contains("à la plage"), "got {text:?}");
        assert!(!text.contains('\u{fffd}'), "must not mangle to U+FFFD");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn utf8_is_read_unchanged() {
        let dir = std::env::temp_dir().join("chroma-subs-utf8-test");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("utf8.srt");
        std::fs::write(&path, "1\n00:00:01,000 --> 00:00:02,000\nà la plage\n").expect("write");
        assert!(
            read_subtitle_file(&path)
                .expect("read")
                .contains("à la plage")
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_ttml_file_is_refused_by_name_rather_than_failing_as_junk() {
        // The whole point: the message must say TTML is unsupported, not "no
        // cues found", which reads like a corrupt file.
        for ext in ["ttml", "dfxp", "xml", "itt"] {
            let err = check_supported_extension(Path::new(&format!("subs.{ext}")))
                .expect_err("should refuse");
            assert!(err.contains("TTML"), "got {err:?}");
            assert!(err.contains(".srt"), "should say what to do: {err:?}");
        }
    }

    #[test]
    fn supported_extensions_pass_and_others_are_named() {
        assert!(check_supported_extension(Path::new("a.srt")).is_ok());
        assert!(check_supported_extension(Path::new("a.VTT")).is_ok());
        // No extension at all is allowed through — the content decides.
        assert!(check_supported_extension(Path::new("subtitles")).is_ok());
        let err = check_supported_extension(Path::new("a.mp4")).expect_err("should refuse");
        assert!(err.contains("mp4"), "got {err:?}");
    }

    #[test]
    fn id_sanitising_produces_a_usable_prefix() {
        assert_eq!(sanitise_id("My Film — EN"), "my-film---en");
        assert_eq!(sanitise_id("---"), "");
    }

    #[test]
    fn frames_to_ms_is_the_inverse_of_the_importers_ms_to_frames() {
        // 24 frames at 24 fps is exactly one second, both ways.
        assert_eq!(frames_to_ms(24, 24.0), 1000);
        assert_eq!(frames_to_ms(0, 24.0), 0);
        // A nonsense fps falls back rather than dividing by zero.
        assert_eq!(frames_to_ms(24, 0.0), 1000);
    }
}
