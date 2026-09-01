# Smooth playback / decode pipe (`chroma::decode_pipe`)

Roadmap round-2 item 5 / **D-030**. Scrub + play were ~5–10 fps because every
playback frame paid a full `ffmpeg` process spawn **plus** a keyframe seek **plus**
a PNG encode/decode round-trip. Export had the sibling problem: a `from > 0` range
still decoded from frame 0 (D-022 flagged it, D-015 flagged both).

## What was slow (measured, C019 4K HEVC, 24fps CFR)

`chroma_seek(f)` → `video::decode_frame` spawns `ffmpeg -ss <t> -i clip -frames:v 1
-vcodec png -` per frame:

- process spawn ~10–30 ms
- `-ss` before `-i` is an *accurate* seek → decode from the prior keyframe and
  discard up to `t` (cheap near a keyframe, worse mid-GOP)
- ffmpeg PNG-encodes the frame, Rust `image::load_from_memory` PNG-decodes it —
  ~15–25 ms for a 4K frame, pure overhead
- frame 500 (20 s in) via the export-style `select=between(n,500,500)` linear walk:
  **2.9 s**. Deeper in the clip it scales with distance-from-0.

Then the frontend re-runs a full-res GPU grade + an IPC JPEG round-trip. That half
is unchanged here (see "Not done").

## Options considered

| option | gets playback to | cost / risk |
|---|---|---|
| **(A) persistent `ffmpeg -f rawvideo` stdout pipe, sequential reads, keyframe-seek restart on a jump** | ~24 fps forward; scrub = one restart | ~120 lines, one long-lived child, a global to hold it |
| (B) pre-rendered half/quarter-res proxy file (`.mov` next to the clip) | smooth at any direction, but a transcode wait on open + a proxy-vs-source switch for export + disk | a whole subsystem; the grade still has to run per frame so it only removes decode cost |
| (C) in-memory ring buffer of N decoded frames around the playhead | smooth within the window | 4K rgb24 = 24 MB/frame → ~50 frames = 1.2 GB; eviction policy; still needs (A) to fill it |
| (D) playback skips the GPU grade (show raw frames) or grades through a cached LUT approximation of the current grade | removes the *other* bottleneck | wrong pixels during playback (the point of a grading tool is to see the grade); LUT approx can't represent curves/masks |

## Choice — (A), a persistent sequential-decode pipe

Cheapest thing that materially helps, matches the project's "cheapest that works"
bias (D-027/D-028). One `ffmpeg` per loaded clip instead of one per frame:

```
ffmpeg -hide_banner -loglevel error -ss <(start-0.5)/fps> -i <clip>
       -an -sn -fps_mode passthrough -f rawvideo -pix_fmt rgb24 -
```

- **`-ss (start-0.5)/fps` before `-i`** — accurate seek that lands *exactly* on
  frame `start` for CFR footage. Verified: frames 500/501 out of the pipe are
  byte-identical (PSNR ∞) to the linear-walk `select=between(n,…)` frames. The
  `-0.5` frame margin makes it robust to the clip's `avg_frame_rate` (24.0048)
  vs `r_frame_rate` (24.0) discrepancy — the margin always points backward, so a
  rounding wobble can't skip a frame forward.
- **raw `rgb24` out** — no PNG encode/decode. `RgbImage::from_raw` takes the bytes
  directly.
- **sequential reads** — `frame(target)`:
  - `target == next_index` → one `read_exact(w·h·3)` (the play-forward case, ~5 ms
    for a 4K frame: just the pipe read)
  - `next_index < target ≤ next_index + 48` → discard that many frames, then read
    (short forward scrub / dropped frames)
  - otherwise (backward, or a long jump) → kill + respawn seeked to `target`
    (same cost as one old `decode_frame`, i.e. no worse than today)
- **process-global** `Mutex<Option<FramePipe>>`, mirroring `state.rs`'s
  `THUMB_CACHE`. `set_current_video` drops it when the clip path changes (one
  chokepoint — covers fresh opens and export's clip-swap). `Drop` kills the child.
- **fallback**: any pipe error → drop the pipe, return `Err`; `chroma_seek` then
  falls back to the original `video::decode_frame`. The pipe is a fast path, never
  a new failure mode.

### Export (the from-frame-0 half)

`export::spawn_decoder` now seeks instead of walking from 0:

```
ffmpeg -ss <(from/fps)-1.0> -copyts -i <clip>
       -an -sn -vf select='gte(t\,(from-0.5)/fps)' -frames:v <count>
       -fps_mode passthrough -f rawvideo -pix_fmt rgb24 -
```

- **`-copyts` + `select` by absolute timestamp `t`** (not by decoded-frame index
  `n`) — this is the matte-safety fix D-022 worried about. D-022 used
  `select=between(n,FROM,TO)` from 0 precisely because an input `-ss` shifts `n`
  and would desync the per-frame tracked mattes (D-019, keyed by absolute source
  frame). Selecting by `t` with `-copyts` keeps the timestamps source-absolute, so
  frame `from` is still frame `from` — verified byte-identical to the old path for
  a mid-clip range. The loop still drives `set_current_frame(from + i)` per frame.
- **`-ss …-1.0` back-off** — decode ~1 s of throwaway frames before `from` instead
  of the whole clip. Verified frame 500 in **0.83 s** vs **2.9 s**.
- Net: a late export range no longer pays an O(from) decode tax; a full-clip
  export (`from = 0`) is unchanged (`-ss 0`, `select` passes everything).

## Not done (still open)

- **The frontend regrade + IPC per playback frame.** Each seeked frame still runs
  a full-res WGSL grade pass and ships a JPEG over IPC. That's the remaining
  ceiling on fps for a *heavy* grade. Options for later: a lower-res playback
  proxy render, or a decode-ahead ring buffer feeding the grade. Not in this pass
  — the decode pipe is the bigger, lower-risk win and it's isolated to
  `src/chroma/`.
- **Proxy files** (option B) — deferred. Only worth it if decode stays the
  bottleneck after the pipe, which it shouldn't for v1's single-clip talking-head
  workflow.
- **VFR footage** — the `-ss` seek math assumes CFR (D-004's v1 assumption). A VFR
  clip could land ±1 frame off; acceptable for scrub, and the export path selects
  by timestamp so it stays correct.
