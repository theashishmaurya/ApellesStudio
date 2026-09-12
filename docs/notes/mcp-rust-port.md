# Porting the MCP server from Python to Rust (D-312)

The worked detail behind **D-312**: how the port is verified, what is done, what is left,
and every place the Rust server deliberately does not match the Python one.

Read D-312 in `docs/08-decisions.md` first for *why*. This file is the *how* and the
*where we are* — it is the thing to open when picking the port back up.

---

## Status

| | |
|---|---|
| Harness | **complete** — covers all 163 tools, passing (plus the D-313 HTTP-transport test) |
| Tools ported | **163 of 163** — Colorist 42, Edit 73, Motion 37, AI-env 2, debug 9. (D-312 landed 161; D-315 added `ai_env_status` / `ai_env_retry` to both servers in one pass, which is the pattern every new tool follows now that the port is complete — write the Python docstring, copy it verbatim into the Rust `description`, re-run `parity/capture.py`, add the names to `ported.json`.) |
| Remaining | **none.** Both servers publish an identical tool set, verified over a real MCP session. |
| `mcp/server.py` | **still live and still the fallback.** Nothing has been retired — see "what is deliberately still open". |

The ledger of what has moved is `crates/apelles-mcp/tests/golden/ported.json`, and it is
not decoration: `tests/parity.rs` checks the running server's advertised tool set against
it in both directions, and checks every name in it against the golden corpus. A tool
cannot be silently dropped, silently added, or listed under a name that never existed.

**Every tool is ported and passing the gate.** What that means precisely: all 163
publish the same name, the same byte-for-byte description and a structurally identical
schema; all 239 recorded calls emit the same ops with the same arguments and the same
timeout budgets, and render the same content. `python: 163 / rust: 163 / IDENTICAL` over
a real stdio MCP session against each server.

**What that does NOT mean.** The Rust server has not been used to do real work yet. The
corpus proves it behaves like the Python one against a stub; the live smoke proves 16
read-only tools agree against a running app. No mutating tool has been driven against a
real project through the Rust server, and `mcp/server.py` is still what the owner's
editor is configured to use. Retiring the Python server is a separate decision that
should follow a real session's use, not this test suite.

---

## The harness

Two halves, both committed, both re-runnable by anyone.

### 1. Capture — `crates/apelles-mcp/parity/capture.py`

Drives the **real** `mcp/server.py` over a real stdio MCP session, with
`parity/stub_control.py` standing in for the app on an ephemeral port, and writes
`crates/apelles-mcp/tests/golden/corpus.json`.

```bash
mcp/.venv/bin/python crates/apelles-mcp/parity/capture.py
```

It records:

- every tool's **name, description and `inputSchema`**, verbatim (163 tools);
- for each tool, **two calls** — `minimal` (required arguments only) and `full` (every
  argument the schema declares) — 239 in total;
- for each call, the exact **`{op, args, timeout_ms}`** posted to the control server, in
  order, and the exact **MCP content blocks** returned.

Arguments are generated from each tool's own published JSON Schema, deterministically,
with the value for each parameter derived from that parameter's **own name**. That last
detail is what makes the harness able to catch a mis-mapped argument: if the port sends
`source_start`'s value under `sourceLen`, the wrong value shows up in the wrong slot
rather than two interchangeable numbers passing unnoticed.

It needs **no Apelles app** and is safe to run at any time — the destructive tools are
covered precisely because nothing real is behind them. It is deterministic: two
consecutive runs against an unchanged Python server produce a byte-identical corpus, so a
diff after re-capturing is always a real behaviour change to explain.

### 2. Replay — `crates/apelles-mcp/tests/parity.rs`

```bash
cargo test -p apelles-mcp
```

Serves the Rust `ApellesMcp` over an in-process duplex stream and drives it with a real
rmcp client — the same shape of session capture used, so what is compared is what a
client would actually see rather than an internal call path. Five tests:

| test | what it protects |
|---|---|
| `the_server_instructions_are_the_pythons_word_for_word` | the scope discipline a model reads before its first call |
| `the_advertised_tool_set_is_exactly_the_ported_ledger` | no silent drop, no silent add, no invented name |
| `every_ported_tool_publishes_the_same_contract_as_the_python_one` | descriptions byte-for-byte; schemas structurally |
| `every_recorded_call_emits_the_same_ops_and_renders_the_same_content` | the wire — ops, args, timeouts — and the rendered output |
| `the_remaining_work_is_written_down_rather_than_estimated` | the ledger still adds up to 163 |

### 3. Live smoke — `crates/apelles-mcp/parity/live_smoke.py`

The one thing a stub cannot prove: that the Rust server really reaches the real control
server and gets the real answer.

```bash
cargo build -p apelles-mcp
mcp/.venv/bin/python crates/apelles-mcp/parity/live_smoke.py [tool ...]
```

Runs read-only tools through **both** servers against a running Apelles app and diffs the
parsed JSON field by field. Deliberately not exhaustive — coverage is the corpus's job,
and a live app can only answer for whatever happens to be open in it.

### 4. HTTP transport — `crates/apelles-mcp/tests/http_transport.rs` (D-313)

The gap the other three leave: all of them exercise the server over stdio's shape (an
in-process duplex stream, or a real stdio subprocess), so all three would keep passing if
`--http` were broken, unroutable, or quietly serving a different tool set.

```bash
cargo test -p apelles-mcp --test http_transport
```

Binds the real `serve::router` on an ephemeral loopback port, dials it with a real rmcp
streamable-HTTP client, and asserts the surface reached **by URL** is the identical one:
same server instructions, same 163 tools, and for a real tool call the same op with its
B-153 timeout budget intact and the same rendered content back. Plus `/health` in the
shape the app's supervisor polls for — `ok` and a 16-hex-char `content_sha256` — because
renaming either of those breaks supervision silently rather than loudly.

No app needed; the control server is stubbed, as in `parity.rs`.

It also carries `live_http_round_trip_against_a_running_app`, `#[ignore]`d — the Rust
counterpart of `live_smoke.py` above, needing no venv:

```bash
cargo build -p apelles-mcp
CHROMA_CONTROL_PORT=19788 ./target/debug/apelles-mcp --http --port 19790 &
CHROMA_MCP_PORT=19790 cargo test -p apelles-mcp --test http_transport -- --ignored --nocapture
```

That is the round trip D-313 actually claims: a real streamable-HTTP client → a real
`apelles-mcp` → the real control server → the running app, printing the state that comes
back.

---

## What is compared how, and why not byte-for-byte everywhere

| thing | comparison | why |
|---|---|---|
| tool descriptions, server instructions | **byte-for-byte** | prose a model reads and acts on; a reflow is a change |
| emitted `{op, args, timeout_ms}` | **exact JSON equality** | the half that breaks silently — a renamed wire key, a dropped argument, an AI budget lost back to 20s (B-153) |
| rendered content blocks | **JSON value equality** | a client parses this text; the value is the contract, `json.dumps`'s bytes are not |
| `inputSchema` | **normalised structural equality** | Pydantic and schemars spell the same contract differently; byte equality would measure the generator, not the contract |

Schema normalisation resolves `$ref`s, collapses every spelling of "T or null" into one
nullable flag, and drops `title` / `$schema` / `format`. It keeps property names,
requiredness, types, enums, nesting, `additionalProperties: false`, and descriptions
(whitespace-collapsed, since re-wrapping a doc comment is formatting, not content).

Two rules worth knowing before a schema failure confuses you:

- **`default` is not compared.** Where a default is *written down* is a generator choice;
  where it is *applied* is behaviour, and that is checked far more strictly by the emitted
  arguments. A drifted default changes those and fails there.
- **A description may be added, never dropped or changed.** schemars publishes a union's
  own doc comment where Pydantic published nothing; that can only make a schema more
  informative. Losing one, or altering what it says, still fails.

---

## Deliberate divergences from `mcp/server.py`

Every one of these is a decision, not an accident. Nothing else differs; if you find
something that does, it is a bug in the port.

1. **The nine `debug_*` tools are compiled out of a release build**
   (`#[cfg(debug_assertions)]`, `src/tools/debug.rs`). The Python server defined all nine
   unconditionally and relied on the app-side half being absent, so a release build
   advertised nine tools it could never answer. This matches the gate `control.rs` already
   uses for its own native debug ops (B-100 / D-219) and CLAUDE.md's standing rule that
   internal debug tooling is never shipped. A debug build publishes 163 tools; a release
   build publishes 154.
2. **An unreachable app reports its own message.** In Python the `RuntimeError` raised on a
   connection failure was masked by the MCP runtime down to `Error executing tool <name>`,
   discarding "Is the Apelles desktop app running?" — the single most useful sentence it
   could have said. The Rust server returns that text. (Note this is the same masking that
   hid B-168 for four days.)
3. **Rendered JSON is not `ensure_ascii`-escaped, and nested keys from the wire come back
   sorted.** `serde_json` is built here without `preserve_order`, and turning that on is a
   workspace-wide change to how every other crate writes JSON (`grade.json` included) that
   this port has no business making. The *rendered summaries'* own key order IS preserved
   exactly, by serialising a struct rather than a map (`src/render.rs`). Only the values
   that came off the wire sort, and a client parses them anyway.

---

## Adding a tool after this port

The port is finished, but this is still the recipe — a new capability lands here the same
way, and the same non-uniform cases are still waiting.

1. Add it to `mcp/server.py` first if it is not there yet (that server is still the
   reference the corpus is captured from), then re-capture.
2. Add an args struct (`#[derive(Deserialize, JsonSchema)]`) and a `#[tool]` method in the
   right `src/tools/*.rs` module. Copy the docstring into `description = r#"..."#`
   **byte-for-byte**, indentation included; the parity test compares it character by
   character and will tell you immediately if it drifted.
3. Build the wire args with `WireArgs`: `.set()` for a key always sent, `.put()` for one
   sent only when supplied, `.put_if()` for a flag whose mere presence is the signal.
   Spell out any camelCase rename at the call site.
4. Add the name to `tests/golden/ported.json` **in the same commit**, and run
   `cargo test -p apelles-mcp`.

### The cases that are not uniform, all of which bit during this port

- **The op name is not always the tool name** — `get_timeline` → `editor_get_timeline`,
  `set_clip_fade` / `set_clip_speed` / `set_track_duck` likewise, `match_to_reference` →
  `match_reference`, `debug_ui_state` → `debug_get_ui_state`.
- **The timeout is not always the default** — the AI-mask tools pass `AI_MASK_TIMEOUT_MS`
  (B-153). Losing that silently turns a working call into a reported failure.
- **The renderer differs** — `render::json_text`, `render::result` (frame + summary), or
  `render::inspect_result`.
- **`editor_get_capabilities` makes no HTTP call at all** — a static ~25 KB document,
  carried across as `src/tools/edit/capabilities.json` by dumping the Python dict rather
  than retyping it.
- **`export` polls** `export_progress` in a loop until it stops running; `editor_export`
  strips the ffmpeg argv out of its answer; `save_grade` and `export`'s `.cube` branch
  flatten `result` up beside `ok`/`error`.
- **A `| None` annotation does NOT mean optional.** `editor_move_media`'s `folder` is
  annotated `str | None` with no default, so it is REQUIRED and nullable — the key must be
  present, its value may be null. schemars reports every `Option` as optional, so that one
  needs `#[schemars(extend("required" = [...]))]`; its per-field `required` attribute
  drops the nullability instead, which is not the same contract.
- **Rust keywords collide with real wire keys and parameter names** — `use`
  (`motion_add_layer`), `from`/`to` (`editor_move_track`), `type` (`add_component`). All
  are serde renames; the published name never changes.
- **A doc comment on a shared type reaches the published schema.** Notes meant for whoever
  edits the type must be plain `//` comments, and a doc comment on an enum shadows the
  per-field description of any field that refs it. Both of these got caught by the gate
  rather than by review.
- **Presence-signalled booleans** (`reset`, `auto_key`, `force`, `clear`) are sent only
  when true — `false` and absent are the same thing to the handler, and sending `false` is
  not.

---

## What is deliberately still open

- **`mcp/server.py` and `mcp/run.sh` are untouched, deliberately.** (D-313 did rework
  `packages/shell/src/ConnectMcpDialog.tsx` — it now leads with the Rust server's HTTP
  URL — but that is a change of what the dialog *recommends*, not a retirement: the
  Python path is still reachable there, and the two files below it still exist.) The last tool
  has now landed, so the blocker is no longer "the port is unfinished" — it is that the
  Rust server has not yet been used to do real work, and that the corpus is captured FROM
  the Python one. Retiring them is its own deliberate step, and it is the coordinating
  session's call (and the owner's), not a subagent's. The sensible order: point a real
  session at the Rust binary, use it for an actual edit, then retire.
- **The counts published in `mcp/README.md` and `website/src/data/mcp.ts` are unchanged**
  and still describe the Python server, which is still the one in use. They move when the
  port does. (`website/src/data/mcp.ts` is separately already stale — that is B-126, not
  this.)
- **Embedding the server in the Tauri process** — option (1) in D-312 — is still open,
  and D-313 changed what is left of it. The rmcp half is now done and shipped
  (`src/serve.rs`), so what remains is only the in-process `OpTransport` that would skip
  the `POST /op` hop. D-313 deliberately did *not* take it: the app supervises
  `apelles-mcp` as a child process instead, so an MCP-server bug cannot take down the
  editor and `app/src-tauri` does not have to depend on a crate that sits beside it. All
  163 tools stay untouched either way. Not scheduled.
