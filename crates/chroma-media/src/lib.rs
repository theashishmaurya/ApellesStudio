//! # chroma-media — L1 media I/O (D-146, `docs/notes/crate-extraction-plan.md` §2.2)
//!
//! **What it is:** everything Chroma knows about *a media file as a source of
//! frames and samples*, with no opinion at all about timelines, projects,
//! grades or the GUI. It is the layer beneath `chroma-project` /
//! `chroma-timeline` and above `chroma-types`.
//!
//! Modules, one per source file it was extracted from
//! (`app/src-tauri/src/chroma/`):
//! - [`video`] — `ffprobe` metadata + single-frame / thumbnail `ffmpeg`
//!   decode (D-015, D-124, D-128).
//! - [`conform`] — the one definition of what "source frame `N`" means, as the
//!   `ffmpeg` options that deliver it. Every decode path below builds its
//!   command through it so they cannot disagree (D-228, B-104).
//! - [`decode_pipe`] — the long-lived sequential-decode `ffmpeg` pipe pool,
//!   one slot per playback stream (D-030, D-125).
//! - [`media_cache`] — the persistent, source-keyed disk cache for derived
//!   artefacts: probes, filmstrip chunks, waveform peaks (D-128).
//! - [`probe`] — the two-layer (memory → disk) probe cache in front of
//!   [`video::probe`], lifted out of the Edit-tab bridge where it had been
//!   living by accident (D-146, B-056).
//! - [`filmstrip`] — windowed, level-of-detail, disk-cached filmstrip tiles
//!   over [`media_cache`] (D-128, D-134).
//! - [`audio`] — the Edit-tab audio engine (symphonia → rubato → dasp_sample
//!   → cpal, D-049/D-050/D-057) and the waveform-envelope path (D-051/D-128).
//!   Its *timeline resolution* — which clip is under a playhead — stayed in
//!   `app/src-tauri` on purpose; see that module's doc.
//!
//! **What it does NOT do:**
//! - **No `#[tauri::command]`.** That is a hard `tauri-macros` constraint, not
//!   a preference: the attribute emits `#[macro_export]`ed macros at the
//!   *defining crate's* root, so `generate_handler![chroma::foo::bar]` would
//!   look for them at a path they are not at; and the wrapper body expands
//!   `::tauri::ipc::private::*`, so a crate hosting a command needs a real
//!   `tauri` dependency. Traced against `tauri-macros-2.6.3` — see
//!   `docs/notes/crate-extraction-plan.md` §1. Every command stays in
//!   `app/src-tauri/src/chroma/*.rs` as a thin wrapper around this crate.
//! - **No knowledge of the timeline.** "Which clip is under this playhead" is
//!   `chroma-timeline` + the app's `chroma::edit` today and
//!   `chroma-compositor` later. This crate is handed a path, a source second
//!   and a gain; it never resolves one.
//! - **No GPU, no grade, no `AppState`.**

pub mod audio;
pub mod conform;
pub mod decode_pipe;
pub mod filmstrip;
pub mod media_cache;
pub mod probe;
pub mod video;
