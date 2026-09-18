/**
 * `@apelles/store` — the HMR-resilient zustand singleton factory (D-358, B-217).
 *
 * What it is: a drop-in replacement for zustand's `create()` for any store that
 *   must be a **process-wide singleton** — one live instance that every other
 *   module in the app agrees on. `createSharedStore('edit.timeline', init)` is
 *   `create(init)` everywhere except a Vite **dev** server, where it hands back
 *   the instance a previous evaluation of the same module already made.
 *
 * What it does NOT do: nothing about persistence, nothing about React, nothing
 *   about Tauri, and no behaviour at all in a production build — `import.meta.hot`
 *   is `undefined` there (Vite replaces it statically and the whole branch folds
 *   away), so `createSharedStore` reduces to a bare `create()` in `npm run
 *   tauri:build` output. It is also inert under vitest — in the default `node`
 *   environment because there is no `import.meta.hot` at all, and in the
 *   `jsdom`/`web` environment because the stub vitest does supply there has no
 *   `data`. Either way a test importing a store module gets an ordinary fresh
 *   store, exactly as before. See `hotMap()` for why that second case needs
 *   saying out loud.
 *
 * **The bug this exists for (B-217).** `app/src/Root.tsx` bridges
 * `useSessionStore`'s open-project identity into `useEditorTimelineStore` /
 * `useMotionProjectStore` / `useMediaPoolStore`. None of those modules is a React
 * Fast Refresh boundary (they export stores and plain functions, not only
 * components — see `Root.tsx`'s own D-201 note), so an HMR update to one of them
 * propagates up the import graph and the whole subtree is **re-evaluated**. A
 * re-evaluated `create()` call builds a *second* store object, and any module
 * that is not re-evaluated in the same pass keeps holding the first. After enough
 * such passes the app provably ran with two live `useSessionStore` instances at
 * once: `Root` bridged `untitled:Untitled` out of one of them while
 * `useChromaControl` was reading a real, saved project out of the other, so the
 * Edit tab showed one project's timeline under a different project's identity,
 * silently.
 *
 * **The fix is Vite's own documented mechanism, not a bespoke one.**
 * `import.meta.hot.data` is an object Vite carries from a module instance to its
 * replacement precisely so a module can hand state to its next evaluation. This
 * module keeps one registry object in *its own* `hot.data` and every
 * `createSharedStore` call looks its key up there first. That covers both
 * directions of the problem:
 *   - this module is re-evaluated → its registry comes back through `hot.data`;
 *   - a *caller* is re-evaluated while this module is not → the caller re-imports
 *     the same live instance of this module and finds the registry already there.
 *
 * **What a preserved store means for editing store code in dev.** Handing back
 * the old instance would, on its own, mean an edit to a store's *actions* never
 * took effect until a full reload. So on every re-evaluation the new initializer
 * is re-run against the existing store api and its **function-valued** properties
 * (plus any genuinely new key) are merged in: the actions you just edited are
 * live, the state you were sitting on survives. Non-function state that already
 * exists is deliberately NOT reset — preserving it is the entire point.
 */
import { create, type StateCreator, type StoreApi, type UseBoundStore } from 'zustand';

/** A zustand store as this module handles it — the object `create()` returns.
 *  The constraint is `object`, not `Record<string, unknown>`, because a store's
 *  state is declared as an `interface` everywhere in this repo and an interface
 *  has no implicit index signature, so it does not satisfy `Record`. */
type AnyState = object;
type SharedStoreApi = UseBoundStore<StoreApi<AnyState>>;
/** The same object seen as an enumerable bag, for the re-initialisation merge. */
type StateEntries = Record<string, unknown>;

/** The one registry, keyed by the caller-supplied singleton name. Lives in this
 *  module's `import.meta.hot.data` in dev and does not exist at all otherwise. */
export type SharedStoreRegistry = Map<string, SharedStoreApi>;

/** The properties `hot.data` is keyed by. Namespaced because `hot.data` is a
 *  plain object shared with anything else this module carries across. */
const REGISTRY_SLOT = '__apellesSharedStores';
const VALUE_SLOT = '__apellesSharedValues';

/** A `Map` living in this module's `hot.data` under `slot`, created on first
 *  use. `null` wherever there is no usable HMR state to hang it on, which is
 *  exactly the "behave like plain `create()`" case:
 *
 *   - a production build, where Vite replaces `import.meta.hot` with `undefined`
 *     and the whole branch folds away;
 *   - vitest's default `node` environment, which has no `import.meta.hot`;
 *   - **vitest's `jsdom`/`web` environment, which supplies an `import.meta.hot`
 *     stub whose `data` is `undefined`.** That last one is why this checks
 *     `hot.data` and not merely `hot`: an earlier revision of this module read
 *     `hot.data[slot]` straight off a truthy `hot` and threw
 *     `Cannot read properties of undefined` in every `*.dom.test.tsx` in
 *     `@apelles/editor` — 50 suites failing at import, from a store module none
 *     of them names. A truthy `hot` is not a promise that `hot.data` exists. */
function hotMap(slot: string): Map<string, unknown> | null {
  const hot = import.meta.hot;
  const data = hot?.data as Record<string, unknown> | undefined;
  if (!data) return null;
  const existing = data[slot];
  if (existing instanceof Map) return existing as Map<string, unknown>;
  const created = new Map<string, unknown>();
  data[slot] = created;
  return created;
}

function hotRegistry(): SharedStoreRegistry | null {
  return hotMap(REGISTRY_SLOT) as SharedStoreRegistry | null;
}

/**
 * The same singleton guarantee as `createSharedStore`, for a plain value rather
 * than a zustand store: `make()` runs once per dev session and every later
 * module evaluation gets that first value back. Used for the module-level
 * registries that must not silently reset under HMR (see `projectIdentity.ts`
 * — a guard that quietly forgot its participants would be worse than no guard).
 *
 * Unlike `createSharedStore` there is no re-initialisation step: the value is
 * whatever `make()` produced first. Only use it for a mutable container whose
 * *contents* are re-registered by their owners on each evaluation.
 */
export function sharedValue<T>(key: string, make: () => T): T {
  const slots = hotMap(VALUE_SLOT);
  if (!slots) return make();
  if (slots.has(key)) return slots.get(key) as T;
  const made = make();
  slots.set(key, made);
  return made;
}

/** Everything in `next` that should be applied onto a store instance that is
 *  being kept across a module re-evaluation: every action (so an edit to store
 *  logic takes effect without a reload), and every key the live state does not
 *  have yet (so a newly added field appears). Existing non-function state is
 *  left alone — keeping it is why the instance was preserved. */
function actionsAndNewKeys(next: StateEntries, live: StateEntries): StateEntries {
  const patch: StateEntries = {};
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === 'function' || !(key in live)) patch[key] = value;
  }
  return patch;
}

/**
 * The testable core: `createSharedStore` with the registry passed in rather than
 * read from `import.meta.hot`. Calling it twice with the same registry and key is
 * exactly what a Vite module re-evaluation does, which is how
 * `sharedStore.test.ts` exercises this without a dev server.
 *
 * `registry === null` means "no HMR here" and makes this a plain `create()`.
 */
export function createSharedStoreIn<T extends AnyState>(
  registry: SharedStoreRegistry | null,
  key: string,
  initializer: StateCreator<T>,
): UseBoundStore<StoreApi<T>> {
  if (!registry) return create<T>()(initializer);

  const kept = registry.get(key);
  if (kept) {
    // Re-run the (possibly edited) initializer against the store that already
    // exists, so `set`/`get` inside the new actions drive the SAME instance
    // every other module is still holding, then adopt those actions.
    const api = kept as unknown as StoreApi<T>;
    const next = initializer(api.setState, api.getState, api) as StateEntries;
    const patch = actionsAndNewKeys(next, api.getState() as StateEntries);
    api.setState(patch as Partial<T>, false);
    return kept as unknown as UseBoundStore<StoreApi<T>>;
  }

  const made = create<T>()(initializer);
  registry.set(key, made as unknown as SharedStoreApi);
  return made;
}

/**
 * Create a zustand store that survives a Vite dev-mode module re-evaluation as
 * one instance (B-217). Identical to `create(initializer)` in production and
 * under vitest.
 *
 * `key` names the singleton and must be unique across the whole app — use the
 * store's own exported name (`'app.session'`, `'edit.timeline'`, …), not the file
 * path, which differs between the specifiers a module can be reached through.
 */
export function createSharedStore<T extends AnyState>(
  key: string,
  initializer: StateCreator<T>,
): UseBoundStore<StoreApi<T>> {
  return createSharedStoreIn(hotRegistry(), key, initializer);
}
