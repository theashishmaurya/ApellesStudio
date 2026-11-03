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
- **Live re-check owed:** the B-374 release numbers and the B-369 open numbers were measured in the agents' own bundles, not yet in the owner's dev app. Re-measure after the next restart and update this table.

## Keeping the floor

Before a release, and after any change to the timeline, the player or the open path: run `perf-300` and compare with this table. A number worse than its floor gets a `B-NNN` and blocks the release unless the owner explicitly accepts it. Roadmap: make the harness compare against this table automatically and fail on a regression (roadmap 00r, "perf floor in CI").
