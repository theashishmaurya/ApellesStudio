//! The two-layer probe cache: memory in front of [`crate::media_cache`]'s
//! disk store, both keyed on the source file's real identity (D-128, B-056).
//!
//! What it is: `probe_cached(path)` — the one call every consumer of a
//!   source file's facts (duration, frame count, resolution, fps, whether it
//!   has audio) actually makes. [`crate::video::probe`] itself is two
//!   `ffprobe` subprocesses — measured at 0.62s + 0.13s on the owner's own
//!   `A001_08302215_C019.MOV` — which is far too expensive to pay per frame,
//!   per filmstrip window, or per project open.
//! What it does NOT do: know anything about clips, timelines or projects. It
//!   is handed a path.
//!
//! **Why this is here and not in the Edit tab (D-146).** It used to be
//! `chroma::edit::probe_cached` — a media concern living in the Edit-tab
//! bridge by accident of who needed it first. Its real consumers are
//! [`crate::filmstrip`], [`crate::audio`], `chroma::project` and `chroma::load`,
//! none of which are the Edit tab, and leaving it there would have forced
//! `chroma-media` to depend on `app/src-tauri` — a cycle. It moved out first,
//! ahead of everything else in plan §2.2, for exactly that reason.
//!
//! **B-056, fixed here (D-146).** The memory layer used to be insert-only and
//! keyed on the path alone, while the disk layer directly beneath it was keyed
//! on `blake3(path ‖ mtime ‖ len)` precisely so that "a re-encoded or replaced
//! file never serves a stale probe". Two different keys for the same question,
//! with the weaker one in front: replace a source file in place — a re-export
//! over the same filename, an `ffmpeg -i … same.mov` — and every consumer got
//! the old duration / frame count / resolution / fps for the rest of the
//! session, with an app restart as the only recovery and nothing to indicate
//! that was what was needed. The memory layer now stores
//! [`crate::media_cache::source_key`] alongside the `VideoInfo` and revalidates
//! it on every hit, so both layers honour the identical staleness contract.
//! That costs one `stat` per hit — the same order as the `HashMap` lookup it
//! guards, and orders of magnitude below the `ffprobe` spawn it avoids.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use once_cell::sync::Lazy;

use crate::media_cache;
use crate::video::{self, VideoInfo};

/// Path → (the source file's identity when this was cached, its facts).
///
/// The `String` is what makes this correct rather than merely fast (B-056):
/// without it the map is insert-only and a replaced file is invisible to it
/// forever. See the module doc.
static PROBE_CACHE: Lazy<Mutex<HashMap<PathBuf, (String, VideoInfo)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

const NS_PROBE: &str = "probe";

/// `path`'s [`VideoInfo`], from memory, then disk, then a real `ffprobe` pass.
///
/// A cached answer is served only if the file still has the identity it had
/// when the answer was computed ([`media_cache::source_key`] — path, mtime and
/// length). When that identity cannot be established at all — the file has
/// gone offline, which `chroma::project::media_item_is_online` treats as a
/// real supported state — the remembered facts are served unvalidated rather
/// than turned into an error: re-probing a file that cannot be `stat`ed would
/// fail anyway, and reporting a clip's duration from memory is strictly better
/// than reporting nothing.
pub fn probe_cached(path: &Path) -> Result<VideoInfo, String> {
    // Computed *first*, not on the miss path as it was before D-146: it is
    // what validates the memory hit, and computing it afterwards is precisely
    // how B-056 came about.
    let key = media_cache::source_key(path).ok();

    {
        let cache = PROBE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((cached_key, info)) = cache.get(path) {
            match key.as_deref() {
                // Same file, same bytes-as-far-as-mtime+len can tell: a hit.
                Some(k) if k == cached_key => return Ok(info.clone()),
                // The file changed under us. Fall through and re-probe; the
                // stale entry is overwritten below rather than removed here,
                // so there is never a window with no entry at all.
                Some(_) => {}
                // Unstattable (offline media). Serve what we have.
                None => return Ok(info.clone()),
            }
        }
    }

    if let Some(key) = key.as_deref()
        && let Some(info) = media_cache::read_json::<VideoInfo>(NS_PROBE, key)
    {
        remember(path, key, &info);
        return Ok(info);
    }

    let info = video::probe(path).map_err(|e| format!("probe {}: {e}", path.display()))?;
    if let Some(key) = key.as_deref() {
        media_cache::write_json(NS_PROBE, key, &info);
        remember(path, key, &info);
    }
    // No `source_key` means no identity to validate a future hit against, so
    // nothing is memoised — an unkeyed entry would be exactly the insert-only
    // cache B-056 was about.
    Ok(info)
}

fn remember(path: &Path, key: &str, info: &VideoInfo) {
    PROBE_CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(path.to_path_buf(), (key.to_string(), info.clone()));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn have_ffmpeg() -> bool {
        std::process::Command::new("ffmpeg")
            .arg("-version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// Synthesize a real, probeable clip at `path` — `testsrc` at a given
    /// size and duration, so two calls with different arguments produce files
    /// whose `VideoInfo` genuinely differs.
    fn synth(path: &Path, size: &str, secs: &str, fps: &str) {
        let out = std::process::Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i"])
            .arg(format!("testsrc=size={size}:rate={fps}"))
            .args(["-t", secs, "-pix_fmt", "yuv420p"])
            .arg(path)
            .output()
            .expect("spawn ffmpeg");
        assert!(
            out.status.success(),
            "ffmpeg synth failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// **B-056, the regression test.** Replace a source file in place and the
    /// next `probe_cached` must report the new file's real facts, not the old
    /// ones.
    ///
    /// Confirmed to fail against the pre-fix code: with the memory layer
    /// keyed on the path alone and inserted into on first probe, the second
    /// call returned the 320x240 / 1s `VideoInfo` for a file that is now
    /// 640x480 / 2s — `left: 320, right: 640`.
    #[test]
    fn a_source_file_replaced_in_place_is_re_probed_not_served_stale() {
        if !have_ffmpeg() {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        }
        let path = std::env::temp_dir().join(format!(
            "chroma_probe_b056_{}_{:?}.mp4",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_file(&path);

        synth(&path, "320x240", "1", "24");
        let before = probe_cached(&path).expect("first probe");
        assert_eq!(before.resolution.width, 320);

        // The real-world move this bug is about: a re-export / re-render over
        // the same filename. Different length *and* different mtime, so the
        // disk layer's key changes too — the point is that the layer in front
        // of it now notices.
        synth(&path, "640x480", "2", "24");
        let after = probe_cached(&path).expect("second probe");

        assert_eq!(
            after.resolution.width, 640,
            "a replaced source file must be re-probed, not served from the in-memory layer"
        );
        assert_eq!(after.resolution.height, 480);
        assert!(
            after.duration_secs > before.duration_secs * 1.5,
            "the replacement is twice as long: {} -> {}",
            before.duration_secs,
            after.duration_secs
        );
        let _ = std::fs::remove_file(&path);
    }

    /// The other half of the contract: an *unchanged* file must still be a
    /// memory hit, or the fix would have traded a correctness bug for the
    /// `ffprobe`-per-call cost this cache exists to avoid.
    #[test]
    fn an_unchanged_file_is_still_served_from_memory() {
        if !have_ffmpeg() {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        }
        let path = std::env::temp_dir().join(format!(
            "chroma_probe_hit_{}_{:?}.mp4",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_file(&path);
        synth(&path, "160x120", "1", "24");

        let cold = std::time::Instant::now();
        let a = probe_cached(&path).expect("first probe");
        let cold = cold.elapsed().as_secs_f64();

        let warm = std::time::Instant::now();
        let b = probe_cached(&path).expect("second probe");
        let warm = warm.elapsed().as_secs_f64();

        assert_eq!(a.resolution, b.resolution);
        assert_eq!(a.frame_count, b.frame_count);
        // An order of magnitude, not a benchmark — a real `ffprobe` pass is
        // two process spawns, a validated memory hit is a `stat` and a hash.
        assert!(
            warm * 5.0 < cold,
            "an unchanged file must still hit memory: cold {cold:.4}s vs warm {warm:.4}s"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// A file that cannot be `stat`ed at all has no identity to validate
    /// against, and must not become an error for a caller that already has
    /// its facts — media going offline is a supported state, not a failure.
    #[test]
    fn an_offline_file_still_serves_its_remembered_facts() {
        if !have_ffmpeg() {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        }
        let path = std::env::temp_dir().join(format!(
            "chroma_probe_offline_{}_{:?}.mp4",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_file(&path);
        synth(&path, "160x120", "1", "24");
        let online = probe_cached(&path).expect("probe while present");

        std::fs::remove_file(&path).expect("take the file offline");
        let offline = probe_cached(&path).expect("an offline clip keeps its remembered facts");
        assert_eq!(online.frame_count, offline.frame_count);
        assert_eq!(online.resolution, offline.resolution);
    }

    /// And a path that was never probed at all is still a real error, not a
    /// silently-empty `VideoInfo`.
    #[test]
    fn a_path_that_was_never_probed_is_an_error() {
        assert!(probe_cached(Path::new("/definitely/not/here.mov")).is_err());
    }
}
