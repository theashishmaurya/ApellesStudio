//! Re-export shim for `apelles_media::media_cache` (D-146,
//! `docs/notes/crate-extraction-plan.md` §2.2).
//!
//! What it is: the old `chroma::media_cache::…` path. The real 311 lines —
//! the cache root `OnceLock`, `source_key`'s blake3(path ‖ mtime ‖ len)
//! identity, `read_blob`/`write_blob`/`read_json`/`write_json`, and the LRU
//! `prune_to_budget` — live in `crates/apelles-media/src/media_cache.rs`.
//!
//! `lib.rs`'s `setup` still calls `chroma::media_cache::init(cache_dir)`
//! through this shim, because `app_cache_dir()` is Tauri's to hand over and
//! the crate must not know about `AppHandle`.

pub use apelles_media::media_cache::*;
