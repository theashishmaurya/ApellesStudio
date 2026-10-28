// B-272 — a leaked (never-unlistened) registration must not execute an op the
// control server addressed to its replacement.
import { describe, expect, it } from 'vitest';
import { assertRequestLive, newBridgeClaim } from './controlBridge';

describe('newBridgeClaim (B-272)', () => {
  it('gives every registration its own instance id', () => {
    const a = newBridgeClaim('editor_');
    const b = newBridgeClaim('editor_');
    expect(a.claim.instance).not.toBe(b.claim.instance);
    expect(a.claim).toMatchObject({ prefix: 'editor_', defers: [] });
  });

  it('two live registrations of one registry run an op exactly once', () => {
    // The page after an HMR reload: the first subscription was never torn down
    // and both still hear every event. The server names the latest announcer.
    const leaked = newBridgeClaim('editor_');
    const current = newBridgeClaim('editor_');
    const executions: string[] = [];
    const deliver = (target: string) => {
      const payload = { id: 'r1', op: 'editor_add_marker', args: {}, target };
      for (const [name, bridge] of [['leaked', leaked], ['current', current]] as const) {
        if (bridge.isForMe(payload)) executions.push(name);
      }
    };
    deliver(current.claim.instance);
    expect(executions).toEqual(['current']);
  });

  it('accepts an untargeted request (a handler driven directly by a test)', () => {
    expect(newBridgeClaim('editor_').isForMe({ id: 'r', op: 'editor_x' })).toBe(true);
    expect(newBridgeClaim('editor_').isForMe(undefined)).toBe(true);
  });
});

// B-314 — an op whose caller already timed out at the bridge must not start.
describe('assertRequestLive (B-314)', () => {
  it('lets a request through until its deadline, and refuses it after', () => {
    expect(() => assertRequestLive({ op: 'editor_move_clip', deadline_ms: 1000 }, 999)).not.toThrow();
    expect(() => assertRequestLive({ op: 'editor_move_clip', deadline_ms: 1000 }, 1000)).not.toThrow();
    expect(() => assertRequestLive({ op: 'editor_move_clip', deadline_ms: 1000 }, 1250)).toThrow(
      /not run: the caller stopped waiting 250 ms .*\(editor_move_clip\)/,
    );
  });

  it('never expires a request without a usable deadline', () => {
    expect(() => assertRequestLive({ op: 'x' }, 10 ** 15)).not.toThrow();
    expect(() => assertRequestLive({ op: 'x', deadline_ms: null }, 10 ** 15)).not.toThrow();
    expect(() => assertRequestLive(undefined, 10 ** 15)).not.toThrow();
  });
});
