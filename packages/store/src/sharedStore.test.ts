// D-358 / B-217 — the HMR-resilient singleton factory.
//
// A Vite module re-evaluation is, from this module's point of view, exactly
// "call `createSharedStoreIn` again with the same registry and the same key":
// `import.meta.hot.data` is the object Vite carries across, and `hotRegistry()`
// is the only thing these tests stand in for. So the re-evaluation these tests
// simulate is the real mechanism, not an approximation of it — what they cannot
// cover is Vite's own decision to re-evaluate the module in the first place, and
// the loading of two copies of one module under two different URLs (which
// `import.meta.hot.data` does not address either; that is what the
// project-identity guard is for).
import { describe, expect, it } from 'vitest';

import { createSharedStoreIn, type SharedStoreRegistry } from './sharedStore';

interface Counter extends Record<string, unknown> {
  count: number;
  label: string;
  bump: () => void;
}

const counter =
  (step: number) =>
  (set: (partial: Partial<Counter>) => void, get: () => Counter) => ({
    count: 0,
    label: 'first',
    bump: () => set({ count: get().count + step }),
  });

describe('createSharedStoreIn', () => {
  it('returns the SAME instance on a second evaluation with the same registry', () => {
    const registry: SharedStoreRegistry = new Map();

    const first = createSharedStoreIn<Counter>(registry, 'test.counter', counter(1));
    const second = createSharedStoreIn<Counter>(registry, 'test.counter', counter(1));

    expect(second).toBe(first);
  });

  it('keeps the live state across the re-evaluation', () => {
    const registry: SharedStoreRegistry = new Map();

    const first = createSharedStoreIn<Counter>(registry, 'test.counter', counter(1));
    first.getState().bump();
    first.getState().bump();
    expect(first.getState().count).toBe(2);

    const second = createSharedStoreIn<Counter>(registry, 'test.counter', counter(1));
    expect(second.getState().count).toBe(2);
  });

  it('adopts the re-evaluated actions, and they drive the surviving instance', () => {
    const registry: SharedStoreRegistry = new Map();

    const first = createSharedStoreIn<Counter>(registry, 'test.counter', counter(1));
    first.getState().bump();

    // The "edit" a developer just made: `bump` now steps by 10.
    const second = createSharedStoreIn<Counter>(registry, 'test.counter', counter(10));
    second.getState().bump();

    expect(second.getState().count).toBe(11);
    // …and the module that never re-imported still sees it, because there is
    // only one store. This is the whole of B-217 in one assertion.
    expect(first.getState().count).toBe(11);
  });

  it('adds a newly introduced state key but does not reset an existing one', () => {
    const registry: SharedStoreRegistry = new Map();

    const first = createSharedStoreIn<Counter>(registry, 'test.counter', counter(1));
    first.getState().bump();
    first.setState({ label: 'edited by the user' });

    const second = createSharedStoreIn<Counter & { added: string }>(
      registry,
      'test.counter',
      (set, get) => ({
        count: 0,
        label: 'first',
        added: 'new field',
        bump: () => set({ count: get().count + 1 }),
      }),
    );

    expect(second.getState().added).toBe('new field');
    expect(second.getState().label).toBe('edited by the user');
    expect(second.getState().count).toBe(1);
  });

  it('keeps stores with different keys apart', () => {
    const registry: SharedStoreRegistry = new Map();

    const a = createSharedStoreIn<Counter>(registry, 'test.a', counter(1));
    const b = createSharedStoreIn<Counter>(registry, 'test.b', counter(1));

    expect(b).not.toBe(a);
  });

  it('is a plain create() with no registry — production and vitest', () => {
    const a = createSharedStoreIn<Counter>(null, 'test.counter', counter(1));
    const b = createSharedStoreIn<Counter>(null, 'test.counter', counter(1));

    expect(b).not.toBe(a);
  });
});
