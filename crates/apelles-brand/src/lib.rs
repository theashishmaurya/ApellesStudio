//! # apelles-brand — brand kits on disk (L2, D-416)
//!
//! **What it is:** the storage half of the brand kit, the one brand definition
//! every tab, template, custom component and agent reads (colours, type, logos,
//! motion style, caption style, a grade look, sound, references). Three places a
//! kit's bytes live:
//!
//! - the user's **library**, `<app data>/brand/kits/<id>.json`, one file per kit
//!   ([`library`]; the per-file rule D-407 wrote for templates, shared through
//!   [`apelles_motion::library`]): a bad file drops itself with a named error;
//! - the **brand asset store**, `<app data>/brand/assets/<sha256>.<ext>` ([`assets`]):
//!   logos, font files, LUTs, reference images and videos, a sonic logo, named by
//!   the SHA-256 of their bytes, so a kit holds `sha256:<hex>.<ext>` ids, never paths;
//! - a project's **snapshot** of its active kit, `<project>.chroma/brand/kit.json`
//!   plus `brand/assets/` ([`project`]): a copy, so a project never depends on the
//!   library (the D-407/D-409 copy semantics). Deleting or editing a library kit
//!   leaves every project that uses it unchanged until it is set again.
//!
//! **What it does NOT do:** interpret a kit. The schema, the contrast check, the
//! theme a kit generates and every per-tab "apply" are TypeScript
//! (`packages/brand`, `@apelles/motion`, `@apelles/editor`, the Colorist app):
//! this crate checks only what the file system needs (safe ids, file stems,
//! content hashes). It never renders, and nothing in a render reads it: Motion
//! renders a theme copied into the manifest and assets copied into the Motion
//! asset folder (same ids).

pub mod assets;
pub mod library;
pub mod project;

use std::path::{Path, PathBuf};

/// `<app data>/brand`.
pub fn brand_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("brand")
}
