# Subtitles / captions (D-229, roadmap item 27)

The Edit tab's subtitle primitive: import a `.srt`/`.vtt` file, get a real
subtitle track, style it, see it in the preview, get it burnt into the export
— and write it back out as a sidecar file.

Reference: `scratch/resolve-reference/captioning.jpg` (Blackmagic's own Edit
page, scraped 2026-09-08). Read directly, not paraphrased, per CLAUDE.md's
"research the real pattern first" rule.

---

## 1. What the reference actually shows

Worth writing down, because two of these drove the data-model choice:

1. Captions live on their **own track type**, labelled "Subtitle 1", sitting
   above the video tracks. Cue blocks on the timeline are tinted and carry
   their own text.
2. **Two subtitle tracks render at the same time** — the frame has an English
   caption in white and a French one in yellow, at two different heights, both
   burnt into the same picture. Neither occludes the other, and neither
   occludes the video.
3. The Inspector is titled with the **track**, and splits into **Captions** and
   **Track Style**. Style is a property of the track; a per-caption **"Use
   Track Style"** checkbox is the escape hatch for one cue.
4. A **cue list** — `#`, Time In/Out, Caption, `CPS` — with the current cue
   highlighted.
5. The rendered caption sits low in frame, each line individually centred, on a
   **uniform-height** rounded-off rectangle that hugs the text horizontally
   with even padding. (Zoomed in on the frame to check this: the box is
   distinctly not tight to the ink — there is real padding above the caps and
   below the baseline, and the two captions' boxes are the same height
   relative to their text.)

Blackmagic's own copy for the section: *"support for importing timed text TTML,
SRT, XML and embedded MXF/IMF subtitles … Subtitles appear in the timeline
above of your video tracks and can be moved and trimmed like any other media.
You can switch between subtitle tracks for different languages and add multiple
captions per track. In the inspector, adjust track styles, change font, color,
size, position and more! Subtitles can be rendered into the final video or
exported as separate TTMLs, SRT or VTT files."*

---

## 2. The data model, and why it is the opposite call from D-211

D-211 made a title a **`Clip` variant** (`Clip::text`) rather than a track kind,
and argued the case well. D-229 makes a caption a **track kind**
(`TrackKind::Subtitle`) with a `Clip::caption` cue on it. Both are right, for
different reasons, and the difference is worth stating precisely:

| | Title (D-211) | Caption (D-229) |
|---|---|---|
| Where the reference puts it | on an ordinary video track | on its own track type |
| Compositing rule | ordinary video z-order — an opaque title occludes what is under it | always over the finished picture, whatever its index; never occludes |
| Several at once | by stacking video tracks | routinely, across subtitle tracks (the reference frame does it) |
| Style lives on | the clip | the **track**, with a per-cue override |
| Text | single line (enforced) | multi-line (required) |

The load-bearing row is **compositing rule**. Apelles' video-track index *is*
its z-order (`resolve_visible_video_layers_at`). If captions were clips on
video tracks, a subtitle track's position in the track list would mean
"compositing priority against the picture" — so inserting a caption lane
between two video tracks would change the picture, and an opaque caption clip
would occlude the video beneath it. Neither is true of a caption in any NLE.
A separate kind with a separate resolver
(`Timeline::resolve_visible_captions_at`) is what makes those facts true by
construction rather than by convention.

The second reason is **where the style lives**. A whole imported `.srt` is
styled once, not cue by cue; that wants a `Track` field, which is meaningless
on a video track.

Everything else is deliberately *not* new. A caption is an ordinary `Clip`, so
its timing is `start_frame`/`duration` and every existing edit op — move, trim,
split, remove, ripple, marquee, undo — works on it for free. That is what
Blackmagic's "can be moved and trimmed like any other media" actually requires,
and it cost nothing.

### What a caption deliberately does NOT have

No `scale`, `rotation`, crop, `opacity` or fades — all ignored by both
renderers. Its geometry is entirely its resolved `CaptionStyle`. Same line
D-211 drew, one step further: the export draws a caption with `drawtext`, which
cannot scale, rotate or crop a text box, and a preview offering controls the
export silently ignores is the B-053 class of defect this repo keeps closing.

**This is also why D-316's on-canvas corner handle writes `size` rather than a
new `scale`** — see §2b.

---

## 2b. On-canvas manipulation (D-316, fixing B-183)

A caption can be selected, moved and resized **on the picture**, not only in
the Inspector. Until D-316 it could not: `chroma_timeline_clip_geometry` errors
for a caption clip (empty `source_path`), so `TransformOverlay` silently drew
nothing — see B-183.

**The three pieces, and where each lives:**

| Question | Answer | Where |
|---|---|---|
| Where is the caption on screen? | its real rendered box, in composition fractions | `CaptionLayout::bounds` (pure) ← `caption_bounds_px` (measures) ← `chroma_measure_caption_bounds` (command) |
| What does dragging the body mean? | `position_x` / `position_y` | `CaptionTransformOverlay.tsx` → `set_caption_style` / `set_caption_cue_style` |
| What does dragging a corner mean? | `size` (font size), multiplied | same, via `captionSizeAfterDrag` |

**The measurement split is D-197's, again.** The box needs one advance width
per line plus the font's line-box height — glyph measurements, which this
crate's whole parity argument forbids it from making (§3: nothing that decides
where a line goes may depend on a measurement). So `CaptionLayout::bounds` is
*handed* them, by the rasteriser's own module, measured with the identical
`ab_glyph` walk that draws the glyphs. `caption_render.rs`'s
`the_measured_bounds_match_the_drawn_pixels` renders real captions and asserts
the computed box equals the drawn pixel extent exactly, so the two cannot drift.

**`chroma_measure_caption_bounds` takes the text and the STYLE, never a
`track`/`clip` pair** — a pure function, deliberately. Resolving the cue
server-side was the first design and was wrong: the Rust side's timeline is
only as current as the frontend's debounced save (~400 ms, B-088), so the box
got measured against the style as it was a moment ago and visibly lagged the
text it was supposed to be around. The frontend already has the resolved style;
it asks only for the glyph measurement it cannot make.

**A corner drag scales about the style's anchor**, because that is what the
model does: every distance in `CaptionLayout` is proportional to the resolved
font size and `(position_x, position_y)` is not, so the whole box — every line,
the leading, the background padding — is a uniform scale about that point. The
box therefore grows as one unit, which is the "propagate to the whole caption"
half of the ask.

**The write lands wherever the Inspector's own fields land** (the cue's
override if it has one, else the track), so dragging a caption on a track style
moves the whole track — the subtitle convention, and identical to typing in the
Inspector's Position X field. One source of truth, not two paths.

**The box exists only while its cue is ON SCREEN** — the playhead inside that
clip's own span, `clipCoversFrame` (**D-317, fixing B-185**). D-316 shipped the
opposite rule, on the reasoning that the box showed "where the caption will be
when its cue comes up". That was wrong in a way worth remembering, because the
symptom pointed somewhere else entirely: a cue is pinned at its style's anchor,
so an off-screen cue's box does not sit in empty space — it lands on top of
whichever cue *is* on screen. And since `position_y` anchors a cue's **last**
line (§2), a selected one-line cue's box falls exactly on a visible two-line
cue's bottom line, which reads as "the box only covers one line of a multi-line
caption" and sent the first investigation hunting for a text-wrapping
divergence that does not exist. The gate also restores the guarantee
`canvasPick.ts` states from the other side: `visibleCaptionsAt` already let a
click select only an on-screen cue, so a box outliving its cue's span was the
one way the draw half and the pick half could disagree.

**Deferred, all attested in D-316's reference sweep:** Shift-constrain-to-axis,
snapping to guides / title-safe / centre, arrow-key nudge,
double-click-to-edit-in-place, and side handles (they would mean non-uniform
scale or wrap width — a caption has neither field, so four corners only).

---

## 3. The hard part: multi-line, in two rasterisers

D-211 **forbade multi-line titles**, on the honest grounds that inter-line
layout is the one thing `ab_glyph` (the preview) and ffmpeg's
`drawtext`/libfreetype (the export) genuinely disagree about. A caption cannot
take that exit: real `.srt` files are full of two-line cues, and joining them
onto one line would mishandle the format.

So the divergence is **closed rather than avoided**, by making the line layout
ours instead of either engine's:

1. **One single-line draw per line.** The export emits one `drawtext` node per
   line; the preview lays out one glyph run per line. Neither engine is ever
   asked to lay out a second line, so neither engine's multi-line rules are
   ever consulted — the case where they provably agree is the only case that
   runs.
2. **The vertical step is plain arithmetic with no font metric in it** —
   `CaptionLayout::line_step` = `round(size × (1 + line_spacing) × comp_h)`.
   Both engines are handed the same integers.
3. **Each line is anchored by the top of its font line box**, which is
   `drawtext`'s `y_align=font` mode.

### The measurement behind step 3

`y_align=font` is what makes a per-line `y` mean the same thing regardless of
which glyphs a line happens to contain. Measured against ffmpeg 7.1, Arial Bold
at `fontsize=60`, all three drawn at `y=150`:

| text | `y_align=baseline` box | `y_align=text` box | `y_align=font` box |
|---|---|---|---|
| `Ag` | ink-dependent | top pinned to `y` | **150 → 218** |
| `xx` | ink-dependent | top pinned to `y` | **150 → 218** |
| `Wy` | ink-dependent | top pinned to `y` | **150 → 218** |

Content-independent, and the box top is exactly `y`. `boxborderw=N` expands it
by exactly `N` on every side (verified at N=10 and N=12). That is precisely the
uniform-height, horizontally-hugging band the reference frame shows — so the
background box is `drawtext`'s own, not a separate `drawbox`.

`drawtext`'s box under the other two modes is the string's *ink* box, which
jitters vertically per line with descenders and capitals. That is why neither
of them is used, and `boxh` does not rescue them: it fixes the height but the
box stays anchored to the content-dependent ink top (measured).

### And why the preview can reproduce it exactly

`drawtext` renders at **em = `fontsize` pixels** and derives its `y_align=font`
line box from the face's own `hhea` table. Verified against the font files
directly, across four faces and three sizes:

```
line box height = (ascender − descender + lineGap) / unitsPerEm × fontsize
baseline offset =  ascender                        / unitsPerEm × fontsize
```

| face | px | predicted | measured |
|---|---|---|---|
| Arial Bold | 60 | 68.99 | 69 |
| Arial Bold | 100 | 114.99 | 115 |
| Arial | 60 | 68.99 | 69 |
| Impact | 60 | 73.18 | 73 |
| Times New Roman | 80 | 91.99 | 92 |

`ab_glyph`, scaled through `chroma::text::freetype_equivalent_scale` (D-212),
reports exactly those two numbers as `ScaleFont::ascent()` and
`ScaleFont::height() + ScaleFont::line_gap()` — because that function's whole
job is to cancel `ab_glyph`'s ascent-descent-based `PxScale` back to an
em-based one. So the preview computes the identical box **from the same font
tables**, not from a fudge factor.

> **Footnote on D-212's prose.** D-212's *code* is correct and this feature
> depends on it. Its *explanation* has the two libraries the wrong way round:
> it says FreeType sizes by `ascender − descender` while `ab_glyph` sizes by
> the em. It is the reverse — `ab_glyph`'s `PxScale` is the ascent-descent
> height, FreeType's `fontsize` is the em — which is why the correction factor
> `px × height_unscaled / upem` is right either way. Measured here directly:
> ffmpeg's advance width for "Hxg" matched the `hmtx` sum at em = fontsize to
> under a pixel in all five cases, and was 11–22% off the other hypothesis.
> Not a bug, and nothing to change; recorded so the next person measuring this
> does not conclude the code is wrong.

---

## 4. The layout spec (what both engines implement)

Given a composition `W × H`, a cue of `n` lines and a resolved `CaptionStyle`:

```
font_px    = max(1, round(size × H))
line_step  = max(1, round(size × (1 + line_spacing) × H))
box_padding= max(0, round(box_padding × font_px))
x_anchor   = round(position_x × W)
last_top   = round(position_y × H)
line_top_i = last_top − (n−1) × line_step + i × line_step
```

`position_y` fixes the **last** line; earlier lines stack upward, so a cue
growing from one line to two keeps its bottom line put — the subtitle
convention. Alignment is applied per line to that line's measured advance
width (`left` → `x_anchor`, `center` → `x_anchor − w/2`, `right` →
`x_anchor − w`), each engine measuring with its own rasteriser over the same
font file.

Two hand-written implementations, in two languages that share no code:
`CaptionLayout::resolve` (Rust) and `captionLayout` (TypeScript). They are
pinned to **one fixture asserted on both sides** —
`caption.rs::layout_numbers_are_the_documented_arithmetic` and
`caption.test.ts::"captionLayout matches the Rust fixture exactly"`. If either
side's rounding drifts, exactly one of those goes red.

---

## 5. Formats

**Shipped: SubRip (`.srt`) and WebVTT (`.vtt`)**, as one parser — they are the
same grammar, differing only in the decimal separator, an optional header,
trailing cue settings and WebVTT's `NOTE`/`STYLE`/`REGION` blocks. Accepting
both is a handful of lines and covers files that mix the conventions, which
real files do constantly.

The parser is lenient about everything that does not change meaning (BOM, CRLF,
missing final newline, absent/out-of-order cue numbers, either decimal
separator, a missing hours field, minutes past 60, multiple blank lines) and
strict about everything that does (an unreadable timing line is refused, with
its line number, rather than guessed at).

**Deferred: TTML** — and this is a deliberate refusal, not an oversight.
A TTML document's cue times are only meaningful once `ttp:timeBase`,
`ttp:frameRate` and `ttp:frameRateMultiplier` are resolved (an offset time of
`120f` means different wall-clock instants under different declared rates, and
an `smpte` timebase changes it again), and its text is only correct once
`region`/`style` inheritance is walked. A subset parser reading `begin`/`end`
and ignoring those would import real broadcast files with **silently wrong
timings** — worse than not supporting the format, because the failure is
invisible. Tracked on the roadmap as its own line.

Also not supported: embedded MXF/IMF subtitle tracks (a demux concern, not a
parse one), and `.xml` (which in Resolve's list means TTML by another name).

**Inline formatting** (`<i>`, `<b>`, `<u>`, `<font …>`, WebVTT's `<c>`/`<v>`)
is **stripped, not rendered**, and XML entities are decoded. The text reaches
the screen correct; the emphasis is dropped. **D-240** removed the original
cause (the shared font catalogue now has real italic/bold faces,
`caption_render.rs` already resolves through `chroma::text`'s catalogue
unchanged) but per-RUN emphasis inside one cue's text is still not attempted —
`CaptionStyle.font` is one style for the whole cue, and `<i>`/`<b>` ask for a
DIFFERENT face mid-line, which is a real (if now unblocked) parsing job, not
just a missing font file. Tracked below.

---

## 6. Where the code is

| Layer | File | What |
|---|---|---|
| L2 model | `crates/apelles-timeline/src/caption.rs` | `CaptionCue`, `CaptionStyle`, `CaptionLayout` — the layout spec |
| L2 model | `crates/apelles-timeline/src/subtitle_import.rs` | the `.srt`/`.vtt` parser and writer; `cues_to_clips` |
| L2 model | `crates/apelles-timeline/src/lib.rs` | `TrackKind::Subtitle`, `Track::caption_style`, `Clip::caption`, `resolve_visible_captions_at` |
| media | `app/src-tauri/src/chroma/caption_render.rs` | the `ab_glyph` rasteriser |
| media | `app/src-tauri/src/chroma/edit.rs` | `draw_captions_onto` — the last compositing pass |
| shell | `app/src-tauri/src/chroma/subtitles.rs` | `chroma_import_subtitles` / `chroma_export_subtitles` |
| L2 model | `crates/apelles-timeline/src/caption.rs` | `CaptionLayout::bounds` / `CaptionBounds` — D-316's rendered-box arithmetic |
| media | `app/src-tauri/src/chroma/caption_render.rs` | `caption_bounds_px` — the glyph measurements that box is fed |
| media | `app/src-tauri/src/chroma/caption_render.rs` | `chroma_measure_caption_bounds` — that box, in composition fractions |
| editor | `packages/editor/src/CaptionTransformOverlay.tsx` | the on-canvas box + move/resize gestures (D-316) |
| editor | `packages/editor/src/useCaptionGeometry.ts` | the measured-box fetch (one cue, or every visible one) |
| editor | `packages/editor/src/canvasPick.ts` | `visibleCaptionsAt` / `pickTopmostCaption` — canvas click-to-select |
| editor | `packages/editor/src/caption.ts` | the TS mirror of the model + layout |
| editor | `packages/editor/src/timelineExport.ts` | `buildCaptionDrawtextSteps`, `captionsForExport` |
| editor | `packages/editor/src/timeline.ts` | the four caption edit ops |
| editor | `packages/editor/src/CaptionInspectorPanel.tsx` | the Inspector sections + cue list |
| editor | `packages/editor/src/useEditorControl.ts` | the five control ops the MCP tools drive |
| MCP | `mcp/server.py` | `editor_import_subtitles`, `editor_export_subtitles`, `editor_add_caption`, `editor_set_caption`, `editor_set_caption_style` |

---

## 7. Deferred

Tracked here so the next pass has the list, not hidden:

- **TTML import/export** — see §5. The reason is written down; do it properly
  or not at all.
- **Embedded MXF/IMF subtitle extraction.**
- ~~**Italic/bold rendering**~~ — **done, D-240.** A whole cue/style can be
  bold/italic (Bold/Italic toggle buttons in the Caption Inspector's Track
  Style section, `bold`/`italic` on `editor_set_caption_style`/
  `editor_import_subtitles`). What is still NOT attempted: per-run emphasis
  inside one cue's text from `<i>`/`<b>` markup (see §5 above) — a real,
  separate parsing job now that the font side is unblocked.
- **Auto-captioning from the transcript.** `editor_get_transcript` (D-189)
  already produces timed words; turning those into cues is a small, obvious
  follow-up and the single highest-value one on this list.
- **Keyframeable caption style.** Deliberately out: a caption's style is
  per-track, and per-track animation has no precedent in this model yet.
- **A caption's own in/out fields in the Inspector.** The reference has them;
  here a caption is trimmed on the timeline like any other clip, which already
  works. Worth adding as numeric fields later.
- **Cue-list "Add New / Prev / Next" buttons** from the reference's own
  Captions tab — the list itself ships (click a row to select it), the
  navigation buttons do not.
