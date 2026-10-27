// @vitest-environment jsdom
/**
 * @apelles/debug — `debug_get_ui_state`'s `motion.customProxies` (B-282).
 *
 * The op reads the live player's custom-layer proxy store itself, not a copy:
 * a key a mounted layer shows appears with its viewer count, and leaves when
 * nobody shows it. The store's own lifecycle is `@apelles/motion`'s
 * `customProxyStore.test.ts`; this only pins that the debug read is wired to
 * the store the player uses.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async () => null,
  convertFileSrc: (p: string) => p,
}));

const { DEBUG_OPS } = await import('./debugOps');
const { customProxyStore } = await import('@apelles/motion/src/customProxyStore');

const KEY = JSON.stringify({ scenes: [{ layers: [{ use: 'custom', component: 'rings@1', props: { label: 'hi' } }] }] });

describe('debug_get_ui_state reports the custom-layer proxies', () => {
  it('lists a shown key with its state and viewers, and drops it once nobody shows it', () => {
    expect(DEBUG_OPS.debug_get_ui_state({}).motion.customProxies).toEqual([]);
    const leave = customProxyStore.subscribe(KEY, () => {});
    expect(DEBUG_OPS.debug_get_ui_state({}).motion.customProxies).toEqual([
      { component: 'rings@1', props: { label: 'hi' }, status: 'waiting', viewers: 1 },
    ]);
    leave();
    expect(DEBUG_OPS.debug_get_ui_state({}).motion.customProxies).toEqual([]);
  });
});
