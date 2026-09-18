# Export through the app's own compositor (D-350) — phases 1 and 2

**Status:** phase 1 (correctness + memory) and phase 2 (speed, §9) both shipped
2026-09-18, opt-in (`renderer: "compositor"`). The old filter-graph path is
still the default and is still present.
**Decisions:** `docs/08-decisions.md` **D-350** (the architecture) and **D-351**
(phase 2's parallelism, and why frame-level `par_iter` is the wrong shape here).
**Bugs it supersedes:** B-228/B-229/B-230 (resource),
B-201/B-208/B-218/B-223 (parity).

Sections 1-8 are phase 1. **Section 9 is phase 2** — read §9.2 first if you are
about to try to parallelise this loop.

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

---

# 9. Phase 2 — speed (D-351, 2026-09-18)

Phase 1 made the export *correct* and *cheap in memory*. It did not make it
fast. This section is what phase 2 measured, what it changed, and — the part
worth reading — **why the obvious parallelisation is the wrong one.**

## 9.1 The starting point, measured

The real project (`2026-09-12-c040-mgfx-recut`, ~79 clips, 3840×2160, 5,605
frames / 233.5 s) rendered correctly at ~3.2 GB — but took **~5-6x the video's
own runtime**, with `apelles` at **~22% CPU on a 10-logical-core machine**.

`edit_render.rs`'s loop was a plain `for pos in 0..req.frames`. Where the time
actually went, on the 20-clip / 1080p / 240-frame stress fixture:

```
total     33.16 s   (7.2 fps)
decode    11.03 s   (33.3%, 480 calls, 23.0 ms/call)
composite 22.12 s   (66.7%)
```

Two thirds compositing, all of it on one thread. That is the ~22%.

## 9.2 Why `par_iter` over frame indices is the WRONG fix

This is the finding, and it is not obvious: **frames are not independent**, even
though each one's *picture* is a pure function of the document. The compositor
reaches a process-global, order-dependent decoder:

1. **`decode_pipe::PIPES` is one global `Mutex<PipePool>`, and it is held across
   the blocking pipe read.** Concurrent `render_timeline_frame` calls serialise
   on decode regardless — so frame-level parallelism buys almost nothing even
   ignoring correctness.
2. **`FramePipe::can_serve` is forward-only**, within `MAX_FORWARD_SKIP = 48`.
   Anything else is a kill-and-respawn, measured at **248-337 ms** (median
   723 ms on the owner's C040 footage). Frames arriving out of order thrash it.
3. **`retain_pipe_slots` and `sync_prefetch` are declarative per frame** — each
   call releases every pipe the *current* frame does not want. Two frames in
   flight would each release the other's pipes, on every frame.

So a naive `par_iter` here is not "slightly unsafe"; it is *slower*, and it
fails silently — the picture stays correct while the decoders churn.

**Round-robin across frames does not help either, and that is provable rather
than empirical.** Hand worker `k` every Lth frame and it still has to *decode*
every frame, because the pipe can only skip forward through the ones it does not
need. Wall time is `N·d + N·c/L`, i.e. speedup `(d + c)/(d + c/L)` — **exactly**
what parallelising the compositing alone achieves, while burning L× the decode
work and L× the ffmpeg children. Contiguous segments genuinely do scale both
terms, but need a whole segment of finished frames buffered (tens of GB at 4K)
unless each segment gets its own encoder — see §9.5.

## 9.3 What phase 2 did instead

**Every per-pixel pass inside a frame, across the cores; frame order untouched.**
Each of these writes each output pixel from inputs it does not itself write, so
splitting by ROW changes the schedule and not one pixel's arithmetic:

- `blend_layer_sampled` — D-217's fused crop/scale/round/blend fast path.
- `image::imageops::overlay` → `overlay_parallel`, a re-spelling of the
  library's own per-pixel `blend`, asserted **byte-identical** to it by
  `overlay_parallel_matches_the_image_crate` so it cannot drift.
- the corner-radius (D-344) and opacity alpha passes.
- `apply_adjustment_to_canvas` (D-230) — now the row-parallel twin of
  `grade_lut::apply_to_rgba`, which has always been parallel.
- the RGB→RGBA widening every decoded frame pays (`to_rgba8_parallel`).

Two non-parallel wins in the same pass:

- **the base layer's `layer.clone()` is gone.** A full-frame layer with no crop,
  resize, rounding, rotation or opacity — the base of every composition, every
  frame — copied the whole canvas (33 MB at 4K) so that `overlay` could read the
  copy. It is a `Cow` now; `to_mut()` still copies exactly when a pass really
  will write.
- **the encoder hand-off left the critical path.** The finished frame goes to a
  writer thread over a `sync_channel(WRITE_AHEAD)`, so the pipe write, the
  kernel buffer and the encoder's own latency overlap the next frame's
  compositing.

`rayon` is not a new dependency — it is already direct in the `apelles` crate
and already this repo's pattern for pixel work (`lens_blur.rs`,
`inpainting.rs`, `grade_lut`) — so there is no dependency `D-NNN` to write.

### The bound on the hand-off, stated

`WRITE_AHEAD = 4` frames. Each is one output-size RGBA canvas, so the extra
resident memory this can *ever* cost is 4 × frame: **133 MB at 4K, 33 MB at
1080p**. Deliberately small and deliberately a hard bound — B-229 and B-230 were
both "a per-unit cost nobody bounded", and answering them with an unbounded
frame queue one layer up would have been the same bug in a new place.

## 9.4 The preview is excluded — and that is a correctness fix

Parallelising at preview sizes **broke an existing test**,
`playback_primes_the_upcoming_cut_and_a_scrub_does_not`. It was confirmed to be
this change's fault the only way that can be confirmed: the same test was run on
pristine `main` under *higher* machine load, where it passed.

The mechanism is real and worth recording. A compositor taking all ten cores
slows the `ffmpeg` decode **child** it is competing with → that inflates
`decode_pipe::record_seek_cost`'s measured EWMA → which widens
`prefetch_lead_secs` → so D-330's scheduler, correctly, primes more standby
pipes than that fixture expects. No arithmetic is wrong anywhere in that chain.
It is simply the export's optimisation reaching into **live playback** and
changing how it schedules decoders, which is the trade CLAUDE.md's
"performance, then stability" exists to forbid.

So the passes go parallel only above `PARALLEL_PIXEL_MIN = 1024² px`. That is a
boundary between two **callers**, not a tuned constant:

| caller | largest frame it composites |
|---|---|
| live preview (`PreviewPane.tsx`, `PREVIEW_LONG_EDGE = 960`) | 960 × 960 = 921,600 px |
| `PARALLEL_PIXEL_MIN` | **1,048,576 px** |
| smallest real export | 1920 × 1080 = 2,073,600 px |

**The live preview is byte- and thread-identical to before this change.**

## 9.5 The numbers — and what they do NOT reach

`cargo test -p apelles --lib chroma::edit_render::parity_tests::measure_render_throughput -- --ignored --nocapture`

Absolute times track machine load, so the honest comparison is **one binary, two
runs, back to back**, via `RAYON_NUM_THREADS` (1 = the pre-D-351 compositor):

```
session A   threads=1   42.05 s ·  5.7 fps   →   threads=10   32.10 s ·  7.5 fps   1.31x
session B   threads=1   19.08 s · 12.6 fps   →   threads=10   14.79 s · 16.2 fps   1.29x
```

Against **pristine `main`**, both on a quiet machine (20 clips, 1080p, 240
frames):

```
main      20.38 s   decode 6.40 s   composite 13.98 s
D-351     14.79 s   decode 5.93 s   composite  8.86 s
          -----------------------------------------------
          overall 1.38x   ·   the compositing half 1.58x
```

**This does not reach the owner's "under 1x the video's runtime", and the reason
is measured, not guessed:**

- **~31% of the time is decode**, still one global-locked, forward-only
  sequential pipe (§9.2). Nothing in this phase touched it.
- **`image::imageops::resize` is still serial**, and it is the largest remaining
  compositing term. It is the library's own separable two-pass filter;
  splitting it by output band needs an input halo whose weight normalisation
  `image` does not expose, so hand-rolling a bit-identical replacement is
  precisely what CLAUDE.md's "check for an existing crate before hand-rolling"
  rule says not to do. Back-solving Amdahl from 1.58x on 10 threads puts the
  parallelised share of compositing at only **~41%** — the other ~59% is that
  resize plus the crop copy.

### Phase 3 — what would actually reach <1x

**Contiguous-segment parallel rendering**: split the timeline into N contiguous
segments, give each its own worker, its own decode-pipe lane, and its own
encoder writing its own file; concatenate at the end. This is the standard
segment-render-and-concat architecture, and unlike every alternative in §9.2 it
scales **both** the decode and the composite term with the core count. It needs
three things, none of them small and none of them done here:

1. **Lane-scoped keys in `decode_pipe`'s global pool** — `(lane, PipeSlot)`
   rather than `PipeSlot`, so `retain_pipe_slots`/`sync_prefetch` release only
   their own worker's pipes. Live playback is lane 0 and keeps today's
   behaviour exactly.
2. **Releasing that pool's lock across the blocking read** (check the pipe out,
   decode, check it back in, with a condvar so two callers for one key still
   serialise). Without this, lanes serialise on decode and the rest is worth
   nothing.
3. **Per-segment encode + concat** in the argv `timelinePipeExport.ts` owns,
   with the audio mux moving to the concat step. This is what removes the
   whole-segment frame buffer that makes contiguous segments impossible today.

Only (3) changes the TypeScript side; (1) and (2) are contained in
`crates/apelles-media/src/decode_pipe.rs` and are behaviour-preserving for the
single-threaded live-playback caller by construction.

## 9.6 Tests added

| test | what it pins |
|---|---|
| `the_piped_stream_carries_every_frame_in_timeline_order` | every frame reaches the encoder, once, in order — asserted losslessly (`-f rawvideo`, no codec) against what the compositor produced, because ffmpeg reads this pipe as headerless raw video where a swap is silent, not an error |
| `overlay_parallel_matches_the_image_crate` | the parallel overlay IS `image`'s overlay, at four canvas/top pairs including partial and fully-outside overlaps, and at a size over the parallel threshold |
| `to_rgba8_parallel_matches_the_image_crate` | same, for the RGB→RGBA widening |
| `parallel_row_passes_match_their_serial_form` | `for_each_row_mut`'s parallel arm equals its serial arm on the same closure |
| `the_parallel_compositor_is_deterministic_across_runs` | the row split cannot leak a scheduler into the picture — CLAUDE.md's "same doc + same frame ⇒ identical pixels", asserted on the composite path directly |

Unchanged and still green: `render_path_matches_the_filter_graph_path_pixel_for_pixel`
and `rendering_the_same_frame_twice_produces_identical_bytes` (phase 1's
old-vs-new pixel parity and determinism), plus the whole `apelles` lib suite —
**366 passed, 0 failed**.

## 9.7 Files (phase 2)

| file | what changed |
|---|---|
| `app/src-tauri/src/chroma/edit.rs` | `for_each_row_mut`, `to_rgba8_parallel`, `overlay_parallel`, `PARALLEL_PIXEL_MIN`; row-parallel `blend_layer_sampled` / corner-radius / opacity / `apply_adjustment_to_canvas`; the base layer's clone becomes a `Cow`; five new tests |
| `app/src-tauri/src/chroma/edit_render.rs` | `WRITE_AHEAD`, the writer thread and its bounded channel; `measure_render_throughput`; `the_piped_stream_carries_every_frame_in_timeline_order` |
