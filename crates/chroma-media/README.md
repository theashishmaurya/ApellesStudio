# chroma-media

**Layer 1 (media I/O).** Everything Chroma knows about a media file *as a
source of frames and samples*, with no opinion about timelines, projects,
grades or the GUI (D-146, `docs/notes/crate-extraction-plan.md` §2.2).

- **Deps:** `chroma-types`, `serde`/`serde_json`, `anyhow`, `log`,
  `once_cell`, `image`, `base64`, `blake3` + `walkdir` + `filetime` (the disk
  cache). **No `tauri`, no `wgpu`, no `chroma-timeline`, no fork types.**
- **Modules**, one per source file it was extracted from:
  - `conform` — the single definition of what "source frame `N`" means (*the
    picture at `N / source_fps` seconds*), expressed as the `ffmpeg` options
    that deliver it. Every decode path below builds its command through it, so
    they cannot disagree about a frame index the way they did in B-103
    (D-224). Not extracted from the fork — new with that decision.
  - `video` — `ffprobe` metadata (`probe`, incl. D-049's audio-stream facts),
    single-frame `ffmpeg` decode (`decode_frame`), thumbnail/filmstrip
    extraction (`extract_thumb`, `extract_thumb_strip`, `extract_thumb_chunk`)
    and the packet-level keyframe scan (`probe_keyframe_interval`, D-128).
  - `decode_pipe` — the long-lived sequential-decode `ffmpeg` pipe pool, one
    slot per playback stream, with the D-125 hardware-decode fallback.
  - `media_cache` — the persistent, source-keyed disk cache for derived
    artefacts (D-128): `blake3(path ‖ mtime ‖ len)` identity, atomic
    `write_blob`, LRU `prune_to_budget`.

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
  `chroma-timeline` + the app's `chroma::edit` today and to
  `chroma-compositor` later. This crate is handed a path, a source second, a
  gain and (D-147) a fade envelope in seconds; it never works one out.
  `audio::AudioSourceSpec` is that boundary, and every field on it is a
  *media* fact stated in seconds — which is why D-147's `audio::FadeEnvelope`
  is seconds too, and why the frames→seconds conversion that needs a `Clip`
  stays app-side, in `chroma::audio::fade_for_clip`. The curve math the
  envelope evaluates (`chroma_types::fade_gain`) is in **L0** for the same
  reason: it is shared with `chroma-timeline`'s compositor-side fade without
  this crate depending on `chroma-timeline`.
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

D-146 — the first of the three ordered commits of plan §2.2: `video.rs` (773),
`decode_pipe.rs` (514) and `media_cache.rs` (311) moved. `probe_cached`
(commit 2) and `filmstrip`/`audio` (commit 3) follow. See `docs/08-decisions.md`
D-146 for the decision record.
