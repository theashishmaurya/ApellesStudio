//! What must be true for `tauri::Builder::build()` to succeed — checked at
//! test time, because nothing else in this repo checks it.
//!
//! **What it is.** A static guard over the pair that B-402 broke: the plugins
//! `lib.rs` registers, and the `plugins.*` config blocks `tauri.conf.json`
//! provides for them.
//!
//! **Why it exists.** v0.3.0 shipped unlaunchable. D-458 registered
//! `tauri_plugin_updater` while deliberately leaving `plugins.updater` out of
//! the config, on the stated assumption that an unconfigured updater would
//! report itself unconfigured. It does not: the plugin deserializes its config
//! during `Builder::build()`, and a missing block is
//! `invalid type: null, expected struct Config` — a panic before any window
//! exists, with no crash report on macOS. `cargo check`, `cargo build`, 520
//! lib tests, the bundle verification and the DMG checksum all passed, because
//! none of them ran the binary.
//!
//! The release workflow now launches the built app and fails on a panic, which
//! is the real control. This is the cheap one that fires in five milliseconds
//! on every `cargo test`, long before a tag.
//!
//! **What it does NOT do.** It does not construct a Tauri app, run the binary,
//! or validate a plugin's config beyond "the block is there and is an object".
//! A config block with a wrong *value* in it (a malformed public key) is still
//! only caught by running the app. It also knows nothing about plugins outside
//! [`PLUGINS_REQUIRING_CONFIG`] — a future plugin with a mandatory config block
//! has to be added to that list by whoever registers it.

/// Plugins whose `plugins.<name>` block is **mandatory**: registering one
/// without it panics in `Builder::build()` rather than degrading.
///
/// Only `updater` is known to behave this way (B-402, measured). Most Tauri
/// plugins deserialize an optional config and default it; those must not be
/// listed here, or this guard would demand config nobody needs.
const PLUGINS_REQUIRING_CONFIG: &[&str] = &["updater"];

/// Is `tauri_plugin_<name>` actually registered on the builder?
///
/// Line comments are skipped, because the whole reason B-402's fix is safe is
/// a long comment in `lib.rs` that names `tauri_plugin_updater` several times
/// while registering nothing.
fn registers_plugin(lib_rs: &str, name: &str) -> bool {
    let needle = format!("plugin(tauri_plugin_{name}");
    lib_rs
        .lines()
        .map(str::trim_start)
        .filter(|line| !line.starts_with("//"))
        .any(|line| line.contains(&needle))
}

/// The B-402 rule, as a pure function over the two files' contents so it can be
/// tested against the failing case as well as today's passing one.
///
/// `Err` carries what a reader needs to act: which plugin, and which side of
/// the pair is missing.
fn check_plugin_config(lib_rs: &str, conf: &serde_json::Value) -> Result<(), String> {
    for name in PLUGINS_REQUIRING_CONFIG {
        if !registers_plugin(lib_rs, name) {
            continue;
        }
        let block = &conf["plugins"][name];
        if !block.is_object() {
            return Err(format!(
                "lib.rs registers tauri_plugin_{name} but tauri.conf.json has no \
                 plugins.{name} object (found {block}). That is not a no-op: the plugin \
                 deserializes its config in Builder::build(), and a missing block panics \
                 before any window exists — B-402, which shipped as v0.3.0 and could not \
                 start at all. Register it in the SAME commit that adds the config, and \
                 verify by RUNNING the built binary."
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(rel: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(rel);
        std::fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "{} should be readable from the test binary: {e}",
                path.display()
            )
        })
    }

    fn conf() -> serde_json::Value {
        let text = read("tauri.conf.json");
        serde_json::from_str(&text)
            .unwrap_or_else(|e| panic!("tauri.conf.json is not valid JSON: {e}"))
    }

    /// **B-402's guard.** The real `lib.rs` and the real base config, checked
    /// against the rule. It is quiet today because the plugin is not
    /// registered; it fires the moment someone registers it without the config
    /// block, which is exactly what shipped once.
    ///
    /// The BASE config is the one checked deliberately, not an overlay: a
    /// `--config` overlay is applied only to the builds that pass it, so config
    /// that lives solely in `tauri.macos.release.conf.json` would still leave
    /// every dev and debug build panicking on launch.
    #[test]
    fn no_plugin_is_registered_without_the_config_block_it_cannot_start_without() {
        if let Err(why) = check_plugin_config(&read("src/lib.rs"), &conf()) {
            panic!("{why}");
        }
    }

    /// The rule itself, on the three inputs that matter — so the test above is
    /// not merely passing because the checker never says no.
    ///
    /// Case 1 is v0.3.0, byte for byte in shape: the registration present, the
    /// config absent.
    #[test]
    fn the_rule_rejects_exactly_the_shipped_v0_3_0_shape() {
        let registered = ".plugin(tauri_plugin_updater::Builder::new().build())";
        let no_config = serde_json::json!({ "productName": "Apelles" });
        let with_config = serde_json::json!({
            "plugins": { "updater": { "endpoints": ["https://example.invalid/latest.json"], "pubkey": "x" } }
        });

        let err = check_plugin_config(registered, &no_config)
            .expect_err("registered with no plugins.updater is B-402 and must be refused");
        assert!(
            err.contains("B-402"),
            "the message must name the bug, got {err}"
        );
        assert!(
            err.contains("updater"),
            "the message must name the plugin, got {err}"
        );

        check_plugin_config(registered, &with_config)
            .expect("registered WITH its config block is the supported state");

        // Today's state: neither half. Also fine — the pair just has to agree.
        check_plugin_config("// nothing registered here", &no_config)
            .expect("not registering it at all is fine");
    }

    /// A prose mention is not a registration. `lib.rs`'s own B-402 comment
    /// names `tauri_plugin_updater` repeatedly, and a guard that tripped on
    /// that would be deleted within the week.
    #[test]
    fn a_comment_naming_a_plugin_is_not_a_registration() {
        let commented = "\
        // D-458 — the updater plugin is NOT registered here.\n\
        // Re-enable .plugin(tauri_plugin_updater::Builder::new().build()) with its config.\n\
        .plugin(tauri_plugin_os::init())\n";
        assert!(!registers_plugin(commented, "updater"));
        assert!(registers_plugin(
            ".plugin(tauri_plugin_updater::Builder::new().build())",
            "updater"
        ));
        assert!(registers_plugin(".plugin(tauri_plugin_os::init())", "os"));
    }
}
