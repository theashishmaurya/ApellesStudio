#!/usr/bin/env bash
# Apelles MCP server — single entry point for any MCP client's config.
#
# Every client's registration (the Claude Code `claude mcp add` command, or
# a JSON `mcpServers`/`servers`/`context_servers` entry) needs exactly ONE
# absolute path to something runnable — not a Python interpreter path plus a
# separate script path. This script IS that one thing: it resolves its own
# location (so it works regardless of the caller's cwd) and execs the venv's
# python against server.py, so nothing outside this file needs to know the
# venv exists at all.
#
# Requires the one-time `cd mcp && python3 -m venv .venv && .venv/bin/pip
# install -r requirements.txt` setup (see README.md) to have already run —
# this script does not create the venv itself, it only uses it.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$DIR/.venv/bin/python" "$DIR/server.py" "$@"
