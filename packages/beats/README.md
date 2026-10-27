# `@apelles/beats`

Beat-grid maths shared by the Edit and Motion tabs (D-413).

| file | what |
|---|---|
| `types.ts` | the wire types `chroma_detect_beats` answers with (mirrors of `apelles_beat`), beat kinds, parameter checks |
| `grid.ts` | nearest-beat search and snapping (a point, or a span by whichever edge is nearer) |
| `cues.ts` | the cue grammar (`downbeat 1`, `next strong beat`, `every beat between a and b`, …) and `planMoves`, which places named moves on a window's beats |

## Boundary

- **Pure TypeScript.** No Tauri, no React, no store, no dependency: everything may depend on it.
- **Knows nothing about clips, tracks, scenes or keyframes.** Each tab maps its own objects onto
  these numbers (`@apelles/editor`'s `beatGrid.ts`, `@apelles/motion`'s `musicTiming.ts`).
- **Calls nothing.** The cached analysis binding is `@apelles/bridge`'s `beats.ts`.

```sh
npx vitest run   # in this folder
```
