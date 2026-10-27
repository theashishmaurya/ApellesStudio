//! Custom Remotion components: the library, the static check, the
//! certification proof, project installs and live-preview proxy frames (D-409).
//!
//! **What it is:** the backend of a custom component's life — draft (code) →
//! checked → certified → used as data.
//!
//! - **Library.** One folder per version, `<root>/<id>/<version>/`, holding
//!   `component.tsx` (the source), `component.js` (the compiled module — the
//!   artifact that renders), `meta.json` (`ComponentMeta` in
//!   `packages/motion-engine/src/custom/componentDef.ts`) and, once proven,
//!   `contact.png` / `thumbnail.png`. Two roots: the built-ins beside the engine
//!   (`packages/motion-engine/components/`, read-only, their ids reserved) and
//!   the user's `<app data>/motion/components/`. [`load_library`] reads both; a
//!   bad entry drops itself with a named error and the rest load.
//! - **Check.** [`check_source`] runs `scripts/check-component.mts` in Node (the
//!   TypeScript compiler API: allowlisted imports, the AST ban list, a strict
//!   type-check) and returns its issues and, on success, the compiled module.
//! - **Draft.** [`write_draft`] stores a checked source as the id's open draft:
//!   the latest version when that is still a draft (replaced in place), else
//!   the next version. A certified version is never written again.
//! - **Proof.** [`prove`] renders the component's sample frames three ways at
//!   once — one in-order pass in a single browser tab, and two passes of fresh
//!   stills in two different out-of-order (backward-seeking) orders — compares
//!   the decoded pixels of every frame across the three, and tiles a contact
//!   sheet. The result is recorded on a draft.
//! - **Certify.** [`certify`] turns a draft whose proof passed for its CURRENT
//!   source and module into an immutable certified version.
//! - **Install.** [`install_into_project`] copies a certified module and its
//!   source into a project's asset folder, content-addressed
//!   ([`crate::assets::store_bytes`]), after re-checking their hashes against
//!   the certificate; the manifest then embeds the definition (copy semantics).
//! - **Proxy.** [`render_proxy`] renders one custom layer's frames as PNGs for
//!   the app's live player, which never runs component code itself.
//!
//! **Security boundary.** Component code only ever runs in the Remotion
//! renderer (`remotion render` / `still`: Node plus a headless Chrome, no Tauri
//! IPC). This module spawns those processes; it never evaluates anything.
//!
//! **What it does NOT do:** validate a spec's shape (the zod schema in
//! TypeScript is the one source of truth; the frontend checks it before calling
//! here), build the proof manifest (the frontend's `customComponents.ts` does,
//! from the spec), or decide anything about a manifest.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use apelles_types::ChromaError;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::assets::{sha256_hex, store_bytes};
use crate::still::{self, SequenceRequest, StillRequest};

pub const SOURCE_FILE: &str = "component.tsx";
pub const CODE_FILE: &str = "component.js";
pub const META_FILE: &str = "meta.json";
pub const CONTACT_FILE: &str = "contact.png";
pub const THUMBNAIL_FILE: &str = "thumbnail.png";
/// `ComponentMeta.schemaVersion` this build writes.
pub const META_SCHEMA_VERSION: u64 = 1;
/// The most frames one proof samples (the contact sheet's readable limit).
pub const MAX_PROOF_FRAMES: usize = 24;

/// `<app data>/motion/components` — the user's library.
pub fn components_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("motion").join("components")
}

/// `packages/motion-engine/components` — the built-ins, shipped as data.
pub fn builtin_components_dir(engine_dir: &Path) -> PathBuf {
    engine_dir.join("components")
}

/// The id rule (`COMPONENT_ID_PATTERN`): `[a-z0-9]`, then up to 63 of
/// `[a-z0-9-]` — a safe folder name.
pub fn is_component_id(id: &str) -> bool {
    crate::templates::is_template_id(id)
}

fn invalid(msg: impl Into<String>) -> ChromaError {
    ChromaError::Invalid(msg.into())
}

fn io_err(what: &str, path: &Path, e: std::io::Error) -> ChromaError {
    ChromaError::Invalid(format!("{what} {}: {e}", path.display()))
}

// ---------------------------------------------------------------------------
// library
// ---------------------------------------------------------------------------

/// Which root an entry came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntrySource {
    Builtin,
    Library,
}

/// One version that loaded.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub version: u32,
    pub source: EntrySource,
    /// The version folder (the GUI shows `contact.png` from here).
    pub dir: String,
    pub meta: Value,
}

/// One folder that could not be used, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LoadError {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Library {
    pub entries: Vec<Entry>,
    pub errors: Vec<LoadError>,
}

/// The numbered version folders of one id, ascending.
fn versions_of(id_dir: &Path) -> Vec<(u32, PathBuf)> {
    let mut out: Vec<(u32, PathBuf)> = std::fs::read_dir(id_dir)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    let v = name.parse::<u32>().ok().filter(|v| *v > 0)?;
                    e.path().is_dir().then(|| (v, e.path()))
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by_key(|(v, _)| *v);
    out
}

/// Read and sanity-check one version folder.
fn read_entry(id: &str, version: u32, dir: &Path) -> Result<Value, String> {
    let text =
        std::fs::read_to_string(dir.join(META_FILE)).map_err(|e| format!("{META_FILE}: {e}"))?;
    let meta: Value =
        serde_json::from_str(&text).map_err(|e| format!("{META_FILE} is not valid JSON: {e}"))?;
    if meta.get("id").and_then(Value::as_str) != Some(id) {
        return Err(format!(
            "{META_FILE}'s id is not \"{id}\" (the folder name)"
        ));
    }
    if meta.get("version").and_then(Value::as_u64) != Some(u64::from(version)) {
        return Err(format!(
            "{META_FILE}'s version is not {version} (the folder name)"
        ));
    }
    for f in [SOURCE_FILE, CODE_FILE] {
        if !dir.join(f).is_file() {
            return Err(format!("{f} is missing"));
        }
    }
    Ok(meta)
}

fn load_root(root: &Path, source: EntrySource, reserved: &[String], library: &mut Library) {
    let Ok(rd) = std::fs::read_dir(root) else {
        return;
    };
    let mut ids: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    ids.sort();
    for id_dir in ids {
        let id = id_dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if id.starts_with('.') {
            continue;
        }
        let path = id_dir.to_string_lossy().to_string();
        if !is_component_id(&id) {
            library.errors.push(LoadError {
                path,
                error: "not a component id (lowercase letters, digits, hyphens)".into(),
            });
            continue;
        }
        if source == EntrySource::Library && reserved.contains(&id) {
            library.errors.push(LoadError {
                path,
                error: format!("\"{id}\" is a built-in component's id"),
            });
            continue;
        }
        for (version, dir) in versions_of(&id_dir) {
            match read_entry(&id, version, &dir) {
                Ok(meta) => library.entries.push(Entry {
                    id: id.clone(),
                    version,
                    source,
                    dir: dir.to_string_lossy().to_string(),
                    meta,
                }),
                Err(error) => library.errors.push(LoadError {
                    path: dir.to_string_lossy().to_string(),
                    error,
                }),
            }
        }
    }
}

/// Every version under the built-in root and the user root. Absent roots are
/// empty, not errors; each bad folder is one named error.
pub fn load_library(builtin: Option<&Path>, user: &Path) -> Library {
    let mut library = Library::default();
    if let Some(b) = builtin {
        load_root(b, EntrySource::Builtin, &[], &mut library);
    }
    let reserved: Vec<String> = library.entries.iter().map(|e| e.id.clone()).collect();
    load_root(user, EntrySource::Library, &reserved, &mut library);
    library
}

/// The folder of `id`@`version` under whichever root holds it.
pub fn find_version(
    builtin: Option<&Path>,
    user: &Path,
    id: &str,
    version: u32,
) -> Option<PathBuf> {
    if !is_component_id(id) {
        return None;
    }
    builtin
        .into_iter()
        .chain(std::iter::once(user))
        .map(|root| root.join(id).join(version.to_string()))
        .find(|d| d.join(META_FILE).is_file())
}

/// One version's meta and source text.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionFiles {
    pub dir: String,
    pub meta: Value,
    pub source: String,
}

pub fn read_version(dir: &Path) -> Result<VersionFiles, ChromaError> {
    let meta_text = std::fs::read_to_string(dir.join(META_FILE))
        .map_err(|e| io_err("read", &dir.join(META_FILE), e))?;
    let meta: Value = serde_json::from_str(&meta_text)
        .map_err(|e| invalid(format!("{}: {e}", dir.join(META_FILE).display())))?;
    let source = std::fs::read_to_string(dir.join(SOURCE_FILE))
        .map_err(|e| io_err("read", &dir.join(SOURCE_FILE), e))?;
    Ok(VersionFiles {
        dir: dir.to_string_lossy().to_string(),
        meta,
        source,
    })
}

/// Write `bytes` to `path` atomically (a `.part` sibling, synced, renamed).
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), ChromaError> {
    let part = path.with_extension(format!(
        "{}.part",
        path.extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default()
    ));
    {
        let mut f = std::fs::File::create(&part).map_err(|e| io_err("create", &part, e))?;
        f.write_all(bytes)
            .and_then(|()| f.sync_all())
            .map_err(|e| io_err("write", &part, e))?;
    }
    std::fs::rename(&part, path).map_err(|e| io_err("move into", path, e))
}

fn write_meta(dir: &Path, meta: &Value) -> Result<(), ChromaError> {
    let mut text = serde_json::to_string_pretty(meta).map_err(|e| invalid(e.to_string()))?;
    text.push('\n');
    write_atomic(&dir.join(META_FILE), text.as_bytes())
}

fn status_of(meta: &Value) -> &str {
    meta.get("status").and_then(Value::as_str).unwrap_or("")
}

// ---------------------------------------------------------------------------
// static check (Node)
// ---------------------------------------------------------------------------

/// What `scripts/check-component.mts` reports.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct CheckReport {
    pub ok: bool,
    #[serde(default)]
    pub issues: Vec<Value>,
    #[serde(default)]
    pub warnings: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

/// `node scripts/check-component.mts` in the engine folder — pure. Node runs
/// the TypeScript directly (type stripping); the one warning silenced is the
/// "module type not specified" notice for the engine's own sources.
pub fn build_check_command(engine_dir: &Path) -> Command {
    let mut cmd = Command::new("node");
    cmd.current_dir(engine_dir);
    cmd.args([
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        "scripts/check-component.mts",
    ]);
    cmd
}

/// Run the static check on `source` (blocking; a few seconds for the type
/// check). A source that fails is `Ok` with `ok: false`; `Err` means the check
/// itself could not run.
pub fn check_source(engine_dir: &Path, source: &str) -> Result<CheckReport, ChromaError> {
    let mut child = build_check_command(engine_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| invalid(format!("failed to spawn node for the component check: {e}")))?;
    let input = json!({ "source": source }).to_string();
    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| invalid("component check: no stdin"))?;
        stdin
            .write_all(input.as_bytes())
            .map_err(|e| invalid(format!("component check: write stdin: {e}")))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| invalid(format!("component check: {e}")))?;
    if !output.status.success() {
        return Err(invalid(format!(
            "component check exited {}: {}",
            output
                .status
                .code()
                .map_or_else(|| "signal".to_string(), |c| c.to_string()),
            crate::tail(&String::from_utf8_lossy(&output.stderr), 20)
        )));
    }
    serde_json::from_slice(&output.stdout).map_err(|e| {
        invalid(format!(
            "component check printed something that is not its report: {e}"
        ))
    })
}

// ---------------------------------------------------------------------------
// drafts, certification, deletion
// ---------------------------------------------------------------------------

/// A stored draft.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftOutcome {
    pub id: String,
    pub version: u32,
    /// `true` when it replaced the id's open draft (same version number).
    pub replaced: bool,
    pub dir: String,
    pub meta: Value,
}

/// Store a checked source as `spec.id`'s open draft. `report` must be the
/// passing check of exactly `source`. Refused for a built-in id and for an
/// unsafe one. The version is the latest one if that is still a draft
/// (replaced in place: nothing can pin a draft), else the next number.
pub fn write_draft(
    builtin: Option<&Path>,
    user: &Path,
    spec: &Value,
    source: &str,
    report: &CheckReport,
) -> Result<DraftOutcome, ChromaError> {
    let id = spec
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("the spec has no string \"id\""))?
        .to_string();
    if !is_component_id(&id) {
        return Err(invalid(format!(
            "component id \"{id}\" must be lowercase letters, digits and hyphens (at most 64)"
        )));
    }
    if builtin.is_some_and(|b| b.join(&id).is_dir()) {
        return Err(invalid(format!(
            "\"{id}\" is a built-in component; write yours under another id"
        )));
    }
    let code = match (&report.code, report.ok) {
        (Some(code), true) => code,
        _ => return Err(invalid("the source did not pass the static check")),
    };
    let id_dir = user.join(&id);
    std::fs::create_dir_all(&id_dir).map_err(|e| io_err("create", &id_dir, e))?;
    let latest = versions_of(&id_dir).pop();
    let (version, replaced) = match &latest {
        Some((v, dir)) => {
            let open_draft = read_entry(&id, *v, dir)
                .map(|m| status_of(&m) == "draft")
                .unwrap_or(false);
            if open_draft {
                (*v, true)
            } else {
                (*v + 1, false)
            }
        }
        None => (1, false),
    };

    let mut meta = spec.clone();
    let obj = meta
        .as_object_mut()
        .ok_or_else(|| invalid("the spec is not an object"))?;
    obj.insert("schemaVersion".into(), json!(META_SCHEMA_VERSION));
    obj.insert("version".into(), json!(version));
    obj.insert("status".into(), json!("draft"));
    obj.insert("sourceHash".into(), json!(sha256_hex(source.as_bytes())));
    obj.insert("codeHash".into(), json!(sha256_hex(code.as_bytes())));
    obj.insert("warnings".into(), json!(report.warnings));
    obj.remove("proof");
    obj.remove("certified");

    // Stage the whole version, then move it into place in one rename.
    let staging = id_dir.join(format!(".staging-{version}"));
    if staging.exists() {
        std::fs::remove_dir_all(&staging).map_err(|e| io_err("clear", &staging, e))?;
    }
    std::fs::create_dir_all(&staging).map_err(|e| io_err("create", &staging, e))?;
    write_atomic(&staging.join(SOURCE_FILE), source.as_bytes())?;
    write_atomic(&staging.join(CODE_FILE), code.as_bytes())?;
    write_meta(&staging, &meta)?;
    let target = id_dir.join(version.to_string());
    if replaced {
        let trash = id_dir.join(format!(".trash-{version}"));
        if trash.exists() {
            std::fs::remove_dir_all(&trash).map_err(|e| io_err("clear", &trash, e))?;
        }
        std::fs::rename(&target, &trash).map_err(|e| io_err("move aside", &target, e))?;
        std::fs::rename(&staging, &target).map_err(|e| io_err("move into", &target, e))?;
        // The old draft is unreachable now; failing to delete it costs disk only.
        let _ = std::fs::remove_dir_all(&trash);
    } else {
        std::fs::rename(&staging, &target).map_err(|e| io_err("move into", &target, e))?;
    }
    Ok(DraftOutcome {
        id,
        version,
        replaced,
        dir: target.to_string_lossy().to_string(),
        meta,
    })
}

/// The SHA-256 of the files actually on disk: `(source, code)`.
fn file_hashes(dir: &Path) -> Result<(String, String), ChromaError> {
    let read = |f: &str| std::fs::read(dir.join(f)).map_err(|e| io_err("read", &dir.join(f), e));
    Ok((
        sha256_hex(&read(SOURCE_FILE)?),
        sha256_hex(&read(CODE_FILE)?),
    ))
}

/// Certify a proven draft: its proof passed, and was made for the source and
/// module on disk now (which are also the ones its meta names). Writes the
/// certificate into `meta.json`; from then on the version is immutable.
pub fn certify(dir: &Path) -> Result<Value, ChromaError> {
    let VersionFiles { mut meta, .. } = read_version(dir)?;
    let label = format!(
        "{}@{}",
        meta.get("id").and_then(Value::as_str).unwrap_or("?"),
        meta.get("version").and_then(Value::as_u64).unwrap_or(0)
    );
    if status_of(&meta) == "certified" {
        return Err(invalid(format!(
            "{label} is already certified (certified versions are immutable)"
        )));
    }
    let (source_hash, code_hash) = file_hashes(dir)?;
    let named = |k: &str| {
        meta.get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    if named("sourceHash") != source_hash || named("codeHash") != code_hash {
        return Err(invalid(format!(
            "{label}'s files no longer match its meta.json; write it again"
        )));
    }
    let proof = meta.get("proof").ok_or_else(|| {
        invalid(format!(
            "{label} has not been checked yet: run the certification check first"
        ))
    })?;
    if proof.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(invalid(format!(
            "{label}'s certification check did not pass; fix the component and check again"
        )));
    }
    let proven = |k: &str| proof.get(k).and_then(Value::as_str).unwrap_or("");
    if proven("sourceHash") != source_hash || proven("codeHash") != code_hash {
        return Err(invalid(format!(
            "{label}'s check was for different code; run the certification check again"
        )));
    }
    let obj = meta
        .as_object_mut()
        .ok_or_else(|| invalid("meta.json is not an object"))?;
    obj.insert("status".into(), json!("certified"));
    obj.insert(
        "certified".into(),
        json!({ "sourceHash": source_hash, "codeHash": code_hash }),
    );
    write_meta(dir, &meta)?;
    Ok(meta)
}

/// Remove one version, or every version of `id` (`version: None`), from the
/// user library. Projects that used it keep their copies. Returns how many
/// versions were removed.
pub fn delete(user: &Path, id: &str, version: Option<u32>) -> Result<usize, ChromaError> {
    if !is_component_id(id) {
        return Err(invalid(format!("\"{id}\" is not a component id")));
    }
    let id_dir = user.join(id);
    if !id_dir.is_dir() {
        return Ok(0);
    }
    let targets: Vec<PathBuf> = versions_of(&id_dir)
        .into_iter()
        .filter(|(v, _)| version.is_none_or(|want| want == *v))
        .map(|(_, d)| d)
        .collect();
    for d in &targets {
        std::fs::remove_dir_all(d).map_err(|e| io_err("remove", d, e))?;
    }
    if versions_of(&id_dir).is_empty() {
        let _ = std::fs::remove_dir_all(&id_dir);
    }
    Ok(targets.len())
}

// ---------------------------------------------------------------------------
// install into a project
// ---------------------------------------------------------------------------

/// What a project needs to embed a certified component.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    /// `sha256:<hex>.js` in the project's asset folder
    pub code: String,
    /// `sha256:<hex>.tsx` in the project's asset folder
    pub source: String,
    pub code_hash: String,
    pub source_hash: String,
    pub meta: Value,
}

/// Copy a CERTIFIED version's module and source into `assets_dir`, after
/// checking the files still hash to what its certificate covers (a hand-edited
/// library file is refused, not installed).
pub fn install_into_project(dir: &Path, assets_dir: &Path) -> Result<Installed, ChromaError> {
    let VersionFiles { meta, source, .. } = read_version(dir)?;
    if status_of(&meta) != "certified" {
        return Err(invalid(
            "only a certified component can be used in a project; certify it first",
        ));
    }
    let code =
        std::fs::read(dir.join(CODE_FILE)).map_err(|e| io_err("read", &dir.join(CODE_FILE), e))?;
    let (source_hash, code_hash) = (sha256_hex(source.as_bytes()), sha256_hex(&code));
    let cert = meta.get("certified").cloned().unwrap_or(Value::Null);
    if cert.get("sourceHash").and_then(Value::as_str) != Some(source_hash.as_str())
        || cert.get("codeHash").and_then(Value::as_str) != Some(code_hash.as_str())
    {
        return Err(invalid(format!(
            "{}: the files do not match the certificate; the library entry was changed after certification",
            dir.display()
        )));
    }
    let (code_id, _) = store_bytes(&code, "js", assets_dir)?;
    let (source_id, _) = store_bytes(source.as_bytes(), "tsx", assets_dir)?;
    Ok(Installed {
        code: code_id,
        source: source_id,
        code_hash,
        source_hash,
        meta,
    })
}

// ---------------------------------------------------------------------------
// certification proof
// ---------------------------------------------------------------------------

/// One sampled variant: its name (`defaults`, `min`, `max`, …) and the
/// ABSOLUTE frames of the proof manifest to sample, in timeline order.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct ProofVariant {
    pub name: String,
    pub frames: Vec<u32>,
}

/// What the frontend's `customComponents.ts` builds from the spec: a manifest
/// with one scene per variant, each holding one layer of the component, and
/// the frames to sample.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct ProofPlan {
    pub manifest: Value,
    pub variants: Vec<ProofVariant>,
    pub scale: f64,
}

/// The finished proof (also written into a draft's `meta.json`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofOutcome {
    pub proof: Value,
    /// absolute path of the contact sheet, when one was rendered
    pub contact_sheet: Option<String>,
    pub thumbnail: Option<String>,
    /// `false` for a certified version: re-proved, nothing written
    pub recorded: bool,
}

/// The frames in the order pass B renders them: every variant backwards, the
/// last variant first — each still a backward seek from the one before.
pub fn order_backwards(samples: &[(usize, u32)]) -> Vec<(usize, u32)> {
    samples.iter().rev().copied().collect()
}

/// The order pass C renders them: within each variant, start at its middle,
/// jump to its end, then back to its start (`[m, last, 0, …]`), variants in
/// order — out of order in a different way from pass B.
pub fn order_scrambled(samples: &[(usize, u32)]) -> Vec<(usize, u32)> {
    let mut out = Vec::with_capacity(samples.len());
    let mut i = 0;
    while i < samples.len() {
        let variant = samples[i].0;
        let group: Vec<(usize, u32)> = samples[i..]
            .iter()
            .take_while(|(v, _)| *v == variant)
            .copied()
            .collect();
        // `group` is non-empty: it holds at least `samples[i]`.
        let (head, last) = group.split_at(group.len() - 1);
        out.extend_from_slice(last);
        let rot = (group.len() / 2).min(head.len());
        out.extend_from_slice(&head[rot..]);
        out.extend_from_slice(&head[..rot]);
        i += group.len();
    }
    out
}

/// How far the in-order pass may drift from a fresh still, per channel. Chrome's
/// GPU rasterizer can land one level apart on anti-aliased edges between a tab
/// that has drawn earlier frames and a fresh page (measured on the particle
/// example: 1-8 pixels of a 480x270 frame, each off by 1/255), which says
/// nothing about the component. State a component carries between frames moves
/// whole shapes: far more pixels, by far more.
pub const IN_ORDER_MAX_DELTA: u8 = 2;
/// ...and on at most this fraction of the frame's pixels.
pub const IN_ORDER_MAX_FRACTION: f64 = 0.001;

/// The difference between two renders of one frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelDrift {
    /// the largest per-channel difference, 0..=255
    pub max_delta: u8,
    /// how many pixels differ at all
    pub pixels: u64,
    /// pixels in the frame
    pub total: u64,
}

impl PixelDrift {
    pub fn within_tolerance(&self) -> bool {
        self.max_delta <= IN_ORDER_MAX_DELTA
            && (self.pixels as f64) <= (self.total as f64) * IN_ORDER_MAX_FRACTION
    }
}

/// Compare two PNGs pixel by pixel (different sizes are maximal drift).
pub fn pixel_drift(a: &Path, b: &Path) -> Result<PixelDrift, ChromaError> {
    let load = |p: &Path| {
        image::open(p)
            .map(|i| i.to_rgba8())
            .map_err(|e| invalid(format!("decode {}: {e}", p.display())))
    };
    let (a, b) = (load(a)?, load(b)?);
    let total = u64::from(a.width()) * u64::from(a.height());
    if a.dimensions() != b.dimensions() {
        return Ok(PixelDrift {
            max_delta: u8::MAX,
            pixels: total,
            total,
        });
    }
    let mut max_delta = 0u8;
    let mut pixels = 0u64;
    for (pa, pb) in a.pixels().zip(b.pixels()) {
        let d =
            pa.0.iter()
                .zip(pb.0.iter())
                .map(|(x, y)| x.abs_diff(*y))
                .max()
                .unwrap_or(0);
        if d > 0 {
            pixels += 1;
            max_delta = max_delta.max(d);
        }
    }
    Ok(PixelDrift {
        max_delta,
        pixels,
        total,
    })
}

/// Hash a PNG's decoded RGBA pixels (so two encoders of the same pixels agree).
pub fn pixel_hash(path: &Path) -> Result<String, ChromaError> {
    let img = image::open(path)
        .map_err(|e| invalid(format!("decode {}: {e}", path.display())))?
        .to_rgba8();
    let mut hasher = blake3::Hasher::new();
    hasher.update(&img.width().to_le_bytes());
    hasher.update(&img.height().to_le_bytes());
    hasher.update(img.as_raw());
    Ok(hasher.finalize().to_hex().to_string())
}

/// Render `order` as fresh stills into `dir`; returns `(sample index, file)`.
fn still_pass(
    engine_dir: &Path,
    bundle: &Path,
    manifest_path: &Path,
    dir: &Path,
    order: &[(usize, u32)],
    index_of: &dyn Fn(&(usize, u32)) -> usize,
    scale: f64,
) -> Result<Vec<(usize, PathBuf)>, ChromaError> {
    std::fs::create_dir_all(dir).map_err(|e| io_err("create", dir, e))?;
    let mut out = Vec::with_capacity(order.len());
    for (k, sample) in order.iter().enumerate() {
        let file = dir.join(format!("{k:02}-f{}.png", sample.1));
        still::render_still(&StillRequest {
            engine_dir: engine_dir.to_path_buf(),
            bundle_dir: bundle.to_path_buf(),
            manifest_path: manifest_path.to_path_buf(),
            output_path: file.clone(),
            frame: sample.1,
            scale,
            composition_id: "Animation".into(),
        })?;
        out.push((index_of(sample), file));
    }
    Ok(out)
}

/// A proof pass's result; a pass that panicked is a failed pass, not a crash.
fn joined<T>(
    h: std::thread::ScopedJoinHandle<'_, Result<T, ChromaError>>,
) -> Result<T, ChromaError> {
    h.join()
        .unwrap_or_else(|_| Err(invalid("a proof pass panicked")))
}

/// Where a proof works: `<cache>/proof/<id>-<version>/`.
fn proof_work_dir(cache_dir: &Path, id: &str, version: u32) -> PathBuf {
    cache_dir.join("proof").join(format!("{id}-{version}"))
}

/// Certification's proof for the version in `dir` (see the module header).
/// `cache_dir` holds the proof bundles and scratch renders. For a draft the
/// result, contact sheet and thumbnail are recorded in the version folder; a
/// certified version can be re-proved, but nothing is written to it.
pub fn prove(
    engine_dir: &Path,
    cache_dir: &Path,
    dir: &Path,
    plan: &ProofPlan,
) -> Result<ProofOutcome, ChromaError> {
    let VersionFiles { mut meta, .. } = read_version(dir)?;
    let id = meta
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let version = u32::try_from(meta.get("version").and_then(Value::as_u64).unwrap_or(0))
        .map_err(|_| invalid("meta.json version out of range"))?;
    let (source_hash, code_hash) = file_hashes(dir)?;
    let code =
        std::fs::read(dir.join(CODE_FILE)).map_err(|e| io_err("read", &dir.join(CODE_FILE), e))?;

    // The plan must render THIS module: its manifest embeds this id@version
    // naming exactly these bytes.
    let key = format!("{id}@{version}");
    let embedded = plan
        .manifest
        .get("components")
        .and_then(|c| c.get(&key))
        .ok_or_else(|| invalid(format!("the proof manifest does not embed {key}")))?;
    if embedded.get("code").and_then(Value::as_str)
        != Some(format!("sha256:{code_hash}.js").as_str())
    {
        return Err(invalid(format!(
            "the proof manifest's {key} is not the module on disk"
        )));
    }
    let samples: Vec<(usize, u32)> = plan
        .variants
        .iter()
        .enumerate()
        .flat_map(|(v, variant)| variant.frames.iter().map(move |f| (v, *f)))
        .collect();
    if samples.is_empty() || samples.len() > MAX_PROOF_FRAMES {
        return Err(invalid(format!(
            "a proof samples 1..={MAX_PROOF_FRAMES} frames (got {})",
            samples.len()
        )));
    }
    if !(plan.scale > 0.0 && plan.scale <= 1.0) {
        return Err(invalid(format!(
            "scale must be in (0, 1], got {}",
            plan.scale
        )));
    }

    // Stage: the module as the bundle's public folder, the manifest beside it.
    let work = proof_work_dir(cache_dir, &id, version);
    if work.exists() {
        std::fs::remove_dir_all(&work).map_err(|e| io_err("clear", &work, e))?;
    }
    let public = cache_dir.join("proof-public").join(&code_hash[..16]);
    store_bytes(&code, "js", &public)?;
    std::fs::create_dir_all(&work).map_err(|e| io_err("create", &work, e))?;
    let manifest_path = work.join("proof.props.json");
    std::fs::write(&manifest_path, plan.manifest.to_string())
        .map_err(|e| io_err("write", &manifest_path, e))?;
    let bundle = still::ensure_bundle(engine_dir, &cache_dir.join("bundles"), Some(&public))?;

    let last = samples.iter().map(|s| s.1).max().unwrap_or(0);
    let index_of = |s: &(usize, u32)| samples.iter().position(|x| x == s).unwrap_or(0);
    let order_b = order_backwards(&samples);
    let order_c = order_scrambled(&samples);
    let passes = [
        format!(
            "in order: every frame 0..=last in one browser tab (--concurrency=1), within {IN_ORDER_MAX_DELTA}/255 on at most {}% of pixels of the fresh stills",
            IN_ORDER_MAX_FRACTION * 100.0
        ),
        format!(
            "fresh stills, backwards: {:?}",
            order_b.iter().map(|s| s.1).collect::<Vec<_>>()
        ),
        format!(
            "fresh stills, scrambled: {:?}",
            order_c.iter().map(|s| s.1).collect::<Vec<_>>()
        ),
    ];

    // The three passes run at once (B-278: each process has its own port).
    let (seq, pass_b, pass_c) = std::thread::scope(|scope| {
        let seq = scope.spawn(|| {
            still::render_sequence(&SequenceRequest {
                engine_dir: engine_dir.to_path_buf(),
                bundle_dir: bundle.clone(),
                manifest_path: manifest_path.clone(),
                out_dir: work.join("in-order"),
                frames: (0, last),
                scale: plan.scale,
                concurrency: Some(1),
            })
        });
        let b = scope.spawn(|| {
            still_pass(
                engine_dir,
                &bundle,
                &manifest_path,
                &work.join("backwards"),
                &order_b,
                &index_of,
                plan.scale,
            )
        });
        let c = scope.spawn(|| {
            still_pass(
                engine_dir,
                &bundle,
                &manifest_path,
                &work.join("scrambled"),
                &order_c,
                &index_of,
                plan.scale,
            )
        });
        (joined(seq), joined(b), joined(c))
    });

    let mut rows = Vec::with_capacity(samples.len());
    let mut all_same = true;
    let mut error = None;
    match (seq, pass_b, pass_c) {
        (Ok(seq), Ok(b), Ok(c)) => {
            let by_index = |pass: &[(usize, PathBuf)], i: usize| {
                pass.iter().find(|(k, _)| *k == i).map(|(_, p)| p.clone())
            };
            for (i, (v, frame)) in samples.iter().enumerate() {
                let files = [
                    seq.iter().find(|(f, _)| f == frame).map(|(_, p)| p.clone()),
                    by_index(&b, i),
                    by_index(&c, i),
                ];
                let mut hashes = Vec::with_capacity(3);
                for f in files.iter() {
                    match f {
                        Some(p) => hashes.push(pixel_hash(p)?),
                        None => hashes.push(String::new()),
                    }
                }
                // The two fresh-still passes must agree bit for bit; the in-order
                // pass within the rasterizer tolerance (see `IN_ORDER_MAX_DELTA`).
                let stills_same = !hashes[1].is_empty() && hashes[1] == hashes[2];
                let drift = match (&files[0], &files[1]) {
                    (Some(a), Some(b)) => Some(pixel_drift(a, b)?),
                    _ => None,
                };
                let in_order_ok = drift.is_some_and(|d| d.within_tolerance());
                let same = stills_same && in_order_ok;
                all_same &= same;
                rows.push(json!({
                    "variant": plan.variants[*v].name,
                    "frame": frame,
                    "hashes": hashes,
                    "same": same,
                    "inOrderMaxDelta": drift.map(|d| d.max_delta),
                    "inOrderPixels": drift.map(|d| d.pixels),
                }));
            }
            // The contact sheet: pass B's stills in timeline order.
            let tiles: Vec<PathBuf> = (0..samples.len()).filter_map(|i| by_index(&b, i)).collect();
            if tiles.len() == samples.len() {
                let sheet = work.join(CONTACT_FILE);
                still::contact_sheet(&tiles, &sheet)?;
                let thumb_index = plan.variants.first().map_or(0, |v| v.frames.len() / 2);
                std::fs::copy(
                    &tiles[thumb_index.min(tiles.len() - 1)],
                    work.join(THUMBNAIL_FILE),
                )
                .map_err(|e| io_err("copy", &work.join(THUMBNAIL_FILE), e))?;
            }
        }
        (s, b, c) => {
            all_same = false;
            error = [s.err(), b.err(), c.err()]
                .into_iter()
                .flatten()
                .map(|e| e.to_string())
                .next();
        }
    }

    let rendered = work.join(CONTACT_FILE).is_file();
    let mut proof = json!({
        "ok": all_same && error.is_none(),
        "sourceHash": source_hash,
        "codeHash": code_hash,
        "frames": rows,
        "passes": passes,
    });
    if let Some(e) = &error {
        proof["error"] = json!(e);
    }
    if rendered {
        proof["contactSheet"] = json!(CONTACT_FILE);
        proof["thumbnail"] = json!(THUMBNAIL_FILE);
    }

    let recorded = status_of(&meta) == "draft";
    let (contact_sheet, thumbnail) = if recorded {
        if rendered {
            for f in [CONTACT_FILE, THUMBNAIL_FILE] {
                let bytes =
                    std::fs::read(work.join(f)).map_err(|e| io_err("read", &work.join(f), e))?;
                write_atomic(&dir.join(f), &bytes)?;
            }
        }
        meta["proof"] = proof.clone();
        write_meta(dir, &meta)?;
        (dir.join(CONTACT_FILE), dir.join(THUMBNAIL_FILE))
    } else {
        (work.join(CONTACT_FILE), work.join(THUMBNAIL_FILE))
    };
    Ok(ProofOutcome {
        proof,
        contact_sheet: rendered.then(|| contact_sheet.to_string_lossy().to_string()),
        thumbnail: rendered.then(|| thumbnail.to_string_lossy().to_string()),
        recorded,
    })
}

// ---------------------------------------------------------------------------
// live-preview proxy frames
// ---------------------------------------------------------------------------

/// One custom layer's proxy render.
#[derive(Debug, Clone)]
pub struct ProxyRequest {
    pub engine_dir: PathBuf,
    /// where the project's preview bundles are cached (shared with stills)
    pub bundle_cache: PathBuf,
    /// `<project>/motion/cache/proxy`
    pub out_root: PathBuf,
    /// the one-layer manifest the frontend built (`customProxy.ts`)
    pub manifest: Value,
    /// the project's asset folder (the component's module is in it)
    pub public_dir: Option<PathBuf>,
    pub scale: f64,
}

/// The rendered frames, in frame order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyOutcome {
    pub dir: String,
    pub files: Vec<String>,
    pub cached: bool,
}

const PROXY_DONE: &str = "done.json";

/// The cache key of a proxy: a content hash of the manifest and scale, so the
/// same layer at the same frame always maps to the same folder.
pub fn proxy_key(manifest: &Value, scale: f64) -> String {
    let mut h = blake3::Hasher::new();
    h.update(manifest.to_string().as_bytes());
    h.update(&scale.to_le_bytes());
    h.finalize().to_hex()[..16].to_string()
}

/// Render (or reuse) every frame of a one-layer proxy manifest.
pub fn render_proxy(req: &ProxyRequest) -> Result<ProxyOutcome, ChromaError> {
    let key = proxy_key(&req.manifest, req.scale);
    let dir = req.out_root.join(&key);
    if let Ok(text) = std::fs::read_to_string(dir.join(PROXY_DONE))
        && let Ok(mut done) = serde_json::from_str::<ProxyOutcome>(&text)
    {
        done.cached = true;
        return Ok(done);
    }
    let fps = req
        .manifest
        .get("fps")
        .and_then(Value::as_f64)
        .unwrap_or(30.0);
    let dur = req
        .manifest
        .get("scenes")
        .and_then(|s| s.get(0))
        .and_then(|s| s.get("dur"))
        .and_then(Value::as_f64)
        .ok_or_else(|| invalid("a proxy manifest has one scene with a dur"))?;
    let frames = (dur * fps).round().max(1.0) as u32;
    let staging = req.out_root.join(format!(".staging-{key}"));
    if staging.exists() {
        std::fs::remove_dir_all(&staging).map_err(|e| io_err("clear", &staging, e))?;
    }
    std::fs::create_dir_all(&staging).map_err(|e| io_err("create", &staging, e))?;
    let manifest_path = staging.join("proxy.props.json");
    std::fs::write(&manifest_path, req.manifest.to_string())
        .map_err(|e| io_err("write", &manifest_path, e))?;
    let bundle = still::ensure_bundle(
        &req.engine_dir,
        &req.bundle_cache,
        req.public_dir.as_deref(),
    )?;
    let rendered = still::render_sequence(&SequenceRequest {
        engine_dir: req.engine_dir.clone(),
        bundle_dir: bundle,
        manifest_path,
        out_dir: staging.join("frames"),
        frames: (0, frames - 1),
        scale: req.scale,
        concurrency: None,
    })?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| io_err("clear", &dir, e))?;
    }
    std::fs::rename(&staging, &dir).map_err(|e| io_err("move into", &dir, e))?;
    let files = rendered
        .iter()
        .filter_map(|(_, p)| {
            p.file_name()
                .map(|n| dir.join("frames").join(n).to_string_lossy().to_string())
        })
        .collect();
    let outcome = ProxyOutcome {
        dir: dir.to_string_lossy().to_string(),
        files,
        cached: false,
    };
    let text = serde_json::to_string(&outcome).map_err(|e| invalid(e.to_string()))?;
    write_atomic(&dir.join(PROXY_DONE), text.as_bytes())?;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(id: &str) -> Value {
        json!({
            "id": id,
            "name": "Burst",
            "props": [{"id": "count", "type": "number", "label": "Count", "default": 10}],
            "size": {"w": 400, "h": 300},
            "duration": 2
        })
    }

    fn passing(code: &str) -> CheckReport {
        CheckReport {
            ok: true,
            issues: vec![],
            warnings: vec![],
            code: Some(code.into()),
        }
    }

    fn fake_proof(dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
        let (s, c) = file_hashes(dir)?;
        let mut meta = read_version(dir)?.meta;
        meta["proof"] =
            json!({"ok": true, "sourceHash": s, "codeHash": c, "frames": [], "passes": []});
        write_meta(dir, &meta)?;
        Ok(())
    }

    #[test]
    fn an_absent_library_is_empty() {
        let lib = load_library(None, Path::new("/no/such/apelles/components"));
        assert!(lib.entries.is_empty() && lib.errors.is_empty());
    }

    #[test]
    fn drafts_replace_in_place_until_certified_then_the_next_version_starts()
    -> Result<(), Box<dyn std::error::Error>> {
        let tmp = tempfile::tempdir()?;
        let user = tmp.path().join("components");
        let a = write_draft(None, &user, &spec("burst"), "src one", &passing("code one"))?;
        assert_eq!((a.version, a.replaced), (1, false));
        let b = write_draft(None, &user, &spec("burst"), "src two", &passing("code two"))?;
        assert_eq!(
            (b.version, b.replaced),
            (1, true),
            "the open draft is replaced"
        );
        assert_eq!(
            std::fs::read_to_string(Path::new(&b.dir).join(SOURCE_FILE))?,
            "src two"
        );
        assert!(!user.join("burst").join(".trash-1").exists());
        assert!(!user.join("burst").join(".staging-1").exists());

        let dir = PathBuf::from(&b.dir);
        assert!(certify(&dir).is_err(), "no proof yet");
        fake_proof(&dir)?;
        let meta = certify(&dir)?;
        assert_eq!(meta["status"], "certified");
        assert!(certify(&dir).is_err(), "certified versions are immutable");

        let c = write_draft(
            None,
            &user,
            &spec("burst"),
            "src three",
            &passing("code three"),
        )?;
        assert_eq!(
            (c.version, c.replaced),
            (2, false),
            "a certified version is never overwritten"
        );
        assert_eq!(std::fs::read_to_string(dir.join(SOURCE_FILE))?, "src two");

        let lib = load_library(None, &user);
        assert_eq!(
            lib.entries.iter().map(|e| e.version).collect::<Vec<_>>(),
            vec![1, 2]
        );
        Ok(())
    }

    #[test]
    fn a_proof_for_other_code_does_not_certify() -> Result<(), Box<dyn std::error::Error>> {
        let tmp = tempfile::tempdir()?;
        let user = tmp.path().join("components");
        let d = write_draft(None, &user, &spec("burst"), "src", &passing("code"))?;
        let dir = PathBuf::from(&d.dir);
        let mut meta = read_version(&dir)?.meta;
        meta["proof"] = json!({"ok": true, "sourceHash": "0".repeat(64), "codeHash": "0".repeat(64), "frames": [], "passes": []});
        write_meta(&dir, &meta)?;
        let err = certify(&dir)
            .err()
            .map(|e| e.to_string())
            .unwrap_or_default();
        assert!(err.contains("different code"), "{err}");
        // A failed proof refuses too.
        fake_proof(&dir)?;
        let mut meta = read_version(&dir)?.meta;
        meta["proof"]["ok"] = json!(false);
        write_meta(&dir, &meta)?;
        assert!(certify(&dir).is_err());
        Ok(())
    }

    #[test]
    fn a_failing_check_or_a_builtin_id_is_refused() -> Result<(), Box<dyn std::error::Error>> {
        let tmp = tempfile::tempdir()?;
        let builtin = tmp.path().join("builtin");
        std::fs::create_dir_all(builtin.join("chart"))?;
        let user = tmp.path().join("user");
        let failing = CheckReport {
            ok: false,
            issues: vec![],
            warnings: vec![],
            code: None,
        };
        assert!(write_draft(None, &user, &spec("burst"), "x", &failing).is_err());
        assert!(write_draft(Some(&builtin), &user, &spec("chart"), "x", &passing("c")).is_err());
        assert!(write_draft(None, &user, &spec("../up"), "x", &passing("c")).is_err());
        Ok(())
    }

    #[test]
    fn a_bad_entry_drops_itself_and_the_rest_load() -> Result<(), Box<dyn std::error::Error>> {
        let tmp = tempfile::tempdir()?;
        let user = tmp.path().join("user");
        write_draft(None, &user, &spec("good"), "s", &passing("c"))?;
        write_draft(None, &user, &spec("bad"), "s", &passing("c"))?;
        std::fs::write(user.join("bad").join("1").join(META_FILE), "{ not json")?;
        std::fs::create_dir_all(user.join("Bad Name"))?;
        let lib = load_library(None, &user);
        assert_eq!(lib.entries.len(), 1);
        assert_eq!(lib.entries[0].id, "good");
        assert_eq!(lib.errors.len(), 2, "{:?}", lib.errors);
        assert!(
            lib.errors
                .iter()
                .any(|e| e.path.ends_with("bad/1") && e.error.contains("not valid JSON"))
        );
        Ok(())
    }

    #[test]
    fn a_library_entry_cannot_shadow_a_builtin() -> Result<(), Box<dyn std::error::Error>> {
        let tmp = tempfile::tempdir()?;
        let builtin = tmp.path().join("builtin");
        let user = tmp.path().join("user");
        write_draft(None, &builtin, &spec("chart"), "s", &passing("c"))?;
        write_draft(None, &user, &spec("chart"), "s", &passing("c"))?;
        let lib = load_library(Some(&builtin), &user);
        assert_eq!(lib.entries.len(), 1);
        assert_eq!(lib.entries[0].source, EntrySource::Builtin);
        assert_eq!(lib.errors.len(), 1);
        Ok(())
    }

    #[test]
    fn install_copies_a_certified_version_content_addressed_and_refuses_tampering()
    -> Result<(), Box<dyn std::error::Error>> {
        let tmp = tempfile::tempdir()?;
        let user = tmp.path().join("user");
        let assets = tmp.path().join("p.chroma/motion/assets");
        let d = write_draft(
            None,
            &user,
            &spec("burst"),
            "the source",
            &passing("the code"),
        )?;
        let dir = PathBuf::from(&d.dir);
        assert!(
            install_into_project(&dir, &assets).is_err(),
            "a draft is not installable"
        );
        fake_proof(&dir)?;
        certify(&dir)?;
        let inst = install_into_project(&dir, &assets)?;
        assert_eq!(inst.code, format!("sha256:{}.js", sha256_hex(b"the code")));
        assert_eq!(
            std::fs::read_to_string(assets.join(format!("{}.js", inst.code_hash)))?,
            "the code"
        );
        assert_eq!(
            std::fs::read_to_string(assets.join(format!("{}.tsx", inst.source_hash)))?,
            "the source"
        );
        std::fs::write(dir.join(CODE_FILE), "tampered")?;
        assert!(install_into_project(&dir, &assets).is_err());
        Ok(())
    }

    #[test]
    fn delete_removes_one_version_or_all() -> Result<(), Box<dyn std::error::Error>> {
        let tmp = tempfile::tempdir()?;
        let user = tmp.path().join("user");
        let d = write_draft(None, &user, &spec("burst"), "s", &passing("c"))?;
        fake_proof(Path::new(&d.dir))?;
        certify(Path::new(&d.dir))?;
        write_draft(None, &user, &spec("burst"), "s2", &passing("c2"))?;
        assert_eq!(delete(&user, "burst", Some(2))?, 1);
        assert_eq!(load_library(None, &user).entries.len(), 1);
        assert_eq!(delete(&user, "burst", None)?, 1);
        assert!(!user.join("burst").exists());
        assert_eq!(delete(&user, "burst", None)?, 0);
        assert!(delete(&user, "../x", None).is_err());
        Ok(())
    }

    #[test]
    fn the_out_of_order_passes_visit_every_sample_in_a_different_order() {
        let samples: Vec<(usize, u32)> = vec![
            (0, 0),
            (0, 20),
            (0, 40),
            (0, 59),
            (1, 60),
            (1, 80),
            (1, 100),
            (1, 119),
        ];
        let b = order_backwards(&samples);
        let c = order_scrambled(&samples);
        let sorted = |mut v: Vec<(usize, u32)>| {
            v.sort();
            v
        };
        assert_eq!(sorted(b.clone()), samples);
        assert_eq!(sorted(c.clone()), samples);
        assert_ne!(b, samples);
        assert_ne!(c, samples);
        assert_ne!(b, c);
        assert_eq!(
            &c[..4],
            &[(0, 59), (0, 40), (0, 0), (0, 20)],
            "end, then back"
        );
        assert!(
            b.windows(2).all(|w| w[1].1 < w[0].1),
            "every step seeks backwards"
        );
    }

    #[test]
    fn the_check_command_runs_the_script_in_the_engine() {
        let cmd = build_check_command(Path::new("/engine"));
        assert_eq!(cmd.get_program(), "node");
        assert_eq!(cmd.get_current_dir(), Some(Path::new("/engine")));
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(
            args.last().map(String::as_str),
            Some("scripts/check-component.mts")
        );
    }

    /// The preview/proof bundle is keyed by the public folder's file names, and
    /// an installed module is named by its hash: a new or changed component is
    /// always a new bundle, never a stale one.
    #[test]
    fn installing_a_component_changes_the_bundle_cache_key()
    -> Result<(), Box<dyn std::error::Error>> {
        let tmp = tempfile::tempdir()?;
        let engine = tmp.path().join("engine");
        std::fs::create_dir_all(engine.join("src"))?;
        std::fs::write(engine.join("src/index.ts"), "x")?;
        let assets = tmp.path().join("assets");
        std::fs::create_dir_all(&assets)?;
        let empty = crate::still::engine_fingerprint(&engine, Some(&assets))?;
        store_bytes(b"module one", "js", &assets)?;
        let one = crate::still::engine_fingerprint(&engine, Some(&assets))?;
        assert_ne!(empty, one);
        store_bytes(b"module two", "js", &assets)?;
        assert_ne!(
            one,
            crate::still::engine_fingerprint(&engine, Some(&assets))?
        );
        Ok(())
    }

    #[test]
    fn pixel_drift_tolerates_rasterizer_noise_but_not_moved_shapes()
    -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let save =
            |name: &str, img: &image::RgbaImage| -> Result<PathBuf, Box<dyn std::error::Error>> {
                let p = dir.path().join(name);
                img.save(&p)?;
                Ok(p)
            };
        let base = image::RgbaImage::from_pixel(100, 100, image::Rgba([20, 20, 20, 255]));
        let a = save("a.png", &base)?;
        let mut noisy = base.clone();
        noisy.put_pixel(5, 5, image::Rgba([21, 20, 20, 255]));
        let b = save("b.png", &noisy)?;
        let d = pixel_drift(&a, &b)?;
        assert_eq!((d.max_delta, d.pixels, d.total), (1, 1, 10_000));
        assert!(d.within_tolerance());
        let mut moved = base.clone();
        for x in 0..20 {
            for y in 0..20 {
                moved.put_pixel(x, y, image::Rgba([200, 40, 40, 255]));
            }
        }
        let c = save("c.png", &moved)?;
        assert!(
            !pixel_drift(&a, &c)?.within_tolerance(),
            "a shape that moved is a failure"
        );
        assert!(pixel_drift(&a, &a)?.within_tolerance());
        Ok(())
    }

    #[test]
    fn proxy_keys_are_content_addressed() {
        let a = json!({"fps": 30, "scenes": [{"dur": 2}]});
        let b = json!({"fps": 30, "scenes": [{"dur": 3}]});
        assert_eq!(proxy_key(&a, 0.5), proxy_key(&a, 0.5));
        assert_ne!(proxy_key(&a, 0.5), proxy_key(&b, 0.5));
        assert_ne!(proxy_key(&a, 0.5), proxy_key(&a, 1.0));
    }
}
