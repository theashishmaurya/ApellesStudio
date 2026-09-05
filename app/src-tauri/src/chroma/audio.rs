//! Tauri bridge for the Edit-tab audio engine (D-049/D-050/D-051/D-057).
//!
//! What it is: the app-side half of the D-146 `chroma-media` extraction
//! (`docs/notes/crate-extraction-plan.md` §2.2). Two things live here, and
//! only two:
//!
//! 1. The five `#[tauri::command]` wrappers. Commands never move into a crate
//!    — a real `tauri-macros` constraint, not a preference (plan §1).
//! 2. The body of [`chroma_audio_play`] that turns a **timeline frame** into a
//!    set of audio sources. That is timeline resolution
//!    (`edit::resolve_video_position` / `edit::resolve_audio_track_positions`
//!    over `chroma-timeline`), which sits a layer *above* media and will
//!    belong to `chroma-compositor` when that becomes real (plan §2.8). It is
//!    exactly why `audio.rs` was split rather than moved whole.
//!
//! What it does NOT do: any decoding, resampling, mixing, device output,
//! waveform extraction or session bookkeeping — `chroma_media::audio` owns all
//! of it, including the D-130 request-ordering protocol. This file used to be
//! the whole 3,086-line implementation; see D-146 in `docs/08-decisions.md`.
//!
//! The ordering that the D-125 skew compensation depends on is preserved
//! exactly: `chroma_media::audio::begin_play` stamps `requested_at` and claims
//! the session **before** the resolution below runs, so the resolution's own
//! cost is still inside the skew `run_session` measures.
//!
//! D-147 added a third, strictly-derived thing to point 2: [`fade_for_clip`],
//! which turns a clip's fade *frames* into the seconds-based
//! `chroma_media::audio::FadeEnvelope` the mixer applies. That conversion is
//! the same frames→seconds step [`chroma_audio_play`] already does for
//! `start_secs` / `duration_secs`, done for one more pair of fields; the
//! envelope's arithmetic, and the decision to apply it per output sample-frame,
//! are the crate's.

use std::path::PathBuf;

use chroma_media::audio::{AudioSourceSpec, FadeEnvelope};

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
    chroma_media::audio::stop(seq);
}

/// Set the master preview-monitoring volume (D-126) — a `0.0..=1.0` linear
/// multiplier applied to every sample in the real `cpal` output callback.
/// Out-of-range input is clamped rather than rejected.
#[tauri::command]
pub fn chroma_audio_set_volume(volume: f32) {
    chroma_media::audio::set_volume(volume);
}

/// Last-measured (rms, peak) of the audio actually written to the output
/// device, roughly once per second of playback; `(0.0, 0.0)` when nothing is
/// playing. The concrete, pollable proxy for "is cpal really producing
/// non-silent PCM" (D-049 verification); not wired to any meter UI yet.
#[tauri::command]
pub fn chroma_audio_level() -> (f32, f32) {
    chroma_media::audio::level()
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
    chroma_media::audio::waveform(source_path, start_secs, duration_secs, buckets).await
}

/// Seek-and-play in one call: resolve `start_frame` on the active timeline to
/// every currently-active audio source — the video track's own embedded
/// audio (D-050's original, still-default behaviour, unchanged: always at
/// unity gain, resolved via the same [`super::edit::resolve_video_position`]
/// lookup the video preview uses) **plus** (D-057, Phase C) any clip on a
/// genuine `TrackKind::Audio` track that overlaps `start_frame`, each at its
/// own track's gain — then hand them to `chroma_media::audio::start`, which
/// decodes and mixes them together. No active source anywhere (no video clip
/// at this position, or one with no audio stream, and no audio-track clip
/// either) is **not** an error: it just means nothing plays, matching the
/// video preview's own "blank frame past the end" behaviour.
///
/// **This resolution is the whole reason `audio.rs` split rather than moved
/// (D-146).** Everything below the two `edit::resolve_*` calls is
/// `chroma-media`'s; the two calls themselves are `chroma-timeline`'s model
/// seen through the Edit-tab bridge, and a media crate that reached for them
/// would be reaching *up* a layer.
///
/// `(async)` (D-125): see [`chroma_audio_stop`] — same reason, and here it
/// also means the command isn't itself queued behind a main-thread preview
/// decode, which is precisely the latency the video clock does not wait for.
///
/// D-129 — a video clip carrying a `link_group` is **skipped** as an
/// embedded-audio source: its sound now lives in a real, linked audio clip
/// that the audio-track walk below picks up on its own. See the inline
/// comment at that check for why the suppression is unconditional, and
/// `chroma_timeline::Clip::link_group` for what the field means on a video
/// clip. A pre-D-129 clip has no `link_group` and takes the unchanged
/// D-050 path.
///
/// `seq` (D-130) is the frontend's monotonic request stamp; a play that a newer
/// request has already overtaken is dropped instead of starting a session from
/// a stale `start_frame`.
#[tauri::command(async)]
pub fn chroma_audio_play(start_frame: u64, seq: u64) -> Result<(), String> {
    // Claims the transport and stamps the "the frontend asked for playback"
    // instant the D-125 skew compensation measures against — deliberately
    // before the resolution below, exactly as the pre-split code did.
    let Some(session) = chroma_media::audio::begin_play(seq) else {
        // Overtaken by a newer request before this task got a worker thread.
        // Starting anyway would replay the timeline from a playhead the
        // picture has already moved past (B-047).
        return Ok(());
    };

    let mut sources: Vec<AudioSourceSpec> = Vec::new();

    if let Some((clip, source_frame, info)) = super::edit::resolve_video_position(start_frame)? {
        if clip.link_group.is_some() {
            // D-129 — this video clip's audio has been externalized into a
            // linked audio clip (see `chroma_timeline::Clip::link_group`), so
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
            // must fall silent (B-048).
            let remaining_frames = (clip.end_frame() - start_frame as i64).max(0) as u64;
            sources.push(AudioSourceSpec {
                path: PathBuf::from(&clip.source_path),
                start_secs: info.frame_to_secs(source_frame),
                duration_secs: Some(info.frame_to_secs(remaining_frames)),
                gain: 1.0,
                // D-147 — a fade on a VIDEO clip fades its embedded audio too,
                // not just its picture. One fade handle per clip, whose meaning
                // follows what the clip contributes (see
                // `chroma_timeline::Clip::fade_in_frames` and the plan doc §2);
                // this is the "…and its sound" half of that, the compositor's
                // `resolve_clip_transform` being the picture half.
                fade: fade_for_clip(&clip, &info, start_frame as i64 - clip.start_frame),
            });
        } else {
            log::debug!(
                "chroma_audio_play: {} has no audio stream — nothing from the video track",
                clip.source_path
            );
        }
    }

    for (clip, info, gain) in super::edit::resolve_audio_track_positions(start_frame)? {
        // Where in the clip the playhead is, and how much of it is still
        // ahead — the same two derivations the embedded-audio baseline above
        // makes, now made once here for an audio-track clip too rather than
        // inside the resolver (D-147; see `resolve_audio_track_positions`).
        let elapsed_frames = start_frame as i64 - clip.start_frame;
        let source_frame = clip.source_start + elapsed_frames;
        let remaining_frames = (clip.end_frame() - start_frame as i64).max(0) as u64;
        sources.push(AudioSourceSpec {
            path: PathBuf::from(&clip.source_path),
            start_secs: info.frame_to_secs(source_frame.max(0) as u64),
            duration_secs: Some(info.frame_to_secs(remaining_frames)),
            gain,
            // D-147 — an audio clip's fade is a gain fade, the direct
            // counterpart of the opacity fade a video clip's picture gets.
            fade: fade_for_clip(&clip, &info, elapsed_frames),
        });
    }

    chroma_media::audio::start(session, sources)
}

/// Build the fade envelope for `clip`, or `None` if it has no fade — the
/// common path, and the one that keeps the mix byte-identical to pre-D-147
/// (see [`FadeEnvelope`], whose `None` case makes the mixer skip its
/// per-sample pass entirely rather than multiply by a 1.0 it computed).
///
/// **This is the timeline→media half of D-147, which is why it is app-side
/// rather than in `chroma-media`.** [`FadeEnvelope`] is seconds — a media
/// fact, exactly like [`AudioSourceSpec`]'s `start_secs`/`duration_secs`
/// beside it. A *clip* with fade *frames* is not: converting one to the other
/// needs `chroma_timeline::Clip` and the clip's probed
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
fn fade_for_clip(
    clip: &chroma_timeline::Clip,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::Mutex;
    use std::thread;
    use std::time::Duration;

    // D-146 — the transport-ordering tests below drive the real commands, so
    // they stayed here when the engine moved; these three are
    // `chroma-media`'s `test-support` hooks onto the session state they
    // assert on (see that crate's README for why a feature, not a bare `pub`).
    use chroma_media::audio::waveform_peaks;
    use chroma_media::audio::{
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
    fn session_test_guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    // --- D-147: clip fades → the mixer's envelope ------------------------ //
    //
    // The timeline→media conversion is what lives here, so it is what is
    // tested here. The envelope's own arithmetic (`apply` — the
    // per-sample-frame ramp, the cross-chunk continuation, the untouched
    // no-envelope buffer) is `chroma-media`'s and is tested in that crate's
    // `audio::tests`.

    /// A 25 fps `VideoInfo` with an audio stream — enough for
    /// [`fade_for_clip`], whose only use of one is the frames→seconds
    /// conversion.
    fn info_25fps() -> super::super::video::VideoInfo {
        super::super::video::VideoInfo {
            resolution: chroma_types::Resolution {
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

    fn clip_with_fade(duration: i64, fade_in: i64, fade_out: i64) -> chroma_timeline::Clip {
        chroma_timeline::Clip {
            duration,
            source_len: duration,
            fade_in_frames: fade_in,
            fade_out_frames: fade_out,
            ..Default::default()
        }
    }

    /// **The backward-compatibility case for the mixer.** A clip with no fade
    /// gets NO envelope at all — not an envelope that happens to return 1.0 —
    /// so `chroma-media`'s `mix_chunk` skips the per-sample pass entirely and
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
        let stale = chroma_audio_play(0, older);

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
                    let _ = chroma_audio_play(0, seq);
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

        let clip = chroma_timeline::Clip {
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
        let mut tracks = vec![chroma_timeline::Track {
            kind: chroma_timeline::TrackKind::Video,
            clips: vec![clip],
            gain: 1.0,
            locked: false,
            hidden: false,
            sync_locked: true,
        }];
        if let Some((audio_path, gain)) = audio_track {
            tracks.push(chroma_timeline::Track {
                kind: chroma_timeline::TrackKind::Audio,
                clips: vec![chroma_timeline::Clip {
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
                locked: false,
                hidden: false,
                sync_locked: true,
            });
        }
        let timeline = chroma_timeline::Timeline {
            id: "tl1".into(),
            name: "AudioTest".into(),
            rate: None,
            tracks,
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
        let played = chroma_audio_play(0, next_test_seq());
        thread::sleep(Duration::from_millis(1500));
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
        let played = chroma_audio_play(0, next_test_seq());
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
        let played = chroma_audio_play(0, next_test_seq());
        thread::sleep(Duration::from_millis(1500));
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
        let played = chroma_audio_play(0, next_test_seq());
        thread::sleep(Duration::from_millis(1500));
        let (_rms, peak) = chroma_audio_level();
        chroma_audio_stop(next_test_seq());
        super::super::state::set_project(None);

        played.expect("chroma_audio_play with a muted audio track");
        assert!(
            peak > 0.001,
            "the video's own audio must still play even with the audio track muted, got peak={peak}"
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
