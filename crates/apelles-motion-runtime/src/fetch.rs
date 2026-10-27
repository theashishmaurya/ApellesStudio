//! Downloading one pinned file, resumably, and proving it is the pinned file.
//!
//! **What it is:** [`fetch`] — download a URL into `<dest>.part`, picking up
//! from where an earlier, interrupted download stopped (an HTTP `Range`
//! request), then hash the whole file and rename it to `dest` only if its
//! SHA-256 and size are the pinned ones. [`verify_file`] is the hash check on
//! its own: the same function both the download and the tests use.
//!
//! **Why resume:** the runtime is ~160 MB. A dropped Wi-Fi connection at 90 %
//! should cost the last 10 %, not the whole download. A server that ignores
//! `Range` (answers 200) is handled by starting the file over.
//!
//! **What it does NOT do:** unpack (see `unpack`), decide what to download
//! (see `store`), or retry on its own — the caller decides (an interrupted body
//! is retried by the installer, a connection that cannot be opened at all is
//! reported as offline).

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::error::RuntimeError;

/// How long a connection may take to open before the download counts as offline.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// How long one read may stall before the download is treated as interrupted.
const READ_STALL_TIMEOUT: Duration = Duration::from_secs(30);
/// Read buffer size.
const CHUNK: usize = 64 * 1024;

/// The HTTP client every runtime download uses (rustls, no proxies beyond the
/// system's, a stall timeout rather than a total one — a 98 MB file on a slow
/// line legitimately takes minutes).
pub fn client() -> Result<reqwest::blocking::Client, RuntimeError> {
    reqwest::blocking::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(READ_STALL_TIMEOUT)
        .user_agent(concat!(
            "Apelles/",
            env!("CARGO_PKG_VERSION"),
            " (motion-runtime)"
        ))
        .build()
        .map_err(|e| RuntimeError::Other(format!("could not build the HTTP client: {e}")))
}

/// The lowercase hex SHA-256 of a file and its length.
pub fn hash_file(path: &Path) -> Result<(String, u64), RuntimeError> {
    let mut file = File::open(path).map_err(|e| RuntimeError::io("open", path, e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    let mut len = 0u64;
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| RuntimeError::io("read", path, e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        len += n as u64;
    }
    let hex = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    Ok((hex, len))
}

/// `Ok` when `path` is exactly `size` bytes with SHA-256 `sha256`.
pub fn verify_file(path: &Path, sha256: &str, size: u64) -> Result<(), RuntimeError> {
    let (actual, len) = hash_file(path)?;
    if len != size {
        return Err(RuntimeError::Checksum {
            file: path.display().to_string(),
            detail: format!("{len} bytes, expected {size}"),
        });
    }
    if actual != sha256 {
        return Err(RuntimeError::Checksum {
            file: path.display().to_string(),
            detail: format!("SHA-256 {actual}, expected {sha256}"),
        });
    }
    Ok(())
}

/// The partial file a download of `dest` writes into.
pub fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".part");
    dest.with_file_name(name)
}

/// Download `url` to `dest`, resuming `<dest>.part` if one is there, and keep
/// it only if it is `size` bytes with SHA-256 `sha256`. `on_bytes` is called
/// with the bytes held so far (including a resumed part) as they arrive.
///
/// A file that fails the check is deleted, so the next attempt starts clean
/// (a corrupt partial cannot poison every retry).
pub fn fetch(
    client: &reqwest::blocking::Client,
    url: &str,
    dest: &Path,
    sha256: &str,
    size: u64,
    mut on_bytes: impl FnMut(u64),
) -> Result<(), RuntimeError> {
    if dest.is_file() && verify_file(dest, sha256, size).is_ok() {
        on_bytes(size);
        return Ok(());
    }
    let part = part_path(dest);
    let mut have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if have > size {
        // Longer than the pinned file: it cannot be a prefix of it.
        std::fs::remove_file(&part).map_err(|e| RuntimeError::io("remove", &part, e))?;
        have = 0;
    }
    if have < size {
        download_into(client, url, &part, have, size, &mut on_bytes)?;
    } else {
        on_bytes(have);
    }
    if let Err(e) = verify_file(&part, sha256, size) {
        let _ = std::fs::remove_file(&part);
        return Err(e);
    }
    std::fs::rename(&part, dest).map_err(|e| RuntimeError::io("move into place", dest, e))
}

/// Append bytes `have..` of `url` to `part`.
fn download_into(
    client: &reqwest::blocking::Client,
    url: &str,
    part: &Path,
    have: u64,
    size: u64,
    on_bytes: &mut impl FnMut(u64),
) -> Result<(), RuntimeError> {
    let mut req = client.get(url);
    if have > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let mut resp = req
        .send()
        .map_err(|e| RuntimeError::from_request(url, &e))?;
    let status = resp.status();
    let resumed = status == reqwest::StatusCode::PARTIAL_CONTENT && have > 0;
    if !status.is_success() {
        return Err(RuntimeError::Http {
            url: url.to_string(),
            status: status.as_u16(),
        });
    }
    let mut file = if resumed {
        OpenOptions::new()
            .append(true)
            .open(part)
            .map_err(|e| RuntimeError::io("open", part, e))?
    } else {
        // 200: the server sent the whole file (no range support, or a fresh start).
        File::create(part).map_err(|e| RuntimeError::io("create", part, e))?
    };
    let mut done = if resumed { have } else { 0 };
    on_bytes(done);
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = resp.read(&mut buf).map_err(|e| RuntimeError::Interrupted {
            url: url.to_string(),
            detail: e.to_string(),
        })?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| RuntimeError::io("write", part, e))?;
        done += n as u64;
        if done > size {
            break;
        }
        on_bytes(done);
    }
    file.sync_all()
        .map_err(|e| RuntimeError::io("sync", part, e))?;
    if done < size {
        return Err(RuntimeError::Interrupted {
            url: url.to_string(),
            detail: format!("the connection closed after {done} of {size} bytes"),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha(bytes: &[u8]) -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    #[test]
    fn a_good_file_verifies() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let f = dir.path().join("a.bin");
        std::fs::write(&f, b"motion runtime")?;
        verify_file(&f, &sha(b"motion runtime"), 14)?;
        Ok(())
    }

    #[test]
    fn a_file_with_other_bytes_fails_the_hash() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let f = dir.path().join("a.bin");
        std::fs::write(&f, b"motion runtimE")?;
        let err = verify_file(&f, &sha(b"motion runtime"), 14)
            .err()
            .ok_or("accepted")?;
        assert!(matches!(err, RuntimeError::Checksum { .. }), "{err}");
        assert!(err.to_string().contains("SHA-256"), "{err}");
        Ok(())
    }

    #[test]
    fn a_truncated_file_fails_on_its_size_first() -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let f = dir.path().join("a.bin");
        std::fs::write(&f, b"motion run")?;
        let err = verify_file(&f, &sha(b"motion runtime"), 14)
            .err()
            .ok_or("accepted")?;
        assert!(matches!(err, RuntimeError::Checksum { .. }), "{err}");
        assert!(err.to_string().contains("10 bytes, expected 14"), "{err}");
        Ok(())
    }

    #[test]
    fn the_part_file_sits_beside_its_destination() {
        assert_eq!(
            part_path(Path::new("/d/node.tar.gz")),
            PathBuf::from("/d/node.tar.gz.part")
        );
    }
}
