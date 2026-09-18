/**
 * `@apelles/store` — Apelles' shared zustand store runtime (D-358, B-217).
 *
 * Two things, both about the same invariant: **a store that caches per-project
 * state must be one instance, and every one of them must agree about which
 * project is open.**
 *
 *  - `createSharedStore` — `create()` that survives a Vite dev-mode module
 *    re-evaluation as a single instance (`sharedStore.ts`).
 *  - the project-identity guard — the registry those stores announce their
 *    identity to, and the assertion the MCP op registries run before executing
 *    anything (`projectIdentity.ts`).
 *
 * Bottom of the D-039 layer stack: depends on `zustand` and nothing else. No
 * React, no Tauri, no tab imports — every package and `app/` may depend on it.
 */
export { createSharedStore, createSharedStoreIn, sharedValue } from './sharedStore';
export type { SharedStoreRegistry } from './sharedStore';

export {
  ProjectIdentityError,
  assertProjectIdentity,
  readProjectIdentityDivergences,
  registerProjectIdentityAuthority,
  registerProjectIdentityParticipant,
  setProjectIdentityAlertSink,
} from './projectIdentity';
export type {
  ProjectIdentityDivergence,
  ProjectIdentityParticipant,
  SessionProjectIdentity,
} from './projectIdentity';
