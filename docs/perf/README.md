# Performance baseline: the floor we don't drop below

**What this is.** The measured speed of the Edit tab at the v0.3.0 point (2026-11-03), recorded at the owner's request: "record the current one so we don't drop from here". Each number below is a **regression floor**. A change that makes one of them worse is a defect (a `B-NNN`), not a trade-off, per CLAUDE.md's priority order (performance, then stability, then shipping speed).

**How it is measured.** The UI harness (`docs/notes/ui-harness.md`), against a 300-clip, 8-track fixture (`--filter perf-300`), with Apelles in front:

```sh
npm run harness --workspace @apelles/ui-harness -- --filter perf-300 --out "$PWD/scratch/perf-baseline/<label>"
# a production-minified bundle: build with identifier studio.apelles.perf, launch with
# CHROMA_CONTROL_PORT=19798, then add --port 19798 (recipe in docs/notes/ui-harness.md)
```

Machine: the owner's MacBook (Apple silicon), window 1470×923. The machine load changes the numbers (see the interleaved A/B method in `ui-harness.md`), so compare against a run made the same way, interleaved when the machine is busy.

**Raw reports in this folder:**
- `2026-11-03-dev-perf300-report.md`: the dev app, after D-437 S10 and B-370/B-371, before B-374.
- `2026-11-03-prod-perf300-after-b374-report.md`: the production bundle after B-374.
- `2026-11-03-export-benchmark-report.md`: the export benchmark (B-380 / D-446), raw.

## The floor (300 clips)

| Measure | Floor | Build it was measured in | Source |
|---|---|---|---|
| Playback, play loop | **≥ 60 fps** (the display rate: since D-454 the loop is the display-clocked native present, so it cannot exceed the refresh; 59.6–60.0 measured) | dev | B-370, D-454 |
| Playback, paint | **≥ 27 fps** on a 30 fps timeline | dev | B-370 |
| Drag during trim / roll / slip / slide / move, p95 | **≤ 30 ms** | dev | D-437 |
| Release frame: trim | **≤ 39 ms** | production | B-374 |
| Release frame: ripple trim | **≤ 40 ms** | production | B-374 |
| Release frame: roll | **≤ 43 ms** | production | B-374 |
| Release frame: slip | **≤ 29 ms** | production | B-374 |
| Release frame: slide | **≤ 45 ms** | production | B-374 |
| Release frame: move | **≤ 42 ms** | production | B-374 |
| Commit to next frame on release (`commitFrameMs`) | **≤ 34 ms** | production | B-374 |
| Wheel scroll, frame p95 | **≤ 17 ms** (2 of 3 runs; 1 run 52 ms under load) | dev | D-437 S8 |
| Opening "Nemotron Transcribe" (290 clips), warm | **≤ 0.73 s** to a ready workspace | debug bundle | B-369 |
| Opening it cold (empty disk cache) | **≤ 2.7 s** | debug bundle | B-369 |
| `open_project` reply | **≤ 186 ms** | debug bundle | B-369 |
| 300-clip correctness (`perf-300` scenarios) | **12 / 12 pass** | dev | — |
| Full harness | **58 / 58 pass** (57 + the B-373 fix, verified on its own) | dev | — |

## Not yet at budget (logged, to fix after v0.3.0)

The budget (`docs/notes/ui-harness.md`) is ≤ 50 ms for any single frame and ≥ 24 fps paint. These are measured but still short of it, or not yet re-measured:

- **B-376:** the move drag (before release) spikes to 49–66 ms on some runs.
- **B-377:** the whole `TimelinePane` re-renders on every edit (toolbar, all track headers, lanes): 4–16 ms per edit.
- **B-378:** the first preview frame after an app launch takes 1–2 s (ffmpeg/VideoToolbox decoder start-up, about 350–800 ms per new pipe).
- **B-379:** the Inspector re-mounts for the newly selected clip a frame or two after the release: 10–20 ms, including a forced layout from a Base UI `scrollIntoViewIfNeeded`.
- **B-375 follow-up:** pinch zoom at 300 clips was 66–109 ms worst frame before the proportional-pinch fix. It is not re-measured since.
- **B-380:** the export is under real time at 4K since D-449 (one GPU render engine): 1.39× → 0.82× on the compositor, the only export renderer since D-449 (the deleted filter path was 2.46×). See "Export" below.
- **Live re-check owed:** the B-374 release numbers and the B-369 open numbers were measured in the agents' own bundles, not yet in the owner's dev app. Re-measure after the next restart and update this table.

## Export (B-380, D-446, D-449, D-449)

**How it is measured.** `measure_export_benchmark` (`app/src-tauri/src/chroma/export_bench.rs`, `#[ignore]`d)
runs a 60 s explainer-shaped fixture (`tests/fixtures/export-bench.json`: 3 video tracks, 15 clips, jump-cut
A-roll with its voice, rounded PIP, crop, keyframed slide, alpha PNG, moving overlay, music). Its media is
textured and grainy, so the encoders do real work. Each export runs end to end on both encoders, and the run
reports wall time, the renderer's own stages, CPU, GPU, peak memory, frame count, A/V drift, loudness and
PSNR / SSIM. Each output is deleted once it has been measured. Since D-448 there is one renderer (the
compositor); the filter-path rows below are the deleted path's last measurement, kept for the comparison.

```sh
CHROMA_FFMPEG=$PWD/target/debug/ffmpeg CHROMA_FFPROBE=$PWD/target/debug/ffprobe \
APELLES_BENCH_SIZE=4k APELLES_BENCH_LOUDNESS=1 \
cargo test -p apelles --lib chroma::edit_render::export_bench -- --ignored --nocapture
```

Same machine as above, shared with other builds (load 15–33), single runs. "× runtime" is export time ÷ the
video's length, so under 1.00 is faster than real time.

| Export of the 60 s fixture | 1080p before → after D-446 | 4K before → after D-446 |
|---|---|---|
| Filter path (deleted by D-448; the default until then) | 0.58× → 0.49× | 2.78× → 2.46× |
| └ the same with no encoder at all (decode + composite + scale) | 0.49× | 2.36× |
| **Compositor** (the only export renderer since D-448, 2 segments) | 0.88× → **0.35×** | 4.06× → **1.38×** |
| └ workers' time blocked on the encoder | 23.8 s → 0.8 s | 109.1 s → 2.2 s |
| Peak memory over the host (compositor path) | 3.2 → 1.9 GB | 6.7 → 4.0 GB |
| Loudness pass (−14 LUFS / −1 dBTP, on target, 1 attempt) | 0.6–1.1 s | 0.9–1.6 s |
| Final resize (same-aspect export) | 0 s | 0 s |
| Decode floor, one track (VideoToolbox → rgb24 pipe) | 0.12× | 0.31× |
| Hardware vs software file, PSNR / SSIM | 44.6 dB / 0.988 (filter), 46.9 dB / 0.992 (compositor) | 44.3 dB / 0.988, 47.0 dB / 0.992 |

Frame counts were exact (1800 / 1800) and audio stayed within 0.3 frame of video in every run. Compositor
segments at 4K with the hardware encoder: 2 → 1.37×, 3 → 1.76×, 4 → 1.64×, 6 → 1.99×, so the planner's 2 is the
fastest measured.

**The export floor.** On this fixture, measured the same way, a worse number than these is a regression:

| Measure | Floor |
|---|---|
| 1080p export (compositor, hardware encode) | **≤ 0.23×** runtime (D-449; 0.35× under a busier machine before) |
| 4K export (compositor, hardware encode) | **≤ 0.82×** runtime (D-449, GPU engine; was 1.38×) |
| GPU engine vs the CPU compositor it replaced (measured before the CPU code was deleted) | max 2 code values, PSNR ≥ 50 dB, SSIM ≥ 0.999 per effect |
| Loudness pass on a 60 s export | **≤ 2 s** |
| Hardware H.264 quality vs libx264 CRF 18 (encoder sweep) | **equal or better** PSNR / SSIM / VMAF (q 70) |

D-449 made the compositor the only renderer after the real-project parity check
(`2026-11-03-export-parity-report.md`), where on the owner's c040 project a 3 s range took 12 s on the
compositor and 1033 s on the deleted filter path.

### After D-449: one GPU render engine (2026-11-03)

The compositor now paints every frame on the GPU (`apelles-compositor`), preview and export alike, with no CPU
compositor and no fallback. Same fixture, same machine and session, planner's 2 segments, best of 2 (measured on
the branch before it was rebased onto D-449, which changed the layer model's Clip exceptions but not the blend):

| Compositor, hardware encode | 1080p before → after | 4K before → after |
|---|---|---|
| × real time | 0.23× → **0.23×** | 1.39× → **0.82×** |
| render wall | 13.4 s → 13.1 s | 82.0 s → 47.6 s |
| workers' decode + composite (summed) | 22.9 s → 23.0 s (decode + set-up 17.9 s, GPU record + upload 5.1 s) | 144.1 s → 86.4 s (70.0 s, 16.4 s) |
| GPU wait / read-back (writer threads, overlapped) | — → 2.1 s / 1.3 s | — → 7.8 s / 4.3 s |
| bytes to / from the GPU | — → 10.1 / 8.0 GB | — → 40.4 / 31.9 GB |
| CPU / GPU busy | 55% / 13% → 57% / 35% | 49% / 12% → 54% / 36% |
| peak memory over the host | 2.5 → 2.6 GB | 3.7 → 4.4 GB |

4K is under real time. 1080p is level, not faster: the CPU blend was already cheap there and decode is what is
left. Per-stage detail, the segment sweep, the parity table and what is not done (nv12, zero-copy VideoToolbox) are
in `docs/notes/export-gpu-compositor.md` §15. **B-380 stays open** for the decode term (the largest at 4K now) and
the grade (B-381); the 4K target itself is met.

### After D-452: VideoToolbox decode and encode in process (2026-11-04)

Decoded frames stay in IOSurfaces from VideoToolbox through the engine to the VideoToolbox encoder; ffmpeg only
remuxes the segments with the sound. Same fixture, back to back on the same machine (load average 8–12), the
planner's 2 segments, best of 2 for the after:

| Hardware H.264 | 1080p before → after | 4K before → after |
|---|---|---|
| × real time | 0.17× → **0.13×** | 0.64× → **0.49×** |
| render wall | 9.6 s → 7.6 s | 37.7 s → 28.3 s |
| workers' decode + set-up (summed) | 13.2 s → 0.4 s | 57.7 s → 1.7 s |
| bytes to / from the GPU | 10.1 / 8.0 GB → 0.1 / 0 GB | 40.4 / 31.9 GB → 0.2 / 0 GB |
| CPU (of 10 cores) / GPU busy | 68% / 28% → 5% / 68% | 71% / 28% → 4% / 60% |
| peak memory over the host | +1.9 GB → +0.12 GB | +4.6 GB → +0.14 GB |
| one track's decode floor (60 s) | 6.0 s → 3.4 s | 19.3 s → 5.5 s |
| frames · A/V offset · loudness | 1800 · 0 · −14.00 LUFS, both | 1800 · 0 · −14.00 LUFS, both |
| PSNR against the engine's own frames | 33.4 → 34.9 dB | 34.4 → 36.0 dB |

An earlier pair, on a busier machine (load 20–45), read 0.26× → 0.13× and 1.07× → 0.50×. The export is now bound by
the media engine's H.264 encoder (the writers spend the render in it; 1–6 segments all measure 0.49–0.50× at 4K),
so the planner's ceiling is 2 segments (D-452). Details: `docs/notes/export-gpu-compositor.md` §16.

## Keeping the floor

Before a release, and after any change to the timeline, the player or the open path: run `perf-300` and compare with this table. A number worse than its floor gets a `B-NNN` and blocks the release unless the owner explicitly accepts it. Roadmap: make the harness compare against this table automatically and fail on a regression (roadmap 00r, "perf floor in CI").
