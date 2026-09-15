//! Apelles control server (D-020).
//!
//! A tiny blocking HTTP server that runs *inside* the Tauri app and bridges
//! `HTTP  ⇄  Tauri events  ⇄  the frontend`. Every request is turned into a
//! `chroma://request` event; the frontend (`useChromaControl`) applies it
//! through the *same* store actions the GUI buttons call and replies on
//! `chroma://response/<id>` with the post-render frame + scopes. So an MCP edit
//! and a manual slider drag share exactly one state — they can't diverge.
//!
//! What it does NOT do: any grade or mask logic, and it does not know the op
//! list. It just forwards `{op, args}`. The op registry lives in the frontend.
//!
//! **Per-request timeout (B-153).** `POST /op` also accepts an optional
//! `timeout_ms`. Because this server has no op list, it cannot tell a decode
//! (milliseconds) from an AI matte over a 4K frame (tens of seconds) — and the
//! flat 20s budget it used for both is what made `add_subject_mask` report a
//! failure for a mask it had actually created. The MCP layer owns the tool list
//! and therefore declares the budget; [`bridge_timeout`] clamps it. Nothing
//! about the op-registry boundary changes: this still forwards `{op, args}` and
//! knows nothing about what the op does, only how long the caller says to wait.
//!
//! The one exception is [`native_op`] (D-210): a short, explicit list of ops
//! that have no frontend state to consult and are answered here, in Rust. Those
//! deliberately do NOT round-trip through the frontend, because there is nothing
//! in the store for them to consult and the moment each is most worth having is
//! the moment the frontend cannot answer:
//!
//!   - `debug_screenshot` / `debug_sample_pixel` (D-210) — a screenshot is a
//!     picture of the webview, not a fact about the store, and the single most
//!     valuable time to take one is when the frontend is too wedged to reply.
//!   - `debug_record_video` (D-330) — the same argument over time: a recording
//!     of the window is a capture from outside the frontend, and routing it
//!     through the frontend would mean the render loop being measured also had
//!     to drive the measurement. Unlike every other op here it BLOCKS this
//!     server for its whole duration (seconds), since the loop below serves one
//!     request at a time; `debug_record::MAX_RECORD_SECS` bounds that.
//!   - `ai_env_status` / `ai_env_retry` (D-315) — the AI-environment bootstrap
//!     is a Rust state machine (`apelles_ai::ai_env`) with no store copy, and it
//!     is running at its most interesting *during* startup, before the frontend
//!     registries have subscribed at all.
//!
//! Only the `debug_*` ops are `#[cfg(debug_assertions)]`
//! (B-100/D-219): internal debug tooling is never shipped, so a release build
//! has no [`debug_native_op`] arms at all and forwards them onward; the
//! AI-env pair ships, because "why can't I use the AI features yet" is a
//! user-facing answer. The FRONTEND-side `debug_*` ops (D-219's UI-state /
//! DOM-tree / frame-timing registry, `@apelles/debug`) need no special handling
//! here — they are ordinary forwarded ops, gated on their own side by
//! `import.meta.env.DEV`.
//!
//! **Cold-start readiness (B-071).** This server binds long before any frontend
//! listener exists: [`serve`] is spawned from `lib.rs`'s `.setup()`, i.e. while
//! the Rust process is still starting — the webview has not loaded, React has
//! not mounted, and none of the four `chroma://request` registries have
//! subscribed. Tauri events are not buffered, so an op emitted in that window is
//! dropped on the floor; the request then sat out its whole budget and came back
//! a timeout, which is both a 20-second stall and the wrong diagnosis. (Neither
//! the open port nor `GET /health` disproves it: the port is bound in `.setup()`
//! too, and health answers 200 either way, reporting the truth only in its
//! `bridge` field.)
//!
//! So each frontend registry announces itself on `chroma://bridge-ready` once
//! its own `listen()` has actually resolved, saying which op prefix it claims
//! and which prefixes it defers to another registry; [`dispatch`] blocks until a
//! registry that would really handle THIS op has checked in. The `defers` half
//! is what keeps that correct in the presence of Colorist's catch-all claim —
//! see [`BridgeClaim`]. The op-registry boundary is unchanged: this still knows
//! no op names, only the prefixes the frontend tells it about at runtime.
//!
//! See chroma/docs/08-decisions.md D-020 / D-210 and
//! chroma/docs/notes/control-server/SPEC.md.

use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::time::Duration;

use tauri::{Emitter, Listener};
use tiny_http::{Header, Method, Response, Server};

const DEFAULT_PORT: u16 = 19788;
/// How long the HTTP request waits for the frontend to apply + render + reply,
/// when the caller doesn't say (see [`bridge_timeout`]).
const BRIDGE_TIMEOUT: Duration = Duration::from_secs(20);
/// Ceiling on a caller-supplied `timeout_ms` (B-153). Generous enough for the
/// slowest real op — an AI matte over a 4K frame — without letting a bad value
/// pin an HTTP worker here indefinitely.
const MAX_BRIDGE_TIMEOUT: Duration = Duration::from_secs(300);
/// Floor on a caller-supplied `timeout_ms`: below this, even a healthy
/// frontend's normal render round trip would "time out", which would report a
/// working app as broken.
const MIN_BRIDGE_TIMEOUT: Duration = Duration::from_secs(1);
/// Shorter budget for `GET /health` so a dead/hidden window still answers fast.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(3);
/// B-071 — how long a `POST /op` waits for the frontend registry that owns its
/// op to finish subscribing, on top of its own [`bridge_timeout`] budget.
///
/// Sized for the worst honest case: a cold `tauri dev` start where Vite is
/// still building the frontend while the Rust side is already listening. It is
/// deliberately NOT taken out of the caller's own budget — an AI matte asking
/// for 180s should get 180s of *work*, not 180s minus however long the app took
/// to boot. `mcp/server.py`'s client-side slack (`READY_GRACE_S`) covers this
/// same span on its side so a real cold start still comes back as this server's
/// own explanatory answer rather than an httpx read timeout; the two constants
/// are a pair and move together.
const BRIDGE_READY_TIMEOUT: Duration = Duration::from_secs(30);

type HttpResponse = Response<std::io::Cursor<Vec<u8>>>;

/// Spawned from `lib.rs` `.setup()` on its own thread. Never panics: a bind
/// failure just logs and returns (the app runs fine without the control server).
pub fn serve(app: tauri::AppHandle) {
    let port: u16 = std::env::var("CHROMA_CONTROL_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let addr = format!("127.0.0.1:{port}");

    let server = match Server::http(&addr) {
        Ok(s) => s,
        Err(e) => {
            log::error!("[chroma::control] bind {addr} failed: {e} — control server disabled");
            return;
        }
    };
    log::info!("[chroma::control] listening on http://{addr}  (POST /op {{op,args}})");

    // B-071 — start hearing frontend handshakes BEFORE serving a single
    // request, so a registry that subscribes while the very first HTTP request
    // is already in flight is still recorded in time to answer it.
    let registry: Arc<BridgeRegistry> = Arc::new(BridgeRegistry::default());
    {
        let registry = registry.clone();
        app.listen(
            "chroma://bridge-ready",
            move |ev| match serde_json::from_str::<BridgeClaim>(ev.payload()) {
                Ok(claim) => {
                    log::info!(
                        "[chroma::control] frontend bridge ready: prefix {:?}, defers {:?}",
                        claim.prefix,
                        claim.defers
                    );
                    registry.announce(claim);
                }
                Err(e) => log::warn!("[chroma::control] malformed chroma://bridge-ready: {e}"),
            },
        );
    }

    for mut req in server.incoming_requests() {
        let raw = req.url().to_string();
        let path = raw
            .split('?')
            .next()
            .unwrap_or("")
            .trim_matches('/')
            .to_string();
        let method = req.method().clone();

        // GET /health — liveness + a best-effort snapshot of the real state.
        if method == Method::Get && path == "health" {
            // B-071 — health waits for NOTHING: reporting `bridge: false` fast
            // is the whole job of this endpoint, and blocking it on the readiness
            // handshake would turn "is the app up yet?" into the very stall this
            // endpoint exists to diagnose.
            let state = dispatch(
                &app,
                &registry,
                "get_state",
                serde_json::json!({}),
                HEALTH_TIMEOUT,
                Duration::ZERO,
            )
            .ok();
            let body = serde_json::json!({
                "ok": true,
                "service": "chroma-control",
                "port": port,
                "bridge": state.is_some(),
                "state": state.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()),
            });
            let _ = req.respond(json_response(200, body.to_string()));
            continue;
        }

        if method != Method::Post {
            let _ = req.respond(json_response(405, err_body("POST only")));
            continue;
        }

        let mut body = String::new();
        if req.as_reader().read_to_string(&mut body).is_err() {
            let _ = req.respond(json_response(400, err_body("could not read request body")));
            continue;
        }

        // Two shapes: `POST /op {op, args, timeout_ms?}` (the generic one) or
        // `POST /<op> {..args}`.
        let (op, args, timeout) = if path.is_empty() || path == "op" {
            let v: serde_json::Value =
                serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
            let op = v
                .get("op")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let args = v
                .get("args")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            (op, args, bridge_timeout(v.get("timeout_ms")))
        } else {
            let args = serde_json::from_str(&body).unwrap_or_else(|_| serde_json::json!({}));
            (path.clone(), args, BRIDGE_TIMEOUT)
        };

        if op.is_empty() {
            let _ = req.respond(json_response(400, err_body("missing op")));
            continue;
        }

        // Ops this server answers itself (D-210) — never forwarded onward.
        if let Some(body) = native_op(&app, &op, &args) {
            let _ = req.respond(json_response(200, body));
            continue;
        }

        match dispatch(&app, &registry, &op, args, timeout, BRIDGE_READY_TIMEOUT) {
            Ok(payload) => {
                let _ = req.respond(json_response(200, payload));
            }
            Err(BridgeErr::NotReady) => {
                // B-071 — a real, distinct answer rather than a timeout's wrong
                // one: nothing was ever emitted, so nothing can have half-run,
                // and retrying in a moment genuinely will work. 503, the status
                // for "not ready yet", not 504.
                let _ = req.respond(json_response(
                    503,
                    err_body(&format!(
                        "op '{op}' has no frontend handler subscribed yet — the Apelles window is \
                         still starting up (waited {}s). Nothing was applied; retry in a moment.",
                        BRIDGE_READY_TIMEOUT.as_secs()
                    )),
                ));
            }
            Err(BridgeErr::Timeout) => {
                // B-153 — say what the budget actually was, and that the work
                // may well have LANDED. The frontend keeps running after this
                // gives up: `add_subject_mask` really did create its mask, and
                // the caller was told only that something failed.
                let _ = req.respond(json_response(
                    504,
                    err_body(&format!(
                        "op '{op}' got no reply from the frontend within {}s. The Apelles window \
                         may be closed or busy — but a slow op can also still be running and \
                         COMPLETE after this, so re-read the state (get_state / list_masks) \
                         before assuming nothing happened or retrying.",
                        timeout.as_secs()
                    )),
                ));
            }
        }
    }
}

/// The frontend budget for one request: the caller's `timeout_ms` when it gave
/// one, clamped to [`MIN_BRIDGE_TIMEOUT`]..=[`MAX_BRIDGE_TIMEOUT`], else
/// [`BRIDGE_TIMEOUT`].
///
/// **Why the CALLER decides (B-153).** This server deliberately does not know
/// the op list (see the module doc), so it cannot know that `add_subject_mask`
/// runs SAM 2 + ViTMatte over a 4K frame while `seek` is a decode. A flat 20s
/// for both is what made the AI-mask ops report a failure for work that had in
/// fact succeeded. The MCP layer *does* own the tool list, so it declares the
/// budget per tool and this clamps it.
fn bridge_timeout(requested: Option<&serde_json::Value>) -> Duration {
    match requested.and_then(|v| v.as_u64()) {
        Some(ms) => Duration::from_millis(ms).clamp(MIN_BRIDGE_TIMEOUT, MAX_BRIDGE_TIMEOUT),
        None => BRIDGE_TIMEOUT,
    }
}

enum BridgeErr {
    Timeout,
    /// B-071 — no frontend registry that would handle this op had subscribed
    /// before [`BRIDGE_READY_TIMEOUT`] elapsed. Deliberately distinct from
    /// [`Self::Timeout`]: "the app has not finished starting" and "the app is up
    /// but did not answer in time" are different facts with different advice —
    /// notably, nothing was emitted here, so unlike a timeout the op cannot have
    /// partially run.
    NotReady,
}

/// B-071 — one frontend `chroma://request` registry's own description of what it
/// answers, sent on `chroma://bridge-ready` once its `listen()` has resolved.
///
/// `prefix` is what it claims: `"editor_"`, `"motion_"`, `"debug_"`, and `""`
/// for `useChromaControl.ts`'s catch-all Colorist registry. `defers` is the
/// load-bearing half — that catch-all answers every op EXCEPT the prefixes it
/// deliberately skips, and without saying so out loud its mere presence would
/// make `editor_add_clip` look servable the instant Colorist subscribed, which
/// is exactly the race this exists to close (the Edit registry may not be up
/// yet). Each registry already keeps that skip list in its own handler; the
/// handshake just reports it.
///
/// Deliberately NOT a roster hardcoded on this side: the server would then hold
/// a second copy of a fact the frontend owns, and D-020's whole point is that
/// the op registry lives in one place. What is announced here is prefixes, at
/// runtime, by the code that owns them — never op names.
#[derive(Debug, Clone, serde::Deserialize)]
struct BridgeClaim {
    #[serde(default)]
    prefix: String,
    #[serde(default)]
    defers: Vec<String>,
}

impl BridgeClaim {
    /// Whether this registry would really handle `op`.
    fn serves(&self, op: &str) -> bool {
        op.starts_with(&self.prefix) && !self.defers.iter().any(|d| op.starts_with(d.as_str()))
    }
}

/// B-071 — which frontend registries have checked in, and the condvar
/// [`dispatch`] parks on until one that serves its op does.
#[derive(Default)]
struct BridgeRegistry {
    claims: Mutex<Vec<BridgeClaim>>,
    ready: Condvar,
}

impl BridgeRegistry {
    /// Record (or refresh) one registry's claim. Keyed by `prefix`, so a
    /// re-announcement after a webview reload replaces rather than duplicates.
    fn announce(&self, claim: BridgeClaim) {
        let Ok(mut claims) = self.claims.lock() else {
            return;
        };
        match claims.iter_mut().find(|c| c.prefix == claim.prefix) {
            Some(existing) => *existing = claim,
            None => claims.push(claim),
        }
        self.ready.notify_all();
    }

    /// Block until some checked-in registry serves `op`, or `timeout` elapses.
    /// `Duration::ZERO` makes it a plain non-blocking check.
    fn wait_for(&self, op: &str, timeout: Duration) -> bool {
        let Ok(claims) = self.claims.lock() else {
            return false;
        };
        if timeout.is_zero() {
            return claims.iter().any(|c| c.serves(op));
        }
        let (claims, _) = self
            .ready
            .wait_timeout_while(claims, timeout, |claims| {
                !claims.iter().any(|c| c.serves(op))
            })
            .unwrap_or_else(|e| e.into_inner());
        // Re-read the predicate rather than trusting `timed_out()`: a claim
        // landing in the same instant the timeout fires must still count.
        claims.iter().any(|c| c.serves(op))
    }
}

/// The ops answered in-process instead of being forwarded to the frontend
/// (D-210). Returns `None` for everything else, which is how the caller knows
/// to fall through to [`dispatch`] — so this can never accidentally swallow a
/// real frontend op it doesn't recognise.
///
/// The reply always uses the same `{ok, error, result}` envelope the frontend
/// produces, and always with HTTP 200: a *failed* screenshot is a normal
/// answer with a reason in it, not a transport failure, and the MCP client
/// reads `ok`/`error` rather than the status code.
///
/// **This is still not an op registry.** It is a short, explicit list of ops that
/// have no frontend state to consult *at all*, and the bar for joining it is
/// exactly that: the answer is a fact about this process, not about the store.
/// Everything that is a fact about the store is forwarded, as D-020 requires.
///
/// **The AI-env pair (D-315) is the first shipped member.** `ai_env_status` /
/// `ai_env_retry` read and poke a state machine that lives entirely in
/// `apelles_ai::ai_env` — there is no store copy of it to keep in sync, and the
/// moment the answer is most wanted is early in startup, before the frontend
/// registries have subscribed, which is precisely when a forwarded op cannot be
/// answered ([`BridgeErr::NotReady`]). Routing them through the store would
/// therefore buy nothing and lose the one case that matters.
fn native_op(app: &tauri::AppHandle, op: &str, args: &serde_json::Value) -> Option<String> {
    let result = match op {
        // D-315 — the AI-environment bootstrap. Shipped, not debug-gated: the
        // reason an AI feature is unavailable is a user-facing fact.
        "ai_env_status" => serde_json::to_value(apelles_ai::ai_env::status_snapshot())
            .map_err(|e| format!("could not serialize the AI-env status: {e}")),
        "ai_env_retry" => {
            let started = apelles_ai::ai_env::retry_now();
            let status = apelles_ai::ai_env::status_snapshot();
            serde_json::to_value(status)
                .map(|mut v| {
                    // `started: false` is a real answer, not a failure — it means
                    // there was nothing to retry (already ready, or an attempt is
                    // already in flight) and the caller should say so rather than
                    // show a spinner for a click that did nothing.
                    if let Some(obj) = v.as_object_mut() {
                        obj.insert("started".into(), serde_json::Value::Bool(started));
                    }
                    v
                })
                .map_err(|e| format!("could not serialize the AI-env status: {e}"))
        }
        _ => return debug_native_op(app, op, args),
    };

    Some(match result {
        Ok(value) => serde_json::json!({ "ok": true, "result": value }).to_string(),
        Err(e) => {
            log::warn!("[chroma::control] native op '{op}' failed: {e}");
            err_body(&e)
        }
    })
}

/// The debug-only half of [`native_op`] (B-100/D-219): internal debug tooling is
/// never shipped, so a release build gets the [no-op twin](debug_native_op)
/// below and forwards these two to the frontend exactly as it did before D-210
/// introduced the native path.
#[cfg(debug_assertions)]
fn debug_native_op(app: &tauri::AppHandle, op: &str, args: &serde_json::Value) -> Option<String> {
    let result = match op {
        "debug_screenshot" => {
            let window = args.get("window").and_then(|v| v.as_str());
            let out_path = args.get("out_path").and_then(|v| v.as_str());
            super::debug_capture::screenshot_to_file(app, window, out_path)
                .and_then(|shot| serde_json::to_value(shot).map_err(|e| e.to_string()))
        }
        "debug_sample_pixel" => sample_pixel_args(args).and_then(|(path, x, y)| {
            super::debug_capture::sample_png_pixel(&path, x, y)
                .and_then(|sample| serde_json::to_value(sample).map_err(|e| e.to_string()))
        }),
        // D-330. Native for the same reason a screenshot is: it is a capture
        // of the webview from outside it, not a question about the app's
        // state. Note this one BLOCKS this server for the whole recording —
        // the loop below serves one request at a time — which is why the
        // duration is bounded (`debug_record::MAX_RECORD_SECS`).
        "debug_record_video" => {
            record_video_args(args).and_then(|(duration_secs, out_path, window, fps, width)| {
                super::debug_record::record_window_video(
                    app,
                    window.as_deref(),
                    out_path.as_deref(),
                    duration_secs,
                    fps,
                    width,
                )
                .and_then(|rec| serde_json::to_value(rec).map_err(|e| e.to_string()))
            })
        }
        _ => return None,
    };

    Some(match result {
        Ok(value) => serde_json::json!({ "ok": true, "result": value }).to_string(),
        Err(e) => {
            log::warn!("[chroma::control] native op '{op}' failed: {e}");
            err_body(&e)
        }
    })
}

/// Release-build twin of [`debug_native_op`] (B-100/D-219). A real function
/// rather than a `cfg` inside the caller, so the one call site reads the same in
/// both configurations.
#[cfg(not(debug_assertions))]
fn debug_native_op(
    _app: &tauri::AppHandle,
    _op: &str,
    _args: &serde_json::Value,
) -> Option<String> {
    None
}

/// `{duration_secs, out_path?, window?, fps?, width?}` for
/// `debug_record_video` (D-330). Only `duration_secs` is required, and it is
/// named in the error rather than silently defaulted: a recording whose
/// length the caller did not actually choose is not a useful artefact.
///
/// Range checking lives in `debug_record` (`validate_duration`/`clamp_fps`),
/// not here — this function's job is the JSON shape, and splitting it that
/// way is what lets the range rules be unit-tested without a control server.
#[cfg(debug_assertions)]
#[allow(clippy::type_complexity)]
fn record_video_args(
    args: &serde_json::Value,
) -> Result<
    (
        f64,
        Option<String>,
        Option<String>,
        Option<u32>,
        Option<u32>,
    ),
    String,
> {
    let duration_secs = args
        .get("duration_secs")
        .and_then(|v| v.as_f64())
        .ok_or_else(|| {
            "debug_record_video needs a 'duration_secs' (how many seconds to record)".to_string()
        })?;
    let text = |name: &str| args.get(name).and_then(|v| v.as_str()).map(str::to_string);
    let count = |name: &str| -> Result<Option<u32>, String> {
        match args.get(name) {
            None | Some(serde_json::Value::Null) => Ok(None),
            Some(v) => v
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .map(Some)
                .ok_or_else(|| format!("debug_record_video needs a non-negative integer '{name}'")),
        }
    };
    Ok((
        duration_secs,
        text("out_path"),
        text("window"),
        count("fps")?,
        count("width")?,
    ))
}

/// `{path, x, y}` for `debug_sample_pixel`, with a real message naming the
/// argument that was missing rather than a silent default.
#[cfg(debug_assertions)]
fn sample_pixel_args(args: &serde_json::Value) -> Result<(String, u32, u32), String> {
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "debug_sample_pixel needs a 'path' to a saved screenshot".to_string())?;
    let coord = |name: &str| -> Result<u32, String> {
        args.get(name)
            .and_then(|v| v.as_u64())
            .and_then(|v| u32::try_from(v).ok())
            .ok_or_else(|| format!("debug_sample_pixel needs a non-negative integer '{name}'"))
    };
    Ok((path.to_string(), coord("x")?, coord("y")?))
}

/// The bridge: wait for a frontend registry that serves `op` to be subscribed
/// (B-071), emit `chroma://request`, wait for the frontend's
/// `chroma://response/<id>`, return its raw JSON payload string.
///
/// `ready_wait` is how long to give the handshake before giving up with
/// [`BridgeErr::NotReady`]; `Duration::ZERO` skips waiting entirely (what
/// `GET /health` wants). `timeout` is the separate budget for the reply itself.
fn dispatch(
    app: &tauri::AppHandle,
    registry: &BridgeRegistry,
    op: &str,
    args: serde_json::Value,
    timeout: Duration,
    ready_wait: Duration,
) -> Result<String, BridgeErr> {
    // Emitting before a handler exists loses the event outright — Tauri does not
    // buffer — so this gate is the difference between an op running and an op
    // silently never happening.
    if !registry.wait_for(op, ready_wait) {
        log::warn!("[chroma::control] no frontend registry subscribed for op '{op}' yet");
        return Err(BridgeErr::NotReady);
    }

    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel::<String>();

    let handler_id = app.once(format!("chroma://response/{id}"), move |ev| {
        let _ = tx.send(ev.payload().to_string());
    });

    let _ = app.emit(
        "chroma://request",
        serde_json::json!({ "id": id, "op": op, "args": args }),
    );

    match rx.recv_timeout(timeout) {
        Ok(payload) => Ok(payload),
        Err(_) => {
            app.unlisten(handler_id);
            // B-164 — no `forget_serving` here anymore. A timeout means the
            // frontend hasn't answered YET (SAM 2 routinely runs past this
            // budget), not that its registry is gone — dropping a still-live
            // claim left every later op on this prefix 503-ing "still
            // starting up" against a window that had been healthy for an
            // hour, with no reload ever coming to fix it. See `forget_serving`'s
            // own doc for why this is safe to drop: the reload case it was
            // guarding against already self-heals through `announce()`.
            log::warn!(
                "[chroma::control] op '{op}' timed out waiting for the frontend (it may still complete there)"
            );
            Err(BridgeErr::Timeout)
        }
    }
}

fn json_response(status: u16, body: String) -> HttpResponse {
    let header =
        Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).expect("static header");
    Response::from_string(body)
        .with_status_code(status)
        .with_header(header)
}

fn err_body(msg: &str) -> String {
    serde_json::json!({ "ok": false, "error": msg }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(v: u64) -> serde_json::Value {
        serde_json::json!(v)
    }

    #[test]
    fn no_timeout_given_keeps_the_default() {
        assert_eq!(bridge_timeout(None), BRIDGE_TIMEOUT);
        // a non-numeric value is not a budget — fall back rather than guess
        assert_eq!(
            bridge_timeout(Some(&serde_json::json!("soon"))),
            BRIDGE_TIMEOUT
        );
        assert_eq!(
            bridge_timeout(Some(&serde_json::Value::Null)),
            BRIDGE_TIMEOUT
        );
    }

    #[test]
    fn a_callers_budget_is_honoured_within_the_bounds() {
        // B-153's case: an AI-mask tool asking for more than the flat 20s that
        // was cutting a successful `add_subject_mask` off mid-flight.
        assert_eq!(bridge_timeout(Some(&ms(120_000))), Duration::from_secs(120));
        assert_eq!(bridge_timeout(Some(&ms(5_000))), Duration::from_secs(5));
    }

    #[test]
    fn an_out_of_range_budget_clamps_instead_of_being_taken_literally() {
        // Neither end may be honoured as asked: 0 would report a healthy app as
        // broken on every call, and an hour would pin an HTTP worker here.
        assert_eq!(bridge_timeout(Some(&ms(0))), MIN_BRIDGE_TIMEOUT);
        assert_eq!(bridge_timeout(Some(&ms(3_600_000))), MAX_BRIDGE_TIMEOUT);
    }

    // ---- B-071: cold-start readiness -------------------------------------

    /// The four registries as they really announce themselves — see each hook's
    /// own `BRIDGE_CLAIM`. Colorist is the catch-all that defers three prefixes.
    fn colorist() -> BridgeClaim {
        BridgeClaim {
            prefix: String::new(),
            defers: ["motion_", "editor_", "debug_"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
        }
    }
    fn editor() -> BridgeClaim {
        BridgeClaim {
            prefix: "editor_".into(),
            defers: vec![],
        }
    }

    #[test]
    fn a_registry_serves_exactly_its_own_prefix() {
        assert!(editor().serves("editor_add_clip"));
        assert!(!editor().serves("motion_add_layer"));
        assert!(!editor().serves("get_state"));
    }

    #[test]
    fn the_catch_all_does_not_cover_the_prefixes_it_defers() {
        // The whole point of `defers`. Colorist claims `""`, so a naive
        // "some prefix matches" rule would call `editor_add_clip` servable the
        // moment Colorist subscribed — and the request would then be emitted
        // into a window where the Edit registry is not listening yet and lost.
        let c = colorist();
        assert!(c.serves("get_state"));
        assert!(c.serves("set_primary"));
        assert!(!c.serves("editor_add_clip"));
        assert!(!c.serves("motion_add_layer"));
        assert!(!c.serves("debug_ui_state"));
    }

    #[test]
    fn waiting_is_per_op_not_per_app() {
        let reg = BridgeRegistry::default();
        assert!(!reg.wait_for("get_state", Duration::ZERO)); // cold: nothing at all

        reg.announce(colorist());
        assert!(reg.wait_for("get_state", Duration::ZERO));
        // …and the Edit tab's ops are still correctly NOT ready.
        assert!(!reg.wait_for("editor_add_clip", Duration::ZERO));

        reg.announce(editor());
        assert!(reg.wait_for("editor_add_clip", Duration::ZERO));
    }

    #[test]
    fn a_re_announcement_replaces_rather_than_duplicates() {
        // A webview reload re-runs every registry's effect; the claim list must
        // not grow without bound across reloads.
        let reg = BridgeRegistry::default();
        reg.announce(editor());
        reg.announce(editor());
        assert_eq!(reg.claims.lock().expect("test mutex").len(), 1);
    }

    #[test]
    fn a_claim_arriving_during_the_wait_unblocks_it() {
        // The real cold-start shape: the request lands first, the frontend
        // finishes subscribing a moment later, and the op must then run rather
        // than have been dropped into a window with no listener.
        let reg = Arc::new(BridgeRegistry::default());
        let announcer = reg.clone();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            announcer.announce(editor());
        });
        assert!(reg.wait_for("editor_add_clip", Duration::from_secs(5)));
        t.join().expect("announcer thread");
    }

    #[test]
    fn giving_up_is_bounded_when_nothing_ever_subscribes() {
        let reg = BridgeRegistry::default();
        let started = std::time::Instant::now();
        assert!(!reg.wait_for("editor_add_clip", Duration::from_millis(80)));
        assert!(started.elapsed() >= Duration::from_millis(80));
    }

    #[test]
    fn a_malformed_handshake_payload_is_rejected_not_guessed_at() {
        // `announce` is only ever reached through this parse, so a garbage
        // payload must not be able to register a claim that serves everything.
        assert!(serde_json::from_str::<BridgeClaim>("not json").is_err());
        // Missing fields default rather than fail — an older frontend that only
        // sends `prefix` still registers, it simply defers nothing.
        let claim: BridgeClaim =
            serde_json::from_str(r#"{"prefix":"editor_"}"#).expect("prefix-only claim");
        assert!(claim.defers.is_empty());
        assert!(claim.serves("editor_add_clip"));
    }
}
