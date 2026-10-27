//! Turning a control-server envelope into MCP content (D-312).
//!
//! WHAT THIS IS
//!  The three renderers every tool ends in — the plain JSON one, the
//!  frame-plus-summary one that mutating tools use, and `inspect_color`'s scope
//!  renderer — ported from `mcp/server.py`'s `_result` / `_inspect_result`.
//!
//! WHAT IT DOES NOT DO
//!  It does not interpret, reorder, complete or validate anything in the envelope.
//!  Which keys exist and what they mean is the frontend's business; this picks the
//!  ones the contract says to surface and passes their values through untouched.
//!
//! ON FIDELITY
//!  The key set and the key ORDER of each rendered summary are part of what an agent
//!  reads, so both are reproduced exactly — including the keys that are always
//!  present and usually null. That ordering comes from serialising a struct, whose
//!  fields serialise in declaration order, rather than from a map: this workspace
//!  builds `serde_json` without `preserve_order`, so a `Map` would sort its keys, and
//!  turning that feature on is a workspace-wide change to how every other crate here
//!  writes JSON (`grade.json` included) that this port has no business making.
//!
//!  What is deliberately NOT reproduced is Python's `json.dumps` byte formatting —
//!  its `ensure_ascii` escaping, and the key order of nested values that came off the
//!  wire, which do land sorted here. A client parses this text as JSON, so the value
//!  is the contract and the bytes are not; `tests/parity.rs` compares these blocks as
//!  JSON values for exactly that reason. Prose — every tool description — is compared
//!  byte-for-byte instead, because that is what a model actually reads.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use rmcp::model::{CallToolResult, ContentBlock};
use serde::Serialize;
use serde_json::{Map, Value};

/// Python's notion of truth, which several of these branches are written in terms of.
///
/// `if res.get("gap"):` skips an empty dict as well as a missing key, and the port has
/// to skip it too — an envelope carrying `gap: {}` must not grow a `gap` line here.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
    }
}

fn get<'a>(env: &'a Value, key: &str) -> Option<&'a Value> {
    env.get(key).filter(|v| !v.is_null())
}

/// `key: value`, with an absent key rendered as an explicit null rather than dropped.
fn owned_or_null(env: &Value, key: &str) -> Value {
    env.get(key).cloned().unwrap_or(Value::Null)
}

/// Pretty JSON, the shape every tool that returns plain text produces.
pub fn json_text(value: &Value) -> CallToolResult {
    CallToolResult::success(vec![ContentBlock::text(pretty(value))])
}

pub fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string())
}

/// A JPEG frame block from a base64 payload, or `None` if it is absent or undecodable.
///
/// Decoded and re-encoded rather than passed through, which is what the Python does and
/// is worth keeping: it normalises the payload and refuses to forward something that is
/// not base64 at all.
fn jpeg_block(image_b64: Option<&Value>) -> Option<ContentBlock> {
    let raw = image_b64?.as_str()?;
    if raw.is_empty() {
        return None;
    }
    let bytes = BASE64.decode(raw).ok()?;
    Some(ContentBlock::image(BASE64.encode(bytes), "image/jpeg"))
}

/// A PNG block from a `data:` URL, or `None` for anything that is not one.
fn data_url_png_block(value: Option<&Value>) -> Option<ContentBlock> {
    let url = value?.as_str()?;
    if !url.starts_with("data:") {
        return None;
    }
    let (_, payload) = url.split_once(',')?;
    let bytes = BASE64.decode(payload).ok()?;
    if bytes.is_empty() {
        return None;
    }
    Some(ContentBlock::image(BASE64.encode(bytes), "image/png"))
}

/// A tool whose answer is a PNG the APP wrote to disk (`debug_screenshot`,
/// `motion_preview_frame`): the image read back from `result.path` (when `inline` and
/// the op succeeded), then `{ok, error, ...result}` as text.
///
/// A read failure is reported IN the result as `inlineError` ("`{done}`, but could not
/// be read back") rather than raised: the app's half succeeded and its path is still the
/// useful answer. Ported from the identical branch in both Python tools.
pub fn file_png_result(env: &Value, inline: bool, done: &str) -> CallToolResult {
    let ok = env.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let mut result = match env.get("result") {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let mut blocks = Vec::new();
    if inline
        && ok
        && let Some(path) = result.get("path").and_then(Value::as_str)
    {
        match std::fs::read(path) {
            Ok(bytes) => blocks.push(ContentBlock::image(BASE64.encode(bytes), "image/png")),
            Err(e) => {
                result.insert(
                    "inlineError".into(),
                    Value::String(format!("{done}, but could not be read back: {e}")),
                );
            }
        }
    }
    let mut out = Map::new();
    out.insert("ok".into(), owned_or_null(env, "ok"));
    out.insert("error".into(), owned_or_null(env, "error"));
    out.extend(result);
    blocks.push(ContentBlock::text(pretty(&Value::Object(out))));
    CallToolResult::success(blocks)
}

/// The mutating-tool renderer: the re-rendered frame, then the state after the change.
///
/// The seven summary keys are always present, in this order, whether or not the envelope
/// carried them — an agent reading `"scopes": null` learns something an absent key does
/// not tell it.
pub fn result(env: &Value) -> CallToolResult {
    /// Declaration order IS the rendered order — see this module's doc.
    #[derive(Serialize)]
    struct Summary {
        ok: Value,
        error: Value,
        result: Value,
        frame: Value,
        scopes: Value,
        histogram: Value,
        adjustments: Value,
    }

    let mut blocks = Vec::new();
    if let Some(image) = jpeg_block(env.get("image_b64")) {
        blocks.push(image);
    }
    let summary = Summary {
        ok: owned_or_null(env, "ok"),
        error: owned_or_null(env, "error"),
        result: owned_or_null(env, "result"),
        frame: owned_or_null(env, "frame"),
        scopes: owned_or_null(env, "scopes"),
        histogram: owned_or_null(env, "histogram"),
        adjustments: owned_or_null(env, "adjustments"),
    };
    let text = serde_json::to_string_pretty(&summary).unwrap_or_else(|_| "{}".to_string());
    blocks.push(ContentBlock::text(text));
    CallToolResult::success(blocks)
}

/// `inspect_color`'s renderer: parade + vectorscope images, then the readable numbers.
///
/// A failed measurement is rendered as the whole raw envelope instead — there are no
/// scopes to read, and the reason is the only useful thing left in it.
pub fn inspect_result(env: &Value) -> CallToolResult {
    /// Declaration order IS the rendered order — see this module's doc.
    #[derive(Serialize)]
    struct Readable {
        scopes: Value,
        histogram: Value,
        #[serde(rename = "frameSize")]
        frame_size: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        reference: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        gap: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reading: Option<Value>,
    }

    if !truthy(env.get("ok")) {
        return json_text(env);
    }

    let empty = Value::Object(Map::new());
    let res = get(env, "result").unwrap_or(&empty);

    let mut blocks = Vec::new();
    for key in ["parade", "vectorscope"] {
        if let Some(image) = data_url_png_block(res.get(key)) {
            blocks.push(image);
        }
    }

    let gap = truthy(res.get("gap")).then(|| owned_or_null(res, "gap"));
    // The one-line prose summary is lifted out of `gap` to the top level as well — it is
    // the sentence a human reads, and burying it inside the numbers hides it.
    let reading = gap
        .as_ref()
        .and_then(|g| g.get("reading"))
        .filter(|r| truthy(Some(r)))
        .cloned();

    let readable = Readable {
        scopes: owned_or_null(res, "scopes"),
        histogram: owned_or_null(res, "histogram"),
        frame_size: owned_or_null(res, "frameSize"),
        reference: truthy(res.get("reference")).then(|| owned_or_null(res, "reference")),
        gap,
        reading,
    };
    let text = serde_json::to_string_pretty(&readable).unwrap_or_else(|_| "{}".to_string());
    blocks.push(ContentBlock::text(text));
    CallToolResult::success(blocks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn text_of(result: &CallToolResult) -> String {
        result
            .content
            .iter()
            .find_map(|b| match b {
                ContentBlock::Text(t) => Some(t.text.clone()),
                _ => None,
            })
            .unwrap_or_default()
    }

    fn images(result: &CallToolResult) -> Vec<String> {
        result
            .content
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Image(i) => Some(i.mime_type.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_summary_always_carries_all_seven_keys_even_when_the_envelope_does_not() {
        // An agent that sees `"scopes": null` knows the app rendered nothing to measure.
        // An agent that sees no `scopes` key cannot tell that from a renderer bug.
        let text = text_of(&result(&json!({ "ok": true })));
        // Read off the rendered TEXT, not a re-parse of it: `serde_json::Value` sorts
        // its keys on the way in, so a parsed copy could not tell a correct order from
        // a scrambled one — which is the very thing being asserted.
        let keys: Vec<&str> = text
            .lines()
            .filter_map(|line| line.trim().strip_prefix('"'))
            .filter_map(|line| line.split('"').next())
            .collect();
        assert_eq!(
            keys,
            [
                "ok",
                "error",
                "result",
                "frame",
                "scopes",
                "histogram",
                "adjustments"
            ]
        );
    }

    #[test]
    fn a_frame_is_rendered_as_an_image_block_before_the_summary() {
        let out = result(&json!({ "ok": true, "image_b64": BASE64.encode([1u8, 2, 3]) }));
        assert_eq!(images(&out), ["image/jpeg"]);
        assert!(matches!(out.content.last(), Some(ContentBlock::Text(_))));
    }

    #[test]
    fn a_payload_that_is_not_base64_is_dropped_rather_than_forwarded() {
        let out = result(&json!({ "ok": true, "image_b64": "not base64 at all!!" }));
        assert!(images(&out).is_empty());
    }

    #[test]
    fn a_failed_inspection_renders_the_whole_envelope_not_an_empty_scope_table() {
        let env = json!({ "ok": false, "error": "no frame loaded" });
        let parsed: Value =
            serde_json::from_str(&text_of(&inspect_result(&env))).expect("envelope is JSON");
        assert_eq!(parsed, env);
    }

    #[test]
    fn an_empty_gap_is_skipped_the_way_pythons_truthiness_skips_it() {
        // `if res.get("gap"):` — an envelope carrying `gap: {}` must not grow a `gap`
        // line. Getting this wrong is invisible until an agent reads a gap that is not
        // there and "corrects" a grade toward nothing.
        let env = json!({ "ok": true, "result": { "gap": {}, "reference": {} } });
        let parsed: Value =
            serde_json::from_str(&text_of(&inspect_result(&env))).expect("readable is JSON");
        let obj = parsed.as_object().expect("object");
        assert!(!obj.contains_key("gap"));
        assert!(!obj.contains_key("reference"));
    }

    #[test]
    fn a_gaps_reading_line_is_lifted_to_the_top_level_beside_the_numbers() {
        let env = json!({
            "ok": true,
            "result": { "gap": { "exposure": 0.3, "reading": "half a stop dark" } }
        });
        let parsed: Value =
            serde_json::from_str(&text_of(&inspect_result(&env))).expect("readable is JSON");
        assert_eq!(parsed["reading"], json!("half a stop dark"));
        assert_eq!(parsed["gap"]["exposure"], json!(0.3));
    }

    #[test]
    fn both_scope_images_render_as_png_in_parade_then_vectorscope_order() {
        let url = format!("data:image/png;base64,{}", BASE64.encode([9u8, 9, 9]));
        let env = json!({ "ok": true, "result": { "parade": url, "vectorscope": url } });
        assert_eq!(images(&inspect_result(&env)), ["image/png", "image/png"]);
    }
}
