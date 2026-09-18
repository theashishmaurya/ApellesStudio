# c040 split-screen — the geometry, and what it replaces

**What this is.** The worked-out layout for `2026-09-12-c040-mgfx-recut`'s
composite: one frame, two rounded panels side by side — the speaker's camera on
the left, the Motion graphic (plus its captions) on the right. Owner-directed,
2026-09-17, after a hand-drawn wireframe. It replaces **D-342**'s
graphic-full-frame + camera-corner-PIP framing.

**What it does NOT cover:** the `crop_*` semantics the camera panel depends on
(**D-346**, which had to be fixed first — see "Why this needed engine work"),
or the manifest reflow that moves the Motion layers onto the new canvas
(**D-347**).

---

## Why the PIP had to go

D-342 put the camera in the bottom-right corner at `scale 0.22`, `position
(0.760, 0.755)`, uniformly across all nine graphic windows. Its own decision
entry recorded the cost and the owner accepted it at the time: **six of the nine
scenes put caption content under that corner** — measured from each scene's own
render (no PIP) as the rightmost text pixel against the PIP's `0.760` left
edge — `lostmiddle` 0.902, `hook` 0.070 overlap, `qkv` 0.049,
`whatisattention` 0.023, `recap` 0.020, `encdec` 0.012. The worst case visibly
reads *"…in the middle of a"* and stops. A joint search over the whole
bottom-right region found no clean shared slot at that size.

The owner's call (2026-09-17) was to **change the layout rather than shorten the
captions**. The split screen removes the failure mode structurally rather than
by tuning: the camera and the graphic occupy disjoint rectangles, so no caption
can ever sit behind the camera at any position, at any scale, in any scene.

## The reference material this was built from

Per CLAUDE.md's "research the real pattern first" rule. Full trail, including
the dead ends, in `scratch/` (gitignored) — the load-bearing findings:

- **Crop-to-fill is the vendor rule, and letterboxing is not.** Final Cut Pro's
  own *Crop clips* page: *"The cropped image automatically expands to fill the
  screen"* and *"The cropped image always maintains the original aspect ratio."*
  iMovie's *Create a split-screen effect*: *"cropped versions of both clips
  appear in the viewer."* This is what settled D-346's question of which engine
  was wrong, not just how to frame the camera.
  <https://support.apple.com/guide/final-cut-pro/crop-clips-verb8e5db98/mac> ·
  <https://support.apple.com/guide/imovie/create-a-split-screen-effect-movb8c659f55/mac>
- **A 16:9 → vertical reframe is face-aware, not centre-crop.** FCP's *Smart
  Conform* adjusts framing *"based on the specific video content, such as
  faces"*, then exposes **Position** for the operator to nudge. That is exactly
  the shape of the camera crop below: a fixed horizontal centre measured off the
  speaker, not the frame's midpoint.
  <https://support.apple.com/guide/final-cut-pro/adjust-framing-with-smart-conform-ver26664d93f/mac>
- **EBU R 95** (v1.1, 2017), the only hard number anyone publishes for this:
  *"The action safe area is 3.5% and the graphics safe area is 5%, at the top,
  bottom and lateral parts of the image."* It explicitly covers 2160p. On
  3840×2160 that is a 192 px horizontal / 108 px vertical graphics-safe inset —
  which is what sets the Motion panel's INTERNAL padding below, since the
  captions are "graphics" and must sit inside that box of the **whole canvas**,
  not merely inside their own panel. <https://tech.ebu.ch/docs/r/r095.pdf>
- **Nobody publishes a split ratio, a corner radius, or a gutter.** Zoom
  documents "Side-by-side: Speaker" and a *draggable* divider (*"the meeting
  window is split between the shared content and video thumbnails, with the
  ability to adjust the proportions"*) and states no default. Loom has no
  side-by-side layout at all — its screen+camera mode is a circular bubble.
  Screen Studio exposes `Padding` / `Rounded corners` / `Inset` / `Roundness`
  sliders with no published values; Descript binds visual ROLES ("Talking
  Head", "Screen Recording") to positions with no proportions; Camtasia and
  Riverside likewise. **The 30/70 split, the 14 px radius and the gutter are
  therefore our own calls and are recorded as such** — the widely repeated
  "Zoom is 25/75" is community lore with no vendor source and was not used.
  Adobe's and Blackmagic's docs could not be retrieved (403 / client-rendered)
  and are cited by nobody here.

## The geometry

Canvas **3840 × 2160** (the project's own `settings`). All values are output
pixels.

| | value | why |
|---|---|---|
| outer margin `M` | **64** | the frame reads as a frame at 1.7% of the width; thin enough that neither panel loses real area |
| gutter `G` | **64** | `G = M`, so the two panels sit in an even, symmetric frame. **Our call** — no video, broadcast or presentation source states a gutter↔margin rule (R 95 is silent on internal gutters). The nearest real precedents are web grids and disagree with each other: IBM Carbon runs a gutter ≈1.3–2× its margins, Bootstrap 5 fixes a 24 px gutter with no stated margin ratio. Equal reads cleanest here and is trivially re-tunable |
| panel height `H` | **2032** = 2160 − 2·64 | both panels full height; no vertical dead space |
| left panel `W_L` | **1144** | exactly **9:16** against `H` (1144/2032 = 0.5630 vs 0.5625) — the portrait/short-form standard, so the speaker column is a shape the crop has a real convention for. Lands at **30.8%** of the 3712 px content width, inside the owner's "~30%" |
| gutter | 1208 → 1272 | |
| right panel `W_R` | **2504** = 3840 − 2·64 − 64 − 1144 | 67.5% of the content width; aspect 2504/2032 = **1.232** |
| corner radius | **14** | the owner's number, taken literally in the units the field uses (`corner_radius` is OUTPUT-CANVAS pixels, D-344). **Flag for the owner:** 14 px on a 3840-wide canvas is 0.36% of the width and reads as a very subtle round — if the wireframe meant "14 px" against a 1920-wide mental canvas, 28 is the equivalent. One-line change either way |

Both panels: `y` 64 → 2096.
Left panel: `x` 64 → 1208. Right panel: `x` 1272 → 3776.

### The camera (left panel)

The source is `A001_09122356_C040.MOV`, 3840×2160 @ 24 — the same 16:9 as the
canvas, so its `natural` footprint is the whole composition and `scale` means
the same thing in both engines (no B-208 exposure).

| field | value | derivation |
|---|---|---|
| `crop_top` | **0.07** | drops 151 px of ceiling. Chosen by eye against six frames sampled across the source: it puts the eyes near the upper third instead of the vertical middle, which is the difference between the two variants rendered in `scratch/` (`v_t000.png` vs `v_t007.png`) |
| `crop_bottom` | **0** | |
| `crop_left` | **0.3877422** | the kept width is `2008.8 × (1144/2032) = 1130.9 px`, i.e. a kept fraction of 0.2945156, centred on **x = 0.535** of the frame |
| `crop_right` | **0.3177422** | |
| `scale` | **0.29791667** | `1144 / 3840`. The HEIGHT follows from the cropped aspect ratio in both engines (D-346), and lands on 2032 |
| `position_x` | **0.01666667** | `64 / 3840` |
| `position_y` | **0.02962963** | `64 / 2160` |
| `corner_radius` | **14** | |

**Why 0.535 and not 0.5.** The speaker's head centre was measured across six
frames spanning the source (t = 60/150/260/380/500/620 s): 0.547, 0.522, 0.569,
0.500, 0.522, 0.547 — mean 0.534, range 0.50–0.57. A half-crop-width of 0.1473
around 0.535 keeps the head inside with ≥0.03 of margin at both extremes; a
centre-crop at 0.5 would put the head's right edge on the panel edge at the
0.57 frames. This is FCP Smart Conform's own rule (face-aware crop + a position
nudge), applied by hand.

**Verified through real ffmpeg**, with the exact expressions
`timelineExport.ts`'s `buildClipFilterChain` emits: `crop → scale` produces a
box measuring **exactly 1144 × 2032**, and the composited frame's panel edges
probe at x 64…1207 / gutter 1208…1271 / 1272…3775, y 64…2095 — every edge on
its designed pixel. (`scratch/.../exportcheck2.png`.)

### The animate in/out

D-342's PIP ramps are kept in character and re-pointed: **12 frames** (0.5 s at
this timeline's 24 fps), `ease-in-out` `(0.42, 0, 0.58, 1)` on every animated
property, a shrink ending as the graphic starts and a grow beginning as it ends.
The animated properties become `scale` + `crop_left` + `crop_top` +
`crop_right` + `position_x` + `position_y` (+ `corner_radius` 0 → 14, which IS
keyframeable in both engines, D-344). All of those are keyframeable through
`editor_set_clip_keyframes` today; `box_width`/`box_height` are not, which is
why the camera is sized with `scale` + a crop rather than a box, and why D-346
had to land first.

The ramp is a genuine reframe rather than a plain shrink — the box morphs from
16:9 full-frame to the 9:16 column — and each ramp lives on whichever camera
clip actually contains it, per D-342's existing per-clip placement (18 keyframed
ramps, 36 static holds, 21 clips staying full-frame; two ramps deliberately
nudged 2–3 frames to sit inside one clip, and `payoff`'s pulled inside its own
window).

### The Motion graphic (right panel)

The manifest's canvas becomes the panel: **1252 × 1016** authoring pixels, which
`Config.setScale(2)` (D-342) renders at exactly **2504 × 2032**. The Edit clip
then places it 1:1 with no resampling at all:

| field | value |
|---|---|
| `box_width` | **0.65208333** (`2504 / 3840`) |
| `box_height` | **0.94074074** (`2032 / 2160`) |
| `position_x` | **0.33125** (`1272 / 3840`) |
| `position_y` | **0.02962963** |
| `corner_radius` | **14** |

`box_width`/`box_height` rather than `scale` deliberately: they are canvas
fractions in both engines with no unit divergence, and the render is already the
box's exact size.

**Internal padding: 64 authoring px** (= 128 output px) on all four sides, so
the graphic's content box is 1124 × 888 authoring px. That number is not
arbitrary — it is what puts the right panel's content exactly on EBU R 95's
graphics-safe boundary of the WHOLE canvas: the panel's own right edge is at
output x 3776, and 3776 − 128 = **3648 = 0.95 × 3840**, R 95's 5% inset to the
pixel. Vertically it clears the 108 px inset with room.

---

## Why this needed engine work

Two contracts were wrong, and both are fixed and committed:

- **D-346 (fixes B-218, B-223)** — the live preview applied a crop as an alpha
  mask over the already-scaled full frame, so the camera column would have been
  correct in the export and wrong in the preview. It now resizes the crop's
  sub-image into the box, matching ffmpeg and the docs, guarded by a
  cross-engine parity pair.
- **D-347** — `motion_set_project_settings` wrote a new canvas without moving
  the layers, so changing the Motion canvas to 1252 × 1016 would have left every
  scene's composition in the top-left corner at 65% of the frame's width. It now
  reflows the layout onto the new canvas in the same commit, driven off
  `propCatalog.ts`'s existing position/size registries.

## Done, 2026-09-18

Two dispatched passes each hit a real connectivity wall and correctly stopped
rather than work around it (their accounts, and the mid-air "worktree cannot
reach chroma" misdiagnosis, are preserved in git history — `git log -p` on
this file — rather than kept inline here, now that the work itself is done).
The actual blocker both times was the coordinating session's own `/mcp`
connection going stale/dead, not the app, not the MCP server's code, and not
worktree isolation as such. Once reconnected, the coordinating session
finished the whole content rebuild directly in one pass:

1. **Reflow ran exactly as predicted**: `motion_set_project_settings(width=1252,
   height=1016, reflow=True)` reported `sx 0.6521`, `sy 0.9407`,
   **82 layers / 327 fields** moved — matching the pre-computed estimate above
   to the field.
2. **Every scene was checked against the LIVE rendered result, not the
   pre-reflow static estimate** — and the estimate turned out wrong in one
   direction and right in another:
   - `c040-hook` and `c040-payoff` (the two scenes flagged for a stacking
     redesign) actually fit cleanly once really reflowed and screenshotted —
     the `claudechat` (691 px) and annotation column (404 px) total 1095 px
     inside the 1252-wide canvas with a tight but real ~59 px gutter. **No
     redesign was needed**; the pre-reflow width analysis had overstated the
     collision because it summed the PRE-reflow widths (1060+620) rather than
     the post-reflow ones.
   - `c040-whatisattention`'s word row (`summarize this and flag anything
     off`) genuinely did overflow — `off` sat right at the frame's edge with
     no margin. Fixed with a small proportional compression of the row (all
     six words shifted left by 3–28 px, anchored on `summarize`) rather than a
     two-row wrap, since the overflow was only ~30 px; the matching emphasis
     highlight boxes and the "↑ underweighed" callout were moved by the same
     deltas to stay aligned with the words they mark.
   - **One further defect, not predicted by the pre-reflow analysis, was found
     and fixed in the same pass**: `c040-qkv`'s `graph` layer has FIXED node
     positions (not force-directed), and one node — `v`, labelled `"the
     content of \"anything\""` — is dramatically longer than its neighbours'
     single-word labels. The reflow compresses node POSITIONS by `sx`/`sy` but
     does not shrink label FONT SIZE (graph labels aren't a registered
     `propCatalog` size field), so a gap that was comfortable pre-reflow
     collided post-reflow: the label visually ran into its neighbour
     (`"anythingthe content of \"anything\""`, jammed together, confirmed at
     two different frames so not a transient animation artifact). Fixed by
     shortening the label to `"the content"` via `motion_set_layer_field`
     (`key: "nodes"`, the whole array rewritten with the one label changed —
     there is no dedicated per-node-label tool).
3. **All 9 scenes re-rendered** (`motion_render`) — confirmed via
   `get_timeline` (not `motion_get_edit_links`, which reported a stale
   `clipCount: 0` / wrong-project-path snapshot at the time; the real
   timeline was correct throughout) that all 9 Edit-tab overlay clips
   auto-refreshed to the new renders with their exact original frame counts
   unchanged (D-260), so no re-placement was needed.
4. **The camera's PIP clips were rebuilt — in three passes, because the first
   two were each caught wrong by direct owner spot-checking, not by any
   automated check.**

   **Pass 1** replaced the static base transform (`position_x 0.76,
   position_y 0.755, scale 0.22`) on the 38 clips a first scan found carrying
   it, with the new left-panel values (`crop_top 0.07, crop_left 0.3877422,
   crop_right 0.3177422, scale 0.29791667, position_x 0.01666667, position_y
   0.02962963, corner_radius 14`) via `editor_set_clip_transform`.

   **Pass 2**, prompted by the owner seeing old-corner PIP still live in the
   preview: re-scanning every clip whose timeline range overlaps ANY of the 9
   overlay windows (not just clips with the exact old values) found **22
   more** clips inside overlay windows sitting at the plain full-frame default
   (`position 0,0, scale 1`) — never part of the original 38, and never fixed
   by pass 1. These got the same new left-panel transform.

   **Pass 3**, prompted by the owner seeing old-corner PIP AGAIN, in a THIRD
   spot — this was the real miss. `editor_set_clip_transform` only ever
   writes a clip's STATIC base value, and a keyframe silently overrides a
   static value for any property it names. **16 clips genuinely do carry real
   animated keyframes** — this note's ORIGINAL "18 ramps + 36 holds"
   description was much closer to correct than the "no animated keyframes at
   all, D-342 never shipped that" claim pass 1/2's investigation put in its
   place. The miss: `project.json` stores them under the field
   `chroma_keyframes`, and the scan that produced the "no keyframes exist"
   conclusion searched for a field called `keyframes` — a name that was never
   there to find. Each of the 16 ramps interpolates `position_x`/`position_y`/
   `scale` between a full-frame hold and the PIP target over a 12-frame
   `ease-in-out` — exactly the "smooth animate in/out" the geometry section
   above describes. Fixed by rewriting all 16 via `editor_set_clip_keyframes`
   (same frame numbers, same ease curves — only the target values changed
   from the old corner to the new left-panel geometry).

   **After all three passes**, re-verified exhaustively (every clip whose
   range overlaps any overlay window, checked programmatically against BOTH
   its static value and, where present, its keyframes' end-state — not by
   further spot-checking) that zero clips anywhere still resolve to the old
   corner transform. The 9 Motion overlay clips on track 1 got the new
   right-panel box (`box_width 0.65208333, box_height 0.94074074, position_x
   0.33125, position_y 0.02962963, corner_radius 14`) — this part was correct
   on the first pass, since the graphic panel never animates.

   **The lesson, stated plainly for whoever next greps this file for "how do I
   check a clip's keyframes": grep `project.json` for `chroma_keyframes`, not
   `keyframes`.** A scan that returns zero matches for a plausible-sounding
   field name is not proof the field never held anything — it may be proof
   the name was wrong. This cost three passes and two owner-caught misses that
   a single correct grep would have prevented.
5. **Verified by real export, not preview alone**: the whole timeline was
   exported at native 3840×2160 to `2026-09-12-c040-final.mp4`. D-346's actual
   compositing fix is Rust (`app/src-tauri/src/chroma/edit.rs` —
   `composite_layer_onto`/`effective_size`/`blend_layer_sampled`, 496 lines,
   confirmed by reading the merged diff directly), not "frontend TS with no
   Rust" as one of the earlier passes briefly and wrongly claimed — that pass
   was looking at the GUI's separate box-drawing/hit-testing mirror of the fix
   (`transformGeometry.ts`/`canvasPick.ts`/`clipKeyframes.ts`), not what
   renders the live preview's actual pixels. The Rust fix needs the Tauri
   app's own binary rebuilt, which it was (`target/debug/apelles` relinked at
   00:38, after the D-346 merge at 00:35) — the live preview already matched
   the design (camera left panel correctly cropped/rounded, graphic right
   panel with visible gutter, captions fully clear of the camera in every
   scene checked), and the export was run to confirm that match holds under
   the real ffmpeg path too, per this note's own standing caution.
