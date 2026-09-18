# Export through the app's own compositor (D-350) — phase 1

**Status:** phase 1 shipped 2026-09-18, opt-in (`renderer: "compositor"`).
The old filter-graph path is still the default and is still present.
**Decision:** `docs/08-decisions.md` D-350. **Bugs it supersedes:**
B-228/B-229/B-230 (resource), B-201/B-208/B-218/B-223 (parity).

---

## 1. What this is

`editor_export` used to composite a timeline's picture by compiling it into one
ffmpeg `-filter_complex` graph: one `-i` per clip, and per clip a
`setpts`/`crop`/`scale`/`geq`/`overlay` chain. That is a second, hand-written
implementation of compositing maths the app already owns — the Edit tab's live
preview composites the same document natively, in Rust, every frame.

Phase 1 adds the other shape: **render the picture with the preview's own
compositor, headlessly, frame by frame, and hand ONE raw RGBA stream to ONE
ffmpeg process that does nothing but compress and mux.**

Both paths exist. `editor_export` picks between them with `renderer`.

## 2. A correction to D-350's own wording

D-350 calls the target "the native **GPU** compositor
(`crates/apelles-gpu`, `composite_layer_onto`)". That is not quite what is
there, and it matters for anyone reading the decision later:

- `crates/apelles-gpu` is **only** the headless wgpu device/queue/limits
  constructor (96 lines). It is used by the *grade* path.
- `composite_layer_onto` and `composite_video_frame` live in
  `app/src-tauri/src/chroma/edit.rs` and are **CPU** code — the `image` and
  `imageproc` crates, `image::imageops::resize`/`overlay`, a hand-written
  `blend_layer_sampled` fast path (D-217).

The GPU does appear in the Edit tab's render, but for the **grade**, not the
geometry: `grade_lut::lut_for_clip` bakes a clip's Colorist grade to a 3D LUT by
running an identity lattice through the real wgpu pipeline, and the compositor
interpolates that lattice per pixel on the CPU.

None of D-350's reasoning depends on the distinction — the argument is "one
compositor, not two, and hand the encoder only finished frames", which is about
*where the compositing happens*, not which processor does it. But the code this
phase builds on is the CPU compositor, and calling it a GPU one would send the
next reader to the wrong file. Moving that compositing to the GPU is a real,
separate, later question (it would be `apelles-compositor`, already named as a
future crate) and phase 1 deliberately does not touch it.

## 3. The shape that shipped

```
timelinePipeExport.ts            chroma::edit_render                chroma::edit
  buildPipeExportPlan  ──args──▶  chroma_render_timeline_export ──▶  render_timeline_frame
  (audio mix only)                  render_timeline                    composite_video_frame
                                      │  one frame at a time             composite_layer_onto
                                      ▼                                  (+ grade LUT, text,
                                    ffmpeg  -f rawvideo -i -              captions, adjustments)
                                      + the audio inputs/graph
                                      → out.mp4
```

**`app/src-tauri/src/chroma/edit.rs`** — one refactor, no behaviour change:
`timeline_frame_image` split into a thin project-reading wrapper and
`render_timeline_frame(&Timeline, &ProjectSettings, pos, max_long_edge, intent)`.
The old function resolved the project manifest from disk *on every call*, which
is invisible at preview rates and pathological at export rates (a 4-minute
60 fps export would re-parse the manifest ~14,000 times).

**`app/src-tauri/src/chroma/edit_render.rs`** (new) — the loop, the resize and
the pipe. It composites nothing itself and builds no ffmpeg arguments.

**`packages/editor/src/timelinePipeExport.ts`** (new) — the argv. Emits **no
video filter graph at all** (asserted directly, not inferred). Reuses
`timelineExportAudio.ts`'s per-source construction (D-197) unchanged.

**`packages/editor/src/timelineExport.ts`** — `exportTotalDurationSec` extracted
so both paths derive an export's length from one definition; `buildExport-
FfmpegArgs` now calls it rather than computing it inline.

### What the compositor covers, for free

Because the picture is the preview's own, everything the preview supports is
exported by construction, with no per-feature work: per-clip transform, crop,
`box_width`/`box_height`, rotation, opacity, corner radius (D-344), keyframes
with easing (D-208), speed ramps (D-236), transitions including dip-to-colour
plates (D-226), adjustment clips (D-230), title/text clips (D-211), captions
(D-229) and each clip's baked Colorist grade (D-256). The old path spells every
one of those as its own filter node.

### The canvas-size choice

`canvas_plan(comp, out)` composites straight into the OUTPUT size when the
output is a same-aspect downscale of the composition (the common case: a 4K
composition exported at 1080p), using the same `max_long_edge` knob the preview
uses. That is a 4x reduction in per-layer pixel work versus compositing at 4K and
shrinking. A genuinely different aspect ratio, or an upscale, composites at the
composition and resizes once at the end — which is what the old path's own
output `scale` did.

## 4. Audio

Out of scope for D-350, and left alone. The audio mix is compiled by the same
`timelineExportAudio.ts` functions the old path uses — `buildAudioSourceChain`,
`resolveDuckForTrack`, `audioRefMapArg`, the `amix normalize=0` +
`asoftclip=tanh` topology — so gain, fades, ducking, EQ, pan and per-clip volume
behave identically.

**One structural difference.** In the old path a video clip's embedded audio
rides the `-i` its own PICTURE already opened, and a transition has widened that
input into handle media, so the audio is `atrim`med back afterwards. Here the
picture opens no inputs, so embedded audio gets its own `-i` at exactly the
clip's `[source_start, +duration)` window — the same audio, by a shorter route,
with no `atrim`. Audio inputs therefore number one per audio-contributing clip
(as before) rather than being shared with video inputs (which no longer exist).

Muxed in **one process**, not two passes: the audio inputs and filter graph sit
alongside the raw video input in the same invocation, with the pipe as input 0.

## 5. Verification — the old-vs-new pixel comparison

The two paths are in two languages, so the comparison's inputs are frozen into
one committed file rather than re-derived on each side:

- `packages/editor/src/exportParityFixture.test.ts` builds the parity timeline,
  compiles **both** argvs with the live compilers, and writes
  `app/src-tauri/tests/fixtures/export-parity.json`. On every run it also
  re-asserts the committed file still deep-equals what those compilers produce —
  **so the fixture cannot go stale silently**, which is the only thing that makes
  this sound. Regenerate with
  `WRITE_EXPORT_PARITY_FIXTURE=1 npx vitest run packages/editor/src/exportParityFixture.test.ts`.
- `edit_render.rs`'s `render_path_matches_the_filter_graph_path_pixel_for_pixel`
  reads it, generates the fixture media with real ffmpeg, runs the old argv, runs
  the new path, decodes five real timestamps from **both output files** and
  compares.

Same two-halves-one-written-down-fact shape D-338/B-201's placement-parity pair
already uses, with a whole document and two whole argvs as the shared fact
instead of a rectangle.

### The fixture

Two tracks, four clips, 640x360 @ 30, 60 frames: a full-frame base layer, plus a
**keyframed slide** (`overlay=x='<piecewise expr>'` in the old path), a
**rounded box** (`geq`), and a **crop** (`crop=`, crop-then-scale per B-218).
Flat colours on purpose — a geometry disagreement shows up as a moved edge,
which a per-pixel diff sees immediately, where a textured source would smear it
into resampling noise.

Every source is at the composition's own size, deliberately: the two engines are
**already documented to disagree** about what `scale` is a fraction of when a
clip's source resolution differs from the composition (the export reads it as a
canvas fraction, the preview as a multiple of the clip's own footprint — see
`capabilities.json`'s own `scale` note). That is a real pre-existing divergence
and mixing it in would make a genuine regression indistinguishable from it. It is
also, incidentally, a divergence the render path closes by existing.

### The measurement (2026-09-18)

```
frame  5  PSNR 33.1 dB · differing 0.312% · SOLID 0.0000%   keyframed slide, x = 53.33 px
frame 15  PSNR 41.8 dB · differing 0.000% · SOLID 0.0000%   same slide, x = 160 px exactly
frame 25  PSNR 33.1 dB · differing 0.312% · SOLID 0.0000%   same slide, x = 266.67 px
frame 35  PSNR 43.3 dB · differing 0.023% · SOLID 0.0000%   rounded corners — the arc's AA
frame 50  PSNR 43.1 dB · differing 0.000% · SOLID 0.0000%   crop-then-scale
```

**Frames 15 and 50 are pixel-for-pixel identical.** A box on an integer boundary
and a cropped-then-scaled box come out of the two engines the same, through two
independent libx264 encodes.

**Why PSNR is reported but not asserted on.** Every frame that differs at all
differs *only* where x lands on a fraction of a pixel — `overlay` truncates a
fractional x where `composite_layer_onto` rounds it — and on flat saturated
colours a one-pixel boundary line is a per-pixel delta of ~170, which drags PSNR
down hard while being, visibly, nothing. The difference's bounding box on frames
5 and 25 is exactly the pip box's own outline. So the asserted metrics are:

- **`solid_share`** — the difference mask after a **3x3 erosion**. A boundary a
  pixel out of place is a one-pixel-thin line and erodes to nothing; a box in the
  wrong place, at the wrong size, in the wrong colour, or missing is a filled
  region and survives. It measures **0.0000% on every frame**, so the limit is
  set just above zero rather than at a tolerated level.
- **`gross_share`** — the whole difference, as a backstop against a boundary many
  pixels thick. Limit 2%, ~6x the observed worst (0.312%).

### Determinism

`rendering_the_same_frame_twice_produces_identical_bytes` renders each sample
frame twice straight on the compositor (no encoder, so a codec's own
non-determinism cannot mask a renderer's) and compares raw RGBA. CLAUDE.md's
"render the same frame twice, diff" rule, applied to this path.

## 6. Resource behaviour — measured

`cargo test -p apelles --lib chroma::edit_render::parity_tests::measure -- --ignored --nocapture`.
`#[ignore]`d because it samples a live process: a measurement, not a pass/fail
fact. 20 clips, 1920x1080, 240 frames, on the owner's machine, 2026-09-18:

```
filter-graph path : peak RSS  1786.6 MB · peak threads  100 · 21 inputs
compositor path   : peak RSS  1462.5 MB · peak threads  149 ·  1 input · 5 ffmpeg children
                    (host process at rest: 11.3 MB / 2 threads, subtracted)
                                RSS -18%  ·  threads +49%
```

Stable across runs (1462.5 / 1467.1 MB, 151 / 151 threads). **Wall time is not
claimed** — run-to-run variance on this machine is larger than the effect, the
same caveat B-230 recorded (the old path measured 36.8 s and 18.8 s on two
passes of the identical configuration).

**Read honestly:**

- **Memory is down 18%** and, more importantly, the *shape* changed: the old
  path's memory is `(clips) x (decoder frame pools) + (filter instances) x
  (filter thread pools)` — both multiplications B-229 and B-230 had to cap. The
  new path's is one encoder plus one decoder per **visible video track**, so it
  is flat in clip count. At 20 clips the caps are doing their job and the gap is
  modest; at this fixture's real-project equivalent (~79 clips) the old path's
  term grows and the new path's does not. **That slope is argued structurally
  and asserted on the compiled argv (`the_render_path_opens_one_input_however_
  many_clips_there_are`, and its 20-clip twin in the vitest fixture: 21 inputs
  versus 1); it has not been measured end to end at 79 clips.** Doing that on
  the real project is the obvious next measurement and is not claimed here.
- **Threads are UP 49%**, and that is a real, unresolved cost, not a rounding.
  Each `decode_pipe` ffmpeg is spawned with ffmpeg's default thread count (= the
  machine's logical CPU count) and there are ~4 alive at a time, so ~149. It is
  bounded by concurrent decoders rather than by clip count — so it does not have
  the B-229/B-230 growth — but the constant is bad. Capping `-threads` on a
  decode pipe the way B-230 capped the export's is the obvious fix and is
  **deliberately not done here**: `decode_pipe` is the live playback decoder, and
  changing its threading blind would trade an export number against preview
  smoothness, which is a measurement of its own. Tracked as phase-2 work.

### `FrameIntent::Single`, not `Playing` — measured, and counter-intuitive

An export walks strictly forward, which looks exactly like the pattern
`Playing`'s cut-boundary prefetch (D-324) exists to smooth. It is not. That
prefetch spawns a standby decoder ~half a second ahead of each boundary, which
pays for itself when a human is watching frames arrive in real time and cannot
when the render is already going as fast as the decoders allow. On this fixture
(clips of 0.4 s — *shorter than the lookahead*, which is what "heavily cut"
means) `Playing` spawned a standby per cut and cost **+35% peak RSS and 3x the
wall time** for a byte-identical picture:

```
FrameIntent::Playing : 1964.2 MB · 250 threads · 6 children · 40.0 s
FrameIntent::Single  : 1451.3 MB · 149 threads · 5 children · 12.8 s
```

### The pixel format

`rgba`, not `rgb24`. The compositor's canvas *is* an `image::RgbaImage`, so rgba
is the one format it hands over with no conversion pass. The 33% extra pipe
traffic is a memcpy through a kernel buffer; an rgb24 conversion is a pass over
every pixel in userspace, per frame.

## 7. What phase 1 defers — explicitly, not silently

1. **`speedOverrides` / `fitOverrides` / `freezeOverrides`.** Export-time-only
   knobs that change a clip's on-timeline footprint or framing; the live
   compositor has no notion of them. The render path **refuses** an export
   carrying one (`pipeExportUnsupported`) rather than honouring it in the sound
   while the picture ignores it. A clip's *own persisted* speed ramp (D-236) is
   fully supported — the preview resolves it, so both halves already agree.
2. **Deleting the old path.** It remains the default. `renderer` is a temporary
   parameter, documented as such in `editorExport.ts` and on both MCP surfaces.
3. **Progress reporting.** `render_timeline` knows exactly which frame it is on —
   this path can report real progress, where the old one could only parse ffmpeg
   stderr. Not wired to an event yet.
4. **Encoder choice.** Hardcoded h.264 / crf 18 / yuv420p, matching what the old
   path got from ffmpeg's extension default for `.mp4`. ProRes and a quality
   knob are a parameter away but are not in phase 1.
5. **Capping `decode_pipe`'s thread count** for a render — see §6.
6. **A GPU compositor.** §2.
7. **The `scale`-semantics divergence** between the two engines (§5). The render
   path closes it by construction, but that means an export switched to
   `renderer: "compositor"` will *deliberately differ* from the same export on
   the filter path for any clip whose source resolution is not the composition's
   — in the render path's favour, since it matches what the Edit tab shows. Worth
   knowing before comparing a real project's two outputs and concluding something
   regressed.

## 8. Files

| file | what changed |
|---|---|
| `app/src-tauri/src/chroma/edit.rs` | `render_timeline_frame` split out of `timeline_frame_image` |
| `app/src-tauri/src/chroma/edit_render.rs` | **new** — the render loop, the encoder pipe, the parity + measurement harness |
| `app/src-tauri/src/chroma/export.rs` | `drain_stderr`/`tail` made `pub(super)` (shared, not copied) |
| `app/src-tauri/src/chroma/mod.rs`, `src/lib.rs` | module + command registration |
| `app/src-tauri/tests/fixtures/export-parity.json` | **new** — the frozen comparison inputs |
| `packages/editor/src/timelinePipeExport.ts` | **new** — the render path's argv |
| `packages/editor/src/timelineExport.ts` | `exportTotalDurationSec` extracted and shared |
| `packages/editor/src/editorExport.ts` | `renderer` parameter, render-path dispatch |
| `packages/editor/src/exportQueueStore.ts` | a job freezes its render plan alongside its argv |
| `packages/editor/src/exportParityFixture.test.ts` | **new** — the fixture generator + staleness guard |
| `mcp/server.py`, `mcp/schemas.py`, `crates/apelles-mcp/src/tools/edit.rs` | `renderer` on both MCP surfaces |
