# Export benchmark, raw report (B-380, D-446), 2026-11-03

**What this is.** The raw output behind `README.md`'s "Export" section: the before and after of hardware
encode (D-446) on the B-380 benchmark, plus the encoder speed and quality sweeps that set the hardware
encoder's quality value and the ProRes choice.

**Machine.** The owner's MacBook, Apple M4 (4 performance + 6 efficiency cores, 10 logical), 24 GB. The machine
was shared with other agents' builds (load average 15–33 during the runs). Single runs (`APELLES_BENCH_REPEATS=1`):
read the big ratios, not the second decimal. ffmpeg: the bundled 9.0.2 (`CHROMA_FFMPEG=target/debug/ffmpeg`, D-389).

**Fixture.** `tests/fixtures/export-bench.json` (`packages/editor/src/exportBenchFixture.test.ts`): 60 s at
30 fps, 3 video tracks, 15 clips. A-roll in six jump cuts carries the voice; four B-roll cutaways (one full frame,
one rounded PIP, one crop into a box, one keyframed slide); a lower-third PNG with alpha twice; a moving overlay
twice; a music bed at -10 dB. Media is `testsrc2` with temporal grain and motion, encoded at a camera bitrate
(about 60 Mb/s at 4K).

**Commands.**

```sh
CHROMA_FFMPEG=$PWD/target/debug/ffmpeg CHROMA_FFPROBE=$PWD/target/debug/ffprobe \
APELLES_BENCH_SIZE=1080p APELLES_BENCH_SPLIT=1 APELLES_BENCH_LOUDNESS=1 \
cargo test -p apelles --lib chroma::edit_render::export_bench -- --ignored --nocapture
# 4K: APELLES_BENCH_SIZE=4k; the segment sweep: APELLES_BENCH_CONFIGS=compositor-hardware APELLES_BENCH_SEGMENTS=2,3,4,6
```

In each table, `software` is the pre-D-446 encoder (libx264; the filter path's is ffmpeg's `.mp4` default,
CRF 23) and `hardware` is VideoToolbox H.264 at q 70. `(no encode)` is the filter argv with its encoder removed:
decode + composite + scale only. `[auto]` is the segment count the app plans on this machine.

## 1080p

```text
=== B-380 export benchmark: 1920x1080 @ 30 fps, 60 s timeline (3 video tracks, 15 clips), media ready in 14.1s ===
decode floor (one track, A-roll 60 s, VideoToolbox → rgb24 pipe): 7.1s  x0.12
filter-software                  34.9s  x0.58   cpu   54% of 10  gpu avg  12% peak  78%  rss +  1027 MB  
    frames 1800/1800 · video 60.000s audio 60.011s (Δ 0.3 frames) · 47 MB · loudness pass 0.6s (1 attempt(s)): -28.40 → -14.00 LUFS, peak -3.30 dBTP
filter-software (no encode)      29.3s  x0.49   cpu   21% of 10  gpu avg  12% peak  33%  rss +   428 MB  decode + composite + scale only
filter-hardware                  29.6s  x0.49   cpu   20% of 10  gpu avg  12% peak  40%  rss +   382 MB  
    frames 1800/1800 · video 60.000s audio 60.011s (Δ 0.3 frames) · 95 MB · vs software: PSNR 44.556050 dB, SSIM 0.987763 · loudness pass 0.7s (1 attempt(s)): -28.40 → -14.00 LUFS, peak -3.30 dBTP
filter-hardware (no encode)      29.1s  x0.48   cpu   21% of 10  gpu avg  12% peak  62%  rss +   404 MB  decode + composite + scale only
compositor-software [auto]       53.0s  x0.88   cpu   86% of 10  gpu avg  12% peak  64%  rss +  3173 MB  segs 2 · render 52.5s [per-worker sums: decode+composite 70.9s, resize 0.0s, wait-on-encoder 23.8s] · concat 0.5s
    frames 1800/1800 · video 60.000s audio 60.011s (Δ 0.3 frames) · 125 MB · loudness pass 0.7s (1 attempt(s)): -28.40 → -14.00 LUFS, peak -3.30 dBTP
compositor-hardware [auto]       21.3s  x0.35   cpu   55% of 10  gpu avg  12% peak  13%  rss +  1908 MB  segs 2 · render 20.9s [per-worker sums: decode+composite 36.4s, resize 0.0s, wait-on-encoder 0.8s] · concat 0.4s
    frames 1800/1800 · video 60.000s audio 60.011s (Δ 0.3 frames) · 85 MB · vs software: PSNR 46.926702 dB, SSIM 0.991727 · loudness pass 1.1s (1 attempt(s)): -28.40 → -14.00 LUFS, peak -3.30 dBTP
```

## 4K

```text
=== B-380 export benchmark: 3840x2160 @ 30 fps, 60 s timeline (3 video tracks, 15 clips), media ready in 50.5s ===
decode floor (one track, A-roll 60 s, VideoToolbox → rgb24 pipe): 18.7s  x0.31
filter-software                 166.8s  x2.78   cpu   55% of 10  gpu avg  12% peak  74%  rss +  3076 MB  
    frames 1800/1800 · video 60.000s audio 60.011s (Δ 0.3 frames) · 175 MB · loudness pass 0.9s (1 attempt(s)): -28.40 → -14.00 LUFS, peak -3.20 dBTP
filter-software (no encode)     141.3s  x2.36   cpu   21% of 10  gpu avg  25% peak  72%  rss +  1464 MB  decode + composite + scale only
filter-hardware                 147.7s  x2.46   cpu   21% of 10  gpu avg  23% peak  98%  rss +  1149 MB  
    frames 1800/1800 · video 60.000s audio 60.011s (Δ 0.3 frames) · 379 MB · vs software: PSNR 44.327005 dB, SSIM 0.988016 · loudness pass 1.6s (1 attempt(s)): -28.40 → -14.00 LUFS, peak -3.20 dBTP
filter-hardware (no encode)     156.1s  x2.60   cpu   21% of 10  gpu avg  18% peak  70%  rss +  1249 MB  decode + composite + scale only
compositor-software [auto]      243.7s  x4.06   cpu   83% of 10  gpu avg  14% peak  64%  rss +  6669 MB  segs 2 · render 242.5s [per-worker sums: decode+composite 328.5s, resize 0.0s, wait-on-encoder 109.1s] · concat 1.1s
    frames 1800/1800 · video 60.000s audio 60.011s (Δ 0.3 frames) · 470 MB · loudness pass 0.9s (1 attempt(s)): -28.40 → -14.00 LUFS, peak -3.20 dBTP
compositor-hardware [auto]       83.0s  x1.38   cpu   53% of 10  gpu avg  17% peak  63%  rss +  3998 MB  segs 2 · render 81.7s [per-worker sums: decode+composite 142.2s, resize 0.0s, wait-on-encoder 2.2s] · concat 1.3s
    frames 1800/1800 · video 60.000s audio 60.011s (Δ 0.3 frames) · 338 MB · vs software: PSNR 47.035092 dB, SSIM 0.992141 · loudness pass 1.4s (1 attempt(s)): -28.40 → -14.00 LUFS, peak -3.20 dBTP
```

## 4K, compositor + hardware encoder, segment sweep

```text
=== B-380 export benchmark: 3840x2160 @ 30 fps, 60 s timeline (3 video tracks, 15 clips), media ready in 0.0s ===
decode floor (one track, A-roll 60 s, VideoToolbox → rgb24 pipe): 18.8s  x0.31
compositor-hardware [2]          82.3s  x1.37   cpu   52% of 10  gpu avg  20% peak  68%  rss +  3904 MB  segs 2 · render 81.0s [per-worker sums: decode+composite 140.5s, resize 0.0s, wait-on-encoder 2.4s] · concat 1.3s
    frames 1800/1800 · video 60.000s audio 60.011s (Δ 0.3 frames) · 338 MB
compositor-hardware [3]         105.9s  x1.76   cpu   50% of 10  gpu avg  13% peak  47%  rss +  5230 MB  segs 3 · render 104.6s [per-worker sums: decode+composite 285.7s, resize 0.0s, wait-on-encoder 2.1s] · concat 1.2s
    frames 1800/1800 · video 60.000s audio 60.011s (Δ 0.3 frames) · 331 MB
compositor-hardware [4]          98.6s  x1.64   cpu   58% of 10  gpu avg  12% peak  46%  rss +  5806 MB  segs 4 · render 97.3s [per-worker sums: decode+composite 341.2s, resize 0.0s, wait-on-encoder 2.5s] · concat 1.3s
    frames 1800/1800 · video 60.000s audio 60.011s (Δ 0.3 frames) · 331 MB
compositor-hardware [6]         119.5s  x1.99   cpu   53% of 10  gpu avg  12% peak  32%  rss +  7868 MB  segs 6 · render 117.9s [per-worker sums: decode+composite 648.2s, resize 0.0s, wait-on-encoder 1.8s] · concat 1.6s
    frames 1800/1800 · video 60.000s audio 60.011s (Δ 0.3 frames) · 331 MB
```

The single-lane run, made while a `sample` profile was attached: `compositor-hardware [1]` 235.1 s (x3.92), CPU
21%, render 233.5 s [decode+composite 216.8 s, wait-on-encoder 5.1 s]. The profile's busy samples:
`blend_layer_sampled` about 58%, pipe `read` (decode) about 28%, pipe `write` (to the encoder) about 10%,
`to_rgba8_parallel` about 2% (`docs/notes/export-gpu-compositor.md` §13).

## Encoder speed: 10 s of grainy 4K, decoded and piped as raw RGBA into each encoder

Load average 8 to 79 during this sweep, so the ratios are indicative.

| encoder | seconds | × real time | file |
|---|---:|---:|---:|
| decode only (`-f null`) | 7.6 | 0.76 | — |
| libx264 `-crf 18` | 76.2 | 7.62 | 111 MB |
| `h264_videotoolbox -q:v 65` | 11.8 | 1.18 | 34 MB |
| `hevc_videotoolbox -q:v 65` | 12.0 | 1.20 | 29 MB |
| `prores_ks` profile 3 | 60.6 | 6.06 | 1159 MB |
| `prores_videotoolbox` profile 3, fed `p210le` | 9.5 | 0.95 | 1129 MB, **wrong picture** (PSNR 23.8 dB vs `prores_ks`) |
| `prores_videotoolbox` profile 3, fed `bgra` | 15.0 | 1.50 | 1170 MB, PSNR 42.3 dB / SSIM 0.990 vs `prores_ks` |

## Encoder quality: 10 s of 1080p (grain `alls=4`), each against the source

Every encode goes through the same RGBA pipe, so the RGBA round trip caps all of them equally. Speed column: the
decode-only run took 2.04 s.

| encoder | seconds | file | PSNR dB | SSIM | VMAF |
|---|---:|---:|---:|---:|---:|
| libx264 `-crf 18` | 7.35 | 15.3 MB | 41.318 | 0.9496 | 97.25 |
| VT H.264 q 60 | 2.36 | 8.1 MB | 40.337 | 0.9494 | 95.97 |
| VT H.264 q 65 | 2.18 | 9.7 MB | 40.806 | 0.9503 | 96.57 |
| **VT H.264 q 70** (chosen) | 2.32 | 12.5 MB | **41.318** | **0.9513** | **97.23** |
| VT H.264 q 75 | 2.36 | 15.0 MB | 41.528 | 0.9517 | 97.55 |
| VT HEVC q 65 | 2.31 | 9.8 MB | 40.687 | 0.9501 | 96.39 |
| `prores_ks` HQ | 9.95 | 292 MB | 42.180 | 0.9709 | 95.48 |
| **`prores_videotoolbox` HQ, `bgra`** (chosen) | 2.48 | 297 MB | **42.299** | **0.9733** | **97.63** |

## Determinism

The same 1080p input encoded twice: VT H.264 q 70 decoded frame md5 `785b1eea…` both times, and VT ProRes
`c9c0418f…` both times. The `.mp4` file bytes differed between the two H.264 runs. D-446 records what this means
for the determinism contract.
