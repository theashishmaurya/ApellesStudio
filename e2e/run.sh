#!/usr/bin/env bash
# D-104 — real E2E test runner (WebdriverIO + @wdio/tauri-service, embedded
# provider, macOS). See docs/notes/e2e-testing.md for the full story on why
# this needs a staging step at all.
#
# Two real constraints this script exists to work around, both found live
# while wiring this up (not assumed from docs):
#   1. Tauri's own build step statically validates EVERY file under
#      app/src-tauri/capabilities/ against whatever plugins are actually
#      compiled in — regardless of what tauri.conf.json's active
#      `security.capabilities` list references. So capabilities/e2e.json
#      (which grants `wdio-webdriver:default`, a permission that only
#      exists when the app is built with the `e2e-testing` Cargo feature)
#      cannot simply live there permanently — it breaks every ordinary
#      `cargo build`/`npm run dev` the instant it's present, feature flag
#      or not. It's staged in only for the duration of this script's build.
#   2. The E2E binary is built into its own target dir (`target/e2e`), not
#      the shared `target/debug` a running `npm run dev` dev server also
#      writes to — building the same output path with a different feature
#      set would clobber the live dev binary and force an unrelated
#      rebuild the next time dev picks back up.
#
# Usage: e2e/run.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

CAP_SRC="e2e/capabilities-staging/e2e.json"
CAP_DST="app/src-tauri/capabilities/e2e.json"

cleanup() {
  rm -f "$CAP_DST"
}
trap cleanup EXIT

echo "[e2e] staging capabilities/e2e.json"
cp "$CAP_SRC" "$CAP_DST"

echo "[e2e] checking for a conflicting cargo/rustc process (this repo's own dev-server discipline)"
if pgrep -f "cargo|rustc" >/dev/null 2>&1; then
  echo "[e2e] a cargo/rustc process is already running — refusing to start a concurrent build (this corrupts target/, see CLAUDE.md)." >&2
  echo "[e2e] wait for it to finish, or stop the dev server, then retry." >&2
  exit 1
fi

echo "[e2e] building the e2e-testing binary into target/e2e (separate from the shared dev target/debug)"
CARGO_TARGET_DIR=target/e2e cargo build -p apelles --no-default-features --features e2e-testing --manifest-path app/src-tauri/Cargo.toml

echo "[e2e] running the WebdriverIO suite"
cd e2e
npx wdio run wdio.conf.mjs
