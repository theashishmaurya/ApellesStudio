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
 * **What it does NOT do:** register listeners, answer ops, or know any op name.
 * A request with no `target` at all (a unit test driving a handler directly) is
 * accepted; the control server always sets one.
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
