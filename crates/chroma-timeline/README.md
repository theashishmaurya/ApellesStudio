# chroma-timeline

**Layer 2 (domain model).** The OTIO-shaped edit model for the Editing tab:
tracks, clips, gaps, and the edit ops (ripple / roll / slip / slide, trim,
split), plus the transcript→EDL builder.

- **Deps:** `chroma-types`, `serde`. **Pure** — no `wgpu`, no `ffmpeg`, no
  rendering.
- **Serde ↔ OTIO JSON.** The OpenTimelineIO *data model*, not its C bindings
  (D-039).

## Status

D-039 migration **step 1 skeleton** — `Timeline` / `Track` / `Clip` skeleton
with `#[derive(Serialize, Deserialize)]`. OTIO-shaped, D-039. Edit ops and
transcript→EDL land in a later, tracked step.
