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
| Playback, play loop | **≥ 60 fps** | dev | B-370 |
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
- **B-380:** 4K export is still slower than real time: 2.46× on the default (filter) path and 1.38× on the compositor path, after D-446's hardware encode. See "Export" below for the floor and what is left.
- **Live re-check owed:** the B-374 release numbers and the B-369 open numbers were measured in the agents' own bundles, not yet in the owner's dev app. Re-measure after the next restart and update this table.

## Export (B-380, D-446)

**How it is measured.** `measure_export_benchmark` (`app/src-tauri/src/chroma/export_bench.rs`, `#[ignore]`d)
runs a 60 s explainer-shaped fixture (`tests/fixtures/export-bench.json`: 3 video tracks, 15 clips, jump-cut
A-roll with its voice, rounded PIP, crop, keyframed slide, alpha PNG, moving overlay, music). Its media is
textured and grainy, so the encoders do real work. Each export runs end to end, on both renderers and both
encoders, and the run reports wall time, the renderer's own stages, CPU, GPU, peak memory, frame count, A/V
drift, loudness and PSNR / SSIM. Each output is deleted once it has been measured.

```sh
CHROMA_FFMPEG=$PWD/target/debug/ffmpeg CHROMA_FFPROBE=$PWD/target/debug/ffprobe \
APELLES_BENCH_SIZE=4k APELLES_BENCH_SPLIT=1 APELLES_BENCH_LOUDNESS=1 \
cargo test -p apelles --lib chroma::edit_render::export_bench -- --ignored --nocapture
```

Same machine as above, shared with other builds (load 15–33), single runs. "× runtime" is export time ÷ the
video's length, so under 1.00 is faster than real time.

| Export of the 60 s fixture | 1080p before → after D-446 | 4K before → after D-446 |
|---|---|---|
| **Filter path** (the Export panel's and `editor_export`'s default renderer) | 0.58× → **0.49×** | 2.78× → **2.46×** |
| └ the same with no encoder at all (decode + composite + scale) | 0.49× | 2.36× |
| **Compositor path** (`renderer: "compositor"`, 2 segments) | 0.88× → **0.35×** | 4.06× → **1.38×** |
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
| 1080p export, filter path, hardware encode | **≤ 0.49×** runtime |
| 1080p export, compositor path, hardware encode | **≤ 0.35×** runtime |
| 4K export, filter path, hardware encode | **≤ 2.46×** runtime |
| 4K export, compositor path, hardware encode | **≤ 1.38×** runtime |
| Loudness pass on a 60 s export | **≤ 2 s** |
| Hardware H.264 quality vs libx264 CRF 18 (encoder sweep) | **equal or better** PSNR / SSIM / VMAF (q 70) |

**Not at budget yet (B-380 stays open).** 4K is not under real time on either path. The default filter path is
held by its own thread caps (21% CPU, decode + composite + scale alone is 2.36×). The compositor path's remaining
time is the CPU blend (`blend_layer_sampled`, about 58% of busy samples) and the decode pipes' reads (about 28%).
The re-ordered plan is in `docs/notes/export-gpu-compositor.md` §13: compositor as the default renderer, then the
GPU compositor (D-363).

## Keeping the floor

Before a release, and after any change to the timeline, the player or the open path: run `perf-300` and compare with this table. A number worse than its floor gets a `B-NNN` and blocks the release unless the owner explicitly accepts it. Roadmap: make the harness compare against this table automatically and fail on a regression (roadmap 00r, "perf floor in CI").
