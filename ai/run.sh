#!/usr/bin/env bash
# Apelles AI sidecar. Models auto-download to ai/models/ on first use.
# The app normally starts this for you — see docs/notes/sidecar-lifecycle.md.
set -euo pipefail
cd "$(dirname "$0")"
# Since D-314 the interpreter is usually the SHARED ../ai-env/.venv, not a venv
# in this directory. `ai-env/python.sh` walks the same ladder the Rust supervisor
# does, so running by hand and being auto-started agree on the environment.
export SIDECAR_PYTHON_ENV=CHROMA_AI_PYTHON
PY="$(../ai-env/python.sh "$PWD")"
exec "$PY" -m uvicorn server:app --host 127.0.0.1 --port "${CHROMA_AI_PORT:-8765}" --log-level warning
