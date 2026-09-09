// Apelles — the session lock (D-268 / B-132).
//
// **What it is.** The mutual-exclusion primitive behind `useSessionStore`'s
// `busy` flag: the thing that stops two project/shot mutations
// (`newProject`, `openProject`, `addShots`, `removeShot`, `switchToShot`,
// `relinkShot`, `saveUntitledAs`) from running against the same decode
// session at the same time.
//
// **What it does that a bare `busy: boolean` did not** (all three are B-132,
// the bug that made a fresh app unable to create a project at all):
//
//   1. **It names its holder.** A refusal is
//      `session busy — 'newProject' has held the session lock for 4.2s`,
//      not the opaque `session busy` that told tonight's live debugging
//      session nothing at all about which op was stuck or for how long.
//   2. **It is re-entrant by explicit hand-off, not by accident.**
//      `_hydrateOpenDto` is called BOTH directly (SourcesPanel's "add to
//      grading") and from inside five actions that already hold the lock. As
//      a bare flag it unconditionally set `busy: true` on entry and cleared
//      it in its own `finally` — so on every one of those five paths it
//      released its *caller's* lock while the caller was still running, and
//      the "mutual exclusion" was a no-op for the whole tail of the outer
//      action. A holder now passes its handle down; `release()` is identity-
//      checked, so a nested callee can never drop a lock it did not take.
//   3. **It cannot wedge the app forever.** A single `await` that never
//      settles inside a lock-held block — a lost Tauri IPC transport
//      (B-081), a Rust command that blocks the async runtime, an op that
//      outlives `control.rs`'s 20s `BRIDGE_TIMEOUT` while still running —
//      used to latch `busy: true` for the entire life of the process, with
//      no reset path and no way to even observe the flag. Every session
//      action then returned `session busy` forever and the only user-facing
//      recovery was quitting the app. A lock held past
//      [`STALE_SESSION_LOCK_MS`] is now considered abandoned, logged loudly,
//      and broken so the session recovers.
//
// **What it does NOT do.** It is not a general-purpose async mutex: there is
// no queue and no fairness, because the callers do not want to wait — a
// second click / MCP call while one is in flight should be *refused with a
// reason*, not silently queued behind a multi-second decode. It also does not
// cancel the op it steals the lock from; nothing in the Tauri bridge is
// cancellable, so a stolen-from op keeps running to completion and simply
// finds, at `release()`, that it no longer owns the lock. Stealing is
// containment, not a cure — the log line it emits is the evidence that a real
// hang happened and is what a future investigation starts from.
//
// Pure and store-agnostic on purpose (it talks to a two-method [`LockSlot`],
// not to zustand) so it is unit-testable on its own — see `sessionLock.test.ts`.

/** A lock currently held: which action took it, and when (epoch ms). */
export interface HeldLock {
  op: string;
  since: number;
}

/** The holder's side of an acquired lock. `release()` is idempotent and is a
 *  no-op once this handle's lock has been superseded (see the stale-lock note
 *  in the module doc), so a `finally { lock.release() }` is always safe. */
export interface SessionLockHandle {
  readonly op: string;
  release(): void;
}

/** The single mutable cell the lock lives in. `useSessionStore` backs this
 *  with its own `lock` field; a test can back it with a plain variable. */
export interface LockSlot {
  read(): HeldLock | null;
  write(next: HeldLock | null): void;
}

export type AcquireResult =
  | { ok: true; lock: SessionLockHandle }
  | { ok: false; error: string };

/**
 * How long a lock may be held before it is treated as abandoned.
 *
 * Deliberately generous — this is a wedge-breaker, not a deadline. The
 * slowest legitimate holder is `openProject`/`newProject` on a project full
 * of large clips, which probes every one of them (`open_manifest` →
 * `register_video_shot`) before it returns; a real cold open of a big project
 * is seconds, not minutes. Two minutes is far outside that and comfortably
 * outside `control.rs`'s own 20s `BRIDGE_TIMEOUT`, so breaking the lock can
 * only ever affect an op that is already, unambiguously, not coming back.
 */
export const STALE_SESSION_LOCK_MS = 120_000;

/** The user-facing refusal for a lock that is legitimately held. Names the
 *  holder and the age, because "session busy" alone is unactionable for both
 *  a human reading a toast and an agent reading an MCP error. */
export function describeHeldLock(held: HeldLock, now: number = Date.now()): string {
  const seconds = Math.max(0, now - held.since) / 1000;
  return `session busy — '${held.op}' has held the session lock for ${seconds.toFixed(1)}s`;
}

/**
 * Take the lock for `op`, or refuse with a reason naming the current holder.
 *
 * A lock older than [`STALE_SESSION_LOCK_MS`] is broken rather than honoured
 * (see the module doc): the previous holder's handle stops matching, so its
 * own `release()` becomes a no-op and cannot clobber the new holder.
 */
export function acquireSessionLock(
  slot: LockSlot,
  op: string,
  now: number = Date.now(),
): AcquireResult {
  const held = slot.read();
  if (held) {
    const age = now - held.since;
    if (age < STALE_SESSION_LOCK_MS) {
      return { ok: false, error: describeHeldLock(held, now) };
    }
    // Never silent: this is the only trace that a real hang happened, and the
    // op name is the whole lead for diagnosing it.
    console.error(
      `[session] breaking a stale session lock — '${held.op}' has held it for ` +
        `${(age / 1000).toFixed(1)}s and is not coming back. Recovering the session; ` +
        `whatever '${held.op}' was awaiting never settled (see docs/BUGS.md B-132).`,
    );
  }

  const mine: HeldLock = { op, since: now };
  slot.write(mine);
  return {
    ok: true,
    lock: {
      op,
      release: () => {
        // Identity check, not a truthiness check: this is what makes a nested
        // callee unable to release its caller's lock, and a stolen-from
        // holder unable to release the thief's.
        if (slot.read() === mine) slot.write(null);
      },
    },
  };
}
