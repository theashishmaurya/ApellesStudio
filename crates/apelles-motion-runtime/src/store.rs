//! The runtime on disk: where it lives, the cheap "is it intact" check, and the
//! atomic install / upgrade / removal.
//!
//! **Layout** (`root` is `<app data>/motion-runtime`):
//!
//! ```text
//! root/
//!   <key>/                 one installed runtime, named by pins::runtime_key()
//!     node/bin/node        Node.js (+ LICENSE)
//!     chrome/chrome-headless-shell, …
//!     compositor/remotion, ffmpeg, *.dylib, …
//!     runtime.json         the stamp: key, each artifact's version, hash and entry size
//!   downloads/             verified archives and resumable *.part files
//!   staging-<key>/         an install in progress (never read as a runtime)
//! ```
//!
//! **Atomic install:** everything is unpacked into `staging-<key>/` and the
//! stamp written last; one `rename` then makes it `<key>/`. A crash or a quit
//! mid-install leaves a staging folder the next install deletes, never a
//! half-runtime that [`inspect`] could take for a real one.
//!
//! **Cheap integrity check ([`inspect`], run on every launch and every status
//! read):** the stamp parses and names the current key and pins, and each
//! artifact's entry file exists, is executable where it must be, and is the
//! size the install recorded. No hashing — hashing 330 MB on every launch is
//! not cheap. A full re-download is one "Repair" (install) away.
//!
//! **Upgrade:** a new pin set is a new key. The old runtime keeps working
//! until the new one is renamed into place; then the old folder is deleted.
//!
//! **What it does NOT do:** run anything, or hold global state (see `manager`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::RuntimeError;
use crate::fetch;
use crate::pins::{Artifact, ArtifactId};
use crate::unpack::{self, UnpackSpec};

/// The stamp file inside an installed runtime.
pub const STAMP_FILE: &str = "runtime.json";
/// The folder verified archives and partial downloads live in.
pub const DOWNLOADS_DIR: &str = "downloads";
const STAGING_PREFIX: &str = "staging-";
const TRASH_PREFIX: &str = "trash-";
/// The stamp's own format; bump if its shape changes incompatibly.
const STAMP_FORMAT: u32 = 1;
/// Headroom on top of the computed need, so an install never fills a disk to
/// the last byte.
pub const DISK_MARGIN_BYTES: u64 = 256 * 1024 * 1024;
/// Attempts per download for a transient failure (an interrupted body resumes).
const DOWNLOAD_ATTEMPTS: u32 = 3;

/// One artifact as recorded in the stamp.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StampedArtifact {
    pub id: ArtifactId,
    pub version: String,
    pub sha256: String,
    pub entry: String,
    pub entry_size: u64,
}

/// `runtime.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stamp {
    pub format_version: u32,
    pub key: String,
    pub artifacts: Vec<StampedArtifact>,
    pub unpacked_bytes: u64,
}

/// What [`inspect`] found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallState {
    /// The current pins are installed and intact, at `dir`.
    Ready { dir: PathBuf, stamp: Stamp },
    /// Nothing is installed.
    Missing,
    /// Only a runtime for other pins is installed (an app update moved them).
    Outdated { found_key: String },
    /// The current pins' folder is there but fails the check.
    Broken { reason: String },
}

/// The installed runtime folder for `key`.
pub fn runtime_dir(root: &Path, key: &str) -> PathBuf {
    root.join(key)
}

/// The folder one artifact is unpacked into.
pub fn artifact_dir(runtime: &Path, id: ArtifactId) -> PathBuf {
    runtime.join(id.dir_name())
}

/// Check the runtime for `key` / `artifacts` under `root` (see the module doc).
pub fn inspect(root: &Path, key: &str, artifacts: &[Artifact]) -> InstallState {
    let dir = runtime_dir(root, key);
    if !dir.is_dir() {
        return match installed_keys(root).into_iter().next() {
            Some(found_key) => InstallState::Outdated { found_key },
            None => InstallState::Missing,
        };
    }
    match check(&dir, key, artifacts) {
        Ok(stamp) => InstallState::Ready { dir, stamp },
        Err(reason) => InstallState::Broken { reason },
    }
}

fn check(dir: &Path, key: &str, artifacts: &[Artifact]) -> Result<Stamp, String> {
    let text = std::fs::read_to_string(dir.join(STAMP_FILE))
        .map_err(|e| format!("{STAMP_FILE} is unreadable ({e})"))?;
    let stamp: Stamp =
        serde_json::from_str(&text).map_err(|e| format!("{STAMP_FILE} does not parse ({e})"))?;
    if stamp.format_version != STAMP_FORMAT || stamp.key != key {
        return Err(format!("{STAMP_FILE} belongs to {}", stamp.key));
    }
    for a in artifacts {
        let s = stamp
            .artifacts
            .iter()
            .find(|s| s.id == a.id)
            .ok_or_else(|| format!("{} is not recorded", a.label))?;
        if s.sha256 != a.sha256 || s.entry != a.entry {
            return Err(format!(
                "{} was installed from a different download",
                a.label
            ));
        }
        let entry = artifact_dir(dir, a.id).join(&s.entry);
        let meta = std::fs::metadata(&entry)
            .map_err(|_| format!("{} is missing ({})", a.label, entry.display()))?;
        if !meta.is_file() || meta.len() != s.entry_size {
            return Err(format!("{} is damaged ({})", a.label, entry.display()));
        }
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 {
            return Err(format!(
                "{} is not executable ({})",
                a.label,
                entry.display()
            ));
        }
    }
    Ok(stamp)
}

/// Every installed runtime key under `root` (folders with a stamp, not a
/// staging or trash folder), sorted.
pub fn installed_keys(root: &Path) -> Vec<String> {
    let mut keys: Vec<String> = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().join(STAMP_FILE).is_file())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|name| !name.starts_with(STAGING_PREFIX) && !name.starts_with(TRASH_PREFIX))
        .collect();
    keys.sort();
    keys
}

/// Bytes already held for `a` in the downloads folder (a verified archive
/// counts as whole, a partial as its length).
fn held_bytes(downloads: &Path, a: &Artifact) -> u64 {
    let dest = downloads.join(a.file_name());
    if dest.is_file() {
        return std::fs::metadata(&dest)
            .map(|m| m.len().min(a.size))
            .unwrap_or(0);
    }
    std::fs::metadata(fetch::part_path(&dest))
        .map(|m| m.len().min(a.size))
        .unwrap_or(0)
}

/// Bytes the install still needs on disk: what is left to download, the
/// unpacked runtime, and [`DISK_MARGIN_BYTES`].
pub fn bytes_needed(root: &Path, artifacts: &[Artifact]) -> u64 {
    let downloads = root.join(DOWNLOADS_DIR);
    let to_fetch: u64 = artifacts
        .iter()
        .map(|a| a.size - held_bytes(&downloads, a))
        .sum();
    let unpacked: u64 = artifacts.iter().map(|a| a.unpacked_size).sum();
    to_fetch + unpacked + DISK_MARGIN_BYTES
}

/// Refuse when `free` is below `need` (both bytes) for the disk holding `dir`.
pub fn ensure_space(need: u64, free: u64, dir: &Path) -> Result<(), RuntimeError> {
    if free >= need {
        return Ok(());
    }
    const MB: u64 = 1024 * 1024;
    Err(RuntimeError::DiskSpace {
        need_mb: need.div_ceil(MB),
        free_mb: free / MB,
        dir: dir.display().to_string(),
    })
}

/// Free bytes on the filesystem holding `path` (or its nearest existing parent).
pub fn free_bytes(path: &Path) -> Result<u64, RuntimeError> {
    let mut probe = path;
    while !probe.exists() {
        probe = probe.parent().ok_or_else(|| {
            RuntimeError::Other(format!("no existing parent of {}", path.display()))
        })?;
    }
    let st = rustix::fs::statvfs(probe)
        .map_err(|e| RuntimeError::io("measure free space on", probe, e.into()))?;
    Ok(st.f_bavail.saturating_mul(st.f_frsize))
}

/// Where the install is, for progress reporting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Step {
    Downloading,
    Unpacking,
    Finishing,
}

/// One progress report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub step: Step,
    pub artifact: Option<ArtifactId>,
    pub label: String,
    /// Download bytes held so far, across every artifact.
    pub bytes_done: u64,
    /// Total download bytes, across every artifact.
    pub bytes_total: u64,
}

/// Where the downloads come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source<'a> {
    /// The pinned URLs.
    Pinned,
    /// A mirror serving every artifact by its file name under this base URL
    /// (used by the tests; a local fixture server).
    Mirror(&'a str),
}

impl Source<'_> {
    fn url_for(&self, a: &Artifact) -> String {
        match self {
            Source::Pinned => a.url.to_string(),
            Source::Mirror(base) => format!("{}/{}", base.trim_end_matches('/'), a.file_name()),
        }
    }
}

/// One install request.
pub struct InstallRequest<'a> {
    pub root: &'a Path,
    pub key: &'a str,
    pub artifacts: &'a [Artifact],
    pub source: Source<'a>,
    /// Free bytes on the disk holding a path ([`free_bytes`] in the app; a
    /// fixed number in the disk-space test).
    pub free_space: &'a dyn Fn(&Path) -> Result<u64, RuntimeError>,
}

/// Download, verify, unpack and atomically install the runtime; then delete
/// the downloads and every other runtime version. Returns the runtime folder.
pub fn install(
    req: &InstallRequest<'_>,
    mut progress: impl FnMut(Progress),
) -> Result<PathBuf, RuntimeError> {
    let root = req.root;
    let downloads = root.join(DOWNLOADS_DIR);
    std::fs::create_dir_all(&downloads).map_err(|e| RuntimeError::io("create", &downloads, e))?;
    ensure_space(
        bytes_needed(root, req.artifacts),
        (req.free_space)(root)?,
        root,
    )?;

    let client = fetch::client()?;
    let total: u64 = req.artifacts.iter().map(|a| a.size).sum();
    let mut finished = 0u64;
    for a in req.artifacts {
        let url = req.source.url_for(a);
        let dest = downloads.join(a.file_name());
        let mut attempt = 0;
        loop {
            attempt += 1;
            let result = fetch::fetch(&client, &url, &dest, a.sha256, a.size, |held| {
                progress(Progress {
                    step: Step::Downloading,
                    artifact: Some(a.id),
                    label: a.label.to_string(),
                    bytes_done: finished + held,
                    bytes_total: total,
                });
            });
            match result {
                Ok(()) => break,
                Err(e) if e.is_transient() && attempt < DOWNLOAD_ATTEMPTS => continue,
                Err(e) => return Err(e),
            }
        }
        finished += a.size;
    }

    let staging = root.join(format!("{STAGING_PREFIX}{}", req.key));
    remove_dir_if_present(&staging)?;
    let mut stamped = Vec::with_capacity(req.artifacts.len());
    let mut unpacked = 0u64;
    for a in req.artifacts {
        progress(Progress {
            step: Step::Unpacking,
            artifact: Some(a.id),
            label: a.label.to_string(),
            bytes_done: total,
            bytes_total: total,
        });
        let dir = artifact_dir(&staging, a.id);
        unpacked += unpack::unpack(
            &downloads.join(a.file_name()),
            &dir,
            UnpackSpec {
                format: a.format,
                strip_prefix: a.strip_prefix,
                keep: a.keep,
            },
        )?;
        let entry = dir.join(a.entry);
        let entry_size = std::fs::metadata(&entry)
            .map_err(|e| RuntimeError::Archive {
                file: a.file_name().to_string(),
                detail: format!("{} is missing after unpacking ({e})", a.entry),
            })?
            .len();
        stamped.push(StampedArtifact {
            id: a.id,
            version: a.version.to_string(),
            sha256: a.sha256.to_string(),
            entry: a.entry.to_string(),
            entry_size,
        });
    }

    progress(Progress {
        step: Step::Finishing,
        artifact: None,
        label: "Finishing".to_string(),
        bytes_done: total,
        bytes_total: total,
    });
    let stamp = Stamp {
        format_version: STAMP_FORMAT,
        key: req.key.to_string(),
        artifacts: stamped,
        unpacked_bytes: unpacked,
    };
    let text = serde_json::to_string_pretty(&stamp)
        .map_err(|e| RuntimeError::Other(format!("stamp: {e}")))?;
    let stamp_path = staging.join(STAMP_FILE);
    std::fs::write(&stamp_path, format!("{text}\n"))
        .map_err(|e| RuntimeError::io("write", &stamp_path, e))?;

    let final_dir = runtime_dir(root, req.key);
    if final_dir.exists() {
        // A broken install of the same key: move it aside, then delete it.
        let trash = root.join(format!("{TRASH_PREFIX}{}", req.key));
        remove_dir_if_present(&trash)?;
        std::fs::rename(&final_dir, &trash)
            .map_err(|e| RuntimeError::io("move aside", &final_dir, e))?;
    }
    std::fs::rename(&staging, &final_dir)
        .map_err(|e| RuntimeError::io("move into place", &final_dir, e))?;

    // From here the new runtime is live; clean-up failures cost disk only.
    for a in req.artifacts {
        let _ = std::fs::remove_file(downloads.join(a.file_name()));
    }
    let _ = std::fs::remove_dir(&downloads);
    if let Ok(entries) = std::fs::read_dir(root) {
        for e in entries.flatten() {
            let path = e.path();
            if path != final_dir && path.is_dir() && path != downloads {
                let _ = std::fs::remove_dir_all(&path);
            }
        }
    }
    Ok(final_dir)
}

/// Delete every runtime, download and staging folder under `root`.
pub fn remove_all(root: &Path) -> Result<(), RuntimeError> {
    remove_dir_if_present(root)
}

fn remove_dir_if_present(dir: &Path) -> Result<(), RuntimeError> {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(RuntimeError::io("remove", dir, e)),
    }
}

/// Bytes used by everything under `dir` (0 when it does not exist).
pub fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            Ok(_) => e.metadata().map(|m| m.len()).unwrap_or(0),
            Err(_) => 0,
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pins::Format;
    use std::os::unix::fs::PermissionsExt;

    fn artifact(id: ArtifactId, entry: &'static str) -> Artifact {
        Artifact {
            id,
            label: "test",
            version: "1",
            url: "https://example.invalid/a.tar.gz",
            sha256: "00",
            size: 10,
            unpacked_size: 20,
            format: Format::TarGz,
            strip_prefix: "root/",
            keep: &[],
            entry,
            licence: "MIT",
        }
    }

    /// Lay out a runtime folder by hand, as an install would have.
    fn fake_install(
        root: &Path,
        key: &str,
        arts: &[Artifact],
    ) -> Result<PathBuf, Box<dyn std::error::Error>> {
        let dir = runtime_dir(root, key);
        let mut stamped = Vec::new();
        for a in arts {
            let entry = artifact_dir(&dir, a.id).join(a.entry);
            std::fs::create_dir_all(entry.parent().ok_or("no parent")?)?;
            std::fs::write(&entry, b"#!/bin/sh\n")?;
            std::fs::set_permissions(&entry, std::fs::Permissions::from_mode(0o755))?;
            stamped.push(StampedArtifact {
                id: a.id,
                version: a.version.into(),
                sha256: a.sha256.into(),
                entry: a.entry.into(),
                entry_size: 10,
            });
        }
        let stamp = Stamp {
            format_version: STAMP_FORMAT,
            key: key.into(),
            artifacts: stamped,
            unpacked_bytes: 30,
        };
        std::fs::write(dir.join(STAMP_FILE), serde_json::to_string(&stamp)?)?;
        Ok(dir)
    }

    #[test]
    fn nothing_installed_is_missing() -> Result<(), Box<dyn std::error::Error>> {
        let root = tempfile::tempdir()?;
        let arts = [artifact(ArtifactId::Node, "bin/node")];
        assert_eq!(inspect(root.path(), "k1", &arts), InstallState::Missing);
        assert_eq!(
            inspect(&root.path().join("absent"), "k1", &arts),
            InstallState::Missing
        );
        Ok(())
    }

    #[test]
    fn an_intact_install_is_ready() -> Result<(), Box<dyn std::error::Error>> {
        let root = tempfile::tempdir()?;
        let arts = [
            artifact(ArtifactId::Node, "bin/node"),
            artifact(ArtifactId::Chrome, "chrome-headless-shell"),
        ];
        let dir = fake_install(root.path(), "k1", &arts)?;
        match inspect(root.path(), "k1", &arts) {
            InstallState::Ready { dir: d, stamp } => {
                assert_eq!(d, dir);
                assert_eq!(stamp.artifacts.len(), 2);
            }
            other => return Err(format!("{other:?}").into()),
        }
        Ok(())
    }

    #[test]
    fn a_runtime_for_other_pins_is_outdated() -> Result<(), Box<dyn std::error::Error>> {
        let root = tempfile::tempdir()?;
        let arts = [artifact(ArtifactId::Node, "bin/node")];
        fake_install(root.path(), "node-1", &arts)?;
        assert_eq!(
            inspect(root.path(), "node-2", &arts),
            InstallState::Outdated {
                found_key: "node-1".into()
            }
        );
        Ok(())
    }

    #[test]
    fn a_changed_pin_hash_breaks_an_install_of_the_same_key()
    -> Result<(), Box<dyn std::error::Error>> {
        let root = tempfile::tempdir()?;
        let arts = [artifact(ArtifactId::Node, "bin/node")];
        fake_install(root.path(), "k1", &arts)?;
        let mut repinned = arts;
        repinned[0].sha256 = "11";
        assert!(matches!(
            inspect(root.path(), "k1", &repinned),
            InstallState::Broken { .. }
        ));
        Ok(())
    }

    #[test]
    fn a_truncated_or_missing_or_non_executable_entry_is_broken()
    -> Result<(), Box<dyn std::error::Error>> {
        let root = tempfile::tempdir()?;
        let arts = [artifact(ArtifactId::Node, "bin/node")];
        let dir = fake_install(root.path(), "k1", &arts)?;
        let entry = artifact_dir(&dir, ArtifactId::Node).join("bin/node");

        std::fs::write(&entry, b"#!")?;
        let InstallState::Broken { reason } = inspect(root.path(), "k1", &arts) else {
            return Err("truncated accepted".into());
        };
        assert!(reason.contains("damaged"), "{reason}");

        std::fs::write(&entry, b"#!/bin/sh\n")?;
        std::fs::set_permissions(&entry, std::fs::Permissions::from_mode(0o644))?;
        let InstallState::Broken { reason } = inspect(root.path(), "k1", &arts) else {
            return Err("non-executable accepted".into());
        };
        assert!(reason.contains("not executable"), "{reason}");

        std::fs::remove_file(&entry)?;
        let InstallState::Broken { reason } = inspect(root.path(), "k1", &arts) else {
            return Err("missing accepted".into());
        };
        assert!(reason.contains("missing"), "{reason}");
        Ok(())
    }

    #[test]
    fn a_staging_folder_is_never_taken_for_a_runtime() -> Result<(), Box<dyn std::error::Error>> {
        let root = tempfile::tempdir()?;
        let arts = [artifact(ArtifactId::Node, "bin/node")];
        // A crashed install: everything unpacked, stamp written, rename never ran.
        let dir = fake_install(root.path(), "k1", &arts)?;
        std::fs::rename(&dir, root.path().join(format!("{STAGING_PREFIX}k1")))?;
        assert_eq!(
            inspect(root.path(), "k1", &arts),
            InstallState::Missing,
            "a half-made install is not a runtime (the next install deletes it)"
        );
        Ok(())
    }

    #[test]
    fn too_little_free_space_is_refused_with_both_numbers() {
        let err = ensure_space(600 * 1024 * 1024, 100 * 1024 * 1024, Path::new("/data")).err();
        let Some(err) = err else {
            panic!("refusal expected");
        };
        assert_eq!(err.kind(), "diskSpace");
        let text = err.to_string();
        assert!(text.contains("600 MB") && text.contains("100 MB"), "{text}");
        assert!(ensure_space(10, 10, Path::new("/data")).is_ok());
    }

    #[test]
    fn the_need_counts_only_what_is_not_downloaded_yet() -> Result<(), Box<dyn std::error::Error>> {
        let root = tempfile::tempdir()?;
        let arts = [artifact(ArtifactId::Node, "bin/node")];
        let full = bytes_needed(root.path(), &arts);
        assert_eq!(full, 10 + 20 + DISK_MARGIN_BYTES);
        let downloads = root.path().join(DOWNLOADS_DIR);
        std::fs::create_dir_all(&downloads)?;
        std::fs::write(fetch::part_path(&downloads.join("a.tar.gz")), b"1234")?;
        assert_eq!(bytes_needed(root.path(), &arts), full - 4);
        Ok(())
    }

    #[test]
    fn free_space_is_measured_on_the_nearest_existing_folder()
    -> Result<(), Box<dyn std::error::Error>> {
        let root = tempfile::tempdir()?;
        let free = free_bytes(&root.path().join("not/yet/created"))?;
        assert!(free > 0);
        Ok(())
    }
}
