# BUGS

Real defects only — in our code or the engine. Not setup/housekeeping. Move to GitHub
Issues once public.

```
## B-NNN — title
status: open | fixed | wontfix   ·   severity: blocker | high | medium | low   ·   area: …
repro / expected / actual / cause / fix
```

## Known engine constraints (design around these — not bugs)

- Render entry points are Tauri-coupled → **D-014** (extract `render_core`).
- Masks are static per image — no keyframe/tracking model. We add it.
- Depth Anything is wired for stills; per-frame video depth needs temporal smoothing or it flickers.
- `process_and_get_dynamic_image` bypasses the GPU and returns the source unprocessed if `w|h > max_texture_dimension_2d` — watch at 8K.

## Open

_(none)_

## Fixed

_(none)_
