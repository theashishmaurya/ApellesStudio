#!/usr/bin/env bash
# Chroma media-understanding sidecar (D-184). Models pull from the HF cache on
# first use. The app starts this for you — see README.md.
cd "$(dirname "$0")"
exec .venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port "${CHROMA_AI_MEDIA_PORT:-8766}" --log-level warning
