# Motion primitive traps — behaviours you cannot guess from the catalog

Each entry here cost a live debug cycle while building c038's 21 compositions
(D-368). `motion_list_primitives` does not report any of it, and several items
contradict what a primitive's field list implies.

Kept as its own note rather than inside the c038 note because none of it is
c038-specific — it applies to any Motion scene.



1. **Every time field in a manifest is SECONDS, including the ones nested inside a
   primitive's own props.** `registry.ts`'s per-primitive `adapt` runs them through
   the seconds→frames converter on the way in. So `graph`'s `enter` is
   `{at, stagger}` in **seconds** (`{"at": 0.1, "stagger": 0.55}`), not frames and
   not an array — an array makes `Graph.tsx:352` interpolate over `[NaN, NaN]` and
   throw; `stagger: 20` silently means twenty SECONDS, so every node but the first
   never appears. Same for `pulses[].at`/`.dur` and `highlight[].at`/`.dur`.
2. **`text` with `align: "center"` treats `x` as the CENTRE**, not the left edge
   (`Text.tsx` applies `translateX(-50%)`). A centred line wants `x: 626` (the
   1252-wide canvas's midpoint). Left at `x: 64` it renders essentially off-canvas
   and looks like the layer is missing entirely.
3. **`graph` fits its layout inside hardcoded margins of L/R 220, T 275, B 190**,
   tuned for the old 1920×1080 canvas. Its scale is
   `min((W-440)/spanX, (H-465)/spanY, 1.6)`, so a `height` under ~500 collapses
   the whole diagram to a point. Give it `width: 1252` / `height: 900` — the FULL
   canvas, not the padded content box, because its `<svg>` is `inset: 0` on the
   layer origin and those margins are what keep the content inside the safe area.
   With `width: 1124` the whole diagram sits 64 px left of centre.
4. **A primitive that throws used to wedge the preview permanently.** Fixed
   (B-241/D-367): the player now remounts on the next manifest edit or scene
   change. If you still see a stuck error triangle, you are on an older build.
5. **`emphasis preset: "ring"` is an expanding PING at radius 1.65×box, not an
   enclosure. Use `"scribble"` to draw around something** — and note scribble
   renders well outside its own box: **width ≈ box × 1.1, height ≈ box × 1.5,
   centred**. To enclose something, set the box to about ⅔ the height you
   want covered. An ellipse cannot enclose a very wide, flat rectangle at all;
   circle the meaningful part instead.
6. **`motion_set_layer_field` turns a float with a zero fractional part into a
   STRING** — `at: 1.0` comes back as `"1.0"`, which silently breaks the
   seconds→frames conversion. `2.5` is fine; `2.0` is not. **Write whole
   numbers as plain integers and read the echoed `value` on every numeric
   field.** Reproduced deliberately on a throwaway scene; the whole server
   chain passes values through untouched, so this originates in the MCP
   client, not in Apelles — which is why there is no `B-NNN` for it.
7. **Some "default" primitive instances are DEMOS, not blanks.** A new `plot`
   ships `baseline`, `baselineLabel: "no documents at all"` and
   `annotate: [{i:2,"buried here"}]`; a new `claudechat` ships a whole
   France-visa conversation plus an `active` schedule. Null what you don't
   want or it silently draws on top of your content. **`text`, `matrix`,
   `graph` and `emphasis` are the opposite** — genuinely minimal defaults in
   this build, nothing to clean up (confirmed by dumping the saved manifest).
8. **`emphasis` layers DISAPPEAR after their `dur`.** `text` is revealed and
   then permanent; `emphasis` is not. Two marks only co-exist if their
   `at`/`dur` windows actually overlap.
9. **`matrix preset: "fill-in"` ignores `values`** (only `heatmap` reads them),
   and a matrix draws its full empty grid from scene frame 0, before its own
   `at`. `plot` does not do the equivalent — only its first marker appears early.
10. **`motion_add_scene` takes no id argument** and generates `scene-xxxxxx`.
   Set the real id afterwards with `motion_set_scene_field key="id"`; it works
   but returns a spurious "not one of the known scene fields" warning.


---

## Two more found while building Act 4

- **`matrix preset: "highlight"` ignores `values` entirely.** It reads a
  separate `highlight` array of `{r, c, at, dur}`. Given `values` and no
  `highlight`, every cell resolves to 0 and the grid renders **completely
  empty** — not dimmed, invisible. A spec calling for `highlight` + `values`
  wants `heatmap`, which is the preset that reads `values`.
- **`fillDir` names the axis that ADVANCES, and `total` is the count along
  it.** On a 1-row strip, `fillDir: "row"` gives `total = rows = 1`, so the
  whole strip fills in a single step instead of cell by cell. A 1xN strip
  filling left-to-right needs `fillDir: "col"`.

Both were caught by reading `Matrix.tsx` before building, not from the spec.

---

## One the fix itself changed (2026-10-07)

- **A `layers` callout that does not fit beside its stack is now drawn
  CENTRED UNDER the stack, with no arm** (B-240/D-370). It used to flip to the
  left of the stack and, on a narrow canvas, render at a negative x — entirely
  off-frame, silently. Budget, measured: the text's near edge sits
  `cardW/2 + 314` from the stack's centre, so a side placement needs
  `cardW/2 + 314 + 0.42 × 34 × len(callout)` to fit inside the canvas's 60-px
  margin. On a 1252-wide canvas a default `cardW: 620` leaves **nothing** —
  624 wanted against 566 available — so every callout on such a stack goes
  below. Narrow `cardW` if you want it beside the stack; otherwise the text
  wraps into the full content box under it, which is usually the better
  layout anyway.
