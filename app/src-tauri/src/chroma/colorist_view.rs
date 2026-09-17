//! **colorist_view.rs — the Colorist ⇄ Edit *picture* bridge** (D-294, B-147).
//!
//! What it is: the one place that answers "which Edit-timeline
//! [`apelles_timeline::Clip`] is the Colorist tab actually grading right now,
//! and what does that clip's picture look like?" — the geometry counterpart of
//! [`super::grade_lut`], which is the colour half of the same bridge in the
//! other direction (a Colorist grade → a `Lut3d` the Edit compositor applies).
//!
//! What it does:
//! - [`resolve`] maps the decode session's active clip **path** to the clip on
//!   the open project's active timeline, plus that timeline's fps and the
//!   project's composition size.
//! - [`ClipView::source_frame`] maps a **clip-local** frame (what the Colorist
//!   transport counts in after D-294) to the **source** frame to decode,
//!   through the clip's own trim and speed ramp
//!   (`Clip::clamped_source_frame_at` — the same function the Edit preview and
//!   the exporter use, never a second copy of that arithmetic).
//! - [`ClipView::apply_geometry`] places a decoded source frame into
//!   composition space exactly as `chroma::edit`'s compositor would: crop →
//!   scale → rotate → position, via `edit::composite_layer_onto` itself.
//!
//! What it does NOT do, deliberately:
//! - **No grade.** The Colorist is what *produces* the grade; baking
//!   `grade_lut::lut_for_clip` in here would show the grade twice (once from
//!   the LUT, once from the live wgpu pipeline the Colorist renders this frame
//!   through) and make every subsequent adjustment compound on itself.
//! - **No opacity / fade / transition alpha.** Those are how a clip *blends
//!   into layers beneath it*, and the Colorist canvas has no layers beneath
//!   it. A clip at 50% opacity is not a clip that should be graded against a
//!   half-black picture.
//! - **No other layers.** This is one clip's own picture, not the timeline
//!   composite — a second video track's clip is a separate Colorist shot with
//!   a separate grade, and painting it in here would make the two grades
//!   impossible to judge apart.
//! - **No GPU.** Same CPU `image`/`imageproc` path `chroma::edit` already
//!   uses; the Colorist's wgpu pipeline runs *after* this, on the picture this
//!   produces.
//!
//! ## Resolution is by CLIP ID, falling back to path (D-306, was D-294)
//!
//! D-294 resolved by source path, because the decode session
//! (`chroma::state::Session`) was itself path-keyed and carried no clip
//! identity; it inherited D-070's documented limit — two clips sharing one
//! `source_path` collapse onto a single Colorist shot — and named this function
//! as "the single place that changes" when the session gained clip identity.
//! D-306 (B-150) is that change: a session shot now carries the
//! `apelles_timeline::Clip` id it *is*, so [`resolve_for`] looks the clip up by
//! id and two clips of one file resolve to their own picture, trim and
//! geometry.
//!
//! [`resolve`]'s path-only lookup remains for the shots that genuinely have no
//! clip id (see below) and as the fallback when an id no longer matches
//! anything on the timeline — a clip deleted on the Edit tab between the
//! session read and this call, which the next resync prunes. Falling back
//! keeps the picture right for that one frame instead of dropping to raw
//! source; it cannot resurrect the old ambiguity, because a shot that HAS an
//! id only reaches the fallback once its clip is genuinely gone.
//!
//! An **Untitled** session (a loose clip via the file picker / MCP `open`) has
//! no project, no timeline and therefore no clip: both functions return `None`
//! and every caller falls back to the raw-source behaviour that was correct
//! for that case all along.

use std::path::Path;

use apelles_timeline::{Clip, TrackKind};
use image::DynamicImage;

use super::edit;
use super::state::Shot;

/// The Edit-timeline clip the Colorist is grading, resolved against the open
/// project's active timeline, plus the two numbers its picture depends on.
#[derive(Debug, Clone)]
pub struct ClipView {
    pub clip: Clip,
    /// the active timeline's own timebase — what `clip.start_frame` /
    /// `clip.duration` are counted in
    pub fps: f64,
    /// the project's composition size in pixels ([`edit::composition_size`]) —
    /// the canvas every clip's geometry is measured against (D-136)
    pub comp: (u32, u32),
}

impl ClipView {
    /// How many frames the Colorist transport should offer for this shot: the
    /// clip's own length on the timeline, **not** the source file's.
    ///
    /// This is half of B-147 — the reported length was the whole source file
    /// (2990 frames for a clip trimmed to a few hundred), so the Colorist
    /// transport scrubbed straight past the clip's out-point into footage the
    /// Edit tab and the export never show.
    pub fn frame_count(&self) -> u64 {
        self.clip.duration.max(0) as u64
    }

    /// The **source** frame a clip-local frame decodes from.
    ///
    /// `Clip::clamped_source_frame_at` is the same mapping
    /// `apelles_timeline::Track::clip_at` gives the Edit preview and the
    /// exporter, so a trimmed, speed-ramped or differently-rated clip resolves
    /// identically in all three engines rather than through a fourth,
    /// hand-rolled `source_start + n` (which is exactly B-079).
    pub fn source_frame(&self, clip_frame: u64) -> u64 {
        let local = clip_frame.min(self.frame_count().saturating_sub(1)) as i64;
        self.clip
            .clamped_source_frame_at(self.clip.start_frame + local, self.fps)
            .max(0) as u64
    }

    /// This clip's geometry, resolved at `source_frame` and with the
    /// compositing-only fields neutralised — see the module doc for why
    /// opacity/fade are deliberately not carried here.
    fn geometry_at(&self, source_frame: u64) -> edit::ClipTransform {
        edit::resolve_clip_transform_unfaded(&self.clip, source_frame as i64).without_blend()
    }

    /// Place `img` (this clip's decoded source frame) into composition space,
    /// applying the clip's crop / scale / rotation / position — the picture the
    /// Edit tab's preview and the ffmpeg export both show for this frame.
    ///
    /// `max_long_edge` caps the canvas the same way
    /// `chroma::edit::composite_video_frame` does, so the Colorist's own
    /// playback-resolution knob (D-031) keeps meaning "render quality" and
    /// nothing else: every geometry field is a ratio of the composition, so
    /// the framing is identical at every cap.
    ///
    /// **Returns `img` untouched when the clip's transform is the identity AND
    /// its source already fills the composition** — the same two-part fast
    /// path `timeline_frame` takes (D-132/D-136), for the same reason. That is
    /// the overwhelmingly common case (an untransformed clip in a project whose
    /// output spec came from it), and it must stay byte-identical and free:
    /// this runs on every scrub and every playback frame.
    pub fn apply_geometry(
        &self,
        source_frame: u64,
        img: DynamicImage,
        max_long_edge: Option<u32>,
    ) -> Result<DynamicImage, String> {
        let (comp_w, comp_h) = self.comp;
        if comp_w == 0 || comp_h == 0 {
            return Ok(img);
        }
        let info = edit::probe_cached(Path::new(&self.clip.source_path))?;
        let t = self.geometry_at(source_frame);
        if t.is_identity() && (info.resolution.width, info.resolution.height) == self.comp {
            return Ok(img);
        }

        let (canvas_w, canvas_h) = max_long_edge
            .and_then(|le| super::decode_pipe::scale_target(comp_w, comp_h, le))
            .unwrap_or((comp_w, comp_h));
        // One uniform ratio from the width, exactly as `composite_video_frame`
        // derives it — deriving x and y independently would let
        // `scale_target`'s even-dimension rounding become a visible
        // anisotropic squash.
        let render_scale = canvas_w as f64 / comp_w as f64;
        // D-344 — `corner_radius` is authored in OUTPUT-composition pixels, so
        // it is converted into this canvas's pixels here, the same way (and
        // from the same ratio) `natural` below is. Every other field on the
        // transform is a ratio and needs no such step; see
        // `edit::ClipTransform::scaled_to_render`.
        let t = t.scaled_to_render(render_scale);
        let natural = (
            info.resolution.width as f64 * render_scale,
            info.resolution.height as f64 * render_scale,
        );

        let mut canvas: image::RgbaImage =
            image::ImageBuffer::from_pixel(canvas_w, canvas_h, image::Rgba([0, 0, 0, 255]));
        edit::composite_layer_onto(&mut canvas, &img.to_rgba8(), &t, natural);
        Ok(DynamicImage::ImageRgba8(canvas))
    }
}

/// Maps a transport-space `frame` to `(clamped, source_frame)`: clip-local
/// against `view`'s own length when a clip resolves, else the raw source's
/// `source_frame_count`. Every call site that decodes a Colorist picture needs
/// this pair before it can call [`ClipView::apply_geometry`].
///
/// **B-158** — pulled out after a second call site
/// (`chroma::session::decode_and_install`) re-derived this mapping by hand and
/// simply omitted the clip branch (no [`resolve_for`] call, no
/// `apply_geometry` at all), so a shot switch on a rotated/trimmed clip showed
/// the raw, un-rotated source until the next `chroma_seek` scrub silently
/// fixed it back up. One function now backs both `chroma_seek`
/// ([`super::commands::seek_and_install`]) and `decode_and_install`, so a
/// third call site cannot forget the clip branch the way this one did.
pub fn frame_mapping(view: Option<&ClipView>, frame: u64, source_frame_count: u64) -> (u64, u64) {
    let clamped = match view {
        Some(v) => frame.min(v.frame_count().saturating_sub(1)),
        None => frame.min(source_frame_count.saturating_sub(1)),
    };
    let decode_frame_index = match view {
        Some(v) => v.source_frame(clamped),
        None => clamped,
    };
    (clamped, decode_frame_index)
}

/// The clip the Colorist is grading when its active shot's source file is
/// `source_path`, or `None` when there is no clip to speak of — no project
/// open (an Untitled loose-clip session), no active timeline, no video track,
/// or nothing on it referencing this file.
///
/// Reads the manifest fresh on every call rather than caching: an Inspector
/// transform edit or a trim on the Edit tab has to reach the Colorist preview
/// on the next frame, and `apelles_project::timeline::resolve_timeline_and_settings`
/// is the same per-frame read `chroma_timeline_frame` already makes (it is
/// memoised on the manifest's own mtime — see `apelles-project`'s
/// `manifest.rs`).
///
/// **First matching clip in track order wins** when several reference the same
/// file — an ambiguity inherent to addressing a clip by the file it reads.
/// [`resolve_for`] is the identity-addressed entry point every caller with a
/// session shot in hand should use instead (D-306); this one is for the shots
/// that have no clip id at all.
pub fn resolve(source_path: &Path) -> Option<ClipView> {
    let (timeline, settings) = edit::resolve_timeline_and_settings(false).ok()?;
    let clip = timeline
        .tracks
        .iter()
        .filter(|t| t.kind == TrackKind::Video)
        .flat_map(|t| t.clips.iter())
        .find(|c| !c.source_path.is_empty() && Path::new(&c.source_path) == source_path)?;
    view_of(clip, &timeline, &settings)
}

/// The clip a session **shot** is, resolved by its own [`ShotId`] (D-306,
/// B-150) — by clip id when the shot has one, by source path when it does not.
///
/// This is what makes two Edit-timeline clips of one source file two
/// independently viewable, independently gradeable Colorist shots: each
/// resolves to *its* clip's trim, speed ramp and geometry, not to whichever of
/// the two happened to sit earlier in track order.
///
/// A clip id that matches nothing on the timeline falls back to the path lookup
/// — see the module doc for why that is right rather than a silent
/// re-introduction of the old ambiguity.
pub fn resolve_for(shot: &Shot) -> Option<ClipView> {
    let Some(clip_id) = shot.clip_id.as_deref() else {
        return resolve(&shot.path);
    };
    let (timeline, settings) = edit::resolve_timeline_and_settings(false).ok()?;
    let found = timeline
        .tracks
        .iter()
        .filter(|t| t.kind == TrackKind::Video)
        .flat_map(|t| t.clips.iter())
        .find(|c| c.id == clip_id);
    match found {
        Some(clip) => view_of(clip, &timeline, &settings),
        None => {
            log::debug!(
                "[chroma::colorist_view] clip {clip_id} is no longer on the active timeline — \
                 falling back to a source-path match until the next resync prunes it"
            );
            resolve(&shot.path)
        }
    }
}

/// The shared tail of both lookups: reject a zero-length clip, resolve the
/// composition size, and package the two numbers the picture depends on.
fn view_of(
    clip: &Clip,
    timeline: &apelles_timeline::Timeline,
    settings: &super::project::ProjectSettings,
) -> Option<ClipView> {
    if clip.duration <= 0 {
        return None;
    }
    let comp = edit::composition_size(settings, timeline).ok()?;
    Some(ClipView {
        clip: clip.clone(),
        fps: timeline.fps(),
        comp,
    })
}

/// The `(resolution, frame_count, duration_secs)` a shot at `source_path`
/// should be DISPLAYED as: clip-local when it resolves to an Edit-timeline
/// clip ([`resolve`]), else the raw source's own probe (`info`) — the same
/// choice [`ClipView::frame_count`] documents, shared so every surface that
/// reports a shot's length agrees with what the transport actually scrubs.
///
/// **B-154** — D-294 gave this correction to `chroma_video_info` alone, but
/// `chroma::session`'s `ShotDto` (`chroma_session_list`/`_add`/`_set_active`/
/// `_remove` — what the ShotStrip and every shot-switch actually populate the
/// Colorist transport from) built straight off `Shot.info`, the raw source
/// probe, and never called [`resolve`] at all. That is the whole bug: the
/// Colorist's own main-preview decode was already clip-aware (`chroma_seek` /
/// `seek_and_install`), so playback correctly stopped at the real trim
/// boundary, while the transport bar's readout and scrub-range kept
/// advertising the source file's full length. Fixed by routing both call
/// sites through this one function instead of leaving a second, unfixed copy
/// of D-294's arithmetic in `session.rs`.
///
/// D-306: takes the whole [`Shot`], so the clip it reports against is resolved
/// by that shot's own identity ([`resolve_for`]). Taking a bare source path
/// could only ever find the FIRST clip reading a file, so the two shots of a
/// doubled source would have advertised one trim between them.
pub fn display_info(shot: &Shot) -> (apelles_types::Resolution, u64, f64) {
    display_info_for(resolve_for(shot).as_ref(), &shot.info)
}

/// The pure half of [`display_info`], split out so a test can supply an
/// already-built [`ClipView`] directly rather than needing a real open
/// project on disk for [`resolve`] to read.
fn display_info_for(
    view: Option<&ClipView>,
    info: &super::video::VideoInfo,
) -> (apelles_types::Resolution, u64, f64) {
    let (resolution, frame_count) = match view {
        Some(v) => (
            apelles_types::Resolution {
                width: v.comp.0,
                height: v.comp.1,
            },
            v.frame_count(),
        ),
        None => (info.resolution, info.frame_count),
    };
    let fps = info.fps();
    let duration_secs = if fps > 0.0 {
        frame_count as f64 / fps
    } else {
        info.duration_secs
    };
    (resolution, frame_count, duration_secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clip(source_start: i64, start_frame: i64, duration: i64) -> Clip {
        Clip {
            id: "c1".into(),
            source_path: "/tmp/a.mov".into(),
            source_start,
            start_frame,
            duration,
            source_len: 3000,
            ..Default::default()
        }
    }

    fn view(c: Clip) -> ClipView {
        ClipView {
            clip: c,
            fps: 30.0,
            comp: (1920, 1080),
        }
    }

    #[test]
    fn frame_count_is_the_clips_length_not_the_sources() {
        // B-147's own reproduction, in one assertion: a 3000-frame source
        // trimmed to 400 frames must offer the Colorist 400 frames.
        let v = view(clip(500, 0, 400));
        assert_eq!(v.frame_count(), 400);
    }

    #[test]
    fn clip_local_frame_zero_is_the_clips_in_point() {
        let v = view(clip(500, 120, 400));
        assert_eq!(v.source_frame(0), 500);
        assert_eq!(v.source_frame(10), 510);
    }

    #[test]
    fn a_clip_local_frame_past_the_out_point_clamps_to_the_last_one() {
        let v = view(clip(500, 0, 400));
        assert_eq!(v.source_frame(9_999), v.source_frame(399));
    }

    #[test]
    fn geometry_drops_opacity_but_keeps_rotation() {
        // The Colorist canvas has no layers beneath it, so a half-opaque clip
        // must still be graded against its full picture — while its rotation
        // (B-147's actual symptom: the owner's 180-degree-corrected footage
        // showing upside down in Colorist) must be applied.
        let mut c = clip(0, 0, 100);
        c.opacity = 0.5;
        c.rotation = 180.0;
        let t = view(c).geometry_at(0);
        // `is_identity()` requires `opacity >= 1.0`, so a transform that still
        // carried the clip's 0.5 could not report the rotation as the only
        // difference — the second assertion is what pins both facts.
        assert!(!t.is_identity());
        let mut plain = clip(0, 0, 100);
        plain.opacity = 0.5;
        assert!(
            view(plain).geometry_at(0).is_identity(),
            "opacity alone must not survive into the Colorist's geometry"
        );
    }

    #[test]
    fn an_untransformed_clip_is_still_the_identity() {
        let t = view(clip(0, 0, 100)).geometry_at(0);
        assert!(t.is_identity());
    }

    fn raw_source_info(frame_count: u64, fps: u32) -> super::super::video::VideoInfo {
        super::super::video::VideoInfo {
            resolution: apelles_types::Resolution::new(3840, 2160),
            fps_num: fps,
            fps_den: 1,
            duration_secs: frame_count as f64 / fps as f64,
            frame_count,
            codec: "hevc".into(),
            pix_fmt: "yuv420p".into(),
            color_primaries: String::new(),
            color_transfer: String::new(),
            color_space: String::new(),
            has_audio: false,
            audio_sample_rate: 0,
            audio_channels: 0,
        }
    }

    #[test]
    fn display_info_reports_the_clips_length_not_the_sources_b154() {
        // B-154's own repro numbers: a source probed at 2990 frames / 30fps
        // (~99.7s — the bug report's real clip ran ~2:04.6 at its own fps,
        // the exact fps doesn't matter to this assertion) backing a clip
        // trimmed to 1380 frames on the timeline. The transport bar must
        // report the clip's 1380, not the source's 2990.
        let info = raw_source_info(2990, 30);
        let v = view(clip(131, 0, 1380));
        let (resolution, frame_count, duration_secs) = display_info_for(Some(&v), &info);
        assert_eq!(frame_count, 1380);
        assert_eq!(resolution, apelles_types::Resolution::new(1920, 1080)); // `view()`'s comp
        assert!((duration_secs - 1380.0 / 30.0).abs() < 1e-9);
    }

    #[test]
    fn frame_mapping_with_a_resolved_clip_goes_through_its_trim_b158() {
        // B-158's own repro: a clip trimmed in 131 frames, at clip-local frame
        // 0, must decode source frame 131 — the exact mapping `chroma_seek`
        // already applied and `decode_and_install` used to skip entirely.
        let v = view(clip(131, 0, 1380));
        let (clamped, source_frame) = frame_mapping(Some(&v), 0, 2990);
        assert_eq!(clamped, 0);
        assert_eq!(source_frame, 131);
    }

    #[test]
    fn frame_mapping_clamps_to_the_clips_own_length_not_the_sources() {
        let v = view(clip(131, 0, 1380));
        let (clamped, _) = frame_mapping(Some(&v), 9_999, 2990);
        assert_eq!(clamped, 1379); // the clip's last frame, not the source's
    }

    #[test]
    fn frame_mapping_with_no_resolved_clip_passes_the_frame_through() {
        // An Untitled loose-clip session: no clip resolves, so the frame is a
        // raw source index clamped to the source's own length.
        let (clamped, source_frame) = frame_mapping(None, 50, 2990);
        assert_eq!(clamped, 50);
        assert_eq!(source_frame, 50);
    }

    #[test]
    fn display_info_falls_back_to_the_raw_source_with_no_resolved_clip() {
        // An Untitled loose-clip session (no project, so `resolve` finds no
        // clip) must report the source exactly as before D-294/B-154 — this
        // is the branch every non-project shot always takes.
        let info = raw_source_info(2990, 30);
        let (resolution, frame_count, duration_secs) = display_info_for(None, &info);
        assert_eq!(frame_count, 2990);
        assert_eq!(resolution, info.resolution);
        assert!((duration_secs - 2990.0 / 30.0).abs() < 1e-9);
    }
}
