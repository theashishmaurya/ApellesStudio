# `@apelles/store`

Apelles' shared **zustand store runtime**. Created by **D-358** to fix **B-217**.

Two exports, one invariant: *a store that caches per-project state must be one
instance, and every one of them must agree about which project is open.*

| export | what it is |
|---|---|
| `createSharedStore(key, initializer)` | `zustand`'s `create()`, except that under a Vite **dev** server it hands back the instance an earlier evaluation of the same module already made. Identical to plain `create()` in a production build (no `import.meta.hot`) and under vitest (the `node` environment has none; the `jsdom` one has a stub with no `data`). |
| `sharedValue(key, make)` | the same singleton guarantee for a plain value — used for module-level registries that must not silently reset under HMR. |
| `registerProjectIdentityAuthority` / `registerProjectIdentityParticipant` / `assertProjectIdentity` / `readProjectIdentityDivergences` / `setProjectIdentityAlertSink` / `ProjectIdentityError` | the cross-store project-identity guard: the authority is `useSessionStore`, the participants are every store the composition root hands the open project's identity to, and the assertion is what each MCP op registry runs before executing an op. |

## Boundary

- **Depends on:** `zustand`. Nothing else. No React, no Tauri, no `@apelles/*`.
- **Depended on by:** `app/`, `@apelles/editor`, `@apelles/motion`,
  `@apelles/bridge`. It is the bottom of the D-039 layer stack, so anything may
  depend on it and it may depend on nothing in this repo.
- **Not a store collection.** It holds no application state of its own and never
  will — the stores themselves stay in the package that owns their domain.
- **Not a persistence layer.** Nothing here reads or writes disk.

## Why it exists (B-217)

`app/src/Root.tsx` bridges `useSessionStore`'s open-project identity into
`@apelles/editor`'s timeline store, `@apelles/motion`'s manifest store and
`@apelles/bridge`'s media pool. None of those modules is a React Fast Refresh
boundary, so an HMR update to any of them re-evaluates the subtree — and a
re-evaluated `create()` builds a *second* store while modules that were not
re-evaluated keep the first.

After a long dev session that provably happened: `Root` bridged
`untitled:Untitled` out of one `useSessionStore` instance while
`useChromaControl` was reading a real, saved project out of another, so the Edit
tab served (and would have let an agent edit) one project's timeline under a
different project's identity, with no error anywhere.

`createSharedStore` prevents the duplication, through `import.meta.hot.data` —
Vite's own documented mechanism for carrying state from a module instance to its
replacement. The identity guard catches the same class of failure if anything
ever gets past that, because the expensive part of B-217 was not that it happened
but that it was silent.

## Tests

`npm test --workspace @apelles/store`. `sharedStore.test.ts` drives
`createSharedStoreIn` with an explicit registry, which is exactly what a Vite
module re-evaluation does; `projectIdentity.test.ts` induces a deliberate
authority/participant mismatch and pins that the assertion refuses the op;
`sharedStore.dom.test.ts` runs under `jsdom`, where `import.meta.hot` exists but
`hot.data` does not — the one environment that can catch this module assuming
the second follows from the first.
