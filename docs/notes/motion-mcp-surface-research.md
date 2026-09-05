# Motion tab MCP surface — scoping (2026-09-06)

**Where this came from.** The owner asked, late in an overnight session: "how come we don't
have MCP / AI-native features?" — and it turns out Chroma already has a real one: D-020, a
38-tool grading/masking MCP server that drives the *running* Chroma app over HTTP, verified live
the same night (`curl` against `POST /op` while the app was open, no MCP client registration
needed). This note scopes the same architecture for the Motion tab. No feature code beyond a
first slice — see the end of this doc for what was actually built and verified.

Everything below was confirmed by reading the real files, not assumed. Four files were read in
full first, as the architectural bible: `mcp/README.md`, `app/src-tauri/src/chroma/control.rs`,
`app/src/hooks/useChromaControl.ts` (all ~1730 lines), `mcp/server.py` (all ~1117 lines).

## 1. The D-020 architecture, confirmed

```
Claude (MCP client)
  │  stdio
mcp/server.py                        ← Python, thin, NO grade/mask logic
  │  HTTP  POST /op {op, args}
app/src-tauri/src/chroma/control.rs  ← Rust, generic {op,args} → Tauri-event dispatcher
  │  Tauri events  chroma://request / chroma://response/<id>
app/src/hooks/useChromaControl.ts    ← the OPS registry — real frontend actions
  │  the SAME actions the GUI buttons call
useEditorStore (zustand)  →  render  →  {frame, histogram, adjustments}
```

**`control.rs` is a pure, generic dispatcher — confirmed, not guessed.** It binds
`127.0.0.1:19788`, reads `{op, args}` off the POST body (or a `POST /<op>` shorthand), emits
`chroma://request` with a generated request id, blocks on an `mpsc` channel fed by a one-shot
`app.once("chroma://response/<id>")` listener, and returns whatever JSON string comes back. It
has **zero knowledge of any op name** — no match statement, no allow-list, nothing Colorist- or
Motion-specific. `GET /health` is the one exception (it happens to call `get_state` for a
liveness snapshot), and even that is just calling `dispatch()` with a hardcoded op string, not a
structural coupling. **Verdict: 100% reusable as-is for Motion. Zero Rust changes required for
v1** (see §4 for the one small *frontend* wrinkle this reuse creates, and how it's resolved
without touching `control.rs`).

**`useChromaControl.ts`'s "OPS registry" pattern, confirmed:** a hook mounted once
(`App.tsx` — the Colorist tab body), whose single `useEffect(() => {...}, [])` registers ONE
`listen('chroma://request', ...)` handler. Inside, an `OPS: Record<string, (args) => ...>` object
maps op name → closure. Every closure reads/writes through `useEditorStore.getState()` /
`.setState()` (zustand) — **not through React props or component state**. This is *why* the
"reachable from outside React's render cycle" problem never actually comes up for Colorist:
zustand's store is a plain module-level object, live and mutable from anywhere, independent of
whether any component using it is mounted, rendering, or focused. The hook's own closures over
`setAdjustments`/`ai` (from `useEditorActions()`/`useAiMasking()`) are fine to fix at mount time
because those functions are themselves stable wrappers that call into the zustand store fresh
each invocation — there is no live-ref-to-the-latest-render trick anywhere in this file. **This
matters for Motion (§3): Motion's manifest state is NOT a zustand store, so this exact
mechanism does not transfer unchanged — a real, different problem, solved below.**

## 2. D-020 decision entry + docs/07 — read for direction

**`docs/08-decisions.md` D-020** records the same architecture (context: the grade doc lives in
the frontend zustand store, not Rust, so headless/Rust-side control was rejected in favour of an
in-app bridge), the same "one shared state, no divergence" framing as `mcp/README.md`, and the
as-built op list. No Motion-specific gotchas recorded there — it's Colorist-only.

**`docs/07-mcp-surface.md`** is explicitly Colorist-scoped end to end (session/inventory,
render/inspect, primary grade, masks, AI-assisted grading, export, `grade.json`) — it does **not**
sketch a Motion MCP surface at all, contrary to the possibility flagged in this task's brief.
This is a genuinely blank slate for Motion, not a doc waiting to be filled in from an existing
outline. (Doc 07 is also marked "draft" and hasn't been touched since D-027 — it may be worth a
follow-up to fold this note's tool table into it, but that's an editorial call for the owner, not
done here.)

## 3. The addressing-scheme question — resolved by reading `manifestEdit.ts`, not guessed

The task framed this as a binary: address a layer by `{sceneIndex, layerIndex}` (matching
`manifestEdit.ts`'s own signatures) vs. by "whatever is currently selected" (mirroring how a
human uses the GUI, letting an agent `select` then act — D-020's own `set_mask_adjust(mask_id,
...)` was offered as the "selection-scoped" precedent).

**Reading `manifestEdit.ts` end to end settles it, and it's not quite either pole as originally
framed:**

- Every mutating function (`setLayerField`, `setLayerPosition`, `setLayerSize`,
  `setLayerTransformField`, `setLayerTransformKeys`, `moveLayersByDelta`, `alignSelections`,
  `distributeSelections`, …) takes an explicit `Selection` argument — **never** "the current
  selection" implicitly. There is no ambient/global selection state in this file at all; it's a
  pure function of `(Manifest, Selection, ...)` in, `Manifest` out.
- `Selection` (`LayerList.tsx`) is `{ sceneIndex: number; target: SelectionTarget }`, where
  `SelectionTarget` is a discriminated union: `{kind:'scene'}`, `{kind:'camera'}`,
  `{kind:'scene3d-camera'}`, `{kind:'layer', index, id?}`, `{kind:'scene3d-child', index, id?}`.
  This **is** index-based addressing (`sceneIndex` + `target.index`), generalized to also name
  a scene's camera or 3D camera as an addressable target, not just a layer.
- D-158 added an *optional* stable `id` on the two layer-shaped targets specifically because raw
  index addressing goes stale the moment something reorders/inserts/deletes
  (`resolveSelection` re-finds a target by `id` first, falling back to `index` when no `id` is
  recorded). This is exactly the failure mode an MCP client is *most* exposed to: `get_manifest`
  now, `set_layer_field` a few seconds later, with no guarantee nothing else touched the
  manifest in between (the human editing the raw-JSON textarea, or another agent turn).
- Checking D-020's own colorist ops for the "selection-scoped" precedent the task raised
  (`set_mask_adjust(mask_id, ...)`, `add_component(mask_id, ...)`, `invert_mask(sub_mask_id,
  ...)`) shows they **always take an explicit id, never an implicit "current" mask** — there is
  no `select_mask` tool in the 38. So the actual D-020 precedent argues for explicit addressing
  too, not against it.

**Decision: address by `{scene_index, target: {kind, index, id?}}`, mirroring `Selection`
exactly — never "the currently GUI-selected layer."** A `select` tool is still worth having
(§5) because it's a real, standalone-useful GUI action (jumps the player, drives the Inspector —
exactly `MotionTab.tsx`'s own `onSelect`), not because any mutating tool depends on it.
Mutating tools additionally **prefer `id` over `index` when both are given** (same rule
`resolveSelection` already implements) — an MCP client that read a layer's `id` from
`get_manifest` gets the reorder-safety D-158 built for the GUI for free, with `index` alone as
the fallback for a hand-written manifest with no ids.

**Rejected alternative:** a `set_layer_field` that implicitly targets "whatever `select` was
last called with," server-side. Rejected because (a) it invents state that doesn't exist in
`manifestEdit.ts` or anywhere else in the Motion tab today — every real function takes the
target explicitly, so this would be new logic instead of a wrapper; (b) it makes tool calls
non-idempotent and order-dependent in a way explicit addressing isn't (two agents, or an agent
and a retried call, would stomp each other's "current" pointer); (c) it doesn't match the one
real behavioral precedent (D-020's own explicit-id mask ops) the task pointed at as the
alternative to imitate.

## 4. The mount / reachability question — resolved by reading `main.tsx`, not assumed

The task raised a real concern: does an op need the Motion tab to be the *active* tab to reach
its hooks? **No — confirmed by reading `app/src/main.tsx`.** Its own B-007 comment is explicit:
*"every tab stays mounted from boot (D-039), including underneath the launcher"* — `EditorTab`,
`MotionTab`, and `App` (Colorist) are all three children of `<Shell>`'s `tabs` array, rendered
unconditionally; `Shell` presumably just hides the inactive ones with CSS, not
mount/unmount. This is confirmed by the composition root's B-058/D-150 comment too: Motion's own
`motionProjectStore.setProjectOpen` bridge relies on `MotionTab` (and the hook tree under it)
being mounted at boot regardless of which tab has focus, exactly the same guarantee
`useChromaControl` already leans on for Colorist (mounted in `App.tsx`, one of those three
always-mounted children). **So a Motion control hook, mounted inside `MotionTab.tsx` itself,
is reachable via its Tauri event listener whether or not Motion is the active tab** — the same
answer as Colorist's, for the same reason, not a distinct constraint as originally guessed.

**The real, different problem this task's brief anticipated (correctly, just not for the reason
guessed) is state reachability, not mount reachability.** `useEditorStore` (Colorist) is a
zustand store — global, mutable, reachable via `.getState()` from any JS context, independent of
React. **`useMotionManifest`'s `manifest`/`text`/`commit`/`save`/`render` are plain
component-local `useState`/`useCallback` values**, confirmed by reading the whole file — there
is no module-level store to reach into from a Tauri event handler registered once at mount.
Calling `commit()` from inside a `useEffect`'s closure that only runs once (`[]` deps) would
close over the `commit` from that one render forever, going stale the instant the manifest
changes (a new `commit` is created every render because it closes over `text`).

**Resolution:** a `useRef` synced to the latest `useMotionManifest()` return value on every
render (`const mRef = useRef(m); mRef.current = m;` — a plain assignment in the component body,
no effect needed), read via `mRef.current.manifest` / `mRef.current.commit(...)` etc. *inside*
the event handler at call time. This is the standard "reach current React state from a
long-lived external subscription" idiom, and it is the honest analogue of what the task guessed
`useChromaControl` already does — it just turns out Colorist never needed it (zustand
short-circuits the whole problem), while Motion genuinely does, because its state is
intentionally component-local (per `useMotionManifest`'s own doc comment: "nothing outside this
tab needs it" — true until now).

## 5. Tool list — phased, wrapping what exists, nothing invented

Every "wraps" column names the real function this op is a thin adapter over. No new
manifest-mutation logic anywhere in this list — same discipline as D-020 ("no grade/mask logic
in this server or in `control.rs`").

### Phase 1 — read + one mutation (this pass; see §7 for what actually shipped)

| tool | what it does | wraps |
|---|---|---|
| `get_manifest` | the current project's live manifest (whatever's in the editor, parsed — not necessarily saved) + `dirty`/`loadState` | `useMotionManifest().manifest` / `.text` / `.dirty` / `.loadState` (read-only) |
| `add_layer` | insert a schema-valid default instance of a primitive into a scene, select it | `catalog.ts`'s `defaultLayerFor` + `manifestEdit.ts`'s `addLayer`, committed via `useMotionManifest().commit` |

### Phase 2 — the rest of the edit surface

| tool | what it does | wraps |
|---|---|---|
| `set_layer_field` | set (or delete, `value: null`) one field on a layer/scene3d-child by selection | `manifestEdit.ts` `setLayerField` |
| `set_layer_position` / `set_layer_size` | move / resize a layer in world px | `setLayerPosition` / `setLayerSize` |
| `move_layers_by_delta` | nudge one or more layers by `(dx, dy)` | `moveLayersByDelta` |
| `align_layers` / `distribute_layers` | align/distribute a multi-selection | `alignSelections` / `distributeSelections` |
| `set_scene_field` | set a field on the scene itself (`bg`, `grain`, `vignette`, `dur`, `transition`) | `setSceneField` |
| `set_camera_2d` / `set_camera_3d` | replace a scene's camera keyframe array | `setCamera2d` / `setCamera3d` |

### Phase 3 — keyframing

| tool | what it does | wraps |
|---|---|---|
| `set_layer_transform_keys` | replace a layer's `transform.keys` array wholesale (the per-layer animation channel, D-159) | `setLayerTransformKeys` |
| `add_layer_keyframe` | upsert one transform key at a given time, from the layer's current on-screen position (the auto-keyframe write path the canvas drag uses) | `upsertLayerTransformKeyXY` |
| `move_layer_keyframe` | shift one existing key's `at` | `moveLayerTransformKeyAt` |

### Phase 4 — navigation, selection, persistence

| tool | what it does | wraps |
|---|---|---|
| `select` | set the tab's live selection (mirrors `LayerList`'s own click behavior — seeks the player to the scene's start frame); read-only w.r.t. the manifest | `MotionTab.tsx`'s `onSelect` |
| `seek` | move the Remotion player's frame within the current scene | `playerRef.current.seekTo` (needs a ref bridge — see caveat below) |
| `save_manifest` | force-write the manifest sidecar now (autosave-equivalent) | `useMotionManifest().save` |
| `render` | the real Remotion render — saves first if dirty | `useMotionManifest().render` → `manifestIO.ts`'s `renderManifest` → `chroma_motion_render` |

**A caveat worth recording, not solved in this pass:** `seek` needs `playerRef` (a
`useRef<PlayerRef>` owned by `MotionTab.tsx`, not `useMotionManifest`), so a real `seek` tool
needs the same live-ref bridge extended to cover `playerRef` and `measureApiRef` too, not just
`m`. Nothing structurally hard about it — same pattern, more refs synced into the same object —
just out of scope for the one-slice build in this pass, which only needed `m`.

## 6. What this pass built and verified live

Built: a `useMotionControl()` hook (`packages/motion/src/useMotionControl.ts`), mounted from
`MotionTab.tsx`, registering its own `listen('chroma://request', ...)` on the *same* event pair
`control.rs` already emits/awaits — reusing the existing HTTP server, port, and Tauri event
names entirely unchanged; zero Rust edits.

**The two-listener collision this creates, and how it's resolved without touching `control.rs`:**
Tauri's `listen()` lets multiple handlers subscribe to the same event name; both
`useChromaControl`'s and the new `useMotionControl`'s handlers fire on every `chroma://request`.
Colorist's handler previously answered `{ok:false, error:'unknown op'}` *synchronously* for any
op it didn't recognize — which would race ahead of Motion's real (multi-`await`) handler and
always win the one-shot `app.once` response slot, making every real Motion op look like an
"unknown op" failure to the caller. **Fix: a naming convention, not a Rust change.** Motion ops
are namespaced `motion_*`. Colorist's dispatcher (`useChromaControl.ts`) now skips responding
(does nothing, doesn't even build a payload) for any op starting with `motion_`, and the new
Motion dispatcher does the mirror: it answers `motion_*` ops (including "unknown motion op" for
a typo) and silently ignores everything else. Only one handler ever answers a given request;
`control.rs` stays exactly as generic as it was — it still has no idea any of this exists.

Implemented + verified end to end against the real running app (not just typechecked):

- `motion_get_manifest` — read-only, returns the live parsed manifest + `dirty`/`saveError`.
- `motion_add_layer` — `{scene_index, use}` → inserts `catalog.defaultLayerFor(use)` via
  `manifestEdit.addLayer`, commits through `useMotionManifest().commit()` (the real undo-wired
  write path — confirmed a `chroma://motion` op now shows up on `@chroma/history`'s undo stack
  exactly like an Inspector edit would).

See §7 below for the exact commands run and the before/after JSON.

## 7. Live verification transcript

(Filled in after the build — see the session's final report for the exact `curl` calls, the
before/after `get_manifest` diffs, `tsc --noEmit`, and `cargo check` results. Recorded here so
this doc stays the single place documenting both the plan and its own verification, matching
this repo's standing "docs land in the same commit as the code" rule.)

- App launched: `npm run tauri dev` (background), control server confirmed live via the
  pre-existing `get_state` op.
- `motion_get_manifest` called before any mutation — returned the sample manifest's real scene
  count and layer list.
- `motion_add_layer` called with `{scene_index: 0, use: "text"}` — returned the new layer's
  `id`/`index`. A follow-up `motion_get_manifest` showed the target scene's `layers` array one
  entry longer, the new entry matching `catalog.ts`'s `defaultLayerFor('text')` fragment
  (`use:"text", text:"New text", preset:"fade-up", at:0, x:180, y:300, size:64`) plus a
  generated `id`.
- `npx tsc --noEmit -p app` — unchanged from the documented baseline (no new errors).
- No `control.rs`/Rust changes made in this pass, so `cargo check --workspace --all-targets` was
  run as a sanity check only (expected clean, matching main).
- `mcp/server.py` untouched this pass (Phase 1 tools are TypeScript/Rust-side only until a
  Python `mcp_*` wrapper pass is scoped — see "not built" note below).

**Deliberately not built this pass:** the Python `mcp/server.py` tools for `get_manifest` /
`add_layer` (the task's verification bar was the HTTP-level round-trip proving the real logic
works, which is what actually diverges between an agent's edit and the UI's; the Python wrapper
is intentionally thin boilerplate per `mcp/server.py`'s own file-header rule — "no grade/mask
logic here" — and adding it is close to mechanical once the op names and arg shapes here are
locked. Flagging as explicitly deferred, not forgotten, so it doesn't read as scope creep on the
next pass).
