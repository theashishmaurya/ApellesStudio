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
//!     `parity.rs` proves the 163 tools behave; it does that over an in-process duplex
//!     stream, which is stdio's shape. It would keep passing if `--http` were broken,
//!     unroutable, or serving a different tool set. This file is the one that fails in
//!     that case: it checks the surface a client reaches *by URL* is the identical
//!     one — same instructions, same tool count, same op emitted, same content back —
//!     and that `/health` answers in the shape the app's supervisor polls for.
//!
//!     Since B-169 it also checks the server is still *there*: every test holds the
//!     serving task and asserts it has not finished, and one of them binds and then
//!     leaves the server strictly alone for a few seconds. A server that answers one
//!     request and then dies used to pass this file cleanly.
//!
//! WHAT IT DOES NOT DO
//!     It does not re-check all 163 tools' schemas or rendering. That is `parity.rs`'s
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
const TOOL_COUNT: usize = 169;

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

/// How long "idle" is for [`the_server_stays_up_when_no_client_ever_connects`].
///
/// B-169's crash loop killed the process in well under a second and on every restart,
/// so a few seconds with the socket still accepting is real evidence rather than a
/// coin flip. Long enough to catch that class of bug, short enough to live in
/// `cargo test`.
const IDLE: std::time::Duration = std::time::Duration::from_secs(3);

/// The real router on an ephemeral loopback port, plus the task serving it.
///
/// The task handle is **kept and checked** rather than dropped on the floor (B-169).
/// This used to be a bare `tokio::spawn(async move { let _ = axum::serve(..).await; })`
/// whose result nothing ever looked at, which meant a server that died the instant
/// after answering — or a server that never came up at all — still left every
/// assertion below passing. The bug that shipped was in exactly that blind spot.
struct Server {
    base: String,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl Server {
    async fn spawn(stub: Arc<StubApp>) -> std::io::Result<Self> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let router = serve::router(ApellesMcp::new(stub), "http://127.0.0.1:19788".into());
        let task = tokio::spawn(async move { axum::serve(listener, router).await });
        Ok(Self {
            base: format!("http://{addr}"),
            task,
        })
    }

    /// Error out — with whatever the server task actually reported — if it is no
    /// longer serving. `axum::serve` only returns when the accept loop is finished,
    /// so *any* completion during a test is a failure, `Ok(())` included.
    async fn still_serving(&mut self) -> Result<(), String> {
        if !self.task.is_finished() {
            return Ok(());
        }
        match (&mut self.task).await {
            Ok(Ok(())) => Err("the server task returned while the test was still using it".into()),
            Ok(Err(e)) => Err(format!("axum::serve failed: {e}")),
            Err(e) => Err(format!("the server task panicked: {e}")),
        }
    }
}

#[tokio::test]
async fn a_real_client_reaches_the_identical_tool_surface_over_http()
-> Result<(), Box<dyn std::error::Error>> {
    let stub = Arc::new(StubApp {
        seen: Mutex::new(Vec::new()),
    });
    let mut server = Server::spawn(stub.clone()).await?;
    let base = server.base.clone();

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
    // Everything above could pass against a server that then fell over, or that had
    // already fallen over after answering. It must still be serving.
    server.still_serving().await?;
    Ok(())
}

/// **B-169's regression guard**: no client, ever, and the server is still there.
///
/// D-313 shipped a server that the app's supervisor killed and respawned forever
/// because it exited about half a second after binding — with nothing connected to it
/// and nothing to serve. Every test in this file passed throughout, because they all
/// dial the server immediately and none of them outlive their own request. This one
/// does the opposite: bind, then *leave it completely alone* for [`IDLE`], then check
/// both halves of "still up" — the task has not completed, and the socket still
/// answers a fresh connection.
#[tokio::test]
async fn the_server_stays_up_when_no_client_ever_connects() -> Result<(), Box<dyn std::error::Error>>
{
    let mut server = Server::spawn(Arc::new(StubApp {
        seen: Mutex::new(Vec::new()),
    }))
    .await?;

    tokio::time::sleep(IDLE).await;

    server.still_serving().await?;

    // `still_serving` proves the accept loop has not returned; this proves the port is
    // genuinely accepting, on a connection opened after the idle period rather than
    // one held open across it.
    let status = reqwest::get(format!("{}{}", server.base, serve::HEALTH_PATH))
        .await
        .map_err(|e| format!("nothing accepting on the port after {IDLE:?} idle: {e}"))?
        .status();
    assert!(
        status.is_success(),
        "the server should still be healthy after {IDLE:?} of no traffic, got {status}"
    );
    Ok(())
}

#[tokio::test]
async fn health_answers_in_the_shape_the_apps_supervisor_polls_for()
-> Result<(), Box<dyn std::error::Error>> {
    let mut server = Server::spawn(Arc::new(StubApp {
        seen: Mutex::new(Vec::new()),
    }))
    .await?;
    let base = server.base.clone();

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
    server.still_serving().await?;
    Ok(())
}

/// The live counterpart of `parity/live_smoke.py`, over HTTP and with no venv.
///
/// The two tests above stub the app, so they prove the transport and nothing about
/// whether the thing on the other end is real. This one calls a **running Apelles**
/// through a **running `apelles-mcp --http`** and prints what came back — the
/// end-to-end round trip D-313 is actually claiming.
///
/// `#[ignore]` because it needs both of those running; `cargo test` must stay green on
/// a machine with neither.
///
/// ```bash
/// # the app supervises one on its own; this is the by-hand equivalent
/// cargo build -p apelles-mcp
/// CHROMA_CONTROL_PORT=19788 ./target/debug/apelles-mcp --http --port 19790 &
/// CHROMA_MCP_PORT=19790 cargo test -p apelles-mcp --test http_transport \
///     -- --ignored --nocapture
/// ```
#[tokio::test]
#[ignore = "needs a running Apelles app and a running apelles-mcp --http"]
async fn live_http_round_trip_against_a_running_app() -> Result<(), Box<dyn std::error::Error>> {
    let port = std::env::var("CHROMA_MCP_PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(serve::DEFAULT_HTTP_PORT);
    let base = format!("http://127.0.0.1:{port}");

    let health: Value = reqwest::get(format!("{base}{}", serve::HEALTH_PATH))
        .await
        .map_err(|e| format!("no apelles-mcp on {port}: {e}"))?
        .json()
        .await?;
    println!("health: {health}");

    let client = ()
        .serve(StreamableHttpClientTransport::with_client(
            reqwest::Client::new(),
            StreamableHttpClientTransportConfig::with_uri(format!("{base}{}", serve::MCP_PATH)),
        ))
        .await?;

    let tools = client.list_all_tools().await?;
    println!("tools advertised over HTTP: {}", tools.len());
    assert_eq!(tools.len(), TOOL_COUNT);

    // A read, never a write: this runs against the owner's real open project.
    let result = client
        .call_tool(CallToolRequestParams::new("get_state"))
        .await?;
    let Some(ContentBlock::Text(text)) = result.content.first() else {
        return Err(format!("get_state returned no text block: {:?}", result.content).into());
    };
    println!("get_state via HTTP -> {}", text.text);

    // The app answers with a JSON envelope; a transport that "worked" but reached
    // nothing real would come back as an unreachable-control-server error string.
    let state: Value = serde_json::from_str(&text.text)
        .map_err(|e| format!("get_state did not return JSON ({e}): {}", text.text))?;
    assert!(
        state.is_object(),
        "expected a state object from the running app, got {state}"
    );

    client.cancel().await?;
    Ok(())
}
