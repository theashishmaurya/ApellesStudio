//! `editor_get_capabilities`' static reference document (D-312).
//!
//! WHAT THIS IS
//! The hard-won, non-obvious facts about the Edit tab's compositing and export that an
//! agent would otherwise only find by reading source or hitting them live. It is data,
//! not behaviour: the tool that serves it makes no call to the app at all.
//!
//! WHY IT IS A JSON FILE
//! It came across from `mcp/server.py`'s `EDITOR_CAPABILITIES` dict verbatim, by dumping
//! that dict rather than by retyping it — ~25 KB of prose in which a single reworded
//! sentence is a real change to what an agent is told. Keeping it as JSON keeps it that
//! way, and keeps the diff readable when a capability genuinely changes.

use std::sync::OnceLock;

use serde_json::Value;

const CAPABILITIES_JSON: &str = include_str!("capabilities.json");

/// The document, parsed once.
///
/// A parse failure would mean the committed file is not JSON, which cannot happen
/// without someone breaking it by hand — so it degrades to an explicit error object
/// rather than taking the server down at the first call.
pub fn document() -> &'static Value {
    static DOC: OnceLock<Value> = OnceLock::new();
    DOC.get_or_init(|| {
        serde_json::from_str(CAPABILITIES_JSON).unwrap_or_else(|e| {
            serde_json::json!({
                "error": format!("editor capabilities document is not valid JSON: {e}"),
            })
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_committed_document_really_is_json_and_really_has_content() {
        // The `unwrap_or_else` above hides a broken file behind a plausible-looking
        // answer, so something has to actually check the file parses. This is it.
        let doc = document();
        assert!(
            doc.get("error").is_none(),
            "capabilities.json failed to parse"
        );
        assert!(
            doc.as_object().is_some_and(|o| o.len() > 1),
            "capabilities document is empty"
        );
    }
}
