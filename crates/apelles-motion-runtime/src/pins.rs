//! The three pinned downloads that make up Motion's render runtime (D-417).
//!
//! **What it is:** the exact files the app fetches the first time the Motion tab
//! opens, each pinned by URL, byte size and SHA-256, plus what to keep from each
//! archive and the one file whose presence proves it is installed.
//!
//! **Where each pin comes from** (re-derive them the same way when bumping):
//!
//! | artifact | source | checksum source |
//! |---|---|---|
//! | Node.js | `nodejs.org/dist/v<ver>/node-v<ver>-darwin-arm64.tar.gz` | that release's `SHASUMS256.txt` (published by the Node.js release team) |
//! | Chrome Headless Shell | Chrome for Testing, `storage.googleapis.com/chrome-for-testing-public/<ver>/mac-arm64/` | none is published: measured once with `shasum -a 256`, cross-checked against the bucket's own `x-goog-hash` MD5 |
//! | Remotion compositor | `registry.npmjs.org/@remotion/compositor-darwin-arm64/-/…-<ver>.tgz` | measured once; the npm `integrity` (sha512) in the root `package-lock.json` is pinned too and a test compares the two |
//!
//! The Chrome version is the one the pinned Remotion was tested with
//! (`TESTED_VERSION` in `@remotion/renderer`), and the compositor version is the
//! engine's Remotion version; `tests` below hold both against the checkout.
//!
//! **Bumping a pin** changes [`runtime_key`], so an installed runtime is reported
//! `outdated` and the next install puts the new one beside it and removes the old
//! one only after the new one is in place (D-417's upgrade path).
//!
//! **What it does NOT do:** download or check anything (see `fetch` / `store`).

/// The archive format of a download.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    /// A gzip-compressed tar (`.tar.gz` / npm's `.tgz`).
    TarGz,
    /// A zip archive.
    Zip,
}

/// Which part of the runtime an artifact is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactId {
    /// The Node.js binary that runs the renderer and the component check.
    Node,
    /// Chrome Headless Shell, the browser Remotion renders frames in.
    Chrome,
    /// Remotion's per-platform compositor (its own ffmpeg build, stitching, frame extraction).
    Compositor,
}

impl ArtifactId {
    /// The folder the artifact is unpacked into, inside an installed runtime.
    pub fn dir_name(self) -> &'static str {
        match self {
            ArtifactId::Node => "node",
            ArtifactId::Chrome => "chrome",
            ArtifactId::Compositor => "compositor",
        }
    }
}

/// One pinned download.
#[derive(Debug, Clone, Copy)]
pub struct Artifact {
    pub id: ArtifactId,
    /// What a person is told is downloading.
    pub label: &'static str,
    pub version: &'static str,
    pub url: &'static str,
    /// Lowercase hex SHA-256 of the whole download.
    pub sha256: &'static str,
    /// Exact download size, bytes (a server that sends more or less is wrong).
    pub size: u64,
    /// Bytes on disk once unpacked (only the kept members) — for the disk check.
    pub unpacked_size: u64,
    pub format: Format,
    /// The leading folder every member of the archive sits in; stripped.
    pub strip_prefix: &'static str,
    /// Members to keep (paths after `strip_prefix`); empty keeps everything.
    pub keep: &'static [&'static str],
    /// The file inside the unpacked folder that must exist (and be the size the
    /// install recorded) for the artifact to count as installed.
    pub entry: &'static str,
    /// The licence the artifact is distributed under (shown in the notices).
    pub licence: &'static str,
}

impl Artifact {
    /// The last path segment of [`Artifact::url`] — what a mirror serves it as.
    pub fn file_name(&self) -> &'static str {
        self.url.rsplit('/').next().unwrap_or(self.url)
    }
}

/// Node.js: the current Long-Term-Support line (v24 "Krypton"). The engine's
/// component check needs Node's built-in TypeScript type stripping (22.18+).
pub const NODE_VERSION: &str = "24.22.1";
/// The Chrome Headless Shell `@remotion/renderer` 4.0.519 was tested against.
pub const CHROME_VERSION: &str = "149.0.7790.0";
/// The engine's Remotion version, which the compositor must match exactly.
pub const REMOTION_VERSION: &str = "4.0.519";
/// npm's `integrity` for the compositor tarball, as `package-lock.json` records it.
pub const COMPOSITOR_NPM_INTEGRITY: &str = "sha512-Cuu6UxdqaAgY8p0f6WdstmXp1acCcGw2qywVqnbe8/iVY6CTtmOFcN5kNXhbYoEbXiaYCPFTXsfN/ifWtxAMOg==";

/// The oldest Node a DEVELOPER's own `node` may be (the type stripping
/// `scripts/*.mts` need is on by default from 22.18).
pub const NODE_MIN_VERSION: (u32, u32, u32) = (22, 18, 0);

/// Everything the runtime downloads, in download order (smallest first, so a
/// connection problem shows up before the long download).
pub const ARTIFACTS: [Artifact; 3] = [
    Artifact {
        id: ArtifactId::Compositor,
        label: "Remotion compositor 4.0.519",
        version: REMOTION_VERSION,
        url: "https://registry.npmjs.org/@remotion/compositor-darwin-arm64/-/compositor-darwin-arm64-4.0.519.tgz",
        sha256: "9f7b625d05161cd1b608b12e381fefe06c8f65d883755fb5b85daad024e91c9e",
        size: 8_441_419,
        unpacked_size: 17_700_285,
        format: Format::TarGz,
        strip_prefix: "package/",
        keep: &[],
        entry: "remotion",
        licence: "Remotion License (remotion.dev/license); its FFmpeg build is GPL",
    },
    Artifact {
        id: ArtifactId::Node,
        label: "Node.js 24.22.1",
        version: NODE_VERSION,
        url: "https://nodejs.org/dist/v24.22.1/node-v24.22.1-darwin-arm64.tar.gz",
        sha256: "89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7",
        size: 53_062_778,
        unpacked_size: 122_703_465,
        format: Format::TarGz,
        strip_prefix: "node-v24.22.1-darwin-arm64/",
        keep: &["bin/node", "LICENSE"],
        entry: "bin/node",
        licence: "MIT (Node.js), with its bundled dependencies' notices in LICENSE",
    },
    Artifact {
        id: ArtifactId::Chrome,
        label: "Chrome Headless Shell 149.0.7790.0",
        version: CHROME_VERSION,
        url: "https://storage.googleapis.com/chrome-for-testing-public/149.0.7790.0/mac-arm64/chrome-headless-shell-mac-arm64.zip",
        sha256: "17ef152eba8ffcfebc42e25ab295eb040d8e62455cff7dfcc735b652456d6899",
        size: 98_080_877,
        unpacked_size: 202_108_564,
        format: Format::Zip,
        strip_prefix: "chrome-headless-shell-mac-arm64/",
        keep: &[],
        entry: "chrome-headless-shell",
        licence: "BSD-3-Clause (Chromium) and its third-party licences in LICENSE.headless_shell",
    },
];

/// The pin set's identity: an installed runtime belongs to exactly one key, and
/// a different key means it is outdated. Human-readable on purpose (it is the
/// install folder's name).
pub fn runtime_key() -> String {
    format!("node-{NODE_VERSION}_chrome-{CHROME_VERSION}_remotion-{REMOTION_VERSION}")
}

/// Total download size of every artifact.
pub fn total_download_bytes() -> u64 {
    ARTIFACTS.iter().map(|a| a.size).sum()
}

/// Total on-disk size of every unpacked artifact.
pub fn total_unpacked_bytes() -> u64 {
    ARTIFACTS.iter().map(|a| a.unpacked_size).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn workspace() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    #[test]
    fn every_pin_is_well_formed() {
        for a in ARTIFACTS {
            assert_eq!(a.sha256.len(), 64, "{:?}", a.id);
            assert!(
                a.sha256
                    .chars()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
            );
            assert!(a.url.starts_with("https://"), "{:?}", a.id);
            assert!(
                a.url.contains(a.version),
                "{:?}: the URL names its version",
                a.id
            );
            assert!(a.strip_prefix.ends_with('/'));
            assert!(a.size > 0 && a.unpacked_size > 0);
            assert!(!a.entry.is_empty());
        }
        let mut dirs: Vec<_> = ARTIFACTS.iter().map(|a| a.id.dir_name()).collect();
        dirs.sort_unstable();
        dirs.dedup();
        assert_eq!(dirs.len(), ARTIFACTS.len(), "one folder per artifact");
    }

    #[test]
    fn the_key_names_every_pinned_version() {
        let key = runtime_key();
        for v in [NODE_VERSION, CHROME_VERSION, REMOTION_VERSION] {
            assert!(key.contains(v), "{key} names {v}");
        }
    }

    /// The compositor must be the engine's own Remotion version, and its pinned
    /// npm integrity must be the one the lock file installs in development.
    #[test]
    fn the_compositor_pin_matches_the_engine_and_the_lock_file()
    -> Result<(), Box<dyn std::error::Error>> {
        let engine: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(
            workspace().join("packages/motion-engine/package.json"),
        )?)?;
        assert_eq!(engine["dependencies"]["remotion"], REMOTION_VERSION);
        assert_eq!(engine["dependencies"]["@remotion/cli"], REMOTION_VERSION);

        let lock: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(
            workspace().join("package-lock.json"),
        )?)?;
        let entry = &lock["packages"]["node_modules/@remotion/compositor-darwin-arm64"];
        assert_eq!(entry["version"], REMOTION_VERSION);
        assert_eq!(entry["integrity"], COMPOSITOR_NPM_INTEGRITY);
        let compositor = ARTIFACTS
            .iter()
            .find(|a| a.id == ArtifactId::Compositor)
            .ok_or("no compositor pin")?;
        assert_eq!(entry["resolved"], compositor.url);
        Ok(())
    }

    /// Chrome must be the version the pinned renderer was tested with. Read from
    /// the installed `@remotion/renderer` when the checkout has `node_modules`.
    #[test]
    fn the_chrome_pin_is_the_one_remotion_was_tested_with() {
        let file = workspace()
            .join("node_modules/@remotion/renderer/dist/browser/get-chrome-download-url.js");
        let Ok(text) = std::fs::read_to_string(&file) else {
            eprintln!("skipped: {} not installed (run npm ci)", file.display());
            return;
        };
        assert!(
            text.contains(&format!("exports.TESTED_VERSION = '{CHROME_VERSION}'")),
            "@remotion/renderer's TESTED_VERSION is not {CHROME_VERSION}; re-pin Chrome"
        );
    }
}
