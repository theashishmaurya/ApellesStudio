//! `apelles-mcp` — the stdio MCP server an assistant launches to drive the app (D-312).
//!
//! A drop-in replacement for `mcp/server.py`: same tool names, same descriptions, same
//! arguments, same control-server contract. It needs the Apelles desktop app running
//! (the control server binds on app start) and reads `CHROMA_CONTROL_PORT` for the port,
//! default 19788 — exactly as the Python server did.
//!
//! ```text
//! claude mcp add apelles -- /ABS/PATH/chroma/target/release/apelles-mcp
//! ```

use std::sync::Arc;

use apelles_mcp::{ApellesMcp, HttpControlTransport};
use rmcp::ServiceExt;
use rmcp::transport::stdio;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // stdout is the MCP transport — anything printed there corrupts the protocol, so
    // every diagnostic goes to stderr, which the client shows as server logs.
    let transport = Arc::new(HttpControlTransport::from_env());
    eprintln!(
        "[apelles-mcp] control server: {}  (POST /op {{op,args}})",
        transport.base_url()
    );

    let service = ApellesMcp::new(transport).serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}
