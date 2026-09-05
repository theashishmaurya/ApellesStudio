# Motion tab audit — what the Motion tab can actually do, vs. the Edit tab and vs. a real motion-graphics tool (2026-09-05)

Owner, tonight: *"motion is not loaded lets now work on out motion thingy, [m]ap out where
we lag, have a Catalog Section where all our built catalog is there which we can get on our
current thing."* This note is the "map out where we lag" half. The Catalog is the build half
(D-151) — scoped directly off this audit's own biggest finding, not in parallel with it.

**Same method as `docs/notes/timeline-feature-audit.md`**, deliberately: the actual current
code read line by line and cited, not summarized from the decision docs (which, as that note
found for the Edit tab, can describe intent that never shipped). Where a claim is "there is
none," it was confirmed by `grep`, and the grep is named.

**Companion to `docs/notes/global-inspector.md`** — that note has the phased build history
(Phases 1–4, D-081/D-099/D-102/D-103) for how Motion's layer list and Inspector came to
exist. This note is a flat "is X built" checklist against the Edit tab and against real
external motion-graphics tools.

## What was actually read

- `packages/motion/src/` — all 11 source files in full: `MotionTab.tsx`,
  `MotionPreview.tsx`, `LayerList.tsx`, `InspectorPanel.tsx`, `ManifestEditor.tsx`,
  `useMotionManifest.ts`, `manifestIO.ts`, `manifestEdit.ts`, `propCatalog.ts`,
  `resizable.tsx`, `Button.tsx`.
- `packages/motion-engine/src/` — `engine/schema.ts`, `engine/registry.ts`,
  `engine/build.ts`, `engine/sample.ts`, `Root.tsx`, all 9 files in `primitives/`, all 6
  in `compositions/`.
- `mcp/server.py` and `docs/07-mcp-surface.md` for the agent surface.
- `docs/04-roadmap.md` items 6 (multi-track NLE) and 7 (Global Inspector) as the real
  build history and the Edit-tab comparison baseline.

## References for "what a real motion-graphics tool has"

Unlike the timeline audit, the comparison here is mostly **in-repo and concrete**, so
external doc-fetching was not the load-bearing evidence and is not claimed as such:

- **The Edit tab, in this same repo** — the strongest available reference, because it is the
  same team's own answer to the same interaction problems (add a thing, move a thing, undo a
  thing) at a much more mature stage. Cited per row below with its `D-NNN`.
- **Remotion's own Studio / Editor Starter** — already checked and written up in
  `docs/notes/global-inspector.md` (rejected as a base to build on: paid, ~$600, a template
  not a library). Its relevant structural point stands: a real Remotion-based editor has an
  **insert path**, not only a property panel.
- **After Effects / Apple Motion**, as the category baseline for the three interactions this
  audit ends up centering on: a browsable effects/presets library you drag from, direct
  on-canvas manipulation, and a layer timeline. Used as a category-level claim only — no
  specific vendor doc page is cited, because none was fetched.

---

## Feature matrix

Each row: what the concept is, what the **Edit tab** has, what the **Motion tab** has, with a
real file/line citation for the Motion column.

| Concept | Edit tab | Colorist | **Motion tab** | Motion evidence |
|---|---|---|---|---|
| Live preview | ✅ player + compositor | ✅ canvas | ✅ real `@remotion/player`, scrubbable, looping | `MotionPreview.tsx:39–50` |
| Selection model | ✅ `{track,id}` (D-080) | ✅ mask/layer | ✅ `{sceneIndex, target}`, 5 target kinds | `LayerList.tsx:23–33` |
| Object list / tree | ✅ tracks + clips | ✅ mask list | ✅ scene → camera → layers → scene3d children | `LayerList.tsx:86–101` |
| Click-to-navigate | ✅ click clip | ✅ | ✅ selecting a row seeks the player to that scene | `MotionTab.tsx:80–83` → `build.ts:30` |
| Typed property panel | ✅ `ClipInspectorPanel` (D-102) | ✅ | ✅ all 8 primitives, scalar controls + JSON fallback | `InspectorPanel.tsx:298–377`, `propCatalog.ts:50–137` |
| Keyframes | ✅ transform kf + **real bezier curves (D-147)** | ✅ mask kf | ⚠️ **camera only** — 2D + 3D camera key list; the engine has per-key bezier easing but the schema silently strips it (**B-059**) | `InspectorPanel.tsx:249–296`; `Camera.tsx:20–30,73` vs. `schema.ts:32–37` |
| **Add a new object** | ✅ drag from Sources, auto-create track (D-096) | ✅ `add_mask` | ❌ **none — no `addLayer`/`addScene` anywhere** | grep `addLayer\|addScene\|insertLayer\|duplicate` over `packages/motion/src` → **0 hits**; `manifestEdit.ts` exports 9 fns, all `selected*` readers or `set*` field-writers (`manifestEdit.ts:30–118`) |
| Delete an object | ✅ lift + ripple-delete (D-054/D-105) | ✅ `delete_mask` | ❌ none (same grep) | as above |
| Duplicate / copy-paste | ❌ (own audit's gap) | — | ❌ | as above |
| Drag and drop | ✅ `@dnd-kit` (D-096/D-100) | — | ❌ **zero** | grep `drag\|drop\|onPointer\|onMouseDown\|dnd-kit` over `packages/motion/src` → only 2 hits, both prose in a comment (`useMotionManifest.ts:152,156`) |
| On-canvas manipulation | ✅ transform handles (D-136) | ✅ mask handles | ❌ bare `<Player controls>`, no overlay | `MotionPreview.tsx:38–51` — no children, no handle layer |
| Timeline / time axis UI | ✅ multi-track, zoom, ruler, waveforms (D-051/D-058) | — | ❌ **no time axis at all**; scene order is array order, timing is `dur`/`at` numbers | `MotionTab.tsx:96–130` — 4 panes, none is a timeline |
| Multi-select | ❌ (own audit's #1) | — | ❌ `Selection` is a single object, never an array | `LayerList.tsx:30–33` |
| Undo / redo | ✅ shell-level (D-052) | ✅ 50-deep | ❌ **explicitly deferred at D-052** | grep `undo\|redo\|history` over `packages/motion/src` → **0 hits** |
| Fades / ducking | ✅ D-147 / D-149 | — | n/a (`transition` per scene exists) | `schema.ts:81` |
| Persistence | ✅ project | ✅ `grade.json` | ✅ one manifest per project, save + dirty state | `useMotionManifest.ts:118–132` |
| Render / export | ✅ export dialog (D-049) | ✅ | ✅ real render → auto-added to Sources (D-062) | `useMotionManifest.ts:134–165` |
| Resizable panes | ✅ | ✅ | ✅ 4 real resizable panels | `MotionTab.tsx:96–130`, `resizable.tsx` |
| **MCP / agent surface** | ✅ `get_timeline`, `set_clip_fade`, `set_track_duck` | ✅ ~40 tools | ❌ **zero tools** | `mcp/server.py` has 45 `@mcp.tool`s, **none** motion; grep `motion\|manifest` over `mcp/*.py` → 0; `docs/07-mcp-surface.md` never mentions the Motion tab |
| Discoverability of what exists | ✅ Sources pool | ✅ mask-type menu | ❌ nothing lists the 8 primitives in the UI | no catalog surface existed before D-151 |

---

## Primitive inventory — the "is anything dead code" check

Every file in `packages/motion-engine/src/primitives/`, cross-checked against the schema's
`use` enum (`schema.ts:48–59`), the registry (`registry.ts:41–113`), and the demo
compositions registered in `Root.tsx`.

| File | Export | `use` value | In registry | Demo composition |
|---|---|---|---|---|
| `Text.tsx` | `Text` | `text` | ✅ `registry.ts:45` | `PrimitivesDemo` |
| `Emphasis.tsx` | `Emphasis` | `emphasis` | ✅ `:58` | `PrimitivesDemo` |
| `Matrix.tsx` | `Matrix` | `matrix` | ✅ `:68` | `PrimitivesDemo` |
| `Graph.tsx` | `Graph` | `graph` | ✅ `:70` | `GraphDemo` |
| `Layers.tsx` | `Layers` | `layers` | ✅ `:92` | `LayersDemo` |
| `ParticleFlow.tsx` | `ParticleFlow` | `particleflow` | ✅ `:103` | `ParticleDemo` |
| `Scene3D.tsx` | `LabelBox` | `labelbox` | ✅ `:104` | `Scene3DDemo` |
| `Scene3D.tsx` | `LayerStack` | `layerstack` | ✅ `:105` | `Scene3DDemo` |
| `Scene3D.tsx` | `Scene3D` | — (container: `scene.scene3d`) | n/a | `Scene3DDemo`, `ParticleDemo` |
| `Camera.tsx` | `Camera`, `push`, `pan`, `pullBack` | — (container: `scene.camera`) | n/a | `PrimitivesDemo` |
| `postfx.tsx` | `FilmGrain`, `Vignette` | — (flags: `grain`, `vignette`) | n/a | `LayersDemo`, `ParticleDemo` |

**Finding: there is no dead primitive.** All 8 manifest-addressable primitives are wired into
both the schema enum and the registry, and every one has a demo composition proving it
renders. The three non-`use` files are containers/flags, correctly not in the enum. The
dead-code hypothesis this audit went looking for did not pan out — worth saying plainly
rather than manufacturing a finding.

The one real nit: **`Glow` is over-exported** from `primitives/index.ts:11` but has no
consumer outside `Scene3D.tsx` itself (`:162`, `:202`). Not dead code — a barrel export that
promises a public primitive that isn't one. Cosmetic; not worth a commit on its own.

---

## The biggest gap, stated plainly

**The Motion tab can edit everything and create nothing.**

`manifestEdit.ts` — the entire manifest-mutation layer, the file the Inspector is built on —
exports nine functions (`manifestEdit.ts:30,39,56,60,68,83,92,99,112`). Four are readers
(`selectedScene`, `selectedLayer`, `selectedCamera2d`, `selectedCamera3d`), four are
field-writers on things that already exist (`setLayerField`, `setSceneField`, `setCamera2d`,
`setCamera3d`), one is a JSON parse helper. **There is no function anywhere in the package
that makes a new scene or a new layer exist.**

The consequence is concrete: to put a text callout on screen, the owner opens
`ManifestEditor.tsx`'s `<textarea>` (`:65–70`) and hand-types

```json
{ "use": "text", "text": "…", "preset": "fade-up", "at": 0.2, "x": 180, "y": 300 }
```

from memory — including the exact `use` string, which nothing in the UI lists, and the
per-primitive required props (`Matrix` needs `rows`/`cols`, `Graph` needs `nodes`/`edges`,
`Layers` needs `items`), which nothing in the UI lists either. `propCatalog.ts` holds the
complete, verified field catalog for all 8 primitives — but it is only ever consulted
*after* a layer with a recognized `use` already exists (`InspectorPanel.tsx:360`). Pure
chicken-and-egg: the tool's own knowledge of its primitives is unreachable until you've
already done the hard part by hand.

**The pattern is already proven in-file, and simply wasn't extended.** `CameraKeyList`'s
`+ Add keyframe` button (`InspectorPanel.tsx:287–293`) is the one creative act in the entire
tab — it constructs a default (`makeDefault={() => ({ at: 0 })}`, `:335`), appends it, and
writes the new manifest back through the same `onChange` → `setText` path
(`MotionTab.tsx:90–92`). That is exactly the mechanism a catalog insert needs. It exists, it
works, it was only ever pointed at camera keyframes.

This is why the owner asked for a Catalog. It is the same request as "give me a way to add
things," arriving as "show me what we've built so I can get it on our current thing."

## Second-biggest: the Motion tab is the one tab an agent cannot touch

`mcp/server.py` exposes 45 tools. The Colorist owns most of them; the Edit tab has accumulated
a real surface (`get_timeline` `:309`, `set_clip_fade` `:330`, `set_track_duck` `:388`).
**Motion has none**, and `docs/07-mcp-surface.md` — 141 lines documenting the contract — never
mentions the tab. An agent can write a manifest file onto disk, but has no tool to load one,
validate it against the schema, mutate a layer, or trigger a render.

For a product whose stated thesis is agent-native across cut, motion, and grade, that makes
Motion the weak link by a wide margin. Worth noting the dependency: a Motion MCP surface
wants the same manifest-mutation ops (`add_layer`, `set_layer_field`, `remove_layer`) that the
GUI needs. Building those ops once, purely, in `manifestEdit.ts` — as this pass does for
`addLayer` — means the MCP layer later wraps existing tested functions rather than
reimplementing manifest surgery in Python.

---

## Prioritized — "what blocks the most, blocks nothing else"

1. **A creation path — the Catalog + a real `addLayer` op. Built this pass (D-151).** It is
   the gap that makes every other Motion feature more useful the moment it exists (an
   Inspector with nothing to inspect is worth little; a layer list you can't add to is a
   read-only outline), and it blocks nothing else. Contained scope: a pure fragment
   constructor per primitive + one `addLayer` in `manifestEdit.ts` + a browse panel. It also
   quietly unblocks #3, since the MCP layer should wrap the same op.
2. **On-canvas manipulation second.** Once layers can be *created*, "now drag it where I want
   it" is the immediate next thing a user reaches for, and typing `x: 180` into a number
   field is the sharpest remaining friction. Real scope: an overlay on `MotionPreview`'s
   `<Player>` mapping composition coordinates ↔ screen coordinates (the manifest is in world
   px at `manifest.width`×`height`, the player is scaled to fit — a real but small mapping),
   drag → `setLayerField('x'|'y')`. The Edit tab's D-136 solved the analogous problem and is
   the reference. **Deliberately not attempted this pass** — named here as the audit's own
   next priority rather than half-built alongside the Catalog.
3. **A Motion MCP surface third.** The AI-native gap, and cheap once #1's ops exist:
   `get_manifest` / `add_layer` / `set_layer_field` / `render_manifest`, wrapping
   `manifestEdit.ts` through the same in-app bridge the Edit-tab tools use.
4. **Undo/redo for Motion fourth.** D-052 deferred it for a real reason ("no natural edit-
   history unit") — but with `addLayer`/`setLayerField` as discrete, named, immutable ops, the
   unit now exists: push a before/after `Manifest` snapshot per op into `@chroma/history`,
   exactly as `useEditorTimelineStore.applyOp` does for the timeline. The textarea stays
   outside the stack (it has the browser's own undo).
5. **A scene/layer timeline UI fifth.** The most visible difference from After Effects and
   from this repo's own Edit tab, and the largest build. Lower urgency than 1–4 because the
   layer list plus per-layer `at`/`dur` fields do represent the same information — badly, but
   completely. Do it after direct manipulation exists, so the timeline can reuse the same
   drag mechanics rather than inventing a second set.
6. **Everything else — multi-select, delete/duplicate, multi-manifest per project, easing
   curves on camera keyframes (**B-059** — the engine already supports per-key bezier easing
   and the schema silently strips it, so this one is nearly free) — is real but genuinely
   lower-urgency** and mutually independent. Pick
   them up opportunistically. Multi-manifest in particular (D-046's deliberate "one manifest
   per project") should wait for a real user need rather than being built speculatively.
