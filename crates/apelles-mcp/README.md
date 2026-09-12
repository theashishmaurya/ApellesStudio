# `apelles-mcp` — the AI-facing tool surface (D-312)

The MCP server an assistant launches to drive the **running Apelles desktop app**. One
tool per capability the app exposes; each tool POSTs `{op, args, timeout_ms}` to the
app's control server and renders the envelope that comes back.

```
Claude (MCP client)
  │  stdio
apelles-mcp                            ← this crate
  │  HTTP  POST /op {op, args, timeout_ms}
app/src-tauri/src/chroma/control.rs    (control server, in the app, port 19788)
  │  Tauri events  chroma://request  /  chroma://response/<id>
the frontend op registries             (useChromaControl / useEditorControl / useMotionControl)
  │  the SAME store actions the GUI buttons call
render  →  { rendered frame, histogram, adjustments, scopes }
```

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

The Rust replacement for `mcp/server.py` (D-020). **All 161 tools are ported and pass the
parity gate** — both servers publish an identical tool set over a real MCP session.
`tests/golden/ported.json` is the ledger, and the tests check the live server against it
in both directions, so a tool cannot be dropped or added unnoticed.

The **migration** is not finished: this server has not been used to do real work yet, so
`mcp/server.py` remains the configured server, the rollback, and the reference the corpus
is captured from. Retiring it is a separate, deliberate step.

Plan, divergences and open items: **`docs/notes/mcp-rust-port.md`**.

## Running it

```bash
cargo build --release -p apelles-mcp
claude mcp add apelles -- /ABS/PATH/chroma/target/release/apelles-mcp
```

The Apelles app must be running (the control server binds on app start), with something
open. `CHROMA_CONTROL_PORT` overrides the port; default 19788, the same default the app
and the Python server use.

A **release** build publishes 152 tools; a **debug** build also publishes the nine
`debug_*` ones, which are behind a real `#[cfg(debug_assertions)]` gate because internal
debug tooling is never shipped.

## Verifying it

```bash
cargo test -p apelles-mcp                                        # the parity gate
mcp/.venv/bin/python crates/apelles-mcp/parity/capture.py        # re-record the corpus
mcp/.venv/bin/python crates/apelles-mcp/parity/live_smoke.py     # against a running app
```

`tests/parity.rs` replays a golden corpus captured from the Python server — every tool's
name, description and schema, and for 237 recorded calls the exact ops emitted and content
rendered. It needs no Apelles app. `parity/live_smoke.py` covers the one thing the corpus
cannot: that this really reaches the real control server. Both, and what each compares how,
are documented in `docs/notes/mcp-rust-port.md`.

## Layout

| path | what it is |
|---|---|
| `src/transport.rs` | the `OpTransport` trait and its HTTP implementation — the `POST /op` boundary |
| `src/render.rs` | envelope → MCP content: plain JSON, frame + summary, and `inspect_color`'s scopes |
| `src/args.rs` | `WireArgs` — building an `args` object with omit-when-absent as a first-class operation |
| `src/schemas.rs` | the shared nested-argument shapes (the Rust port of `mcp/schemas.py`, D-310) |
| `src/server.rs` | `ApellesMcp`: the handler, the server instructions, the merged router |
| `src/tools/` | the tools, one module per tab — `colorist` / `edit` / `motion` / `debug` |
| `parity/` | the harness's recording half, plus the live smoke test |
| `tests/golden/` | the captured corpus and the porting ledger |

Adding a capability is unchanged from D-020: one entry in the owning tab's frontend `OPS`
registry, one tool here. The recipe, and the op-prefix convention that keeps two frontend
registries from racing for one response, is `docs/notes/mcp-architecture.md`.
