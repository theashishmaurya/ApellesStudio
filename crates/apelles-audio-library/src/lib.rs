//! **apelles-audio-library** — find a sound or a track on Openverse, import it
//! with its credit (D-400).
//!
//! - [`licence`] — the licence policy: CC0 and CC BY by default, ShareAlike on
//!   request, NonCommercial and NoDerivatives always refused, each with a named
//!   reason.
//! - [`model`] — the parsed shape of a search and the client-side filters
//!   (licence, kind, duration).
//! - [`credits`] — the `assets/audio/CREDITS.json` ledger and the
//!   video-description text built from it.
//! - [`client`] — the HTTP client: search, detail, download, with a polite
//!   `429` policy.
//!
//! **Not in this crate:** the Tauri commands that give it a project directory
//! and a path (`app/src-tauri/src/chroma/audio_library.rs`), importing into the
//! media pool, and placing on the timeline (the Edit tab). **Network access is
//! explicit:** nothing here runs unless a tool call asked for a search or an
//! import, and nothing in the render or grade path links to it.

pub mod client;
pub mod credits;
pub mod licence;
pub mod model;
