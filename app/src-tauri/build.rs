use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

/// B-181 — a build-time HTTP client with no explicit timeout, not a client
/// with none at all. `reqwest::blocking::get`'s default client's implicit
/// timeout is shorter than a real, working download of these binaries can
/// take on an ordinary (not broken, just not fast) network — verified live:
/// the uv archive download timed out identically on 3 straight attempts
/// while `curl` succeeded on the same URL in 11.4s. A short implicit timeout
/// makes "still transferring" indistinguishable from "actually stuck", so
/// every retry in [`fetch_uv`] failed the same way a plain re-run of `curl`
/// would not have. 120s is generous for a binary this size on any network
/// that will complete at all; a build that is truly offline still fails,
/// just slower and for the right reason.
fn http_client() -> Result<reqwest::blocking::Client, reqwest::Error> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
}

fn verify_sha256(path: &Path, expected_hash: &str) -> Result<bool, io::Error> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 8192];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    let hash_bytes = hasher.finalize();
    let calculated_hash = hex::encode(hash_bytes);
    Ok(calculated_hash == expected_hash)
}

fn download_and_verify(
    url: &str,
    dest_path: &Path,
    expected_hash: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR not set"));
    let temp_filename = dest_path.file_name().unwrap();
    let temp_path = out_dir.join(temp_filename);

    println!(
        "cargo:warning=Downloading to temporary path: {:?}",
        temp_path
    );
    let mut response = http_client()?.get(url).send()?;

    if !response.status().is_success() {
        let status = response.status();
        let error_body = response
            .text()
            .unwrap_or_else(|_| "Could not read error body".to_string());
        return Err(format!("Download failed with status {}: {}", status, error_body).into());
    }

    let mut temp_file = fs::File::create(&temp_path)?;
    response.copy_to(&mut temp_file)?;
    println!("cargo:warning=Download complete. Verifying file integrity...");

    match verify_sha256(&temp_path, expected_hash) {
        Ok(true) => {
            fs::copy(&temp_path, dest_path)?;
            fs::remove_file(&temp_path)?;
            println!(
                "cargo:warning=Successfully downloaded and verified {:?}.",
                dest_path
            );
            Ok(())
        }
        Ok(false) => {
            fs::remove_file(&temp_path)?;
            Err("Verification failed! The downloaded file is corrupt.".into())
        }
        Err(e) => {
            fs::remove_file(&temp_path).ok();
            Err(format!("Could not verify file after download: {}", e).into())
        }
    }
}

// ---- uv: the bundled Python toolchain for the AI-env bootstrap (D-315) -------------
//
// Apelles' two Python sidecars need a 1.6 GB venv that is deliberately NOT in the
// installer (see D-315: bundling it re-creates the "nobody downloads a 2 GB app"
// problem D-314 just spent 1.7 GB fixing). The app builds that venv itself, on
// first launch, in the background — and to do that on a machine with no Python at
// all it needs a Python toolchain of its own. That is `uv`: one static binary that
// can fetch a self-contained `python-build-standalone` CPython, create the venv and
// install the locked requirements, with no system interpreter anywhere in the loop.
//
// Fetched here, at BUILD time, by the same hash-verified pattern as the ONNX Runtime
// library above — pinned version, pinned sha256, panic on mismatch — and dropped
// where Tauri's `externalBin` mechanism expects it, so it lands beside the app's own
// executable in a dev run AND inside the bundle.

/// The pinned `uv` release. Moving this means re-fetching BOTH hashes below from
/// the release's own published `.sha256` files — never hand-edit one of them.
const UV_VERSION: &str = "0.12.13";

/// The one target this is wired up for: v1 ships macOS ARM only (`docs/02-scope.md`),
/// and `externalBin` is declared in `tauri.macos.conf.json` rather than the base
/// config so a Linux/Windows build is unaffected rather than broken.
///
/// A macOS **x86_64** build deliberately gets nothing here and then fails loudly in
/// `tauri_build::build()` on the missing `binaries/uv-x86_64-apple-darwin`. That is
/// the right failure: silently bundling an app whose AI features can never bootstrap
/// is far worse than a build error naming the gap.
const UV_TARGET: &str = "aarch64-apple-darwin";

/// sha256 of `uv-aarch64-apple-darwin.tar.gz`, from the release's published
/// `.sha256` file — what the download is verified against.
const UV_ARCHIVE_SHA256: &str = "7e6ddb9316acc00f2296c82ff4d99977870ee34b2f0ddcae9444d714db9364ed";

/// sha256 of the `uv` executable *inside* that archive. Pinned separately because
/// the extracted binary is what actually ships and what the "already there, skip the
/// download" check re-verifies on every rebuild — the archive itself is not kept.
const UV_BINARY_SHA256: &str = "964e82d2f7736a5dd3c8d4dfe299697286c655ff44c9ae3802886f27c5bf4d4a";

/// Download the pinned `uv` archive, verify it, and extract just the `uv` executable
/// to `binaries/uv-<target triple>` — the exact path+name Tauri's `externalBin`
/// resolves (`tauri_utils::resources::external_binaries` appends `-<triple>`, and
/// `tauri_build`'s `copy_binaries` strips it again when it copies the file next to
/// our own executable). `uvx`, the other member of the archive, is a `uv tool run`
/// shim we have no use for and is deliberately not extracted.
fn fetch_uv(dest: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let url = format!(
        "https://github.com/astral-sh/uv/releases/download/{UV_VERSION}/uv-{UV_TARGET}.tar.gz"
    );
    println!("cargo:warning=Downloading uv {UV_VERSION} for {UV_TARGET}...");
    println!("cargo:warning=URL: {url}");

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR not set"));
    let archive = out_dir.join(format!("uv-{UV_TARGET}.tar.gz"));

    // Retried, because this genuinely flakes on an ordinary (not broken, just
    // not fast) network — see [`http_client`]'s doc for the real cause (B-181:
    // it was a too-short implicit timeout, not a DNS/TLS blip as first
    // suspected). The hash check below means a retry can never paper over a
    // *bad* download — only over a missing one.
    let client = http_client()?;
    let mut last_err = String::new();
    let mut downloaded = false;
    for attempt in 1..=3 {
        match client.get(&url).send().and_then(|r| r.error_for_status()) {
            Ok(mut response) => {
                let mut file = fs::File::create(&archive)?;
                response.copy_to(&mut file)?;
                downloaded = true;
                break;
            }
            Err(e) => {
                last_err = e.to_string();
                println!("cargo:warning=uv download attempt {attempt}/3 failed: {e}");
                std::thread::sleep(std::time::Duration::from_secs(2 * attempt));
            }
        }
    }
    if !downloaded {
        return Err(format!("could not download {url}: {last_err}").into());
    }

    // Verify BEFORE unpacking. Feeding an unverified archive to a tar reader is
    // exactly the step that must not happen on a corrupt or substituted download.
    if !verify_sha256(&archive, UV_ARCHIVE_SHA256)? {
        fs::remove_file(&archive).ok();
        return Err(format!(
            "uv {UV_VERSION} archive failed sha256 verification (expected {UV_ARCHIVE_SHA256}). \
             Refusing to unpack it."
        )
        .into());
    }

    let member = format!("uv-{UV_TARGET}/uv");
    let reader = flate2::read::GzDecoder::new(fs::File::open(&archive)?);
    let mut found = false;
    for entry in tar::Archive::new(reader).entries()? {
        let mut entry = entry?;
        if entry.path()?.to_string_lossy() == member {
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)?;
            }
            entry.unpack(dest)?;
            found = true;
            break;
        }
    }
    fs::remove_file(&archive).ok();
    if !found {
        return Err(format!("uv {UV_VERSION} archive contains no `{member}`").into());
    }

    // The extracted bytes get their own check: the archive hash proves what we
    // downloaded, this proves what we are about to ship.
    if !verify_sha256(dest, UV_BINARY_SHA256)? {
        fs::remove_file(dest).ok();
        return Err(format!(
            "the uv executable extracted from a valid archive does not match \
             {UV_BINARY_SHA256} — refusing to bundle it."
        )
        .into());
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dest, fs::Permissions::from_mode(0o755))?;
    }

    println!("cargo:warning=uv {UV_VERSION} verified and staged at {dest:?}");
    Ok(())
}

/// Stage `uv` for `externalBin` if this target is the one we bundle it for, skipping
/// the download when a valid copy is already staged (same shape as the ONNX check).
fn stage_uv(manifest_dir: &Path, target_os: &str, target_arch: &str) {
    if (target_os, target_arch) != ("macos", "aarch64") {
        println!(
            "cargo:warning=Not staging uv for {target_os}-{target_arch}: the AI-env bootstrap \
             (D-315) is wired up for macOS ARM only, which is v1's one platform."
        );
        return;
    }

    let dest = manifest_dir
        .join("binaries")
        .join(format!("uv-{UV_TARGET}"));

    if dest.exists() {
        match verify_sha256(&dest, UV_BINARY_SHA256) {
            Ok(true) => {
                println!(
                    "cargo:warning=uv {UV_VERSION} already staged and valid. Skipping download."
                );
                return;
            }
            Ok(false) => {
                println!(
                    "cargo:warning=Staged uv has the wrong hash (stale pin?). Re-downloading."
                );
                fs::remove_file(&dest).ok();
            }
            Err(e) => println!("cargo:warning=Could not verify staged uv: {e}. Re-downloading."),
        }
    }

    if let Err(e) = fetch_uv(&dest) {
        panic!("Failed to download and verify uv {UV_VERSION}: {e}");
    }
}

// ---- ffmpeg + ffprobe: the media toolchain every decode/probe/export runs (D-389) ----
//
// Every frame Apelles shows, every probe, thumbnail, filmstrip tile and export goes
// through an `ffmpeg`/`ffprobe` child process (D-015). Until D-389 the app ran
// whatever `ffmpeg` its PATH happened to hold, so a release build opened from Finder
// (which inherits launchd's minimal PATH, with no `/opt/homebrew/bin`) could decode
// nothing at all (B-253). Both binaries are now bundled as Tauri `externalBin`s,
// fetched here at build time by the same pinned-version, pinned-sha256 pattern `uv`
// uses above, and found at runtime by `apelles_media::ffmpeg_locate`.
//
// The build: Martin Riedl's static macOS arm64 release build of FFmpeg 9.0.2
// (https://ffmpeg.martin-riedl.de; build script Apache-2.0 at
// https://git.martin-riedl.de/ffmpeg/build-script). It is configured
// `--enable-gpl --enable-version3`, so the binaries are GPL-3.0-or-later as
// distributed, which is compatible with shipping inside this AGPL-3.0 app (GPL-3.0
// §13 / AGPL-3.0 §13 explicitly allow combining the two). The licence text and the
// corresponding-source pointer ship in `resources/licenses/` (`GPL-3.0.txt`,
// `FFMPEG-NOTICE.txt`). Why this build, the alternatives, and the size cost: D-389
// in `docs/08-decisions.md`.

/// The pinned build's directory on the build server: `<unix build time>_<version>`.
/// Moving this means re-fetching ALL FOUR hashes below from the new build (the
/// archive hashes from its published `.sha256` files, the binary hashes by
/// unpacking), never hand-editing one of them.
const FFMPEG_BUILD: &str = "1789931890_9.0.2";

/// Same single-target rule as [`UV_TARGET`]: v1 ships macOS ARM only.
const FFMPEG_TARGET: &str = "aarch64-apple-darwin";

/// One bundled ffmpeg-suite binary: its name and its two pins.
struct FfBin {
    name: &'static str,
    /// sha256 of `<name>.zip`, from the build's published `<name>.zip.sha256`.
    archive_sha256: &'static str,
    /// sha256 of the executable inside it: what ships, and what the "already
    /// staged, skip the download" check re-verifies on every build.
    binary_sha256: &'static str,
}

const FF_BINS: [FfBin; 2] = [
    FfBin {
        name: "ffmpeg",
        archive_sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
        binary_sha256: "2e11c6f90993cdb79fff84d3f90044d28316b310e75b3e030cfc9a54f2c9d384",
    },
    FfBin {
        name: "ffprobe",
        archive_sha256: "fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6",
        binary_sha256: "2738aa46a7f9acbc8ab09a6715554c90f7de603171ac403726765685df6a0059",
    },
];

/// Download one pinned `<name>.zip`, verify it, and extract its single member to
/// `binaries/<name>-<target triple>`, the `externalBin` naming `fetch_uv` uses.
fn fetch_ff_bin(bin: &FfBin, dest: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let url = format!(
        "https://ffmpeg.martin-riedl.de/download/macos/arm64/{FFMPEG_BUILD}/{}.zip",
        bin.name
    );
    println!("cargo:warning=Downloading {} ({FFMPEG_BUILD})...", bin.name);
    println!("cargo:warning=URL: {url}");

    let out_dir = PathBuf::from(env::var("OUT_DIR")?);
    let archive = out_dir.join(format!("{}-{FFMPEG_BUILD}.zip", bin.name));

    // Retried for the same reason `fetch_uv` is (B-181). The hash check below
    // means a retry can only paper over a missing download, never a bad one.
    let client = http_client()?;
    let mut last_err = String::new();
    let mut downloaded = false;
    for attempt in 1..=3 {
        match client.get(&url).send().and_then(|r| r.error_for_status()) {
            Ok(mut response) => {
                let mut file = fs::File::create(&archive)?;
                response.copy_to(&mut file)?;
                downloaded = true;
                break;
            }
            Err(e) => {
                last_err = e.to_string();
                println!(
                    "cargo:warning={} download attempt {attempt}/3 failed: {e}",
                    bin.name
                );
                std::thread::sleep(std::time::Duration::from_secs(2 * attempt));
            }
        }
    }
    if !downloaded {
        return Err(format!("could not download {url}: {last_err}").into());
    }

    // Verify BEFORE unpacking, as with `uv`.
    if !verify_sha256(&archive, bin.archive_sha256)? {
        fs::remove_file(&archive).ok();
        return Err(format!(
            "{} archive failed sha256 verification (expected {}). Refusing to unpack it.",
            bin.name, bin.archive_sha256
        )
        .into());
    }

    let mut zip = zip::ZipArchive::new(fs::File::open(&archive)?)?;
    let mut member = zip.by_name(bin.name)?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    io::copy(&mut member, &mut fs::File::create(dest)?)?;
    drop(member);
    fs::remove_file(&archive).ok();

    // The archive hash proves what we downloaded; this proves what we ship.
    if !verify_sha256(dest, bin.binary_sha256)? {
        fs::remove_file(dest).ok();
        return Err(format!(
            "the {} executable extracted from a valid archive does not match {}; \
             refusing to bundle it.",
            bin.name, bin.binary_sha256
        )
        .into());
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dest, fs::Permissions::from_mode(0o755))?;
    }

    println!(
        "cargo:warning={} {FFMPEG_BUILD} verified and staged at {dest:?}",
        bin.name
    );
    Ok(())
}

/// Stage `ffmpeg` and `ffprobe` for `externalBin` on the one target they are
/// bundled for, skipping any already staged with the pinned hash.
fn stage_ffmpeg(manifest_dir: &Path, target_os: &str, target_arch: &str) {
    if (target_os, target_arch) != ("macos", "aarch64") {
        println!(
            "cargo:warning=Not staging ffmpeg for {target_os}-{target_arch}: the bundled \
             ffmpeg (D-389) is wired up for macOS ARM only, which is v1's one platform."
        );
        return;
    }

    for bin in &FF_BINS {
        let dest = manifest_dir
            .join("binaries")
            .join(format!("{}-{FFMPEG_TARGET}", bin.name));
        if dest.exists() {
            match verify_sha256(&dest, bin.binary_sha256) {
                Ok(true) => {
                    println!(
                        "cargo:warning={} {FFMPEG_BUILD} already staged and valid. Skipping download.",
                        bin.name
                    );
                    continue;
                }
                Ok(false) => {
                    println!(
                        "cargo:warning=Staged {} has the wrong hash (stale pin?). Re-downloading.",
                        bin.name
                    );
                    fs::remove_file(&dest).ok();
                }
                Err(e) => println!(
                    "cargo:warning=Could not verify staged {}: {e}. Re-downloading.",
                    bin.name
                ),
            }
        }
        if let Err(e) = fetch_ff_bin(bin, &dest) {
            panic!(
                "Failed to download and verify {} {FFMPEG_BUILD}: {e}",
                bin.name
            );
        }
    }
}

/// The two files the AI-env bootstrap reads at runtime, staged into the already-bundled
/// `resources/` directory (D-315).
///
/// They live at the workspace root in `ai-env/`, which is outside this crate, and a
/// Tauri `resources` entry that reaches out with `../..` is both fragile and awkward to
/// give a stable in-bundle path. Copying them in here instead means the existing
/// `"resources"` bundle entry picks them up unchanged, and `resources/ai-env/<file>` is
/// the one path the runtime resolver has to know — in a dev run and in a bundle alike.
///
/// `requirements.lock.txt` is what gets installed; `verify.py` is the import check that
/// decides whether an existing venv is actually usable. Both are also the *inputs* to
/// `ai-env/setup.sh`, so a human-run setup and an app-run bootstrap can never disagree
/// about what "installed" and "healthy" mean (`CLAUDE.md`: shared logic, never copied).
fn stage_ai_env_resources(manifest_dir: &Path) {
    let src_dir = manifest_dir.join("../../ai-env");
    let dest_dir = manifest_dir.join("resources").join("ai-env");

    for name in ["requirements.lock.txt", "verify.py"] {
        let src = src_dir.join(name);
        println!("cargo:rerun-if-changed={}", src.display());
        let Ok(bytes) = fs::read(&src) else {
            panic!(
                "D-315: {} is missing — the AI-env bootstrap cannot be built without it.",
                src.display()
            );
        };
        let dest = dest_dir.join(name);

        // B-177 — write ONLY when the content really differs. `fs::copy` bumps the
        // destination's mtime even when the bytes are identical, and `tauri dev`
        // watches `src-tauri/` for exactly that: the copy triggered a rebuild, the
        // rebuild re-ran this, and `npm run tauri:dev` never reached a running app.
        // The same "already valid, skip it" shape the ONNX download above uses, and
        // for the same reason.
        if fs::read(&dest).is_ok_and(|existing| existing == bytes) {
            continue;
        }
        if let Err(e) = fs::create_dir_all(&dest_dir).and_then(|()| fs::write(&dest, &bytes)) {
            panic!(
                "Failed to stage {} into resources/ai-env: {e}",
                src.display()
            );
        }
    }
}

fn main() {
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap();
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap();

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());

    let (download_filename, lib_name, expected_hash) =
        match (target_os.as_str(), target_arch.as_str()) {
            ("windows", "x86_64") => (
                "onnxruntime-windows-x86_64.dll",
                "onnxruntime.dll",
                "579b636403983254346a5c1d80bd28f1519cd1e284cd204f8d4ff41f8d711559",
            ),
            ("windows", "aarch64") => (
                "onnxruntime-windows-aarch64.dll",
                "onnxruntime.dll",
                "79281671a386ed1baab9dbdbb09fe55f99577011472e9526cf9d0b468bb6bcc7",
            ),
            ("linux", "x86_64") => (
                "libonnxruntime-linux-x86_64.so",
                "libonnxruntime.so",
                "3da6146e14e7b8aaec625dde11d6114c7457c87a5f93d744897da8781e35c673",
            ),
            ("linux", "aarch64") => (
                "libonnxruntime-linux-aarch64.so",
                "libonnxruntime.so",
                "0afd69a0ae38c5099fd0e8604dda398ac43dee67cd9c6394b5142b19e82528de",
            ),
            ("macos", "x86_64") => (
                "libonnxruntime-macos-x86_64.dylib",
                "libonnxruntime.dylib",
                "283e595e61cf65df7a6b1d59a1616cbd35c8b6399dd90d799d99b71a3ff83160",
            ),
            ("macos", "aarch64") => (
                "libonnxruntime-macos-aarch64.dylib",
                "libonnxruntime.dylib",
                "2b885992d3d6fa4130d39ec84a80d7504ff52750027c547bb22c86165f19406a",
            ),
            ("android", "aarch64") => (
                "libonnxruntime-android-arm64-v8a.so",
                "libonnxruntime.so",
                "999ecfdb5b5a13e4097487773b6d71ce8a075408a237daab072e8f5e817bd78e",
            ),
            _ => panic!("Unsupported target: {}-{}", target_os, target_arch),
        };

    let dest_dir = if target_os == "android" {
        manifest_dir.join("libs").join("arm64-v8a")
    } else {
        manifest_dir.join("resources")
    };

    fs::create_dir_all(&dest_dir).unwrap();
    let dest_path = dest_dir.join(lib_name);

    let mut is_valid = false;
    if dest_path.exists() {
        match verify_sha256(&dest_path, expected_hash) {
            Ok(true) => {
                println!(
                    "cargo:warning=ONNX Runtime library already exists and is valid. Skipping download."
                );
                is_valid = true;
            }
            Ok(false) => {
                println!(
                    "cargo:warning=File {:?} exists but has incorrect hash. Deleting and re-downloading.",
                    dest_path
                );
                fs::remove_file(&dest_path).unwrap();
            }
            Err(e) => {
                println!(
                    "cargo:warning=Could not verify file {:?}: {}. Re-downloading.",
                    dest_path, e
                );
            }
        }
    }

    if !is_valid {
        println!(
            "cargo:warning=Downloading ONNX Runtime library for {}-{}...",
            target_os, target_arch
        );
        let base_url =
            "https://huggingface.co/CyberTimon/RapidRAW-Models/resolve/main/onnxruntimes-v1.22.0/";
        let download_url = format!("{}{}?download=true", base_url, download_filename);
        println!("cargo:warning=URL: {}", download_url);

        if let Err(e) = download_and_verify(&download_url, &dest_path, expected_hash) {
            panic!("Failed to download and verify ONNX Runtime library: {}", e);
        }
    }

    if target_os == "android" {
        let jni_libs_dir = manifest_dir.join("gen/android/app/src/main/jniLibs/arm64-v8a");
        fs::create_dir_all(&jni_libs_dir).unwrap();
        fs::copy(&dest_path, jni_libs_dir.join(lib_name)).unwrap();

        println!("cargo:rustc-env=ORT_LIB_LOCATION={}", dest_dir.display());
        println!("cargo:rustc-env=ORT_STRATEGY=manual");
        println!("cargo:rustc-link-search=native={}", dest_dir.display());
    }

    // D-315: the Python toolchain the AI-env bootstrap drives, and the two files it
    // reads. Must run before `tauri_build::build()`, which is what copies
    // `externalBin` and `resources` into place.
    stage_uv(&manifest_dir, &target_os, &target_arch);
    // D-389: the bundled ffmpeg/ffprobe every decode, probe and export runs.
    stage_ffmpeg(&manifest_dir, &target_os, &target_arch);
    stage_ai_env_resources(&manifest_dir);

    println!("cargo:rerun-if-changed=build.rs");

    tauri_build::build()
}
