/**
 * `@apelles/bridge` — the control bridge's claim, and the rule that one op runs
 * once (B-272).
 *
 * **What it is:** the frontend half of the handshake `app/src-tauri/src/chroma/
 * control.rs` runs with each op registry (Colorist's catch-all, Edit, Motion,
 * Debug). A registry calls [`newBridgeClaim`] once per subscription; the claim
 * it announces on `chroma://bridge-ready` carries a fresh `instance` id, and the
 * control server stamps every `chroma://request` with the `target` instance
 * that is to run it. [`BridgeClaim.isForMe`] is the one test a handler applies
 * before doing anything.
 *
 * **Why (B-272):** Tauri events fan out to EVERY live listener. A registration
 * whose `unlisten` never ran (the dev-mode HMR teardown race `safeUnlisten`
 * swallows, a full reload that left a Rust-side listener behind) kept executing
 * every op next to its replacement, so one `editor_add_marker` made two
 * markers and a 44-frame ripple delete removed 88. With a target, a leaked
 * listener is inert by construction: its instance is not the one the server
 * named, however many of them are alive.
 *
 * **B-280 — a subscription follows its module, not just its component.** Each
 * registry builds its op table inside its subscribing effect, so the table is
 * the one from the module evaluation that ran the effect. A dev hot update
 * re-evaluates the registry module (and the op modules it imports), but under
 * `<React.StrictMode>` (`app/src/main.tsx`) Fast Refresh does not re-run an
 * effect whose dependencies are unchanged: React 19's strict second render
 * (`renderWithHooksAgain`) clears the hot-reload "ignore previous deps" flag
 * and rebuilds the effect list, so `[]` compares equal and the OLD
 * subscription, holding the old op table, stays the announced target. Each
 * registry therefore declares a module-level `REGISTRY_EVALUATION` symbol and
 * lists it as the effect's dependency: constant for a module instance's life
 * (one subscription, as before), new after a hot update (cleanup, then a fresh
 * claim with the new code, which the server then targets).
 *
 * **B-314 — an op the caller gave up on never starts.** The control server
 * waits a bounded time for each reply (`bridge_timeout`) and then answers the
 * MCP client "timed out". The request itself stayed in flight: a busy webview
 * delivers the event late, or the registry awaits before running it, and the
 * op then ran AFTER the caller had moved on, against indices it composed for
 * a timeline its own follow-up calls had since changed (a 20 s
 * `editor_move_clip` that timed out later moved a different clip). The server
 * now stamps every request with `deadline_ms`, the wall-clock moment it stops
 * waiting, and [`assertRequestLive`] refuses to start an op past it. An op
 * already running when the deadline passes still completes; the timeout
 * answer says so.
 *
 * **What it does NOT do:** register listeners, answer ops, or know any op name.
 * A request with no `target` at all (a unit test driving a handler directly) is
 * accepted; the control server always sets one. Likewise a request without a
 * `deadline_ms` never expires.
 */

/** What a registry announces on `chroma://bridge-ready`. */
export interface BridgeClaimWire {
  /** The op prefix it serves (`"editor_"`; `""` for the catch-all). */
  prefix: string;
  /** Prefixes it hands to another registry. */
  defers: string[];
  /** This subscription's identity: new for every registration. */
  instance: string;
}

export interface BridgeClaim {
  /** The payload to emit on `chroma://bridge-ready`. */
  claim: BridgeClaimWire;
  /** Whether a `chroma://request` payload is addressed to THIS subscription. */
  isForMe(requestPayload: unknown): boolean;
}

/** A claim for one new subscription of the registry serving `prefix`. */
export function newBridgeClaim(prefix: string, defers: string[] = []): BridgeClaim {
  const instance = crypto.randomUUID();
  return {
    claim: { prefix, defers, instance },
    isForMe(requestPayload) {
      const target = (requestPayload as { target?: unknown } | null | undefined)?.target;
      return target === undefined || target === instance;
    },
  };
}

/** B-314 — throw (with the reason the op's response carries) when the control
 *  server has already stopped waiting for this request, so a late op is not
 *  started. Registries call it immediately before running the op handler,
 *  after any `await` of their own. Same machine, same wall clock: the server
 *  stamps `deadline_ms` from `SystemTime::now()`, compared here with
 *  `Date.now()`. */
export function assertRequestLive(requestPayload: unknown, now: number = Date.now()): void {
  const deadline = (requestPayload as { deadline_ms?: unknown } | null | undefined)?.deadline_ms;
  if (typeof deadline !== 'number' || !Number.isFinite(deadline) || now <= deadline) return;
  const op = (requestPayload as { op?: unknown }).op;
  throw new Error(
    `not run: the caller stopped waiting ${now - deadline} ms before this op could start (it timed out at the ` +
      `bridge), so it was dropped instead of applying late${typeof op === 'string' ? ` (${op})` : ''}`,
  );
}
