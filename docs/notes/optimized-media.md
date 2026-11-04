# Optimized media: one conversion at import, one decode path (D-453)

**Decision:** D-453 (D-452 step 3). **Code:** `crates/apelles-media/src/optimized_media.rs` (+ `tests.rs`),
`decode_pipe.rs` (`FramePipe::open`), `vt_decode.rs` (empty edits, B-384);
`app/src-tauri/src/chroma/media_conversion.rs`; `apelles_project::MediaItemDto::conversion`;
`packages/bridge/src/media.ts` (`conversion`, `cancelConversion`, the progress event);
`packages/editor/src/MediaConversionOverlay.tsx`, `PreviewConversionNotice.tsx`, `conversionNotice.ts`;
`editor_cancel_media_conversion` and `editor_list_media`'s `conversion` / `previewable` /
`awaitingConversion` on both MCP servers.

## 1. The shape

D-452 put decode on the media engine: `AVAssetReader` → VideoToolbox → IOSurface frames the GPU engine
converts. AVFoundation opens the QuickTime family (`.mov`, `.mp4`, `.m4v`) only; the importer also accepts
Matroska / WebM, AVI, MPEG-TS (`.mts`, `.m2ts`) and MXF. Until this step those were decoded by an `ffmpeg`
pipe, a second decoder. The owner's call (2026-11-04): convert them once at import into a `.mov` the media
engine reads, Final Cut's "optimized media", and delete the pipe.

```
 import / project open                       decode (preview, scrub, export, Colorist)
 ─────────────────────                       ─────────────────────────────────────────
 pool item  ──▶ optimized_media::request     FramePipe::open(original path)
 (original     │ one worker thread               │
  path kept)   ▼                                 ▼
          ffmpeg  hevc_videotoolbox ──▶  <project>.chroma/optimized-media/<source_key>.mov
                                         <source_key>.json  (pix_fmt, matrix)
                                                 │
                                                 ▼
                                         vt_decode::Reader (AVAssetReader, VideoToolbox)
```

- **The project file is never rewritten.** Clips and pool items keep the original path; `decode_source`
  maps it to `<project>/optimized-media/<media_cache::source_key(original)>.mov` at open time. Relinking
  works as before, and a source rewritten in place has a new key, so it is converted again and the old
  file is pruned (`optimized_media::prune`, on every project open and import).
- **No project open** (a loose clip opened in the Colorist): the app cache's `optimized-media/` folder,
  beside the media cache, not inside it (that one is pruned to a size budget).
- **Who asks.** Import (`chroma_media_import`) and project open (`open_manifest`, which is how an existing
  project whose sources need converting gets converted, with the same progress UI), both through
  `media_conversion::convert_project_sources` (the pool's video items plus every timeline clip's source).
  A decode of a source never asked about queues it itself; a decode of a cancelled or failed one does not
  restart it — re-probing the item does (`chroma_media_reprobe`, the Sources tile's "Convert again",
  `editor_reprobe_media`).
- **One at a time.** One worker thread; the queue is FIFO. Switching projects cancels the outgoing one's
  conversions (they resume when it is opened again).

## 2. The conversion, measured

The argv (`optimized_media::conversion_args`):

```
ffmpeg -nostdin -loglevel error -nostats -progress pipe:1 -copyts [-c:v libvpx-vp9]
       -i SRC -map 0:<video stream> -an -sn -dn -map_metadata -1
       -c:v hevc_videotoolbox -q:v 75 -bf 0 -g <round(fps)> -tag:v hvc1
       (-pix_fmt nv12 -profile:v main | -pix_fmt p010le -profile:v main10 | -pix_fmt bgra -alpha_quality 0.75)
       [-color_range pc]
       -fps_mode passthrough -enc_time_base demux -video_track_timescale <source time base>
       -f mov DEST.partial.mov
```

### Codec and quality

Three lossless 1080p30 masters (a hard-edged chart, a moving fractal, a gradient with temporal grain),
each encoded into the delivery files a conversion actually sees, then converted. PSNR-Y and SSIM are of the
converted file against the **decode of the source it was made from** (the picture the deleted pipe drew),
paired frame by frame.

```text
source                       q    size vs source   PSNR-Y (worst frame)   SSIM
chart  VP9 WebM 9.4 Mb/s     70   1.18x            49.5 (48.0)            0.9970
                             75   1.39x            51.2 (49.4)            0.9975
                             80   1.73x            53.7 (51.9)            0.9984
chart  H.264 .mts 24 Mb/s    75   0.50x            52.3 (51.2)            0.9986
mandel VP9 WebM 17.8 Mb/s    70   1.23x            45.8 (44.2)            0.9930
                             75   1.45x            47.1 (45.6)            0.9935
                             80   1.80x            49.3 (47.8)            0.9949
mandel H.264 .mts 26 Mb/s    75   0.87x            47.6 (45.8)            0.9943
mandel H.264 .mkv 11.9 Mb/s  75   1.80x            47.5 (45.8)            0.9940
grain  H.264 .mts 25 Mb/s    70   3.51x            42.4 (37.1)            0.9781
                             75   4.12x            43.7 (38.7)            0.9845
                             80   5.19x            45.9 (41.1)            0.9909
```

**`-q:v 75`.** It keeps every frame of the two textured sources at or above 45 dB against the original's
decode (70 drops the fractal's worst frame to 44.2), at 0.5–1.8× the delivery file's size; 80 costs
another 25–30% of size for about 2 dB in an intermediate that is re-encoded at export anyway. Grain is the
hard case for every codec (a per-pixel temporal noise field): 38.7 dB worst frame at 75.

**HEVC, confirmed over ProRes.** ProRes 422 HQ is 220 Mb/s at 1080p30 (7–17× the HEVC file on these
sources), `prores_videotoolbox` re-tags an untagged source as BT.709 and converts its values (19.98 dB
against the source on the chart: not usable as a lossless-looking intermediate without extra handling), and
only M1 Pro and later have a ProRes decode engine, while every Apple Silicon Mac decodes HEVC in hardware.
The software ProRes encoder (`prores_ks`, 49 dB) was not considered: the hardware encoder is required.

### What the argv keeps, and why each option is there

- **Timestamps.** Without `-fps_mode passthrough` and `-enc_time_base demux`, ffmpeg retimed a Matroska
  source's millisecond timestamps onto a 1/30 grid and dropped or duplicated frames (a 10-bit fixture fell
  to 25 dB until both were set). With them, every packet's presentation time is the source's own
  (`-video_track_timescale` is the source stream's time base, reduced: 1000 for Matroska/WebM, 90000 for
  MPEG-TS, 30000 for a 1001/30000 AVI), and `-copyts` keeps an MPEG-TS start offset (1.4 s) as an empty
  edit. So the D-228 grid picks the same frame for every nominal index, holds of a variable-frame-rate
  source included.
- **No B-frames** (`-bf 0`): presentation order is decode order, so there are no composition offsets for
  ffmpeg and AVFoundation to read differently (export-gpu-compositor.md §16.2). **A sync sample every
  second** (`-g round(fps)`): a seek decodes at most a second forward; 1.6% larger than a 10-second
  interval.
- **Depth and chroma.** More than 8 bits → Main 10 (`p010le`); measured 56–58 dB on a 10-bit source.
  VideoToolbox's HEVC encoder takes 4:2:0 only (bundled ffmpeg 9.0's `p210le` path silently came out
  4:2:0 too), so a 4:2:2 / 4:4:4 source is subsampled to 4:2:0 (luma 58.7 dB, chroma 44–48 dB against a
  4:2:2 10-bit source). The converted file's own pixel format is recorded, so the engine decodes its real
  layout.
- **Range.** A full-range source (MJPEG, `color_range=pc`) stays full range (`-color_range pc`): the
  MJPEG AVI fixture's luma is within 47.6 dB of its original's.
- **Alpha.** A source with alpha in its pixels, or a VP8/VP9 WebM with `alpha_mode=1` (side-channel alpha,
  decoded with libvpx), becomes HEVC with alpha, fed BGRA. VideoToolbox codes that BGRA with BT.709 and
  writes no matrix tag whatever it is told (base layer 42 dB as BT.709, 28 dB as BT.601); a `-c copy` remux
  that adds the tag drops the alpha layer. So the matrix is recorded in the converted file's facts
  (`<key>.json`), and the decode uses it. Measured: alpha 56.4 dB, colour 40.4 dB (through two matrices and
  two chroma subsamplings). The engine composites video opaque, as it did before (the pipe was rgb24); the
  alpha is in the file for when it does not.
- **The hardware encoder is required** (`hevc_videotoolbox` without `-allow_sw`). A failure is an error
  that names the source and quotes ffmpeg's last lines; nothing encodes in software instead.
- **The media engine reads the file before it counts.** The partial file is opened by `vt_decode` and its
  first frame decoded; a file AVFoundation refuses is an error naming the source, not a black clip later.
  This caught a real case: Homebrew's ffmpeg 7.1 writes an HEVC-with-alpha `.mov` AVFoundation will not
  start reading; the bundled 9.0.2 (what the app runs, D-389) writes one it reads.

### Speed

```text
1080p30 H.264 .mkv   194 fps   6.5x real time
1080p30 VP9 .webm    201 fps   6.7x real time
4K30 H.264 .mkv       57 fps   1.9x real time
4K30 VP9 .webm        57 fps   1.9x real time
```

(M4, bundled ffmpeg 9.0.2, source decode included.) A one-hour 4K Matroska source converts in about half
an hour; nothing else in the app waits on it, and the clip can be placed and edited meanwhile.

## 3. State, GUI and MCP

`optimized_media` holds each source's `ConversionStatus` (`queued` / `converting` + `progress` / `ready` /
`failed` + `error` / `cancelled`; a converted file on disk with no job is `ready`) and tells one listener
every change and every whole percent. The app forwards it as `chroma://media-conversion`
(`{ sourcePath, conversion }`); the media pool store applies it to its items while a project is open, and
`MediaItemDto::conversion` reads the same state live, so `chroma_media_list` (and through it
`editor_list_media`) reports it.

- **Sources tile:** `MediaConversionOverlay` — "Waiting to convert" / "Converting 42%" with a determinate
  bar and a Cancel, or a warning with "Convert again" (a re-probe). The context menu has "Cancel
  conversion".
- **Preview:** a source under the playhead that is not converted cannot be drawn. The frame command
  returns the decode's error naming the file and its state, and the preview shows
  `PreviewConversionNotice` in place of the picture (which file, how far, Cancel / Convert again), keyed
  so it re-renders only when what it shows changes; when the last one finishes, the frame is fetched again.
  An export fails with the same error naming the source.
- **MCP:** `editor_list_media` rows carry `conversion` and `previewable`, the response `awaitingConversion`;
  `editor_cancel_media_conversion(ids)` cancels (parallel to `editor_cancel_export`) and reports each
  item's `wasConverting` and new `conversion`; `editor_reprobe_media` starts a cancelled or failed one
  again. 276 / 257 tools (debug / release).

## 4. Tests and tolerances

`optimized_media::tests` (fixtures generated per run, 3 s at 320×240 unless noted):

| test | what it asserts |
|---|---|
| `every_container_converts_to_a_mov_that_decodes_to_the_originals_frames` | H.264 `.mkv` (BT.709), VP9 `.webm` (untagged), MJPEG `.avi` (full-range 4:2:2), H.264 `.mts` (1.4 s start): the converted file decoded by VideoToolbox has the same number of grid slots to the end as ffmpeg's conformed decode of the original, from frame 0 and from 1, 29, 45; every frame's luma ≥ **40 dB** PSNR against the original's decode, and closer to its own index than to either neighbour. Measured worst frames: 49.1 / 47.8 / 47.6 / 49.0 dB. |
| `a_held_frame_of_a_vfr_source_is_held_for_the_same_slots_after_conversion` | the D-228 VFR shape (a two-second hold) in Matroska, from eight start points before, at, inside and after the hold, and the same slot count to the end. |
| `a_ten_bit_source_stays_ten_bit` | Main 10; 10-bit luma ≥ 40 dB (measured 56.3). |
| `a_source_with_alpha_becomes_hevc_with_alpha` | VP9 alpha WebM: the alpha as AVFoundation decodes it ≥ 40 dB (56.4), colour ≥ 35 dB (40.4), the matrix recorded; on an ffmpeg older than 8 (Homebrew 7.1) it must be refused with an error naming the file instead. |
| `converting_the_same_source_twice_gives_the_same_pictures` | determinism: two conversions decode to identical planes (the files differ in bytes; the pictures do not). |
| `a_cancelled_conversion_leaves_nothing_behind` | a cancel mid-run is an error, with no converted and no partial file. |
| `the_queue_converts_reports_and_maps_the_decode_to_the_converted_file` | queued → converting → ready through the listener; the decode maps into the project's folder; asking again is a no-op; a stale converted file and its facts are pruned. |
| `a_queued_conversion_can_be_cancelled_and_asked_for_again` | a queued and a running cancel, nothing half-written, a decode does not restart a cancelled source, a request does. |

Also: `decode_pipe::tests::a_source_that_needs_converting_plays_through_its_converted_file` (the pool,
keyed by the original path), `vt_decode::tests::an_empty_edit_at_the_start_holds_the_first_frame_not_black`
(B-384), `chroma::media_conversion::tests::opening_an_existing_project_converts_its_sources_and_the_pool_reports_it`
(conversion on open), and the frontend's `conversionNotice.test.ts`, `MediaConversionOverlay.dom.test.tsx`
and `media.test.ts` (the event, the cancel).

**Why 40 dB and not equality.** The conversion is a second lossy generation; equality is not available.
40 dB sits well under every measured frame (47–56 dB) and well above what a wrong frame (12–20 dB against a
neighbour on `testsrc2`) or a range / matrix mistake (25–30 dB) scores, so it catches the failures that
matter and survives encoder variation across Macs.

## 5. What went with the pipe, and what ffmpeg still does

Deleted: `decode_pipe`'s ffmpeg arm (`FfmpegStream`, the `rgb24` reads, the `-hwaccel videotoolbox` retry
in software and its per-source memo, D-125's hardware-decode policy for this path), `Decoded::Rgb` (and the
`Decoded` enum: a stream returns a `VideoFrame`), the decode `scale` argument (`playback_frame_scaled` →
`playback_frame`, `PrefetchSpec::scale`, `FramePipe::open_scaled` → `open`), and the pipe-only tests
(the software-pipe VFR/B-104 walks, the scaled-pipe test, the pipe-vs-`decode_frame` comparisons). The pool
tests moved onto `.mp4` fixtures and the media engine.

Still ffmpeg, on purpose: the conversion itself; probing (`ffprobe`); thumbnails, filmstrips and
single-frame stills (`video::extract_thumb*`, `video::decode_frame`); scene detection (`scenes`); the
export's sound mix and its remux (`-c:v copy`, D-197, `chroma::edit_render`); the loudness pass (D-401);
the Colorist's single-clip export (`chroma::export`); the generic argv runner (`chroma::ffmpeg_run`); and,
in debug builds only, the debug video recorder's mux (`chroma::debug_record`). None of these decodes a
frame for the preview, a scrub or the export's picture.
