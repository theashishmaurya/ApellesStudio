# Rounded corners on an Edit-tab clip (`Clip.corner_radius`, D-344)

What this is: the worked-out design detail behind the per-clip `corner_radius`
field — the unit it is in and why, the one formula both renderers compute, the
naive formula that was tried first and measurably broke, and the real numbers
the two engines agree to.

What it is **not**: the decision record. That is `docs/08-decisions.md` D-344.

---

## What was missing

A clip on the Edit timeline had no way to render with rounded corners, in
either engine. Before D-344 the words "rounded corner" appeared exactly once in
the whole codebase, and it was a disclaimer: the animated-caption capability
entry explaining that a caption *cannot* have one, because
`drawbox has neither a corner radius nor a per-frame alpha expression`.
Neither `composite_layer_onto` (the live preview, `app/src-tauri/src/chroma/
edit.rs`) nor `buildClipFilterChain` (the ffmpeg export, `packages/editor/src/
timelineExport.ts`) had any masking concept beyond the D-132 crop insets, which
are rectangular by construction.

## The unit: OUTPUT-CANVAS PIXELS, and why that breaks the local pattern

Every other geometry field on a clip is a **fraction** of the output
composition — `position_x`/`position_y` (D-136), `scale`, `box_width`/
`box_height` (D-193), the four crop insets (D-132). That is not a stylistic
preference: it is B-043's fix. The preview renders the same composition into a
960-px buffer while scrubbing and a 640-px one while playing, so a field
measured in *canvas pixels* silently changes meaning with the preview quality.
A ratio is invariant under that by construction.

`corner_radius` is pixels anyway, for two reasons:

1. **It is a finish on the box, not the box's geometry.** A human means "16 px
   of round", and specifically does not want that number rescaled when the box
   moves or is resized. Every reference that exposes the control states it in
   pixels — CSS `border-radius`, Premiere's Rounded Corners, Resolve's Rounded
   Corner.
2. **The conversion is exact and one-directional, so it costs nothing.** The
   output composition's pixel size is a render parameter *both* engines already
   hold, so there is no Rust/TS parity gap here (contrast `scale`, whose
   meaning depends on the clip's own source resolution, which the pure, no-I/O
   ffmpeg compiler cannot probe — B-074/D-184's documented gap).

So the preview pays for the exception in exactly one place:
`ClipTransform::scaled_to_render(render_scale)`, called by the two functions
that own a `render_scale` (`composite_video_frame` and `ClipView::
apply_geometry`). A zero radius stays exactly zero at every scale, so the
default is free.

## Where in the pipeline: after `scale`, before `rotate`

Rounding is a property of the layer's **placement box**, so it has to be
applied once the box's real on-canvas size is known (after `scale`/`box_*`) and
while the box is still axis-aligned (before `rotate`). Both engines put it at
that same point, and the position is the whole of the field's definition rather
than a convenience: a rotated clip's rounded corners rotate *with* it, which is
the only reading of "this clip has rounded corners" that survives a rotation.
Masking after `rotate` instead would give the export axis-aligned rounding on a
rotated clip while the preview showed rotated rounding — precisely the
two-engine divergence class B-090/B-094/B-095 each closed.

Both engines **multiply** the existing alpha rather than replacing it, exactly
as `opacity` already does, so a cropped, rounded, half-opaque, dissolving clip
is all four at once and none of them silently overrides another.

## The formula: the canonical rounded-box SDF, and the trap that isn't it

Both engines compute this, on the pixel whose top-left is `(x, y)` in a `w`×`h`
box at radius `r`:

```
r'  = clamp(r, 0, min(w, h) / 2)
qx  = |x + 0.5 - w/2| - (w/2 - r')
qy  = |y + 0.5 - h/2| - (h/2 - r')
sd  = hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r'
cov = clamp(0.5 - sd, 0, 1)
```

That is the standard `sdRoundedBox` signed distance field, thresholded at half
a pixel for a one-pixel anti-aliased edge. Two details are load-bearing:

- **The clamp to `min(w, h) / 2`** makes an over-large radius a pill (or a
  circle on a square box), which is what CSS does with one, rather than a
  degenerate shape. It lives at the point of use in both engines, matching how
  `crop_pixel_rect` clamps the crop insets and `composite_layer_onto` clamps
  `opacity` — the model stores what the UI wrote, the consumer decides what it
  means.
- **The `+ 0.5` on the pixel centre** makes the box span `0..w` (full pixel
  coverage) rather than `0..w-1` (pixel *centres*). Without it the outermost
  row and column come back half-covered even at `r == 0`.

### The naive formula, and why it was rejected against real ffmpeg

The obvious formulation is "distance from the corner circle's centre,
thresholded at `r`":

```
dx  = max(0, max(r - x, x - (w - 1 - r)))
dy  = max(0, max(r - y, y - (h - 1 - r)))
cov = clamp(r + 0.5 - hypot(dx, dy), 0, 1)
```

It produces a correct-looking rounded corner, and it is **wrong at `r == 0`**.
With no corner arc to be outside of, `dx` and `dy` are both zero everywhere, so
`cov` evaluates to `clamp(0.5 - 0, 0, 1) == 0.5` — it silently halves the alpha
of the **entire layer**. Measured directly against real ffmpeg before either
engine was written; the probe reported `r=0 -> all alpha 255: False`.

It is patchable with a special case (`cov = 1` where the distance is zero), but
that special case is the defect: it introduces a discontinuity at sub-pixel
radii and, more importantly, it means the "zero is byte-identical" guarantee
holds only because the *callers* skip the mask, not because the formula is an
identity. Under a **keyframed** radius passing through zero, the callers cannot
skip it. The SDF form needs no special case and is an exact identity at
`r == 0` by construction, which is why it is the one that shipped.

## Both engines, and how they are held together

| | preview | export |
|---|---|---|
| where | `chroma::edit::corner_coverage`, applied in `composite_layer_onto` | `cornerRadiusMaskExpr`, a `geq` node in `buildClipFilterChain` |
| paths | two — fused per destination pixel in `blend_layer_sampled` (the D-217 magnify fast path), and a buffer pass on the general/rotated path | one — `format=rgba` then `geq=…:a='alpha(X,Y)*(…)'` |
| keyframes | `f64_or("corner_radius", …)`, the D-034 engine | `keyframeExprAt(…, bigTVar)`; `geq`'s time variable is uppercase `T` |
| identity | no work emitted at all when `radius <= 0` | no `geq` node, and no `format=rgba`, when the radius is zero and unkeyed |

They are held together by **one canonical table of alpha bytes**, recorded from
real ffmpeg output, that *both* engines' real test suites assert against:

- `chroma::edit`'s `corner_coverage_matches_real_ffmpegs_own_measured_alpha`
- `packages/editor/src/timelineExportCornerRadius.ffmpeg.test.ts`'s
  `CORNER_PROFILE_100x100_R20`

A change to either engine's formula that the other does not get fails one of
the two. This is the test B-090/B-094/B-095's postmortems each say should have
existed on day one of a two-engine field; here it did.

### The canonical profile — 100×100 box, `corner_radius: 20`

Real ffmpeg's own alpha bytes for the top-left 8×8 block of a fully opaque
layer:

```
   0   0   0   0   0   0   0   0
   0   0   0   0   0   0   0   0
   0   0   0   0   0   0   0   0
   0   0   0   0   0   0   0   0
   0   0   0   0   0   0   0 149
   0   0   0   0   0   0 175 255
   0   0   0   0   0 175 255 255
   0   0   0   0 149 255 255 255
```

### Measured agreement

Comparing real ffmpeg's rendered alpha against the preview's formula over the
whole 100×100 frame at `corner_radius: 20`:

| measurement | result |
|---|---|
| pixels compared | 10 000 |
| max &#124;export − preview&#124; | **1 / 255** |
| pixels differing at all | 56 (0.6 %) |
| pixels differing by more than 1/255 | **0** |
| mean absolute difference | 0.0056 / 255 |
| arc-crossing (50 % coverage) disagreement, over all 20 arc rows | **0 px** |

The residual 1/255 on 0.6 % of pixels is ffmpeg's own alpha quantisation
(`geq` truncates where the reference rounds), not a difference in the mask. The
**visible** boundary — where each row's coverage crosses 50 %, which is what a
viewer reads as "the round" — is identical on every row.

At `corner_radius: 0`: real ffmpeg leaves all 10 000 pixels at alpha 255, and
the preview's coverage is exactly `1.0` (not `0.999…`) at every pixel of every
box size tested.

## Deliberate limits

- **Not on a text/title clip.** The export compiles a title to `drawtext`,
  which cannot mask its own corners, so a preview that rounded one would be
  showing a picture the export cannot produce —
  `resolve_text_clip_transform` pins the field to zero and
  `editor_set_clip_transform` refuses a non-default value, the same defence
  `scale`/`rotation`/`crop_*` already have there (D-211).
- **Not on an adjustment clip.** Its correction is full-frame (D-229); there is
  no box to round.
- **Not on a dip-to-colour plate.** A plate covers the frame; rounding it would
  let the picture beneath show through at the corners, which is not what a
  dip-to-colour is.
- **The on-canvas transform box stays rectangular.** `resolveClipBoxTransform`
  deliberately does not resolve the radius: the overlay is a manipulation
  handle, not a preview of the picture, and every NLE draws it square for a
  rounded layer.
- **No per-corner radii.** One radius for all four. Both engines' formulas
  would extend to four without much trouble, but nothing has asked for it and
  a four-number field is a real API decision, not a free generalisation.
