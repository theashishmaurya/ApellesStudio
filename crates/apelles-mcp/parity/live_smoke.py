#!/usr/bin/env python3
"""Run the same READ-ONLY tools against a real Apelles app, both servers, and diff (D-312).

WHAT THIS IS
  The other half of the parity story. `capture.py` + `tests/parity.rs` prove the Rust
  server reproduces the Python one's behaviour against a *stub* app, exhaustively and
  with no app running. This proves the remaining thing that stub cannot: that the Rust
  server really does talk to the real control server and get the real answer back.

WHAT IT DOES
  Starts each server in turn over stdio against the SAME running Apelles app, calls the
  named read-only tools on both, and compares the parsed JSON. Anything that differs is
  printed field by field.

WHAT IT DOES NOT DO
  It calls nothing that mutates. The tool list defaults to reads only, and passing a
  mutating tool is on you — this exists to check the wire, not to edit the owner's work.
  It is also not exhaustive and is not meant to be: coverage is the corpus's job, and a
  live app can only ever answer for whatever happens to be open in it.

USAGE
  cargo build -p apelles-mcp
  mcp/.venv/bin/python crates/apelles-mcp/parity/live_smoke.py [tool ...]

  The Apelles desktop app must be running. `CHROMA_CONTROL_PORT` is honoured by both
  servers; both are pointed at the same one.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

HERE = Path(__file__).resolve().parent
CRATE = HERE.parent
REPO = CRATE.parent.parent
SERVER_PY = REPO / "mcp" / "server.py"
RUST_BIN = REPO / "target" / "debug" / "apelles-mcp"

#: Reads only, and the ones that answer without a project open.
DEFAULT_TOOLS = ["get_state", "get_timeline", "motion_get_state"]


async def call_all(command: str, args: list[str], tools: list[str]) -> dict[str, Any]:
    params = StdioServerParameters(
        command=command,
        args=args,
        env={
            "CHROMA_CONTROL_PORT": os.environ.get("CHROMA_CONTROL_PORT", "19788"),
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        },
    )
    out: dict[str, Any] = {}
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            for tool in tools:
                result = await session.call_tool(tool, {})
                text = next((b.text for b in result.content if b.type == "text"), "")
                try:
                    out[tool] = json.loads(text)
                except json.JSONDecodeError:
                    out[tool] = text
    return out


def diff(tool: str, py: Any, rs: Any, path: str = "") -> list[str]:
    """Field-by-field differences, so a mismatch names the key rather than dumping both."""
    if isinstance(py, dict) and isinstance(rs, dict):
        problems = []
        for key in sorted(set(py) | set(rs)):
            if key not in py:
                problems.append(f"{tool}{path}.{key}: only rust has it")
            elif key not in rs:
                problems.append(f"{tool}{path}.{key}: only python has it")
            else:
                problems += diff(tool, py[key], rs[key], f"{path}.{key}")
        return problems
    if isinstance(py, list) and isinstance(rs, list) and len(py) == len(rs):
        return [p for i, (a, b) in enumerate(zip(py, rs)) for p in diff(tool, a, b, f"{path}[{i}]")]
    return [] if py == rs else [f"{tool}{path}: python {py!r} != rust {rs!r}"]


async def main() -> int:
    tools = sys.argv[1:] or DEFAULT_TOOLS
    if not RUST_BIN.exists():
        print(f"build it first: cargo build -p apelles-mcp  (missing {RUST_BIN})", file=sys.stderr)
        return 2

    print(f"tools: {', '.join(tools)}", file=sys.stderr)
    py = await call_all(sys.executable, [str(SERVER_PY)], tools)
    rs = await call_all(str(RUST_BIN), [], tools)

    problems: list[str] = []
    for tool in tools:
        problems += diff(tool, py.get(tool), rs.get(tool))

    if problems:
        print(f"\n{len(problems)} difference(s):", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1
    print(f"\nlive parity OK — {len(tools)} tool(s) identical against the running app", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
