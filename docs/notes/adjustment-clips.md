# Adjustment clips in the Edit tab (D-230)

Roadmap item 27 ("Organization & finishing"). Built 2026-09-08. Reference:
DaVinci Resolve's own Edit page, `scratch/resolve-reference/adjustments.jpg`,
read before anything here was designed per CLAUDE.md's "research the real
pattern first" rule.

---

## 1. What Resolve actually shows, and what we took from it

The reference screenshot shows three things, all of which carried over:

1. **The adjustment clip sits on the video track ABOVE the clips it affects** —
   V2, over `Van.mov` / `Beach.mov` on V1. It is an ordinary clip on an
   ordinary video track, not a track type of its own.
2. **Its body is a flat, saturated, thumbnail-free bar** carrying an `fx` badge,
   the adjustment-layer glyph and the words "Adjustment Clip" — deliberately
   unlike every clip around it, because it is the one clip on the timeline that
   contributes no picture.
3. **Selecting it shows the EFFECT it carries in the Inspector** (Resolve's
   Effects / OpenFX tab, `Analog Damage` and its parameter list) — a plain list
   of labelled sliders with numeric readouts and per-parameter resets, not the
   clip-geometry form a media clip gets.

What we did **not** take: Resolve's effect is an arbitrary OpenFX plugin from a
library of hundreds. Ours is one fixed primary correction — see §3.

## 2. The compositing model

> An ordinary clip contributes **its own** pixels.
> A D-226 transition blends **two named** clips.
> An adjustment clip contributes **nothing** and transforms **the result of
> everything below it**.

That third thing is a genuinely new compositing model, and it is the reason this
work needed a `D-NNN` rather than being a routine feature.

**The implementation is almost nothing, and that is the point.** Both renderers
already walk layers back-to-front:

- `chroma::edit::composite_video_frame` iterates `decoded.iter().rev()` — lowest
  priority first, at the back;
- `timelineExport.ts` chains `overlay` nodes starting from the highest track
  index, ending with track 0 on top.

At the instant either walk reaches the adjustment layer, **the canvas (or
stream) in hand is exactly "every layer beneath this clip"**. So the scoping
rule is not implemented at all — it falls out of the existing z-order, and the
time span falls out of the clip only being resolved inside its own frames in the
first place.

Concretely:

| | live preview (`chroma::edit`) | export (`@apelles/editor`) |
|---|---|---|
| the layer | `Step::Adjust(ops)` in the paint list | a real slot in `pending`/`chains`, no `-i` |
| the work | `apply_adjustment_to_canvas` on the canvas so far | two filter nodes on `lastLabel` |
| the gate | the clip only resolves inside its own span | `enable='between(t,…)'` |

`buildTextDrawtextStep` (D-213) had already established the export half of this
shape — "a filter on the composited stream, spliced at the position that clip's
`overlay` would have occupied" — so an adjustment clip reuses a proven pattern
rather than inventing one.

**What this inherits for free**, with no second rule to keep in step: stacking
(two adjustment clips compose, the lower one applied first), coexisting with
titles on the same track, hidden and locked tracks, and moving / trimming /
splitting / deleting the adjustment clip like any other clip.

### Options weighed (full writeup in D-230)

- **`TrackKind::Adjustment`** — rejected. Contradicts D-211's precedent and
  Resolve itself; needs its own resolver, ordering rule and export pass, all
  re-deriving track index order; makes "an adjustment and a title on one track"
  unrepresentable.
- **Bake the correction into each affected clip** — rejected. Mutates real
  user-authored content, needs clips split at the adjustment's boundaries on
  partial coverage, and has no answer at all where layers overlap or are
  partly transparent ("the composited result" is then not any one clip's
  pixels).
- **A general node/effects graph** — out of v1 scope (`docs/02-scope.md`:
  "adjustment stack not nodes"), and not needed to ship the primitive.

## 3. The effect it carries — and why it is not the Colorist grade

> **Update, 2026-09-09 (D-256).** Everything in this section is still true as
> written — but it is no longer true that the Colorist grade is unreachable
> from the Edit tab *at all*. D-256 found the option this analysis had not
> considered: don't move the computation, move the **result**. Running an
> identity RGB lattice through the very shader named below, once, yields a 3D
> LUT that the CPU compositor can interpolate and ffmpeg's `lut3d` can apply —
> so a *clip's own* saved grade now renders in the Edit preview and the export
> identically. See `docs/notes/colorist-edit-grade-bridge.md`.
>
> That does **not** make an adjustment clip redundant, and the two are not
> alternatives. A baked lattice is a fixed function of one clip's saved
> `grade.json`. An adjustment clip is a live, keyframeable operator on whatever
> is composited *beneath it* — the set of layers under it changes with the edit
> and its `mix` animates, neither of which a pre-baked table can express. The
> split is what each is for.

The obvious effect for an adjustment clip is Apelles' real grading stack. **It
is structurally unavailable** *as a computation to call* (see the update
above). Verified in the code before deciding:

- the Colorist's `adjustments` blob is *deliberately untyped in Rust*
  (D-020/D-025: "the canonical shape is owned by the frontend `useEditorStore`
  and a typed Rust mirror would just drift");
- it is applied **only** by RapidRAW's wgpu shader — there is no CPU
  implementation of it anywhere in the workspace;
- the Edit tab's preview compositor is explicitly GPU-free (`chroma::edit`'s own
  header: "no `wgpu`, no colour grade");
- and the ffmpeg export compiler **could not reproduce a wgpu shader at all**.

That last point is decisive rather than merely inconvenient: every adjustment
clip would have been a guaranteed preview-vs-export divergence, which is the
exact B-090 / B-095 / B-098 defect class this repo has already fixed three
times. A feature whose two engines cannot agree by construction does not meet
this project's bar.

**So the effect is a five-parameter primary correction**, in the Colorist's own
vocabulary so nothing here reads as a second effects language:

| parameter | range | meaning |
|---|---|---|
| `exposure` | -1..1 | stops; a linear gain of `2^value` |
| `contrast` | -1..1 | about the 0.5 pivot |
| `saturation` | -1..1 | -1 = Rec.709 luma, +1 = double |
| `temperature` | -1..1 | + warmer (red up, blue down) |
| `tint` | -1..1 | + magenta (green down) |

All default `0`, so **adding an adjustment clip changes nothing until a
parameter moves** — and an identity correction is skipped entirely by the
preview and emits no filter node at all in the export, so it is genuinely free
rather than merely invisible.

## 4. The operator

`apelles_types::adjustment` (L0, beside `fade`/`pan`/`eq` and for their reason:
the operator is a property of the values, not of the timeline). **Both renderers
consume the operator it builds rather than re-deriving the correction** — which
is what makes preview and export the same maths *by construction* instead of by
two implementations happening to agree.

```
stage 1 (per-channel affine)  v = clamp01(gain[c] · v + offset)
stage 2 (saturation matrix)   v = clamp01(sat · v)

ge = 2^exposure ; c = 1 + contrast ; s = 1 + saturation
gain = ( c·ge·(1+0.3·temperature), c·ge·(1-0.3·tint), c·ge·(1-0.3·temperature) )
offset = 0.5·(1-c)
sat = s·I + (1-s)·(Rec709 luma broadcast)
mix (the clip's opacity) lerps each stage toward its own identity
```

Two stages, because that is **what ffmpeg can execute**:

| stage | ffmpeg filter | why |
|---|---|---|
| 1 | `lutrgb` | expression-based → **no coefficient cap**; a 256-entry LUT built once at init, not per-pixel work |
| 2 | `colorchannelmixer` | a real SIMD 3×3 matrix; its coefficients provably stay inside ffmpeg's ±2 (max 1.928) |

### Why not one matrix, and why not `geq` — measured, not assumed

- **One folded matrix was the first design, and its own corner-case test killed
  it.** A saturation matrix maps grey to itself, so the contrast pivot survives
  folding and all three steps collapse to a single 3×3 + offset. But
  `colorchannelmixer` caps coefficients at ±2, and the folded matrix breaches
  that at *ordinary* settings — contrast `0.6` with saturation `0.8` already
  clamps, crushing mid-grey from `0.5` to `0.196`. Splitting the gain out into
  `lutrgb` removes the ceiling entirely; stage 2 alone can never reach it, which
  is why this module contains no clamp and the export needs no fallback path.
- **`geq` would run the whole operator verbatim**, no cap, no split. Rejected on
  measurement: **76.9 s vs 1.95 s** for 6 s of 1080p30 — ~39× slower.
- **`format=rgba` is mandatory, and its absence is silent.** An earlier draft
  carried the offset on `colorchannelmixer`'s alpha coefficients; with no
  explicit alpha format the filter runs, reports success, and drops the offset
  (grey 128 came back 126, not the expected 179). The pin stayed after the
  offset moved to `lutrgb`, to stop ffmpeg inserting a YUV round trip between
  the two nodes.
- **The two filters round differently** — `lutrgb` truncates, `colorchannelmixer`
  rounds — and there is a real 8-bit quantisation *between* them.
  `AdjustmentOps::apply_rgb8` mirrors all three facts. Carrying `f64` through
  would be *more* accurate and therefore *wrong*, because it would disagree with
  the export.
- **Measured agreement: ≤ 1/255**, over 6 swatches × 4 parameter sets chosen at
  the corners of the parameter space.

## 5. What applies to an adjustment clip, and what does not

Narrow, and narrow **identically in both engines** — the B-053/B-095 rule.

- **`opacity` applies**, as the correction's mix amount (`0` = no effect, `1` =
  full), and **statically only**: not keyframed, not faded. ffmpeg fixes these
  filter coefficients at filter init, so a time-varying mix is not expressible
  in the export at all; animating it in the preview alone would recreate exactly
  the divergence B-053/B-095 were filed for. Centralised in
  `Clip::adjustment_ops` (Rust) / `clipAdjustmentOps` (TS) so both renderers
  inherit the restriction from one place.
- **`position_*`, `scale`, `rotation`, `box_*`, the crop insets do NOT apply.**
  The correction is always full-frame.
- **It reaches letterboxed / empty regions** (the black backdrop) as well as
  picture, because the export's filters sit on the composited stream, which
  includes `[base]`. Preview and export agreeing beats the arguably-tidier
  masked alternative, which the export could not reproduce without a per-layer
  alpha pass it does not have.

Each of these is stated in the Inspector panel itself and in the MCP tool
docstrings, rather than left to be discovered.

## 6. Both interfaces, same pass

Per CLAUDE.md's human+AI rule, with one op and one validator underneath both.

**GUI**
- an **"Adjust"** toolbar button beside "Title" — drops a neutral adjustment
  clip at the playhead on the **topmost** video track (the only placement that
  grades the whole edit; the reference shows the same stacking);
- the **on-timeline body** from the reference: flat tinted bar, wand badge, the
  clip name, and a live summary of the correction (`EXP +0.30 · SAT -0.60`), no
  filmstrip and no waveform;
- **`AdjustmentClipInspectorPanel`** — slider + number + per-parameter reset per
  row, a reset-all, and the §5 restrictions stated outright. Stacked above
  `EditorInspectorPanel` exactly as `TextClipInspectorPanel` is, so the shared
  Opacity row stays genuinely shared rather than copied.

**MCP**
- `editor_add_adjustment_clip` — track, span, and any of the five parameters.
  Its result reports **what the placed clip actually affects**, because placing
  it on the bottom track (where it reaches nothing) is the one obvious way to
  get this wrong;
- `editor_set_adjustment_clip` — a merge patch, so changing saturation never
  resets exposure;
- an `adjustment_clips` entry in `editor_get_capabilities`.

## 7. Verification

A **matched pair** of real-pixel suites — which is what makes preview/export
parity a checked claim rather than an assertion:

- `preview_adjustment_tests` (`app/src-tauri/src/chroma/edit.rs`) — real
  `timeline_frame` output, real media on disk, decoded JPEG pixels;
- `timelineExportAdjustment.ffmpeg.test.ts` (`packages/editor/src`) — real
  ffmpeg renders, real decoded pixels.

Both assert against the **shared `AdjustmentOps`** rather than hand-typed
numbers, and both cover: the control (no adjustment clip at all), the correction
reaching the track below, the **z-order claim** (an adjustment below the picture
must not touch it), the identity no-op, the `opacity` mix, and stacking.

Underneath those: `crates/apelles-types/src/adjustment.rs`'s own unit tests (14),
including one that pins the maths to **real ffmpeg output pasted in verbatim**
and one that proves stage 2 never reaches ffmpeg's ±2 cap across the whole
parameter space; and `packages/editor/src/adjustment.test.ts` (23) for the
shared validator, the reducer's refusals — notably that patching an
`adjustment` onto a media clip is rejected, since both renderers branch on
`is_adjustment` *before* `source_path` and the clip's picture would otherwise
vanish — and the emitted filtergraph (the `format=rgba` pin, the `enable`
gates, and that no coefficient is ever formatted in exponential notation, which
ffmpeg's option parser rejects).

## 8. Deferred, deliberately

- **More parameters** (highlights/shadows, curves, LUTs, a real vignette). Each
  is additive over the same two-stage operator only if ffmpeg can run it with
  the same fidelity — widen both engines together or not at all.
- **Keyframing the mix.** Needs an export filter whose coefficients accept a
  time expression; `geq` can, at ~39× the cost. Revisit only with a measurement.
- **Masking the correction** to a region (Resolve's Power Windows on an
  adjustment clip). Needs a per-layer alpha pass the export compiler does not
  have.
- **An effects library** beyond one primary correction — that is the node/graph
  question, out of v1 scope.
