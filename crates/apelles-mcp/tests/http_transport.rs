//! The HTTP transport carries the same server the stdio one does (D-313).
//!
//! WHAT THIS IS
//!     A real MCP session over a real TCP socket: `serve::router` bound to an
//!     ephemeral loopback port, an rmcp streamable-HTTP client dialling the resulting
//!     URL, and a real tool called through it. No app is needed — the control server
//!     is stubbed, exactly as in `parity.rs`, because the boundary under test here is
//!     the transport, not the ops.
//!
//! WHAT IT IS FOR, GIVEN `parity.rs` EXISTS
//!     `parity.rs` proves the 161 tools behave; it does that over an in-process duplex
//!     stream, which is stdio's shape. It would keep passing if `--http` were broken,
//!     unroutable, or serving a different tool set. This file is the one that fails in
//!     that case: it checks the surface a client reaches *by URL* is the identical
//!     one — same instructions, same tool count, same op emitted, same content back —
//!     and that `/health` answers in the shape the app's supervisor polls for.
//!
//! WHAT IT DOES NOT DO
//!     It does not re-check all 161 tools' schemas or rendering. That is `parity.rs`'s
//!     job and duplicating it here would only mean two files to update. One real tool
//!     call is enough to prove the pipe.

use std::sync::{Arc, Mutex};

use apelles_mcp::transport::{Envelope, OpError, OpTransport};
use apelles_mcp::{ApellesMcp, serve, server::INSTRUCTIONS};
use rmcp::ServiceExt;
use rmcp::model::{CallToolRequestParams, ContentBlock};
use rmcp::transport::streamable_http_client::{
    StreamableHttpClientTransport, StreamableHttpClientTransportConfig,
};
use serde_json::{Value, json};

/// The tool set the parity gate pins. Asserted here too, because "the HTTP transport
/// serves a *different* server" is precisely the failure this file exists to catch.
const TOOL_COUNT: usize = 161;

/// Answers every op with one canned envelope and writes down what it was asked. The
/// cut-down twin of `parity.rs`'s recorder — this file needs "what op went out", not
/// the whole `responses.json` fixture set.
struct StubApp {
    seen: Mutex<Vec<(String, Value, u64)>>,
}

#[async_trait::async_trait]
impl OpTransport for StubApp {
    async fn call(&self, op: &str, args: Value, timeout_ms: u64) -> Result<Envelope, OpError> {
        if let Ok(mut seen) = self.seen.lock() {
            seen.push((op.to_string(), args, timeout_ms));
        }
        Ok(json!({ "ok": true, "result": { "op": op } }))
    }
}

/// Serve the real router on an ephemeral loopback port; return its base URL.
async fn spawn(stub: Arc<StubApp>) -> std::io::Result<String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let router = serve::router(ApellesMcp::new(stub), "http://127.0.0.1:19788".into());
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok(format!("http://{addr}"))
}

#[tokio::test]
async fn a_real_client_reaches_the_identical_tool_surface_over_http()
-> Result<(), Box<dyn std::error::Error>> {
    let stub = Arc::new(StubApp {
        seen: Mutex::new(Vec::new()),
    });
    let base = spawn(stub.clone()).await?;

    let client = ()
        .serve(StreamableHttpClientTransport::with_client(
            reqwest::Client::new(),
            StreamableHttpClientTransportConfig::with_uri(format!("{base}{}", serve::MCP_PATH)),
        ))
        .await?;

    // 1. The contract a client is shown is the same one stdio shows.
    let info = client.peer_info().ok_or("the server sent no ServerInfo")?;
    assert_eq!(
        info.instructions.as_deref(),
        Some(INSTRUCTIONS),
        "the HTTP transport must serve the same server instructions as stdio"
    );

    let tools = client.list_all_tools().await?;
    assert_eq!(
        tools.len(),
        TOOL_COUNT,
        "every tool must be reachable over HTTP, not a subset"
    );

    // 2. A real call really reaches the app boundary, with its arguments intact.
    let mut arguments = serde_json::Map::new();
    arguments.insert("frame".into(), json!(42));
    let result = client
        .call_tool(CallToolRequestParams::new("editor_set_playhead").with_arguments(arguments))
        .await?;

    let seen = stub.seen.lock().map_err(|_| "recorder mutex")?.clone();
    assert_eq!(
        seen.len(),
        1,
        "one tool call should post exactly one op, got {seen:?}"
    );
    let (op, args, timeout_ms) = &seen[0];
    assert_eq!(op, "editor_set_playhead");
    assert_eq!(args, &json!({ "frame": 42 }));
    assert_eq!(
        *timeout_ms,
        apelles_mcp::DEFAULT_OP_TIMEOUT_MS,
        "the per-tool timeout budget must survive the HTTP transport too (B-153)"
    );

    // 3. And the rendered answer comes back to the client, not just to the server.
    let blocks = result.content;
    let Some(ContentBlock::Text(text)) = blocks.first() else {
        return Err(format!("expected a text content block, got {blocks:?}").into());
    };
    assert!(
        text.text.contains("editor_set_playhead"),
        "the stub's envelope should have been rendered back to the client, got {:?}",
        text.text
    );

    client.cancel().await?;
    Ok(())
}

#[tokio::test]
async fn health_answers_in_the_shape_the_apps_supervisor_polls_for()
-> Result<(), Box<dyn std::error::Error>> {
    let base = spawn(Arc::new(StubApp {
        seen: Mutex::new(Vec::new()),
    }))
    .await?;

    let body: Value = reqwest::get(format!("{base}{}", serve::HEALTH_PATH))
        .await?
        .json()
        .await?;

    // `apelles-ai`'s supervisor reads exactly these two keys off every sidecar's
    // /health: 200 + `ok` for liveness, `content_sha256` for the D-101 staleness
    // comparison. Renaming either here silently breaks supervision rather than
    // failing loudly, which is why they are pinned.
    assert_eq!(body["ok"], json!(true));
    assert_eq!(
        body["content_sha256"].as_str().map(str::len),
        Some(16),
        "the staleness hash must be the sidecars' 16-hex-char format, got {:?}",
        body["content_sha256"]
    );
    assert_eq!(body["service"], json!("apelles-mcp"));
    assert_eq!(body["control"], json!("http://127.0.0.1:19788"));
    Ok(())
}
