# `apelles-mcp` — the AI-facing tool surface (D-312, D-313)

The MCP server that drives the **running Apelles desktop app**. One tool per capability
the app exposes; each tool POSTs `{op, args, timeout_ms}` to the app's control server and
renders the envelope that comes back.

```
Claude Code / Cursor / … (MCP client)
  │  streamable HTTP :19790/mcp   (D-313 — the app runs one of these for every client)
  │  …or stdio                    (D-312 — the client spawns this binary itself)
apelles-mcp                            ← this crate
  │  HTTP  POST /op {op, args, timeout_ms}
app/src-tauri/src/chroma/control.rs    (control server, in the app, port 19788)
  │  Tauri events  chroma://request  /  chroma://response/<id>
the frontend op registries             (useChromaControl / useEditorControl / useMotionControl)
  │  the SAME store actions the GUI buttons call
render  →  { rendered frame, histogram, adjustments, scopes }
```

**Two HTTP hops, opposite directions**, and it is worth keeping them straight: 19790 is
how a *client reaches this server* (`src/serve.rs`); 19788 is how a *tool reaches the app*
(`src/transport.rs`). Both transports above expose the identical 192 tools off the same
`ApellesMcp` — nothing in `src/tools/` knows which one it is running on.

## Boundary

**This crate contains no grade, mask, timeline or motion logic. Not one line.** Every op
is applied by the frontend through the same store actions the GUI uses, which is what
keeps an MCP edit and a manual slider drag from ever diverging (D-020). A default, a clamp
or a rename implemented here would be a second source of truth, and is a bug.

It also does not change the control-server contract: `control.rs` still knows no op names
and no schemas, and the op registry still lives in the frontend. What this layer *does*
own is the tool list — which is exactly why it, and only it, declares each op's timeout
budget (B-153).

Layering: top of the stack, beside `app/src-tauri`. **Nothing in `crates/*` may depend on
it.**

## Status

The Rust replacement for `mcp/server.py` (D-020). **All 192 tools are ported and pass the
parity gate** — both servers publish an identical tool set over a real MCP session.
`tests/golden/ported.json` is the ledger, and the tests check the live server against it
in both directions, so a tool cannot be dropped or added unnoticed.

The **migration** is not finished: this server has not been used to do real work yet, so
`mcp/server.py` remains the configured server, the rollback, and the reference the corpus
is captured from. Retiring it is a separate, deliberate step.

Plan, divergences and open items: **`docs/notes/mcp-rust-port.md`**.

## Running it

Two transports, same tools. `apelles-mcp --help` lists the arguments.

### HTTP (D-313) — normally you do not run it at all

The desktop app starts and supervises one of these on launch, so a client only needs the
URL:

```bash
claude mcp add --transport http apelles http://127.0.0.1:19790/mcp
```

Other clients' exact config shapes differ (`url` vs `serverUrl`, `mcpServers` vs
`servers` vs `context_servers`, and Cline's `"type": "streamableHttp"`); the in-app
**MCP** dialog — `packages/shell/src/ConnectMcpDialog.tsx` — has the verified snippet for
each one. To run it by hand instead: `apelles-mcp --http [--port <PORT>]`.

**What builds it (B-169).** This crate is deliberately *not* a Cargo dependency of
`apelles`, so nothing in the app's own crate graph produces this binary — the app would
otherwise spawn whatever stale copy was left in `target/<profile>/`. Tauri's build hooks
do it: `app/package.json`'s `tauri:before-dev` / `tauri:before-build` run
`cargo build -p apelles-mcp` before vite. Removing that from either hook re-breaks the
app's MCP server without breaking any build, which is exactly how B-169 shipped —
`app/src-tauri/src/chroma/sidecar.rs` has a test pinning the chain.

`CHROMA_MCP_PORT` overrides the port (default 19790), `CHROMA_MCP_NO_SPAWN` stops the app
auto-starting its own, and `CHROMA_MCP_BIN` points the app's supervisor at a specific
binary. `GET /health` answers `{ok, service, version, content_sha256, control}` — that is
what the supervisor polls, and `content_sha256` is how it tells a stale *externally-run*
server from the one this build would have started. Note the limit of that check (B-169):
it hashes this binary's own bytes, so it cannot tell you the binary is out of date with
respect to its *source* — keeping the artifact current is the build's job, above.

### stdio (D-312) — unchanged

Bare `apelles-mcp` with no arguments is still the stdio server, so a client registered
before D-313 keeps working. Use it for a client with no HTTP support — **Claude Desktop's
`claude_desktop_config.json` is stdio-only** — or to run the binary yourself:

```bash
cargo build --release -p apelles-mcp
claude mcp add apelles -- /ABS/PATH/chroma/target/release/apelles-mcp
```

Either way the Apelles app must be running (the control server binds on app start), with
something open. `CHROMA_CONTROL_PORT` overrides *that* port; default 19788, the same
default the app and the Python server use.

A **debug** build publishes 192 tools. A **release** build drops the twelve `debug_*`
ones, which are behind a real `#[cfg(debug_assertions)]` gate because internal debug
tooling is never shipped (180). The **`motion`** Cargo feature (default on) carries the
47 `motion_*` tools; the beta bundle builds this server `--no-default-features` while the
Motion tab is hidden, so it publishes 133 (D-391). `tests/parity.rs` and
`tests/http_transport.rs` pin the full surface and only build with `motion` on.

## Verifying it

```bash
cargo test -p apelles-mcp                                        # parity gate + HTTP transport
mcp/.venv/bin/python crates/apelles-mcp/parity/capture.py        # re-record the corpus
mcp/.venv/bin/python crates/apelles-mcp/parity/live_smoke.py     # against a running app
```

`tests/parity.rs` replays a golden corpus captured from the Python server — every tool's
name, description and schema, and for 267 recorded calls the exact ops emitted and content
rendered. It needs no Apelles app. `tests/http_transport.rs` (D-313) covers what parity
structurally cannot: it binds the real router on an ephemeral port, dials it with a real
streamable-HTTP client, and checks the surface reached *by URL* is the identical one —
same instructions, same 192 tools, same op emitted, same content back — plus that
`/health` answers in the shape the supervisor polls for. `parity/live_smoke.py` covers the
remaining gap: that this really reaches the real control server. All three, and what each
compares how, are documented in `docs/notes/mcp-rust-port.md`.

## Layout

| path | what it is |
|---|---|
| `src/serve.rs` | how a *client* reaches us: stdio, or the streamable-HTTP router (`/mcp` + `/health`) |
| `src/cli.rs` | which transport the binary was asked for, and on which port |
| `src/transport.rs` | how a *tool* reaches the app: the `OpTransport` trait and its `POST /op` implementation |
| `src/render.rs` | envelope → MCP content: plain JSON, frame + summary, and `inspect_color`'s scopes |
| `src/args.rs` | `WireArgs` — building an `args` object with omit-when-absent as a first-class operation |
| `src/schemas.rs` | the shared nested-argument shapes (the Rust port of `mcp/schemas.py`, D-310) |
| `src/server.rs` | `ApellesMcp`: the handler, the server instructions, the merged router |
| `src/tools/` | the tools, one module per tab — `colorist` / `edit` / `motion` / `debug` — plus `ai_env`, which is deliberately not a tab (D-315: `control.rs` answers those two natively, and the environment they report on backs AI features in two tabs) |
| `parity/` | the harness's recording half, plus the live smoke test |
| `tests/golden/` | the captured corpus and the porting ledger |

Adding a capability is unchanged from D-020: one entry in the owning tab's frontend `OPS`
registry, one tool here. The recipe, and the op-prefix convention that keeps two frontend
registries from racing for one response, is `docs/notes/mcp-architecture.md`.
