//! Re-export shim for `apelles_media::decode_pipe` (D-146,
//! `docs/notes/crate-extraction-plan.md` §2.2).
//!
//! What it is: the old `chroma::decode_pipe::…` path. The real module —
//! `FramePipe` over the media engine (D-452), the `PipeSlot` pool,
//! `playback_frame`, `scale_target`, `retain_pipe_slots`, `reset` — lives in
//! `crates/apelles-media/src/decode_pipe.rs`.

pub use apelles_media::decode_pipe::*;
