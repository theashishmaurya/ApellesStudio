#!/usr/bin/env python3
"""Capture the golden parity corpus from the Python MCP server (D-312).

WHAT THIS IS
    The recording half of the parity harness that gates the Python-to-Rust port of the
    Apelles MCP server. It drives the REAL `mcp/server.py` over a real stdio MCP
    session, with a stub control server standing in for the app, and writes down
    exactly what that server publishes and emits.

WHAT IT DOES
    1. `tools/list` — every tool's name, description and `inputSchema`, verbatim. This
       is the contract an MCP client sees, and the port has to reproduce it.
    2. For every tool, two calls: `minimal` (required arguments only) and `full` (every
       argument the schema declares). Arguments are generated FROM each tool's own
       published schema, deterministically, with a value derived from each parameter's
       own name — so a port that maps `source_start` to the wrong wire key produces a
       different value in the wrong slot and is caught, not silently accepted.
    3. For each call, the exact `{op, args, timeout_ms}` the server POSTed to the
       control server, in order, plus the MCP content blocks it returned.

    The result is `tests/golden/corpus.json`, replayed against the Rust server by
    `tests/parity.rs`. Re-running this on an unchanged Python server must produce a
    byte-identical file; if it does not, that is a real behaviour change to explain.

WHAT IT DOES *NOT* DO
    - It does NOT talk to a running Apelles app, and must not: the corpus has to cover
      the destructive tools too, and the boundary under test (what the MCP layer sends
      and renders) is on this side of the app entirely. A running app is covered
      separately by the live smoke test — see the crate README.
    - It does NOT judge whether an argument is semantically sensible. A generated value
      only has to reach the wire; the stub never interprets it.
    - It does NOT capture the app-side envelope shapes as fact. Those are fixtures in
      `responses.json`, chosen to exercise every rendering branch the MCP layer has.

USAGE
    <python-with-mcp-and-httpx> crates/apelles-mcp/parity/capture.py [--out PATH]

    Needs the same interpreter `mcp/server.py` runs under (`mcp/.venv/bin/python` by
    the setup in `mcp/README.md`). Takes a few seconds; `export` really does poll.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mcp import ClientSession, StdioServerParameters  # noqa: E402
from mcp.client.stdio import stdio_client  # noqa: E402

from stub_control import serve  # noqa: E402

HERE = Path(__file__).resolve().parent
CRATE = HERE.parent
REPO = CRATE.parent.parent
SERVER_PY = REPO / "mcp" / "server.py"
RESPONSES = HERE / "responses.json"
FIXTURE_PNG = HERE / "fixtures" / "screenshot.png"
DEFAULT_OUT = CRATE / "tests" / "golden" / "corpus.json"

#: Stands in for the fixture PNG's absolute path wherever it would otherwise be recorded.
FIXTURE_TOKEN = "__FIXTURE_PNG__"

#: A 1x1 PNG, so `debug_screenshot`'s inline-read branch has a real file to read back.
FIXTURE_PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


# --------------------------------------------------------------------------- #
# deterministic argument generation, from a tool's own published JSON Schema
# --------------------------------------------------------------------------- #


def _seed(name: str) -> int:
    """A stable small integer derived from a parameter's name.

    Named parameters get distinct values so a mis-mapped argument shows up as the wrong
    value in the wrong place rather than passing unnoticed. Deterministic across runs
    and machines — `hash()` is not, `blake2b` is.
    """
    return int.from_bytes(hashlib.blake2b(name.encode(), digest_size=4).digest(), "big")


def _resolve(schema: dict[str, Any], defs: dict[str, Any]) -> dict[str, Any]:
    """Follow a `$ref` into the schema's own `$defs`, once. Non-refs pass through."""
    ref = schema.get("$ref")
    if not ref:
        return schema
    key = ref.rsplit("/", 1)[-1]
    return defs.get(key, {})


def _value(schema: dict[str, Any], defs: dict[str, Any], path: str) -> Any:
    """One deterministic value satisfying `schema`, keyed by `path` for distinctness."""
    schema = _resolve(schema, defs)
    seed = _seed(path)

    if "const" in schema:
        return schema["const"]
    if "enum" in schema:
        options = schema["enum"]
        return options[seed % len(options)]

    for union_key in ("anyOf", "oneOf"):
        if union_key in schema:
            # Optional parameters are modelled as `anyOf: [T, null]`; pick the first
            # branch that is not the null one, which is the shape a caller supplies.
            branches = [b for b in schema[union_key] if _resolve(b, defs).get("type") != "null"]
            if branches:
                return _value(branches[0], defs, path)
            return None

    kind = schema.get("type")
    if isinstance(kind, list):
        kind = next((k for k in kind if k != "null"), None)

    if kind == "object":
        props: dict[str, Any] = schema.get("properties", {})
        if not props:
            # A free-form object (`dict[str, float]` and friends carry only
            # `additionalProperties`). One deterministic entry is enough to prove the
            # map survives the port intact.
            extra = schema.get("additionalProperties")
            inner = (
                _value(extra, defs, f"{path}.value")
                if isinstance(extra, dict)
                else f"v_{path}.value"
            )
            return {f"k_{path}": inner}
        # Every property, not just the required ones: a nested model's own validators
        # (MotionSelection needs a scene index, MotionKeyTarget a key index) reject a
        # partially-filled object, and a full one exercises more of the mapping anyway.
        return {name: _value(sub, defs, f"{path}.{name}") for name, sub in props.items()}

    if kind == "array":
        items = schema.get("items", {})
        count = max(int(schema.get("minItems", 1)), 1)
        return [_value(items, defs, f"{path}[{i}]") for i in range(count)]

    if kind == "integer":
        return seed % 97 + 1
    if kind == "number":
        return round((seed % 9700) / 100.0 - 48.0, 2)
    if kind == "boolean":
        return seed % 2 == 0
    if kind == "string":
        return f"v_{path}"
    if kind == "null":
        return None

    # No `type` at all — a `typing.Any` parameter. A string is the least surprising
    # thing to put on the wire and still proves the value round-trips unchanged.
    return f"any_{path}"


def cases_for(tool_name: str, schema: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """The `minimal` and `full` argument vectors for one tool.

    `minimal` is what a caller who reads only the required list would send; `full` sets
    every declared parameter, which is what actually exercises each per-argument
    omit-if-None branch and each wire-key rename in the tool body.
    """
    defs = schema.get("$defs", {})
    props: dict[str, Any] = schema.get("properties", {})
    required = set(schema.get("required", []))

    minimal = {
        name: _value(sub, defs, f"{tool_name}.{name}")
        for name, sub in props.items()
        if name in required
    }
    full = {name: _value(sub, defs, f"{tool_name}.{name}") for name, sub in props.items()}

    cases = [("minimal", minimal)]
    if full != minimal:
        cases.append(("full", full))
    return cases


# --------------------------------------------------------------------------- #
# capture
# --------------------------------------------------------------------------- #


def _content_blocks(result: Any) -> list[dict[str, Any]]:
    """Normalise an MCP tool result's content to the shape `tests/parity.rs` compares.

    Only the fields that carry meaning are kept: an image is its mime type plus its
    payload, text is its text. Anything else about the transport is not part of the
    contract being ported.
    """
    blocks: list[dict[str, Any]] = []
    for block in result.content:
        kind = getattr(block, "type", None)
        if kind == "text":
            blocks.append({"type": "text", "text": block.text})
        elif kind == "image":
            blocks.append(
                {"type": "image", "mimeType": block.mime_type, "data": block.data}
            )
        else:
            blocks.append({"type": str(kind), "repr": repr(block)})
    return blocks


async def capture(out_path: Path) -> int:
    FIXTURE_PNG.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_PNG.write_bytes(FIXTURE_PNG_BYTES)

    raw = json.loads(RESPONSES.read_text())
    responses = {
        op: json.loads(json.dumps(env).replace("__FIXTURE_PNG__", str(FIXTURE_PNG)))
        for op, env in raw.items()
        if not op.startswith("__comment__")
    }

    server, recorder, port = serve(responses)
    try:
        params = StdioServerParameters(
            command=sys.executable,
            args=[str(SERVER_PY)],
            env={"CHROMA_CONTROL_PORT": str(port), "PATH": "/usr/bin:/bin"},
        )
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                init = await session.initialize()
                listing = await session.list_tools()

                tools = []
                for tool in sorted(listing.tools, key=lambda t: t.name):
                    tools.append(
                        {
                            "name": tool.name,
                            "description": tool.description,
                            "inputSchema": tool.input_schema,
                        }
                    )

                cases = []
                for tool in tools:
                    for label, args in cases_for(tool["name"], tool["inputSchema"]):
                        recorder.reset()
                        result = await session.call_tool(tool["name"], args)
                        cases.append(
                            {
                                "tool": tool["name"],
                                "case": label,
                                "arguments": args,
                                "requests": [
                                    {
                                        "op": ex["op"],
                                        "args": ex["args"],
                                        "timeout_ms": ex["timeout_ms"],
                                    }
                                    for ex in recorder.take()
                                ],
                                "isError": bool(result.is_error),
                                "content": _content_blocks(result),
                            }
                        )
                        print(f"  {tool['name']}/{label}", file=sys.stderr)

                corpus = {
                    "_comment": (
                        "GOLDEN — captured from mcp/server.py by parity/capture.py "
                        "(D-312). Do not hand-edit; re-capture instead."
                    ),
                    "instructions": init.instructions,
                    "fixturePng": str(FIXTURE_PNG.relative_to(CRATE)),
                    "tools": tools,
                    "cases": cases,
                }
    finally:
        server.shutdown()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    # The fixture PNG's absolute path leaks into `debug_screenshot`'s recorded answer,
    # and an absolute path is whatever machine ran the capture. Writing it back as a
    # token keeps the corpus portable and re-capturable to the same bytes anywhere; the
    # replay side substitutes its own copy of the same file.
    text = json.dumps(corpus, indent=2, sort_keys=False).replace(
        json.dumps(str(FIXTURE_PNG))[1:-1], FIXTURE_TOKEN)
    out_path.write_text(text + "\n")
    print(
        f"\n{len(corpus['tools'])} tools, {len(corpus['cases'])} cases -> {out_path}",
        file=sys.stderr,
    )
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args()
    return asyncio.run(capture(args.out))


if __name__ == "__main__":
    raise SystemExit(main())
