#!/usr/bin/env bash
# Apelles media-understanding sidecar (D-184). Models pull from the HF cache on
# first use. The app starts this for you — see README.md.
set -euo pipefail
cd "$(dirname "$0")"
# Since D-314 this shares ../ai-env/.venv with the ai/ sidecar (one environment,
# still two processes). `ai-env/python.sh` walks the same ladder the Rust
# supervisor does, so running by hand and being auto-started agree.
export SIDECAR_PYTHON_ENV=CHROMA_AI_MEDIA_PYTHON
PY="$(../ai-env/python.sh "$PWD")"
exec "$PY" -m uvicorn server:app --host 127.0.0.1 --port "${CHROMA_AI_MEDIA_PORT:-8766}" --log-level warning
