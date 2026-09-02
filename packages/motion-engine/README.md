# @chroma/motion-engine

The Remotion motion engine for Chroma's **Motion tab** — data-driven motion
primitives + a JSON scene-manifest compiler, in the locked "dark Excalidraw"
look.

## Provenance

**Moved in from `videoAgent/engine/motion/` on 2026-09-02 (D-039).** This copy
is now canonical; **the `videoAgent` copy is stale — the user should delete
`~/my_projects/videoAgent/engine/motion/`.** The design reference still lives in
videoAgent: `engine/catalog.md`, `engine/DESIGN.md`, and the
`.claude/skills/motion-primitives/` + `.claude/skills/animate/` skills. Those
were not copied; port or re-point them if that knowledge is needed in Chroma.

## Layout

```
src/
  design.ts            ← locked design tokens (colours, stroke feel, type, easing)
  engine/
    build.ts           ← the JSON scene-manifest compiler
    schema.ts / registry.ts / Video.tsx / sample.ts
  primitives/          ← text, emphasis, matrix, graph, layers, scene3d, particleflow
  compositions/        ← *Demo compositions (living primitive references)
  lib/  helpers/        ← deterministic roughjs + frame helpers
  Root.tsx             ← registers compositions
```

## Commands

```bash
npm run dev                                   # Remotion studio
npx remotion render Animation out.mp4 --props=manifest.json
npx tsc --noEmit                               # typecheck
```

## Status (D-039)

Moved in verbatim (minus `node_modules` / `out/` / `.git` / its own
`package-lock.json` — the workspace install uses the root lock). Not yet wired
to `@chroma/motion` or the Tauri app — that is a later migration step.

## Determinism rules

Remotion renders each frame independently — same frame must produce same pixels.

- roughjs: always pass a fixed `seed` (helpers default to one).
- Any layout solver (d3-force, etc.): freeze the result once, don't run per frame.
- No `Math.random()` / `Date.now()` in render paths — derive from `useCurrentFrame()`.
