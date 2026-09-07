//! write_text_file.rs — generic "write this UTF-8 text to this path" primitive
//! (D-196).
//!
//! What it is: the ONE place this app writes an arbitrary, caller-built text
//!   file to an arbitrary absolute path with no knowledge of what the text
//!   MEANS — mirrors `chroma::ffmpeg_run`'s own "generic execution primitive,
//!   the caller owns the content" split exactly, one level simpler (no
//!   process to spawn, just a file write). The first real caller is
//!   `packages/editor/src/timelineInterchange.ts` (D-196's FCPXML compiler),
//!   via `useEditorControl.ts`'s `editor_export_fcpxml` op — that TS module
//!   builds the whole XML string; this command's only job is putting it on
//!   disk.
//! What it does NOT do: know the file is XML, validate its content, create
//!   parent directories that don't exist (an absent parent directory is
//!   reported as a real error, not silently created — same "the caller
//!   already has a real project directory, a missing one means something is
//!   actually wrong" judgment `chroma::project`'s own save path makes), or
//!   append/merge with an existing file (always a full overwrite, matching
//!   every other "write this whole file" command in this crate, e.g.
//!   `chroma::motion`'s manifest save).
//!
//! Why not `tauri-plugin-fs`: it's already a workspace dependency
//! (`tauri-plugin-fs = "2.5.1"`, `Cargo.toml`) and registered
//! (`tauri_plugin_fs::init()`, `lib.rs`), but the app's `capabilities/
//! default.json` grants it NO filesystem permissions today — widening that
//! capability file to allow arbitrary-path writes from the frontend is a
//! strictly bigger security surface than one narrow, single-purpose Tauri
//! command with the exact same "the caller already knows what path it wants"
//! contract every other `chroma_*` command already has (`chroma_run_ffmpeg`,
//! `chroma::motion::chroma_motion_render`, etc.) — matching this crate's own
//! existing pattern rather than introducing a second one for one new call site.

use std::path::Path;

/// Write `contents` to `path`, verbatim, UTF-8, overwriting whatever was
/// there. Pure I/O, no interpretation of `contents` — split out from the
/// `#[tauri::command]` wrapper below purely so it's unit-testable without
/// going through Tauri's own command-invocation machinery, mirroring
/// `chroma::ffmpeg_run::run_ffmpeg`'s own reason for existing as a free
/// function.
pub fn write_text_file(path: &str, contents: &str) -> Result<(), String> {
    let p = Path::new(path);
    if let Some(parent) = p.parent()
        && !parent.as_os_str().is_empty()
        && !parent.exists()
    {
        return Err(format!(
            "directory {} does not exist — create it first",
            parent.display()
        ));
    }
    std::fs::write(p, contents).map_err(|e| format!("write {}: {e}", p.display()))
}

/// The Tauri command `useEditorControl.ts`'s `editor_export_fcpxml` (and any
/// future "write this whole text file" op) calls. Synchronous I/O on a plain
/// text write is fast enough not to need `spawn_blocking` (unlike
/// `chroma_run_ffmpeg`, which blocks on an external process) — Tauri's own
/// command dispatch already runs off the main thread.
#[tauri::command]
pub fn chroma_write_text_file(path: String, contents: String) -> Result<(), String> {
    write_text_file(&path, &contents)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_the_exact_contents_given() {
        let dir = std::env::temp_dir().join(format!(
            "chroma-write-text-file-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.fcpxml");

        write_text_file(path.to_str().unwrap(), "<fcpxml version=\"1.7\"/>").unwrap();

        let read_back = std::fs::read_to_string(&path).unwrap();
        assert_eq!(read_back, "<fcpxml version=\"1.7\"/>");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn overwrites_an_existing_file_rather_than_appending() {
        let dir = std::env::temp_dir().join(format!(
            "chroma-write-text-file-test-overwrite-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.txt");
        std::fs::write(&path, "old content, much longer than the new one").unwrap();

        write_text_file(path.to_str().unwrap(), "new").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reports_a_real_error_rather_than_silently_creating_a_missing_parent_directory() {
        let path = std::env::temp_dir().join(format!(
            "chroma-write-text-file-test-missing-{}/nested/out.txt",
            std::process::id()
        ));
        let result = write_text_file(path.to_str().unwrap(), "content");
        assert!(result.is_err());
        assert!(!path.exists());
    }
}
