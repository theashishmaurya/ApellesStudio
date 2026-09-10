//! **colorist_view.rs — the Colorist ⇄ Edit *picture* bridge** (D-291, B-147).
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
//!   transport counts in after D-291) to the **source** frame to decode,
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
//! ## Why resolution is by PATH, not by clip id (D-291)
//!
//! The decode session (`chroma::state::Session`) is keyed by source path and
//! carries no clip identity — D-070 chose that deliberately and recorded the
//! one limit it costs: two different clips sharing one `source_path` collapse
//! onto a single Colorist shot, so only one of them is viewable at a time.
//! Resolving here by path inherits exactly that limit and adds no new state to
//! keep in sync; carrying a clip id in the session instead would mean a second
//! identity that can go stale against the timeline (the failure mode B-083 and
//! B-034 both are), for a case the session cannot represent anyway. When the
//! decode session is finally retired in favour of clip identity, this function
//! is the single place that changes.
//!
//! An **Untitled** session (a loose clip via the file picker / MCP `open`) has
//! no project, no timeline and therefore no clip: [`resolve`] returns `None`
//! and every caller falls back to the raw-source behaviour that was correct
//! for that case all along.

use std::path::Path;

use apelles_timeline::{Clip, TrackKind};
use image::DynamicImage;

use super::edit;

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
/// file. See the module doc: that is D-070's already-documented "two clips
/// sharing a source path collapse onto one Colorist shot" limit, restated
/// deterministically rather than a new ambiguity introduced here.
pub fn resolve(source_path: &Path) -> Option<ClipView> {
    let (timeline, settings) = edit::resolve_timeline_and_settings(false).ok()?;
    let clip = timeline
        .tracks
        .iter()
        .filter(|t| t.kind == TrackKind::Video)
        .flat_map(|t| t.clips.iter())
        .find(|c| !c.source_path.is_empty() && Path::new(&c.source_path) == source_path)?;
    if clip.duration <= 0 {
        return None;
    }
    let comp = edit::composition_size(&settings, &timeline).ok()?;
    Some(ClipView {
        clip: clip.clone(),
        fps: timeline.fps(),
        comp,
    })
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
}
