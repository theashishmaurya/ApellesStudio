//! The parity gate: this server must behave like `mcp/server.py` did (D-312).
//!
//! WHAT THIS IS
//!     The replay half of the harness whose recording half is `parity/capture.py`. It
//!     drives THIS server through a real MCP session — a real client, real JSON-RPC,
//!     over an in-process duplex stream — exactly the way capture drove the Python one
//!     over stdio, and checks the two against each other on three things:
//!
//!       1. the contract a client is shown: server instructions, and every tool's name,
//!          description and `inputSchema`;
//!       2. what actually goes out to the app: for each recorded call, the exact
//!          sequence of `{op, args, timeout_ms}` posted to the control server;
//!       3. what comes back to the client: the rendered MCP content blocks.
//!
//! WHY IT IS SHAPED LIKE THIS
//!     The corpus covers all 187 tools including the destructive ones, because it was
//!     captured against a stub control server rather than a real app — the boundary
//!     under test is what the MCP layer sends and renders, which is entirely on this
//!     side of the app. No Apelles app is needed to run this, and none should be.
//!
//! WHAT IS COMPARED HOW, AND WHY
//!     - **Tool descriptions and server instructions: byte-for-byte.** They are prose a
//!       model reads and acts on; a reflow is a change.
//!     - **Emitted ops: exact JSON equality**, including `timeout_ms`. This is the half
//!       that silently breaks — a wire key renamed, an argument dropped when it should
//!       be sent, an AI budget lost back to the 20s default (B-153).
//!     - **Rendered content: JSON value equality** for text blocks that parse as JSON,
//!       exact string equality otherwise. A client parses these, so the value is the
//!       contract and the byte formatting is not (see `src/render.rs`'s own note).
//!     - **Schemas: normalised structural equality.** Pydantic and schemars spell the
//!       same contract differently (`anyOf: [T, null]` vs `type: [T, null]`, a `title`
//!       on every property, where a default is written down). Byte equality would only
//!       measure which library generated the file. What is compared is what a client
//!       can actually rely on: the property names, which are required, the types and
//!       enums, nested shapes, and the descriptions — the last with whitespace
//!       collapsed, since re-wrapping a doc comment is formatting, not content.
//!
//! MID-MIGRATION
//!     `tests/golden/ported.json` lists the tools ported so far. The set this server
//!     advertises must equal it exactly, in both directions — so a tool cannot be
//!     quietly dropped, nor quietly added without landing in the ledger.
//!
//! RE-CAPTURING
//!     `mcp/.venv/bin/python crates/apelles-mcp/parity/capture.py`. It is deterministic:
//!     an unchanged Python server re-captures byte-identically.

// D-391 — this file pins the full tool surface, `motion_*` included, so it only
// builds with the (default) `motion` feature on.
#![cfg(feature = "motion")]

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use apelles_mcp::transport::{Envelope, OpError, OpTransport};
use apelles_mcp::{ApellesMcp, server::INSTRUCTIONS};
use rmcp::model::{CallToolRequestParams, ContentBlock};
use rmcp::{ServiceExt, service::RunningService};
use serde_json::{Map, Value, json};

const CORPUS: &str = include_str!("golden/corpus.json");
const PORTED: &str = include_str!("golden/ported.json");
const RESPONSES: &str = include_str!("../parity/responses.json");

/// Stands in for the fixture PNG's absolute path in both the canned responses and the
/// recorded answers. `debug_screenshot` really does read the file back off disk, so the
/// stub has to hand it a path that exists HERE — while the corpus has to stay portable,
/// since an absolute path is whatever machine ran the capture. Substituted in on the way
/// out, substituted back out on the way in.
const FIXTURE_TOKEN: &str = "__FIXTURE_PNG__";

fn fixture_png() -> String {
    format!(
        "{}/parity/fixtures/screenshot.png",
        env!("CARGO_MANIFEST_DIR")
    )
}

// --------------------------------------------------------------------------- #
// the stub app: the Rust twin of parity/stub_control.py
// --------------------------------------------------------------------------- #

/// One `POST /op` as the stub saw it — the thing the corpus recorded for the Python
/// server and the thing this server must reproduce.
#[derive(Debug, Clone, PartialEq)]
struct Recorded {
    op: String,
    args: Value,
    timeout_ms: u64,
}

/// Answers by op name from the same `parity/responses.json` the capture used, and writes
/// down every request. Knows nothing else — see `parity/stub_control.py`'s own note on
/// why this must never grow into a mock of the app.
struct RecordingTransport {
    responses: Map<String, Value>,
    seen: Mutex<Vec<Recorded>>,
}

impl RecordingTransport {
    fn new() -> Self {
        let raw: Value = serde_json::from_str(&RESPONSES.replace(FIXTURE_TOKEN, &fixture_png()))
            .expect("responses.json parses");
        let responses = raw
            .as_object()
            .expect("responses.json is an object")
            .iter()
            .filter(|(k, _)| !k.starts_with("__comment__"))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        Self {
            responses,
            seen: Mutex::new(Vec::new()),
        }
    }

    fn take(&self) -> Vec<Recorded> {
        let mut seen = self.seen.lock().expect("recorder mutex");
        std::mem::take(&mut *seen)
    }
}

#[async_trait::async_trait]
impl OpTransport for RecordingTransport {
    async fn call(&self, op: &str, args: Value, timeout_ms: u64) -> Result<Envelope, OpError> {
        self.seen.lock().expect("recorder mutex").push(Recorded {
            op: op.to_string(),
            args,
            timeout_ms,
        });
        Ok(self
            .responses
            .get(op)
            .or_else(|| self.responses.get("__default__"))
            .cloned()
            .unwrap_or(Value::Null))
    }
}

// --------------------------------------------------------------------------- #
// the session
// --------------------------------------------------------------------------- #

struct Harness {
    client: RunningService<rmcp::service::RoleClient, ()>,
    recorder: Arc<RecordingTransport>,
}

impl Harness {
    async fn start() -> Self {
        let recorder = Arc::new(RecordingTransport::new());
        let (client_io, server_io) = tokio::io::duplex(1 << 20);

        let server = ApellesMcp::new(recorder.clone());
        tokio::spawn(async move {
            if let Ok(running) = server.serve(server_io).await {
                let _ = running.waiting().await;
            }
        });

        let client = ().serve(client_io).await.expect("client connects");
        Self { client, recorder }
    }
}

// --------------------------------------------------------------------------- #
// the corpus
// --------------------------------------------------------------------------- #

fn corpus() -> Value {
    serde_json::from_str(CORPUS).expect("corpus.json parses")
}

fn ported() -> BTreeSet<String> {
    let doc: Value = serde_json::from_str(PORTED).expect("ported.json parses");
    doc["tools"]
        .as_array()
        .expect("ported.json has a `tools` array")
        .iter()
        .map(|v| v.as_str().expect("tool name is a string").to_string())
        .collect()
}

// --------------------------------------------------------------------------- #
// schema normalisation
// --------------------------------------------------------------------------- #

/// Whitespace-collapsed text, so re-wrapping a doc comment is not a difference.
fn squash(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn resolve<'a>(schema: &'a Value, defs: &'a Map<String, Value>) -> &'a Value {
    schema
        .get("$ref")
        .and_then(Value::as_str)
        .and_then(|r| r.rsplit('/').next())
        .and_then(|k| defs.get(k))
        .unwrap_or(schema)
}

/// The part of a JSON Schema a client can actually rely on, in one canonical shape.
///
/// Deliberately drops what is generator noise — `title`, `$schema`, `format`, and the
/// difference between `anyOf: [T, null]` and `type: [T, null]` — and keeps what changes
/// how a call must be written: names, requiredness, types, enums, nesting, description.
///
/// `default` is deliberately NOT compared. Where a default is *written down* is a
/// generator choice; where it is *applied* is behaviour, and that is checked far more
/// strictly one test down, by comparing the actual arguments each call puts on the wire.
/// A default that drifted would change those, and fail there.
fn normalise(schema: &Value, defs: &Map<String, Value>, depth: usize) -> Value {
    // Recursive models would otherwise not terminate. Nothing in this surface nests this
    // deep; the guard exists so a future one fails loudly rather than hanging.
    if depth > 12 {
        return json!("<too deep>");
    }
    // A `$ref` node may carry its own `description` alongside the reference, and that
    // one WINS over the referenced type's: it describes this use of the shape, not the
    // shape. Capturing it before resolving is the difference between comparing a field's
    // real published description and comparing the type's generic one.
    let outer_description = schema
        .get("$ref")
        .and(schema.get("description"))
        .and_then(Value::as_str)
        .map(squash);
    let schema = resolve(schema, defs);
    let Some(obj) = schema.as_object() else {
        return json!({ "any": true });
    };

    let mut types: BTreeSet<String> = BTreeSet::new();
    let mut branches: Vec<Value> = Vec::new();

    match obj.get("type") {
        Some(Value::String(t)) => {
            types.insert(t.clone());
        }
        Some(Value::Array(list)) => {
            for t in list {
                if let Some(t) = t.as_str() {
                    types.insert(t.to_string());
                }
            }
        }
        _ => {}
    }

    for key in ["anyOf", "oneOf"] {
        if let Some(Value::Array(list)) = obj.get(key) {
            for branch in list {
                let resolved = resolve(branch, defs);
                if resolved.get("type") == Some(&json!("null")) {
                    types.insert("null".to_string());
                } else {
                    branches.push(normalise(branch, defs, depth + 1));
                }
            }
        }
    }

    // Nullability is pulled out of `type` and carried as its own flag, so that the four
    // ways these two generators can spell "T or null" — `type: [T, null]`,
    // `anyOf: [{type: T}, {type: null}]`, and either of those wrapped around a `$ref` —
    // all normalise to the same thing.
    let nullable = types.remove("null");

    let mut out = Map::new();

    // A single non-null branch IS the type; flatten it, and keep whatever the outer
    // level said about it. Pydantic hangs the `description` on the outer `anyOf` node
    // while schemars hangs it on the type itself — dropping the outer one here is how an
    // earlier version of this normaliser lost every field description on the Python
    // side and then "proved" the two schemas agreed.
    if branches.len() == 1 && types.is_empty() && !obj.contains_key("enum") {
        let mut only = branches.remove(0);
        if let Some(inner) = only.as_object_mut() {
            if nullable {
                inner.insert("nullable".into(), json!(true));
            }
            if let Some(d) = outer_description
                .clone()
                .or_else(|| obj.get("description").and_then(Value::as_str).map(squash))
                .filter(|_| !inner.contains_key("description"))
            {
                inner.insert("description".into(), json!(d));
            }
        }
        return only;
    }

    if nullable {
        out.insert("nullable".into(), json!(true));
    }
    if !types.is_empty() {
        out.insert(
            "type".into(),
            Value::Array(types.into_iter().map(Value::String).collect()),
        );
    }
    if !branches.is_empty() {
        out.insert("branches".into(), Value::Array(branches));
    }
    if let Some(values) = obj.get("enum").and_then(Value::as_array) {
        let mut sorted: Vec<String> = values.iter().map(|v| v.to_string()).collect();
        sorted.sort();
        out.insert("enum".into(), json!(sorted));
    }
    if let Some(c) = obj.get("const") {
        out.insert("const".into(), c.clone());
    }
    if let Some(d) = outer_description
        .clone()
        .or_else(|| obj.get("description").and_then(Value::as_str).map(squash))
    {
        out.insert("description".into(), json!(d));
    }
    if let Some(items) = obj.get("items") {
        out.insert("items".into(), normalise(items, defs, depth + 1));
    }
    for key in ["minItems", "maxItems"] {
        if let Some(v) = obj.get(key) {
            out.insert(key.into(), v.clone());
        }
    }
    if let Some(props) = obj.get("properties").and_then(Value::as_object) {
        let mut mapped = Map::new();
        for (name, sub) in props {
            mapped.insert(name.clone(), normalise(sub, defs, depth + 1));
        }
        out.insert("properties".into(), Value::Object(mapped));
        let mut required: Vec<String> = obj
            .get("required")
            .and_then(Value::as_array)
            .map(|r| {
                r.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        required.sort();
        out.insert("required".into(), json!(required));
        // `false` and absent differ (closed vs. open shape); anything else is "open".
        let closed = obj.get("additionalProperties") == Some(&json!(false));
        out.insert("closed".into(), json!(closed));
    }
    Value::Object(out)
}

/// Does the ported schema honour the Python one?
///
/// Equality everywhere, with one asymmetry: a `description` the Python schema HAD must
/// be present and say the same thing, but the port is allowed to add one where Pydantic
/// emitted none. That direction is real — schemars publishes a union's own doc comment
/// where Pydantic published nothing — and it can only make a schema more informative.
/// Losing a description, or changing what one says, still fails.
fn schema_honours(expected: &Value, actual: &Value, path: &str, problems: &mut Vec<String>) {
    match (expected, actual) {
        (Value::Object(e), Value::Object(a)) => {
            for (key, want) in e {
                match a.get(key) {
                    Some(got) => schema_honours(want, got, &format!("{path}.{key}"), problems),
                    None => problems.push(format!("{path}.{key}: missing (python had {want})")),
                }
            }
            for key in a.keys() {
                if key != "description" && !e.contains_key(key) {
                    problems.push(format!("{path}.{key}: added by the port, python had none"));
                }
            }
        }
        (Value::Array(e), Value::Array(a)) if e.len() == a.len() => {
            // Union branches and the like: recurse element-wise so a nested description
            // gets the same asymmetric treatment, and so a mismatch names the branch
            // rather than dumping both whole arrays.
            for (i, (want, got)) in e.iter().zip(a).enumerate() {
                schema_honours(want, got, &format!("{path}[{i}]"), problems);
            }
        }
        _ if expected == actual => {}
        _ => problems.push(format!("{path}: python {expected}, rust {actual}")),
    }
}

fn normalise_tool_schema(schema: &Value) -> Value {
    let defs = schema
        .get("$defs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    normalise(schema, &defs, 0)
}

// --------------------------------------------------------------------------- #
// content comparison
// --------------------------------------------------------------------------- #

/// A content block reduced to what the corpus records, so the two sides are comparable.
fn describe(block: &ContentBlock) -> Value {
    match block {
        ContentBlock::Text(t) => json!({ "type": "text", "text": t.text }),
        ContentBlock::Image(i) => {
            json!({ "type": "image", "mimeType": i.mime_type, "data": i.data })
        }
        other => json!({ "type": "other", "repr": format!("{other:?}") }),
    }
}

/// Put the fixture path back as its token, so a machine-specific absolute path never
/// decides whether the two sides agree.
fn untokenise(block: Value) -> Value {
    match serde_json::to_string(&block) {
        Ok(text) => {
            serde_json::from_str(&text.replace(&fixture_png(), FIXTURE_TOKEN)).unwrap_or(block)
        }
        Err(_) => block,
    }
}

/// Text blocks are compared as JSON values when both sides are JSON — see this file's
/// header for why the bytes are not the contract but the value is.
fn blocks_match(expected: &Value, actual: &Value) -> bool {
    if expected == actual {
        return true;
    }
    let (Some(e), Some(a)) = (expected.as_object(), actual.as_object()) else {
        return false;
    };
    if e.get("type") != Some(&json!("text")) || a.get("type") != Some(&json!("text")) {
        return false;
    }
    let parse = |v: Option<&Value>| -> Option<Value> { serde_json::from_str(v?.as_str()?).ok() };
    match (parse(e.get("text")), parse(a.get("text"))) {
        (Some(e), Some(a)) => e == a,
        _ => false,
    }
}

// --------------------------------------------------------------------------- #
// the tests
// --------------------------------------------------------------------------- #

#[tokio::test]
async fn the_server_instructions_are_the_pythons_word_for_word() {
    // Prose a model reads before its first call, including the scope discipline that
    // actually changes how an agent grades. A paraphrase here is a behaviour change.
    let expected = corpus()["instructions"]
        .as_str()
        .expect("corpus recorded instructions")
        .to_string();
    assert_eq!(INSTRUCTIONS, expected);

    let harness = Harness::start().await;
    let info = harness.client.peer_info().expect("server info");
    assert_eq!(info.instructions.as_deref(), Some(expected.as_str()));
    harness.client.cancel().await.ok();
}

#[tokio::test]
async fn the_advertised_tool_set_is_exactly_the_ported_ledger() {
    // Both directions on purpose: a dropped tool is a regression, and a tool added
    // without landing in the ledger means the port's own status is no longer known.
    let harness = Harness::start().await;
    let listed: BTreeSet<String> = harness
        .client
        .list_all_tools()
        .await
        .expect("tools/list")
        .into_iter()
        .map(|t| t.name.to_string())
        .collect();
    harness.client.cancel().await.ok();

    let ledger = ported();
    let missing: Vec<_> = ledger.difference(&listed).collect();
    let unexpected: Vec<_> = listed.difference(&ledger).collect();
    assert!(
        missing.is_empty() && unexpected.is_empty(),
        "ported.json and the live server disagree.\n  in the ledger but not served: {missing:?}\
         \n  served but not in the ledger: {unexpected:?}"
    );

    // Every ported name must be a real tool the Python server had — a typo would
    // otherwise pass silently as "a tool the corpus does not cover".
    let known: BTreeSet<String> = corpus()["tools"]
        .as_array()
        .expect("corpus tools")
        .iter()
        .map(|t| t["name"].as_str().expect("name").to_string())
        .collect();
    let invented: Vec<_> = ledger.difference(&known).collect();
    assert!(
        invented.is_empty(),
        "not tools the Python server had: {invented:?}"
    );
}

#[tokio::test]
async fn every_ported_tool_publishes_the_same_contract_as_the_python_one() {
    let corpus = corpus();
    let ledger = ported();
    let golden: BTreeMap<String, &Value> = corpus["tools"]
        .as_array()
        .expect("corpus tools")
        .iter()
        .map(|t| (t["name"].as_str().expect("name").to_string(), t))
        .collect();

    let harness = Harness::start().await;
    let listed = harness.client.list_all_tools().await.expect("tools/list");
    harness.client.cancel().await.ok();

    for tool in &listed {
        let name = tool.name.to_string();
        let want = golden
            .get(&name)
            .unwrap_or_else(|| panic!("{name} is not in the corpus"));

        // Byte-for-byte: this is the text the model reads to decide how to call it.
        assert_eq!(
            tool.description.as_deref().unwrap_or_default(),
            want["description"].as_str().unwrap_or_default(),
            "description drifted for `{name}`"
        );

        let expected = normalise_tool_schema(&want["inputSchema"]);
        let actual =
            normalise_tool_schema(&serde_json::to_value(&*tool.input_schema).expect("schema"));
        let mut problems = Vec::new();
        schema_honours(&expected, &actual, "", &mut problems);
        assert!(
            problems.is_empty(),
            "inputSchema drifted for `{name}`:\n  - {}",
            problems.join("\n  - ")
        );
    }
    assert_eq!(listed.len(), ledger.len());
}

#[tokio::test]
async fn every_recorded_call_emits_the_same_ops_and_renders_the_same_content() {
    let corpus = corpus();
    let ledger = ported();
    let harness = Harness::start().await;

    let mut checked = 0usize;
    for case in corpus["cases"].as_array().expect("corpus cases") {
        let name = case["tool"].as_str().expect("tool name");
        if !ledger.contains(name) {
            continue;
        }
        let label = case["case"].as_str().unwrap_or("?");
        let arguments = case["arguments"].as_object().cloned().unwrap_or_default();

        let _ = harness.recorder.take();
        let result = harness
            .client
            .call_tool(CallToolRequestParams::new(name.to_string()).with_arguments(arguments))
            .await
            .unwrap_or_else(|e| panic!("{name}/{label} failed to call: {e}"));

        // (2) what actually went to the app.
        let emitted: Vec<Value> = harness
            .recorder
            .take()
            .into_iter()
            .map(|r| json!({ "op": r.op, "args": r.args, "timeout_ms": r.timeout_ms }))
            .collect();
        let expected_requests = case["requests"].clone();
        assert_eq!(
            expected_requests,
            Value::Array(emitted),
            "`{name}`/{label} posted different ops than the Python server did"
        );

        // (3) what came back to the client.
        let expected_content = case["content"].as_array().cloned().unwrap_or_default();
        let actual_content: Vec<Value> = result
            .content
            .iter()
            .map(|b| untokenise(describe(b)))
            .collect();
        assert_eq!(
            expected_content.len(),
            actual_content.len(),
            "`{name}`/{label} returned {} content blocks, expected {}",
            actual_content.len(),
            expected_content.len()
        );
        for (i, (want, got)) in expected_content.iter().zip(&actual_content).enumerate() {
            assert!(
                blocks_match(want, got),
                "`{name}`/{label} content block {i} differs\n  python: {want}\n  rust:   {got}"
            );
        }
        assert_eq!(
            case["isError"].as_bool().unwrap_or(false),
            result.is_error.unwrap_or(false),
            "`{name}`/{label} disagrees about being an error"
        );
        checked += 1;
    }

    harness.client.cancel().await.ok();
    assert!(checked > 0, "no ported tool had a case in the corpus");
    eprintln!(
        "parity: {checked} recorded calls replayed for {} ported tools",
        ledger.len()
    );
}

#[test]
fn the_remaining_work_is_written_down_rather_than_estimated() {
    // Not a progress bar for its own sake: this is what stops "the port is done" from
    // being asserted while tools are still missing. It fails when the two numbers stop
    // adding up, which is the moment the ledger stopped being true.
    let corpus = corpus();
    let all: BTreeSet<String> = corpus["tools"]
        .as_array()
        .expect("corpus tools")
        .iter()
        .map(|t| t["name"].as_str().expect("name").to_string())
        .collect();
    let done = ported();
    let remaining: Vec<_> = all.difference(&done).cloned().collect();
    eprintln!(
        "port status: {}/{} tools ported, {} remaining",
        done.len(),
        all.len(),
        remaining.len()
    );
    assert_eq!(done.len() + remaining.len(), all.len());
}
