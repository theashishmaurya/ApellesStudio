//! The whole install, end to end, against a local fixture "mirror" (D-417):
//! real HTTP (a tiny server on 127.0.0.1 with `Range` support), real archives,
//! real SHA-256 checks, the real atomic install — and no network.
//!
//! What each test pins: a clean install becomes `Ready` and leaves no
//! downloads behind; an interrupted download resumes from its `.part` and only
//! the missing bytes cross the wire; a mirror serving the wrong bytes installs
//! nothing; a new pin set replaces the old runtime only once the new one is in
//! place; too little disk space refuses before a byte is downloaded; an
//! unreachable server is reported as offline.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use apelles_motion_runtime::pins::{Artifact, ArtifactId, Format};
use apelles_motion_runtime::store::{self, InstallRequest, InstallState, Source};
use apelles_motion_runtime::{RuntimeError, fetch};

type TestResult = Result<(), Box<dyn std::error::Error>>;

/// Serves every file in `dir` by name, honouring `Range: bytes=N-`. Counts the
/// body bytes it sent and the requests it answered.
struct Mirror {
    base: String,
    sent: Arc<AtomicU64>,
    requests: Arc<AtomicU64>,
}

fn serve(dir: PathBuf) -> Result<Mirror, Box<dyn std::error::Error>> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let base = format!("http://{}", listener.local_addr()?);
    let sent = Arc::new(AtomicU64::new(0));
    let requests = Arc::new(AtomicU64::new(0));
    let (s, r) = (sent.clone(), requests.clone());
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            r.fetch_add(1, Ordering::SeqCst);
            let _ = answer(stream, &dir, &s);
        }
    });
    Ok(Mirror {
        base,
        sent,
        requests,
    })
}

fn answer(mut stream: TcpStream, dir: &Path, sent: &AtomicU64) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let name = line
        .split_whitespace()
        .nth(1)
        .unwrap_or("/")
        .trim_start_matches('/')
        .to_string();
    let mut from = 0u64;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 || header == "\r\n" {
            break;
        }
        if let Some(v) = header.to_ascii_lowercase().strip_prefix("range: bytes=") {
            from = v.trim().trim_end_matches('-').parse().unwrap_or(0);
        }
    }
    let Ok(body) = std::fs::read(dir.join(&name)) else {
        stream.write_all(
            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )?;
        return Ok(());
    };
    let total = body.len() as u64;
    let slice = &body[from.min(total) as usize..];
    let head = if from > 0 {
        format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {from}-{}/{total}\r\nConnection: close\r\n\r\n",
            slice.len(),
            total - 1
        )
    } else {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            slice.len()
        )
    };
    stream.write_all(head.as_bytes())?;
    stream.write_all(slice)?;
    sent.fetch_add(slice.len() as u64, Ordering::SeqCst);
    Ok(())
}

fn leak(s: String) -> &'static str {
    s.leak()
}

/// Three fixture archives shaped like the real pins (a Node tarball with
/// extras that are not kept, a Chrome zip, an npm tarball), and their pins.
fn fixtures(dir: &Path, tag: &str) -> Result<Vec<Artifact>, Box<dyn std::error::Error>> {
    std::fs::create_dir_all(dir)?;
    let node = dir.join(format!("node-{tag}.tar.gz"));
    {
        let gz = flate2::write::GzEncoder::new(
            std::fs::File::create(&node)?,
            flate2::Compression::fast(),
        );
        let mut b = tar::Builder::new(gz);
        for (name, body, mode) in [
            (
                "node-x/bin/node",
                format!("#!/bin/sh\necho v24.0.0-{tag}\n"),
                0o755,
            ),
            ("node-x/LICENSE", "MIT".to_string(), 0o644),
            (
                "node-x/include/node.h",
                "headers, not kept".to_string(),
                0o644,
            ),
        ] {
            let mut h = tar::Header::new_gnu();
            h.set_size(body.len() as u64);
            h.set_mode(mode);
            h.set_cksum();
            b.append_data(&mut h, name, body.as_bytes())?;
        }
        b.into_inner()?.finish()?;
    }
    let chrome = dir.join(format!("chrome-{tag}.zip"));
    {
        let mut w = zip::ZipWriter::new(std::fs::File::create(&chrome)?);
        let exe = zip::write::SimpleFileOptions::default().unix_permissions(0o755);
        w.start_file("shell/chrome-headless-shell", exe)?;
        w.write_all(format!("chrome {tag}").as_bytes())?;
        w.start_file(
            "shell/resources.pak",
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored),
        )?;
        // Big enough that a resumed download is visibly cheaper.
        w.write_all(&vec![7u8; 200_000])?;
        w.finish()?;
    }
    let compositor = dir.join(format!("compositor-{tag}.tgz"));
    {
        let gz = flate2::write::GzEncoder::new(
            std::fs::File::create(&compositor)?,
            flate2::Compression::none(),
        );
        let mut b = tar::Builder::new(gz);
        let body = vec![1u8; 150_000];
        let mut h = tar::Header::new_gnu();
        h.set_size(body.len() as u64);
        h.set_mode(0o755);
        h.set_cksum();
        b.append_data(&mut h, "package/remotion", &body[..])?;
        b.into_inner()?.finish()?;
    }
    let pin = |id,
               path: &Path,
               format,
               strip: &'static str,
               keep: &'static [&'static str],
               entry: &'static str|
     -> Result<Artifact, Box<dyn std::error::Error>> {
        let (sha, size) = fetch::hash_file(path)?;
        let name = path
            .file_name()
            .ok_or("name")?
            .to_string_lossy()
            .to_string();
        Ok(Artifact {
            id,
            label: leak(format!("{name} fixture")),
            version: leak(tag.to_string()),
            url: leak(format!("https://example.invalid/{name}")),
            sha256: leak(sha),
            size,
            unpacked_size: 1_000_000,
            format,
            strip_prefix: strip,
            keep,
            entry,
            licence: "MIT",
        })
    };
    Ok(vec![
        pin(
            ArtifactId::Compositor,
            &compositor,
            Format::TarGz,
            "package/",
            &[],
            "remotion",
        )?,
        pin(
            ArtifactId::Node,
            &node,
            Format::TarGz,
            "node-x/",
            &["bin/node", "LICENSE"],
            "bin/node",
        )?,
        pin(
            ArtifactId::Chrome,
            &chrome,
            Format::Zip,
            "shell/",
            &[],
            "chrome-headless-shell",
        )?,
    ])
}

fn plenty(_: &Path) -> Result<u64, RuntimeError> {
    Ok(u64::MAX / 2)
}

fn request<'a>(
    root: &'a Path,
    key: &'a str,
    arts: &'a [Artifact],
    base: &'a str,
) -> InstallRequest<'a> {
    InstallRequest {
        root,
        key,
        artifacts: arts,
        source: Source::Mirror(base),
        free_space: &plenty,
    }
}

#[test]
fn a_clean_install_from_the_mirror_is_ready_and_leaves_no_downloads() -> TestResult {
    let tmp = tempfile::tempdir()?;
    let arts = fixtures(&tmp.path().join("mirror"), "a")?;
    let mirror = serve(tmp.path().join("mirror"))?;
    let root = tmp.path().join("runtime");
    let mut steps = Vec::new();
    let dir = store::install(&request(&root, "k1", &arts, &mirror.base), |p| {
        steps.push(p)
    })?;

    assert_eq!(dir, root.join("k1"));
    let InstallState::Ready { stamp, .. } = store::inspect(&root, "k1", &arts) else {
        return Err("not ready after install".into());
    };
    assert_eq!(stamp.artifacts.len(), 3);
    assert!(dir.join("node/bin/node").is_file());
    assert!(dir.join("node/LICENSE").is_file());
    assert!(!dir.join("node/include").exists(), "only kept members");
    assert!(dir.join("chrome/resources.pak").is_file());
    assert!(dir.join("compositor/remotion").is_file());
    assert!(
        !root.join(store::DOWNLOADS_DIR).exists(),
        "archives deleted"
    );
    let total: u64 = arts.iter().map(|a| a.size).sum();
    let last_download = steps
        .iter()
        .rev()
        .find(|p| p.step == store::Step::Downloading)
        .ok_or("no download progress")?;
    assert_eq!(last_download.bytes_done, total);
    assert_eq!(steps.last().map(|p| p.step), Some(store::Step::Finishing));
    // The installed Node really runs.
    let out = std::process::Command::new(dir.join("node/bin/node")).output()?;
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "v24.0.0-a");
    Ok(())
}

#[test]
fn an_interrupted_download_resumes_from_its_part_file() -> TestResult {
    let tmp = tempfile::tempdir()?;
    let arts = fixtures(&tmp.path().join("mirror"), "a")?;
    let mirror = serve(tmp.path().join("mirror"))?;
    let root = tmp.path().join("runtime");
    let downloads = root.join(store::DOWNLOADS_DIR);
    std::fs::create_dir_all(&downloads)?;
    // The first half of the Chrome zip is already here, as if the line dropped.
    let chrome = arts
        .iter()
        .find(|a| a.id == ArtifactId::Chrome)
        .ok_or("chrome")?;
    let bytes = std::fs::read(tmp.path().join("mirror").join(chrome.file_name()))?;
    let held = bytes.len() / 2;
    assert!(held > 50_000, "a meaningful prefix");
    std::fs::write(
        fetch::part_path(&downloads.join(chrome.file_name())),
        &bytes[..held],
    )?;

    store::install(&request(&root, "k1", &arts, &mirror.base), |_| {})?;
    let total: u64 = arts.iter().map(|a| a.size).sum();
    assert_eq!(
        mirror.sent.load(Ordering::SeqCst),
        total - held as u64,
        "only the missing bytes were downloaded"
    );
    assert!(matches!(
        store::inspect(&root, "k1", &arts),
        InstallState::Ready { .. }
    ));
    Ok(())
}

#[test]
fn a_mirror_serving_the_wrong_bytes_installs_nothing() -> TestResult {
    let tmp = tempfile::tempdir()?;
    let arts = fixtures(&tmp.path().join("mirror"), "a")?;
    // Corrupt the Node archive on the mirror after it was pinned.
    let node = arts
        .iter()
        .find(|a| a.id == ArtifactId::Node)
        .ok_or("node")?;
    let path = tmp.path().join("mirror").join(node.file_name());
    let mut bytes = std::fs::read(&path)?;
    let last = bytes.len() - 1;
    bytes[last] ^= 0xff;
    std::fs::write(&path, bytes)?;
    let mirror = serve(tmp.path().join("mirror"))?;
    let root = tmp.path().join("runtime");

    let err = store::install(&request(&root, "k1", &arts, &mirror.base), |_| {})
        .err()
        .ok_or("a corrupt download was installed")?;
    assert_eq!(err.kind(), "checksum", "{err}");
    assert_eq!(store::inspect(&root, "k1", &arts), InstallState::Missing);
    assert!(
        !fetch::part_path(&root.join(store::DOWNLOADS_DIR).join(node.file_name())).exists(),
        "the bad file is not kept to poison the next attempt"
    );
    Ok(())
}

#[test]
fn a_new_pin_set_replaces_the_old_runtime_once_it_is_installed() -> TestResult {
    let tmp = tempfile::tempdir()?;
    let old = fixtures(&tmp.path().join("mirror"), "old")?;
    let new = fixtures(&tmp.path().join("mirror"), "new")?;
    let mirror = serve(tmp.path().join("mirror"))?;
    let root = tmp.path().join("runtime");
    store::install(&request(&root, "node-old", &old, &mirror.base), |_| {})?;

    // The app updated: its pins are now `new`, so the old runtime is outdated…
    assert_eq!(
        store::inspect(&root, "node-new", &new),
        InstallState::Outdated {
            found_key: "node-old".into()
        }
    );
    // …and keeps existing until the new one is in place.
    let mut old_still_there = true;
    store::install(&request(&root, "node-new", &new, &mirror.base), |p| {
        if p.step != store::Step::Finishing {
            old_still_there &= root.join("node-old").is_dir();
        }
    })?;
    assert!(
        old_still_there,
        "the old runtime survives the whole download"
    );
    assert!(matches!(
        store::inspect(&root, "node-new", &new),
        InstallState::Ready { .. }
    ));
    assert!(
        !root.join("node-old").exists(),
        "the old runtime is deleted afterwards"
    );
    assert_eq!(store::installed_keys(&root), vec!["node-new".to_string()]);
    Ok(())
}

#[test]
fn too_little_disk_space_refuses_before_downloading_anything() -> TestResult {
    let tmp = tempfile::tempdir()?;
    let arts = fixtures(&tmp.path().join("mirror"), "a")?;
    let mirror = serve(tmp.path().join("mirror"))?;
    let root = tmp.path().join("runtime");
    let tiny = |_: &Path| -> Result<u64, RuntimeError> { Ok(1024) };
    let req = InstallRequest {
        free_space: &tiny,
        ..request(&root, "k1", &arts, &mirror.base)
    };
    let err = store::install(&req, |_| {})
        .err()
        .ok_or("installed on a full disk")?;
    assert_eq!(err.kind(), "diskSpace", "{err}");
    assert_eq!(
        mirror.requests.load(Ordering::SeqCst),
        0,
        "no request was made"
    );
    Ok(())
}

#[test]
fn an_unreachable_server_is_reported_as_offline() -> TestResult {
    let tmp = tempfile::tempdir()?;
    let arts = fixtures(&tmp.path().join("mirror"), "a")?;
    // A port nothing listens on: bind, note it, close.
    let port = TcpListener::bind("127.0.0.1:0")?.local_addr()?.port();
    let base = format!("http://127.0.0.1:{port}");
    let root = tmp.path().join("runtime");
    let err = store::install(&request(&root, "k1", &arts, &base), |_| {})
        .err()
        .ok_or("installed without a server")?;
    assert_eq!(err.kind(), "offline", "{err}");
    assert!(err.to_string().contains("Retry"), "{err}");
    Ok(())
}

#[test]
fn the_real_pins_are_the_files_the_cached_downloads_hold() -> TestResult {
    // Optional cross-check against real downloads, without any network: point
    // APELLES_MOTION_RUNTIME_FIXTURES at a folder holding the three pinned
    // files (as fetched by hand) and every pin's size and SHA-256 is verified.
    let Ok(dir) = std::env::var("APELLES_MOTION_RUNTIME_FIXTURES") else {
        eprintln!("skipped: APELLES_MOTION_RUNTIME_FIXTURES not set");
        return Ok(());
    };
    for a in apelles_motion_runtime::pins::ARTIFACTS {
        fetch::verify_file(&Path::new(&dir).join(a.file_name()), a.sha256, a.size)?;
    }
    Ok(())
}
