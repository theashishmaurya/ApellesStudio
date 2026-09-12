//! How a tool reaches the app: the `POST /op` boundary, behind a trait (D-312).
//!
//! WHAT THIS IS
//!  [`OpTransport`] — "send one op, get one envelope back" — and the HTTP
//!  implementation of it that talks to the control server running inside the Apelles
//!  desktop app.
//!
//! WHAT IT DOES NOT DO
//!  It does not know any op names, and it must not grow a table of them: that is the
//!  same boundary `control.rs` holds on its own side (D-020). It moves JSON.
//!
//! WHY IT IS A TRAIT
//!  Two reasons, both load-bearing. The parity harness swaps in a recording transport
//!  so all 161 tools — the destructive ones included — can be exercised with no app
//!  running. And serving this same tool surface from inside the Tauri process later
//!  means writing one more implementation, not touching 161 tools (D-312).

use std::time::Duration;

use serde_json::{Value, json};

use crate::{READY_GRACE_SECS, TRANSPORT_SLACK_SECS};

/// A control-server envelope: `{ok, error, result, frame, scopes, histogram,
/// adjustments, image_b64}`, exactly as the frontend produced it. Kept as a raw
/// [`Value`] rather than a struct because this layer adds no meaning to it — the
/// renderers in [`crate::render`] read the keys they need and pass the rest through.
pub type Envelope = Value;

/// A failure to *reach* the app at all.
///
/// Deliberately narrow. An op the app refused is NOT an error here — it is an ordinary
/// envelope with `ok: false` and a reason in it, and so are the control server's own 503
/// (frontend not subscribed yet, B-071) and 504 (frontend did not answer in time,
/// B-153). Both of those carry the detail that matters most, and turning them into
/// exceptions is precisely what once hid it behind a bare "Error executing tool <name>".
#[derive(Debug, thiserror::Error)]
pub enum OpError {
    #[error(
        "Cannot reach the Apelles control server at {base_url}. Is the Apelles desktop app running?"
    )]
    Unreachable { base_url: String },

    #[error("The Apelles control server at {base_url} answered {status} for op '{op}'")]
    Status {
        base_url: String,
        op: String,
        status: u16,
    },

    #[error("The Apelles control server sent something that is not a JSON envelope: {source}")]
    Malformed {
        #[source]
        source: serde_json::Error,
    },
}

/// One op, one envelope.
#[async_trait::async_trait]
pub trait OpTransport: Send + Sync {
    /// POST `{op, args, timeout_ms}` and return the parsed envelope.
    ///
    /// `timeout_ms` is how long the app's frontend gets to answer; the control server
    /// clamps it. A tool that drives a model rather than a slider passes its own (see
    /// [`crate::AI_MASK_TIMEOUT_MS`]). It is a transport concern, not an op argument —
    /// it rides beside `args`, never inside it, so no frontend op may take a parameter
    /// of this name.
    async fn call(&self, op: &str, args: Value, timeout_ms: u64) -> Result<Envelope, OpError>;
}

/// The real thing: the control server inside the running app.
pub struct HttpControlTransport {
    base_url: String,
    client: reqwest::Client,
}

impl HttpControlTransport {
    /// Point at `http://127.0.0.1:<port>`, taking the port from `CHROMA_CONTROL_PORT`
    /// exactly as the app and the Python server both do (default 19788).
    pub fn from_env() -> Self {
        let port = std::env::var("CHROMA_CONTROL_PORT").unwrap_or_else(|_| "19788".to_string());
        Self::new(format!("http://127.0.0.1:{port}"))
    }

    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            client: reqwest::Client::new(),
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }
}

#[async_trait::async_trait]
impl OpTransport for HttpControlTransport {
    async fn call(&self, op: &str, args: Value, timeout_ms: u64) -> Result<Envelope, OpError> {
        // Always outlive the app-side budget so a real frontend timeout comes back as
        // the control server's own explanatory 504 envelope rather than as a client-side
        // read timeout with nothing in it. `READY_GRACE_SECS` covers the readiness wait
        // the server may add on top of that budget on a cold start (B-071).
        let deadline = Duration::from_millis(timeout_ms)
            + Duration::from_secs(READY_GRACE_SECS + TRANSPORT_SLACK_SECS);

        let response = self
            .client
            .post(format!("{}/op", self.base_url))
            .json(&json!({ "op": op, "args": args, "timeout_ms": timeout_ms }))
            .timeout(deadline)
            .send()
            .await
            .map_err(|_| OpError::Unreachable {
                base_url: self.base_url.clone(),
            })?;

        let status = response.status();
        // 503 (B-071) and 504 (B-153) are normal answers with a reason in them, not
        // transport failures — see `OpError`'s own doc.
        if !status.is_success() && status.as_u16() != 503 && status.as_u16() != 504 {
            return Err(OpError::Status {
                base_url: self.base_url.clone(),
                op: op.to_string(),
                status: status.as_u16(),
            });
        }

        let body = response.text().await.map_err(|_| OpError::Unreachable {
            base_url: self.base_url.clone(),
        })?;
        serde_json::from_str(&body).map_err(|source| OpError::Malformed { source })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_port_matches_the_control_server_and_the_python_server() {
        // Not a tautology: this constant is duplicated in three places by necessity
        // (control.rs binds it, the MCP layer dials it, mcp/README.md documents it), so
        // a drift here is a real "cannot reach the app" bug in the field.
        unsafe { std::env::remove_var("CHROMA_CONTROL_PORT") };
        assert_eq!(
            HttpControlTransport::from_env().base_url(),
            "http://127.0.0.1:19788"
        );
    }
}
