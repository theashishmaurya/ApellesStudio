# Text / title clips in the Edit tab (D-211 · D-212 · D-213)

Roadmap item 24. Built 2026-09-08. Reference: DaVinci Resolve's own Edit page,
section **"Incredible 2D and 3D Titles"** (`scratch/resolve-reference/titles.jpg`
+ `resolve-edit-features.json`), scraped 2026-09-08 per CLAUDE.md's
"research the real pattern first" rule.

---

## The gap this closes

Before this pass there was **no text concept anywhere in the codebase** —
`grep` for `TrackKind::Text`, for a title clip, for a text field on `Clip`:
nothing. A video track held only decoded video, an audio track only decoded or
synthesised audio. The 2026-09-07 comparison reel got its "BEFORE"/"AFTER"
labels from an **external `ffmpeg drawtext` finishing pass** laid on top of a
correct Apelles export — disclosed at the time as not a Apelles feature, and
something no GUI user (and no MCP agent, short of dropping to raw ffmpeg)
could do at all.

## What Resolve actually does, and what we took from it

> "To create 2D or 3D titles, open the effects library …, find the text
> generator or Fusion title template you want, and **drag it into the timeline
> above your video tracks**. Then use the inspector to type your text and
> adjust parameters such as font, size, color and more. **The basic title
> generators let you build simple titles and lower thirds from scratch.** …
> There are also more than 100 Fusion title tools …"
> — Blackmagic Design, Resolve Edit page, "Incredible 2D and 3D Titles"

Three things carried straight over:

1. **A title is a clip on an ordinary video track, above the picture.** Not a
   track type of its own. (Resolve *does* have a dedicated Subtitle track
   type — but that is its own separate feature, section 23 of the same page,
   for imported SRT/TTML caption tracks, and is explicitly a different thing
   from a title.)
2. **The Inspector is where its text/font/size/colour live**, alongside the
   ordinary clip properties, not in a modal or an on-canvas editor.
3. **The basic title generator and the animated template library are two
   different features.** Phase 1 here is the first one, deliberately and
   entirely. See "Deferred" below.

---

## The model — D-211: a `Clip` variant, not a `TrackKind`

`apelles_timeline::Clip` gains one field:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub text: Option<TextLayer>,   // Some ⇒ this clip draws generated text
```

```rust
pub struct TextLayer {
    pub content: String,   // single line (Phase 1)
    pub font: String,      // a catalogue KEY, e.g. "sans-bold"
    pub size: f64,         // fraction of the COMPOSITION height
    pub color: String,     // "#RRGGBB"
}
```

**Why a `Clip` variant rather than `TrackKind::Text`.** The one real constraint
a title imposes is z-order — it has to composite *over* the video beneath it.
That is already solved: track index order **is** compositing z-order in this
model (D-086: "lower index = higher priority", `resolve_visible_video_layers_at`
returns layers in that order and the compositor paints them in reverse). A
title on track 0 is drawn last, over everything. Nothing to add.

A new track kind, by contrast, would have needed its own resolver, its own
compositing-order rule against the video tracks, its own branch in every
`kind == Video` / `kind == Audio` walk (there are ~15 across
`apelles-timeline`, `chroma::edit`, `chroma::audio`, `timeline.ts` and
`timelineExport.ts`), and its own pass in the export compiler — all
re-deriving what track index order already gives. It would also have made "a
title on the same track as the shot it labels" *unrepresentable*, which every
reference NLE allows.

The variant shape pays off immediately and concretely:

| Capability | Code written for text clips |
|---|---|
| Placement (append / at a frame / ripple / auto-create a track) | none — the existing `add_clip` op |
| Trim / split / move / remove / gap-close | none — every existing op |
| Timeline duration, gap detection, layer resolution | none |
| Undo/redo, history labels | one `labelForOp` case |
| Z-order over the video | none |
| Position + opacity keyframes | none — `chroma_keyframes` as-is |
| Fade in/out | none — `Clip::fade_*` as-is |

`Clip::is_text()` is the one predicate everything branches on.

### Field conventions, and why

- **`size` is a fraction of composition height, not pixels.** The same B-043
  reasoning that made `position_x` normalised: the live compositor rasterises
  at whatever `max_long_edge` the preview asked for (960 scrubbing, 640
  playing) while the export renders at full resolution. A pixel size would
  cover a different fraction of the picture in each. A fraction is invariant
  by construction, and `chroma::text`'s own test asserts that a layer rendered
  at 640×360 and at 1280×720 differs by exactly 2× in every dimension.
- **`font` is a catalogue key, not a path or a system family name.** See D-212.
- **No `opacity` on `TextLayer`.** That is `Clip::opacity`, already
  keyframeable and already multiplied by the clip's fade. A second alpha would
  be two sources of truth for one number.
- **`source_path` stays empty and `source_fps` unset** on a text clip.
  `source_frames_to_timeline`'s documented fallback for an absent `source_fps`
  is a 1:1 ratio, which is exactly right for a generated layer: its `duration`
  really is its timeline footprint.

---

## What applies to a text clip (the Phase 1 boundary)

| `Clip` field | Applies to a title? |
|---|---|
| `opacity` (+ `fade_in/out_frames`, `fade_*_curve`) | **yes**, keyframeable |
| `position_x`, `position_y` | **yes**, keyframeable |
| `scale`, `rotation`, `box_width`, `box_height`, `crop_*` | **no** — in *neither* engine |
| `start_frame`, `duration`, trim/split/move | yes, like any clip |

**Why the second group is off, and why that is a correctness decision rather
than a shortcut.** The export path compiles a text clip to ffmpeg's own
`drawtext` filter (D-213), which can place a text box and fade it and nothing
else — it has no scale, no rotation, no crop. Had the live preview honoured
those fields anyway (it trivially could: the rasterised layer goes through the
same `composite_layer_onto` a video layer does), the preview would be showing
a picture the export cannot produce. That is precisely the class of defect
this session kept closing:

- **B-053 / D-132** — a lone clip's transform silently discarded by the
  preview's fast path.
- **B-090** — a keyframed `scale` silently dropped by the export compiler.
- **B-094 / D-208** — per-property keyframes resolved differently by the two
  engines.

So `chroma::edit::resolve_text_clip_transform` pins them, and there are three
lines of defence in total: the compositor pins them, the MCP
`editor_set_clip_transform` op **refuses** a non-default value for one of them
on a text clip with a real error message, and the Inspector's Title section
says so in plain words.

**Known gap:** `ClipInspectorPanel.tsx` still *renders* those rows for a text
clip. That file was being edited by two other concurrent efforts during this
pass and was off-limits; gating each row on `clip.text == null` is a
one-line-per-row follow-up. Tracked in roadmap item 24.

---

## The live preview — D-212: `ab_glyph`, and one shared font file

`app/src-tauri/src/chroma/text.rs`:

- **`TEXT_FONTS`** — a fixed catalogue, each entry a stable `key`, a `label`,
  and an ordered list of candidate absolute paths (first existing wins).
  **Single-face `.ttf` files only, never a `.ttc` collection** — and that is
  load-bearing: `drawtext` takes a `fontfile=` with no face index and uses
  face 0, so a single-face file is the only shape where "both renderers read
  the same file" also means "both read the same *face*". That is why the
  obvious macOS picks (Helvetica, Avenir, SF) are absent — they ship only as
  `.ttc`. **D-240** grew the catalogue from 8 to 18 entries — every family
  with a real italic/bold-italic sibling on disk (`sans`/`condensed`/
  `serif`/`mono`) now lists all four, each also carrying `group`/`bold`/
  `italic` metadata that `@apelles/editor`'s `composeFontStyleKey` uses to turn
  a Bold/Italic TOGGLE into the right flat key — `impact`/`sans-black` stay
  standalone (no italic face ships for either on macOS, and both are already
  a design's own maximum weight).
- **`chroma_text_fonts`** (Tauri command) — the catalogue resolved against
  this machine. **One source of truth for both renderers**: the Inspector's
  picker lists it, and `editorExport.ts` passes the same resolved paths into
  `drawtext`'s `fontfile=`.
- **`render_text_layer`** — rasterises one `TextLayer` into a canvas-sized
  RGBA buffer: text centred, transparent elsewhere. Handed to
  `composite_layer_onto` exactly like a decoded frame, so position, opacity,
  fade and paint order are all the *existing* code.

**Why `ab_glyph` (the crate decision).** It is already in this workspace's
dependency tree at exactly the version declared — `imageproc`, which
`chroma::edit` already uses for `rotate_about_center`, depends on it. So this
adds a direct dependency on a crate already being compiled, not a new one. It
is small, pure Rust, no C/FreeType FFI, and does the one thing needed: outline
a glyph at a pixel size, hand back per-pixel coverage. Apache-2.0/MIT.
Considered and rejected: `cosmic-text` (a full shaping/layout engine — right
answer for multi-line, bidi and complex scripts, far too much for a
single-line title, and a large new tree), `fontdue` (comparable, but not
already present), `rusttype` (deprecated in favour of `ab_glyph` by its own
author), `font-kit` (a *discovery* library — would add a dependency and a
system scan to produce a path the catalogue already states).

**Why not `imageproc::drawing::draw_text_mut`**, the obvious shortcut: it
blends the glyph colour toward the *existing* pixel, which on the transparent
canvas this needs produces premultiplied RGB against a straight-alpha channel
— a dark halo on every antialiased edge once `image::imageops::overlay`
blends it. Writing coverage into alpha and the fill colour into RGB is four
lines and is correct; there is a unit test asserting an antialiased edge pixel
still carries the exact fill colour.

**Caching, because this is a per-frame path.** Two module-level caches: parsed
faces keyed by file (bounded by the catalogue's own size, so no eviction), and
the last four *rasterised layers* keyed by everything the output depends on
(content, font, px size, colour, canvas size). A title redrawn on every frame
of playback rasterises once.

---

## The export — D-213: `drawtext`, spliced into the overlay chain

`packages/editor/src/timelineExport.ts`:

- A text clip **opens no ffmpeg input** — no `-ss`/`-t`/`-i`, no input index,
  no per-clip filter chain. It still takes a real slot in the paint order and
  in `totalDurationSec`, because it is a real visible layer occupying real
  timeline space.
- Its `drawtext` node is spliced into the overlay chain **at exactly the
  position that clip's `overlay` would have occupied**, reading the stream
  built so far. That is what preserves z-order with no separate rule: a title
  on track 0 is still emitted last, over everything below it.

Every geometry rule mirrors the Rust side exactly:

| | live preview (`chroma::text` + `composite_layer_onto`) | export (`drawtext`) |
|---|---|---|
| size | `round(size × canvas_h)` px | `fontsize=round(size × opts.height)` |
| horizontal | ink box centred, then `+ position_x × canvas_w` | `x='(w-text_w)/2+w*(…)'` |
| vertical | ink box centred, then `+ position_y × canvas_h` | `y='(h-text_h)/2+h*(…)'` |
| alpha | `opacity × fade_multiplier` | `alpha='(opacity)*(fade)'` |
| window | `Track::clip_at` | `enable='between(t,start,end)'` |
| font | the catalogue's resolved file, via `ab_glyph` | the **same** file, via `fontfile=` |

**The ink box, not font metrics.** ffmpeg's `text_w`/`text_h` are measurements
of the *rendered glyphs*, so the Rust rasteriser centres on the union of the
glyphs' own `px_bounds()` rather than on the face's ascent/descent. Centring
on font metrics would put an all-caps title (no descenders, cap height well
under the ascent) visibly higher in the preview than in the export.

**"Size" means two different things to the two libraries — measured, not
assumed.** `ab_glyph`'s `PxScale` is the **em** size (`units_per_em` → that
many pixels); FreeType, which `drawtext` hands `fontsize` to, sizes by the
face's **vertical extent** (`ascender - descender`) instead. For Arial Bold
that is 2288 units against a 2048-unit em. Rendering the same title both ways
at 640×360 found exactly that: 129 px of ink wide from `ab_glyph` against
144 px from `drawtext`, a ratio of 1.116 versus the predicted 2288/2048 =
1.117. `chroma::text::freetype_equivalent_scale` applies the conversion, and
the export's convention wins deliberately — ffmpeg's `fontsize` is what ships
in the rendered file, so the preview is what gets taught to agree. This was
found by measuring pixels, not by reading either library's docs; without it
every title was ~11 % smaller on screen than in the exported file.

**Keyframe/fade time base.** A media clip's filter chain has its own `t == 0`
at the clip's in-point (its `-ss`). A text clip's `drawtext` runs on the
*composited base stream*, where `t` is timeline time — so its keyframe and
fade expressions are written in terms of `(t-startSec)`. `keyframeExprAt`
gained an optional `timeVar` parameter for exactly this, defaulting to `'t'`
so every existing caller's argv is byte-identical.

**Escaping.** `escapeFiltergraphValue` handles a literal `'` the only way
ffmpeg allows (close the quote, `\'`, reopen — nothing can be escaped *inside*
a single-quoted section), and the node sets **`expansion=none`**, which makes
`%` and `{}` literal rather than text-expansion directives. Turning expansion
off outright beats escaping around it: none of this feature's text is ever
meant to be a directive.

**An unresolvable font is refused, not guessed.** `textClipsMissingFonts`
runs in `compileEditorExportArgs` before compiling; a `drawtext` with a bad
`fontfile=` takes the *whole* export down with an opaque libfreetype message,
and substituting a different face would ship a file that disagrees with the
preview.

### Preview/export parity: what is and is not claimed

Two different rasterisers (`ab_glyph` vs. libfreetype) reading the same font
file at the same effective pixel size, centring the same measured ink box.
They are **not pixel-identical** — antialiasing differs at the sub-pixel
level. What *is* asserted, by tests on both sides against the same
specification rather than against each other: the ink is present, at the
expected size, centred (± a small tolerance) and offset by `position_*` as
specified; nothing is drawn outside the clip's own time window; the same
layer at two canvas resolutions scales exactly.

Measured directly, the same "AFTER" title at `size = 0.12`, threshold "any
ink", after the FreeType-scale conversion above:

| canvas | engine | ink box | w×h | centre |
|---|---|---|---|---|
| 640×360 | preview (`ab_glyph`) | `[248,164 .. 392,195]` | 144×31 | (320.0, 179.5) |
| 640×360 | export (`drawtext`) | `[248,164 .. 392,196]` | 144×32 | (320.0, 180.0) |
| 320×180 | preview, through the real `chroma_timeline_frame` + JPEG | `[123,82 .. 196,98]` | 73×16 | (159.5, 90.0) |
| 320×180 | export (`drawtext`) | `[123,82 .. 196,98]` | 73×16 | (159.5, 90.0) |

Identical left/right/top bounds; a single row of difference at the bottom
edge, which is one antialiased row landing either side of the threshold.
Before the FreeType-scale conversion the same comparison read 129×28 against
144×32.

### The escaping, and how it is proved

`quoteFiltergraphValue` is verified by rendering thirteen awkward strings —
apostrophes, colons, commas, semicolons, brackets, `%`, `{}`, backslashes,
non-ASCII — **both** through the escaper and through `drawtext`'s own
escaping-free `textfile=`, and asserting the two output frames are
byte-identical. That test caught the first implementation, which used the
shell-style `'\''` idiom: it produced no ffmpeg error and no text at all,
because a bare `'` reaching the second-level option parser opens a quote
there and swallows `fontsize`, `fontcolor`, `x`, `y` and the rest into the
text value. "ffmpeg exited 0" would have passed.

---

## The two interfaces (CLAUDE.md: human **and** AI, same pass)

| | GUI | MCP |
|---|---|---|
| create | **Title** button in the timeline toolbar → playhead, topmost video track, selected | `editor_add_text_clip` |
| edit text/font/size/colour | Inspector **Title** section (`TextClipInspectorPanel.tsx`) | `editor_set_text_clip` |
| position / opacity / keyframes / fade | the existing Inspector rows (D-208) | `editor_set_clip_transform`, `editor_set_clip_keyframes`, `editor_set_clip_fade` |
| trim / split / move / delete | the existing timeline gestures | the existing `editor_*` ops |
| which fonts exist | the Inspector's picker | `editor_text_fonts` |

Both go through the **same** `newTextLayer` validator and the **same**
`add_clip` / `set_text_clip` ops. `TextClipInspectorPanel` is a separate
component stacked *above* `EditorInspectorPanel` rather than a branch inside
`ClipInspectorPanel`: a title's properties are a different form with a
different write op, and stacking is what keeps the shared half genuinely
shared (a title's Opacity/Position rows are the existing D-208 rows, not a
second copy).

---

## Deferred — Phase 2 and beyond

Everything below is a real, named gap, not an oversight. None of it is
started.

**Text features**
- **Multi-line text.** Rejected at the write path today. The blocker is
  parity, not effort: inter-line layout (line height, per-line alignment) is
  the one thing `ab_glyph` and `drawtext` genuinely disagree about, and
  guessing at it would reintroduce exactly the preview/export divergence this
  design exists to avoid. Doing it properly means either implementing
  `drawtext`'s own line metrics exactly, or moving the export to the
  rasterised-overlay route below.
- **Alignment (left/centre/right)** — meaningless without either multiple
  lines or a real text box to align within, so it follows multi-line.
- **A background box / outline / stroke / drop shadow.** `drawtext` has `box`,
  `borderw` and `shadowx`/`shadowy`, so the export half is nearly free; the
  Rust rasteriser would need real work (an outline pass, a shadow blur) to
  match, which is why it is not in Phase 1.
- **Keyframeable `size` and `color`.** `size` is straightforward on both sides
  (`drawtext`'s `fontsize` accepts an expression; the Rust cache key would
  need the resolved per-frame px). `color` needs a per-channel interpolation
  convention on both sides. Neither is in the roadmap's stated minimum
  ("keyframeable position at least").
- **Text shaping** — no bidi, no complex scripts, no ligature substitution.
  Latin advance-and-kern only, on both sides. Real support means
  `cosmic-text`/HarfBuzz on the Rust side and `text_shaping=1` on `drawtext`,
  and the two would need checking against each other.
- **Lower-third and animated title presets** — Resolve's "100+ Fusion title
  tools". This is the Motion tab's territory (Remotion), not a `drawtext`
  extension; a preset that produced a real `TextLayer` + a keyframe track
  would be the cheap version.
- **A bundled font.** The catalogue resolves against system fonts, so a
  project moved between machines can lose a family (the export then refuses,
  loudly, rather than substituting). Shipping one open-licensed face would
  make the render fully machine-independent.

**Transform**
- **`scale` / `rotation` / `crop` on a title.** The route is to stop compiling
  text to `drawtext` and instead compile it to a **rasterised PNG overlay
  input** — the same layer the preview already produces, written to a temp
  file and fed through the identical `overlay` chain a video clip uses, which
  then gets every transform for free and makes the two engines share the
  *rasteriser* as well as the font. That needs the export compiler to stop
  being pure (it would need to write a file), which is a real design decision
  of its own, hence Phase 2.
- ~~**On-canvas drag of a title**~~ — **done** (D-211 follow-up; the box and its
  MOVE drag, never the corner handles, since a title's `scale` is pinned
  server-side). The claim this entry made on the way — that
  `chroma_timeline_clip_geometry` "already answers correctly for a text clip
  (natural footprint = the whole composition)" — **was wrong, and shipped as
  B-130.** That is what the *buffer* is: `render_text_layer` allocates a
  composition-sized RGBA canvas and draws a small centred ink box into it. As a
  *footprint* it gave every title a full-frame selection box, and made a selected
  title swallow every canvas click meant for the footage beneath it. Fixed in
  **D-262**: `clip_geometry` reports the measured ink box
  (`chroma::text::text_layer_ink_fraction`, the same glyph walk `rasterise`
  draws with). An adjustment clip really is full-frame and still reports `1 x 1`.
- **Hiding the unsupported Transform rows** for a text clip in
  `ClipInspectorPanel.tsx` — same reason it is not done, same "close to free".

**Interchange**
- `timelineInterchange.ts`'s FCPXML exporter does not know about text clips;
  a title currently maps to nothing there. FCPXML has a real `<title>`
  element, so this is a genuine mapping job rather than a blocker.
