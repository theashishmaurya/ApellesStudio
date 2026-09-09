//! Re-export shim for `apelles_media::decode_pipe` (D-146,
//! `docs/notes/crate-extraction-plan.md` §2.2).
//!
//! What it is: the old `chroma::decode_pipe::…` path. The real 514 lines —
//! `FramePipe`, the `PipeSlot` pool, `playback_frame_scaled`'s hardware-decode
//! fallback (D-125), `scale_target`, `retain_track_slots`, `reset` — live in
//! `crates/apelles-media/src/decode_pipe.rs`.

pub use apelles_media::decode_pipe::*;
