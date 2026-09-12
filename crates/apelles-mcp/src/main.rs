//! `apelles-mcp` — the MCP server an assistant drives the app through (D-312, D-313).
//!
//! Same 161 tools whichever way it is reached; the only choice this file makes is the
//! transport. It needs the Apelles desktop app running (the control server binds on app
//! start) and reads `CHROMA_CONTROL_PORT` for the port, default 19788.
//!
//! ```text
//! # HTTP (D-313) — the app already runs one of these on 19790, so this is all a
//! # client needs. Nothing to spawn, no path to a binary.
//! claude mcp add --transport http apelles http://127.0.0.1:19790/mcp
//!
//! # stdio (D-312) — for a client with no HTTP support, or to run it by hand.
//! claude mcp add apelles -- /ABS/PATH/chroma/target/release/apelles-mcp
//! ```
//!
//! `--help` for the full argument list.

use std::process::ExitCode;
use std::sync::Arc;

use apelles_mcp::cli::{self, Cli};
use apelles_mcp::{ApellesMcp, HttpControlTransport, serve};

#[tokio::main]
async fn main() -> ExitCode {
    let cli = match Cli::parse(std::env::args().skip(1)) {
        Ok(cli) => cli,
        Err(e) => {
            eprintln!("apelles-mcp: {e}");
            return ExitCode::FAILURE;
        }
    };

    if cli == Cli::Help {
        // The one thing this binary ever prints to stdout on purpose. Every other
        // diagnostic goes to stderr because on the stdio transport stdout is the
        // protocol, and a stray line there corrupts the session.
        print!("{}", cli::HELP);
        return ExitCode::SUCCESS;
    }

    let transport = Arc::new(HttpControlTransport::from_env());
    let control_url = transport.base_url().to_string();
    eprintln!("[apelles-mcp] control server: {control_url}  (POST /op {{op,args}})");
    let service = ApellesMcp::new(transport);

    let result: Result<(), Box<dyn std::error::Error>> = match cli {
        Cli::Stdio => serve::stdio(service).await,
        Cli::Http { port } => serve::http(service, port, control_url)
            .await
            .map_err(Into::into),
        // Handled above, before the transport is built.
        Cli::Help => Ok(()),
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("apelles-mcp: {e}");
            ExitCode::FAILURE
        }
    }
}
