# Export through the app's own compositor (D-350) — phases 1, 2, 3 and the GPU plan

**Status:** phase 1 (correctness + memory) and phase 2 (speed, §9) shipped
2026-09-18; phase 3 (contiguous segments, §10) shipped 2026-09-19. **Since
D-448 (2026-11-03, §14) this is the only export renderer** — the old
filter-graph path was compared on the owner's projects and deleted; the
sections below that compare against it are history. **§15 (D-449, 2026-11-03)
is the as-built GPU engine**: every frame of the preview and the export is now
painted on the GPU by `apelles-compositor`, with no CPU compositor and no
fallback. §2's and §9's descriptions of a CPU compositor are history from here
on. §11 is the plan it was built from (D-363), kept for its op list and risk
table; §15.1 says what changed from it.
**Decisions:** `docs/08-decisions.md` **D-350** (the architecture), **D-351**
(phase 2's parallelism, and why frame-level `par_iter` is the wrong shape here),
**D-360** (phase 3's segments, lanes and concat), **D-363** (the GPU
compositor plan) and **D-449** (what was built: one GPU engine for preview and
export, no CPU fallback).
**Bugs it supersedes:** B-228/B-229/B-230 (resource),
B-201/B-208/B-218/B-223 (parity). **B-234** (phase 3's real-world shortfall) is
what §11 exists to eventually close.

Sections 1-8 are phase 1. **Section 9 is phase 2** — read §9.2 first if you are
about to try to parallelise this loop. **Section 10 is phase 3**, which is the
parallelisation §9.2 says IS correct, and §10.5 is the honest measurement of how
far it got (1.64x, and still not under 1x) — including why a single timing run
on this machine is worthless and what the harness does about it. **Section 11
is the plan for what comes next**, and **§13 (B-380, D-446, 2026-11-03)** is its wave 0: the measured 4K stage split, the hardware encoder pulled forward, and the plan re-ordered by payoff — moving the compositor itself onto the GPU
— scoped but explicitly deferred; start there, not from scratch, when this is
picked back up.

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

1. **`speedOverrides` / `fitOverrides` / `freezeOverrides`.** Refused here in
   phase 1; **drawn by the compositor since D-448** as clip data (§14).
2. **Deleting the old path.** Done by D-448 (§14).
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

---

# 10. Phase 3 — contiguous segments (D-360, 2026-09-19)

Phase 1 made the export correct and memory-flat; phase 2 put the compositing
work on every core and still left it well above the video's own runtime. This
is the phase that goes after the owner's actual goal — **under 1x** — and it is
the one §9.5 already scoped: split the timeline into N contiguous stretches,
give each its own worker, its own decode-pipe lane and its own encoder, and
concatenate.

## 10.1 Why contiguous, and why nothing cheaper works

This argument is D-351's (§9.2), repeated here only because it is what rules out
every simpler option:

- **`par_iter` over frame indices is unsafe *and* slower.** `decode_pipe` is a
  process-global pool whose pipes serve only *forward* targets within
  `MAX_FORWARD_SKIP = 48`, and whose `retain_pipe_slots`/`sync_prefetch` are
  declarative per frame — so out-of-order frames thrash the decoders, and two
  frames in flight release each other's pipes.
- **Round-robin (worker `k` takes every Lth frame) is provably no better than
  phase 2.** Each worker still has to *decode* every frame, because a pipe can
  only skip forward through the ones it does not need. Wall time stays
  `N·d + N·c/L`.
- **Contiguous ranges divide both terms**, because worker `k` decodes only the
  frames in its own range. The price is that a whole segment of finished frames
  would have to be buffered — tens of GB at 4K — *unless each segment has its
  own encoder*. Which is the whole design.

## 10.2 The two things `decode_pipe` needed

Both are contained in `crates/apelles-media/src/decode_pipe.rs`, and both are
behaviour-preserving for the single-threaded live-playback caller by
construction rather than by care.

**1. The pool is keyed by `(lane, slot)`, not `slot`.** A `PipeSlot` answers
"which independently-sequential stream is this?" — one per visible video track.
That was the whole question while exactly one thing walked the timeline. A
`PipeLane` is the missing half: *whose*. Every walker calls `retain_pipe_slots`
and `sync_prefetch` every frame with the complete set of slots **it** wants —
both are declarative by design (D-330) — so under one un-laned pool, N workers
at N different positions would each release every other's pipes on every frame.
That is D-125/B-040's measured respawn storm (which reduced the multi-layer
compositor to ~0.85 fps) reproduced one level up.

`PipeLane::LIVE` is the entire pre-existing app — preview, Colorist,
thumbnails. Nothing in the running app passes anything else.

**2. The pool's lock is released across the blocking read.** It used to be held
for the whole of `FramePipe::frame_scaled` — the pipe read, and on a respawn the
248-337 ms keyframe seek behind it. Lanes alone would have bought nothing:
N workers would have queued on one mutex and decoded exactly as sequentially as
one of them did. The pipe is now **checked out** of the pool, read off-lock, and
checked back in, with `Checkout`'s `Drop` guaranteeing it always returns — every
exit from a decode (the frame, a pipe error, the hardware-decode fallback, a
panic) has to give the key back, or the next caller for it waits on a condvar
forever. A second caller for the *same* key waits, which is exactly the
serialisation the pool mutex used to impose on it.

A release (`retain_pipe_slots`, `reset`, `drop_pipes_for_path`) arriving while a
pipe is checked out cannot take it from the thread holding it, so it **dooms**
the key instead and `Checkout::drop` honours that — a released pipe stays
released even when the release loses the race.

## 10.3 The shape that shipped

`render_timeline` now has one loop, `render_range`, parameterised by frame range
and lane. The single-stream path is one call of it over the whole timeline; the
segmented path is N of them at once inside a `std::thread::scope`. There is
deliberately no third spelling of the loop.

- **Segment count is decided by the renderer, not the compiler**
  (`plan_segment_count`), because only it knows the machine: bounded by the work
  available (`MIN_SEGMENT_FRAMES = 90`), by `available_parallelism`, and by
  `MAX_SEGMENTS = 8`.
- **`MAX_SEGMENTS = 6` is a memory bound before it is a speed one.** Each
  segment holds its own encoder plus one `decode_pipe` ffmpeg per visible video
  track, so the render's cost is `segments × (tracks + 1)` — exactly the
  per-unit product B-229 and B-230 were. Bounding the multiplier here, rather
  than letting it follow whatever core count the machine has, is what stops a
  32-core box turning a 3.2 GB export into a 25 GB one. Six rather than eight
  because the throughput sweep says so as well (§10.5). Within a segment the
  hand-off bound is still phase 2's `WRITE_AHEAD = 4`.
- **`MIN_SEGMENT_FRAMES` is the cold-start tax.** Every segment starts with one
  keyframe seek per visible track (248-337 ms, median 723 ms on the owner's
  C040). 90 frames is ~5.6 s of work at this path's measured rate against
  ~0.7 s of start-up — a ~12% tax on that segment, for a whole core.
- **A lane is released when its segment ends** (`release_lane`, via an RAII
  `LaneGuard`), so the Nth segment's decoders die when the Nth segment does
  rather than at process exit.
- **A failing segment aborts its siblings** through a shared `AtomicBool`
  checked once per frame, so a failure surfaces in about a frame's time instead
  of after every other segment has rendered itself out in full.

### The argv (the only TypeScript change)

`timelinePipeExport.ts` compiles two more argvs alongside the single-stream one.
Both carry a placeholder for the one thing the compiler cannot know — where this
run's temporary files landed — substituted by `edit_render` exactly once each
(`{{APELLES_SEGMENT_OUT}}`, `{{APELLES_CONCAT_LIST}}`).

- **`segmentArgs`** — the same raw-RGBA input and the same codec tail as the
  single-stream argv (that equality *is* the concat demuxer's precondition, so it
  is asserted rather than assumed), writing **video only**, with **no `-t`**: a
  segment's length is however many frames the compositor writes before closing
  the pipe.
- **`concatArgs`** — `-f concat -safe 0` over the finished segments, `-c:v copy`
  (re-encoding would cost a second generation for nothing), plus **the whole
  timeline's audio mix**, which has no notion of a frame range and so is muxed
  once, here.

**The concat list is input 0 — exactly where the pipe was — and that is
load-bearing.** `buildPipeAudioGraph` numbers its sources from input 1 because
input 0 is the pipe; putting the list in that same slot lets the *identical*
graph string be reused at the concat step instead of recompiled with shifted
indices, which would be a second implementation of the mix and precisely the bug
class D-350 exists to close. Asserted directly, on a timeline that really has
sound.

## 10.4 Correctness — where a split can hide, and what pins it

Segment boundaries are the only place this architecture can go wrong, and it
goes wrong **silently**: the concat demuxer stitches whatever it is handed, so a
segment one frame short produces a perfectly valid file that is one frame out of
sync from that boundary onward, with no error from anything.

So frame accuracy is structural first and measured second:

| pinned by | what it pins |
|---|---|
| `segment_ranges_partition_the_render_exactly` | the ranges cover `0..frames` — contiguous, no hole, no overlap, no two differing by more than one frame |
| `render_range`'s own tail check | each worker wrote **exactly** its range's length |
| `render_segmented`'s total check | the segments wrote `req.frames` between them |
| `the_segmented_render_is_the_same_video_as_the_single_stream_one` | `ffprobe -count_frames` on both real files agrees with the other and with the count asked for; and every frame at `b-1`, `b`, `b+1` for every boundary, plus phase 1's five sample frames, decoded from **both** files and compared |
| `a_frame_is_the_same_in_any_decode_lane` | a lane changes which `ffmpeg` decoded a frame, never the frame — raw compositor output, no encoder in the way |

The fixture's pip **slides one step per frame**, which is what makes the boundary
comparison sharp: a one-frame offset is a *displaced box* — a filled region,
which is exactly what `solid_share` (§5) measures and a one-pixel rounding line
is not.

**What is NOT claimed: the final file is not byte-identical to the single-stream
file, and could not be.** Each segment is its own libx264 encode with its own
GOP structure and rate control, so the compressed bytes differ by construction.
What is asserted is that the *picture* is the same, by the same
`solid_share`/`gross_share` metrics phase 1 used for old-vs-new. Determinism
itself (same doc + same frame ⇒ same pixels) is unchanged and still pinned by
phase 1's `rendering_the_same_frame_twice_produces_identical_bytes` and D-351's
`the_parallel_compositor_is_deterministic_across_runs`.

## 10.5 The numbers — and, again, what they do NOT reach

```text
cargo test -p apelles --lib chroma::edit_render::parity_tests::measure_segmented -- --ignored --nocapture
```

The whole export end to end — decode, composite, encode, and for the segmented
runs the concatenation — on the same 20-clip / 1080p / 240-frame stress fixture
phase 2 used. 240 frames at 30 fps is **8.00 s of video**, so "under 1x" means
the `xruntime` column below 1.00. Ten logical cores.

```text
segs       best       fps  xruntime  speedup
   1     14.45s      16.6      1.81     1.00x
   2     10.18s      23.6      1.27     1.42x
   4      8.79s      27.3      1.10     1.64x
   6      8.91s      26.9      1.11     1.62x
   8      9.19s      26.1      1.15     1.57x
```

**Read honestly, and the headline first: this is a real 1.64x, and it still
does NOT reach the owner's "under 1x the video's runtime."** It takes the
export from **1.81x** the video's runtime to **1.10x** — close enough to the
goal to see it, and not the goal.

### Why this is best-of-3, and why a single reading here was worthless

This matters more than the table. The first two sweeps of this fixture, run
minutes apart with identical code, disagreed **by 2x on the one-segment
baseline** — 24.24 s, then 12.38 s — and the second sweep even reported 6 and 8
segments as *slower than one*. Nothing about the code changed. Sibling build
agents on this machine come and go on a timescale **shorter than one sweep**
(load average was observed swinging between 15 and 64 during this work), so
each row of a single-pass sweep is timed under a different machine.

So the harness now runs `REPEATS = 3`, sweeping **every configuration inside
each repeat** (so drift lands on all of them roughly equally rather than
concentrating in whichever row was unlucky), and reports the **minimum** per
configuration. The minimum, not the mean, because every error source here is
additive and one-directional: another process can only ever make this render
slower, never faster, so the fastest observed run is the closest this harness
gets to the cost of the code itself — and averaging a contended run in just
launders someone else's build into our number. The spread that survives is
still large (repeat 3's four-segment run took 13.98 s against repeat 2's
8.79 s), which is exactly why the minimum is the one reported.

**The 1.64x above is therefore the conservative reading.** An earlier
single-pass sweep showed 2.04x; that number is not repeated here because it
was measured under a load spike on its baseline row and is not one this
harness can reproduce.

One caveat remains, pointing the other way: **this fixture is 1080p.** The
owner's real project is 4K, where decode is a much larger share of each frame
and therefore has more for segments to reclaim. An end-to-end measurement on
that project is still not done — it was already on phase 2's punch list and
still is.

### Why it plateaus at 4-6 rather than scaling to the core count

Worth stating, because "N segments on N cores" sounds like it should be linear
and is not:

1. **Phase 2 already spends every core inside a frame.** `rayon` puts ~41% of
   the compositing work (§9.5's Amdahl back-solve) across all ten cores at one
   segment. So segmenting is not claiming an idle machine — it is claiming the
   *serial remainder* (`image::imageops::resize`, the crop copy) and the decode
   term. That is a smaller prize than the core count suggests.
2. **A segment is not just a compositor.** Each one runs its own libx264 and
   its own decode `ffmpeg` per visible track, all competing for the same ten
   cores as the compositor. Past ~4 segments the machine is saturated and
   further segments buy context switching and one more cold start
   (`MIN_SEGMENT_FRAMES`) rather than throughput.
3. **Eight measured WORSE than four** (9.19 s vs 8.79 s), which is the same
   effect from the other side — and both independent sweeps agreed on that
   ordering.

**So `MAX_SEGMENTS` is 6, not 8.** Eight costs a third more concurrent encoders
and decode processes than six and buys no throughput at all on either
measurement — which is the wrong side of that constant's own memory argument
(`segments × (tracks + 1)`, the B-229/B-230 shape). Six keeps the whole
plateau. The 4K case is unmeasured, and every unknown there points the same
way: each segment's resident cost is four times larger at 4K, so if the bound
is wrong for 4K it is wrong in the direction of being too generous, not too
tight.

### What would be needed to actually reach <1x

Not speculation — these are the terms the measurements above name:

- **`image::imageops::resize` is still serial within a frame**, and §9.5
  already worked out why it stays that way: splitting it by output band needs an
  input halo whose weight normalisation `image` does not expose, and
  hand-rolling a bit-identical replacement is what CLAUDE.md's "check for an
  existing crate first" rule forbids. A maintained parallel resampler crate
  that is *provably* bit-identical would be the honest route.
- **The compositing is still on the CPU.** §2 records that D-350 phase 1 did
  not actually move compositing onto the GPU despite the decision's title; that
  remains the largest single unclaimed factor, and it is the one that would
  change the shape of this table rather than its constants.
- **Hardware encode.** Every segment encodes with libx264 on the CPU, competing
  with the compositor for the cores this phase is trying to spend on pixels.
  `h264_videotoolbox` per segment is a parameter away and is not in this phase.

## 10.6 Files (phase 3)

| file | what changed |
|---|---|
| `crates/apelles-media/src/decode_pipe.rs` | `PipeLane`, `PipeKey`, the `LiveEntry::Idle/Busy` pool, `check_out`/`Checkout`/`release_key`, `release_lane`; `playback_frame_scaled`/`retain_pipe_slots`/`sync_prefetch` take a lane |
| `app/src-tauri/src/chroma/edit.rs` | `render_timeline_frame`/`composite_video_frame`/`decode_clip_rgba`/`decode_clip_picture`/`prime` take a lane |
| `app/src-tauri/src/chroma/edit_render.rs` | `render_range` (the loop, parameterised), `render_segmented`, `plan_segment_count`, `segment_ranges`, `LaneGuard`, `SegmentedEncodePlan`, the token substitution; new tests + `measure_segmented_render_throughput` |
| `app/src-tauri/src/chroma/{commands,session,playback}.rs` | `PipeLane::LIVE` at the three live decode call sites |
| `packages/editor/src/timelinePipeExport.ts` | `segmentArgs`/`concatArgs`, the two tokens, `TimelineRenderPlan` |
| `packages/editor/src/{editorExport,exportQueueStore}.ts` | the render plan carries `segments`; three hand-copied shapes become one `TimelineRenderPlan` |
| `packages/editor/src/exportParityFixture.test.ts` | the segment argvs join the frozen fixture; three new cross-engine tests |

---

## 10.7 Equal frames are not equal work — the partition divides COST (D-373, 2026-10-09)

D-360 cut the N segments by **equal frame count**. §10.4 verified that partition
hard, and it is still exactly right about frame *accuracy* — but it is the wrong
quantity to equalise. A frame's cost is set by how many layers composite there
and what each one does: a span of stacked full-frame 4K camera decodes two or
three streams and composites them, while a span that is one flat graphics panel
decodes one and composites nothing at all (D-132/B-053's single-layer fast path
returns the plain decode). Because the concat waits on the slowest lane, the
export's wall clock is the straggler's.

**Measured on the real 98-clip 4K c038 project, after D-369 had already cut the
lane count from 6 to 3** (23 m 25 s total): final segment sizes
**[367, 361, 176] MB**, the third lane tracking at ~45 % of the other two for
the entire run. It never stalled — it had less costly content. That is B-234's
2026-10-06 profiling section's "lever 2", and this is it.

### The model

`app/src-tauri/src/chroma/render_cost.rs`. Pure, integer, and **from the
`Timeline` alone** — no decode, no `ffprobe`, no file opened (the one filesystem-
shaped input is `still::is_image_file`, a filename-extension test). It asks the
renderer's own `Timeline::resolve_visible_video_layers_at`, filtered by the
renderer's own `edit::layer_is_renderable` — extracted out of
`render_timeline_frame`'s inline closure, because a second copy of "which layers
are there" is precisely the two-implementations divergence D-350 exists to
remove — and charges each layer against the branch `composite_layer_onto` would
actually take:

| term | weight | what it is |
|---|---|---|
| frame base | 1 | the canvas fill, the RGBA hand-off, the encoder's per-frame work |
| video decode | 3 | `decode_pipe::playback_frame_scaled` + the RGBA convert |
| still / text layer | 0 | a hit in `apelles_media::still`'s or `chroma::text`'s cache |
| composite, fused | 1 | D-217's `blend_layer_sampled`, bounded by the canvas |
| composite, resized | 2 | the general path — a full intermediate buffer, then `overlay` |
| composite, rotated | 6 | `rgba8 → rgba32f → rotate → rgba8`: three full passes, one at 4× the bytes |
| adjustment clip | 1 | D-230's full-canvas per-pixel colour pass |

**3:1 for decode against composite is this document's own measurement**, not a
guess: §9.1 has 11.03 s of decode over 480 layer-decodes (23.0 ms each), and
§10.5's post-D-351 one-segment total of 14.45 s leaves ~3.4 s of compositing over
those same 480 layers (~7 ms each). §10.5's closing caveat — decode is a larger
share at 4K — says the ratio only grows on the footage this is for. The three
paint weights are asserted as an *order* at compile time so an edit cannot
silently invert the ranking the model rests on.

A lone layer with an identity transform is charged its decode and **no composite
at all**, which is the single-layer fast path; separating that frame from a
composited one is most of the model's value.

### What it does not know

Each of these is a decision, and the last one was found the hard way:

- **Keyframes and fades.** Static transform fields only. Resolving the real
  transform means parsing `chroma_keyframes` per keyframed layer per sampled
  frame — real time before the render starts — and the error it removes is one
  or two units on a layer whose transform crosses a branch boundary. The terms
  this model exists to separate are exact either way.
- **Source pixel size and whether a clip is graded**, which the real fast-path
  guard also tests. Both need I/O, so the estimate is optimistic by one
  composite unit on the cheapest frame in the render.
- **Codec, bitrate, compressibility.** A 4K ProRes decode and a 4K H.264 decode
  are one weight. This is the model's real limit.
- **How many PROCESSES a lane will need.** It costs work per frame; it does not
  know that moving a boundary into a region where more tracks have content makes
  that lane spawn more decode `ffmpeg`s. That is D-369's territory, and it is
  what the first version of the measurement below accidentally measured.

### The partition

`edit_render::segment_ranges` takes the cost curve instead of a frame count and
cuts the cumulative sum, keeping three properties:

1. **It partitions `0..frames` exactly.** §10.4's reason (the concat demuxer
   stitches whatever it is handed) plus D-362's (the progress tracker is built
   from these ranges, so the percentage is only a true fraction because they
   partition exactly).
2. **No segment below `MIN_SEGMENT_FRAMES`** while the render is long enough to
   allow it — a cut that handed a lane a handful of very expensive frames would
   spend more on its cold start than it saved on balance.
3. **A flat curve gives back the equal-frame split** to within one frame, so a
   uniform timeline partitions exactly as it did before D-373.

### Measurement — and what it could and could not show

**The sweep in §10.5 provably cannot measure this.** The 20-clip / 1080p /
240-frame stress fixture is **uniform**: every frame carries the same two layers
(a full-length base plus one of 20 back-to-back cuts), so its cost curve is
constant and the work-balanced split *is* the equal-frame split, frame for
frame. That is asserted, not inferred —
`the_stress_fixtures_cost_curve_is_flat_so_d373_cannot_move_its_split` fails the
day the fixture stops being uniform, at which point the sweep becomes able to
read D-373 and that test is the signal to go and read it. So the before/after
tables below are the same two renders on a differently-loaded machine:

```text
segs   before    after
   1   13.69s   10.76s
   2   10.41s    9.43s
   4   10.45s    9.03s
   6   10.85s    9.06s
   8   12.19s    9.40s
```

**A second harness, `measure_segmented_render_balance`, makes the fixture
lopsided out of its own media**: every clip covering the first half of the render
gets a 17° `rotation` (the dearest compositing branch), the second half stays on
the fused path. The model moves the two-lane cut from 120 to 92 and the
**estimated per-lane imbalance from 1.90x to 1.01x** ([2280, 1200] →
[1748, 1732] work units).

**Why rotation and not "fewer layers in the second half", which was the first
attempt.** Truncating a track changes how many decode processes each lane needs,
and changes it *differently for the two partitions*: the cost-based cut reaches
back into the stacked region, so its cheap lane spawns decoders the equal-frame
lane never had. That version measured the cost-based partition **consistently
5-6 % slower in every repeat** (9.75 s vs 10.30 s best-of-5) — D-369's
contention term, not noise. A true finding about the model (see "does not know"
above), and nothing at all about whether balancing work helps, because the two
partitions were not running the same number of processes.

**And then the wall clock still could not resolve it.** On the rotation skew the
run-to-run spread on the *identical* configuration was 9.28-17.02 s against a
2.4 s gap between the two partitions' minima — three times the effect. The
harness now says so itself: it compares each configuration's spread against the
gap and prints **INCONCLUSIVE** rather than a ratio when the spread wins, which
is §10.5's own lesson ("a single reading here is not a fact about this code")
turned into an assertion instead of a footnote.

**So: no wall-clock evidence that the balanced partition finishes sooner.** What
is evidenced is that the imbalance is real and was measured on the real project,
that the model identifies it, and that the partition removes it —
deterministically and under test, with two unit tests verified failing against
equal-frame splitting. **The real c038 A/B, and fitting these weights against
its per-lane timings, is what remains** (B-234 says so too).

### Files (D-373)

| file | what changed |
|---|---|
| `app/src-tauri/src/chroma/render_cost.rs` | new — the cost model, its weights and their rationale, 12 unit tests |
| `app/src-tauri/src/chroma/edit.rs` | `layer_is_renderable` extracted from `render_timeline_frame`'s inline filter |
| `app/src-tauri/src/chroma/edit_render.rs` | `segment_ranges` takes the cost curve; new `plan_segment_ranges`; 5 new tests + `measure_segmented_render_balance` + the fixture-flatness assertion |
| `app/src-tauri/src/chroma/mod.rs` | `pub mod render_cost;` and its line in the module map |

---

## 11. The GPU compositor plan (D-363) — scoped 2026-09-19, deliberately NOT built

§10.5 named the remaining term: *"the compositing is still on the CPU… that
remains the largest single unclaimed factor."* This section is a read-only
planning pass's output (no code or other docs were touched by that pass) —
captured here so the next session picks it up rather than re-deriving it. It
answers "what would it take" without spending the build. See **D-363** in
`docs/08-decisions.md` for the decision itself (options considered, why).

### 11.1 What's being ported — fully enumerated, not guessed

The CPU compositor (`app/src-tauri/src/chroma/edit.rs`) does exactly these
operations, and nothing else — **source-over blending only, no masks, no
other blend modes** (Colorist masks are stripped at LUT-bake time,
`edit.rs:38-40`), which is what makes this tractable:

1. opaque-black canvas init (`edit.rs:2410`)
2. reverse z-order paint walk (`:2413`), order resolved on the CPU
3. 3D-LUT grade per clip, **before geometry** (`grade_lut.rs:616` →
   `lut3d.rs:223`) — must use **manual trilinear fetches from a storage
   buffer**, not a hardware `textureSampleLevel` sampler, because hardware
   samplers quantise interpolation weights to 8-bit fixed point and would
   silently diverge from `Lut3d::sample_trilinear`'s f32 math
4. integer crop rect from normalised insets (`:2477-2487`)
5. placement box size, `effective_size` (`:1974`, used `:2652`)
6. bilinear **magnify**, crop-relative taps (`blend_layer_sampled`,
   `:2899-2948`)
7. Triangle **minify**, separable two-pass (`image::imageops::resize`,
   `:2715/2720`) — **the hard parity target**; §9.5 already found this
   library does not expose its weight normalisation, so byte-exactness in
   WGSL is not guaranteed and must be measured, not assumed
8. rounded-corner SDF coverage × alpha (`corner_coverage`, `:2526`), applied
   after scale, before rotate
9. rotation about the crop's centre, rgba32f/bilinear/transparent border
   (`:2758-2769`)
10. opacity alpha multiply (`:2771-2779`)
11. source-over blend (`overlay_parallel` = `image::Rgba::blend`, `:235-260`,
    `:2969-2973`) — **truncates, does not round** (`as u8`)
12. placement at `round(position * canvas)` (`:2794-2796`, D-338's top-left
    convention)
13. the adjustment-clip colour op on the whole canvas (`:2443` →
    `AdjustmentOps::apply_rgb8`, `adjustment.rs:340`) — **floors to u8
    between its two stages** (`:343-344`); a "cleaner" full-precision f32
    shader would diverge by design
14. generated colour plates / dip-to-colour (`:2286-2298`)
15. pre-rasterised text/caption layers (`:2331-2345`, `:1376`) — stay
    CPU-rasterised, uploaded as cached textures, not re-derived on the GPU

**Deliberately out of scope:** the live preview (stays byte/thread-identical
— D-351 §9.4 is the precedent for why reaching into preview scheduling from
an export change breaks things), the single-layer plain-decode fast path
(`:1268-1306`, keep it — uploading/reading back an already-correct frame
would be a regression), GPU decode, hardware encode (separate wave, changes
output bytes), and deleting the CPU compositor (it stays as the parity
reference, permanently).

### 11.2 Where it lives: a new crate, `crates/apelles-compositor`

Not inside `apelles-gpu` — that crate is L0 and must stay a thin
`init_gpu_context()` shell per its own README and architecture-lock's
rebuild-time principle. The name and slot are already reserved in
`crates/README.md:20`, `docs/03-architecture.md:138`,
`docs/notes/architecture-lock.md:45`. Legal dependency chain: `app (L4) →
apelles-compositor (L1) → apelles-gpu (L0) → apelles-types (L0)`. It needs
only `apelles-gpu` (device) and `apelles-types` (`Lut3d`, `AdjustmentOps`,
already L0) — **not** `apelles-media` or `apelles-grade` as
architecture-lock's own table predicted, and not `apelles-timeline` (L2,
would be an illegal upward edge). **That prediction was wrong and D-363
corrects it — record the correction, same as D-143/D-146/D-148 each did.**

The crate takes a pure `FramePlan { canvas, steps: Vec<Step> }` /
`Step::{Paint{source, place}, Adjust(AdjustmentOps)}` descriptor — no
timeline/app types cross the boundary. `edit.rs` gains exactly one
`ClipTransform + natural → Placement` conversion, reusing
`crop_pixel_rect`/`effective_size` unchanged, so the geometry math still has
exactly one implementation (the D-350 rationale, applied at this new
boundary rather than undone by it — the single gravest risk here is
re-deriving geometry inside the shader and recreating the bug class D-350
exists to close).

Wired as a **third `renderer` value, `"gpu"`**, alongside the existing
`'filter' | 'compositor'` (`editorExport.ts:98,264-272,423-454`,
`mcp/schemas.py:390`, `crates/apelles-mcp/src/tools/edit.rs:873,3962,3989`).
Same pipe protocol, same argv shape — only who fills the RGBA buffer
changes. `'compositor'` stays the default until parity + throughput evidence
is in.

### 11.3 The honest bandwidth arithmetic

At 4K, canvas readback alone is 3840×2160×4 = 33.2 MB/frame; at ~24fps that's
~0.8 GB/s — fine on Apple Silicon's unified memory, **but only if pipelined**
with a bounded staging-buffer ring (the same shape as `WRITE_AHEAD`,
`edit_render.rs:119-134`). A naive synchronous `device.poll(PollType::Wait)`
per frame (the pattern that's correct for `gpu_processing.rs`'s one-off
screenshot readback, wrong here) would fully serialise CPU/GPU and hand the
whole win back — the single biggest way this effort could make export
*slower*, not faster.

**Modelled, not measured:** if the real 4K project's ~100ms/frame splits like
the 1080p fixture (composite ≈ 2/3), swapping ~67ms of CPU compositing for
~6ms of GPU upload+dispatch+readback predicts ~39ms/frame ⇒ ~219s for the
233.5s test video ⇒ **~0.94x**. That clears the <1x goal with *no margin* —
which is exactly why the plan puts a measurement wave *before* any GPU code:
if the real split turns out closer to composite-40%/decode-40%/encode-20%,
the GPU compositor alone cannot reach <1x and hardware encode has to be
pulled forward.

### 11.4 Five waves (each independently commit-able and verifiable)

0. **Measure first (Sonnet, blocking gate).** Per-phase timing (decode / LUT
   / composite / resize / readback / encoder-wait) on the *real* 4K/79-clip
   project, per segment — `measure_render_throughput` currently reports only
   a total. This is also B-234's own missing root-cause measurement. If
   composite is under ~45% of real wall time, say so and resequence hardware
   encode ahead of the GPU compositor.
1. **The crate + op kernels (Opus).** `apelles-compositor`, WGSL for ops
   3/6/7/8/10/11/13 above, not wired into anything yet. Op-level parity
   tests, byte-exact where the CPU op is byte-exact (source-over, the
   adjustment operator's floor, the LUT's manual fetch) — the frame-level
   diff metric (`GROSS_DIFF_CHANNEL = 24`) deliberately ignores ±1 LSB drift,
   so these op tests are what actually catch rounding divergence.
2. **Frame assembler + opt-in wiring (Opus).** `FramePlan`/`Placement`, the
   one `ClipTransform → Placement` conversion, `renderer: "gpu"` through
   both MCP surfaces **and the export-dialog GUI control in the same
   commit** (CLAUDE.md's human-AND-AI rule). Frame- and video-level parity
   against the CPU path (`export-parity.json`, same methodology as §10's
   segment work). Performance is explicitly NOT claimed in this wave.
3. **Make it fast (Opus).** One device + one pipeline cache per render
   (never process-lifetime — mirrors `BakeSession`'s own reasoning,
   `grade_lut.rs:95-103`), a texture pool, an async staging-buffer ring, a
   text/caption texture cache, and a re-decision of `MAX_SEGMENTS` now that
   the GPU is a second shared resource segments compete for. This is the
   wave that either reaches <1x or produces the honest number for what's
   still missing.
4. **The remaining terms (Sonnet), sequenced by wave 0/3's data.**
   `h264_videotoolbox` per segment, optionally `nv12`/`yuv420p` from
   `decode_pipe` so colour conversion also moves to the GPU. Both change
   output bytes — parity moves to the picture-level tolerance D-360 already
   established for a different encoder, not byte-exactness.
5. **The live preview.** Explicitly deferred, needs its own decision — D-351
   §9.4's scar tissue about reaching into preview scheduling applies again.

### 11.5 Named risks and their catchers

Triangle-minify not matching `image`'s weight normalisation (caught by the
op-level test; fallback is CPU-only minify through wave 2, moved in wave 3
with its own measurement) · intermediate-quantisation mismatches in the
adjustment operator and source-over blend, invisible to the frame metric
(caught by byte-exact op tests) · hardware LUT-sampler quantisation (caught
by the LUT op test; mitigated structurally by manual fetches, never
`textureSampleLevel`) · readback becoming the new bottleneck (caught by wave
3's phase timing; mitigated by the bounded staging ring) · VRAM/unified-memory
pressure at 4K × N segments, the same unbounded-per-unit-cost shape as
B-229/B-230 one layer down (caught by extended resource measurement;
mitigated by one device + one bounded pool + re-deciding `MAX_SEGMENTS`) · a
third long-lived wgpu device alongside `image_processing::GpuContext` and
`BakeSession` (mitigated by construction — created per render, dropped at the
end) · the `wgpu = "29.0"` pin (`app/src-tauri/Cargo.toml`, downgraded to
avoid a P3 colour shift on Apple devices) — any dependency forcing wgpu 30
reintroduces that bug, hard constraint on every dep choice · cross-device
non-determinism, since CPU IEEE-754 gives cross-machine byte-identity and a
GPU does not — CLAUDE.md's determinism invariant becomes a *per-device*
guarantee for this path, stated as an accepted scoped weakening, not
discovered later · GPU hang/device loss mid-export — every poll needs a
timeout and the export must fail loudly, never silently fall back to CPU
mid-render (which would ship one file composited two different ways) ·
losing the single-layer fast path if `renderer: "gpu"` routes every frame
through upload+readback regardless (mitigated by keeping `edit.rs:1268-1306`
intact and asserting it still triggers under the GPU renderer).

### 11.6 Dependency check done, so it isn't redone

Per CLAUDE.md's "check for an existing crate before hand-rolling" rule:
**Smelter** (`software-mansion/smelter`) isn't usable — its render crate
isn't published on crates.io, it's a workspace-internal piece of a media
*server* with its own decode/encode pipeline. **Vello**
(`linebender/vello`, Apache-2.0/MIT, wgpu `^29.0.3` compatible with our pin)
is genuinely maintained but is a vector-path renderer whose image
resampling/AA/blend semantics are its own — adopting it would turn "does the
GPU match the CPU" from a check into a re-derivation, and it does nothing
for the 3D-LUT grade or the adjustment operator (custom shaders either way).
**rosace-compositor** (0.1.0, ~70 downloads) isn't a real dependency
candidate. The operation set here is small, fixed, and fully enumerated
above (§11.1) — CLAUDE.md's own carve-out ("a genuinely small, stable need
loses to a dependency") applies; hand-rolling these specific WGSL kernels
against the CPU path as ground truth is the right call, not a shortcut
around the rule.

---

# 12. Progress and the stall watchdog (D-362, 2026-09-19 — fixes B-231)

Phases 1-3 made the export correct, memory-flat, parallel and segmented. None
of them made it **observable**, and B-231 is what that cost: an export you
cannot tell the state of is not one you can run blind, which is the only way an
agent ever runs one.

B-231 is a single bug with two opposite symptoms, and the export had both:

- **the false negative** — `editor_export` blocks on a frontend round trip with
  a fixed 20 s `BRIDGE_TIMEOUT`, and a real 4K export takes minutes, so a
  healthy export reliably answered `{"ok": false}` and then went on to succeed;
- **the false positive** — a render task hung internally while the `apelles`
  process stayed healthy (`editor_get_state` kept answering `"ready"`), its
  `ffmpeg` child blocked at 0% CPU on a starved stdin, the output file frozen
  mid-write with no `moov` atom. Nothing reported anything, ever.

## 12.1 The progress value — why the frame fraction, and why counted where it is

D-360 changed the question phase 2 left behind: progress is now a sum over N
concurrent workers, not one counter.

**The primary number is `framesWritten / framesTotal`, summed across every
segment — and it is exact, not an estimate.** `segment_ranges` partitions
`0..frames` with no hole and no overlap (§10.4 already pins that, because the
concatenated output's frame accuracy rests on it), so the sum over workers is a
true fraction of the whole render however they interleave in time.

What was not chosen, and why:

| option | why not |
|---|---|
| segments done / total, alone | `0/1` then `1/1` for the entire single-stream path — no progress at all for exactly the cheaper exports. Even at six segments it moves six times in several minutes. |
| parse `ffmpeg`'s stderr | what the OLD filter path had to do, and what D-350 exists to stop doing. With N concurrent encoders it is now N stderrs. |
| an event per frame | rejected on the bug's own terms: the caller asks this question **after** its op already timed out, when every event it might have received is gone. Same reasoning as D-359 for `motion_render`. Polling is also this repo's existing shape (`chroma_export_progress`). |

**Reported alongside it, not instead of it:** `segmentsDone`/`segmentsTotal` and
a row per segment. The percentage alone cannot tell four segments evenly at 78%
from three finished and one wedged at 12% — and the second is exactly the
situation B-231 was filed about.

**A frame counts when it is WRITTEN to the encoder, not when it is
composited.** That is the most downstream point this path controls, so one
counter freezes whether the compositor stalled, the `WRITE_AHEAD` channel
jammed, or the encoder stopped reading — which is what lets the progress number
*be* the watchdog's heartbeat rather than needing a second liveness signal. It
can only under-report, by at most the `WRITE_AHEAD` frames in flight.

**The ETA is the max over unfinished segments, not the aggregate rate**, because
a segmented render ends when its slowest worker does; the aggregate rate
systematically under-estimates the tail as earlier segments retire.

## 12.2 Where the answer is served from

`editor_export_status` is answered **natively** by the control server
(`chroma::control`'s `native_op`, the `ai_env_status` precedent from D-210),
not relayed to the frontend like the `editor_detect_*_status` family it
otherwise copies. Those detectors' work really is frontend-driven, so their
status honestly lives there. This render runs in Rust, so Rust is where its
numbers already are — and relaying them would put a second copy of the truth
behind exactly the round trip that has already failed.

`editor_export` itself also stops returning the false negative: on
`renderer="compositor"` both MCP surfaces poll past the bridge timeout and
return the render's own settled outcome. Facet 1 is removed from the surface,
not documented around.

## 12.3 The watchdog

One thread per render, checking each unfinished segment's last-frame time every
500 ms.

**`STALL_TIMEOUT = 120 s`, sized from the measurements with a deliberately wide
margin.** This path renders at 37-60 ms a frame at 1080p (§10.5) and roughly
four times that at 4K; its slowest legitimate single frame is a segment's cold
keyframe seek per visible track (248-337 ms, median 723 ms). Two minutes is more
than an order of magnitude above the worst honest case — on purpose, because the
one condition that actually coincided with B-231's hang was severe memory
pressure (swap at ~9.3/10 GB from an unrelated build), and under deep swap an
honest frame can take tens of seconds. **A watchdog whose false alarm kills a
healthy 4K export would be worse than the bug it is here to catch.**

**It kills the encoder, because nothing else can free the stall it catches.**
The wedged thread is inside `write_all` on a pipe whose reader has stopped;
a blocking pipe write has no timeout and no interrupt, so the reader has to go
away. That needs `shared_child` (MIT, already in the tree via
`tauri-plugin-shell`): `std::process::Child::kill` takes `&mut self`, and
killing by raw pid races with the `wait` that reaps it.

Every previously unbounded `wait` on this path is bounded now (`wait_bounded`),
the concat step included — so the "took EOF and then never exited" variant
cannot hang silently either. The watchdog's verdict outranks the downstream
error its own kill produces: a killed encoder surfaces as a broken pipe, which
names the symptom and not the cause.

## 12.4 Proving it — a watchdog that cannot be shown to fire is not a fix

`a_stalled_encoder_is_killed_and_reported` builds a **genuinely** stuck export
out of a real `ffmpeg`, rather than simulating one. `-re` makes ffmpeg read its
input at the input's declared rate, so `-framerate 0.02` is one frame every 50
seconds: once the kernel pipe buffer and `WRITE_AHEAD` fill, the writer blocks
and stays blocked — facet 2's exact shape, with the child alive and near 0% CPU.

Measured before the test was written, to confirm the fixture really does stall:
**5 frames in 59.6 s**, the writer blocked for the whole of it.

| pinned by | what it pins |
|---|---|
| `a_stalled_encoder_is_killed_and_reported` | a real stalled `ffmpeg` is caught, killed and named — the call returns in **5.5 s** against the test's 4 s budget (per-job, which is the only reason this is a test and not a two-minute one), and the status reads `stalled` with the segment, its frame range and the warning that the file is unusable |
| `the_status_advances_while_a_real_render_is_in_flight` | progress sampled from a second thread **during** a real render moves, never goes backwards, and lands exactly on `framesTotal` / 100% |
| `the_watchdog_fires_on_a_silent_segment` | the watchdog at unit level: one worker keeps writing, one goes quiet, the quiet one is the one named |
| `a_finished_segment_is_not_watched` | a completed segment does not trip the watchdog while its siblings run on |
| `progress_sums_across_concurrent_segments` | the sum is a true fraction whatever order out-of-order workers advance in |
| `a_second_export_is_refused_while_one_runs` | one render at a time — two would overwrite each other's counters and double the `segments × (tracks + 1)` budget `MAX_SEGMENTS` bounds |
| `exportQueueStore.test.ts`'s two D-362 cases | the dialog follows a compositor job's real progress, ignores a stale `jobId` from the previous export, stops polling when the job settles, and never polls a filter-graph job |

## 12.5 What is still not covered

**The `"filter"` renderer reports no progress and cannot.** It hands the whole
job to one ffmpeg and learns nothing until it exits; the only way to know where
it is would be parsing that stderr, which is the thing D-350 exists to stop
doing. `editor_export_status` answers `idle` for such an export rather than
guessing, and both tool descriptions say so outright.

## 12.6 Files (D-362)

| file | what changed |
|---|---|
| `app/src-tauri/src/chroma/export_status.rs` | **new** — `ExportJob`/`ExportStatus`/`ExportState`, the counters, `STALL_TIMEOUT`, the watchdog thread, `snapshot()`, `chroma_editor_export_status` |
| `app/src-tauri/src/chroma/edit_render.rs` | `render_range` takes the job + its segment index (the abort flag moves onto the job), the encoder becomes a `SharedChild`, the writer ticks the counter per frame, `wait_bounded`, the partition is derived once in `render_timeline`, `TimelineRenderRequest.output`; two new real-ffmpeg tests |
| `app/src-tauri/src/chroma/export.rs` | `drain_stderr_pipe` split out of `drain_stderr`, so a `SharedChild`'s stderr uses the same drainer |
| `app/src-tauri/src/chroma/control.rs` | `editor_export_status` as a native op |
| `app/src-tauri/{Cargo.toml,src/lib.rs}` | `shared_child`; the new command registered |
| `mcp/server.py`, `crates/apelles-mcp/src/tools/edit.rs` | `editor_export_status`; `editor_export` polls past the bridge timeout on the compositor path; both descriptions rewritten |
| `packages/ui/src/components/ui/progress.tsx` | **new** — shadcn `progress` on Base UI (D-042) |
| `packages/editor/src/editorExport.ts` | `TimelineExportStatus`, `readTimelineExportStatus`, `runCompiledExport` passes the output path |
| `packages/editor/src/exportQueueStore.ts` | `ExportJob.progress`, `followProgress` and its stale-`jobId` guard |
| `packages/editor/src/EditorExportDialog.tsx` | `JobProgress` — the real bar, percentage, frame and segment counts, ETA |

---

# 13. B-380 (2026-11-03): where the 4K time goes, the hardware encoder, and the GPU plan updated

**Decision:** D-446 (VideoToolbox encode by default). **Numbers:** `docs/perf/README.md` "Export" and
`docs/perf/2026-11-03-export-benchmark-report.md`. **Harness:** `app/src-tauri/src/chroma/export_bench.rs`
(`measure_export_benchmark`, `#[ignore]`d), fixture `tests/fixtures/export-bench.json` from
`packages/editor/src/exportBenchFixture.test.ts`.

§11.4 wave 0 asked for a per-phase measurement before any GPU code. This is that measurement, on a synthetic
60 s explainer-shaped timeline rather than the owner's project (the task allowed fixtures only), with grain and
motion so the encoders do real work. The renderer now reports its stages itself (`RenderStages` on
`TimelineRenderOutcome`: decode + composite, resize, waiting on the encoder, concat, loudness), so the split no
longer has to be inferred from totals.

## 13.1 What the split said

At 4K with libx264 (2 segments, 4.06x real time), the two workers spent **109 s blocked handing frames to the
encoder** against 329 s in decode + composite. §11.3 modelled that encode would be ~20%. It was larger than
that, so wave 4's hardware encode was pulled forward and done first (D-446). With VideoToolbox the wait drops
to 2 s and the export to **1.38x**. The resize term is **0**: `canvas_plan` composites straight at the output
size whenever the aspect ratio matches, which every fixture case does.

## 13.2 What is left at 4K, measured

- **Segments do not scale past 2 at 4K.** 2 → 1.37x, 3 → 1.76x, 4 → 1.64x, 6 → 1.99x, with CPU at 50–58%
  throughout. Per-worker frame time grows with the lane count, so the shared limit is the decode pipes and
  memory bandwidth (each lane reads 4K RGB frames, about 25 MB each, through a pipe), not cores. The planner's
  answer (2 for this 3-video-track timeline) is the fastest measured.
- **A `sample` profile of the hardware-encode render** (15 s, single lane, busy samples only): `blend_layer_sampled`
  about 58%, `read` on the decode pipes about 28%, writes to the encoder about 10%, `to_rgba8_parallel` about 2%.
  That run measured 3.92x at 1 lane against 1.37x at 2. Part of that gap is the profiler pausing the process and
  a load average above 30, so the 1-lane number is a profile, not a floor.
- **The decode floor** for one 4K track (VideoToolbox → rgb24 pipe, the `decode_pipe` shape) is 18.7 s per
  60 s, 0.31x. Two overlapping tracks put about 0.5x of the budget in decode before any compositing.

## 13.3 What would reach under 1x, in order of measured payoff

1. **Make the compositor the default renderer.** The Export panel and `editor_export` default to the filter
   path (`DEFAULT_EXPORT_RENDERER = 'filter'`), which at 4K is 2.46x even with hardware encode and 2.36x with no
   encoder at all. Its `-threads 1` per input and `-filter_complex_threads 2` (B-229/B-230 memory caps) hold it
   to 21% CPU. The compositor path is 1.38x on the same timeline. What blocks the flip is D-350 phase 1's
   refusals (`speedOverrides` / `fitOverrides` / `freezeOverrides`, the panel's "Clip exceptions"). An
   automatic fallback to the filter path when those are set would be a small change, but it changes which
   pixels the default export draws, so it is the owner's call.
2. **§11's GPU compositor, waves 1–3.** It removes the ~58% blend share. Under §11.3's own bandwidth arithmetic
   (pipelined readback, ~6 ms per 4K frame), the model is: the 2-lane render's ~45 ms per frame of wall time
   minus most of its blend share is about 25–30 ms, about 0.8x. That is modelled, not measured, the same caveat
   §11.3 carries.
3. **`nv12` out of `decode_pipe`** (wave 4's second half): half the pipe bytes of rgb24, and the conversion moves
   to the GPU with the compositor. This goes after 2, because it only pays once the compositor runs on the GPU.

Hardware encode (D-446) is wave 4's first half, done. It changes output bytes, and parity is measured at the
picture level (PSNR 44–47 dB, SSIM 0.988–0.992 against the libx264 file on the same path), as §11.4 wave 4
said it would be.

---

# 14. D-448 (2026-11-03): one renderer — the parity check, the Clip exceptions, and what grading carries

**Decision:** D-448. **Numbers:** `docs/perf/2026-11-03-export-parity-report.md`.

## 14.1 The check

Copies of three of the owner's projects were exported both ways through the real compiler with the same
encoder, and compared per frame and per sample (the harness, `export_parity_real`, is in history at the
commit before D-448's). The sound, length, A/V offset and loudness were identical in every case. Every
picture difference above encoder noise was the filter path drawing something other than the Edit preview
(three projects), the filter path failing outright, one-frame clip-end / mixed-rate conventions, or a
compositor defect (B-382, fixed). §13.3's step 1 is therefore done, and with the owner's direction ("I don't
wanna keep multiple paths") the filter path is deleted rather than kept behind a switch.

## 14.2 The Clip exceptions, as layer data

`clipExceptions.ts` writes the export-time exceptions onto the copy of the timeline the export draws, and the
compiler sends that document with the render request (`TimelineRenderRequest.timeline`):

| Exception | Clip data | Where the compositor reads it |
|---|---|---|
| speed override | a one-run `speed_points` ramp | `Clip::source_frame_at`, `Clip::end_frame_at` (and the audio compiler's `resolveSpeedSegments`) |
| Stretch to fill | `Clip.stretch` | `ClipTransform::effective_size` (height = uncropped `natural.1 × scale`) |
| Hold last frame | `Clip.hold_until_frame` | `Track::held_clip_at`, from `Track::push_layers_at` only (the mixer's `clip_at` is unchanged) |

All three are inputs to the shared layer model (`VisibleLayer`, `ClipTransform`), so D-363's GPU blend gets
them with no work of its own. Functions changed for that merge: `Track::push_layers_at` (one line: the held
clip when nothing covers the position), `Track::held_clip_at` (new), `Track::duration` (counts a hold),
`Clip::source_frame_at` (B-382's floor), `ClipTransform::effective_size` (`stretch`), and the
`ClipTransform` literals (`stretch` field). Nothing in the blend or the layer drawing was touched.

**Known cost.** A speed change or a held frame on a 4K source makes the decode pipe seek per frame
(18–41 s for 3 s in the check). The fix belongs in `decode_pipe`: stream through a constant-speed run, and
hand back a held frame from the last decode instead of seeking.

## 14.3 What grading carries

Both renderers applied the same per-pixel lattice (D-256), so nothing was lost by deleting one. Measured:
the lattice equals the grade shader on flat colour within 3 codes. Not carried, and now said in the Export
panel before Export, in `editor_get_grade_status` and in the capabilities note: masks, the Colorist crop,
relight, the neighbourhood / position effects (left out of the bake since B-381 instead of mis-baked), and
the local part of contrast / shadows / highlights / whites / blacks. Against the Colorist's own render of a
real frame both exports measured about 20 dB, partly that local part and partly a warmer cast not yet
root-caused (B-381, open). **The real fix for all of it is to run the grade shader per frame instead of a
LUT, which is what a GPU compositor makes affordable** — it belongs with D-363's waves, not in the CPU blend.

---

# 15. D-449 (2026-11-03): one GPU render engine for the preview and the export — as built

**Decision:** D-449 (supersedes D-363's shape). **Crate:** `crates/apelles-compositor` (README there).
**App side:** `chroma::gpu_compositor` (the process's one engine), `chroma::edit::paint_layer` (the one
`ClipTransform` → pixels conversion), `chroma::edit::composite_video_frame` (builds the frame plan).
**Numbers:** `docs/perf/README.md` "Export"; raw logs summarised in §15.6.

## 15.1 What changed from the §11 plan, and why

§11 planned a GPU compositor as a third `renderer` value, opt-in, with the CPU compositor kept as the
default and as a permanent reference, built in five waves, the live preview excluded. The owner set a
different shape the same day the work started: one engine, no second path, preview included ("I don't
wanna keep multiple paths"; "finish it end to end"). That is the Final Cut Pro / Resolve / Premiere
pattern: one image engine for playback and export, hardware decode and encode around it. So:

- **No `renderer: "gpu"`, no GPU/CPU control** in Export or in `editor_export`. There was nothing to add
  to either MCP surface; the tool count is unchanged.
- **No CPU fallback.** A GPU error is an error; the engine is reopened for the next frame.
- **The preview moved in the same change**, because it is the same function: `composite_video_frame` is
  what the Edit preview, the Colorist's framed clip (via `composite_layer_onto`) and every export segment
  call. §9.4's concern (export parallelism slowing the preview's decoders) does not apply: the GPU path
  takes no CPU cores.
- **The CPU blend is deleted** (`blend_layer_sampled`, `overlay_parallel`, `to_rgba8_parallel`,
  `apply_adjustment_to_canvas`, the CPU rotation and resize in `composite_layer_onto`,
  `grade_lut::apply_to_rgba`, the CPU caption overlay). It lived on only as a test oracle
  (`chroma::compositor_parity`) until the parity below was measured, and then went too.

What §11 got right and was kept: the crate, its L1 slot and dependencies (`apelles-gpu` + `apelles-types`
only), the fully enumerated op list (§11.1), manual LUT fetches, the geometry staying in `edit.rs`, and
the dependency check (§11.6: no library fits).

## 15.2 The shape

```
chroma::edit (what to draw)                     apelles-compositor (how to draw it)
  render_timeline_frame(_deferred)
    resolve layers, keyframes, fades, ──▶ FramePlan { canvas, background,
    transitions, grade lattice, text,          steps: [Paint(Layer) | Adjust(ops)], captions last }
    captions; paint_layer() turns a                 │
    ClipTransform into crop / box /                 ▼
    origin in canvas pixels              Engine::submit → PendingFrame ──wait──▶ RgbaImage
                                            (prepare, sample | resize_v → resize_h → rotate → overlay,
                                             adjust; one command buffer, one submission per frame)
```

- **Preview:** `timeline_frame` → `render_timeline_frame` waits at once and JPEG-encodes, as before.
- **Export:** `edit_render::render_range` calls `render_timeline_frame_deferred` and sends the frame, still
  on the GPU, to its encoder-writer thread, which waits for it, resizes when the output's aspect differs,
  and writes. The worker decodes frame N + 1 while the GPU draws frame N. `WRITE_AHEAD` (4) still bounds
  what is in flight.
- **The single-layer plain-decode fast path stays**: a lone untransformed, ungraded, uncaptioned clip
  that is the whole composition is returned as decoded, with no upload. A frame with a caption now goes
  through the engine (captions are its top layers).

## 15.3 How each step matches the CPU compositor

Everything that depends only on the layer's geometry is computed on the CPU with the CPU compositor's
own expressions, and uploaded (`tables.rs`); the GPU does only per-pixel sums and the blend. Rust rounds
half away from zero, WGSL's `round` rounds half to even, so the kernels use their own `round_half_up`.

| step | CPU (deleted) | GPU kernel | what is exact |
|---|---|---|---|
| RGB → RGBA | `to_rgba8_parallel` | `prepare` | exact |
| grade | `grade_lut::apply_to_rgba` (`Lut3d::apply_rgb8`) | `prepare`, manual trilinear from a storage buffer | within 1 code value (f32 FMA) |
| crop | sub-image / clamped taps | crop rect from `crop_pixel_rect` | exact |
| magnify / 1:1 (fused) | `blend_layer_sampled` | `sample`; taps and fractions from `tables::sample_tables` (the CPU's f64 expressions) | 1:1 exact; magnify within 1 |
| minify (general) | `image::imageops::resize` Triangle | `resize_v` → `resize_h`; weights from `tables::triangle_weights` (image 0.25's f32 algorithm) | within 1 |
| rounded corners | `corner_coverage` (the shared SDF) | the same SDF in f32 | within 1 at the AA edge |
| rotation | `imageproc::rotate_about_center` bilinear, rgba32f | `rotate`; matrix from `tables::rotation_inverse` (imageproc's f32 product) | within 1 |
| opacity | alpha × opacity, rounded | same, in `sample` / `overlay` | exact |
| source-over | `image::Rgba::blend` (straight alpha, truncating) | `prelude.wgsl` `blend` | within 1 (division rounding) |
| adjustment clip | `AdjustmentOps::apply_rgb8` (f64, floor between stages) | `adjust`; stage 1 as tables, stage 2 fixed-point | exact except 2.4e-5 of RGB inputs, by 1 |
| captions | `image::imageops::overlay` after compositing | a top layer, 1:1 | as source-over |

## 15.4 Parity, measured against the CPU compositor (before it was deleted)

`chroma::compositor_parity` (test-only while it existed): 1920×1080, textured sources, each plan drawn by
the GPU engine and by the CPU compositor moved verbatim into the test module. Metrics: PSNR over RGB,
SSIM of BT.709 luma (8×8 windows, stride 4), the largest channel difference, and the share of pixels
with any difference. **Threshold: max 2 code values, PSNR ≥ 50 dB, SSIM ≥ 0.999.**

```text
effect                                                                   PSNR dB     SSIM   max  differing
1:1 full-frame layer                                                   identical 1.000000     0    0.0000%
magnify 1.73x, fractional position                                        111.30 1.000000     1    0.0001%
magnify + crop + opacity 0.6                                               69.42 0.999967     1    2.1880%
rounded corners (fused path)                                               88.56 1.000000     1    0.0278%
minify 0.31x (Triangle)                                                    91.64 1.000000     1    0.0133%
minify + crop + rounded + opacity (general path)                           95.14 1.000000     1    0.0083%
rotate 17° (magnified)                                                     94.40 1.000000     1    0.0149%
rotate -33° + minify + rounded + opacity                                   85.91 0.999999     1    0.0520%
alpha layer over picture (a title)                                         77.60 0.999988     1   15.3871%
dip-to-colour plate at 0.42                                                77.00 1.000000     1    0.3893%
grade (33³ lattice), 1:1                                               identical 1.000000     0    0.0000%
grade + magnify + rounded                                                 116.07 1.000000     1    0.0012%
adjustment clip                                                        identical 1.000000     0    0.0000%
full stack (base, graded PIP, slide, rotated card, title, adjustment)      59.48 0.999493     2   11.0180%
```

The differences are one-code-value rounding flips, in two places: the blend's division (the title and
translucent cases differ on many pixels by 1) and fused multiply-adds in the interpolation. The full
stack reaches 2 where one layer's ±1 lands under another's blend. There is no displaced edge or wrong
region anywhere: the old-vs-new export test, which erodes one-pixel lines away
(`render_path_matches_the_filter_graph_path_pixel_for_pixel`, §5), read exactly what it read in 2026-09
(worst 33.4 dB on the known fractional-x boundary, SOLID 0.0000% on every frame) with the GPU engine
drawing the compositor side, before D-449 deleted the filter path and that test with it.

Engine-level tests that remain (`cargo test -p apelles-compositor`): a 1:1 opaque layer and an RGB source
are byte-exact; a plate blend equals `image`'s own `blend` exactly; the adjustment against `apply_rgb8`
on all 2^24 RGB values (≤ 1, on at most 2.4e-5 of channel values); the grade within 1 of
`Lut3d::apply_rgb8`.

## 15.5 Determinism

No atomics, no reductions, one write per output pixel, fixed summation order. Pinned by:
`a_frame_renders_to_the_same_bytes_every_time` (crate: six repeats and four threads at once),
`a_frame_dropped_unread_does_not_poison_the_next_one` (a dropped in-flight frame cannot leak a mapped
buffer into the next), and in the app `the_compositor_is_deterministic_across_runs`,
`rendering_the_same_frame_twice_produces_identical_bytes`, `a_frame_is_the_same_in_any_decode_lane` and
the segmented-vs-single-stream video test, plus `a_graded_frame_hashes_the_same_every_time` (`chroma::gpu_compositor`): a graded full-stack frame hashed `0438176df4831369` on every
run on the M4. Per device, as D-363 said it would be.

## 15.6 Speed, measured

`measure_export_benchmark` (§13's fixture: 60 s, 3 video tracks, 15 clips, grain and motion), compositor
path, hardware encode, the planner's segment count (2 on this machine), same machine and session for
before and after. M4, 10 logical cores, shared with other agents' builds (load average 5–16 during the
runs; best of 2 for the after).

| | 1080p before (CPU) | 1080p after (GPU) | 4K before (CPU) | 4K after (GPU) |
|---|---|---|---|---|
| **× real time** | 0.23× | **0.23×** | 1.39× | **0.82×** |
| render wall | 13.4 s | 13.1 s | 82.0 s | 47.6 s |
| worker time, decode + composite (summed over 2 workers) | 22.9 s | 23.0 s | 144.1 s | 86.4 s |
| └ of which decode + frame set-up | — | 17.9 s | — | 70.0 s |
| └ of which GPU record + upload | — | 5.1 s | — | 16.4 s |
| GPU wait (writer threads, overlapped) | — | 2.1 s | — | 7.8 s |
| read-back (writer threads) | — | 1.3 s | — | 4.3 s |
| frames through the engine / bytes up / bytes down | — | 960 / 10.1 GB / 8.0 GB | — | 960 / 40.4 GB / 31.9 GB |
| waiting on the encoder | 1.1 s | 1.4 s | 2.6 s | 3.0 s |
| CPU (of 10 cores) / GPU busy | 55% / 13% | 57% / 35% | 49% / 12% | 54% / 36% |
| peak memory over the host | 2.5 GB | 2.6 GB | 3.7 GB | 4.4 GB |

The other 840 of the 1800 frames are single-layer A-roll frames that take the plain-decode fast path and
never reach the engine. "GPU busy" includes the VideoToolbox decode and encode.

**Read honestly:**

- **4K is under real time**, 1.39× → 0.82×, which was the blocker. Before pipelining (the worker waiting
  for each frame itself) it measured 0.87–0.88×. Pipelining moved 7.8 s of GPU wait off the workers.
- **1080p is level with the CPU compositor, not faster.** At 1080p the CPU blend was already cheap: it
  ran on every core above `PARALLEL_PIXEL_MIN`. What remains is decode: 17.9 s of the workers' 23 s.
  A 1080p explainer frame through the engine alone costs 1.3 ms to submit and 3.5 ms to wait and read
  back (`measure_the_cost_of_one_frame`). Synchronously, without the pipelining, 1080p measured 0.26×.
- **Decode is now the largest term at 4K** too (70 s of the workers' 86 s). One 4K track decodes in 17–20
  s per 60 s through VideoToolbox into the pipe, whatever the pixel format (§15.9). The next real gain is
  the zero-copy media path in §15.9, or more lanes.
- **Segments.** With the blend off the CPU, 3 segments measured 0.74× at 4K (synchronous GPU, load ~10)
  and 0.22–0.23× at 1080p, against the planner's 2. A pipelined 3-segment 4K run under load 16 measured
  1.17×. That is inconclusive, so the planner is unchanged (§15.9).

**Hops a zero-copy path would remove, per 4K frame through the engine** (from the counters above): the
upload copy (40.4 GB / 960 frames ≈ 42 MB, inside the 17 ms of record + upload), the read-back copy
(33 MB, 4.5 ms), and on each side the pipe itself (25 MB of rgb24 per layer in, 33 MB of RGBA out).

**The preview (perf-300).** See §15.8 for the harness run against the debug bundle.

## 15.7 Grading

**Superseded 2026-11-04 by D-450** (`docs/notes/native-grade-pass.md`): the Colorist's own shader now runs
per frame on the engine's device and the lattice path below is deleted; a graded engine frame is the
Colorist's render bit for bit. This section records what was measured before.

The Colorist grade reaches the engine as the 33³ lattice the Colorist's own shader baked (D-256), applied
on the GPU with `apply_rgb8`'s arithmetic. Measured on a graded 1280×720 frame (exposure, contrast,
highlights, shadows, saturation, temperature, tint):

| | PSNR | SSIM | max |
|---|---|---|---|
| GPU export vs CPU compositor (same lattice) | 99.5 dB | 1.0000 | 1 |
| GPU export vs the Colorist's own render of the frame | 49.2 dB | 0.9979 | 20 |
| CPU export vs the Colorist's own render (before D-449) | 49.2 dB | 0.9979 | 20 |

So the engine is exactly as close to the Colorist as the export always was. The remaining gap is the
lattice: it interpolates between 33 points per axis where the shader computes, and a 3D LUT cannot carry
the parts of a grade that are not per-pixel (masks, local tone, crop; D-256 strips and warns). Closing it,
the owner's "same document and same frame give identical pixels" applied to grading, means running the
Colorist shader per frame inside the engine. Measured before deciding
(`measure_the_colorist_shader_per_frame`, the shader as `export::grade_frame` runs it: its own device, the
frame uploaded, rendered, read back): **59 ms a frame at 1080p and 452 ms at 4K**, against 7 ms and 23 ms for
a whole engine frame with the lattice. One graded 4K clip would take the export from 0.82× to about 15×
real time, so the shader cannot simply be called per frame. `grade_frame` also reads process-global frame
state (`chroma::state::current_video().frame`) for tracked masks and relight depth, which is not safe with
parallel export segments and the live preview drawing at once, and it applies the Colorist crop and
rotation, which would change a clip's framing on the timeline. The real step is the grade shader rendering
into the engine's own device with no read-back, with its per-frame inputs passed in rather than read from
global state (`apelles-grade`, roadmap item 8), then a `Step::Grade` in the plan. Not built here.

**B-381's warmer cast** (D-448's check: exports about 20 dB from the Colorist's render on real footage, and
warmer). It is a property of the lattice, not of the renderer: the GPU engine and the CPU compositor agree
to 99.5 dB on a graded frame, so the cast survives unchanged on this path and its root cause is still the
open part of B-381.

## 15.8 The preview

Same engine, same function. The preview's frame path is unchanged around it: `chroma_timeline_frame` →
`timeline_frame` → `render_timeline_frame` → JPEG. No new command, no frontend change, so nothing new
crosses the `@apelles/bridge` seam (D-447). The perf-300 harness results are in §15.6.

## 15.9 Not done, and why

- **`nv12` out of `decode_pipe`** (§13.3 item 3). Measured first: one 4K track through VideoToolbox into
  the pipe takes 20.1 s as rgb24 and 18.9 s as nv12 (60 s of video, twice each). The hardware decoder,
  not the conversion or the pipe, sets the floor, so nv12 buys about 6% of the decode term and half the
  upload copy. It would also make a composited frame's colour conversion (GPU) differ by a code value
  from a fast-path frame's (swscale) on the same clip. Not worth it alone; it belongs to the zero-copy
  step below, which removes the CPU copy entirely.
- **Zero-copy VideoToolbox frames.** Feasible through wgpu: `wgpu::hal::metal::Device::texture_from_raw`
  plus `Device::create_texture_from_hal` take an `MTLTexture`, which `CVMetalTextureCache` makes from a
  decoder's IOSurface-backed `CVPixelBuffer`; `objc2-core-video`, `objc2-metal` and `objc2-io-surface` are
  already in the lockfile. It needs an in-process decoder (a `VTDecompressionSession` or `AVAssetReader`
  in place of the `decode_pipe` ffmpeg processes, keeping D-228's conform to the nominal frame grid, the
  forward-skip and seek behaviour, lanes and the hardware-failure fallback), the engine taking textures
  as well as buffers (two-plane YCbCr kernels), and, for the encode side, a `VTCompressionSession` fed
  `CVPixelBuffer`s from the engine with muxing, audio and the segment concat that ffmpeg does today. The
  hops it would remove, measured at 4K (§15.6): the upload copy and the read-back, plus the pipe read on
  each side. A multi-day replacement of both media ends, so it is its own wave with its own decision.
- **The final aspect-change resize** (`canvas_plan`'s `needs_resize`, only when the output's aspect
  differs from the composition) is still `image::imageops::resize` on the writer thread. It is zero in
  every measured case. It can become a second engine pass.
- **The segment planner is unchanged.** It still counts an encoder process per segment against the cores.
  With the blend off the CPU, 3 segments measured faster than the planner's 2 at both sizes (§15.6), but
  changing a CPU bound measured on one fixture under a busy machine is a decision of its own (B-234's
  starving-lanes evidence is why the bound is conservative).

## 15.10 Files

| file | what changed |
|---|---|
| `crates/apelles-compositor/` | **new** — the engine, the plan, the tables, eight WGSL kernels, 14 tests, README |
| `app/src-tauri/src/chroma/gpu_compositor.rs` | **new** — the process's one engine, `render` / `submit` / `grade` / `stats` |
| `app/src-tauri/src/chroma/edit.rs` | the CPU passes deleted; `paint_layer`; `composite_video_frame` builds a plan; `RenderedFrame` + `render_timeline_frame_deferred`; captions as plan layers (`caption_steps`) |
| `app/src-tauri/src/chroma/edit_render.rs` | the writer waits for GPU frames (`Outgoing`); `RenderStages` gains the engine's counters |
| `app/src-tauri/src/chroma/{colorist_view,grade_lut,highlight_draw,export_bench,mod}.rs` | callers moved to the engine; `apply_to_rgba` deleted; `for_each_row_mut` moved to its last user; the bench prints the GPU stages |

---

# 16. D-452 (2026-11-04): VideoToolbox decode and encode in process — the CPU hops on both media ends removed

**Decision:** D-452. **Code:** `crates/apelles-media/src/vt_decode.rs`, `vt_encode.rs`, `decode_pipe.rs`;
`crates/apelles-compositor/src/video.rs`, `kernels/ycbcr.wgsl`, `kernels/output.wgsl`, `engine.rs`
(`submit_with`, `submit`, `submit_into`); `crates/apelles-types/src/video_frame.rs`.

## 16.1 The shape

```
 AVAssetReader (VideoToolbox)          apelles-compositor (wgpu / Metal)                VTCompressionSession
 ─────────────────────────────         ─────────────────────────────────                ───────────────────────
 CVPixelBuffer (IOSurface, Y'CbCr) ─▶  CVMetalTextureCache → texture_from_raw            ┌─ pool buffer (IOSurface)
   source's own layout, full size        ycbcr.wgsl: crop → RGBA (matrix, range)         │    420v / BGRA
                                         … the D-449 plan, unchanged …                   │
                                         submit_with ──┬─ submit: staging read-back      │  (preview JPEG, pictures)
                                                       └─ submit_into ── output.wgsl ───▶┘  NV12 709 / BGRA, no read-back
                                                                                         └─▶ AVAssetWriter (.mp4/.mov)
```

No decoded or finished pixel crosses the CPU on the media-engine path. ffmpeg stays where it is the right tool
(§16.6): the remux and the audio mix, loudness, probing, thumbnails / filmstrips, the Colorist's single-clip export,
and converting, once, a source in a container AVFoundation does not open (§16.8, D-453), which then decodes here
like any other.

## 16.2 Why `AVAssetReader`, and how the grid is kept

`VTDecompressionSession` needs a demuxer and a presentation-order reorder buffer in front of it; `AVAssetReader`
is Apple's own demuxer + decoder pipeline over the same decoders, delivers in presentation order, honours edit lists,
and starts a read at a time by decoding forward from the preceding sync sample. It also hands out the frame whose
presentation interval overlaps the start of the range, which is exactly what a hold needs (verified: the held
frame of a VFR source is delivered when the read starts in the middle of the hold).

The conform (`fps=N/D:start_time=0:round=up` + `select` in ffmpeg, D-228) is reimplemented in exact integer
arithmetic on `CMTime`: slot `k` is the last frame with `pts · num ≤ k · den · timescale`, the first frame for a
slot before it, and the stream ends at the track's time-range end (decoded samples carry no duration). The read
starts at `(first − ½) / fps`, the same half-frame-early point `conform::from_frame` seeks to.

Tests (`vt_decode::tests`): luma **bit-exact** against ffmpeg's conformed software decode on a CFR source from
five start points, on a VFR source with a two-second hold from eight start points (before, at, inside and after the
hold), and the same frame count to the end of the source. The VFR fixture has no B-frames: with B-frames and a
two-second gap, ffmpeg's mp4 muxer writes composition offsets that ffmpeg and AVFoundation read back as different
presentation times for the frames around the gap, so that file has no single right answer (the real VFR sources,
macOS screen recordings, have no B-frames).

## 16.3 The conversion, measured

`compositor::video_tests::the_ycbcr_conversion_matches_swscale_within_a_code_value`, 640×360, frames 0 and 17,
the engine against ffmpeg's rgb24 of the same nominal frame (the decode pipe's command):

```text
layout                           vs swscale precise (full_chroma_int+accurate_rnd)    vs the pipe's default conversion
h264 4:2:0 8-bit bt709 tv        80.1–80.6 dB, max 1, 0% > 1 code                       30.5–30.7 dB, max 122–129
h264 4:2:0 8-bit untagged tv     80.1–81.1 dB, max 1, 0% > 1                            31.1–31.3 dB
h264 4:2:0 8-bit bt709 pc        77.0 dB, max 1, 0% > 1                                 30.7–30.9 dB
hevc 4:2:0 10-bit bt709 tv       79.5–80.2 dB, max 1, 0% > 1                            30.7–30.9 dB
prores 4:2:2 10-bit bt709 tv     74.3–74.4 dB, max 1, 0% > 1                            30.4–30.5 dB
```

**Tolerance: 1 code value** against swscale's precise conversion, asserted. The test chart (`testsrc2`) is all hard
colour edges, which is the worst case for the chroma difference against the pipe's default conversion: swscale's
unscaled fast path replicates each chroma sample over its 2×2 block and uses coarser fixed-point tables (flat
BT.709 red decodes as 249 there, 251 here, 250.8 exactly). The engine reconstructs chroma bilinearly at the centred
position swscale itself assumes. Natural footage is measured in §16.6.

Matrix and range: the probed `color_space` (what ffmpeg converts by), BT.601 when untagged (swscale's default).
The probe falls back to the first decoded frame's tag when the container has none, because ffmpeg's ProRes decoder
reads the matrix from every frame header while the container may not carry a `colr` atom (VideoToolbox itself
reports BT.601 for such a file, so its attachment cannot be used). Probe cache namespace `probe-v4`.

## 16.4 What the stream does that the pipe could not

- **A repeat is not a seek.** The frame last handed out is served again for the same index:
  `engine_pipe_tests::a_held_frame_and_a_slow_ramp_are_served_without_a_seek` (30 repeats of a held frame return
  the same IOSurface; a half-speed ramp `41, 41, 42, 42, …` reads forward). This is roadmap 5b's "no per-frame seek
  for speed changes and Hold last frame": a ramp faster than real time was already a forward read, slower and held
  frames were the per-frame seeks.
- **Full size to the GPU.** The preview's long-edge cap no longer pre-scales the decode; the engine's Triangle
  minify does it while painting the layer.
- **A prime is a thread, not a process.** `sync_prefetch` opens a `Reader`, whose thread seeks and decodes two
  frames ahead while the outgoing clip still plays; adopting it at the boundary is a channel receive.

## 16.5 Encode

`vt_encode::SegmentEncoder` reproduces the session ffmpeg's `h264_videotoolbox -q:v 70` built (read off a real
ffmpeg encode: High profile, `has_b_frames=0`, a key frame every 12 frames) at VideoToolbox quality 0.70, so
D-446's measurement (equal to libx264 CRF 18) is of the same encoder settings; ProRes 422 HQ (`apch`) is fed BGRA.
Every file is tagged Rec.709 (ffmpeg's path wrote none, and converted RGB with swscale's BT.601 default: a player
reading the untagged HD file as Rec.709 showed it slightly off). The writer's media and movie timescales are the
rate's own (`30000` for 29.97), so frame `n` is at exactly `n · 1001 / 30000` and the file's duration is
`frames / fps` (AVFoundation's default 600 rounded 29.97 onto a 20-tick grid). Tests: `vt_encode::tests` (frame
count, profile, rate, tags, the decoded frames), `video_tests::a_frame_written_into_an_encoder_buffer_is_rec709_nv12_of_the_canvas`
(within 1 code of an f64 reference, 1918 wide so neither plane's row is 256-byte aligned) and
`…_for_prores_is_the_canvas_as_bgra` (exact).

## 16.6 The export, wired (step 2)

`chroma::edit_render` renders each segment's frames into its own `SegmentEncoder`: the worker takes a buffer from
the encoder's pool, asks for the frame with `Destination::Encoder { buffer, format }`
(`render_timeline_frame_deferred` → `Engine::submit_into`, which also resamples the canvas when the output's aspect
differs from the composition, with the general layer path's Triangle passes, replacing the CPU `imageops::resize`),
and hands the in-flight frame to the segment's writer thread, which waits for the GPU (`PendingGpu::wait`) and
gives the buffer to the encoder. A gap is an empty plan into the same buffer. Every export, one segment or several,
then runs the same remux: the concat list of the segment files, the audio mix D-197 compiles, `-c:v copy`, `-t` the
export's length. The request is typed (`width`, `height`, `frames`, `fps`, `format`, `args` = the remux); the frame
rate becomes the file's exact clock (`frame_rate`: an NTSC rate is `n·1000/1001`).

**What still runs ffmpeg, and why:** the remux (joining files and muxing an AAC / PCM mix it already compiles is
what ffmpeg is for; AVAssetWriter would need the mix re-implemented), the audio mix itself (D-197, unchanged),
loudness (D-401), probing, thumbnails and filmstrips (batch extraction into the disk cache), the Colorist's own
single-clip export (`chroma::export`, which renders through the grade shader, not this engine), and the one-time
conversion of a source in a container AVFoundation does not open (§16.8).

**Cancel, status and the watchdog.** A cancel stops every segment's loop at its next frame; the dropped encoder
abandons its temporary file; the remux, the one child process left, is killed through the cancel registration.
Progress is still counted where a frame reaches the encoder. The watchdog no longer kills an encoder process (there
is none): every wait in the in-process encoder is bounded (`GPU_TIMEOUT`, `vt_encode`'s append and finish
timeouts), so a wedged segment returns an error by itself, and the watchdog records the stall and stops the
siblings. Its end-to-end test against an ffmpeg that stopped reading went with the ffmpeg encoder.

**The Encoder option (D-446) is removed.** Its "software" arm was ffmpeg's libx264 / `prores_ks`, a second encoder
path the owner ruled out, and VideoToolbox's own software encoder would be a fallback with no measured reason to
exist. The Export panel's Encoder field, `encoder` on `editor_export` in both MCP servers (corpus re-captured, still
275 / 256 tools) and `ExportEncoder` in the editor are gone; a caller that still passes `encoder` gets an error
saying so rather than a silently different file.

## 16.7 Measured

Back to back on the same machine (load average 8–12), `measure_export_benchmark`, hardware H.264, the planner's 2
segments; before is the commit before D-452 (`3802e3bd`):

| | 1080p before → after | 4K before → after |
|---|---|---|
| × real time | 0.17× → **0.13×** | 0.64× → **0.49×** |
| render wall | 9.6 → 7.6 s | 37.7 → 28.3 s |
| workers' decode + set-up (summed) | 13.2 → 0.4 s | 57.7 → 1.7 s |
| bytes up / down | 10.1 / 8.0 GB → 0.1 / 0 GB | 40.4 / 31.9 GB → 0.2 / 0 GB |
| CPU / GPU busy | 68% / 28% → 5% / 68% | 71% / 28% → 4% / 60% |
| peak memory over the host | +1.9 → +0.12 GB | +4.6 → +0.14 GB |
| one track's decode floor (60 s) | 6.0 → 3.4 s | 19.3 → 5.5 s |

On a busier run (load 20–45) the same pair read 0.26× → 0.13× and 1.07× → 0.50×.

**Where the time goes now: the hardware H.264 encoder.** The writers spend the render inside it (55 s summed over
two writers for a 28 s render at 4K); the workers wait on them. 4K at 1, 2, 3 and 4 segments measured 0.50×, 0.49×,
0.49×, 0.50×; 1080p at 1, 2, 3, 4 and 6 measured 0.18×, 0.13–0.16×, 0.14×, 0.14×, 0.15×. More segments cannot help
a shared encoder, so the planner's ceiling is now 2 (`MAX_SEGMENTS`, retuned from 6) and its memory estimate uses
the in-process sizes (roadmap 5b's "more segments" item, answered by measurement: fewer). Faster than this needs a
faster encode (HEVC is about as fast; a lower H.264 quality would change the file) — not a renderer change.

**Parity against the old export of the same fixture** (`measure_export_fidelity` and ffprobe / ebur128):

| | 1080p old · new | 4K old · new |
|---|---|---|
| frames / video / audio duration / start | 1800 / 60.000 / 60.010 / 0 · identical | identical |
| loudness (integrated, true peak) | −14.0 LUFS, −3.4 dBTP · identical | −14.0, −3.0 · identical |
| PSNR against the engine's own frames | 33.4 · **34.9** dB | 34.4 · **36.0** dB |
| file size | 84 · 80 MB | 338 · 321 MB |
| new vs old, RGB | PSNR 36.8 dB, SSIM 0.957 | 37.6 dB, 0.965 |

The new file is closer to the picture the engine drew than the old one was: the old path converted RGB to Y'CbCr
with swscale's BT.601 default and wrote no tag, so a player reading HD as BT.709 shifted it, and it pre-scaled the
B-roll with `fast_bilinear` before the engine. The two files differ from each other by two independent lossy
encodes of a grain-heavy fixture (temporal noise at quality 0.70), which is why new-vs-old is lower than either
against the truth. The H.264 setting is ffmpeg's `h264_videotoolbox -q:v 70` session reproduced property by
property (quality 0.70, High, no B-frames, a key frame every 12), so D-446's measurement against libx264 CRF 18
holds for the same encoder settings; the new numbers above are the re-measurement on the new path.

**Scrub latency** (`chroma::scrub_bench::measure_scrub_latency`: two stacked 20 s H.264 tracks with grain, a
picture-in-picture over a full frame, at the preview's 1280 px, `render_timeline_frame` per position), before →
after:

| | drag forward (+3 frames) p50 / p95 | jump anywhere p50 / p95 | drag back (−2 frames) p50 / p95 | ffmpeg processes left |
|---|---|---|---|---|
| 1080p | 16.1 / 23.3 → 9.8 / 14.8 ms | 357 / 563 → 121 / 240 ms | 480 / 569 → 153 / 219 ms | 2 → 0 |
| 4K | 50.7 / 75.6 → 17.5 / 26.5 ms | 861 / 1902 → 128 / 440 ms | 1076 / 1458 → 240 / 457 ms | 2 → 0 |

A jump or a step back is still a seek to the sync sample before it (this fixture has a key frame every 2 s); the
seek itself is now in process instead of an ffmpeg spawn and a pipe. **Determinism:**
`two_exports_of_one_document_decode_to_the_same_frames` (two exports decode to identical frames) and the frame-level
tests in §16.5.

## 16.8 Optimized media: the last decoder goes (step 3, D-453)

A source in a container AVFoundation does not open (Matroska / WebM, AVI, MPEG-TS, MXF) is converted once, on
import or when its project opens, into an HEVC `.mov` (`hevc_videotoolbox -q:v 75`, its own timestamps kept) in
the project's `optimized-media/` folder, keyed by `media_cache::source_key` of the original; `decode_pipe` opens
that file in its place (`optimized_media::decode_source`) and the project keeps naming the original. The ffmpeg
decode pipe, its software retry and the decode `scale` argument are deleted, so every frame the preview, a scrub
or an export draws is decoded by `vt_decode`. Measured against the original's decode: every frame of the textured test sources at or
above 45 dB, the same frame at every nominal index, VFR holds and an MPEG-TS start offset included. A source not
converted yet is an error naming it, which the preview shows as "converting N%" and an export reports. Design,
measurements, tests and the state machine: `docs/notes/optimized-media.md`. Found on the way: B-384 (a `.mov`'s
leading empty edit decoded black).
