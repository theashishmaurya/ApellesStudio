# Real-time playback ≥30 fps (`chroma::playback`, D-031)

Round-2 item 5 tail / **D-031**. D-030 (`docs/notes/smooth-playback.md`) fixed
*decode* — a persistent sequential `ffmpeg` pipe took raw decode on the 4K C019
clip from ~1.6 fps to ~39 fps. It explicitly left **the frontend regrade + IPC
per playback frame** as the remaining ceiling. This note closes that.

## What was still slow (measured, C019 4K HEVC 24 fps)

Per playback frame the old path did, in order:

1. `setInterval(1000/fps)` fires (no wall-clock sync — drifts, and stacks up
   when a frame runs long).
2. IPC `chroma_seek(frame)` — decode-pipe frame (fast now) + swap into
   `AppState.original_image`. A `seekInFlight` mutex **drops** any frame that
   arrives while one is in flight.
3. `bumpFrameNonce()` → a React effect in `useImageProcessing.ts` →
   `applyAdjustments(adj, false, calculateTargetRes())`.
4. IPC `apply_adjustments` — **`calculateTargetRes()` returns the 4K long edge**
   for a 4K source (it snaps to `origMax` once the target is ≥ 0.8·origMax), so
   the WGSL grade + the `downscale_f32_image` that precedes it both run at
   **3840 px**. `downscale_f32_image` alone is ~40 ms on a 4K frame (rgb8→f32
   convert + a single-threaded weighted box filter).

So: two IPC round-trips, a React round-trip, a frame-dropping mutex, and a
full-4K grade + a 40 ms CPU downscale, per frame. Headless harness at 4K:
**~14.5 fps** (68 ms/frame — 39 ms downscale, 25 ms grade, 5 ms decode).

## Levers (from the D-031 brief)

| # | lever | effect |
|---|---|---|
| 1 | grade at ~1280 px during playback, not 4K | biggest single win; nobody pixel-peeps at 30 fps |
| 2 | kill the nonce→debounce path for playback | a playback loop wants every frame *now* or dropped cleanly |
| 3 | one fused Rust command (decode+swap+grade in one IPC) | removes a whole IPC hop + the React round-trip + the frame/matte desync risk |
| 4 | decode-ahead worker | only if decode is still the ceiling |
| 5 | rAF + wall-clock frontend loop | real-time playback, clean frame-skip, no `setInterval` drift |

## Choice — 1 + 2 + 3 + 5, and do the downscale in ffmpeg not the CPU

Measurement drove this. After (1) the CPU downscale (`downscale_f32_image` at
4K) *becomes* the bottleneck — 39 ms/frame, more than the grade. The fix is to
**decode straight to playback resolution**: `ffmpeg -vf scale=1280:720` in the
decode pipe. ffmpeg's scaler is SIMD; scaled 4K→720 decode is **~0.8 ms/frame**,
and `AppState.original_image` is then already ≤ playback res so
`generate_transformed_preview` does **no** downscale at all.

- **(1)+(downscale-in-ffmpeg)** `decode_pipe.rs` gains `open_scaled` /
  `frame_scaled` / `playback_frame_scaled` — an optional `scale: Option<(w,h)>`
  the pipe passes to `-vf scale`. A change of scale forces one respawn (same cost
  as a seek jump). D-030's native `open` / `frame` / `playback_frame` stay as
  thin `..._scaled(.., None)` wrappers — the D-030 tests are untouched.
  `scale_target(src_w, src_h, long_edge)` → even-dimension downscale target, or
  `None` when the source already fits.
- **(3) the fused command** `chroma_play_frame(frame, jsAdjustments, targetResolution)`
  in a new `src/chroma/playback.rs`:
  1. `commands::seek_and_install(frame, Some(dim), state)` — the extracted body
     of `chroma_seek` (clears the per-frame pixel caches, decodes **scaled** via
     the pipe, swaps `original_image`, points `CurrentVideo.frame` at `frame` so
     the tracked matte (D-019) stays in lockstep).
  2. dispatch **one** `PreviewJob` to the existing preview worker at
     `target_resolution = dim` (`is_interactive: false`, no analytics/waveform),
     await its bytes, return them (`WGPU_RENDER` on the native-surface path).
  One IPC call. No `bumpFrameNonce`, no React effect, no second `invoke`. The
  preview worker already coalesces, and the loop awaits each job before
  requesting the next, so the grade always renders the frame just installed —
  frame and matte cannot desync.
  `seek_and_install` clearing `cached_preview` + `gpu_image_cache` every call is
  what stops `process_preview_job` reusing frame N-1's cached base / input
  texture (the adjustments hash is constant across a playback run) — same
  mechanism `chroma_seek` already relied on, and the reason `export.rs` keys its
  `transform_hash` by frame.
- **(2)+(5) the frontend loop** — `ChromaTimeline.tsx` drops the `setInterval` +
  `seekInFlight` mutex + the `goToFrame`→`doSeek`→nonce chain for playback. A
  `requestAnimationFrame` loop against a wall clock:
  `want = startFrame + floor((now - startTime) * fps)`; if `!busy && want !=
  lastRequested`, `invoke('chroma_play_frame', …)`; frames we couldn't render in
  time are simply never requested (audio-less playback stays real-time). On
  pause, one `goToFrame(currentFrame)` re-decodes native + regrades full-res —
  quality at rest is unchanged. **Scrub is untouched** — dragging the strip still
  goes through `chroma_seek` + the nonce at `calculateTargetRes()`.

(4) decode-ahead was **not needed** — scaled decode is 0.8 ms/frame, ~3 % of the
budget. Left for a future heavier-codec case.

## Measured — headless timing harness

`chroma::playback::tests::playback_throughput_c019` (gated on `CHROMA_TEST_VIDEO`).
Loops 60 frames of C019 through the real path minus IPC + surface present:
scaled decode pipe → `render_core::render` (a real WGSL grade — exposure +
contrast + saturation + WB + a luma curve — the same call `export.rs` uses).

```
=== D-031 playback throughput — C019 3840x2160 @ 24.0 fps, grade @ 1280 px long edge, 60 frames ===
  scaled decode (ffmpeg): 0.83 ms/frame   grade: 26.55 ms/frame
  TOTAL:  27.38 ms/frame   => 36.5 fps effective (headless, no IPC / no surface)
```

At 960 px: **19.6 ms/frame, 50.9 fps**. At the old 4K path: 68.8 ms/frame,
14.5 fps.

**36.5 fps headless at 1280 px clears the 30 fps bar** (and the 24 fps source
rate) with margin for the one IPC hop + the wgpu surface present that end-to-end
adds. If a lower-end GPU can't hold 30, `PLAYBACK_LONG_EDGE` in
`ChromaTimeline.tsx` drops toward 960 (50 fps headless) — one constant.

The grade (26 ms @ 1280) is now the dominant term. Lowering it further is a
shader / lower-res question for later, not needed for the bar.

## What a human still needs to smoke-test

The harness is the throughput proxy for the ceiling; it does not exercise the
IPC hop or the native wgpu surface. In a `tauri dev`:

1. Open C019, add a non-trivial grade (exposure + a curve + a subject mask).
2. Hit play. Confirm it plays at ~real-time (a ~10 s section takes ~10 s, not
   ~40 s) and the **grade is visible on every frame** (not raw frames, not a
   stale grade).
3. Pause. Confirm the held frame sharpens to full-res within a moment.
4. With a **tracked** subject mask (D-019): play through a section where the
   subject moves; confirm the matte follows the subject frame-to-frame (no
   offset blob), and is still correct after pause.
5. Scrub the strip — confirm single-frame scrub still works and settles full-res.

## Known gaps

- **Linux.** `chroma_play_frame` returns a JPEG when `use_wgpu_renderer = false`
  (Linux); the rAF loop ignores the response body, so Linux playback would show a
  stale frame. Video is macOS-first for v1 (D-006 / D-020 already note the native
  surface). Fix later: have the loop set `finalPreviewUrl` from a non-`WGPU_RENDER`
  body.
- **GPU poll timeout.** `process_preview_job` blocks up to 500 ms on
  `device.poll(Wait)` after the grade. At 1280 px the grade finishes fast so this
  rarely waits, but a shorter/zero timeout for the playback job (drop a late frame
  rather than block) is a possible follow-up — skipped here to avoid editing the
  shared `process_preview_job` hot path.

## Files

- new: `engine/src-tauri/src/chroma/playback.rs` — `chroma_play_frame`,
  `playback_dim`, the harness.
- `engine/src-tauri/src/chroma/decode_pipe.rs` — `+scale_target`,
  `+open_scaled` / `+frame_scaled` / `+playback_frame_scaled`; `open` / `frame` /
  `playback_frame` become native-size wrappers.
- `engine/src-tauri/src/chroma/commands.rs` — `chroma_seek` body extracted to
  `pub async fn seek_and_install(frame, scale_long_edge, state)`.
- `engine/src-tauri/src/chroma/mod.rs` +2, `lib.rs` +1 `generate_handler!` line.
- `engine/src/components/panel/editor/ChromaTimeline.tsx` — rAF wall-clock
  playback loop calling `chroma_play_frame`; pause → full-res settle.
