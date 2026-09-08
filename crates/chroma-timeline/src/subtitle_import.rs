//! # Subtitle file parsing — SubRip (`.srt`) and WebVTT (`.vtt`) (D-229)
//!
//! **What it is:** a parser from the *text* of a subtitle file to a list of
//! [`ImportedCue`]s — a start time, an end time, and the cue's lines.
//!
//! **What it does NOT do:** it never opens a file, never touches the
//! filesystem, and never builds a [`crate::Timeline`]. It takes a `&str` and
//! returns data, which is what keeps it testable against awkward real-world
//! input with no fixtures on disk and what keeps this crate free of I/O (see
//! the crate's own module doc). Reading the file and converting milliseconds
//! to frames on the project's own timebase is `chroma::subtitles`
//! (`app/src-tauri`); [`cues_to_clips`] is the shared conversion both it and
//! the tests use.
//!
//! ## Formats
//!
//! **SubRip and WebVTT are one grammar here, deliberately.** Both are
//! blank-line-separated blocks of `start --> end` plus text lines; they differ
//! only in the decimal separator (`,` vs `.`), an optional `WEBVTT` header,
//! optional cue settings trailing the timing line, and WebVTT's `NOTE`/`STYLE`/
//! `REGION` blocks. Accepting both separators and skipping the non-cue blocks
//! is a handful of lines and covers files that mix the conventions — which real
//! files do, constantly: plenty of `.srt` in the wild uses `.` as its decimal
//! separator, and rejecting those would be pedantry, not correctness.
//!
//! **TTML is deliberately NOT parsed** (D-229, roadmap item 27). It is not the
//! same shape of job: a TTML document's cue times are only meaningful once
//! `ttp:timeBase`, `ttp:frameRate` and `ttp:frameRateMultiplier` are resolved
//! (an offset time of `120f` means different wall-clock instants under
//! different declared rates, and `smpte` timebase changes it again), and its
//! text content is only correct once `region` and `style` inheritance is
//! walked. A subset parser that read `begin`/`end` and ignored those would
//! import real broadcast files with silently wrong timings — the exact
//! half-built outcome this feature refused to ship. It is tracked as its own
//! roadmap line rather than faked here.
//!
//! ## Inline formatting
//!
//! SubRip's `<i>` / `<b>` / `<u>` / `<font …>` tags and WebVTT's `<c>` /
//! `<v Speaker>` are **stripped, not rendered** — the text is correct, the
//! emphasis is dropped. That is a real limitation with a real cause: the font
//! catalogue both renderers share (`chroma::text::TEXT_FONTS`) has no italic
//! face, so there is nothing honest to switch to, and leaving the literal
//! `<i>` in the text would burn markup into the picture. XML entities are
//! decoded, so `&amp;` reaches the screen as `&`.

use crate::Clip;
use crate::caption::CaptionCue;

/// One cue as it appeared in the file — times in milliseconds from the start
/// of the *file's* timeline, not the project's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedCue {
    /// Cue start, in milliseconds.
    pub start_ms: i64,
    /// Cue end, in milliseconds. Always `>= start_ms` (see
    /// [`parse_subtitles`]).
    pub end_ms: i64,
    /// The cue's text, lines joined with `\n`, tags stripped and entities
    /// decoded.
    pub text: String,
}

/// Why a subtitle file could not be read.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SubtitleParseError {
    /// The text contained no recognisable cue at all. Almost always a wrong
    /// file rather than a corrupt one, so it says so.
    #[error("no subtitle cues found — is this a SubRip (.srt) or WebVTT (.vtt) file?")]
    NoCues,
    /// A block had a timing line that could not be read. Carries the 1-based
    /// line number so the message can point at it.
    #[error("line {line}: could not read the timing line {text:?}")]
    BadTiming { line: usize, text: String },
}

/// Parse SubRip / WebVTT text into cues, in file order.
///
/// **Lenient about everything that does not change meaning, strict about
/// everything that does.** It tolerates a UTF-8 BOM, CRLF, a missing final
/// newline, absent or out-of-order cue numbers, `,` or `.` as the decimal
/// separator, a missing hours field (WebVTT's `MM:SS.mmm`), one or more blank
/// lines between blocks, and trailing WebVTT cue settings. It refuses a block
/// whose timing line is unreadable rather than guessing at it, and it refuses
/// a file with no cues at all.
///
/// A cue whose end precedes its start has its end **clamped up to its start**
/// rather than being dropped: such a cue is a real, common authoring slip, and
/// a zero-length caption that the user can see and fix on the timeline beats a
/// caption that silently vanished on import.
pub fn parse_subtitles(text: &str) -> Result<Vec<ImportedCue>, SubtitleParseError> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let lines: Vec<&str> = text
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect();

    let mut cues = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        // Skip blank lines between blocks.
        if lines[i].trim().is_empty() {
            i += 1;
            continue;
        }
        // WebVTT's header and its non-cue blocks. `NOTE`/`STYLE`/`REGION`
        // introduce a block that runs to the next blank line — skipping only
        // the keyword line would leave the block's body to be misread as cue
        // text.
        let trimmed = lines[i].trim();
        if is_webvtt_header(trimmed) || is_webvtt_block_keyword(trimmed) {
            while i < lines.len() && !lines[i].trim().is_empty() {
                i += 1;
            }
            continue;
        }

        // A block is: [optional identifier line] timing line, then text until
        // a blank line. The identifier is skipped by *looking ahead* for the
        // arrow rather than by assuming it is numeric — WebVTT identifiers are
        // free text, and plenty of `.srt` files number their cues oddly.
        let timing_idx = if lines[i].contains("-->") {
            i
        } else if i + 1 < lines.len() && lines[i + 1].contains("-->") {
            i + 1
        } else {
            return Err(SubtitleParseError::BadTiming {
                line: i + 1,
                text: lines[i].trim().to_string(),
            });
        };

        let (start_ms, end_ms) =
            parse_timing_line(lines[timing_idx]).ok_or_else(|| SubtitleParseError::BadTiming {
                line: timing_idx + 1,
                text: lines[timing_idx].trim().to_string(),
            })?;

        let mut body = Vec::new();
        let mut j = timing_idx + 1;
        while j < lines.len() && !lines[j].trim().is_empty() {
            body.push(strip_markup(lines[j]));
            j += 1;
        }
        i = j;

        let joined = body.join("\n");
        // A cue with a timing line and no text is a real thing in damaged
        // files; it carries no information, so it is dropped rather than
        // becoming an empty caption clip on the timeline.
        if joined.trim().is_empty() {
            continue;
        }
        cues.push(ImportedCue {
            start_ms,
            end_ms: end_ms.max(start_ms),
            text: joined,
        });
    }

    if cues.is_empty() {
        return Err(SubtitleParseError::NoCues);
    }
    Ok(cues)
}

fn is_webvtt_header(line: &str) -> bool {
    // The spec allows `WEBVTT`, `WEBVTT - some title`, `WEBVTT\tfoo`.
    line == "WEBVTT" || line.starts_with("WEBVTT ") || line.starts_with("WEBVTT\t")
}

fn is_webvtt_block_keyword(line: &str) -> bool {
    ["NOTE", "STYLE", "REGION"]
        .iter()
        .any(|k| line == *k || line.starts_with(&format!("{k} ")))
}

/// `00:00:04,040 --> 00:00:05,600 line:90%` → `(4040, 5600)`.
///
/// Everything after the end timestamp (WebVTT cue settings, SubRip's legacy
/// `X1:… Y1:…` coordinates) is ignored: those position a cue in the *file's*
/// own coordinate system, which a Chroma caption does not use — its position
/// comes from its track's [`crate::caption::CaptionStyle`]. Honouring them
/// would mean two competing sources of truth for one number.
fn parse_timing_line(line: &str) -> Option<(i64, i64)> {
    let (lhs, rhs) = line.split_once("-->")?;
    let start = parse_timestamp(lhs.trim())?;
    // The end timestamp is the first whitespace-delimited token after the
    // arrow; anything following it is settings.
    let end_token = rhs.split_whitespace().next()?;
    let end = parse_timestamp(end_token)?;
    Some((start, end))
}

/// `HH:MM:SS,mmm` / `HH:MM:SS.mmm` / `MM:SS.mmm` → milliseconds.
///
/// The fractional part is read as a decimal fraction of a second rather than
/// as "milliseconds", so a two-digit `.06` is 60 ms and a four-digit `.0625`
/// is 62 ms — files with a non-3-digit fraction exist, and reading `.06` as
/// 6 ms would put the cue in the wrong place.
fn parse_timestamp(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let (time_part, frac_ms) = match s.split_once([',', '.']) {
        Some((t, f)) => {
            let digits: String = f.chars().take_while(|c| c.is_ascii_digit()).collect();
            if digits.is_empty() {
                return None;
            }
            // Read as a fraction of a second: 0.06 -> 60 ms, 0.0625 -> 62 ms.
            let value: f64 = digits.parse().ok()?;
            let scale = 10f64.powi(digits.len() as i32);
            (t, (value / scale * 1000.0).round() as i64)
        }
        None => (s, 0),
    };

    let mut h = 0i64;
    let mut m;
    let s_sec;
    let parts: Vec<&str> = time_part.split(':').collect();
    match parts.as_slice() {
        [hh, mm, ss] => {
            h = parse_uint(hh)?;
            m = parse_uint(mm)?;
            s_sec = parse_uint(ss)?;
        }
        // WebVTT allows the hours field to be omitted.
        [mm, ss] => {
            m = parse_uint(mm)?;
            s_sec = parse_uint(ss)?;
        }
        _ => return None,
    }
    if m >= 60 {
        // Tolerated rather than rejected: a `00:75:00` appears in files
        // produced by naive tooling, and it means what it says.
        h += m / 60;
        m %= 60;
    }
    Some(((h * 3600 + m * 60 + s_sec) * 1000) + frac_ms)
}

fn parse_uint(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.is_empty() || !s.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// Strip SubRip/WebVTT inline tags and decode XML entities — see the module
/// doc for why the tags are stripped rather than rendered.
fn strip_markup(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut depth = 0usize;
    for ch in line.chars() {
        match ch {
            '<' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    decode_entities(&out)
}

/// The five XML predefined entities plus numeric character references.
///
/// Hand-rolled rather than pulled from a crate: this is the complete set a
/// subtitle file can legally contain, it is twenty lines, and the alternative
/// is a dependency on an HTML entity table for a format that has no HTML in it.
fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp..];
        // A `;` more than a few characters away is a literal ampersand, not a
        // truncated entity — bail out and emit it as text.
        let end = after[..after.len().min(12)].find(';');
        let Some(end) = end else {
            out.push('&');
            rest = &after[1..];
            continue;
        };
        let name = &after[1..end];
        let decoded = match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => name
                .strip_prefix('#')
                .and_then(|n| match n.strip_prefix(['x', 'X']) {
                    Some(hex) => u32::from_str_radix(hex, 16).ok(),
                    None => n.parse::<u32>().ok(),
                })
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &after[end + 1..];
            }
            None => {
                out.push('&');
                rest = &after[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Turn parsed cues into caption [`Clip`]s on a project running at `fps`,
/// offset by `offset_frames` timeline frames.
///
/// **Milliseconds become frames exactly once, here** — the one place the
/// file's own time base meets the project's, so an off-by-one rounding rule
/// cannot differ between the GUI import path and the MCP one.
///
/// A cue is given a minimum duration of one frame: a cue whose start and end
/// round to the same frame is real (a very short cue in a 24 fps project), and
/// a zero-duration clip is not something the timeline model can represent
/// usefully.
///
/// `id_prefix` seeds the clip ids; the caller supplies it so ids are stable
/// and unique within the timeline (see `chroma::subtitles`).
pub fn cues_to_clips(
    cues: &[ImportedCue],
    fps: f64,
    offset_frames: i64,
    id_prefix: &str,
) -> Vec<Clip> {
    let fps = if fps.is_finite() && fps > 0.0 {
        fps
    } else {
        crate::DEFAULT_FPS
    };
    cues.iter()
        .enumerate()
        .map(|(i, cue)| {
            let start = ms_to_frames(cue.start_ms, fps) + offset_frames;
            let end = ms_to_frames(cue.end_ms, fps) + offset_frames;
            let duration = (end - start).max(1);
            let mut clip = Clip {
                id: format!("{id_prefix}{i}"),
                start_frame: start,
                duration,
                source_len: duration,
                ..Clip::default()
            };
            clip.caption = Some(CaptionCue::new(cue.text.clone()));
            clip
        })
        .collect()
}

fn ms_to_frames(ms: i64, fps: f64) -> i64 {
    (ms as f64 * fps / 1000.0).round() as i64
}

/// Render cues back out as SubRip text — the other half of the round trip
/// Blackmagic's own copy promises ("exported as separate TTMLs, SRT or VTT
/// files").
///
/// Emits the canonical `HH:MM:SS,mmm` form with `\n` line endings and a
/// trailing blank line after each cue, which every reader accepts.
pub fn cues_to_srt(cues: &[ImportedCue]) -> String {
    let mut out = String::new();
    for (i, cue) in cues.iter().enumerate() {
        out.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            i + 1,
            format_srt_timestamp(cue.start_ms),
            format_srt_timestamp(cue.end_ms),
            cue.text
        ));
    }
    out
}

/// Render cues back out as WebVTT text.
pub fn cues_to_vtt(cues: &[ImportedCue]) -> String {
    let mut out = String::from("WEBVTT\n\n");
    for cue in cues {
        out.push_str(&format!(
            "{} --> {}\n{}\n\n",
            format_vtt_timestamp(cue.start_ms),
            format_vtt_timestamp(cue.end_ms),
            cue.text
        ));
    }
    out
}

fn format_srt_timestamp(ms: i64) -> String {
    let (h, m, s, milli) = split_ms(ms);
    format!("{h:02}:{m:02}:{s:02},{milli:03}")
}

fn format_vtt_timestamp(ms: i64) -> String {
    let (h, m, s, milli) = split_ms(ms);
    format!("{h:02}:{m:02}:{s:02}.{milli:03}")
}

fn split_ms(ms: i64) -> (i64, i64, i64, i64) {
    let ms = ms.max(0);
    (
        ms / 3_600_000,
        (ms / 60_000) % 60,
        (ms / 1000) % 60,
        ms % 1000,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real-shaped SubRip file: CRLF, a BOM, an italic tag, a two-line cue,
    /// an entity, and NO trailing newline on the last cue.
    const REAL_SRT: &str = "\u{feff}1\r\n\
        00:00:04,040 --> 00:00:05,600\r\n\
        We always visit this beach\r\n\
        \r\n\
        2\r\n\
        00:00:05,600 --> 00:00:07,660\r\n\
        Every year we spend a week\r\n\
        here\r\n\
        \r\n\
        3\r\n\
        00:00:08,040 --> 00:00:09,880\r\n\
        <i>Swimming</i>, surfing &amp; sunsets";

    #[test]
    fn parses_a_real_shaped_srt_file() {
        let cues = parse_subtitles(REAL_SRT).expect("parses");
        assert_eq!(cues.len(), 3);
        assert_eq!(cues[0].start_ms, 4040);
        assert_eq!(cues[0].end_ms, 5600);
        assert_eq!(cues[0].text, "We always visit this beach");
        // The two-line cue keeps BOTH lines.
        assert_eq!(cues[1].text, "Every year we spend a week\nhere");
        // Tags stripped, entity decoded, the rest of the line intact.
        assert_eq!(cues[2].text, "Swimming, surfing & sunsets");
        // A missing final newline must not lose the last cue.
        assert_eq!(cues[2].end_ms, 9880);
    }

    #[test]
    fn parses_webvtt_with_header_settings_notes_and_no_hours() {
        let vtt = "WEBVTT - My captions\n\
            \n\
            NOTE this is a comment\n\
            spanning two lines\n\
            \n\
            intro-cue\n\
            00:01.000 --> 00:02.500 line:90% align:center\n\
            Hello there\n\
            \n\
            00:00:03.000 --> 00:00:04.000\n\
            <v Roger>Second\n";
        let cues = parse_subtitles(vtt).expect("parses");
        assert_eq!(cues.len(), 2, "the NOTE block must not become a cue");
        // Hours omitted.
        assert_eq!((cues[0].start_ms, cues[0].end_ms), (1000, 2500));
        assert_eq!(cues[0].text, "Hello there");
        // A free-text cue identifier is skipped, not treated as text.
        assert_eq!(cues[1].text, "Second");
    }

    #[test]
    fn accepts_a_dot_decimal_separator_in_an_srt_file() {
        // Extremely common in the wild; rejecting it would be pedantry.
        let srt = "1\n00:00:01.500 --> 00:00:02.000\nHi\n";
        let cues = parse_subtitles(srt).expect("parses");
        assert_eq!((cues[0].start_ms, cues[0].end_ms), (1500, 2000));
    }

    #[test]
    fn keeps_overlapping_cues_in_file_order_without_merging_them() {
        // Two speakers talking over each other is legal and meaningful; the
        // parser must not "fix" it. (They land on the timeline as overlapping
        // clips, which is why the importer spreads them over tracks — see
        // `Timeline::add_subtitle_track_with_cues`.)
        let srt = "1\n00:00:01,000 --> 00:00:05,000\nFirst\n\n\
                   2\n00:00:02,000 --> 00:00:03,000\nSecond\n";
        let cues = parse_subtitles(srt).expect("parses");
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].text, "First");
        assert_eq!(cues[1].start_ms, 2000);
        assert!(cues[1].start_ms < cues[0].end_ms, "they really do overlap");
    }

    #[test]
    fn tolerates_missing_and_out_of_order_cue_numbers() {
        let srt = "00:00:01,000 --> 00:00:02,000\nNo number\n\n\
                   99\n00:00:03,000 --> 00:00:04,000\nOdd number\n";
        let cues = parse_subtitles(srt).expect("parses");
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].text, "No number");
        assert_eq!(cues[1].text, "Odd number");
    }

    #[test]
    fn tolerates_multiple_blank_lines_between_blocks() {
        let srt =
            "1\n00:00:01,000 --> 00:00:02,000\nA\n\n\n\n2\n00:00:03,000 --> 00:00:04,000\nB\n";
        let cues = parse_subtitles(srt).expect("parses");
        assert_eq!(cues.len(), 2);
    }

    #[test]
    fn a_cue_with_no_text_is_dropped_not_imported_blank() {
        let srt = "1\n00:00:01,000 --> 00:00:02,000\n\n2\n00:00:03,000 --> 00:00:04,000\nB\n";
        let cues = parse_subtitles(srt).expect("parses");
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "B");
    }

    #[test]
    fn an_end_before_its_start_is_clamped_rather_than_dropped() {
        let srt = "1\n00:00:05,000 --> 00:00:02,000\nBackwards\n";
        let cues = parse_subtitles(srt).expect("parses");
        assert_eq!(cues[0].start_ms, 5000);
        assert_eq!(cues[0].end_ms, 5000);
    }

    #[test]
    fn a_non_three_digit_fraction_is_read_as_a_fraction_of_a_second() {
        // `.06` is 60 ms, not 6 ms.
        assert_eq!(parse_timestamp("00:00:01.06"), Some(1060));
        // 0.0625 s is 62.5 ms, which rounds away from zero to 63.
        assert_eq!(parse_timestamp("00:00:01.0625"), Some(1063));
        assert_eq!(parse_timestamp("00:00:01"), Some(1000));
    }

    #[test]
    fn minutes_past_sixty_roll_into_hours() {
        assert_eq!(parse_timestamp("00:75:00,000"), Some(75 * 60 * 1000));
    }

    #[test]
    fn empty_and_junk_input_are_refused_with_a_real_reason() {
        assert_eq!(parse_subtitles(""), Err(SubtitleParseError::NoCues));
        assert_eq!(parse_subtitles("\n\n\n"), Err(SubtitleParseError::NoCues));
        // A file that is clearly not a subtitle file names the offending line.
        let err = parse_subtitles("{\n  \"json\": true\n}").expect_err("refused");
        assert!(matches!(err, SubtitleParseError::BadTiming { line: 1, .. }));
    }

    #[test]
    fn a_malformed_timestamp_is_refused_rather_than_guessed_at() {
        let srt = "1\n00:00:0X,000 --> 00:00:02,000\nA\n";
        let err = parse_subtitles(srt).expect_err("refused");
        assert!(matches!(err, SubtitleParseError::BadTiming { line: 2, .. }));
    }

    #[test]
    fn decodes_numeric_character_references_and_leaves_bare_ampersands_alone() {
        assert_eq!(decode_entities("a &#233; b"), "a é b");
        assert_eq!(decode_entities("a &#xE9; b"), "a é b");
        assert_eq!(decode_entities("Tom & Jerry"), "Tom & Jerry");
        assert_eq!(decode_entities("&unknown; x"), "&unknown; x");
    }

    #[test]
    fn cues_become_clips_on_the_projects_own_timebase() {
        let cues = vec![
            ImportedCue {
                start_ms: 1000,
                end_ms: 2000,
                text: "A".into(),
            },
            ImportedCue {
                start_ms: 2000,
                end_ms: 2010,
                text: "B".into(),
            },
        ];
        let clips = cues_to_clips(&cues, 24.0, 0, "cap-");
        assert_eq!(clips[0].start_frame, 24);
        assert_eq!(clips[0].duration, 24);
        assert!(clips[0].is_caption());
        assert_eq!(
            clips[0].caption.as_ref().map(|c| c.text.as_str()),
            Some("A")
        );
        // A cue shorter than one frame still gets a real, visible duration.
        assert_eq!(clips[1].duration, 1);
        assert_eq!(clips[1].id, "cap-1");
    }

    #[test]
    fn clip_conversion_honours_the_offset_and_a_bad_fps() {
        let cues = vec![ImportedCue {
            start_ms: 1000,
            end_ms: 2000,
            text: "A".into(),
        }];
        assert_eq!(cues_to_clips(&cues, 24.0, 100, "c")[0].start_frame, 124);
        // A zero/NaN fps falls back to the project default rather than
        // producing frame 0 or a NaN cast.
        assert_eq!(
            cues_to_clips(&cues, 0.0, 0, "c")[0].start_frame,
            (crate::DEFAULT_FPS as i64)
        );
    }

    #[test]
    fn srt_and_vtt_round_trip_through_the_parser() {
        let original = parse_subtitles(REAL_SRT).expect("parses");
        for text in [cues_to_srt(&original), cues_to_vtt(&original)] {
            let back = parse_subtitles(&text).expect("re-parses what we wrote");
            assert_eq!(back, original, "round trip must be lossless");
        }
    }

    #[test]
    fn srt_timestamps_are_formatted_canonically() {
        assert_eq!(format_srt_timestamp(3_661_500), "01:01:01,500");
        assert_eq!(format_vtt_timestamp(3_661_500), "01:01:01.500");
        assert_eq!(format_srt_timestamp(-5), "00:00:00,000");
    }
}
