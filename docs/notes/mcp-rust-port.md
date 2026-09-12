# Porting the MCP server from Python to Rust (D-312)

The worked detail behind **D-312**: how the port is verified, what is done, what is left,
and every place the Rust server deliberately does not match the Python one.

Read D-312 in `docs/08-decisions.md` first for *why*. This file is the *how* and the
*where we are* — it is the thing to open when picking the port back up.

---

## Status

| | |
|---|---|
| Harness | **complete** — covers all 161 tools, passing |
| Tools ported | **47 of 161** — the whole **Colorist** surface (42/42), plus the four tracer tools from the other tabs |
| Remaining | Edit 71 of 73, Motion 35 of 37, debug 8 of 9 |
| `mcp/server.py` | **still live and still the fallback.** Nothing has been retired. |

The ledger of what has moved is `crates/apelles-mcp/tests/golden/ported.json`, and it is
not decoration: `tests/parity.rs` checks the running server's advertised tool set against
it in both directions, and checks every name in it against the golden corpus. A tool
cannot be silently dropped, silently added, or listed under a name that never existed.

**The port is not complete and must not be described as complete.** 114 tools remain — the
whole Edit and Motion surfaces, and eight of the nine debug tools.

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

- every tool's **name, description and `inputSchema`**, verbatim (161 tools);
- for each tool, **two calls** — `minimal` (required arguments only) and `full` (every
  argument the schema declares) — 237 in total;
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
| `the_remaining_work_is_written_down_rather_than_estimated` | the ledger still adds up to 161 |

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
   internal debug tooling is never shipped. A debug build publishes 161 tools; a release
   build publishes 152.
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

## How to port the next tool

1. Find it in `mcp/server.py`. Read the whole function — signature, docstring, body.
2. Add an args struct (`#[derive(Deserialize, JsonSchema)]`) and a `#[tool]` method in the
   right `src/tools/*.rs` module. Copy the docstring into `description = r#"..."#`
   **byte-for-byte**, indentation included; the parity test compares it character by
   character and will tell you immediately if it drifted.
3. Build the wire args with `WireArgs`: `.set()` for a key always sent, `.put()` for one
   sent only when supplied. Spell out any camelCase rename at the call site.
4. Watch for the things that are not uniform:
   - **the op name is not always the tool name** — `get_timeline` → `editor_get_timeline`,
     `set_clip_fade` / `set_clip_speed` / `set_track_duck` likewise,
     `match_to_reference` → `match_reference`, `debug_ui_state` → `debug_get_ui_state`;
   - **the timeout is not always the default** — the AI-mask tools pass
     `AI_MASK_TIMEOUT_MS` (B-153);
   - **the renderer differs** — `render::json_text`, `render::result` (frame + summary), or
     `render::inspect_result`;
   - **`editor_get_capabilities` makes no HTTP call at all** — it returns a large static
     document, which has to be ported as data;
   - **`export` polls** `export_progress` in a loop until it stops running;
   - **`save_grade`, `editor_export` and `export` post-process the envelope** rather than
     rendering it as-is.
5. Add the tool's name to `tests/golden/ported.json` **in the same commit**.
6. `cargo test -p apelles-mcp`. Green means it matches the Python server on every recorded
   call; red names the exact field that does not.

### Shape of the remaining work

By prefix, using `mcp/README.md`'s own split (Colorist 42, Edit 65 + the 4 unprefixed,
Motion 36, debug 9 — 161 with the 9). 131 of the 161 bodies are a single statement; 62
have any branching at all, and almost all of that branching is the omit-when-absent rule
`WireArgs` already implements. The bulk of the work is prose, not logic: the descriptions
are most of `mcp/server.py`'s 6,258 lines and every one of them has to survive intact.

The natural batching is one commit per prefix group, since each maps to one frontend op
registry and one `src/tools/*.rs` module.

---

## What is deliberately still open

- **`mcp/server.py`, `mcp/run.sh` and the Python entry in
  `packages/shell/src/ConnectMcpDialog.tsx` are untouched.** They are the rollback and the
  reference the corpus is captured from, so they cannot be retired before the last tool
  lands. Retiring them is its own deliberate step at the end of the port, and it is the
  coordinating session's call, not a subagent's.
- **The counts published in `mcp/README.md` and `website/src/data/mcp.ts` are unchanged**
  and still describe the Python server, which is still the one in use. They move when the
  port does. (`website/src/data/mcp.ts` is separately already stale — that is B-126, not
  this.)
- **Embedding the server in the Tauri process** — option (1) in D-312 — is a real future
  option and is cheap by construction: one more `OpTransport` implementation and rmcp's
  streamable-HTTP server transport, with all 161 tools untouched. It is not scheduled.
