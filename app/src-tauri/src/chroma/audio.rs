//! Tauri bridge for the Edit-tab audio engine (D-049/D-050/D-051/D-057).
//!
//! What it is: the app-side half of the D-146 `apelles-media` extraction
//! (`docs/notes/crate-extraction-plan.md` §2.2). Two things live here, and
//! only two:
//!
//! 1. The `#[tauri::command]` wrappers (five for playback, plus D-232's three
//!    for scrubbing). Commands never move into a crate — a real `tauri-macros`
//!    constraint, not a preference (plan §1).
//! 2. The body of [`chroma_audio_play`] that turns a **timeline frame** into a
//!    set of audio sources. That is timeline resolution
//!    (`edit::resolve_video_position` / `edit::resolve_audio_track_positions`
//!    over `apelles-timeline`), which sits a layer *above* media and will
//!    belong to `apelles-compositor` when that becomes real (plan §2.8). It is
//!    exactly why `audio.rs` was split rather than moved whole.
//!
//! What it does NOT do: any decoding, resampling, mixing, device output,
//! waveform extraction or session bookkeeping — `apelles_media::audio` owns all
//! of it, including the D-130 request-ordering protocol. This file used to be
//! the whole 3,086-line implementation; see D-146 in `docs/08-decisions.md`.
//!
//! The ordering that the D-125 skew compensation depends on is preserved
//! exactly: `apelles_media::audio::begin_play` stamps `requested_at` and claims
//! the session **before** the resolution below runs, so the resolution's own
//! cost is still inside the skew `run_session` measures.
//!
//! D-147 added a third, strictly-derived thing to point 2: [`fade_for_clip`],
//! which turns a clip's fade *frames* into the seconds-based
//! `apelles_media::audio::FadeEnvelope` the mixer applies. That conversion is
//! the same frames→seconds step [`chroma_audio_play`] already does for
//! `start_secs` / `duration_secs`, done for one more pair of fields; the
//! envelope's arithmetic, and the decision to apply it per output sample-frame,
//! are the crate's. D-223 added [`level_for_clip`] beside it on exactly the
//! same seam — a clip's own `volume`/`pan` (and their keyframes, in the clip's
//! own source-frame space) turned into the seconds-based
//! `apelles_media::audio::LevelEnvelope`.

use std::path::PathBuf;

use apelles_media::audio::{
    AudioSourceSpec, AudioSpeedSegment, DuckEnvelope, FadeEnvelope, LevelEnvelope,
};
use apelles_media::scrub::ScrubSource;

/// Stop whatever is currently playing (or a no-op if nothing is). Called on
/// pause and on unmount; also called implicitly by [`chroma_audio_play`]
/// before it starts a new session.
///
/// `(async)` (D-125): this joins the audio thread, which can take up to one of
/// its poll intervals — that must not happen on Tauri's main thread, where it
/// would stall the window and every other in-flight command.
///
/// `seq` (D-130) is the frontend's monotonic request stamp — a stop that has
/// already been overtaken by a newer play/stop is dropped rather than killing
/// the session that superseded it.
#[tauri::command(async)]
pub fn chroma_audio_stop(seq: u64) {
    apelles_media::audio::stop(seq);
}

/// Set the master preview-monitoring volume (D-126) — a `0.0..=1.0` linear
/// multiplier applied to every sample in the real `cpal` output callback.
/// Out-of-range input is clamped rather than rejected.
#[tauri::command]
pub fn chroma_audio_set_volume(volume: f32) {
    apelles_media::audio::set_volume(volume);
}

/// Last-measured (rms, peak) of the audio actually written to the output
/// device, roughly once per second of playback; `(0.0, 0.0)` when nothing is
/// playing. The concrete, pollable proxy for "is cpal really producing
/// non-silent PCM" (D-049 verification); not wired to any meter UI yet.
#[tauri::command]
pub fn chroma_audio_level() -> (f32, f32) {
    apelles_media::audio::level()
}

/// Downsampled amplitude envelope for `source_path`'s `[start_secs,
/// start_secs + duration_secs)` range (D-051) — what `Waveform.tsx` draws
/// instead of decoding PCM in the browser. All times are in the **source
/// file's** own base; the caller converts from timeline frames. Returns an
/// empty `Vec` (not an error) for a source with no audio stream or a
/// non-positive `duration_secs`/`buckets`.
#[tauri::command]
pub async fn chroma_audio_waveform(
    source_path: String,
    start_secs: f64,
    duration_secs: f64,
    buckets: usize,
) -> Result<Vec<(f32, f32)>, String> {
    apelles_media::audio::waveform(source_path, start_secs, duration_secs, buckets).await
}

/// Turn the frontend's `(path, source_secs)` pair into a scrub target (D-232),
/// or `None` when there is nothing audible under the playhead — a gap, a silent
/// clip, or past the end of the timeline, all of which are ordinary states that
/// must sound like silence.
///
/// **Why the frontend resolves this and not us.** Every other timeline→media
/// conversion in this file ([`fade_for_clip`] and friends) is app-side
/// precisely because it needs a `apelles_timeline::Clip`. A scrub's is not: it
/// arrives already resolved, in exactly the "bare source path + source seconds"
/// shape [`chroma_audio_waveform`] has taken since D-051, and for the same
/// reason — the caller is a pointer drag firing tens of times a second, and
/// [`super::edit::resolve_video_position`] would re-read and clone the whole
/// active `Timeline` out of the project manifest on every one of them. See
/// D-232 for the full weighing, including why this is a real boundary call
/// rather than a convenience: `@apelles/editor`'s `clipAt` is already the
/// pointwise mirror of `apelles_timeline::Track::clip_at` and is already what
/// every other Edit-tab UI decision resolves through.
fn scrub_source(source_path: Option<String>, source_secs: f64, gain: f32) -> Option<ScrubSource> {
    let path = source_path.filter(|p| !p.is_empty())?;
    if !source_secs.is_finite() {
        return None;
    }
    Some(ScrubSource {
        path: PathBuf::from(path),
        source_secs: source_secs.max(0.0),
        // B-110 — the frontend resolves this the same way it resolves the path
        // and the second (`ScrubSource.gain`); a malformed value is normalised
        // to unity by `apelles_media::scrub::apply_gain` rather than here, so
        // there is one rule for it and not two.
        gain,
    })
}

/// Begin a tape-style scrub gesture (D-232) — the pointer went down on the
/// timeline cursor or the player's position bar.
///
/// Claims the SAME transport `chroma_audio_play`/`chroma_audio_stop` use, so a
/// scrub started during playback stops it, and pressing Play during a scrub
/// stops the scrub, through the one D-130 ordering protocol rather than a
/// second one. `seq` is the frontend's monotonic stamp, from the same counter
/// the other two commands use.
///
/// `(async)` (D-125): like the other two, this joins the outgoing session's
/// thread and must not do that on Tauri's main thread.
#[tauri::command(async)]
pub fn chroma_audio_scrub_begin(
    source_path: Option<String>,
    source_secs: f64,
    gain: f32,
    seq: u64,
) -> Result<(), String> {
    let Some(session) = apelles_media::scrub::begin(seq) else {
        // Overtaken by a newer transport request before this task got a worker
        // thread — same drop the play path makes, for the same reason.
        return Ok(());
    };
    apelles_media::scrub::start(session, scrub_source(source_path, source_secs, gain))
}

/// Move the scrub read head — called for every pointer move of the drag.
///
/// **Deliberately a plain blocking `#[tauri::command]`, and deliberately
/// without a `seq`.** It only stores into a mutex (microseconds), so there is
/// nothing to get off the main thread; and running inline on the IPC drain
/// means these keep their issue order for free, where the `(async)` commands
/// around it cannot. A position is a level, not an edge — last writer wins is
/// exactly what a scrub wants. See `apelles_media::scrub::update`.
#[tauri::command]
pub fn chroma_audio_scrub_update(source_path: Option<String>, source_secs: f64, gain: f32) {
    apelles_media::scrub::update(scrub_source(source_path, source_secs, gain));
}

/// End the scrub gesture (pointer up, or the component unmounting mid-drag).
/// The same stop the transport already had, under the name the gesture calls
/// it by.
#[tauri::command(async)]
pub fn chroma_audio_scrub_end(seq: u64) {
    apelles_media::scrub::end(seq);
}

/// Resolve `frame` on the active timeline to every currently-active audio
/// source at that instant — the video track's own embedded audio (D-050's
/// original, still-default behaviour, unchanged: always at unity gain,
/// resolved via the same [`super::edit::resolve_video_position`] lookup the
/// video preview uses) **plus** (D-057, Phase C) any clip on a genuine
/// `TrackKind::Audio` track that overlaps `frame`, each at its own track's
/// gain. No active source anywhere (no video clip at this position, or one
/// with no audio stream, and no audio-track clip either) is **not** an
/// error: it just means nothing plays at `frame`, matching the video
/// preview's own "blank frame past the end" behaviour.
///
/// **This resolution is the whole reason `audio.rs` split rather than moved
/// (D-146).** Everything [`apelles_media::audio::run_session`] does with the
/// `Vec` this returns is that crate's; the two `edit::resolve_*` calls here
/// are `apelles-timeline`'s model seen through the Edit-tab bridge, and a
/// media crate that reached for them would be reaching *up* a layer — which
/// is exactly why this function is handed to `run_session` as a `Send`
/// closure (B-111) rather than the crate calling back into `chroma::edit`
/// itself.
///
/// D-129 — a video clip carrying a `link_group` is **skipped** as an
/// embedded-audio source: its sound now lives in a real, linked audio clip
/// that the audio-track walk below picks up on its own. See the inline
/// comment at that check for why the suppression is unconditional, and
/// `apelles_timeline::Clip::link_group` for what the field means on a video
/// clip. A pre-D-129 clip has no `link_group` and takes the unchanged
/// D-050 path.
///
/// **B-111 — called more than once per session.** [`chroma_audio_play`]
/// calls this once, for its own `start_frame`, to build the session's
/// initial `Vec`; `apelles_media::audio::start` is ALSO given this function
/// itself (as `resolve_at`), and `run_session` calls it again periodically
/// on its own thread as the timeline plays forward, so a clip that starts
/// later than `start_frame` is discovered and opened when its own moment
/// comes rather than never at all. Every `AudioSourceSpec` carries its
/// [`apelles_timeline::Clip::id`] as `clip_id` so `run_session` can tell "this
/// is the same clip, still playing" from "this is a clip that just started"
/// across two calls at different frames — this function has no idea that
/// matters, it just resolves `frame` fresh every time, exactly as if it were
/// the only call.
fn resolve_sources_at(frame: u64) -> Result<Vec<AudioSourceSpec>, String> {
    let mut sources: Vec<AudioSourceSpec> = Vec::new();
    // B-079 — the active timeline's own rate, for every `end_frame_at(fps)`
    // out-point below (fps-naive `end_frame()` before this fix). A cheap
    // extra manifest read (see `timeline_fps`'s own doc) rather than
    // widening `resolve_video_position`/`resolve_audio_track_positions`.
    let fps = super::edit::timeline_fps()?;

    if let Some((track_index, clip, source_frame, info)) =
        super::edit::resolve_video_position(frame)?
    {
        if clip.link_group.is_some() {
            // D-129 — this video clip's audio has been externalized into a
            // linked audio clip (see `apelles_timeline::Clip::link_group`), so
            // it contributes NO embedded-audio source here: the linked clip
            // is picked up below by `resolve_audio_track_positions` like any
            // other audio-track clip, with its own track's gain/mute, its own
            // trim and its own position. Without this, both would play and
            // the same audio would be summed with itself (≈+6 dB, phase
            // doubled) for every clip dropped after D-129.
            //
            // Unconditional, not "only when the linked half really covers
            // this position": if the user slipped the audio half elsewhere
            // (an L-cut) the picture is correctly silent here, and if they
            // deleted it, the clip stays silent — exactly what Premiere and
            // Resolve do with a deleted audio half. `unlink` is the way back
            // to embedded playback.
            log::debug!(
                "chroma_audio_play: {} is A/V-linked — audio comes from its linked clip, not its embedded stream",
                clip.source_path
            );
        } else if info.has_audio {
            // How much of this clip is still ahead of the playhead, in the
            // clip's own frame space — the out-point past which this source
            // must fall silent (B-048). B-079 — `end_frame_at(fps)`, not the
            // fps-naive `end_frame()`: a mixed-native-fps clip's real
            // out-point depends on its own `source_fps` against the
            // timeline's rate.
            let remaining_frames = (clip.end_frame_at(fps) - frame as i64).max(0) as u64;
            // D-242 — a ramped clip overrides the open point and the out-point
            // with the retime's own, because under a ramp the source second to
            // open at and the number of OUTPUT seconds left stop being the same
            // number. `None` (every un-ramped clip) leaves both exactly as the
            // two lines above computed them.
            let speed = speed_for_clip(&clip, &info, frame as i64, fps);
            sources.push(AudioSourceSpec {
                path: PathBuf::from(&clip.source_path),
                start_secs: speed
                    .as_ref()
                    .map_or_else(|| info.frame_to_secs(source_frame), |s| s.open_secs),
                duration_secs: Some(
                    speed
                        .as_ref()
                        .map_or_else(|| info.frame_to_secs(remaining_frames), |s| s.output_secs),
                ),
                speed: speed.map(|s| s.segments).unwrap_or_default(),
                gain: 1.0,
                // D-147 — a fade on a VIDEO clip fades its embedded audio too,
                // not just its picture. One fade handle per clip, whose meaning
                // follows what the clip contributes (see
                // `apelles_timeline::Clip::fade_in_frames` and the plan doc §2);
                // this is the "…and its sound" half of that, the compositor's
                // `resolve_clip_transform` being the picture half.
                fade: fade_for_clip(&clip, &info, frame as i64 - clip.start_frame),
                // D-149 — a video track's embedded audio is a mixed source like
                // any other, so it ducks like any other. Rare in practice (the
                // thing you duck is a music bed, which lives on an audio track,
                // and D-129 externalises new clips' audio anyway) but excluding
                // it would be an asymmetry with no reason behind it.
                duck: duck_for_track(track_index, frame, &info)?,
                // D-223 — a video clip's own Clip Volume / Clip Pan apply to
                // its embedded audio, the one thing that clip contributes to
                // the mix. (They have no picture meaning at all, unlike the
                // fade above — see `Clip::volume`.)
                level: level_for_clip(&clip, &info, frame as i64 - clip.start_frame),
                // D-224 — and so does its EQ, for the same reason and on the
                // same stream. Handed over verbatim: unlike the three above,
                // an EQ band needs no frames→seconds conversion (hertz,
                // decibels and Q are not timeline quantities), so there is no
                // `eq_for_clip` beside `fade_for_clip`/`level_for_clip` — the
                // filter itself is built by `apelles_media`, at the output
                // device's real sample rate, which only it knows.
                eq_bands: clip.eq_bands.clone(),
                // B-111 — see this function's own doc: the identity
                // `run_session`'s periodic re-resolve matches "already open"
                // sources against.
                clip_id: clip.id.clone(),
            });
        } else {
            log::debug!(
                "chroma_audio_play: {} has no audio stream — nothing from the video track",
                clip.source_path
            );
        }
    }

    for (track_index, clip, source_frame, info, gain) in
        super::edit::resolve_audio_track_positions(frame)?
    {
        // B-079 — `source_frame` is now `resolve_audio_track_positions`'s own
        // fps-correct `Track::clip_at` result (passed through, no longer
        // discarded), not a second, fps-naive `clip.source_start +
        // elapsed_frames` re-derivation at this call site — that
        // re-derivation, applied to a mixed-native-fps clip, was the bug.
        // `elapsed_frames` stays a plain TIMELINE-frame difference (both
        // operands already share that unit) — only `fade_for_clip` below
        // still needs it.
        let elapsed_frames = frame as i64 - clip.start_frame;
        let remaining_frames = (clip.end_frame_at(fps) - frame as i64).max(0) as u64;
        // D-242 — see the video-track source above; identical for the same
        // reason, since a ramp is a property of the clip and not of what kind
        // of track it sits on.
        let speed = speed_for_clip(&clip, &info, frame as i64, fps);
        sources.push(AudioSourceSpec {
            path: PathBuf::from(&clip.source_path),
            start_secs: speed
                .as_ref()
                .map_or_else(|| info.frame_to_secs(source_frame), |s| s.open_secs),
            duration_secs: Some(
                speed
                    .as_ref()
                    .map_or_else(|| info.frame_to_secs(remaining_frames), |s| s.output_secs),
            ),
            speed: speed.map(|s| s.segments).unwrap_or_default(),
            gain,
            // D-147 — an audio clip's fade is a gain fade, the direct
            // counterpart of the opacity fade a video clip's picture gets.
            fade: fade_for_clip(&clip, &info, elapsed_frames),
            // D-149 — the everyday ducking case: a music bed on this track,
            // ducked by whatever is on the dialogue track it points at.
            duck: duck_for_track(track_index, frame, &info)?,
            // D-223 — the everyday case: this clip's own level and stereo
            // position, independent of its track's fader.
            level: level_for_clip(&clip, &info, elapsed_frames),
            // D-224 — and its own EQ, verbatim (see the video-track source
            // above for why there is no conversion step for these).
            eq_bands: clip.eq_bands.clone(),
            // B-111 — see this function's own doc.
            clip_id: clip.id.clone(),
        });
    }

    Ok(sources)
}

/// Seek-and-play in one call: resolve `start_frame` via
/// [`resolve_sources_at`] and hand the result to `apelles_media::audio::start`
/// — which decodes and mixes it, AND (B-111) calls [`resolve_sources_at`]
/// again on its own as playback continues, so a clip starting later than
/// `start_frame` is not silent for the whole session. See
/// [`resolve_sources_at`]'s own doc for the full story; this wrapper is only
/// the Tauri command boundary and the D-125 session claim.
///
/// `(async)` (D-125): see [`chroma_audio_stop`] — same reason, and here it
/// also means the command isn't itself queued behind a main-thread preview
/// decode, which is precisely the latency the video clock does not wait for.
///
/// `seq` (D-130) is the frontend's monotonic request stamp; a play that a newer
/// request has already overtaken is dropped instead of starting a session from
/// a stale `start_frame`.
///
/// `rate` (D-280) is the preview PLAYBACK rate — timeline seconds per real
/// second, `1.0` for ordinary playback, clamped here to
/// [`PLAYBACK_RATE_MIN`]`..=`[`PLAYBACK_RATE_MAX`] so a malformed IPC value
/// cannot ask the mixer for something absurd. It changes only how fast this
/// SESSION runs, applied post-mix and pitch-preserving; it touches no clip, no
/// project and no export. A rate change is a fresh `chroma_audio_play` from the
/// current playhead, which is also when the video clock re-baselines — see
/// `apelles_media::audio`'s own "Playback rate" section, and `PreviewPane.tsx`.
///
/// **Not** [`speed_for_clip`]'s per-clip Speed/Retime ramp (D-236/D-242), which
/// is project data, is part of the export, and varispeeds on purpose.
#[tauri::command(async)]
pub fn chroma_audio_play(start_frame: u64, seq: u64, rate: f64) -> Result<(), String> {
    // Claims the transport and stamps the "the frontend asked for playback"
    // instant the D-125 skew compensation measures against — deliberately
    // before the resolution below, exactly as the pre-split code did.
    let Some(session) = apelles_media::audio::begin_play(seq) else {
        // Overtaken by a newer request before this task got a worker thread.
        // Starting anyway would replay the timeline from a playhead the
        // picture has already moved past (B-047).
        return Ok(());
    };

    let fps = super::edit::timeline_fps()?;
    let sources = resolve_sources_at(start_frame)?;

    apelles_media::audio::start(
        session,
        sources,
        start_frame,
        fps,
        clamp_playback_rate(rate),
        Box::new(resolve_sources_at),
    )
}

/// D-280 — the slowest preview playback rate the transport will accept.
/// Below this the WSOLA stage is repeating each segment four times or more and
/// the artefacts stop being worth the review speed; it is also well past
/// anything the reference tools' own shuttle ladders offer.
pub const PLAYBACK_RATE_MIN: f64 = 0.25;

/// D-280 — the fastest. 8x is the top of Final Cut Pro's own J/K/L shuttle
/// ladder (1x → 2x → 4x → 8x), which is the natural ceiling to borrow; the
/// GUI's own presets stop at 4x and only the custom field can reach here.
pub const PLAYBACK_RATE_MAX: f64 = 8.0;

/// Bring an IPC-supplied playback rate into range. A non-finite or absent value
/// reads as ordinary 1x playback rather than as an error: the transport must
/// keep working, and a caller that sent nonsense wanted to play something.
/// Mirrors `chroma_audio_set_volume`'s own clamp-don't-reject contract, and the
/// same clamp `@apelles/editor`'s `playbackRate.ts` applies on the way in — a
/// boundary is checked at the boundary, on both sides.
fn clamp_playback_rate(rate: f64) -> f64 {
    if !rate.is_finite() || rate <= 0.0 {
        return 1.0;
    }
    rate.clamp(PLAYBACK_RATE_MIN, PLAYBACK_RATE_MAX)
}

/// Build the fade envelope for `clip`, or `None` if it has no fade — the
/// common path, and the one that keeps the mix byte-identical to pre-D-147
/// (see [`FadeEnvelope`], whose `None` case makes the mixer skip its
/// per-sample pass entirely rather than multiply by a 1.0 it computed).
///
/// **This is the timeline→media half of D-147, which is why it is app-side
/// rather than in `apelles-media`.** [`FadeEnvelope`] is seconds — a media
/// fact, exactly like [`AudioSourceSpec`]'s `start_secs`/`duration_secs`
/// beside it. A *clip* with fade *frames* is not: converting one to the other
/// needs `apelles_timeline::Clip` and the clip's probed
/// [`super::video::VideoInfo`], and a media crate reaching for either would be
/// reaching *up* a layer (D-039/D-146 — the same rule that kept
/// [`chroma_audio_play`]'s body here at all).
///
/// `elapsed_frames` is how far into the clip playback is starting, in timeline
/// frames. Frames → seconds goes through the clip's own probed
/// [`super::video::VideoInfo::frame_to_secs`], the same conversion the clip
/// out-point arithmetic (B-048/D-130) already uses a few lines up at each call
/// site — so this inherits the model's existing assumption that a clip's source
/// fps is its timeline fps rather than introducing a second one.
/// D-242 — this clip's speed ramp as the live mixer takes it: where in the
/// source to OPEN, how many OUTPUT seconds are left, and the runs themselves in
/// seconds relative to that open point. `None` when the clip plays at its
/// recorded rate, which is every clip in every pre-D-236 project — and `None`
/// is what keeps their mix byte-identical, because it leaves the two fields it
/// would otherwise override exactly as they were.
///
/// **This is the timeline→media half of D-242, which is why it is app-side**,
/// exactly like [`fade_for_clip`] and [`level_for_clip`] and for the same
/// reason: an [`AudioSpeedSegment`] is seconds and a number — media facts —
/// while "this clip's speed runs, in its own source-frame space, from the
/// playhead on" needs a `apelles_timeline::Clip` and its probed
/// [`super::video::VideoInfo`], which a media crate reaching for would be
/// reaching *up* a layer (D-039/D-146).
///
/// **Why `open_secs` is not simply the source second under the playhead.**
/// `symphonia` decodes forwards. A run playing in REVERSE is entered at its
/// highest source second and walks down, so opening the file where the
/// playhead is would open it past everything the run is about to play. The
/// open point is therefore the LOWEST source frame any remaining run touches,
/// and the retime reads the buffer that fills from there in whichever
/// direction each run travels. For an all-forward ramp that lowest frame IS
/// the frame under the playhead, so nothing changes.
fn speed_for_clip(
    clip: &apelles_timeline::Clip,
    info: &super::video::VideoInfo,
    start_frame: i64,
    fps: f64,
) -> Option<ClipSpeed> {
    if clip.speed_points.is_empty() {
        return None;
    }
    let (runs, out_source_frames) = clip.remaining_speed_segments(start_frame, fps);
    if runs.is_empty() {
        return None;
    }
    let open_frame = runs
        .iter()
        .map(|r| r.start_source_frame)
        .min()
        .unwrap_or(clip.source_start)
        .max(0);
    let open_secs = info.frame_to_secs(open_frame as u64);
    // Relative to the open point, in the clip's OWN native rate — the same
    // conversion `@apelles/editor`'s `rampSegmentSeconds` makes for the
    // exporter, so the live chain and the ffmpeg chain are built from the same
    // numbers.
    let segments = runs
        .iter()
        .map(|r| AudioSpeedSegment {
            start_secs: info.frame_to_secs((r.start_source_frame - open_frame).max(0) as u64),
            end_secs: info.frame_to_secs((r.end_source_frame - open_frame).max(0) as u64),
            speed: r.speed,
        })
        .collect();
    Some(ClipSpeed {
        open_secs,
        // OUTPUT seconds, which under a ramp is NOT the source span — that is
        // the whole distinction `AudioSourceSpec::duration_secs` documents.
        output_secs: if info.fps() > 0.0 {
            out_source_frames.max(0.0) / info.fps()
        } else {
            0.0
        },
        segments,
    })
}

/// What [`speed_for_clip`] resolves to: the three values a ramped clip's
/// [`AudioSourceSpec`] needs that an un-ramped one gets from the playhead
/// directly.
struct ClipSpeed {
    /// Absolute source seconds to open the file at.
    open_secs: f64,
    /// How many OUTPUT seconds this clip still contributes.
    output_secs: f64,
    /// The runs, relative to `open_secs`.
    segments: Vec<AudioSpeedSegment>,
}

fn fade_for_clip(
    clip: &apelles_timeline::Clip,
    info: &super::video::VideoInfo,
    elapsed_frames: i64,
) -> Option<FadeEnvelope> {
    if clip.fade_in_frames <= 0 && clip.fade_out_frames <= 0 {
        return None;
    }
    let secs = |frames: i64| info.frame_to_secs(frames.max(0) as u64);
    Some(FadeEnvelope {
        offset_secs: secs(elapsed_frames),
        len_secs: secs(clip.duration),
        fade_in_secs: secs(clip.fade_in_frames),
        fade_out_secs: secs(clip.fade_out_frames),
        in_curve: clip.fade_in_curve,
        out_curve: clip.fade_out_curve,
    })
}

/// Build this clip's own volume/pan envelope (D-223), or `None` when it is at
/// unity and centred — the common path, and the one that keeps the mix
/// byte-identical to pre-D-223 (see [`LevelEnvelope::new`], whose `None` makes
/// the mixer skip its per-sample pass rather than multiply by a 1.0 it
/// computed).
///
/// **This is the timeline→media half of D-223, which is why it is app-side**,
/// exactly like [`fade_for_clip`] above and for the same reason: a
/// [`LevelEnvelope`] is seconds and plain numbers — media facts — while "this
/// clip's `volume` keyframes, in its own source-frame space" needs a
/// `apelles_timeline::Clip` and its probed [`super::video::VideoInfo`], which a
/// media crate reaching for would be reaching *up* a layer (D-039/D-146).
///
/// **Keyframes are read through [`super::keyframes::parse_keyframes`]**, the
/// same D-034 parser `chroma::edit::resolve_clip_transform` uses for the
/// picture — so a `"volume"` key an agent or the Inspector wrote is seen here
/// exactly as the compositor sees an `"opacity"` one. What this does NOT do is
/// call `interpolate_param` per sample: the mixer needs a self-contained
/// envelope it can evaluate on its own thread, so the keys are converted once,
/// here, into the clip-local seconds `LevelCurve::Keys` interpolates between —
/// linearly, holding outside, which is `interpolate_param`'s own rule for a
/// numeric param. (Its `rotation` shortest-arc special case is not reachable
/// for these two names, and its `round6` is not applied — a ≤5e-7 difference
/// in a linear gain, two orders of magnitude below `f32` audio precision.)
///
/// `elapsed_frames` is how far into the clip playback is starting, in timeline
/// frames — the same argument, meaning and conversion [`fade_for_clip`] takes.
fn level_for_clip(
    clip: &apelles_timeline::Clip,
    info: &super::video::VideoInfo,
    elapsed_frames: i64,
) -> Option<LevelEnvelope> {
    let fps = info.fps();
    // Signed, unlike `VideoInfo::frame_to_secs`'s own `u64`: a key authored
    // BEFORE this clip's current in-point is perfectly legal (trimming never
    // deletes keys) and is what holds the curve's value at the clip's head, so
    // its clip-local position is genuinely negative and must stay so.
    let secs = |frames: i64| if fps > 0.0 { frames as f64 / fps } else { 0.0 };

    let keyframes = clip.chroma_keyframes.as_ref().and_then(|kf| {
        // `parse_keyframes` reads `parameters.chromaKeyframes` off the
        // CONTAINING object; `Clip::chroma_keyframes` is the bare array. Same
        // one-line wrap `resolve_clip_transform` does, not a second parser.
        let wrapped = serde_json::json!({ "chromaKeyframes": kf });
        super::keyframes::parse_keyframes(&wrapped)
    });

    let curve = |name: &str, static_value: f64| -> apelles_media::audio::LevelCurve {
        let Some(keys) = keyframes.as_ref() else {
            return apelles_media::audio::LevelCurve::Const(static_value);
        };
        let points: Vec<(f64, f64)> = keys
            .iter()
            .filter_map(|k| {
                let v = k.params.get(name)?.as_f64()?;
                if !v.is_finite() {
                    return None;
                }
                Some((secs(k.frame as i64 - clip.source_start), v))
            })
            .collect();
        // No key names this param -> its static field governs, exactly as
        // `interpolate_param` returning `None` means for the compositor.
        if points.is_empty() {
            apelles_media::audio::LevelCurve::Const(static_value)
        } else {
            // `parse_keyframes` is frame-sorted, so this is already ascending
            // — `LevelCurve::value_at`'s stated precondition, met by
            // construction rather than by a re-sort.
            apelles_media::audio::LevelCurve::Keys(points)
        }
    };

    LevelEnvelope::new(
        secs(elapsed_frames),
        curve("volume", clip.volume),
        curve("pan", clip.pan),
    )
}

/// Build the ducking envelope for the source on track `track_index`, or `None`
/// if that track isn't ducked — the common path, and the one that keeps the mix
/// byte-identical to pre-D-149 (see [`DuckEnvelope`], whose `None` case makes
/// the mixer skip its per-sample pass entirely rather than multiply by a 1.0 it
/// computed).
///
/// **This is the timeline→media half of D-149, which is why it is app-side.**
/// [`DuckEnvelope`] is seconds, like [`FadeEnvelope`] and
/// [`AudioSourceSpec`]'s `start_secs`/`duration_secs` beside it. "Which frames
/// does the dialogue track have clips on" is not: answering it needs a
/// `apelles_timeline::Timeline`, and a media crate reaching for one would be
/// reaching *up* a layer (D-039/D-146 — the same rule that kept
/// [`chroma_audio_play`]'s body here at all). So the app resolves the trigger
/// track's layout and converts frames → session-relative seconds; the crate
/// owns the smoother and the dB conversion.
///
/// **Which fps does the conversion.** `info` is the *ducked* clip's own probed
/// [`super::video::VideoInfo`] — the same one that produced this source's
/// `start_secs`/`duration_secs` a few lines up, so the trigger spans land in
/// exactly the seconds base the envelope is evaluated in. That inherits the
/// model's existing "a clip's source fps is the timeline's fps" assumption
/// (B-048/D-130, and [`fade_for_clip`] below) rather than introducing a second
/// one — and it is the assumption to revisit first if a real mixed-fps timeline
/// ever makes a duck land early or late.
///
/// Spans are made **session-relative** by subtracting the playhead: a trigger
/// clip already under the playhead comes back with a negative start, which
/// [`DuckEnvelope::new`] clips to `0.0` and reads as "already ducked when Play
/// was pressed."
fn duck_for_track(
    track_index: usize,
    start_frame: u64,
    info: &super::video::VideoInfo,
) -> Result<Option<DuckEnvelope>, String> {
    let Some((duck_db, attack_ms, release_ms, spans)) =
        super::edit::resolve_track_duck(track_index, start_frame)?
    else {
        return Ok(None);
    };
    let secs = |frames: i64| info.frame_to_secs(frames.max(0) as u64);
    let spans_secs: Vec<(f64, f64)> = spans
        .iter()
        .map(|&(s, e)| {
            (
                secs(s) - secs(start_frame as i64),
                secs(e) - secs(start_frame as i64),
            )
        })
        .collect();
    Ok(DuckEnvelope::new(
        &spans_secs,
        duck_db,
        attack_ms,
        release_ms,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::thread;
    use std::time::Duration;

    // D-146 — the transport-ordering tests below drive the real commands, so
    // they stayed here when the engine moved; these three are
    // `apelles-media`'s `test-support` hooks onto the session state they
    // assert on (see that crate's README for why a feature, not a bare `pub`).
    use apelles_media::audio::waveform_peaks;
    use apelles_media::audio::{
        session_begin_request as begin_request, session_is_current as is_current, session_snapshot,
    };

    /// A process-wide monotonic stamp for tests, standing in for the
    /// frontend's `nextAudioSeq()`. `SESSION` is one `Lazy` static shared by
    /// every `#[test]` in this binary, so a per-test counter starting at 1
    /// would be rejected as stale by whatever ran before it; this mirrors the
    /// real frontend's own "seeded well above anything already accepted"
    /// property.
    fn next_test_seq() -> u64 {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    }

    /// `SESSION` (and, for the integration tests, `state::SESSION`'s open
    /// project) is one process-global shared by every `#[test]` in this
    /// binary, which `cargo test` runs in parallel threads. Any test that
    /// starts, stops or asserts on a playback session takes this first, so two
    /// of them can never interleave their generation bumps — the same class of
    /// cross-test interference B-038 documents for `chroma::export`/`relight`,
    /// avoided here rather than discovered later.
    ///
    /// **B-107 — this is the SHARED `PROJECT_STATE_LOCK`, not a private mutex
    /// of its own.** It used to be `static LOCK: Mutex<()>` local to this
    /// function, which serialised these tests against *each other* and against
    /// nothing else. But the global they actually contend over is
    /// `state::SESSION`'s open project, and the tests in `chroma::edit`,
    /// `chroma::project` and `chroma::state` guard that with
    /// `PROJECT_STATE_LOCK`. Two different mutexes over one global is not
    /// mutual exclusion: several tests here call `state::set_project(None)` on
    /// their way out, which would land in the middle of an
    /// `edit::preview_adjustment_tests` body that was holding the *other* lock
    /// and had opened its own project, so its next `timeline_frame` panicked
    /// with "no project open". One lock, one global.
    ///
    /// It costs some test parallelism (these now serialise against every
    /// project-state test in the binary, not just each other) and that is the
    /// right trade: `PROJECT_STATE_LOCK` is the codebase's existing, documented
    /// answer for exactly this class (B-105), and a second lock beside it is
    /// the thing that was wrong.
    fn session_test_guard() -> std::sync::MutexGuard<'static, ()> {
        super::super::PROJECT_STATE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    // --- D-147: clip fades → the mixer's envelope ------------------------ //
    //
    // The timeline→media conversion is what lives here, so it is what is
    // tested here. The envelope's own arithmetic (`apply` — the
    // per-sample-frame ramp, the cross-chunk continuation, the untouched
    // no-envelope buffer) is `apelles-media`'s and is tested in that crate's
    // `audio::tests`.

    /// A 25 fps `VideoInfo` with an audio stream — enough for
    /// [`fade_for_clip`], whose only use of one is the frames→seconds
    /// conversion.
    fn info_25fps() -> super::super::video::VideoInfo {
        super::super::video::VideoInfo {
            resolution: apelles_types::Resolution {
                width: 1920,
                height: 1080,
            },
            fps_num: 25,
            fps_den: 1,
            duration_secs: 10.0,
            frame_count: 250,
            codec: "h264".into(),
            pix_fmt: "yuv420p".into(),
            color_primaries: String::new(),
            color_transfer: String::new(),
            color_space: String::new(),
            has_audio: true,
            audio_sample_rate: 48_000,
            audio_channels: 2,
        }
    }

    fn clip_with_fade(duration: i64, fade_in: i64, fade_out: i64) -> apelles_timeline::Clip {
        apelles_timeline::Clip {
            duration,
            source_len: duration,
            fade_in_frames: fade_in,
            fade_out_frames: fade_out,
            ..Default::default()
        }
    }

    /// **The backward-compatibility case for the mixer.** A clip with no fade
    /// gets NO envelope at all — not an envelope that happens to return 1.0 —
    /// so `apelles-media`'s `mix_chunk` skips the per-sample pass entirely and
    /// the mix runs exactly the arithmetic it ran before D-147.
    #[test]
    fn a_clip_with_no_fade_gets_no_envelope_at_all() {
        let info = info_25fps();
        assert!(fade_for_clip(&clip_with_fade(100, 0, 0), &info, 0).is_none());
        // a negative / nonsense value is "no fade" too, not an envelope
        assert!(fade_for_clip(&clip_with_fade(100, -5, 0), &info, 0).is_none());
        // …and one real fade window IS enough to get one
        assert!(fade_for_clip(&clip_with_fade(100, 25, 0), &info, 0).is_some());
    }

    /// Frames convert to seconds through the clip's own fps: at 25 fps a
    /// 25-frame fade is exactly one second.
    #[test]
    fn fade_for_clip_converts_frames_to_seconds_at_the_clips_own_fps() {
        let env = fade_for_clip(&clip_with_fade(250, 25, 50), &info_25fps(), 0).unwrap();
        assert!((env.len_secs - 10.0).abs() < 1e-9);
        assert!((env.fade_in_secs - 1.0).abs() < 1e-9);
        assert!((env.fade_out_secs - 2.0).abs() < 1e-9);
        assert_eq!(env.offset_secs, 0.0);
    }

    /// **Full fade to silence at the boundary**, through a real envelope built
    /// from a real clip rather than only the pure curve math: the very first
    /// sample of a fade-in is exactly silent, and so is the out-point.
    #[test]
    fn the_envelope_is_exactly_silent_at_both_fade_boundaries() {
        let env = fade_for_clip(&clip_with_fade(250, 25, 25), &info_25fps(), 0).unwrap();
        assert_eq!(env.gain_at(0.0), 0.0);
        assert_eq!(env.gain_at(10.0), 0.0); // the out-point, 10 s in
        assert!(
            (env.gain_at(5.0) - 1.0).abs() < 1e-6,
            "unity well clear of both windows"
        );
    }

    /// Starting playback mid-clip starts part-way down the ramp, not at the
    /// top of it — what `offset_secs` exists for. 12 frames into a 25-frame
    /// (1 s) linear fade-in is gain 0.48 at the session's very first sample.
    #[test]
    fn a_mid_fade_play_starts_part_way_down_the_ramp() {
        let env = fade_for_clip(&clip_with_fade(250, 25, 0), &info_25fps(), 12).unwrap();
        assert!(
            (env.gain_at(0.0) - 0.48).abs() < 1e-6,
            "got {}",
            env.gain_at(0.0)
        );
    }

    // --- D-223: per-clip volume/pan → the mixer's level envelope ---------- //
    //
    // The timeline→media half is what lives here: a clip's static fields and
    // its `chroma_keyframes` turned into clip-local seconds. The pan law, the
    // per-channel application and the interpolation itself are
    // `apelles-media`'s / `apelles-types`' and are tested there.

    fn clip_with_level(volume: f64, pan: f64) -> apelles_timeline::Clip {
        apelles_timeline::Clip {
            duration: 250,
            source_len: 250,
            volume,
            pan,
            ..Default::default()
        }
    }

    /// **The backward-compatibility case for the mixer.** A clip at unity and
    /// centred gets NO envelope at all — not one that happens to return 1.0 —
    /// so `mix_chunk` skips the per-sample pass and the mix runs exactly the
    /// arithmetic it ran before D-223. The same property `fade_for_clip`'s own
    /// first test pins, for the same reason.
    #[test]
    fn a_clip_at_unity_and_centre_gets_no_level_envelope_at_all() {
        let info = info_25fps();
        assert!(level_for_clip(&clip_with_level(1.0, 0.0), &info, 0).is_none());
        // …and either field alone is enough to get one
        assert!(level_for_clip(&clip_with_level(0.5, 0.0), &info, 0).is_some());
        assert!(level_for_clip(&clip_with_level(1.0, -1.0), &info, 0).is_some());
    }

    /// A static level resolves to exactly the clip's own numbers, through the
    /// real pan law — hard left is `(√2, 0)`, so the right channel is silent
    /// and the left is boosted (the 0 dB-centre normalisation).
    #[test]
    fn a_static_level_resolves_to_the_clips_own_volume_and_pan() {
        let env = level_for_clip(&clip_with_level(0.5, -1.0), &info_25fps(), 0).unwrap();
        let (vol, l, r) = env.gains_at(3.0);
        assert!((vol - 0.5).abs() < 1e-6, "{vol}");
        assert!((l - std::f32::consts::SQRT_2).abs() < 1e-6, "{l}");
        assert_eq!(r, 0.0);
    }

    /// A **keyframed** volume becomes a real automation curve in the mixer's
    /// own clip-local seconds — the keys are SOURCE frames, converted at the
    /// clip's own fps and rebased on its `source_start` (25 fps here, so
    /// source frame 25 is 1 s into a clip starting at source frame 0).
    #[test]
    fn keyframed_volume_becomes_a_clip_local_seconds_curve() {
        let clip = apelles_timeline::Clip {
            chroma_keyframes: Some(serde_json::json!([
                { "frame": 0, "params": { "volume": 0.0 } },
                { "frame": 50, "params": { "volume": 1.0 } },
            ])),
            ..clip_with_level(1.0, 0.0)
        };
        let env = level_for_clip(&clip, &info_25fps(), 0).expect("a keyed volume is a real level");
        assert_eq!(env.gains_at(0.0).0, 0.0);
        assert!(
            (env.gains_at(1.0).0 - 0.5).abs() < 1e-6,
            "midpoint of the ramp"
        );
        assert_eq!(env.gains_at(2.0).0, 1.0);
        assert_eq!(env.gains_at(9.0).0, 1.0, "held past the last key");
    }

    /// Keys are rebased on the clip's own `source_start`, exactly as
    /// `resolve_clip_transform` reads them for the picture — a trimmed clip's
    /// automation must not slide by the trim amount.
    #[test]
    fn keyframe_times_are_rebased_on_the_clips_source_start() {
        let clip = apelles_timeline::Clip {
            source_start: 25, // 1 s into the source at 25 fps
            chroma_keyframes: Some(serde_json::json!([
                { "frame": 25, "params": { "volume": 0.0 } },
                { "frame": 75, "params": { "volume": 1.0 } },
            ])),
            ..clip_with_level(1.0, 0.0)
        };
        let env = level_for_clip(&clip, &info_25fps(), 0).expect("a keyed volume is a real level");
        // The first key sits at the clip's own in-point, i.e. clip second 0.
        assert_eq!(env.gains_at(0.0).0, 0.0);
        assert!((env.gains_at(1.0).0 - 0.5).abs() < 1e-6);
    }

    /// A keyframe naming only ONE of the two params leaves the other on its
    /// static field — `interpolate_param`'s own "only the keys that define
    /// this param take part" rule, which is what makes per-property keyframing
    /// work at all (B-094).
    #[test]
    fn a_key_naming_only_pan_leaves_volume_on_its_static_field() {
        let clip = apelles_timeline::Clip {
            chroma_keyframes: Some(serde_json::json!([
                { "frame": 0, "params": { "pan": -1.0 } },
                { "frame": 50, "params": { "pan": 1.0 } },
            ])),
            ..clip_with_level(0.25, 0.0)
        };
        let env = level_for_clip(&clip, &info_25fps(), 0).unwrap();
        for t in [0.0, 1.0, 2.0] {
            assert!((env.gains_at(t).0 - 0.25).abs() < 1e-6, "volume at {t}");
        }
        // …and the pan really sweeps: silent right at the start, silent left
        // at the end.
        assert_eq!(env.gains_at(0.0).2, 0.0);
        assert_eq!(env.gains_at(2.0).1, 0.0);
    }

    /// Keys that are all the identity are not an envelope — an agent that
    /// keyed volume at 1.0 twice changed nothing, and must not cost the mixer
    /// its fast path. (The check itself is `LevelEnvelope::new`'s; this pins
    /// that the app-side builder really routes through it.)
    #[test]
    fn keyframes_that_are_all_identity_still_produce_no_envelope() {
        let clip = apelles_timeline::Clip {
            chroma_keyframes: Some(serde_json::json!([
                { "frame": 0, "params": { "volume": 1.0, "pan": 0.0 } },
                { "frame": 50, "params": { "volume": 1.0, "pan": 0.0 } },
            ])),
            ..clip_with_level(1.0, 0.0)
        };
        assert!(level_for_clip(&clip, &info_25fps(), 0).is_none());
    }

    /// Starting playback mid-clip starts part-way along the automation, not at
    /// its beginning — what `offset_secs` is for, the same property
    /// `a_mid_fade_play_starts_part_way_down_the_ramp` pins for a fade.
    #[test]
    fn a_mid_ramp_play_starts_part_way_along_the_automation() {
        let clip = apelles_timeline::Clip {
            chroma_keyframes: Some(serde_json::json!([
                { "frame": 0, "params": { "volume": 0.0 } },
                { "frame": 50, "params": { "volume": 1.0 } },
            ])),
            ..clip_with_level(1.0, 0.0)
        };
        // 25 frames = 1 s into a 2 s ramp.
        let env = level_for_clip(&clip, &info_25fps(), 25).unwrap();
        assert!(
            (env.gains_at(0.0).0 - 0.5).abs() < 1e-6,
            "{}",
            env.gains_at(0.0).0
        );
    }

    // --- D-149: track ducking → the mixer's envelope ---------------------- //
    //
    // The timeline→media half is what lives here: resolving `duck_from` to a
    // real trigger track, its clip layout to session-relative seconds, and the
    // whole thing to `None` when it can't apply. The smoother's own arithmetic
    // (the one-pole closed form, attack-vs-release, fade×duck composition) is
    // `apelles-media`'s and is tested in that crate's `audio::tests`.

    /// A three-track project on disk and made active: V0 (a video clip), A1 (a
    /// music bed, the track that gets ducked, configured by `duck`) and A2 (the
    /// dialogue/trigger track, holding `trigger_spans` in timeline frames).
    /// `duck` is `(duck_from, duck_db, attack_ms, release_ms)`.
    ///
    /// The returned `TempDir` must be kept alive for the project directory to
    /// stay on disk; the caller is responsible for `state::set_project(None)`.
    fn open_duck_test_project(
        duck: Option<(usize, f32, f32, f32)>,
        trigger_spans: &[(i64, i64)],
    ) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().expect("tempdir");
        let project_dir = tmp.path().join("DuckTest.chroma");
        std::fs::create_dir_all(&project_dir).expect("mkdir project dir");

        let clip = |id: &str, path: &str, start: i64, len: i64| apelles_timeline::Clip {
            id: id.into(),
            name: id.into(),
            source_path: path.to_string(),
            source_start: 0,
            duration: len,
            source_len: len,
            start_frame: start,
            ..Default::default()
        };
        let mut bed = apelles_timeline::Track {
            kind: apelles_timeline::TrackKind::Audio,
            clips: vec![clip("bed", "/bed.m4a", 0, 250)],
            ..Default::default()
        };
        if let Some((from, db, attack, release)) = duck {
            bed.duck_from = Some(from);
            bed.duck_db = db;
            bed.duck_attack_ms = attack;
            bed.duck_release_ms = release;
        }
        let timeline = apelles_timeline::Timeline {
            id: "tl1".into(),
            name: "DuckTest".into(),
            rate: None,
            tracks: vec![
                apelles_timeline::Track {
                    kind: apelles_timeline::TrackKind::Video,
                    clips: vec![clip("vid", "/vid.mov", 0, 250)],
                    ..Default::default()
                },
                bed,
                apelles_timeline::Track {
                    kind: apelles_timeline::TrackKind::Audio,
                    clips: trigger_spans
                        .iter()
                        .enumerate()
                        .map(|(i, &(s, e))| clip(&format!("vo{i}"), "/vo.m4a", s, e - s))
                        .collect(),
                    ..Default::default()
                },
            ],
            markers: Vec::new(),
        };
        let manifest = super::super::project::ProjectManifest {
            schema: "chroma.project/1".into(),
            name: "DuckTest".into(),
            created: String::new(),
            modified: String::new(),
            shots: Vec::new(),
            active_shot: 0,
            active_clip_id: None,
            settings: Default::default(),
            timelines: vec![timeline],
            active_timeline: 0,
            media: Vec::new(),
            folders: Vec::new(),
        };
        super::super::project::save_manifest(&project_dir, &manifest).expect("save manifest");
        super::super::state::set_project(Some(super::super::state::ProjectRef {
            path: project_dir,
            name: "DuckTest".into(),
        }));
        tmp
    }

    /// **The backward-compatibility case for the mixer, D-149's half.** A track
    /// with no `duck_from` — every track in every pre-D-149 project — gets NO
    /// envelope at all, not one that happens to return 1.0, so `mix_chunk`
    /// skips the per-sample pass and the mix runs exactly the arithmetic it ran
    /// before this feature existed.
    #[test]
    fn a_track_with_no_duck_configured_gets_no_envelope_at_all() {
        let _guard = session_test_guard();
        let _project = open_duck_test_project(None, &[(50, 75)]);
        let got = duck_for_track(1, 0, &info_25fps()).expect("resolves");
        super::super::state::set_project(None);
        assert!(got.is_none(), "no duck_from must mean no envelope");
    }

    /// **A real duck, end to end from the timeline.** A 25 fps trigger clip at
    /// frames [50, 75) is seconds [2, 3) of the session, so the bed is unity
    /// before it, at the full −12 dB reduction inside it, and recovered after.
    #[test]
    fn a_configured_duck_reduces_gain_exactly_under_the_trigger_clip() {
        let _guard = session_test_guard();
        // attack/release deliberately fast (10 ms) so "settled" is unambiguous
        // at the sample points below; the smoothing itself is tested for real
        // in `apelles-media`.
        let _project = open_duck_test_project(Some((2, -12.0, 10.0, 10.0)), &[(50, 75)]);
        let env = duck_for_track(1, 0, &info_25fps())
            .expect("resolves")
            .expect("a real duck");
        super::super::state::set_project(None);

        assert!((env.gain_at(0.0) - 1.0).abs() < 1e-6, "unity before the VO");
        assert!(
            (env.gain_at(1.9) - 1.0).abs() < 1e-6,
            "still unity just before"
        );
        assert!(
            (env.gain_at(2.9) - 0.251_189).abs() < 1e-4,
            "−12 dB under the VO, got {}",
            env.gain_at(2.9)
        );
        assert!(
            (env.gain_at(4.0) - 1.0).abs() < 1e-4,
            "recovered after it, got {}",
            env.gain_at(4.0)
        );
    }

    /// Frames convert to seconds at the clip's own fps, and a mid-clip Play
    /// makes the spans session-relative: starting at frame 50 (2 s in) puts the
    /// trigger's own start at session second 0, i.e. already ducked.
    #[test]
    fn duck_spans_are_session_relative_so_a_mid_trigger_play_starts_ducked() {
        let _guard = session_test_guard();
        let _project = open_duck_test_project(Some((2, -12.0, 10.0, 300.0)), &[(50, 75)]);
        let env = duck_for_track(1, 50, &info_25fps())
            .expect("resolves")
            .expect("a real duck");
        super::super::state::set_project(None);
        assert!(
            (env.gain_at(0.0) - 0.251_189).abs() < 1e-5,
            "Play pressed mid-VO starts fully ducked, not ramping in: {}",
            env.gain_at(0.0)
        );
    }

    /// Every way a duck can be configured-but-inert resolves to `None` rather
    /// than to an envelope. The self-reference is the one worth having a test
    /// for: it is reachable just by removing a track above the pair, and a
    /// track ducking on its own clips would attenuate exactly the audio it is
    /// triggered by.
    #[test]
    fn an_unresolvable_or_self_referencing_duck_is_none() {
        let _guard = session_test_guard();
        let info = info_25fps();

        let _p1 = open_duck_test_project(Some((1, -12.0, 10.0, 300.0)), &[(50, 75)]);
        let self_ref = duck_for_track(1, 0, &info).expect("resolves");
        super::super::state::set_project(None);
        assert!(self_ref.is_none(), "a track cannot duck from itself");

        let _p2 = open_duck_test_project(Some((99, -12.0, 10.0, 300.0)), &[(50, 75)]);
        let missing = duck_for_track(1, 0, &info).expect("resolves");
        super::super::state::set_project(None);
        assert!(missing.is_none(), "a duck_from naming no real track");

        let _p3 = open_duck_test_project(Some((2, 0.0, 10.0, 300.0)), &[(50, 75)]);
        let unity = duck_for_track(1, 0, &info).expect("resolves");
        super::super::state::set_project(None);
        assert!(unity.is_none(), "0 dB changes nothing");

        let _p4 = open_duck_test_project(Some((2, -12.0, 10.0, 300.0)), &[]);
        let silent = duck_for_track(1, 0, &info).expect("resolves");
        super::super::state::set_project(None);
        assert!(silent.is_none(), "an empty trigger track never triggers");

        let _p5 = open_duck_test_project(Some((2, -12.0, 10.0, 300.0)), &[(50, 75)]);
        let past = duck_for_track(1, 200, &info).expect("resolves");
        super::super::state::set_project(None);
        assert!(past.is_none(), "every trigger clip is behind the playhead");
    }

    /// Two abutting trigger clips reach the envelope as ONE span — the merge is
    /// `Track::clip_spans_from`'s, and this is the check that it survives the
    /// frames→seconds conversion rather than being undone by it. Without it the
    /// duck would release and re-attack at the seam between two dialogue takes.
    #[test]
    fn abutting_trigger_clips_hold_the_duck_across_the_cut() {
        let _guard = session_test_guard();
        let _project =
            open_duck_test_project(Some((2, -12.0, 10.0, 300.0)), &[(50, 75), (75, 100)]);
        let env = duck_for_track(1, 0, &info_25fps())
            .expect("resolves")
            .expect("a real duck");
        super::super::state::set_project(None);
        // The seam is frame 75 = session second 3.0.
        assert!(
            (env.presence_at(3.0) - 1.0).abs() < 1e-6,
            "the duck must hold across the cut, got presence {}",
            env.presence_at(3.0)
        );
    }

    /// D-280 — the transport must survive a malformed rate rather than refuse
    /// to play. Pure arithmetic with a real correct answer, so it is tested
    /// rather than reasoned about.
    #[test]
    fn playback_rate_is_clamped_not_rejected() {
        assert_eq!(clamp_playback_rate(1.0), 1.0);
        assert_eq!(clamp_playback_rate(3.0), 3.0);
        assert_eq!(clamp_playback_rate(PLAYBACK_RATE_MAX), PLAYBACK_RATE_MAX);
        assert_eq!(clamp_playback_rate(1000.0), PLAYBACK_RATE_MAX);
        assert_eq!(clamp_playback_rate(0.01), PLAYBACK_RATE_MIN);
        // Nonsense reads as ordinary playback, never as an error or as silence.
        assert_eq!(clamp_playback_rate(0.0), 1.0);
        assert_eq!(clamp_playback_rate(-2.0), 1.0);
        assert_eq!(clamp_playback_rate(f64::NAN), 1.0);
        assert_eq!(clamp_playback_rate(f64::INFINITY), 1.0);
    }

    #[test]
    fn generation_bump_invalidates_a_session() {
        let _guard = session_test_guard();
        // begin_request with nothing running just advances the counter and is
        // safe to call repeatedly (mirrors chroma_audio_stop being called on
        // an already-silent preview / on unmount).
        let g1 = begin_request(next_test_seq()).expect("fresh seq is accepted");
        let g2 = begin_request(next_test_seq()).expect("fresh seq is accepted");
        assert!(g2 > g1);
        assert!(!is_current(g1));
        assert!(is_current(g2));
    }

    // ------------------------------------------------------------------ //
    // B-047 / D-130 — request ordering. `chroma_audio_play`/`_stop` are
    // `(async)` Tauri commands since D-125, so two invokes become two
    // independently scheduled `tokio::spawn`ed tasks: they can run
    // concurrently and in either order. These assert the protocol survives
    // that, which before D-130 it did not — a stop that lost the race landed
    // on the session that had already superseded it (silence), and a play
    // that lost the race won the generation with an out-of-date `start_frame`
    // (the audio replaying a stretch the picture had already gone past —
    // "the voice is overlapping / just loops").
    // ------------------------------------------------------------------ //

    #[test]
    fn a_stale_stop_cannot_kill_the_play_that_superseded_it() {
        let _guard = session_test_guard();
        let newer = next_test_seq();
        let older = newer - 1; // issued first, but reaches the runtime second

        let gen_after_play = begin_request(newer).expect("the newer request is accepted");
        chroma_audio_stop(older);

        let (generation, last_seq) = session_snapshot();
        assert_eq!(
            generation, gen_after_play,
            "a stale stop must not bump the generation — bumping it is exactly what tore down \
             the session the frontend had just asked for"
        );
        assert_eq!(last_seq, newer, "the newest accepted stamp still stands");
        assert!(
            is_current(gen_after_play),
            "the superseding session is still the live one"
        );
    }

    #[test]
    fn a_stale_play_cannot_supersede_a_newer_request() {
        let _guard = session_test_guard();
        let newer = next_test_seq();
        let older = newer - 1;

        let gen_after_newer = begin_request(newer).expect("the newer request is accepted");
        // No project is open, so this would return Ok(()) either way — what is
        // under test is that it never gets as far as claiming the session.
        let stale = chroma_audio_play(0, older, 1.0);

        assert!(stale.is_ok(), "a dropped stale play is not an error");
        let (generation, last_seq) = session_snapshot();
        assert_eq!(
            generation, gen_after_newer,
            "a stale play must not claim the session — claiming it is what made playback \
             restart from an out-of-date playhead"
        );
        assert_eq!(last_seq, newer);
    }

    #[test]
    fn a_newer_stop_does_stop_a_running_session() {
        let _guard = session_test_guard();
        // The other half of the contract: ordering is enforced, not "stops are
        // ignored". A stop genuinely newer than the running session's request
        // still tears it down.
        let gen_after_play = begin_request(next_test_seq()).expect("accepted");
        chroma_audio_stop(next_test_seq());
        assert!(
            !is_current(gen_after_play),
            "a newer stop must still invalidate the running session"
        );
    }

    #[test]
    fn concurrent_out_of_order_requests_leave_exactly_the_newest_in_charge() {
        let _guard = session_test_guard();
        // The real shape of the race: N transport commands, stamped in issue
        // order, handed to threads that start in an arbitrary order — which is
        // exactly what `tokio::spawn` does with them. Whatever the interleaving,
        // the highest stamp must be the one holding the session at the end.
        let base = next_test_seq();
        for _ in 0..7 {
            next_test_seq(); // reserve the stamps this round hands out
        }
        let stamps: Vec<u64> = (base..base + 8).collect();
        let newest = *stamps.last().expect("non-empty");

        let mut handles = Vec::new();
        for (i, seq) in stamps.iter().copied().enumerate() {
            handles.push(thread::spawn(move || {
                // Stagger nothing deliberately — let the OS interleave these
                // however it likes, including newest-first.
                if i % 2 == 0 {
                    let _ = chroma_audio_play(0, seq, 1.0);
                } else {
                    chroma_audio_stop(seq);
                }
            }));
        }
        for h in handles {
            let _ = h.join();
        }

        let (_, last_seq) = session_snapshot();
        assert_eq!(
            last_seq, newest,
            "the newest request must own the session no matter which order the tasks ran in"
        );
    }

    /// Build a throwaway one-clip-video-track `.chroma` project on disk
    /// pointing at `video_path`, and make it the open project via
    /// `state::set_project` — no Tauri runtime needed, since none of these
    /// commands take a `tauri::State`. The returned `TempDir` must be kept
    /// alive for the project directory to stay on disk; the caller is
    /// responsible for `state::set_project(None)` once done.
    fn open_test_project(video_path: &str) -> tempfile::TempDir {
        open_test_project_with_audio_track(video_path, None)
    }

    /// D-057: [`open_test_project`], optionally with a second, genuine
    /// `TrackKind::Audio` track added — `(audio_clip_source_path, gain)` —
    /// holding one clip at `start_frame: 0` covering the same position the
    /// tests below play from. This is the real fixture Phase C's own test
    /// requirement asks for: "a `Timeline` with a video track (embedded
    /// audio) + a genuine `TrackKind::Audio` track holding a real
    /// audio-bearing clip."
    fn open_test_project_with_audio_track(
        video_path: &str,
        audio_track: Option<(&str, f32)>,
    ) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().expect("tempdir");
        let project_dir = tmp.path().join("AudioTest.chroma");
        std::fs::create_dir_all(&project_dir).expect("mkdir project dir");

        let clip = apelles_timeline::Clip {
            id: "clip1".into(),
            shot_id: None,
            media_id: None,
            name: "test".into(),
            source_path: video_path.to_string(),
            source_start: 0,
            duration: 100_000, // longer than any real test clip; exact value is irrelevant here
            source_len: 100_000,
            start_frame: 0, // D-054: the only clip on its track
            ..Default::default()
        };
        let mut tracks = vec![apelles_timeline::Track {
            kind: apelles_timeline::TrackKind::Video,
            clips: vec![clip],
            ..Default::default()
        }];
        if let Some((audio_path, gain)) = audio_track {
            tracks.push(apelles_timeline::Track {
                kind: apelles_timeline::TrackKind::Audio,
                clips: vec![apelles_timeline::Clip {
                    id: "audio-clip1".into(),
                    shot_id: None,
                    media_id: None,
                    name: "audio-track-test".into(),
                    source_path: audio_path.to_string(),
                    source_start: 0,
                    duration: 100_000,
                    source_len: 100_000,
                    start_frame: 0, // overlaps the video clip's [0, 100_000)
                    ..Default::default()
                }],
                gain,
                ..Default::default()
            });
        }
        let timeline = apelles_timeline::Timeline {
            id: "tl1".into(),
            name: "AudioTest".into(),
            rate: None,
            tracks,
            markers: Vec::new(),
        };
        let manifest = super::super::project::ProjectManifest {
            schema: "chroma.project/1".into(),
            name: "AudioTest".into(),
            created: String::new(),
            modified: String::new(),
            shots: Vec::new(),
            active_shot: 0,
            active_clip_id: None,
            settings: Default::default(),
            timelines: vec![timeline],
            active_timeline: 0,
            media: Vec::new(),
            folders: Vec::new(),
        };
        super::super::project::save_manifest(&project_dir, &manifest).expect("save manifest");
        super::super::state::set_project(Some(super::super::state::ProjectRef {
            path: project_dir,
            name: "AudioTest".into(),
        }));
        tmp
    }

    /// Synthesize a short pure-tone `.m4a` (AAC-in-MP4, matching this
    /// crate's `symphonia` feature set — `isomp4` + `aac`, no `wav`/`pcm`
    /// support enabled) via `ffmpeg`'s `sine` test source — a second,
    /// genuinely distinct real audio signal for the mixing tests below to
    /// sum against `CHROMA_TEST_AUDIO_VIDEO`'s content. `ffmpeg` is already a
    /// hard dependency of this repo's pipeline (`video.rs`'s own doc); there
    /// is no committed binary audio fixture in this repo (every existing
    /// audio/video test fixture is an env-var-gated real file, not something
    /// checked in — see D-050), so generating one at test time, into a
    /// tempdir, mirrors that same convention rather than adding a first
    /// binary fixture file to source control. `sample_rate` is passed
    /// explicitly so the synthesized tone can be made to match a real
    /// fixture's own rate (48 kHz for `CHROMA_TEST_AUDIO_VIDEO`, per D-050) —
    /// letting a test decode both through [`decode_mono_range`] and mix them
    /// sample-for-sample without needing `rubato` in the test itself.
    fn synth_test_tone(dir: &Path, freq_hz: u32, duration_secs: f64, sample_rate: u32) -> PathBuf {
        let out = dir.join("tone.m4a");
        let status = std::process::Command::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                &format!(
                    "sine=frequency={freq_hz}:duration={duration_secs}:sample_rate={sample_rate}"
                ),
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-ac",
                "2",
            ])
            .arg(&out)
            .status()
            .expect("spawn ffmpeg to synthesize a test tone");
        assert!(status.success(), "ffmpeg tone synthesis failed");
        out
    }

    // Integration test — only runs if CHROMA_TEST_AUDIO_VIDEO points at a real
    // file with an audio stream (this repo's own real project's one shot,
    // `pexels_28808272.mp4`, has none — see D-049, and the sibling test
    // below). Calls the real `chroma_audio_play` command exactly as
    // `PreviewPane.tsx` does, and asserts the `cpal` output callback actually
    // wrote non-silent PCM — the concrete D-049 verification proxy,
    // end-to-end through the real command surface rather than only the pure
    // helpers above.
    #[test]
    fn chroma_audio_play_produces_non_silent_pcm_end_to_end() {
        let _guard = session_test_guard();
        let Ok(video_path) = std::env::var("CHROMA_TEST_AUDIO_VIDEO") else {
            eprintln!(
                "skip: set CHROMA_TEST_AUDIO_VIDEO to run (a real file with an audio stream)"
            );
            return;
        };

        let _tmp = open_test_project(&video_path);
        let played = chroma_audio_play(0, next_test_seq(), 1.0);
        // B-106 — 2.5 s, not 1.5 s. `chroma_audio_level` refreshes only once per
        // second of audio the device has actually written, and a session's first
        // few hundred ms are device-open + seek, during which the ring is
        // legitimately silent. 1.5 s put that single refresh right on the
        // boundary, so this assertion could fail because the meter had not
        // ticked yet rather than because there was no sound — seen live,
        // intermittently, while adding D-232's own sibling test.
        thread::sleep(Duration::from_millis(2500));
        let (rms, peak) = chroma_audio_level();
        chroma_audio_stop(next_test_seq());
        super::super::state::set_project(None);

        played.expect("chroma_audio_play");
        eprintln!(
            "chroma_audio_play_produces_non_silent_pcm_end_to_end ({video_path}): rms={rms:.4} peak={peak:.4}"
        );
        assert!(
            peak > 0.001,
            "expected non-silent PCM out of the real cpal output stream after 1.5s of playback, got peak={peak}"
        );
    }

    /// D-280 — the "with audio" half, end to end, at a real non-1x rate.
    ///
    /// The owner's ask was explicitly that fast playback still *makes
    /// intelligible sound* rather than silence. This is the same D-049
    /// verification proxy as the test above — "did non-silent PCM reach the real
    /// device" — applied at 3x, which is the claim that could actually regress:
    /// a broken time-stretch stage would starve the ring and the meter would
    /// read zero. It cannot say the result sounds *good*; that is
    /// `apelles_media::timestretch`'s own pitch test (a 440 Hz tone still
    /// measures 440 Hz at 0.5x/2x/3x/4x) plus a human listening.
    #[test]
    fn chroma_audio_play_at_a_faster_rate_still_produces_non_silent_pcm() {
        let _guard = session_test_guard();
        let Ok(video_path) = std::env::var("CHROMA_TEST_AUDIO_VIDEO") else {
            eprintln!(
                "skip: set CHROMA_TEST_AUDIO_VIDEO to run (a real file with an audio stream)"
            );
            return;
        };

        let _tmp = open_test_project(&video_path);
        let played = chroma_audio_play(0, next_test_seq(), 3.0);
        // B-106's 2.5 s, for its own reason (the level meter refreshes once per
        // second of written audio) — unchanged by the rate, since that window is
        // real output time either way.
        thread::sleep(Duration::from_millis(2500));
        let (rms, peak) = chroma_audio_level();
        chroma_audio_stop(next_test_seq());
        super::super::state::set_project(None);

        played.expect("chroma_audio_play at 3x");
        eprintln!(
            "chroma_audio_play_at_a_faster_rate_still_produces_non_silent_pcm ({video_path}): rms={rms:.4} peak={peak:.4}"
        );
        assert!(
            peak > 0.001,
            "3x playback must still deliver audible PCM, not silence — got peak={peak}"
        );
    }

    // Integration test — only runs if CHROMA_TEST_SILENT_VIDEO points at a
    // real file confirmed (via `ffprobe`) to have NO audio stream — this
    // repo's own real project's shot (`pexels_28808272.mp4`) is exactly such
    // a file, found live while wiring up the sibling test above (see D-049).
    // A source with no audio must play back silently, without error — this
    // pins that "silent is correct, not a bug" behaviour.
    #[test]
    fn chroma_audio_play_on_a_source_with_no_audio_is_a_silent_no_op() {
        let _guard = session_test_guard();
        let Ok(video_path) = std::env::var("CHROMA_TEST_SILENT_VIDEO") else {
            eprintln!(
                "skip: set CHROMA_TEST_SILENT_VIDEO to run (a real file confirmed to have no audio stream)"
            );
            return;
        };

        let _tmp = open_test_project(&video_path);
        let played = chroma_audio_play(0, next_test_seq(), 1.0);
        thread::sleep(Duration::from_millis(300));
        let (rms, peak) = chroma_audio_level();
        chroma_audio_stop(next_test_seq());
        super::super::state::set_project(None);

        played.expect("chroma_audio_play should be Ok even when the source has no audio stream");
        assert_eq!(
            (rms, peak),
            (0.0, 0.0),
            "a source with no audio stream must not produce any device output"
        );
    }

    /// End-to-end through the real command surface (D-057): a genuine
    /// two-track `Timeline` — the video's embedded audio on the video track,
    /// plus a synthesized tone clip on a real `TrackKind::Audio` track
    /// (`Track::clip_at` resolving it via `resolve_audio_track_positions`,
    /// exactly what a future Phase D UI's "add an audio track" would
    /// eventually produce) — played through the real `chroma_audio_play`
    /// command, exactly as `PreviewPane.tsx` would call it. Proves the whole
    /// pipeline (timeline resolution → `run_session` opening 2 sources →
    /// real `cpal` output) actually engages for a multi-track project, using
    /// the same live-device rms/peak proxy D-050 introduced (a sandboxed
    /// agent can't literally listen — see that decision).
    #[test]
    fn chroma_audio_play_mixes_a_genuine_audio_track_with_the_video_track() {
        let _guard = session_test_guard();
        let Ok(video_path) = std::env::var("CHROMA_TEST_AUDIO_VIDEO") else {
            eprintln!(
                "skip: set CHROMA_TEST_AUDIO_VIDEO to run (a real file with an audio stream)"
            );
            return;
        };

        let tmp = tempfile::tempdir().expect("tempdir");
        let tone_path = synth_test_tone(tmp.path(), 440, 3.0, 48_000);

        let _project = open_test_project_with_audio_track(
            &video_path,
            Some((&tone_path.display().to_string(), 1.0)),
        );
        let played = chroma_audio_play(0, next_test_seq(), 1.0);
        // B-106 — 2.5 s, not 1.5 s. `chroma_audio_level` refreshes only once per
        // second of audio the device has actually written, and a session's first
        // few hundred ms are device-open + seek, during which the ring is
        // legitimately silent. 1.5 s put that single refresh right on the
        // boundary, so this assertion could fail because the meter had not
        // ticked yet rather than because there was no sound — seen live,
        // intermittently, while adding D-232's own sibling test.
        thread::sleep(Duration::from_millis(2500));
        let (rms, peak) = chroma_audio_level();
        chroma_audio_stop(next_test_seq());
        super::super::state::set_project(None);

        played.expect("chroma_audio_play with a video track + a genuine audio track");
        eprintln!(
            "chroma_audio_play_mixes_a_genuine_audio_track_with_the_video_track: rms={rms:.4} peak={peak:.4}"
        );
        assert!(
            peak > 0.001,
            "expected non-silent mixed PCM out of the real cpal output stream, got peak={peak}"
        );
    }

    /// The same two-track project as above, but the audio track's gain is
    /// `0.0` — end-to-end proof that `Track::gain` really reaches the mixer:
    /// still non-silent (the video's own audio still plays), but this is
    /// the live-device sibling of `real_decoded_sources_mix_and_mute_correctly`'s
    /// exact, deterministic version of the same property.
    #[test]
    fn chroma_audio_play_with_a_muted_audio_track_still_plays_the_video() {
        let _guard = session_test_guard();
        let Ok(video_path) = std::env::var("CHROMA_TEST_AUDIO_VIDEO") else {
            eprintln!(
                "skip: set CHROMA_TEST_AUDIO_VIDEO to run (a real file with an audio stream)"
            );
            return;
        };

        let tmp = tempfile::tempdir().expect("tempdir");
        let tone_path = synth_test_tone(tmp.path(), 440, 3.0, 48_000);

        let _project = open_test_project_with_audio_track(
            &video_path,
            Some((&tone_path.display().to_string(), 0.0)),
        );
        let played = chroma_audio_play(0, next_test_seq(), 1.0);
        // B-106 — 2.5 s, not 1.5 s. `chroma_audio_level` refreshes only once per
        // second of audio the device has actually written, and a session's first
        // few hundred ms are device-open + seek, during which the ring is
        // legitimately silent. 1.5 s put that single refresh right on the
        // boundary, so this assertion could fail because the meter had not
        // ticked yet rather than because there was no sound — seen live,
        // intermittently, while adding D-232's own sibling test.
        thread::sleep(Duration::from_millis(2500));
        let (_rms, peak) = chroma_audio_level();
        chroma_audio_stop(next_test_seq());
        super::super::state::set_project(None);

        played.expect("chroma_audio_play with a muted audio track");
        assert!(
            peak > 0.001,
            "the video's own audio must still play even with the audio track muted, got peak={peak}"
        );
    }

    // ------------------------------------------------------------------ //
    // D-232 — tape-style scrubbing. The design's load-bearing claim is that a
    // scrub is a THIRD request on the existing single transport rather than a
    // parallel subsystem, so the first two tests below assert exactly that
    // against the same session state the play/stop ordering tests above use.
    // The grain/window arithmetic itself is `apelles-media`'s and is unit-tested
    // in `scrub.rs`; what lives here is the command surface.
    // ------------------------------------------------------------------ //

    /// **B-110 — the level the frontend resolved must survive the command
    /// boundary.** Before this, `chroma_audio_scrub_*` took only a path and a
    /// source second, so every monitored source reached the engine at unity
    /// while `chroma_audio_play` mixed the same clip at its real `gain`. Pure —
    /// this is the conversion, not the device.
    #[test]
    fn a_scrub_source_carries_the_level_the_frontend_resolved() {
        let resolved =
            scrub_source(Some("/media/music.mp3".into()), 12.5, 0.4).expect("a real source");
        assert_eq!(resolved.path, PathBuf::from("/media/music.mp3"));
        assert_eq!(resolved.source_secs, 12.5);
        assert_eq!(resolved.gain, 0.4);
    }

    /// "Nothing audible here" is a `None`, not a source at gain zero — the two
    /// are different states to the engine (`None` clears the read head; a real
    /// source at zero keeps a decoded window open for silence).
    #[test]
    fn a_scrub_source_with_no_path_is_none_whatever_its_level() {
        assert!(scrub_source(None, 1.0, 0.4).is_none());
        assert!(scrub_source(Some(String::new()), 1.0, 0.4).is_none());
        assert!(
            scrub_source(Some("/a.mp3".into()), f64::NAN, 1.0).is_none(),
            "a non-finite position is not a position"
        );
    }

    /// **A scrub and playback cannot sound at once.** Starting a scrub claims
    /// the same generation a play would, so the running play session's thread
    /// sees itself superseded and exits — no second protocol, no new invariant.
    #[test]
    fn starting_a_scrub_supersedes_a_running_play_session() {
        let _guard = session_test_guard();
        let gen_after_play = begin_request(next_test_seq()).expect("accepted");
        chroma_audio_scrub_begin(None, 0.0, 1.0, next_test_seq()).expect("scrub begin");
        assert!(
            !is_current(gen_after_play),
            "a scrub must tear down the play session it started over"
        );
        chroma_audio_scrub_end(next_test_seq());
    }

    /// And the other direction, plus the ordering rule: a scrub command that a
    /// newer request has already overtaken is dropped, exactly like a stale
    /// play or stop (B-047 / D-130).
    #[test]
    fn a_stale_scrub_command_cannot_supersede_a_newer_request() {
        let _guard = session_test_guard();
        let newer = next_test_seq();
        let older = newer - 1; // issued first, reaches the runtime second

        let gen_after_newer = begin_request(newer).expect("the newer request is accepted");
        let stale = chroma_audio_scrub_begin(None, 0.0, 1.0, older);

        assert!(stale.is_ok(), "a dropped stale scrub is not an error");
        let (generation, last_seq) = session_snapshot();
        assert_eq!(
            generation, gen_after_newer,
            "a stale scrub must not claim the session"
        );
        assert_eq!(last_seq, newer);
        assert!(is_current(gen_after_newer));
    }

    /// A position update carries no `seq` and must never touch the transport —
    /// it is a level, not an edge (see `apelles_media::scrub::update`). If it
    /// bumped the generation it would kill the very scrub thread it is steering.
    #[test]
    fn a_scrub_position_update_never_touches_the_transport() {
        let _guard = session_test_guard();
        let mine = begin_request(next_test_seq()).expect("accepted");
        for secs in [0.0, 1.0, 2.5] {
            chroma_audio_scrub_update(Some("/fixture.m4a".into()), secs, 1.0);
        }
        assert!(
            is_current(mine),
            "steering a scrub must not supersede the session being steered"
        );
    }

    /// End-to-end through the real command surface: a real scrub gesture over a
    /// real file must produce non-silent PCM out of the actual `cpal` output
    /// stream — the same live-device rms/peak proxy D-049/D-050 introduced,
    /// which is the only thing a sandboxed agent can check about audio it
    /// cannot listen to. Gated on `CHROMA_TEST_AUDIO_VIDEO`, like its playback
    /// siblings; unlike them it needs no open project, because a scrub is
    /// handed a resolved source rather than resolving a timeline.
    #[test]
    fn chroma_audio_scrub_produces_non_silent_pcm_end_to_end() {
        let _guard = session_test_guard();
        let Ok(video_path) = std::env::var("CHROMA_TEST_AUDIO_VIDEO") else {
            eprintln!(
                "skip: set CHROMA_TEST_AUDIO_VIDEO to run (a real file with an audio stream)"
            );
            return;
        };

        chroma_audio_scrub_begin(Some(video_path.clone()), 0.5, 1.0, next_test_seq())
            .expect("chroma_audio_scrub_begin");
        // Drag the read head forward the way a real pointer would, so the run
        // covers both the in-window fast path and at least one re-anchor
        // (`WINDOW_SECS - PRE_ROLL_SECS` = 2.5 s of source, crossed twice here).
        //
        // 2.4 s of drag, deliberately generous: `chroma_audio_level` refreshes
        // only once per second of audio the device has actually written, and the
        // first ~250 ms of a scrub is device-open + first-window decode, during
        // which the ring is legitimately silent. A 1.2 s run put the single
        // refresh right on that boundary and made this test a coin flip — the
        // assertion has to fail because there is no sound, never because the
        // meter had not ticked yet.
        for step in 0..40 {
            chroma_audio_scrub_update(Some(video_path.clone()), 0.5 + step as f64 * 0.25, 1.0);
            thread::sleep(Duration::from_millis(60));
        }
        let (rms, peak) = chroma_audio_level();
        chroma_audio_scrub_end(next_test_seq());

        eprintln!(
            "chroma_audio_scrub_produces_non_silent_pcm_end_to_end ({video_path}): rms={rms:.4} peak={peak:.4}"
        );
        assert!(
            peak > 0.001,
            "expected non-silent PCM out of the real cpal output stream while scrubbing, got peak={peak}"
        );
    }

    /// A scrub with nothing under the playhead — a gap, or a source with no
    /// audio stream — is a silent no-op, not an error. The direct counterpart of
    /// `chroma_audio_play_on_a_source_with_no_audio_is_a_silent_no_op`.
    #[test]
    fn chroma_audio_scrub_over_a_source_with_no_audio_is_a_silent_no_op() {
        let _guard = session_test_guard();
        let Ok(video_path) = std::env::var("CHROMA_TEST_SILENT_VIDEO") else {
            eprintln!(
                "skip: set CHROMA_TEST_SILENT_VIDEO to run (a real file confirmed to have no audio stream)"
            );
            return;
        };

        chroma_audio_scrub_begin(Some(video_path.clone()), 0.5, 1.0, next_test_seq())
            .expect("a scrub over silent media is not an error");
        for step in 0..5 {
            chroma_audio_scrub_update(Some(video_path.clone()), 0.5 + step as f64 * 0.25, 1.0);
            thread::sleep(Duration::from_millis(60));
        }
        let (rms, peak) = chroma_audio_level();
        chroma_audio_scrub_end(next_test_seq());

        assert_eq!(
            (rms, peak),
            (0.0, 0.0),
            "a source with no audio stream must not produce any device output"
        );
    }

    // Integration test (D-051) — real symphonia decode + bucket reduction,
    // gated on the same CHROMA_TEST_AUDIO_VIDEO fixture the D-050 playback
    // test uses (a real file confirmed to have an audio stream).
    // `chroma_audio_waveform` takes a bare source path — no open project
    // needed, unlike `chroma_audio_play`.
    #[test]
    fn chroma_audio_waveform_returns_nonflat_peaks_for_a_real_file() {
        let Ok(video_path) = std::env::var("CHROMA_TEST_AUDIO_VIDEO") else {
            eprintln!(
                "skip: set CHROMA_TEST_AUDIO_VIDEO to run (a real file with an audio stream)"
            );
            return;
        };

        let peaks = waveform_peaks(&video_path, 0.0, 2.0, 100).expect("waveform_peaks");
        assert_eq!(peaks.len(), 100, "requested bucket count must be honoured");
        assert!(
            peaks.iter().any(|(lo, hi)| *hi > *lo || *hi != 0.0),
            "expected at least some non-silent peaks decoding 2s of {video_path}"
        );
    }

    // A source confirmed to have NO audio stream (CHROMA_TEST_SILENT_VIDEO,
    // same fixture the D-050 silent-playback test uses) must return an empty
    // peaks Vec, not an error — mirrors chroma_timeline_frame's blank-frame
    // "nothing to draw" contract.
    #[test]
    fn chroma_audio_waveform_on_a_silent_source_is_an_empty_ok() {
        let Ok(video_path) = std::env::var("CHROMA_TEST_SILENT_VIDEO") else {
            eprintln!(
                "skip: set CHROMA_TEST_SILENT_VIDEO to run (a real file confirmed to have no audio stream)"
            );
            return;
        };

        let peaks = waveform_peaks(&video_path, 0.0, 2.0, 100).expect("waveform_peaks");
        assert_eq!(peaks, Vec::new());
    }

    #[test]
    fn chroma_audio_waveform_zero_duration_or_buckets_is_an_empty_ok_without_touching_disk() {
        // a nonexistent path proves this returns early on the duration_secs/
        // buckets guard rather than attempting to open/probe it.
        assert_eq!(
            waveform_peaks("/nonexistent/path.mp4", 0.0, 0.0, 100).unwrap(),
            Vec::new()
        );
        assert_eq!(
            waveform_peaks("/nonexistent/path.mp4", 0.0, 2.0, 0).unwrap(),
            Vec::new()
        );
    }
}
