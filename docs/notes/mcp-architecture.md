# MCP surface architecture — the pattern every tab follows (2026-09-07)

Owner: "make sure if follows the same architecture and write the architecture and
rule so expose the MCP servers." This is that doc — the repeatable convention for
giving a Chroma tab a real, agent-controllable MCP surface, written down once so
the next tab (or the next op on an existing tab) doesn't have to re-derive it, and
so nobody accidentally reinvents a second MCP server the way D-183's own first
draft did (see "A mistake already made" below — read it before building a new one).

**There is exactly ONE MCP server for this whole app: `mcp/server.py`.** Every
tab's ops live in it, as more `@mcp.tool()` functions in the same file. There is
no per-tab MCP server, no per-tab port, no per-tab registration. If you find
yourself creating a second MCP server package for a new tab, stop — that is the
anti-pattern this doc exists to head off.

## The four layers, in order

```
MCP client (Claude Code, or any MCP client)
        │  stdio, one process: `mcp/server.py`
        ▼
mcp/server.py            — @mcp.tool() functions, one per agent-facing capability
        │  HTTP POST /op {op, args}  →  http://127.0.0.1:19788 (CHROMA_CONTROL_PORT)
        ▼
chroma::control           — app/src-tauri/src/chroma/control.rs (D-020)
        │  Tauri event: emit('chroma://request', {id, op, args})
        ▼
useXControl.ts             — one per tab, listens on 'chroma://request'
        │  real store action (applyOp / setPlayhead / importPaths / ...)
        ▼
the actual GUI state       — Zustand store or component-local React state
```

Each arrow only ever carries `{op, args}` down and `{ok, error, result}` back up.
No layer except the bottom one knows what any `op` name means — `control.rs` has
**never needed a code change** to support a new tab's ops; it forwards blind. This
is what makes "add a tool" additive rather than invasive: a new capability is a
new listener match + a new Python function, nothing upstream or in between moves.

**Why one shared HTTP bridge and not a Tauri IPC command per op (`invoke()`
directly)**: an MCP client is a separate OS process from the Tauri app: the plugin
architecture predates `mcp/server.py`. The bridge exists so a Python (or any)
process outside the webview can reach the frontend's own store actions without the
app exposing a second, parallel Rust-side implementation of everything the GUI
already does — see the next section for why that "same store action, not a
parallel implementation" property is load-bearing, not incidental.

## The one design rule that isn't optional: mutating tools use the SAME
## code path a GUI click does

An agent's edit and a human's click must go through the identical store action —
not a different Rust command that happens to produce the same on-disk result.
Established D-140 (originally reasoned through for the Edit tab, applies to every
tab equally):

- **Undo/redo**: a store action like `@chroma/editor`'s `timelineStore.applyOp`
  pushes a before/after pair onto the shared undo stack (D-051). A dedicated Rust
  command that mutates the same data but skips the store produces an edit the
  human cannot Cmd+Z — invisible, unreviewable, a "black box" edit in exactly the
  sense `docs/00-vision.md` rules out.
- **One shared state**: `get_state`/`get_timeline`-style read tools must reflect a
  human's manual edits, and a human's UI must visibly move/re-render when an agent
  calls a mutating tool. That's only true if both paths write the same store.

Concretely: a `useXControl.ts` op handler calls `useXStore.getState().someAction(...)`
— never `invoke('chroma_some_dedicated_command', ...)` directly, even when a
dedicated Tauri command for the same mutation exists (several do, for headless/
scripting callers outside the app — that's what they're *for*; they are not the
path an MCP tool takes). A read-only op (`get_state`, `get_timeline`) is the one
place calling a plain Tauri command directly is fine, since there's no undo
history to preserve.

**A worked example of that carve-out, so it isn't mistaken for a violation**:
D-189's `editor_get_transcript` / `editor_analyze_video` (plus their two
`*_status` polls) go straight to `chroma_transcribe` / `chroma_analyze_video`
via a store action that only caches. They mutate no document state at all —
they ask the `ai-media/` sidecar a question about a file on disk — so there is
nothing for an undo stack to hold and nothing in the GUI that must visibly
move. They're also the first ops here that **cannot** answer within
`control.rs`'s 20 s `BRIDGE_TIMEOUT` (a transcript runs for tens of seconds, an
analysis for minutes), so they follow `depth_track`/`depth_track_status`'s
start-then-poll shape: the start op kicks a background job and returns a
`state` immediately, and a second op polls it. Any future op wrapping a slow
capability should copy that pair rather than trying to make the bridge wait.

## The op-prefix convention — every tab opts IN to its own namespace

Every tab's `useXControl.ts` listens on the SAME two Tauri events every other
tab's does (`chroma://request` / `chroma://response/<id>`) — `control.rs` emits
one event per request and awaits exactly one reply, so **at most one listener may
ever answer a given op name**, or two hooks race for the same one-shot response
slot and the request hangs or double-answers.

The convention that keeps that true as tabs are added: each tab's hook is scoped
to a private prefix and returns immediately (bare `return`, before doing any work)
for anything outside it:

```ts
const EDITOR_OP_PREFIX = 'editor_';   // @chroma/editor's useEditorControl.ts
const MOTION_OP_PREFIX = 'motion_';   // @chroma/motion's useMotionControl.ts

const unlistenP = listen('chroma://request', async (ev) => {
  const { id, op, args } = ev.payload;
  if (typeof op !== 'string' || !op.startsWith(EDITOR_OP_PREFIX)) return; // not ours
  // ... look up op in this hook's own OPS map, run it, emit the response
});
```

**Colorist's `useChromaControl.ts` is the ONE hook that does NOT follow this
shape, and is not the template to copy.** It predates the convention (it's tab
#1) and is a catch-all: it answers everything NOT matching another tab's known
prefix, rather than opting in to a `colorist_`-style prefix of its own. It carries
an explicit skip-list instead (`op.startsWith('motion_') || op.startsWith('editor_')
→ return`), which every *new* tab's prefix must be added to by hand — the one
piece of manual bookkeeping this pattern still has. A genuinely new tab (not
Colorist, Motion, or Editor) should opt IN with its own prefix like Motion/Editor
do, not grow Colorist's skip-list or its catch-all OPS map — and should add itself
to that skip-list so Colorist doesn't shadow it.

**Where the hook gets its state without prop-drilling**: if the tab's data lives
in a real module-level store (Zustand, reachable via `useXStore.getState()` from
anywhere), the hook takes **no arguments** and is mounted unconditionally
(`useXControl()`, no args) — this is `useEditorControl.ts`'s and
`useChromaControl.ts`'s shape, since `useEditorTimelineStore`/`useMediaPoolStore`/
Colorist's own stores are all real module-level Zustand. If the tab's state is
deliberately **component-local** React state instead (as `useMotionManifest`'s
own doc comment states: "nothing outside this tab needs it"), the hook needs a
ref threaded in from the tab component and kept fresh every render — this is why
`useMotionControl(m, { playerRef, ... })` takes arguments and `useEditorControl()`
does not. Check which shape your tab's own state is in before copying either.

## The recipe: adding a new tab's MCP surface (or a new op to an existing one)

1. **Frontend half** — in the tab's own package, write (or extend)
   `useXControl.ts`: pick a prefix (`x_`), copy the dispatch-loop shape from
   `useEditorControl.ts` (opt-in prefix, `OPS` map, try/catch around each op,
   `safeUnlisten` for the HMR-teardown race — see that file's own doc comment for
   why `safeUnlisten` exists, B-032/B-034/D-112). Each op reads/writes the tab's
   real store action, never a parallel implementation. Mount the hook once, from
   the tab's own root component (`EditorTab.tsx`, `MotionTab.tsx`) or app-level
   (`App.tsx`, for a tab with no single root) — not from a component that only
   mounts sometimes, or the surface silently goes dark whenever that component is
   unmounted.
2. **Backend half** — in `mcp/server.py`, add one `@mcp.tool()` function per op,
   each just `json.dumps(_op("x_the_op_name", **args), indent=2, default=str)`
   (or `_result(...)` instead of a bare dump, for a tool whose result should
   include a rendered frame/histogram the way Colorist's grading tools do). Match
   an existing tool's docstring depth — units, defaults, what's undoable, what a
   caller would otherwise have to guess. **The tool's Python function NAME is
   independent of the wire op name** — a rename on one side (D-183 moved three
   ops from bare `get_timeline`/`set_clip_fade`/`set_track_duck` names to
   `editor_get_timeline`/etc.) doesn't have to break the other, so a Python tool
   can keep a stable public name while its own `_op(...)` call is updated to
   match wherever the frontend handler for it actually lives now.
3. **Update `docs/notes/mcp-tool-coverage.md`** — move the tab (or the specific
   op) out of whichever gap section it was tracked under, into a real "current
   coverage" list. That doc's own last line: "does this need an MCP tool, and if
   so is one actually built? If not, add a line... rather than letting this doc
   silently drift out of date."
4. **Restart Claude Code** before the new tools are callable — a (re)connected
   MCP server's tools only become visible to a Claude Code session after a full
   exit + relaunch, not immediately (the same gotcha `videoAgent`'s
   `/mcp-editor-setup` skill documents for Palmier Pro/OBS).

## A mistake already made, so it isn't made again

D-183's own first draft misread this architecture entirely: having found no
`editor_*` ops on the control-server bridge and no obvious MCP entry for this
project in a `claude mcp list` run from an unrelated working directory, it
concluded no real MCP server existed for this app and built a second one from
scratch — a brand-new Node/TS package (`@modelcontextprotocol/sdk`,
`packages/mcp-editor/`) duplicating `mcp/server.py`'s exact role as a translator
in front of the same control-server HTTP endpoint. That package was deleted
before ever being registered, once `mcp/server.py`'s existence (and
`docs/notes/mcp-tool-coverage.md`'s own explicit "adding a tool is mechanical: a
new `@mcp.tool()` in `mcp/server.py`" instruction) was actually found. The real
error was searching for "is there an MCP server" instead of searching the repo
for one — `mcp/` sitting at the repo root, next to `app/`/`packages/`, was always
there to grep for.

**The check before building any new MCP-adjacent infrastructure**: does
`mcp/server.py` (or this doc, or `docs/notes/mcp-tool-coverage.md`) already cover
this? If a capability seems to need a new server, new port, or new registration
step, that is itself the signal something has been missed, not a green light to
build one — everything this app exposes to an agent goes through the one server
and the one control-server bridge above.

## ~~A half-finished example~~ — finished 2026-09-09 (D-255), with one correction

This section used to describe Motion as the cautionary half-finished case: its
frontend half (`useMotionControl.ts`, `motion_*` prefix) real and complete
(D-167/D-170/D-171), its Python half entirely absent — zero `motion_*` tools in
`mcp/server.py`, so an agent could only reach those ops by POSTing to the control
server by hand. **D-255 closed it: 32 `motion_*` tools now exist**, and
`docs/notes/mcp-tool-coverage.md`'s "Gap: Motion tab — 0 tools" heading is gone.

Two things that pass learned, worth keeping here since this doc is the recipe:

1. **"It is exactly Step 2, nothing more" was right about the mechanism and
   optimistic about the scope.** Wrapping the 18 existing ops was indeed
   mechanical. But a tab's op surface can itself be *behind* its GUI: eight
   shipped gestures (add a scene, reorder layers, set scale/rotation/opacity,
   retime a camera key, ease one key, edit a card, multi-select field edits, read
   the selection) had no op to wrap at all, because they were built after the op
   surface was. **So Step 1 is not "is there a hook?" but "does the hook cover
   every gesture the tab ships today?"** — check the tab's real store/edit
   functions against its op list, not just for the hook's existence. Fourteen of
   the 32 were new ops.
2. **A hand-copied GUI handler will drift, and only a test catches it.**
   `motion_select` was written to mirror `MotionTab.tsx`'s `onSelect` and did,
   exactly — until `onSelect` gained two refinements (D-173, D-176) that the op
   never received, leaving the op silently wrong for two decisions' worth of
   time (B-125). The rule "a mutating op calls the same store action a GUI click
   does" protects against this only when the op literally *calls* that function;
   where an op re-implements a component-local handler (because the handler
   closes over component state, as this one does), add a test that compares the
   two behaviours. That is what found it.

**Step 5, added by that pass: test the ops.** If a tab's registry is declared
inside a `useEffect` closed over React refs, no test can reach one op without
rendering the hook — which is why Motion's whole surface shipped untested. Split
the registry into a pure factory (`motionOps.ts`'s `createMotionOps(ctx)`, taking
accessor *functions* so nothing goes stale) and leave the hook as a thin shell
owning only the listener, the prefix filter and the `emit`. Then every op is
directly callable against a hand-built context, and the assertion that matters is
cheap: run the op, run the real edit function the GUI gesture calls, assert the
two results are identical.
