//! AI-environment tools — is the Python environment every AI feature needs built yet,
//! and force a build attempt now (D-315).
//!
//! **Why these are their own module and not a tab's.** Every other module here mirrors a
//! frontend op registry: Colorist ops are `useChromaControl.ts`, `editor_*` is
//! `@apelles/editor`, `motion_*` is `@apelles/motion`. These two mirror none of them,
//! because they are answered by `control.rs` itself, in Rust, with no frontend round
//! trip at all (the same native path D-210 opened for the debug screenshot). Filing them
//! under a tab would say they belong to that tab's surface, and they belong to all
//! three: the environment they report on backs Colorist's subject masks and depth
//! tracking *and* the Edit tab's transcript and video analysis.
//!
//! **Why an agent needs them.** Until the bootstrap reaches `ready`, every AI-backed
//! tool fails — and before D-315 it failed with a bare connection error that an agent
//! could not tell from a crashed sidecar or a malformed request. The app now prefixes
//! that failure with `apelles_ai::ai_env::NOT_READY_CODE` (`ai_env_not_ready`), and
//! these two are the structured read and the manual nudge that go with it: one says how
//! far along the build is, the other skips the backoff.
//!
//! Every description below is the Python tool's docstring, byte-for-byte, and
//! `tests/parity.rs` compares them character by character (D-312).

use rmcp::model::CallToolResult;
use rmcp::{ErrorData, tool, tool_router};

use crate::args::WireArgs;
use crate::render;
use crate::server::ApellesMcp;

#[tool_router(router = ai_env_router, vis = "pub")]
impl ApellesMcp {
    #[tool(
        name = "ai_env_status",
        description = r#"Is the shared Python environment every AI feature needs built yet — and
    if not, how far along is it (D-315)?

    Call this when an AI-backed tool (`add_subject_mask`, `track_subject`,
    `depth_track`, `editor_get_transcript`, `editor_analyze_video`) fails with an
    error whose first word is `ai_env_not_ready`. That prefix is the machine
    signal that the environment is still being built — it is NOT a bad request
    and NOT a crashed sidecar, and the same call will work once this reports
    `"ready"`.

    Returns {phase, detail, packagesDone, packagesTotal, attempt, retryInSecs,
    lastError, venv, elapsedSecs}. Branch on `phase`:

      "ready"                usable now, so an AI failure is something else
      "checking" | "installingPython" | "creatingVenv" |
      "installingPackages" | "repairing"
                             still working — wait and poll. `packagesDone` /
                             `packagesTotal` are real counts parsed from uv, so
                             3/91 -> 60/91 is progress and a frozen pair with a
                             climbing `elapsedSecs` is one big wheel downloading
      "failed"               an attempt failed and another is already scheduled
                             in `retryInSecs` (almost always: no internet).
                             `ai_env_retry` skips that wait
      "unavailable"          cannot be built here at all — no bundled uv, no
                             lock file, or CHROMA_AI_ENV_NO_BOOTSTRAP is set.
                             NOT retried on a timer and NOT fixable by waiting,
                             so tell the human instead of polling

    Nothing else is blocked: Edit, Motion, Colorist, grading and export all work
    throughout. A non-ready phase is a reason to route around the AI tools for
    now, never a reason to stop working."#
    )]
    pub async fn ai_env_status(&self) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new();
        let env = self.op("ai_env_status", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "ai_env_retry",
        description = r#"Attempt the AI-environment build again right now, instead of waiting out
    the backoff `ai_env_status` reports in `retryInSecs` (D-315). Worth calling
    once you have fixed the likely cause — reconnecting the network is the usual
    one; pointless otherwise, since the backoff will try again by itself.

    Returns the same snapshot `ai_env_status` does, plus `started`: `true` if an
    attempt was really triggered, `false` if there was nothing to trigger —
    already `"ready"`, an attempt already running, or `"unavailable"` (which no
    amount of retrying changes). `false` is a normal answer, not a failure; read
    `phase` and act on that rather than calling this again.

    Retrying costs little and loses nothing: uv's wheel cache survives every
    failed attempt, so a build that died part-way resumes from what it had
    already downloaded rather than starting over."#
    )]
    pub async fn ai_env_retry(&self) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new();
        let env = self.op("ai_env_retry", args).await?;
        Ok(render::json_text(&env))
    }
}

/// This surface's contribution to the merged router.
pub fn router() -> rmcp::handler::server::router::tool::ToolRouter<ApellesMcp> {
    ApellesMcp::ai_env_router()
}
