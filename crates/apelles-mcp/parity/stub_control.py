#!/usr/bin/env python3
"""A stand-in for the Apelles control server, for parity capture only (D-312).

WHAT THIS IS
    A tiny in-process HTTP server that speaks the exact contract
    `app/src-tauri/src/chroma/control.rs` speaks — `POST /op {op, args, timeout_ms}`
    answered with an `{ok, error, result, ...}` envelope — and records every request
    it is handed.

WHAT IT DOES
    Lets `capture.py` drive the real `mcp/server.py` end-to-end for all 161 tools,
    including the destructive ones, with no Apelles app running and no risk to a real
    project. What the port has to be faithful to is *the request the MCP layer emits
    and the MCP content it renders from an envelope* — the two halves that live in the
    MCP layer. The app behind it is deliberately not part of that contract: control.rs
    knows no op names (D-020), so anything the app would do is downstream of the
    boundary being tested.

WHAT IT DOES *NOT* DO
    - No grade, mask, timeline or motion logic of any kind. It never inspects `args`
      beyond echoing them back in its recording; the canned envelope is chosen by op
      NAME alone, from `responses.json`.
    - It is not a mock of the app and must never grow into one. A behaviour that
      depends on what the app actually computes is verified by the live smoke test
      against a running app, not here.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


class Recorder:
    """The exchanges seen so far, in order, guarded for the server's worker threads."""

    def __init__(self, responses: dict[str, Any]) -> None:
        self._responses = responses
        self._lock = threading.Lock()
        self.exchanges: list[dict[str, Any]] = []

    def reset(self) -> None:
        with self._lock:
            self.exchanges = []

    def take(self) -> list[dict[str, Any]]:
        with self._lock:
            taken, self.exchanges = self.exchanges, []
        return taken

    def handle(self, body: dict[str, Any]) -> dict[str, Any]:
        op = body.get("op", "")
        envelope = self._responses.get(op, self._responses["__default__"])
        with self._lock:
            self.exchanges.append(
                {
                    "op": op,
                    "args": body.get("args", {}),
                    "timeout_ms": body.get("timeout_ms"),
                    "response": envelope,
                }
            )
        return envelope


def serve(responses: dict[str, Any]) -> tuple[ThreadingHTTPServer, Recorder, int]:
    """Bind on an ephemeral port and start serving. Returns (server, recorder, port)."""
    recorder = Recorder(responses)

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler's own casing
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw)
            except json.JSONDecodeError:
                body = {}
            payload = json.dumps(recorder.handle(body)).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args: Any) -> None:
            """Silence the default stderr access log — capture output must stay clean."""

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, recorder, port
