# Caption presets and per-word animation (D-243/D-244, roadmap item 28)

The Edit tab's Captions panel: a library of styled caption looks you can drop
onto the timeline, a full property editor for a placed caption, and the per-word
animation model underneath both — rendered identically in the live preview and
in the export.

Builds directly on **D-229** (`docs/notes/subtitles.md`), which gave a caption
its own track kind, a static `CaptionStyle` and the shared line layout that
makes a multi-line cue render the same in both engines. Read that first; this
note only covers what D-243 adds.

Reference: HyperFrames' caption catalogue, kept in
`scratch/heygen-caption-reference/` (Apache-2.0 — see D-244 for provenance and
what was and was not taken).

---

## 1. What the reference actually shows

The catalogue is 19 named caption looks, grouped by tone. Read off their real
sources rather than screenshots, so the numbers below are theirs:

- **Highlight** — the visible line stays up in heavy uppercase, and the word
  being spoken gets a filled rounded box swept in behind it (Montserrat 800 at
  80px on a 1080-tall frame, group sitting 140px off the bottom, a red gradient
  box with 12px/6px padding and a 10px radius, sweeping in over 0.15s).
- **Pill Karaoke** — follow-along lyrics; spoken words dim, the live word wears
  a bright pill.
- **Kinetic Slam** — one full-screen word per beat, alternating slam direction
  (Anton, `back.out` eases, ~0.22s per word).
- **Clip Wipe** — a clean corporate build, each word revealed by a `clipPath`
  wipe (Poppins 800 at 88px, 120px off the bottom).
- **Neon Accent / Neon Glow**, **Glitch RGB**, **Matrix Decode**, **Gradient
  Fill**, **Texture**, **Parallax Layers**, **Camera Follow**, **Particle
  Burst**, **Emoji Pop**, **Editorial Emphasis**, **Weight Shift**, **Blend
  Difference**, **Texture Mask Text**, **Morph Text**.

Two structural facts drove the design more than any single look:

1. **Every one of them is per-WORD.** The unit of animation is the word, timed
   against speech — not the cue. D-229's model has no word in it at all.
2. **Every one of them is a browser composition** — HTML + CSS + GSAP, fetching
   GSAP from a CDN and fonts from Google Fonts at render time. That is what
   makes them un-embeddable here (D-243 Decision 1) and why the looks had to be
   re-expressed rather than run.

---

## 2. The model

`CaptionStyle` gains one optional field:

```rust
pub animation: Option<CaptionAnimation>,   // absent = D-229's static caption
```

`apelles_timeline::caption_anim` carries the rest, mirrored exactly by
`@apelles/editor`'s `captionAnim.ts` (the same two-file mirror `caption.rs` /
`caption.ts` already is, and for the same reason — see either header).

**A preset is nothing but a `CaptionStyle` carrying one of these.** There is no
preset object, nothing stores a preset id, and picking one in the panel writes
its style through the existing `set_caption_style` op. That is what makes every
value a preset sets editable immediately afterwards, which was the owner's
explicit requirement ("keep the style configurable as much as possible").

### The five kinds

| kind | what it does | adapted from |
|---|---|---|
| `none` | D-229's static caption, drawn one `drawtext` per LINE | — |
| `highlight` | line stays up; the live word gets a filled box | `caption-highlight` |
| `karaoke` | line stays up; words recolour as they are spoken | `caption-pill-karaoke` |
| `slam` | one word at a time, sliding in from alternating sides | `caption-kinetic-slam` |
| `build` | the line assembles word by word | `caption-clip-wipe` |

`none` takes D-229's original code path unchanged, which is what keeps every
existing project rendering byte-identically.

### Word timings are derived

A `.srt` cue carries only its own in/out, so each word takes a share of the
cue's duration **proportional to its character count**, computed over the whole
cue rather than per line (so a two-line cue reads at one rate). Cumulative
integer character counts are converted to seconds only at the end, so the
windows tile the cue exactly and the last word's end is exactly the duration.

Not yet wired to the transcript's real word timings — a named follow-up, and
the obvious partner to **D-238's auto-captioning**, which already turns those
same timed words into cues. This would take the same data one level finer. The
model already fits it: `CaptionWord.start`/`end` are just numbers, so a better
source substitutes without changing either renderer.

---

## 3. The parity constraint, which decided the whole vocabulary

A caption is drawn twice — `ab_glyph` in the Rust preview, ffmpeg `drawtext` in
the export — and this repo's recurring defect class is a preview offering
something the export cannot reproduce (B-053, B-088, B-090, B-094). So the
animation vocabulary is exactly what ffmpeg can evaluate **per frame, per node,
without changing its own text layout**.

Verified against this machine's ffmpeg (`ffmpeg -h filter=drawtext`):
`x`, `y` and `alpha` are `<string>` expression options; `fontcolor` is not, and
`drawbox`'s `color` is not.

| property | preview | export |
|---|---|---|
| alpha | glyph coverage multiply | `alpha=` expression |
| dx / dy | pen offset | `x=` / `y=` expressions |
| fill colour | chosen per word | one `drawtext` node per phase, `enable`d over its window |
| highlight box | filled rect | `drawbox`, binary |

**Three things are deliberately absent**, each because ffmpeg cannot do it:

- **Per-word scale.** `fontsize` is the input to the very measurement that makes
  the two engines agree (D-212), so animating it re-opens the divergence D-229
  closed. This is why `slam` slides rather than popping, and why Editorial's
  size contrast is not reproduced.
- **A rounded highlight box.** `drawbox` has no corner radius.
- **A sweeping / fading highlight box.** `drawbox`'s colour is not a per-frame
  expression, so the box is binary — on for the active word's window.

The same scope line D-211 drew for titles and D-229 drew for captions, applied
a third time.

### Node-count control

A word that changes colour would naively be three `drawtext` nodes (upcoming /
active / spoken). Adjacent phases resolving to the same colour are **collapsed**,
so a preset that recolours nothing emits one node per word rather than three.
Still roughly one node per word overall: fine for normal cues, and a real
(unhit, unoptimised) concern for a 400-cue `.srt` set to animate.

---

## 4. Per-word layout is ours, and what that cost

D-229's principle — "the line layout is OURS, so neither engine's own layout is
ever consulted" — applies one level down. An animated caption positions each
**word** itself.

That needs each word's advance width, which is a glyph measurement only the Rust
side can make. So:

- `chroma::text::chroma_measure_caption_words` measures a batch with the same
  advance-and-kern walk the preview rasterises with.
- `captionMetrics.ts` caches those for the **synchronous** export compiler —
  the same "the compiler stays pure, the caller supplies what only it can know"
  split `fontFiles` already uses (D-197). Warmed in `runEditorExport`, right
  where `loadTextFonts()` already is.
- The cache is keyed by `(font, fontPx, word)` and is **additive, never
  invalidated**: an entry measures an immutable triple, so it cannot go stale;
  re-warming after an edit measures only genuinely new words.
- A word with no measurement **refuses the export**
  (`captionClipsMissingMetrics`) rather than compiling a line stacked at x=0.

`slam` is the one kind that needs no cross-word measurement — one centred word
at a time, which ffmpeg could place from `text_w` alone.

---

## 5. The panel

`CaptionPanel.tsx`, opened by the "Subtitles" button (which previously went
straight to a file picker):

- **Styles** — the preset library, grouped by tone, each tile carrying a live
  CSS thumbnail of that preset's own colours, weight, box and highlight. The
  thumbnails are generated from the same `CaptionStyle` the renderers read, so a
  preset cannot show one thing and apply another — which a checked-in PNG per
  preset eventually would. Each tile's tooltip carries the preset's provenance
  and its specific divergence from the reference.
- **Import** — D-229's `.srt`/`.vtt` flow, moved in verbatim.

Clicking a tile calls `applyCaptionPreset`, which finds or creates a subtitle
track, writes the style, and drops a caption so the look is visible at once.
**That is the same function `editor_add_caption_preset` calls** — one path for
the human and the agent, per CLAUDE.md.

Editing a placed caption is `CaptionInspectorPanel.tsx`, which now carries every
animation knob alongside the static ones.

---

## 6. MCP

- `editor_list_caption_presets` — the library, as data (id, label, group,
  description, animation kind, provenance note, full style).
- `editor_add_caption_preset` — apply one, creating the track and placing a
  caption. `place_caption=False` restyles a track that already has cues.
- `editor_set_caption_style` — extended with `animation`, `active_color`,
  `spoken_color`, `upcoming_color`, `highlight_color`, `highlight_opacity`,
  `highlight_pad_x`, `highlight_pad_y`, `enter_secs`, `enter_rise`, `word_gap`.
  The per-word colours take the literal string `"default"` to CLEAR back to the
  caption's own colour — omitting an argument means "leave alone", which is a
  different thing, and clearing an accent is otherwise unreachable.

---

## 7. Verification

- `apelles-timeline` — 238/238, of which 17 are new `caption_anim` tests: window tiling, the degradation
  cases (zero duration, empty text, out-of-range index), each kind's own
  invariants, and a fixture asserted number-for-number against the TypeScript
  mirror.
- `@apelles/editor` — `captionAnim.test.ts` asserts **the same fixture numbers**,
  so a drift in either language fails exactly one of the two;
  `captionPresets.test.ts` holds every preset to real colours, catalogue fonts,
  in-range values and (for adapted ones) a provenance note naming HyperFrames
  and Apache-2.0; `CaptionPanel.dom.test.tsx` mounts the panel and clicks it.
- `chroma::caption_render` — 20/20 (8 new): the PREVIEW side of every kind,
  plus the two things only this side can get wrong — that an animated caption
  is not served a stale frame from the layer cache (the key carries the time
  only when animated), and that a static caption ignores the time entirely and
  renders exactly what D-229 rendered.
- **Real ffmpeg, real pixels** — `captionAnimExport.ffmpeg.test.ts` renders and
  measures: a `build` really accumulates words, a `slam` really slides while
  entering, a `highlight` box really travels word to word while the line stays
  up, and a static caption still renders exactly as D-229 rendered it. This is
  the tier that catches the failure a string match cannot: a filtergraph that
  compiles perfectly and never evaluates its expressions (how B-075 and B-090
  each shipped green).

The advances fed to the ffmpeg tests are synthetic round numbers, deliberately:
it makes the expected left edge of the line exactly computable by hand rather
than re-derived from the code under test. It also means only the FIRST word's
pen is predictable there — ffmpeg still draws each word at its real glyph
width — which is why those tests assert the line's left edge and its overall
extent rather than every word boundary.

---

## 8. Known gaps

Both are named on the roadmap, and neither is hidden from the user:

- **Typography.** The reference uses Montserrat, Anton, Poppins, Outfit, Space
  Grotesk and Gabarito. Apelles' catalogue is system faces only, because both
  renderers must read the same single-face `.ttf` (D-212). Each preset names the
  nearest catalogue face and says so in its own note. All six are SIL OFL 1.1
  and freely bundleable — a mechanical follow-up.
- **11 of the 19 catalogue looks are not built**, each because the native
  vocabulary genuinely cannot express it (glow, gradient fill, texture masking,
  channel splits, particles, per-character scramble, blend modes, per-word font
  weight, 3D parallax, camera moves, glyph morphing). Every one is named
  individually in D-243 with its specific blocker, so a follow-up needs no
  re-scraping and no re-deciding.
