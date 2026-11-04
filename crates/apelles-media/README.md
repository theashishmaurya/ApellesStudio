# apelles-media

**Layer 1 (media I/O).** Everything Apelles knows about a media file *as a
source of frames and samples*, with no opinion about timelines, projects,
grades or the GUI (D-146, `docs/notes/crate-extraction-plan.md` §2.2).

- **Deps:** `apelles-types`, `serde`/`serde_json`, `anyhow`, `log`,
  `once_cell`, `image`, `base64`, `blake3` + `walkdir` + `filetime` (the disk
  cache), and on macOS the objc2 bindings for Vision, AVFoundation, CoreMedia,
  CoreVideo and VideoToolbox (D-397, D-452). **No `tauri`, no `wgpu`, no
  `apelles-timeline`, no fork types.**
- **Modules**, one per source file it was extracted from:
  - `scenes` (D-411) — `detect_scene_cuts`: picture-cut instants from ffmpeg's
    `scene` score on a 160 px decode (threshold 0.3), parsed from `showinfo`.
    One whole-file pass; the caller caches it (the clipper, in `media_cache`).
  - `ocr` (D-397) — `recognize_image` / `recognize_media`: the words in a picture
    and their boxes, via the macOS Vision framework (`objc2-vision`), on-device.
    macOS-only; other targets get a named error.
  - `ffmpeg_locate` — **the one resolver for which `ffmpeg`/`ffprobe` runs
    (D-389, B-253)**, and the `ffmpeg()` / `ffprobe()` `Command` constructors
    every spawn in the workspace uses. Ladder: `CHROMA_FFMPEG`/`CHROMA_FFPROBE`
    → beside `current_exe()` (the Tauri `externalBin` copy bundled in the app)
    → `/opt/homebrew/bin`, `/usr/local/bin` → `PATH`. Resolved once, cached,
    logged at startup (`log_resolution`); a miss is a `ToolMissing` error naming
    every place checked. `child_env()` hands the answer to a sidecar process.
    It does not fetch the binaries (`app/src-tauri/build.rs` does) or run them
    to check a version. **Never spawn `Command::new("ffmpeg")` directly** — a
    Finder-launched app has no Homebrew on its `PATH`.
  - `conform` — the single definition of what "source frame `N`" means (*the
    picture at `N / source_fps` seconds*), expressed as the `ffmpeg` options
    that deliver it. Every decode path below builds its command through it, so
    they cannot disagree about a frame index the way they did in B-104
    (D-228). Not extracted from the fork — new with that decision.
  - `video` — `ffprobe` metadata (`probe`, incl. D-049's audio-stream facts),
    single-frame `ffmpeg` decode (`decode_frame`), thumbnail/filmstrip
    extraction (`extract_thumb`, `extract_thumb_chunk`)
    and the packet-level keyframe scan (`probe_keyframe_interval`, D-128).
  - `probe` — the memory → disk probe cache (`probe_cached`, keyed by path +
    mtime + size) and `probe_cached_many`, the same for many paths on up to 8
    scoped threads with a progress callback (B-369: a project open's media step).
  - `still` — **still images as timeline sources (D-292)**: `video`'s
    counterpart for a source that has one frame and no clock. The extension
    gate (`is_image_file`, mirrored on the TS side), a header-only dimension
    `probe` (no subprocess), `decode_scaled` (the still counterpart of
    `decode_pipe::playback_frame`, memoised on `(path, source_key,
    target)` so a still held for three seconds is decoded once, not 72 times)
    and a `thumbnail` in the same wire shape `video::extract_thumb` produces.
    Deliberately reports **no** rate/duration/frame count — a still has none,
    and synthesising one belongs to the timeline, not here. Does not decode RAW
    (that is the fork's `image_loader`, above this layer) or animate a GIF.
  - `vt_decode` (D-452) — **the media engine's decode**: `Reader`, one
    sequential AVFoundation / VideoToolbox decode of a QuickTime-family file
    (`.mov`, `.mp4`, `.m4v`) from nominal frame `N`, on its own thread with a
    two-frame read-ahead, conformed to the D-228 grid in exact `CMTime`
    arithmetic. Each frame is an IOSurface-backed, Metal-compatible
    `CVPixelBuffer` in the source's own two-plane Y'CbCr layout (4:2:0 / 4:2:2
    / 4:4:4, 8- or 10-bit, video or full range) with the matrix ffmpeg would
    use for it (`YcbcrLayout`); the GPU engine converts it. Frames
    AVAssetReader synthesizes for an empty edit are dropped, as ffmpeg presents
    none there (B-384). No colour, no scaling, no audio, no fallback.
  - `vt_encode` (D-452) — **the media engine's encode**: `SegmentEncoder`, a
    `VTCompressionSession` (hardware required) into an `AVAssetWriter`
    writing a video-only `.mp4` / `.mov`. H.264 at D-446's measured quality
    (VideoToolbox quality 0.70, High, no B-frames, key frame every 12) or
    ProRes 422 HQ, tagged Rec.709, the frame clock exact at `n / fps`. The
    caller fills buffers from the encoder's own pool on the GPU. No audio, no
    joining (ffmpeg remuxes those in `chroma::edit_render`).
  - `decode_pipe` — the pool of sequential decode streams, one per playback
    slot and lane (D-125, D-360), with the cut-boundary prefetch (D-324,
    D-330). Every stream is a `vt_decode::Reader` (D-452): over the source
    itself for the QuickTime family, over its converted file for any other
    container (`optimized_media`, D-453), keyed by the original path either
    way. `playback_frame` returns a `VideoFrame` (full size, for the GPU). A
    repeat of the last frame (a hold, a slow ramp) is served without a seek. A
    source not converted yet is an error naming it. A still never uses it:
    there is no stream to step (D-292).
  - `optimized_media` (D-453) — **a source the media engine cannot open,
    converted once**: `convert` runs `hevc_videotoolbox -q:v 75` into a
    `.mov` keeping the source's timestamps (D-228's grid holds), range, depth
    and alpha, and checks the media engine can read it; the files live in the
    open project's `optimized-media/` folder (`set_project_dir`; the app
    cache's with no project, `init`), keyed by `media_cache::source_key`, with
    each file's decode facts beside it. `request` / `cancel` / `status` /
    `set_listener` are the one-worker queue the app drives and the GUI and MCP
    read; `decode_source` is what `decode_pipe` opens; `prune` removes files
    nothing maps to. Hardware encoder required, no software fallback. Design
    and measurements: `docs/notes/optimized-media.md`.
  - `media_cache` — the persistent, source-keyed disk cache for derived
    artefacts (D-128): `blake3(path ‖ mtime ‖ len)` identity, atomic
    `write_blob`, LRU `prune_to_budget`.
  - `audio` — the Edit-tab playback engine (symphonia → rubato → dasp_sample →
    cpal, D-049/D-050/D-057), its per-source gain envelopes (fade D-147, duck
    D-149, level D-223, EQ D-224), its per-source **speed retime** (D-242 — a
    variable-rate reader that varispeeds a ramped clip's sound to match its
    picture, reverse included; the export's pitch-preserving `atempo` is
    deliberately NOT mirrored here, see D-242), the single transport's
    generation/`seq` ordering protocol (D-130), and the waveform-envelope path
    (D-051/D-128).
  - `scrub` — **tape-style audio scrubbing (D-232)**: the *position-driven*
    playback mode, beside `audio`'s time-driven one. Given a path and a source
    second that the caller updates at pointer-move rate, it repeatedly emits a
    short enveloped grain read from a decoded window around that position. It
    is not a second engine: it claims `audio`'s **same** single transport (so a
    scrub and a play can never sound at once, with no new invariant), opens its
    `cpal` output stream through `audio::build_output_stream`, and fills its
    window through `audio::open_source`/`DecodedSource`. One source, not a mix
    — see D-232.

## Loudness (D-401)

`loudness` measures a finished file (ebur128 with true peak), applies one linear gain plus an oversampled `alimiter`, remuxes with the video stream copied, re-measures and corrects until the target is met within tolerance. Used by both export paths; silent files are left untouched.

## What it does NOT do

- **Own any `#[tauri::command]`.** A real `tauri-macros` constraint, not
  taste: the attribute emits `#[macro_export]`ed macros at the *defining*
  crate's root, so `generate_handler![chroma::foo::bar]` would look for them
  at a path they are not at, and the wrapper body expands
  `::tauri::ipc::private::*` — a crate hosting a command needs a real `tauri`
  dependency. Traced against `tauri-macros-2.6.3`; see
  `docs/notes/crate-extraction-plan.md` §1. Every command stays in
  `app/src-tauri/src/chroma/*.rs` as a thin wrapper.
- **Resolve the timeline.** "Which clip is under this playhead" belongs to
  `apelles-timeline` + the app's `chroma::edit` today and to
  `apelles-compositor` later. This crate is handed a path, a source second, a
  gain and (D-147) a fade envelope in seconds; it never works one out.
  `audio::AudioSourceSpec` is that boundary, and every field on it is a
  *media* fact stated in seconds — which is why D-147's `audio::FadeEnvelope`
  is seconds too, why D-242's `audio::AudioSpeedSegment` is seconds too, and
  why the frames→seconds conversion that needs a `Clip` stays app-side, in
  `chroma::audio::fade_for_clip` / `chroma::audio::speed_for_clip`. **This is
  also why D-242's retime resolves a speed ramp it is handed rather than one it
  looks up**: `speed_ramp::segments_from_output`, which answers "which runs are
  still ahead of the playhead", lives in `apelles-timeline` — one layer up — and
  the app converts its answer to seconds before this crate sees it. The curve math the
  envelope evaluates (`apelles_types::fade_gain`) is in **L0** for the same
  reason: it is shared with `apelles-timeline`'s compositor-side fade without
  this crate depending on `apelles-timeline`.
  **The one thing a play session is told *about* a timeline rather than about a
  source is its length** (`audio::ResolvedAudio::timeline_end_frame`, D-357) —
  a single frame number the app reports alongside each re-resolve, uninterpreted
  here beyond one comparison. It exists because "the playhead is in a real
  silence between two clips" and "the playhead is past the last clip" are
  indistinguishable from inside the mixer and must not be (B-192); it is not a
  crack in the boundary above, since the answer still comes *from* the layer
  that owns the timeline rather than being worked out here.
- **Touch the GPU, the grade, or `AppState`.**

## The `test-support` feature

Three items are test-only by design and were `#[cfg(test)]` while this code
lived inside `app/src-tauri`: `media_cache::init_for_tests` (bind a `tempdir`
cache root) and `decode_pipe::open_pipe_count` (the observable D-125's "one
pipe per visible layer" contract is asserted against). The tests that need
them now sit on the *other side* of a crate boundary — in
`app/src-tauri/src/chroma/{filmstrip,edit}.rs` — and a separate crate's
`#[cfg(test)]` items are unreachable from there.

They are gated `#[cfg(any(test, feature = "test-support"))]` and
`app/src-tauri` enables the feature from its **`[dev-dependencies]`** only.
That is Cargo's canonical answer to exactly this, and it is why the
alternative (`#[doc(hidden)] pub`) was rejected: an unconditional `pub` would
ship both functions in every release build, which the house "no dead code"
rule forbids, and would put a cache-root override on the public API of a crate
whose production entry point is deliberately `init(app_cache_dir)`.

## Status

D-146 — all three ordered commits of plan §2.2 landed: `video.rs`,
`decode_pipe.rs` and `media_cache.rs` (commit 1), `probe_cached` out of
`edit.rs` (commit 2), `filmstrip.rs` whole and `audio.rs` **split** — engine
here, timeline resolution left app-side (commit 3). See `docs/08-decisions.md`
D-146 for the decision record. `scrub` was added later, by D-232, and is the
only module here that was not extracted from the fork.
