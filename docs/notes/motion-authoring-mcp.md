# Motion authoring from MCP — new graphics and templates as data, not code (Phases 0-1 built, D-403/D-404/D-405; Phases 2-4 design)

Owner request (2026-10-26): "look into a way to create new catalog / motion graphics from MCP
directly instead of tweaking the code." Context: Apelles' founder/brand-video studio direction needs
agents to author new motion graphics and reusable templates through MCP alone, with a matching GUI
(CLAUDE.md human-and-AI rule), deterministically, local-first. This note is the design trail;
each phase needs its own D-NNN when built (numbers below are provisional; D-402 is taken by the B-274 edit journal).

## Status

- **Phase 0 — built (D-403, 2026-10-27).** Per-primitive schemas in
  `packages/motion-engine/src/engine/primitiveProps.ts`; the layer schema is a discriminated
  union (`schema.ts`), loose on load, strict for authoring (`validate.ts`'s unknown-key
  pass); `motion_validate`, `motion_insert_layers`, `motion_set_scene`,
  `motion_add_layer(props)`, `propsSchema` (`jsonSchema.ts`), `motion_preview_frame`
  (`crates/apelles-motion/src/still.rs`: cached bundle + `remotion still` + contact sheet).
  Every mutating op refuses a document that would not load, with the same issues.
  GUI: Catalog **Insert as JSON**, toolbar **Still**. Deviation from the plan below: the
  preview bundle is cached per project under `motion/cache/preview/`, keyed by a content
  fingerprint of the engine sources; `propCatalog` is TESTED against the schemas
  (`propCatalog.schema.test.ts`, both directions) rather than derived from them.
- **Phase 1 — built (D-404/D-405, 2026-10-27).** `image` (assets copied into
  `motion/assets/<sha256>.<ext>`, ids `sha256:<hex>.<ext>`, `--public-dir` for renders and
  previews, `convertFileSrc` in the player), `icon` (Phosphor by kebab name, the library
  loaded by dynamic `import()` with `delayRender`), `shape` (`@remotion/shapes` +
  `@remotion/paths`), `counter`, `group` (relative `at`, transform, rect/roundrect/ellipse or
  text mask via an SVG `clipPath`, depth ≤ 4), `anim` tracks (absolute values; one level into
  object props, e.g. `mask.w`). `motion_import_asset`; icon names validated against the
  installed library. GUI: Catalog rows, asset/icon pickers, Property tracks field, nested group
  rows (a child row selects its group). Proof: `packages/motion/src/brandScene.e2e.test.ts` +
  `crates/apelles-motion/tests/preview_render.rs`. Deviations: shape masks use CSS `clip-path`
  and text masks an SVG `clipPath` (not CSS `mask`); a group child cannot be selected on its own
  yet.
- Phases 2-4: design below, not built.

## What existed before Phase 0 (checked in the code, 2026-10-26)

- **11 primitives** (`use` values in `packages/motion-engine/src/engine/schema.ts`, `z.enum`, plus a
  hand-written `REGISTRY` in `src/engine/registry.ts`): text, emphasis, matrix, graph, layers,
  deviceframe, claudechat, plot, particleflow, labelbox, layerstack. All explainer-style. **No
  image/logo, shape, path, icon, group or number counter**, so a brand video cannot show a logo yet.
- **Primitive props are not validated**: the layer schema is `.passthrough()`. A wrong prop renders
  silently or throws mid-render; `packages/motion/src/propCatalog.ts` describes fields for the
  Inspector but nothing enforces them.
- **Only the transform is keyframeable** (x, y, scale, rot, opacity, blur; `Video.tsx`
  `renderLayers`). Colour, size and stroke progress are not.
- **Reuse:** D-332 layer presets save one frozen layer (`layerPresets.ts`, `layerPresetIO.ts`).
  No scene/group template, no Lottie.
- **MCP:** `motion_add_layer(use)` inserts defaults only, so an agent needs N `motion_set_layer_field`
  calls. No whole-scene insert, no validation dry-run, no single-frame preview (though
  `crates/apelles-motion/src/lib.rs` `build_command` already supports `--frames`).
- **Precedents to follow:** D-399 themes (data embedded in the manifest + a user library + one
  builder shared by GUI and MCP); D-332 copy semantics; D-347 `manifestReflow.ts` (canvas reflow);
  `lib/rng.ts` (seeded mulberry32); zod `z.toJSONSchema` to publish prop schemas to agents.

## Recommendation

### Templates as data (scene or group)

`templateDef.ts` (zod, beside `themeDef.ts`):

```
MotionTemplate { schemaVersion: 1, id, name, version, description, tags[],
  kind: "scene" | "group", authoredAt: { width, height, fps },
  slots: [{ id, type: text|number|color|image|icon|enum|list, label, default?, required,
            constraints { maxLen, min, max, options } }],
  body: Scene-without-id | Layer[],   // any value may be {"$slot": "headline"}
  themeDef?: ThemeDef }
```

- Bindings are `{"$slot": id}` plus `"{price}/mo"`-style text interpolation. **No expression
  language.**
- `instantiateTemplate(t, values, canvas)` is pure: fill slots, reflow from `authoredAt` (D-347),
  mint fresh ids, validate with `manifestSchema`.
- **Copy semantics** (D-332): the manifest holds plain expanded layers, so a render never depends on
  the library (D-399's determinism rule). Provenance `scene.template = {id, version, values}` lets
  `motion_refill_template` re-expand with new values; no live link.
- Storage: `<app data>/motion/templates/<id>.json`, one file per template; built-in starters ship as
  data in `packages/motion/src/templates/*.json` (logo reveal, feature callout, stat counter,
  testimonial, pricing card, CTA end card); migrate by `schemaVersion`.
- MCP: `motion_save_template`, `motion_define_template`, `motion_list_templates` (returns slot
  schemas), `motion_get_template`, `motion_instantiate_template(id, values, …, dry_run)`,
  `motion_refill_template`, `motion_delete_template`.
- GUI: a Templates section in `CatalogPanel.tsx`; an insert form generated from the slots; "Save
  scene as template" on the scene row; a "make slot" toggle beside each Inspector field.

### New kinds of graphics: generic primitives (core of the plan)

Each with its own zod props schema: **`image`** (project asset: logo, screenshot; fit, radius,
border), **`icon`** (Phosphor by name and weight; the package is already a motion-engine dependency),
**`shape`** (rect, roundrect, ellipse, polygon, star, line; fill/gradient/stroke; `@remotion/shapes`),
**`counter`** (from→to with format, prefix, suffix), **`group`** (children, its own `at`, transform,
clip/mask by shape or text), **`path`** (SVG `d` with draw-on/morph via `@remotion/paths`; design
shapes only, never icons), **`repeater`** (grid/radial/linear copies with per-index stagger and
seeded jitter), `textonpath` (later). Plus **property tracks** `anim: {"<prop>": [{at, v, ease}]}`
for numeric and colour props, through the existing `interpolateKeys` and Remotion's
`interpolateColors`. Caps in the schema: repeater ≤ ~400 instances, group depth ≤ 4.

With these, an agent can build logo reveals, lower thirds, feature grids, pricing cards, stat bars,
animated underlines, icon rows and badge bursts entirely in JSON.

### Rejected or deferred

- **Live composite primitives** (definition + instances that update together): no for now; a
  group template covers ~90%, and a live graph needs the override/reconciliation model D-332 declined.
- **Lottie import** (`@remotion/lottie` + lottie-web): later, import only. Frame-seekable, so
  deterministic, but agents cannot author it and it ignores the theme. lottie-web runs **expressions
  via `eval`**, so validation must refuse expressions and external asset URLs; store the JSON as a
  hashed asset.
- **Sandboxed user JS** (QuickJS/iframe): rejected. Determinism needs stubbing `Math.random`/`Date`,
  per-frame WASM calls are slow in headless renders, the webview has Tauri IPC (no
  `allow-same-origin`), and the output would have to be a display list of primitives anyway, i.e.
  the generic-primitives option. It also reintroduces the code the owner asked to avoid.

## MCP surface for authoring safely

- `motion_validate({manifest | scene | layers | template})`: a dry run returning
  `{ok, issues: [{path, code, message, expected, hint}]}` from zod; every mutating op returns the same
  list when it refuses.
- `motion_list_primitives` gains a `propsSchema` per primitive (`z.toJSONSchema`).
- `motion_insert_layers(scene, layers[], dry_run)` and `motion_set_scene(scene, scene, dry_run)`:
  validated fragments in one undoable step; `motion_add_layer` gains `props`.
- `motion_preview_frame(scene, at_seconds | frames[], scale)`: PNG(s) via `remotion still` against a
  bundle cached by engine hash (`build_still_command` beside `build_command`); several frames come
  back as a contact sheet so the agent can see motion. Can preview an uncommitted manifest.
- `motion_import_asset(path)`: copies into `<project>.chroma/motion/assets/<sha256>.<ext>`; the
  manifest references content hashes, never absolute paths (deterministic), rendered via
  `--public-dir`.

## Phased plan

| Phase | What | Provisional D-NNN |
|---|---|---|
| 0 | Per-primitive zod prop schemas (layer schema → discriminated union; `propCatalog` derived/tested against them); `motion_validate`, `motion_insert_layers`, `motion_set_scene`, `motion_preview_frame`. Makes everything after it safe for agents. | D-403 |
| 1 | Brand primitives: `image` (+ hashed asset store), `icon`, `shape`, `counter`, `group` with mask, `anim` property tracks. Most leverage for founder videos. | D-404 (assets), D-405 (primitives) |
| 2 | Templates: `templateDef.ts`, `templates.ts`/`templateIO.ts`, Rust load/save beside themes, 7 MCP tools, GUI, starter pack. Records the rejections above. | D-406 |
| 3 | Expressive: `path` (draw-on, morph), `repeater`, `textonpath`. | D-407 |
| 4 | Lottie import as an asset, refusing expressions. | D-408 |

Every phase ships the GUI and MCP halves together, re-captures the MCP parity corpus, and verifies
determinism (render the same frame twice, compare hashes).

Critical files: `packages/motion-engine/src/engine/{schema,registry,Video}.tsx?`,
`packages/motion/src/{motionOps,catalog,propCatalog,manifestEdit,layerPresets}.ts`,
`packages/motion-engine/src/themeDef.ts`, `crates/apelles-motion/src/lib.rs`,
`crates/apelles-mcp/src/tools/motion/tools.rs`, `mcp/server.py`.
