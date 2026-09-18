// @vitest-environment jsdom
/**
 * `@apelles/store` — B-217/D-358: this module must not assume
 * `import.meta.hot.data` exists merely because `import.meta.hot` does.
 *
 * No `B-NNN` of its own: this was a defect in D-358's own first revision, caught
 * by the full `@apelles/editor` suite before it ever reached `main`. It gets a
 * regression test rather than a bug entry — but the test is worth its weight,
 * because the failure mode is maximally misleading (see below).
 *
 * **Why this tier, and why jsdom specifically.** `sharedStore.test.ts` runs in
 * vitest's default `node` environment, where there is no `import.meta.hot` at
 * all, so every path through `hotMap()` short-circuits on the first check and
 * the bug this file exists for is unreachable there. vitest's `jsdom`/`web`
 * environment is different: it supplies an `import.meta.hot` **stub whose `data`
 * is `undefined`**. The first revision of `sharedStore.ts` read `hot.data[slot]`
 * off a merely-truthy `hot` and threw `Cannot read properties of undefined
 * (reading '__apellesSharedValues')` at import time — which took out **50
 * `*.dom.test.tsx` suites in `@apelles/editor`**, none of which names this
 * module: they just transitively import a store that is built with it.
 *
 * So the environment IS the test. Merely importing this package and using it
 * under jsdom is what reproduces the failure; the assertions below then pin
 * that it degrades to a plain `create()` rather than throwing.
 */
import { describe, expect, it } from 'vitest';

import { createSharedStore, sharedValue } from './sharedStore';

interface Counter {
  count: number;
  bump: () => void;
}

describe('the web/jsdom environment, where `import.meta.hot` exists but `hot.data` does not', () => {
  it('creates a store without throwing', () => {
    const store = createSharedStore<Counter>('test.dom.counter', (set, get) => ({
      count: 0,
      bump: () => set({ count: get().count + 1 }),
    }));

    store.getState().bump();
    expect(store.getState().count).toBe(1);
  });

  it('degrades to a plain create() — no registry to hand an instance back', () => {
    const init = (set: (p: Partial<Counter>) => void, get: () => Counter): Counter => ({
      count: 0,
      bump: () => set({ count: get().count + 1 }),
    });

    const first = createSharedStore<Counter>('test.dom.same', init);
    const second = createSharedStore<Counter>('test.dom.same', init);

    // Not the same instance: with no usable `hot.data` there is nowhere to keep
    // one. That is correct and is what production does too — the singleton
    // guarantee is a dev-server affordance, never a load-bearing runtime one.
    expect(second).not.toBe(first);
  });

  it('runs `sharedValue` without throwing — the exact accessor that blew up', () => {
    const made = sharedValue('test.dom.value', () => ({ registered: true }));

    expect(made).toEqual({ registered: true });
  });
});
