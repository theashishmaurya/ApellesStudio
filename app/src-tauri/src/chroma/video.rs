//! Re-export shim for `apelles_media::video` (D-146,
//! `docs/notes/crate-extraction-plan.md` §2.2), plus the one test that could
//! not move with it.
//!
//! What it is: the old `chroma::video::…` path, kept alive so no call site in
//! the fork or in `chroma/*` had to change when the real 773 lines moved into
//! `crates/apelles-media/src/video.rs`. The `pub use` glob is deliberate and
//! temporary — the plan's wave-4 sweep retargets every call site at
//! `apelles_media::video::…` and deletes this file.
//!
//! What it does NOT do: nothing of its own. `probe`, `decode_frame`,
//! `extract_thumb`, `extract_thumb_chunk`, `probe_keyframe_interval`,
//! `split_mjpeg`, `VideoInfo`, `FramePos`, `VIDEO_EXTENSIONS`,
//! `is_video_file` — all `apelles_media::video`'s now.

pub use apelles_media::video::*;

#[cfg(test)]
mod tests {
    /// The fork's own routing hook, not `apelles_media::video`'s behaviour —
    /// which is exactly why this one test stayed behind when the module moved
    /// (D-146). `formats::is_supported_image_file` is `app/src-tauri`'s
    /// decision about which files reach the load path at all, and it calls
    /// `chroma::video::is_video_file` to make it; this asserts that edge is
    /// still wired, from the side that owns it.
    #[test]
    fn engine_treats_video_as_loadable_media() {
        assert!(crate::formats::is_supported_image_file("clip.mov"));
        assert!(crate::formats::is_supported_image_file("A001_C019.MOV"));
        assert!(!crate::formats::is_supported_image_file("notes.txt"));
    }
}
