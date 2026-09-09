// Unit tests for the session lock (D-268 / B-132).
//
// The three properties that make this a lock rather than the bare `busy`
// boolean it replaces: it names its holder, a nested callee cannot release its
// caller's lock, and an abandoned lock cannot wedge the session forever.
import { describe, expect, it, vi } from 'vitest';

import {
  acquireSessionLock,
  describeHeldLock,
  STALE_SESSION_LOCK_MS,
  type HeldLock,
  type LockSlot,
} from './sessionLock';

/** A `LockSlot` backed by a plain variable — the store backs the same
 *  interface with its own `lock` field. */
function testSlot(): LockSlot & { current: HeldLock | null } {
  const slot = {
    current: null as HeldLock | null,
    read: () => slot.current,
    write: (next: HeldLock | null) => {
      slot.current = next;
    },
  };
  return slot;
}

describe('acquireSessionLock', () => {
  it('grants a free lock and records who took it and when', () => {
    const slot = testSlot();
    const res = acquireSessionLock(slot, 'newProject', 1_000);
    expect(res.ok).toBe(true);
    expect(slot.current).toEqual({ op: 'newProject', since: 1_000 });
  });

  it('refuses a held lock with a message naming the holder and its age', () => {
    const slot = testSlot();
    acquireSessionLock(slot, 'newProject', 1_000);

    const res = acquireSessionLock(slot, 'openProject', 5_200);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    // The whole point of the rewrite: not the opaque 'session busy'.
    expect(res.error).toContain('newProject');
    expect(res.error).toContain('4.2s');
  });

  it('frees the lock on release, so the next caller can take it', () => {
    const slot = testSlot();
    const first = acquireSessionLock(slot, 'newProject', 1_000);
    if (!first.ok) throw new Error('unreachable');
    first.lock.release();

    expect(slot.current).toBeNull();
    expect(acquireSessionLock(slot, 'openProject', 1_100).ok).toBe(true);
  });

  it('release is idempotent and never frees a lock taken since', () => {
    // This is the re-entrancy guarantee `_hydrateOpenDto` depends on: a stale
    // handle calling `release()` must not drop somebody else's lock.
    const slot = testSlot();
    const first = acquireSessionLock(slot, 'newProject', 1_000);
    if (!first.ok) throw new Error('unreachable');
    first.lock.release();

    const second = acquireSessionLock(slot, 'openProject', 2_000);
    if (!second.ok) throw new Error('unreachable');

    first.lock.release(); // the old handle, fired again
    expect(slot.current).toEqual({ op: 'openProject', since: 2_000 });
  });

  it('breaks an abandoned lock so a hung op cannot wedge the session forever', () => {
    // B-132 as it actually happened: an `await` inside a lock-held block never
    // settled, so `release()` never ran and every session action returned
    // 'session busy' for the rest of the process's life.
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const slot = testSlot();
    const hung = acquireSessionLock(slot, 'newProject', 1_000);
    if (!hung.ok) throw new Error('unreachable');

    // Still honoured right up to the threshold.
    expect(acquireSessionLock(slot, 'openProject', 1_000 + STALE_SESSION_LOCK_MS - 1).ok).toBe(
      false,
    );

    const recovered = acquireSessionLock(slot, 'openProject', 1_000 + STALE_SESSION_LOCK_MS);
    expect(recovered.ok).toBe(true);
    expect(slot.current?.op).toBe('openProject');
    // Never silently: the log line is the only evidence a real hang happened.
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain('newProject');

    // And the hung op, if it ever does come back, cannot clobber the new holder.
    hung.lock.release();
    expect(slot.current?.op).toBe('openProject');
    warn.mockRestore();
  });
});

describe('describeHeldLock', () => {
  it('reads as an actionable sentence, not a bare flag', () => {
    expect(describeHeldLock({ op: 'addShots', since: 0 }, 12_340)).toBe(
      "session busy — 'addShots' has held the session lock for 12.3s",
    );
  });
});
