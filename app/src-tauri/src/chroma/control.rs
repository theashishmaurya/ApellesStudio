//! Chroma control server (D-020).
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
//! The one exception is [`native_op`] (D-210): a short, explicit list of ops
//! that have no frontend state to consult and are answered here, in Rust —
//! today the debug webview screenshot and its pixel probe. Those deliberately
//! do NOT round-trip through the frontend, because the single most valuable
//! moment to photograph the UI is when the frontend is too wedged to answer
//! (and a screenshot is a picture of the webview, not a fact about the store,
//! so routing it through the store would buy nothing anyway).
//!
//! Those two are also the only thing here that is `#[cfg(debug_assertions)]`
//! (B-100/D-219): internal debug tooling is never shipped, so a release build
//! has no [`native_op`] arms at all and forwards every op onward. The
//! FRONTEND-side `debug_*` ops (D-219's UI-state / DOM-tree / frame-timing
//! registry, `@chroma/debug`) need no special handling here — they are
//! ordinary forwarded ops, gated on their own side by `import.meta.env.DEV`.
//!
//! See chroma/docs/08-decisions.md D-020 / D-210 and
//! chroma/docs/notes/control-server/SPEC.md.

use std::sync::mpsc;
use std::time::Duration;

use tauri::{Emitter, Listener};
use tiny_http::{Header, Method, Response, Server};

const DEFAULT_PORT: u16 = 19788;
/// How long the HTTP request waits for the frontend to apply + render + reply.
const BRIDGE_TIMEOUT: Duration = Duration::from_secs(20);
/// Shorter budget for `GET /health` so a dead/hidden window still answers fast.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(3);

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
            let state = dispatch(&app, "get_state", serde_json::json!({}), HEALTH_TIMEOUT).ok();
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

        // Two shapes: `POST /op {op, args}` (the generic one) or `POST /<op> {..args}`.
        let (op, args) = if path.is_empty() || path == "op" {
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
            (op, args)
        } else {
            let args = serde_json::from_str(&body).unwrap_or_else(|_| serde_json::json!({}));
            (path.clone(), args)
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

        match dispatch(&app, &op, args, BRIDGE_TIMEOUT) {
            Ok(payload) => {
                let _ = req.respond(json_response(200, payload));
            }
            Err(BridgeErr::Timeout) => {
                let _ = req.respond(json_response(
                    504,
                    err_body("frontend did not respond within 20s — is the Chroma window open?"),
                ));
            }
        }
    }
}

enum BridgeErr {
    Timeout,
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
/// B-100/D-219 — this whole function is gated with the module it calls into.
/// Every op it answers is internal debug tooling, and internal debug tooling
/// is never shipped, so a release build gets the [`no-op twin`](native_op)
/// below and forwards everything to the frontend exactly as it did before
/// D-210 introduced the native path.
#[cfg(debug_assertions)]
fn native_op(app: &tauri::AppHandle, op: &str, args: &serde_json::Value) -> Option<String> {
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

/// Release-build twin of [`native_op`] (B-100/D-219): there are no native ops
/// once the debug tooling is compiled out, so everything is forwarded to the
/// frontend. A real function rather than a `cfg` inside the caller, so the one
/// call site reads the same in both configurations.
#[cfg(not(debug_assertions))]
fn native_op(_app: &tauri::AppHandle, _op: &str, _args: &serde_json::Value) -> Option<String> {
    None
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

/// The bridge: emit `chroma://request`, wait for the frontend's
/// `chroma://response/<id>`, return its raw JSON payload string.
fn dispatch(
    app: &tauri::AppHandle,
    op: &str,
    args: serde_json::Value,
    timeout: Duration,
) -> Result<String, BridgeErr> {
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
            log::warn!("[chroma::control] op '{op}' timed out waiting for the frontend");
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
