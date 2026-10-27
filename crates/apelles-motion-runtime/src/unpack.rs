//! Unpacking a verified archive into an artifact folder.
//!
//! **What it is:** [`unpack`] — extract a `.tar.gz` or `.zip` into a folder,
//! stripping the archive's one leading folder and, when asked, keeping only
//! named members (Node's tarball carries npm and C headers the runtime never
//! uses; only `bin/node` and its licence are kept). Unix permissions are kept,
//! so executables stay executable.
//!
//! **Safety:** archives are only unpacked after their SHA-256 matched the pin,
//! and even so every member path is checked to be a plain relative path (no
//! `..`, no absolute paths) and symbolic links are refused — none of the pinned
//! archives contains one, so one appearing is a reason to stop, not to follow.
//!
//! **What it does NOT do:** verify the download (that happened before) or make
//! the result visible (the installer unpacks into a staging folder that is
//! renamed into place only when everything is there).

use std::fs::File;
use std::io::{BufReader, Write};
use std::path::{Component, Path, PathBuf};

use crate::error::RuntimeError;
use crate::pins::Format;

/// What to extract and where.
#[derive(Debug, Clone, Copy)]
pub struct UnpackSpec<'a> {
    pub format: Format,
    /// The leading folder every member sits in (stripped). A member outside it
    /// is an error.
    pub strip_prefix: &'a str,
    /// Paths (after stripping) to keep; empty keeps everything.
    pub keep: &'a [&'a str],
}

/// Extract `archive` into `dest` (created if needed). Returns the number of
/// bytes written.
pub fn unpack(archive: &Path, dest: &Path, spec: UnpackSpec<'_>) -> Result<u64, RuntimeError> {
    std::fs::create_dir_all(dest).map_err(|e| RuntimeError::io("create", dest, e))?;
    let written = match spec.format {
        Format::TarGz => unpack_tar_gz(archive, dest, spec)?,
        Format::Zip => unpack_zip(archive, dest, spec)?,
    };
    for want in spec.keep {
        if !dest.join(want).is_file() {
            return Err(archive_err(archive, format!("it has no {want}")));
        }
    }
    Ok(written)
}

fn archive_err(archive: &Path, detail: impl Into<String>) -> RuntimeError {
    RuntimeError::Archive {
        file: archive.display().to_string(),
        detail: detail.into(),
    }
}

/// The member's path relative to the artifact folder, or `None` for the
/// leading folder itself / a member not kept. An unsafe path is an error.
fn relative(
    archive: &Path,
    member: &Path,
    spec: UnpackSpec<'_>,
) -> Result<Option<PathBuf>, RuntimeError> {
    if member
        .components()
        .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(archive_err(
            archive,
            format!("unsafe member path {}", member.display()),
        ));
    }
    let text = member.to_string_lossy().replace('\\', "/");
    let prefix = spec.strip_prefix.trim_end_matches('/');
    let rest = if text.trim_end_matches('/') == prefix {
        ""
    } else if let Some(rest) = text.strip_prefix(spec.strip_prefix) {
        rest
    } else {
        return Err(archive_err(
            archive,
            format!("member {text} is outside {}", spec.strip_prefix),
        ));
    };
    if rest.is_empty() {
        return Ok(None);
    }
    if !spec.keep.is_empty() && !spec.keep.contains(&rest.trim_end_matches('/')) {
        return Ok(None);
    }
    Ok(Some(PathBuf::from(rest)))
}

fn unpack_tar_gz(archive: &Path, dest: &Path, spec: UnpackSpec<'_>) -> Result<u64, RuntimeError> {
    let file = File::open(archive).map_err(|e| RuntimeError::io("open", archive, e))?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(BufReader::new(file)));
    tar.set_preserve_permissions(true);
    let mut written = 0u64;
    let entries = tar
        .entries()
        .map_err(|e| archive_err(archive, e.to_string()))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| archive_err(archive, e.to_string()))?;
        let member = entry
            .path()
            .map_err(|e| archive_err(archive, e.to_string()))?
            .into_owned();
        let Some(rel) = relative(archive, &member, spec)? else {
            continue;
        };
        let kind = entry.header().entry_type();
        if kind.is_dir() {
            let dir = dest.join(&rel);
            std::fs::create_dir_all(&dir).map_err(|e| RuntimeError::io("create", &dir, e))?;
            continue;
        }
        if !kind.is_file() {
            return Err(archive_err(
                archive,
                format!("{} is not a regular file", member.display()),
            ));
        }
        let out = dest.join(&rel);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| RuntimeError::io("create", parent, e))?;
        }
        entry
            .unpack(&out)
            .map_err(|e| archive_err(archive, format!("{}: {e}", member.display())))?;
        written += entry.header().size().unwrap_or(0);
    }
    Ok(written)
}

fn unpack_zip(archive: &Path, dest: &Path, spec: UnpackSpec<'_>) -> Result<u64, RuntimeError> {
    let file = File::open(archive).map_err(|e| RuntimeError::io("open", archive, e))?;
    let mut zip = zip::ZipArchive::new(BufReader::new(file))
        .map_err(|e| archive_err(archive, e.to_string()))?;
    let mut written = 0u64;
    for i in 0..zip.len() {
        let mut member = zip
            .by_index(i)
            .map_err(|e| archive_err(archive, e.to_string()))?;
        let Some(name) = member.enclosed_name() else {
            return Err(archive_err(
                archive,
                format!("unsafe member path {:?}", member.name()),
            ));
        };
        if member.is_symlink() {
            return Err(archive_err(
                archive,
                format!("{} is a symbolic link", name.display()),
            ));
        }
        let Some(rel) = relative(archive, &name, spec)? else {
            continue;
        };
        let out = dest.join(&rel);
        if member.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| RuntimeError::io("create", &out, e))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| RuntimeError::io("create", parent, e))?;
        }
        let mut f = File::create(&out).map_err(|e| RuntimeError::io("create", &out, e))?;
        let n = std::io::copy(&mut member, &mut f)
            .map_err(|e| archive_err(archive, format!("{}: {e}", name.display())))?;
        f.flush().map_err(|e| RuntimeError::io("write", &out, e))?;
        written += n;
        if let Some(mode) = member.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&out, std::fs::Permissions::from_mode(mode & 0o777))
                .map_err(|e| RuntimeError::io("set permissions on", &out, e))?;
        }
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A `.tar.gz` with `root/` holding `bin/tool` (executable), `LICENSE`, `extra.txt`.
    pub(crate) fn tar_gz(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
        let file = File::create(path)?;
        let gz = flate2::write::GzEncoder::new(file, flate2::Compression::fast());
        let mut b = tar::Builder::new(gz);
        for (name, body, mode) in [
            ("root/bin/tool", &b"#!/bin/sh\necho hi\n"[..], 0o755),
            ("root/LICENSE", &b"MIT"[..], 0o644),
            ("root/extra.txt", &b"not kept"[..], 0o644),
        ] {
            let mut h = tar::Header::new_gnu();
            h.set_size(body.len() as u64);
            h.set_mode(mode);
            h.set_cksum();
            b.append_data(&mut h, name, body)?;
        }
        b.into_inner()?.finish()?;
        Ok(())
    }

    #[test]
    fn a_tar_gz_keeps_only_the_named_members_with_their_modes()
    -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let archive = dir.path().join("a.tar.gz");
        tar_gz(&archive)?;
        let out = dir.path().join("out");
        unpack(
            &archive,
            &out,
            UnpackSpec {
                format: Format::TarGz,
                strip_prefix: "root/",
                keep: &["bin/tool", "LICENSE"],
            },
        )?;
        assert!(out.join("bin/tool").is_file());
        assert!(out.join("LICENSE").is_file());
        assert!(!out.join("extra.txt").exists(), "not kept");
        let mode = std::fs::metadata(out.join("bin/tool"))?
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0o111, "still executable");
        Ok(())
    }

    #[test]
    fn a_zip_unpacks_everything_under_its_folder() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let archive = dir.path().join("a.zip");
        {
            let mut w = zip::ZipWriter::new(File::create(&archive)?);
            let exe = zip::write::SimpleFileOptions::default().unix_permissions(0o755);
            w.start_file("shell/headless", exe)?;
            w.write_all(b"bin")?;
            w.start_file(
                "shell/res/data.pak",
                zip::write::SimpleFileOptions::default(),
            )?;
            w.write_all(b"pak")?;
            w.finish()?;
        }
        let out = dir.path().join("out");
        let n = unpack(
            &archive,
            &out,
            UnpackSpec {
                format: Format::Zip,
                strip_prefix: "shell/",
                keep: &[],
            },
        )?;
        assert_eq!(n, 6);
        assert_eq!(std::fs::read(out.join("res/data.pak"))?, b"pak");
        let mode = std::fs::metadata(out.join("headless"))?
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0o111);
        Ok(())
    }

    #[test]
    fn a_member_outside_the_leading_folder_is_refused() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let archive = dir.path().join("a.tar.gz");
        tar_gz(&archive)?;
        let err = unpack(
            &archive,
            &dir.path().join("out"),
            UnpackSpec {
                format: Format::TarGz,
                strip_prefix: "other/",
                keep: &[],
            },
        )
        .err()
        .ok_or("accepted")?;
        assert!(matches!(err, RuntimeError::Archive { .. }), "{err}");
        Ok(())
    }

    #[test]
    fn a_missing_kept_member_is_an_error() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let archive = dir.path().join("a.tar.gz");
        tar_gz(&archive)?;
        let err = unpack(
            &archive,
            &dir.path().join("out"),
            UnpackSpec {
                format: Format::TarGz,
                strip_prefix: "root/",
                keep: &["bin/node"],
            },
        )
        .err()
        .ok_or("accepted")?;
        assert!(err.to_string().contains("no bin/node"), "{err}");
        Ok(())
    }
}
