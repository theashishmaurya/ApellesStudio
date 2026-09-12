#!/usr/bin/env bash
# Print the Python interpreter a sidecar should run from, or fail with the fix.
#
#   ai-env/python.sh <sidecar-dir>
#
# The SAME ladder `apelles_ai::sidecar`'s `resolve_python` walks, most specific
# first (D-314) — a sidecar's `run.sh` must not disagree with the app about which
# interpreter it is on, which is exactly what two hand-copied snippets would
# eventually do. Lives here, called by both `run.sh` scripts, per CLAUDE.md's
# "shared logic → never copy-pasted."
#
#   1. $CHROMA_<NAME>_PYTHON   this sidecar, explicitly   (set by the caller)
#   2. $CHROMA_SIDECAR_PYTHON  both sidecars, explicitly
#   3. <sidecar-dir>/.venv     a venv belonging to this sidecar alone
#   4. ai-env/.venv            the shared venv — the D-314 default
#
# There is deliberately no `python3`-on-PATH rung here: the Rust supervisor has
# one because it must degrade rather than block app startup, but a human running
# `./run.sh` by hand is better served by an error naming setup.sh than by a
# system Python that will fail at the first `import torch`.
set -euo pipefail

DIR="${1:?usage: python.sh <sidecar-dir>}"
SHARED="$(cd "$(dirname "$0")" && pwd)"

if [ -n "${SIDECAR_PYTHON_ENV:-}" ] && [ -n "${!SIDECAR_PYTHON_ENV:-}" ]; then
  P="${!SIDECAR_PYTHON_ENV}"
  [ -x "$P" ] || { echo "$SIDECAR_PYTHON_ENV=$P is not executable" >&2; exit 1; }
  echo "$P"; exit 0
fi

if [ -n "${CHROMA_SIDECAR_PYTHON:-}" ]; then
  [ -x "$CHROMA_SIDECAR_PYTHON" ] || {
    echo "CHROMA_SIDECAR_PYTHON=$CHROMA_SIDECAR_PYTHON is not executable" >&2; exit 1; }
  echo "$CHROMA_SIDECAR_PYTHON"; exit 0
fi

for candidate in "$DIR/.venv/bin/python" "$SHARED/.venv/bin/python"; do
  [ -x "$candidate" ] && { echo "$candidate"; exit 0; }
done

echo "no Python environment found for $DIR" >&2
echo "run:  ./ai-env/setup.sh" >&2
exit 1
