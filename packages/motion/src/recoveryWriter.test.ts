// @apelles/motion — unit tests for the recovery writer (D-415): debounce,
// ordering through one chain, flush, clear, and failure reporting.
import { describe, expect, it, vi } from 'vitest';

import { createRecoveryWriter, RECOVERY_DEBOUNCE_MS, type RecoveryTimers } from './recoveryWriter';

/** Manual timers: nothing fires until the test says so. */
function manualTimers() {
  let next = 1;
  const pending = new Map<number, () => void>();
  const timers: RecoveryTimers = {
    set: (fn) => {
      const id = next++;
      pending.set(id, fn);
      return id;
    },
    clear: (id) => {
      pending.delete(id);
    },
  };
  return {
    timers,
    pendingCount: () => pending.size,
    fireAll: () => {
      const fns = [...pending.values()];
      pending.clear();
      fns.forEach((fn) => fn());
    },
  };
}

function setup() {
  const log: string[] = [];
  const errors: unknown[] = [];
  const backend = {
    write: vi.fn(async (text: string) => {
      log.push(`write:${text}`);
    }),
    clear: vi.fn(async () => {
      log.push('clear');
    }),
  };
  const t = manualTimers();
  const writer = createRecoveryWriter(backend, (e) => errors.push(e), t.timers, RECOVERY_DEBOUNCE_MS);
  return { writer, backend, log, errors, t };
}

describe('recovery writer', () => {
  it('writes only the latest text, once, after the debounce', async () => {
    const { writer, log, t } = setup();
    writer.schedule('a');
    writer.schedule('ab');
    writer.schedule('abc');
    expect(t.pendingCount()).toBe(1);
    expect(log).toEqual([]);
    t.fireAll();
    await writer.settled();
    expect(log).toEqual(['write:abc']);
  });

  it('flush writes a pending text now and cancels the timer', async () => {
    const { writer, log, t } = setup();
    writer.schedule('x');
    writer.flush();
    await writer.settled();
    expect(log).toEqual(['write:x']);
    expect(t.pendingCount()).toBe(0);
  });

  it('flush with nothing pending does nothing', async () => {
    const { writer, backend } = setup();
    writer.flush();
    await writer.settled();
    expect(backend.write).not.toHaveBeenCalled();
  });

  it('clear drops a pending text and removes the copy', async () => {
    const { writer, log, t } = setup();
    writer.schedule('unsaved');
    writer.clear();
    expect(t.pendingCount()).toBe(0);
    await writer.settled();
    expect(log).toEqual(['clear']);
  });

  it('a write can never land after the clear that followed it', async () => {
    const order: string[] = [];
    let releaseWrite!: () => void;
    const slowWrite = new Promise<void>((r) => {
      releaseWrite = r;
    });
    const t = manualTimers();
    const writer = createRecoveryWriter(
      {
        write: async () => {
          await slowWrite;
          order.push('write');
        },
        clear: async () => {
          order.push('clear');
        },
      },
      () => undefined,
      t.timers,
    );
    writer.schedule('x');
    writer.flush(); // write starts, held open
    writer.clear(); // queued behind it
    releaseWrite();
    await writer.settled();
    expect(order).toEqual(['write', 'clear']);
  });

  it('reports a failed write and keeps working', async () => {
    const { writer, backend, errors, log } = setup();
    backend.write.mockRejectedValueOnce(new Error('disk full'));
    writer.schedule('a');
    writer.flush();
    writer.schedule('b');
    writer.flush();
    await writer.settled();
    expect(errors).toHaveLength(1);
    expect(log).toEqual(['write:b']);
  });
});
