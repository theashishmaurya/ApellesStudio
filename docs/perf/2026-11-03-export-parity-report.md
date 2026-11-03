# Export parity on the owner's projects: filter path vs compositor (B-380, D-448), 2026-11-03

**What this is.** The check that decided D-448 (one export renderer, the compositor; the ffmpeg filter-graph
path deleted). Copies of three of the owner's projects were exported both ways and compared frame by frame,
sample by sample. The harness (`chroma::edit_render::export_parity_real::measure_real_project_parity`, with its
TypeScript half `packages/editor/src/exportParityReal.test.ts`) is in history at the commit before D-448's,
and was deleted with the path it compared against.

**Setup.** APFS clones (`cp -c`) of `Nemotron Transcribe.chroma`, `Five Levels of Claude Code.chroma` and
`2026-09-12-c040-mgfx-recut.chroma` in a scratch directory; the originals were never opened. Each case was
compiled with the real `compileEditorExportArgs` once per renderer (the backend's answers — fonts,
composition size, baked grades, caption word widths — served from the clone), exported at 1080p on the short
edge with the same encoder (VideoToolbox H.264 q 70), and deleted once measured. Machine shared with another
agent's 4K benchmark, so the timings are indicative only.

**Projects chosen for coverage.** Nemotron: text, keyframes, fades, karaoke captions, mixed 3840/2880/2160/1480
sources, a 52 s 9:16-style whole timeline. Five Levels: titles, keyframed cards, mixed 24/30/60 fps screen
recordings, EQ. c040-mgfx-recut: rounded PIPs, keyframed crops, split screen on a 24.005 fps camera in a
30 fps timeline. None of the three uses transitions, adjustment clips, speed ramps, dynamic zoom, highlights,
a non-identity grade or the Clip exceptions, so a **coverage timeline** was built from c040's own footage for
those (2 s per effect), plus three Clip-exception cases. The grades on it were written into the clone the way
the Colorist writes them: primaries (exposure, contrast, saturation, temperature, highlights, shadows); the
same with curves and a `.cube` in the LUT slot, on a clip under a transform, crop and rounded corners; and
primaries with a radial mask.

## Results

`PSNR` / `SSIM` are the compositor's file against the filter path's, per frame (mean, worst). Audio is the
sample difference at the best lag (−200 dBFS = bit-identical). Times are each path's wall time for the case.

| Case | Effects | Frames | A/V | Audio diff | LUFS / dBTP (both) | PSNR mean / min | SSIM mean / min | Filter / compositor s |
|---|---|---|---|---|---|---|---|---|
| Five Levels @12.4 s | text | 24 = 24 | 0 | −200 dB | −27.6 / −16.8 | 39.8 / 38.5 | 0.998 / 0.998 | 0.8 / 1.5 |
| Five Levels @0.3 s | plain clip, identity grade | 28 = 28 | 0 | −200 dB | −23.8 / −12.1 | 46.2 / 45.7 | 0.992 / 0.991 | 2.4 / 2.7 |
| Five Levels @2.5 s | keyframes, mixed fps / size, text | 48 = 48 | 0 | −200 dB | −28.3 / −12.6 | 17.8 / 15.7 | 0.885 / 0.856 | **180 / 5.5** |
| Nemotron Voiceover v2 @0.5 s | text, fades, keyframes, mixed size | — | — | — | — | filter path **failed** (ffmpeg exit 234) | — | — / 5.1 |
| Nemotron Short 1, whole (52 s, 1480×1080) | captions (karaoke), keyframes, mixed size | 1560 = 1560 | 0 | −200 dB | −21.1 / −5.2 | 25.4 / 3.7 | 0.937 / 0.429 | 33 / 189 |
| Nemotron Short 1 @0.3 s | captions, keyframes, mixed size | 90 = 90 | 0 | −200 dB | −22.4 / −9.6 | 19.9 / 17.4 | 0.923 / 0.862 | 0.8 / 5.0 |
| c040 @2.9 s | rounded, crop, keyframes, mixed fps / size | 72 = 72 | 0 | −200 dB | −24.5 / −9.9 | 14.0 / 9.6 | 0.755 / 0.711 | **1033 / 12** |
| c040 @0.3 s | 24.005 fps source on a 24 fps timeline | 58 = 58 | 0 | −200 dB | −22.1 / −8.4 | 35.9 / 30.8 | 0.958 / 0.925 | 0.8 / 0.8 |
| Coverage (20 s) | transitions, adjustment, speed ramp, dynamic zoom, highlights, 3 grades, fades, rounded, crop | 600 = 600 | 0 | −200 dB | −19.4 / −4.0 | **41.6** / 16.4 | 0.977 / 0.756 | 924 / 212 |
| Clip exception: speed ×2 | speed override | 90 = 90 | 0 | −200 dB | −20.0 / −6.9 | 45.0 / 33.9 | 0.997 / 0.988 | 5.2 / 21.4 |
| Clip exception: Stretch to fill | fit override on a cropped clip | 90 = 90 | 0 | −200 dB | −19.1 / −6.4 | 37.8 / 31.7 | 0.990 / 0.981 | 4.5 / 17.8 |
| Clip exception: Hold last frame | freeze + speed | 90 = 90 | 0 | −200 dB | −20.0 / −6.9 | 41.1 / 33.9 | 0.994 / 0.988 | 2.1 / 41.4 |

Durations and stream starts were equal to the millisecond in every case (video and audio both start at 0, and
their lengths agree), so the A/V offset is 0 throughout. The sound is bit-identical in every case: the audio
mix was always one compiler (`timelineExportAudio.ts`) shared by both paths.

### The worst frames, and what each one is

The harness wrote each case's two worst frames out as compositor | filter | difference ×4, and for the worst
one also compared the compositor frame with the filter's neighbouring frames (`worstVsFilterNeighbours`).

- **Text (38.5 dB, SSIM 0.998).** Glyph-edge antialiasing only: the two engines rasterise the same font file
  (ab_glyph vs FreeType `drawtext`). Identical layout.
- **Plain clip (45.7 dB).** Encoder noise.
- **c040 @2.9 s (9.6 dB).** The filter path draws the split-screen layout as a full-frame zoom on the presenter's
  head; the compositor draws the split screen with the card beside it — the layout the Edit tab shows (the
  compositor is the preview's own `render_timeline_frame`). Keyframed crop + scale on a 4K source in a
  different-rate timeline. Neighbouring frames do not match either (6.5 dB): a different picture, not a timing
  difference.
- **Five Levels @2.5 s (15.7 dB).** A keyframed card is drawn larger and offset on the filter path, with a
  second copy of its frame showing behind it; the compositor draws it once, where the preview has it.
- **Nemotron Short 1 (17.4 dB in the range, 3.7 dB worst in the whole timeline).** The filter path draws the
  picture box taller, covering the caption beneath it; the compositor keeps the caption clear, as the preview
  does. The 3.7 dB frame (1544 of 1560) is a clip's last frame: the compositor's frame 1544 equals the filter's
  frame 1545 exactly (104 dB). The compositor ends that clip where the timeline model says it ends
  (`Clip::end_frame_at`, what the timeline draws); the filter path's `enable=between(t,…)` lets it run one
  frame longer.
- **c040 @0.3 s (30.8 dB).** The compositor's frame n matches the filter's frame n−1 (35.8 vs 27.5 dB): on a
  24.005 fps camera the filter path's seek lands one frame ahead. By the frame arithmetic (source frame
  77 + ⌊n × 24.005 / 24⌋ is the frame on screen at n / 24 s) the compositor's frame is the right one. This was
  also where **B-382** was found: before the fix the compositor rounded that conversion instead of flooring it,
  showing the next source frame for half of each frame's screen time on any clip whose rate is not the
  timeline's (fixed, `a_mixed_rate_clip_shows_the_frame_on_screen_not_the_next_one`).
- **Coverage (mean 41.6 dB; worst 16.4 dB at frame 352).** The worst frame is the speed-ramped clip's last
  frame: the compositor's frame 352 equals the filter's frame 353 (84 dB) — the same one-frame clip-end
  convention as above. The transitions, the adjustment clip, the dynamic zoom, the highlights and the three
  graded clips match to 24–45 dB per frame, with the lowest frames inside the cross dissolve and the speed
  ramp, where the two engines pick handle / ramp frames one frame apart.
- **Clip exceptions (37.8–45.0 dB, SSIM ≥ 0.981).** Implemented in the compositor by D-448 (they were refused
  before) and matching the filter path's reading of them; the worst frames are again one frame apart on the
  24 fps source in the 30 fps exception timeline.

### Grading: both exports against the Colorist's own render

For the full-frame graded coverage clips, the harness rendered the same source frame through the Colorist's
own pipeline (`chroma::export::grade_frame`, the Colorist export's per-frame render, masks included) and
compared both exports with it.

| Clip | Compositor vs filter | Compositor vs Colorist | Filter vs Colorist |
|---|---|---|---|
| Primaries (exposure, contrast, saturation, temperature, highlights, shadows) | 39.6 dB | 19.6 dB | 19.5 dB |
| Primaries + radial mask | 38.3 dB | 20.4 dB | 20.3 dB |

- **The compositor carries exactly what the filter path carried** — the same baked lattice (D-256), applied
  per pixel — so deleting the filter path drops no grade feature. Curves and an applied `.cube` are in the
  lattice; the masked clip's mask is in neither export (it was named in the warning on both).
- **Both differ from the Colorist's render of real footage** (≈ 20 dB). Two measured causes:
  - The bake left neighbourhood and position effects (vignette, grain, sharpening, clarity, structure, dehaze,
    centre, noise reduction, chromatic aberration, glow, halation, flare, lens blur) IN the lattice render,
    where they baked the lattice image's layout into the colours. Fixed (B-381): they are left out of the
    lattice and named.
  - Contrast, shadows, highlights, whites and blacks are local tone operators in the Colorist's shader (they
    read a blurred neighbourhood, `tonal_blur_texture`). On a flat colour the lattice reproduces the shader to
    within 3 codes (`the_lattice_matches_the_grade_shader_on_flat_colour`), so the LUT is right for what a LUT
    can be; on textured footage the local part is lost. That is now said in the grade warning instead of
    being presented as "carried exactly".
  - Not fully explained: the side-by-side also shows a warmer overall cast on the exports than on the
    Colorist render, more than local detail would account for. Logged in B-381 as the open part, with these
    numbers; the next step is to render the Colorist reference with the grade loaded through
    `apelles_grade_model::load_grade` (as the bake does) to rule out a schema-migration difference in the
    reference itself.
- **The Export panel's grade note** now appears when the panel opens, not in the instant after Export is
  pressed, and says what the Edit tab and the export show (B-381).

## Verdict and threshold

Sound, timing, length and loudness: identical in every case. Picture: where only the renderer differs (text,
plain footage) the two match to encoder noise. Every frame below 40 dB / 0.98 SSIM was looked at and is one of:
the filter path drawing a layout different from the Edit preview (three projects), the filter path failing
outright (one range), the filter path running a clip one frame longer than the timeline model, or one frame
apart on a mixed-rate source — and the one compositor defect among them (B-382) is fixed. The filter path is not
the reference: on the owner's own projects it is the renderer that disagrees with the preview. D-448 made the
compositor the only renderer on that basis.

Speed, on the ranges the filter path managed at all: c040's rounded / keyframed range took 1033 s on the
filter path and 12 s on the compositor; Five Levels' keyframed range 180 s vs 5.5 s. The compositor was slower
on the coverage-type cases with 4K sources sped up or held (the Clip exceptions, 18–41 s for 3 s): a speed
ramp or a held frame makes the decode pipe seek per frame. Logged as the open part of B-380's per-feature
cost, not a parity issue.
