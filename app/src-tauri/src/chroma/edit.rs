//! Editor tab bridge (D-041, multi-timeline D-045) — the `apelles-timeline`
//! model ⇄ the frontend.
//!
//! What it is: the Tauri command surface for the **Edit tab** — get / set the
//!   project's **active** [`Timeline`] (D-041 was single-video-track and
//!   singular; D-045 made a project hold several independently-editable named
//!   timelines, one active), list/create/switch timelines, and decode one
//!   timeline frame to **raw JPEG bytes** for the preview pane (D-217 — it was
//!   a `data:image/jpeg;base64,…` string until then).
//! What it does: `chroma_timeline_get` returns the active timeline (building a
//!   fresh one from the project's shots the first time — probing each source
//!   for a frame count here, `apelles-timeline` never touches media — and
//!   persisting it) or `chroma_timeline_set` replaces it; `chroma_timeline_list`
//!   /`chroma_timeline_create`/`chroma_timeline_set_active` manage the
//!   `timelines` list itself; `chroma_timeline_frame` resolves a timeline
//!   position on the active timeline to `(clip, source frame)` via
//!   [`apelles_timeline::Track::clip_at`] and decodes that source frame with the
//!   lightweight [`super::decode_pipe`] path (ffmpeg → rgb → JPEG);
//!   clips (including across tracks) on the active timeline;
//!   `resolve_audio_track_positions` (D-057, Phase C) is the audio-track
//!   counterpart of `resolve_video_position`, resolving every genuine
//!   `TrackKind::Audio` clip overlapping a position for `chroma::audio`'s
//!   mixer.
//! What it does NOT do: no `wgpu` — this module never opens a GPU device, and
//!   the editor preview stays independent of the Colorist's `AppState`/GPU
//!   render path. Still no transcript cut / OTIO export.
//!   **"No colour grade" is no longer true, as of D-256**, and the way it stopped
//!   being true is the point: a clip's saved Colorist grade
//!   (`<project>/grades/<clip.id>.grade.json`) reaches this compositor as a
//!   baked `apelles_types::Lut3d` — 3×33³ numbers that `chroma::grade_lut`
//!   produced by running an identity lattice through the Colorist's own wgpu
//!   pipeline once, memoised on the grade file's (mtime, len). So the grade
//!   maths still has exactly one implementation (the shader), this module still
//!   holds no GPU handle, and the ffmpeg exporter applies the very same lattice
//!   via `lut3d`. `composite_video_frame` applies it to each clip's decoded
//!   pixels before geometry; the single-layer fast path declines itself when a
//!   clip is graded, the same way D-132 made it decline a real transform. A 3D
//!   LUT is per-pixel, so the **spatial** half of a grade (masks/local layers,
//!   the Colorist crop, relight) is not carried — stripped at bake time with a
//!   logged warning, never silently.
//!   **Transitions ARE here as of D-226** (roadmap item 27,
//!   `docs/notes/transitions.md`): a `apelles_timeline::Transition` bridges a cut
//!   without the two clips ever overlapping, so
//!   `Timeline::resolve_visible_video_layers_at` can now hand this module TWO
//!   layers from one track (a cross dissolve's two clips, the incoming one
//!   carrying a real blend alpha) or a generated colour plate with no clip at
//!   all (a dip to colour). `composite_video_frame` grew one arm for the plate
//!   and one multiply (`with_transition_alpha`) for the blend; everything else
//!   about the compositor — paint order, geometry, the fade/opacity
//!   composition — is unchanged. The second clip decodes through its own
//!   `PipeSlot::TrackTransition` slot, because two sources interleaved through
//!   one slot is exactly B-040's measured failure mode.
//!   `resolve_video_position` (used by Colorist's active-clip resolution and
//!   the embedded-audio baseline, `chroma::audio` — genuinely single-clip
//!   concerns, unchanged) resolves **N video tracks under opaque, top-wins
//!   selection** (D-056, Phase B1) — video tracks in index order, first one
//!   with a clip (not a gap) at the position wins, via
//!   `apelles_timeline::Timeline::resolve_video_clip_at`. `chroma_timeline_frame`
//!   itself (D-088, Phase 2/B3) is a DIFFERENT, real story now: real CPU
//!   pixel-level compositing IS here, for the multi-track preview
//!   specifically — `Timeline::resolve_visible_video_layers_at` resolves
//!   every visible video layer at a position, and `composite_video_frame`
//!   alpha-blends them (opacity/position/scale/rotation, keyframeable via
//!   the existing D-034 engine) when there's more than one; the
//!   exactly-one-layer case still takes the old plain-decode fast path,
//!   byte-identical to before. Audio mixing across `TrackKind::Audio` tracks
//!   is real too (D-057, `chroma::audio`'s mixer) — this module just
//!   resolves *which* clips are active, the actual decode/mix/output lives in
//!   `chroma::audio`. No timeline-switcher UI yet (D-045 pass 2 is model +
//!   commands only; "active timeline" is a Rust-side concept the frontend
//!   doesn't need to know about for the existing single-timeline Edit tab to
//!   keep working) — pass 3.
//!
//! The timelines are persisted **inside the `.chroma` project**:
//!   `ProjectManifest.timelines: Vec<Timeline>` + `active_timeline: usize`
//!   (additive, `#[serde(default)]`, schema major unchanged — same move D-038
//!   made for `settings`). `project::load_manifest` losslessly migrates a
//!   legacy singular `timeline` key (D-041's shape) into a one-element
//!   `timelines` list — see the D-045 decision.
//!
//! Fork hygiene (D-003): all new code here + in `apelles-timeline`; the only
//!   `project.rs` edit is the `timelines`/`active_timeline` fields. Upstream
//!   footprint is `pub mod edit;` in `chroma/mod.rs` + the `generate_handler!`
//!   lines in `lib.rs`. Divergence logged in `docs/09-engine-notes.md`.

use std::collections::HashMap;
use std::io::Cursor;
use std::path::{Path, PathBuf};

use image::DynamicImage;
use image::codecs::jpeg::JpegEncoder;
use serde::Serialize;

use apelles_timeline::{Clip, LayerRole, LayerSource, Timeline, TrackKind, VisibleLayer};

#[cfg(test)]
use super::highlight_draw::apply_highlights_to_rgba;
use super::highlight_draw::highlighted_picture;
use super::state;
use super::video::VideoInfo;
use super::{caption_render, decode_pipe, grade_lut, project, text};

// --------------------------------------------------------------------------- //
// per-clip probe cache — moved out of this file into `apelles-media` (D-146,
// `docs/notes/crate-extraction-plan.md` §2.2). It was never an Edit-tab
// concern: its consumers are `filmstrip`, `audio`, `project` and `load`, and
// leaving it here would have made `apelles-media` depend on `app/src-tauri`, a
// cycle. B-056 (the in-memory layer never invalidated, so a source file
// replaced in place served a stale `VideoInfo` for the rest of the session)
// was fixed in the same move — see `apelles_media::probe`'s module doc.
//
// Re-exported at the old path so the ~15 `probe_cached(..)` call sites in this
// file, and `super::edit::probe_cached` in `audio.rs`/`filmstrip.rs`/
// `load.rs`/`project.rs`, did not change.
// --------------------------------------------------------------------------- //

pub(crate) use apelles_media::probe::probe_cached;

// --------------------------------------------------------------------------- //
// D-351 — the compositor's per-pixel passes, across the machine's cores.
//
// Measured first, not assumed: a headless export of the 20-clip/1080p stress
// fixture spent **66.7% of its wall time compositing and 33.3% decoding**
// (33.16 s for 240 frames, 7.2 fps), with every one of those composite passes
// running on ONE thread while the other nine sat idle — which is exactly the
// "~22% CPU on a 10-core machine" the owner saw on the real project. See
// `docs/notes/export-gpu-compositor.md` §9.
//
// Every pass parallelised here writes each output pixel from inputs it does not
// itself write, so splitting the work by ROW is not an approximation: each
// pixel's arithmetic is the identical expression it was before, evaluated in an
// unspecified thread order that cannot reach it. That is what keeps CLAUDE.md's
// "same doc + same frame ⇒ identical pixels" invariant true by construction
// rather than by hoping — `rendering_the_same_frame_twice_produces_identical_
// bytes` and the old-vs-new pixel-parity test both still pass unchanged, and
// `parallel_row_passes_match_their_serial_form` asserts the equivalence
// directly on the two hot loops.
//
// What is NOT parallelised here, deliberately: `image::imageops::resize`. It is
// the library's own separable two-pass filter, and splitting it by output band
// would need an input halo whose weight normalisation `image` does not expose —
// a hand-rolled "identical" resize is exactly the kind of thing CLAUDE.md says
// to reach for a library for, not to re-derive. It is parallelised ACROSS
// layers instead (`prepare_layer_paint`), and remains this path's largest
// single-threaded term; see the design note for what closes it.
// --------------------------------------------------------------------------- //

/// Below this many pixels a pass runs serially — and the number is **not** a
/// rayon split-overhead threshold, which is what it looks like. It is the line
/// between the LIVE PREVIEW's frames and an EXPORT's, and it is there because
/// those two want opposite things from the CPU.
///
/// **Measured, not assumed** (this was a real regression, caught by an existing
/// test before it shipped). Parallelising the compositor at preview sizes made
/// `playback_primes_the_upcoming_cut_and_a_scrub_does_not` fail: the compositor
/// taking every core slows the `ffmpeg` decode CHILD it is competing with, which
/// inflates `decode_pipe::record_seek_cost`'s measured EWMA, which widens
/// `prefetch_lead_secs`, which primes more standby pipes than that test's
/// fixture expects. Nothing there is wrong arithmetic — it is D-330's scheduler
/// correctly reacting to a genuinely slower seek — but it is the export's
/// optimisation reaching into live playback and changing how it schedules
/// decoders, which is precisely the trade CLAUDE.md says not to make
/// ("performance, then stability" is about the UI feeling snappy; a preview that
/// starves its own decoder to compositing threads is the opposite).
///
/// So: an export composites on every core, and the preview composites exactly as
/// it did before this change, byte for byte and thread for thread.
///
/// **Why this value separates them exactly.** `PreviewPane.tsx`'s
/// `PREVIEW_LONG_EDGE` is 960, and the preview is the only caller that caps the
/// canvas that way — so the largest frame live playback can ever composite is
/// 960×960, i.e. 921,600 px, even for a square composition. The smallest frame a
/// real export composites is 1920×1080, i.e. 2,073,600 px. 1024² sits between
/// them with room on both sides, so this is a boundary between two callers
/// rather than a tuned constant. (A deliberately tiny export — the 640×360
/// parity fixture — therefore composites serially, which is correct: it is
/// smaller than a preview frame.)
const PARALLEL_PIXEL_MIN: u64 = 1024 * 1024;

/// Run `f(y, row)` over every row of `buf`, in parallel when there is enough
/// work to pay for it. `stride` is one row in bytes; `buf.len()` must be a whole
/// number of rows.
///
/// The serial arm is not a fallback for correctness — both arms run the same
/// closure over the same disjoint rows — it is purely the small-image case.
pub(super) fn for_each_row_mut(
    buf: &mut [u8],
    stride: usize,
    f: impl Fn(usize, &mut [u8]) + Send + Sync,
) {
    debug_assert!(stride > 0 && buf.len().is_multiple_of(stride));
    if (buf.len() / stride.max(1)) as u64 * (stride as u64 / 4) < PARALLEL_PIXEL_MIN {
        buf.chunks_mut(stride)
            .enumerate()
            .for_each(|(y, r)| f(y, r));
    } else {
        use rayon::prelude::*;
        buf.par_chunks_mut(stride)
            .enumerate()
            .for_each(|(y, r)| f(y, r));
    }
}

/// `DynamicImage::to_rgba8`, but the 8-bit-RGB case — which is every frame
/// `decode_pipe` produces — converts across cores instead of on one.
///
/// A 4K frame is 8.3 M pixels; at two video layers a frame that is ~16 M
/// channel-widening writes per frame charged to a single thread for no reason.
/// Every other variant defers to `image`'s own conversion, unchanged.
fn to_rgba8_parallel(img: DynamicImage) -> image::RgbaImage {
    let DynamicImage::ImageRgb8(src) = img else {
        return img.to_rgba8();
    };
    let (w, h) = src.dimensions();
    let mut out: image::RgbaImage = image::ImageBuffer::new(w, h);
    let src_raw = src.as_raw();
    let src_stride = w as usize * 3;
    let dst_stride = w as usize * 4;
    for_each_row_mut(out.as_mut(), dst_stride, |y, row| {
        let s = &src_raw[y * src_stride..y * src_stride + src_stride];
        for (d, p) in row
            .as_chunks_mut::<4>()
            .0
            .iter_mut()
            .zip(s.as_chunks::<3>().0)
        {
            *d = [p[0], p[1], p[2], 255];
        }
    });
    out
}

/// `image::imageops::overlay`, across cores.
///
/// Deliberately a re-spelling of that function's own body rather than a new
/// blend model: it is `dst.blend(&src)` over the intersection of the two
/// images, which is a dozen lines and is the ONLY thing standing between this
/// pass and the row split. The alternative — keeping `image`'s serial call —
/// leaves a full-canvas alpha blend per layer per frame on one thread.
/// `overlay_parallel_matches_the_image_crate` asserts the two produce identical
/// buffers, so this cannot drift from the library it mirrors.
fn overlay_parallel(canvas: &mut image::RgbaImage, top: &image::RgbaImage, ox: i64, oy: i64) {
    use image::Pixel as _;
    let (cw, ch) = canvas.dimensions();
    let (tw, th) = top.dimensions();
    let x0 = ox.max(0);
    let y0 = oy.max(0);
    let x1 = (ox + tw as i64).min(cw as i64);
    let y1 = (oy + th as i64).min(ch as i64);
    if x1 <= x0 || y1 <= y0 {
        return;
    }
    let stride = cw as usize * 4;
    let t_stride = tw as usize * 4;
    let t_raw = top.as_raw();
    let band = &mut canvas.as_mut()[y0 as usize * stride..y1 as usize * stride];
    for_each_row_mut(band, stride, |ri, row| {
        let py = y0 + ri as i64;
        let t_row = (py - oy) as usize * t_stride;
        for px in x0..x1 {
            let to = t_row + (px - ox) as usize * 4;
            let src = image::Rgba([t_raw[to], t_raw[to + 1], t_raw[to + 2], t_raw[to + 3]]);
            let o = px as usize * 4;
            image::Rgba::from_slice_mut(&mut row[o..o + 4]).blend(&src);
        }
    });
}

// --------------------------------------------------------------------------- //
// D-292 — a clip's source may be a STILL IMAGE, not just moving footage.
//
// The two questions the preview asks of every picture layer — "how big is this
// source?" and "give me its picture at this frame" — each get one answer here
// that covers both kinds, so the compositor, the single-layer fast path, the
// composition-size derivation and the transform overlay's geometry all branch
// in exactly one place instead of four.
//
// A still deliberately does NOT go through `decode_pipe`: there is no stream to
// step through, no keyframe to seek to and no `ffmpeg` process to hold open. It
// also never holds a `PipeSlot` (see `layer_pipe_slot`), so a still layer costs
// the pipe pool nothing at all.
// --------------------------------------------------------------------------- //

/// The pixel dimensions of `clip`'s source — a still through
/// `apelles_media::still`, moving footage through [`probe_cached`].
fn clip_source_size(source_path: &str) -> Result<(u32, u32), String> {
    let res = apelles_media::probe::source_resolution(Path::new(source_path))?;
    if res.width == 0 || res.height == 0 {
        return Err(format!("{source_path} has no usable resolution"));
    }
    Ok((res.width, res.height))
}

/// The decoded size a layer of `source_size` should be asked for at this
/// preview quality — [`decode_pipe::scale_target`], shared by the two decoders
/// below so a still and a video layer of the same source size always arrive at
/// the same pixel dimensions.
fn decode_scale(source_size: (u32, u32), max_long_edge: Option<u32>) -> Option<(u32, u32)> {
    max_long_edge.and_then(|le| decode_pipe::scale_target(source_size.0, source_size.1, le))
}

/// **A still ignores `source_frame` entirely, and that is the whole feature:**
/// every frame of a still clip's on-timeline duration is the same picture, so
/// the resolved source frame — which the timeline computes for a still exactly
/// as it does for footage, since nothing downstream should have to care — is
/// simply not consulted. That is what makes a still hold for its full length
/// instead of the compositor trying to frame-step a codec stream that has one
/// frame in it. (Stated once here; it is equally true of
/// [`decode_clip_picture`] below.)
///
/// **The compositor's variant: RGBA, shared where it can be.** A still's
/// buffer comes straight back from `apelles_media::still`'s decode cache as the
/// `Arc` that cache holds, with no copy at all — which is the point of the
/// `Arc` in `Step::Paint`, and the same zero-copy path a rasterised text layer
/// already takes. A video frame is converted once, exactly as it was before
/// D-292.
fn decode_clip_rgba(
    source_path: &str,
    source_size: (u32, u32),
    lane: decode_pipe::PipeLane,
    slot: decode_pipe::PipeSlot,
    source_frame: u64,
    max_long_edge: Option<u32>,
) -> Result<std::sync::Arc<image::RgbaImage>, String> {
    let path = PathBuf::from(source_path);
    let scale = decode_scale(source_size, max_long_edge);
    if apelles_media::still::is_image_file(&path) {
        return apelles_media::still::decode_scaled(&path, scale)
            .map_err(|e| format!("decode still {source_path}: {e}"));
    }
    let info = probe_cached(&path)?;
    decode_pipe::playback_frame_scaled(lane, slot, &path, &info, source_frame, scale)
        .map(|img| std::sync::Arc::new(to_rgba8_parallel(img)))
        .map_err(|e| format!("decode {source_path} @ src frame {source_frame}: {e}"))
}

/// **The single-layer fast path's variant: the picture as it decodes.**
///
/// A separate function from [`decode_clip_rgba`] rather than a wrapper over it,
/// deliberately: this frame goes straight to `encode_preview_jpeg`, so forcing
/// a decoded video frame through RGBA on the way would add a full-buffer
/// conversion per frame to the path that exists precisely to avoid work. The
/// still arm pays one copy here (its cached buffer is shared and a
/// `DynamicImage` must own its pixels) — the trade the other way round, and the
/// right one for each caller.
fn decode_clip_picture(
    source_path: &str,
    source_size: (u32, u32),
    lane: decode_pipe::PipeLane,
    slot: decode_pipe::PipeSlot,
    source_frame: u64,
    max_long_edge: Option<u32>,
) -> Result<DynamicImage, String> {
    let path = PathBuf::from(source_path);
    let scale = decode_scale(source_size, max_long_edge);
    if apelles_media::still::is_image_file(&path) {
        return apelles_media::still::decode_scaled(&path, scale)
            .map(|img| DynamicImage::ImageRgba8(img.as_ref().clone()))
            .map_err(|e| format!("decode still {source_path}: {e}"));
    }
    let info = probe_cached(&path)?;
    decode_pipe::playback_frame_scaled(lane, slot, &path, &info, source_frame, scale)
        .map_err(|e| format!("decode {source_path} @ src frame {source_frame}: {e}"))
}

// --------------------------------------------------------------------------- //
// timeline load / build / persist
// --------------------------------------------------------------------------- //

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn current_project_dir() -> Result<PathBuf, String> {
    state::current_project()
        .map(|p| p.path)
        .ok_or_else(|| "no project open — open one in the Colorist tab".to_string())
}

// --------------------------------------------------------------------------- //
// timeline lifecycle — moved out of this file into `apelles-project` (D-148,
// `docs/notes/crate-extraction-plan.md` §2.3). `build_from_shots`,
// `ensure_timeline`, `load_and_ensure_timeline`, `resolve_timeline` and
// `resolve_timeline_and_settings` were never Edit-tab concerns: they read
// `manifest.shots`, call `project::resolve_shot` / `project::save_manifest`,
// and their non-Edit callers are `chroma::project`'s own `open_manifest`,
// `chroma_project_resync_clips`, `chroma_project_add_shot_paths` and
// `chroma_project_remove_clip`.
//
// What genuinely stays here is the *process global* — which project is
// currently open — because that is `chroma::state`, app-layer by design. So
// the crate's functions take the project directory as an argument and these
// wrappers supply it: the same "the crate takes the fact, the app looks it
// up" shape D-145 gave `tracked_depth_map`. Every call site below is
// unchanged.
// --------------------------------------------------------------------------- //

/// A pure pass-through, not a wrapper — the crate function already took the
/// project directory explicitly. `chroma::project` calls it at this path too;
/// see `apelles_project::timeline`'s module doc for why it is not an Edit-tab
/// concern despite having lived here since D-041.
pub(crate) use apelles_project::timeline::ensure_timeline;

/// Load the **open** project's manifest with `timelines` guaranteed non-empty
/// and `active_timeline` valid. Returns the directory alongside it because
/// most callers here go on to `project::save_manifest(&dir, ..)`.
fn load_and_ensure_timeline(persist: bool) -> Result<(PathBuf, project::ProjectManifest), String> {
    let dir = current_project_dir()?;
    let manifest = apelles_project::timeline::load_and_ensure_timeline(&dir, persist)?;
    Ok((dir, manifest))
}

/// The **open** project's active timeline (D-045) — its persisted one, or a
/// fresh build from its shots the first time. `pub(crate)` (D-056): also how
/// `chroma::audio`'s mixer enumerates every genuine `TrackKind::Audio` track
/// on the active timeline (`resolve_audio_track_positions`, below).
pub(crate) fn resolve_timeline(persist: bool) -> Result<Timeline, String> {
    apelles_project::timeline::resolve_timeline(&current_project_dir()?, persist)
}

/// [`resolve_timeline`] plus the project's output spec (D-038) — the pair
/// [`timeline_frame`] needs, since D-136 made the compositor's canvas the
/// **composition** rather than the top layer's decoded size.
pub(crate) fn resolve_timeline_and_settings(
    persist: bool,
) -> Result<(Timeline, project::ProjectSettings), String> {
    apelles_project::timeline::resolve_timeline_and_settings(&current_project_dir()?, persist)
}

/// The **composition space** every clip's geometry is measured against
/// (D-136, Phase 0a of `docs/notes/on-canvas-transform.md`): the project's
/// recorded output resolution (D-038), or — for a project that never recorded
/// one — the probed resolution of the timeline's first **real video** clip,
/// which is exactly the clip [`project::infer_settings_from_clip`] would have
/// derived those settings from when a project is first created from footage.
///
/// **Deliberately independent of the playhead.** The pre-D-136 canvas *was*
/// playhead-dependent (it was whichever layer happened to be on top at that
/// position, at whatever size it happened to decode to), and that is half of
/// B-043: a value that means one thing at frame 100 and another at frame 400 is
/// not a coordinate space. Taking one clip gives one answer for the whole
/// timeline, for the preview and for [`chroma_timeline_clip_geometry`] alike,
/// so the overlay and the picture cannot disagree.
///
/// **B-152 — real video wins over a still, regardless of track order.** Plain
/// "first clip in Vec order" used to mean a still image (a `match_to_reference`
/// comparison photo, a title card) sitting on an earlier-indexed video track
/// than the real footage silently set the composition — and therefore every
/// export's — aspect ratio for the whole project, with real 4K camera footage
/// resampled to whatever the still happened to be. Fix option (a) from the bug
/// writeup: a still is a legitimate composition source (a slideshow project has
/// nothing else), so this walks every video track/clip once and returns the
/// **first clip that is real footage** if one exists anywhere on the timeline;
/// only when the timeline is images-only does it fall back to the first clip
/// of any kind, preserving that case exactly as before.
///
/// **B-276 — a project with no size at all is refused by name**
/// ([`NO_COMPOSITION_SIZE`]), telling the caller to set one, rather than with a
/// message that blamed clips. An export does not take this refusal: it has its
/// own requested size, see [`derived_composition_size`].
pub(super) fn composition_size(
    settings: &project::ProjectSettings,
    timeline: &Timeline,
) -> Result<(u32, u32), String> {
    derived_composition_size(settings, timeline)?.ok_or_else(|| NO_COMPOSITION_SIZE.to_string())
}

/// B-276 — why [`composition_size`] has nothing to answer with: no explicit
/// project size, and no footage or still on any video track to read one from.
pub(super) const NO_COMPOSITION_SIZE: &str = "this project has no frame size yet: its settings name no \
     width/height, and no video track holds footage or a still to take one from. Set one with \
     set_project_settings(width=..., height=...) (or the Edit tab's project settings), or put \
     footage or a still on a video track";

/// [`composition_size`]'s resolution, with "the project has no size" as
/// `Ok(None)` instead of an error, so a caller that has a size of its own can
/// stand it in.
///
/// **B-276 — the export is that caller.** `editor_export` always names an
/// output `width`/`height`, and the export compiler
/// (`compileEditorExportArgs` in `@apelles/editor`) already reads a sizeless
/// project's composition as exactly that output size. The compositor render
/// takes the same reading ([`super::edit_render::render_timeline`]), so the
/// two engines size every clip against the same composition, and a project
/// whose only content is audio (or that has not been given a size yet) still
/// exports. An `Err` is a real failure (a source that will not probe), never
/// "nothing to measure".
pub(super) fn derived_composition_size(
    settings: &project::ProjectSettings,
    timeline: &Timeline,
) -> Result<Option<(u32, u32)>, String> {
    if let (Some(w), Some(h)) = (settings.width, settings.height)
        && w > 0
        && h > 0
    {
        return Ok(Some((w, h)));
    }
    let mut first_any: Option<&Clip> = None;
    for clip in timeline
        .tracks
        .iter()
        .filter(|t| t.kind == TrackKind::Video)
        .flat_map(|t| t.clips.iter())
        .filter(|c| !c.source_path.is_empty())
    {
        if !apelles_media::still::is_image_file(&clip.source_path) {
            // Real footage always wins, wherever it sits in track order.
            return clip_source_size(&clip.source_path).map(Some);
        }
        if first_any.is_none() {
            first_any = Some(clip);
        }
    }
    let Some(first) = first_any else {
        return Ok(None);
    };
    // D-292 — `clip_source_size`, not `probe_cached`: the timeline may hold
    // only stills, and a project whose only source is a still must still be
    // able to say how big its composition is.
    clip_source_size(&first.source_path).map(Some)
}

/// Resolve timeline position `pos` on the **active** timeline to the single
/// winning clip under **opaque, top-track-wins** compositing (D-056, Phase B1
/// of `docs/notes/multi-track-nle.md`), the corresponding **source** frame,
/// and that clip's probed [`VideoInfo`] (D-049) — the shared first half of
/// both the video preview's [`chroma_timeline_frame`] and the audio path's
/// `audio::chroma_audio_play`: both read from the same clip at the same
/// position, one for pixels, one for samples.
///
/// The track-priority walk itself (video tracks in index order, first one
/// with a clip — not a gap — at `pos` wins) is
/// [`apelles_timeline::Timeline::resolve_video_clip_at`] — pure model logic,
/// no media involved, unit-tested at the `apelles-timeline` crate level. This
/// function is the thin media-layer wrapper around it: probe the winning
/// clip's source so the caller gets pixel dimensions/frame-rate too, which
/// `apelles-timeline` itself never touches.
///
/// `Ok(None)` when every video track has a gap at `pos` (or `pos` is
/// negative / past everything) or the winning clip's source path is
/// empty/offline — the same "just show/play nothing" case both callers
/// already handle, not an error. Still errors if the timeline has no video
/// track at all (distinct from "every video track has a gap here").
///
/// **D-149 — the winning track's own index comes back as the first element.**
/// `resolve_video_clip_at` has always computed it and this function threw it
/// away; the audio path now needs it to look up that track's ducking
/// configuration, and re-deriving "which video track won" at the call site
/// would mean a second copy of the top-wins walk that could drift from this
/// one. Same call as D-147 made for `resolve_audio_track_positions` below: hand
/// back what was already resolved rather than resolve it twice.
pub(crate) fn resolve_video_position(
    pos: u64,
) -> Result<Option<(usize, Clip, u64, VideoInfo)>, String> {
    let timeline = resolve_timeline(false)?;
    if !timeline.tracks.iter().any(|t| t.kind == TrackKind::Video) {
        return Err("timeline has no video track".to_string());
    }

    let Some((track_idx, clip, source_frame)) = timeline.resolve_video_clip_at(pos as i64) else {
        return Ok(None);
    };
    if clip.source_path.is_empty() {
        return Ok(None);
    }
    // D-292 — a STILL is not a source of samples. This function's only consumer
    // is `chroma::audio`'s embedded-audio baseline, and a still has no audio
    // stream to probe; `Ok(None)` is precisely the "play nothing here" case
    // that consumer already handles for a gap or an offline source, so it needs
    // no still-specific branch of its own.
    if apelles_media::still::is_image_file(&clip.source_path) {
        return Ok(None);
    }
    let info = probe_cached(Path::new(&clip.source_path))?;
    Ok(Some((
        track_idx,
        clip.clone(),
        source_frame.max(0) as u64,
        info,
    )))
}

/// Resolve every genuine `TrackKind::Audio` clip on the active timeline that
/// overlaps `pos` to `(the track index, the clip, its resolved SOURCE frame,
/// its probed VideoInfo, that track's gain)` — the Phase C (D-056) counterpart
/// of [`resolve_video_position`]'s single video-track lookup, feeding
/// `chroma::audio`'s mixer the extra sources to sum in alongside the baseline
/// video-embedded audio. Uses [`apelles_timeline::Track::clip_at`] exactly
/// like the video path — a track with nothing covering `pos` (a gap, or an
/// empty track) contributes nothing, silently, the same "not an error"
/// contract `resolve_video_position` already has. A clip whose source turns
/// out to have no audio stream is skipped the same way.
///
/// **D-147 — this returns the `Clip` + `VideoInfo` rather than D-057's
/// original `(path, start_secs, duration_secs, gain)` tuple**, and that is a
/// simplification, not an extension. The mixer needs the clip's fade fields
/// now, and it *already* derives `start_secs`/`duration_secs` from exactly
/// this pair for the embedded-audio baseline a few lines away in
/// `chroma_audio_play` — so returning the pair removes a duplicated piece of
/// seconds arithmetic instead of adding a fifth positional element to a tuple
/// that was already hard to read. It also keeps the module dependency
/// one-way: `chroma::audio` knows about `chroma::edit`, not the reverse, so
/// the mixer's own `FadeEnvelope` type stays in the mixer.
///
/// The clip's **out-point** (B-048) is the caller's `clip.end_frame_at(fps) -
/// pos`: `chroma::audio` streams each source until it runs out, so it has to
/// be told where the clip actually ends or it keeps playing the rest of the
/// file underneath whatever the timeline cut to next.
///
/// **D-149 — the track's own index comes back too**, as the first element. The
/// mixer needs it to look up that track's ducking configuration, and the index
/// is the only thing that identifies a track (there is no track id); deriving
/// it again at the call site would mean re-walking the same filtered list and
/// getting it subtly wrong the first time an empty audio track sits between
/// two populated ones. It is the *timeline* index, not the position within the
/// filtered audio-only subset — the same index `Track::duck_from` stores.
///
/// **B-079 — the resolved SOURCE frame is now returned too**, rather than
/// discarded (`let Some((clip, _source_frame))`, pre-fix). `Track::clip_at`
/// already computes this correctly, fps-converted via `Clip::source_fps` —
/// the caller (`chroma_audio_play`) used to silently re-derive it with a
/// second, fps-naive `clip.source_start + elapsed_frames` formula instead of
/// reusing this one, which is exactly the bug. Returning it removes that
/// duplicate (and previously wrong) arithmetic at the call site.
///
/// `(track index, clip, resolved source frame, probed VideoInfo, track gain)`
/// — named here (clippy's `type_complexity`) once B-079's fix added the
/// source-frame element on top of D-147/D-149's existing four.
pub(crate) type AudioTrackPosition = (usize, Clip, u64, VideoInfo, f32);

pub(crate) fn resolve_audio_track_positions(pos: u64) -> Result<Vec<AudioTrackPosition>, String> {
    let timeline = resolve_timeline(false)?;
    let fps = timeline.fps();
    let mut out = Vec::new();
    for (track_index, track) in timeline
        .tracks
        .iter()
        .enumerate()
        .filter(|(_, t)| t.kind == TrackKind::Audio)
    {
        let Some((clip, source_frame)) = track.clip_at(pos as i64, fps) else {
            continue;
        };
        if clip.source_path.is_empty() {
            continue;
        }
        // D-292 — a still contributes no samples, the same way a video clip with
        // no audio stream doesn't. Skipped before the probe rather than after,
        // since there is no audio stream to probe for.
        if apelles_media::still::is_image_file(&clip.source_path) {
            continue;
        }
        let info = probe_cached(Path::new(&clip.source_path))?;
        if !info.has_audio {
            continue;
        }
        out.push((
            track_index,
            clip.clone(),
            source_frame.max(0) as u64,
            info,
            track.gain,
        ));
    }
    Ok(out)
}

/// B-079 — the active timeline's own timebase ([`apelles_timeline::Timeline::fps`]),
/// for `chroma::audio`'s fps-aware per-clip out-point arithmetic
/// (`chroma_audio_play`'s `end_frame_at(fps)` calls) — the one thing that
/// module needs from the timeline beyond what [`resolve_video_position`]/
/// [`resolve_audio_track_positions`] already hand it. A thin, cheap
/// (no media probing) re-read of the manifest rather than widening either of
/// those signatures for a single extra `f64`.
pub(crate) fn timeline_fps() -> Result<f64, String> {
    Ok(resolve_timeline(false)?.fps())
}

/// The timeline-wide facts `chroma::audio::resolve_sources_at` reports
/// alongside its sources, from **one** manifest read. See
/// [`timeline_audio_facts`].
pub(crate) struct TimelineAudioFacts {
    /// [`apelles_timeline::Timeline::fps`].
    pub(crate) fps: f64,
    /// B-192 — the timeline's total length in frames.
    pub(crate) end_frame: u64,
    /// B-235 — [`apelles_timeline::Timeline::edit_fingerprint`].
    pub(crate) revision: u64,
}

/// B-192 — [`timeline_fps`] plus the active timeline's total length in frames
/// ([`apelles_timeline::Timeline::duration`], the longest track), and (B-235)
/// its edit fingerprint, from **one** manifest read rather than three.
///
/// The fingerprint is what `chroma::audio::resolve_sources_at` reports as
/// `ResolvedAudio::revision`, which is how a play session notices the timeline
/// was edited while it plays and rebuilds what it is playing (B-235). It
/// costs one serialization of the active timeline per resolve — tens of
/// microseconds on a ~150-clip recut, on a 10 Hz schedule, off the main
/// thread.
///
/// The length is what `chroma::audio::resolve_sources_at` reports to
/// `apelles_media::audio` as `ResolvedAudio::timeline_end_frame`, which is how
/// a play session tells a genuine silent gap between two clips ("keep going")
/// from the end of the timeline ("stop"). It is the timeline's plain length,
/// not "where the audio ends": the exact answer would need an audio-stream
/// probe per clip on that closure's 10 Hz schedule, and overstating it costs
/// only mixed silence the session's own idle path would have produced anyway.
pub(crate) fn timeline_audio_facts() -> Result<TimelineAudioFacts, String> {
    let timeline = resolve_timeline(false)?;
    Ok(TimelineAudioFacts {
        fps: timeline.fps(),
        end_frame: timeline.duration().max(0) as u64,
        revision: timeline
            .edit_fingerprint()
            .map_err(|e| format!("fingerprint the active timeline: {e}"))?,
    })
}

/// D-149 — one track's ducking configuration resolved against the active
/// timeline at `pos`: the dB/attack/release numbers off `track_index`'s own
/// `apelles_timeline::Track`, plus the **trigger** track's clip layout from
/// `pos` onward, in timeline frames.
///
/// `Ok(None)` — no ducking for this track — for every ordinary reason, none of
/// them an error: no `duck_from` set (the default and every pre-D-149 project),
/// a `duck_from` that no longer names a real track (a track was removed after
/// the duck was configured), or a track pointed at **itself**. That last one is
/// worth rejecting explicitly rather than letting it through: a track ducking
/// on its own clips would attenuate exactly the audio it is triggered by, which
/// is not a thing anyone means and is trivially reachable by removing a track
/// above the pair and shifting the indices.
///
/// This is the timeline half of D-149 and is why it lives here rather than in
/// `apelles-media`: "which frames does track N have clips on" is timeline
/// resolution, and a media crate reaching for it would be reaching *up* a layer
/// (D-039/D-146 — the same rule that kept `chroma_audio_play`'s body app-side).
pub(crate) fn resolve_track_duck(
    track_index: usize,
    pos: u64,
) -> Result<Option<(f32, f32, f32, Vec<(i64, i64)>)>, String> {
    let timeline = resolve_timeline(false)?;
    let Some(track) = timeline.tracks.get(track_index) else {
        return Ok(None);
    };
    let Some(from) = track.duck_from else {
        return Ok(None);
    };
    if from == track_index {
        return Ok(None);
    }
    let Some(trigger) = timeline.tracks.get(from) else {
        return Ok(None);
    };
    // B-079 — `clip_spans_from` is fps-aware now: a mixed-native-fps trigger
    // clip's duck-envelope span used to end at the wrong timeline frame.
    let fps = timeline.fps();
    Ok(Some((
        track.duck_db,
        track.duck_attack_ms,
        track.duck_release_ms,
        trigger.clip_spans_from(pos as i64, fps),
    )))
}

// --------------------------------------------------------------------------- //
// tauri commands
// --------------------------------------------------------------------------- //

/// The open project's **active** edit timeline. Builds one from the project's
/// shots (one full-length video clip per shot, back to back) the first time a
/// project has no timelines at all, and persists that so subsequent opens /
/// saves keep it. Unchanged signature/behaviour from D-041 for a
/// single-timeline project — "active timeline" is invisible here unless the
/// caller has made more than one (`chroma_timeline_create`).
///
/// **B-205 / D-334 — `(async)` is load-bearing, not decoration.** Tauri's own
/// documentation is explicit that "commands without the _async_ keyword are
/// executed on the main thread", and this command's body is not cheap: it
/// reads and parses the project manifest UNCACHED (212 KB of JSON on the
/// owner's real project), runs every schema migration, back-fills legacy clip
/// positions across all 150 clips, and may write the manifest back out. It
/// also fires on every window focus. Doing that inline on the UI thread froze
/// the window for the duration — the "app becomes unresponsive" half of the
/// report, as distinct from the merely-slow async work around it. The body is
/// synchronous blocking I/O, so `spawn_blocking` is what it needs; `(async)`
/// alone would only move it to a runtime worker it would then block.
#[tauri::command]
pub async fn chroma_timeline_get() -> Result<Timeline, String> {
    tokio::task::spawn_blocking(|| resolve_timeline(true))
        .await
        .map_err(|e| e.to_string())?
}

/// Replace the open project's **active** timeline and persist it to
/// `project.json`. Stores whatever is sent verbatim (no server-side
/// clamping) — same contract as D-041, now scoped to whichever timeline is
/// active rather than assuming there's only one.
#[tauri::command]
pub fn chroma_timeline_set(timeline: Timeline) -> Result<(), String> {
    let (dir, mut manifest) = load_and_ensure_timeline(false)?;
    let idx = manifest.active_timeline;
    manifest.timelines[idx] = timeline;
    manifest.modified = now_rfc3339();
    project::save_manifest(&dir, &manifest)
}

/// One timeline's id/name/duration + whether it's the active one — what
/// [`chroma_timeline_list`] returns. For a future timeline-switcher UI
/// (D-045 pass 3); no UI consumes this yet.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSummary {
    pub id: String,
    pub name: String,
    pub duration: i64,
    pub active: bool,
}

/// All of the open project's timelines (D-045). Lazily builds the first one
/// from shots (same fallback [`chroma_timeline_get`] always had) if the
/// project has none yet, so this never returns an empty list for a project
/// with at least the implicit shots-derived timeline.
#[tauri::command]
pub fn chroma_timeline_list() -> Result<Vec<TimelineSummary>, String> {
    let (_dir, manifest) = load_and_ensure_timeline(true)?;
    Ok(manifest
        .timelines
        .iter()
        .enumerate()
        .map(|(i, tl)| TimelineSummary {
            id: tl.id.clone(),
            name: tl.name.clone(),
            duration: tl.duration(),
            active: i == manifest.active_timeline,
        })
        .collect())
}

/// Create a new, empty, named timeline, append it to the project, make it the
/// active timeline, and persist. Returns the full new [`Timeline`] so a
/// caller can use it immediately without a second `chroma_timeline_get`.
#[tauri::command]
pub fn chroma_timeline_create(name: String) -> Result<Timeline, String> {
    let (dir, mut manifest) = load_and_ensure_timeline(false)?;
    let tl = Timeline {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        rate: None,
        tracks: Vec::new(),
        markers: Vec::new(),
    };
    manifest.timelines.push(tl.clone());
    manifest.active_timeline = manifest.timelines.len() - 1;
    manifest.modified = now_rfc3339();
    project::save_manifest(&dir, &manifest)?;
    Ok(tl)
}

/// Make the timeline with `id` the active one — every `chroma_timeline_get`/
/// `_set`/`_frame` call after this targets it. Errors (leaving the active
/// timeline unchanged) if no timeline in the project has that id.
#[tauri::command]
pub fn chroma_timeline_set_active(id: String) -> Result<(), String> {
    let (dir, mut manifest) = load_and_ensure_timeline(false)?;
    let idx = manifest
        .timelines
        .iter()
        .position(|tl| tl.id == id)
        .ok_or_else(|| format!("no timeline with id {id}"))?;
    manifest.active_timeline = idx;
    manifest.modified = now_rfc3339();
    project::save_manifest(&dir, &manifest)
}

// --------------------------------------------------------------------------- //
// track management + cross-track move (D-054, Phase A of the multi-track NLE
// note — model + commands only, no frontend consumer yet: see
// docs/notes/multi-track-nle.md).
// --------------------------------------------------------------------------- //

/// Add a new, empty track of `kind` to the **active** timeline and persist.
/// Returns the new track's index. No UI populates a second track yet (Phase
/// D) — this makes the capability reachable for a script/test/future UI.
#[tauri::command]
pub fn chroma_timeline_add_track(kind: TrackKind) -> Result<usize, String> {
    let (dir, mut manifest) = load_and_ensure_timeline(false)?;
    let idx = manifest.active_timeline;
    let track_idx = manifest.timelines[idx].add_track(kind);
    manifest.modified = now_rfc3339();
    project::save_manifest(&dir, &manifest)?;
    Ok(track_idx)
}

/// Remove `track` (and every clip on it — see
/// `apelles_timeline::Timeline::remove_track`'s doc) from the **active**
/// timeline and persist. Errors on an out-of-range index.
#[tauri::command]
pub fn chroma_timeline_remove_track(track: usize) -> Result<(), String> {
    let (dir, mut manifest) = load_and_ensure_timeline(false)?;
    let idx = manifest.active_timeline;
    manifest.timelines[idx]
        .remove_track(track)
        .map_err(|e| e.to_string())?;
    manifest.modified = now_rfc3339();
    project::save_manifest(&dir, &manifest)
}

/// Move the clip at `(from_track, from_idx)` on the **active** timeline onto
/// `to_track` at timeline-absolute `to_start_frame`, and persist. Works for a
/// same-track reposition too (`from_track == to_track`). Errors (leaving the
/// timeline unchanged) for an out-of-range track/clip index, a negative
/// position, or (unless `ripple` is true, D-104) a destination that would
/// overlap an existing clip.
#[tauri::command]
pub fn chroma_timeline_move_clip(
    from_track: usize,
    from_idx: usize,
    to_track: usize,
    to_start_frame: i64,
    ripple: bool,
) -> Result<(), String> {
    let (dir, mut manifest) = load_and_ensure_timeline(false)?;
    let idx = manifest.active_timeline;
    manifest.timelines[idx]
        .move_clip(from_track, from_idx, to_track, to_start_frame, ripple)
        .map_err(|e| e.to_string())?;
    manifest.modified = now_rfc3339();
    project::save_manifest(&dir, &manifest)
}

// --------------------------------------------------------------------------- //
// A/V link groups (D-129/D-138, `docs/notes/av-linking.md`) — exposing the
// timeline crate's own `link`/`unlink` as real commands. D-129 deliberately
// left this undone ("the frontend's `applyOp` + `chroma_timeline_set` is the
// real edit path… exposing it is a one-liner when the MCP surface wants it")
// — these two exist for that MCP/scripting surface, and as the real Tauri
// command each is, NOT as the app UI's own edit path: `TimelinePane.tsx`'s
// Link/Unlink toolbar actions go through `applyOp`'s mirrored `link`/`unlink`
// TypeScript logic in `packages/editor/src/timeline.ts` and
// `chroma_timeline_set`, the same as every other per-clip op on that surface
// (`move`/`trim`/`split`/`remove`), so the whole-timeline undo/redo history
// keeps working uniformly. Both commands below act on the active timeline
// directly and persist immediately, matching `chroma_timeline_add_track` /
// `_remove_track` / `_move_clip` above — real, scriptable surface a caller
// that isn't the editor's own React tree can use without round-tripping a
// whole `Timeline` through `chroma_timeline_set`.
// --------------------------------------------------------------------------- //

/// Dissolve the **complete** A/V link group the clip at `(track, clip)` on
/// the active timeline belongs to, and persist. A no-op for an already
/// unlinked clip; errors for an out-of-range index or a locked track — see
/// `apelles_timeline::Timeline::unlink`'s own doc for the full semantics
/// (Palmier's own `manage_clip_links` `unlink`, Premiere's `Clip > Unlink`,
/// Resolve's "Unlink Clips").
#[tauri::command]
pub fn chroma_timeline_unlink_clip(track: usize, clip: usize) -> Result<(), String> {
    let (dir, mut manifest) = load_and_ensure_timeline(false)?;
    let idx = manifest.active_timeline;
    manifest.timelines[idx]
        .unlink(track, clip)
        .map_err(|e| e.to_string())?;
    manifest.modified = now_rfc3339();
    project::save_manifest(&dir, &manifest)
}

/// Link two **already-independent** clips on the active timeline — one on a
/// video track, one on an audio track — into a new A/V link group, and
/// persist. Returns the new group id. Errors if either clip is already
/// linked, if the two clips are the same track kind (not one video + one
/// audio), if either clip's own track is locked, or for an out-of-range
/// track/clip index — see `apelles_timeline::Timeline::link`'s own doc for
/// the full validation and why this is deliberately narrower than Palmier's
/// own group-merging `link`.
#[tauri::command]
pub fn chroma_timeline_link_clips(
    track_a: usize,
    clip_a: usize,
    track_b: usize,
    clip_b: usize,
) -> Result<String, String> {
    let (dir, mut manifest) = load_and_ensure_timeline(false)?;
    let idx = manifest.active_timeline;
    let group = manifest.timelines[idx]
        .link((track_a, clip_a), (track_b, clip_b))
        .map_err(|e| e.to_string())?;
    manifest.modified = now_rfc3339();
    project::save_manifest(&dir, &manifest)?;
    Ok(group)
}

/// The preview JPEG's quality, 0-100. 80 is what the preview has always used;
/// named here because [`encode_preview_jpeg`] is now the single place the
/// preview's wire format is decided, and because this is the one dial that
/// trades preview bytes for preview fidelity.
const PREVIEW_JPEG_QUALITY: u8 = 80;

/// Encode one preview picture to JPEG bytes — the only place the preview's wire
/// format is chosen (D-217).
fn encode_preview_jpeg(img: &DynamicImage) -> Result<Vec<u8>, String> {
    let mut buf = Cursor::new(Vec::with_capacity(64 * 1024));
    img.to_rgb8()
        .write_with_encoder(JpegEncoder::new_with_quality(
            &mut buf,
            PREVIEW_JPEG_QUALITY,
        ))
        .map_err(|e| format!("jpeg encode: {e}"))?;
    Ok(buf.into_inner())
}

/// A 1×1 black JPEG — returned for a timeline position past the end (or before
/// the start), so the preview `<img>` clears instead of erroring.
///
/// **Black JPEG, not the 1×1 transparent PNG this used to be (D-217).** The
/// preview payload is raw bytes now and the frontend wraps them in one `Blob`
/// of one fixed MIME type; a second image format on the same channel would mean
/// either byte-sniffing on the JS side or an outright wrong `Content-Type`. At
/// 1×1 inside an `object-contain` `<img>` the two are equally invisible — the
/// element lays out at its 1×1 intrinsic size either way — so nothing the user
/// sees changes.
fn blank_frame_jpeg() -> Result<Vec<u8>, String> {
    encode_preview_jpeg(&DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        1,
        1,
        image::Rgb([0, 0, 0]),
    )))
}

/// Decode the source frame(s) under timeline position `pos` and return the
/// result as raw JPEG bytes. `max_long_edge` (px) optionally caps the decoded
/// size — ffmpeg downscales, so a 4K source is
/// never CPU-scaled here (except inside [`composite_video_frame`]'s own
/// per-layer resize/rotate, unavoidable once more than one layer is real
/// compositing, not a plain decode).
///
/// D-088 (Phase 2 of the P0 full-NLE effort, `docs/notes/multi-track-nle.md`
/// Phase B3): this used to be a single-clip decode only
/// (`resolve_video_position`'s opaque top-wins winner) — now resolves EVERY
/// visible video track's clip at `pos`
/// (`Timeline::resolve_visible_video_layers_at`, D-086) and, when there's
/// more than one, real-composites them (`composite_video_frame`) instead of
/// showing only the top one. The exactly-one-layer case (still the
/// overwhelming common one) takes the same fast plain-decode path as
/// before — byte-identical output, no new cost — **unless that one layer
/// carries a real transform** (D-132/B-053: it used to take the fast path
/// even then, silently discarding that clip's own crop / opacity /
/// position / scale / rotation; see the guard in [`timeline_frame`]).
/// Deliberately does NOT call
/// `resolve_video_position` (that resolver stays single-winner, unchanged,
/// for its OTHER two callers — Colorist's active-clip resolution and the
/// embedded-audio baseline, both genuinely single-clip concerns this
/// change has no business touching).
///
/// Out-of-range / nothing visible → a 1×1 black JPEG ([`blank_frame_jpeg`]);
/// a decode / probe failure → `Err`.
///
/// **Raw bytes over IPC, not a `data:image/jpeg;base64,…` string (D-217).**
/// Base64 on this path cost a second full pass over the picture plus ~33% more
/// bytes to JSON-escape, ship, parse and decode again in the webview, for every
/// displayed frame during playback. `tauri::ipc::Response` hands the frontend
/// an `ArrayBuffer` instead; see D-217 for the measured split.
///
/// **Runs off the Tauri main thread** (D-125). A plain `#[tauri::command] fn`
/// is `ExecutionContext::Blocking` — Tauri runs it on the main thread, so every
/// millisecond this spends decoding is a millisecond the whole window's event
/// loop and *every other* IPC command (notably `chroma_audio_play`, whose
/// start latency is what keeps audio in step with the video clock — D-050)
/// is stalled behind it. A cold pipe spawn is ~0.5 s even after D-125's other
/// fixes, which is far too long to hold the main thread. Same `async fn` +
/// `spawn_blocking` shape `chroma::commands`' and `chroma::session`'s decode
/// commands already use.
///
/// **`playing` is D-324.** `Some(true)` means "this is the next frame of a
/// running playback", which is what licenses priming a decode pipe for the cut
/// ahead (see [`prefetch_upcoming_boundaries`]). Optional and defaulting to
/// `false` so a scrub, a paused seek or any caller that does not care keeps the
/// exact pre-D-324 behaviour rather than spawning an `ffmpeg` per dragged
/// frame.
#[tauri::command]
pub async fn chroma_timeline_frame(
    pos: u64,
    max_long_edge: Option<u32>,
    playing: Option<bool>,
) -> Result<tauri::ipc::Response, String> {
    let intent = if playing.unwrap_or(false) {
        FrameIntent::Playing
    } else {
        FrameIntent::Single
    };
    let jpeg = tokio::task::spawn_blocking(move || timeline_frame(pos, max_long_edge, intent))
        .await
        .map_err(|e| format!("timeline frame task: {e}"))??;
    Ok(tauri::ipc::Response::new(jpeg))
}

/// The real body of [`chroma_timeline_frame`], synchronous — split out so the
/// command can hand it to `spawn_blocking` and so tests can call it directly
/// without a tokio runtime.
///
/// Two phases, deliberately separable so they can be timed apart (D-217):
/// [`timeline_frame_image`] produces the picture (decode + composite),
/// [`encode_preview_jpeg`] turns it into the wire payload.
pub(crate) fn timeline_frame(
    pos: u64,
    max_long_edge: Option<u32>,
    intent: FrameIntent,
) -> Result<Vec<u8>, String> {
    match timeline_frame_image(pos, max_long_edge, intent)? {
        Some(img) => encode_preview_jpeg(&img),
        None => blank_frame_jpeg(),
    }
}

/// B-141 — the launcher card's own `thumb.jpg`, generated from the EXACT same
/// composited picture the Edit tab's live preview shows at timeline position
/// 0: the same [`timeline_frame_image`] call `chroma_timeline_frame` makes,
/// so a clip's `rotation`/`scale`/`position_*`/crop and any Colorist grade
/// are all applied identically. `chroma::project::regen_thumb` is the only
/// caller — it needs `None` (rather than a placeholder image) for "the
/// timeline has nothing to show at frame 0" so it can fall back to its own
/// legacy single-clip grab instead of writing a black square to disk.
///
/// **Deliberately not [`timeline_frame`]:** that function turns "nothing
/// visible" into [`blank_frame_jpeg`] (a 1×1 black JPEG) for the live
/// preview's `<img>`, which is the right answer for a video element but the
/// wrong one for a thumbnail file — a black square is a worse launcher card
/// than the pre-B-141 raw frame grab, not a better one.
///
/// `None` on either "no video track at all" (a brand-new project with only
/// stills, or one whose timeline failed to build) or a genuine decode error —
/// both cases the caller's own fallback already exists for.
pub(crate) fn timeline_thumb_jpeg(max_long_edge: u32) -> Option<Vec<u8>> {
    match timeline_frame_image(0, Some(max_long_edge), FrameIntent::Single) {
        Ok(Some(img)) => encode_preview_jpeg(&img).ok(),
        _ => None,
    }
}

/// The decode + composite half of [`timeline_frame`]: the finished preview
/// picture for timeline position `pos`, or `None` when nothing is visible there
/// (which [`timeline_frame`] turns into [`blank_frame_jpeg`]).
///
/// Split out of `timeline_frame` by D-217 so the two halves can be timed
/// independently — the whole point of that decision was to find out which half
/// the preview's per-frame cost actually lives in, and a monolithic function
/// cannot answer that. See `preview_throughput_tests`.
pub(crate) fn timeline_frame_image(
    pos: u64,
    max_long_edge: Option<u32>,
    intent: FrameIntent,
) -> Result<Option<DynamicImage>, String> {
    let (timeline, settings) = resolve_timeline_and_settings(false)?;
    render_timeline_frame(
        &timeline,
        &settings,
        pos,
        max_long_edge,
        intent,
        decode_pipe::PipeLane::LIVE,
    )
}

/// Whether a resolved [`VisibleLayer`] is one this renderer will actually
/// draw — i.e. everything [`Timeline::resolve_visible_video_layers_at`] returns
/// except an **empty-source media clip** (one whose media is missing or
/// offline).
///
/// D-211 — a TEXT clip is a real visible layer with no `source_path` at all:
/// its picture is generated, not decoded. So the "skip a clip with no source"
/// filter (which exists to drop an empty/offline media clip) has to make an
/// exception for it, or a title would resolve, be discarded here, and silently
/// never appear.
///
/// D-226 — a [`LayerSource::Color`] plate (a dip-to-colour transition) is
/// likewise generated and has no `source_path`, so the same exception applies
/// to it; this predicate only ever discards an EMPTY-source media clip, which
/// is what it was always for.
///
/// D-230 — an ADJUSTMENT clip has no `source_path` either, and decodes nothing
/// at all: it is an operator on the layers below it, not a layer with pixels.
/// Same exception, third time.
///
/// **A named predicate rather than the inline closure it was until D-373**,
/// because `chroma::render_cost` has to agree with
/// [`render_timeline_frame`] about which layers exist at a position in order to
/// estimate what that frame costs, and a second copy of the rule is exactly the
/// kind of two-implementations divergence D-350 exists to remove.
pub(super) fn layer_is_renderable(layer: &VisibleLayer<'_>) -> bool {
    match &layer.source {
        LayerSource::Clip { clip, .. } => {
            clip.is_text() || clip.is_adjustment() || !clip.source_path.is_empty()
        }
        LayerSource::Color { .. } => true,
    }
}

/// **The headless render entry point (D-350).** Everything
/// [`timeline_frame_image`] does, against an **explicitly supplied** timeline
/// and output spec rather than the open project's, re-read from disk.
///
/// What it is: the one function that turns "this document, at this timeline
/// position" into a finished picture — decode every visible layer, run each
/// clip's Colorist grade, composite them in z-order through
/// [`composite_layer_onto`], apply adjustment clips in place, draw captions on
/// top. It is exactly what the Edit tab's live preview calls, so anything built
/// on it is composited by the preview's own engine by construction rather than
/// by a second implementation kept in sync by hand — which is the whole of
/// D-350's rationale (see `docs/notes/export-gpu-compositor.md`).
///
/// What it does NOT do: read the open project (the caller supplies the
/// document), resize to an output resolution (the caller picks the canvas via
/// `max_long_edge`), or encode anything.
///
/// **Why the split is load-bearing rather than cosmetic.** The pre-D-350
/// function resolved the project manifest from disk on *every call*. That is
/// invisible at preview rates (a few calls a second) and pathological at export
/// rates — a 4-minute 60 fps export is ~14,000 manifest parses of a document
/// that cannot change while the render runs. `edit_render` resolves once and
/// drives this.
///
/// **`lane` is which set of decode pipes this walk owns (D-360).** The live
/// preview is `PipeLane::LIVE`; each contiguous-segment render worker gets its
/// own. It exists because this function is declarative about the pipes it wants
/// — it releases every slot not visible at `pos` on every call — so two callers
/// at two different `pos` sharing one lane would release each other's decoders
/// every frame. Nothing else about the frame depends on it: the picture at
/// `pos` is the same in any lane, which `a_frame_is_the_same_in_any_decode_lane`
/// pins.
pub(crate) fn render_timeline_frame(
    timeline: &Timeline,
    settings: &project::ProjectSettings,
    pos: u64,
    max_long_edge: Option<u32>,
    intent: FrameIntent,
    lane: decode_pipe::PipeLane,
) -> Result<Option<DynamicImage>, String> {
    if !timeline.tracks.iter().any(|t| t.kind == TrackKind::Video) {
        return Err("timeline has no video track".to_string());
    }
    let layers: Vec<VisibleLayer<'_>> = timeline
        .resolve_visible_video_layers_at(pos as i64)
        .into_iter()
        .filter(layer_is_renderable)
        .collect();

    // Release the decode pipe of any slot that is no longer a visible layer
    // here (hidden, deleted, or just a gap under the playhead) before decoding
    // — D-125: pipes are per track index now, and each one owns a live ffmpeg
    // process, so the set has to track what's actually on screen. D-226: keyed
    // by real `PipeSlot`, since a transition's partner clip holds a second slot
    // on the same track whose lifetime is the transition window, not the
    // track's.
    let mut keep_slots: Vec<decode_pipe::PipeSlot> =
        layers.iter().filter_map(layer_pipe_slot).collect();

    // D-324 — resolve the upcoming cut boundaries BEFORE the release above
    // runs, because their slots have to survive it.
    //
    // A track whose playhead currently sits in a gap (or on a still, or on a
    // text clip) contributes no visible slot, so an unextended keep-list would
    // release the pipe primed for the clip starting a few frames later — and
    // then the next frame would prime it again, and the frame after that would
    // release it again. That is one `ffmpeg` spawned and killed per displayed
    // frame: strictly worse than the stall this is here to remove. Extending
    // the keep-list with what is about to be visible keeps at most half a
    // second of extra lifetime per slot, which is exactly the lookahead.
    let upcoming = match intent {
        FrameIntent::Playing => upcoming_boundary_targets(timeline, pos, max_long_edge),
        // A scrub/thumbnail predicts nothing, so it also extends nothing — the
        // keep-list stays exactly the pre-D-324 visible set.
        FrameIntent::Single => Vec::new(),
    };
    keep_slots.extend(upcoming.iter().map(|t| t.slot));
    decode_pipe::retain_pipe_slots(lane, &keep_slots);

    if layers.is_empty() {
        // A gap under the playhead still has a boundary coming, and priming it
        // is the whole reason the keep-list above was extended.
        prime(lane, &upcoming);
        return Ok(None);
    }
    let comp = composition_size(settings, timeline)?;

    // D-136 — the fast path's second condition. A lone clip may be returned as
    // a plain decode only if it really *is* the whole composition: same pixel
    // dimensions as the composition space, so the picture a plain decode
    // produces and the picture the compositor would produce are the same
    // framing (the preview `<img>` is `object-contain`, so the two differing in
    // resolution alone is invisible — differing in framing is not). A 640×360
    // clip in a 1920×1080 project is a third of the frame wide with black
    // around it, and must go through the compositor to look like that; before
    // D-136 it filled the preview edge to edge, which is the same class of
    // defect as B-043's position drift and would have made the transform
    // overlay draw a box in a place the picture disagrees with.
    //
    // D-226 — a layer carrying a transition alpha below 1.0 never takes it
    // either, for exactly D-132/B-053's reason: the alpha is a real blend the
    // plain decode cannot express, so a fast path that ignored it would show a
    // hard cut where the document says there is a dissolve. (A cross dissolve
    // resolves two layers and so already fails the single-layer arm; this guard
    // is what covers the one-sided cases — a dangling transition, or a dip whose
    // plate has been filtered away.)
    let single_plain = match layers.as_slice() {
        // D-211 — a lone TEXT clip never takes the plain-decode fast path:
        // there is no source to decode, and its whole picture comes from the
        // compositor's own rasterise-and-blend step.
        [l] if l.alpha < 1.0 => false,
        // D-230 — nor does a lone ADJUSTMENT clip: it decodes nothing, and the
        // picture it produces (its correction applied to the black canvas
        // beneath it) only exists once the compositor has run. Taking the fast
        // path here would have tried to probe its empty `source_path`.
        [
            VisibleLayer {
                source: LayerSource::Clip { clip, .. },
                ..
            },
        ] if clip.is_text() || clip.is_adjustment() => false,
        [
            VisibleLayer {
                source:
                    LayerSource::Clip {
                        clip, source_frame, ..
                    },
                ..
            },
        ] => {
            // D-292 — `clip_source_size` covers a still here too: a lone still
            // that really is the whole composition takes the plain-decode fast
            // path exactly like a lone video clip does, which for a still is
            // one cache hit per frame.
            let size = clip_source_size(&clip.source_path)?;
            resolve_clip_transform(clip, *source_frame).is_identity()
                && size == comp
                // D-256 — a clip carrying a real Colorist grade never takes the
                // plain-decode fast path either, for exactly D-132/B-053's
                // reason: the grade is a real transform of this clip's pixels
                // that a raw decode cannot express, so a fast path that ignored
                // it would show the ungraded picture while the document says the
                // clip is graded. An UNGRADED clip (no grade file, or one that
                // bakes to the identity — the overwhelmingly common case) still
                // takes it, byte-identically to before, because
                // `lut_for_clip` returns `None` for both and answers from its
                // memo after the first frame.
                && grade_lut::lut_for_clip(&clip.id).is_none()
                // D-396 — nor does a clip carrying highlights: they are drawn by
                // the compositor on the decoded picture, which a plain decode
                // does not run.
                && clip.highlights.is_empty()
        }
        _ => false,
    };

    let img = match layers.as_slice() {
        [] => return Ok(None),
        [
            VisibleLayer {
                track,
                source:
                    LayerSource::Clip {
                        clip,
                        source_frame,
                        role,
                    },
                ..
            },
        ] if single_plain => {
            // Fast path: exactly one visible layer, with nothing to apply to
            // it, needs no compositing at all.
            //
            // **The `is_identity()` guard is D-132/B-053.** Pre-D-132 this
            // arm matched *every* single-layer frame unconditionally, so a
            // lone clip's opacity / position / scale / rotation were silently
            // ignored in the preview — the Inspector wrote them, the file
            // stored them, and the picture never changed until a second video
            // track happened to exist. That was already wrong for the D-082
            // fields; shipping crop into it would have made it the first
            // thing the owner tried ("crop one clip") and the first thing
            // that appeared to do nothing. A clip that really has no
            // transform still takes this path, so the overwhelmingly common
            // case is byte-identical and no slower than before.
            // `comp` IS this clip's source size — that is exactly what
            // `single_plain` just checked — so no second probe is needed here.
            decode_clip_picture(
                &clip.source_path,
                comp,
                lane,
                pipe_slot(*track, *role),
                (*source_frame).max(0) as u64,
                max_long_edge,
            )?
        }
        _ => composite_video_frame(&layers, max_long_edge, comp, lane)?,
    };

    // D-229 — captions go on last, over the finished picture, whatever the
    // video z-order turned out to be. That includes over the single-layer fast
    // path above: a caption must not be the reason a plain one-clip frame
    // stops taking it, so this is a separate pass rather than another arm of
    // the match. `draw_captions_onto` returns the frame untouched when there
    // are none, which is every pre-D-229 project and every frame of a project
    // with no subtitle track — so the common case pays one `Vec` allocation
    // that comes back empty.
    let img = draw_captions_onto(img, timeline, pos as i64)?;

    // D-324 — prime the upcoming boundaries AFTER this frame is decoded, not
    // before.
    //
    // Order is load-bearing, and getting it wrong is silent: a standby is
    // consulted by `playback_frame_scaled` whenever the live pipe cannot serve
    // the frame being asked for, which is exactly the situation on the first
    // frame of a clip. Priming first therefore had this very frame's decode
    // pick up the pipe meant for the NEXT clip, find it could not serve the
    // frame at hand, and drop it — so the standby was spawned and killed every
    // frame and never once adopted. The prefetch ran, the processes churned,
    // and nothing got faster. (Caught by
    // `playback_primes_the_upcoming_cut_and_a_scrub_does_not`, which is why it
    // asserts on the standby count rather than only on wall-clock.)
    prime(lane, &upcoming);

    Ok(Some(img))
}

/// Hand the resolved [`PrefetchTarget`]s to `decode_pipe::sync_prefetch`
/// (D-324, made declarative by D-330).
///
/// **Must be called on every frame, including with an empty `targets`.** That
/// call is the only thing that releases a standby in the normal course of play:
/// `sync_prefetch` is told the complete set of boundaries still worth holding a
/// process open for, and drops everything else. So a scrub (which predicts
/// nothing, and therefore wants nothing primed) has to say so rather than
/// simply not calling — otherwise the standbys playback left behind would sit
/// holding `ffmpeg` processes until the slot went away.
fn prime(lane: decode_pipe::PipeLane, targets: &[PrefetchTarget]) {
    let specs: Vec<decode_pipe::PrefetchSpec<'_>> = targets
        .iter()
        .map(|t| decode_pipe::PrefetchSpec {
            slot: t.slot,
            path: &t.path,
            info: &t.info,
            target: t.target,
            scale: t.scale,
        })
        .collect();
    decode_pipe::sync_prefetch(lane, &specs);
}

/// D-229 — alpha-composite every caption showing at `pos` onto `frame`.
///
/// **A separate pass over the finished picture, deliberately** (see
/// `Timeline::resolve_visible_captions_at`): a caption is not a video layer,
/// takes no part in the video z-order, and never occludes what is under it the
/// way an opaque clip does. Painting it here — after the compositor, after the
/// single-layer fast path — is what makes those three facts true in the
/// preview as well as in the model.
///
/// **The canvas is whatever the frame already is**, not the composition: the
/// caption layer is rasterised at the frame's own size, so its style's
/// fractions resolve against the same picture the viewer is looking at. That
/// is the same resolution-independence contract the export honours by
/// resolving the identical fractions against the output size.
fn draw_captions_onto(
    frame: DynamicImage,
    timeline: &Timeline,
    pos: i64,
) -> Result<DynamicImage, String> {
    let captions = timeline.resolve_visible_captions_at(pos);
    if captions.is_empty() {
        return Ok(frame);
    }
    let (w, h) = (frame.width(), frame.height());
    let mut canvas = frame.to_rgba8();
    // D-243 — an animated caption needs to know where in its OWN clip this
    // frame falls. Clip-local, not session-relative, so a cue that is moved or
    // rippled animates identically (the same rule its word windows follow).
    let fps = timeline.fps();
    for cap in captions {
        let time = if fps > 0.0 {
            caption_render::CaptionTime {
                t_secs: (pos - cap.clip.start_frame) as f64 / fps,
                dur_secs: cap.clip.duration as f64 / fps,
            }
        } else {
            // A timeline with no usable frame rate has no time axis to animate
            // along; drawing the static first frame is the honest degradation.
            caption_render::CaptionTime::STATIC
        };
        let layer = caption_render::render_caption_layer(cap.cue, &cap.style, w, h, time)?;
        // Full opacity: a caption has no `opacity`/fade of its own (see
        // `Clip::caption`'s doc) — its only transparency is the background
        // box's, which is already baked into the layer's own alpha.
        image::imageops::overlay(&mut canvas, layer.as_ref(), 0, 0);
    }
    Ok(DynamicImage::ImageRgba8(canvas))
}

/// **D-324/D-330 — how far ahead of the playhead to look for the next cut, when
/// this source has never been measured.**
///
/// D-324 derived 0.5 s from a lead-time curve measured on one file
/// (`…C038.MOV`, respawn 248-337 ms): 200 ms of lead → 103 ms still to wait,
/// 400 ms → 1.0 ms, 800 ms → 2.6 ms. D-330 re-ran that measurement on the
/// owner's `…C040.MOV` and got a materially different curve — 200 ms → 450 ms,
/// **400 ms → 51 ms**, 500 ms → 1.6 ms — because a respawn on that file costs a
/// median **723 ms** (min 460, max 2372 over 16 of its own cut points). Half a
/// second sat exactly on the knee for that footage, which is why cuts still
/// hitched after D-324.
///
/// So this constant is now only the **bootstrap**: the value used for a source
/// that has not yet paid a single un-hidden respawn, and therefore has nothing
/// measured. Once one has been paid, [`prefetch_lead_secs`] uses that source's
/// own measurement instead. It is kept at D-324's 0.5 s because that is a real
/// measured figure for real footage, not a guess.
///
/// **Why a duration and not a frame count**: the thing being hidden is wall
/// clock (a seek), so the lead has to be wall clock too — 12 frames is half a
/// second at 24 fps and a fifth of one at 60.
const DEFAULT_PREFETCH_LEAD_SECS: f64 = 0.5;

/// How much longer than the measured seek to give a prefetch (D-330).
///
/// The measurement is a median over a source whose own spread is wide (460 ms
/// to 2372 ms on `C040`), and being late is far worse than being early: late
/// means the user sees the whole remaining stall, early means one `ffmpeg`
/// started sooner than it had to. 1.5× puts the median comfortably past the
/// knee of the lead curve without pinning processes open for seconds.
const PREFETCH_LEAD_SAFETY: f64 = 1.5;

/// Hard bounds on the adaptive lead. The ceiling is what
/// [`upcoming_boundary_targets`] actually scans, so it also bounds that walk's
/// cost; the floor keeps a source that once seeked suspiciously fast (a warm
/// page cache, a tiny fixture) from losing the lead entirely.
const MIN_PREFETCH_LEAD_SECS: f64 = 0.5;
const MAX_PREFETCH_LEAD_SECS: f64 = 2.0;

/// **D-330 — how much lead THIS source needs, from what it has been measured to
/// cost.**
///
/// Every un-hidden respawn times itself (`decode_pipe::record_seek_cost`), so a
/// source that has crossed one cold cut has told us how expensive its keyframe
/// seek is. A source that has not falls back to [`DEFAULT_PREFETCH_LEAD_SECS`].
///
/// Self-correcting in the right direction: the estimate only exists because a
/// seek was paid in full, and paying one is exactly the event that means the
/// lead was too short.
fn prefetch_lead_secs(path: &Path) -> f64 {
    match decode_pipe::estimated_seek_ms(path) {
        Some(ms) => (ms / 1000.0 * PREFETCH_LEAD_SAFETY)
            .clamp(MIN_PREFETCH_LEAD_SECS, MAX_PREFETCH_LEAD_SECS),
        None => DEFAULT_PREFETCH_LEAD_SECS,
    }
}

/// The widest window [`upcoming_boundary_targets`] ever walks, in timeline
/// frames at `fps` — [`MAX_PREFETCH_LEAD_SECS`]' worth. Boundaries found inside
/// it are then filtered against *their own* source's lead, so a slow file gets
/// primed early and a fast one is not primed until it needs to be.
fn prefetch_scan_frames(fps: f64) -> u64 {
    if !fps.is_finite() || fps <= 0.0 {
        return 1;
    }
    ((MAX_PREFETCH_LEAD_SECS * fps).round() as u64).max(1)
}

/// Whether a preview-frame request is one step of continuous playback or a
/// one-off picture — the only thing that decides whether it is worth priming a
/// decode pipe for the cut ahead (D-324).
///
/// A scrub, a paused seek and a thumbnail are all `Single`: their next position
/// is whatever the user's pointer does next, so a prediction from the current
/// one is worth nothing and would spawn an `ffmpeg` per dragged frame. Playback
/// is the opposite — its next position is arithmetic.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum FrameIntent {
    /// A scrub, a paused seek, a thumbnail — no prefetch.
    Single,
    /// The next frame of a running playback — prime the upcoming boundary.
    Playing,
}

/// **D-324 — prime a decode pipe for every cut boundary playback is about to
/// cross.**
///
/// The Edit tab knows the whole edit list, so when playback is running, the
/// next clip on each track — and the exact source frame it opens on — is
/// arithmetic rather than a guess. This resolves the timeline once at
/// `pos + lookahead` and hands each visible layer's slot to
/// `decode_pipe::prefetch`, which does nothing at all unless a respawn is
/// genuinely coming. So mid-clip this is one extra timeline walk per frame and
/// no processes; approaching a cut it is the one `ffmpeg` spawn that turns a
/// ~300 ms stall into a ~1 ms read.
///
/// **The prefetch target is the clip's FIRST frame, not the frame at
/// `pos + lookahead`.** Playback crosses the boundary at the new clip's own
/// `start_frame`, and a pipe primed past that point could not serve it — it
/// would respawn, which is the entire thing being avoided. Priming at the start
/// instead means the boundary frame is the standby's very next read, and the
/// handful of frames after it are the ordinary forward-skip the pipe already
/// does, so a dropped frame either side changes nothing.
///
/// **D-330 — a CHAIN of boundaries, not the one clip visible at a single
/// instant.** D-324 resolved the timeline once, at `pos + lookahead`, and
/// primed whatever was there. On a timeline whose clips are shorter than the
/// lookahead that is actively wrong: while playback is still approaching clip
/// `N+1`, the layer at `pos + lookahead` is already clip `N+2`, so `N+1`'s
/// standby was replaced before it was ever adopted and its boundary paid the
/// full respawn anyway. This walks the window instead and primes every boundary
/// in it, in order, which is what lets a run of short clips overlap its
/// respawns rather than serialise them.
///
/// **D-330 — a clip already under the playhead is skipped outright.** D-324
/// clamped its target to `max(clip.start_frame, pos)` and relied on
/// `decode_pipe::prefetch` to no-op for it. It does not: `prime` runs AFTER the
/// frame is decoded, so the live pipe's `next_index` is already `source_frame +
/// 1` and `can_serve`'s `target >= next_index` fails by exactly one. Every
/// ordinary mid-clip frame therefore spawned an `ffmpeg`, killed it on the next
/// frame, and never adopted it — the precise opposite of the module doc's "one
/// extra timeline walk per frame and no processes". Measured harmless
/// (a spawn-and-kill per frame alongside a live read moved its median 7.13 ms →
/// 6.62 ms, i.e. not at all) but wasteful and wrong, so the condition is now
/// explicit rather than delegated.
///
/// Never fails the frame. Every step that could error (an unprobeable source, a
/// clip whose media has gone offline) simply skips that layer: the fallback is
/// the respawn that would have happened anyway.
fn upcoming_boundary_targets(
    timeline: &Timeline,
    pos: u64,
    max_long_edge: Option<u32>,
) -> Vec<PrefetchTarget> {
    let fps = timeline.fps();
    let scan = prefetch_scan_frames(fps);
    let mut out: Vec<PrefetchTarget> = Vec::new();
    let mut per_slot: HashMap<decode_pipe::PipeSlot, usize> = HashMap::new();

    // Walk the window one frame at a time. A one-frame clip is a real thing on
    // this timeline (the owner's recut has one), so a coarser step would miss
    // boundaries outright; and the walk stops early once every slot it has seen
    // is already full, which mid-clip is immediately.
    for ahead in (pos + 1)..=(pos + scan) {
        for layer in timeline.resolve_visible_video_layers_at(ahead as i64) {
            let Some(slot) = layer_pipe_slot(&layer) else {
                continue; // text, adjustment, colour plate, still — never a pipe
            };
            let LayerSource::Clip { clip, .. } = &layer.source else {
                continue;
            };
            // Not a boundary: this clip is already under the playhead, so the
            // live pipe is mid-stream in it and will reach every frame of it by
            // reading forward. See the "off by exactly one" note above.
            if clip.start_frame <= pos as i64 {
                continue;
            }
            let primed = per_slot.entry(slot).or_default();
            if *primed >= decode_pipe::MAX_STANDBY_PER_SLOT {
                continue;
            }
            let source_frame = clip.source_frame_at(clip.start_frame, fps);
            if source_frame < 0 {
                continue;
            }
            let path = PathBuf::from(&clip.source_path);
            // Only prime once this boundary is inside ITS OWN source's lead —
            // a slow file is primed early, a fast one is left until it needs to
            // be, and neither is decided by a constant that happens to suit one
            // of them.
            let lead = prefetch_lead_secs(&path);
            if fps > 0.0 && (clip.start_frame - pos as i64) as f64 / fps > lead {
                continue;
            }
            let target = source_frame as u64;
            if out
                .iter()
                .any(|t| t.slot == slot && t.path == path && t.target == target)
            {
                continue; // the same boundary, seen again a frame later
            }
            let (Ok(size), Ok(info)) = (clip_source_size(&clip.source_path), probe_cached(&path))
            else {
                continue;
            };
            *primed += 1;
            out.push(PrefetchTarget {
                slot,
                path,
                info,
                target,
                scale: decode_scale(size, max_long_edge),
            });
        }
    }
    out
}

/// One resolved D-324 prefetch: everything `decode_pipe::prefetch` needs for a
/// boundary the playhead is approaching. Produced by
/// [`upcoming_boundary_targets`] before the frame is decoded, because its
/// `slot` also has to extend that frame's `retain_pipe_slots` keep-list — see
/// the call site for why a slot about to become visible must not be released
/// first and re-primed a frame later.
struct PrefetchTarget {
    slot: decode_pipe::PipeSlot,
    path: PathBuf,
    info: apelles_media::video::VideoInfo,
    target: u64,
    scale: Option<(u32, u32)>,
}

/// D-226 — the decode-pipe slot a clip layer belongs in: the track's own slot
/// for an ordinary layer, its transition-partner slot for the second clip of a
/// cross dissolve. See `apelles_timeline::LayerRole` for why the two must not
/// share (B-040).
fn pipe_slot(track: usize, role: LayerRole) -> decode_pipe::PipeSlot {
    match role {
        LayerRole::Primary => decode_pipe::PipeSlot::Track(track),
        LayerRole::TransitionPartner => decode_pipe::PipeSlot::TrackTransition(track),
    }
}

/// D-226 — the slot a layer will decode through, or `None` for one that decodes
/// nothing (a generated text clip, a dip-to-colour plate, or — D-230 — an
/// adjustment clip). Drives the per-frame `retain_pipe_slots` release so a slot
/// whose layer went away frees its `ffmpeg` process the same frame.
///
/// **D-292 — a STILL layer is `None` too.** It has a real `source_path`, unlike
/// the three generated cases above, but it is decoded by `apelles_media::still`
/// and never touches `decode_pipe`, so claiming a slot for it would pin an
/// `ffmpeg` process that nothing is going to use — and, worse, would keep a slot
/// alive that `retain_pipe_slots` would otherwise have released to the video
/// layer that actually needs it.
fn layer_pipe_slot(layer: &VisibleLayer<'_>) -> Option<decode_pipe::PipeSlot> {
    match &layer.source {
        LayerSource::Clip { clip, role, .. }
            if !clip.is_text()
                && !clip.is_adjustment()
                && !apelles_media::still::is_image_file(&clip.source_path) =>
        {
            Some(pipe_slot(layer.track, *role))
        }
        _ => None,
    }
}

/// One clip's placement geometry in composition space — what an on-canvas
/// transform overlay needs and cannot work out for itself (D-136, Phase 1 of
/// `docs/notes/on-canvas-transform.md`).
///
/// The frontend can already read a clip's `position_*`/`scale`, and after
/// D-136 those are fractions of the composition, so the *offset* half of the
/// overlay's box needs no backend help at all. What it can't know is how big
/// the box is: that is the clip's source resolution measured against the
/// composition's, and neither number is in the timeline JSON.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipGeometry {
    /// The composition's own pixel size ([`composition_size`]) — reported so
    /// the overlay can show a real resolution and so a caller that wants
    /// composition pixels can convert, not because the box math needs it.
    pub comp_width: u32,
    pub comp_height: u32,
    /// The clip's full-frame footprint at `scale == 1.0`, as a fraction of
    /// the composition. `1.0`/`1.0` = its source exactly fills the frame.
    pub natural_width: f64,
    pub natural_height: f64,
}

/// [`ClipGeometry`] for the clip at `track`/`clip` on the active timeline.
///
/// Indices, not a clip id, to match every other per-clip command on this
/// surface (`chroma_timeline_move_clip`, and the `set_clip_transform` op the
/// overlay writes) — the caller resolving an id to an index once and using it
/// for both is strictly better than two conventions in one interaction.
///
/// Probes the source (cached, [`probe_cached`]), so it is `async` +
/// `spawn_blocking` for the same reason [`chroma_timeline_frame`] is: a cold
/// probe is two `ffprobe` spawns and must not sit on Tauri's main thread.
#[tauri::command]
pub async fn chroma_timeline_clip_geometry(
    track: usize,
    clip: usize,
) -> Result<ClipGeometry, String> {
    tokio::task::spawn_blocking(move || clip_geometry(track, clip))
        .await
        .map_err(|e| format!("clip geometry task: {e}"))?
}

/// The synchronous body of [`chroma_timeline_clip_geometry`] — split out for
/// the same reason [`timeline_frame`] is, so tests can call it without a
/// tokio runtime.
pub(crate) fn clip_geometry(track: usize, clip: usize) -> Result<ClipGeometry, String> {
    let (timeline, settings) = resolve_timeline_and_settings(false)?;
    let (comp_w, comp_h) = composition_size(&settings, &timeline)?;
    let c = timeline
        .tracks
        .get(track)
        .and_then(|t| t.clips.get(clip))
        .ok_or_else(|| format!("no clip {clip} on track {track}"))?;
    // B-130/D-262 — a TITLE's footprint is the size of its rendered INK, not
    // the whole frame.
    //
    // D-211 answered "the whole composition" here, on the true-but-irrelevant
    // fact that a text clip's RGBA layer is allocated at the composition's
    // size (see `composite_video_frame`). That buffer is almost entirely
    // transparent: the glyphs occupy a small box centred in it. Nothing ever
    // decided that the whole buffer was the right thing to report — the
    // `TransformOverlay` box and `useCanvasClipPick`'s hit rect are both
    // derived from this number, so a 12%-of-frame-height title got a selection
    // box spanning the entire 1080x1920 frame and swallowed every canvas click
    // meant for the footage under it. `chroma::text::text_layer_ink_fraction`
    // measures the ink with the SAME advance-and-kern walk that rasterises it,
    // so the box is around the glyphs actually drawn.
    //
    // A title with no ink (empty content — its ordinary state the moment it is
    // added, before anything is typed) falls back to the whole frame: there is
    // no ink to measure, and a zero-size box would leave the clip with no
    // grabbable move handle at all, which is strictly worse than an oversized
    // one. Same fallback for an unmeasurable font, rather than failing the
    // whole geometry fetch over it.
    if c.is_text() {
        let (nw, nh) = c
            .text
            .as_ref()
            .and_then(|t| {
                super::text::text_layer_ink_fraction(t, comp_w, comp_h)
                    .ok()
                    .flatten()
            })
            .unwrap_or((1.0, 1.0));
        return Ok(ClipGeometry {
            comp_width: comp_w,
            comp_height: comp_h,
            natural_width: nw,
            natural_height: nh,
        });
    }
    // D-230 — an adjustment clip IS the whole frame, for a reason the title
    // above turned out not to share: it draws nothing at all, but its
    // correction covers every pixel, so "the whole composition" is the honest
    // footprint. Answered here rather than left to fall through to the
    // `source_path.is_empty()` error below, which would have made every
    // selection of an adjustment clip a failed IPC round trip that the caller
    // then had to interpret — an error used as control flow for a case that is
    // not an error.
    if c.is_adjustment() {
        return Ok(ClipGeometry {
            comp_width: comp_w,
            comp_height: comp_h,
            natural_width: 1.0,
            natural_height: 1.0,
        });
    }
    if c.source_path.is_empty() {
        return Err("clip has no source".to_string());
    }
    // D-292 — a still has a real footprint on the canvas exactly like footage
    // does, so the on-canvas transform overlay must be able to box one.
    let (sw, sh) = clip_source_size(&c.source_path)?;
    Ok(ClipGeometry {
        comp_width: comp_w,
        comp_height: comp_h,
        natural_width: sw as f64 / comp_w as f64,
        natural_height: sh as f64 / comp_h as f64,
    })
}

/// D-199 (canvas-boundary preview overlay) — the composition's own pixel size
/// ([`composition_size`]), with NO clip selection required.
///
/// [`ClipGeometry`]/[`chroma_timeline_clip_geometry`] already reports
/// `comp_width`/`comp_height`, but only as a side effect of resolving ONE
/// selected clip's box — `TransformOverlay.tsx` (the on-canvas transform
/// handles) has always had this for free because it never needs the frame
/// size without a clip also selected. A boundary overlay that must render
/// with NOTHING selected (so a human can see the real output frame before
/// touching anything) needs the composition size on its own — this is that,
/// a thin wrapper with no clip-probing at all.
#[tauri::command]
pub async fn chroma_timeline_composition_size() -> Result<ClipGeometry, String> {
    tokio::task::spawn_blocking(composition_size_only)
        .await
        .map_err(|e| format!("composition size task: {e}"))?
}

/// The synchronous body of [`chroma_timeline_composition_size`] — same
/// `spawn_blocking` split as [`timeline_frame`]/[`clip_geometry`]: this can
/// end up probing a clip too (`composition_size`'s no-explicit-settings
/// fallback), which is real disk I/O, so it stays off the async runtime's
/// caller and off Tauri's main thread the same way.
///
/// Reuses [`ClipGeometry`]'s shape with `natural_width`/`natural_height`
/// fixed at `1.0` (undefined without a clip — see that struct's own doc for
/// what they mean) rather than inventing a second, near-identical DTO the
/// frontend would need a second type for.
fn composition_size_only() -> Result<ClipGeometry, String> {
    let (timeline, settings) = resolve_timeline_and_settings(false)?;
    let (comp_w, comp_h) = composition_size(&settings, &timeline)?;
    Ok(ClipGeometry {
        comp_width: comp_w,
        comp_height: comp_h,
        natural_width: 1.0,
        natural_height: 1.0,
    })
}

// --------------------------------------------------------------------------- //
// D-088 (Phase 2, Phase B3 of docs/notes/multi-track-nle.md): the actual
// multi-layer compositor. Real CPU alpha-over compositing (`image` +
// `imageproc`, both already dependencies — no wgpu here, this is a
// per-frame-on-demand still decode, not a 60fps realtime path; a GPU
// version can follow if this proves too slow in practice, but a real,
// correct, working CPU compositor beats an unbuilt GPU one).
// --------------------------------------------------------------------------- //

/// A clip's transform, resolved for one specific `source_frame` — the
/// static fields, or their keyframe-interpolated values.
pub(super) struct ClipTransform {
    opacity: f64,
    position_x: f64,
    position_y: f64,
    scale: f64,
    /// D-193 — resolved (static-or-keyframed) mirror of `Clip::box_width`/
    /// `box_height`: `Some` overrides `scale`'s natural-footprint box-size
    /// computation entirely for that axis (a fraction of the CANVAS, not
    /// the layer's own source), `None` means "no override, this axis is
    /// governed by `scale` as before D-193" — see [`Self::effective_size`]
    /// (the point of use) and `Clip::box_width`'s own doc for the full
    /// reasoning.
    box_width: Option<f64>,
    box_height: Option<f64>,
    rotation: f64,
    /// D-132 — normalised (0.0–1.0) edge insets into the layer's own source
    /// frame, resolved for this frame exactly like every field above (static
    /// value, or its keyframe-interpolated one). See `Clip::crop_left`'s doc
    /// for why the unit is a fraction of the source and not pixels.
    crop_left: f64,
    crop_top: f64,
    crop_right: f64,
    crop_bottom: f64,
    /// D-344 — the placement box's corner radius, in **the canvas actually
    /// being rendered into**, not in output-composition pixels. `Clip::
    /// corner_radius` is authored in OUTPUT pixels (see its own doc); the
    /// preview renders the same composition into a smaller buffer, so
    /// [`Self::scaled_to_render`] converts it exactly once, at the only two
    /// places that know `render_scale`. Every other field here is a ratio and
    /// needs no such step — this one is the single exception, which is why it
    /// gets a named conversion rather than an ad-hoc multiply at the point of
    /// use.
    corner_radius: f64,
}

impl ClipTransform {
    /// D-132/B-053 — whether applying this transform to a layer would change
    /// nothing at all, so [`timeline_frame`]'s single-layer fast path may
    /// skip compositing entirely and return the plain decoded frame.
    ///
    /// Exact comparisons, not epsilons: these values come from the
    /// Inspector's own numeric inputs (or the keyframe interpolator over
    /// them), so "the user has not touched this field" really is the exact
    /// literal default, and a tolerance would only invent a second,
    /// silently different notion of identity from the one
    /// [`composite_layer_onto`] itself acts on. A **negative** crop inset
    /// counts as no crop, matching [`crop_pixel_rect`]'s own clamp — the
    /// predicate has to agree with what would actually be painted.
    pub(super) fn is_identity(&self) -> bool {
        self.opacity >= 1.0
            && self.position_x == 0.0
            && self.position_y == 0.0
            && self.scale == 1.0
            // D-193 — conservative on purpose: proving a `box_width`/
            // `box_height` override happens to equal what `scale == 1.0`
            // would have produced anyway needs the canvas size, which this
            // method doesn't have. Treating "an override is present at
            // all" as "not identity" is always SAFE (worst case, an
            // override that happens to be a no-op still takes the real
            // compositor path instead of the fast one) and never wrong —
            // the same discipline `crop_left`'s own exact-comparison note
            // above already explains for this method.
            && self.box_width.is_none()
            && self.box_height.is_none()
            && self.rotation == 0.0
            && self.crop_left <= 0.0
            && self.crop_top <= 0.0
            && self.crop_right <= 0.0
            && self.crop_bottom <= 0.0
            // D-344 — a NEGATIVE radius counts as no rounding, matching
            // `corner_coverage`'s own clamp, for the crop insets' reason
            // directly above: this predicate has to agree with what would
            // actually be painted.
            && self.corner_radius <= 0.0
    }

    /// D-294 — the same geometry with the **blend** neutralised: opacity back
    /// to fully opaque. For a consumer that places one clip on a canvas with
    /// nothing beneath it, where opacity/fade have nothing to blend *against*
    /// — today that is the Colorist's own preview (`super::colorist_view`).
    /// A method rather than a `pub` field so the struct's invariant stays
    /// "every field here is already resolved for one frame", and so the one
    /// place this neutralising happens is named.
    pub(super) fn without_blend(mut self) -> Self {
        self.opacity = 1.0;
        self
    }

    /// D-344 — convert `corner_radius` from the OUTPUT-composition pixels it
    /// is authored in into the pixels of the canvas this render is actually
    /// producing (`canvas_width / comp_width`, the same single uniform ratio
    /// `composite_video_frame` already derives for `natural`).
    ///
    /// **Why this exists at all.** Every other geometry field on this struct
    /// is a ratio of the composition, so it survives the preview's
    /// 960-while-scrubbing / 640-while-playing decode cap for free — that is
    /// B-043's whole lesson, and D-136 restructured the compositor around it.
    /// A corner radius is deliberately NOT a ratio (see `Clip::corner_radius`
    /// for why a human means "16 px of round", not "1.5% of the width"), so it
    /// is the one field that has to be converted explicitly. Doing it here, in
    /// one named method called by the two functions that own a `render_scale`,
    /// is what keeps that conversion from being re-derived — differently —
    /// inside the compositor.
    ///
    /// A zero radius stays exactly zero at every scale, so an un-rounded clip
    /// is byte-identical through this method.
    pub(super) fn scaled_to_render(mut self, render_scale: f64) -> Self {
        self.corner_radius *= render_scale;
        self
    }

    /// How much of each axis the crop insets KEEP, as a fraction — the same
    /// `1 - near - far` per axis that [`crop_pixel_rect`] turns into pixels,
    /// and clamped the same way so a nonsense inset can never make this
    /// negative. `(1.0, 1.0)` for an un-cropped clip.
    fn kept_fraction(&self) -> (f64, f64) {
        let keep =
            |near: f64, far: f64| (1.0 - near.clamp(0.0, 1.0) - far.clamp(0.0, 1.0)).max(0.0);
        (
            keep(self.crop_left, self.crop_right),
            keep(self.crop_top, self.crop_bottom),
        )
    }

    /// This layer's placement box size, in `canvas`-pixel space (D-193).
    /// `box_width`/`box_height`, when set, are a fraction of `canvas`
    /// directly — bypassing `natural`/`scale` entirely for that axis, which
    /// is what gives this override zero Rust/TS-export parity gap (see
    /// `Clip::box_width`'s own doc).
    ///
    /// **WIDTH with no override is `natural.0 * scale`** — the pre-D-193
    /// formula, unchanged, and deliberately NOT crop-adjusted: the exporter's
    /// width is `canvas_width * scale` whatever the crop is
    /// (`timelineExport.ts`'s `widthExpr`), so a crop must not enter here
    /// either.
    ///
    /// **HEIGHT with no override is that width times the CROPPED aspect
    /// ratio** — which is exactly what `buildClipFilterChain` asks ffmpeg for
    /// in the same case (`heightExpr = '-2'`: "compute the height from the
    /// real post-crop aspect ratio"). This is half of the B-218 fix. It used
    /// to be `natural.1 * scale`, the UNCROPPED source's aspect — the same
    /// number for every clip that is not cropped (every clip in every project
    /// authored before B-218, which is why nothing had ever diverged), and a
    /// wrong, too-short one for every clip that is.
    fn effective_size(&self, natural: (f64, f64), canvas: (u32, u32)) -> (f64, f64) {
        let scale = self.scale.max(0.0);
        let (cw, ch) = canvas;
        let w = self
            .box_width
            .map(|bw| bw * cw as f64)
            .unwrap_or(natural.0 * scale);
        let h = self.box_height.map(|bh| bh * ch as f64).unwrap_or_else(|| {
            let (kept_w, kept_h) = self.kept_fraction();
            let cropped_w = natural.0 * kept_w;
            if cropped_w <= 0.0 {
                // Cropped away on this axis — the caller's own
                // `crop_pixel_rect` guard has already returned before any of
                // this is painted; fall back to the uncropped formula rather
                // than dividing by zero.
                return natural.1 * scale;
            }
            w * (natural.1 * kept_h) / cropped_w
        });
        (w, h)
    }
}

/// Resolve `clip`'s transform at `source_frame`. Deliberately does NOT call
/// `chroma::keyframes::interpolated_parameters` — that reads
/// `chroma::state::current_video()`'s global "currently loaded video" frame,
/// the Colorist grading session's own state, which has nothing to do with
/// (and would usually disagree with) the specific source frame a timeline
/// clip is being composited at here. Calls the lower-level, frame-explicit
/// `parse_keyframes`/`interpolate` directly instead — same D-034 engine,
/// just not routed through the global-state-coupled wrapper. Keyframes are
/// authored relative to the clip's own SOURCE frame (matching the
/// convention every other keyframeable thing in this codebase — masks,
/// relight lights — already uses: "the current frame" of whatever's loaded,
/// which for a single clip IS its source frame).
///
/// **D-147 — the clip's fade multiplies into `opacity` last**, after the
/// static-or-keyframed value has been resolved, so a keyframed opacity
/// animation and the clip's own fade compose *multiplicatively* (clip opacity
/// keyframes × the fade handle — what a real NLE does, and the only order
/// under which neither silently overrides the other). The position within the
/// clip comes free and exactly: `source_frame - clip.source_start`, straight
/// out of `Track::clip_at`'s own definition (`source_start + (timeline_frame -
/// start_frame)`), so this needs no signature change. A clip with no fade
/// configured gets exactly `1.0` from `fade_multiplier_at` with no arithmetic
/// at all — the byte-identical-to-pre-D-147 guarantee.
///
/// Note this deliberately does NOT need a change to
/// [`ClipTransform::is_identity`]: the fade is already folded into `opacity`
/// by the time that runs, so a faded lone clip correctly fails the
/// `opacity >= 1.0` test and goes through the compositor instead of
/// [`timeline_frame`]'s plain-decode fast path — which is exactly the
/// D-132/B-053 lesson about a lone clip's transform being silently discarded.
fn resolve_clip_transform(clip: &Clip, source_frame: i64) -> ClipTransform {
    let mut t = resolve_clip_transform_unfaded(clip, source_frame);
    t.opacity *= clip.fade_multiplier_at(source_frame - clip.source_start);
    t
}

/// D-211 — [`resolve_clip_transform`] for a **text clip**: the same resolved
/// (static-or-keyframed, fade-multiplied) `opacity`/`position_x`/`position_y`,
/// with every other field pinned to its identity value.
///
/// **The pinning is the point, and it is not a shortcut.** The export half of
/// this feature compiles a text clip to ffmpeg's `drawtext`, which can place a
/// text box (`x`/`y` expressions), fade it (`alpha`), and nothing else — it
/// cannot scale, rotate or crop one. If the live preview honoured `scale` and
/// the export ignored it, the preview would be showing a picture the export
/// cannot produce: precisely the class of defect B-053 (a lone clip's
/// transform silently dropped in the preview), B-090 (a keyframed `scale`
/// silently dropped in the export) and B-094 each closed. Making the preview
/// deliberately match the narrower engine is what keeps "preview matches
/// export" a fact for Phase 1. Widening BOTH sides — by compiling a text clip
/// to a rasterised overlay input instead of `drawtext`, which then rides the
/// identical `overlay` chain a video layer does and gets every transform for
/// free — is the Phase 2 route, recorded in `docs/notes/text-title-clips.md`.
///
/// The GUI never offers those fields for a text clip and
/// `editor_set_clip_transform` refuses a non-default value for one, so this
/// is the third and last line of that defence, not the only one.
fn resolve_text_clip_transform(clip: &Clip, source_frame: i64) -> ClipTransform {
    let t = resolve_clip_transform(clip, source_frame);
    ClipTransform {
        opacity: t.opacity,
        position_x: t.position_x,
        position_y: t.position_y,
        scale: 1.0,
        box_width: None,
        box_height: None,
        rotation: 0.0,
        crop_left: 0.0,
        crop_top: 0.0,
        crop_right: 0.0,
        crop_bottom: 0.0,
        // D-344 — pinned for this function's own stated reason: the export
        // compiles a title to `drawtext`, which cannot mask its own corners,
        // so a preview that rounded one would be showing a picture the export
        // cannot produce.
        corner_radius: 0.0,
    }
}

/// [`resolve_clip_transform`] without D-147's fade multiply — the D-088/D-132
/// static-or-keyframed resolution on its own. Split out purely so the fade can
/// be applied at one place after every one of this function's three return
/// paths, rather than repeated at each.
pub(super) fn resolve_clip_transform_unfaded(clip: &Clip, source_frame: i64) -> ClipTransform {
    let base = ClipTransform {
        opacity: clip.opacity,
        position_x: clip.position_x,
        position_y: clip.position_y,
        scale: clip.scale,
        box_width: clip.box_width,
        box_height: clip.box_height,
        rotation: clip.rotation,
        crop_left: clip.crop_left,
        crop_top: clip.crop_top,
        crop_right: clip.crop_right,
        crop_bottom: clip.crop_bottom,
        corner_radius: clip.corner_radius,
    };
    let Some(kf_value) = &clip.chroma_keyframes else {
        return base;
    };
    // `parse_keyframes` expects the *containing* params object (it reads
    // `parameters.chromaKeyframes` off it) — `Clip::chroma_keyframes` stores
    // the array directly, so wrap it the one time this function needs to.
    let wrapped = serde_json::json!({ "chromaKeyframes": kf_value });
    let Some(keyframes) = super::keyframes::parse_keyframes(&wrapped) else {
        return base;
    };
    if keyframes.is_empty() {
        return base;
    }
    // D-208 (B-094) — resolve **one param at a time, over only the keys that
    // define it** (`interpolate_param`), not by frame-bracketing across every
    // key (`interpolate`). Per-property keyframing means a clip's keys really
    // do carry different param subsets at different frames, and the shared
    // mask resolver's "a field present in only one bracketing key is held
    // from that key" rule turns such a param's linear ramp into a step. This
    // is the same filter-then-interpolate order `timelineExport.ts`'s
    // `keyframeExprAt` already used, so preview and export agree by
    // construction. Byte-identical to the old call for any clip whose keys all
    // carry the same params — i.e. every pre-D-208 whole-clip key.
    let source_frame_u64 = source_frame.max(0) as u64;
    let f64_or = |key: &str, fallback: f64| {
        super::keyframes::interpolate_param(&keyframes, source_frame_u64, key)
            .and_then(|v| v.as_f64())
            .unwrap_or(fallback)
    };
    ClipTransform {
        opacity: f64_or("opacity", base.opacity),
        position_x: f64_or("position_x", base.position_x),
        position_y: f64_or("position_y", base.position_y),
        scale: f64_or("scale", base.scale),
        // D-193 — an override is itself independently keyframeable via its
        // own "box_width"/"box_height" params key (mirrors every field
        // above); a clip with NO override (`base.box_width`/`box_height`
        // both `None`) always stays `None` here too, regardless of the
        // keyframe data — there is nothing to interpolate FROM, and
        // inventing a value would silently turn an un-overridden clip into
        // an overridden one.
        box_width: base.box_width.map(|bw| f64_or("box_width", bw)),
        box_height: base.box_height.map(|bh| f64_or("box_height", bh)),
        rotation: f64_or("rotation", base.rotation),
        // D-132 — crop keyframes go through the same D-034 engine as every
        // other field here, which is the whole reason the crop insets are
        // four flat scalars on `Clip` rather than a nested rect (that
        // interpolator takes a flat `{name: number}` params object).
        crop_left: f64_or("crop_left", base.crop_left),
        crop_top: f64_or("crop_top", base.crop_top),
        crop_right: f64_or("crop_right", base.crop_right),
        crop_bottom: f64_or("crop_bottom", base.crop_bottom),
        // D-344 — keyframeable through the same D-034 engine as every field
        // above, and for the same reason it is a flat scalar rather than
        // anything richer. The exporter's own `geq` mask expression is
        // re-evaluated per frame, so an animated radius is a picture BOTH
        // engines can produce — which is the test D-211's pinned text fields
        // fail and this one passes.
        corner_radius: f64_or("corner_radius", base.corner_radius),
    }
}

/// D-226 — fold a [`VisibleLayer`]'s transition alpha into an already-resolved
/// [`ClipTransform`]'s opacity.
///
/// **Multiplied in last, after the clip's own static/keyframed opacity and its
/// D-147 fade** — the same multiplicative composition, and for the same reason:
/// a clip that is 50% opaque, half way through its own fade-out, and half way
/// through a dissolve is all three at once, and any ordering where one silently
/// replaces another would make two of the three controls appear broken. A layer
/// outside a transition has `alpha == 1.0` and this is exactly a no-op, so every
/// pre-D-226 frame is byte-identical.
fn with_transition_alpha(mut t: ClipTransform, alpha: f64) -> ClipTransform {
    t.opacity *= alpha.clamp(0.0, 1.0);
    t
}

/// D-226 — the transform for a dip-to-colour **plate**: identity geometry (it
/// is generated at exactly canvas size and covers the frame), carrying only the
/// transition's own alpha as its opacity.
///
/// Pinned rather than derived for [`resolve_text_clip_transform`]'s reason: a
/// plate has no clip behind it, so there is no `position`/`scale`/`crop` to
/// resolve, and the export path compiles it to a `color` source overlaid at
/// full frame — stating the identity here is what keeps the two engines
/// producing the same picture instead of one of them acquiring geometry the
/// other cannot express.
fn plate_transform(alpha: f64) -> ClipTransform {
    ClipTransform {
        opacity: alpha.clamp(0.0, 1.0),
        position_x: 0.0,
        position_y: 0.0,
        scale: 1.0,
        box_width: None,
        box_height: None,
        rotation: 0.0,
        crop_left: 0.0,
        crop_top: 0.0,
        crop_right: 0.0,
        crop_bottom: 0.0,
        // D-344 — a plate covers the whole frame; rounding its corners would
        // let the picture beneath show through at them, which is not what a
        // dip-to-colour is. The export overlays a full-frame `color` source
        // with no mask, so this pin is also what keeps the two engines equal.
        corner_radius: 0.0,
    }
}

/// Decode every layer (already visible + non-empty-source, see the caller)
/// and alpha-composite them onto one canvas. Paint order: `layers` arrives
/// in `resolve_visible_video_layers_at`'s index-ascending order (index 0 =
/// highest priority); this function decodes in that order but PAINTS in
/// reverse (lowest priority first, at the back; highest priority last, on
/// top) — matches `resolve_visible_video_layers_at`'s own documented paint
/// contract.
///
/// **The canvas is the COMPOSITION** (`comp`, in pixels — see
/// [`composition_size`]), downscaled to `max_long_edge` for the preview.
/// Each layer is sized at its own **natural footprint in composition
/// space** — its source pixel dimensions measured against the composition's
/// — times `scale`, and its TOP-LEFT corner is placed at
/// `position_x`/`position_y` as fractions of the canvas (D-338, fixes
/// B-201 — see [`composite_layer_onto`]). Not scaled to fill the canvas by default: a
/// lower-priority layer showing through at its own native size, like a
/// picture-in-picture, is the more useful default than a silent full-bleed
/// stretch, and that intent is unchanged from D-088 — what changed (D-136)
/// is that "native size" is now measured against a fixed composition
/// instead of against another layer's decode.
///
/// **Why that closes B-043.** The canvas used to be `decoded[0].img`'s
/// dimensions, i.e. the top layer decoded at whatever `max_long_edge` the
/// caller asked for, and `scale_target` returns `None` for a source already
/// under the cap. So the canvas changed size with the preview quality, with
/// the top layer's source resolution, and with which clip was on top at that
/// playhead — and `position_*`/`scale`, measured in that canvas's pixels,
/// changed meaning with it. Here `max_long_edge` only chooses how many
/// pixels the same composition is rendered into: every geometry field is a
/// ratio of the composition, so the picture is identical at every preview
/// quality up to resampling. Preview scale is a render-quality knob and
/// nothing else, which is what it always claimed to be.
fn composite_video_frame(
    layers: &[VisibleLayer<'_>],
    max_long_edge: Option<u32>,
    comp: (u32, u32),
    lane: decode_pipe::PipeLane,
) -> Result<DynamicImage, String> {
    /// One step of the paint walk. Was a plain struct (a layer always had
    /// pixels) until D-230 introduced a layer that has none and instead
    /// *operates on the canvas*, which is a different kind of step rather than
    /// a differently-configured one — so it is an enum now.
    enum Step {
        /// An ordinary picture layer: paint it onto the canvas.
        Paint {
            /// `Arc` (D-211) purely so a **rasterised text layer** — which
            /// `chroma::text` hands back from its own cache, shared with
            /// whatever other frame is showing the same title — needs no
            /// per-frame clone of a full canvas-sized buffer. A decoded video
            /// frame is owned outright and just gets wrapped; the cost is one
            /// allocation per layer per frame, against a memcpy of the whole
            /// buffer.
            img: std::sync::Arc<image::RgbaImage>,
            transform: ClipTransform,
            /// This layer's full-frame footprint on the canvas at
            /// `scale == 1.0`, in canvas pixels — its source size mapped
            /// through the composition.
            natural: (f64, f64),
        },
        /// D-230 — an **adjustment clip**: apply this colour operator to the
        /// canvas as it stands, which is precisely every layer below this one,
        /// since the paint walk runs back-to-front. Nothing is drawn.
        Adjust(apelles_timeline::AdjustmentOps),
    }

    let (comp_w, comp_h) = comp;
    let (canvas_w, canvas_h) = max_long_edge
        .and_then(|le| decode_pipe::scale_target(comp_w, comp_h, le))
        .unwrap_or((comp_w, comp_h));
    // One uniform ratio for both axes (from the width): `scale_target`
    // preserves aspect apart from its even-dimension rounding, and deriving
    // x and y independently would let that ±1 px turn into a visible
    // anisotropic squash on every layer.
    let render_scale = canvas_w as f64 / comp_w as f64;

    let mut decoded: Vec<Step> = Vec::with_capacity(layers.len());
    for layer in layers {
        // D-226 — a generated full-frame plate: a dip-to-colour transition's
        // colour, at the canvas's own size, with the transition's own alpha as
        // its opacity. Structurally the same "generated layer" case D-211's text
        // clip already established (`natural` is the canvas, no resize step
        // runs), which is why it needs no new step in the paint loop below —
        // only its own way of producing a buffer.
        if let LayerSource::Color { rgb } = layer.source {
            let (r, g, b) = rgb;
            decoded.push(Step::Paint {
                img: std::sync::Arc::new(image::ImageBuffer::from_pixel(
                    canvas_w,
                    canvas_h,
                    image::Rgba([r, g, b, 255]),
                )),
                transform: plate_transform(layer.alpha),
                natural: (canvas_w as f64, canvas_h as f64),
            });
            continue;
        }
        let LayerSource::Clip {
            clip,
            source_frame,
            role,
        } = &layer.source
        else {
            unreachable!("the Color arm returns above");
        };
        let track = layer.track;
        // D-230 — an ADJUSTMENT clip contributes no picture. It becomes a
        // `Step::Adjust` in the same ordered list, so the reverse walk below
        // reaches it at exactly its own z-position and applies it to the canvas
        // built from every layer below — no separate ordering rule, the same
        // way D-213's `drawtext` splices into the export's overlay chain.
        //
        // An adjustment whose correction provably does nothing (`None` from
        // `adjustment_ops`) is dropped here rather than pushed, so a
        // freshly-added, untouched adjustment clip costs the preview exactly
        // one skipped branch per frame and not a full-canvas pass.
        if clip.is_adjustment() {
            if let Some(ops) = clip.adjustment_ops() {
                decoded.push(Step::Adjust(ops));
            }
            continue;
        }
        // D-211 — a text clip's layer is GENERATED, not decoded: rasterise it
        // at the canvas's own size (so `natural` is the canvas and no resize
        // step runs) and let everything downstream — the paint order, the
        // position offset, the opacity/fade multiply — treat it exactly like
        // a decoded one. `resolve_text_clip_transform` is what keeps that
        // "exactly like" honest by zeroing the fields the export path cannot
        // reproduce; see its own doc.
        if let Some(text_layer) = &clip.text {
            decoded.push(Step::Paint {
                img: text::render_text_layer(text_layer, canvas_w, canvas_h)?,
                // No `scaled_to_render` (D-344): a text clip's radius is pinned
                // to zero by `resolve_text_clip_transform`, and zero is
                // scale-invariant — stating the conversion here would only
                // suggest there is something to convert.
                transform: with_transition_alpha(
                    resolve_text_clip_transform(clip, *source_frame),
                    layer.alpha,
                ),
                natural: (canvas_w as f64, canvas_h as f64),
            });
            continue;
        }
        let source_size = clip_source_size(&clip.source_path)?;
        // One decode pipe per track (D-125/B-040) — sharing a single global
        // pipe across layers made every layer after the first respawn ffmpeg
        // (different path, or the same path stepping backwards), which is what
        // reduced this whole path to ~0.85 fps. D-226 — and one more per track
        // while a cross dissolve is running there, for that same reason applied
        // within a single track; see `pipe_slot`. D-292 — a STILL layer takes
        // no slot at all and never reaches `decode_pipe`; see
        // `decode_clip_rgba`.
        let mut rgba = decode_clip_rgba(
            &clip.source_path,
            source_size,
            lane,
            pipe_slot(track, *role),
            (*source_frame).max(0) as u64,
            max_long_edge,
        )?;
        // D-256 — **the Colorist grade, applied here.** On this clip's own
        // decoded pixels, before any geometry, because that is what a grade is:
        // a property of the clip's picture, not of where it sits in the
        // composition. The ffmpeg exporter puts its `lut3d` node at exactly the
        // same point in the per-clip chain (before `crop`/`scale`), which is
        // what makes the two engines agree on order as well as on maths — and
        // since a 3D LUT is per-pixel it commutes with `crop` exactly anyway,
        // so only the resample is order-sensitive and both engines resample
        // after.
        //
        // Costs a memo lookup + one `metadata()` stat per layer per frame for
        // an ungraded clip, and nothing else — `lut_for_clip` returns `None`
        // before touching the GPU when there is no grade file, which is every
        // clip in every project that has never been near the Colorist tab.
        //
        // D-292 — `Arc::make_mut` rather than a plain `&mut`: a STILL's buffer
        // is the decode cache's own, shared with whatever other frame is
        // showing the same still, so grading it in place would corrupt the
        // cache. `make_mut` copies exactly when the buffer is shared and not
        // otherwise — so a still pays one copy only when it is actually graded,
        // and a freshly decoded video frame (refcount 1) is still graded in
        // place, byte-identically to before.
        if let Some(lut) = grade_lut::lut_for_clip(&clip.id) {
            grade_lut::apply_to_rgba(std::sync::Arc::make_mut(&mut rgba), &lut);
        }
        // D-396 — **the clip's highlighter strokes**, drawn on the decoded
        // picture after the grade and before any geometry, so they follow every
        // crop, push-in and rotation. The ffmpeg exporter's `geq` nodes sit at
        // exactly this point in the per-clip chain (after `lut3d`, before
        // `crop`). A clip with none costs one empty-slice check.
        highlighted_picture(&clip.id, &mut rgba, &clip.highlights, *source_frame);
        decoded.push(Step::Paint {
            img: rgba,
            // D-344 — `corner_radius` is the one geometry field authored in
            // OUTPUT pixels rather than as a ratio, so it is the one that has
            // to ride `render_scale` explicitly; see
            // `ClipTransform::scaled_to_render`. Exactly the same `render_scale`
            // `natural` below is built from, so a rounded box and its rounding
            // can never disagree about which canvas they are in.
            transform: with_transition_alpha(
                resolve_clip_transform(clip, *source_frame).scaled_to_render(render_scale),
                layer.alpha,
            ),
            // The layer's **source** size, not its decoded size — that is the
            // whole point: the decoded size follows the preview quality, the
            // source size does not.
            natural: (
                source_size.0 as f64 * render_scale,
                source_size.1 as f64 * render_scale,
            ),
        });
    }

    let mut canvas: image::RgbaImage =
        image::ImageBuffer::from_pixel(canvas_w, canvas_h, image::Rgba([0, 0, 0, 255]));

    for step in decoded.iter().rev() {
        match step {
            Step::Paint {
                img,
                transform,
                natural,
            } => composite_layer_onto(&mut canvas, img, transform, *natural),
            // D-230 — the whole adjustment-clip compositing model, in one line:
            // the canvas at this point in the reverse walk IS "every layer
            // beneath this clip", so applying the operator to it is exactly the
            // documented behaviour, with no scoping logic of its own.
            Step::Adjust(ops) => apply_adjustment_to_canvas(&mut canvas, ops),
        }
    }

    Ok(DynamicImage::ImageRgba8(canvas))
}

/// D-230 — apply an adjustment clip's colour operator to the whole canvas.
///
/// **Whole canvas, deliberately.** The correction is full-frame: it reaches
/// letterboxed/empty regions (which are the black backdrop) exactly as it
/// reaches picture, because that is what the ffmpeg export does — there the
/// filter sits on the composited stream, which includes `[base]`. Preview and
/// export agreeing matters more here than the arguably-tidier alternative of
/// masking the effect to where picture happens to be, which the export could
/// not reproduce without a per-layer alpha pass it does not have.
///
/// Alpha is untouched: the operator is a colour correction, and the canvas is
/// opaque by construction (it starts as opaque black).
fn apply_adjustment_to_canvas(
    canvas: &mut image::RgbaImage,
    ops: &apelles_timeline::AdjustmentOps,
) {
    // D-351 — by row, like `grade_lut::apply_to_rgba` (which this pass is the
    // adjustment-clip twin of) has always done. A full-canvas colour operator on
    // one thread is a 4K frame's worth of per-pixel maths per adjustment clip
    // per frame.
    let stride = canvas.width() as usize * 4;
    for_each_row_mut(canvas.as_mut(), stride, |_, row| {
        for px in row.as_chunks_mut::<4>().0 {
            let [r, g, b] = ops.apply_rgb8([px[0], px[1], px[2]]);
            px[0] = r;
            px[1] = g;
            px[2] = b;
        }
    });
}

/// The **kept** (un-cropped) region of a `w`×`h` layer under `t`'s normalised
/// insets, as an exclusive `(x0, y0, x1, y1)` pixel rect in the layer's own
/// space — D-132.
///
/// Returns `None` when the crop leaves nothing to paint (insets summing to
/// ≥ 1 on either axis, or rounding to an empty span on a small layer). The
/// clamp to `0.0..=1.0` lives here, at the point of use, for the reason
/// `Clip::crop_left`'s own doc gives: the model stores what the UI wrote and
/// the consumer decides what it means, exactly as `opacity` already does one
/// line below its own read.
///
/// **Normalised in, pixels out, per decoded layer** — which is what makes the
/// crop invariant under `PreviewPane`'s 960-while-scrubbing / 640-while-
/// playing decode scales (B-043's failure mode for `position_*`, avoided here
/// by construction rather than fixed after the fact).
fn crop_pixel_rect(w: u32, h: u32, t: &ClipTransform) -> Option<(u32, u32, u32, u32)> {
    let span = |size: u32, near: f64, far: f64| -> (u32, u32) {
        let s = size as f64;
        let lo = (s * near.clamp(0.0, 1.0)).round() as u32;
        let hi = size.saturating_sub((s * far.clamp(0.0, 1.0)).round() as u32);
        (lo, hi)
    };
    let (x0, x1) = span(w, t.crop_left, t.crop_right);
    let (y0, y1) = span(h, t.crop_top, t.crop_bottom);
    (x1 > x0 && y1 > y0).then_some((x0, y0, x1, y1))
}

/// D-344 — how much of the pixel whose top-left corner is `(x, y)` a
/// `w`×`h` placement box rounded to radius `r` covers: `1.0` well inside,
/// `0.0` well outside, a linear one-pixel ramp across the corner arc.
/// All four arguments are in the placement box's OWN pixel space.
///
/// **This is the canonical rounded-box signed distance field** (the
/// `sdRoundedBox` every SDF reference states — `q = |p| - (half - r)`,
/// `length(max(q, 0)) + min(max(q.x, q.y), 0) - r`), not a hand-derived
/// corner test, per CLAUDE.md's "don't hand-roll what a known-good formula
/// already solves". Using the real SDF rather than the obvious
/// "distance from the corner circle's centre" is not pedantry: the naive form
/// has no defined value on the straight edges, so it needs a special case
/// there — and that special case is exactly what broke `r == 0`, which under
/// the naive expression silently halved the alpha of the ENTIRE layer instead
/// of doing nothing (caught against real ffmpeg before either engine was
/// written; see `docs/notes/rounded-corners.md`). The SDF form needs no
/// special case and is an exact identity at `r == 0` by construction, which is
/// what makes this feature's "zero is byte-identical" guarantee hold for a
/// KEYFRAMED radius passing through zero too, not just for a clip that never
/// sets one.
///
/// `+ 0.5` on both the pixel centre and the coverage threshold is the
/// half-pixel convention that makes the box span `0..w` (full pixel coverage)
/// rather than `0..w-1` (pixel centres): without it the outermost row and
/// column would come back half-covered even at `r == 0`.
///
/// `r` is clamped to `0 ..= min(w, h) / 2` here, at the point of use, exactly
/// as [`crop_pixel_rect`] clamps the crop insets and for the same stated
/// reason — the model stores what the UI wrote, the consumer decides what it
/// means. An over-large radius therefore becomes a pill or a circle (what CSS
/// `border-radius` does with one) rather than a degenerate shape.
///
/// **The ffmpeg exporter computes this identical expression** in its `geq`
/// alpha mask (`timelineExport.ts`'s `cornerRadiusMaskExpr`) — same formula,
/// same clamp, same half-pixel convention — which is what makes the two
/// engines agree to within ffmpeg's own 1/255 quantisation rather than
/// "approximately".
fn corner_coverage(x: f64, y: f64, w: f64, h: f64, r: f64) -> f32 {
    // The SDF itself lives in `apelles-types` (D-396) now that clip highlights
    // share it; this stays as the call sites' local name.
    apelles_types::shape::rounded_box_coverage(x, y, w, h, r)
}

/// Crop → scale → **round the corners** → rotate → apply opacity (as an alpha
/// multiply) → overlay `layer` onto `canvas`, with its TOP-LEFT corner at
/// `transform`'s `position_x`/`position_y` (canvas fractions). Real
/// arbitrary-angle rotation via `imageproc::geometric_transformations::
/// rotate_about_center` — the exact same function + transparent-border
/// pattern `image_processing.rs`'s own `apply_rotation` already uses for
/// the Colorist's rotate adjustment, not a second rotation implementation.
///
/// **Crop is first, and the crop is what gets scaled** (D-132, corrected by
/// B-218). The crop insets select a sub-rectangle of the layer, and it is
/// that sub-rectangle — not the whole layer with some of its alpha zeroed —
/// that is resized into the placement box and placed at `position_*`. That
/// is `crop` then `scale`, which is the order `capabilities.json` has always
/// documented, the order the ffmpeg exporter has always compiled
/// (`crop=...` → `scale=...` → `overlay=...`, `timelineExport.ts`'s
/// `buildClipFilterChain`), and — until B-218 was fixed — NOT the order this
/// function actually performed.
///
/// **What B-218 was.** This used to zero the alpha of the cropped-away pixels
/// and resize the layer's FULL footprint into the box, on D-132's reasoning
/// that a crop should behave like Premiere's Crop effect and Resolve's Crop
/// mode — the remaining picture staying where it was rather than re-centring
/// as an edge is dragged in. Self-consistent, but it means a cropped layer
/// covers only the crop's own fraction of its box, while the export fills the
/// box: `crop_left 0.35, crop_right 0.35, scale 0.30` measured `0.091 × 0.302`
/// of canvas here against the `0.30 × <cropped height>` the docs promise and
/// the export produces. The preview moved to meet the exporter for the same
/// reason D-338 did with `position_*`: ffmpeg's is the external convention,
/// the export is what actually ships, and the documented recipe for landing a
/// clip in an exact box is built on it. A caller who wants the in-place
/// reading still has it — shrink the box by the kept fraction and offset
/// `position_*` by the crop — whereas under the old reading "fill this box
/// with the cropped picture" was not expressible at all.
///
/// One consequence worth stating: `rotation` now pivots about the CROP's
/// centre rather than the layer's full-frame centre, because the buffer it
/// rotates is the crop. That matches the export, where `rotate` likewise acts
/// on the cropped, scaled box.
///
/// `natural` (D-136) is this layer's full-frame footprint on `canvas` at
/// `scale == 1.0`, in canvas pixels — computed by the caller from the
/// layer's SOURCE resolution and the composition, never from `layer`'s own
/// decoded dimensions. That indirection is the fix for B-043's second half:
/// resizing the decoded buffer by a plain `scale` made a layer's on-screen
/// size follow the preview's decode quality (a 640×360 source under a
/// 960-px cap isn't downscaled at all, so it was two thirds of a 4K-derived
/// canvas at one quality and the entire canvas at another). The decoded
/// buffer's size now only affects sharpness.
///
/// **`position_x`/`position_y` are the layer's TOP-LEFT corner, as a fraction
/// of the canvas** — `(0, 0)` puts the layer in the canvas's top-left corner,
/// `(0.5, 0.5)` starts it at the canvas's midpoint. **D-338 changed this**
/// (fixes B-201): until then this function centred the layer and treated
/// `position_*` as an offset FROM that centre (`cw/2 - sw/2 + position_x*cw`),
/// while the ffmpeg exporter has always compiled the same field to
/// `overlay=x='<position_x>*W'`, i.e. the top-left corner. The two engines
/// therefore disagreed by exactly `(1 - box_fraction)/2` per axis on every
/// non-full-frame layer, silently, with each side self-consistent. The
/// export's reading is ffmpeg's own external convention and is depended on by
/// the stacked comparison recipe `capabilities.json` documents, so the preview
/// moved to meet it.
///
/// Consequences worth stating, because they follow from the formula and not
/// from any extra code here:
/// - a layer that exactly covers the canvas (`box_width`/`box_height` `1.0`,
///   or a source whose footprint is the whole composition) renders
///   byte-identically to before at `position (0, 0)` — both readings give
///   `x = 0`. That is why every existing project keeps rendering as it did;
///   see D-338 for the verification against the real saved projects.
/// - a **text** layer is generated at exactly canvas size with `scale` pinned
///   to `1.0` (see `resolve_text_clip_transform` and `composite_video_frame`'s
///   text arm), so it is the same identity: `cw/2 - cw/2 + px*cw == px*cw`.
///   Titles are untouched by this change, and still agree with `drawtext`'s
///   own centred-plus-offset placement on the export side.
/// - `scale` now grows a layer about its top-left corner rather than about the
///   canvas centre — which is what the exporter has always done, so this is
///   the same divergence being closed rather than a new one. The GUI's corner
///   drag keeps growing a box about its own centre by writing the
///   compensating `position_*` (`transformGeometry.ts`'s
///   `dragCornerReposition`), so the gesture is unchanged for a human.
///
/// **D-344 — the corner-radius mask sits between `scale` and `rotate`**, and
/// that position is the whole of its definition. Rounding is a property of the
/// layer's PLACEMENT BOX, so it has to be applied once the box's real
/// on-canvas size `(sw, sh)` is known (after `scale`/`box_*`) and while the box
/// is still axis-aligned (before `rotate`) — a rotated clip's rounded corners
/// then rotate with it, which is the only reading of "this clip has rounded
/// corners" that survives a rotation. It multiplies the alpha plane rather than
/// replacing it, exactly as `opacity` does below, so a cropped, rounded,
/// half-opaque, dissolving clip is all four at once. `corner_radius <= 0.0`
/// emits no work at all — not a pass over the buffer, not a branch inside one —
/// which is what makes the default byte-identical to the pre-D-344 path.
/// `timelineExport.ts` puts its own `geq` mask node at the matching point in
/// the export chain (after `scale`, before `rotate`), for the same reasons.
pub(super) fn composite_layer_onto(
    canvas: &mut image::RgbaImage,
    layer: &image::RgbaImage,
    t: &ClipTransform,
    natural: (f64, f64),
) {
    let opacity = t.opacity.clamp(0.0, 1.0) as f32;
    if opacity <= 0.0 {
        return; // fully transparent — nothing to paint, skip the work
    }

    let (lw, lh) = layer.dimensions();
    let Some((cx0, cy0, cx1, cy1)) = crop_pixel_rect(lw, lh, t) else {
        return; // cropped away entirely — nothing to paint
    };
    let cropped = (cx0, cy0, cx1, cy1) != (0, 0, lw, lh);
    // B-218 — the crop's own pixel size. This, not the layer's full size, is
    // what gets resized into the placement box: crop happens BEFORE scale, the
    // order `capabilities.json` has always documented and the exporter has
    // always compiled (`crop=...` then `scale=...`).
    let (crop_w, crop_h) = (cx1 - cx0, cy1 - cy0);
    // D-193 — `box_width`/`box_height` (canvas-fraction, when set) override
    // `natural * scale` per axis independently; see `ClipTransform::
    // effective_size`'s own doc for the full "why".
    let (raw_w, raw_h) = t.effective_size(natural, canvas.dimensions());
    let (sw, sh) = (raw_w.round().max(1.0) as u32, raw_h.round().max(1.0) as u32);

    // D-217 — the magnified / 1:1 case goes straight onto the canvas instead of
    // through a full-size intermediate buffer. This is the preview's single
    // dominant cost: measured on the owner's own reel (two 2940×1670 layers in
    // a 1080×1920 canvas at the 960 px preview cap), `image::imageops::resize`
    // was ~16 ms per layer of a ~43 ms frame — 74% of it — because the layer is
    // enlarged to its full on-canvas footprint (1470×835 at `scale == 1`,
    // 1911×1086 at the reel's keyframed `scale == 1.3`) and `overlay` then
    // throws most of those pixels away against a 540×960 canvas. Sampling
    // bounds the work by what the canvas can actually show, and at a ratio ≥ 1
    // it is not an approximation: `Triangle`'s support collapses to the same
    // two taps per axis that a bilinear fetch uses, so this produces the same
    // picture. A genuine **minification** keeps the `resize` path below — its
    // output buffer is smaller than the source there, so the waste it can carry
    // is bounded anyway, and `Triangle`'s widening support is real area
    // filtering that a naive bilinear sample would alias against.
    if t.rotation == 0.0 && sw >= crop_w && sh >= crop_h {
        let (cw, ch) = canvas.dimensions();
        // Same placement arithmetic as the general path's `overlay` call below
        // — the layer's TOP-LEFT corner at `position_*` of the canvas (D-338,
        // fixes B-201; see this function's own doc). The work buffer's size
        // does not enter into it, which is exactly why the two paths agree
        // without this branch having to reconstruct `(ww, wh)`.
        let x = t.position_x * cw as f64;
        let y = t.position_y * ch as f64;
        blend_layer_sampled(
            canvas,
            layer,
            (cx0, cy0, cx1, cy1),
            (sw, sh),
            (x, y),
            opacity,
            t.corner_radius,
        );
        return;
    }

    // The un-cropped branch is byte-for-byte the pre-D-132 path — no extra
    // buffer, no per-pixel pass — so an uncropped clip (every clip in every
    // existing project) costs exactly what it did before.
    //
    // B-218 — the cropped branch takes the crop's SUB-IMAGE and resizes THAT
    // into the placement box, rather than alpha-masking the full layer and
    // resizing the whole thing. Two things follow, both of which are the fix:
    // the kept picture fills the box (crop-then-scale, ffmpeg's order and the
    // documented one) instead of occupying only the sub-rectangle of it the
    // crop happened to leave, and the crop edge is hard rather than feathered
    // — which is what ffmpeg's own `crop` produces, so the two engines now
    // agree there too. It is also strictly less work than the old path: no
    // full-layer clone, no per-pixel alpha pass, and the resize input is the
    // crop rather than the whole frame.
    // D-351 — `Cow`, not an unconditional clone. A full-frame layer with no
    // crop, no resize, no rounding, no rotation and full opacity — the base
    // layer of every composition, on every frame — reached `layer.clone()` here
    // and then had `overlay` read the copy: a whole canvas memcpy per frame
    // (33 MB at 4K) whose result is byte-identical to what it was copied from.
    // `to_mut()` below still copies exactly when one of those passes really is
    // going to write, so nothing that mutates `work` changed.
    let mut work: std::borrow::Cow<'_, image::RgbaImage> = if cropped {
        let sub = image::imageops::crop_imm(layer, cx0, cy0, crop_w, crop_h).to_image();
        std::borrow::Cow::Owned(if (sw, sh) != (crop_w, crop_h) {
            image::imageops::resize(&sub, sw, sh, image::imageops::FilterType::Triangle)
        } else {
            sub
        })
    } else if (sw, sh) != (lw, lh) {
        std::borrow::Cow::Owned(image::imageops::resize(
            layer,
            sw,
            sh,
            image::imageops::FilterType::Triangle,
        ))
    } else {
        std::borrow::Cow::Borrowed(layer)
    };

    // D-344 — round the placement box's corners, here: `work` is now exactly
    // the box at its real on-canvas size `(sw, sh)` and is still axis-aligned,
    // which is the only point in this pipeline where both are true. See this
    // function's own doc for why that position is the definition rather than a
    // convenience, and [`corner_coverage`] for the formula and its clamp.
    //
    // A multiply into the existing alpha, never a replace, so this composes
    // with the crop mask above it exactly the way `opacity` below composes with
    // both: a cropped-away pixel is already alpha 0 and must not be un-hidden.
    if t.corner_radius > 0.0 {
        let work = work.to_mut();
        let (ww, wh) = work.dimensions();
        let (fw, fh) = (ww as f64, wh as f64);
        let radius = t.corner_radius;
        let stride = ww as usize * 4;
        // D-351 — the same per-pixel coverage multiply, by row. `corner_coverage`
        // is a pure function of `(x, y, w, h, r)`, so a row depends on nothing
        // another row writes.
        for_each_row_mut(work.as_mut(), stride, |y, row| {
            for (x, px) in row.as_chunks_mut::<4>().0.iter_mut().enumerate() {
                let cov = corner_coverage(x as f64, y as f64, fw, fh, radius);
                if cov < 1.0 {
                    px[3] = (px[3] as f32 * cov).round().clamp(0.0, 255.0) as u8;
                }
            }
        });
    }

    if t.rotation != 0.0 {
        let rgba32f = DynamicImage::ImageRgba8(work.into_owned()).to_rgba32f();
        let rotated = imageproc::geometric_transformations::rotate_about_center(
            &rgba32f,
            (t.rotation as f32) * std::f32::consts::PI / 180.0,
            imageproc::geometric_transformations::Interpolation::Bilinear,
            imageproc::geometric_transformations::Border::Constant(image::Rgba([
                0.0f32, 0.0, 0.0, 0.0,
            ])),
        );
        work = std::borrow::Cow::Owned(DynamicImage::ImageRgba32F(rotated).to_rgba8());
    }

    if opacity < 1.0 {
        let work = work.to_mut();
        let stride = work.width() as usize * 4;
        for_each_row_mut(work.as_mut(), stride, |_, row| {
            for p in row.as_chunks_mut::<4>().0 {
                p[3] = (p[3] as f32 * opacity).round().clamp(0.0, 255.0) as u8;
            }
        });
    }

    let (cw, ch) = canvas.dimensions();
    // D-136 — `position_*` is a fraction of the composition, so it scales
    // with the canvas: the same stored value lands on the same part of the
    // picture at every preview quality. Per-axis (x against the width, y
    // against the height), matching the crop insets' own convention.
    //
    // D-338 (fixes B-201) — and it names the layer's TOP-LEFT corner, not an
    // offset from the canvas centre, so this is `position * canvas` and
    // nothing else: literally ffmpeg's `overlay=x='<position_x>*W'`, which is
    // what the exporter has always compiled. The work buffer's own size no
    // longer appears in the placement at all, which is the whole point — it
    // is what made the old formula disagree with the export by half the
    // layer's size.
    let x = t.position_x * cw as f64;
    let y = t.position_y * ch as f64;
    overlay_parallel(canvas, &work, x.round() as i64, y.round() as i64);
}

/// Paint a layer onto `canvas` at `dest_size`, scaling it by direct bilinear
/// sampling and touching **only the canvas pixels it can actually cover**
/// (D-217).
///
/// What it is: the enlarge-and-blend inner loop of [`composite_layer_onto`]'s
/// no-rotation, ratio-≥-1 fast path — crop, scale, opacity and source-over
/// blend fused into one pass whose cost is bounded by the canvas rather than
/// by the layer's (arbitrarily large) on-canvas footprint.
///
/// `crop` is the SOURCE RECTANGLE this box samples, not a mask over the whole
/// layer (B-218): `dest_size` maps onto `crop`'s extent, so the kept picture
/// fills the box exactly as `crop=...`-then-`scale=...` does in the export.
/// The caller's own ratio-≥-1 guard is therefore against the CROP's size, not
/// the layer's.
///
/// What it does NOT do: rotation (the caller keeps that on the general path,
/// which needs a whole rotated buffer), and **minification** — a ratio below 1
/// needs `Triangle`'s widening support to avoid aliasing, and a plain bilinear
/// fetch would not give it. Both are the caller's own guard conditions.
///
/// `origin` is the layer's unrounded top-left on the canvas; it is rounded here
/// exactly the way `image::imageops::overlay` rounds it on the general path, so
/// a clip does not shift by a pixel depending on which path it took. The sample
/// position `(o + 0.5) * ratio - 0.5` is the one `image::imageops::resize`
/// itself uses, so at ratio ≥ 1 the two agree pixel for pixel.
///
/// `corner_radius` (D-344) is folded into the same fused pass rather than
/// costing a second one — this path exists precisely to avoid materialising a
/// full-size intermediate buffer, and masking one into existence just to round
/// its corners would give that back. It is evaluated in the destination box's
/// own space (`px - ox`, `py - oy` against `dest_size`), which is the identical
/// grid the general path's `work` buffer uses, so the two paths produce the
/// same coverage for the same clip — `ox`/`oy` are the same rounded origin
/// `overlay` would have placed that buffer at.
fn blend_layer_sampled(
    canvas: &mut image::RgbaImage,
    layer: &image::RgbaImage,
    crop: (u32, u32, u32, u32),
    dest_size: (u32, u32),
    origin: (f64, f64),
    opacity: f32,
    corner_radius: f64,
) {
    use image::Pixel as _;

    let (cw, ch) = canvas.dimensions();
    // Only the WIDTH of the layer is needed now (B-218): it is the row stride
    // for the byte offsets below. The sampling extent is the CROP's, not the
    // layer's — see this function's own doc.
    let lw = layer.width();
    let (sw, sh) = dest_size;
    let (ox, oy) = (origin.0.round() as i64, origin.1.round() as i64);

    // The visible window: the layer's footprint clipped to the canvas. Empty
    // means the layer is entirely off-canvas — which the old path still paid a
    // full-size resize for before `overlay` discarded all of it.
    let vx0 = ox.max(0);
    let vy0 = oy.max(0);
    let vx1 = (ox + sw as i64).min(cw as i64);
    let vy1 = (oy + sh as i64).min(ch as i64);
    if vx1 <= vx0 || vy1 <= vy0 {
        return;
    }

    // D-344 — resolved once for the whole window, not per pixel: an un-rounded
    // clip (every clip in every pre-D-344 project) never evaluates the SDF at
    // all, it multiplies by a constant `1.0` the optimiser folds away.
    let rounding = |bx: i64, by: i64| -> f32 {
        if corner_radius <= 0.0 {
            return 1.0;
        }
        corner_coverage(bx as f64, by as f64, sw as f64, sh as f64, corner_radius)
    };

    // B-218 — the source rectangle this box samples is the CROP, not the whole
    // layer: `rx`/`ry` map the destination box onto the crop's own extent and
    // every tap is offset by, and clamped to, the crop's bounds. That is
    // crop-then-scale — the kept picture fills the box — where this used to map
    // the box onto the FULL layer and merely zero the alpha of taps that landed
    // outside the crop, which left the kept picture occupying only the crop's
    // own sub-fraction of the box. The general (minifying / rotated) path above
    // does the same thing by resizing the crop's sub-image.
    let (cx0, cy0, cx1, cy1) = crop;
    let rx = (cx1 - cx0) as f64 / sw as f64;
    let ry = (cy1 - cy0) as f64 / sh as f64;
    let src = layer.as_raw();
    let stride = lw as usize * 4;
    let last_x = cx1 as i64 - 1;
    let last_y = cy1 as i64 - 1;

    // Per-column sample state, computed once for the whole window rather than
    // once per row — this loop runs up to canvas-many times.
    struct Col {
        i0: usize,
        i1: usize,
        fx: f32,
    }
    // A tap that falls outside the crop reads the crop's edge texel, exactly as
    // `resize` reaches the same place from the other side (it drops
    // out-of-range taps and renormalises what is left).
    let cols: Vec<Col> = (vx0..vx1)
        .map(|px| {
            let u = ((px - ox) as f64 + 0.5) * rx - 0.5 + cx0 as f64;
            let ux = u.floor();
            let x0 = (ux as i64).clamp(cx0 as i64, last_x);
            let x1 = (ux as i64 + 1).clamp(cx0 as i64, last_x);
            Col {
                i0: x0 as usize * 4,
                i1: x1 as usize * 4,
                fx: (u - ux) as f32,
            }
        })
        .collect();

    // D-351 — one destination row per unit of work. Every tap this loop reads is
    // in `layer` (immutable) and every pixel it writes is on its own row, so the
    // split changes the schedule and nothing else: each output pixel is the same
    // expression of the same inputs it was before.
    let canvas_stride = cw as usize * 4;
    let band = &mut canvas.as_mut()[vy0 as usize * canvas_stride..vy1 as usize * canvas_stride];
    for_each_row_mut(band, canvas_stride, |ri, crow| {
        let py = vy0 + ri as i64;
        let v = ((py - oy) as f64 + 0.5) * ry - 0.5 + cy0 as f64;
        let vy = v.floor();
        let fy = (v - vy) as f32;
        let y0 = (vy as i64).clamp(cy0 as i64, last_y);
        let y1 = (vy as i64 + 1).clamp(cy0 as i64, last_y);
        let row0 = y0 as usize * stride;
        let row1 = y1 as usize * stride;

        for (i, px) in (vx0..vx1).enumerate() {
            let c = &cols[i];
            // The four taps. Every one of them is inside the crop by
            // construction (B-218 — the indices above are clamped to it), so
            // there is no mask to apply and the crop edge is hard, matching
            // ffmpeg's own `crop` and the general path's sub-image resize.
            let tap = |base: usize, off: usize| -> [f32; 4] {
                let p = &src[base + off..base + off + 4];
                [p[0] as f32, p[1] as f32, p[2] as f32, p[3] as f32]
            };
            let p00 = tap(row0, c.i0);
            let p10 = tap(row0, c.i1);
            let p01 = tap(row1, c.i0);
            let p11 = tap(row1, c.i1);

            let mut out = [0f32; 4];
            for ch in 0..4 {
                let top = p00[ch] + (p10[ch] - p00[ch]) * c.fx;
                let bot = p01[ch] + (p11[ch] - p01[ch]) * c.fx;
                out[ch] = top + (bot - top) * fy;
            }
            // D-344 — the rounded-box coverage for this destination pixel, in
            // the placement box's own space. `rounding` is `1.0` for every
            // un-rounded clip (the guard above computes nothing at all then),
            // so this multiply is an exact no-op and the pre-D-344 arithmetic
            // is preserved bit for bit.
            let a = (out[3] * opacity * rounding(px - ox, py - oy))
                .round()
                .clamp(0.0, 255.0) as u8;
            if a == 0 {
                continue; // fully transparent sample — nothing to blend
            }
            let sample = image::Rgba([
                out[0].round().clamp(0.0, 255.0) as u8,
                out[1].round().clamp(0.0, 255.0) as u8,
                out[2].round().clamp(0.0, 255.0) as u8,
                a,
            ]);
            let o = px as usize * 4;
            let dst = image::Rgba::from_slice_mut(&mut crow[o..o + 4]);
            if a == 255 {
                *dst = sample; // an opaque source-over is a plain replace
            } else {
                dst.blend(&sample);
            }
        }
    });
}

#[cfg(test)]
mod composite_tests {
    use super::*;
    use image::{ImageBuffer, Rgba};

    fn flat(w: u32, h: u32, px: [u8; 4]) -> image::RgbaImage {
        ImageBuffer::from_pixel(w, h, Rgba(px))
    }

    /// A deterministic, NON-flat test image — flat colours would let a wrong
    /// pixel index pass every comparison below, which is precisely the class of
    /// mistake a row split can make.
    fn noisy(w: u32, h: u32, seed: u32) -> image::RgbaImage {
        ImageBuffer::from_fn(w, h, |x, y| {
            let v = |k: u32| {
                ((x.wrapping_mul(2654435761)
                    .wrapping_add(y.wrapping_mul(40503)))
                    ^ seed.wrapping_mul(k + 1)) as u8
            };
            Rgba([v(1), v(2), v(3), v(4)])
        })
    }

    /// **D-351 — the parallel overlay is the `image` crate's overlay.**
    ///
    /// `overlay_parallel` exists only to put `image::imageops::overlay`'s own
    /// per-pixel blend on more than one thread, so the thing that has to stay
    /// true is not "it looks right" but "it is byte-identical to the function it
    /// replaced" — including at every partial overlap, which is where an index
    /// error hides.
    #[test]
    fn overlay_parallel_matches_the_image_crate() {
        // The last case is deliberately over `PARALLEL_PIXEL_MIN` so this
        // exercises the PARALLEL arm as well as the serial one — the small
        // cases alone would only ever compare `overlay_parallel`'s serial
        // fallback against `image`, which is the half that cannot be wrong.
        for (cw, ch, tw, th) in [
            (64u32, 48u32, 32u32, 24u32),
            (301, 199, 512, 400),
            (8, 8, 8, 8),
            (1920, 1080, 1280, 700),
        ] {
            for (ox, oy) in [
                (0i64, 0i64),
                (7, 5),
                (-9, -13),
                (cw as i64 - 3, 2),
                (2, ch as i64 + 4),
            ] {
                let base = noisy(cw, ch, 11);
                let top = noisy(tw, th, 29);
                let mut want = base.clone();
                image::imageops::overlay(&mut want, &top, ox, oy);
                let mut got = base.clone();
                overlay_parallel(&mut got, &top, ox, oy);
                assert_eq!(
                    want, got,
                    "overlay_parallel diverged at canvas {cw}x{ch}, top {tw}x{th}, origin ({ox},{oy})"
                );
            }
        }
    }

    /// **D-351 — the row split is a schedule change, not a maths change.**
    ///
    /// `for_each_row_mut` has a serial arm and a parallel arm chosen by size
    /// alone. This drives the same closure through both over an image big
    /// enough to take the parallel arm and asserts the buffers are equal —
    /// so if the parallel arm ever mis-indexes a row, the two disagree here
    /// rather than in an exported video.
    #[test]
    fn parallel_row_passes_match_their_serial_form() {
        let (w, h) = (1600u32, 900u32); // 1.44 Mpx — comfortably over PARALLEL_PIXEL_MIN
        assert!(
            (w as u64) * (h as u64) >= PARALLEL_PIXEL_MIN,
            "this test must exercise the PARALLEL arm to mean anything"
        );
        let stride = w as usize * 4;
        let pass = |y: usize, row: &mut [u8]| {
            for (x, px) in row.as_chunks_mut::<4>().0.iter_mut().enumerate() {
                px[0] = px[0].wrapping_add(x as u8);
                px[3] = ((px[3] as f32) * 0.5 + y as f32).round().clamp(0.0, 255.0) as u8;
            }
        };
        let src = noisy(w, h, 7);
        let mut serial = src.clone();
        serial
            .as_mut()
            .chunks_mut(stride)
            .enumerate()
            .for_each(|(y, r)| pass(y, r));
        let mut parallel = src.clone();
        for_each_row_mut(parallel.as_mut(), stride, pass);
        assert_eq!(
            serial, parallel,
            "the parallel row arm is not the serial one"
        );
    }

    /// **D-351 — the parallel RGB→RGBA widening is `to_rgba8`.**
    #[test]
    fn to_rgba8_parallel_matches_the_image_crate() {
        for (w, h) in [(333u32, 277u32), (2, 2), (1920, 1080)] {
            let rgb: image::RgbImage =
                ImageBuffer::from_fn(w, h, |x, y| image::Rgb([x as u8, y as u8, (x ^ y) as u8]));
            let want = DynamicImage::ImageRgb8(rgb.clone()).to_rgba8();
            let got = to_rgba8_parallel(DynamicImage::ImageRgb8(rgb));
            assert_eq!(want, got, "to_rgba8_parallel diverged at {w}x{h}");
        }
    }

    /// **D-351 — the compositor is a pure function of its inputs, run twice.**
    ///
    /// The row split hands unspecified rows to unspecified threads, so the one
    /// thing a scheduler could in principle leak into the picture is a
    /// *different answer on a second run*. CLAUDE.md makes that a blocker
    /// ("same doc + same frame ⇒ identical pixels"), so it is asserted directly
    /// on the two passes that now split, rather than only end-to-end.
    #[test]
    fn the_parallel_compositor_is_deterministic_across_runs() {
        // Export-sized on purpose: at a PREVIEW size every pass below takes the
        // serial arm and this would assert nothing about the parallel one.
        let layer = noisy(1800, 1400, 3);
        let t = ClipTransform {
            opacity: 0.6,
            position_x: 0.1,
            position_y: 0.05,
            scale: 1.0,
            box_width: Some(0.5),
            box_height: Some(0.5),
            rotation: 0.0,
            crop_left: 0.1,
            crop_top: 0.05,
            crop_right: 0.0,
            crop_bottom: 0.0,
            corner_radius: 18.0,
        };
        let natural = natural_of(&layer);
        let once = {
            let mut c = flat(1920, 1080, [0, 0, 0, 255]);
            composite_layer_onto(&mut c, &layer, &t, natural);
            c
        };
        for _ in 0..3 {
            let mut c = flat(1920, 1080, [0, 0, 0, 255]);
            composite_layer_onto(&mut c, &layer, &t, natural);
            assert_eq!(once, c, "the compositor produced two different pictures");
        }
    }

    /// D-136 — a layer whose natural composition footprint is exactly its own
    /// buffer size, i.e. "this layer's source fills the composition and the
    /// canvas is at full resolution." Keeps every pre-D-136 case in this
    /// module testing exactly what it tested before; the tests that exercise
    /// the new indirection pass a different `natural` deliberately.
    fn natural_of(layer: &image::RgbaImage) -> (f64, f64) {
        let (w, h) = layer.dimensions();
        (w as f64, h as f64)
    }

    fn identity_transform() -> ClipTransform {
        ClipTransform {
            opacity: 1.0,
            position_x: 0.0,
            position_y: 0.0,
            scale: 1.0,
            box_width: None,
            box_height: None,
            rotation: 0.0,
            crop_left: 0.0,
            crop_top: 0.0,
            crop_right: 0.0,
            crop_bottom: 0.0,
            corner_radius: 0.0,
        }
    }

    /// D-088: `resolve_clip_transform` with no `chroma_keyframes` returns the
    /// clip's own static fields, untouched.
    #[test]
    fn resolve_clip_transform_uses_static_fields_when_unkeyframed() {
        let clip = Clip {
            opacity: 0.5,
            position_x: 10.0,
            position_y: -5.0,
            scale: 2.0,
            rotation: 45.0,
            ..Default::default()
        };
        let t = resolve_clip_transform(&clip, 0);
        assert_eq!(t.opacity, 0.5);
        assert_eq!(t.position_x, 10.0);
        assert_eq!(t.position_y, -5.0);
        assert_eq!(t.scale, 2.0);
        assert_eq!(t.rotation, 45.0);
    }

    /// D-088: with real `chroma_keyframes`, the interpolated value wins over
    /// the static field at that source frame — same D-034 engine masks and
    /// relight lights already use, just called with an explicit frame
    /// instead of the global `current_video()` state (see
    /// `resolve_clip_transform`'s own doc for why).
    #[test]
    fn resolve_clip_transform_uses_interpolated_keyframe_values() {
        let clip = Clip {
            opacity: 1.0, // static field — should be overridden by the keyframes below
            chroma_keyframes: Some(serde_json::json!([
                { "frame": 0, "params": { "opacity": 0.0 } },
                { "frame": 100, "params": { "opacity": 1.0 } },
            ])),
            ..Default::default()
        };
        // halfway between the two keys -> linear interpolation -> ~0.5
        let t = resolve_clip_transform(&clip, 50);
        assert!(
            (t.opacity - 0.5).abs() < 0.01,
            "expected ~0.5, got {}",
            t.opacity
        );
        // before the first key -> held at the first key's value (0.0)
        let t0 = resolve_clip_transform(&clip, 0);
        assert_eq!(t0.opacity, 0.0);
    }

    /// **D-233 — the LIVE PREVIEW path honours a segment's ease curve.**
    ///
    /// `chroma::keyframes`' own tests pin the resolver; this pins the whole
    /// compositor-facing path a rendered frame actually takes
    /// (`resolve_clip_transform` -> `resolve_clip_transform_unfaded` ->
    /// `interpolate_param`), which is the half that has to agree with
    /// `timelineExport.ts`. The matching export-side proof is
    /// `timelineExportEase.ffmpeg.test.ts`, which measures real exported
    /// pixels against the same curve.
    #[test]
    fn resolve_clip_transform_applies_a_segments_ease_curve() {
        let eased = Clip {
            opacity: 1.0,
            chroma_keyframes: Some(serde_json::json!([
                {
                    "frame": 0,
                    "params": { "opacity": 0.0 },
                    "ease": { "opacity": { "x1": 0.42, "y1": 0.0, "x2": 1.0, "y2": 1.0 } },
                },
                { "frame": 100, "params": { "opacity": 1.0 } },
            ])),
            ..Default::default()
        };

        // The curve is applied, and it is the RIGHT curve — compared against
        // `EaseCurve::eval` itself rather than a hand-copied constant.
        for f in [10_i64, 25, 50, 75, 90] {
            let got = resolve_clip_transform(&eased, f).opacity;
            let want = apelles_types::EaseCurve::EASE_IN.eval(f as f64 / 100.0);
            assert!(
                (got - want).abs() < 1e-6,
                "frame {f}: got {got}, want {want}"
            );
        }
        // An ease-in is genuinely slower at the start than the linear ramp the
        // same two keys would otherwise give — so a wrong-but-plausible curve
        // fails this too.
        assert!(resolve_clip_transform(&eased, 25).opacity < 0.25);

        // Both authored keyframes still resolve to exactly their values: a
        // curve warps the rate, it can never move a key.
        assert_eq!(resolve_clip_transform(&eased, 0).opacity, 0.0);
        assert_eq!(resolve_clip_transform(&eased, 100).opacity, 1.0);

        // ...and the same keys with no `ease` are the pre-D-233 linear ramp,
        // unchanged — the backward-compatibility half, at this layer.
        let plain = Clip {
            opacity: 1.0,
            chroma_keyframes: Some(serde_json::json!([
                { "frame": 0, "params": { "opacity": 0.0 } },
                { "frame": 100, "params": { "opacity": 1.0 } },
            ])),
            ..Default::default()
        };
        assert_eq!(resolve_clip_transform(&plain, 25).opacity, 0.25);
    }

    /// **B-094 / D-208 — per-property keyframes really are independent.**
    /// Three keys, each naming a DIFFERENT param subset: `scale` is keyed at
    /// 0 and 100 only, `opacity` at 50 only. `scale` must ramp linearly
    /// across the whole 0..100 span, completely unaffected by the unrelated
    /// `opacity` key sitting in the middle of it — the exact contract
    /// `timelineExport.ts`'s `keyframeExprAt` already had (it filters every
    /// key by `hasOwnProperty(param)` before interpolating) and that this
    /// live-preview path did NOT, because `keyframes::interpolate` brackets
    /// by frame across ALL keys and then *holds* a param that only one side
    /// of the bracket defines.
    #[test]
    fn each_param_interpolates_across_only_its_own_keyframes() {
        let clip = Clip {
            opacity: 1.0,
            scale: 1.0,
            chroma_keyframes: Some(serde_json::json!([
                { "frame": 0,   "params": { "scale": 1.0 } },
                { "frame": 50,  "params": { "opacity": 0.5 } },
                { "frame": 100, "params": { "scale": 2.0 } },
            ])),
            ..Default::default()
        };
        // scale ramps 1 -> 2 over 0..100, sampled either side of the
        // unrelated opacity key. Pre-fix this was a step function: flat 1.0
        // up to 50 (held from the low key), then flat 2.0 (held from the
        // high key).
        for (frame, want) in [(25u64, 1.25), (50, 1.5), (75, 1.75)] {
            let t = resolve_clip_transform(&clip, frame as i64);
            assert!(
                (t.scale - want).abs() < 1e-6,
                "scale at frame {frame}: expected {want}, got {}",
                t.scale
            );
        }
        // ...and opacity, keyed only once, holds flat at that one value
        // everywhere rather than being dragged around by the scale keys.
        for frame in [0i64, 25, 50, 75, 100] {
            let t = resolve_clip_transform(&clip, frame);
            assert!(
                (t.opacity - 0.5).abs() < 1e-6,
                "opacity at frame {frame}: expected 0.5, got {}",
                t.opacity
            );
        }
    }

    /// **The preview PIXELS, not just the resolved struct.** The same
    /// resolve-then-composite pair `composite_video_frame` runs per frame,
    /// driven by the shape per-property keyframing actually produces: `scale`
    /// keyed at 0 and 100, an unrelated `opacity` key at 50 sitting between
    /// them. This is the B-088-shaped check the per-property GUI is built on
    /// ("a preview that lies is worse than no feature").
    ///
    /// **Sampled at frame 25, deliberately** — the endpoints alone would pass
    /// either way (both resolvers land exactly on a key there), and so would
    /// a clip whose keys all named `scale`. Frame 25 is inside the bracket
    /// whose upper key does NOT name `scale`, which is precisely where the
    /// old union-bracket resolver *held* `scale` at 1.0 and painted a 4x4 box
    /// instead of the 8x8 the animation calls for.
    #[test]
    fn the_preview_really_animates_one_keyed_property_and_holds_the_rest() {
        let clip = Clip {
            scale: 1.0,
            position_x: 0.0,
            chroma_keyframes: Some(serde_json::json!([
                { "frame": 0,   "params": { "scale": 1.0 } },
                { "frame": 50,  "params": { "opacity": 1.0 } },
                { "frame": 100, "params": { "scale": 5.0 } },
            ])),
            ..Default::default()
        };
        let layer = flat(4, 4, [255, 0, 0, 255]);
        let paint = |frame: i64| {
            let mut canvas = flat(20, 20, [0, 0, 0, 255]);
            let t = resolve_clip_transform(&clip, frame);
            composite_layer_onto(&mut canvas, &layer, &t, natural_of(&layer));
            canvas
        };

        // Frame 0: scale 1 -> a 4x4 box at the canvas's top-left (D-338),
        // i.e. (0,0)-(3,3).
        let first = paint(0);
        assert_eq!(*first.get_pixel(3, 3), Rgba([255, 0, 0, 255]));
        assert_eq!(*first.get_pixel(6, 6), Rgba([0, 0, 0, 255]));

        // Frame 25: scale interpolates 1 -> 5 across 0..100, so 2.0 here ->
        // an 8x8 box that now really covers (6,6). Held at 1.0 pre-fix, this
        // pixel stayed black and the "zoom" never happened on screen.
        let mid = paint(25);
        assert_eq!(*mid.get_pixel(3, 3), Rgba([255, 0, 0, 255]));
        assert_eq!(
            *mid.get_pixel(6, 6),
            Rgba([255, 0, 0, 255]),
            "scale must really animate between its own keys, across an unrelated key"
        );

        // The box's top-left stays pinned at the canvas origin throughout —
        // `position_x`/`position_y` are keyed nowhere, so they stayed at their
        // static 0.0 while `scale` animated past them, and D-338's anchor is
        // that corner. Both canvases therefore still end short of the right
        // edge (4 px wide, then 8, against a 20 px canvas).
        for canvas in [&first, &mid] {
            assert_eq!(*canvas.get_pixel(0, 0), Rgba([255, 0, 0, 255]));
            assert_eq!(*canvas.get_pixel(19, 10), Rgba([0, 0, 0, 255]));
        }
    }

    /// The other half of B-094: a param that NO key defines falls back to the
    /// clip's own static field, rather than being invented from a neighbour.
    #[test]
    fn an_unkeyed_param_keeps_its_static_value_on_a_keyframed_clip() {
        let clip = Clip {
            rotation: 30.0,
            position_x: 0.25,
            chroma_keyframes: Some(serde_json::json!([
                { "frame": 0,   "params": { "scale": 1.0 } },
                { "frame": 100, "params": { "scale": 2.0 } },
            ])),
            ..Default::default()
        };
        let t = resolve_clip_transform(&clip, 50);
        assert_eq!(t.rotation, 30.0);
        assert_eq!(t.position_x, 0.25);
        assert!((t.scale - 1.5).abs() < 1e-6);
    }

    // --- D-147: clip fades in the compositor ----------------------------- //

    /// **The backward-compatibility case for the compositor.** A clip with no
    /// fade configured — every clip in every pre-D-147 project — resolves to
    /// exactly the opacity it did before, bit for bit, at every frame.
    #[test]
    fn a_clip_with_no_fade_resolves_to_exactly_the_old_opacity() {
        for opacity in [1.0, 0.5, 0.0] {
            let clip = Clip {
                opacity,
                duration: 100,
                ..Default::default()
            };
            for f in [0, 1, 50, 99, 100] {
                let t = resolve_clip_transform(&clip, f);
                assert_eq!(
                    t.opacity.to_bits(),
                    opacity.to_bits(),
                    "opacity {opacity} at frame {f} changed to {}",
                    t.opacity
                );
            }
        }
    }

    /// A fade really reaches zero opacity at both boundaries, and unity in the
    /// clear middle — the compositor half of the same property the audio
    /// envelope and the pure curve math are each tested for.
    #[test]
    fn a_faded_clip_reaches_zero_opacity_at_both_boundaries() {
        let clip = Clip {
            opacity: 1.0,
            duration: 100,
            fade_in_frames: 20,
            fade_out_frames: 20,
            ..Default::default()
        };
        assert_eq!(resolve_clip_transform(&clip, 0).opacity, 0.0);
        assert_eq!(resolve_clip_transform(&clip, 100).opacity, 0.0);
        assert!((resolve_clip_transform(&clip, 10).opacity - 0.5).abs() < 1e-6);
        assert!((resolve_clip_transform(&clip, 50).opacity - 1.0).abs() < 1e-6);
        assert!((resolve_clip_transform(&clip, 90).opacity - 0.5).abs() < 1e-6);
    }

    /// The fade is measured from the clip's own IN-POINT, not from source
    /// frame 0 — so a trimmed clip (`source_start > 0`) fades over its own
    /// first frames, not over frames it does not contain.
    #[test]
    fn the_fade_window_is_measured_from_the_clips_in_point() {
        let clip = Clip {
            opacity: 1.0,
            source_start: 500,
            duration: 100,
            fade_in_frames: 20,
            ..Default::default()
        };
        // source frame 500 IS this clip's first frame
        assert_eq!(resolve_clip_transform(&clip, 500).opacity, 0.0);
        assert!((resolve_clip_transform(&clip, 510).opacity - 0.5).abs() < 1e-6);
        assert!((resolve_clip_transform(&clip, 520).opacity - 1.0).abs() < 1e-6);
    }

    /// The fade multiplies into the KEYFRAMED opacity, not instead of it —
    /// clip opacity keyframes × the fade handle, which is what a real NLE
    /// does and the only order under which neither silently overrides the
    /// other.
    #[test]
    fn the_fade_multiplies_into_a_keyframed_opacity() {
        let clip = Clip {
            opacity: 1.0,
            duration: 100,
            fade_in_frames: 20,
            chroma_keyframes: Some(serde_json::json!([
                { "frame": 0, "params": { "opacity": 0.5 } },
                { "frame": 100, "params": { "opacity": 0.5 } },
            ])),
            ..Default::default()
        };
        // keyframed opacity is a flat 0.5; halfway through the fade-in the
        // multiplier is 0.5, so the result must be 0.25 — not 0.5 (fade
        // ignored) and not 0.5 (keyframe ignored).
        let t = resolve_clip_transform(&clip, 10);
        assert!(
            (t.opacity - 0.25).abs() < 1e-6,
            "expected 0.25, got {}",
            t.opacity
        );
    }

    /// A faded clip must NOT be treated as an identity transform — otherwise
    /// `timeline_frame`'s single-layer fast path would return a plain decode
    /// and the fade would silently do nothing in the preview. This is exactly
    /// the D-132/B-053 failure mode, checked for the new field.
    #[test]
    fn a_faded_lone_clip_is_not_identity_so_it_cannot_take_the_fast_path() {
        let clip = Clip {
            opacity: 1.0,
            duration: 100,
            fade_in_frames: 20,
            ..Default::default()
        };
        assert!(!resolve_clip_transform(&clip, 5).is_identity(), "mid-fade");
        // …and it IS identity again once clear of the fade window, so an
        // un-faded stretch of a faded clip still takes the cheap path.
        assert!(
            resolve_clip_transform(&clip, 50).is_identity(),
            "clear of the fade"
        );
    }

    /// Opacity 0 must be a real no-op — the canvas is untouched, not just
    /// "very faint."
    #[test]
    fn composite_layer_onto_skips_entirely_at_zero_opacity() {
        let mut canvas = flat(4, 4, [10, 20, 30, 255]);
        let before = canvas.clone();
        let layer = flat(4, 4, [255, 255, 255, 255]);
        let t = ClipTransform {
            opacity: 0.0,
            ..identity_transform()
        };
        composite_layer_onto(&mut canvas, &layer, &t, natural_of(&layer));
        assert_eq!(canvas, before);
    }

    /// Opacity 1 with an opaque layer exactly covering the canvas must
    /// produce the layer's own color, not a blend with whatever was there.
    #[test]
    fn composite_layer_onto_full_opacity_fully_replaces() {
        let mut canvas = flat(4, 4, [10, 20, 30, 255]);
        let layer = flat(4, 4, [200, 100, 50, 255]);
        composite_layer_onto(
            &mut canvas,
            &layer,
            &identity_transform(),
            natural_of(&layer),
        );
        assert_eq!(*canvas.get_pixel(2, 2), Rgba([200, 100, 50, 255]));
    }

    /// D-088's real "not opaque top-wins" ask: a real alpha blend at
    /// fractional opacity must land STRICTLY between the two colors, not at
    /// either endpoint — proves real blending math ran, not a threshold
    /// on/off switch.
    #[test]
    fn composite_layer_onto_partial_opacity_blends_strictly_between() {
        let mut canvas = flat(4, 4, [0, 0, 0, 255]);
        let layer = flat(4, 4, [255, 255, 255, 255]);
        let t = ClipTransform {
            opacity: 0.5,
            ..identity_transform()
        };
        composite_layer_onto(&mut canvas, &layer, &t, natural_of(&layer));
        let r = canvas.get_pixel(2, 2)[0];
        assert!(r > 20 && r < 235, "expected a real mid-blend, got {r}");
    }

    /// `position_x`/`position_y` place the layer's TOP-LEFT corner (D-338,
    /// fixes B-201) — a layer smaller than the canvas must land exactly there
    /// and leave the untouched canvas area alone.
    #[test]
    fn composite_layer_onto_respects_position_offset() {
        let mut canvas = flat(10, 10, [0, 0, 0, 255]);
        let layer = flat(2, 2, [255, 0, 0, 255]);
        // x = 0.3 × 10 = 3, y = 0.0 × 10 = 0 (D-136 — a FRACTION, not pixels;
        // D-338 — the layer's top-left corner, not an offset from centre), so
        // the 2×2 layer covers (3,0)-(4,1).
        let t = ClipTransform {
            position_x: 0.3,
            ..identity_transform()
        };
        composite_layer_onto(&mut canvas, &layer, &t, natural_of(&layer));
        assert_eq!(*canvas.get_pixel(3, 0), Rgba([255, 0, 0, 255]));
        assert_eq!(*canvas.get_pixel(4, 1), Rgba([255, 0, 0, 255]));
        // one past the box on each axis, and the pre-D-338 centred spot
        assert_eq!(*canvas.get_pixel(5, 0), Rgba([0, 0, 0, 255]));
        assert_eq!(*canvas.get_pixel(3, 2), Rgba([0, 0, 0, 255]));
        assert_eq!(*canvas.get_pixel(7, 4), Rgba([0, 0, 0, 255]));
    }

    /// `scale` actually changes the painted footprint size, not just a
    /// cosmetic field nobody reads.
    #[test]
    fn composite_layer_onto_respects_scale() {
        let mut canvas = flat(20, 20, [0, 0, 0, 255]);
        let layer = flat(4, 4, [255, 0, 0, 255]);
        // -> 12x12 with its top-left at position (0,0), i.e. (0,0)-(11,11)
        // (D-338: `scale` grows a layer about its own top-left corner, which
        // is exactly what `overlay=x='0*W'` after a `scale=` does on the
        // export side).
        let t = ClipTransform {
            scale: 3.0,
            ..identity_transform()
        };
        composite_layer_onto(&mut canvas, &layer, &t, natural_of(&layer));
        assert_eq!(*canvas.get_pixel(0, 0), Rgba([255, 0, 0, 255]));
        assert_eq!(*canvas.get_pixel(11, 11), Rgba([255, 0, 0, 255]));
        assert_eq!(*canvas.get_pixel(12, 12), Rgba([0, 0, 0, 255]));
    }

    /// **D-217's safety claim, checked.** The sampled fast path must produce
    /// the same picture as the resize-then-overlay path it replaced — that is
    /// the whole argument for it being an optimisation rather than a change of
    /// look. The reference is the pre-D-217 algorithm written out inline, so
    /// this stays a real comparison even as the fast path evolves.
    ///
    /// ±1 per channel, not exact: the two accumulate in a different order (one
    /// rounds once at the end of a fused sample-and-blend, the other rounds
    /// into an intermediate `u8` buffer and then blends), which can differ by a
    /// least-significant bit. It is not a filtering difference — `Triangle`'s
    /// support collapses to two taps per axis at a ratio ≥ 1, which is exactly
    /// what the sampler does.
    #[test]
    fn the_sampled_fast_path_matches_resize_then_overlay() {
        let reference_of = |canvas: (u32, u32),
                            layer: &image::RgbaImage,
                            t: &ClipTransform,
                            natural: (f64, f64)| {
            let mut reference = flat(canvas.0, canvas.1, [0, 0, 0, 255]);
            let (raw_w, raw_h) = t.effective_size(natural, reference.dimensions());
            let (sw, sh) = (raw_w.round().max(1.0) as u32, raw_h.round().max(1.0) as u32);
            let (cx0, cy0, cx1, cy1) =
                crop_pixel_rect(layer.width(), layer.height(), t).expect("a non-empty crop");
            // B-218 — crop THEN scale: the reference resizes the crop's own
            // sub-image, which is what the general path does and what ffmpeg's
            // `crop=` → `scale=` pair does.
            let sub = image::imageops::crop_imm(layer, cx0, cy0, cx1 - cx0, cy1 - cy0).to_image();
            let mut work =
                image::imageops::resize(&sub, sw, sh, image::imageops::FilterType::Triangle);
            let opacity = t.opacity.clamp(0.0, 1.0) as f32;
            if opacity < 1.0 {
                for p in work.pixels_mut() {
                    p[3] = (p[3] as f32 * opacity).round().clamp(0.0, 255.0) as u8;
                }
            }
            let (cw, ch) = reference.dimensions();
            // D-338 — the top-left placement both real paths now use; the
            // work buffer's size no longer enters into the placement at all
            // (see `composite_layer_onto`'s own doc).
            let x = t.position_x * cw as f64;
            let y = t.position_y * ch as f64;
            image::imageops::overlay(&mut reference, &work, x.round() as i64, y.round() as i64);
            reference
        };

        // A layer with real structure, so interpolation actually shows up.
        let mut layer = image::RgbaImage::new(8, 6);
        for (x, y, p) in layer.enumerate_pixels_mut() {
            *p = Rgba([(x * 31) as u8, (y * 41) as u8, 200, 255]);
        }
        let natural = natural_of(&layer);

        for (name, t) in [
            (
                "magnified and offset",
                ClipTransform {
                    scale: 4.0,
                    position_x: 0.1,
                    position_y: -0.05,
                    ..identity_transform()
                },
            ),
            (
                "magnified, cropped and half-opaque",
                ClipTransform {
                    scale: 3.0,
                    opacity: 0.5,
                    crop_left: 0.2,
                    crop_bottom: 0.25,
                    ..identity_transform()
                },
            ),
            (
                "magnified far enough to hang off the canvas",
                ClipTransform {
                    scale: 6.0,
                    position_x: 0.4,
                    ..identity_transform()
                },
            ),
        ] {
            let mut fast = flat(40, 30, [0, 0, 0, 255]);
            composite_layer_onto(&mut fast, &layer, &t, natural);
            let reference = reference_of((40, 30), &layer, &t, natural);
            for (px, py, p) in fast.enumerate_pixels() {
                let r = reference.get_pixel(px, py);
                for c in 0..4 {
                    assert!(
                        (p[c] as i32 - r[c] as i32).abs() <= 1,
                        "{name}: pixel ({px},{py}) channel {c}: fast {p:?} vs reference {r:?}"
                    );
                }
            }
        }

        // The same equivalence at the real thing's scale and settings: the
        // owner's reel is a 540×960 preview canvas, a 960×544 decoded layer,
        // `crop_left`/`crop_right` 0.052212, and `scale` keyframed up to 1.3
        // with `position_x` up to 0.3 — the exact combination that made this
        // the preview's dominant cost, and the one a 40×30 fixture cannot
        // stand in for on its own.
        let mut real = image::RgbaImage::new(240, 136); // the decoded layer, scaled down
        for (x, y, p) in real.enumerate_pixels_mut() {
            // Deterministic pseudo-photographic detail — high-frequency enough
            // that any sampling difference between the two paths would show.
            let n = (x * 7919 + y * 104_729) % 251;
            *p = Rgba([n as u8, ((n * 3) % 251) as u8, ((n * 7) % 251) as u8, 255]);
        }
        let real_natural = (367.5, 208.75); // source-derived footprint, canvas px
        let t = ClipTransform {
            scale: 1.3,
            position_x: 0.3,
            position_y: -0.12,
            crop_left: 0.052_212,
            crop_right: 0.052_212,
            ..identity_transform()
        };
        let mut fast = flat(135, 240, [0, 0, 0, 255]);
        composite_layer_onto(&mut fast, &real, &t, real_natural);
        let reference = reference_of((135, 240), &real, &t, real_natural);
        let mut worst = 0i32;
        for (px, py, p) in fast.enumerate_pixels() {
            let r = reference.get_pixel(px, py);
            for c in 0..4 {
                worst = worst.max((p[c] as i32 - r[c] as i32).abs());
                assert!(
                    (p[c] as i32 - r[c] as i32).abs() <= 1,
                    "reel-shaped: pixel ({px},{py}) channel {c}: fast {p:?} vs reference {r:?}"
                );
            }
        }
        eprintln!("reel-shaped equivalence: worst per-channel difference {worst}");
    }

    /// A layer scaled up and pushed entirely off the canvas paints nothing —
    /// and, since D-217, costs nothing either: the old path resized the whole
    /// (arbitrarily large) footprint first and let `overlay` discard all of it.
    #[test]
    fn a_layer_entirely_off_canvas_paints_nothing() {
        let mut canvas = flat(20, 20, [0, 0, 0, 255]);
        let layer = flat(4, 4, [255, 0, 0, 255]);
        let t = ClipTransform {
            scale: 2.0,
            position_x: 5.0,
            ..identity_transform()
        };
        composite_layer_onto(&mut canvas, &layer, &t, natural_of(&layer));
        assert!(
            canvas.pixels().all(|p| *p == Rgba([0, 0, 0, 255])),
            "nothing should have been painted"
        );
    }

    // ---------------------------------------------------------------- //
    // D-193 — independent per-axis `box_width`/`box_height`
    // (`docs/notes/independent-clip-size.md`).
    // ---------------------------------------------------------------- //

    /// `box_width`/`box_height` size the box as a fraction of the CANVAS,
    /// independently per axis — the exact "full width, half height" layout
    /// a single uniform `scale` could never produce (B-074's own finding,
    /// generalised past export-only `fit`/`stretch` into a real persisted
    /// field).
    #[test]
    fn composite_layer_onto_respects_independent_box_width_and_box_height() {
        let mut canvas = flat(20, 10, [0, 0, 0, 255]);
        let layer = flat(4, 4, [255, 0, 0, 255]);
        // full canvas width, half its height -> 20x5, top-left at (0,0)
        // (D-338), i.e. covering y ∈ [0,5). This is the TOP half of the
        // stacked comparison layout, exactly as `timelineExport.ts` compiles
        // it: `scale=w=W*1.0:h=H*0.5` then `overlay=x='0*W':y='0*H'`.
        let t = ClipTransform {
            box_width: Some(1.0),
            box_height: Some(0.5),
            ..identity_transform()
        };
        composite_layer_onto(&mut canvas, &layer, &t, natural_of(&layer));
        assert_eq!(*canvas.get_pixel(10, 0), Rgba([255, 0, 0, 255]));
        assert_eq!(*canvas.get_pixel(0, 4), Rgba([255, 0, 0, 255]));
        assert_eq!(*canvas.get_pixel(19, 4), Rgba([255, 0, 0, 255]));
        assert_eq!(
            *canvas.get_pixel(10, 5),
            Rgba([0, 0, 0, 255]),
            "outside the half-height box"
        );
        assert_eq!(
            *canvas.get_pixel(10, 9),
            Rgba([0, 0, 0, 255]),
            "outside the half-height box"
        );
    }

    /// **B-218's safety guarantee, stated as a property rather than a
    /// fixture:** the new crop-aware height rule is EXACTLY the old
    /// `natural.1 * scale` whenever the clip is not cropped — which is every
    /// clip in every project authored before this fix. Exact `==`, not an
    /// epsilon: `w * (h * 1.0) / (w * 1.0)` has to come back bit-identical,
    /// and it does because the division is by the same value it multiplies.
    #[test]
    fn effective_size_is_unchanged_for_an_uncropped_clip() {
        for (nw, nh) in [(1920.0, 1080.0), (640.0, 480.0), (3840.0, 2160.0)] {
            for scale in [0.22, 0.5, 1.0, 1.75] {
                let t = ClipTransform {
                    scale,
                    ..identity_transform()
                };
                assert_eq!(
                    t.effective_size((nw, nh), (3840, 2160)),
                    (nw * scale, nh * scale),
                    "{nw}x{nh} at scale {scale}"
                );
            }
        }
    }

    /// **B-218 — a cropped clip's height follows the CROPPED aspect ratio**,
    /// which is what `timelineExport.ts` asks ffmpeg for with `h='-2'`. The
    /// numbers: a 16:9 source cropped to a third of its width is 3x taller
    /// than it is wide relative to the box, so a 0.25-scale box 480 px wide is
    /// 852.6 px tall, not the 270 px the uncropped aspect would have given.
    #[test]
    fn effective_size_derives_height_from_the_cropped_aspect_ratio() {
        let t = ClipTransform {
            crop_left: 1.0 / 3.0,
            crop_right: 1.0 / 3.0,
            scale: 0.25,
            ..identity_transform()
        };
        let (w, h) = t.effective_size((1920.0, 1080.0), (1920, 1080));
        assert!((w - 480.0).abs() < 1e-9, "width is not crop-adjusted: {w}");
        let kept_w = 1920.0 / 3.0;
        assert!(
            (h - 480.0 * 1080.0 / kept_w).abs() < 1e-6,
            "height must follow the cropped aspect ratio, got {h}"
        );
    }

    /// An explicit `box_height` is a MORE specific statement than any derived
    /// aspect ratio, exactly as it is in the exporter (where it wins over
    /// `-2`), so a crop must not move it.
    #[test]
    fn effective_size_lets_an_explicit_box_height_win_over_the_crop() {
        let t = ClipTransform {
            crop_top: 0.4,
            box_width: Some(0.25),
            box_height: Some(0.5),
            ..identity_transform()
        };
        assert_eq!(
            t.effective_size((1920.0, 1080.0), (1920, 1080)),
            (480.0, 540.0)
        );
    }

    /// **D-338 / B-201 — the CROSS-ENGINE placement parity pair, Rust half.**
    ///
    /// Its twin is `'D-338/B-201 — placement parity with the live-preview
    /// compositor'` in `packages/editor/src/timelineExport.ffmpeg.test.ts`,
    /// which renders the SAME transform through REAL ffmpeg and asserts the
    /// SAME rectangle. Neither test knows the other exists at run time; that
    /// is the point. A change to either engine's placement math fails a test
    /// in that engine's own language, against a number written down
    /// independently of both formulas.
    ///
    /// **Why a pair rather than one test.** The two engines are a Rust image
    /// compositor and a spawned ffmpeg process, in two toolchains with two
    /// test runners; a single test spanning them would have to build and run
    /// this crate from vitest, or re-implement that file's fixture generation
    /// under `cargo test`. Two tests plus one hard-coded shared rectangle buy
    /// the same regression protection with each half runnable on its own.
    ///
    /// **Why it exists at all.** B-201's own write-up names the missing
    /// cross-engine test as the root cause of the bug surviving: the preview
    /// read `position_*` as a centre offset and the export as the top-left
    /// corner, each side self-consistent and separately tested, disagreeing by
    /// `(1 - box_fraction)/2` of the canvas — a divergence that vanishes at
    /// full frame, which was the only geometry anyone had checked end to end.
    /// The transform below is deliberately neither full-frame NOR centred, so
    /// it could not pass under the old convention.
    #[test]
    fn composite_layer_onto_agrees_with_the_exporter_on_the_parity_rectangle() {
        // The canvas both engines render into; every number below is an exact
        // integer in both, so a failure is never about rounding.
        const CANVAS: (u32, u32) = (320, 240);
        // The one transform under test, spelled identically in the twin:
        // box_width 0.5, box_height 0.5, position 0.25, 0.25.
        let t = ClipTransform {
            box_width: Some(0.5),
            box_height: Some(0.5),
            position_x: 0.25,
            position_y: 0.25,
            ..identity_transform()
        };
        // The rectangle it MUST cover, half-open, as literals rather than
        // recomputed from the transform — a test must not be able to follow a
        // broken formula. x from 0.25 × 320 = 80 for 0.5 × 320 = 160;
        // y from 0.25 × 240 = 60 for 0.5 × 240 = 120.
        const EXPECTED: (u32, u32, u32, u32) = (80, 60, 240, 180);

        let mut canvas = flat(CANVAS.0, CANVAS.1, [0, 0, 0, 255]);
        let layer = flat(160, 120, [255, 0, 255, 255]);
        composite_layer_onto(&mut canvas, &layer, &t, (160.0, 120.0));

        let (x0, y0, x1, y1) = EXPECTED;
        for (x, y) in [(x0, y0), (x1 - 1, y0), (x0, y1 - 1), (x1 - 1, y1 - 1)] {
            assert_eq!(
                *canvas.get_pixel(x, y),
                Rgba([255, 0, 255, 255]),
                "({x},{y}) is a corner of the parity rectangle and must be painted"
            );
        }
        for (x, y, why) in [
            (x0 - 1, y0, "left of the box"),
            (x1, y0, "right of the box"),
            (x0, y0 - 1, "above the box"),
            (x0, y1, "below the box"),
        ] {
            assert_eq!(
                *canvas.get_pixel(x, y),
                Rgba([0, 0, 0, 255]),
                "({x},{y}) is {why} and must be untouched"
            );
        }
        // And explicitly NOT where the pre-D-338 centre-offset formula put it:
        // cw/2 - sw/2 + 0.25*cw = 160 - 80 + 80 = 160 in x, 120 - 60 + 60 =
        // 120 in y. That box would have covered (160,120)-(319,239), so its
        // far corner is a pixel this convention must leave black.
        assert_eq!(
            *canvas.get_pixel(CANVAS.0 - 1, CANVAS.1 - 1),
            Rgba([0, 0, 0, 255]),
            "the pre-D-338 centre-offset placement would have reached the canvas's far corner"
        );
    }

    /// **The other half of the stacked comparison layout** (D-338 / B-201):
    /// the same half-height box moved to the BOTTOM with `position_y: 0.5`.
    /// This is the recipe `capabilities.json` documents and the
    /// `chroma-comparison-reel` skill emits, and before D-338 it worked in the
    /// export and landed a quarter of a canvas too high in the preview — the
    /// single most-used non-full-frame geometry in this project, and the exact
    /// case that had no cross-engine test.
    #[test]
    fn a_half_height_box_at_position_y_half_fills_the_bottom_half() {
        let mut canvas = flat(20, 10, [0, 0, 0, 255]);
        let layer = flat(4, 4, [255, 0, 0, 255]);
        let t = ClipTransform {
            box_width: Some(1.0),
            box_height: Some(0.5),
            position_y: 0.5,
            ..identity_transform()
        };
        composite_layer_onto(&mut canvas, &layer, &t, natural_of(&layer));
        // y = 0.5 × 10 = 5, height 5 -> y ∈ [5,10)
        assert_eq!(*canvas.get_pixel(10, 5), Rgba([255, 0, 0, 255]));
        assert_eq!(*canvas.get_pixel(10, 9), Rgba([255, 0, 0, 255]));
        assert_eq!(
            *canvas.get_pixel(10, 4),
            Rgba([0, 0, 0, 255]),
            "the top half must stay clear for the other clip"
        );
    }

    /// **B-223 (fixed alongside B-218) — `box_width` with no `box_height`
    /// keeps the box's own ASPECT RATIO, it does not fall back to
    /// `natural.1 * scale`.** D-193 wrote this the other way and the exporter
    /// never agreed: `heightExpr` is ffmpeg's `-2` in exactly this case, which
    /// computes the height from the resized width and the input's real aspect
    /// ratio. So a 4x4 source forced to a 20-px-wide box is 20 px tall in the
    /// export; the preview used to make it 4, and only a clip setting BOTH
    /// axes (which is what every real caller does, and what
    /// `capabilities.json`'s own recipes tell you to do) escaped the gap.
    #[test]
    fn box_size_override_on_one_axis_keeps_the_boxs_aspect_ratio() {
        let mut canvas = flat(20, 20, [0, 0, 0, 255]);
        let layer = flat(4, 4, [255, 0, 0, 255]);
        // width forced to the full canvas; height follows from it and the
        // source's own 1:1 aspect -> a 20x20 box at (0,0).
        let t = ClipTransform {
            box_width: Some(1.0),
            scale: 1.0,
            ..identity_transform()
        };
        composite_layer_onto(&mut canvas, &layer, &t, natural_of(&layer));
        assert_eq!(
            *canvas.get_pixel(10, 3),
            Rgba([255, 0, 0, 255]),
            "inside the box"
        );
        assert_eq!(
            *canvas.get_pixel(10, 19),
            Rgba([255, 0, 0, 255]),
            "a 1:1 source in a 20px-wide box is 20px tall, as `scale=w=20:h=-2` makes it"
        );
    }

    /// D-193/B-053-style safety: a `box_width`/`box_height` override must
    /// not be treated as an identity transform just because it happens to
    /// visually coincide with `scale == 1.0` — see `ClipTransform::
    /// is_identity`'s own doc for why this is a deliberately conservative,
    /// always-safe rule rather than a canvas-aware exact check.
    #[test]
    fn a_clip_with_a_box_size_override_is_never_identity() {
        let t = ClipTransform {
            box_width: Some(1.0),
            ..identity_transform()
        };
        assert!(!t.is_identity());
        let t = ClipTransform {
            box_height: Some(1.0),
            ..identity_transform()
        };
        assert!(!t.is_identity());
    }

    /// D-193 — resolving a clip with NO `box_width`/`box_height` override
    /// must never invent one from keyframe data, even when the clip is
    /// otherwise keyframed (here, `opacity`) — there is nothing to
    /// interpolate FROM for an axis the clip never set.
    #[test]
    fn resolve_clip_transform_leaves_box_size_none_without_an_override() {
        let clip = Clip {
            chroma_keyframes: Some(serde_json::json!([
                { "frame": 0, "params": { "opacity": 0.0 } },
                { "frame": 100, "params": { "opacity": 1.0 } },
            ])),
            ..Default::default()
        };
        let t = resolve_clip_transform(&clip, 50);
        assert_eq!(t.box_width, None);
        assert_eq!(t.box_height, None);
    }

    /// D-193 — once a clip HAS an override, that override is itself
    /// keyframeable via its own `box_width`/`box_height` params key, same
    /// as every other transform field.
    #[test]
    fn resolve_clip_transform_resolves_a_keyframed_box_width() {
        let clip = Clip {
            box_width: Some(0.5), // static fallback before/after the keys
            chroma_keyframes: Some(serde_json::json!([
                { "frame": 0, "params": { "box_width": 0.2 } },
                { "frame": 100, "params": { "box_width": 1.0 } },
            ])),
            ..Default::default()
        };
        assert_eq!(resolve_clip_transform(&clip, 0).box_width, Some(0.2));
        assert!((resolve_clip_transform(&clip, 50).box_width.unwrap() - 0.6).abs() < 0.01);
        assert_eq!(resolve_clip_transform(&clip, 100).box_width, Some(1.0));
    }

    // ---------------------------------------------------------------- //
    // D-136 — composition space (Phase 0a of
    // `docs/notes/on-canvas-transform.md`, closes B-043).
    // ---------------------------------------------------------------- //

    /// The painted region of `canvas` in the flat `colour`, as
    /// `(x0, y0, x1, y1)` **fractions** of the canvas — the unit the geometry
    /// fields are now in, so two renders of the same transform at different
    /// canvas resolutions can be compared directly.
    fn painted_fraction(canvas: &image::RgbaImage, colour: Rgba<u8>) -> (f64, f64, f64, f64) {
        let (w, h) = canvas.dimensions();
        let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0u32, 0u32);
        for (x, y, p) in canvas.enumerate_pixels() {
            if *p == colour {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x + 1);
                y1 = y1.max(y + 1);
            }
        }
        assert!(x0 != u32::MAX, "nothing was painted");
        (
            x0 as f64 / w as f64,
            y0 as f64 / h as f64,
            x1 as f64 / w as f64,
            y1 as f64 / h as f64,
        )
    }

    /// **B-043, closed.** The same clip transform rendered into two canvases
    /// of very different resolutions — from the *same* decoded layer buffer,
    /// exactly as one decode gets re-used across preview qualities — must put
    /// the picture on the same part of the frame. Before D-136 both halves of
    /// this failed: `position_*` were canvas pixels (so the layer moved) and
    /// `scale` multiplied the decoded buffer (so it resized).
    #[test]
    fn geometry_is_identical_at_every_render_scale() {
        let layer = flat(40, 40, [255, 0, 0, 255]);
        let red = Rgba([255, 0, 0, 255]);
        // D-338 — both offsets positive and small enough that the 60 %-wide
        // box stays wholly on the canvas. The pre-D-338 version of this test
        // used `position_y: -0.2`, which under the top-left convention would
        // push the box's top edge off the canvas and clamp BOTH renders'
        // measured `y0` to exactly 0 — an artefact that would make the
        // invariance assertion below pass vacuously.
        let t = ClipTransform {
            position_x: 0.1,
            position_y: 0.2,
            scale: 1.5,
            ..identity_transform()
        };

        // "scrub quality": the composition rendered into 100×100, so the
        // layer's natural footprint is 40 px.
        let mut small = flat(100, 100, [0, 0, 0, 255]);
        composite_layer_onto(&mut small, &layer, &t, (40.0, 40.0));

        // "full quality": the same composition into 300×300 — every canvas
        // length ×3, so the natural footprint is ×3 too, while the decoded
        // buffer handed in is byte-for-byte the same one.
        let mut large = flat(300, 300, [0, 0, 0, 255]);
        composite_layer_onto(&mut large, &layer, &t, (120.0, 120.0));

        let a = painted_fraction(&small, red);
        let b = painted_fraction(&large, red);
        let close = |x: f64, y: f64| (x - y).abs() < 0.01;
        assert!(
            close(a.0, b.0) && close(a.1, b.1) && close(a.2, b.2) && close(a.3, b.3),
            "same transform, different render scale: {a:?} vs {b:?}"
        );
        // and it's the right place, not just consistently the wrong one:
        // 1.5× of a 40 %-wide layer = 60 %, with its top-left corner at
        // (0.10, 0.20) (D-338), so it spans 0.10–0.70 and 0.20–0.80.
        assert!(close(a.0, 0.10) && close(a.2, 0.70), "x span {a:?}");
        assert!(close(a.1, 0.20) && close(a.3, 0.80), "y span {a:?}");
    }

    /// A layer whose source is smaller than the composition sits in the frame
    /// at that ratio — `scale: 1.0` means "its own size in the composition",
    /// not "fill the canvas". The pre-D-136 compositor could not express this
    /// at all: it resized the *decoded* buffer, which `scale_target` leaves
    /// untouched whenever the source already fits under the preview cap, so a
    /// small source silently became full-frame.
    #[test]
    fn a_sub_composition_layer_keeps_its_relative_size() {
        let layer = flat(64, 36, [0, 200, 255, 255]);
        let mut canvas = flat(192, 108, [0, 0, 0, 255]);
        // a 64×36 source in a 192×108 composition, canvas at 1:1 → a third.
        composite_layer_onto(&mut canvas, &layer, &identity_transform(), (64.0, 36.0));
        let (x0, y0, x1, y1) = painted_fraction(&canvas, Rgba([0, 200, 255, 255]));
        assert!((x1 - x0 - 1.0 / 3.0).abs() < 0.01, "width {}", x1 - x0);
        assert!((y1 - y0 - 1.0 / 3.0).abs() < 0.01, "height {}", y1 - y0);
        // D-338 — in the canvas's top-left corner, since `position_*` are zero
        // and that is where `overlay=x='0*W':y='0*H'` puts it too.
        assert!(x0.abs() < 0.01 && y0.abs() < 0.01, "origin {x0},{y0}");
    }

    /// `position_x` is a fraction of the **width** and `position_y` of the
    /// **height** — the same per-axis convention the crop insets use. On a
    /// deliberately non-square canvas the two must therefore land different
    /// pixel distances for the same numeric value.
    #[test]
    fn position_is_normalised_per_axis() {
        let layer = flat(2, 2, [255, 255, 255, 255]);
        let mut canvas = flat(200, 100, [0, 0, 0, 255]);
        let t = ClipTransform {
            position_x: 0.25,
            position_y: 0.25,
            ..identity_transform()
        };
        composite_layer_onto(&mut canvas, &layer, &t, (2.0, 2.0));
        // D-338 — top-left corner at 0.25 × 200 = 50 px in x and
        // 0.25 × 100 = 25 px in y, so the 2×2 covers (50,25)-(51,26). The
        // same numeric 0.25 therefore lands 50 px along one axis and 25 px
        // along the other, which is the per-axis property under test.
        assert_eq!(*canvas.get_pixel(50, 25), Rgba([255, 255, 255, 255]));
        assert_eq!(*canvas.get_pixel(51, 26), Rgba([255, 255, 255, 255]));
        assert_eq!(*canvas.get_pixel(50, 50), Rgba([0, 0, 0, 255]));
        assert_eq!(*canvas.get_pixel(25, 25), Rgba([0, 0, 0, 255]));
    }

    // ---------------------------------------------------------------- //
    // D-132 — per-clip crop.
    // ---------------------------------------------------------------- //

    /// The normalised-inset → pixel-rect conversion, on its own: a quarter
    /// off the left and a half off the bottom of a 100×100 layer keeps
    /// x ∈ [25, 100), y ∈ [0, 50).
    #[test]
    fn crop_pixel_rect_converts_normalised_insets_to_pixels() {
        let t = ClipTransform {
            crop_left: 0.25,
            crop_bottom: 0.5,
            ..identity_transform()
        };
        assert_eq!(crop_pixel_rect(100, 100, &t), Some((25, 0, 100, 50)));
    }

    /// **The reason the unit is a fraction and not pixels** (D-132, and the
    /// class of defect B-043 is): the SAME crop value keeps the same
    /// *fraction* of the picture at every decode scale `PreviewPane` asks
    /// for (960 scrubbing / 640 playing / full-res later), where a pixel
    /// rect would keep a different fraction at each one.
    #[test]
    fn crop_is_invariant_under_the_decode_scale() {
        let t = ClipTransform {
            crop_left: 0.5,
            ..identity_transform()
        };
        let big = crop_pixel_rect(960, 540, &t).unwrap();
        let small = crop_pixel_rect(640, 360, &t).unwrap();
        let frac = |(x0, _, x1, _): (u32, u32, u32, u32), w: u32| (x1 - x0) as f64 / w as f64;
        assert!((frac(big, 960) - frac(small, 640)).abs() < 1e-9);
        assert!((frac(big, 960) - 0.5).abs() < 1e-9);
    }

    /// A crop that leaves nothing (insets summing past the whole frame) is
    /// `None` — and the compositor must then paint nothing at all, rather
    /// than panicking on an empty rect or painting the un-cropped layer.
    #[test]
    fn a_degenerate_crop_paints_nothing() {
        let t = ClipTransform {
            crop_left: 0.7,
            crop_right: 0.7,
            ..identity_transform()
        };
        assert_eq!(crop_pixel_rect(100, 100, &t), None);
        let mut canvas = flat(4, 4, [10, 20, 30, 255]);
        let before = canvas.clone();
        let layer = flat(4, 4, [255, 255, 255, 255]);
        composite_layer_onto(&mut canvas, &layer, &t, natural_of(&layer));
        assert_eq!(canvas, before);
    }

    /// Out-of-range insets are clamped at the point of use, not rejected by
    /// the model (`Clip::crop_left`'s own doc) — a negative inset is no
    /// crop, `> 1.0` is the whole edge.
    #[test]
    fn crop_insets_are_clamped_by_the_consumer() {
        let neg = ClipTransform {
            crop_left: -0.5,
            ..identity_transform()
        };
        assert_eq!(crop_pixel_rect(100, 100, &neg), Some((0, 0, 100, 100)));
        let over = ClipTransform {
            crop_left: 4.0,
            ..identity_transform()
        };
        assert_eq!(crop_pixel_rect(100, 100, &over), None);
    }

    /// **B-218 — the crop is what gets scaled, so the KEPT picture fills the
    /// box.** Cropping the left half away and leaving `scale` at 1.0 does not
    /// leave the right half sitting where it was with a hole beside it (which
    /// is what this function did until B-218 was fixed, and what the previous
    /// version of this test asserted): the kept half is the picture now, and
    /// it is resized into the placement box exactly as `crop=` → `scale=`
    /// does in the export.
    ///
    /// The layer is two-toned on purpose. A flat one could not tell "the kept
    /// half was stretched across the box" from "the whole layer was painted",
    /// and the cropped-away colour appearing anywhere would mean the crop
    /// rectangle itself was wrong.
    #[test]
    fn composite_layer_onto_scales_the_crop_into_the_box() {
        let mut canvas = flat(10, 10, [0, 0, 0, 255]);
        let mut layer = flat(10, 10, [255, 0, 0, 255]);
        for y in 0..10 {
            for x in 0..5 {
                layer.put_pixel(x, y, Rgba([0, 255, 0, 255])); // cropped away
            }
        }
        let t = ClipTransform {
            crop_left: 0.5,
            ..identity_transform()
        };
        // width  = natural.0 * scale                      = 10
        // height = width * (natural.1 * 1.0) / (natural.0 * 0.5) = 20
        // i.e. a 10x20 box at (0,0) — the visible half of it covers the whole
        // 10x10 canvas, all of it the KEPT (red) half of the layer.
        composite_layer_onto(&mut canvas, &layer, &t, natural_of(&layer));
        for (x, y) in [(0, 0), (4, 5), (9, 9), (0, 9), (9, 0)] {
            assert_eq!(
                *canvas.get_pixel(x, y),
                Rgba([255, 0, 0, 255]),
                "({x},{y}): the kept half fills the box; pre-B-218 the left half was black here"
            );
        }
    }

    /// Each edge crops its own side — a top crop must not take pixels off
    /// the bottom (the kind of thing an axis mix-up in `crop_pixel_rect`
    /// would produce and a single-edge test would miss).
    ///
    /// Post-B-218 the way to see that is what SURVIVES into the box rather
    /// than what is missing from it: the layer is painted so that each cropped
    /// edge carries its own unique colour, and neither may appear anywhere in
    /// the result.
    #[test]
    fn composite_layer_onto_crops_each_edge_independently() {
        let mut canvas = flat(10, 10, [0, 0, 0, 255]);
        let mut layer = flat(10, 10, [255, 0, 0, 255]);
        for x in 0..10 {
            for y in 0..3 {
                layer.put_pixel(x, y, Rgba([0, 255, 0, 255])); // cropped by crop_top
            }
        }
        for y in 0..10 {
            for x in 8..10 {
                layer.put_pixel(x, y, Rgba([0, 0, 255, 255])); // cropped by crop_right
            }
        }
        let t = ClipTransform {
            crop_top: 0.3,
            crop_right: 0.2,
            ..identity_transform()
        };
        // crop rect = x 0..8, y 3..10 (8x7). width = 10, height = 10 * 7/8 =
        // 8.75 -> 9, so the box is 10x9 at (0,0).
        composite_layer_onto(&mut canvas, &layer, &t, natural_of(&layer));
        for y in 0..9 {
            for x in 0..10 {
                assert_eq!(
                    *canvas.get_pixel(x, y),
                    Rgba([255, 0, 0, 255]),
                    "({x},{y}) is inside the box and must be the KEPT colour only"
                );
            }
        }
        assert_eq!(
            *canvas.get_pixel(5, 9),
            Rgba([0, 0, 0, 255]),
            "row 9 is below the 9-px-tall box the cropped aspect ratio produces"
        );
    }

    /// **B-218 — the CROSS-ENGINE crop-then-scale parity pair, Rust half.**
    ///
    /// Its twin is `'B-218 — crop-then-scale parity with the live-preview
    /// compositor'` in `packages/editor/src/timelineExport.ffmpeg.test.ts`,
    /// which pushes the SAME transform through REAL ffmpeg and asserts the
    /// SAME rectangle, the same way D-338's own parity pair does for
    /// `position_*`. B-218's write-up named the absence of exactly this test —
    /// "one non-trivial crop+scale combination through both engines" — as what
    /// let the divergence survive, so it is the fix's own regression guard.
    ///
    /// The transform is deliberately cropped on all four edges AND scaled AND
    /// placed off-centre: under the pre-fix behaviour the box landed in the
    /// same place but only its middle quarter carried any picture, so every
    /// corner assertion below fails.
    #[test]
    fn composite_layer_onto_agrees_with_the_exporter_on_the_crop_parity_rectangle() {
        // Every number here is an exact integer in both engines.
        const CANVAS: (u32, u32) = (320, 240);
        let t = ClipTransform {
            crop_left: 0.25,
            crop_right: 0.25,
            crop_top: 0.25,
            crop_bottom: 0.25,
            scale: 0.5,
            position_x: 0.25,
            position_y: 0.25,
            ..identity_transform()
        };
        // Written as literals, not recomputed from the transform:
        //   crop  -> 160x120 out of the 320x240 source, offset (80, 60)
        //   scale -> width 320 * 0.5 = 160; height follows the CROPPED aspect
        //            ratio (ffmpeg's `-2`): 160 * 120/160 = 120
        //   place -> top-left at (0.25 * 320, 0.25 * 240) = (80, 60)
        const EXPECTED: (u32, u32, u32, u32) = (80, 60, 240, 180);

        let mut canvas = flat(CANVAS.0, CANVAS.1, [0, 0, 0, 255]);
        let layer = flat(320, 240, [255, 0, 255, 255]);
        composite_layer_onto(&mut canvas, &layer, &t, (320.0, 240.0));

        let (x0, y0, x1, y1) = EXPECTED;
        for (x, y) in [(x0, y0), (x1 - 1, y0), (x0, y1 - 1), (x1 - 1, y1 - 1)] {
            assert_eq!(
                *canvas.get_pixel(x, y),
                Rgba([255, 0, 255, 255]),
                "({x},{y}) is a corner of the crop parity rectangle and must be painted"
            );
        }
        for (x, y, why) in [
            (x0 - 1, y0, "left of the box"),
            (x1, y0, "right of the box"),
            (x0, y0 - 1, "above the box"),
            (x0, y1, "below the box"),
        ] {
            assert_eq!(
                *canvas.get_pixel(x, y),
                Rgba([0, 0, 0, 255]),
                "({x},{y}) is {why} and must be untouched"
            );
        }
    }

    // --- D-344, rounded corners ------------------------------------------ //

    /// **The regression guarantee, proved for every input rather than for one
    /// fixture.** `corner_radius == 0` must be byte-identical to the pre-D-344
    /// path, and the mechanism by which that holds is that the coverage is
    /// EXACTLY `1.0` at radius zero — so even where the mask does run (a
    /// keyframed radius passing through zero, where the caller cannot skip the
    /// pass) multiplying by it changes no alpha byte. Exact `==` on purpose,
    /// not an epsilon: `alpha * 1.0f32` is exact, `alpha * 0.999f32` is not.
    ///
    /// This is also the exact property the obvious "distance from the corner
    /// circle's centre" formulation FAILS — it returns `0.5` here and would
    /// silently halve the whole layer's alpha. See [`corner_coverage`].
    #[test]
    fn corner_coverage_is_exactly_one_everywhere_at_zero_radius() {
        for (w, h) in [(1.0, 1.0), (16.0, 9.0), (100.0, 100.0), (7.0, 33.0)] {
            for y in 0..(h as u32) {
                for x in 0..(w as u32) {
                    let cov = corner_coverage(x as f64, y as f64, w, h, 0.0);
                    assert_eq!(cov, 1.0, "radius 0 must cover ({x},{y}) of {w}x{h} fully");
                }
            }
        }
    }

    /// A negative radius is "no rounding", matching [`ClipTransform::
    /// is_identity`]'s own `<= 0.0` test — the two have to agree about what
    /// gets painted, exactly as the crop insets' clamp and predicate do.
    #[test]
    fn corner_coverage_treats_a_negative_radius_as_no_rounding() {
        assert_eq!(corner_coverage(0.0, 0.0, 8.0, 8.0, -5.0), 1.0);
    }

    /// **Cross-engine parity, pinned as real numbers.** These are the actual
    /// alpha bytes REAL ffmpeg produced for the exporter's own
    /// `cornerRadiusMaskExpr` on a 100×100 opaque layer at radius 20
    /// (`docs/notes/rounded-corners.md` records the probe). The Rust
    /// compositor must reproduce them to within ffmpeg's own 1/255 alpha
    /// quantisation — which is the difference between the two engines
    /// "agreeing" and merely "both looking rounded", and is the test B-201's
    /// postmortem says should have existed on the first day of a two-engine
    /// field rather than the day after the divergence was noticed.
    #[test]
    fn corner_coverage_matches_real_ffmpegs_own_measured_alpha() {
        // (x, y, the byte real ffmpeg wrote)
        const MEASURED: &[(u32, u32, u8)] = &[
            (0, 0, 0),
            (3, 0, 0),
            (7, 4, 149),
            (6, 5, 175),
            (7, 5, 255),
            (5, 6, 175),
            (4, 7, 149),
            (50, 0, 255),
            (0, 50, 255),
            (50, 50, 255),
        ];
        for &(x, y, expected) in MEASURED {
            let cov = corner_coverage(x as f64, y as f64, 100.0, 100.0, 20.0);
            let got = (cov * 255.0).round() as i32;
            assert!(
                (got - expected as i32).abs() <= 1,
                "({x},{y}): preview {got} vs real ffmpeg {expected} — more than \
                 one quantisation step apart, the two engines have diverged",
            );
        }
    }

    /// An over-large radius becomes a pill/circle rather than a degenerate
    /// shape — the clamp to `min(w, h) / 2`, which both engines apply at the
    /// point of use. On a square box that means a circle: the centre is solid,
    /// all four corners are gone, and the edge MIDPOINTS survive (a circle
    /// inscribed in the square touches them).
    #[test]
    fn corner_coverage_clamps_an_over_large_radius_to_a_circle() {
        let (w, h) = (64.0, 64.0);
        assert_eq!(corner_coverage(32.0, 32.0, w, h, 10_000.0), 1.0);
        assert_eq!(corner_coverage(0.0, 0.0, w, h, 10_000.0), 0.0);
        assert!(
            corner_coverage(31.0, 0.0, w, h, 10_000.0) > 0.5,
            "edge midpoint kept"
        );
    }

    /// The **fast (sampled, magnifying, un-rotated) compositing path** really
    /// rounds: the layer's own corner on the canvas is gone, its centre and its
    /// edge midpoints are not. `scale: 2.0` on a 10×10 layer keeps this on
    /// `blend_layer_sampled` (the `sw >= lw` branch), which is the path that
    /// computes the mask per DESTINATION pixel rather than over a buffer.
    #[test]
    fn composite_layer_onto_rounds_corners_on_the_sampled_path() {
        let mut canvas = flat(20, 20, [0, 0, 0, 255]);
        let layer = flat(10, 10, [255, 0, 0, 255]);
        let t = ClipTransform {
            scale: 2.0,
            corner_radius: 6.0,
            ..identity_transform()
        };
        composite_layer_onto(&mut canvas, &layer, &t, natural_of(&layer));
        // The 10x10 layer at scale 2 exactly fills the 20x20 canvas.
        assert_eq!(
            *canvas.get_pixel(0, 0),
            Rgba([0, 0, 0, 255]),
            "corner rounded off"
        );
        assert_eq!(
            *canvas.get_pixel(19, 0),
            Rgba([0, 0, 0, 255]),
            "corner rounded off"
        );
        assert_eq!(
            *canvas.get_pixel(0, 19),
            Rgba([0, 0, 0, 255]),
            "corner rounded off"
        );
        assert_eq!(
            *canvas.get_pixel(19, 19),
            Rgba([0, 0, 0, 255]),
            "corner rounded off"
        );
        assert_eq!(
            *canvas.get_pixel(10, 10),
            Rgba([255, 0, 0, 255]),
            "centre kept"
        );
        assert_eq!(
            *canvas.get_pixel(10, 0),
            Rgba([255, 0, 0, 255]),
            "top edge kept"
        );
        assert_eq!(
            *canvas.get_pixel(0, 10),
            Rgba([255, 0, 0, 255]),
            "left edge kept"
        );
    }

    /// The **general (buffer) path** rounds identically — and the mask is
    /// applied BEFORE the rotation, so at 90° the rounded corners have rotated
    /// with the picture instead of staying axis-aligned. A 90° turn maps the
    /// box onto itself, so "still rounded at all four corners, still solid in
    /// the middle" is exactly the assertion that distinguishes the two orders
    /// from a mask applied after.
    #[test]
    fn composite_layer_onto_rounds_corners_before_rotating() {
        let mut canvas = flat(20, 20, [0, 0, 0, 255]);
        let layer = flat(20, 20, [255, 0, 0, 255]);
        let t = ClipTransform {
            rotation: 90.0,
            corner_radius: 6.0,
            ..identity_transform()
        };
        composite_layer_onto(&mut canvas, &layer, &t, natural_of(&layer));
        assert_eq!(
            *canvas.get_pixel(0, 0),
            Rgba([0, 0, 0, 255]),
            "corner rounded off"
        );
        assert_eq!(
            *canvas.get_pixel(19, 19),
            Rgba([0, 0, 0, 255]),
            "corner rounded off"
        );
        assert_eq!(
            *canvas.get_pixel(10, 10),
            Rgba([255, 0, 0, 255]),
            "centre kept"
        );
    }

    /// Rounding MULTIPLIES the alpha the crop already wrote rather than
    /// replacing it — a cropped-away pixel must not be un-hidden by a rounded
    /// clip, the same composition rule `opacity` follows.
    #[test]
    fn corner_radius_rounds_the_cropped_box_not_the_uncropped_layer() {
        let mut canvas = flat(20, 20, [0, 0, 0, 255]);
        let layer = flat(20, 20, [255, 0, 0, 255]);
        // The right half of the layer, landed 1:1 in a 10x20 box at the
        // canvas's top-left, rounded. B-218 — the rounding follows the box the
        // CROP produces, so both of its own corners are rounded away; before
        // the fix the box was the uncropped 20x20 one and these two pixels
        // were square (and the painted area was the other half of the canvas).
        let t = ClipTransform {
            crop_left: 0.5,
            box_width: Some(0.5),
            box_height: Some(1.0),
            corner_radius: 4.0,
            ..identity_transform()
        };
        composite_layer_onto(&mut canvas, &layer, &t, natural_of(&layer));
        assert_eq!(
            *canvas.get_pixel(5, 10),
            Rgba([255, 0, 0, 255]),
            "the box's interior is painted"
        );
        assert_eq!(
            *canvas.get_pixel(0, 0),
            Rgba([0, 0, 0, 255]),
            "the cropped box's own top-left corner is rounded away"
        );
        assert_eq!(
            *canvas.get_pixel(9, 19),
            Rgba([0, 0, 0, 255]),
            "and so is its bottom-right"
        );
        assert_eq!(
            *canvas.get_pixel(15, 10),
            Rgba([0, 0, 0, 255]),
            "nothing is painted outside the box"
        );
    }

    /// D-344 — `corner_radius` is authored in OUTPUT pixels, so rendering the
    /// same composition into a half-size preview buffer must halve it; every
    /// other field is a ratio and is untouched. Zero stays exactly zero at
    /// every scale, which is what keeps the default free.
    #[test]
    fn scaled_to_render_converts_output_pixels_into_canvas_pixels() {
        let t = ClipTransform {
            corner_radius: 24.0,
            scale: 1.5,
            position_x: 0.25,
            ..identity_transform()
        }
        .scaled_to_render(0.5);
        assert_eq!(t.corner_radius, 12.0);
        assert_eq!(t.scale, 1.5, "a ratio must not be rescaled");
        assert_eq!(t.position_x, 0.25, "a ratio must not be rescaled");
        assert_eq!(
            identity_transform().scaled_to_render(0.5).corner_radius,
            0.0
        );
    }

    /// A rounded clip is NOT the identity, so `timeline_frame`'s single-layer
    /// plain-decode fast path cannot silently discard the rounding — which is
    /// exactly the D-132/B-053 defect this predicate exists to prevent.
    #[test]
    fn a_rounded_clip_is_not_the_identity_transform() {
        assert!(identity_transform().is_identity());
        assert!(
            !ClipTransform {
                corner_radius: 1.0,
                ..identity_transform()
            }
            .is_identity()
        );
    }

    /// `corner_radius` rides the same D-034 keyframe engine as every other
    /// transform field — the exporter's `geq` mask is re-evaluated per frame,
    /// so an animated radius is a picture BOTH engines can produce.
    #[test]
    fn resolve_clip_transform_resolves_a_keyframed_corner_radius() {
        let clip = Clip {
            corner_radius: 0.0,
            chroma_keyframes: Some(serde_json::json!([
                {"frame": 0, "params": {"corner_radius": 0.0}},
                {"frame": 10, "params": {"corner_radius": 20.0}},
            ])),
            ..Clip::default()
        };
        assert_eq!(resolve_clip_transform(&clip, 0).corner_radius, 0.0);
        assert_eq!(resolve_clip_transform(&clip, 10).corner_radius, 20.0);
        let mid = resolve_clip_transform(&clip, 5).corner_radius;
        assert!(mid > 0.0 && mid < 20.0, "expected a real ramp, got {mid}");
    }

    /// A TEXT clip's radius is pinned to zero: the export compiles a title to
    /// `drawtext`, which cannot mask its own corners, so a preview that
    /// rounded one would be showing a picture the export cannot produce — the
    /// same parity reasoning that pins `scale`/`rotation`/`crop_*` there.
    #[test]
    fn a_text_clips_corner_radius_is_pinned_to_zero() {
        let clip = Clip {
            corner_radius: 30.0,
            text: Some(apelles_timeline::TextLayer::default()),
            ..Clip::default()
        };
        assert_eq!(resolve_text_clip_transform(&clip, 0).corner_radius, 0.0);
        assert_eq!(plate_transform(1.0).corner_radius, 0.0);
    }

    /// Crop composes with the rest of the transform rather than replacing it —
    /// **and B-218 fixed which way round they compose.** `scale` sets the
    /// box's WIDTH from the canvas exactly as before (`natural.0 * scale`,
    /// crop-independent, mirroring the exporter's `widthExpr`); the CROP then
    /// decides what fills that width and how tall it is.
    #[test]
    fn crop_composes_with_scale() {
        let mut canvas = flat(20, 20, [0, 0, 0, 255]);
        let layer = flat(4, 4, [255, 0, 0, 255]);
        // scale 2 -> width 4 * 2 = 8, unchanged by the crop. crop_left 0.5
        // keeps a 2x4 sub-image, whose 1:2 aspect makes the box 8x16 with its
        // top-left at (0,0). Before B-218 the same transform produced an 8x8
        // box with only its right half painted — the exporter's own
        // `crop=2:4:2:0, scale=8:-2` has always produced this one.
        let t = ClipTransform {
            scale: 2.0,
            crop_left: 0.5,
            ..identity_transform()
        };
        composite_layer_onto(&mut canvas, &layer, &t, natural_of(&layer));
        assert_eq!(*canvas.get_pixel(0, 0), Rgba([255, 0, 0, 255])); // the crop fills the box
        assert_eq!(*canvas.get_pixel(7, 15), Rgba([255, 0, 0, 255])); // ...all 8x16 of it
        assert_eq!(*canvas.get_pixel(8, 4), Rgba([0, 0, 0, 255])); // past the box's width
        assert_eq!(*canvas.get_pixel(4, 16), Rgba([0, 0, 0, 255])); // past its height
    }

    /// An uncropped layer takes the untouched pre-D-132 path — proved by
    /// output equality with the same composite run through the explicit
    /// zero-inset transform, so the "no crop costs nothing" claim in
    /// `composite_layer_onto`'s doc is a tested one.
    #[test]
    fn an_uncropped_layer_is_unchanged_by_the_crop_pass() {
        let layer = flat(6, 6, [3, 200, 40, 255]);
        let mut with_zero_insets = flat(10, 10, [0, 0, 0, 255]);
        composite_layer_onto(
            &mut with_zero_insets,
            &layer,
            &identity_transform(),
            natural_of(&layer),
        );
        let mut with_negative_insets = flat(10, 10, [0, 0, 0, 255]);
        let t = ClipTransform {
            crop_left: -1.0,
            crop_bottom: -1.0,
            ..identity_transform()
        };
        composite_layer_onto(&mut with_negative_insets, &layer, &t, natural_of(&layer));
        assert_eq!(with_zero_insets, with_negative_insets);
    }

    /// D-132 — crop rides the same D-034 keyframe engine as every other
    /// transform field (which is why the insets are four flat scalars and
    /// not a nested rect: that interpolator takes a flat params object).
    #[test]
    fn resolve_clip_transform_interpolates_crop_keyframes() {
        let clip = Clip {
            crop_left: 0.0,
            chroma_keyframes: Some(serde_json::json!([
                { "frame": 0, "params": { "crop_left": 0.0 } },
                { "frame": 100, "params": { "crop_left": 1.0 } },
            ])),
            ..Default::default()
        };
        let t = resolve_clip_transform(&clip, 50);
        assert!(
            (t.crop_left - 0.5).abs() < 0.01,
            "expected ~0.5, got {}",
            t.crop_left
        );
    }

    /// D-132 — the static crop fields are read straight off the clip when
    /// it isn't keyframed, the same way the D-082 five already are.
    #[test]
    fn resolve_clip_transform_reads_static_crop_fields() {
        let clip = Clip {
            crop_left: 0.1,
            crop_top: 0.2,
            crop_right: 0.3,
            crop_bottom: 0.4,
            ..Default::default()
        };
        let t = resolve_clip_transform(&clip, 0);
        assert_eq!(
            (t.crop_left, t.crop_top, t.crop_right, t.crop_bottom),
            (0.1, 0.2, 0.3, 0.4)
        );
    }

    /// B-053 — the predicate `timeline_frame`'s single-layer fast path is
    /// gated on. A freshly-defaulted clip is identity (so the common case
    /// still skips compositing entirely and stays byte-identical); a clip
    /// with a crop — or with any of the D-082 fields set, which used to be
    /// silently ignored on that path — is not.
    #[test]
    fn only_a_genuinely_untransformed_clip_takes_the_fast_path() {
        assert!(resolve_clip_transform(&Clip::default(), 0).is_identity());
        for clip in [
            Clip {
                crop_left: 0.01,
                ..Default::default()
            },
            Clip {
                crop_bottom: 0.5,
                ..Default::default()
            },
            Clip {
                opacity: 0.5,
                ..Default::default()
            },
            Clip {
                position_x: 4.0,
                ..Default::default()
            },
            Clip {
                scale: 1.5,
                ..Default::default()
            },
            Clip {
                rotation: 90.0,
                ..Default::default()
            },
        ] {
            assert!(
                !resolve_clip_transform(&clip, 0).is_identity(),
                "{clip:?} should not be identity"
            );
        }
        // a negative inset changes no pixel, so it must not force the slow
        // path either — the predicate has to agree with `crop_pixel_rect`.
        assert!(
            resolve_clip_transform(
                &Clip {
                    crop_top: -0.2,
                    ..Default::default()
                },
                0
            )
            .is_identity()
        );
    }

    // ----------------------------------------------------------------- //
    // D-211 — text/title clips
    // ----------------------------------------------------------------- //

    fn text_clip(content: &str) -> Clip {
        Clip {
            id: "t".into(),
            name: "Title".into(),
            duration: 48,
            source_len: 48,
            text: Some(apelles_timeline::TextLayer {
                content: content.into(),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    /// The Phase 1 boundary, enforced at the compositor: a text clip's
    /// opacity, fade and position are honoured; scale/rotation/crop/box are
    /// pinned to identity because `drawtext` (the export path) cannot
    /// reproduce them. See `resolve_text_clip_transform`'s own doc.
    #[test]
    fn a_text_clips_transform_keeps_position_and_opacity_and_drops_the_rest() {
        let clip = Clip {
            opacity: 0.4,
            position_x: 0.25,
            position_y: -0.1,
            scale: 3.0,
            rotation: 45.0,
            crop_left: 0.3,
            crop_bottom: 0.2,
            box_width: Some(0.5),
            box_height: Some(0.5),
            ..text_clip("AFTER")
        };
        let t = resolve_text_clip_transform(&clip, 0);
        assert_eq!(t.opacity, 0.4);
        assert_eq!(t.position_x, 0.25);
        assert_eq!(t.position_y, -0.1);
        assert_eq!(t.scale, 1.0);
        assert_eq!(t.rotation, 0.0);
        assert_eq!(t.crop_left, 0.0);
        assert_eq!(t.crop_bottom, 0.0);
        assert_eq!(t.box_width, None);
        assert_eq!(t.box_height, None);
    }

    /// A text clip's own keyframed position and its fade both still resolve —
    /// the two things Phase 1 promises are animatable — through exactly the
    /// same D-034 engine and D-147 multiply a media clip uses.
    #[test]
    fn a_text_clips_position_keyframes_and_fade_still_resolve() {
        let clip = Clip {
            chroma_keyframes: Some(serde_json::json!([
                { "frame": 0,  "params": { "position_x": 0.0 } },
                { "frame": 10, "params": { "position_x": 0.5 } },
            ])),
            fade_in_frames: 10,
            ..text_clip("AFTER")
        };
        assert!((resolve_text_clip_transform(&clip, 5).position_x - 0.25).abs() < 1e-9);
        assert!((resolve_text_clip_transform(&clip, 10).position_x - 0.5).abs() < 1e-9);
        // Fade-in: half opacity halfway through a 10-frame linear ramp.
        let faded = resolve_text_clip_transform(&clip, 5).opacity;
        assert!((faded - 0.5).abs() < 1e-6, "fade multiplier was {faded}");
        assert!((resolve_text_clip_transform(&clip, 0).opacity).abs() < 1e-9);
    }

    /// The lone-layer fast path decodes `source_path` — a text clip has none,
    /// so it must never be eligible for it (it would be a decode of "").
    #[test]
    fn a_lone_text_clip_never_takes_the_plain_decode_fast_path() {
        let clip = text_clip("AFTER");
        // Its transform IS identity — which is exactly why the fast-path
        // guard cannot be `is_identity()` alone for a text clip.
        assert!(resolve_clip_transform(&clip, 0).is_identity());
        assert!(clip.is_text());
        assert!(clip.source_path.is_empty());
    }

    /// A text layer really does composite onto a frame: white text over a
    /// black backdrop leaves lit pixels where the glyphs are and untouched
    /// black everywhere else. The same alpha-over path a video layer takes —
    /// `composite_layer_onto`, unchanged by D-211.
    #[test]
    fn a_rendered_text_layer_composites_over_the_frame_beneath_it() {
        const W: u32 = 320;
        const H: u32 = 180;
        let mut canvas: image::RgbaImage = ImageBuffer::from_pixel(W, H, Rgba([0, 0, 0, 255]));
        let layer = super::text::render_text_layer(
            &apelles_timeline::TextLayer {
                content: "III".into(),
                ..Default::default()
            },
            W,
            H,
        )
        .expect("rasterise");
        composite_layer_onto(
            &mut canvas,
            &layer,
            &identity_transform(),
            (W as f64, H as f64),
        );

        let lit = canvas.pixels().filter(|p| p[0] > 200).count();
        assert!(lit > 20, "expected real white glyph pixels, got {lit}");
        // The corners are nowhere near centred text — still pure black.
        for (x, y) in [(0, 0), (W - 1, 0), (0, H - 1), (W - 1, H - 1)] {
            assert_eq!(canvas.get_pixel(x, y).0, [0, 0, 0, 255]);
        }
    }

    // ----------------------------------------------------------------- //
    // D-396 — clip highlights
    // ----------------------------------------------------------------- //

    fn stroke(rect: [f64; 4], at: i64, dur: i64) -> apelles_timeline::Highlight {
        apelles_timeline::Highlight {
            rect,
            at,
            dur,
            color: None,
            opacity: None,
        }
    }

    fn luminance(px: [u8; 4]) -> f64 {
        let lin = |c: u8| {
            let c = f64::from(c) / 255.0;
            if c <= 0.04045 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * lin(px[0]) + 0.7152 * lin(px[1]) + 0.0722 * lin(px[2])
    }

    fn contrast(a: [u8; 4], b: [u8; 4]) -> f64 {
        let (la, lb) = (luminance(a), luminance(b));
        (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
    }

    /// No highlights, or none started yet: the buffer is neither changed nor
    /// copied (the `Arc` is still the one the caller handed in).
    #[test]
    fn highlights_that_have_not_started_leave_the_picture_and_its_arc_untouched() {
        let shared = std::sync::Arc::new(noisy(40, 30, 7));
        let mut img = shared.clone();
        apply_highlights_to_rgba(&mut img, &[], 0);
        apply_highlights_to_rgba(&mut img, &[stroke([0.1, 0.1, 0.9, 0.5], 10, 10)], 9);
        assert!(
            std::sync::Arc::ptr_eq(&img, &shared),
            "no copy before the sweep"
        );
        assert_eq!(*img, *shared);
    }

    /// The stroke paints only inside its box, sweeps left to right, and leaves
    /// every pixel outside the box byte-identical.
    #[test]
    fn a_highlight_paints_only_its_box_and_sweeps_left_to_right() {
        let base = noisy(100, 60, 3);
        let one = [stroke([0.2, 0.25, 0.8, 0.75], 0, 10)];
        let paint = |frame: i64| {
            let mut img = std::sync::Arc::new(base.clone());
            apply_highlights_to_rgba(&mut img, &one, frame);
            (*img).clone()
        };
        let (mid, done) = (paint(4), paint(10));
        // Outside the box (and its antialiased rim): untouched.
        for (x, y) in [(0, 0), (99, 59), (10, 30), (90, 30), (50, 5), (50, 55)] {
            assert_eq!(done.get_pixel(x, y), base.get_pixel(x, y), "({x},{y})");
        }
        // Inside, the finished stroke has moved the pixel; mid-sweep the right
        // part is still unpainted while the left part is.
        assert_ne!(done.get_pixel(70, 30), base.get_pixel(70, 30));
        assert_eq!(mid.get_pixel(70, 30), base.get_pixel(70, 30));
        assert_ne!(mid.get_pixel(25, 30), base.get_pixel(25, 30));
    }

    /// A finished stroke stays put for the rest of the clip.
    #[test]
    fn a_swept_highlight_stays_for_the_rest_of_the_clip() {
        let base = noisy(60, 40, 5);
        let one = [stroke([0.1, 0.2, 0.9, 0.8], 0, 8)];
        let paint = |frame: i64| {
            let mut img = std::sync::Arc::new(base.clone());
            apply_highlights_to_rgba(&mut img, &one, frame);
            (*img).clone()
        };
        assert_eq!(paint(8), paint(9_999));
    }

    /// **The stroke reads on both an article page and a dark one** (the scope's
    /// "test both"): the page colour changes visibly (1.3:1 on white, 3.0:1 on
    /// dark), and text under the stroke keeps at least WCAG's large-text 3:1
    /// against it (measured 4.8:1 dark-on-white, 4.1:1 light-on-dark).
    #[test]
    fn the_default_stroke_reads_on_white_and_dark_pages_and_keeps_text_legible() {
        for (page, text) in [
            ([255, 255, 255, 255], [20, 20, 20, 255]),
            ([24, 24, 27, 255], [235, 235, 235, 255]),
        ] {
            let mut img = std::sync::Arc::new(flat(20, 20, page));
            apply_highlights_to_rgba(&mut img, &[stroke([0.0, 0.0, 1.0, 1.0], 0, 0)], 0);
            let stroked = img.get_pixel(10, 10).0;
            assert!(
                contrast(page, stroked) > 1.25,
                "stroke is not visible on page {page:?}: {stroked:?}"
            );
            // Text under the stroke is blended with the same operator.
            let mut t = std::sync::Arc::new(flat(20, 20, text));
            apply_highlights_to_rgba(&mut t, &[stroke([0.0, 0.0, 1.0, 1.0], 0, 0)], 0);
            let ratio = contrast(stroked, t.get_pixel(10, 10).0);
            assert!(
                ratio >= 3.0,
                "text under the stroke on {page:?}: {ratio:.2}:1"
            );
        }
    }

    /// **The cross-engine pin.** `[frame, x, y, r, g, b]` measured from real
    /// ffmpeg running the exporter's own `geq` node on a flat white 100x60
    /// picture -- the identical table `HIGHLIGHT_PROFILE` in
    /// `packages/editor/src/timelineExportHighlight.ffmpeg.test.ts` asserts on
    /// the ffmpeg side. The compositor must reproduce every value to within one
    /// 8-bit level (the two compute in different float widths), so a change to
    /// either engine's formula that the other does not get fails one suite.
    ///
    /// The one exception is the pen's leading-edge pixel while it is still
    /// moving (frames 2 and 4): the exporter samples the ease-out curve as 32
    /// straight pieces where this evaluates the bezier exactly, a bounded
    /// ~0.04 px difference in where the edge sits, worth up to ~4 levels on
    /// that one antialiased pixel (D-197's documented asymmetry, measured).
    #[test]
    fn highlight_matches_real_ffmpegs_own_measured_pixels() {
        const PROFILE: &[(i64, u32, u32, [u8; 3])] = &[
            (10, 19, 30, [255, 255, 255]),
            (10, 20, 30, [249, 222, 166]),
            (10, 20, 15, [249, 222, 166]),
            (10, 20, 44, [249, 222, 166]),
            (10, 50, 30, [249, 222, 166]),
            (10, 50, 14, [255, 255, 255]),
            (10, 50, 15, [249, 222, 166]),
            (10, 50, 44, [249, 222, 166]),
            (10, 50, 45, [255, 255, 255]),
            (10, 79, 30, [249, 222, 166]),
            (10, 80, 30, [255, 255, 255]),
            (10, 79, 15, [255, 255, 255]),
            (10, 73, 15, [249, 224, 172]),
            (10, 74, 15, [250, 231, 191]),
            (10, 75, 15, [252, 242, 220]),
            (10, 76, 16, [250, 229, 185]),
            (10, 77, 17, [249, 224, 172]),
            (10, 78, 18, [250, 229, 185]),
            (10, 79, 19, [252, 242, 220]),
            (10, 79, 21, [249, 224, 172]),
            (2, 50, 30, [252, 241, 218]),
            (2, 51, 30, [255, 255, 255]),
            (4, 67, 30, [250, 231, 192]),
            (4, 68, 30, [255, 255, 255]),
            (7, 77, 30, [250, 228, 182]),
            (7, 78, 30, [255, 255, 255]),
        ];
        let canonical = [stroke([0.2, 0.25, 0.8, 0.75], 0, 10)];
        let mut diffs = Vec::new();
        for &(frame, x, y, want) in PROFILE {
            let mut img = std::sync::Arc::new(flat(100, 60, [255, 255, 255, 255]));
            apply_highlights_to_rgba(&mut img, &canonical, frame);
            let got = img.get_pixel(x, y).0;
            let tolerance = if frame == 10 || frame == 7 { 1 } else { 5 };
            if (0..3).any(|c| got[c].abs_diff(want[c]) > tolerance) {
                diffs.push(format!(
                    "frame {frame} ({x},{y}): got {:?}, ffmpeg measured {want:?}",
                    &got[..3]
                ));
            }
        }
        assert!(
            diffs.is_empty(),
            "compositor diverged from ffmpeg:\n{}",
            diffs.join("\n")
        );
    }

    /// The same operator on a dark page, pinned to the ffmpeg-measured value
    /// (truncation included): `24 + 0.45*(242-24) = 122.1`, `... = 95.1`,
    /// `27 + 0.45*(58-27) = 40.95 -> 40`.
    #[test]
    fn highlight_blends_over_a_dark_page_like_ffmpeg() {
        let mut img = std::sync::Arc::new(flat(100, 60, [24, 24, 27, 255]));
        apply_highlights_to_rgba(&mut img, &[stroke([0.2, 0.25, 0.8, 0.75], 0, 10)], 10);
        assert_eq!(img.get_pixel(50, 30).0, [122, 95, 40, 255]);
        assert_eq!(img.get_pixel(5, 5).0, [24, 24, 27, 255]);
    }

    /// Strokes apply in list order: a later one is drawn over an earlier one.
    #[test]
    fn highlights_apply_in_list_order_later_over_earlier() {
        let mut a = stroke([0.0, 0.0, 1.0, 1.0], 0, 0);
        a.color = Some("#ff0000".into());
        a.opacity = Some(1.0);
        let mut b = stroke([0.0, 0.0, 1.0, 1.0], 0, 0);
        b.color = Some("#0000ff".into());
        b.opacity = Some(1.0);
        let mut img = std::sync::Arc::new(flat(10, 10, [255, 255, 255, 255]));
        apply_highlights_to_rgba(&mut img, &[a, b], 0);
        assert_eq!(img.get_pixel(5, 5).0, [0, 0, 255, 255]);
    }
}

/// B-152 — [`composition_size`] must derive the project's composition/export
/// resolution from the timeline's real footage, never incidentally from
/// whatever image happens to sit first in track order (a `match_to_reference`
/// comparison photo, a title card, anything non-representative).
///
/// Needs a real decodable video fixture (`clip_source_size` probes it via
/// `ffmpeg`), kept out of the pure `composite_tests` module above for the same
/// reason `preview_text_tests` is — skipped (not failed) without ffmpeg on
/// PATH.
#[cfg(test)]
mod composition_size_tests {
    use apelles_timeline::{Clip, Timeline, Track, TrackKind};

    use super::*;

    fn have_ffmpeg() -> bool {
        apelles_media::ffmpeg_locate::ffmpeg_path().is_ok()
    }

    /// A tiny real, decodable video fixture at `(w, h)` — one frame is enough,
    /// `clip_source_size` only probes the stream's dimensions.
    fn video_fixture(path: &std::path::Path, w: u32, h: u32) {
        let ok = apelles_media::ffmpeg_locate::ffmpeg()
            .expect("an ffmpeg to build the fixture")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                &format!("color=black:size={w}x{h}:rate=1"),
                "-frames:v",
                "1",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("spawn ffmpeg");
        assert!(ok.success(), "generating the video fixture failed");
    }

    /// A tiny real PNG still fixture at `(w, h)` — a wrong-aspect "reference
    /// image" stand-in, probed by `apelles_media::still` (no ffmpeg needed).
    fn still_fixture(path: &std::path::Path, w: u32, h: u32) {
        image::RgbaImage::new(w, h)
            .save(path)
            .expect("write still fixture");
    }

    fn video_clip(id: &str, path: &std::path::Path) -> Clip {
        Clip {
            id: id.into(),
            name: id.into(),
            source_path: path.to_string_lossy().into_owned(),
            duration: 24,
            source_len: 24,
            start_frame: 0,
            ..Default::default()
        }
    }

    /// The B-152 repro: track 0's first clip is a 2000×1130 reference photo
    /// (a `match_to_reference` grading aid, not footage), track 1 holds the
    /// project's real 3840×2160 camera clip. With no explicit project
    /// width/height, the composition must come from the real footage, not
    /// from whichever clip happens to be first in track order.
    #[test]
    fn composition_size_prefers_real_video_over_a_first_track_reference_image() {
        if !have_ffmpeg() {
            eprintln!("skipping: no ffmpeg on PATH");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let reference_photo = tmp.path().join("reference.png");
        still_fixture(&reference_photo, 2000, 1130);
        let camera_footage = tmp.path().join("camera.mp4");
        video_fixture(&camera_footage, 3840, 2160);

        let timeline = Timeline {
            id: "tl1".into(),
            name: "Timeline 1".into(),
            rate: None,
            tracks: vec![
                Track {
                    kind: TrackKind::Video,
                    clips: vec![video_clip("reference", &reference_photo)],
                    ..Default::default()
                },
                Track {
                    kind: TrackKind::Video,
                    clips: vec![video_clip("camera", &camera_footage)],
                    ..Default::default()
                },
            ],
            markers: Vec::new(),
        };
        let settings = project::ProjectSettings::default();

        let (w, h) = composition_size(&settings, &timeline).expect("composition size");
        assert_eq!(
            (w, h),
            (3840, 2160),
            "composition size must come from the real camera footage, not the \
             2000x1130 reference photo that happens to sit on track 0"
        );
    }

    /// A genuinely image-only project (a slideshow) must keep working exactly
    /// as before — falling back to the first still when no real video exists
    /// anywhere on the timeline, per the bug writeup's own "don't break a
    /// genuinely image-first project" constraint.
    #[test]
    fn composition_size_falls_back_to_a_still_when_no_real_video_exists() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let slide = tmp.path().join("slide.png");
        still_fixture(&slide, 1200, 800);

        let timeline = Timeline {
            id: "tl1".into(),
            name: "Timeline 1".into(),
            rate: None,
            tracks: vec![Track {
                kind: TrackKind::Video,
                clips: vec![video_clip("slide", &slide)],
                ..Default::default()
            }],
            markers: Vec::new(),
        };
        let settings = project::ProjectSettings::default();

        let (w, h) = composition_size(&settings, &timeline).expect("composition size");
        assert_eq!((w, h), (1200, 800));
    }

    /// B-276 — no explicit size and nothing on a video track (a voice-over and
    /// a music bed only): refused by name, telling the caller to set the
    /// project size, never "no clip" while clips are there.
    /// `derived_composition_size` answers `None` for the same project, which is
    /// what lets an export stand its own size in.
    #[test]
    fn a_sizeless_project_is_refused_by_name() {
        let audio = |id: &str| Clip {
            id: id.into(),
            name: id.into(),
            source_path: format!("/nonexistent/{id}.wav"),
            duration: 24,
            source_len: 24,
            ..Default::default()
        };
        let timeline = Timeline {
            id: "tl1".into(),
            name: "Timeline 1".into(),
            rate: None,
            tracks: vec![
                Track {
                    kind: TrackKind::Video,
                    clips: Vec::new(),
                    ..Default::default()
                },
                Track {
                    kind: TrackKind::Audio,
                    clips: vec![audio("vo"), audio("music")],
                    ..Default::default()
                },
            ],
            markers: Vec::new(),
        };
        let settings = project::ProjectSettings::default();

        let err = composition_size(&settings, &timeline).expect_err("sizeless");
        assert_eq!(err, NO_COMPOSITION_SIZE);
        assert!(err.contains("set_project_settings"));
        assert_eq!(
            derived_composition_size(&settings, &timeline).expect("not a failure"),
            None
        );
    }

    /// An explicit project width/height always wins, even over real footage of
    /// a different aspect — unchanged pre-existing behavior, not a B-152
    /// consequence, but load-bearing enough to pin down alongside the fix.
    #[test]
    fn composition_size_prefers_explicit_settings_over_any_clip() {
        if !have_ffmpeg() {
            eprintln!("skipping: no ffmpeg on PATH");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let camera_footage = tmp.path().join("camera.mp4");
        video_fixture(&camera_footage, 3840, 2160);

        let timeline = Timeline {
            id: "tl1".into(),
            name: "Timeline 1".into(),
            rate: None,
            tracks: vec![Track {
                kind: TrackKind::Video,
                clips: vec![video_clip("camera", &camera_footage)],
                ..Default::default()
            }],
            markers: Vec::new(),
        };
        let settings = project::ProjectSettings {
            width: Some(1920),
            height: Some(1080),
            ..Default::default()
        };

        let (w, h) = composition_size(&settings, &timeline).expect("composition size");
        assert_eq!((w, h), (1920, 1080));
    }
}

/// D-211 — the text/title clip's **live-preview path, end to end**: a real
/// `.chroma` project on disk, a real video source, and the actual
/// [`timeline_frame`] command the preview pane calls over IPC — resolve the
/// visible layers, rasterise the title, composite, JPEG-encode — with the
/// returned data-URL decoded back to pixels and checked.
///
/// Kept out of the pure `composite_tests` module above for the same reason
/// `preview_throughput_tests` is: it needs real `ffmpeg` on PATH and writes
/// real files. Skipped (not failed) without ffmpeg, matching the posture
/// `packages/editor/src/timelineExportText.ffmpeg.test.ts` takes on the
/// export side — the two files together are what make "the preview matches
/// the export" a checked claim rather than an assertion.
#[cfg(test)]
mod preview_text_tests {
    use apelles_timeline::{Clip, TextLayer, Timeline, Track, TrackKind};

    const W: u32 = 320;
    const H: u32 = 180;

    use super::super::PROJECT_STATE_LOCK;

    fn have_ffmpeg() -> bool {
        apelles_media::ffmpeg_locate::ffmpeg_path().is_ok()
    }

    /// A flat black clip, so any lit pixel in the composited frame is the
    /// title and nothing else.
    fn black_clip(path: &std::path::Path) {
        let ok = apelles_media::ffmpeg_locate::ffmpeg()
            .expect("an ffmpeg to build the fixture")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                &format!("color=black:size={W}x{H}:rate=24:duration=2"),
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("spawn ffmpeg");
        assert!(ok.success(), "generating the black fixture clip failed");
    }

    /// A project with a title on track 0 (topmost = drawn last, over
    /// everything) and the black source on track 1 — exactly the layout the
    /// Add-title button and `editor_add_text_clip` both produce.
    fn open_title_project(video: &std::path::Path) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().expect("tempdir");
        let project_dir = tmp.path().join("Titles.chroma");
        std::fs::create_dir_all(&project_dir).expect("mkdir project dir");

        let title = Clip {
            id: "title".into(),
            name: "AFTER".into(),
            duration: 48,
            source_len: 48,
            start_frame: 0,
            text: Some(TextLayer {
                content: "AFTER".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        let under = Clip {
            id: "under".into(),
            name: "under".into(),
            source_path: video.to_string_lossy().into_owned(),
            source_start: 0,
            duration: 48,
            source_len: 48,
            start_frame: 0,
            ..Default::default()
        };

        // An explicit composition size, so `composition_size` never has to
        // fall back to probing a clip — the title has no source to probe.
        let settings = super::project::ProjectSettings {
            width: Some(W),
            height: Some(H),
            ..Default::default()
        };

        let manifest = super::project::ProjectManifest {
            schema: "chroma.project/1".into(),
            name: "Titles".into(),
            created: String::new(),
            modified: String::new(),
            shots: Vec::new(),
            active_shot: 0,
            active_clip_id: None,
            settings,
            timelines: vec![Timeline {
                id: "tl1".into(),
                name: "Titles".into(),
                rate: None,
                tracks: vec![
                    Track {
                        kind: TrackKind::Video,
                        clips: vec![title],
                        ..Default::default()
                    },
                    Track {
                        kind: TrackKind::Video,
                        clips: vec![under],
                        ..Default::default()
                    },
                ],
                markers: Vec::new(),
            }],
            active_timeline: 0,
            media: Vec::new(),
            folders: Vec::new(),
        };
        super::project::save_manifest(&project_dir, &manifest).expect("save manifest");
        super::state::set_project(Some(super::state::ProjectRef {
            path: project_dir,
            name: "Titles".into(),
        }));
        tmp
    }

    /// `timeline_frame`'s raw JPEG bytes (D-217), decoded back to real pixels —
    /// the same bytes the preview `<img>` shows via its `Blob` URL.
    fn decode_preview(jpeg: &[u8]) -> image::RgbaImage {
        image::load_from_memory(jpeg)
            .expect("decode jpeg")
            .to_rgba8()
    }

    /// The whole point of D-211, checked through the real command: a title
    /// clip's text is actually painted into the preview frame, over the video
    /// beneath it, and nowhere it shouldn't be.
    #[test]
    fn a_title_clip_really_renders_text_into_the_preview_frame() {
        if !have_ffmpeg() {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        }
        // Held for the whole body — see `PROJECT_STATE_LOCK`. `unwrap_or_else`
        // on the poison rather than `expect`: a panic in the sibling test must
        // not turn into a second, misleading failure here.
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().expect("tempdir");
        let video = tmp.path().join("black.mp4");
        black_clip(&video);
        let _project = open_title_project(&video);
        super::decode_pipe::reset();

        let frame = decode_preview(
            &super::timeline_frame(12, Some(W), super::FrameIntent::Single).expect("preview frame"),
        );
        assert_eq!(frame.dimensions(), (W, H));

        // Real, bright glyph pixels — and the ink's bounding box centred, the
        // same rule `chroma::text`'s own rasteriser test and the export's
        // pixel test both check against.
        let (mut x0, mut y0, mut x1, mut y1, mut lit) = (W, H, 0u32, 0u32, 0usize);
        for (x, y, p) in frame.enumerate_pixels() {
            if p[0] > 180 && p[1] > 180 && p[2] > 180 {
                lit += 1;
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x + 1);
                y1 = y1.max(y + 1);
            }
        }
        assert!(
            lit > 50,
            "expected real white glyph pixels in the preview, got {lit}"
        );
        let cx = (x0 + x1) as f64 / 2.0;
        let cy = (y0 + y1) as f64 / 2.0;
        // Printed (visible under `--nocapture`) so a preview/export parity
        // check can be read as real numbers, not only as a shared tolerance —
        // the export side's equivalent is
        // `timelineExportText.ffmpeg.test.ts`'s own ink measurement.
        eprintln!(
            "preview ink=[{x0},{y0}..{x1},{y1}] w={} h={} centre=({cx:.1}, {cy:.1}) lit={lit}",
            x1 - x0,
            y1 - y0
        );
        assert!(
            (cx - W as f64 / 2.0).abs() <= 4.0,
            "title not centred, cx={cx}"
        );
        assert!(
            (cy - H as f64 / 2.0).abs() <= 4.0,
            "title not centred, cy={cy}"
        );

        // The corners are black video, untouched by the title. JPEG at q80 is
        // lossy, so this is "still dark", not "exactly 0".
        for (x, y) in [(2, 2), (W - 3, 2), (2, H - 3), (W - 3, H - 3)] {
            let p = frame.get_pixel(x, y);
            assert!(
                p[0] < 60,
                "corner ({x},{y}) should still be the black clip, got {p:?}"
            );
        }
    }

    /// `position_x`/`position_y` really move the title in the preview — the
    /// half of the transform Phase 1 supports, through the same
    /// `composite_layer_onto` offset a video layer uses.
    #[test]
    fn a_titles_position_offset_really_moves_it_in_the_preview() {
        if !have_ffmpeg() {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        }
        // Held for the whole body — see `PROJECT_STATE_LOCK`. `unwrap_or_else`
        // on the poison rather than `expect`: a panic in the sibling test must
        // not turn into a second, misleading failure here.
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().expect("tempdir");
        let video = tmp.path().join("black.mp4");
        black_clip(&video);
        let project = open_title_project(&video);
        super::decode_pipe::reset();

        let centre_x = |frame: &image::RgbaImage| -> f64 {
            let (mut x0, mut x1) = (W, 0u32);
            for (x, _, p) in frame.enumerate_pixels() {
                if p[0] > 180 && p[1] > 180 && p[2] > 180 {
                    x0 = x0.min(x);
                    x1 = x1.max(x + 1);
                }
            }
            assert!(x1 > x0, "no ink found");
            (x0 + x1) as f64 / 2.0
        };

        let centred = centre_x(&decode_preview(
            &super::timeline_frame(12, Some(W), super::FrameIntent::Single).expect("frame"),
        ));

        // Shift the title a quarter of the frame to the right and re-render
        // through the same command.
        let mut tl = super::resolve_timeline(false).expect("timeline");
        tl.tracks[0].clips[0].position_x = 0.25;
        super::chroma_timeline_set(tl).expect("persist");
        let _ = &project; // keep the project dir alive for the second render
        let shifted = centre_x(&decode_preview(
            &super::timeline_frame(12, Some(W), super::FrameIntent::Single).expect("frame"),
        ));

        let moved = shifted - centred;
        assert!(
            (moved - 0.25 * W as f64).abs() <= 4.0,
            "expected the title to move ~{}px right, it moved {moved}px",
            0.25 * W as f64
        );
    }
}

/// **D-226 — real, end-to-end preview pixels for a transition.**
///
/// The whole feature's claim is that a cut with a transition on it renders as a
/// real BLEND rather than a hard cut, and only a decoded pixel from the middle
/// of the transition can tell those two apart: both produce a perfectly valid
/// frame of exactly the right size at exactly the right moment. So these go
/// through the real `timeline_frame` command against real solid-colour media on
/// disk — the same shape `preview_text_tests` above uses, and the deliberate
/// mirror of `packages/editor/src/timelineExportTransitions.ffmpeg.test.ts` on
/// the export side. The two files together are what make "the preview matches
/// the export" a checked claim rather than an assertion.
///
/// Solid colours, not a test pattern: "what colour is on screen half way
/// through the blend" is the question, and it is unanswerable against moving
/// content.
#[cfg(test)]
mod preview_transition_tests {
    use apelles_timeline::{
        Clip, Timeline, Track, TrackKind, Transition, TransitionAlignment, TransitionKind,
    };

    use super::super::PROJECT_STATE_LOCK;

    const W: u32 = 320;
    const H: u32 = 180;
    /// A JPEG round trip at the preview's own quality moves a flat colour by a
    /// few codes, and a 50% blend of two primaries by a few more. Far tighter
    /// than the thing being distinguished (a real blend, ~128, from a hard cut,
    /// 0 or 255).
    const TOL: i32 = 26;

    fn have_ffmpeg() -> bool {
        apelles_media::ffmpeg_locate::ffmpeg_path().is_ok()
    }

    /// 96 frames (4s at 24fps) of one flat colour, so a decoded pixel at any
    /// time IS the layer's own identity.
    fn flat_clip(path: &std::path::Path, color: &str) {
        let ok = apelles_media::ffmpeg_locate::ffmpeg()
            .expect("an ffmpeg to build the fixture")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                &format!("color={color}:size={W}x{H}:rate=24:duration=4"),
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("spawn ffmpeg");
        assert!(ok.success(), "generating the {color} fixture clip failed");
    }

    /// Two abutting 48-frame clips cut at frame 48, each trimmed INSIDE its own
    /// 96-frame source so real handle media exists on both sides — the shape a
    /// razor split produces, and the one a cross dissolve needs.
    fn open_cut_project(
        red: &std::path::Path,
        blue: &std::path::Path,
        transitions: Vec<Transition>,
    ) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().expect("tempdir");
        let project_dir = tmp.path().join("Cut.chroma");
        std::fs::create_dir_all(&project_dir).expect("mkdir project dir");

        let clip = |id: &str, path: &std::path::Path, source_start: i64, start_frame: i64| Clip {
            id: id.into(),
            name: id.into(),
            source_path: path.to_string_lossy().into_owned(),
            source_fps: Some(24.0),
            source_start,
            duration: 48,
            source_len: 96,
            start_frame,
            ..Default::default()
        };

        let settings = super::project::ProjectSettings {
            width: Some(W),
            height: Some(H),
            ..Default::default()
        };
        let manifest = super::project::ProjectManifest {
            schema: "chroma.project/1".into(),
            name: "Cut".into(),
            created: String::new(),
            modified: String::new(),
            shots: Vec::new(),
            active_shot: 0,
            active_clip_id: None,
            settings,
            timelines: vec![Timeline {
                id: "tl1".into(),
                name: "Cut".into(),
                rate: Some(apelles_types::Rational { num: 24, den: 1 }),
                tracks: vec![Track {
                    kind: TrackKind::Video,
                    clips: vec![clip("A", red, 0, 0), clip("B", blue, 24, 48)],
                    transitions,
                    ..Default::default()
                }],
                markers: Vec::new(),
            }],
            active_timeline: 0,
            media: Vec::new(),
            folders: Vec::new(),
        };
        super::project::save_manifest(&project_dir, &manifest).expect("save manifest");
        super::state::set_project(Some(super::state::ProjectRef {
            path: project_dir,
            name: "Cut".into(),
        }));
        tmp
    }

    fn transition(kind: TransitionKind, alignment: TransitionAlignment) -> Transition {
        Transition {
            id: "tr".into(),
            kind,
            at_frame: 48,
            duration: 24,
            alignment,
            color: None,
        }
    }

    /// The centre pixel of the real preview frame at timeline position `pos`,
    /// decoded back from `timeline_frame`'s own JPEG bytes — exactly what the
    /// preview `<img>` shows.
    fn centre_pixel(pos: u64) -> [u8; 3] {
        let jpeg =
            super::timeline_frame(pos, Some(W), super::FrameIntent::Single).expect("preview frame");
        let img = image::load_from_memory(&jpeg)
            .expect("decode jpeg")
            .to_rgba8();
        assert_eq!(img.dimensions(), (W, H));
        let p = img.get_pixel(W / 2, H / 2);
        [p[0], p[1], p[2]]
    }

    fn assert_near(actual: u8, expected: i32, what: &str) {
        assert!(
            (actual as i32 - expected).abs() <= TOL,
            "{what}: got {actual}, expected ~{expected}"
        );
    }

    #[test]
    fn a_cross_dissolve_really_blends_both_clips_in_the_live_preview() {
        if !have_ffmpeg() {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        }
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().expect("tempdir");
        let (red, blue) = (tmp.path().join("red.mp4"), tmp.path().join("blue.mp4"));
        flat_clip(&red, "red");
        flat_clip(&blue, "blue");

        // The CONTROL first, through the same command and the same fixtures:
        // without a transition this cut is hard, so every assertion below would
        // also pass on a build that never blends.
        let _project = open_cut_project(&red, &blue, Vec::new());
        super::decode_pipe::reset();
        let before = centre_pixel(46);
        let after = centre_pixel(50);
        assert_near(before[0], 255, "control: R two frames before the cut");
        assert_near(before[2], 0, "control: B two frames before the cut");
        assert_near(after[2], 255, "control: B two frames after the cut");
        assert_near(after[0], 0, "control: R two frames after the cut");
        drop(_project);

        // Now the same cut with a centred 24-frame dissolve — window [36, 60),
        // so frame 48 is progress 0.5 exactly.
        let _project = open_cut_project(
            &red,
            &blue,
            vec![transition(
                TransitionKind::CrossDissolve,
                TransitionAlignment::CenterAtCut,
            )],
        );
        super::decode_pipe::reset();

        let start = centre_pixel(36);
        assert_near(
            start[0],
            255,
            "R at the window's first frame (pure outgoing)",
        );
        assert_near(start[2], 0, "B at the window's first frame");

        let mid = centre_pixel(48);
        eprintln!("preview mid-dissolve centre pixel = {mid:?}");
        assert_near(mid[0], 128, "R at the midpoint of the dissolve");
        assert_near(mid[2], 128, "B at the midpoint of the dissolve");
        // The load-bearing assertion: this is NEITHER source clip. A hard cut
        // would put one of these at 0 and the other at 255.
        assert!(
            mid[0] > 60 && mid[2] > 60,
            "mid-dissolve must be a real blend of both clips, got {mid:?}"
        );

        let three_quarters = centre_pixel(54);
        assert_near(three_quarters[2], 191, "B at 75% through the dissolve");
        assert!(
            three_quarters[2] > mid[2] && three_quarters[0] < mid[0],
            "the blend must progress: {mid:?} then {three_quarters:?}"
        );

        // Past the window: pure incoming, at its own real frames.
        let done = centre_pixel(70);
        assert_near(done[2], 255, "B past the window (pure incoming)");
        assert_near(done[0], 0, "R past the window");
    }

    #[test]
    fn a_dip_to_colour_covers_the_cut_with_its_own_plate() {
        if !have_ffmpeg() {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        }
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().expect("tempdir");
        let (red, blue) = (tmp.path().join("red.mp4"), tmp.path().join("blue.mp4"));
        flat_clip(&red, "red");
        flat_clip(&blue, "blue");

        let mut dip = transition(TransitionKind::DipToColor, TransitionAlignment::CenterAtCut);
        dip.color = Some("#00FF00".into());
        let _project = open_cut_project(&red, &blue, vec![dip]);
        super::decode_pipe::reset();

        let at_cut = centre_pixel(48);
        assert_near(at_cut[1], 255, "G at the peak of a dip-to-green");
        assert_near(at_cut[0], 0, "R at the peak of a dip-to-green");
        assert_near(at_cut[2], 0, "B at the peak of a dip-to-green");

        let start = centre_pixel(36);
        assert_near(
            start[0],
            255,
            "R at the window start — the dip has not begun",
        );
        let past = centre_pixel(61);
        assert_near(past[2], 255, "B past the window end — the dip is over");

        // Half way IN, the outgoing clip is still there at half strength under
        // a half-strength plate — which is the whole difference between a dip
        // and a cut to a colour and back.
        let half_in = centre_pixel(42);
        assert_near(half_in[0], 128, "R half way into the dip");
        assert_near(half_in[1], 128, "G half way into the dip");
    }
}

/// Real-file preview-throughput regression coverage for D-125 / B-040 — kept
/// out of the pure-logic `tests` module above because every one of these needs
/// a real video file on disk and a real `ffmpeg`.
#[cfg(test)]
mod preview_throughput_tests {
    use std::time::Instant;

    use apelles_timeline::{Clip, Timeline, Track, TrackKind};
    use base64::Engine as _;

    fn test_video() -> Option<String> {
        std::env::var("CHROMA_TEST_VIDEO")
            .ok()
            .filter(|p| std::path::Path::new(p).exists())
    }

    /// A project shaped exactly like the one this bug was found on: several
    /// **video** tracks all holding content under the same playhead, two of
    /// them the same source file. That is what makes the preview take
    /// `composite_video_frame`'s multi-layer path, which is where the
    /// single-shared-decode-pipe respawn storm lived.
    ///
    /// `comp` sets the project's output size (`None` = whatever the source is,
    /// which takes `composite_video_frame`'s cheapest path). D-217's phase
    /// breakdown passes the owner's real 1080×1920 portrait composition,
    /// because a comp size that differs from the source resolution is exactly
    /// what makes every layer pay a CPU resize per frame.
    fn open_multi_track_project(
        video_path: &str,
        tracks_n: usize,
        comp: Option<(u32, u32)>,
    ) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().expect("tempdir");
        let project_dir = tmp.path().join("MultiTrack.chroma");
        std::fs::create_dir_all(&project_dir).expect("mkdir project dir");

        let tracks: Vec<Track> = (0..tracks_n)
            .map(|i| Track {
                kind: TrackKind::Video,
                clips: vec![Clip {
                    id: format!("clip{i}"),
                    name: format!("layer{i}"),
                    source_path: video_path.to_string(),
                    source_start: 0,
                    duration: 100_000,
                    source_len: 100_000,
                    start_frame: 0,
                    // Every layer must actually be composited — a fully
                    // opaque top layer is still decoded by the current
                    // resolver, but keeping them partly transparent makes
                    // the intent explicit and matches a real stacked edit.
                    opacity: if i == 0 { 1.0 } else { 0.5 },
                    ..Default::default()
                }],
                ..Default::default()
            })
            .collect();

        let manifest = super::project::ProjectManifest {
            schema: "chroma.project/1".into(),
            name: "MultiTrack".into(),
            created: String::new(),
            modified: String::new(),
            shots: Vec::new(),
            active_shot: 0,
            active_clip_id: None,
            settings: super::project::ProjectSettings {
                width: comp.map(|(w, _)| w),
                height: comp.map(|(_, h)| h),
                ..Default::default()
            },
            timelines: vec![Timeline {
                id: "tl1".into(),
                name: "MultiTrack".into(),
                rate: None,
                tracks,
                markers: Vec::new(),
            }],
            active_timeline: 0,
            media: Vec::new(),
            folders: Vec::new(),
        };
        super::project::save_manifest(&project_dir, &manifest).expect("save manifest");
        super::state::set_project(Some(super::state::ProjectRef {
            path: project_dir,
            name: "MultiTrack".into(),
        }));
        tmp
    }

    /// **D-324 — a timeline shaped the way `editor_ripple_delete_ranges`
    /// leaves one**: many short clips butted together with no gaps, each
    /// pointing at a source frame far from where the previous one stopped.
    ///
    /// `jump` is the distance in source frames between consecutive clips —
    /// comfortably past `decode_pipe`'s 48-frame forward-skip threshold, so
    /// every boundary is a genuine keyframe seek rather than a hop the live
    /// pipe would absorb on its own. That is the whole property under test.
    fn open_ripple_cut_project(
        video_path: &str,
        n_clips: i64,
        clip_frames: i64,
        jump: i64,
    ) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().expect("tempdir");
        let project_dir = tmp.path().join("RippleCut.chroma");
        std::fs::create_dir_all(&project_dir).expect("mkdir project dir");

        let clips: Vec<Clip> = (0..n_clips)
            .map(|i| Clip {
                id: format!("cut{i}"),
                name: format!("cut{i}"),
                source_path: video_path.to_string(),
                source_start: i * jump,
                duration: clip_frames,
                source_len: n_clips * jump + clip_frames,
                start_frame: i * clip_frames,
                ..Default::default()
            })
            .collect();

        let manifest = super::project::ProjectManifest {
            schema: "chroma.project/1".into(),
            name: "RippleCut".into(),
            created: String::new(),
            modified: String::new(),
            shots: Vec::new(),
            active_shot: 0,
            active_clip_id: None,
            settings: Default::default(),
            timelines: vec![Timeline {
                id: "tl1".into(),
                name: "RippleCut".into(),
                rate: None,
                tracks: vec![Track {
                    kind: TrackKind::Video,
                    clips,
                    ..Default::default()
                }],
                markers: Vec::new(),
            }],
            active_timeline: 0,
            media: Vec::new(),
            folders: Vec::new(),
        };
        super::project::save_manifest(&project_dir, &manifest).expect("save manifest");
        super::state::set_project(Some(super::state::ProjectRef {
            path: project_dir,
            name: "RippleCut".into(),
        }));
        tmp
    }

    /// A 24 fps fixture long enough for the cut jumps below to land inside it.
    fn synth_long_fixture(dir: &std::path::Path, frames: i64) -> String {
        let out = dir.join("cuts.mp4");
        let status = apelles_media::ffmpeg_locate::ffmpeg()
            .expect("an ffmpeg to build the fixture")
            .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
            .arg(format!(
                "testsrc=size=320x240:rate=24:duration={}",
                frames as f64 / 24.0
            ))
            .args(["-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p"])
            .arg(&out)
            .status()
            .expect("ffmpeg to synthesize the cut fixture");
        assert!(status.success(), "ffmpeg could not build the cut fixture");
        out.display().to_string()
    }

    /// **D-324, the caller half.** Continuous playback must prime the decode
    /// pipe for the cut it is approaching; a scrub must not.
    ///
    /// This is the piece `decode_pipe`'s own tests cannot cover: they prove a
    /// primed pipe is adopted, but not that the Edit tab works out *what* to
    /// prime, *when*, from the edit list — nor that it stops short of doing so
    /// for a one-off frame.
    #[test]
    fn playback_primes_the_upcoming_cut_and_a_scrub_does_not() {
        // B-105 — this test opens a project AND drives the process-global
        // decode-pipe pool, both of which its assertions read back. One lock,
        // one global (see `chroma::audio`'s `session_test_guard`).
        let _guard = super::super::PROJECT_STATE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp_src = tempfile::tempdir().expect("tempdir");
        const N_CLIPS: i64 = 8;
        const CLIP_FRAMES: i64 = 12; // 0.5 s at 24 fps — one per lookahead window
        const JUMP: i64 = 100; // >> the 48-frame forward-skip threshold
        let video = synth_long_fixture(tmp_src.path(), N_CLIPS * JUMP + CLIP_FRAMES + 24);
        let _project = open_ripple_cut_project(&video, N_CLIPS, CLIP_FRAMES, JUMP);

        // --- a scrub primes nothing -------------------------------------- //
        apelles_media::decode_pipe::reset();
        super::timeline_frame(0, Some(640), super::FrameIntent::Single).expect("scrub frame");
        assert_eq!(
            apelles_media::decode_pipe::standby_pipe_count(),
            0,
            "a one-off frame must not spawn an ffmpeg for a boundary it cannot predict"
        );

        // --- playback primes the next boundary --------------------------- //
        apelles_media::decode_pipe::reset();
        super::timeline_frame(0, Some(640), super::FrameIntent::Playing).expect("play frame 0");
        assert_eq!(
            apelles_media::decode_pipe::standby_pipe_count(),
            1,
            "frame 0 is within the 0.5 s lookahead of the cut at frame {CLIP_FRAMES}, so the \
             next clip's pipe must already be spawning"
        );

        // --- and crossing every boundary neither fails nor leaks --------- //
        for pos in 0..(N_CLIPS * CLIP_FRAMES) as u64 {
            super::timeline_frame(pos, Some(640), super::FrameIntent::Playing)
                .unwrap_or_else(|e| panic!("play frame {pos}: {e}"));
            assert!(
                apelles_media::decode_pipe::open_pipe_count() <= 1,
                "one video track is one live pipe, at frame {pos}"
            );
            assert!(
                apelles_media::decode_pipe::standby_pipe_count() <= 1,
                "at most one primed pipe per slot — a prefetch that replaced another \
                 without dropping it would leak an ffmpeg per cut, at frame {pos}"
            );
        }

        apelles_media::decode_pipe::reset();
        super::state::set_project(None);
    }

    /// **D-330, half one — a mid-clip playback frame primes NOTHING.**
    ///
    /// D-324 delegated this to `decode_pipe::prefetch`'s own `can_serve` check
    /// and documented the result as "one extra timeline walk per frame and no
    /// processes". It was not: `prime` runs *after* the frame is decoded, so
    /// the live pipe's `next_index` was already `source_frame + 1` while the
    /// scheduler's clamped target was `source_frame` — off by exactly one, so
    /// `can_serve` was false on every ordinary frame and each one spawned an
    /// `ffmpeg`, killed it on the next frame, and never adopted it.
    ///
    /// The existing D-324 test could not catch this: it asserts
    /// `standby_pipe_count() <= 1`, and one wasted standby per frame satisfies
    /// that. This asserts **zero**, which is the real contract.
    ///
    /// Uses one long clip so that no part of the scan window contains a
    /// boundary — any standby at all here is a spawn nothing will ever adopt.
    #[test]
    fn a_mid_clip_playback_frame_primes_nothing() {
        let _guard = super::super::PROJECT_STATE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp_src = tempfile::tempdir().expect("tempdir");
        // One clip, far longer than the widest lookahead the scheduler scans.
        let video = synth_long_fixture(tmp_src.path(), 600);
        let _project = open_ripple_cut_project(&video, 1, 500, 0);

        apelles_media::decode_pipe::reset();
        for pos in 10..40u64 {
            super::timeline_frame(pos, Some(640), super::FrameIntent::Playing)
                .unwrap_or_else(|e| panic!("play frame {pos}: {e}"));
            assert_eq!(
                apelles_media::decode_pipe::standby_pipe_count(),
                0,
                "mid-clip frame {pos} has no boundary ahead of it, so it must spawn \
                 no ffmpeg at all — a standby here is D-330's off-by-one back again"
            );
        }

        apelles_media::decode_pipe::reset();
        super::state::set_project(None);
    }

    /// **D-330, half two (B-200) — a run of clips SHORTER than the lead time
    /// keeps every one of its boundaries primed.**
    ///
    /// The bug: with one standby per slot and a single-instant lookahead, the
    /// layer resolved at `pos + lookahead` is already clip `N+2` while playback
    /// is still approaching `N+1`, so priming `N+2` evicted `N+1`'s standby
    /// before it was ever adopted. Every such boundary then paid the full
    /// respawn it was meant to hide.
    ///
    /// Asserts the property that fails under that design: while playing a run
    /// of 4-frame clips, the pipeline is primed for more than one boundary at a
    /// time, and no boundary is ever reached cold.
    #[test]
    fn a_run_of_clips_shorter_than_the_lead_keeps_its_chain_primed() {
        let _guard = super::super::PROJECT_STATE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp_src = tempfile::tempdir().expect("tempdir");
        const N_CLIPS: i64 = 8;
        // 4 frames ≈ 0.17 s at 24 fps — comfortably shorter than even the
        // minimum lead, which is the shape that defeated D-324.
        const CLIP_FRAMES: i64 = 4;
        const JUMP: i64 = 200; // >> MAX_FORWARD_SKIP, so each cut is a real seek
        let video = synth_long_fixture(tmp_src.path(), N_CLIPS * JUMP + CLIP_FRAMES + 24);
        let _project = open_ripple_cut_project(&video, N_CLIPS, CLIP_FRAMES, JUMP);

        apelles_media::decode_pipe::reset();
        let mut max_primed = 0usize;
        for pos in 0..(N_CLIPS * CLIP_FRAMES) as u64 {
            super::timeline_frame(pos, Some(640), super::FrameIntent::Playing)
                .unwrap_or_else(|e| panic!("play frame {pos}: {e}"));
            let primed = apelles_media::decode_pipe::standby_pipe_count();
            max_primed = max_primed.max(primed);
            assert!(
                primed <= apelles_media::decode_pipe::MAX_STANDBY_PER_SLOT,
                "the chain must stay capped — {primed} primed at frame {pos}"
            );
        }

        // The whole point: at some moment more than ONE boundary was primed
        // together. Under D-324's one-per-slot map this is 1, always, and the
        // short clips' boundaries each paid a full respawn.
        assert!(
            max_primed > 1,
            "a run of clips shorter than the lead time must overlap its respawns \
             — only ever {max_primed} primed at once, so the chain is not working"
        );

        apelles_media::decode_pipe::reset();
        super::state::set_project(None);
    }

    /// **D-324's measured claim, end to end through the real preview path.**
    ///
    /// Plays a stretch of a heavily recut timeline twice — once as playback
    /// (prefetch on), once as a series of one-off frames (prefetch off, i.e.
    /// exactly the pre-D-324 behaviour) — and reports the per-frame cost at the
    /// **cut boundaries** separately from the frames in between. That split is
    /// the whole point: mid-clip frames were never the problem, and averaging
    /// the two together dilutes a stall the user sees as a hitch into a number
    /// that looks like mild slowness.
    ///
    /// **Paced to the timeline's real frame rate, deliberately.** The lookahead
    /// D-324 buys is half a second of WALL CLOCK for ffmpeg to seek in. A
    /// flat-out loop decodes a 12-frame clip in ~80 ms, so it hands the
    /// prefetch a tenth of the lead real playback would and measures a benefit
    /// that is real but much smaller than the one a user gets. Sleeping out
    /// each frame's budget is what makes this the same experiment as playing
    /// the timeline.
    ///
    /// Env-gated on real footage because the cost being removed is a real 4K
    /// HEVC keyframe seek; on a 320×240 `testsrc` a respawn is cheap enough
    /// that the difference is noise. The assertion is loose for
    /// `b040_multi_layer_preview_throughput`'s stated reason: a guard against
    /// the *class* of regression, not a wall-clock budget.
    ///
    /// ```text
    /// CHROMA_TEST_VIDEO=~/Downloads/A001_09122319_C038.MOV \
    ///   cargo test -p apelles ripple_cut_playback_throughput -- --nocapture
    /// ```
    #[test]
    fn ripple_cut_playback_throughput() {
        let _guard = super::super::PROJECT_STATE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let Some(video) = test_video() else {
            eprintln!("skip: set CHROMA_TEST_VIDEO");
            return;
        };
        // 0.5 s clips, each jumping 30 s further into the source — the shape of
        // a silence/retake cleanup on a talking head.
        const N_CLIPS: i64 = 10;
        const CLIP_FRAMES: i64 = 12;
        const JUMP: i64 = 720;
        const FPS: f64 = 24.0;
        let _project = open_ripple_cut_project(&video, N_CLIPS, CLIP_FRAMES, JUMP);
        let last = (N_CLIPS * CLIP_FRAMES) as u64;
        let budget = std::time::Duration::from_secs_f64(1.0 / FPS);

        // Returns (mean ms at a cut boundary, mean ms mid-clip).
        let run = |intent: super::FrameIntent| -> (f64, f64) {
            apelles_media::decode_pipe::reset();
            // The first frame of any run pays a cold spawn either way.
            super::timeline_frame(0, Some(960), intent).expect("warm frame");
            let (mut cuts, mut mids) = (Vec::new(), Vec::new());
            for pos in 1..last {
                let t = Instant::now();
                super::timeline_frame(pos, Some(960), intent).expect("frame");
                let ms = t.elapsed().as_secs_f64() * 1000.0;
                if pos % CLIP_FRAMES as u64 == 0 {
                    cuts.push(ms);
                } else {
                    mids.push(ms);
                }
                // Play at the timeline's rate: whatever is left of this frame's
                // budget is time the prefetched ffmpeg gets to seek in, exactly
                // as it would during real playback.
                if let Some(rest) = budget.checked_sub(t.elapsed()) {
                    std::thread::sleep(rest);
                }
            }
            let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len().max(1) as f64;
            (mean(&cuts), mean(&mids))
        };

        let (cut_without, mid_without) = run(super::FrameIntent::Single);
        let (cut_with, mid_with) = run(super::FrameIntent::Playing);
        apelles_media::decode_pipe::reset();
        super::state::set_project(None);

        eprintln!(
            "ripple_cut_playback_throughput ({N_CLIPS} clips, {} cuts, paced at {FPS} fps):\n  \
             without prefetch: {cut_without:.1} ms at a cut, {mid_without:.1} ms mid-clip\n  \
             with prefetch:    {cut_with:.1} ms at a cut, {mid_with:.1} ms mid-clip",
            N_CLIPS - 1,
        );
        assert!(
            cut_with * 2.0 < cut_without,
            "crossing a cut must get materially cheaper — got {cut_with:.1} ms with the \
             prefetch against {cut_without:.1} ms without"
        );
        assert!(
            cut_with < budget.as_secs_f64() * 1000.0,
            "with the pipe primed, a cut should cost less than one frame's budget \
             ({:.1} ms) — got {cut_with:.1} ms, i.e. the stall is still dropping frames",
            budget.as_secs_f64() * 1000.0
        );
    }

    /// The B-040 regression guard. Before D-125 every composited layer past
    /// the first forced a full `ffmpeg` respawn + keyframe seek *per displayed
    /// frame* on a timeline shaped like the owner's real three-video-track
    /// project, which is what "play takes 2-3 s and then stutters" actually
    /// was. Measured through this exact code path, before and after,
    /// back-to-back under identical machine load: **618 ms/frame → 23-31
    /// ms/frame** (≈1.6 fps → ~34 fps against a 24 fps timeline). On an idle
    /// machine the same comparison was 660 ms → 17 ms. The "before" figure was
    /// produced by temporarily pointing every layer back at one shared pipe
    /// and re-running this test, not inferred.
    ///
    /// The budget is deliberately loose (200 ms/frame average, vs. ~618 ms
    /// before and 17-31 ms after) so this stays a guard against the *class* of
    /// bug — a per-frame process respawn — and never a flaky wall-clock
    /// assertion on a busy machine.
    #[test]
    fn sequential_preview_frames_do_not_respawn_a_decoder_per_layer() {
        let Some(vid) = test_video() else {
            eprintln!("skip: set CHROMA_TEST_VIDEO");
            return;
        };
        // Held for the whole body — see `PROJECT_STATE_LOCK`. These two tests
        // were already sharing process-global project state with each other
        // and, as of D-211, with `preview_text_tests` too.
        let _guard = super::super::PROJECT_STATE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _project = open_multi_track_project(&vid, 3, None);
        super::decode_pipe::reset();

        const FRAMES: u64 = 24;
        const BUDGET_MS: u128 = 200;

        // The first frame legitimately pays the pipe spawns + keyframe seeks;
        // it is not part of the steady-state measurement.
        super::timeline_frame(100, Some(960), super::FrameIntent::Single).expect("warm frame");

        let start = Instant::now();
        for f in 101..101 + FRAMES {
            super::timeline_frame(f, Some(960), super::FrameIntent::Single).expect("frame");
        }
        let per_frame = start.elapsed().as_millis() / FRAMES as u128;
        eprintln!(
            "3-layer preview: {per_frame} ms/frame over {FRAMES} sequential frames \
             (same path pre-D-125 measured 618-660 ms/frame)"
        );
        assert!(
            per_frame < BUDGET_MS,
            "{per_frame} ms/frame exceeds the {BUDGET_MS} ms budget — a decode pipe \
             is very likely respawning per layer again (B-040)"
        );
        super::decode_pipe::reset();
    }

    /// A track that stops being a visible layer must give its `ffmpeg`
    /// process back — the pool is per track index, so without this it would
    /// grow one live decoder per track ever seen (D-125).
    #[test]
    fn a_track_that_leaves_the_visible_set_releases_its_pipe() {
        let Some(vid) = test_video() else {
            eprintln!("skip: set CHROMA_TEST_VIDEO");
            return;
        };
        // Held for the whole body — see `PROJECT_STATE_LOCK`. These two tests
        // were already sharing process-global project state with each other
        // and, as of D-211, with `preview_text_tests` too.
        let _guard = super::super::PROJECT_STATE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _project = open_multi_track_project(&vid, 3, None);
        super::decode_pipe::reset();

        super::timeline_frame(100, Some(960), super::FrameIntent::Single).expect("frame");
        assert_eq!(
            super::decode_pipe::open_pipe_count(),
            3,
            "one pipe per layer"
        );

        super::decode_pipe::retain_pipe_slots(
            super::decode_pipe::PipeLane::LIVE,
            &[super::decode_pipe::PipeSlot::Track(0)],
        );
        assert_eq!(
            super::decode_pipe::open_pipe_count(),
            1,
            "pipes for tracks no longer visible must be dropped"
        );
        super::decode_pipe::reset();
        assert_eq!(super::decode_pipe::open_pipe_count(), 0);
    }

    /// **D-217's profile.** Where a preview frame's time actually goes, phase
    /// by phase, on a project shaped like the owner's own laggy one: two video
    /// layers of real 2940×1670 footage composited into a 1080×1920 portrait
    /// canvas at the live `PREVIEW_LONG_EDGE`.
    ///
    /// This exists because the standing theory ("base64 is the dominant cost")
    /// had never been measured, and a monolithic `timeline_frame` could not
    /// answer it. It prints the split rather than asserting a wall-clock
    /// budget for the two cheap phases — those are microseconds and a
    /// millisecond assertion on them would be noise — but it *does* assert the
    /// one structural invariant D-217 bought: the payload the frontend gets is
    /// the JPEG itself, not a ~4/3-inflated base64 transcription of it.
    ///
    /// Run it with the numbers visible:
    /// `CHROMA_TEST_VIDEO=… cargo test -p apelles preview_frame_phase_breakdown -- --nocapture`
    #[test]
    fn preview_frame_phase_breakdown() {
        let Some(vid) = test_video() else {
            eprintln!("skip: set CHROMA_TEST_VIDEO");
            return;
        };
        let _guard = super::super::PROJECT_STATE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // The owner's real reel: two video layers, 1080×1920 portrait canvas.
        let _project = open_multi_track_project(&vid, 2, Some((1080, 1920)));
        super::decode_pipe::reset();

        const FRAMES: u64 = 24;
        const LONG_EDGE: u32 = 960;

        // The first frame pays the pipe spawns + keyframe seeks; not measured.
        super::timeline_frame(100, Some(LONG_EDGE), super::FrameIntent::Single)
            .expect("warm frame");

        let (mut t_image, mut t_jpeg, mut t_b64) = (0u128, 0u128, 0u128);
        let (mut n_jpeg, mut n_b64) = (0usize, 0usize);
        for f in 101..101 + FRAMES {
            let t0 = Instant::now();
            let img = super::timeline_frame_image(f, Some(LONG_EDGE), super::FrameIntent::Single)
                .expect("image")
                .expect("a visible layer");
            t_image += t0.elapsed().as_micros();

            let t1 = Instant::now();
            let jpeg = super::encode_preview_jpeg(&img).expect("jpeg");
            t_jpeg += t1.elapsed().as_micros();
            n_jpeg = jpeg.len();

            // The pre-D-217 payload, measured on the same picture in the same
            // run so the comparison is like-for-like rather than across builds.
            let t2 = Instant::now();
            let b64 = base64::engine::general_purpose::STANDARD.encode(&jpeg);
            t_b64 += t2.elapsed().as_micros();
            n_b64 = b64.len() + "data:image/jpeg;base64,".len();
        }

        let n = FRAMES as u128;
        eprintln!(
            "preview frame phases @ {LONG_EDGE}px long edge, 2 layers → 1080×1920 comp, \
             {FRAMES} frames:\n  decode+composite {:.2} ms/frame\n  jpeg encode      {:.2} ms/frame\
             \n  base64 encode    {:.2} ms/frame  (removed by D-217)\n  \
             payload {} KB raw vs {} KB as a data URL (+{:.0}%)",
            t_image as f64 / n as f64 / 1000.0,
            t_jpeg as f64 / n as f64 / 1000.0,
            t_b64 as f64 / n as f64 / 1000.0,
            n_jpeg / 1024,
            n_b64 / 1024,
            (n_b64 as f64 / n_jpeg as f64 - 1.0) * 100.0,
        );

        // The invariant, not the wall clock: what crosses the IPC boundary is
        // the JPEG, byte for byte.
        let payload =
            super::timeline_frame(120, Some(LONG_EDGE), super::FrameIntent::Single).expect("frame");
        assert_eq!(&payload[..2], &[0xFF, 0xD8], "raw JPEG bytes, not a string");
        assert!(
            payload.len() < n_b64,
            "the raw payload must be smaller than the base64 one it replaced"
        );
        super::decode_pipe::reset();
    }
}

/// **D-230 — real, end-to-end preview pixels for an adjustment clip.**
///
/// The feature's whole claim is that a clip which draws nothing nonetheless
/// changes the colour of *other* clips, on *other* tracks, only *inside its own
/// span*. Every part of that is invisible to a structural test: a build that
/// silently ignored adjustment clips entirely would still produce a perfectly
/// valid frame of the right size at the right moment, with the right clip
/// showing. Only a decoded pixel can tell the two apart.
///
/// So these go through the real `timeline_frame` command against real
/// solid-colour media on disk — the same shape `preview_transition_tests` and
/// `preview_text_tests` use, and the deliberate mirror of
/// `packages/editor/src/timelineExportAdjustment.ffmpeg.test.ts` on the export
/// side. **The two files together are what make "the preview matches the
/// export" a checked claim rather than an assertion**, which is the specific
/// thing B-090/B-095/B-098 were each filed for the absence of.
///
/// Flat colours, not a test pattern: "what colour is on screen" is the
/// question, and it is unanswerable against moving content.
#[cfg(test)]
mod preview_adjustment_tests {
    use apelles_timeline::{AdjustmentLayer, AdjustmentOps, Clip, Timeline, Track, TrackKind};

    use super::super::PROJECT_STATE_LOCK;

    const W: u32 = 320;
    const H: u32 = 180;
    /// A JPEG round trip at the preview's own quality moves a flat colour by a
    /// few codes. Far tighter than what is being distinguished here (a
    /// corrected colour from an uncorrected one, which these fixtures separate
    /// by 40+ codes summed across the channels asserted).
    const TOL: i32 = 26;

    /// The correction under test. Deliberately moves the channels by different
    /// amounts, so "the adjustment ran" cannot be confused with "the JPEG round
    /// trip drifted" on any single channel.
    fn layer() -> AdjustmentLayer {
        AdjustmentLayer {
            exposure: 0.4,
            contrast: 0.0,
            saturation: -0.6,
            temperature: 0.5,
            tint: 0.0,
        }
    }

    fn have_ffmpeg() -> bool {
        apelles_media::ffmpeg_locate::ffmpeg_path().is_ok()
    }

    /// 96 frames (4s at 24fps) of one flat colour, so a decoded pixel at any
    /// time IS the layer's own identity.
    fn flat_clip(path: &std::path::Path, color: &str) {
        let ok = apelles_media::ffmpeg_locate::ffmpeg()
            .expect("an ffmpeg to build the fixture")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                &format!("color={color}:size={W}x{H}:rate=24:duration=4"),
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("spawn ffmpeg");
        assert!(ok.success(), "generating the {color} fixture clip failed");
    }

    fn media_clip(id: &str, path: &std::path::Path) -> Clip {
        Clip {
            id: id.into(),
            name: id.into(),
            source_path: path.to_string_lossy().into_owned(),
            source_fps: Some(24.0),
            source_start: 0,
            duration: 96,
            source_len: 96,
            start_frame: 0,
            ..Default::default()
        }
    }

    /// An adjustment clip covering `[start_frame, start_frame + len)` — no
    /// source path and no media, exactly as the real model builds one.
    fn adjustment_clip(id: &str, start_frame: i64, len: i64, adj: AdjustmentLayer) -> Clip {
        Clip {
            id: id.into(),
            name: "Adjustment Clip".into(),
            source_path: String::new(),
            source_start: 0,
            duration: len,
            source_len: len,
            start_frame,
            adjustment: Some(adj),
            ..Default::default()
        }
    }

    /// A project whose track list is exactly `tracks` (index 0 = topmost).
    fn open_project(tracks: Vec<Track>) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().expect("tempdir");
        let project_dir = tmp.path().join("Adjust.chroma");
        std::fs::create_dir_all(&project_dir).expect("mkdir project dir");

        let settings = super::project::ProjectSettings {
            width: Some(W),
            height: Some(H),
            ..Default::default()
        };
        let manifest = super::project::ProjectManifest {
            schema: "chroma.project/1".into(),
            name: "Adjust".into(),
            created: String::new(),
            modified: String::new(),
            shots: Vec::new(),
            active_shot: 0,
            active_clip_id: None,
            settings,
            timelines: vec![Timeline {
                id: "tl1".into(),
                name: "Adjust".into(),
                rate: Some(apelles_types::Rational { num: 24, den: 1 }),
                tracks,
                markers: Vec::new(),
            }],
            active_timeline: 0,
            media: Vec::new(),
            folders: Vec::new(),
        };
        super::project::save_manifest(&project_dir, &manifest).expect("save manifest");
        super::state::set_project(Some(super::state::ProjectRef {
            path: project_dir,
            name: "Adjust".into(),
        }));
        // B-107 — assert the precondition this helper exists to establish,
        // rather than inheriting it. Every caller holds `PROJECT_STATE_LOCK`,
        // but that only excludes other holders of the SAME lock: when
        // `chroma::audio`'s tests guarded the very same global with a private
        // mutex of their own, one of them could clear it between this line and
        // the first `centre_pixel` call, and the failure surfaced as a
        // "no project open" panic inside `timeline_frame` — three layers from
        // the cause, and easy to misread as a fault in the feature under test.
        // Checked here so a future second lock fails loudly, at the leak.
        assert!(
            super::state::current_project().is_some(),
            "open_project must leave a project open — if this fires, some other \
             test cleared the process-global project state without holding \
             PROJECT_STATE_LOCK (see B-107)"
        );
        tmp
    }

    fn video_track(clips: Vec<Clip>) -> Track {
        Track {
            kind: TrackKind::Video,
            clips,
            ..Default::default()
        }
    }

    /// The centre pixel of the real preview frame at timeline position `pos`,
    /// decoded back from `timeline_frame`'s own JPEG bytes — exactly what the
    /// preview `<img>` shows.
    fn centre_pixel(pos: u64) -> [u8; 3] {
        let jpeg =
            super::timeline_frame(pos, Some(W), super::FrameIntent::Single).expect("preview frame");
        let img = image::load_from_memory(&jpeg)
            .expect("decode jpeg")
            .to_rgba8();
        assert_eq!(img.dimensions(), (W, H));
        let p = img.get_pixel(W / 2, H / 2);
        [p[0], p[1], p[2]]
    }

    fn assert_near(actual: u8, expected: i32, what: &str) {
        assert!(
            (actual as i32 - expected).abs() <= TOL,
            "{what}: got {actual}, expected ~{expected}"
        );
    }

    /// The feature, end to end: an adjustment clip on the TOP track really
    /// corrects a media clip on the track BELOW it, and only within its own
    /// span.
    ///
    /// The control is the same project at a position the adjustment clip does
    /// not cover, rendered through the same command against the same fixture —
    /// so a build that ignored adjustment clips would fail the "inside"
    /// assertions while still passing the "outside" ones, rather than passing
    /// everything.
    #[test]
    fn an_adjustment_clip_corrects_the_track_beneath_it_only_inside_its_own_span() {
        if !have_ffmpeg() {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        }
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().expect("tempdir");
        let teal = tmp.path().join("teal.mp4");
        // A colour with three DIFFERENT channel values, so a correction that
        // rebalances channels shows up as a change in their relationship and
        // not merely in overall brightness.
        flat_clip(&teal, "0x3080B0");

        // Track 0 (top): an adjustment clip covering frames 48..=71 only.
        // Track 1 (below): the picture, for the whole timeline.
        let _project = open_project(vec![
            video_track(vec![adjustment_clip("ADJ", 48, 24, layer())]),
            video_track(vec![media_clip("PIC", &teal)]),
        ]);
        super::decode_pipe::reset();

        // OUTSIDE the adjustment's span — the picture, untouched.
        let outside = centre_pixel(12);
        eprintln!("outside the adjustment span: {outside:?}");

        // INSIDE it — the same picture, corrected.
        let inside = centre_pixel(60);
        eprintln!("inside the adjustment span:  {inside:?}");

        // The load-bearing assertion, stated against the SHARED operator
        // rather than against numbers typed in by hand: whatever
        // `AdjustmentOps` says this correction does to the source colour is
        // what the preview must actually show. That is what ties this test to
        // the export, which compiles its coefficients from the very same
        // operator.
        let ops = AdjustmentOps::build(&layer(), 1.0);
        let expected = ops.apply_rgb8(outside);
        eprintln!("operator says outside -> {expected:?}");
        assert_near(
            inside[0],
            expected[0] as i32,
            "R inside the adjustment span",
        );
        assert_near(
            inside[1],
            expected[1] as i32,
            "G inside the adjustment span",
        );
        assert_near(
            inside[2],
            expected[2] as i32,
            "B inside the adjustment span",
        );

        // …and that it is genuinely a DIFFERENT picture, so the assertions
        // above cannot be satisfied by the adjustment doing nothing at all.
        let moved = (inside[0] as i32 - outside[0] as i32).abs()
            + (inside[1] as i32 - outside[1] as i32).abs()
            + (inside[2] as i32 - outside[2] as i32).abs();
        assert!(
            moved > 40,
            "the adjustment must visibly change the picture beneath it; \
             outside={outside:?} inside={inside:?}"
        );
        // Direction, not just magnitude: this correction warms (red up). A sign
        // error in the white-balance maths would keep `moved` large and still
        // be wrong.
        assert!(
            inside[0] > outside[0],
            "a +temperature correction must raise red: {outside:?} -> {inside:?}"
        );
    }

    /// The z-order claim, which IS the compositing model: an adjustment clip
    /// reaches only what is BELOW it. Same fixture as above with the two tracks
    /// swapped — the adjustment is now on the bottom track, so the picture
    /// above it must come through completely untouched.
    ///
    /// Without this, a build that applied the correction to the whole finished
    /// frame regardless of the clip's position would pass the test above.
    #[test]
    fn an_adjustment_clip_does_not_reach_a_track_above_it() {
        if !have_ffmpeg() {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        }
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().expect("tempdir");
        let teal = tmp.path().join("teal.mp4");
        flat_clip(&teal, "0x3080B0");

        // Track 0 (top): the picture. Track 1 (below): the adjustment.
        let _project = open_project(vec![
            video_track(vec![media_clip("PIC", &teal)]),
            video_track(vec![adjustment_clip("ADJ", 48, 24, layer())]),
        ]);
        super::decode_pipe::reset();

        let outside = centre_pixel(12);
        let inside = centre_pixel(60);
        eprintln!("adjustment BELOW the picture: outside={outside:?} inside={inside:?}");

        for (ch, name) in [(0usize, "R"), (1, "G"), (2, "B")] {
            assert_near(
                inside[ch],
                outside[ch] as i32,
                &format!("{name}: an adjustment below the picture must not change it"),
            );
        }
    }

    /// A freshly added, untouched adjustment clip is a guaranteed no-op — the
    /// property both engines' skip paths exist to preserve, and the reason
    /// "add one, then grade it" is a safe two-step for an agent.
    #[test]
    fn an_identity_adjustment_clip_changes_nothing() {
        if !have_ffmpeg() {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        }
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().expect("tempdir");
        let teal = tmp.path().join("teal.mp4");
        flat_clip(&teal, "0x3080B0");

        let _project = open_project(vec![
            video_track(vec![adjustment_clip(
                "ADJ",
                48,
                24,
                AdjustmentLayer::IDENTITY,
            )]),
            video_track(vec![media_clip("PIC", &teal)]),
        ]);
        super::decode_pipe::reset();

        let outside = centre_pixel(12);
        let inside = centre_pixel(60);
        for (ch, name) in [(0usize, "R"), (1, "G"), (2, "B")] {
            assert_near(
                inside[ch],
                outside[ch] as i32,
                &format!("{name}: an identity adjustment must change nothing"),
            );
        }
    }
}

/// **D-256 — the Colorist grade really reaches the Edit preview.**
///
/// The claim this decision makes is a pixel claim, so it is checked as one: the
/// same clip, at the same timeline position, through the real `timeline_frame`
/// command body, with and without a grade file on disk — and the frames must
/// differ in the direction the grade names.
///
/// Four things are asserted together, because any one alone would pass on a
/// broken build:
///
/// 1. **A real grade changes the picture** (and brightens it, for `+EV`) — the
///    headline. Without it, "the code calls a function" is all that is known.
/// 2. **An identity grade changes NOTHING, byte for byte** — the control, and
///    the reason assertion 1 is a measurement of the *grade* rather than of the
///    mere presence of a grade file flipping the compositor onto a different
///    code path (which it does: see `single_plain`). A build that applied any
///    lattice, identity included, fails here.
/// 3. **The same document renders the same bytes twice** — CLAUDE.md's
///    render-path invariant, on the new path.
/// 4. **A grade belongs to its own clip id only** — the D-070 link, checked
///    from the negative side.
///
/// Flat grey, not a test pattern, for `preview_transition_tests`' reason: "how
/// bright is this pixel now" is unanswerable against moving content.
#[cfg(test)]
mod grade_bridge_tests {
    use apelles_timeline::{Clip, Timeline, Track, TrackKind};

    use super::super::PROJECT_STATE_LOCK;
    use super::grade_lut;

    const W: u32 = 320;
    const H: u32 = 180;
    /// The grey the fixture clip is filled with (ffmpeg's `color=gray`).
    const GREY: i32 = 128;

    fn have_ffmpeg() -> bool {
        apelles_media::ffmpeg_locate::ffmpeg_path().is_ok()
    }

    fn have_gpu() -> bool {
        crate::render_core::init_gpu_context().is_ok()
    }

    /// 96 frames (4s at 24fps) of flat grey.
    fn grey_clip(path: &std::path::Path) {
        let ok = apelles_media::ffmpeg_locate::ffmpeg()
            .expect("an ffmpeg to build the fixture")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                &format!("color=gray:size={W}x{H}:rate=24:duration=4"),
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("spawn ffmpeg");
        assert!(ok.success(), "generating the grey fixture clip failed");
    }

    /// A one-clip project whose composition size is the clip's own, so an
    /// ungraded render takes the single-layer plain-decode fast path — which is
    /// exactly the path D-256 had to teach to decline itself.
    fn open_one_clip_project(dir: &std::path::Path, clip_path: &std::path::Path) {
        let project_dir = dir.join("Graded.chroma");
        std::fs::create_dir_all(apelles_project::grade_dir(&project_dir)).expect("mkdir project");

        let settings = super::project::ProjectSettings {
            width: Some(W),
            height: Some(H),
            ..Default::default()
        };
        let manifest = super::project::ProjectManifest {
            schema: "chroma.project/1.1".into(),
            name: "Graded".into(),
            created: String::new(),
            modified: String::new(),
            shots: Vec::new(),
            active_shot: 0,
            active_clip_id: None,
            settings,
            timelines: vec![Timeline {
                id: "tl1".into(),
                name: "Graded".into(),
                rate: Some(apelles_types::Rational { num: 24, den: 1 }),
                tracks: vec![Track {
                    kind: TrackKind::Video,
                    clips: vec![Clip {
                        id: "A".into(),
                        name: "A".into(),
                        source_path: clip_path.to_string_lossy().into_owned(),
                        source_fps: Some(24.0),
                        source_start: 0,
                        duration: 96,
                        source_len: 96,
                        start_frame: 0,
                        ..Default::default()
                    }],
                    ..Default::default()
                }],
                markers: Vec::new(),
            }],
            active_timeline: 0,
            media: Vec::new(),
            folders: Vec::new(),
        };
        super::project::save_manifest(&project_dir, &manifest).expect("save manifest");
        super::state::set_project(Some(super::state::ProjectRef {
            path: project_dir,
            name: "Graded".into(),
        }));
    }

    /// Write clip `A`'s grade document, exactly as `chroma_save_grade` would.
    fn write_grade(project_dir: &std::path::Path, adjustments: serde_json::Value) {
        let path = grade_lut::grade_file_for(project_dir, "A");
        std::fs::write(
            &path,
            serde_json::to_string(&serde_json::json!({
                "schema": "chroma.grade/1",
                "shot": { "source": "A" },
                "adjustments": adjustments,
                "notes": "",
            }))
            .expect("serialise grade"),
        )
        .expect("write grade");
        // The memo is keyed on (mtime, len); two writes inside one filesystem
        // timestamp tick could otherwise look unchanged. Explicit, not hopeful.
        grade_lut::clear_cache();
    }

    fn project_dir() -> std::path::PathBuf {
        super::state::current_project().expect("project open").path
    }

    /// The preview frame at `pos`, through the real command body, as
    /// `(centre pixel, hash of the whole JPEG)`.
    ///
    /// A hash rather than the `Vec<u8>` itself purely so a failure prints
    /// something a human can read — asserting on two 3 kB byte vectors dumps
    /// both of them into the panic message and buries the actual finding.
    /// Equality of the hash is equality of the bytes for this purpose: the
    /// frames being compared are renders of the same fixture, not adversarial
    /// input.
    fn preview(pos: u64) -> ([u8; 3], u64) {
        super::decode_pipe::reset();
        let jpeg =
            super::timeline_frame(pos, Some(W), super::FrameIntent::Single).expect("preview frame");
        (centre_pixel(&jpeg), hash(&jpeg))
    }

    fn hash(bytes: &[u8]) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        bytes.hash(&mut h);
        h.finish()
    }

    fn centre_pixel(jpeg: &[u8]) -> [u8; 3] {
        let img = image::load_from_memory(jpeg)
            .expect("decode jpeg")
            .to_rgba8();
        assert_eq!(img.dimensions(), (W, H));
        let p = img.get_pixel(W / 2, H / 2);
        [p[0], p[1], p[2]]
    }

    #[test]
    fn a_colorist_grade_visibly_changes_the_edit_preview() {
        if !have_ffmpeg() {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        }
        if !have_gpu() {
            eprintln!("skip: no GPU adapter, cannot bake a grade");
            return;
        }
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        grade_lut::clear_cache();

        let tmp = tempfile::tempdir().expect("tempdir");
        let clip = tmp.path().join("grey.mp4");
        grey_clip(&clip);
        open_one_clip_project(tmp.path(), &clip);
        let dir = project_dir();

        // --- 1. the baseline: no grade file at all -------------------------
        let (plain_px, plain) = preview(12);
        assert!(
            (plain_px[0] as i32 - GREY).abs() <= 8,
            "fixture is not flat grey: {plain_px:?}"
        );

        // --- 2. the CONTROL: an identity grade must change nothing ---------
        // Byte-identical, not merely close: an identity grade resolves to NO
        // lattice at all (`Lut3d::is_identity`), so the frame must take the very
        // same code path and produce the very same bytes as having no grade file
        // at all. This is what makes assertion 3 a measurement of the grade
        // rather than of the compositor path having changed underneath it.
        write_grade(&dir, serde_json::json!({}));
        let (identity_px, identity) = preview(12);
        assert_eq!(
            (identity_px, identity),
            (plain_px, plain),
            "an identity grade changed the preview — the bridge applied a lattice \
             it should have recognised as a no-op"
        );

        // --- 3. the HEADLINE: a real grade changes the picture --------------
        write_grade(&dir, serde_json::json!({ "exposure": 1.5 }));
        let (graded_px, graded) = preview(12);
        assert_ne!(
            graded, plain,
            "a +1.5 EV Colorist grade produced a byte-identical Edit preview \
             (centre pixel {graded_px:?} vs {plain_px:?}) — the grade is not \
             reaching the compositor at all"
        );
        assert!(
            graded_px[0] as i32 > plain_px[0] as i32 + 30,
            "+1.5 EV should visibly brighten the clip: ungraded {plain_px:?} vs graded {graded_px:?}"
        );

        // --- 4. determinism (CLAUDE.md's render-path invariant) -------------
        assert_eq!(
            preview(12),
            (graded_px, graded),
            "the same grade + the same frame rendered two different pictures"
        );

        // --- 5. and it is reversible: reset the grade, get the baseline back -
        write_grade(&dir, serde_json::json!({}));
        assert_eq!(
            preview(12),
            (plain_px, plain),
            "resetting the grade did not restore the ungraded picture"
        );

        super::state::set_project(None);
    }

    /// The same claim from the negative side: a grade written under a different
    /// clip id must not leak onto this clip. The grade↔clip link is the clip id
    /// (D-070), and nothing weaker.
    #[test]
    fn a_grade_belongs_to_its_own_clip_id_only() {
        if !have_ffmpeg() {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        }
        if !have_gpu() {
            eprintln!("skip: no GPU adapter, cannot bake a grade");
            return;
        }
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        grade_lut::clear_cache();

        let tmp = tempfile::tempdir().expect("tempdir");
        let clip = tmp.path().join("grey.mp4");
        grey_clip(&clip);
        open_one_clip_project(tmp.path(), &clip);
        let dir = project_dir();

        let plain = preview(12);
        std::fs::write(
            grade_lut::grade_file_for(&dir, "SOME-OTHER-CLIP"),
            serde_json::to_string(&serde_json::json!({
                "schema": "chroma.grade/1",
                "adjustments": { "exposure": 1.5 },
            }))
            .expect("serialise"),
        )
        .expect("write grade");
        grade_lut::clear_cache();

        assert_eq!(
            preview(12),
            plain,
            "another clip's grade leaked onto this one"
        );
        super::state::set_project(None);
    }

    /// **The export half of the same lattice.** `bake_luts_for_clips` must hand
    /// the ffmpeg compiler a real, readable `.cube` for a graded clip — and
    /// nothing at all for an ungraded one, so an un-graded timeline compiles to
    /// exactly the argv it always did.
    ///
    /// Asserts on the FILE, not just the map: the `.cube` is the actual
    /// interface with ffmpeg, and a path in a map pointing at a file that does
    /// not parse is the failure this is here to catch.
    #[test]
    fn the_export_bake_writes_a_real_cube_only_for_graded_clips() {
        if !have_gpu() {
            eprintln!("skip: no GPU adapter, cannot bake a grade");
            return;
        }
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        grade_lut::clear_cache();

        let tmp = tempfile::tempdir().expect("tempdir");
        let clip = tmp.path().join("grey.mp4");
        // No decode happens on this path, so the file need not be real video.
        std::fs::write(&clip, b"not a video").expect("write placeholder");
        open_one_clip_project(tmp.path(), &clip);
        let dir = project_dir();
        let ids = vec!["A".to_string()];

        // 1. ungraded — no entry, no file, no GPU device created
        let none = grade_lut::bake_luts_for_clips(&ids).expect("bake (ungraded)");
        assert!(none.luts.is_empty(), "an ungraded clip must produce no LUT");
        assert!(none.warnings.is_empty());

        // 2. an identity grade — a grade FILE exists, but it bakes to a no-op,
        //    so still no `lut3d` node in the export (mirrors the preview).
        write_grade(&dir, serde_json::json!({}));
        let identity = grade_lut::bake_luts_for_clips(&ids).expect("bake (identity)");
        assert!(
            identity.luts.is_empty(),
            "an identity grade must not put a lut3d node in the export"
        );

        // 3. a real grade — a real .cube, parseable by the app's own reader
        //    (which is what ffmpeg's `lut3d` will also have to do).
        write_grade(&dir, serde_json::json!({ "exposure": 1.5 }));
        let graded = grade_lut::bake_luts_for_clips(&ids).expect("bake (graded)");
        let path = graded
            .luts
            .get("A")
            .expect("a graded clip must produce a LUT path");
        assert!(
            std::path::Path::new(path).is_file(),
            "the .cube path does not exist: {path}"
        );
        let parsed = crate::lut_processing::parse_lut_file(path).expect("ffmpeg-readable .cube");
        assert_eq!(parsed.size, apelles_types::lut3d::DEFAULT_SIZE);

        // 4. content-addressed: baking again is byte-identical and reuses the
        //    same filename, which is what lets a QUEUED export's frozen argv
        //    keep pointing at the lattice it was compiled against.
        let again = grade_lut::bake_luts_for_clips(&ids).expect("bake (repeat)");
        assert_eq!(
            again.luts.get("A"),
            Some(path),
            "the .cube name is not stable"
        );

        super::state::set_project(None);
    }

    /// **The parity claim itself, measured.**
    ///
    /// Everything else in this file checks one engine. This checks that the two
    /// engines agree: the SAME clip, the SAME grade, rendered once by the CPU
    /// preview compositor and once by ffmpeg's own `lut3d` reading the `.cube`
    /// the export path writes — and the two pictures must be the same colour.
    ///
    /// That is the entire justification for D-256's baked-lattice design over
    /// the alternatives (a second CPU implementation of the grading stack, or
    /// preview-only with a documented export gap), so it is checked rather than
    /// asserted. `apelles_types::adjustment`'s header called this parity
    /// structurally unreachable; this test is what says otherwise, in pixels.
    ///
    /// The tolerance absorbs one h264/yuv420p round trip plus the RGB↔YUV
    /// conversions `lut3d` forces — the same ±14 the sibling TypeScript ffmpeg
    /// suites use, and far tighter than the ~100-code move being measured.
    #[test]
    fn the_preview_and_the_ffmpeg_export_render_the_same_graded_colour() {
        if !have_ffmpeg() {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        }
        if !have_gpu() {
            eprintln!("skip: no GPU adapter, cannot bake a grade");
            return;
        }
        const TOL: i32 = 14;
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        grade_lut::clear_cache();

        let tmp = tempfile::tempdir().expect("tempdir");
        let clip = tmp.path().join("grey.mp4");
        grey_clip(&clip);
        open_one_clip_project(tmp.path(), &clip);
        let dir = project_dir();
        write_grade(&dir, serde_json::json!({ "exposure": 1.5 }));

        // Engine 1 — the live Edit preview (CPU trilinear over the lattice).
        let (preview_px, _) = preview(12);

        // Engine 2 — ffmpeg's own `lut3d`, over the `.cube` the export writes.
        let baked = grade_lut::bake_luts_for_clips(&["A".to_string()]).expect("bake");
        let cube = baked
            .luts
            .get("A")
            .expect("a graded clip must produce a LUT");
        let out = apelles_media::ffmpeg_locate::ffmpeg()
            .expect("an ffmpeg to build the fixture")
            .args(["-v", "error", "-i"])
            .arg(&clip)
            .arg("-vf")
            // Same interpolation the preview's sampler uses — NOT lut3d's
            // tetrahedral default. See `timelineExport.ts`'s own node.
            .arg(format!(
                "lut3d=file={}:interp=trilinear",
                cube.replace(':', "\\:")
            ))
            .args(["-vframes", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
            .output()
            .expect("spawn ffmpeg");
        assert!(
            out.status.success() && out.stdout.len() >= 3,
            "ffmpeg lut3d produced no pixel: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let export_px = [out.stdout[0], out.stdout[1], out.stdout[2]];

        for (i, ch) in ["R", "G", "B"].iter().enumerate() {
            assert!(
                (preview_px[i] as i32 - export_px[i] as i32).abs() <= TOL,
                "{ch}: the Edit preview and the ffmpeg export disagree on the graded \
                 colour — preview {preview_px:?}, export {export_px:?}"
            );
        }
        // And the thing they agree on is actually a grade, not the source: a
        // build that applied nothing anywhere would satisfy the loop above.
        assert!(
            preview_px[0] as i32 > GREY + 30,
            "both engines agree, but on the UNGRADED colour: {preview_px:?}"
        );

        super::state::set_project(None);
    }

    /// A masked grade still exports — as its primary only — but says so. The
    /// warning is the whole point: this is the one case where the exported file
    /// legitimately will not match the Colorist tab.
    #[test]
    fn a_masked_grade_exports_its_primary_and_warns() {
        if !have_gpu() {
            eprintln!("skip: no GPU adapter, cannot bake a grade");
            return;
        }
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        grade_lut::clear_cache();

        let tmp = tempfile::tempdir().expect("tempdir");
        let clip = tmp.path().join("grey.mp4");
        std::fs::write(&clip, b"not a video").expect("write placeholder");
        open_one_clip_project(tmp.path(), &clip);
        let dir = project_dir();

        write_grade(
            &dir,
            serde_json::json!({
                "exposure": 1.5,
                "masks": [{ "visible": true, "adjustments": { "exposure": -2.0 } }],
            }),
        );
        let baked = grade_lut::bake_luts_for_clips(&["A".to_string()]).expect("bake");
        assert!(
            baked.luts.contains_key("A"),
            "the primary must still export"
        );
        assert!(
            baked
                .warnings
                .iter()
                .any(|w| w.contains("clip A") && w.contains("masked/local")),
            "a dropped mask must be reported to the user, not only logged: {:?}",
            baked.warnings
        );

        super::state::set_project(None);
    }
}
