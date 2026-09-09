#!/usr/bin/env bash
# Apelles AI sidecar. Models auto-download to ai/models/ on first use.
cd "$(dirname "$0")"
exec .venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port "${CHROMA_AI_PORT:-8765}" --log-level warning
