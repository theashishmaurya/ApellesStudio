# CHANGELOG

One or two lines per session. Detail lives in the decision it references.

## [Unreleased]

- **2026-09-19** — **B-216: consolidated the retake/silence/transcription reliability status into one summary bullet, no code changed.** Answering an owner question about real-world cut quality by auditing the existing investigation trail rather than re-investigating: confirmed B-224/B-198/B-188/B-189 all fixed with their D-numbers, and confirmed the entry's own "still open" list is current — clip-straddling blindness (the bigger of the two, architecture not tuning), phantom duplicates, and the unpinned false-positive regression gap. See the new lead bullet in B-216, `docs/BUGS.md`.

- **2026-09-18** — **B-208 fixed (D-353): `scale` now means the same thing in the preview and the export.** The export compiler learned the preview's reading — `scale` × the clip's own native footprint, not × the output canvas — via a new `sourceFootprints` option fed from the media pool's already-probed dimensions (the compiler is still pure and still probes nothing) plus a new `compositionSize.ts` warm/snapshot so the synchronous compiler knows what the footprint is a fraction OF. `ClipTransform::effective_size` is untouched, per D-353; an export whose sources are the composition's own size is byte-identical. Verified at three levels, including the non-degenerate parity case this bug's own filing named as missing: a 160×120 source in a 320×240 canvas through real ffmpeg (confirmed to fail without the fix), and a `c-scaled` clip added to D-350's cross-engine `export-parity.json` harness, which the Rust compositor and the filter graph now diff pixel-for-pixel on a source that is NOT the composition's size — the one thing that fixture was previously built to avoid. Re-capturing the MCP parity corpus for the changed capability text also exposed two pre-existing `editor_export` divergences the stale corpus had been hiding (it predated D-350's `renderer` parameter): a reflowed docstring and a `renderer` typed as a bare `String` in Rust against Python's two-value literal, so its published schema had no `enum`. Both fixed — the parity gate goes 4/5 → 5/5.

- **2026-09-18** — **B-225 fixed: a `graph` layer's node labels now shrink with a canvas reflow (D-347) instead of colliding.** The originally-filed cause (`graph` missing from `propCatalog.ts`'s size-field registry) was wrong — it's registered fine; label font size was never a manifest field in ANY registry to begin with. `Graph.tsx` now derives label size from actual on-screen inter-node clearance in its own layout memo (a rendering-time computation, not a new manifest field — kept clear of B-213's concurrent, unrelated `propCatalog.ts` work). Test lives colocated in `Graph.test.ts`, using the real test runner `@apelles/motion-engine` gained concurrently via B-212, rather than the older cross-package pattern. See B-225 in `docs/BUGS.md`.

- **2026-09-18** — **B-232 found (not fixed): `@apelles/motion-engine`'s `tsc` is not actually clean, despite B-212's own commit claiming it was.** 10 real errors from B-212's own new `Emphasis.dom.test.tsx` (`HTMLElement.querySelector`/`.firstChild` not found), plus 2 pre-existing in `Scene3D.tsx` (`document` not found) — all one root cause, `tsconfig.json`'s `lib` has no `"dom"`. Found incidentally while verifying B-225 introduced no new `tsc` errors of its own (it didn't — neither `Graph.tsx` nor `Graph.test.ts` appears in this error list). See B-232 in `docs/BUGS.md`.
- **2026-09-18** — **D-356: fixed B-186, the on-canvas VIDEO transform box drawing over the wrong picture when the playhead sat off the selected clip** — the same `clipCoversFrame`/hidden-track gate D-317 already gave `CaptionTransformOverlay` for B-185, now also in `TransformOverlay.tsx`, confirmed against the Rust timeline resolvers not to conflict with D-209's separate "which frame to resolve" rule. 7 new DOM tests in `PreviewPane.transform.dom.test.tsx`.

- **2026-09-18** — **B-184 (and its duplicate B-210) fixed: `TimelinePane.tsx` is React-Compiler-clean again, so the Edit tab's hottest surface gets its auto-memoization back.** One ref read in the render body (`trimPressRef.current`, added with B-144's slip/slide preview) was costing the whole ~3,400-line file every bit of D-201's auto-memoization, silently. D-355 snapshots that press into state in `onDndDragStart` — beside the `setClipGrab` that has done exactly this since B-137 — rather than the suggested "set state from the pointerdown listener", which would have re-rendered the entire pane on every click in the edit area. The raw capture-phase listener is untouched, so its never-re-binds contract holds by construction. Verified with a negative control: breaking the snapshot fails 4 of `slipSlidePreview`'s 6 real-`PointerEvent` cases (both Alt-armed and both tool-picked entrances) while its two "ghost must still show" controls stay green. `reactCompiler.test.ts` 99/99, 48 drag-gesture DOM tests green, full editor suite 2043/2043, `tsc` unchanged at 3 pre-existing errors.

- **2026-09-18** — **B-203: `editor_get_timeline` now reports `boxWidth`/`boxHeight`.** The only preview/export-parity-safe sizing mechanism (`box_width`/`box_height`, per B-201) was writable and persisted but never read back — `timelineDto` (`useEditorControl.ts`) omitted the two fields entirely, so the natural write-then-read verification looked like a silent no-op. Both MCP surfaces (`mcp/server.py`, `crates/apelles-mcp/src/tools/edit.rs`) checked and confirmed pure passthroughs over this same DTO — no change needed there. See B-203 in `docs/BUGS.md`.

- **2026-09-18** — **B-172 fixed (D-354): `understand_video` can now actually bootstrap its own model.** `HF_HUB_OFFLINE=1` stays hardcoded on the VLM subprocess (correct, local-first — not the bug), but `ai-env/setup.sh --fetch-models` is a new explicit one-time download step, and the offline failure now raises a `UserFacingError` naming that exact command instead of dumping the raw `mlx_vlm.generate failed: ...` subprocess text. New test `ai-media/test_video_understand_offline_model.py` replays the real B-172 stderr through the detection helper and through `describe_frames` end-to-end.

- **2026-09-18** — **B-212: `emphasis`'s `pulse`/`glow` presets now actually draw from a manifest layer.** Both were children-only wrappers (`<div>{children}</div>` with a transform/filter on it), but a manifest layer is rendered `<C {...props} />` self-closing (`Video.tsx`) and can never have `children` — so both silently drew nothing, the entire time, from the one authoring surface that matters. Fixed by giving them the same `box`-driven self-drawn form `ring`/`scribble` already use in `Emphasis.tsx`, keeping their original motion formulas (`pulse`'s scale bob, `glow`'s breathing drop-shadow) applied to a real drawn shape instead of an empty wrapper. New `Emphasis.dom.test.tsx` renders the real manifest path and checks actual SVG output; `packages/motion-engine` gained a test runner (`vitest`/`@testing-library/react`/`jsdom`, already used elsewhere in the repo) in the process, since it had none. See B-212 in `docs/BUGS.md`.

- **2026-09-18** — **B-213: a `matrix` layer's `w`/`h` now mean the same thing on every surface.** `motion_set_layer_size` and `motion_list_layers` already agreed that `w`/`h` are the grid's TOTAL footprint (`w = cols*(cell+gap)-gap`), not the per-cell size — verified, not assumed. `motion_list_primitives`' catalog was the outlier: `{kind: "scalar", key: "cell"}` alone read as "the resizable field IS `cell`," which is what produced the original bug. Fixed by giving `sizeFields`'s `SizeKind` an optional `note`, populated for `matrix` only, stating the TOTAL-footprint reading explicitly — `text`/`deviceframe` (confirmed genuinely different: verbatim passthrough and an intrinsic-size ratio, respectively) are untouched. See B-213 in `docs/BUGS.md`.
- **2026-09-18** — **D-352/D-353/D-354: three owner calls needed before the open-backlog fix pass could start.** D-352: `editor_trim_clip`'s delta sign — the code (both engines) is right, the two MCP docstrings were wrong, fix the docs not the behavior. D-353: `scale`'s preview-vs-export unit split (B-208) — change the export to read real source dimensions rather than retroactively resizing every existing clip with a non-default `scale` on preview's side. D-354: `understand_video`'s model download (B-172) stays an explicit `ai-env/setup.sh --fetch-models` step, never an implicit first-call fetch, per CLAUDE.md's local-first rule.

- **2026-09-18** — **B-231: `editor_export`'s status can't be trusted in either direction.** A healthy compositor export on the real ~79-clip project reliably reports itself as `{"ok": false}` (the frontend RPC's fixed 20s timeout, hit on real project sizes even though the export goes on to succeed) — and, found earlier the same night, a genuinely hung export (the `apelles` render task died internally while the process itself stayed healthy and `"status": "ready"`) reported nothing at all, leaving a frozen, `moov`-atom-less corrupt file with zero surfaced error. Not fixed here — real progress/completion reporting is already D-350 phase 2's top punch-list item; this entry adds the "a hang looks identical to success" half so both gaps are tracked together. See B-231 in `docs/BUGS.md`.

- **2026-09-18** — **D-351 (D-350 phase 2): the export compositor now uses every core; the live preview deliberately still uses one.** Phase 1's render path was correct and memory-flat on the owner's real project (~3.2 GB vs 38-56 GB) but ran at **~5-6x the video's runtime on ~22% of a 10-core machine** — measured cause: a sequential frame loop in which **66.7% of the time was compositing, entirely single-threaded** (33.3% decode). Every per-pixel compositing pass is now row-parallel via `rayon` (already a direct dep, already this repo's pattern — no new dependency): `blend_layer_sampled`, a parallel `overlay` asserted byte-identical to `image`'s own, the corner-radius and opacity passes, `apply_adjustment_to_canvas`, and the RGB→RGBA widening. Plus the base layer's per-frame whole-canvas `clone()` is gone (a `Cow` — 33 MB/frame at 4K), and the encoder hand-off moved to a writer thread behind a bounded 4-frame channel (a stated 133 MB-at-4K bound, so this does not reintroduce B-229/B-230's unbounded-per-unit shape). **Measured 1.38x overall, 1.58x on the compositing half** (20 clips/1080p: 20.38 s → 14.79 s), reproducible at 1.29-1.31x as a same-binary `RAYON_NUM_THREADS` A/B. **Reported honestly: this does not reach the owner's "under 1x" goal** — ~31% is still serial decode and `image::imageops::resize` is still serial; phase 3 (contiguous-segment render with per-segment encode + concat) is what would, and `docs/notes/export-gpu-compositor.md` §9.2 records **why a naive `par_iter` over frames is both unsafe and slower** here. The preview is excluded because parallelising at preview sizes measurably broke an existing prefetch test by starving the decode child — it is byte- and thread-identical to before. Five new tests incl. a lossless end-to-end frame-order check; full `apelles` lib suite 366/366.

- **2026-09-18** — **D-350 phase 1: `editor_export` can now render its PICTURE through the app's own compositor instead of an ffmpeg filter graph.** New `chroma::edit_render` walks the timeline headlessly through `edit::render_timeline_frame` (split out of `timeline_frame_image` so the project manifest is resolved once, not ~14,000 times for a 4-minute export) and pipes one raw RGBA stream into a single ffmpeg process, which also carries D-197's existing audio mix unchanged. The picture goes through **no video filter graph at all** and the encoder opens **one input** whatever the clip count — both of B-228/B-229/B-230's multiplications gone by construction rather than by a cap. Opt-in via `editor_export`'s new `renderer` parameter on the GUI queue and both MCP surfaces; the old path stays the default. Verified with a REAL old-vs-new pixel comparison (both argvs compiled by the live TS compilers, frozen into a committed fixture a vitest test re-asserts every run, diffed by a Rust test at five timestamps covering a keyframed slide, rounded corners and a crop): two frames bit-identical, every other difference a one-pixel boundary line — 0.0000% solid difference after a 3x3 erosion on every frame — plus a same-frame-twice determinism check. Measured at 20 clips/1080p: peak RSS 1787 → 1463 MB (−18%), threads 100 → 149 (+49%, entirely `decode_pipe`'s uncapped per-pipe ffmpeg threads — a bounded constant, not a multiplication, and phase-2 work since that decoder is also live playback's). Also found and fixed by measurement: `FrameIntent::Playing`'s cut prefetch is actively harmful for a heavily-cut export (+35% RSS, 3x wall time). Design, numbers and the full deferral list: `docs/notes/export-gpu-compositor.md`.

- **2026-09-18** — **B-230: the other half of B-229's blowup — every clip's own `-i` got a full-width decoder frame-thread pool, so decode memory scaled as (clip count) × (CPU count) × (one 4K frame).** After B-229 bounded the thread count, the same real export still showed 38 GB in Activity Monitor. Root-caused with a measured reproduction at real 3840x2160, not guessed: the leading hypothesis — `overlay`'s default `eof_action=repeat` holding each finished branch's last frame — was **refuted** (worth only 7-9 %), and two controls killed the frame-retention story outright (4× shorter clips changed nothing; un-scattering the branches made it *worse*). The driver is frame threading: 20 4K branches measured 14,336 MB at ffmpeg's per-input `auto` default, 10,240 MB at `-threads 4`, and 7,684 MB at `-threads 1` — with `-threads 4 -thread_type slice` matching single-threaded, proving the cost is per *frame* thread. Fixed with a `TOTAL_DECODE_FRAME_THREADS = 8` budget shared across an export's video inputs (`-threads floor(8/inputs)` before each video `-i`, one-clip exports left at ffmpeg's default): re-measured 14,336 MB → 7,735 MB, threads 285 → 65, with all 61 real-ffmpeg picture/audio tests still green. See B-230 in `docs/BUGS.md`.

- **2026-09-18** — **B-229 (critical): `editor_export` had no cap on ffmpeg's per-filter-instance thread pool — one real export ballooned to 3,065 threads and 56 GB of memory,** a genuine crash risk the owner caught live via Activity Monitor and killed. Root-caused with a controlled, measured reproduction (not guessed): `-filter_complex_threads` defaults to CPU count but multiplies per filter INSTANCE, not once per graph, so a heavily-cut project's ~400+-instance overlay/crop/geq chain multiplies out catastrophically; `-filter_threads` (the more commonly-known flag) is confirmed a no-op for this graph shape. Fixed with one line — `-filter_complex_threads 2` on every export — bounding memory/threads to a small multiple of clip count regardless of project size. Verified against both the argv builder's own tests and the suite that runs real ffmpeg and measures real output (63 + 35 tests), confirming zero effect on correctness. See B-229 in `docs/BUGS.md`.

- **2026-09-18** — **B-228: `editor_export` fully decoded every clip on a muted (`gain: 0`) audio track for output that's guaranteed silent.** Found exporting c040: 158 `-i` inputs for a 77-clip timeline, 20+ minutes of 300-600% CPU before the first output byte. 68 of those inputs were the muted raw-dialogue track redundantly decoding the same 4K source, once per clip, for a track contributing zero to the final mix. Fixed by skipping an audio track's clips entirely when its own `gain` is exactly 0 — confirmed safe against cross-track ducking first (it's derived from clip timing, not decoded audio). Two new tests; deliberately does not extend to a clip's own per-clip `volume: 0`, which can be faded/keyframed up. See B-228 in `docs/BUGS.md`.

- **2026-09-18** — **c040's video gap closed for real, with no ripple and no touch to the recap graphic.** After B-227 explained why closing it directly was refused (a sync-locked recap-graphic clip straddled the ripple point), the owner's own better idea won: extend the camera clip after the gap 29 frames backward into its own already-trimmed source material instead of rippling anything. Zero gap left on track 0, `verify_split_screen.py` still clean, nothing else touched. See B-227's own updated resolution note in `docs/BUGS.md`.
- **2026-09-18** — **B-227: `editor_remove_gap` could silently do nothing and still report `{ok: true}`.** Found live trying to close a 29-frame gap on c040: three attempts, three false successes, and the GUI's own "close gap" hit the same wall — confirming a real reducer bug, not an MCP relay issue. Root cause: `applyOp`'s `remove_gap` case has a real, correct, INTENTIONAL rejection (B-033's reject-on-straddle contract — a clip on a sync-locked other track straddled this gap's end frame), but nothing distinguished that rejection from success on the way back to the caller — the third function in this exact silent-no-op class after B-215 and B-197 (both still open). Fixed by factoring the reducer's precondition check into a pure, exported `checkRemoveGap`, called by both the reducer and the `editor_remove_gap` command handler before dispatch, so a rejection is now a real, specific `error` naming which track and why. Four new regression tests; full `packages/editor` suite 2031/2032 (one pre-existing, unrelated failure). See B-227 in `docs/BUGS.md`.
- **2026-09-18** — **c040: a manually-fixed retake never made it into the narration audio, because that audio comes from a separately-rendered track.** The owner found (by ear) and cut the known "constantly...glancing" duplicate-take pair (B-216) out of the camera track, marking it for review. The project's real narration audio is a separate Adobe-Podcast-enhanced render (`track 4`) generated earlier from an un-cut snapshot, so it still played the flawed take in full under the now-silent video gap. Confirmed via an isolated re-transcription (same "one word stretched across a hole" signature B-216 root-caused) and fixed by cutting the identical frame range out of `track 4`, left as a matching gap rather than rippled so nothing downstream shifts out of sync. See B-216 in `docs/BUGS.md` for the process lesson: a track rendered from an earlier snapshot of an edit needs a retake fix re-applied to it separately — nothing tracks that it exists.
- **2026-09-18** — **c040 split screen: three more real defects the owner
  caught by scrubbing, all now closed with a data-driven check instead of
  another round of eyeballing.** (1) Static crop applied unconditionally
  while position/scale were held via keyframe produced a brief "super
  zoomed" frame — the crop's narrow sub-image got blown up to fill the
  canvas before the ramp's first keyframe. Fixed by making
  `crop_top`/`crop_left`/`crop_right`/`corner_radius` keyframed properties
  too, synced to the same frames/ease as `position`/`scale`, on all 16 ramp
  clips. (2) B-226's window-shrink fix had a side effect: 6 clips (4, 33,
  34, 35, 36, 45) that were correctly cropped under the OLD, too-long
  windows now sat outside the corrected windows but were still statically
  cropped — a left-panel crop with black on the right during what should
  be a plain full-frame segment. Reverted all 6 to full-frame defaults. (3)
  `c040-payoff`'s exit ramp (the very last scene, ending on the video's own
  final frame) completed 6 frames (0.25 s) before the graphic's real end,
  so the camera briefly covered the last beat of the last graphic in the
  video — fixed by moving the ramp's second keyframe to land on the clip's
  true last frame. Answering the owner's own question — "how do we know
  what's wrong without looking?" — built `scratch/c040-split-verify/
  verify_split_screen.py`: reads `project.json` directly, computes real
  track-1 (graphic) window coverage fresh each run, resolves every track-0
  (camera) clip's effective transform at its own start/end (correctly
  holding before-first/after-last keyframe), and flags any disagreement as
  FAIL while correctly demoting a ramp's own legitimate boundary frame to a
  non-failing NOTE. After the three fixes above it returns a clean PASS —
  a repeatable data check to run after any future edit to these two
  tracks, not another scrub-and-hope pass. Full writeup: B-226 in
  `docs/BUGS.md`.
- **2026-09-18** — **D-349: the speech Whisper silently never read is now
  found, re-read and spliced into the transcript retake detection groups —
  and B-224's non-determinism is fixed first, because the detector needed a
  reproducible transcript to be testable at all.** B-216's research pass had
  root-caused the failure (the model emits no tokens for an utterance inside a
  window it is otherwise decoding at temperature 0.0 with every quality metric
  healthy, ~1 dropped multi-second region per 3 minutes of raw footage, and
  *biased towards retakes* — so the grouper is blind in exactly the place it is
  looking) and validated a detector on 111 labelled windows. This pass built
  it. **B-224 first:** `ai-media/transcribe.py` seeds MLX's global RNG from a
  named constant, verified in reverse against that entry's own repro — three
  identical runs of the same file now return byte-identical JSON, against
  925/923/913 words and three unequal transcripts before. **The detector** is
  `crates/apelles-speech`'s new `dark` module (no new dependency — `vad.rs` and
  `silence.rs::speech_spans` already had everything), implementing the
  research's recommendation exactly, with 18 unit tests including one written
  to fail against B-216's own original wording. Re-validated independently on
  both real sources through a new `#[ignore]`d live test: c040 4 regions / 1
  gated, c038 6 stretches / 1 gated, and re-reading all 10 in isolation
  recovered the speaker's own dropped content in 8 — every case the research
  had confirmed by hand. **The recovery is the part that actually fixes the
  workflow**, and is more than B-216 asked for: windowed transcription
  (`--start-secs`/`--duration-secs`, timestamps shifted back to absolute source
  seconds) runs through the whole stack, and `editor_detect_retakes` now
  re-transcribes each located window on its own and splices the words into the
  transcript it groups, by default. One design input came only from
  validation — language auto-detection is unreliable on a short window (2 of 10
  came back in the wrong script), so the recovery pins the file's own detected
  language. Both interfaces as always: `editor_detect_dark_regions`/`_status`
  on both MCP surfaces (179 tools, parity-checked), `recoverDarkRegions` on
  both retake tools, the Recut panel running the identical shared step and
  saying when a grouping read recovered lines, and the Index panel marking a
  recovered transcript row **recovered** so nobody is blindsided by content
  appearing that was not there before. **B-216's clip-straddling blindness is
  untouched and remains the bigger open half** — this fixes what the grouper
  reads, not what it reads it over.
- **2026-09-18** — **B-226: every one of c040's 9 Motion overlays had a
  multi-second BLACK-SCREEN tail, fixed for this project without losing any
  content.** Owner caught it live, scrubbing past `c040-qkv` and seeing black
  where the graphic should be. Root cause: all 9 scenes render at the
  manifest's 30fps while the Edit timeline runs at the camera's native
  ~24.005fps, and each overlay clip was placed on the timeline using its
  30fps-native frame count directly as its timeline-frame span — no fps
  conversion. The real content plays correctly and simply runs out ~20-25%
  before the placement's declared end, and for that gap the clip is still
  "placed" but has nothing left to show. Confirmed systemic (all 9 scenes,
  not one), confirmed a corrected placement loses zero content (the black
  region was never real content), and fixed at the root rather than the
  symptom: changed the Motion manifest's `fps` to match the timeline
  (animation timing is authored in seconds, so this doesn't shift anything)
  and re-rendered — the existing re-render auto-refresh then set every
  clip's duration to the exactly-correct value with no manual edit and no use
  of `editor_trim_clip` (the tool with its own history of silent no-ops and a
  destructive crash on this exact class of edit, B-215/B-220). Checked
  whether the camera's 16 PIP-in/out ramps needed retiming against the
  corrected boundaries — they didn't: every ramp already lined up with the
  real content's correct end, since they were authored by ear/eye against
  the always-correct visible content, not the buggy placement metadata.
  Verified live at the exact frame that was solid black before the fix — now
  correct. Root engine defect (fps-unaware duration derivation in
  `editor_add_clip`/D-260's refresh path) is NOT fixed, only this project's
  instance of it — see B-226 in `docs/BUGS.md`.
- **2026-09-18** — **D-348's c040 split-screen rebuild finished end-to-end —
  the content half that two prior passes each hit a real `/mcp` connectivity
  wall on.** Reflow ran exactly as predicted (`sx 0.6521`/`sy 0.9407`, 82
  layers/327 fields). Checking every scene against the LIVE rendered result
  (not the pre-reflow static estimate) found the estimate had been wrong in
  both directions: `c040-hook`/`c040-payoff` needed no stacking redesign after
  all (the pre-reflow width sum had overstated the collision), while
  `c040-whatisattention`'s word row genuinely overflowed and was fixed with a
  small proportional compression instead of a two-row wrap. Found and fixed
  one more defect the pre-reflow analysis couldn't have predicted:
  `c040-qkv`'s graph had a disproportionately long node label that the
  reflow's position-only compression put into collision with its neighbour —
  filed as **B-225** (reflow doesn't scale a graph's label font size), worked
  around by shortening the one label. All 9 scenes re-rendered and the
  camera's PIP clips moved to the new left-panel geometry. Full detail:
  `docs/notes/c040-split-screen-layout.md`.
- **2026-09-18 — correction to the entry above, caught by the owner
  spot-checking the live result, not by any automated check.** The claim that
  the camera's PIP was "a static per-clip transform, not animated keyframe
  ramps" was WRONG, and wrong for an avoidable reason: the scan behind it
  searched `project.json` for a field named `keyframes` and found none — the
  real field is `chroma_keyframes`, a name the scan never tried. **16 clips
  genuinely carry real animated ramps** (closer to this decision's original
  "18 ramps" description than the false "none exist" conclusion). Because a
  keyframe silently overrides a static value for any property it names,
  fixing only the static transforms (60 clips, across two passes — a first
  scan found 38, a second, broader one keyed off actual overlay-window
  overlap rather than exact-value matching found 22 more) left these 16
  clips' animated END-STATE still pointing at the old bottom-right corner —
  invisible in spot-checks that missed those windows, visible the moment the
  owner scrubbed to one, which happened twice. Fixed by rewriting all 16 via
  `editor_set_clip_keyframes` (same frames, same ease curves, only the
  target values changed). Re-verified programmatically afterward: zero clips
  anywhere still resolve to the old corner, by static value or keyframe
  end-state. The export mentioned as verification in the entry above was
  itself interrupted mid-run at the owner's request before completion and so
  verified nothing; the real verification here is the exhaustive
  `project.json` re-scan plus live-preview spot-checks at the two exact
  frames the owner flagged, both now confirmed correct.
- **2026-09-18** — **B-216's dropped-speech failure is root-caused and its
  proposed detector is validated — research only, no product code touched. See
  `docs/notes/whisper-dark-region-research.md`.** It is none of the paths it
  looked like (no-speech skip, temperature fallback, chunk stitching — all ruled
  out by per-window decode telemetry): whisper simply declines to transcribe an
  utterance inside a window it is otherwise decoding confidently at temperature
  0.0, and the loss is **biased towards retakes** — the calibration case's dropped
  region is the flubbed take of the very pair B-216 was opened over. Reproduced on
  a second, previously untested video (c038: 7 confirmed drops in 989 s). The
  detector works but B-216's literal wording misses >half the cases (a stretched
  word covers the gap); with a >2.0 s non-covering-word rule plus a per-file RMS
  gate it reaches **90-100 % precision at 100 % recall** over 111 labelled windows,
  reusing `apelles-speech`'s existing Silero runner with no new dependency.
- **2026-09-18** — **B-224: transcription is not reproducible** — the same file
  gives a different transcript every run (925/923/913 words), because
  `mlx_whisper` samples on an unseeded MLX RNG above temperature 0. Breaks the
  determinism invariant; two-line fix, not applied in that research pass.

- **2026-09-18** — **Two mid-session blocker theories for the c040 rebuild
  corrected, `docs/notes/c040-split-screen-layout.md` fixed in place.** (1) The
  original "MCP server predates D-345, restart it" reading was disproved by a
  follow-up pass, which then overclaimed a NEW theory — that `isolation:
  "worktree"` dispatch structurally cannot reach the `chroma` MCP server at
  all. That overclaim does not survive the SAME night's own evidence: a prior
  agent, dispatched with the identical worktree isolation, had a full hour of
  successful `chroma` tool use (280 calls) doing exactly this task. The far
  simpler explanation: the coordinating session had just killed the one
  running `mcp/server.py` process trying to force its own stale tool list to
  refresh (it does not auto-respawn) — a dead shared server, not a structural
  per-worktree limitation. (2) A second claim in that same pass — "D-346's
  preview fix is entirely frontend TS, no Rust" — is also wrong: the actual
  compositing fix is 496 lines of Rust in `edit.rs`, verified by reading the
  merged diff directly; the TS files are the GUI's separate box-drawing mirror
  of it. Both corrected in the notes file so the next pass doesn't inherit
  either wrong belief.
- **2026-09-18** — **c040's composite is redesigned as a two-panel split screen
  (D-348) — geometry designed, researched and ffmpeg-verified; the content
  rebuild itself is blocked and the timeline is UNCHANGED.** The owner's answer
  to the six captions running behind D-342's corner PIP was a fourth option none
  of the marker's three offered: change the layout. Speaker camera left (1144 ×
  2032 at (64,64), exactly 9:16, from a face-aware crop centred on the speaker's
  measured head position rather than the frame's), Motion graphic + captions
  right (2504 × 2032 at (1272,64)), 64-px margin and gutter, 14-px corners —
  which removes the collision structurally instead of by tuning, since the two
  can no longer overlap at any scale in any scene. Every edge was checked
  through real ffmpeg with the exporter's own expressions before anything was
  applied, and the research found that **no vendor publishes** a split ratio, a
  radius or a gutter (Zoom's divider is draggable with no stated default; Loom
  has no side-by-side layout at all), so those three are recorded as our calls —
  while EBU R 95's 5% graphics-safe inset sets the graphic panel's internal
  padding to the pixel and Final Cut Pro's Smart Conform is the authority for
  cropping rather than letterboxing a 16:9 source into a vertical column. Full
  derivation and reference trail: `docs/notes/c040-split-screen-layout.md`.
  **Blocked, deliberately, at exactly one step:** the Motion canvas has to
  become 1252 × 1016 with a reflow, and `motion_set_project_settings` (D-345,
  shipped the day before) is not in the tool list the running MCP server process
  advertises — a restart reaches it. Not worked around with a direct manifest
  file write, which is the practice **B-222** was filed against and which that
  entry already records a previous agent correctly stopping at. The project's
  own marker now carries the decision, the geometry and this blocker.
- **2026-09-18** — **The live preview finally crops the way the exporter and the
  docs always said it did (D-346, fixes B-218 and the never-filed B-223), and a
  Motion canvas resize now MOVES the layers with it (D-347, the missing half of
  D-345).** B-218: `composite_layer_onto` applied a crop as an alpha mask over
  the already-scaled full frame, so a cropped clip covered only the crop's own
  fraction of its placement box while the export filled it — `crop 0.35/0.35,
  scale 0.30` measured `0.091 × 0.302` against the documented, exported
  `0.30 × <cropped height>`. The preview moved to ffmpeg's order (resize the
  crop's sub-image), for the reason D-338 moved `position_*` and the one
  first-party rule that exists on the question — Final Cut Pro's own *"The
  cropped image automatically expands to fill the screen"*. Guarded by a real
  **cross-engine parity pair** (Rust test + a real-ffmpeg twin over one
  four-edge crop + scale + off-centre placement), which is exactly what B-218's
  write-up said would have caught it. B-223 fell out of the same line: an
  un-overridden height was the UNCROPPED aspect ratio in the preview and
  ffmpeg's `-2` in the export, so `box_width` with no `box_height` rendered
  20×4 in one engine and 20×20 in the other; both now use `width × cropped
  aspect`, which reduces exactly to the old formula for every clip that exists.
  The GUI's drawn transform box and click hit-rect follow. D-347:
  `motion_set_project_settings(reflow=True)` remaps every layer onto the new
  canvas in the same commit — built over `propCatalog.ts`'s existing
  `positionFields`/`sizeFields` registries rather than a second description of
  which fields are geometry, so a primitive added later reflows for free. Both
  MCP surfaces, a GUI toggle, 12 unit tests, parity corpus regenerated.
- **2026-09-17** — **`2026-09-12-c040-mgfx-recut` ships with Adobe
  Podcast-enhanced dialogue, a one-off editorial call, not a pipeline
  change.** After hearing both live, the owner chose Adobe's real output
  over the original camera audio for this video specifically. Track 4
  (Adobe-enhanced) is the real audio now; track 2 (original) stays muted
  rather than removed. See `docs/notes/speech-enhancement-research.md`'s
  "What's on the timeline right now" — the local-first in-Chroma
  speech-enhancement research below is unaffected and still parked for later.
- **2026-09-17** — **Local speech-enhancement research (not yet a feature) —
  see `docs/notes/speech-enhancement-research.md`.** Real bake-off against
  `2026-09-12-c040-mgfx-recut`'s actual final-cut audio: DeepFilterNet3 hits
  0.066x realtime (well inside the 0.5-0.7x target), Resemble Enhance is the
  best-sounding local option but 3.11x — misses the target by 4-6x. The
  initial theory (match Resemble's own presence-lift EQ curve) was overturned
  once Adobe Podcast's REAL output was obtained (manually, via its own web
  tool) and measured: Adobe's actual spectral fingerprint is nearly flat with
  a gentle high-frequency roll-off, much closer to DeepFilterNet3 than to
  Resemble's dramatic lift. Owner-verified by ear: Adobe's real output is
  clean, "no issue," now the target to match. Also surfaced a reproducible
  `editor_add_clip` defect (auto-links a duplicate audio clip for a
  pure-audio media item placed directly on an audio track) — noted in the
  research doc, not yet filed as its own `B-NNN`.
- **2026-09-17 (follow-up pass)** — **`2026-09-12-c040-mgfx-recut`: the owner's 4
  follow-up markers all closed — 97 more frames cut, the `c040-recap` SCENE
  re-authored from 12 s to 18.6 s against the real narration, and three new
  app bugs found doing it (B-219/B-220/B-221).** 3m57.6s → **3m53.5s** (5702 →
  5605 frames @24). The original `2026-09-12-c040-mgfx` is verified
  **byte-identical** (sha256 over all 27 files, snapshot taken at the start of
  the pass and re-diffed at the end).
  **The three cut markers, each confirmed from an isolated re-transcription plus
  a per-50 ms amplitude envelope before cutting, never from the whole-file
  transcript alone:** (1) two orphan "Constantly." pickup takes live on the
  timeline as clips 22/23 — Whisper's whole-file pass reports NOTHING across
  268.3-271.2 s, a **fifth** dark region in this source (see B-216), while the
  RMS shows two clean bursts and a 2.4 s isolated extract reads them instantly;
  cut 36 frames. (2) a duplicated "constantly" at the recap seam, a textbook
  straddling pair — the complete word ends clip 63 and a partial second one
  opens clip 64 — closed by removing 6 frames from clip 64's head so the join
  reads "…the reply while constantly / glancing back at it."; verified by
  rebuilding the spliced audio with `ffmpeg` and re-transcribing it, which now
  returns the sentence once. (3) 2.25 s of dead air at clip 65's head (RMS
  ~150-200 vs 2000-5000 speech), cut 54 frames leaving a 0.60 s beat. Plus one
  UNMARKED defect found in the same sweep: a 1-frame orphan (clip 20) that was
  41 ms of a word's onset spliced between two unrelated shots — an audible tick;
  cut. **B-197 did not bite** (4-range batch: −97 frames exactly, tracks 0/2
  coverage 5704 → 5607, and tracks 1/3 rippled with them, so all 8 unchanged
  overlays kept their narration sync with no action).
  **The recap scene, the part the previous pass explicitly left undone.** Its
  own marker note claimed the render was stale against the manifest; that claim
  was **wrong**, and the reason is worth knowing: a layer's `transform.keys`
  `opacity` is an additive DELTA on the layer's own opacity (`Video.tsx`
  `topacity = (t.opacity ?? 1) + delta.opacity`), so `{at:4.6, opacity:0} →
  {at:5.1, opacity:-1}` is a fade-OUT, not the fade-IN it was read as. Frames
  pulled from the old render confirm it matched its manifest exactly. The real
  defect was only the second one: the beats ran ahead of the post-cut narration.
  Re-timed against measured transcript positions — caption 1 t=1.0 → **6.0**
  ("matching each word's query…" starts t=6.25), caption 2 t=5.2 → **10.6**
  ("the encoder builds a picture…" t=10.46-12.96), caption 3 t=7.8 → **12.9**
  ("the decoder writes the reply… glancing back at it." t=12.96-18.33), with the
  graph/matrix/rings/fades moved to match and 7 pulses + 3 highlights added so
  the graph is not static through the 5.5 s window the longer scene opened up.
  Scene `dur` 12 → **18.6 s**, which fits: the next line starts at t=18.88 and
  `c040-payoff` does not move (it sits at 5257, 210 frames clear).
  **Two things the re-render then exposed that nothing warned about.** The
  timeline's overlay clips all pointed into the ORIGINAL project's renders
  directory (B-219) — a filesystem-copied project keeps absolute `source_path`s
  — so `motion_render` refreshed nothing and `motion_get_edit_links` reported
  `rendered: true, clipCount: 2` for every scene anyway. Fixed by repointing all
  18 overlay clips to the copy's own pool items; the project is self-contained
  now. And the camera's PIP-out ramp still fired at the OLD recap end (tl
  4889-4901), so the extended graphic played behind a full-frame camera for its
  last 146 frames — moved to 5047-5059 (the head of clip 62), with clips 60/61
  held at PIP. Every one of the 16 other ramps was cross-checked against its own
  graphic window and is correct to the frame.
  **Verified:** all 9 overlay windows screenshotted in the Edit tab at a content
  beat and matched against what is being said at that exact frame; the three
  recap beats confirmed landing on their words.
  **Left open, deliberately, as the copy's only marker:** six captions elsewhere
  in the piece are wide enough that their last words sit behind the bottom-right
  camera PIP. Measured from each scene's own render (no PIP) as the rightmost
  text pixel vs the PIP's 0.760 edge — worst `c040-lostmiddle` at 0.902, which
  visibly reads "…in the middle of a" and stops. That is the downstream cost of
  D-342's owner-pinned corner, which was chosen on a geometric overlap metric
  rather than on whether caption WORDS survive, so it is an owner decision, not
  an edit fix. The recap's own third caption WAS shortened ("…glancing back at
  it the whole way." → "…glancing back at it.") since it both overran and
  matched the narration less well; all three recap captions now clear the PIP
  (0.731 / 0.671 / 0.638).
- **2026-09-17** — **B-219, B-220, B-221 filed, all three hit live in the pass
  above and all three destructive-or-silent.** B-219: a copied project's
  absolute `source_path`s make `motion_render`'s documented Edit-refresh a
  no-op, with `motion_get_edit_links` confirming the wrong answer. B-220:
  `editor_trim_clip(edge:"end", delta:-198)` collapsed a 360-frame clip to
  **1** frame instead of extending it to 558, and the next call on that clip
  hard-errored and closed the project — same op as B-215, different and worse
  symptom. B-221: `editor_remove_clip` propagates across the A/V link group and
  says so nowhere, so removing "both halves" of a linked pair by index deleted a
  NEIGHBOURING clip (`c040-payoff`, both tracks) with two `{ok: true}`
  responses; caught only by re-reading the timeline, and fully recovered.
- **2026-09-17** — **The Motion manifest's own top-level fields become editable
  by both a human and an agent (D-345, fixes B-222).** New
  `motion_set_project_settings(title?, width?, height?, fps?)` on both MCP
  surfaces (177 tools) — a partial merge committed once, validated against what
  Remotion itself enforces (positive-integer dimensions, positive fps; an odd
  dimension is a warning, since h264 rounds it down), and a new **Project** form
  in the Inspector's previously-dead "nothing selected" state, carrying the
  theme picker D-339 had left open. Both go through one
  `setProjectSettings`. A `width`/`height`/`fps` change reports which existing
  scene renders it just made stale (`renders`, off D-260's own edit-link map)
  and deliberately does not re-render them.

- **2026-09-17** — **`2026-09-12-c040-mgfx-recut`: the owner's 10 markers worked
  through on a COPY, 342 frames (14.25 s) cut, all 9 Motion overlays re-timed.**
  New project is a filesystem copy of `2026-09-12-c040-mgfx`, which is verified
  byte-identical afterwards (only `name`/`modified` differ). 4m11.8s → 3m57.6s.
  **Used D-343's new whole-track sweep** (`clip` omitted) for both detectors —
  75 clips in one dispatch each — which found the 5-10 s dead air (marker 9)
  and one retake group, and **that is the finding**: the per-clip detectors can
  only see inside one clip's trimmed range, so on a 75-clip talking-head cut
  almost every real retake straddles a clip boundary and is invisible to them.
  The other 8 were found by mapping each marker to raw source seconds and
  re-transcribing the disputed windows in isolation — Whisper's whole-file pass
  silently swallowed four multi-second regions (365.7-370.1, 518.2-521.6,
  615.7-618.0, 638.9-645.4 s), stretching one word across each, and three of
  those hid an entire flubbed take. **The abrupt cut (marker 7) was two
  defects, not one**: a junk restart fragment ("constantly … the enco–") left on
  the timeline, and clip 69's in-point set 0.8 s into "And that's exactly why",
  so the sentence began on "exactly". Fixed by cutting the fragment and
  ripple-extending the clip's head 184 frames to pull in the complete final take
  of the preceding sentence ("glancing back at it."), then cutting the 3.05 s
  pause that came with it — all three splices verified to land in measured
  silence. **B-197 did NOT bite** (8-range batch applied exactly: −453 frames on
  tracks 0 and 2, source coverage down by exactly 453). **B-215 reproduced a
  second time** — `editor_trim_clip(edge:"end")` returned `{ok:true}` and changed
  nothing on an overlay clip; worked around by position, disclosed not fixed.
  The 18 PIP ramps re-timed themselves correctly for 6 of 9 windows with no
  action (keyframes are stored in clip source-frame space, so they travel with
  their clip) — only the 3 windows with an internal cut, plus the recap window
  whose OUT-ramp clip was deleted outright, needed re-keying. Marker 6's recap
  sync (B-215's known-unfixed 105-frame gap) is fixed: the graphic now lands on
  the words "quick recap" instead of 4.5 s after them. Left open and recorded as
  the copy's only remaining marker: the recap SCENE's own internal beats still
  run ahead of the narration, and its rendered mp4 is stale against the
  manifest's own schedule — a Motion re-author + `motion_render`, not edit work.
- **2026-09-17** — **B-216/D-343's sweep has a real blind spot worth knowing
  before trusting it for a cleanup pass**: it sweeps every clip on a track in
  one dispatch, but each clip is still analysed only within its own trimmed
  range. On an already-tightly-cut timeline that is most of the timeline's real
  retakes. Noted here from live use; no code change made this session.
- **2026-09-17** — **The long-lived `mcp/server.py` process was 3 days stale**
  (started Mon 15:54, `server.py` last written Thu 19:13 by D-342), so this
  session's `chroma` tool list still had `clip` REQUIRED on both detectors and
  no `_status` twins at all. The app itself was current (the sweep is frontend
  TS, HMR-live), so the sweep was reached through the control server the wrapper
  itself posts to — disclosed as a workaround, not a fix. The real fix is a
  `chroma` MCP reconnect in the coordinating session; a subagent must not kill
  its parent's MCP server.
- **2026-09-17** — **B-217 filed: Vite/HMR silently duplicated a store instance,
  wedging the Edit tab into one project's timeline under another's identity.**
  After hours of continuous HMR, `Root.tsx`'s session-store bridge held a
  different `useSessionStore` instance than the actual op handler read —
  `open_project` reported success and Rust genuinely held `c040-mgfx`, but
  `editor_get_state` reported `untitled:Untitled` while the Edit tab visibly
  rendered the real timeline. Worked around with a full reload; not fixed —
  stores have no guard against HMR re-instantiation.
- **2026-09-17** — **B-218 filed: the live preview applies scale before crop**,
  contradicting `editor_get_capabilities`' own documented crop-then-scale order
  and its `full_width_half_height_recipe`. Measured: a `crop 0.35/0.35, scale
  0.30` combination produces a `0.30×0.30` box, not the documented `0.30×full`
  — crop is applied within the already-scaled box. Export's own order not yet
  checked (never called `editor_export` to test it). Same shape of bug as
  B-201: a missing preview/export parity test, not just a wrong doc.

- **2026-09-17** — **D-342: the `c040` composite inverts — Motion graphic full-frame,
  camera a keyframed corner PIP.** Reverses D-333/D-338's inset-card framing on owner
  direction. All nine scenes re-rendered at native 3840x2160 via `Config.setScale(2)`
  (Remotion's scale factor) rather than a bigger manifest — the manifest route would
  have produced a broken layout, since layer `x`/`y`/`size` are raw 1080-space CSS
  pixels with no design-space normalisation. Camera track moved to index 0 to paint
  over the graphic; 54 of 75 camera clips carry the PIP (18 keyframed 12-frame
  ease-in-out ramps, 36 static holds) at one owner-pinned value, `scale 0.22` at
  `(0.76, 0.755)` — bottom-right, the owner's explicit corner. The measured-optimal
  slot was the top-right mirror of it (`0.025`), clear on all nine scenes; the
  bottom-right puts content under the PIP on six of nine (worst `lostmiddle` 0.081)
  and no clean shared slot exists in that corner at this size. Applied uniformly
  rather than split into per-scene exceptions; tradeoff recorded in D-342.
- **2026-09-17** — **D-343 fixes B-216: `clip` is now OPTIONAL on both recut
  detectors — omit it and you sweep the whole track in one call.** Not four new
  `*_all` tools: an agent that already knows `editor_detect_retakes` gets the
  sweep by leaving an argument out. Root-caused why a client-side loop would
  not have fixed it — `control.rs`'s `serve()` is a single-threaded,
  one-request-at-a-time HTTP loop, so N calls queue there regardless and the
  round trips, not the analysis, are the cost. Measured by counting, per
  `performance-instrumentation.md`: **20 clips = 1 dispatch, vs 20** the old
  way (88 ms vs 1066 ms in jsdom, a floor on the real gap). The response
  separates `flagged` (full detail) from `clean` (bare indices) so a 75-clip
  sweep is readable. GUI half landed in the same pass: `RecutPanel`'s "select
  one clip" is replaced by a "This clip / Whole track" scope toggle. Both MCP
  surfaces updated, corpus regenerated, parity green.

- **2026-09-17** — **B-216 filed: retake/silence detection has no "sweep the whole
  timeline" mode.** Root-caused why several real retakes and a 5-10s silence
  survived to the final `2026-09-12-c040` cut, from 10 owner-placed markers.
  Verified the algorithm itself is sound (the flagged "encoder reads your whole
  message" retake pair scores 0.8413 against the real code, above the 0.82
  default threshold — it would be caught if run). The actual gap: every caller
  requires one explicit `track`/`clip` per call, with no batch-all convenience,
  so a cleanup pass naturally stops at the clip a report points at rather than
  re-sweeping the whole timeline. Also surfaced a separate, pre-existing,
  untested false-positive risk in `containment()`'s scoring (acknowledged in
  the code's own doc comment) — noted but not the cause here.

- **2026-09-17** — **B-215 filed: `editor_trim_clip(edge: "end")` silently no-ops** on
  at least one real clip — returns `{ok: true}`, changes nothing, no error/note.
  Found trying to close a 105-frame gap between `c040-thefix` and `c040-recap` on
  `2026-09-12-c040-mgfx`'s overlay track; worked around by leaving `c040-recap` at its
  original placement rather than risk the overlap the failed trim caused once already.
  The sync gap (recap's graphic lands ~4.4s after its own narration starts) is left
  unfixed, disclosed rather than silently shipped.

- **2026-09-17** — **`2026-09-12-c040-mgfx`: the apelles-studio theme pass, plus the two
  scenes D-339/D-340 were built to unblock (content, not code, except the three fixes
  below).** Pinning `theme: "apelles-studio"` had changed fonts and stroke geometry but
  almost no colour, because all eight scenes were authored before the theme registry
  existed and every accent was a hardcoded hex that legitimately wins over a theme
  default. All 28 colour literals were triaged: generic accent uses (the `matrix`
  heatmap/`fill-in` accent, `graph` pulses, `plot`'s series, four `emphasis` marks, two
  callout labels) deleted so they inherit the theme's ochre; genuinely SEMANTIC warnings
  ("…never answered.", "↑ underweighed" and its scribble, the buried-ask mark, the "lost
  in the middle" dip, "before") re-pointed at the site's own `--danger-inverse`
  (`#c17f6d`) rather than flattened to ochre, so "this one is wrong" keeps a colour of its
  own; `plot`'s baseline demoted to the dim ink token, since a reference line is not the
  subject. `claudechat` deliberately keeps its own Claude-brand palette — it depicts a
  real product, not our page. **`c040-selfattn` rebuilt** as the D-340 payoff: a 7-word
  full mesh (21 edges) over the video's own example sentence, weighted so "anything"↔"off"
  and "pull"↔"items" are plainly the strong ones and "this"↔"the" is a hairline, with
  pulses glancing back and forth along them. **`c040-recap` added** (new, 9th scene,
  placed between `thefix` and `payoff` per the real transcript beat order — timeline
  frames 4985-5345, mapped from raw-file seconds through the main track's own
  `source_start`): a fast-cut of the established motifs, not new art — the mesh again at a
  smaller scale, the `matrix` "picture" callback, and two ring "glances" back at it.
  `c040-qkv` fixed on review: the garbled node label "off ?" is now "off", and the
  abstract "value" no longer sits in the mesh as if it were another word in the sentence
  (three ochre role captions — query / keys / value — head their groups, and the value
  node carries a phrase rather than a word). `c040-lostmiddle`'s callout no longer crosses
  its own curve. Nothing exported, deliberately. Three real defects found live: **D-341**
  (a `plot` annotation needs a `dy`), **B-214** (`emphasis`'s `ring` drew a fully opaque
  ring for the whole scene BEFORE its `at` — visible in already-approved output, older
  than this pass, exposed by it) and **B-211's real root cause** — d3-force's own
  `forceLink` throws on a dangling link *before* the render-side guards that half 1 of
  that fix added, which is why the preview wedged again on the identical reproduction;
  now filtered at source and covered by tests, where half 1 had none.
- **2026-09-17** — **B-211 half-fixed: `graph`'s `at()` no longer throws on a dangling
  node reference.** `edges`/`pulses` naming an id `nodes` doesn't carry used to
  dereference `layout[id]` and crash the whole frame, wedging the Motion tab's
  still-preview for the rest of the session. Now returns `null` and the caller skips
  that one edge/pulse — every other element still renders. The other half (making an
  already-wedged preview recoverable) is a different area and still open.
- **2026-09-17** — **`2026-09-12-c040-mgfx`: the attention explainer's motion-graphics
  set rebuilt and roughly quadrupled (content, not code; files B-211, B-212, B-213).**
  Seven of a planned nine scenes built through the `motion_*`/`editor_*` MCP surface
  against the live app: `c040-hook` and `c040-whatisattention` new, `c040-qkv` and
  `c040-encdec` rebuilt in place (they were near-identical 3-circle `graph` templates —
  qkv is now a real query→keys→value diagram with labelled word nodes, encdec drops
  `graph` entirely for a `matrix` "picture" + token-by-token decoder column),
  `c040-lostmiddle` extended in place (three `annotate` callouts, markers, a scribble on
  the dip), plus new `c040-thefix` (the `layers` card stack) and `c040-payoff` (a
  two-conversation `claudechat` before/after that bookends the hook). Copy is the
  speaker's own transcript, not generic explainer filler. Overlay coverage of the 4:11
  cut goes from **38.0s (15.1%)** to **142.5s (56.6%)**; all eight clips sit on the same
  top overlay track at the established 0.35×0.35 @ 0.03,0.06 inset, placed by mapping
  raw-file transcript seconds through each source clip's own `source_start` into edited
  timeline frames. Nothing exported, deliberately. Three real defects found live and
  filed rather than worked around quietly: **B-211** (a transient dangling graph-node
  ref permanently wedges the Motion still-preview — survived a project reload; the whole
  build was reviewed off `motion_render` output instead), **B-212** (`emphasis`'s
  `pulse`/`glow` presets render nothing from a manifest) and **B-213** (`matrix`'s
  scalar-size op contradicts its own `motion_list_primitives` contract).
  Deliberately NOT done: the `graph`-schema self-attention word-mesh and the recap
  scene, both out of this pass's scope.
- **2026-09-17** — **D-340: a `graph` edge carries a `weight`.** The
  self-attention scene's `matrix` heatmap was rejected as the most overused
  visual in the AI-explainer genre; the replacement is a `graph` mesh over the
  real words of a sentence — which only works if an edge can say how strong it
  is. `{from, to, directed?, weight?}`, 0-1, default 1, scaling BOTH stroke
  width and opacity (opacity alone reads as "further away", width alone is
  invisible at 2.5px). The weight-0 floor is deliberately non-zero: "these two
  barely relate" is worth seeing, and a vanished edge is indistinguishable from
  a forgotten one. Absent `weight` renders byte-identically (verified with real
  `remotion still` renders at two frames). The test caught a real `NaN` path on
  its first run — a hand-authored `"weight": "0.4"` reaches an unvalidated
  `.passthrough()` field and would have silently dropped the stroke.
- **2026-09-17** — **D-339: the motion engine's locked look becomes a theme
  registry.** `design.ts`'s one flat `design` constant (19 files imported it
  directly, so no manifest could ever choose a different look) is now a named
  `THEMES` registry resolved per render through a React context, off a new
  optional top-level `manifest.theme`. The locked "dark Excalidraw" values are
  kept unchanged to the byte as the `dark-excalidraw` preset and stay the
  engine default — a manifest with no `theme` key renders exactly as before,
  proved with byte-identical `remotion still` renders at four frames covering
  2D, roughjs and the 3D scene. Second preset `apelles-studio` is
  apelles.studio's own editorial look, sourced field-by-field from
  `website/src/styles/tokens.css`: basalt ground, marble ink, ochre as the ONE
  working colour (terracotta fails contrast on basalt — the site's own rule),
  Newsreader / Instrument Sans / IBM Plex Mono, and `roughness: 0` so the
  existing roughjs path emits exact geometry rather than needing a second
  renderer. New `motion_set_project_theme` on both MCP surfaces (175 → 176),
  `motion_list_primitives` now publishes the registry, and the website's tool
  counts were re-counted after three tools of pre-existing drift.
- **2026-09-16** — **D-338 (fixes B-201, files B-208 and B-209): one placement
  convention for `position_x`/`position_y` — the export's TOP-LEFT corner, with
  the live preview moved to meet it.** The preview centred a layer and read
  `position_*` as an offset from that centre; ffmpeg's `overlay` has always read
  it as the overlay's top-left corner. The two agree only at full frame, which
  is why nobody caught it and why D-333's motion-graphics overlays had to be
  placed full-frame as a disclosed workaround. Changed the preview, not the
  export: `overlay`'s reading is ffmpeg's own external convention and the
  documented stacked-comparison recipe (and the `chroma-comparison-reel` skill)
  depends on it. Audited every real saved project clip by clip: **two** carry
  non-default geometry, both in one old unrelated project, and exactly **one**
  of them actually moves — its equivalent new-convention position is written
  down in D-338 rather than corrected by a migration pass built for one number.
  Both `-mgfx` projects and both `c038`/`c040` cuts are fully default.
  The missing cross-engine test B-201 named as the real root cause
  now exists as a duplicated PAIR (`edit.rs` + `timelineExport.ffmpeg.test.ts`),
  both asserting one hard-coded rectangle for one named non-full-frame
  transform. Two spin-offs filed rather than carried quietly: **B-208** (the
  separate `scale` unit divergence, still open) and **B-209** (the `apelles`
  crate's `--lib` test build had not compiled since `chroma_timeline_get` became
  `async` — fixed here; 331 tests were unrunnable). With the convention fixed,
  D-333's workaround is lifted: all eight motion-graphics overlays in the two
  `-mgfx` projects come down from full-frame to a `0.35` upper-left inset card
  over the dark side of the shot, placed against the real frames. Nothing
  exported. A third bug, found the same way
  and left open with its exact diagnosis: **B-210**, `TimelinePane.tsx` has been
  losing all React Compiler auto-memoization to a ref read during render, with
  D-201's guard test red on `main` rather than preventing it.

- **2026-09-16** — **D-337: measured four faster transcription backends and kept
  `mlx-whisper large-v3`.** Owner asked for a genuinely faster local model
  without trading accuracy. Ran `large-v3`, `large-v3-turbo`, `turbo` 4-bit,
  `distil-large-v3` and `distil-large-v3.5` through the shipped `transcribe.py`
  path on the real `c040` source (686 s), deterministic per model. **The fastest
  credible candidate, `large-v3-turbo`, silently drops 19.4 s / 29 words of real
  speech** — reproducibly, with the audio present at normal level, and it
  transcribes that same slice perfectly in isolation (a long-form seek artifact,
  i.e. silent and content-dependent). 4-bit quantization bought **zero** speed
  (494 s vs 498 s) for worse accuracy; `distil-large-v3.5`'s only MLX build
  produces 147 zero-length words. Parakeet leads the leaderboard but needs CUDA;
  `faster-whisper` has no Apple Silicon GPU path. **No backend change** — the
  one code change is a doc fix marking `distil-large-v3` English-only, which the
  module's own Hinglish promise contradicted. Two proposals recorded, not built:
  speculative decoding (~2×, provably identical output, blocked on `mlx-whisper`)
  and `parakeet-mlx` as an opt-in English path. Caveat on the record: these runs
  were taken at load average 130 from sibling agents, so the speedup *ratios*
  are real and the absolute seconds are not.

- **2026-09-16** — **D-336 (+ B-206, B-207): the project-open/timeline perf pass
  — four distinct defects, not one.** Owner: *"open a project it takes forever,
  timeline takes forever, preview takes like hell ... app becomes
  unresponsive."* Established first that this is NOT the playback path D-321/
  D-323/D-324/D-325/D-334 already fixed. **(1)** `Waveform` fetched for every
  clip on a track regardless of scroll position (the timeline library
  virtualizes rows but not actions) — **75 audio decodes at 150 clips and 150
  at 300, now 5 and 5**, via a shared `clipVisibility.ts` the filmstrip already
  had privately. **(2)** `chroma_session_thumbnail` had no cache and no
  concurrency bound, so opening the owner's 75-clip recut spawned 75 concurrent
  4K `ffmpeg` processes — B-037 again, from the one call site D-121's fix never
  covered; now three-tier cached + hwaccel, behind a new **process-wide**
  `ffmpeg_gate`. **(3)** Grades loaded with `await` inside a `for` — 75
  sequential round trips, 72 of them for files that do not exist; now one
  `chroma_load_grades`. **(4)** "Unresponsive" was literal: `chroma_timeline_get`
  (uncached 212 KB manifest parse + migration + 150-clip backfill, re-fired on
  every window focus) and `chroma_project_list` ran **on the UI thread**, since
  a Tauri command without `async` does. Harness: a new
  `TimelinePane.mountCost.dom.test.tsx` that counts per-clip IPC fan-out
  (verified failing first), and a new `scrub` span channel in `previewTiming`/
  `debug_frame_timing` because the paused preview path had no cost
  instrumentation at all. **The preview symptom is root-caused but deliberately
  NOT fixed** — any backward scrub step forces an ffmpeg respawn + keyframe seek
  (248-337 ms vs 6.7 ms sequential), and the obvious frame-cache fix needs an
  invalidation key this pass could not prove correct; three sequenced candidates
  are in `docs/04-roadmap.md`. The "under 1s" target is not claimed end-to-end:
  the numbers here are fan-out counts and code-level cost accounting, not a
  stopwatch on the owner's own app.

- **2026-09-15** — **D-334: the preview stutter was two unrelated defects, and the
  theory this pass started from was neither.** Measured first: mid-clip decode is
  **6.8 ms/frame (146 fps)**, so the decoder was never the baseline cost, and the
  measured 10 s window held only 3 cuts — a *median* of 200 ms/frame cannot be a
  per-cut cost, so the baseline is **B-146** (webview) and the p95 620 ms hitches
  are the decoder. Two plausible hypotheses died on measurement and are recorded
  rather than discarded: "4K decode can't keep up" (killed: 6× real time) and "the
  mid-clip prefetch churn is the stutter" (killed: a spawn-and-kill per frame beside
  a live read moved its median 7.13 → 6.62 ms, i.e. not at all). Decoder side
  (**B-199**): a clip shorter than the lookahead had its standby **evicted by the
  clip after it**, so its cut paid the full seek it was meant to hide — `standby`
  becomes a list per slot (cap 3), `prefetch` becomes the declarative
  `sync_prefetch(wanted)`, and the scheduler walks a CHAIN of boundaries instead of
  sampling one instant. D-324's fixed 0.5 s lead was tuned on a file whose seek cost
  248-337 ms; this one's costs a median **723 ms**, so the lead is now measured per
  source (every un-hidden respawn times itself) rather than constant. Also fixed an
  off-by-one that spawned an `ffmpeg` **every mid-clip frame** and never adopted it.
  Result on the owner's own footage: **436.8 ms → 35.6 ms at a cut**. Webview side:
  three more reactive `playhead` subscribers gone (`CaptionLibrary`,
  `CaptionsFromTranscriptButton`, `CaptionTransformOverlay`, and `useCanvasClipPick`
  — whose re-render *is* `PreviewPane`'s), **30 commits → 0** over 30 ticks, measured
  both ways. **Live-verified, and the verification overturned the easy story:** on a
  settled machine this build plays the owner's project at **41.5 ms/frame, 24.0 fps,
  zero hitches** (budget is 41.7 ms) — but reverting just the frontend fixes measures
  **40 ms**, i.e. they moved nothing live, and the same build measures **86 ms at
  load ~133 vs 40 ms at load ~10**, so much of the original 200 ms was machine
  contention rather than a ceiling. `fetch` (IPC + Rust) is now **26-33 ms of the
  41 ms frame**, reversing D-290's split — composite + JPEG encode, not
  `createImageBitmap`, is the next target. A
  Blender-style decoder pool was evaluated seriously and rejected on data: we have
  had that fix since D-125, and **37 of this project's 74 cuts already cost nothing**
  because of it. B-146 stays open with six subscribers and the main-thread JPEG
  decode remaining.
- **2026-09-16** — **D-333: explainer motion graphics for c038/c040, and a new
  `plot` primitive.** Read both talking-head timelines with
  `editor_get_timeline_transcript` (D-329) on throwaway `-mgfx` copies, picked
  the moments a visual genuinely earns its place, and built four Motion scenes
  each in one consistent style — researched first from 3Blue1Brown/manim,
  Alammar, Liu et al., the FT's own chart palettes and BBC/Netflix legibility
  numbers, all kept in `scratch/mgfx-reference/`. Took the researched *grammar*
  (assemble in narration order, dim-don't-delete, direct labels not legends, one
  thing moves at a time, no bounce) but NOT its palette, since the engine's
  `design.ts` is already the one token source. The catalog had no way to draw a
  plotted curve — `graph` is node-link, `matrix` is a cell grid — so `plot`
  is the 11th primitive: one series, one dashed reference baseline revealed
  BEFORE the curve so the curve visibly sinks onto it, direct annotations, no
  legend. No Rust or Python change was needed for it to reach MCP. Overlays are
  full-frame cutaways rather than the researched side-by-side, because
  `position_x` means different things in the preview and the export — filed as
  **B-201** and flagged as a workaround, not fixed.
- **2026-09-16** — **D-330: a performance change you can WATCH — a live fps
  overlay burned into the window, plus a webview video recorder.** Debug
  tooling piece 6, built so the decode-pipe/rendering fix in flight can be shown
  as before/after footage instead of asserted. `debug_set_fps_overlay` displays
  the *same* `paint`/`raf` ring buffers `debug_frame_timing` reads — a formatter,
  never a second measurement, because two "fps" numbers that could disagree are
  worth nothing as evidence. Both gained a `windowMs` (default 2 s): the 240-
  sample ring is 10–48 s of history at this preview's real rates, so an
  unwindowed average would spend a whole demo still showing the old number.
  `debug_record_video` repeats D-210's `takeSnapshot` mechanism and pipes RAW
  pixels into ffmpeg (PNG per frame would mostly measure its own encoder), holds
  a fixed cadence so the file's wall clock matches reality, and *counts* the
  padding when a capture misses its slot rather than drifting into slow motion.
  Overlay is plain DOM on a 250 ms timer, not React — a readout re-rendering the
  app four times a second would change the frame rate it reports. Both MCP
  surfaces, parity corpus re-captured, debug-only gate re-measured (release
  publishes 160 tools vs 171; 0 occurrences of every new symbol in a real
  `vite build`). Found and fixed **B-200** while live-verifying.
- **2026-09-16** — **B-200: `debug_record_video`'s `width` silently did
  nothing.** `WKSnapshotConfiguration.snapshotWidth` is in POINTS, so asking a
  1280-point window for "1280" requested exactly its native size — 2560 real
  pixels on a 2× display, at 58.7 ms per capture. `width` now means the output
  video's pixel width and is divided by the scale factor first: re-measured at
  1280×720 and 15.0 ms, a 3.5× cut in what each capture costs the app being
  recorded. Caught by reading the first live run's numbers rather than trusting
  the parameter.
- **2026-09-16** — **D-332: Motion layers can be saved as reusable
  components.** Closes D-331's largest audit finding: the Motion tab could
  create everything and keep nothing, so a tuned `matrix` or `graph` had to be
  retyped from memory every time (`duplicateLayer` only helps inside one
  manifest). A component is a named, frozen copy of one layer fragment —
  keyframes included, layer `id` stripped — living in a user-level library at
  `<app_data_dir>/motion/layer-presets.json`, shared across projects, following
  RapidRAW's own `load_presets`/`save_presets` pattern rather than D-243's
  hard-coded caption presets (which have no storage at all). Inserting one is a
  COPY with no live link back, which is deliberate and stated on the tools.
  Both halves in one pass: the Inspector's "Save as component" box and the
  Catalog's Components section, and `motion_save_layer_preset` /
  `motion_list_layer_presets` / `motion_add_layer_from_preset` /
  `motion_delete_layer_preset` (Motion 37 → **41 tools**; the server 171 → 175).
  The Rust tool descriptions were generated from the Python docstrings rather
  than transcribed, so the byte-for-byte parity check cannot fail on a
  copy-paste slip. 48 new tests; live-verified in real Chromium including the
  save → insert → delete round trip.
- **2026-09-16** — **D-331: a scene can be given a 2D camera from the GUI.** A
  firsthand Motion-tab UX audit (D-165's harness, real Chromium) found the
  standing human-AND-AI rule violated in the *inverted* direction:
  `setCamera2d` creates `scene.camera` when absent, so `motion_set_camera_2d`
  could bring a 2D camera into being, while the GUI only ever rendered a
  Camera row for a scene that already had one — circular, and unreachable by
  hand. New `addCamera2d` + a hover-revealed `Add camera` action on the scene
  row, defaulting to one neutral key (`{at: 0, zoom: 1}`) and selecting the new
  camera so the Inspector's `+ Add keyframe` is the obvious next click. No new
  MCP tool: the agent path already reached the identical end state, and a test
  pins the two paths to the same manifest. The audit's three other findings are
  recorded in the same entry — the Motion preset/component library and
  manifest-level fields are deferred to the roadmap with reasons, and the
  "render → Sources is silent" suspicion was **withdrawn** after reading
  `Root.tsx` (it already toasts; the harness just never wires `onRendered`).
- **2026-09-17** — **D-344: a clip can have ROUNDED CORNERS, in both engines.**
  New per-clip `corner_radius`, in OUTPUT-CANVAS PIXELS (the one geometry field
  that is not a canvas fraction — a human means "16 px of round" and does not
  want it rescaled; the preview pays for the exception in one named conversion,
  `ClipTransform::scaled_to_render`). Masked after `scale` and before `rotate`
  in both engines, so a rotated clip's rounding rotates with it, and it
  MULTIPLIES alpha so crop/opacity/fade/dissolve still compose. The formula is
  the canonical rounded-box SDF, chosen because the obvious
  distance-from-the-corner form was **measured broken** against real ffmpeg
  first: at `r == 0` it evaluates to 0.5 and silently halves the whole layer's
  alpha, which a keyframed radius passing through zero would have hit live. The
  two engines are pinned to one canonical table of real-ffmpeg alpha bytes that
  BOTH suites assert — max divergence 1/255 on 0.6 % of pixels, and the visible
  arc is identical on every row. `corner_radius: 0` emits no masking work at
  all. Lands with the Inspector row (it joins `ClipTransformParam`, so it gets
  the diamond, reset and curve editor) and both MCP surfaces in the same pass.

- **2026-09-18** — **B-159: the Agent Activity dock's "Hide" (X) button now
  actually hides the dock**, instead of silently duplicating the caret-toggle
  beside it. New `dockDismissed`/`dismissedAtRowKey` state on `useAgentStore`
  re-shows the card the instant a genuinely new activity item (Colorist,
  Edit, or Motion) arrives, so dismissing never hides real new activity. New
  DOM-level test (`AgentActivityDock.dom.test.tsx`, jsdom +
  `@testing-library/react`) covers both the hide and the re-show.

- **2026-09-18** — **B-196: a failed `presets.json` read can no longer wipe the
  user's preset library.** `usePresets.ts` now tracks a real `PresetsLoadStatus`
  (`idle`/`loading`/`ready`/`error`, mirroring `timelineStore.ts`'s
  `TimelineLoadStatus`) instead of collapsing "load failed" into the same `[]`
  as "genuinely no presets yet" — `savePresetsToBackend` refuses to persist
  unless the last load actually succeeded. New `usePresets.dom.test.ts`
  regression-tests the exact failure (a failed load followed by an edit no
  longer writes an empty list back over the real file).

- **2026-09-18** — **B-194: a corrupt `settings.json` no longer gets silently
  replaced with defaults and written back over the real file.** New
  `app_settings::LoadSettingsError` (`NotFound`/`Io`/`Parse`, copied from
  D-326's `LoadManifestError`) distinguishes "first run" from "a real settings
  file exists and failed to read" — only the former may default. The frontend
  catch in `useAppInitialization.ts` no longer fakes a loaded `appSettings`
  value (which used to unlock the auto-persist effects that wrote the default
  back); `useSettingsStore` gained a real `settingsLoadError` state plus a
  `toast.error` so the failure is visible instead of silent.
- **2026-09-15** — **B-199: the transport bar's timecode no longer jitters,
  and drops the frame field.** `tabular-nums` alone only fixes digit widths;
  `font-mono` on the whole readout makes every character (colons, `/`, space)
  the same advance width, so `current / total` is a true constant width. Also
  drops the trailing `:FF` per the owner's request — `fmtTimecode` itself is
  unchanged, only this one display strips it.
- **2026-09-15** — **D-329: the Transcript panel reads the WHOLE timeline, and
  follows the spoken word.** D-328 scoped it to one selected clip and disclosed
  that as a limit; the owner rejected it ("i should be able to transcribe the
  whole main timeline not just one clip") — a cut sequence is dozens of clips,
  so "select one clip" made the only real question unanswerable. New pure module
  `timelineTranscript.ts` splits the two halves that pull opposite ways: fetch
  deduped per FILE (forty clips off one `.MOV` is one whisper job), but read by
  walking CLIPS in timeline order, so speech the edit cut out never appears. The
  conversion delegates to `spanToFrames` rather than the obvious
  `startFrame + (sourceFrame - sourceStart)`, which is **B-077's exact bug** —
  pinned by a 48fps-source fixture whose naive answer is the row's own END
  frame. Per-FILE progress (count, basename, clip count, live elapsed) with the
  done files' rows rendering while others run, not one opaque spinner. Words are
  real buttons: the spoken one highlights karaoke-style and clicking one seeks
  to its own frame — riding the SAME store subscription as the row highlight,
  never a second one (measured: 0 commits inside a word, exactly 1 on a word
  boundary). Unlike D-328 this **did** need an MCP tool —
  `editor_get_timeline_transcript` on both surfaces (168 → 169), served by the
  same stitch the panel renders. Real-Chromium pass caught two spacing defects
  every unit test missed, and closed D-328's own disclosed harness gap by
  exposing `mediaStore`.
- **2026-09-15** — **D-328: markers can span a RANGE, and the Edit tab has an
  Index panel.** `Marker.duration_frames` reverses D-222's deliberate
  scope-out — its "a second time-extent concept" objection does not survive
  contact (an annotation's extent participates in no compositing, ripple or
  export), while its "wants its own drag affordance" objection was right and is
  answered by drawing a ranged marker as a BAR on the ruler rather than a pin.
  A point marker is an ABSENT duration, never a zero one — one gate
  (`normaliseMarkerDuration`) enforces that at every write, which is what lets
  a pre-D-328 `project.json` load untouched and re-save without gaining the
  key (tested). The popover now carries Time + Duration as real timecode
  fields (`parseTimecode`, new, beside `fmtTimecode` so formatter and parser
  cannot disagree), a bigger Comments box and Remove Marker. The new **Index**
  library mode lists every marker (colour, poster frame, in → out, an inline
  comment that writes a real `set_marker`, delete, click-to-seek) and the
  selected clip's transcript (click-to-seek, with the row under the playhead
  highlighted). That highlight is the D-325/B-146 trap: it subscribes to the
  store and sets state only on a row-BOUNDARY crossing, so 30 ticks inside one
  segment cost **0** React commits where the naive reactive selector costs 30
  — measured both ways. `EditLibraryPanel`'s own reactive `playhead`
  subscriber was fixed in passing (the new panel is its child); B-146 stays
  open with nine left. Both MCP surfaces gained `duration_frames` together,
  parity corpus regenerated and diffed to exactly the three marker tools; no
  new tool was needed for the panel, verified rather than assumed.

- **2026-09-15** — **B-198 fixed (D-327): a retake is a SPAN of utterances, and
  the embedding model that looked like the answer is measurably the wrong
  tool.** On the owner's own footage the detector found one group of two and
  missed a line the speaker delivered three times, leaving ~22s of duplicated
  speech unflagged — because Whisper's segment boundaries straddle the restarts,
  so no pair of utterances was ever a duplicate of another (measured: best 0.857,
  every pair carrying repeats two and three 0.18-0.28). `detect_retakes` now
  compares spans of up to `max_span_utterances` (default 3) adjacent utterances:
  the same material scores 0.905, and the detector finds three takes reaching
  179.92s where the old one stopped at 157.48s. Groups gained `takes` (inclusive
  ranges over `members`; `keep` indexes them), which also fixed an unreported
  latent defect — the Recut panel and the MCP op both built one cut candidate
  per member, which with multi-utterance takes would have offered half a
  delivery for cutting while marking the other half the keeper. The obvious
  semantic fix was built in full (`all-MiniLM-L6-v2`, on-device ONNX, verified
  to four decimals against upstream's own reference implementation) and
  **rejected on measurement**: cosine scores a sentence against its own negation
  0.946 and an antonym pair 0.981, above every genuine retake (0.59-0.77), with
  five of six must-not-group probes outscoring the weakest true one. No
  threshold separates them; edit distance ranks the same pairs correctly. Full
  numbers: `docs/notes/retake-detection.md`.

- **2026-09-15** — **B-197 filed: `editor_ripple_delete_ranges` silently
  dropped 2 of 87 ranges from a batch cut while reporting full success.**
  Both ranges independently verified correct in an earlier 60-range call on
  the same file — only failed once the batch grew larger/differently
  composed. Confirmed by brute-forcing the true frame union against the
  actual result (630 frames/26.25s survived that should have been cut, one
  fewer clip boundary than requested). Not root-caused yet — likely
  `rippleDeleteOneRange`'s silent early-return on a refused `remove` op,
  but not confirmed. Worked around for tonight's real edit by splitting into
  two smaller calls, each verified independently — not a fix, disclosed as
  a workaround.

- **2026-09-15** — **B-193 fixed (D-326): a manifest that fails to load is no
  longer mistaken for a project that doesn't exist.** `load_manifest` returns a
  typed `LoadManifestError` whose `NotFound` is a distinct variant (same
  `Display` text as before, so nothing downstream reworded), and
  `chroma_project_save` substitutes a fresh manifest **only** on a genuine
  not-found — every other failure now refuses to save and says so, naming the
  recovery file. `save_manifest` (already atomic since B-034/D-112, contrary to
  the bug report) gained the `fsync` that completes the pattern and a rolling
  `project.json.bak`, taken by O(1) hard-link before the new content lands.
  Measured fsync/backup costs and the rejected `rename(project.json → .bak)`
  variant — which would have re-created B-193 in a new form — are in D-326.
  Regression tests confirmed failing on the pre-fix code first. The audit also
  found the same read-swallow-then-overwrite shape in five places in
  RapidRAW-inherited code (`settings.json`, the `.rrdata` sidecars and their
  eleven write-back sites, `presets.json`) — filed as **B-194/B-195/B-196**,
  deliberately not folded into this commit.

- **2026-09-15** — **B-193 filed, critical: `chroma_project_save` silently
  wipes a project to empty if `load_manifest` fails for ANY reason, not just
  "doesn't exist yet."** Destroyed a real edited project live tonight during
  an app crash/restart under severe memory pressure — recovered only because
  the coordinating agent happened to have the exact cut ranges saved
  separately. No distinction between "new project" and "existing project that
  failed to read" in either `load_manifest`'s error type or the autosave
  fallback that trusts it. No backup, no versioning, nothing to catch this the
  next time. Not fixed yet — needs a real fix (typed not-found vs. real error,
  atomic writes, possibly a rolling backup), dispatched separately.

- **2026-09-15** — **D-325, B-146 continuation: `TimelinePane`'s reactive
  `playhead` subscription was scaling preview cost with clip count.** Live
  testing after D-323/D-324 still showed a heavily recut 96-clip project at
  218ms/frame vs. a 1-clip baseline's 94ms — both far above D-290's ~21.5ms
  ceiling. Measured and ruled out two leads first (a Rust timeline clone,
  D-324's own prefetch keep-list — both real O(clip-count) but microseconds,
  not milliseconds). Found: `TimelinePane.tsx`, one of D-290's "eight
  components that re-render on every displayed frame" (actually eleven,
  recounted this pass), is a ~4500-line component that also fails its own
  React Compiler test (B-184) and walks every clip to render — so its
  playhead-driven re-render cost scaled with clip count, and it double-
  committed every tick on top of that. Fixed: reads `playhead` via
  `getState()` at the three call sites that need it instead of a reactive
  selector — one commit per tick now, not two, at every clip count
  (`TimelinePane.playheadCost.dom.test.tsx`). Honestly scoped: the remaining
  per-commit cost still scales with clip count (now inside
  `@xzdarcy/react-timeline-editor`'s own internal re-render), the other ten
  subscribers are untouched, and this pass could not re-take live
  `debug_frame_timing` numbers against the real app (worktree isolation) — see
  D-325 and `docs/04-roadmap.md` item 25.

- **2026-09-14** — **D-324 fixes B-191: every cut of a recut timeline cost a
  ~300 ms ffmpeg keyframe seek in the playback hot path.** A ripple-delete's
  boundaries are arbitrary source-frame jumps, so all 95–155 of them forced a
  pipe respawn — measured at 248–337 ms, of which `Command::spawn` is 0.8 ms, so
  the cost is the seek and nothing else. Fixed by priming the next clip's pipe
  ~0.5 s ahead off the edit list the app already has, and adopting it at the
  boundary: **307 ms → 31 ms per cut**, inside one frame's budget. Proxy media
  rejected a third time, now on evidence — it would reseek at every boundary too.

- **2026-09-14** — **D-323 fixes B-190: a recut timeline's audio went silent for
  good at the first cut.** The mix loop ended the session the first time every
  OPEN source ran dry, and its timeline re-resolve ran on a separate 100 ms
  schedule — so four boundaries in five were judged against a stale resolve, and
  the first to lose the race ended playback permanently ("stop and start and it
  starts working"). Now exhaustion forces a resolve at that exact position
  before it is believed. Exhausted sources are also retired, which that fix
  would otherwise have made reachable as one open decoder per cut. A slow
  synchronous open was ruled out by measurement (0.4–4.7 ms), so no audio
  prefetch was built. B-192 filed for the narrower gap case left.

- **2026-09-14** — **D-322 fixes B-189: the transcribe "subprocess" was a
  plain function call.** `server.py` imported `transcribe.py` and called it, so
  every job's mlx-whisper weights and Metal buffers landed in the long-lived
  uvicorn process — the exact thing the module's own header comment said was
  structurally impossible. No MLX exotica involved. `transcribe_subprocess()`
  now runs the file as `__main__` through `sys.executable`, the same shape
  `video_understand` already used for the VLM. Measured: a fresh process went
  **10 MB → 4,387 MB** on one 9-second clip the old way; the fixed sidecar
  holds **47 MB with zero `IOAccelerator`** across two real jobs over real
  HTTP. Transcript output is byte-identical, the `/transcribe` contract and the
  `_GPU` serialisation are untouched, and B-119's error sentence still crosses
  the new process boundary verbatim. New `test_transcribe_subprocess.py` pins
  the wiring so the import can't come back.

- **2026-09-14** — **B-189 filed: the `ai-media` sidecar leaks GPU/Metal
  memory per transcription job, unbounded.** Caught via Activity Monitor
  showing the same process grow 5.87GB → 11.18GB across two real
  transcriptions; `ps`'s RSS metric is blind to it entirely (shows ~35MB) —
  only `footprint`/Activity Monitor's own accounting sees the ~11GB sitting
  in `IOAccelerator (graphics)`. Contradicts the sidecar's own documented
  "subprocess isolation makes this structurally impossible" design. Not
  fixed yet — needs root-causing why MLX's Metal context outlives the
  subprocess boundary.

- **2026-09-14** — **D-321 fixes B-188: the recut slowdown was an O(n²)
  resample, not the VAD, the packet loop, or a debug build.** All three
  suspects B-188 named are ruled out by measurement (2.46s of `next_packet()`,
  5.0s of VAD, and `[profile.dev]` is already `opt-level = 2`). The real cause
  was `RateConverter::push_interleaved` — written for playback's one-packet
  pushes, quadratic when `decode_mono_at_rate` hands it a whole clip, because it
  drained the accumulator per chunk. A cursor plus one reclaim per call takes
  the owner's 989s 4K file from **243.6s to 4.9s** (686s file: 169.5s → 3.0s)
  with bit-identical VAD output. Separately, both detectors are now
  **start-then-poll** on the same store and vocabulary the transcript tools use
  — new `editor_detect_silences_status` / `editor_detect_retakes_status` (MCP
  **168 tools**, parity recapture clean) — so a detection that outruns its
  caller's timeout is held instead of discarded, which no amount of speed
  guarantees on its own. `RECUT_TIMEOUT_MS` deleted; the Recut panel polls the
  store rather than blocking, and a retake run resumes itself once its
  transcript lands.

- **2026-09-14** — **B-188 filed: `editor_detect_silences` blows its own 180s
  budget on real 4K camera footage, and the result is then unrecoverable.** The
  very first real use of D-318's detector — the owner's own 4.48 GB HEVC 4K
  clip — timed out; the app kept working several minutes past the timeout
  (VAD itself is fast, so `decode_mono_range`'s packet loop over a huge
  interleaved container is the leading suspect) and then went idle with no
  completion or error logged anywhere. Not fixed yet — needs real profiling.

- **2026-09-14** — **D-318 (cont.): the Recut panel, three MCP tools, and an
  atomic `ripple_delete_ranges`.** The GUI half and the agent half landed
  together because CLAUDE.md requires it. `ripple_delete_ranges` exists because
  this store pushes one history entry per op, so accepting 20 detected silences
  would otherwise cost 20+ presses of cmd-Z — it composes the already-tested
  split/remove/remove_gap rather than re-deriving ripple arithmetic, and applies
  ranges back-to-front so an earlier cut cannot move a later one. MCP goes to
  **166 tools** (was 163), all still passing the golden-corpus parity harness;
  the recapture was byte-identical for the 163 that already existed. Detection
  is synchronous on a 180s budget because it was measured, not guessed: 16.1
  minutes of audio scores in 6.1s.

- **2026-09-14** — **D-318/D-319/D-320: `apelles-speech`, the read-only silence
  and retake detectors.** The owner's talking-head footage needed the dead air
  and the flubbed takes cut, and Apelles could find neither — `editor_get_waveform`
  returns unclassified amplitude, `editor_remove_gap` is about *editorial* gaps,
  and `mcp-tool-coverage.md` literally instructed an agent to pick the spans by
  hand. A raw `ffmpeg silencedetect` was the first reach and was correctly
  stopped ("we should build internal tool not rely on ffmpeg scripts"). Silence
  now comes from a **real VAD** — silero-vad v6.2.1's own released ONNX, on-device
  via the `ort` stack `app/src-tauri` has run seven models on since the fork
  (D-319) — rather than from Whisper word-gaps, which would have made a purely
  acoustic question wait minutes for a transcript and inherit the decoder's
  hallucinations. Retakes stay transcript-based, since they are a fact about
  words. Both are strictly read-only: they return candidates, and applying one
  reuses the split/remove/ripple ops that already existed. Pinning the model
  version turned out to matter — v6 fed v5's bare 512-sample window returns
  probabilities pinned near 0.001, so **every frame reads as silence** with no
  error at all (measured table in D-319). Plain edit distance also missed the
  exact case this was asked for (a false start scores 0.647), so `similarity()`
  adds a containment view over `strsim` (D-320). 33 tests; the Rust runner
  reproduces an independent Python reference exactly on a real clip. B-187 files
  an `ort` process-exit abort found and root-caused along the way.

- **2026-09-13** — **D-317 (fixing B-185): the on-canvas caption box no longer
  draws for a cue the playhead is not over.** Reported as "the box only covers
  one line of a multi-line caption after a size change re-wraps it"; the
  wrapping theory was wrong twice over — nothing in Apelles wraps caption text
  (lines are literal `\n`s, D-229), and the measurement and rasteriser agree
  exactly at every font size. The box was simply drawn for the SELECTED cue with
  no check that it was on screen, so it landed on top of whichever cue was, and
  because `CaptionLayout` anchors `position_y` at a cue's last line, a one-line
  phantom box falls precisely on a two-line caption's bottom line. Confirmed
  live on the reporter's own project (selection on a cue starting at frame 230
  while the playhead sat at 115). Now gated on `clipCoversFrame`, newly
  extracted so `clipAt`, `visibleCaptionsAt` and the overlay share one
  definition of "on screen at this frame" instead of two copies and a missing
  third. B-186 files the same hole in the video-clip overlay.

- **2026-09-13** — **D-316 (fixing B-183): a caption is now selectable, movable
  and resizable on the canvas.** Selecting a caption showed a full working
  Inspector and drew absolutely nothing on the picture — root cause was
  mechanical, not deliberate: `chroma_timeline_clip_geometry` returns
  `Err("clip has no source")` for a caption clip's empty `source_path`, so
  `TransformOverlay` bailed silently. Now a real box on the cue's **measured**
  rendered bounds (`CaptionLayout::bounds`, fed real `ab_glyph` metrics by
  `caption_bounds_px`, surfaced by the new `chroma_measure_caption_bounds`
  command — proved against actual drawn pixels, not against itself), with
  drag-to-move writing `position_x`/`position_y` and a corner drag writing
  `size`, the font size, scaled about the style's own anchor so every line, the
  leading and the background padding grow as one unit. Built from a real
  reference sweep (Premiere/Resolve/FCP/CapCut/Canva/Figma —
  `scratch/caption-oncanvas-reference/`), which is also why the corner writes
  font size rather than a new `scale` field, and why there are four handles and
  not eight. Same ops as the Inspector and `editor_set_caption_style`, so one
  source of truth and no MCP gap. Canvas click-to-select sees captions too.
  The live verification pass (a real build, a real talking-head clip, 8 cues
  from its own Whisper transcript) earned its keep: it caught the measurement
  command resolving the cue from the PERSISTED timeline, so the box lagged the
  text by one ~400 ms save debounce — B-088's class, reintroduced through a
  different door. The command is now a pure `text + style + comp size → box`
  function with no timeline access at all.


- **2026-09-13** — **B-182: the shared Sources panel toggle silently ate every
  click in Colorist, only Colorist** — Colorist's own `EditorToolbar` wrapper
  sat at the identical `z-10` and, rendering after the chip in DOM order, won
  every stacking tie and absorbed the click before React ever saw it. Isolated
  live via a temporary `console.log` inside the real `onClick` (zero output on
  a real click, correct output once raised above the competing element) —
  no DOM inspection or state test could have shown this, since jsdom computes
  no real paint order. Fixed by raising the chip to `z-20`.
- **2026-09-13** — **B-181: `cargo build` on a fresh checkout could fail outright** —
  the `uv`/ONNX Runtime downloads in `build.rs` used no explicit HTTP timeout, and
  the implicit default was shorter than a real download reliably takes (`curl`
  succeeded on the same URL in 11.4s; a bare `reqwest::blocking::get` reproduction
  timed out every time). All 4 worktrees this session had the binary pre-cached and
  never hit it — same "verified once under conditions that never exercised it"
  shape as B-169/B-173/B-177. Fixed with an explicit 120s timeout on a shared client.
- **2026-09-13** — **B-178: `cargo test -p apelles` had been red since B-171** —
  four tests still relied on the auto-placement B-171 deliberately removed.
  Each now places its clip(s) explicitly via `append_media_clip`, the same
  fix B-171 already made for its six sibling tests in `apelles-project`.
  `cargo test -p apelles --lib` → 307 passed, 0 failed.
- **2026-09-13** — **B-174: "Captions from Transcript" could hang forever** —
  a cached transcribe model still tried an online revision check (`huggingface_
  hub.snapshot_download` with no `local_files_only`), and today that call died
  mid-flight (a CLOSE_WAIT socket, confirmed live via `lsof`) with no timeout
  anywhere in the path. Fixed by resolving the cached snapshot path ourselves
  first, so `mlx_whisper`'s loader never touches the network once a model is
  cached. Same bug family as B-172; `ai/server.py`'s other model loads weren't
  audited for it in this pass.
- **2026-09-13** — **D-315: the AI Python environment now bootstraps itself on first
  launch from a bundled `uv`, instead of a human running `ai-env/setup.sh`.** The
  installer carries a 34.8 MB static `uv` binary (Tauri `externalBin`, fetched +
  sha256-verified at build time) rather than the 1.6 GB venv; at app launch a background
  thread runs `uv python install` -> `uv venv` -> `uv pip install -r
  requirements.lock.txt`, fetching its own self-contained CPython so it works on a
  machine with no Python at all. Never blocks startup. Retry (capped backoff), resume
  (verified: `SIGKILL` 45 s into a cold install, identical re-run finished in **25 s**
  off uv's wheel cache) and self-heal (a torn venv is detected by really importing both
  sidecars' packages via the shared `ai-env/verify.py`, then re-installed and, if still
  broken, wiped and rebuilt). Live state on the `ai-env-status` event +
  `chroma_ai_env_status`, mirrored by `ai_env_status` / `ai_env_retry` MCP tools, so
  clicking Subject Mask thirty seconds after install says "still setting up" instead of
  a raw connection error. A real bug caught by its own test: `uv venv` refuses an
  existing environment without `--clear`, so the heal path could never have rebuilt a
  torn venv.
- **2026-09-13** — **D-315, the agent half:** `ai_env_status` / `ai_env_retry` land in
  BOTH MCP servers (161 -> **163** tools, parity harness re-captured and passing), and
  the five AI-backed tools now fail with a stable `ai_env_not_ready` token carrying the
  phase and the package counts instead of a bare connection error nobody could tell from
  a crashed sidecar. Both ops are answered natively by `control.rs` in Rust — the D-210
  path's first *shipped* members, because the bootstrap has no store state and is most
  interesting during startup, when a forwarded op cannot be answered at all (B-071). The
  not-ready check sits at the one sidecar call site rather than in either server or in an
  op-name list, so the GUI gets it too and a still-image subject mask (ONNX SAM, no
  Python) is correctly never gated. **B-180:** `retry_now()` promised a retry in the one
  phase whose supervisor thread has already exited. **B-175:** `add_subject_mask` /
  `track_subject` reported `ok: true` for an AI call that failed — the error was swallowed
  into a GUI toast. **B-177:** `npm run tauri:dev` rebuild-looped forever in a fresh
  checkout — `build.rs` re-copied a watched resource on every build. **B-178** filed
  here (fixed separately, see above): `cargo test -p apelles` had been red since B-171
  (four tests in the app crate still assumed the auto-placement that change deliberately
  removed).
- **2026-09-13** — **D-315, the GUI half: the bootstrap now has a face.** One shared
  store (`@apelles/bridge`'s `aiEnv.ts` — in `bridge` because the consumers straddle the
  `app/` / `packages/` layer boundary, and shared because Tauri events aren't buffered so
  every consumer needs read-once-then-listen), an **AI Environment** card in Settings with
  a real progress bar, package count, elapsed time, retry countdown, Retry now on `failed`
  and Re-check on `ready`, and a "still setting up — 47 of 91 packages" line at every
  sidecar-backed control *before* it is clicked: track subject, finalize matte, track
  depth, relight bake-normals / track-depth, Captions from Transcript. Deliberately
  advisory — nothing is disabled, because a sidecar someone started by hand answers
  regardless of what the bootstrap reports, and the agent half's `explain_unreachable`
  already turns a call that really fails into `ai_env_not_ready`. The two are complements:
  the call site can only explain a failure that happened, the GUI can only show the state
  before it does. `unknown` says nothing (it's the first milliseconds of every launch),
  `unavailable` warns without promising a retry, and the in-process ONNX Bake Depth
  carries no notice at all. `safeUnlisten` moved into `bridge` as the canonical copy for
  `packages/*`.
- **2026-09-12** — **D-314: both Python sidecars now run from ONE shared venv
  (`ai-env/.venv`) — 3.5 GB of duplicated wheels down to 1.8 GB.** They stay two
  separate PROCESSES; only the environments merged. D-189 split them because
  `mlx-vlm` needs `transformers>=5.5` and `ai/` pinned `<5` for ViTMatte, which
  pip called `ResolutionImpossible` — but that `<5` was a defensive pin nobody
  re-tested, and it no longer holds: the real `hustvl/vitmatte-small-composition-1k`
  checkpoint produces a correct matte on transformers 5.x (fg 1.0000, bg 0.0000,
  124 distinct alphas), and the union of both requirement sets installs cleanly.
  Dependencies are declared per-sidecar and compiled into a committed
  `ai-env/requirements.lock.txt`, **exactly pinned including transitives** —
  deliberately, as the guard against this stack's known "silent upgrade" failure.
  One new install step for a fresh checkout: `./ai-env/setup.sh`. Bonus find: the
  old `ai/.venv` carried a stray `utils3d` 0.1.0 — an unrelated PyPI package
  sharing a name with the `utils3d_moge` fork MoGe actually imports — which had
  pulled in jupyter/open3d/pandas/scikit-learn for nothing. A real bug caught by
  its own new test: `canonicalize()` on a venv's `bin/python` resolves the symlink
  to the *system* interpreter and silently abandons the locked environment.
- **2026-09-12** — **B-172: `understand_video` can never download its own
  model** — found end-to-end verifying D-314; `HF_HUB_OFFLINE=1` is set
  unconditionally on every call, so the "first-run download" the code's own
  docs promise is unreachable on a machine that's never fetched the model.
  Not a D-314 regression (reproduces identically pre-merge); left open,
  wants its own local-first-policy `D-NNN`, not a quiet patch.
- **2026-09-12** — **B-173: `npm run tauri:build` — this repo's own
  documented release-build command — failed outright** with `unrecognized
  subcommand 'tauri'`, a redundant literal `tauri` left in the root
  `package.json` script. One-line fix; `tauri:dev` was unaffected (different
  script shape).
- **2026-09-12** — **B-170: deleting a project you just closed refused with
  "cannot delete the currently open project"**, from a screen that plainly
  has no project open — `closeProject()` now tells the Rust side too (new
  `chroma_project_close` command), which `set_project`'s own doc comment
  always said should happen but nothing ever called.
- **2026-09-12** — **B-171: a new project no longer auto-places every picked
  clip onto the timeline** in file-picker order — they land in the media
  pool only, placement is now always a deliberate drag/`editor_add_clip`.
  Also: the New Project dialog's Create button is now disabled until both a
  name and at least one clip are chosen.
- **2026-09-12** — **the native Help menu now has real items** ("Keyboard
  Shortcuts", "MCP") instead of macOS's empty default — both just open the
  same dialogs the chrome bar already does (`app/src-tauri/src/lib.rs`'s new
  `.menu()`/`.on_menu_event()`, a plain event `Shell.tsx` listens for).
- **2026-09-12** — **B-169: D-313's MCP sidecar could never have started on its
  own — nothing in the app's build built the binary the app spawns.** It
  crash-looped every ~0.5s from the moment it merged, on a *pre-D-313*
  `target/debug/apelles-mcp` that ignored `--http`, served stdio, and hit
  instant EOF (`ConnectionClosed("initialize request")` — rmcp's stdio path, not
  its HTTP one; `serve.rs` and rmcp were both innocent). `apelles-mcp` is
  deliberately not a Cargo dependency of `apelles`, and Tauri's build hooks ran
  vite only, so `npm run tauri:dev` never produced the binary
  `Launch::WorkspaceBin` goes on to spawn. Fixed by building it in the hooks
  (`tauri:before-dev`/`tauri:before-build`), with a test that follows
  `tauri.conf.json` → `app/package.json` and asserts the hook really builds the
  package the spec launches. The D-101 staleness guard cannot catch this class at
  all for a compiled sidecar (it hashes the very file the child runs, so a
  months-old build matches itself) — now documented as such instead of implying a
  check it does not perform, and the fast-fail escalation no longer tells the user
  to look for "the Python error" in a Rust sidecar's crash loop, printing
  `cargo build -p apelles-mcp` instead. `http_transport.rs` was green throughout
  because it discarded its serving task's result and every test outlived the
  server by milliseconds; it now holds and checks that task, and a new test binds
  the server and leaves it idle with no client for 3s. Both guards
  negative-controlled. D-313's "the sidecar is healthy and I called a tool
  through it" was true only because that session had hand-built the binary, which
  is exactly what masks this.
- **2026-09-12** — **D-313: Apelles runs its own MCP server, and a client only
  needs a URL.** `apelles-mcp` gained a streamable-HTTP transport (`--http`,
  rmcp + axum, loopback `127.0.0.1:19790/mcp`, `CHROMA_MCP_PORT` — 19789 was
  the first pick and turned out to be held by Palmier Pro on the owner's own
  machine, found by `lsof` during end-to-end testing) serving the
  identical 161 tools; stdio stays the default so every D-312 registration keeps
  working. The app spawns and supervises it on launch the way it already does
  the two Python sidecars — health-checked, restarted with backoff, never
  killing an instance it did not start, killed on exit — by generalizing
  `apelles_ai::sidecar`'s `SidecarSpec` to describe a compiled binary rather
  than copy-pasting the supervisor. `ConnectMcpDialog.tsx` now leads with each
  client's URL registration, verified fresh per client (they genuinely differ:
  `url` vs `serverUrl`, `mcpServers` vs `servers` vs `context_servers`, Cline's
  `"type": "streamableHttp"`), keeping stdio as the fallback — Claude Desktop's
  config file cannot express a URL server at all.
- **2026-09-12** — **added a "Connect to MCP" help dialog** (shell-level,
  next to the Keyboard Shortcuts opener) covering the real, verified config
  format for 7 MCP clients — Claude Code, Claude Desktop, Cursor, Windsurf,
  VS Code, Zed, Cline — plus a link to apelles.studio. Reference copy only;
  performs no setup/connection itself. Every client's command/config now
  points at a new `mcp/run.sh` wrapper (resolves its own venv + `server.py`)
  instead of exposing the venv's python interpreter path directly. A larger
  follow-up (moving the MCP server itself off Python entirely, onto a native
  Rust implementation) is in progress separately — see `docs/08-decisions.md`
  once that decision record lands.
- **2026-09-12** — **D-312: the MCP server is reimplemented in Rust
  (`crates/apelles-mcp`, on `rmcp` 3.3), replacing `mcp/server.py`.** The test
  harness came first and is the gate: `parity/capture.py` records what the real
  Python server publishes and emits for all 161 tools (237 calls, against a stub
  control server, no app needed, byte-identical across runs), and
  `cargo test -p apelles-mcp` replays that corpus against the Rust server
  through a real MCP session. **All 161 tools are ported and passing** —
  Colorist 42, Edit 73, Motion 37, debug 9 — with both servers publishing an
  identical tool set over a real MCP session, and 16 read-only tools
  additionally diffed field-by-field against the running app. The Rust server
  has NOT been used for real work yet, so `mcp/server.py` stays as the fallback
  and as the corpus's reference; retiring it is a separate, deliberate call.
  Divergences and open items: `docs/notes/mcp-rust-port.md`.
- **2026-09-12** — **fixed B-168: `editor_import_subtitles` raised `NameError`
  on every call** and had done since 2026-09-08 — eleven caption-style
  arguments its body forwards were never added to its signature (D-241/D-242
  added them to `editor_set_caption_style` only). Found by D-312's parity
  harness on its first run, before a line of the port existed, because that
  harness is the first thing to ever actually *call* all 161 tools.
- **2026-09-12** — **fixed B-167: Relight now honours a rotated/flipped
  clip's real transform when baking its depth/normal map**, instead of
  always warping as if rotation/flip were zero — the depth (and any baked
  normal) used to silently drift out of alignment with the displayed frame
  the moment a clip was rotated or flipped. An initial hypothesis about the
  `rim` light's default `distance` was built into a real GPU-render
  regression test and empirically disproved before landing anything — see
  `docs/BUGS.md`'s B-167 entry for the actual root cause found on the
  follow-up pass.
- **2026-09-12** — **fixed B-162 (D-311): Apelles now decodes Opus audio
  natively.** `symphonia` (the D-049 playback decoder) has no Opus decoder at
  all, confirmed against its own feature list — so a WebM/Opus source
  (`yt-dlp`'s own default, and therefore most anything downloaded straight
  from YouTube) played with no sound and no error. Added
  `symphonia-adapter-libopus` (MIT/Apache-2.0, wraps the real libopus
  reference implementation, chosen over `moosicbox_opus` which is explicitly
  "under development" and MPL-2.0) rather than a transcode-at-import step —
  the owner's call was to decode the original file natively, not convert it.
  `apelles-media` now builds its own `CodecRegistry` (every default codec
  symphonia already had, plus Opus) instead of the static default one. Found
  and fixed a real environment gap along the way: `opusic-sys`'s build needs
  `cmake`, not installed on this machine — a one-time toolchain requirement
  now, not a workaround. Verified live against the exact file that surfaced
  the bug: real, non-silent, varying audio levels decoding from the
  untranscoded original. Also removed `forget_serving` (`control.rs`) and its
  dedicated test — B-164's fix left it as a kept-for-later primitive assuming
  a `WindowEvent` teardown hook would use it, but this app creates exactly
  one window, so that hook would never fire usefully; `cargo check` had
  already flagged it dead, removed rather than left speculative.
- **2026-09-12** — **fixed B-165/B-166: two MCP docstrings corrected to match
  real behaviour**, found while modelling D-310's schemas. B-165: `set_clip_fade`
  and `editor_set_keyframe_ease` claimed CSS's `"ease"` was a valid curve
  preset; the real parser only accepts `linear`/`ease-in`/`ease-out`/
  `ease-in-out` and rejects `"ease"` outright — docstrings now say exactly
  that. B-166: three Motion ease docstrings implied `y` overshoot was
  unbounded; the real handler silently clamps it to `-0.75..1.75` with a
  warning — now stated. Also confirmed, while auditing all 161 tools for
  this: the 121 tools that didn't need a D-310 model all have correct
  scalar typing already, and the 5 tools with a bare `Any` value param
  (`motion_set_*_field`/`_item`) are correctly `Any` by design — genuinely
  open-ended field setters, not a gap.
- **2026-09-12** — **fixed B-164: a slow Colorist op no longer bricks the
  whole Colorist MCP surface for the rest of the session.** `control.rs`'s
  `dispatch` dropped a registry's bridge claim on ANY timeout, but a registry
  only re-announces once, at mount — so a still-healthy, still-mounted
  registry (SAM 2 routinely runs past the default 20s budget) never got its
  claim back, and every later Colorist op 503'd blaming "still starting up"
  against a window that had been up for an hour. Very likely the real root
  cause of B-160. Fix: stopped calling `forget_serving` from the timeout
  path — the mid-session-reload case it was written for already self-heals
  through the new registry's own `announce()` replacing the stale claim by
  prefix. `cargo fmt`/`clippy` clean, all 11 `chroma::control` tests pass
  unchanged.
- **2026-09-12** — **every structured MCP parameter now has a real, validated schema
  (D-310, roadmap item 7 done).** New `mcp/schemas.py`: 20 reusable Pydantic models
  covering all 43 nested parameters across the 40 tools that have them, so each tool
  publishes real JSON Schema with typed `properties` instead of a bare
  `{"type": "object"}`, and a malformed argument fails at the tool boundary naming the
  field. Every shape was read off its real consuming handler rather than its docstring —
  a docstring-faithful schema would have rejected shapes that work today (the known
  `centerX/centerY` radial geometry, and four more found the same way). `to_wire()`
  re-emits only the caller's own keys, so the JSON posted to the control server is
  byte-identical to the pre-change code (verified, 29/29 payloads), which bounds the
  regression risk to validation alone.
- **2026-09-12** — **logged B-164 (high): one slow op permanently bricks the Colorist MCP
  surface for the session.** Found while trying to live-verify D-310 against the running
  app. A dispatch timeout makes `control.rs` drop the registry's bridge claim, but a
  registry announces only once at mount — so a still-healthy, still-mounted
  `useChromaControl` never re-announces and every later Colorist op 503s with a message
  blaming startup, on a window that has been up for an hour. Root-caused to
  `control.rs:471`; very likely the real cause of **B-160** too. Not fixed — it lives in
  `app/`, outside that change's scope. Also logged **B-165**/**B-166**, two
  docstring-vs-behaviour gaps the schema work surfaced.
- **2026-09-12** — **logged B-162: `hasAudio: true` doesn't mean Apelles can decode the audio
  codec Apelles' playback pipeline can't decode.** `editor_import_media`
  correctly probed a WebM/Opus source's audio, but `symphonia` (the D-049
  playback decoder) has no Opus decoder at all — confirmed against its own
  published feature list, not assumed — so the clip played silently muted
  with zero indication anywhere in the app. Logged as an open engine gap
  (needs either a new Opus-capable dependency or a transcode-at-import
  pipeline stage, both real design calls); the one clip this session needed
  was unblocked live via a direct `ffmpeg` re-encode to AAC, not a fix.
- **2026-09-12** — **fixed B-163: `editor_add_clip` now gives a dropped clip
  its own linked audio track, matching the real GUI drag.** The MCP tool
  called the same `add_clip` engine op the GUI's Sources-panel drag does, but
  never built the `linkedAudio` half the op already supported — an
  MCP/GUI-parity gap the code's own comments had documented as deliberate,
  which is exactly what `CLAUDE.md`'s "built for a human AND an AI" rule
  exists to catch. Fixed and verified live: `get_timeline` now shows a real
  second `kind: "audio"` track sharing the video clip's `linkGroup`, exactly
  as a Sources-panel drop produces. `editor_edit_in` has the identical
  inherited gap, not yet fixed — flagged in B-163, scoped out of this pass.
- **2026-09-11** — **disk-space pass + git-worktree audit.** Reclaimed ~62GB
  (4.8GB free → 66GB+): cleared `target/` in the main repo and one worktree
  (~17GB, pure reproducible build cache), removed 5 of 6 stale
  `.claude/worktrees/` entries after checking each one's diff against `main`
  individually (4 were fully merged with zero unique content; 1, `B-152`'s
  worktree, was ~180 files diverged and its own base bug already fixed
  separately — none discarded blind). The 6th, `agent-add0a2596af145652`, is
  left for the owner: 13 uncommitted Rust file edits on an ancient base, and
  the auto-mode classifier correctly declined to force-remove a worktree with
  real uncommitted changes without a closer look first.
- **2026-09-11** — **B-161 (re-)fixed**, see `BUGS.md` — the worktree audit
  above surfaced one worktree, `agent-a37ca05888692a3aa`, that was NOT
  redundant: a real, verified favicon-bloat fix (44KB → 7.7KB tab icon) that
  never made it into `main` after the `wrangler pages deploy` incident
  `CLAUDE.md`'s "never deploy to production from a worktree" rule is about.
  Re-applied the code change fresh (new bug number, since the original `B-150`
  collided with an unrelated bug already using that number on `main`) rather
  than merging the stale branch wholesale.
- **2026-09-11** — **root `README.md` rewritten** — it still described the pre-D-039
  "grading only, not an editor, Phase 0, nothing runs yet" framing from 2026-09-02, over
  a week stale and actively misleading for anyone finding the repo (it's public on
  GitHub). Rewritten to the current 3-tab framing, an honest pre-1.0 status, the accurate
  `crates/`/`packages/` layout from `CLAUDE.md`, and the 150+-tool MCP server as a named
  differentiator. Sourced from `docs/00-vision.md` and `website/src/data/product.ts`
  (the site's own test-checked ground truth) rather than freehand, to avoid introducing
  a second, driftable copy of the same claims. Also added `website/public/llms.txt`
  (verified via `npm run build` that it ships to `dist/`) — a machine-readable summary
  for AI crawlers/agents, on-brand for an AI-native tool and cheap to keep accurate since
  it draws on the same source data.
- **2026-09-11** — **docs fix: two stale "beta signup is a placeholder" references
  corrected** in `pre-launch-plan.md` and `04-roadmap.md`'s website section — the
  form moved off Formspree to a real, live FormSubmit.co endpoint on 2026-09-10
  (D-255 follow-up, `website/BETA_SIGNUP_SETUP.md`), but both docs still described
  it as an open placeholder. Caught when the owner corrected a marketing-channel
  answer that repeated the stale claim.
- **2026-09-11** — **roadmap: logged that no structured MCP tool parameter has a
  validated schema** (every `dict | None` arg across all 161 tools in `mcp/server.py`
  relies on docstring prose only — see `04-roadmap.md` gap 7 in the "Make Colorist's
  MCP tool surface AI-first" section). Found while building a sun-rays-through-window
  mask effect: `add_component`'s docstring documents `geometry` for a radial sub-mask
  as `{cx,cy,rx,ry,...}`, but the frontend also silently accepts an undocumented
  `centerX/centerY/radiusX/radiusY` shape — a second accepted shape a real schema would
  have made explicit. Nothing was broken (confirmed live after an initial wrong
  diagnosis — see the roadmap entry for the retraction), but there's no schema for an
  MCP client to validate against.
- **2026-09-10** — **fixed B-158: switching the active Colorist shot now decodes the
  right frame with the clip's geometry applied.** Live-caught: a shot switch showed
  `A001_09091129_C026.MOV` (a `rotation: 180` clip) upside-down. `decode_and_install`
  (the shot-switch pixel path) decoded `shot.frame` as a raw source index with no clip
  resolution and no geometry pass, unlike `chroma_seek`'s own clip-aware
  `seek_and_install` (D-294). Pulled the clip-local→source-frame mapping into a shared
  `colorist_view::frame_mapping`, used by both paths so a third can't independently
  drop it; `decode_and_install` now resolves the clip and runs `apply_geometry` before
  installing. 3 new unit tests; live-verified in the running app.
- **2026-09-10** — **fixed B-071 (D-309): the control server waits for a real frontend
  handshake before forwarding an op.** It binds its HTTP port in Tauri's `.setup()`, long
  before the webview loads and any `chroma://request` registry has subscribed, and Tauri
  does not buffer — so the first op after an app start was emitted to nobody, burned the
  full 20s budget and came back blaming a closed window; the retry worked because the app
  had finished starting meanwhile. Each registry now announces itself on
  `chroma://bridge-ready` (the prefix it claims, the prefixes it defers) and `dispatch`
  waits for one that really serves the op; giving up is a distinct, accurate 503.
  **B-071's filed cause was wrong** — `httpx.post` opens a fresh client per call, so there
  was never a connection pool to hold a dead socket — and the entry now records the real
  mechanism. 8 new `chroma::control` unit tests; `cargo fmt`/`clippy` clean. **Not
  live-verified against a real cold app start.**
- **2026-09-10** — **fixed B-080 (D-308): a pending debounced save is flushed before any
  switch that would misaddress it.** `chroma_timeline_set` lands on whichever timeline is
  ACTIVE when it arrives, so a save still on the 400ms debounce when the active timeline or
  the open project changed was addressed to a document the backend had moved off — while
  `load()` had already overwritten the only in-memory copy. The edit then existed nowhere,
  with no error at all. `flushPendingSave()` settles that debt (the timer *and* any save
  already in flight, `restoreSnapshot`'s immediate save included) before
  `createTimeline`/`setActiveTimeline` issue their command, and before `useSessionStore`'s
  project open/new/close issue theirs; a flush that fails refuses the switch rather than
  destroying the edit. 6 new regression tests, all confirmed failing pre-fix; `tsc`
  unchanged at its 65-error baseline. **Not live-verified against the real Rust backend.**
- **2026-09-10** — **D-306 (fixes B-150) + D-307 (fixes B-153), and two real causes
  found for B-155.** D-306: a Colorist shot's identity is now its Edit-timeline clip
  (`chroma::state::ShotId`), not its source file — two clips of one file are two
  independently viewable, independently gradeable shots, threaded through `Session`,
  `load`, `project`, `export`, `colorist_view`, the `ShotDto.clipId` wire field and
  `useSessionStore`. D-307: `POST /op` takes a caller-declared `timeout_ms` (clamped
  1s..=300s) and a 504 comes back as an `{ok,error}` answer instead of a masked
  exception — the flat 20s bridge timeout was cutting off a *successful*
  `add_subject_mask` mid-flight and reporting it as a bare, detail-free tool error.
  B-155 also gained a second, independent fix: `resyncClips` (a background poll) was
  replacing the editor's adjustments with another shot's grade without stashing the
  outgoing shot's first, silently discarding a just-created mask. **Verified by unit
  tests + `cargo clippy`/`fmt` only — not re-tested against the live app**, so B-155
  stays open pending a real run of its repro, and D-307's sidecar timing is reasoned
  from the code rather than measured.
- **2026-09-10** — **fixed B-144: a slip/slide drag no longer shows the move
  preview.** `onDndDragMove`'s suppression only checked Alt, so D-261's
  tool-driven slip/slide (no modifier) still painted the landing preview; the
  `DragOverlay` filmstrip/pill ghost was never suppressed for either entrance
  at all. Both now gate on the same `claimed` test `onDndDragEnd` already
  used to commit. New `TimelinePane.slipSlidePreview.dom.test.tsx` (6 tests).
- **2026-09-10** — **fixed B-011: `export_video`'s state restore was a no-op
  whenever nothing was loaded before the export** (`if let Some(p) = prev`
  never fires for `prev: None`, the ordinary case) — a real leak in the
  running app, not just the test-only symptom this was filed as, since
  `current_video()` stayed pointed at the export's last frame forever
  afterward. Now `set_current_video(prev)` unconditionally; `chroma::export`'s
  own tests also take `PROJECT_STATE_LOCK` (D-211), matching `chroma::audio`'s
  and `chroma::relight`'s (B-105) existing use of it.
- **2026-09-10** — **fixed B-041: `chroma_audio_play` on an audio-only Audio-track
  clip.** The original crash (`probe`'s `-select_streams v:0` erroring on a
  video-less file) was already gone, fixed incidentally by B-089/D-292's
  `probe_audio_only`. What was still live: `resolve_sources_at` converted a
  TIMELINE-frame span (`remaining_frames`) through the SOURCE's own probed
  fps, which for an audio-only file is `probe_audio_only`'s nominal `24` —
  wrong on any project whose fps isn't 24. New `timeline_frame_span_to_secs`
  divides by the timeline's own fps instead; new
  `resolve_sources_at_a_genuine_audio_only_track_clip_uses_the_timeline_fps`
  test (30fps timeline) pins `duration_secs: 3.0`, not the `3.75` the old
  formula would give.
- **2026-09-10** — **fixed B-152 (D-305): composition/export resolution no
  longer hijacked by a reference-image clip.** `composition_size()` used to
  derive a project's output resolution from the first video-track clip in
  plain track-index order, so a `match_to_reference` comparison photo sitting
  ahead of the real footage on the timeline silently set the whole project's —
  and therefore every export's — aspect ratio. It now prefers the first clip
  that is real footage anywhere on the timeline, falling back to a still only
  when the project has no video at all (a genuine slideshow keeps working
  unchanged). New unit tests in `edit.rs`'s `composition_size_tests` cover the
  repro, the images-only fallback, and explicit project settings still
  winning over any clip.
- **2026-09-10** — **B-145 + B-160: the timeline's drag gestures, root-caused and fixed.**
  **D-303** — a clip dragged on a horizontally-scrolled timeline landed at frame 0 no
  matter where it was dropped, because `@dnd-kit/core`'s `event.delta` is short by the
  whole scroll offset on this surface (its scroll adjustment is measured against
  `over ?? active`'s scrollable ancestors, and the dragged clip is inside the timeline
  library's scrolling grid while the drop zones are overlay siblings outside it). New
  `dragDelta.ts` derives the displacement from `active.rect.current` instead and adds the
  pane's own scroll change back; one helper now feeds the landing preview, the move, the
  create-a-track drop, the slip/slide drag and the transition drop — two of which were
  silently broken the same way and unreported. **D-304** — the drag also felt shaky:
  measured at ~2 full re-renders of `TimelinePane` per pointer-move (frame p90 24.3ms vs
  16.7ms idle), because the landing-preview state lived on the pane; moved it and its four
  overlays into `TimelineDragPreview.tsx` behind an imperative handle, back to p90 17.0ms.
  New: `docs/notes/timeline-drag-interactions.md`, the full pointer-down-to-`applyOp` map
  of all seven drag gestures and three drag systems on this surface.
- **2026-09-10** — **B-154 fixed:** the Colorist transport bar's duration/frame-count
  readout showed the raw source file's full length instead of the trimmed
  Edit-timeline clip's — `chroma::session::ShotDto::from` (`chroma_session_list`/
  `_add`/`_set_active`/`_remove`, what the ShotStrip and every shot switch build
  `videoInfo` from) never consulted `colorist_view::resolve`, unlike `chroma_video_info`
  which D-294 had already fixed. Extracted the shared correction into
  `colorist_view::display_info`/`display_info_for` and routed both call sites through
  it, with unit tests reproducing the bug's own numbers. Found but not fixed in the
  same pass, logged as **B-158**: `session.rs`'s `decode_and_install` (shot-switch
  pixel path) still decodes `Shot.frame` as a raw source index with no clip mapping or
  geometry pass, unlike the transport's own `chroma_seek`.
- **2026-09-10** — **B-151 fixed:** `debug_screenshot` on the Colorist tab always
  returned a stale, byte-identical blank frame. Root cause confirmed: Colorist's
  picture is a native wgpu surface painted onto the window BEHIND the webview
  (`gpu_processing::get_or_init_gpu_context`/`WgpuDisplay`), invisible to
  `takeSnapshotWithConfiguration:`'s webview-only capture. Fixed by reading back
  `GpuProcessor::output_texture` on demand (`gpu_processing::read_display_frame`,
  never on the interactive render path) and compositing it onto the webview PNG at
  its real on-screen rect (`debug_capture::composite_wgpu_overlay`). 5 new unit
  tests on the placement geometry.
- **2026-09-10** — **D-301: removed Colorist's standalone still-image Export panel**
  (owner call, live) — deleted `ExportPanel.tsx`, `Panel.Export` and every switch/map
  keyed on it, the `toggle_export` shortcut, both context-menu entries that opened it,
  the dead `isLibraryExportPanelVisible` flag, and its i18n keys across all 13 locales.
  Colorist grades video via the Edit tab now; standalone still-photo export had no
  remaining workflow to serve. `tsc` stayed at the pre-existing 65-error baseline.
- **2026-09-10** — **D-300: the whole app moved off `lucide-react` onto Phosphor
  Icons** (`@phosphor-icons/react` ^2.1.10, MIT) — 82 files and ~180 glyphs across
  all 7 packages that used it (`app`, `ui`, `editor`, `motion`, `player`, `shell`,
  `keymap`), chosen over Tabler/Heroicons/Radix for its six weights. Standardized
  on `regular`, with `fill` deliberately replacing the old `fill="currentColor"`
  idiom on rating stars and keyframe diamonds (Phosphor draws filled paths, so a
  CSS `fill` recoloured the outline instead of solidifying it). Closes the
  roadmap's "Lock/Unlock icons are hard to tell apart" item. Also deleted
  `simple-icons`, an unreferenced dependency in `app/package.json`.
- **2026-09-10** — BUGS.md status audit for B-077/B-091/B-126: all three were
  already fixed in code/data but their entries still read `status: open`.
  B-077 (timeline fps conversion) was fixed the same day it was filed
  (D-194) under a duplicate `## B-077` heading that never got cross-linked
  back to the original entry. B-091 (`editor_export`'s intermittent MCP
  response failure) was mitigated in the very commit that documented it
  (d88ad66, stripping the unbounded `args` field from the default response)
  but the doc text wasn't updated in the same commit. B-126 (website's stale
  MCP tool count) was fixed by D-264/D-266/D-270 and reconciled again in the
  2026-09-10 website-redesign merge (161 tools, 37 `motion_*`, matching
  `mcp/server.py` exactly; `website/tests/mcp-data.test.ts` 77/77 passing).
  No code changes were needed for any of the three — just correcting BUGS.md
  to match reality.
- **2026-09-10** — **B-108 fixed:** the export compiler's `keyframeExprAt`
  now takes the same shortest-signed-arc path for keyframed `rotation` the
  live preview's `lerp_value` already does, so a `350° → 10°` sweep exports
  as the +20° short hop through 0° instead of a -340° spin the long way
  through 180°. New `shortestArcDelta`/`unwrapRotationKeys` helpers in
  `timelineExport.ts`; 5 new tests mirror the Rust engine's own shortest-arc
  unit tests key-for-key. All 1730 `@apelles/editor` tests pass, `tsc`
  clean.
- **2026-09-10** — **B-141 fixed:** the launcher card's `thumb.jpg` is now
  generated through the same composited, transform-aware `timeline_frame_
  image` path the Edit tab's live preview uses (new `edit::timeline_thumb_
  jpeg`), instead of a raw, un-rotated single-frame grab off the Colorist
  tab's `current_video()` — a rotated clip's launcher card now matches what
  the timeline actually plays. New pixel-level test
  (`regen_thumb_applies_the_clips_rotation_like_the_edit_tab_preview_does`)
  proves a 180°-rotated clip's thumbnail is actually rotated — `cargo test`
  confirms it green. Falls back to the legacy raw grab only when the
  timeline has nothing to show at frame 0.
- **2026-09-10** — website image weight + SEO/social-card follow-ups from the
  same Lighthouse pass as B-149: converted the three `Demo.astro` screenshots
  from PNG to WebP (77-81% smaller, same pixel dimensions) and the hero
  painting to WebP-with-JPG-fallback via `<picture>` (35% smaller); built a
  real 1200×630 (1.91:1) dedicated OG/social-card image with the headline and
  a CTA baked in as pixels, replacing the bare 1568×1003 hero crop that most
  platforms were cropping or letterboxing; shortened every page's
  meta/og/twitter description to under ~155 characters (all five were over,
  the homepage at 239). **D-293:** also found and fixed a real drift —
  Cloudflare auto-enabled Web Analytics on the zone, silently making
  `privacy.astro`'s "no analytics anywhere" claim false; owner chose to keep
  the (cookieless) analytics and disclose it accurately instead of disabling
  it, so the privacy page now names it specifically.
- **2026-09-10** — **D-292: still images are first-class Edit-tab sources.**
  Importing a PNG used to come back `offline: true, video: null` and could
  never be placed — the extension gate rejected it before any probe ran. Now:
  a second probed kind on the pool item (`MediaItem.image`, additive on the
  wire), an ordinary media clip with a *synthesized* length (3s placed,
  reusing `DEFAULT_TITLE_SECONDS`; one hour of trim headroom) rather than a
  new clip kind, a memoised `apelles_media::still` decode that never touches
  `decode_pipe`, and a `-loop 1` export input — pinned by a real ffmpeg render
  that was mutation-checked. GUI and MCP in the same pass. **An honest
  widening of v1's "one footage type"**; D-292 says why that is right now, and
  `docs/02-scope.md`'s Edit-tab section is updated (Colorist's own scope line
  is not). Drafted as D-281, renumbered on the way in — `main` had meanwhile
  landed a different D-281 (RapidRAW ownership).
- **2026-09-10** — **merged the Colorist-tab consolidation** (agent worktree
  `af18c5eb8c0b19df9`) into `main`: B-147 fixed, the Metadata panel + rating
  widget removed, the Colorist frame strip replaced by a scrub bar, Agent
  Activity promoted to a shell overlay with real `source: 'user'|'agent'`
  attribution, and Export consolidated to one shell-level button with **both**
  backends deliberately kept underneath (Colorist's is the only one that
  renders masks/relight/crop — see D-297). Crop-panel dedup and player
  unification were investigated and deliberately NOT forced (D-299; roadmap
  items 8 and 9). All six of its decisions were renumbered on the way in —
  drafted D-291..D-296, landed as **D-294..D-299** — because `main` had
  meanwhile taken D-291/292/293. One dangling forward reference in B-147 was
  corrected in the same pass. The five entries below are that work.

- **2026-09-10** — **D-299: Colorist's duplicate Crop panel and the "one common
  player" ask are the same pass — scoped, not forced.** The owner's literal
  crop ask ("make the Edit one authoritative") was already delivered by D-294.
  What the investigation added: `CropPanel` is two halves (a real duplicate,
  and perspective+lens which nothing else in the app provides), `Panel.Crop` is
  a canvas MODE with 63 call sites reaching into grade-document fields the
  renderer and the mask maths read — and the reason the two previews cannot
  simply share a component is that **Colorist's picture is not a DOM element**:
  it is a native wgpu surface behind the webview. Three-phase shape recorded
  for the dedicated pass; the user-visible half of the complaint (the previews
  disagreeing) is already fixed by D-294.

- **2026-09-10** — **D-298: the agent activity feed is global, and finally
  reports Edit and Motion.** The dock moved out of the Colorist tab onto a new
  shell-level `overlay` slot. The instrumentation gap the roadmap predicted was
  real: nothing outside Colorist fed the feed. Closed by attributing what was
  already recorded — `@apelles/history` entries gained
  `source: 'user' | 'agent'`, stamped by a `runAsAgent()` scope that each tab's
  MCP dispatcher wraps its handler in, one line per tab rather than one per op.

- **2026-09-10** — **D-297: one Export, reachable from every tab.** Colorist's
  own Export dialog is gone; `EditorExportDialog` moved off the Edit tab's
  per-tab slot onto a shell-level `headerAction`, so it sits in the chrome bar
  whatever tab is active. Colorist's export BACKEND was kept, not deleted — it
  is the only path that renders masks / local layers / relight / the Colorist
  crop into a file (the Edit exporter carries the global grade only, as a
  baked LUT) — and was made clip-aware, closing B-147's residual on the export
  side. A speed-ramped clip is now refused there rather than silently
  exporting the wrong frames.

- **2026-09-10** — **D-296: RapidRAW's photo-culling workflow removed from the
  Colorist tab.** The Metadata panel (a single-photo EXIF viewer whose every
  field reads `-` on video) and the five-star rating widget are gone outright,
  D-281's standard — with every entry point: the `Panel.Metadata` route and its
  keyboard action, the `rate_0..5` shortcuts, both context-menu Rating
  submenus, the quick-filter stars, `imageRatings` and its filter/sort/search
  paths, the `Filmstrip` badge, and `set_rating_for_paths` in Rust. 13 locale
  files cleaned of the orphaned keys.

- **2026-09-10** — **B-147 fixed (D-294): the Colorist grades the Edit
  timeline's clip, not the raw source file.** A new one-way bridge,
  `chroma::colorist_view`, resolves the active shot to its
  `apelles_timeline::Clip` and gives Colorist the clip's real trim (the
  transport counts clip-local frames now, not the source file's 2990) and its
  real geometry (crop/scale/rotation/position, applied through the Edit
  compositor itself). No grade, no opacity/fade, no other layers — the
  geometry counterpart of `grade_lut`'s colour bridge. Identity fast path
  keeps an untransformed clip byte-identical. **D-295:** Colorist's
  frame-thumbnail strip retired for a real scrub bar (`ColoristTransport`),
  answering "a proper timeline or none" with "a transport, not a second
  timeline"; `chroma_frame_thumbnails`, `extract_thumb_strip` and
  `state::THUMB_CACHE` deleted whole.

- **2026-09-10** — fixed a real bug in D-291's own
  `.github/workflows/website-deploy.yml`: it ran `npm run test` before
  `npm run build`, but `tests/build-output.test.ts` requires `dist/` to
  already exist — every run since D-291 landed failed at the test step
  before ever reaching the deploy step, unrelated to the still-unset
  Cloudflare secrets. Caught by actually pushing and checking `gh run view`
  rather than assuming the workflow was correct. Reordered to check → build →
  test, matching `website/package.json`'s own `verify` script.
- **2026-09-10** — B-149: fixed two real Lighthouse findings on production
  (`apelles.studio`) — a contrast failure on the "01/02/03" room numbers
  (ochre on marble, 2.95:1; switched to terracotta, 5.3:1) and a
  render-blocking Google Fonts request costing ~750ms of LCP (moved to the
  standard preload+swap non-blocking pattern). Measured LCP 968ms → 225ms on
  the same production URL before/after. Deployed via `wrangler pages deploy`.
- **2026-09-10** — D-291: `website/` now has real hosting — Cloudflare Pages
  project `apelles-studio` on the `ashish.1999vns@gmail.com` account, custom
  domains `apelles.studio` (live, SSL verified) and `www.apelles.studio`
  (301-redirects to the apex, path/query preserved), and a path-filtered
  GitHub Actions workflow (`.github/workflows/website-deploy.yml`) so a push
  only deploys when `website/**` actually changed. GitHub secrets for the
  workflow are not yet set (owner's own step — see D-291). Corrected a false
  start mid-pass: the Pages project was first created against the wrong,
  already-logged-in Cloudflare account and had to be deleted and redone.
- **2026-09-10** — B-148: fixed the website Hero's mobile ask overlapping the
  headline (collapses to just the button below 640px, which now navigates to
  `/#beta` instead of submitting inline) and, in a same-day follow-up, fixed
  that fallback button rendering full-width instead of sized-to-content.
- **2026-09-10** — added a root-level `LICENSE` file (canonical AGPL-3.0 v3 text,
  copied from `app/LICENSE`) — the repo went public and was pushed to GitHub this
  session with no license file at the root. Closed out D-002 (open since project
  start, gated on "decide before first public push") as decided: AGPL-3.0 for the
  whole project, with `packages/motion-engine/`'s own separate MIT license
  (`packages/motion-engine/LICENSE.md`) called out as an explicit carve-out.
  Updated `README.md`'s License section to match.
- **2026-09-10** — fixed `website/`'s own stale MCP tool counts (`161` total /
  `152` shipped / Edit `69`, was `160`/`151`/`68`) after this session added
  new tools (D-280's `editor_set_playback_rate` among them) — caught by
  `mcp-data.test.ts`'s own anti-fabrication guard, not missed silently.

- **2026-09-10** — **B-146 root-caused and partly fixed (D-290):** "playback
  lags" / "4x jumps the frames" is not the decoder. Measured live, the play
  loop costs 25.0 ms a frame and still costs 21.5 ms over a timeline gap where
  Rust decodes nothing — the ceiling is the webview. A displayed frame no
  longer costs a React render at all (the `<img>`'s `src` is written
  imperatively), pausing no longer re-decodes the frame already on screen, and
  `useCanvasClipPick` stopped re-registering its capture-phase listener every
  frame. The audio-seek warnings in the dev log measured out as a bounded
  once-per-source cost and are now guarded by a test that proves which path it
  measured. `debug_frame_timing` gained `fetch`/`tick` duration channels so the
  remaining ~19 ms can be split by subtraction. Completes an interrupted
  session's work; renumbered twice on the way in (draft D-281 → D-282, both
  meanwhile claimed by other merges) before landing on D-290.
- **2026-09-10** — **B-146 logged, investigating:** general preview playback
  lag and janky frame-jumping at 4× — dispatched to an Opus agent to profile
  before fixing; a real repeating seek-error warning in the live audio log
  passed along as a lead, not yet confirmed as the cause. (Answered by the
  entry above: it was not the cause.)
- **2026-09-10** — **B-145 logged, not fixed:** dragging a clip lands it at
  frame 0 instead of the drop position — reported live, no jsdom repro
  attempted yet.
- **2026-09-10** — the selected-gap highlight (`TimelinePane.tsx`) is now a
  glassy translucent fill (soft gradient, backdrop blur, hairline border)
  instead of a plain dashed outline, per live feedback ("this looks bad").
- **2026-09-10** — **B-142 confirmed fixed live** (the Keyboard Shortcuts
  3-column grid actually renders now) — **B-143 filed and fixed:** the
  dialog's own widening to `max-w-[80vw]` never took effect because the
  base `DialogContent` default is a `sm:`-scoped `sm:max-w-lg`, and
  `tailwind-merge` only dedupes within the same variant; confirmed against
  the live generated stylesheet, then matched the variant
  (`max-w-[80vw] sm:max-w-[80vw]`).

- **2026-09-10** — **B-142, the real fix:** the previous fix (a WebKit-quirk
  theory, merging two divs) shipped and was confirmed live still broken.
  Real cause: `app/src/styles.css`'s Tailwind `@source` list never included
  `packages/keymap/src` at all — added when D-273 created the whole
  package, so `columns-1`/`sm:columns-2`/`lg:columns-3` were inert class
  names, never real CSS. Same gap found and fixed for `packages/inspector/
  src`, not yet visibly broken there only by coincidence. Every future
  package with real UI needs its own `@source` line — nothing else
  enforces this.
- **2026-09-10** — **B-142 fixed:** D-278's new multi-column Keyboard
  Shortcuts layout never actually balanced in the real app — a WebKit-only
  quirk (this app's real renderer) where `columns-*` fails to balance when
  nested inside a separate `overflow-y-auto` ancestor, invisible to D-278's
  own jsdom tests since jsdom computes no real CSS layout at all. Fixed by
  merging the scroll and columns containers into one element.
- **2026-09-10** — **D-278: Keyboard Shortcuts window, layout redesign** —
  against the owner's Figma "Keyboard Shortcuts Collection" reference
  (`scratch/keyboard-shortcuts-figma-reference.png`), not a functionality
  change: D-273's click-to-remap/Escape-to-unassign/per-row-reset/"Restore
  Defaults" all already worked. `KeyboardShortcutsDialog.tsx`'s 9
  categories / ~62 rows now render inside a CSS multi-column flow
  (`columns-1 sm:columns-2 lg:columns-3`, each category `break-inside-avoid`)
  on a widened `max-w-5xl` dialog instead of one stacked column; sticky
  per-category headers and per-row borders are dropped (sticky fights a
  multi-column flow) for a plain underline and tighter row spacing closer to
  the reference. New `KeyboardShortcutsDialog.dom.test.tsx` (7 tests)
  re-verifies every interaction survived the layout change.
- **2026-09-10** — **B-137 fixed (D-279): a clip drag's ghost now stays under
  the pointer.** Root-caused in a real jsdom pointer drag rather than guessed
  from the one screenshot: the "pinned preview" is dnd-kit's `DragOverlay`
  clip ghost, which anchors at the dragged clip's LEFT EDGE while D-119 caps
  its width at 320px — so every clip longer than ~3.5s at the default zoom
  leaves the ghost hundreds of pixels behind the cursor. Neither the vendored
  timeline library's edge resize nor the Trim tool was involved; both are
  ruled out with evidence in the bug entry. The ghost is now a window onto the
  clip centred on the grab point, shifted to the pointer via a dnd-kit
  `Modifier`, and is a strict no-op for clips inside the cap. New
  `dragGhost.ts` + 8 pure tests + 5 real-DOM mid-drag tests. Also logged
  **B-144** (a slip/slide drag still paints the move preview it will not
  perform) — root-caused, deliberately left, reasons in the entry.
- **2026-09-10** — **D-280: a real preview PLAYBACK-RATE control on the Edit
  tab's transport** (`0.25×–8×`; `0.5/1/2/3/4` presets plus a custom field,
  next to play/pause), with `editor_set_playback_rate` as its MCP half. **Fast
  review keeps its audio and keeps its pitch** — a new WSOLA time-stretch stage
  (`crates/apelles-media/src/timestretch.rs`) scales the *mixed* preview stream
  at one seam, so a voice at 3× is still that voice rather than a chipmunk or
  silence; the choice is Premiere's own "Maintain pitch while Shuttling"
  default, researched before building. It is transport state only: no clip
  changes, nothing is persisted, nothing about an export moves — deliberately
  not the Inspector's per-clip Speed field (D-236). J/K/L shuttling is a
  separate roadmap item, since `J` needs reverse playback we do not have.
- **2026-09-10** — **B-140/D-275: retired the Edit tab's `CanvasSettingsPopover`**
  — confirmed live, minutes after D-274 shipped, as a real duplicate of the
  new docked Project Settings panel (both showing Resolution/Frame Rate at
  once), not just a hypothetical overlap. The popover, its preview-toolbar
  trigger, and its `panelRegistry.ts` panel id are gone; `@apelles/debug`'s
  real-DOM popover proof moved to `EditorExportDialog` instead.
- **2026-09-10** — **D-276: Export dialog cleanup** — dropped the per-clip
  SPEED override row (D-236's real, persisted, keyframeable Speed/Retime
  section on the clip's own Inspector is now the better, single place to set
  this — export already preferred it over the flat override anyway) and
  fixed the FPS field showing a raw, many-decimal float instead of the app's
  usual 3-decimal display. `fit`/Freeze per-clip rows are unchanged — no
  persisted equivalent exists for either yet.
- **2026-09-10** — **D-277: Project Settings form polish** — Resolution's
  preset pills are now a `Select` (matching Frame Rate/Colour Space's own
  shape), every dropdown/field in the form is consistently full-width, a
  real aspect-ratio lock (mirroring `ClipInspectorPanel`'s D-193 lock) now
  keeps Width/Height proportional while editing Custom resolution, and the
  redundant "Canvas" `CollapsibleSection` wrapper around the whole form is
  gone (the panel's own header already said the same thing).
- **2026-09-10** — **B-141 logged, not fixed:** a project's own launcher-card
  thumbnail shows the raw, un-rotated source frame rather than what the
  timeline actually composites — root-caused to `regen_thumb`'s raw
  `extract_thumb` call bypassing every clip transform and the Colorist
  grade entirely. Real fix routes it through the same composited decode the
  live preview uses; out of scope to rush alongside this session's other
  work.
- **2026-09-10** — **D-274: Project Settings docked in the Edit tab's
  Inspector column** (roadmap's "same feature, better UX"), filling
  `ClipInspectorPanel`'s own "nothing selected" empty state rather than a
  third tab. Resolution/Frame Rate/Colour Space now render through one
  shared, instant-apply `ProjectSettingsForm` (new, `packages/editor`) that
  both the new docked `ProjectSettingsPanel` and the Colorist tab's existing
  `ProjectSettingsModal.tsx` render — same underlying `chroma_project_get_
  settings`/`_set_settings` commands and their `chroma://project-settings-
  changed` broadcast, no forked state. The Colorist gear icon's modal stays
  as an entry point, now instant-apply instead of staged Save/Cancel. New
  tests: `ProjectSettingsForm.dom.test.tsx`,
  `EditorInspectorPanel.projectSettings.dom.test.tsx` (incl. a live
  single-source-of-truth proof). See D-274.

- **2026-09-10** — **D-273: one keyboard-shortcut registry for the whole app,
  plus a real Keyboard Shortcuts window.** The audit came first and found five
  independent keydown listeners and three defects: **Play/Space was bound to
  nothing at all** (B-139 — the preview's transport was click-only), Colorist's
  45 shortcuts fired in **every** tab (B-138), and the Edit tab's own keys only
  worked once the timeline had been clicked. New `@apelles/keymap` package —
  one registry, one window-level tab-scoped dispatcher, remaps persisted
  through the existing `appSettings.keybinds` (zero Rust change), and a
  shell-level settings window reachable from all three tabs. RapidRAW's own
  `keyboardUtils.ts` half-registry is absorbed, not duplicated: deleted, its 45
  rows now the `colorist`-scoped rows of the one list with ids and defaults
  unchanged so existing remaps survive. Audit + design:
  `docs/notes/keyboard-shortcuts.md`.

- **2026-09-10** — **B-134 fixed:** a dragged clip's A/V-linked partner (e.g.
  the audio half of a clip on Video 1) now tracks the drag live via a new
  ghost overlay (`TimelinePane.tsx`'s `linkDragGhosts`, same shape as the
  pre-existing `dragSyncGhosts`), instead of sitting inert until drop. The
  position math is a new pure function, `timeline.ts`'s `linkedDragGhosts`,
  with 8 real unit tests in `timeline.test.ts` — pulled out of the component
  specifically because a real-DOM proof turned out to be impossible here:
  jsdom's `<DndContext>` never resolves a real drop target at all (confirmed
  going further than `TimelinePane.marquee`/`trim.dom.test.tsx` had already
  found, by also stubbing `TrackDropZone`'s own rect — dnd-kit's
  `DragOverlay` preview node is what collision detection actually measures,
  and its page position comes from a CSS transform jsdom cannot see).

- **2026-09-10** — **B-131 fixed (D-272):** `add_clip` now refuses an explicit
  `track`+`startFrame` that lands on a span another clip already covers,
  naming the conflicting clip, instead of silently splicing into it —
  `checkAddClip` learned the occupancy question via the same "overlap
  rejected unless `ripple`" contract `move` already enforces, and all three
  MCP placement tools (`editor_add_clip`/`editor_add_text_clip`/
  `editor_add_adjustment_clip`) now run it as a real pre-flight check.

- **2026-09-10** — **B-137 logged, not fixed:** a clip edge-trim drag's own
  preview appears to stay pinned at the clip's original position instead of
  tracking the cursor (screenshot: the selected-clip box near `00:00:00`,
  the cursor visibly at `00:00:06`, mid-drag). Not yet root-caused — only
  one before/after-style screenshot exists, not a captured mid-drag
  sequence — reference saved at `scratch/b137-trim-drag-preview-static.png`.

- **2026-09-10** — **B-136, sixth and (hopefully) final attempt: static
  `cursor: none`, never changed at all.** Owner-driven research surfaced a
  real published shadcn scrubber component using `active:cursor-none` — a
  native `:active` pseudo-class, not a scripted toggle like every one of
  this bug's five prior attempts — and pointed at WebKit bug 53341's own
  title: "Changing CSS cursor style doesn't have any effect while the mouse
  is down." A value that's never changed at all, because it was already
  correct before the mouse went down, is what this landed on: the field's
  cursor is now `cursor-none` unconditionally from first render, and
  `ScrubCursorGhost` activates on hover as well as mid-scrub so there's
  never a moment with no affordance. Same research pass also caught a real,
  unrelated latent regression: an early `releasePointerCapture()` call left
  over from an abandoned cursor theory would have silently broken tracking
  for any scrub exiting the app window's actual bounds — reverted, capture
  now correctly holds for the whole gesture.

- **2026-09-10** — **B-136, finally fixed: the scrub-cursor rabbit hole, five
  rounds live with the owner.** A `document.body.style.cursor` write
  (defeated by WebKit bug 53341, which freezes the visible cursor for the
  whole duration of a held mouse button); Tauri's native `setCursorIcon`
  once per drag (same freeze — WKWebView re-asserts its own cursor on every
  native move faster than a one-time call can hold); the same native call
  re-asserted on every `pointermove` (still lost — unconditional diagnostic
  logging proved the calls were succeeding every time, ruling out
  failure/misconfig/timing all at once); a `ScrubCursorGhost` — a small icon
  that tracks the pointer as an ordinary portaled DOM element instead of
  touching any cursor API, immune to the freeze by construction —
  **confirmed genuinely working live**; and a fifth attempt at also hiding
  the real OS arrow underneath it (`cursor: none` set unconditionally on
  every press) that made things WORSE — a global-cursor-state regression
  breaking the cursor elsewhere in the app — reverted outright rather than
  chased further, since the ghost alone already fixed the actual reported
  defect. `@apelles/ui` drops the `@tauri-apps/api` dependency the native
  attempt needed (gains `react-dom` for the portal instead), and the
  now-unused `core:window:allow-set-cursor-icon` capability grant comes back
  out too. Along the way, also fixed: B-135 (undo not reaching a focused
  field until blur) and confirmed-not-bugs (the track header's lock icon,
  cropped out of two screenshots but present in the real DOM both times).

- **2026-09-10** — **Privacy Policy and Terms pages added; no cookie-consent
  banner (D-289, `website/`).** `/privacy/` and `/terms/` written from what
  the code actually does (FormSubmit as the one data processor, no
  cookies/analytics anywhere, AGPL-3.0 for the eventual software vs. these
  pages' own terms) rather than a generic template — both explicitly flagged
  as a good-faith draft needing real legal review, not a certification. No
  cookie-consent banner built: there are no cookies to consent to, and
  faking a consent flow (or adding tracking just to justify one) would be
  exactly the decoration this site's own discipline argues against. Linked
  from a new Footer "Legal" column.
- **2026-09-10** — **Stale imagery hidden, `/docs/mcp/` hidden, a real domain
  bug fixed, a real SEO pass (D-288, `website/`).** Home page's Demo section
  and the Edit room's screenshot hidden (owner's call — the captures predate
  the rename), using the same honest "not shown yet" shape Motion/Colorist
  already had; `Demo.astro` itself untouched, just not currently rendered.
  `/docs/mcp/` excluded from routing via Astro's own `_` convention, every
  link to it removed. Caught and fixed a real bug: `astro.config.mjs`'s
  `site` was still the pre-D-265 placeholder domain (`apelles.video`)
  instead of the real one the owner bought (`apelles.studio`) — every
  canonical/OG URL had been wrong since that domain purchase. Added
  `@astrojs/sitemap` + `robots.txt`, moved the OG/Twitter preview image off
  a (now-hidden) editor screenshot onto the hero painting with real
  dimensions, added a minimal JSON-LD block restating only already-tested
  facts. One genuine orphaned screenshot file (only used by the things just
  removed) caught by the test suite's own orphan-detection check and
  deleted, not papered over.

- **2026-09-10** — **Hero values baked in from the live inspector; the
  highlighter mark retired; eyebrow and two Footer paragraphs cut (D-287,
  `website/`).** Baked HeroDevPanel's final slider values into Hero.astro's
  `var(--dev-*, …)` fallbacks. Removed D-284's ochre `<mark>` highlighter
  entirely — headline is plain light ink again, legible via a darker 41%
  scrim and a two-layer text-shadow. Fixed a real, separate bug found while
  chasing "why does the text still look thin": `global.css` forces the
  large-display `opsz 72` optical cut on every h1, wrong for this
  much-smaller one — reset to let `font-optical-sizing: auto` pick the
  right cut, plus a real weight bump (300→480/440). Cut the hero's eyebrow
  line (the "never learned to edit" objection check moved to a page-title
  assertion in build-output.test.ts, since it still holds there), and two
  Footer paragraphs — the colour-citation colophon and the licence/RapidRAW
  attribution, the latter only after being shown that Footer.astro's own
  header comment flags it as a licence-compliance item and confirming the
  removal explicitly rather than treating it as routine copy trimming.
  Footer's "who Apelles was" bio replaced with two lines about the product
  instead. HeroDevPanel gained a Hide/reopen toggle.

- **2026-09-10** — **Hero's headline and signup split back into
  independently-positioned blocks (D-286, `website/`).** Live-tested
  HeroDevPanel revealed every slider moved both together (D-284 had merged
  them into one column). Split into `.headline`/`.ask`, each with its own
  top/left/width custom properties; panel now groups its nine sliders under
  Headline / Signup form / Image. Verified with a real DOM check
  (`getBoundingClientRect` before/after), not just a screenshot — moving one
  block's position leaves the other's bounding rect untouched.

- **2026-09-10** — **A dev-only live inspector for the hero's position
  values (D-285, `website/`).** `HeroDevPanel.astro` — six sliders (content
  top/left/width, image crop x/y, scrim opacity) bound to CSS custom
  properties `Hero.astro` already reads with real-value fallbacks; dragging
  one updates the page live, no rebuild. Gated by `import.meta.env.DEV`,
  confirmed absent from a real `astro build` output. Built after evaluating
  and rejecting real open-source visual editors for this stack: Onlook
  needs Next.js + Tailwind specifically (not Astro, despite an initial wrong
  answer from a search summary — corrected against its actual GitHub
  README), and Webstudio/GrapesJS are standalone builders with their own
  project format rather than tools that attach to an existing codebase's
  real source files. Owner chose to keep the site on Astro over migrating
  to Next.js for the sake of visual-editor support.

- **2026-09-10** — **The signature retires rose for ink; the hero headline
  gets a real highlighter mark (D-284, `website/`).** `--pigment-rose` is
  gone from the palette (not just unused — removed from `palette.ts`,
  `tokens.css`, the Footer's own colophon copy, and the test suite's
  "spent once" mechanism, which was rewritten rather than patched since it
  was fundamentally about colour *scarcity*, and ink is the opposite of
  scarce). `.signature` is now a solid basalt-ink fill everywhere, flipped
  light-on-dark inside Hero.astro's own dark ground via a scoped override.
  The hero headline's lines now sit on real ochre `<mark>` highlights
  (`box-decoration-break: clone`), replacing an earlier `::selection`
  override the owner had spotted by accident and liked. Also replaced the
  hero's dual-landmark absolute positioning (headline pinned to the moon,
  form pinned separately to the brush tip) with one centred column — it
  didn't read as centred in practice — and caught a real mobile bug live: a
  `flex: 1 1 10rem` written for a row layout was inflating the email input
  to hundreds of pixels tall once the mobile breakpoint switched that row to
  a column. Two dev-tooling lessons worth keeping: a browser-window resize
  doesn't reliably reflect in screenshots (switched to Chrome DevTools'
  `resize_page`, a real viewport resize, to actually catch the bug), and a
  screenshot that disagrees with the live DOM/CSS state is the thing to
  distrust first.

- **2026-09-10** — **The home page hero gets a commissioned painting, and the
  site's signature colour moves into it (D-283, `website/`).** A real
  brush-in-hand Apelles painting is now the hero's full-bleed background,
  locked to its own aspect ratio (not cropped) so the headline can sit
  centred on the painting's golden disc and the "Request beta access" form
  can land exactly at the brush tip — both measured against the real image,
  not guessed. `<Signature/>` moved from `Beta.astro`'s section up into the
  hero's own inline form (the page's one rose element, per D-264's own
  spent-once rule); `Beta.astro`'s button is now a plain marble pill. Hero
  copy trimmed (lede, facts list, "See it mid-edit" link all cut, not
  relocated). `Nav.astro` is now a floating rounded island (`position:
  fixed`) instead of a bar flush to the viewport edge, on every page.
- **2026-09-10** — **The website's beta signup is live (`website/`).** Moved
  from Formspree (50/month free cap) to FormSubmit.co (free, unlimited),
  emailing every submission to the owner's inbox. Required matching
  FormSubmit's own conventions, not Formspree's: the AJAX/JSON endpoint needs
  a `/ajax/` path segment, and its honeypot field is named `_honey`, not
  `_gotcha`. Verified end to end in a real browser against the live
  FormSubmit endpoint (not just the test suite) — real submission, real
  success state, real one-time confirmation email triggered.
- **2026-09-10** — **`website/`'s six "second ground" sections go from
  `--pigment-marble-deep` to basalt (D-282).** New `--ink-inverse(-soft)` /
  `--edge-inverse(-strong)` tokens (mixed the same way `--edge`/`--wash`
  already are, so `palette.test.ts` still passes them as documented, not
  literals). Real finding along the way: ochre reads better than terracotta
  on a dark ground (5.1:1 vs 2.9:1), so it takes over as the working
  link/emphasis colour inside these sections instead. Also caught and fixed
  an unrelated one-tool drift in `src/data/mcp.ts` (`editor_reprobe_media`,
  B-073's real fix via D-270, had never been added) while re-verifying.
- **2026-09-09** — **B-135/B-136: two more Inspector numeric-field bugs, found
  live right after B-133.** B-135 — undo (or any other external write) landed
  correctly in the store immediately, but a FOCUSED field kept showing its own
  stale typed draft until it lost focus; `useNumberField` now clears the draft
  the instant an incoming value didn't come from the field's own last edit,
  corrected during render so there's no stale-frame flash. B-136 — the
  drag-to-scrub gesture never visibly moved the cursor; the first fix assumed
  it was B-133's exact bug and applied the same technique, which the owner's
  own follow-up screenshot proved wrong — WebKit freezes the VISIBLE system
  cursor for an entire held-mouse-button gesture and won't repaint a CSS
  `cursor` write until release, no matter how it's applied. Real fix (D-271):
  Tauri's native `setCursorIcon`, which bypasses WebKit's WebView layer
  entirely — `@apelles/ui` takes a real `@tauri-apps/api` dependency for it,
  scoped to `ScrubbableNumberInput` specifically since every consumer of that
  component (not the shared, framework-agnostic scrub hooks Motion also
  reaches) already only runs inside the real Tauri window.

- **2026-09-09** — 9 freshly-shot clips imported into a new project all played
  upside-down; investigated rather than assumed a decode bug — `ffprobe` shows
  no rotation metadata on the sources at all, so the pixels are genuinely
  stored upside-down and there's nothing for Apelles to misread. Backlogged
  (`04-roadmap.md`, Later) as a real gap instead: no bulk clip-transform apply
  across a selection, so fixing N clips the same way costs N Inspector visits.

- **2026-09-09** — **four small Edit-tab UI fixes.** The timeline ruler's first
  timecode label and playhead flag sat clipped against the pane's left edge
  (`START_LEFT_PX` 20→32, the one shared constant both the ruler and every
  clip/marker/gap overlay already key off, so nothing desynced). The toolbar's
  Split/Marker/Transitions/Remove/Unlink/Link/Close Gap/Move to buttons
  dropped their visible text labels to match the icon-only tool palette
  beside them — every one of them already had a tooltip carrying the full
  name, now bolded as the tooltip's first line. **B-133** — selecting Slip/Slide
  (or arming the Alt smart-trim heuristic) never visibly changed the cursor:
  `ClipBody`'s own hardcoded `cursor-grab` class was masking the edit area's
  already-correct `trimModeCursor` style, since an element's own declared
  cursor always beats an ancestor's; fixed by writing the resolved cursor
  straight onto the specific hovered clip. Investigated but found NOT a bug:
  trackpad pinch-zoom on the preview canvas — `PreviewPane.tsx` already
  implements the identical `ctrlKey`-wheel convention the timeline uses, with
  a passing test exercising real pinch; if it's still not working live, the
  next step is confirming WKWebView actually delivers `ctrlKey: true` on a
  real trackpad pinch, not another code change.

- **2026-09-09** — **three open bugs fixed: B-073, B-097, B-101.**
  **B-073 (D-270)** — a media-pool item whose first probe failed is repairable
  again: `chroma_media_reprobe` re-probes **by id** (address translation onto
  D-260's one `refresh_media`, not a second implementation), reached from both
  the Sources panel's new "Re-probe" row action + unusable-card warning badge
  and the `editor_reprobe_media` MCP tool; `add_media` additionally heals an
  already-pooled path that never got `video` metadata, which is the recovery
  the bug was found by. Both surfaces report the outcome, never a false
  success.
  **B-097** — root cause was NOT the suspected off-by-one in `Track::clip_at`,
  which is correct: every timeline-creation site left `Timeline::rate` unset
  while `infer_settings_from_clip` had already recorded the media's real rate
  in `settings.fps`, so a project seeded from 25fps footage resolved its whole
  edit at `DEFAULT_FPS` 24. `infer_timeline_rate` now seeds the exact rational
  at both creation sites (new timelines only — no migration). The entry's own
  wrong diagnosis is corrected in place rather than dropped.
  **B-101 (D-269)** — a panned MONO clip exported 3.01 dB below what it played,
  because the exporter's `aformat` upmix is power-preserving while the live
  mixer duplicates at unity. The live mixer is the source of truth (the
  power-preserving law would have made a CENTRED mono clip diverge instead, and
  contradicts this codebase's 0 dB-centre pan law), so the probed
  `audio_channels` now rides through to the export compiler, which emits a
  unity duplicate for a source known to be mono. Verified by measuring both
  engines against each other, not by comparing formulae — including a
  measurement of the pre-fix chain proving the test can see the bug.

- **2026-09-09** — **B-132/D-268: a wedged session could permanently stop the
  app creating or opening ANY project** — found live, `new_project` answering
  `session busy` call after call with nothing in flight. `useSessionStore.busy`
  was a bare latching boolean: it had no timeout and no reset, so one `await`
  that never settled held it `true` for the life of the process and all seven
  session actions refused forever (relaunch was the only recovery); it was not
  re-entrant, so `_hydrateOpenDto` released its *caller's* lock and left the
  tail of five actions unguarded (a D-063 oversight); and it named nothing, on
  any surface — `debug_ui_state` reports the Edit tab's store, not this one,
  which is why a wedged app read as "idle". Now a real lock
  (`app/src/store/sessionLock.ts`): named holder in the refusal, re-entrancy by
  explicit hand-off with an identity-checked `release()`, and an abandoned lock
  broken after 2 minutes with a loud log naming the op. `get_state` reports
  `session.busy`/`heldBy`/`heldForMs` so an agent can see it too. The
  zustand-`persist`-rehydration theory was refuted (there is no `persist`
  middleware) — no on-disk state is corrupted and no install needs recovery.
  `app/` had no test runner at all, which is how this shipped: vitest added,
  13 tests, each verified to fail against the behaviour it pins.

- **2026-09-09** — **D-267 correction, same session: the app icon looked
  broken next to every other Dock icon, and the nav mark was still the old
  design.** The desktop icon set was regenerated from `apelles-mark-opaque.png`
  (the original render, black square intact) instead of the transparent file
  — every other app icon on the system fills its whole tile with an opaque
  background (Chrome's is white), so a transparent-cornered icon looked like
  a floating circle the moment it sat in the Dock next to one. `Nav.astro`'s
  four-tesserae SVG mark is replaced with the same `icon-192.png` the
  favicon uses — one mark image now, not two designs on the same page.
  `brand/` holds both source variants, named for which job each is for.

- **2026-09-09** — **D-267: a new photographic brand mark, converted into a
  real, properly-generated asset set** — the owner's own AI-generated medallion
  (an "A" + a marble bust profile, the same terracotta/ochre/marble palette
  D-264 already quarried from the Alexander Mosaic). Fixed the source's one
  real defect first: no alpha, a solid black square baked in behind the
  circular badge — cleared with a flood fill from the four corners only, so
  connected background comes out but nothing enclosed in the design (a hair
  shadow, an iris) is touched; verified on green and on a checkerboard, not
  assumed. The desktop app icon set (60 files: macOS/Windows/iOS/Android) was
  regenerated in one pass via this repo's own `npx tauri icon`, not hand-resized.
  The website favicon (D-264's tesserae SVG) is replaced with a real
  favicon.ico + PNG set from the same master; checked at real pixel scale
  first — legible by 48×48, soft at 16×16, shown to the owner before they
  confirmed the swap. `Nav.astro`'s separate inline mark is untouched, out of
  scope for this pass. `palette.test.ts`'s two SVG-hex-counting tests (no
  longer applicable to a photograph) are replaced with tests that check what
  IS still real: every declared favicon file exists at its real size, and
  every href Base.astro declares resolves to a file on disk. `astro build`/
  `check` clean, 190/190 tests (net +2).

- **2026-09-09** — **D-266: the last two MCP coverage gaps, one closed and one
  found to have been mis-scoped.** The media pool's four missing tools shipped
  (`editor_list_media` / `_list_media_folders` / `_create_media_folder` /
  `_move_media`), each wrapping the `useMediaPoolStore` action the Sources
  panel's own UI already calls — a "step 2 was never done" gap, with GUI parity
  verified rather than assumed. `editor_list_media` reads through to disk, not
  off the cached array whose staleness *is* B-073/B-082/B-084's mechanism, and
  marks every entry `editor_add_clip` would refuse with the cause and the fix
  in words: B-073's stuck item is now findable in one call instead of by
  hand-reading `project.json` (the bug itself is untouched and still open).
  Investigating the "audio playback — 0 tools" gap found it inferred four
  missing tools from four Tauri command names, three of which were already
  covered — there is only one transport (`editor_set_playing` drives picture
  and sound together) and `_waveform` was D-232's. What was really missing was
  the master monitor, a GUI-only control since D-126: `editor_set_audio_monitor`
  now drives the same volume/mute the transport bar's speaker button does (the
  same store lift `waveformView` got), and `editor_get_audio_level` reports what
  actually reached the output device — the agent's ears, deliberately not paired
  with a GUI meter because the measurement window is ~1 second. 159 MCP tools
  (150 shipped); `@chroma/editor` 1625/1625 with 23 new, `website` 188/188 with
  both published gap statements rewritten.

- **2026-09-09** — **D-264: `website/` rebuilt end to end for the Apelles
  rebrand** — new visual identity, new information architecture, new copy. The
  palette is quarried from the Alexander Mosaic (Carrara marble, Iberian basalt,
  iron-oxide red and yellow) per the 2025 PLOS ONE analysis of its tesserae, and
  its one imported-from-Portugal pink becomes a hard, tested design rule: the
  signature colour is spent on exactly one element per page, as the mosaicists
  spent it on one face out of roughly two million tiles. Newsreader +
  Instrument Sans + IBM Plex Mono; Inter and Space Grotesk banned in a constant
  and asserted absent. One page became four (`/`, `/who-its-for/`, `/inside/`,
  `/docs/mcp/`), and the copy now argues who the product is for — non-editors,
  against Resolve's and Premiere's built-by-editors-for-editors assumption —
  rather than listing what it has. D-255's "site palette IS the app palette"
  rule is superseded but its coverage moved, not dropped. **The anti-fabrication
  suite earned its keep on the first run**: the site was publishing 106 MCP
  tools against a server with 144, having missed the Motion room's 37-tool gap
  closing (D-257/D-259/D-260); `MOTION_GAP` is replaced by the two real
  remaining gaps. Screenshots predate the rename and still show the old wordmark
  — disclosed in the caption, never retouched (`TODO-RECAPTURE-SHOTS.md`).
  `npm run verify` clean, 186 tests, all four pages checked in a real browser.

- **2026-09-09** — **D-265: the product is renamed Chroma → Apelles**, after the
  owner bought `apelles.studio` and wanted the product to follow the domain. Not
  a find-and-replace: `chroma` is also a real colour-science word here
  (`chromatic_aberration`, `chroma_sigma_scale`, YUV chroma), a load-bearing IPC
  identifier (`chroma_*` Tauri commands span Rust ↔ frontend ↔ the capabilities
  allowlist ↔ `mcp/server.py`), and an on-disk one (`.chroma` bundles,
  `chroma.grade/N` schema ids, `~/Movies/Chroma/`). The line landed at the
  persistence boundary: **everything a human reads becomes Apelles** — the eight
  `crates/apelles-*`, the `@apelles/*` npm scope across 12 packages, the Tauri
  wrapper crate (`RapidRAW` → `apelles`, the rename D-040 had already deferred),
  `productName`/window title/wordmark/"Welcome to Apelles", the branding baked
  into exports (EXIF Software, XMP toolkit, `.cube` titles, FCPXML names), the
  MCP server identity, and all of `docs/` — while **everything already written to
  disk keeps its `chroma` identifier** until there is a real migration. Upstream
  RapidRAW's own identity is untouched on purpose: `app/` is vendored AGPL-3.0,
  so its authorship, its own module/comment history and its live
  `CyberTimon/RapidRAW-Models` URLs are a licence obligation, not branding —
  `authors` gained a name rather than losing one. Bundle id moved to
  `studio.apelles.app` (orphans local app-data; deliberate, pre-1.0). Shook out
  one real bug: the regenerated lockfile nested a second `@types/react` in
  `motion-engine`, breaking `@react-three/fiber`'s JSX augmentation (+24 `tsc`
  errors) — fixed at the root by aligning it to the React versions the workspace
  `overrides` already force, not worked around. `cargo check --workspace` green,
  566 Rust crate tests green, 2294 JS tests green, `tsc` back to its exact 64-error
  baseline. Gap: the app crate's own ~170 `chroma::*` tests could not run — the
  machine's disk was 100% full.

- **2026-09-09** — **D-263: the Edit tab's left library becomes a real activity
  bar — rail on the far left, its buttons switching the DOCKED column** — the
  owner, live, with screenshots: *"as we open this and we have text, other
  things like effects, it should be opening in this panel only as we switch —
  and this panel should be to the left of the open panel, not the other way
  around."* Both halves were real. The rail's Title/Effects/Subtitles buttons
  opened floating popovers (D-248, whose "a drag out of a popover keeps it
  open" reasoning stops applying once nothing is a popover — Sources has dragged
  media out of this very column with a plain `draggable` div since D-046), and
  the rail rendered to the RIGHT of the column it switches, which no reordering
  inside `EditorTab.tsx` could fix: Sources is shell-level (D-046/D-116) and the
  rail is tab-local (D-248). Solved with the pattern this repo already had for
  exactly that — D-251's per-tab injected node: `ShellTab` gains `libraryRail`
  and `libraryPanel`, `Root.tsx` supplies both, and `Shell.tsx` still imports
  nothing from `@apelles/editor`. The rail is now four buttons (Sources / Titles
  / Effects / Subtitles) with VS Code activity-bar semantics (switch, and
  collapse when the shown library is clicked again), built from VS Code's and
  Final Cut Pro's own docs (`scratch/activity-bar-reference/`). The caption
  style library docked too (`CaptionPanel` → `CaptionLibrary`), so D-252's
  `caption-panel` popover id retires. MCP parity checked, not assumed: every
  capability here already has its `editor_*` tool and none of them care what is
  on screen; `debug_get_ui_state` reports the new `libraryMode` so a screenshot
  of the column can still be read. 11 new real-DOM tests (7 in `@apelles/editor`,
  4 in `@apelles/shell`, the latter mounting the REAL rail + panel to pin
  "rail before column" in document order); 1596/1596 editor, 32/32 debug, 7/7
  shell green, `tsc` clean. Lands on top of D-262, whose B-129 new-track fix
  rewrote the very `addAtPlayhead` this pass moved — merged in verbatim, one
  copy, and its own DOM tests now drive the rail plus the docked panel. Found
  and written up, not fixed: **B-131**, `add_clip` has no occupancy check
  (GUI repro closed by D-262; the MCP one is open).

- **2026-09-09** — **D-261: the smart trims get a real tool palette — five icons
  in the timeline toolbar, Alt kept underneath** — the owner, live: *"for roll
  slip etc, instead of alt lets have icons for all of them :) much better."*
  Ripple/roll/slip/slide were reachable only by holding Alt and aiming at the
  right part of a clip (D-235), with every explanatory affordance appearing only
  once the key was already down (D-250) — a discoverability defect three passes
  deep. There is now a Select/Ripple/Roll/Slip/Slide icon group in
  `TimelinePane`'s toolbar (`TrimToolbar.tsx`), taken from a fresh scrape of
  Adobe's own Premiere Tools-panel help into `scratch/premiere-tools-reference/`
  — Adobe's tool set, its filled-active-chip convention, its icon-only +
  tooltip labelling, and its V/B/N/Y/U shortcuts. A chosen tool decides alone,
  ignoring position and modifiers, so a drag is deterministic; Select is a real
  default tool (Adobe's own), not an off state. The Alt heuristic is **kept**
  and strictly layered — it acts only while Select is active — so the two rules
  can never fight over one drag. MCP parity checked, not assumed: all five
  behaviours are already directly nameable per call, so this is correctly
  GUI-only. 15 new unit + 14 new real-DOM tests; the central pair proves the
  icon path and the Alt path commit the identical timeline, and D-235/D-250's
  68 tests pass unchanged.

- **2026-09-09** — **B-129 + B-130 fixed (D-262): "Add Title" now makes its own
  video track, and a title's on-canvas box is its real ink** — both live-reported
  by the owner from one screenshot and both confirmed against their real project
  first. B-129: the track-kind rule existed only in `TimelinePane`'s drop handler,
  so every other caller walked past it — a title had landed on an AUDIO track, and
  another in a gap between two shots on the footage track, where it renders over
  black. The rule moved into the op (`checkAddClip`, shaped like the existing
  `checkTransition`/`checkEditIn`), and `add_clip` gained `onNewVideoTrack` —
  a new video track at index 0, placed in ONE op so one Undo removes both. The GUI
  button and `editor_add_text_clip`/`editor_add_adjustment_clip` both default to
  it; `track` is optional now, deleting the three-call add-track/move-track dance
  the old docstring taught. B-130: `clip_geometry` reported a title's footprint as
  the whole frame — inherited from D-211's "the layer buffer is composition-sized",
  never actually decided — so a 12%-tall title got a full-frame selection box and
  swallowed every canvas click meant for the footage beneath it. It now reports the
  measured ink box, from the same glyph walk that rasterises the text
  (`text_layer_ink_fraction`); no frontend change was needed. 1564 tests in
  `@apelles/editor` (+6), 4 new Rust tests, `tsc` clean, `fmt`/`clippy` clean.

- **2026-09-09** — **D-258: Motion's first representational primitives — a Claude
  chat UI and a phone frame, deliberately decoupled** — the catalog goes from 8
  primitives to 10. `claudechat` draws the real Claude mobile app screen (header,
  user bubbles, serif assistant prose, tool chips, task/document cards, input bar,
  sunburst welcome), built from colours and structure sampled out of the owner's
  own reference screenshot rather than recalled. `deviceframe` is the phone chrome
  on its own, with a genuinely transparent glass cutout, so it frames anything —
  the two compose by agreeing on a rect (`lib/device.ts`) instead of one containing
  the other, per the owner's "separate, not attached". Multiple conversations
  animate over one scene through the EXISTING `active` step schedule, not a new
  mechanism; `registry.ts`'s `resolveActive` was redefined as a wrapper over the
  new `resolveActiveStep` so there is one implementation. Both primitives reach
  `motion_list_primitives`/`motion_add_layer` with no new MCP tool (asserted by a
  test, not assumed). Verified with real `remotion still` renders at three states
  against the reference — which caught a line-wrap over-estimate and a collapsed
  `\n` — plus a byte-identical determinism re-render. 561 tests in `@apelles/motion`
  (37 new), 2155 across all workspaces, `tsc` clean.

- **2026-09-09** — **B-061 + B-062 fixed — Motion Inspector camera-time
  label and a schema validation gap** — B-061: the camera-keyframe `at`
  field was labelled "At (frame)" while the manifest stores seconds;
  relabelled `'At (s)'` on both `CAM2D_KEY_FIELDS` and `CAM3D_KEY_FIELDS`
  (`packages/motion/src/propCatalog.ts`), paired with a new `FieldSpec.step`
  (`step: 0.1`) so a keyboard/scrub nudge no longer jumps a whole second.
  B-062: an `ease` curve's `x1`/`x2` had no validation against
  `Easing.bezier`'s own hard `[0,1]` requirement, so a hand-edited
  out-of-range value parsed fine and only crashed at render time;
  `schema.ts`'s `easeCurve` now `.refine()`s that at PARSE time (`y1`/`y2`
  stay unconstrained — `design.ease.anticipate`'s own legitimate overshoot).
  Both already fully diagnosed with a proposed fix in `docs/BUGS.md`; applied
  verbatim. New tests: `propCatalog.test.ts` (4 tests), a new `B-062` block
  in `schema.test.ts` (6 tests).

- **2026-09-09** — **B-060 fixed — ambient drift now scales with the real
  render fps, not a fixed 30 token** — both ambient-drift implementations
  (`draw.ts`'s `ambientDrift`, `Camera.tsx`'s inline camera drift) divided
  frame-by-`design.fps` (a fixed authoring-default token, `30`) instead of
  the composition's REAL fps, so the same manifest drifted at a visibly
  different perceived speed at 60fps vs 24fps than at the default 30fps.
  `ambientDrift` now takes `fps` as a parameter (the same shape as its
  neighbour `pop(frame, fps, delay)`); `Camera.tsx`'s inline expression
  became an exported, unit-tested `cameraDrift(frame, fps)` reading
  `useVideoConfig().fps`. Own commit (changes rendered pixels for any
  non-30fps manifest) with a before/after: at the same 1-second wall-clock
  instant, the old formula gave `cameraDrift`'s 24fps-render and 60fps-render
  DIFFERENT values (`{dx:1.385,dy:2.670}` vs `{dx:2.796,dy:1.648}`); the
  fixed function gives both the SAME value (`{dx:1.694,dy:2.543}`). New test:
  `ambientDrift.test.ts` (7 tests) — 536 total in `@apelles/motion`, `tsc`
  clean on both packages.

- **2026-09-09** — **D-259: Motion can finally delete and duplicate — human and
  agent halves in one commit.** `manifestEdit.ts` gains `deleteLayer`/
  `deleteScene`/`duplicateLayer`/`duplicateScene`; `LayerList.tsx` gains
  hover-revealed duplicate+delete actions on every layer AND scene row; the MCP
  surface goes **32 → 36 `motion_*` tools**. Until now nothing anywhere could
  remove a layer or a scene once added (roadmap item 6, "the top Motion gap").
  Two real findings: the existing `resolveSelections` re-resolve is **not**
  enough for a delete (it cannot see that a scene delete renumbers every later
  scene), so all four ops return the selection to install next; and only the
  SCENE delete confirms — a two-step arm-then-confirm on the button, no dialog —
  because it cascades into contained content, the same line Premiere draws.
  Deleting the last scene is refused (`scenes.min(1)`). Also corrected a stale
  roadmap item: Motion undo/redo has been live since D-155. 560 tests green
  (+41), `py_compile` clean, 36 Python names diffed identical to the 36 op keys.

- **2026-09-09** — **D-260: re-rendering a Motion scene now refreshes the Edit
  clips already placed from it** — previously a rendered file was frozen at
  render time and a placed clip kept showing it forever, with a manual re-import
  and `editor_swap_clip_media` as the only way out. Not a live embedded renderer
  (D-243's rejection of Remotion-inside-Edit stands, and the owner chose the
  lighter option explicitly): the render now writes beside its destination and
  finishes with an atomic `rename`, so nothing — the preview's live `ffmpeg`
  decoder, an export mid-read — can ever see half a video; the one thing in this
  workspace that a replaced file does *not* invalidate on its own, a live decode
  pipe, is dropped by path. Provenance is a new optional `MediaItem
  .motion_scene_id`, so the pool item (not N copies on N clips) records which
  scene made the file. A new `chroma_media_refresh` reconciles the pool with disk
  and a new `refresh_media` timeline op re-reads length and rate into every clip
  — a **no-op** when the re-render is the same length, which is the common case.
  Both interfaces: an "N in Edit" badge on the Motion scene row, and a new
  Motion tool, `motion_get_edit_links` — landing on top of D-259's delete/
  duplicate batch, the 37th `motion_*` tool overall. Proved by a frame-diff
  through the real preview compositor (red → blue with no re-import) **plus a
  negative control** that shows the same sequence leaving the clip red
  without the one call this adds. Fixes **B-127** (B-056's defect, still
  unfixed in `filmstrip.rs`'s keyframe cache) and **B-128** (a replaced
  source kept its old probe and thumbnail forever — and `Root.tsx`'s comment
  claimed the opposite).

- **2026-09-09** — **D-255: the marketing website shipped, out of sequence** —
  a new top-level `website/` (Astro, its own project, deliberately outside the
  npm workspace), reversing the standing "build the website LAST, right before
  launch" decision at the owner's explicit instruction. Its palette and type are
  a verbatim transcription of the app's own Dark theme and Poppins face, with the
  shipped `MARKER_COLORS` swatches as the only chromatic signals — and a test
  reads both real app files and fails on any drift. The hero is a working
  miniature of the Edit tab (a real draggable playhead scrubbing real
  screenshots, plus D-253's own 8px-per-step drag-to-scrub numeric fields driving
  the preview) rather than a parallax scroll. Every MCP figure is counted from
  `mcp/server.py` — 115 definitions, 9 debug-only, **106 shipped** — by a test
  that also asserts every tool name printed is real, which caught one invented
  name during the build and found `mcp/README.md`'s own heading stale (94/8/48
  vs. the real 115/9/60; corrected here). Missing things are stated on the page,
  not hidden: no Motion or Colorist screenshots exist, there is no demo video,
  and the Motion tab's 0 MCP tools is printed beside the other counts. The beta
  form is fully built against a marked placeholder endpoint and refuses to post
  until a real one is set (`website/BETA_SIGNUP_SETUP.md`). 141 tests green,
  `astro check` and `astro build` clean.

- **2026-09-09** — **D-256: a Colorist grade now actually renders on the Edit
  timeline** — previously it had literally no effect on the same clip in Edit,
  in the preview or the export. Carried across as a **baked 33³ 3D LUT**: an
  identity lattice run through the Colorist's own wgpu pipeline once per grade
  change (memoised on the grade file's mtime), then applied by the Edit CPU
  compositor and by ffmpeg's `lut3d` — so the grade keeps exactly one
  implementation (the shader) and preview/export agree by construction, which
  `apelles_types::adjustment`'s header had called structurally unreachable.
  Measured equal, not approximately: `[227,227,227]` from both engines on the
  same graded clip. Carries the **global** grade only; masks / Colorist crop /
  relight are inherently outside a 3D LUT and are dropped with a warning shown
  in the Export dialog and by the new `editor_get_grade_status` MCP tool, never
  silently. New `apelles_types::Lut3d` (L0, pure) + `chroma::grade_lut`; D-022's
  `.cube` bake refactored to share the one baker. Investigation correction
  worth knowing: the Edit↔grade link is **`Clip::id`** (D-070), not the
  `shot_id` it looks like.

- **2026-09-09** — **D-257: the Motion tab gets its real MCP surface — 32
  `motion_*` tools, closing `mcp-tool-coverage.md`'s "Gap: Motion tab — 0
  tools"** — the last tab an agent could not drive at all, despite a fully
  shipped visual builder. 18 tools wrap ops that already existed on the bridge
  (D-167→D-170) and were never exposed; **14 are new ops**, because eight
  shipped GUI gestures had nothing to wrap (add a scene, reorder layers,
  scale/rotation/opacity, retime a camera key, ease one key, edit a card,
  multi-select edits, read the selection). Split the op registry out of
  `useMotionControl`'s `useEffect` into a pure `motionOps.ts`/`createMotionOps`
  factory so it could be tested at all — 78 new tests, each mutating one
  asserting the op produces the IDENTICAL manifest the GUI's own
  `manifestEdit.ts` call does; the whole prior surface had zero. Deferred, and
  said so: delete-a-layer/scene (neither the GUI nor `manifestEdit.ts` has one —
  MCP-only would break parity from the other side).

- **2026-09-09** — **B-125: `motion_select` had silently drifted from the GUI
  gesture it mirrors**, always re-seeking to the scene start and throwing away
  the playhead — `onSelect` gained D-173's same-scene check and D-176's
  seek-to-the-layer's-own-start, the hand-copied op received neither. Found by
  D-257's new tests, which are the first this op surface has ever had.

- **2026-09-09** — **D-253: numeric fields lose the native spinner and gain
  drag-to-scrub** — finishes B-113, whose `pr-5` reserve could never have
  worked (WebKit lays the spin button out INSIDE the padding box, so padding
  moves the digits and the arrows together). Every `type="number"` in the app
  now suppresses the widget via `@apelles/ui`'s `Input`, and the field itself is
  dragged horizontally to change its value — Resolve's "virtual slider", 8px
  per declared `step`, Shift ×10 / Cmd ÷10 (Adobe's convention, not Blender's),
  4px click/drag threshold matching the timeline's own. New
  `ScrubbableNumberInput` + shared `useNumberField` hook (reached by
  `@apelles/motion` through a new `@apelles/ui/number-scrub` subpath, since it
  cannot import that barrel); migrated every real numeric field in the Edit and
  Motion Inspectors.

- **2026-09-09** — **B-124: the clip Inspector's Video/Audio tabs looked inert
  because BOTH panels painted at once, stacked** — Base UI's `Tabs.Panel` hides
  a deselected panel by unmounting it, and that unmount waits on a
  `requestAnimationFrame` a non-frontmost window never fires (this repo's own
  `previewTiming.ts` documents that throttling), so the Audio content rendered
  1076px below the fold under a Video panel that never left. Fixed with two CSS
  rules on `TabsContent` in `@apelles/ui` (`[&[inert]]:hidden` — `inert` is
  render-derived, so it is correct with no frame at all — plus
  `[&[hidden]]:hidden`, since a UA `[hidden]` rule loses to any author `display`
  utility). Found in the same pass: `data-selected:` matched nothing (Base UI
  emits `data-active`), so no tab in the app had ever shown a selected state,
  `TimelineSwitcher`'s active-timeline underline included. Proven in real
  Chromium with rAF stubbed dead; jsdom is documented as structurally unable to
  see this one.

- **2026-09-09** — **D-254: the Inspector tab bar now draws Apelles' own
  selected state, and every section seam has a real rule** — the owner's
  "doesn't look like our design system" turned out to be a control with no
  selected state at all (B-124); with that fixed, the bar moves off shadcn's
  pill onto the kit's `line` variant plus the same accent underline
  `Shell.tsx`'s Edit/Motion/Colorist switcher and `TimelineSwitcher` already
  use. All six section seams get a hairline, not just the Crop → Dynamic Zoom
  one that was screenshotted. `app/harness.html` gained a `?mode=inspector`.

- **2026-09-09** — **D-251: Export moved again, out of the Edit tab entirely,
  to `@apelles/shell`'s own chrome bar beside the tab switcher** — the owner's
  live follow-up to D-249. `ShellTab` gained a `headerAction` slot, rendered
  only while that tab is active; `Root.tsx` supplies the Edit tab's real
  `EditorExportDialog` for it, `Shell.tsx` still never imports
  `@apelles/editor`. A considered, narrow reversal of D-118's tab-agnostic
  rule for this one slot (Colorist/Motion have no export action to conflict
  with). New `packages/shell` DOM test suite (first one the package has had)
  proves the real dialog opens from the chrome bar and hides on other tabs.

- **2026-09-08** — **D-252: a generic `debug_set_popover_open(id, open)` debug op**,
  backed by one shared `openPanels` map (`useEditorTimelineStore`) and
  `@apelles/editor`'s new `panelRegistry.ts`, so an agent can open/close any
  registered Edit-tab popover/dialog by name without a working
  Accessibility/Screen-Recording permission to click it — built because the
  coordinating session needed to screenshot `CaptionPanel`'s caption-preset
  popover and hit exactly that wall. Migrated `CaptionPanel`,
  `CanvasSettingsPopover` and `EditorExportDialog` off local `useState` onto
  it; `EditLibraryRail`'s uncontrolled rail popovers and `MarkerStrip`'s
  `editingId`-keyed marker editor are found and deliberately left for a
  follow-on pass (see D-252). New real-DOM test
  (`packages/debug/src/debugOps.popover.dom.test.tsx`) proves the op opens
  the real `CaptionPanel` popover with no synthesised click.
  `@apelles/editor` 1507/1507, `@apelles/debug` 32/32, production `vite build`
  re-verified debug-only (0 occurrences of the new op name in the bundle).

- **2026-09-09** — **B-123 fixed: the whole D-235/D-250 smart trim tool
  (ripple/roll/slip/slide) was inert in the real app.** Reported live by the
  owner — "none of the roll slip etc we built works with alt key" — after both
  features shipped fully green. `TimelinePane` binds three NATIVE listeners to
  its edit-area node in `useEffect(…, [])`: D-235's capture-phase `pointerdown`
  (the tool's entire arm), B-116's ctrl-`wheel` zoom and D-128's
  `ResizeObserver`. That node sits behind two early returns — including the
  `tracks.length === 0` "Empty timeline" placeholder every NEW project starts
  in — so on the app's own startup path it does not exist when the component
  first commits; the effects ran once against `null` and never again, and the
  node then mounted carrying none of them for the rest of the session. With no
  press captured, every armed gesture resolved UNARMED and fell back to a plain
  move/trim, while the badge and cursor (React props, not effect-bound) kept
  correctly announcing "Slip"/"Roll". Every test tier missed it because all of
  them seed a populated timeline BEFORE mounting — the B-092/B-093 pattern
  again. Fixed by giving those effects a real dependency (a `useState` mirror of
  the node) while leaving the ref as the read path; a first attempt that
  replaced the ref outright was reverted after it broke 6 marquee tests and
  bailed the React Compiler. Verified in real Chromium over CDP with real
  trusted input — listener attachment read out of the browser, all four modes
  committing real ops on a timeline that started empty — plus a regression test
  that mounts in the real app's order and provably fails without the fix.
  B-116's ctrl-wheel zoom and D-128's viewport tracking were dead the same way
  and are restored by the same three lines.

- **2026-09-08** — **B-122 fixed: dragging a clip onto a track HEADER crashed
  the whole app, because two different dnd-kit droppables both called
  themselves `type: 'track'`.** Caught in the dev-server log while the owner
  was testing the B-115 drag gesture — `TypeError: undefined is not an object
  (evaluating 'dest.clips')`, unhandled inside a React event handler, taking
  the render tree and the `tauri dev` process down with it. The track HEADER is
  a droppable too (every `useSortable` item is), and it carried `{ type:
  'track', index }` while the row LANE carried `{ type: 'track', track }` — so
  a clip dropped on a header passed the discriminator check and read
  `undefined` as its destination track index. It survived review because the
  payload shapes were asserted with six separate inline `as` casts, each
  individually plausible: a cast is a promise, not a check. Fixed at the root —
  distinct `'track-header'`/`'track-lane'` discriminators, and a new
  `dndTargets.ts` that replaces every cast with a runtime-validating narrowing
  which refuses a header, a stale track index and a malformed payload alike, so
  no caller can be handed an index it must remember to bounds-check. The same
  bug existed in `onDndDragMove` (crashed mid-drag) and, mirrored, in the
  track-reorder branch (silently did nothing). 13 new unit cases, the first
  feeding in the exact payload that crashed the app.

- **2026-09-08** — **The clip Inspector is tabbed: Video and Audio, instead of
  one ~30-control scroll (D-246), and its numeric fields no longer hide their
  own digits under the spinner arrows (B-113).** Both reported live by the
  owner against a real project. The tab split is Resolve's own
  (`scratch/resolve-reference/`, the same scrape D-208/D-223/D-224 were built
  from): Transform, Crop, Dynamic Zoom, Speed, Fade and Keyframes on Video;
  Volume/Pan and the four-band EQ on Audio. Nothing moved but the container —
  same sections, same ops, same gates — and the DOM test asserts exactly that
  (the union of the two tabs is the old section set, with nothing on both). A
  clip type with no audio (a title) gets no Audio tab and no tab bar at all,
  so its Inspector is the column it always was. The tab lives in the store, so
  the human's click and the new `debug_set_inspector_tab` drive one action, not
  two. B-113 was two faults at once: WebKit paints a number input's spinner
  over its right-aligned text with no space reserved (now reserved by
  `@apelles/ui`'s `Input` for EVERY `type="number"`, not per call site), and the
  rows rendered raw dragged floats like `0.052212` into a 40px box — a resting
  field now shows a `step`-derived rounding and the exact value returns on
  focus, so nothing stored or typed changed.

- **2026-09-08** — **Edit tab, from the owner's live pass: a left library rail,
  a Title you can actually drag, a track above the top one, an anchored zoom,
  Export at the top, and a marker you can delete (D-248, D-249; B-114 to
  B-118).** Six defects reported hands-on against the real
  `perf-comparison-reel-v3` project, plus one design call the investigation
  changed: the three boxes sketched on the app's far-left edge were not a
  broken component — nothing rendered there at all — so the rail is a new
  decision, built from Resolve's own "effects library icon at the top left"
  and reusing the Colorist tab's existing icon-rail pattern. It hosts Titles,
  Effects and Subtitles, each a real HTML5 drag source (a second MIME type,
  because only `.types` is readable during `dragover`) routed through the
  media drop's own placement code, so a dragged title snaps, ripples and
  creates a track by exactly the rules a dragged source does. The timeline's
  top became the mirror of its bottom (dropping above the tracks now makes a
  new topmost one, where it used to silently land on the existing top track);
  the zoom gained an anchor it never had (the cursor for a wheel, the playhead
  for the +/- buttons); the marker LIST gained the delete that only ever
  existed behind a double-click on a 9px flag; and the header strip got the
  right-hand padding B-051/D-131 gave its left side two decisions ago. Human +
  AI in the same pass: `editor_add_track` takes an optional `index`.

- **2026-09-08** — **A pass over four things the owner hit editing live:
  B-122, B-120, B-121 and D-250.** *B-122* — "Captions from Transcript" on a
  source with no audio showed the raw `CalledProcessError` argv from the
  sidecar's ffmpeg call; `chroma_transcribe` now refuses up front through the
  same `VideoInfo::has_audio` probe the rest of the app uses, and `ai-media/`
  grew a `UserFacingError` so a predicted failure reaches the UI as its
  sentence instead of its exception class. *B-120* — a real defect behind "idk
  what is this audio waveform but it seems broken": a peaks request that
  overran the end of a file had its envelope **time-stretched** to fill the
  requested window (a tone at source seconds 1–2 drawn at 2–4), which hit every
  source shorter than one 12 s scrub tile; `envelope_over` now buckets only
  what decoded and pads the rest with silence, and the strip says *why* it is
  empty instead of drawing one flat line for silence, loading and no-source
  alike. *B-121* — the D-243 Captions panel was wired and rendering and still
  unfindable, because its button kept the old "Subtitles" label of the file
  picker it replaced. *D-250* — D-235's four trim modes are announced at the
  POINTER now (a mode badge with a gloss, plus a standard-keyword cursor swap)
  where Resolve's own copy says the signal belongs, and every clip's tooltip
  finally says the Alt/Option arm key exists at all.

- **2026-09-08** — **B-111 fixed: the audio session now re-resolves the
  timeline as it plays, so a clip starting later than the playhead when Play
  was pressed actually sounds (D-245).** The old `chroma_audio_play` built its
  source list once, from the frame Play was pressed at, and froze it for the
  whole session — on the owner's own reel, only the continuous music bed at
  frame 0 could ever be heard; the other ten scattered SFX clips never fired
  no matter how long playback ran. `run_session` now calls the same
  resolution again periodically (~every 100ms) as a `Send` closure the app
  hands it — `apelles-media` still never sees a timeline — and opens whichever
  sources are newly active, matched by a new opaque `AudioSourceSpec::clip_id`
  so nothing already playing is ever reopened. A second bug the fix had to
  get right along the way: a source opened mid-session must have its
  fade/duck/level curve evaluated from ITS OWN start time, not the whole
  session's clock, or a late-joining clip's fade could read as already over
  the instant it starts. Verified against real decoded PCM in memory (no live
  device) — deliberately not confirmed on real speakers yet, stated as the
  one open gap rather than skipped quietly.

- **2026-09-08** — **EQ response graph: Resolve's ±24 dB / log-frequency plot,
  draggable per-band points, scroll-wheel Q (D-237, roadmap item 27's last open
  half of D-224).** `EqResponseGraph.tsx` above the Inspector's four EQ band
  blocks — a numbered point per band (horizontal drag = frequency, log-scaled;
  vertical drag = gain, gain-using kinds only) plus the combined response as a
  filled/stroked curve, sampled from the existing `eqResponseDb` (never
  re-derived). Q is scroll-wheel-over-the-point, checked against Logic Pro's
  own Channel EQ convention and debounced to one commit per gesture. No new
  MCP tool — `editor_set_clip_eq` already reports `responseDb`, so the graph is
  a GUI affordance over it (D-214 precedent). 38 new tests (`eqCurve.test.ts`,
  `EqResponseGraph.dom.test.tsx`) plus 3 end-to-end wiring tests added to
  `ClipInspectorPanel.eq.dom.test.tsx`.

- **2026-09-08** — **Auto-captioning from the D-189 transcript (D-238, roadmap
  item 27).** Turns a transcript's timed words into caption cues instead of
  requiring a hand-authored `.srt` — reuses D-229's `import_subtitles` op
  verbatim (no new track kind, no new `Clip` field), with a segment-boundary-
  aware word/duration/pause grouping heuristic as the only new logic
  (`packages/editor/src/captionsFromTranscript.ts`). GUI: a "Captions from
  Transcript" button beside the Subtitles importer, operating on the selected
  clip. MCP: `editor_generate_captions_from_transcript`.

- **2026-09-08** — **The seven edit types on drop (D-239, roadmap item 27).**
  Dragging a Sources item now raises Blackmagic's own edit overlay over the
  preview — Insert / Overwrite / Replace / Fit to Fill / Place on Top / Append
  at End / Ripple Overwrite as seven labelled targets, built from the
  `timeline.jpg` screenshot the roadmap line itself names. All seven are ONE
  atomic `edit_in` `EditOp` (one undo, named for the type), not a client-side
  sequence — the D-129 precedent. The audit found only Append genuinely free
  and Insert nearly so; Overwrite needed real window-clearing, and Fit to Fill
  needed no new retiming concept at all, just a flat D-236 speed ramp at the
  closed-form fitting speed. Replace is deliberately distinct from D-195's
  `swap_media`. The timeline's own positional drop is untouched. MCP:
  `editor_edit_in`, sharing `checkEditIn` with the overlay so a greyed row, a
  tool error and a refused op can never disagree. Fixed a latent track-index
  remap bug in `timelineStore` (a new track at index 0 renumbers everything
  below it) and a real counting bug in `docs/notes/mcp-tool-coverage.md`.

- **2026-09-08** — **Italic/bold caption/title rendering (D-240, roadmap item
  27).** `chroma::text`'s catalogue gained italic/bold-italic faces for every
  family that has them on macOS (sans/condensed/serif/mono) — no new font, the
  same system families D-212 already references. Bold/Italic toggle buttons
  landed in both the Title and Caption Inspectors, plus matching `bold`/
  `italic` params on the four MCP tools that already set `font`; both compose
  the right flat catalogue key through one shared `composeFontStyleKey`, so
  neither `TextLayer` nor `CaptionStyle` grew a new stored field. Export
  parity measured (not assumed): `ab_glyph` vs. real `drawtext` ink widths
  agree within 1.5% for the new faces.

- **2026-09-08** — **Reverse speed, and the live preview's audio finally
  retimes (D-241, D-242 — D-236's two named speed-ramp follow-ups).** A clip, or
  any single run of a ramp, can now play BACKWARDS: a negative percentage in the
  Inspector or a per-run **Reverse** button (both references spell it that way),
  and negatives on `editor_set_clip_speed`. It needed no schema change — a
  reversed run occupies exactly the output its forward twin would, so a sign
  flip never moves a neighbouring clip — but it did need a different filtergraph
  *shape*: `trim`/`reverse`/`concat` per run and `areverse`+`atempo=|s|` for the
  sound, because a negative `setpts` slope is a graph ffmpeg happily runs and
  which reverses nothing. The "backwards preview decode" D-236 flagged as
  blocking turned out not to exist — `decode_pipe` already handles a backward
  step. Separately, the live mixer now retimes its audio through the same ramp
  the picture uses, closing D-236's stated asymmetry: a 2x clip's preview sound
  was 1.9 s adrift from its picture and is now within 50 µs. It varispeeds
  (pitch moves with speed, like tape and like Premiere's default) where the
  export preserves pitch — deliberate, and stated in the MCP tool's own
  docstring. Verified against real decoded pixels and real decoded audio, both
  with negative controls. Also fixed, in passing and never reachable before:
  fade windows are now measured in PLAYBACK order, which a reversed clip needs
  and which is algebraically identical for every forward ramp.

- **2026-09-08** — **A real Captions panel + animated caption presets
  (D-243/D-244, roadmap item 28).** "Subtitles" now opens a panel instead of a
  file picker: a **Styles** library of caption looks, each tile a live
  thumbnail of its own style, that drop onto the timeline in one click, plus an
  **Import** tab carrying D-229's `.srt`/`.vtt` flow verbatim. Captions can now
  ANIMATE per word — highlight, karaoke, kinetic slam and word build — rendered
  identically by the Rust preview and the ffmpeg export, with every knob
  editable in the Inspector because a preset is pure data, not a baked-in look.
  The architecture question the roadmap raised is answered and closed in D-243:
  **native `CaptionStyle` extension, not a Motion manifest**, because the
  Motion engine has no render-to-file path at all and neither Edit renderer is
  a browser. 8 presets shipped, 11 more named individually with their real
  blockers; looks adapted from HyperFrames' catalogue (Apache-2.0, D-244) as
  design only — no third-party code ships here. Verified with 5 real-ffmpeg
  pixel tests that prove the export actually animates.

- **2026-09-08** — **Context-sensitive trim: ripple / roll / slip / slide from
  one gesture (D-235, roadmap item 27).** Hold Alt/Option over the timeline and
  the same drag becomes a different edit depending on where you point — an edge
  that touches a neighbour rolls the cut, a free edge ripples, the upper half of
  a clip slips its source window, the lower half slides it between its
  neighbours (Shift forces a ripple at an edit point). Taken from Blackmagic's
  own smart-trim copy and the four cursors in
  `scratch/resolve-reference/trim.jpg`, cross-checked against Final Cut's and
  Premiere's own help; the toolbar names the mode while armed, since Apelles
  can't swap cursors. Unarmed gestures are untouched — a body drag is still a
  move, an edge drag still the plain gap-leaving trim. The audit behind it found
  `slip` had shipped as an MCP tool with **no** human gesture (D-195), the
  human-AND-AI gap from the AI side; ripple trim is the existing
  `trim_start`/`trim_end` with a `ripple` flag reusing the one ripple-shift
  primitive, and only `roll`/`slide` are new ops. Both edge- and body-drag
  decisions were extracted to pure functions after finding the timeline
  library's interact.js resize does not run under jsdom at all. MCP:
  `editor_roll_edit`, `editor_slide_clip`, and `ripple` on `editor_trim_clip`.
  Harness fixes on the way: `altKey`, real `pageX`/`pageY`, and a
  `getBoundingClientRect` stub so the slip/slide band is a real test.

- **2026-09-08** — **Speed ramps: variable speed over time, previewed and
  exported from one definition (D-236, roadmap item 27).** A clip now carries
  `speed_points` — "from this SOURCE frame onward, play at this speed" — so the
  speed profile is a step function and the time remap is exactly piecewise
  linear. That shape is chosen, not incidental: it is the only one the live
  preview (closed-form Rust), the export's picture (an ffmpeg `setpts`
  expression) and the export's sound can all express, and the sound is what
  decides it — `atempo` takes a number rather than an expression, so a ramped
  clip's audio is per-segment `atrim`/`atempo`/`concat` and a smoothly-varying
  speed would have had no matching audio at all. The pre-existing export-time
  `speedOverrides` is **generalised, not duplicated**: a flat speed is a
  one-segment ramp, resolved through the same function, still compiling the
  byte-identical filtergraph. Both interfaces in the same pass — an Inspector
  **Speed** section (per-run percentage, add a point at the playhead, a Retime
  Curve readout, modelled on Resolve's own Retime Controls read out of
  `scratch/resolve-reference/create.jpg`) and `editor_set_clip_speed`. Because
  this is the B-090/B-094/B-095/B-098/B-103/B-108 risk squared — it animates
  time itself, so a wrong ramp still renders a smooth, plausible, wrong video —
  the parity proof is real decoded pixels: a fixture whose every frame is a
  distinct grey, exported through a `0.5x → 2x → 1.25x` ramp and read back frame
  by frame, agrees with the preview's own resolver on 78 of 84 frames exactly
  and the rest by one, against up to 18 frames out for a deliberately wrong
  ramp. Found and fixed **B-112** on the way: the export divided a sped clip's
  length by its speed but not its fade windows, so the picture faded for
  `speed`× longer than its own sound. Deliberately not built, all named on the
  roadmap: reverse speed, smoothed S-curve transitions, on-clip point dragging,
  frame interpolation, and live-preview audio retiming.

- **2026-09-08** — **Dynamic zoom: drag two boxes in the viewer instead of
  keying by hand (D-234, roadmap item 27).** Arm it from the Inspector and the
  preview shows a green START box and a dashed red END box over the selected
  clip — Resolve's own convention, read off its own Edit-page copy in
  `scratch/resolve-reference/`. Drag either one and the clip's
  `position_x`/`position_y`/`scale` keyframes are written across its whole
  length, plus a Swap button and the four `EASE_PRESETS` eases (renamed from
  `FADE_PRESETS`/`FadeCurve` when this merged alongside D-233, which folded the
  fade-curve vocabulary into one shared `EaseCurve` type — see that merge's own
  reconciliation). The load-bearing
  call is that it **bakes ordinary keyframes** rather than adding a persistent
  dynamic-zoom stage the way Resolve does: no new `Clip` field, no renderer
  change on either side, so preview/export agreement, undo, the Inspector's
  diamonds and the coming curve editor all work on it for free — pinned by a
  test asserting the baked list is byte-identical to the hand-authored
  equivalent. One deliberate divergence, argued in D-234: the boxes are the
  clip's LAYER FOOTPRINT (bigger = more zoomed in), not Resolve's inverse
  framing rect, so "the box" means one thing everywhere in the viewer. A
  non-linear ease is baked as 20 sampled segments because the keyframe model has
  no per-key easing on either side of the wire. Replaces (never interleaves
  with) existing position/scale keys and says so before the drag; every other
  animated property is left alone. `TransformBox` extracted so the single
  transform box and this pair are one component, not two that drift. MCP:
  `editor_set_dynamic_zoom`, running the same math and the same op as the drag.
- **2026-09-08** — **Two owner-reported audio bugs, and the reason neither could
  be seen.** **B-109:** the app's logger has never written a byte — every
  `app.log` on the machine was 0 bytes, across six bundle identifiers and a
  week of builds, because `tauri-plugin-wdio` (registered unconditionally by
  D-104) takes `log::set_boxed_logger` from its plugin `setup`, which Tauri runs
  before this crate's own `.setup()`, so `fern`'s `apply()` always lost the
  race. That silently disabled the entire audio subsystem's only diagnostics,
  including the D-049 rms/peak verification hook. `run()` now claims the global
  slot first with a forwarding `DeferredLogger`, and `setup_logging` drops the
  real `fern` chain in behind it once `app_log_dir()` is resolvable; verified in
  the real app (0 bytes → real `[INFO]`/`[WARN]` lines, several of which the app
  had been reporting into the void). **B-110:** a tape scrub monitored every
  source at unity — `scrubSourceAt` read `Track::gain` only to skip a fully
  muted track and then threw the value away, and never consulted `Clip::volume`
  at all — so a music bed faded to 0.4 was heard ~8 dB hot under the playhead
  versus in playback ("it plays the audio which is not the right one"). The
  resolved source now carries `track.gain × clip.volume` through both scrub
  commands into `run_scrub`'s per-grain `apply_gain`, and `editor_get_waveform`
  reports it so an agent, which cannot hear a hot monitor, gets the number.
  **B-111 filed, open:** "the first play has no audio, stop and play fixes it"
  is *not* a D-232 regression and not a transport-ordering race — both were
  ruled out with real-DOM and live-app evidence (a real click on Play issues one
  `chroma_audio_play` and no scrub; the first play in a fresh process measures
  `rms=0.0883`). It is that `chroma_audio_play` resolves its sources **once**,
  at the frame Play was pressed, and never again: on the owner's own reel that
  is 1 source out of 11 audio clips, so every SFX that starts later is silent
  for the whole session, and a play started in the reel's 40-second audio gap
  opens no device at all. Root cause confirmed and the fix scoped in B-111; not
  built here, because its only honest verification is an audible one and the
  machine had to stay quiet.

- **2026-09-08** — **Tape-style audio scrubbing + the viewer waveform strip
  (D-232, roadmap item 27).** Dragging the playhead — on the timeline cursor or
  the player's position bar — now makes sound: a new `apelles_media::scrub`
  emits a short enveloped grain from wherever the pointer is, ~17×/second, out
  of a decoded window it only re-anchors when you leave it. The load-bearing
  call is that scrub is a **third request on the existing single audio
  transport**, not a parallel engine, so "a scrub stops playback" and "Play
  stops a scrub" fall out of the D-130 ordering protocol with no new invariant
  (and the frontend's request stamp moved to a shared `audioTransport.ts`,
  because two counters feeding one high-water mark is not two orderings).
  Constant-pitch granular scrub, not varispeed — argued, with the reference
  behaviour cited. The waveform half is a full-width strip between the picture
  and the position bar (read off `scratch/resolve-reference/scrubbing.jpg`),
  showing a 4 s window centred on the playhead, fetched in **snapped tiles** so
  a moving playhead does not re-miss D-128's cache on every frame. MCP:
  `editor_set_waveform_view` + `editor_get_waveform`; deliberately **no**
  `editor_scrub` — an agent cannot hear, so it gets the envelope as numbers
  instead (D-232 §5). Verified to real `cpal` output on real media
  (`rms=0.0807 peak=0.3783`); what it *sounds* like still needs a human ear.
  Detail: `docs/notes/audio-fade-duck-crossfade-plan.md` §11. **Found and fixed
  on the way: B-106** — the three live-device playback tests read a
  once-per-second meter after 1.5 s, so they could fail for having nothing to
  read rather than nothing to hear.
- **2026-09-08** — **Timeline curve editor: real bezier ease curves on any keyframed
  property (D-233, roadmap 27).** Keyframe segments were all linear — the biggest
  reason a generated move looks generated. Each segment now carries an optional
  cubic-bezier `ease`, authored by dragging its two control points in a resizable
  lane docked under the timeline (built from Resolve's own `curve.jpg`), by four
  preset buttons, from the Inspector's per-property curve button, or over MCP
  (`editor_set_keyframe_ease` + `editor_set_curve_editor`; 102 → 104 tools). Not a
  new curve concept: D-147's `FadeCurve` became `EaseCurve` in its own
  `apelles_types::ease` module and is now shared by fades and keyframes, one solver
  across both languages. Absent `ease` = linear, so existing projects resolve
  bit-identically and export byte-identically. Preview and export agree exactly at
  every authored key and by a measured 1.4e-3 between them, proven by a real-ffmpeg
  pixel test that was checked to fail when the curve is dropped. Two bugs found on
  the way: **B-108** (open) — the export spins a seam-crossing `rotation` the long
  way round while the preview takes the short arc; **B-107** (fixed here) —
  `chroma::audio`'s tests guarded the process-global open project with a mutex of
  their own instead of the shared `PROJECT_STATE_LOCK`, so they cleared it out from
  under `chroma::edit`'s adjustment-preview tests. Two locks over one global is not
  mutual exclusion; B-105 fixed the same shape one file over.
- **2026-09-08** — **Docs reconciliation, round 2 (D-231).** Docs-only. The product
  docs had drifted on *feature status*, not framing: `01-prd.md` still called Edit a
  single-track MVP and Motion a placeholder tab, `02-scope.md` listed shipped features
  as out-of-scope, and `03-architecture.md` said 3 crates existed (8 do) and 38 MCP
  tools (95 do). All re-derived from the code — tool counts parsed from `mcp/server.py`,
  primitives from the engine's `zod` enum (8, not 7), crate status from
  `crates/*/README.md`. `CLAUDE.md`'s own drift note was itself wrong on both files it
  named and is rewritten to say what is actually still stale. Two real gaps surfaced and
  documented, not fixed: Motion has **0 MCP tools** despite 18 working `motion_*` bridge
  ops (D-167–D-171 never got their Python wrappers), and Edit's media understanding is
  MCP-only with no GUI consumer.
- **2026-09-08** — **Fix B-104: the on-canvas transform box detached from the
  picture and drifted worse the longer playback ran (D-228).** Owner-reported
  on a real macOS screen recording — a genuinely variable-frame-rate source.
  Root cause was not the probe but three decoders each meaning something
  different by "source frame N": the model says *the picture at `N/source_fps`
  seconds*, while `decode_pipe` and the exporter counted **coded** frames after
  a single seek, which on VFR footage walks away from the model without bound
  (measured up to **4.07 s**, ≈180 frames, on the owner's own clip) and resets
  only on a scrub. New `apelles_media::conform` states the invariant once and
  builds the ffmpeg arguments for it (`fps=…:start_time=0:round=up` under
  `-copyts`, `-noaccurate_seek`); the pipe, `decode_frame`, the thumbnail strip
  and `export::spawn_decoder` all go through it. No transcode, no proxy, no
  schema change, no migration — and free on CFR footage (2.51 → 2.50 ms/frame
  measured). Verified against the owner's real file with an `ffprobe`-PTS
  oracle, plus 6 new tests on a synthesized VFR fixture (3 confirmed failing
  pre-fix) and 8 on the argument construction.
- **2026-09-08** — **Subtitles / captions (D-229, roadmap 27).** `.srt`/`.vtt`
  import as a real `TrackKind::Subtitle` track, per-track style with a per-cue
  "use track style" override, an Inspector section with a CPS cue list, sidecar
  `.srt`/`.vtt` export, and 5 `editor_*` MCP tools. A track kind rather than a
  clip variant — deliberately the opposite call from D-211's title, because a
  caption composites over the finished picture whatever its track index and its
  style belongs to the track. **Multi-line cues** (which D-211 had to forbid for
  titles) render identically in the live preview and the export because the line
  layout is ours, not either engine's: one `drawtext` per line at `y_align=font`,
  whose content-independence and `hhea`-derived box were measured against ffmpeg
  7.1 across four faces before being built on. Proven by a real-ffmpeg pixel test
  (the box lands at exactly `line_top − box_padding`; two lines stack exactly one
  `line_step` apart). **TTML is deliberately refused, not half-built** — its
  timings depend on `ttp:timeBase`/`ttp:frameRate`, and a subset parser would
  import real broadcast files with silently wrong times.
- **2026-09-08** — **Fix B-105: a test-suite race over the process-global
  `current_video()`.** `chroma::state`'s thumb-cache test set a current video
  and never restored it; `chroma::relight`'s "no video loaded" test asserts the
  opposite, so whichever ran first decided the result. Latent for as long as
  both existed — D-230's slower, real-ffmpeg preview tests just widened the
  window enough to make it deterministic. Both halves fixed (the mutator takes
  `PROJECT_STATE_LOCK` and restores the baseline; the dependent test asserts its
  own precondition). `cargo test -p apelles --lib` is now 189 passed / 1 failed
  across three runs, that one being the documented pre-existing B-097.
- **2026-09-08** — **Adjustment clips (D-230, roadmap 27).** A clip that
  contributes no picture of its own and instead applies one colour correction
  to every clip composited *beneath* it, for the span it covers. The
  compositing model is the new part: both renderers already paint
  back-to-front, so the canvas in hand when the walk reaches the adjustment
  layer *is* "every layer below it" — the whole scoping rule falls out of the
  existing z-order rather than being implemented. The effect is a
  five-parameter primary correction, **not** the Colorist grade: that blob is
  untyped in Rust (D-020/D-025) and wgpu-shader-only, so the ffmpeg export
  could never have reproduced it — a guaranteed preview/export divergence of
  the B-090/B-095/B-098 class. One shared operator
  (`apelles_types::adjustment`) feeds both engines, compiled to `lutrgb` +
  `colorchannelmixer`; a single folded matrix was tried and rejected (it
  breaches ffmpeg's ±2 coefficient cap at ordinary settings), and `geq`
  measured ~39× slower. Preview vs. export agree to ≤ 1/255, proved by a
  matched pair of real-pixel suites. Toolbar button, on-timeline body and
  Inspector built from `scratch/resolve-reference/adjustments.jpg`;
  `editor_add_adjustment_clip` / `editor_set_adjustment_clip` in the same
  pass. Detail: `docs/notes/adjustment-clips.md`.
- **2026-09-08** — **Fix B-102: total silence during live preview playback.**
  `symphonia` was never built with MP3 decode support (`isomp4`/`aac`/`alac`/
  `aiff` were explicitly enabled; `mp3` — the one common format symphonia keeps
  OUT of its own defaults — was not), so every `.mp3` audio-track clip failed
  to open and the failure was swallowed on a background thread with no error
  surfaced anywhere. Found live against the owner's real project (4 audio
  tracks, all `.mp3`). Added `"mp3"` to symphonia's feature list in both
  `app/src-tauri/Cargo.toml` and `crates/apelles-media/Cargo.toml`; verified
  end-to-end against the real project's own `music.mp3` (real non-silent PCM
  out of the actual `cpal` device, `peak=1.0267`).
- **2026-09-08** — **Per-clip parametric EQ (D-224, roadmap 27).** A clip now
  carries its own multi-band EQ — `Clip::eq_bands`, five real shapes (low/high
  shelf, bell, high/low pass) with frequency/gain/Q per band, and Resolve's own
  four-band strip in a new Inspector "EQ" section, built from its own
  screenshot. The filters are real Audio EQ Cookbook biquads
  (`apelles_types::eq`), applied per channel with state that survives a chunk
  boundary in the live mixer, and compiled to ffmpeg's GENERIC `biquad` filter
  fed the same coefficients in the export — because its own `bass`/`treble`
  measurably do not implement the cookbook's Q (0.25-0.37 dB off, identified
  from their impulse response), so agreement is structural rather than hoped
  for. Applied before the volume/fade/duck gain stages in both engines, an
  order that genuinely matters because a biquad is time-invariant and a fade is
  not. **Static, not keyframeable**, and that is the stated decision rather
  than a gap: ffmpeg's biquad filters parse their parameters once, so an
  animated EQ cannot be rendered at all. `editor_set_clip_eq` returns the
  resulting curve, not just what it stored. Proved by a real frequency response
  measured in BOTH engines against one shared table — a real sine through the
  real mixer, and real ffmpeg output read with `volumedetect`. The response
  CURVE UI is explicitly deferred (roadmap 27), not half-built.
- **2026-09-08** — **Transitions library (D-226 + D-227, roadmap 27).** A
  transition **bridges** an edit point: the two clips stay abutting and never
  overlap, and it reads their handle media instead — D-226 weighs that against
  real clip overlap (Premiere's shape) and records why the bridging model
  composes with this codebase's own resolution/decode/landing machinery while
  the other fights it. Two types: a cross dissolve (both clips visible at once,
  needs handles) and a dip to colour (a generated plate, needs none, so it
  always works) — the pair that proves both mechanisms. Real live-preview
  compositing (a second decode slot per track, `PipeSlot::TrackTransition`),
  real ffmpeg export via `fade=alpha=1` rather than `xfade` (which
  concatenates, a different compiler shape entirely), a drag-onto-the-cut
  palette with an on-track badge and its own popover, and four
  `editor_*_transition` MCP tools. Proved by real decoded pixels on **both**
  engines — a mid-dissolve preview frame measured `[125, 0, 126]` for a
  red↔blue blend against `[255,0,0]`/`[0,0,255]` for a hard cut, and the export
  sampled at 0/25/50/75/100% of the same window. **Found and fixed on the way:
  B-103** — the export compiler had never placed a clip in TIME at all
  (`overlay` pairs inputs by timestamp; only the audio half ever had its
  `adelay`), so every clip at `start_frame > 0` exported its last frame frozen.
  Design detail: `docs/notes/transitions.md`.
- **2026-09-08** — **Per-clip audio: volume + pan (D-223, roadmap 27).** A clip
  now carries its OWN level and stereo position, independent of its track's
  fader — `Clip::volume` (linear, matching `Track::gain`'s unit) and
  `Clip::pan` (constant-power law at a 0 dB centre, `apelles_types::pan`), both
  keyframeable through the machinery D-208/D-220 already built. Composed as
  `track.gain × clip.volume × fade × duck`, then split per channel, identically
  in the live mixer (a third envelope in the same per-sample-frame pass) and in
  the ffmpeg export (a `channelsplit`/`join` fork, the law written as a real
  per-frame expression since ffmpeg's own `pan` filter cannot take one). New
  Inspector "Audio" section + `editor_set_clip_audio`. Proved by real
  per-channel `volumedetect` measurement of real exported files — a whole-file
  measurement cannot tell a pan from an attenuation. One measured divergence
  filed, not papered over: **B-101**, a panned MONO clip exports 3 dB below
  what it plays. Unblocks roadmap 27's per-clip EQ item.
- **2026-09-08** — **Timeline markers (D-222, roadmap 27).** Colour-coded,
  titled flags pinned to a timeline frame, on their own strip between the
  ruler's ticks and track 0 — Resolve's own placement, built from its own
  screenshot. They live on the `Timeline`, not on a `Clip`, so one survives
  the clip beneath it being trimmed, moved or deleted; they are real
  `EditOp`s (`add_marker`/`remove_marker`/`set_marker`), so unlike D-216's
  selection and D-218's preview zoom they persist into `project.json` and
  undo with ⌘Z. Click a flag to jump, double-click to rename/recolour/delete,
  `M` or the toolbar button to add at the playhead, a dropdown to jump
  between them — plus `editor_add_marker`/`_list_markers`/`_set_marker`/
  `_remove_marker` driving the same three ops. Adds `Textarea` to
  `@apelles/ui`.
- **2026-09-08** — **Pre-launch plan extended: Windows port + general Python-
  sidecar hosting** (`docs/notes/pre-launch-plan.md`, items 5-6). Direct
  codebase survey found the Windows gap narrower than expected: the Rust
  compositor (`wgpu`) and most AI features (ONNX Runtime, plus the relight
  sidecar's own already-real `mps`/`cuda`/`cpu` device selection) are already
  cross-platform, with Windows dylib paths and NSIS packaging already wired.
  The real gaps are the `ai-media/` sidecar (`mlx-vlm`/`mlx-whisper`, hard
  Apple-Silicon-only) and `mlx-audiocraft` — named Windows replacements for
  both (`faster-whisper`; the same Qwen3-VL model via `transformers`+
  BitsAndBytes or GGUF). Confirmed: don't cross-compile Windows from this Mac
  (Tauri's own docs call it unreliable) — GitHub Actions `windows-latest` is
  the standard practice. For general (non-GPU) Python-service hosting:
  Railway to start, Google Cloud Run if GPU becomes a near-term need (its GPU
  support went GA in 2026 with sub-5s cold start) — also found Fly.io's own
  GPU offering was deprecated August 1, 2026.
- **2026-09-08** — **Pre-launch plan researched: fal.ai media-gen, a lightweight
  accounts/credits/payment backend, an opt-in cloud GPU fallback for the
  existing local AI sidecars, and the website** (`docs/notes/pre-launch-plan.md`).
  Owner's own sequencing: build these LAST, after the Resolve-parity backlog,
  not now. Nothing built — real provider research only (fal.ai's queue+webhook
  API and pricing; Supabase+Stripe as the concrete backend stack, with real
  Tauri-desktop OAuth precedent; RunPod/Modal/Replicate/Baseten for GPU
  hosting, including a real, specific blocker — `mlx-audiocraft` needs a
  separate CUDA-native build for the cloud path, since Metal has no container
  GPU passthrough). Surfaced the one thing to resolve before starting the
  backend or the cloud sidecar: `D-002`'s own licensing question (AGPL "blocks
  a closed SaaS") was already flagged unresolved and is now directly load-bearing
  for two of these four items.
- **2026-09-08** — **`PropertyRow` extracted to its own file (D-220,
  roadmap 27)** — the reusable Inspector row (label/field/keyframe-diamond/
  nav/reset) several upcoming features (per-clip audio pan/volume, EQ) will
  need, generalised over the param-name type rather than pinned to
  `ClipTransformParam`. Deliberately NOT a cross-tab unification with
  Motion's/Colorist's own Inspector panels — D-103 already settled that
  question. Also added roadmap item 27, the durable Resolve-parity backlog
  (the session tracker artifact isn't a substitute for this).
- **2026-09-08** — **The debug-tooling loop closes: an agent can now open a
  panel, photograph it, and read the DOM behind the pixels (D-219).**
  `docs/notes/debug-tooling.md` pieces 2, 4 and 5 built, piece 3 found already
  complete in D-210 and left alone. Six new MCP tools in a new `@apelles/debug`
  package: `debug_ui_state`, `debug_set_active_tab`, `debug_set_sources_panel`,
  `debug_set_editor_inspector` (each calling the *same* store action the human's
  own button calls — explicit named ops, never a generic backdoor or a
  synthesised click), `debug_dom_tree` (bounded three ways, every bound reports
  itself) and `debug_frame_timing` (the webview-side smoothness measurement
  D-217 needed and could not take). Forced one honest refactor: the Edit
  Inspector's open/closed flag moved out of `EditorTab.tsx`'s `useState` into
  the store, so there is one piece of state under both interfaces.
- **2026-09-08** — **B-100 fixed: the debug screenshot tool had been shipping
  ungated.** Found while reading D-210 as the reference pattern —
  `chroma_debug_screenshot`/`chroma_debug_sample_pixel` had no
  `#[cfg(debug_assertions)]` anywhere, so a release build contained the whole
  webview-capture path, against this project's own "debug tooling is never
  shipped" invariant. Gated properly (module, both commands inside
  `generate_handler!`, `control.rs`'s `native_op`, and the Cmd/Ctrl+Shift+D
  hook), and the gate is now *verified* rather than asserted: a real production
  `vite build` contains zero occurrences of any debug op name.
- **2026-09-08** — **The preview canvas can be zoomed and panned (D-218,
  roadmap 25).** Owner, live: *"i should be able to zoom in the canvas also."*
  A `−  100%  +` cluster shaped exactly like the timeline's own (same icons,
  same step, same ctrl/pinch-wheel split; the readout doubles as reset-to-fit),
  25%–800%, `editor_set_preview_zoom` + `editor_get_state.previewZoom` in the
  same pass. Zoom is a mathematical transform of the `useContentBox` rect, not
  `overflow: auto` scrolling — chosen so the three on-canvas surfaces
  (`TransformOverlay`, `useCanvasClipPick`, `CanvasBoundary`) need no change to
  their coordinate math AND stay provable in jsdom: 46 new tests, including
  click-to-select and both drag gestures proven correct at 200%-and-panned, plus
  a real-Chromium pass with real hit-testing. 100% means fit, not 1:1 — the
  preview is a capped proxy; D-218 says why. **B-099 fixed on the way**: D-217
  had left `app/src/harness-main.tsx` calling `atob` on a string that still
  carried its `data:` prefix, so the real-browser harness threw at module load
  and mounted nothing — that verification tier had been silently dead since.
- **2026-09-08** — **B-098 fixed: `editor_export` now animates keyframed crop
  insets too.** The last of the nine keyframeable transform properties to
  reach the export compiler — all nine now animate identically in the
  preview and the export. Corrected this bug's own original fix guidance
  along the way: it assumed `crop` needed the same `eval=frame` flag `scale`
  does (B-090's trap), but checked empirically instead of assumed, `crop`
  has no `eval` option at all — its `w`/`h`/`x`/`y` are simply always
  evaluated per frame. One new real-ffmpeg pixel test.
- **2026-09-08** — **The Edit-tab preview's real bottleneck, profiled then
  fixed (D-217, roadmap 25).** The standing theory — base64 in
  `chroma_timeline_frame`'s `data:` URL — was measured and is **wrong**:
  0.01 ms of a 42.7 ms frame. 87% of it was decode + composite, and inside
  that, `image::imageops::resize` at 16-19 ms *per layer*, enlarging each layer
  to its whole on-canvas footprint so `overlay` could throw two thirds of it
  away. `blend_layer_sampled` now samples an unrotated, magnified layer
  straight onto the canvas over the visible rect only: **42.7 → 14.0 ms/frame**
  (~23 → ~71 fps) on the owner's own reel, pixel-equivalent within ±1 per
  channel against the path it replaced. The IPC payload went binary
  (`ArrayBuffer` + `Blob` object URL) in the same pass — cheaper on the webview
  side, but recorded as not having been the bottleneck.
- **2026-09-08** — **Text/title clips (roadmap 24c): `TransformOverlay` hides
  the corner (scale) handles for a text clip, keeps the move drag.** The box
  itself needed no special-casing (the backend's `clip_geometry` already
  answers correctly for a text clip's full-frame natural size); the real gap
  was that a corner drag's `commit` writes `scale` through the same
  `set_clip_transform` op a video clip's does, and the frontend store's own
  reducer applies a text clip's write completely unchecked — silently landing
  a `scale` value neither the live preview (`resolve_text_clip_transform`
  pins it to `1.0`) nor `drawtext` (which cannot scale at all) ever reads.
  B-053's exact shape through a different door; closed by hiding the handles
  rather than teaching the reducer to refuse mid-drag. 3 new real-DOM tests.
- **2026-09-08** — **Text/title clips (roadmap 24b): `ClipInspectorPanel`
  hides Scale/Rotation/Width/Height/Crop for a text clip**, leaving Opacity/
  Position X/Position Y — the three fields `resolve_text_clip_transform`
  actually honours (the rest are pinned server-side and `editor_set_clip_
  transform` refuses a non-default write to any of them). A known follow-up
  left open from D-211's own pass (`ClipInspectorPanel.tsx` was owned by two
  concurrent efforts at the time). 3 new real-DOM tests.
- **2026-09-08** — **`editor_set_selection` (roadmap 26, D-216): the Edit tab's
  selection is finally WRITABLE over MCP, not just readable.** Closes the
  read/write asymmetry D-209 hit live — `TransformOverlay`'s on-canvas box and
  handles mount only for a selection of exactly one clip, so until now nothing
  but a human's mouse could reach, drive or verify the entire on-canvas
  transform surface. One op driving the store's existing
  `setSelection`/`setSelectedGap` (the same pair every GUI selection path
  calls), one MCP tool, no new store action, no Rust change. Takes an array
  (so D-107 multi-select is reachable too), each entry addressable by clip
  index or clip id, `[]` to clear, or a `gap` — validated against the live
  timeline, and a gap against the same `gapAt` the GUI's own click uses.
  **Deliberately not undoable**: selection is not part of `Timeline`, so
  D-051's snapshots never carried it and a human's click pushes nothing
  either — see D-216. 17 new real-DOM tests that assert the box and its four
  handles actually mount, not just that the store took the value; 703/703.
  **Verified live end to end** in a second isolated instance with
  `debug_screenshot` (D-210): no box → call the op → box + four handles tight
  around the picture and the real Inspector form → drive a transform and watch
  the picture land inside the box (B-093's own symptom, checked by an agent for
  the first time) → clear → select a gap and watch "Close Gap" appear.
- **2026-09-08** — **B-095 fixed (D-215): `editor_export` now honours `opacity` and `rotation`,
  static and keyframed** — both were completely absent from the ffmpeg
  compiler before this. `geq`'s `alpha_expr` for opacity (`colorchannelmixer`,
  the originally-suggested filter, turns out to flatly reject a time-varying
  expression — confirmed empirically), `rotate=` for rotation (direction and
  canvas-size behavior verified to match the Rust compositor's own
  `imageproc::rotate_about_center` empirically, not assumed). Folding fade
  into the same opacity expression also fixed an adjacent, previously-silent
  gap: a video clip's own fade handle (D-207) only ever reached its embedded
  audio, never the picture. Three new real-ffmpeg pixel tests. Filed B-098
  separately for the one still-open piece of the same shape: crop insets
  remain static-only in export.
- **2026-09-08** — **`editor_move_track` (roadmap 24(e), D-214):** closes the
  "a new track always lands at the bottom of the z-order" gap found right
  after text/title clips shipped — `editor_add_track` only ever appends, so a
  title added to a project that already had footage had no MCP way to get
  above it. Wraps `Timeline::move_track`, the same primitive
  `TimelinePane.tsx`'s drag-to-reorder track headers already used (D-094) —
  a pure MCP-exposure gap, not a missing primitive. Along the way, promoted
  the GUI's local selection-follow math (`trackIndexAfterMove`) to a shared
  `timeline.ts` helper so the new MCP op keeps a human's live clip selection
  correct after an agent-driven reorder, the same way the GUI's own drag
  already does.
- **2026-09-08** — **Text/title clips in the Edit tab** (roadmap 24,
  D-211/D-212/D-213): `Clip::text` as a real clip variant on an ordinary video
  track (so placement/trim/split/keyframes/fades are all the existing ops), an
  `ab_glyph` rasteriser feeding the live compositor, an ffmpeg `drawtext`
  export path spliced into the overlay chain at the clip's own z-order, plus a
  timeline **Title** button, an Inspector Title section and
  `editor_add_text_clip`/`editor_set_text_clip`/`editor_text_fonts`. Both
  engines read the same font file; pixel-measuring the two found (and fixed) a
  real ~11 % size mismatch between `ab_glyph`'s em-based scale and FreeType's
  ascender+descender one, and caught an escaping bug that rendered no text at
  all while exiting 0. Phase 1 is the basic title generator — single-line, no
  scale/rotation/crop — with the deferred list in
  `docs/notes/text-title-clips.md`.

- **2026-09-08** — **Fixed B-096: the Edit tab's preview/timeline split
  wasn't actually resizable**, a fixed `h-[46%]` flex row despite CLAUDE.md's
  own standing rule for exactly this class of pane. Wrapped in a nested
  vertical `ResizablePanelGroup` — the same pattern this file's own
  Inspector column and `MotionTab.tsx`'s equivalent split already use, not a
  new one.

- **2026-09-08** — **Fixed B-093 (D-209): on a keyframed clip the on-canvas
  transform box was drawn from the clip's STATIC transform, so it sat nowhere
  near the picture, and dragging it wrote a value the compositor can never
  show** (owner, live, with screenshots on the real ~50-keyframe
  `perf-comparison-reel-v3.chroma` — "the handles are entirely to the side of
  the visible picture", "i made it small but no clip follows that only the
  box"). Pre-existing since D-136 and invisible until B-085/B-092 made canvas
  click-to-select actually work. The box and D-204's hit rect now read
  `clipKeyframes.ts`'s new `resolveClipBoxTransform` at the clip's own source
  frame — five calls to D-208's existing `paramValueAt`, deliberately **not** a
  second interpolator — and a drag auto-keys **per property**, the same answer
  D-208 gave the Inspector's number fields, through the same helpers. Also
  fixed a `setState`-in-render commit the new DOM drag coverage exposed (a
  StrictMode double-commit is two keyframes, not one idempotent static write).
  **Perf, per the new top-priority rule:** the per-property keyframe reads are
  now indexed once per keyframe-array identity instead of re-sorting the list
  27 times per Inspector render — measured 31.7 µs → 1.2 µs at 50 keys (26.9×).
  That is not what "lagging like hell" is, though: D-209 records the real
  target (every preview frame crosses IPC as a base64 JPEG string, one at a
  time) in roadmap item 25. 23 new tests, 632/632. Live-run in a second
  isolated Tauri instance on the owner's real 50-keyframe project (loads,
  scrubs, no console error or panic; zero React-Compiler bailouts in
  `packages/editor/src` in the real vite build) but **not** verified at the
  pointer tier — and the reason is its own new roadmap item 26: there is no
  `editor_set_selection` op, so nothing but a human's mouse can put a clip into
  the state where the transform box even mounts, which leaves the whole
  on-canvas surface agent-unverifiable. See D-209.

- **2026-09-08** — **(D-210) An agent can now actually see the app.** New
  `chroma_debug_screenshot` / `chroma_debug_sample_pixel` commands make the
  running window's WKWebView photograph *itself*
  (`takeSnapshotWithConfiguration:`), which — unlike `screencapture`,
  `CGWindowListCreateImage` or ScreenCaptureKit — needs no macOS Screen
  Recording permission, the wall that had blocked every live UI verification
  this session. Exposed as MCP `debug_screenshot` (take a shot → `Read` the
  path → look at it) + `debug_sample_pixel`, and to a human as
  Cmd/Ctrl+Shift+D. Verified live against a real running window, not just
  compiled. Notes: `docs/notes/debug-screenshot-tool.md`.

- **2026-09-07** — **Fixed B-092 (D-205): canvas click-to-select was still
  completely dead in the real app after D-204 shipped it** ("still not able to
  select / unselect clips / video by clicking on the canvas... from timeline it
  works"). `useContentBox` took a `RefObject` and could only re-measure when
  its *size* changed — so when the composition size arrived (milliseconds)
  before the container existed (`PreviewPane` renders its surface only once a
  real ffmpeg frame decode returns, hundreds of ms), it stored a 0×0 box
  forever and `useCanvasClipPick` never attached its listener at all. Every
  test and the browser harness answered both commands from synchronous stubs,
  so they never saw that ordering. The hook now takes the ELEMENT, held in
  state via a callback ref. Verified live in a real WKWebView window with real
  clicks: same coordinates select/clear with the fix and do nothing without it.
  Also exposed `selection`/`selectedGap` on `editor_get_state` — selection was
  previously unobservable from outside the webview, which is how this shipped.

- **2026-09-07** — **(D-206) Added a real delete action to the project
  launcher** — a hover-revealed trash button on each project card, confirmed
  via the app's existing `ConfirmModal`, backed by a new
  `chroma_project_delete` Tauri command (`delete_project_at`, validated the
  same way the launcher's own listing already validates a project before
  showing it; refuses to delete whichever project is currently open). The
  card's outer element changed from a `<button>` to a `<div role="button">`
  so the delete button can nest inside it without invalid/unreliable nested-
  button HTML. 3 new Rust tests.

- **2026-09-07** — **On-clip fade handles (D-207), closing D-147's last UI
  gap.** Owner, by screenshot: the fade "rubber band" every reference NLE has.
  Every clip on the timeline — video track and audio track alike, because one
  fade pair drives picture and sound together in this model — now draws its
  `fade_in_frames`/`fade_out_frames` ramps at their real `FadeCurve` shape
  (exactly, not straightened: an SVG cubic *is* a `cubic-bezier`), with a small
  handle at each ramp's top that drags to set the fade live and commits ONE
  `set_clip_fade` op on pointer-up — the same op, undo stack and persist path
  the Inspector's numeric Fade field already used, so the two can't disagree.
  Coexists with the clip-move drag (distinct hit target) and the library's
  full-height edge-trim handles (a 15px-tall grab target at the clip's top
  edge, leaving the lower ~37px of both trim zones alone — Resolve's own
  stacking). Verified pure (22), jsdom with real `PointerEvent`s (10, including
  "the store must not change until pointer-up"), and by real ffmpeg: a
  drag-derived fade exports at −41.2/−21.6/−38.5 dB head/mid/tail against a
  flat −21.1 dB unfaded. Not live-tested in a Tauri instance — see D-207.

- **2026-09-08** — **Per-property keyframes and per-property reset in the Edit
  tab's Inspector (D-208).** Every Transform/Crop row now has its own
  After-Effects-style stopwatch diamond (filled = that one property is
  animated), `<`/`>` nav over that property's own keys, and a `RotateCcw`
  reset to its default — replacing the single whole-clip button that keyframed
  all nine fields as one bang. Writes MERGE into the key at the playhead
  instead of replacing it, editing an animated property keys the new value
  (and the field now shows the interpolated value at the playhead rather than
  a static number the preview isn't using), and "Key all properties" is kept
  as an explicit batch shortcut. **Found and fixed B-094 on the way:** the
  Rust live-preview resolver bracketed keyframes across *all* keys, so a
  property whose key wasn't named in both bracketing entries was *held* rather
  than interpolated — turning exactly the animation this feature authors into
  a step function on screen while the export rendered it correctly. New
  `keyframes::interpolate_param` fixes it; the mask/relight resolver is
  untouched. **Filed B-095, not fixed:** the ffmpeg export compiler ignores
  `opacity` and `rotation` entirely (static values included).

- **2026-09-07** — **Fixed B-088 (D-202): the Edit tab's live preview never
  showed a clip's current position/crop/scale.** Root-caused to an ordering
  race, not the compositor: `chroma_timeline_frame` renders the project's
  *persisted* manifest, but `PreviewPane` refetched on the store's
  *optimistic* `timeline` object — ~400 ms before the debounced
  `chroma_timeline_set` had written anything, and never again after. The
  preview sat one edit behind, permanently, which is why transforms set via
  the Inspector or MCP appeared to do nothing and `TransformOverlay`'s
  handles moved their box over a picture that never moved. Fixed with a
  `savedVersion` clock bumped only when the backend really holds the new
  timeline. The Rust compositor was read end to end against the export
  compiler and is correct — zero Rust changed. New real-DOM regression test
  drives the real `PreviewPane` and asserts the rendered `<img>`.

- **2026-09-07** — **Roadmap item 23, minimal slice:** added `editor_remove_media`
  MCP tool, wrapping the SAME `chroma_media_remove`/`removeMedia` path the
  Sources panel's own delete UI already used — the pool's only
  stuck/wrong-item correction mechanism until a real re-probe/expiry exists
  (still open). Traced (not live-tested — no built Tauri instance in this
  worktree; see roadmap item 23) that a clip already placed on the timeline
  referencing a removed pool item does not break: its `source_path` is an
  independent copy, never re-read from the pool, only its `media_id`
  back-link goes stale — now reported in the tool's `stillReferencedBy`
  field. `docs/notes/mcp-tool-coverage.md` updated.

- **2026-09-07** — **Fixed B-083 (D-203): switching projects left the Edit
  tab on the previous project's timeline.** The composition root told each
  tab only *whether* a project was open — a boolean, and both sides of an
  `open_project`/`new_project` switch are `true`, so the switch was
  invisible to the bridge. Every per-project store now takes the open
  project's **identity** (`selectProjectKey`) as its one input: a changed
  key drops the outgoing project's state and re-runs the store's existing
  open path. The same gap was audited and fixed in two more stores it was
  equally open in — the Motion tab's manifest (a per-project sidecar a save
  would have written into the wrong project) and the media pool that
  `editor_add_clip` resolves against. `npm test --workspaces` green
  (`@apelles/editor` 499/499, `@apelles/motion` 441/441, `@apelles/bridge`
  5/5 — that package gained a test setup for this).

- **2026-09-07** — **Fixed B-085: you can now click a clip's own picture in
  the Edit-tab preview to select it** (D-204). D-136's transform handles were
  reachable only by selecting in the timeline first — nothing in the preview
  listened for a press on the picture at all. New `canvasPick.ts` derives every
  visible layer's on-canvas rect frontend-side (no new backend command needed;
  the note's own open question had assumed otherwise) by mirroring the Rust
  compositor's layer resolution and paint order, and reusing the exact box math
  `TransformOverlay` draws with. The obvious z-ordered hit-layer version is
  wrong and was caught live in a real browser — a full-frame clip's own
  transform box is full-bleed and swallows every press — so the shipped
  `useCanvasClipPick` decides per press in the capture phase instead. Verified
  pure + jsdom + real-Chromium (canvas-only selection, then a real corner drag
  really resizing). `npm test --workspace @apelles/editor` 534/534 (was 495).

- **2026-09-07** — **Fixed B-087** (two components read Zustand state with
  `getState()` during render instead of subscribing, so the UI never updated
  when that state changed — the Colorist "Paste" button stayed disabled after
  copying adjustments, and `App.tsx`'s drag-overlay thumbnail could miss one
  that arrived mid-drag): `EditorView.tsx`'s `copiedAdjustments` and
  `App.tsx`'s `ImageDragOverlayNode` thumbnail now use real store
  subscriptions. Both are vendored-fork files — divergence logged in
  `docs/09-engine-notes.md`.
- **2026-09-07** — **Fixed B-086** (`CanvasBoundary`'s displayed composition
  size went stale after a `set_project_settings` write from anywhere other
  than `CanvasSettingsPopover`'s own "Apply" — e.g. the MCP tool): the Rust
  `chroma_project_set_settings` command now broadcasts a
  `chroma://project-settings-changed` Tauri event on every successful write,
  and `useCompositionSize` listens for it directly instead of depending on
  each caller to hand-bump a refresh token — closes the gap for the MCP tool
  and any future caller, not just this one symptom. Live-verified in the
  `app/harness.html?mode=preview` browser harness.

- **2026-09-07** — **Filed B-091** (`editor_export`'s own MCP response
  intermittently fails outright for a large-but-not-huge payload, instead
  of the graceful size-limit truncation the same size class usually gets —
  the real ffmpeg render always succeeds regardless) and mitigated it on
  this side of the boundary: `editor_export`'s MCP tool now drops the
  compiled `args` (the full `ffmpeg` argv, the actual driver of the
  oversized response) from its return value by default — a caller almost
  always only needs to know whether it succeeded and where the file
  landed, not the literal filtergraph. Also filed roadmap item 24: the
  Edit tab has no text/title clip primitive at all (confirmed by grep) —
  this session's own "AFTER"/"BEFORE" labels were a real `ffmpeg drawtext`
  finishing pass laid on top of Apelles' own correct export, not a Apelles
  feature, disclosed as such.

- **2026-09-07** — **Fixed B-090: `editor_export` silently ignored `scale`
  keyframes — only `position_x`/`position_y` ever animated per-frame.** A
  "zoom" authored via `editor_set_clip_keyframes` compiled to a fixed-size
  overlay panning around, revealing real background wherever the box never
  grew to cover. Found live via a real black band the owner spotted in an
  exported frame, confirmed by pixel-sampling a dense sequence of real
  decoded frames. New `scaleExpr` mirrors `positionExpr`'s own keyframe
  shape exactly, feeding a `scale` ffmpeg filter with `eval=frame`; also
  single-quoted `w=`/`h=` (the same B-075 class of bug — unquoted keyframe
  expressions break ffmpeg's filtergraph parser). New real-ffmpeg pixel
  test proves actual overlay SIZE changes, not just argv shape or "ffmpeg
  didn't error" (how B-090 shipped invisibly under the existing keyframe
  test). `npm test --workspace @apelles/editor` 495/495 (was 494).
- **2026-09-07** — **Fixed B-089: pure-audio media (no video stream at all)
  could never be imported at all.** `video::probe`'s `-select_streams v:0`
  legitimately returns zero streams for a real SFX/music file, but the code
  treated that as a probe FAILURE — permanently `offline: true` for every
  such file, so `editor_add_clip` refused them. Caught live adding real
  downloaded SFX/music to the comparison reel. New `probe_audio_only`
  fallback: real duration/audio facts, a nominal 24fps reference rate for
  frame bookkeeping (mirrors `apelles-timeline`'s own `DEFAULT_FPS`
  convention). `cargo test -p apelles-media` 99/99 (was 98).
- **2026-09-07** — **React Compiler bailout pass (D-201): `@apelles/editor` is now
  bailout-free, and one real bug fell out of it.** All 22 source files in the
  package compile with zero bailouts (`TimelinePane`/`TransformOverlay`'s
  hand-written memoization was fighting the compiler and costing them ALL
  auto-memoization; `PreviewPane`/`Filmstrip`/`useEditorControl`/`SourcesPanel`
  cleared too), pinned by a new `reactCompiler.test.ts` guard. Investigating the
  inventory's "possibly a real bug" flags found **B-087** (two components read
  Zustand state with `getState()` during render, so Colorist's Paste button never
  updates after a copy) — filed, not fixed. `TimelinePane`'s drag gesture was
  audited and is already deferred to pointer-up; no change.
- **2026-09-07** — **Fixed B-082: `new_project`'s auto-placed clips never got
  `source_fps`.** `append_media_clip`'s `..Default::default()` left it `None`
  despite the real probe sitting right above — the one other real `Clip`-
  construction site the B-075/B-077/D-194/B-079 fps-unit work never audited.
  Caught live rebuilding the comparison reel: a 47.6fps clip's timeline block
  rendered at roughly 2x its real length. New regression test (a 25fps fixture,
  deliberately off the 24fps default) covers both immediate and post-reload
  state. `cargo test -p apelles-project` 53/53 (was 52). Also filed (not fixed)
  **B-083**: `open_project`/`new_project` never refresh the Edit tab's own
  timeline store when switching PROJECTS (D-195's multi-TIMELINE-within-one-
  project switching is unaffected) — worked around this session by not
  switching projects mid-build.
- **2026-09-07** — **Fixed B-084: `editor_import_media` never populated
  `useMediaPoolStore.items` for a path already known to the Rust-side
  manifest** (e.g. seeded by `new_project`'s own `media_paths`), leaving
  `editor_add_clip` permanently unable to find it — mirrors `main.tsx`'s own
  established "added came back empty, refresh anyway" fallback. Also filed
  (not fixed) **B-085** (on-canvas clip selection for resize doesn't work,
  timeline-click-first only — owner-reported) and **B-086** (`CanvasBoundary`
  goes stale after a `set_project_settings` write made from outside
  `CanvasSettingsPopover`'s own Apply button, e.g. the MCP tool — display-only,
  self-heals on the next timeline edit).
- **2026-09-07** — **B-081 root-caused and fixed — and it was never an IPC bug
  (D-201).** The `IPC custom protocol failed` burst fires once per Tauri IPC call
  in flight when the page navigates; the navigation was a **Vite full page reload
  of the entire app**, caused by `app/src/main.tsx` holding the `Root` component
  while exporting nothing (an invalidating React Fast Refresh boundary that every
  edit behind a `@apelles/*` barrel propagated to). `Root` moved to its own
  `app/src/Root.tsx`; verified live that editing `timeline.ts`/`timelineStore.ts`/
  the editor barrel now hot-updates instead of reloading the whole app.
- **2026-09-07** — **"Multiple timelines" live-verified working; B-080 filed.**
  Extended the D-142 browser harness to mount `TimelineSwitcher` against a real
  multi-timeline fake backend and drove it with real Chromium pointer events:
  create-via-"+", switch-by-click, and per-timeline persistence/isolation all work
  correctly. Found and filed (not fixed) **B-080**: switching/creating a timeline
  while an edit's 400ms debounced save is still pending silently drops that edit —
  no error, not on disk, not recoverable from memory. Also fixed a harness-only
  usability bug (its debug overlay was eating real clicks on the newly-added tab
  strip).
- **2026-09-07** — **Two new `EditOp`s from the timeline-editing gap analysis
  (D-195): `slip` and `swap_media`, both with new MCP tools.** `slip` moves a
  clip's `source_start` in place without touching `start_frame`/`duration`
  (mirrors `trim_start`/`trim_end`'s clamp/lockstep discipline, `editor_slip_clip`
  MCP tool). `swap_media` repoints a clip at different source media while
  preserving everything else about it — transform, keyframes, fades, `link_group`
  — re-clamping `source_start`/`duration` (never `start_frame`) if the new source
  is shorter, and always re-reading `source_fps` from the NEW source rather than
  keeping the old one (the same fix-class as B-075/B-077/D-194)
  (`editor_swap_clip_media` MCP tool). `@apelles/editor` 377/377 (20 new tests),
  `tsc` clean.
- **2026-09-07** — **Timeline interchange export (D-196): a real, DTD-verified
  FCPXML 1.7 exporter** so a Apelles edit can move to DaVinci Resolve/Final Cut
  Pro. New pure compiler `packages/editor/src/timelineInterchange.ts` (mirrors
  `timelineExport.ts`'s own "same Timeline model, different output format"
  shape) → `editor_export_fcpxml` op → a new narrow `chroma_write_text_file`
  Tauri command → `mcp/server.py`'s `editor_export_fcpxml` tool. Maps clip
  placement/trims, track z-order (as fcpxml lanes), transform/crop/opacity,
  A/V `link_group`, and audio track gain; does NOT export `chroma_keyframes`
  animation, clip fades, or audio ducking — no verified FCPXML syntax for the
  first two without guessing, no static equivalent for the third — every one
  surfaces as a warning rather than a silent drop. Verified against Apple's
  own real FCPXML 1.7 DTD (`__fixtures__/fcpxml-1.7.dtd`) via `xmllint
  --dtdvalid`, not just string-compared. XMEML/Premiere scoped as a precise,
  separate follow-up, not attempted this pass — see D-196 for the full
  field-mapping table and why.

- **2026-09-07** — **`editor_export` mixes real audio (D-197), and the Edit tab
  gets a real Export button/dialog/sequential queue (D-198).** Closes D-183's own
  "video-only, a documented follow-up" gap, found live via the owner's own
  hand-rolled external-ffmpeg workaround for SFX in a real reel. Gain (D-057),
  one-pole ducking (D-149, exact via `exp()`), cubic-bezier fades (D-147, sampled)
  and a video clip's own embedded audio (D-129-aware) now mix down to a real
  output stream, replicating the LIVE mixer's semantics rather than reinventing
  them — deliberately using the B-075/B-077/D-194-CORRECTED fps math for duck
  trigger spans, not B-079's still-open conflation (new code, no reason to carry a
  known bug into it). `TimelinePane.tsx`'s toolbar gets a real Export button
  (`EditorExportDialog.tsx`) with per-clip speed/fit/freeze rows and a real
  sequential queue (`exportQueueStore.ts`), wired through the exact same
  `compileEditorExportArgs`/`runEditorExport` the MCP tool now also calls
  (`editorExport.ts`) — not a parallel implementation. `docs/notes/audio-export-
  mixing.md` / `docs/notes/export-dialog-queue.md` have the full design.
  `npm test --workspace @apelles/editor` 408/408 (was 357), including real
  `ffprobe`/`volumedetect`-verified ffmpeg execution (gain drop, fade ramp, duck
  engage/release, two-source mix all measured, not just argv-matched); the
  dialog/queue live-tested in a real Chromium tab via the D-142 harness.
- **2026-09-07** — **Live-preview canvas boundary + Edit-tab canvas-size popover
  (D-199), and B-079 fixed (D-200).** Root-caused the "live preview shows the AFTER
  clip full-bleed instead of stacked with BEFORE, no visible output frame" report
  (roadmap item 18): the Rust multi-track compositor itself is correct (verified
  with a real two-clip red/blue stacking test through the actual `timeline_frame`
  production path) — the real causes were B-079 (a mixed-native-fps clip's
  `Track::clip_at` could drop it out of the live composite entirely; now fixed,
  same fps-aware shape B-077/D-194 already gave the TS side) and the genuine
  absence of any canvas-boundary/settings surface to notice or diagnose it. Added
  `CanvasBoundary.tsx` (a selection-independent overlay, always shows the real
  output frame) and `CanvasSettingsPopover.tsx` (view/edit `ProjectSettings.width`/
  `height` from the Edit tab, previously reachable only from Colorist's shot-strip
  gear). Drag-to-rearrange (D-136) verified still working alongside the new
  overlay. Extended the D-142 isolated browser harness to mount `PreviewPane`
  (`?mode=preview`) and live-verified all of the above with real `PointerEvent`s in
  a real Chromium tab. Rust: `apelles-timeline` 137/137 (+8), `RapidRAW` 146/146,
  `apelles-project` 52/52, clippy/fmt clean on touched code. `@apelles/editor` 360/360 (+3), `tsc`
  clean both packages. See D-199/D-200 and `docs/notes/preview-canvas-boundary.md`.
- **2026-09-07** — **Independent per-axis clip sizing (D-193): `Clip.box_width`/
  `box_height` + an Inspector Width/Height/ratio-lock control.** The fuller,
  end-to-end fix D-184/B-074 explicitly scoped out — a clip can now be placed into
  an arbitrary, independently-sized box (not just a uniform `scale` of its own
  natural aspect) at every layer: the persisted `Clip` model, the Rust live-preview
  compositor (`composite_layer_onto`'s new `effective_size`), the `timelineExport.ts`
  ffmpeg compiler (`box_height` now takes priority over `fitOverrides`), a real
  Inspector control (Width/Height in px + a lock/unlock toggle, `Scale` kept as a
  separate "reset to uniform" affordance), and `editor_set_clip_transform`'s MCP
  surface. Unlike `scale`, `box_width`/`box_height` are a canvas fraction in BOTH
  engines — zero Rust/TS export-parity gap for the new fields, closing that gap
  rather than inheriting it. Honest remaining gaps, both documented in D-193 and
  `docs/04-roadmap.md` item 18: not wired into the clip-keyframe GUI button yet
  (engine supports it via `editor_set_clip_keyframes` directly), and no visible
  canvas-boundary overlay/project-settings UI exists yet (a separate, related but
  NOT-the-same-root-cause gap, checked explicitly against this work). Rust: 128+33
  tests, clippy clean. `@apelles/editor` 333/333, `tsc` clean. Not live-verified
  against a running app this pass (no instance available in this worktree).
- **2026-09-07** — **`editor_export freeze_overrides` (D-188) + B-077 filed.** Owner's own
  confirmed creative call for the reel — the sped-up AFTER clip finishes while BEFORE keeps
  playing — needed a real capability that didn't exist: holding a clip's last frame for the
  rest of the export instead of it just disappearing. New export-time-only
  `freeze_overrides` (mirrors `speed_overrides`), via ffmpeg's `tpad=stop_mode=clone`, with a
  real ffmpeg-execution test. Also filed **B-077** (not fixed this pass, dispatched
  separately): `endFrame`/the GUI timeline display add a clip's SOURCE-frame `duration`
  directly to its TIMELINE-frame `start_frame` with no fps conversion — wrong displayed
  duration/gaps for any mixed-native-fps clip (does not affect `editor_export`'s actual
  output, which already converts correctly per B-075). `@apelles/editor` 328/328.
- **2026-09-07** — **B-077/D-194: the same B-075 fps-unit bug, everywhere else in the Edit tab.**
  B-075 fixed `editor_export`'s `duration`/`source_start` fps mix-up but only there; the GUI
  itself had the identical bug — a 2113-frame screen recording at 44.13fps showed 00:01:28:00
  (88s) on the transport bar instead of its real 47.86s. Fixed the one real choke point
  (`endFrame`) and threaded the project's `fps` through everything that calls it in
  `timeline.ts`/`TimelinePane.tsx`/`marquee.ts` — gap detection, insertion/ripple math, the trim
  clamps, filmstrip/waveform widths. Also closed a real persistence gap: `Clip.source_fps` didn't
  exist on the Rust struct, so it silently vanished on every `chroma_timeline_set`/`_get` round
  trip (added, additive, no other Rust change needed). Filed (not fixed) B-079: the live Rust
  playback/audio-decode/duck engine has the same conflation on a reachable path — a real
  follow-up, scoped and documented, not silently skipped. `@apelles/editor` 335/335 (+11),
  `apelles-timeline` 129/129 (+1). See D-194 for why "convert at every consumption site" (matching
  B-075) was chosen over normalizing `duration` to timeline-frame units at clip creation.
- **2026-09-07** — **`editor_export` fixed for real content (B-075/B-076, D-187) + real ffmpeg
  regression tests.** The reel's first real export attempt found every render was actually
  broken three ways: an unquoted keyframe expression made ffmpeg reject the filtergraph
  outright for any clip with more than a trivial animation; `duration`/`source_start`/keyframe
  `frame` were divided by the export's fps instead of the CLIP's own native fps (silently wrong
  timing whenever a source's real frame rate differs from the export's — exactly two screen
  recordings at two different rates); and the `color=[base]` backdrop has no duration of its
  own, so nothing ever capped the output — every export before this ran forever until killed by
  hand. Fixed all three (`Clip.source_fps`, quoted `x=`/`y=`, `-t <furthest clip end>`). New
  `timelineExport.ffmpeg.test.ts` actually invokes real ffmpeg and checks real output via
  `ffprobe` — the existing suite only ever string-compared generated argv, which is exactly how
  all three shipped invisibly. `@apelles/editor` 324/324.
- **2026-09-07** — **D-183's Edit-tab MCP server committed** (was sitting unit-verified but
  uncommitted since 2026-09-07 morning): `useEditorControl.ts`, `timelineExport.ts` (pure
  ffmpeg-argv compiler), `chroma_run_ffmpeg`, 62-tool `mcp/server.py`. Its first-ever real use
  (building a performance-comparison reel) found and fixed two real bugs same-session: **B-069**
  (a Rules-of-Hooks violation in `TimelinePane.tsx` that crashed the ENTIRE `editor_*`
  control-server bridge, not just the one panel — two conditional early-`return`s sat between
  hook calls) and **B-074/D-184** (`editor_export`'s `scale` forced every overlay to the output
  canvas's own aspect ratio, making a full-width/half-height stacked layout impossible for any
  canvas size — fixed via ffmpeg's own `-2` auto-height, with the old forced-stretch behavior
  kept available as an explicit opt-in `fitOverrides` value). See `docs/BUGS.md` B-069–B-074 and
  `docs/08-decisions.md` D-184 for the full detail.
- **2026-09-07** — **Media understanding lands in Apelles proper: a second sidecar, 4 new MCP
  tools (D-189, D-190).** Pulled the two capabilities validated in the sibling `videoAgent`
  prototype into Apelles' own architecture — word-level transcript (mlx-whisper large-v3) and
  "what changed on screen, and when" (ffmpeg scene-detect for exact timing + Qwen3-VL-4B to
  describe each before/after frame pair) — as `ai-media/`, a second supervised FastAPI sidecar
  with its own venv and port. The scope doc demanded a real spike before assuming two processes
  were necessary, and it settled the question outright: `ai/requirements.txt` ∪ `{mlx-vlm,
  mlx-whisper}` is a literal pip `ResolutionImpossible` (mlx-vlm needs `transformers>=5.5`, `ai/`
  pins `<5` for ViTMatte). Rather than copy the supervisor for the second process, **D-190**
  generalized `apelles_ai::sidecar` to N sidecars via a `SidecarSpec` + a state registry — `ai/`'s
  behaviour, call sites and tests all unchanged. Then the usual chain, each layer mirroring its
  precedent: `apelles_ai::media_understanding` (the HTTP client, `depth.rs`'s error discipline),
  4 Tauri commands, an `@apelles/editor` store that caches results **by source path**, and
  `editor_get_transcript`/`editor_analyze_video` (+ their two `*_status` polls) in
  `useEditorControl.ts` and `mcp/server.py`. Start-then-poll rather than blocking because
  `chroma::control`'s bridge times out at 20 s and these run for tens of seconds to minutes.
  Live-verified against real footage: an 18 s clip transcribed in 11.9 s with 55 word-level
  timings; a 20 s cut-heavy reel analysed in 37.9 s, 5 candidates → 5 descriptions with correct
  ffmpeg-derived timestamps. 66 MCP tools now, no name collisions; `cargo fmt`/`clippy` clean,
  22 apelles-ai + 325 editor tests pass, zero new `tsc` errors. Settings shows a status card per
  sidecar. `docs/notes/media-understanding-sidecar-scope.md` records what shipped vs. the plan.

- **2026-09-07** — **`editor_get_capabilities`: a static, no-round-trip MCP tool for
  the Edit tab's hard-won constraints (D-191).** The reel session's own first live use
  of D-183's Edit-tab tools kept needing to read Apelles' own source to learn things no
  docstring said. New tool returns a structured dict covering the `scale`/`fit_overrides`
  aspect-ratio model (kept in sync with D-184's actual shipped fix), track paint order,
  per-clip keyframe scoping, export's real video-only v1 scope, and B-069/B-070/B-071/
  B-073's rough edges — answered entirely in-process, no app/project needed at all.
  `editor_import_media`/`editor_set_clip_transform`'s own docstrings gained short
  pointers to it. 63 tools total, verified via a real module import.
- **2026-09-07** — **A Claude Code project skill packages the reel workflow (D-192).**
  `.claude/skills/chroma-comparison-reel/SKILL.md` turns this session's real end-to-end
  procedure — live-test the MCP surface first, avoid the macOS screen-recording filename
  trap, the stacking/PIP compositing recipe (delegated to `editor_get_capabilities`), the
  real `editor_*` tool sequence including `fit_overrides`, the cross-repo `videoAgent`
  SFX/understanding pattern — into a repeatable, checked-in procedure instead of tribal
  chat-transcript knowledge. `.claude/` was not previously tracked in this repo and is not
  gitignored; this is its first use, flagged rather than silently decided.
- **2026-09-06** — **Per-card drag-to-fix for the `layers` primitive, + B-068 (D-182, Phase 3 of 3).**
  `Layers.tsx`'s `LayerItem` gains optional `dx`/`dy` (a pixel offset added to the computed
  position, `0,0` default, byte-for-byte identical render for every existing manifest) and a
  `data-motion-item-index` per card. New `{kind:'layer-item'}` selection lets a card be clicked,
  outlined, and dragged independent of its siblings (`MotionCanvasOverlay.tsx`'s new
  `findLayerItem`/`'move-item'` drag, `manifestEdit.ts`'s `selectedLayerItem`/
  `setLayerItemOffset`/`setLayerItemField`/`resetLayerItemPosition`, a minimal Inspector form).
  Also fixes **B-068**, found live while testing this: D-181's own solo-scene transport bar let a
  click "see through" it to select/drag the canvas underneath, since the existing hit-test
  deliberately walks the whole `elementsFromPoint` stack, not just the topmost element — a new
  `data-motion-transport` marker + an early bail on `e.target` fixes it. Live-verified end-to-end
  against the real project manifest (drag → correct `dx`/`dy` written, siblings untouched, Reset
  works) plus a byte-for-byte render check. `tsc`/`motion-engine`/`app` baselines unchanged,
  `@apelles/motion` 439/439 (+18). Closes the 3-phase scene-separation + per-card-drag initiative
  (D-180 export, D-181 solo preview, D-182 this one).

- **2026-09-06** — **Selecting a scene previews/scrubs it as its own 0:00-start clip
  (D-181, Phase 2 of 3).** `MotionPreview.tsx` gains `activeSceneIndex` — when set, swaps
  Remotion's native transport (no notion of a sub-range) for a small owned one scoped to that
  scene's own window, with a manual loop constraint (`loop`/native `controls` both disabled while
  soloed). `KeyframeTimeline.tsx` filters lanes to the active scene and re-bases its ruler to
  `[0, sceneDurationFrames)` — every write path underneath stays absolute-frame, unchanged; only
  the display/interaction boundary converts. A toolbar "Scene: `<id>` · Whole video" badge is the
  explicit way back to the combined view. No engine/schema changes at all — same key insight as
  D-180. Live-verified: local transport time, continuous in-scene looping across multiple cycles,
  filtered Keyframes panel, and a clean mid-playback revert via the toggle. `tsc` clean,
  `@apelles/motion` 421/421 (+2). Second of 3 planned phases (per-card drag-to-fix for `layers` next).

- **2026-09-06** — **Render exports every scene as its own separate video file, not one
  combined video (D-180, Phase 1 of 3).** `RenderRequest` (`apelles-motion` crate) gains an
  optional absolute-frame `frame_range`, appending Remotion's own `--frames=start-end` — no
  engine/schema changes needed at all, since the CLI already supports rendering a sub-range of an
  existing composition. `chroma_motion_render` defaults per-scene output to
  `<project>/motion/renders/<sceneId>.mp4`. `useMotionManifest.ts`'s `render()` now loops every
  scene sequentially through `sceneStartFrame`/`sceneDurationFrames`; a scene failing stops the
  loop (surfacing which one) rather than silently skipping it. Real end-to-end smoke test against
  the actual project manifest: rendering the `hook` scene's own range produced a 4.05s file, not
  the manifest's combined 15s. `cargo test -p apelles-motion` 7/7 (+2), `tsc` clean, `@apelles/motion`
  419/419 unchanged. First of 3 planned phases (solo scene preview, per-card drag-to-fix next).

- **2026-09-06** — **`+ Add scene` in `LayerList` (D-179).** New `manifestEdit.ts`
  `addScene(manifest, afterSceneIndex?)` appends a minimal, schema-valid scene (a short random id,
  `dur: 4`) either at the end or right after the currently-selected scene, selecting (and seeking
  to) it immediately — `addLayer`'s own established shape. Multi-scene support was already
  complete everywhere else (timeline, player, LayerList grouping); the only real gap was that
  nothing could CREATE one. Live-verified: new scene inserted in the right place, Inspector
  showed its real fields with no second click, total duration and every downstream reader
  updated with zero changes of their own. `tsc` clean, `@apelles/motion` 419/419 (+7).

- **2026-09-06** — **B-067: a destructive duplicate Inspector field, AND the `layers` primitive's
  `active` step-schedule exposed on the Keyframe timeline (D-178).** `propCatalog.ts` had TWO
  competing editors for `layers`/`layerstack`'s `active` key — a correct generic JSON field and a
  destructive `kind:'number'` override that silently overwrote a real `[{at,i}]` schedule the
  moment it was touched. Deleted the destructive one. Separately: that same schedule had NO
  Keyframe-timeline row at all (unlike Camera) — new `'active'` lane kind threaded through
  `keyframeVisibility.ts`/`manifestEdit.ts`/`KeyframeTimeline.tsx`, parallel to (never merged
  with) the existing `transform.keys`-driven `'layer'` lane, so a layer with both kinds of keys
  gets two clearly-labelled adjacent rows. Live-verified both fixes, including a real end-to-end
  drag-to-retime of an `active` key through the actual UI. `tsc` clean, `@apelles/motion` 412/412
  (+24).

- **2026-09-06** — **`LayerList` drag-to-reorder + real per-layer thumbnails (D-177).** New
  `manifestEdit.ts` `reorderLayers(manifest, sceneIndex, kind, fromIndex, toIndex)` — a pure,
  field-preserving array move within one scene's `layers[]` or `scene3d.children[]` (never across
  scenes, never bridging the two arrays), wired into `LayerList.tsx` as a native
  pointerdown/move/up drag (no drag library, matching this package's own standing convention) with
  a live drop-line and undo-wired commit. Also: real live per-row thumbnails via `@remotion/player`'s
  `Thumbnail` component for `matrix`/`layers` (checked empirically — `text`/`emphasis` render
  illegible hairline strokes at this scale and fall back to a static glyph, same as the 3D three's
  existing WebGL-context-ceiling fallback), mount-on-visible via `IntersectionObserver`. Found and
  fixed a real stale-React-state bug in the drag's own drop-target read (fixed with a ref, before
  ever shipping). `@apelles/motion` 367→382 tests, `tsc` clean, `app`'s 64-error baseline unchanged.

- **2026-09-06** — **B-066: the selection outline froze during a move/resize drag; selecting a
  layer now seeks to its own start (D-176).** `recomputeBoxes` only re-measured on a `selections`
  change or a Remotion `frameupdate`/`scalechange` event — never on `onTransientChange` during a
  drag, so the drawn outline stayed at its pre-drag size while the real content visibly
  moved/resized underneath it. Fixed with one `requestAnimationFrame(recomputeBoxes)` per
  pointermove. Also: new `manifestEdit.ts` export `layerVisibleFrameRange` (6 tests) lets
  `onSelect` seek to a layer's own `at` when the current frame falls outside its visible window —
  a `LayerList` click on a not-yet-visible layer now actually shows it, without reintroducing
  B-064's fixed regression. Live-verified in the harness both ways. `tsc` clean, `@apelles/motion`
  373/373 (+6).

- **2026-09-06** — **Keyframe timeline's zoom now matches the Edit tab's own (D-175).** Real
  `lucide-react` `ZoomIn`/`ZoomOut` icons and a percentage readout (was raw text `−`/`+` and
  `70px/s`), plus ctrl+scroll-wheel zoom (a plain native `wheel` listener, matching
  `TimelinePane.tsx`'s own scroll-vs-zoom split exactly). The underlying `pxPerSecond` range
  stays this timeline's own (D-162's call, unchanged) — only the UI/interaction layer matched.
  Live-verified: button and wheel both step 100%→140% with identical precision. `tsc` clean,
  `@apelles/motion` 367/367 unchanged.

- **2026-09-06** — **B-063: clicking a layer on the Motion canvas also toggled playback
  (D-172).** `@remotion/player` silently defaults `clickToPlay` to match `controls`, so enabling
  the transport bar also made every selection click on the canvas start/stop playback — fighting
  `MotionCanvasOverlay`'s own click-to-select. Fixed with an explicit `clickToPlay={false}` on
  `MotionPreview.tsx`'s `<Player>`. Confirmed NOT a shared-component bug — `@apelles/player`
  (the real cross-tab preview component) isn't used by Motion at all; the Edit tab's own preview
  was never susceptible. Live-verified in the harness. `tsc -p app` unchanged at 64.
- **2026-09-06** — **The scene-manifest panel actually collapses now; `</>` moved to sit with
  Save/Render; B-064 fixed (D-173).** D-153's own deferred shape, finally built: `ManifestEditor`
  is now just the textarea, and `showManifest` (`MotionTab.tsx`) gates the WHOLE panel + its
  handle, reclaiming its ~420px when hidden instead of just hiding the JSON inside a
  still-reserved rectangle. Save/Render/dirty/errors moved to a new always-visible toolbar, whose
  `</>` chip gets a red border when a parse error exists and the panel is collapsed. Also:
  **B-064** — a canvas click to select a layer was resetting the playhead to the scene's start on
  every click (predicted and disclosed back at D-158/D-162, now confirmed live). New
  `manifestEdit.ts` export `sceneIndexAtFrame` (5 tests) lets `onSelect` only seek when the
  target is actually in a different scene than what's under the playhead. Live-verified: same-
  scene canvas click preserves the playhead, cross-scene `LayerList` click still jumps. `tsc -p
  app` unchanged at 64, `@apelles/motion` 367/367.
- **2026-09-06** — **B-065: a 2D layer added to a `scene3d` scene rendered nowhere, ever
  (D-174).** `addLayer` only checks whether the INSERTED primitive is 3D-capable, never whether
  the TARGET scene already has a `scene3d` block — so adding an ordinary 2D primitive (e.g.
  `matrix`) via the Catalog to a scene that already has 3D content silently created permanently
  invisible layers: `Video.tsx`'s `OneScene` was a hard `scene.scene3d ? <ThreeD/> : <TwoD/>`
  ternary that never rendered `scene.layers` at all once a scene had `scene3d`, regardless of
  playhead position. Fixed the general way — `<TwoD>` now renders as a 2D overlay ON TOP of
  `<ThreeD>` whenever `scene.layers` actually has entries — rather than blocking the insert, since
  2D graphics over 3D content is a real, useful composition. Byte-for-byte identical renders for
  every existing `scene3d` manifest (none has `layers` at all, confirmed directly); a real smoke
  render with a `matrix` layer added to the sample's `space` scene now shows it composited over
  the particle stream, where before it rendered nothing at any frame.

- **2026-09-06** — **Close D-170's own flagged gap: camera-key `ease` validation (D-171).**
  `motion_set_camera_2d`/`motion_set_camera_3d` (D-168, built before the ease-validation guard
  existed) now run every key's `ease` through the same `validateEaseArg` D-169's
  `motion_set_layer_transform_keys` already uses — malformed shape errors, out-of-range values
  clamp with a warning instead of validating fine and crashing the render later (B-062's exact
  failure mode, still open at the schema level). `tsc -p app` unchanged at 64,
  `@apelles/motion` 362/362.
- **2026-09-06** — **Motion tab MCP surface, Phase 4: navigation, selection, persistence
  (D-170) — closes the whole scoped tool list (18 ops across 4 phases).** Four new `motion_*`
  ops: `select` (set the live selection + seek the player to the scene's start frame, mirrors
  `MotionTab.tsx`'s own `onSelect`), `seek` (absolute `{frame}` or `{scene_index, at}` seconds),
  `save_manifest` (wraps `useMotionManifest().save`), `render` (wraps `useMotionManifest().render`
  — a real `remotion render` subprocess to disk). `useMotionControl` now takes a `refs`
  parameter (`playerRef`/`measureApiRef`/`setSelections`) alongside `m` — no `mRef`-style re-sync
  needed for any of the three (a stable `useRef` object and a stable `useState` setter, unlike
  `m`'s fresh-every-render object). `save`/`render` (`useMotionManifest.ts`) now resolve to a real
  `SaveOutcome`/`RenderOutcome` instead of a bare `boolean`/`void`, so an MCP call gets a
  definitive answer on the promise itself rather than racing a later re-render for `saveError`/
  `renderError` state — every existing GUI side effect unchanged. Found and empirically confirmed
  a real, pre-existing constraint along the way: `control.rs`'s generic 20s bridge timeout applies
  to `motion_render` too (a live render took 33s; the `curl` caller got a 504 at 20.012s while the
  frontend kept rendering to a real, `ffprobe`-confirmed MP4 in the background) — documented as a
  known limitation (poll the deterministic output path), not "fixed" with new polling machinery
  against this task's own explicit instruction not to invent any. Also documents what's still
  open across the WHOLE surface: no Python `mcp/server.py` wrappers for any of the 18 ops yet, no
  `motion_open_project` (still borrows Colorist's `new_project` for test setup), and a real gap
  found while closing out — `set_camera_2d`/`3d` (D-168) never got B-062's ease-validation guard
  Phase 3 added for layer keyframes. Both `motion_render` branches (>20s and <20s) live-verified
  with real rendered files; a real coordinator-instance-killed-by-an-overbroad-`pkill` mistake was
  made and fixed during cleanup, recorded honestly in the decision entry rather than omitted.
  `tsc -p app` unchanged at 64 (diffed identical, not just counted); `packages/motion`'s vitest
  suite unchanged at 362/362.

- **2026-09-06** — **Motion tab MCP surface, Phase 3: layer keyframing (D-169).** Three new
  `motion_*` ops: `set_layer_transform_keys` (replace a layer/scene3d-child's `transform.keys`
  wholesale), `add_layer_keyframe` (upsert one key at a given time — `x`/`y` optional, derived from
  the layer's current on-screen position via `layerDragBase` when omitted), `move_layer_keyframe`
  (retime one existing key, reorders/clamps like a canvas drag). Added a real correctness guard
  along the way: a new `validateEaseArg` helper closes B-062's exact gap (an `ease` 4-tuple that
  can crash `Easing.bezier` if `x1`/`x2` fall outside `[0,1]`) at the MCP boundary, reusing
  `easeCurve.ts`'s own `resolveEaseCurve`/`clampEaseCurve` — a real error for a malformed value, a
  `warning` (never a blocker) for one that got clamped. Considered and deliberately left out:
  `moveKeysByDelta`'s multi-key nudge (D-163) — its own `baseAtSeconds` needs a live drag session
  an MCP call doesn't have; a real scope boundary, not a silent drop. All three ops live-verified
  against a real second running instance with before/after `motion_get_manifest` diffs. `tsc -p
  app` unchanged at 64; `packages/motion`'s own vitest suite unchanged at 362/362.

- **2026-09-06** — **Motion tab MCP surface, Phase 2: the rest of the non-keyframe edit surface
  (D-168).** Nine new `motion_*` ops in `useMotionControl.ts`: `set_layer_field`,
  `set_layer_position`/`size`, `move_layers_by_delta`, `align_layers`/`distribute_layers`,
  `set_scene_field`, `set_camera_2d`/`3d` — all thin adapters over real `manifestEdit.ts`
  functions, live-verified against a real second running instance. Found and fixed a real gap
  along the way: `manifestEdit.ts`'s functions never prefer a selection's stable `id` over its
  `index` themselves (the GUI only gets that "for free" via `MotionTab.tsx`'s own D-158 effect) —
  a one-shot MCP call has no such standing state, so a new `resolveOrError` helper resolves `id`
  before every mutating op, or an `id`-addressed call would have silently degraded to index-only
  addressing. `tsc -p app` unchanged at 64.

- **2026-09-06** — **Motion tab MCP surface, Phase 1: live-verified (D-167).** New
  `packages/motion/src/useMotionControl.ts`, mounted from `MotionTab.tsx`, answers `motion_*` ops
  over the existing D-020 HTTP↔Tauri-event bridge — zero `control.rs`/Rust changes.
  `motion_get_manifest` (read) and `motion_add_layer` (wraps `manifestEdit.addLayer`, committed
  through the real undo-wired `useMotionManifest().commit()`) built and live-verified via `curl`
  against a real running instance: opened a real `.chroma` project over the same bridge
  (`new_project`), confirmed `motion_get_manifest`'s `loadState` going `no-project` → `ready`, then
  a real before/after manifest diff proving `motion_add_layer` actually mutates state (scene
  `hook`'s `layers` array 2 → 3 entries, matching `catalog.ts`'s `defaultLayerFor('text')` shape).
  Also fixed a two-listener race (`useChromaControl` now skips any `motion_*` op so it can't win
  the response slot ahead of Motion's real multi-`await` handler) and found/documented a
  `CHROMA_CONTROL_PORT` gotcha: the control server's port-collision failure is silent, so a second
  Apelles instance for testing needs an explicit distinct `CHROMA_CONTROL_PORT`, verified via
  `lsof`/`ps eww` rather than assumed. `tsc -p app` unchanged at 64, `cargo check --workspace
  --all-targets` clean. Full scoping + tool-list roadmap:
  `docs/notes/motion-mcp-surface-research.md`.

- **2026-09-05** — **Full regression run finds and fixes a real gap (D-166).** `@apelles/editor`'s
  D-142 `jsdom` devDependency was declared in `package.json` but never actually installed on
  `main` — its flagship permanent DOM regression test (`TimelinePane.marquee.dom.test.tsx`) has
  been silently not executing since it merged (`npm test` still exited 0; vitest treats an
  unhandled collection error as a warning, not a failure). Fixed via `npm install` at the repo
  root. `@apelles/editor` now 8/8 files, 294/294 tests, for real. `cargo check --workspace
  --all-targets` clean, `@apelles/motion` 362/362, `@apelles/history` 11/11, `tsc -p app` unchanged
  at 64. No CI exists to catch this class of drift automatically — named as an open gap.

- **2026-09-05** — **A standalone Motion-tab browser harness, and the first live verification of
  the whole D-150–D-164 initiative (D-165).** `app/motion-harness.html` +
  `app/src/motion-harness-main.tsx` — the Motion-tab sibling of D-142's `TimelinePane` harness —
  mounts the real `MotionTab` standalone, seeded with `motion-engine`'s own `sample` manifest
  plus real keyframes/an authored ease. Actually driven live over CDP this session (not just
  built): click-select + canvas drag + undo-commit, the Inspector's separate X/Y/W/H fields, the
  per-row keyframe timeline at the correct positions, drag-a-key retiming, and the bezier curve
  editor rendering a correctly-shaped authored overshoot curve all confirmed working end to end
  in a real browser. Also fixed `packages/motion/src/index.ts`'s stale doc comment (still said
  "no on-canvas manipulation, no timeline UI, no undo/redo" — false since D-155).
- **2026-09-05** — **Motion keyframe timeline, Phase 5b (part 4): a real bezier curve/easing
  editor (D-164) — closes Phase 5b and the whole Motion visual-builder/keyframe-timeline
  initiative (D-150 through D-164).** New `easeCurve.ts` (pure: `curveToPixel`/`pixelToCurve` —
  the real pointer↔value conversion, `x` unconditionally clamped to `[0,1]` since `remotion`'s own
  `Easing.bezier`/`bezier()` THROWS outside that range, confirmed against its real source this
  pass; `curvePath` needs no numerical bezier evaluation at all, an SVG `C` command already draws
  the identical parametric curve; `resolveEaseCurve`/`clampEaseCurve`; `EASE_PRESETS`/
  `DEFAULT_EASE` sourced BY REFERENCE from `design.ease.*`, plus `Linear`/`Ease In` which that
  module doesn't define) and `EaseCurveEditor.tsx` (`EaseFieldControl`: two draggable
  control-point handles with dashed tangent lines, live-commits per pointermove matching
  `color`/`number`'s own established convention, no popover — inline like `color`). New
  `propCatalog.ts` `FieldKind: 'ease'` replaces `kind:'json'` for `CAM2D_KEY_FIELDS`/
  `CAM3D_KEY_FIELDS`/`LAYER_TRANSFORM_KEY_FIELDS`'s own `ease` entries — the only change to those
  three field lists. Unset `ease` shows `design.ease.inOut` muted/dashed with a "Not set — defaults
  to Ease In Out" caption — the literal fallback `interpolateKeys.ts` already renders with, not a
  guess. Found and filed (not fixed, per this pass's own scope) **B-062**: `schema.ts`'s
  `easeCurve` never validated `Easing.bezier`'s own hard `x∈[0,1]` requirement, so a hand-edited
  out-of-range value validates fine and only crashes at render time. No `manifestEdit.ts`/
  `schema.ts` change — `ease` was already fully plumbed, this is a new INPUT WIDGET only. `tsc`
  clean, `app`/`motion-engine` baselines unchanged, `@apelles/motion` 362/362 (was 334, +28, all
  new in `easeCurve.test.ts`).
- **2026-09-05** — **Motion keyframe timeline, Phase 5b (part 3): box-select + nudge multiple keys
  (D-163), on top of Phase 5b part 2 (D-162).** A new `KeySelectionEntry` model
  (`keyframeVisibility.ts` — `{lane, keyIndex}`, local to `KeyframeTimeline.tsx`, no
  same-kind/same-scene restriction, not cleared on every commit) for selecting individual keys,
  distinct from `Selection[]`. A rubber-band drag over empty track space box-selects via
  `keysInMarqueeRect` — pure geometry, no per-marker DOM measurement (only the scrollable content
  div's own rect is read), reusing `canvasGeometry.ts`'s `rectFromPoints`/`rectsIntersect`
  verbatim. Shift-click toggles, mirroring D-158's exact convention. Nudge generalizes D-158's
  `moveLayersByDelta`: `manifestEdit.ts`'s new `moveKeysAt`/`moveKeysByDelta` avoid a real
  correctness trap (N sequential `moveKeyAt` calls on keys sharing one array can retime the wrong
  key once an earlier reorder shifts a later `keyIndex` — fixed by computing every new `at` from
  each key's own remembered base in one pass, then sorting once). Decided: a key-selection may
  span multiple lanes/scenes; each key clamps to its own scene's `[0,dur]` independently (a nudge
  can go non-uniform at a boundary rather than blocking). `tsc` clean, `app`/`motion-engine`
  baselines unchanged, `@apelles/motion` 334/334 (was 292, +42: 15 in `manifestEdit.test.ts`, 21 in
  `keyframeVisibility.test.ts`, 6 `pxDeltaToSeconds` in `timelineZoom.test.ts`).
- **2026-09-05** — **Motion keyframe timeline, Phase 5b (part 2): per-row lanes (D-162), on top
  of Phase 5b part 1 (D-161).** Retires D-160/D-161's flat single-strip `KeyframeStrip.tsx` for a
  real per-row `KeyframeTimeline.tsx`: one row per keyed 2D camera/layer/3D camera
  (`keyframeVisibility.ts`'s new `keyframeLanes`, `LayerList`'s own row order — rows
  appear/disappear as keys are added/removed), `laneKeyMarkers`/`selectionForLane` as the
  per-lane replacements for the old whole-manifest/whole-selection functions, a shared time ruler
  via a REIMPLEMENTED (not imported) copy of `packages/editor/src/ruler.ts`'s tick algorithm
  (`timelineRuler.ts`), a new independent zoom mechanism (`timelineZoom.ts`, bounds chosen fresh
  for this UI, not reused from the Edit tab's D-134 system), a combined vertical+horizontal
  scroll region (sticky row labels + sticky ruler), per-row click-to-select reusing
  `MotionTab.tsx`'s own `onSelect`, and D-161's drag-a-key gesture generalized so any keyed
  layer's keys can be dragged without first selecting that layer. Layout: the timeline moved out
  of `MotionPreview.tsx` into a new full-width sibling panel in `MotionTab.tsx` (nested vertical
  `PanelGroup`), mirroring the Edit tab's own `PreviewPane`/`TimelinePane` stack. `tsc` clean,
  `app`/`motion-engine` baselines unchanged, `@apelles/motion` 292/292 (was 255, +37: 12 in
  `timelineZoom.test.ts`, 15 in `timelineRuler.test.ts`, the rest replacing/extending
  `keyframeVisibility.test.ts`'s old flat-strip coverage).
- **2026-09-05** — **Motion keyframe timeline, Phase 5b (part 1): drag a key along time (D-161),
  on top of Phase 5a (D-160).** New write primitive `manifestEdit.ts`'s `moveKeyAt` (one generic
  core over `layer.transform.keys`/`scene.camera`/`scene.scene3d.camera`) plus three thin
  wrappers. Two edge cases decided + tested: dragging past a neighbor REORDERS the array
  (`interpolateKeys` already re-sorts by `at`, so array position was never meaningful — clamping
  would only be cosmetic); boundary-clamped to `[0, scene.dur]`, the dragged key's own scene.
  `keyframeVisibility.ts` gains `percentToFrame` (the pixel/percent→frame inverse of
  `frameToPercent`) and `KeyMarker.keyIndex`. `KeyframeStrip.tsx` wires the drag through the SAME
  `onTransientChange`/`onCommit` `MotionCanvasOverlay.tsx` already uses; a real problem found and
  solved along the way — re-deriving markers from a live-reordering transient manifest mid-drag
  would silently drop `setPointerCapture` on the dragged button when React remounts it — solved
  with a local `dragPreview` overlay on a STABLE-manifest-derived marker list instead. `tsc`
  clean, `app`/`motion-engine` baselines unchanged, `@apelles/motion` 255/255 (was 224, +31).
- **2026-09-05** — **Motion keyframe timeline, Phase 5a: key visibility (D-160), scoping +
  first slice on top of Phase 0-4 (D-155-159).** New scoping doc,
  `docs/notes/motion-keyframe-timeline-research.md`, re-verifies the visual-builder research
  doc's own Phase 5 ("a real keyframe timeline… a major feature") against the real code: nothing
  in the Edit tab's timeline stack (`@xzdarcy/react-timeline-editor`'s clip-lane model,
  `@dnd-kit/sortable`) transfers as code (spans vs. durationless points); `ruler.ts`'s tick
  algorithm and D-137's gesture-separation discipline transfer as TECHNIQUE only, never an
  import, per the standing `@apelles/motion`/`@apelles/editor` package-boundary rule. Phases the
  rest as 5a (built here) and 5b (drag-a-key, per-row lanes, box-select, a curve editor — still
  a major feature, not attempted). Built this pass: `keyframeVisibility.ts` (pure,
  `layerKeyCount`/`cameraKeyCount`/`scene3dCameraKeyCount`/`cameraKeyMarkers`/
  `selectedLayerKeyMarkers`/`sceneBoundaryFrames`/`frameToPercent`, 25 new tests);
  `LayerList.tsx` per-row key-count badges; a new read-only `KeyframeStrip.tsx` under the
  player (camera + selected-layer key markers across the WHOLE composition, live playhead,
  click/marker-click-to-seek — no manifest mutation, so no undo/commit plumbing needed). One
  real, disclosed deviation: "the player's own scrubber gains markers" isn't buildable as
  literally worded (Remotion's bundled controls have no extension point, checked directly) — a
  separate strip alongside the untouched player gets the same intent instead. `tsc` clean both
  packages (`app`'s 64-error baseline unchanged, `motion-engine` untouched), `@apelles/motion`
  224/224 (was 199).
- **2026-09-05** — **Motion visual builder, Phase 4: per-layer keyframes (D-159), on top of
  Phase 0/1/2/3 (D-155/D-156/D-157/D-158).** `schema.ts`'s `layer.transform` (D-157) gains an
  optional `keys: TransformKey[]` (`{at, x?, y?, scale?, rot?, opacity?, ease?}`, seconds, additive
  DELTA on top of the static field of the same name, uniformly across all five fields) — the
  manifest's second authored spatial animation channel after the camera. `Camera.tsx`'s own inline
  sort/clamp/ease/interpolate logic extracted into one shared `interpolateKeys`
  (`motion-engine/src/lib/`), used by BOTH the camera and the new layer keys (`Video.tsx`'s
  `renderLayers`) — verified byte-for-byte unchanged via `remotion still` before/after the
  extraction. B-059 fixed (`cam2dKey`'s silently-stripped `ease` field, now real and typed) — and a
  SECOND instance of the identical gap found and fixed on `cam3dKey` (that bug's own text guessed
  it was harmless; `Scene3D.tsx`'s `CameraRig` reads `ease` the same way, so it wasn't). Auto-
  keyframe on drag: `MotionCanvasOverlay.tsx`'s move-drag now writes/updates a `transform.keys` row
  at the current playhead frame when a layer's position is already keyed (any key defines `x` or
  `y`), or the native base field exactly as Phase 1 when it isn't — per-PROPERTY (not per-layer:
  keys existing for `opacity` alone doesn't flip position into key mode), scoped to the move gesture
  only (resize is unaffected — `transformKey` has no size field). `InspectorPanel.tsx`'s camera-only
  `CameraKeyList` generalized to `KeyframeList`, now also driving a new per-layer
  `TransformKeysSection` (single-selection only — a documented scope call, keyframe lists don't
  lockstep-edit the way scalar fields do). `tsc` clean both packages (`app`'s 64-error baseline
  unchanged), `@apelles/motion` 199/199 (40 new tests: `interpolateKeys`, B-059 schema retention, the
  new `manifestEdit.ts` functions).
- **2026-09-05** — **Motion visual builder, Phase 3: multiple elements (D-158), on top of
  Phase 0/1/2 (D-155/D-156/D-157).** The owner said "multiple elements" first. `LayerList.tsx`'s
  `Selection` → `Selection[]` (same-kind `layer`, same-scene, or a single entry of any kind —
  enforced by `toggleSelection`). `MotionCanvasOverlay.tsx` gains a FOURTH pointer gesture
  (marquee-select + shift-click-extend, alongside resize/move/click), D-137's "mutually exclusive
  by DOM position" discipline applied explicitly (`[data-motion-resize-handle]` →
  `[data-motion-layer]` → `[data-motion-world]` containment → Remotion's own untouched chrome).
  Drag now moves every selected layer by one shared world delta (`moveLayersByDelta`), one commit
  per gesture. Stable layer identity: an optional, additive `layer.id` (schema.ts) stamped by
  `addLayer`, with `resolveSelection`/`resolveSelections` preferring it over a captured index so a
  live multi-selection survives a reorder/insert/delete — verified inert on render via
  byte-identical `remotion still` output, id present or absent. `InspectorPanel.tsx`'s
  `MultiLayerInspector`: align/distribute (real pure functions,
  `alignSelections`/`distributeSelections`) always shows for 2+ selections; the D-157 Transform
  group always shows in lockstep; the primitive's own fields also show in lockstep when every
  selected layer shares a `use`. Snapping GUIDES explicitly scoped down (open-ended UI work, not
  built — see D-158's own "smallest next step"). A worktree-infra `node_modules` symlink gotcha
  (cross-package types resolving to the MAIN repo's stale copy) found and worked around without
  `npm install` (blocked by this session's permission classifier) — see D-158's own writeup.
  `tsc` clean both packages (`app`'s 64-error baseline unchanged), `@apelles/motion` 159/159
  (37 new tests).
- **2026-09-05** — **Motion visual builder, Phase 2: resize handles, "snap to layer," the layer
  transform wrapper (D-157), on top of Phase 0/1 (D-155/D-156).** Resize: `sizeFields(use)`
  (`propCatalog.ts`) + `layerWorldSize`/`setLayerSize` (`manifestEdit.ts`) for `emphasis.box`,
  `layers.cardW`/`cardH`, `matrix.cell`, `text.maxWidth`, `graph.width`/`height`; 1–3 on-canvas
  handles per primitive, sharing D-156's drag machinery via a discriminated `DragState`. "Snap to
  layer" — the direct fix for the owner's original misplaced-scribble screenshot — an Inspector
  target-picker on an `emphasis` layer that measures the target's real screen rect
  (`MotionPreview.tsx`'s new `measureApiRef`) and writes `box` via a new pure
  `snapEmphasisToRect`. Engine: an optional, additive `layer.transform`
  (`{x,y,scale,rot,opacity,clipWidth,clipHeight}`, absent ⇒ identity — verified byte-identical
  `remotion still` renders at three frames before/after) applied by `Video.tsx`'s `renderLayers`
  on top of a primitive's own positioning — the enabling structural change for Phase 4's
  keyframes. "Crop" implemented honestly as `clipWidth`/`clipHeight` on that same wrapper, NOT
  the Edit tab's four-inset model. `tsc` clean both packages (`app`'s 64-error baseline
  unchanged), `@apelles/motion` 122/122 (30 new tests).
- **2026-09-05** — **Motion visual builder, Phase 1: select + drag a layer on the canvas
  (D-156), on top of four prerequisites (D-155).** The owner's "drag and drop... a visual
  builder for me" ask, first slice. Engine: `data-motion-world`/`data-motion-layer`/
  `data-motion-box` DOM hooks (zero pixel change — verified with byte-identical `remotion still`
  renders before/after, not just reasoning). Tab: a transient-manifest drag preview (no
  JSON round-trip), `@apelles/history` wired in via a new `useMotionManifest.commit` (Inspector
  edits first, drag commits second), and `MotionCanvasOverlay.tsx` — click-to-select via
  `elementsFromPoint`, drag writes world-space `x`/`y` (`text`/`matrix`/`layers`) or
  `box[0]`/`box[1]` (`emphasis`) through a measured screen↔world map (`canvasGeometry.ts`,
  the exact `docs/notes/motion-visual-builder-research.md` §3a technique, 15 new unit tests
  including the doc's own worked camera example), Escape cancels, Shift locks an axis. Out of
  scope, explicitly: resize, rotate, multi-select, keyframes, `scene3d`. `tsc` clean both
  packages, `@apelles/motion` 92/92 (26 new tests).
- **2026-09-05** — **Motion Inspector: position/size tuples get separate X/Y/W/H fields (D-154).**
  Owner: *"we should be able to have all this as x: y: h: w: separate."* `emphasis.box`
  (the exact field behind a misplaced-scribble screenshot), `particleflow.from`/`to`/`center`,
  and `labelbox`/`layerstack`'s `position`/`size` move from one raw-JSON-array field to a new
  `FieldSpec.kind: 'vec'` — separate labeled number inputs per element, sharing one array value.
  Content fields (`Matrix.values`, `Graph.nodes`, …) stay `'json'`, unchanged. On-canvas
  drag/resize sync and the animation timeline are separate, not-yet-built asks (D-152 Phases 0-2
  and 5). `tsc` clean, `@apelles/motion` 66/66 unchanged.
- **2026-09-05** — **The scene manifest collapses behind a `</>` toggle (D-153).**
  Owner: *"as a user i dont need that, you will need only."* Only the raw-JSON
  textarea and its informational status rows (parse OK, render-success line)
  collapse by default; Save/Render and any real save/render error stay visible
  regardless, avoiding the trap D-152's research doc named (those controls live
  in the same panel as the JSON). A live parse error force-expands, since that's
  the one moment hiding the JSON would hide why Save/Render just greyed out.
  `tsc` clean, `@apelles/motion` 66/66 unchanged.
- **2026-09-05** — **The Motion tab's false "No project open" (B-058 / D-150).**
  Owner-reported live; not the D-148 regression the timing suggested —
  `state::set_project` was running fine. The tab mounts at boot like every tab,
  read its manifest right there with no project open, and stored that honest
  backend error as a *fact about the app*; its only escape was a window `focus`
  event, which the in-window launcher never produces. Same structural fault
  B-034/D-112 removed from the Edit tab, and it gets the same fix: a real
  readiness store with one input pushed in from the composition root, no backend
  call at all while the app says no project is open, and a failed read that says
  so instead of lying. 9 new tests (2 confirmed red against the old behaviour);
  `tsc`/`cargo check` state unchanged. Also filed: `closeProject` leaves the Rust
  `ProjectRef` stale — an adjacent hole this pass deliberately did not fix.
- **2026-09-05** — **Motion tab audit + the Catalog (D-151).** Owner: *"map out
  where we lag, have a Catalog Section where all our built catalog is there
  which we can get on our current thing."* The audit
  (`docs/notes/motion-tab-audit.md`, to `timeline-feature-audit.md`'s rigor bar)
  found the tab **could edit everything and create nothing** — `manifestEdit.ts`
  had nine functions, all readers or field-setters, and adding a layer meant
  hand-typing JSON including `use` strings and required props the UI never
  listed. Built the fix: `catalog.ts` (all 8 primitives, exhaustive against the
  engine's own zod enum so a new primitive is a `tsc` error until catalogued,
  plus schema-valid default fragments), `addLayer` in `manifestEdit.ts`
  (immutable, routes 3D primitives into `scene3d.children` and creates that
  container with a valid camera when absent, returns the new `Selection` so the
  Inspector opens on it), and `CatalogPanel.tsx` as a second tab in the sidebar
  pane. Glyphs not live thumbnails, argued in D-151 (three primitives need a
  WebGL context each). 18 → 57 tests, fragments asserted against the real
  `manifestSchema` and mutation-checked; zero new `tsc` errors. Also filed
  **B-059** (camera `ease` is supported by the engine and silently stripped by
  the schema), found by fact-checking a wrong draft claim. Next priority named,
  not built: on-canvas manipulation.
- **2026-09-05** — **Motion visual builder: research pass, no code (D-152).** The owner asked
  for on-canvas drag/size/animate with a human in the loop, pointing at a `scribble` emphasis
  circling the wrong words. Read the engine end to end, and the framing going in turned out to
  be wrong: **this is not D-136 again.** The Motion model is already scene/world space with the
  camera applied at render time, the camera is an invertible 2D similarity, and the reference
  frame is `manifest.width`/`height` declared in the document — so nothing needs migrating. The
  screenshot's real cause is that `emphasis.box` is a hand-authored duplicate of a rectangle
  only the layout engine can know (plus `Emphasis` drawing the ellipse at `w×1.18` / `h×1.5`).
  Recommended technique: **measure the live DOM** (`data-motion-world` +
  `getBoundingClientRect`) instead of reimplementing the camera's math — drift, easing and the
  player's fit-scale all cancel for free. Phased 0–5, with **Phase 5 (a real keyframe timeline)
  named as a major feature**, crop answered "no, and here is why", and 3D excluded. Also filed
  B-060 (drift rate uses the hardcoded `design.fps` token) and B-061 (Inspector labels camera
  `at` in frames; the manifest is seconds), and scoped Part C (collapse the raw JSON behind a
  `</>` chip) for a fast follow-up — the trap being that Save/Render **and the error strip** live
  inside the panel being collapsed. `docs/notes/motion-visual-builder-research.md`.
- **2026-09-05** — **`apelles-project` real extraction (D-148) — Wave 1–3 of the
  crate migration is done.** `chroma/project.rs` L1–1638 (the manifest, every
  schema migration, the media pool + bins, the D-070 unified clip identity and
  grade-file migration) moves verbatim into `crates/apelles-project/`;
  `open_manifest` + the 20 commands stay in `app/src-tauri`, because all 20 take
  `tauri::State<'_, AppState>`. The one piece of real relocation: the timeline
  lifecycle (`ensure_timeline`, `load_and_ensure_timeline`, `resolve_timeline`,
  `resolve_timeline_and_settings`, `build_from_shots`) leaves `chroma/edit.rs`
  for the new crate — project concerns wearing an Edit-tab name — with the
  process global they read (`chroma::state`'s "which project is open") staying
  app-side as a parameter `chroma::edit`'s three-line wrappers supply, so every
  call site is unchanged and the functions are unit-testable for the first time
  (5 new tests). The 59-test suite splits 48 (model → crate) / 11 (command
  surface + process state → stay). `architecture-lock.md`'s dependency table
  corrected twice on contact: **`apelles-project → apelles-media` is real** and was
  missing; the `apelles-grade-model` edge it claimed does not exist.
  `cargo check --workspace --all-targets` clean; `cargo test -p apelles-project`
  52 passed / 1 ignored; `cargo test -p apelles --lib -- chroma::` 126 passed.
  **Next: wave 4** — delete the shims, retarget call sites, fix `03-architecture.md`.
- **2026-09-05** — **Ducking: music under dialogue (D-149)** — the plan doc's §4,
  built on exactly the seam D-147 left it. `Track` gains `duck_from`/`duck_db`/
  `duck_attack_ms`/`duck_release_ms`; the trigger is a pure timeline query (does
  the nominated track have a clip here — `Track::clip_spans_from`, which
  **merges abutting clips** so the duck holds across a cut instead of pumping at
  every one), smoothed by a real one-pole with separate attack/release time
  constants. The smoother is evaluated in **closed form** rather than as a
  per-sample recursion, which makes the envelope identical at 44.1 and 48 kHz
  and `gain_at` a pure function — a unit test runs the discrete recursion
  against it to pin that they are the same filter. It composes with D-147's fade
  by multiplication in one per-sample-frame pass, so `mix_sources` is still
  untouched. Track-header popover (audio tracks only) + `set_track_duck`, the
  third Edit-tab MCP tool, with the real DSP numbers rather than a "strength"
  dial. A track with no `duck_from` gets no envelope at all, so every existing
  project mixes byte-identically. `cargo check --workspace --all-targets` clean;
  apelles-timeline 128, apelles-media 98, `RapidRAW --lib chroma::` 178/178,
  `@apelles/editor` 294; `tsc -p packages/editor` clean, zero new `tsc -p app`
  errors. Not heard in the real app (no Tauri window in this sandbox), and the
  trigger is still the clip layout rather than the signal — RMS sidechain is
  Phase 2, said out loud in the tool text and the UI.

- **2026-09-05** — **`apelles-media` real extraction (D-146)** — the widest slice
  of D-141's plan (§2.2), in its three required ordered commits. (1) `video.rs`
  + `decode_pipe.rs` + `media_cache.rs` move verbatim; two `#[cfg(test)]` hooks
  become a `test-support` feature enabled only from `[dev-dependencies]`, so a
  release build links none of them. (2) `probe_cached` leaves `edit.rs` — it had
  to, or `apelles-media` would depend on the app — and **B-056 is fixed on the
  way**: the in-memory probe cache now revalidates the source file's
  `blake3(path ‖ mtime ‖ len)` identity on every hit instead of being
  insert-only and path-keyed, so a file replaced in place is re-probed rather
  than serving stale facts for the rest of the session. (3) `filmstrip.rs`
  moves whole and `audio.rs` **splits**: the symphonia→rubato→cpal engine, the
  D-130 session protocol and the waveform path are media and moved; the
  timeline resolution inside `chroma_audio_play` is not, and stayed app-side —
  `begin_play` → *(app resolves)* → `start`, preserving the exact ordering the
  D-125 skew compensation depends on. **B-057 fixed** in the same commit: a
  `ChunkLockGuard` whose `Drop` releases the `CHUNK_LOCKS` entry on every path
  out of `load_chunk`, not only the successful one. Both bug fixes carry
  regression tests confirmed to fail against the pre-fix code.
  `cargo check --workspace --all-targets` clean; `cargo test -p apelles-media`
  83 passed; `cargo test -p apelles --lib -- chroma::` 164 passed.
- **2026-09-05** — **Per-clip fades with real cubic-bezier curves (D-147),** plus the
  scoping doc for the whole "practical sound control" ask
  (`docs/notes/audio-fade-duck-crossfade-plan.md`). `Clip` gains
  `fade_in_frames`/`fade_out_frames` + a `FadeCurve` each; a new
  `apelles-types::fade` evaluates them (Newton–Raphson + bisection over the CSS
  `cubic-bezier` model — there was no easing math anywhere in this repo before this).
  One fade drives picture and sound together: the compositor multiplies it into
  `opacity`, the mixer applies it per **sample-frame** before summing sources.
  Landed just after D-146 moved the mixer into `crates/apelles-media` — `FadeEnvelope`
  moved with it (beside `AudioSourceSpec`, the boundary type it extends), the curve
  math moved *down* to L0 `apelles-types` so the L1 mixer and the L2 timeline model can
  share one implementation without an upward dependency (re-exported from
  `apelles-timeline`, so `apelles_timeline::FadeCurve` still resolves), and
  `chroma_audio_play`'s timeline-resolution half stayed app-side per D-146 — it is
  what converts a clip's fade frames to the envelope's seconds. Inspector section + presets, and the first two Edit-tab MCP
  tools (`get_timeline`, `set_clip_fade`) — which also exercise D-140 §6c's "agent
  edits go through `applyOp` so they stay undoable" for the first time rather than
  only stating it. **Crossfade found blocked** on D-104's no-overlap invariant: the
  no-overlap version is a dip-to-silence, not a crossfade, and no curve fixes that —
  the renderer and mixer are already N-source ready, only the model isn't. **Ducking
  scoped, not built** — it reuses the same time-varying-gain primitive, which is why
  the envelope was shaped as one.
- **2026-09-05** — **`apelles-grade-model` real extraction landed (D-143),** per
  D-141's plan §2.4. `save_grade`/`load_grade`/`migrate_v1`/`relativize`/
  `resolve`/`grade_name` + `SCHEMA`/`MATTE_KEYS`/`SaveResult` moved verbatim
  out of `chroma/grade.rs` into the crate — the zero-dependency-edge claim
  held (only `std::path`/`base64`/`serde_json`). The 2 `#[tauri::command]`
  wrappers stay in `app/src-tauri` per D-141's "commands do not move" rule,
  now thin calls into the crate. Corrected a stale `apelles-types` dependency
  edge in `architecture-lock.md`/`crates/README.md` that the real code never
  had.
- **2026-09-05** — **`apelles-gpu` real extraction (D-144).** `render_core::init_gpu_context()`'s
  real body moved verbatim into the new crate; `render_core`'s own version is now a thin
  wrapper. Resolved the one open question D-141's scoping left: `GpuContext` really does
  split into two structs — a headless `apelles-gpu::GpuContext` (device/queue/limits) and
  the unchanged app-side `image_processing::GpuContext` (same three fields plus the
  `display` surface wrapper). `render()` and the grade path stay app-side, gated on the
  later `apelles-grade` effort. `cargo check --workspace` clean; the 6 known call sites
  (`export.rs`/`playback.rs`/`relight.rs`/`gpu_processing.rs`) are unchanged.
- **2026-09-05** — **`apelles-ai` real extraction (D-145).** `sidecar.rs` moves almost
  whole (704 lines — lifecycle supervision, health checks, content hashing, sidecar
  I/O), dropping `spawn_and_supervise`'s confirmed-unused `AppHandle` param on the way.
  `depth.rs`/`mask.rs` split cleanly at the crate boundary: `tracked_depth_map`/
  `tracked_full_mask` stay app-side (they read `chroma::state::current_video()`) but
  as thin wrappers over new crate functions that take the frame as a plain argument —
  `mask_generation.rs`'s call sites need zero changes. `chroma_subject_mask`'s real
  fork-type dependencies stay put, exactly as scoped. `cargo check --workspace` clean.
- **2026-09-05** — **Pacing & audio assistance scoped (D-140), no feature code.**
  Turned D-139's research into a buildable plan:
  `docs/notes/pacing-audio-assistance-plan.md`. Beat detection runs in the `ai/`
  sidecar on librosa (BSD-3, no weights — essentia/madmom excluded on their
  models' non-commercial licences), decoded via ffmpeg, **without** the `_GPU`
  lock and with no `_MODEL_REGISTRY` entry; results cache in a new `media_cache`
  `"beats"` namespace keyed exactly like the waveform peaks, so Phase 1 adds
  **no** field to `Clip`/`Track`/`Timeline` (a `Timeline::markers` model was
  considered and rejected for v1, with reasons). Beat positions become timeline
  guides + snap targets inside the two functions Apelles already owns
  (`computeInsertion`/`resolveClipLanding`); edge-trim snapping is genuinely
  blocked by the timeline library's `dragLine?: boolean` (verified in its
  bundled types) and is named as a gap rather than promised. MCP is designed in,
  not appended: `get_timeline` + `detect_beats` in Phase 1, `inspect_pacing` +
  `snap_clip_to_beat` in Phase 2, `pulse_steadiness` instead of an invented
  `confidence`, and a real answer to the question `mcp-tool-coverage.md` left
  open (a mutating Edit-tab tool goes through `timelineStore.applyOp` so agent
  edits land on the shared undo stack). Phase 0 first: benchmark librosa on the
  owner's own CassetteAI tension beds, which are the worst case for this class
  of tracker — it can invalidate the premise before anything is built.
- **2026-09-05** — **Audio/rhythm/pacing-assistance research pass (D-139), no
  feature built.** Owner asked about beat/emotion/pacing understanding —
  "the things sound engineers do." Researched beat/onset detection
  (librosa/essentia/madmom/aubio + newer transformer trackers — real, mature,
  offline, license gates found on aubio/essentia/madmom), what Premiere/
  CapCut/Descript's beat features actually do (mark or auto-trim, no
  structural understanding), and how real footage-pacing/"emotion" analysis
  is today (shot-length, loudness, motion-intensity are real; "emotional arc"
  understanding is not, and a marketing-blog citation was checked and
  rejected as non-credible). Write-up:
  `docs/notes/pacing-audio-assistance-research.md`. A separate pass scopes
  the actual feature from these findings.
- **2026-09-05** — **The rest of the D-039 crate extraction is scoped from the
  real code (D-141)** — `docs/notes/crate-extraction-plan.md`, the execution map
  a later wave of parallel agents works from. Three findings changed the plan
  rather than filling it in: `#[tauri::command]` functions must stay in
  `app/src-tauri` (read out of `tauri-macros-2.6.3` — the attribute's two
  `#[macro_export]`ed macros land at the *crate root*, the wrapper body needs a
  real `tauri` dep, and any `State<AppState>` command in a crate is a dependency
  cycle); every extraction leaves a `pub use` shim in the same commit, which is
  what keeps `lib.rs`'s handler list off every slice's diff and makes the wave
  genuinely parallel; and `apelles-agent` is rescoped *out* of the wave, because
  `control.rs` has no Tauri-free core and its own doc says the op registry lives
  in the frontend. Order: `apelles-grade-model`/`apelles-ai`/`apelles-gpu` in
  parallel → `apelles-media` (three ordered commits) → `apelles-project` → shim
  sweep. Two real defects found while reading and filed: **B-056**
  (`edit::PROBE_CACHE` never invalidates, shadowing the mtime+size staleness
  contract of the disk cache beneath it) and **B-057** (`filmstrip::CHUNK_LOCKS`
  leaks on the extraction error path). No code changed.
- **2026-09-05** — **A reusable pointer-gesture test harness + a permanent
  real-DOM regression test for marquee-select (D-142).** This repo had built
  the same real-`PointerEvent`-against-a-real-component browser harness from
  scratch five times (D-095/096/098/100/137), always deleted after use, never
  committed. `packages/editor/src/testUtils/pointerHarness.ts` extracts the
  real common pattern (real `PointerEvent` dispatch with rAF waits, real
  `<StrictMode>` mounting, jsdom's missing layout/pointer-capture APIs
  stubbed, a Tauri `invoke` stand-in, an enforced zero-console-errors check)
  as an importable module; `TimelinePane.marquee.dom.test.tsx` uses it to
  mount the REAL `TimelinePane` and re-verify 9 of D-137's own scenarios
  permanently — runs on every `npm test --workspace @apelles/editor` (277
  passing, 9 new). `app/harness.html` + `harness-main.tsx` (the real-Chromium
  tier for what jsdom's fake layout can't check — dnd-kit's own drop-target
  resolution) are promoted from scratch-and-delete to permanent and checked
  in, cross-validated live via `chrome-devtools` MCP tonight.
- **2026-09-05** — **Marquee-select on the Edit timeline (D-137, roadmap item
  12 Phase 2).** Click-drag on empty timeline canvas rubber-bands a selection;
  every clip the rect intersects is selected, shift/cmd/ctrl unions onto the
  existing selection. The deferral's stated reason was dnd-kit coexistence, and
  it is resolved structurally rather than by precedence: `ClipBody` carries
  `data-chroma-clip-drag` and the gesture refuses any `pointerdown` with that
  on its path — the same condition dnd-kit's own `PointerSensor` uses — reusing
  that sensor's `distance: 4` threshold rather than inventing a second one. All
  decision logic is pure and unit-tested (`marquee.ts`, 36 new tests, 258
  total); the gesture was driven with real `PointerEvent`s at the real
  component under `<StrictMode>` in a browser, confirming same-track and
  cross-track clip drag and track reorder all still work and never raise a
  band. That run caught a real bug before it shipped: Escape cancelled the band
  but its terminating click still wiped the pre-existing selection.
- **2026-09-05** — **A manual A/V link/unlink toggle (D-138).** Closes the two
  things D-129 named and deferred: `Timeline::link` (new — links two
  already-independent clips, one video-track/one audio-track, into a group
  indistinguishable from a drop-created one; deliberately narrower than
  Palmier's own group-merging `link`) and `Timeline::unlink` finally exposed
  as real Tauri commands (`chroma_timeline_link_clips`/`_unlink_clip`). Real
  toolbar UI in `TimelinePane.tsx`: a `Link` button next to the existing
  `Unlink`, shown for a two-clip selection and disabled with a reason
  tooltip (`checkLink`, the one precondition check both the button and
  `applyOp` use) when the pair isn't linkable — wrong track kind, already
  linked, a locked track. The existing `avLinkedIds` link highlight needed
  no changes, it already re-derives live from `link_group`. Interaction
  model re-confirmed as `av-linking.md`'s option (b) — permanent link +
  explicit unlink, no Premiere-style toggle — not reopened without cause.
- **2026-09-04** — **`position_x`/`position_y` become normalised composition
  fractions, with a real migration, and the Edit tab gets real on-canvas
  drag/scale handles (D-136, B-043 closed).** Phase 0a's code, left undone by
  D-132: the compositor's canvas is now the project's own composition
  (`ProjectSettings.width`/`height`, or the first clip's probed resolution),
  not the top layer's decoded size, so a PIP overlay no longer moves or
  resizes when you press Play. Existing pixel-valued positions are migrated,
  not silently reinterpreted — `chroma.project`'s schema gained a minor
  (`1.1`), gating a one-time, non-idempotent reinterpretation of old values as
  composition pixels (every clip nobody ever offset migrates to bit-identical
  zeros). A new `chroma_timeline_clip_geometry` command reports a clip's
  source footprint in composition space. Landed alongside it: `TransformOverlay.tsx`,
  Phase 1's real select/drag/corner-scale handles over the Edit-tab preview —
  a DOM overlay (`@apelles/player`'s new `useContentBox`) with live
  overlay-only feedback while dragging and one `set_clip_transform` op on
  release, the same pattern `RelightPuckLayer.tsx`/D-046 already used.
- **2026-09-04** — **"Play and pause restart the audio, just audio": every
  session was starting at 0:00 (D-133, B-052).** Not a D-130 regression, and not
  D-050's by-design fresh-session-per-Play being misread — audio was literally
  decoding from the head of the file on *every* Play, at any playhead, while the
  picture (which seeks through `ffmpeg`) carried on correctly. `open_source` and
  `decode_mono_range` threw away `symphonia`'s seek result, and on the owner's
  own camera original that seek fails every time: `symphonia-format-isomp4`
  seeks every *other* track first with `?`, and that MOV carries an ordinary
  metadata track exactly one 24 fps frame long, so anything past 0.042 s is
  out-of-range for it. Measured, not inferred — `decode_mono_range` at 0 s, 60 s
  and 120 s returned byte-identical samples. Sources now reach their start time
  by trimming on the packets' own timestamps (correct whether the seek succeeds,
  fails, or lands early); the seek is kept only as the fast path and its failure
  is logged instead of swallowed. Catch-up measured at 56 ms to 60 s / 249 ms to
  300 s on that 2.3 GB file. Still not verified by clicking Play in the
  assembled app — the same honest gap D-125/D-130 disclosed.
- **2026-09-04** — **Video export really applies the Colorist's geometry
  (D-135, B-042 closed).** D-127 made a cropped export refuse; this makes it
  work. `grade_frame` now runs `apply_all_transformations` — the same CPU
  pre-pass the live preview and the still export run — and builds its mask
  bitmaps at the transformed size with the real crop offset instead of a
  hardcoded `(0.0, 0.0)`, so export and preview finally agree about where a
  mask sits. The encoder is spawned **lazily, from the first graded frame's
  measured dimensions**, so a crop or a 90° step really changes the encoded
  size and that number can't drift from the pass that produced it. D-019's
  tracked mattes needed no change (their alignment code already un-does
  crop/rotation/flip; its parenthetical is corrected in place). `yuv420p`'s
  even-dimension requirement is now a written rule — round **down** to a
  multiple of 2 for every codec, trimming ≤1 row/column rather than padding
  or resampling — which also closes an odd custom export resolution reaching
  libx264 (D-049). The lens blur and parametric `color`/`luminance` masks,
  dropped by the same omission, work on video export too.
  `unsupported_geometry` is deleted; the only remaining refusal is a crop
  that rounds to zero. Verified with real ffmpeg encodes probed back (a
  100×60 crop lands at 100×60 and matches the source's own cropped frame 0
  pixel-for-pixel, byte-identical across two runs) plus 13 GPU-free pixel
  tests; `chroma::` 231/231, `apelles-timeline` 111/111. No live-window
  verification possible in this sandbox (disclosed in D-135).
- **2026-09-04** — **Player seek/volume sliders were invisible from a
  Tailwind `data-*` variant typo, not a missing token; Sources toggle still
  overlapped "Timeline" because D-126 only fixed legibility (D-131, B-050,
  B-051).** `slider.tsx`'s Track/Indicator used `data-horizontal:`/
  `data-vertical:`, which compiles to a check for a literal `[data-horizontal]`
  attribute Base UI never sets (it stamps `data-orientation="horizontal"`) —
  confirmed by compiling this app's real `styles.css` through
  `@tailwindcss/node`, not guessed. Fixed to `data-[orientation=horizontal]:`/
  `data-[orientation=vertical]:`; also fixed `Player.tsx` passing both sliders
  a bare number instead of a single-element array (was silently rendering 2
  stacked `Thumb`s instead of 1). Separately, `Player.tsx`'s title strip now
  reserves `pl-10` to clear the Sources toggle's real 32px footprint, instead
  of D-126's untouched uniform `px-3`. `packages/editor`/`packages/player`
  `tsc` clean, `packages/editor` vitest 201/201; no live-window verification
  possible in this sandbox (disclosed in D-131).
- **2026-09-04** — **The Edit tab has a real crop, and Phase 0a's unit
  question is answered (D-132, B-053, B-054).** Owner, live: "no UI for
  crop", "no canvas on player to do it". The crop half is built:
  `Clip.crop_left`/`crop_top`/`crop_right`/`crop_bottom` — four normalised
  0–1 insets into the clip's **own source**, so they are correct at every
  preview decode scale by construction rather than needing the
  composition-space fix first — really applied by `composite_layer_onto`
  (crop first, and **in place**: alpha cleared, footprint kept, so the
  picture doesn't re-centre and rotation keeps its pivot), with a real Crop
  section in the Inspector and keyframes for free through the existing D-034
  engine (flat scalars rather than a nested rect precisely so that
  interpolator can reach them). The **on-canvas half is not built** — no
  drag handles, no Resolve-style mode toggle; that is Phase 1 of
  `docs/notes/on-canvas-transform.md` and it needs an overlay substrate that
  doesn't exist yet. Phase 0a's open unit question is now closed
  (**normalised, against `ProjectSettings.width`/`height`**, adopting the
  scoping doc's own recommendation), but its `position_*` migration is
  unwritten and **B-043 stays open**. Found and fixed on the way: **B-053**
  — the preview's single-layer fast path skipped compositing
  unconditionally, so a lone clip's opacity/position/scale/rotation were
  written to disk, read back into the Inspector, and never applied to a
  pixel. Also **B-054**, a test pinned to the owner's live `project.json`
  that had been failing on `main` since they first used A/V linking. Not
  verified in the assembled window — same environment constraint
  D-125/D-127/D-130 each disclosed.
- **2026-09-04** — **The zoom step itself: one storage level for the whole
  fine band, so a level change is a decimation and not a decode (D-134,
  B-049, B-055).** Owner, after D-124/D-128: everything fast now *except*
  clicking zoom. Measured, not assumed — a fine filmstrip chunk costs the
  same to decode at 0.0625s spacing as at 0.5s (8s of the owner's 4K HEVC is
  ~2.15s either way; the real shape is ~0.8s of ffmpeg spawn plus ~0.24s per
  second of source), so D-128's four fine LOD levels were paying full price
  four times for the same seconds — and awaiting a viewport's five chunks
  one at a time while two of three semaphore permits sat idle. Every fine
  level is now decoded once at the finest rung and the rest decimated from
  it (exact, because the ladder is powers of two), a request's chunks load
  concurrently, and a coarse chunk is derived free from cached finer ones.
  **A fine-band zoom sweep over an already-decoded range: 31.3s → 0.001s**;
  the cold first window 9.45s → 7.15s. B-055 found and fixed alongside: a
  window overrunning the source used to lose its whole filmstrip, not just
  the out-of-range tail. Not confirmed in the assembled Tauri window — same
  honest gap as D-124/D-128.
- **2026-09-04** — **Timeline-header overlap fixed, real master mute/volume
  added, real fullscreen wired (D-126).** The Sources/Inspector floating
  toggles (D-118/D-120) now render as elevated chips
  (background+border+shadow) instead of transparent `ghost` buttons, so
  they no longer visually crowd Player's own title strip. `Player.tsx`
  gains a real `muted`/`onMuteToggle`/`volume`/`onVolumeChange` control
  backed by a new lock-free backend primitive, `chroma_audio_set_volume`
  (separate from D-057's persisted per-track `gain` — this is unpersisted
  monitoring volume only). The fullscreen button, previously unwired by any
  caller, now uses the real browser Fullscreen API with `fullscreenchange`
  sync so Esc-driven exits stay in sync. `packages/player` `tsc` confirmed
  clean; `packages/editor`/`packages/shell` `tsc` and interactive
  verification were blocked by genuine concurrent sibling-worktree build
  load and are disclosed as an honest gap in D-126.
- **2026-09-04** — **"The voice loops / overlaps a couple of seconds": the
  audio session was being restarted mid-playback, and D-125 took away the
  ordering that made restarts safe (D-130, B-047, B-048).** Direct follow-up to
  D-125, against a binary rebuilt after it. The repeat is not one session
  playing twice — the prefill and the ring FIFO were read and cleared of that —
  it is **two sessions starting a moment apart from two different playheads**:
  `PreviewPane`'s audio effect was keyed on the `timeline` *object*, which
  `load()` replaces on every window `focus` (i.e. on the click that starts
  playback) and every edit. D-125 then made both audio commands `(async)`,
  which — traced through `tauri-macros` into `tokio::spawn` — removed the
  main-thread FIFO ordering the play/stop protocol depends on, so those
  restarts could land in any order; a stale play winning means audio starts from
  a playhead the picture has already passed. Fixed by keying the effect on
  whether a timeline exists, and by stamping every transport command with a
  monotonic `seq` that Rust uses to drop overtaken requests. Also fixed (B-048,
  pre-existing): a source streamed to the end of its **file** rather than its
  clip's out-point, so a short clip's audio played on underneath the picture
  that had cut away from it. 8 new tests, each confirmed to fail against the
  pre-fix behaviour. Not verified in the assembled window — same gap D-125
  disclosed.

- **2026-09-04** — **Play took 2-3 s and the audio lagged: one decode pipe
  serving N compositor layers, and an audio clock that started late
  (D-125, B-040).** The suspected cause — contention with the filmstrip
  thumbnails — was measured and disproved: with no thumbnail work running
  at all, a single composited preview frame still cost **618-660 ms**, because
  `decode_pipe` kept one global `ffmpeg` process while D-088's compositor
  decodes every visible layer through it, respawning per layer per frame.
  A `PipeSlot`-keyed pool (one per video track, released when a layer goes
  away) takes that to **23-31 ms/frame**, measured back-to-back under
  identical load. Separately, `run_session` started
  the `cpal` stream before opening its sources, so the ring's untimestamped
  head silence left audio permanently **157-635 ms** behind the picture —
  now measured and compensated before the device starts. Also: the heavy
  preview/audio commands moved off Tauri's main thread, `-hwaccel` in the
  decode pipe, and one preview resolution for scrub and play (the split was
  respawning every pipe on each Play toggle). B-041 logged, not fixed: an
  audio-only clip on a real `Audio` track still fails `chroma_audio_play`.

- **2026-09-04** — **"Do we support crop?" answered end to end, and
  on-canvas PIP handles scoped (D-127, B-042, B-043,
  `docs/notes/on-canvas-transform.md`).** Crop is **real in Colorist**
  (routed panel, applied in the preview — including on a video frame — and
  on a still export), **absent in the Edit tab** (no field on `Clip`,
  nothing in the compositor), and was **silently discarded on a video
  export** along with straighten, flips, 90° steps and the lens warp:
  `grade_frame` never ran the CPU geometry pre-pass, and the guard meant
  to catch that was unreachable by construction. Video export now refuses
  up front and names the offending controls (6 unit tests); actually
  honouring the geometry is queued work, not a tweak. Scoping the drag
  handles also turned up **B-043** — the Edit-tab composite's coordinate
  space is preview-resolution-dependent, so a PIP overlay moves *and*
  resizes when you press Play, a hard prerequisite before any handles get
  built. Handles are planned, not built: the preview is a plain `<img>`,
  not a canvas, so they're a DOM overlay writing the same
  `set_clip_transform` op the numeric Inspector already writes.
- **2026-09-04** — **Persistent, disk-backed media caching + windowed LOD
  filmstrips + the full-resolution decode nobody ever saw (D-128,
  B-044/B-045/B-046).** Owner, live: "we are doing actions which can be cached
  again and again... most editors do it already" and "if you are loading 4k
  that might be wrong." Both right, and two different defects. **(1)** Every
  cache in the codebase was a process-local static, so every relaunch re-ran
  every `ffprobe`, re-decoded every filmstrip and re-decoded every waveform —
  now `chroma::media_cache`, a source-keyed (`blake3(path‖mtime‖size)`) disk
  cache under `app_cache_dir()/chroma`, following RapidRAW's own thumbnail
  cache and real NLE precedent (Premiere's `.cfa`/`.pek`, Resolve's
  `CacheClip`). **(2)** Project-open decoded a full 3840×2160 frame per clip,
  ~1.9s each, and discarded every one unseen. **(3)** The filmstrip is now
  windowed level-of-detail extraction over the visible scroll range — the gap
  D-124 named and deferred, and the shape persistence wanted anyway:
  **727px/tile → ≤50px** at default zoom on the owner's 517s 4K clip, and a
  16s window goes **5.41s cold → 0.007s warm-from-disk**, against 9.5s every
  time for the old whole-clip strip. **(4)** The waveform had no cache at all and re-decoded a
  clip's whole audio on every zoom step, on the main thread. Critical-path
  catalogue: `docs/notes/media-cache.md`.
- **2026-09-04** — **Dropping a clip now creates a real, linked audio clip on
  its own track (D-129).** The owner's ask ("in palmier and other anytime i
  drop a clip it… created a linked track in audio"), which needed the exact
  model change `docs/notes/av-linking.md` had flagged as a prerequisite and
  deferred: a video clip's embedded audio is a separate `Clip` now, not just a
  stream D-050 decoded off the video source. `Clip.link_group` (group-based —
  and on a video clip it also means "don't play the embedded stream", which is
  what stops the same audio summing with itself); one atomic `add_clip` places
  both halves, with the audio track found-or-created through the existing
  `add_track` mechanism; `MediaVideoInfo::has_audio` fills the signal gap
  D-097 flagged, backfilled once for existing pool items. Move, trim, split
  and delete propagate across a link group or reject whole (B-033's own
  discipline); `unlink` dissolves the complete group. Reference-checked
  against Premiere, Resolve and Palmier's `manage_clip_links` — including one
  place the references overruled the scoping doc's own recommendation (trims
  propagate). Pre-D-129 clips are unlinked and behave exactly as before, with
  no retroactive migration, deliberately.
- **2026-09-04** — **The filmstrip's real cost: one 105-second decode per
  clip, re-triggered on every zoom step (D-124, B-039).** Round 3 on
  D-119's filmstrip, run empirically after two rounds of reading missed
  it. `extract_thumb_strip_range` decoded every frame of a clip's range
  and threw ~99.5% away — measured 105.5s for the owner's 517s 4K clip —
  while `count` was derived from on-screen width, so a zoom sweep fired
  four more of them and blanked the strip each time. Anything queued
  behind them (a short clip's one-second strip) waited minutes with no
  error and no log line, because nothing logged a *slow* decode. Now
  keyframe-only decode above a measured threshold, `fps=` time-based
  sampling (also fixes VFR sources), thumbnails at 2x the row height
  instead of 150px, and a fetch keyed on clip duration rather than pixel
  width — **105.5s → 9.27s**, and a 59-step zoom sweep went from one
  backend call per bucket to 2 total. Real decodes now log, too.
- **2026-09-04** — **Fixed two `chroma::project` tests red on `main` since
  D-123 (B-038).** Both still asserted the pre-D-123 "empty tracks
  persist" contract; one panicked outright. Found by re-running the clean
  tree to check whether D-124's own failures were pre-existing.
- **2026-09-04** — **Sources panel's opener moved to the corner it actually
  opens into (D-120).** D-116 moved the panel to the left but left its
  toggle stranded in the chrome bar's top-right — now a `top-2 left-2`
  button over the tab content, mirroring the Inspector's own `top-2
  right-2` toggle (D-118) instead of crowding the same corner as it.
- **2026-09-04** — **Capped concurrent filmstrip `ffmpeg` decodes + hardware
  decode (D-121, B-037).** A real live incident: opening a multi-clip
  project spawned 11 simultaneous `ffmpeg` processes, system load past
  200. A `Semaphore(3)` caps concurrency; `-hwaccel videotoolbox` (with a
  real software fallback) cut a single 4K HEVC decode from 393% CPU/~5s to
  38% CPU/~3.3s, measured directly. Also fixed the paired silent-failure
  bug: a missing thumbnail now logs a real error instead of swallowing it.
- **2026-09-04** — **Removed the redundant dashed drag-landing box
  (D-122).** Now that the drag ghost shows real filmstrip content, the
  separate `border-dashed` landing-position box was drawing the same
  information twice — owner: "we have 3 things... let's remove the dot."
- **2026-09-04** — **Auto-decommission an empty track (D-123).** A track
  emptied by `remove` or a cross-track `move` is now pruned automatically
  and the rest renumber — narrowly scoped to only the directly-edited
  track (checked live: neither Premiere nor Resolve auto-removes by
  default, both need an explicit action), with real index-remap coverage
  for `Selection`/`SelectedGap` so nothing points at a stale track index.

- **2026-09-04** — **Real filmstrip thumbnails on Edit-tab timeline clips,
  in the drag preview too (D-119).** Video clips now show their actual
  source content tiled across the clip (`Filmstrip.tsx` +
  `chroma_clip_thumbnails` → `video::extract_thumb_strip_range`, one
  `ffmpeg` decode pass scoped to the clip's real trimmed range, not the
  whole source file), layered under a translucent waveform strip. The
  `DragOverlay` ghost for a clip drag shows the same real content now
  instead of a generic text pill.
- **2026-09-04** — **Auto-create-a-track-on-drop, restored for dnd-kit clip
  moves (D-117, B-036).** D-100's rewrite moved clip repositioning onto
  `@dnd-kit/core` but never carried over "drop past the last track (or
  above the first, or between two) auto-creates one" — `TrackDropZone`
  only ever registered a droppable per existing track, so the drag
  silently cancelled. Now computes the same insertion boundary the
  legacy Sources-panel path already uses, from the dragged clip's own
  live rect instead of a droppable — one shared boundary concept, not
  two to keep in sync.
- **2026-09-04** — **Edit tab's Inspector is now a real full-height panel (D-118).** Extracted `ClipInspectorPanel` out of `TimelinePane.tsx`'s own internal split (where its height was capped at the timeline's 46%-tall row) into a new sibling, `EditorInspectorPanel.tsx`, rendered by `EditorTab.tsx` as a `ResizablePanel` spanning the tab's full height — the same treatment D-116 gave Sources, on the other side. `selection`/`selectedGap` moved from `TimelinePane`'s local state into `useEditorTimelineStore` so both components read one shared selection. Stayed tab-local (a button in the Edit tab's own corner), not a `Shell.tsx` chrome-bar addition — Colorist and Motion each already have their own always-visible right panel, and Sources' shell-level slot is specifically because it's one real shared resource across all three tabs, which the Inspector isn't.
- **2026-09-04** — **Manifest read caching + a drop-target fix (D-114/D-115,
  B-035).** `chroma::edit::resolve_timeline` (the per-preview-frame hot path)
  no longer re-reads and re-parses `project.json` from disk when nothing has
  changed since the last frame — an mtime-validated in-memory cache, measured
  **18.4x faster in the steady state** (682µs/call → 37µs/call, real test,
  not a claim). Separately: fixed a real `dropTargetTrack`/preview
  inconsistency that could let a Sources-panel drop land on a track never
  shown in the preview, and widened the insert-snap radius (16→28px) for a
  more forgiving drop target.
- **2026-09-04** — **Sources panel moved to the left, made a real resizable panel (D-116).** Matches the media-bin-on-left convention every professional NLE reference (including Palmier Pro) uses. Was a fixed 288px `div` on the right — a real, previously-unnoticed violation of the "everything resizable-by-nature must actually be resizable" rule; now a `ResizablePanel` (default 288, min 220, max 480). No tab package needed a change — each one's own properties panel already anchors independently to its own right edge.
- **2026-09-04** — **Cross-track drag preview is now honest (D-113).** Two
  related follow-ups to D-111 on the same live-testing session: the
  full-row drag-over wash is gone, replaced by a precisely-sized/
  positioned placeholder matching the clip's real duration and real
  resolved landing frame (reusing the same `resolveClipLanding` math the
  actual drop applies); sync-linked clips on other tracks now render a
  live shifted ghost during the drag itself, not just a static highlight
  at selection time. Real horizontal row separator lines added too (the
  library draws none itself).
- **2026-09-04** — **"No project open" (5th occurrence): fixed the screen that
  was misreporting all five, not just the fifth cause (B-034/D-112).** The
  common factor across B-004/B-025/B-031/B-032 was never any one of them — it
  was `EditorTab` reporting *any* failed `chroma_timeline_get` as "no project
  is open", while the shell above it showed the tab bar precisely because one
  was. `projectOpen` is now pushed down from the app's own source of truth and
  is the only thing that can produce that message; `load()` gained a monotonic
  token (a stale failure can no longer clobber a fresh success), a timeout for
  lost IPC responses, and a bounded retry ladder replacing D-085's 500ms
  one-shot. Two real faults found underneath: `save_manifest` was a non-atomic
  `fs::write` torn by the app's own per-frame `load_manifest` reader (**25%
  torn reads measured**; now temp-file + rename, 0/2000 against the owner's
  real project), and **D-108's `safeUnlisten` fix never worked** — it caught a
  sync throw where Tauri actually rejects a promise. Occurrence #5's own
  trigger was a concurrent agent HMR-reloading the owner's live app 3s after a
  successful open: a process problem, not a code one.
- **2026-09-04** — Restored the Rust test build on `main`: D-107/D-109's
  `Track::sync_locked` and D-104's `move_clip(…, ripple)` never updated the
  test initializers in `chroma/project.rs` / `chroma/audio.rs` (10 compile
  errors — `cargo test` couldn't run at all).
- **2026-09-04** — **"Hangs so much" audit (D-111): one redundant IPC round-trip
  cut, sync-lock gets real visual language.** Measured, not assumed —
  `applyOp` was already optimistic; the real hang was mostly this session's
  own 4x-oversubscribed system load (a real 87ms write for an 8KB file
  proves it), plus one genuine fix: `_flushSave` no longer refetches after
  every save (`chroma_timeline_set` stores verbatim, so the refetch was
  pure redundant latency). Sync-lock's silent B-033 rejection ("gap select
  does not work") first got a toast, then the owner redirected to real
  visual language instead — reverted the toast cleanly, shipped
  muted-clip-on-locked-track + a secondary "sync-linked to this selection"
  ring (`syncLinkedClipIds`) instead.
- **2026-09-04** — **Cross-track sync-lock reverted from auto-split to
  reject-on-straddle after confirmed real data corruption (B-033/D-109).**
  D-106/D-107's auto-split let repeated real ripple operations keep
  re-splitting an already-split fragment — confirmed on the owner's actual
  `New.chroma` project (a clip id duplicated 3x on one track, another split
  into 4 slivers, total duration growing after closing a gap). Reverted to
  D-104's own proven-safe reject-on-straddle contract, generalized
  cross-track, checked upfront at all three ripple call sites before any
  mutation. New regression tests apply the rejected op 5x in a row and
  prove zero fragmentation. Real feature loss, deliberate: sync-lock now
  blocks a ripple when a straddling clip sits on a synced track — auto-split
  may return as its own separately-scoped, separately-verified follow-up.
  The owner's real project file is confirmed corrupted on disk with no
  clean automated recovery; manual rebuild through the UI is the
  recommended path — underlying media is untouched, only clip-position
  bookkeeping was corrupted.
- **2026-09-04** — **A third, distinct root cause behind "No project open"
  found and fixed (B-032/D-108).** Tauri listener cleanup (`unlisten.then((f)
  => f())`) could throw when Vite's dev-mode HMR reloaded mid-flight,
  corrupting the IPC bridge — Tauri's own console warning names the exact
  scenario. Dev-mode-only (no HMR in production), but frequent enough this
  session (many concurrent forks editing files against one shared dev
  instance) to repeatedly masquerade as the project-open bug already fixed
  twice under different real causes (B-004, B-031). Fixed with a shared
  `safeUnlisten()` helper across all 6 real call sites. Idle-window
  verified (150s+, zero recurrence); honestly flagged as not
  force-reproduced on demand.
- **2026-09-04** — **Multi-select Phase 1 + cross-track ripple/sync-lock,
  built (D-107).** `Selection` is a real array now (shift/cmd-click,
  generalized Remove/Split); `Track.sync_locked` (default on) makes a
  ripple on one track shift every other synced track too, auto-splitting a
  straddling clip rather than blocking the ripple (the owner's call,
  reversing D-106's own first-pass "reject" recommendation) with a real
  ripple-flash so it's never silent. 73/73 Rust + 115/115 TS tests;
  real-window interactive verification not achieved this pass, disclosed
  honestly. Roadmap items 11/12 marked done.

- **2026-09-04** — **Real scoping docs for the audit's top 3 gaps (D-106):
  multi-select, cross-track ripple/sync-lock, A/V linking.** No code —
  three real design docs (`docs/notes/multi-select.md`,
  `cross-track-ripple-sync-lock.md`, `av-linking.md`), each grounded in
  live-checked references (Resolve's Sync Lock, Premiere's Linked
  Selection, Palmier's own `manage_clip_links`/`manage_tracks` tools).
  Multi-select's "just extend the click handler" first read didn't survive
  tracing every real consumer — scoped with a phased plan instead of built
  blind, matching the judgment applied to the other two. Roadmap items
  11-13 updated to point at the docs.

- **2026-09-04** — **Gap select + delete (ripple close), and a real
  timeline-feature research audit (D-105).** Empty track space is now a
  real, selectable thing — click a gap to select it (a dashed overlay
  tracks the exact bounds), Delete/Backspace or a new "Close Gap" toolbar
  button closes it, rippling every later clip on that track earlier by the
  gap's width. The deliberate mirror image of `remove`'s existing Lift
  behavior. `Track::gap_at`/`Timeline::remove_gap` (Rust) mirror
  `gapAt`/`remove_gap` (TS) field-for-field. Verified against the real
  rendered component via a scratch Chrome-driven harness, not just unit
  tests (67/67 Rust, 108/108 TS). Also: `docs/notes/timeline-feature-
  audit.md` — the actual timeline code audited feature-by-feature against
  Premiere Pro's and DaVinci Resolve's own docs plus Palmier Pro's real MCP
  tool surface, with a prioritized recommendation (multi-select, then
  cross-track ripple/sync-lock, then real A/V linking).
- **2026-09-04** — **Unified clip-move placement, reversing D-096: overlap
  is never a reachable outcome of a plain drag (D-104, B-030).** Cross-track
  move used to reuse a clip's own `start_frame` verbatim (ignoring where it
  was actually dropped) and D-096 had made cross-track overlap an explicit
  allowance — together, dragging a clip onto another track could land it
  stacked directly on top of whatever was already there. New
  `resolveClipLanding` wraps `computeInsertion` (the same "where does this
  fit" algorithm a new clip from Sources already gets) for an EXISTING clip
  being moved, used by both the drag path and the "Move to ▾" dropdown.
  `move`/`move_clip` gain `ripple`, mirrored TS/Rust: overlap is now
  rejected for every move, same-track or cross-track, unless `ripple`
  shifts the way clear (same contract `add_clip` already has). A real edge
  case (a clip straddling the landing point) is explicitly rejected rather
  than left silently still-overlapping. `packages/editor` 91→100 tests,
  `apelles-timeline` 60→61, `cargo clippy -p apelles-timeline` clean. The
  `chroma_timeline_move_clip` Tauri command's signature update (a
  zero-caller command) could not be `cargo check`-verified — blocked by an
  unrelated, concurrent-session in-progress `tauri-plugin-wdio` permission
  mismatch, not anything touched here.
- **2026-09-04** — **Real sidecar ownership: content-hash staleness
  detection (D-101, roadmap item 9).** `ai/server.py` now reports a
  `content_sha256` of its own bytes in `/health`; `chroma::sidecar` computes
  the same hash and flags a mismatch (`SidecarStatus.stale`) instead of
  trusting any 200 forever — the actual D-069 gap. Policy: refuse-and-warn
  only, never auto-kill an external process. Re-checked live on the
  existing 10s poll, not just at boot. New "AI Sidecar" status card in
  Settings — `chroma_ai_status`'s first real consumer. Live-verified
  against the session's own genuinely ~6hr-stale sidecar (killed, restarted
  with the new code, watched the supervisor correctly report "no longer
  stale" with no false positive). One incident: a manual `cargo clippy` run
  collided with the dev server's own auto-rebuild watcher and corrupted
  `target/debug` — recovered via the documented `rm -rf target/debug` +
  rebuild.
- **2026-09-04** — **Global Inspector Phase 3: NLE clip properties
  (D-102).** `ClipInspectorPanel.tsx` — a persistent transform + keyframes
  panel for the selected Edit-tab clip, replacing D-090's popover outright
  (removed, not kept alongside — same fields/ops, no benefit to two
  controls). Added to `TimelinePane.tsx` only after the concurrent
  drag-and-drop work (D-100) finished. Backward-compat verified against a
  scratch harness and the owner's own real project file. Drafted as
  D-101, renumbered after the sidecar-ownership pass above claimed it
  first.
- **2026-09-04** — **Global Inspector Phase 4: the shared shell, closing out
  the whole effort (D-103).** New tiny package `@apelles/inspector` — just
  `InspectorEmptyState`/`InspectorSection`, the two pieces Motion's and the
  NLE's Inspector panels had genuinely converged on identically. Not a full
  merge: the two panels' selections/fields/ops stayed different enough that
  forcing one component would mean rewriting working code for no benefit;
  resizable-panel wrapping and `Selection` both stayed package-local for the
  same reason (`Shell.tsx` already keeps every tab mounted, so there was no
  real cross-tab gap to close). Verified live, both panels side by side,
  post-refactor — no regression in either. All 4 phases of the Global
  Inspector now done.
- **2026-09-04** — **Unified clip move onto ONE mechanism; fixed the real
  root cause of D-098's stuck-ghost/blocked-drag cluster (D-100, B-029).**
  A stuck `activeDrag` after an interrupted drag left `TrackDropZone`'s
  `pointer-events-auto` on forever, silently blocking every click/drag on
  that whole track row — that's what "can't drag in the same track"
  actually was, not same-track drag itself breaking. Fixed by making that
  overlay `pointer-events-none` unconditionally (never needed for dnd-kit's
  own rect-based collision detection) and unifying same-track + cross-track
  clip move onto ONE `useDraggable` covering the whole clip (`ClipBody`),
  with the library's native move-drag disabled (`movable: false`, edge-trim
  untouched) — no more two systems racing for one gesture. Also: a real
  dnd-kit-internal-state bug (an interrupted drag left the NEXT real drag
  on the same pointer silently inert; fixed with a genuine synthetic
  `pointercancel` dispatch on window blur, not just local state reset);
  `computeInsertion`/`nearestEdge` now resolve a drop anywhere on an
  existing clip's body (not just a pixel-precise seam), fixing
  ripple-insert between already-touching clips; click-outside-to-deselect;
  selected-clip contrast (a ring, not a background/text-colour swap that
  was using the wrong token). 91/91 tests, `tsc`/`vite build` clean.
- **2026-09-04** — **Track reorder + cross-track clip move moved onto
  `@dnd-kit/core`/`@dnd-kit/sortable` (D-098, B-028).** Native HTML5 drag
  failed live a second time (cross-track clip move, after track reorder)
  despite passing this session's Chromium-only checks — owner greenlit
  implementing the dnd-kit scoping doc's phase 1 plan for real. Same-track
  drag/trim/resize untouched (the timeline library's own native
  mechanism, never what was broken). Two real bugs found and fixed during
  implementation (a React-synthetic-event same-element-handler ordering
  issue; a droppable-registration timing issue); re-checked D-064's
  `dragDropEnabled` fix first and ruled it out. Verified against the real
  component under real `<StrictMode>` with real `PointerEvent` sequences
  (not just the Chromium harness alone this time) — dnd-kit issue #2116's
  StrictMode bug does not reproduce on the installed version. Still not a
  real Tauri/WKWebView window — flagged explicitly, not claimed closed.
  `tsc`/vitest/vite build clean (88/88 tests, 64-error app baseline
  unchanged, one new safe React-Compiler bailout accounted for).
- **2026-09-04** — **Global Inspector Phase 2: a real Motion property panel
  (D-099).** Typed form bound to the layer-list selection across all 8
  primitives, JSON fallback for content-shaped props, a real camera
  keyframe-list editor, a resizable right-hand panel cluster. Reads/writes
  the manifest immutably and degrades gracefully on a stale/unrecognized
  selection — verified against real, already-existing manifests (the
  owner's explicit backward-compat requirement) via a scratch Chrome-driven
  harness, not just unit tests. `packages/motion`'s first test harness
  (18/18). Phase 3 (NLE half) found to be newly unblocked (B3 shipped as
  D-088) but deliberately not started — would need `TimelinePane.tsx`,
  in active use by concurrent dnd-kit work all session.
- **2026-09-04** — **Mid-stack track insert, kind inference, a real
  cross-track clip-move handle, cross-track overlap allowed (D-096,
  B-027).** Continuing D-095's own live-testing session: a track can now
  be inserted at ANY boundary (above the first, between two, or past the
  last), not just past-the-last; an auto-created track infers its kind
  from the adjacent track instead of a hardcoded `'video'` literal
  (verified `DraggedMedia` carries no real audio/video signal to derive
  from directly); the cross-track clip-move handle is now a full-width
  top strip instead of a small corner icon; `move`/`move_clip` now allow
  cross-track overlap (a real composited layer since D-088), same-track
  overlap still rejected. **Caught and fixed a live regression in the same
  pass**: the wider handle made an ordinary same-track drag an easy
  accidental grab of the cross-track mechanism, which used to silently
  no-op on a same-track drop — now handles it as a real reposition
  instead. Also: `docs/notes/dnd-kit-migration.md`, a real scoping doc
  (not implemented) for the owner's `@dnd-kit` steer — MIT, active repo,
  but no npm release since 2024-12 and an open React-19-StrictMode issue
  against the in-progress rewrite, which this app's `<StrictMode>` root is
  actually exposed to. Rust `apelles-timeline` 59/59, `packages/editor`
  88/88, `tsc` + `vite build` clean.
- **2026-09-03** — **Four real gaps in D-094's drag-and-drop, found live
  (D-095, B-026).** Sources-panel drops now snap/ripple-insert between
  existing clips (`computeInsertion`, `timeline.ts` — the one place this
  model intentionally gains ripple behavior) with a live insertion-line/
  new-track-ghost preview; dropping a clip past the last track row auto-
  creates one (the manual "+ 🎞"/"+ 🎵" toolbar buttons are gone); both
  drag handles' hit targets grew + got an explicit `-webkit-user-drag`
  hint for Tauri's WKWebView (D-094's track-reorder logic was verified
  correct via a real Chromium drag against a new isolated-component
  harness, but couldn't be closed-loop-verified on WKWebView itself); the
  Sources-panel drag ghost is now a small name pill instead of the full
  media card. 88/88 tests (+9), `tsc` + `vite build` clean.
- **2026-09-03** — **Real drag-and-drop for the NLE timeline + resizable
  header sidebar (D-094).** `TimelinePane.tsx`: track reorder is now a
  `GripVertical` drag handle per header row (replacing D-090's up/down
  buttons; generalized `move_track` selection-follow math, not just
  adjacent swap); cross-track clip move is a real drag handle on each clip
  (`CHROMA_CLIP_MOVE_MIME`, same drop mechanism as the existing
  Sources-panel drop) — the old "Move to ▾" dropdown stays as a fallback
  since the live drag gesture couldn't be exercised against the native
  window this session. The track-header sidebar is now a real
  `@apelles/ui` `ResizablePanel` (was a fixed `width: 156px`) — the first
  live use of that component, applying the owner's new standing
  "resizable-by-nature panels" `CLAUDE.md` rule. 79/79 tests, `tsc` +
  `vite build` clean.

- **2026-09-03** — **Local-only user-action telemetry infrastructure
  (D-093).** New `trackEvent(event, props?)` in `@apelles/bridge`, reusing
  the existing `frontend_log` Tauri command (`[telemetry]` prefix, JSON
  payload, lands in `app.log` — no network call, no new storage). Wired
  into tab switches, project open/new/close, and relight actions (add/
  delete light, apply preset, bake depth/normals, track depth). NLE track/
  clip actions deliberately deferred — a concurrent fork is reworking
  `TimelinePane.tsx`'s drag-and-drop — tracked as a follow-up in
  `docs/notes/telemetry.md`, which also has the adoption checklist for
  wiring up a new surface.

- **2026-09-03** — **Sidecar memory: real observability + TTL auto-unload
  (D-087).** Diagnosed a reported 5.78 GB sidecar process — not a leak (the
  process itself was already gone; `_free_gpu()`, B-002, is correctly
  called everywhere), but a real gap: loaded models (SAM2/YOLO/ViTMatte/
  Video-Depth-Anything/MoGe-2) were never released. New `GET /memory`
  (RSS + per-model loaded/idle status) and a background TTL sweep that
  auto-unloads anything idle past 5 minutes, safe against the existing
  `_GPU` lock; `POST /unload` for a manual reclaim. Verified live end to
  end (load → idle → auto-unload, watched `/memory` and RSS the whole way).

- **2026-09-03** — **Fixed: Edit tab stuck on "No project open" after a
  real, successful open; opening a project had no loading feedback (D-085,
  B-025).** Project cards now show a real spinner while opening and disable
  during it (closes a confusing "session busy" double-click race); the Edit
  tab's own load now retries once if it lands on a stale error state.
- **2026-09-03** — **Fixed: dragging a clip in the Edit-tab timeline froze
  the UI (D-083, B-024).** Five callback props to the timeline library were
  inline arrow functions (new identity every render); a native drag fires
  `dragover` continuously, so every tick forced a full re-render of every
  clip across every track. `useCallback`-wrapped with real dependency
  arrays; a pre-existing pattern that only became a felt freeze once
  multi-track (D-080) made the cost scale with track count.
- **2026-09-03** — **Global Inspector, Phase 1: Motion tab gets a real
  scene/layer sidebar (D-081).** Wrote a real scoping doc first
  (`docs/notes/global-inspector.md` — a 4-phase build + the complete
  verified prop catalog for all 8 primitives), since unlike the multi-track
  UI this had none. Built the genuinely unblocked prerequisite: a
  `LayerList` sidebar + selection model, wired to seek the preview player to
  whatever scene/layer is selected — real navigation on its own, ahead of
  the actual property panel (Phase 2, next).

- **2026-09-03** — **Multi-track timeline UI (D-080, Phase D of the
  multi-track NLE effort).** The Edit tab now shows a real lane per track —
  custom header sidebar (kind icon, per-kind label, mute toggle, remove),
  add-video/add-audio-track buttons, and a "Move to ▾" dropdown to move a
  clip between tracks (the timeline library has no native drag-between-rows,
  confirmed before assuming otherwise). Confirmed N-track compositing
  actually works past 2 tracks first (was claimed, never tested) before
  building UI on top of it. Opaque compositing only for now — real blend
  modes/opacity (Phase B3) is still unbuilt, a separate later step.

- **2026-09-03** — **Relight shading overhaul (D-078/D-079): real light, not
  a coloured gel.** Falloff was 2D-screen-only and colour was flat additive
  — read as a translucent wash, live-confirmed fixed by switching to a
  screen blend (respects existing highlights/shadows) plus real 3D falloff.
  Then found `distance` was sweeping the lit side of the face instead of
  moving the light nearer/farther (a real face's own depth variation was
  feeding the light's *direction*, not just its brightness) — direction now
  uses a heavily damped copy of the depth delta. That same investigation
  caught a second real bug: a `distance` far from a surface's depth could
  silently zero the light out completely (folded into the same radius-gated
  falloff) — depth-based dimming is now a separate, non-zeroing multiplier.
- **2026-09-03** — **Relight uses one coherent AI geometry pass now, not
  two mismatched ones (D-077 addendum).** "Bake Normals" now also writes
  MoGe-2's own real depth (computed in the same inference call as the
  normal), instead of pairing the normal against a separate
  Depth-Anything-V2 bake — the two are guaranteed geometrically consistent.

- **2026-09-03** — **Relight: real AI surface normals instead of a depth
  finite-difference (D-077).** "Feels like a light blob, that's not light
  that's just color" was accurate — the old normal was a crude heightfield
  trick on the depth map, not real geometry. New "Bake Normals" action runs
  MoGe-2 (MIT-licensed, vendored, verified on MPS) for a real per-pixel
  surface normal; DSINE was evaluated first and rejected (academic-only
  licence). Depth-derived fallback unchanged when no bake exists.
- **2026-09-03** — **Relight `distance` correction (D-076 follow-up):** the
  first fix still failed live because a light's z was partly anchored to
  whatever the depth map showed *behind the puck's own position* — broken
  the moment the puck sat over open background instead of on the subject.
  `distance` is now a true absolute z-coordinate, independent of puck
  placement; default bumped 40 → 85.
- **2026-09-03** — **Relight positional lights actually shade footage now
  (D-076, B-022).** Root cause of "nothing is getting applied at all": there
  was no real z/depth control for a light, only screen-space x/y/radius — a
  light always sat flush on whatever surface it was dropped on, which
  collapses the shading math to ~zero on real (relatively flat) footage.
  Added a real `distance` field end-to-end (UI slider → Rust → GPU uniform →
  shader), defaulting nonzero so a fresh light is lit immediately. New
  GPU-render regression test proves it (renders through the real shader
  against a flat depth map, asserts distance=0 is byte-identical to no
  light at all).
- **2026-09-03** — **Relight panel: Bake Depth fires itself, Track Depth
  moved to a compact bottom "finalize" action (D-073).** No more picking
  between two equal-weight depth buttons — the cheap single-frame bake now
  fires automatically the moment a positional light needs it; the heavy
  whole-clip track (confirmed capable of crashing the AI sidecar) is a
  deliberate, tooltip-explained action at the bottom of the panel.
- **2026-09-03** — **Fixed: dragging a relight light puck also scrubbed the
  video frame (D-074, B-021).** A capture-phase pan handler on an ancestor
  fired before the puck's own drag handler could stop it; the puck now
  marks itself so the ancestor skips it entirely.
- **2026-09-03** — **Edit-tab timeline: plain trackpad scroll now pans,
  only a real pinch/Ctrl+scroll zooms (D-072).** D-051's scroll-wheel zoom
  treated every wheel tick as zoom, so a plain two-finger scroll (a
  different physical gesture from a pinch) couldn't scroll the timeline at
  all. Now gated on `ctrlKey` — the standard convention browsers already
  use to mark a real pinch gesture — everything else falls through to the
  library's own native scrollable container untouched.

- **2026-09-03** — **Colorist wasn't actually live-synced to the Edit tab —
  a real gap D-070 left behind (D-071, B-020).** Owner's immediate retest:
  a clip dragged onto the Edit tab's timeline never showed up in Colorist,
  and a deleted clip lingered there forever as a ghost shot.
  `chroma_timeline_set` never called `open_manifest`, and `syncFromRust`
  (dead code, never called) was the only thing that looked like it should
  have handled this. New `chroma_project_resync_clips`, triggered on
  Colorist tab focus: diffs the active timeline against the decode session,
  decodes new clips, prunes stale ones, but deliberately only re-picks the
  active clip if it was one of the pruned ones — a manual selection in the
  shot strip survives a resync that doesn't affect it, unlike just calling
  `chroma_project_open` again. `cargo test chroma::` 138/138 (+3), `tsc -p
  app` 64/64 unchanged.

- **2026-09-03** — **The real Track Depth root cause: a 2-day-stale AI
  sidecar (D-069, B-018).** D-067's new logging paid off immediately —
  `app.log` showed every click hitting a 404 (`{"detail":"Not Found"}`)
  from the process on `:8765`, which turned out to have been running
  since **Sept 1, 21:19** (`ps -p $(lsof -ti:8765)`), well before
  `/depth_track` existed in `ai/server.py`. `spawn_and_supervise` (D-028)
  only checks for something-already-answering once, at boot, and defers
  forever once found — so every restart tonight deferred to the same
  stale process, invisible to every actual app rebuild. Killed + restarted
  it (`ai/run.sh`), confirmed live via `curl`. Also hardened
  `chroma_depth_track`/`_status` to check HTTP status before parsing a
  response as success (they didn't — this is *why* the 404 silently
  looked like "nothing happened" instead of a real error).

- **2026-09-03** — **Relight diagnosability + visual consistency (D-067/
  D-068).** `chroma_depth_track`/`_status` had zero logging — "clicked
  Track Depth multiple times, nothing happened" couldn't be told apart
  from four very different real causes purely from `app.log`; every real
  exit path now logs. Separately, `RelightPanel.tsx` — flagged by the
  owner as visibly inconsistent with the rest of the app — is rebuilt on
  `@apelles/ui`'s real `Button`/`Slider` instead of the RapidRAW-era plain
  elements its own module doc had admitted using since D-048. Presentation
  only, no interaction-logic changes.

- **2026-09-03** — **Relight keyframe "Clear"/"X" never actually removed
  keyframes (D-066, B-017).** `writeLightParams` spread-merged its result
  onto the stale light (`{ ...l, ...next }`) — a spread can overwrite a
  key, never un-set one, and `clearKeyframes`/`removeKeyframe` signal
  "done" by deleting `chromaKeyframes` from their return value, which the
  merge silently discarded. Now replaces the light outright. Cross-checked
  the shared mechanism (`maskKeyframes.ts`, D-034) against its other real
  caller (`MaskKeyframeBar.tsx`) — not buggy there, this was specific to
  how `RelightPanel.tsx` composed it. Also confirmed a separate same-
  session report ("no light shows when I change color") is by design, not
  a bug — a positional light genuinely no-ops until Track/Bake Depth runs.

- **2026-09-03** — **Colorist fullscreen had no way back out (D-065,
  B-016).** The only exit button lived inside the toolbar, which itself
  hides (`max-h-0 opacity-0`) exactly when fullscreen turns on — the
  control that exits fullscreen was hidden by fullscreen. Added a
  dedicated close button, always rendered, independent of the toolbar and
  of two undeduplicated `handleToggleFullScreen` closures (`App.tsx`/
  `Editor.tsx`, real duplication flagged but not fully consolidated this
  pass — see D-065).

- **2026-09-03** — **Unified clip identity, Edit ↔ Colorist: `ProjectShot`
  retired, `apelles_timeline::Clip` is the single source of truth (D-070).**
  Colorist's shot strip now reads the active Edit-tab timeline's clips
  directly (`Clip.media_id`, new) instead of a separate persisted
  `ProjectShot` list, so a clip dragged onto the Edit tab shows up in
  Colorist immediately — no more "add to grading" as a second step.
  One-time grade-file migration renames `<gradeDir>/<shotId>.grade.json` →
  `<gradeDir>/<clipId>.grade.json`, warning (never dropping) any grade that
  can't be matched to exactly one clip. Colorist's active-clip resolution
  now shares D-056's `resolve_video_clip_at`, not a second copy. Verified
  against a scratch copy of the owner's real project: 3 shots, 0 renamed
  (already-migrated no-op), 2 warned (never dragged onto the Edit tab),
  nothing lost. `cargo test -p apelles-timeline` 37/37, `chroma::` 135/135
  (+10, 1 ignored real-project harness by design). `tsc -p app` 64 errors,
  unchanged baseline.

- **2026-09-03** — **Sources panel delete (single + batch), edge-trim
  cursor, timeline-switcher width fix (D-060/D-061).** New
  `chroma_media_remove(ids: Vec<String>)` — right-click "Remove from
  pool," a hover trash icon per card, and a header "Select" → "Select
  all" / "Delete (N)" bulk path, all wired to the same batch command
  (removes the pool ref + cached thumbnail, never the source file). The
  timeline's resize handles get a real `ew-resize` cursor + hover
  highlight (the library never styled this at all — `timeline-
  overrides.css`, new); the D-058 tab strip stops stretching to fill the
  row (`grow-0`, the shadcn base `flex-1` was never actually cancelled)
  and is capped to half-width. `cargo test chroma::` 126/126 (+1).
- **2026-09-03** — **The real B-012/B-013 fix: Tauri's own
  `dragDropEnabled` was eating drag-and-drop in the actual app (D-064).**
  D-058 fixed the frontend model and verified strongly — in a plain
  Chrome tab, since that's this sandbox's only way to drive real DOM
  events. The owner's live retest in the real Tauri window showed drag
  still completely dead: Tauri v2's window-level native drag capture
  (on by default, never set in `tauri.conf.json`) intercepts HTML5 drag
  events before the page ever sees them — a class of bug no proxy method
  could catch. `dragDropEnabled: false`. Confirmed by the owner dragging
  a real clip in the real window.
- **2026-09-03** — **Motion render now lands in Sources; Edit-tab preview
  gets a real loading state (D-062).** Rendering used to just write a
  file and print its path as plain text — nothing put it anywhere
  usable. `onRendered` (app-composition-root-owned, since `@apelles/
  motion` can't reach `@apelles/bridge`) now imports the result into the
  Sources pool. `PreviewPane`'s "no frame" placeholder — shown
  identically whether a frame was loading or genuinely absent — is now a
  real spinner during a first-load, and the plain text only for a
  genuinely empty timeline.
- **2026-09-03** — **Colorist shot-switch preview had a fully-built
  loading spinner wired to a dead flag (D-063, B-015).** `showSpinner`
  existed, styled and correct, keyed to `useLibraryStore.isViewLoading`
  — a RapidRAW still-image-library flag with exactly one call site,
  unreachable since the D-043 video pivot. The real switch paths
  (`switchToShot`, `_hydrateOpenDto`) never touched it, and
  `_hydrateOpenDto` itself never toggled `busy` either (4 callers each
  separately remembered to wrap it; Sources' "add to grading" didn't).
  `isLoading` now also reads `useSessionStore.busy`; the toggle moved
  inside `_hydrateOpenDto` so every caller gets it for free.

- **2026-09-03** — **Multi-track NLE Phase B1: opaque top-wins video-track
  resolution (D-056).** Real finding: opaque "top wins" compositing needed
  **no new rendering/GPU code** — with no alpha in play, the top-priority
  track's clip fully obscures whatever's below, so this was a track-
  **selection** problem, not a pixel-compositing one (confirms the phase
  brief's hypothesis rather than assuming it). Landed as
  `apelles_timeline::Timeline::resolve_video_clip_at` — pure model logic,
  video tracks walked in `Vec` index order (lower index = higher priority,
  "on top" — matches Palmier Pro's own track convention and every existing
  project's single-track behavior), first track with a clip (not a gap) at
  the position wins, falls through to the next only on a gap. `edit.rs`'s
  `resolve_video_position` (shared by `chroma_timeline_frame` and the audio
  path) is now a thin wrapper around it that probes the winning clip.
  `cargo test -p apelles-timeline` 30/30 (+7 new tests: both-tracks-have-
  content, only-top, only-bottom, neither, top-gap-falls-through, no-video-
  tracks, single-track-behavior-unchanged-regression); `cargo test
  --manifest-path app/src-tauri/Cargo.toml chroma::` 113/113 (+1 real-clip
  integration test exercising the Tauri command path end to end); `tsc
  --noEmit` 64/64, unaffected (no frontend file touched). GUI boot not
  performed this session — port 1420 was already held by the main
  checkout's own dev server — so the regression proof instead rests on the
  real-media integration test hitting the exact `chroma_timeline_frame`
  command plus a test proving the new resolution path is identical to the
  old one for every single-track position (see D-056). Phase B2 (N tracks)
  is now mostly "confirm it generalizes," since the same walk already has no
  hardcoded track count. Phase B3 (real blend modes/opacity, the genuinely
  new GPU work) is next for the compositor. See D-056,
  `docs/notes/multi-track-nle.md`.

- **2026-09-03** — **Multi-track NLE Phase C: real audio mixing (D-057).**
  `chroma::audio`'s `cpal` pipeline now sums N sources instead of playing
  exactly one — the baseline video-embedded audio (unchanged, unity gain)
  plus every genuine `TrackKind::Audio` clip overlapping the play position.
  New `apelles_timeline::Track::gain: f32` (default `1.0`) is per-track
  volume; a new `mix_sources`/`soft_limit` mixer sums active (nonzero-gain)
  sources through a `tanh` soft limiter (chosen over a hard clamp's real
  clipping or a `1/N` pre-scale's needless quietening), bypassing
  summation/limiting entirely with ≤1 active source — which keeps the
  pre-existing single-track case byte-identical and makes "mute via
  `gain: 0.0`" an exact property. Pan scoped out. `apelles-timeline` 25/25,
  `chroma::audio` 29/29 (new deterministic + live-`cpal` 2-track tests),
  `chroma:: ` wide 122/122, `tsc` 64/64 unchanged, real `cargo build`
  boot confirmed (live Tauri UI boot blocked by an unrelated port-1420
  process already running from the main checkout, not this task's to
  kill — see D-057).

- **2026-09-03** — **Timeline UI fixes from real hands-on testing (D-058,
  B-012/B-013).** Drag-from-Sources and edge-trim were both silently broken:
  `packages/editor/src/timeline.ts`'s frontend edit-op mirror (authoritative
  for real saves, since `chroma_timeline_set` stores verbatim) never picked
  up D-054's `Clip.start_frame` — a dropped clip had no real position, and a
  left-edge trim visibly moved the wrong edge. Ported D-054's model into
  `timeline.ts` field-for-field against the Rust ops (`trim_start`/
  `trim_end`'s neighbor clamps, `split`'s right-half position, `add_clip`'s
  append position, a new overlap-rejected `move` op replacing the now-inert
  `reorder`-as-position-change); `TimelinePane.tsx` renders from each clip's
  real `start_frame` instead of re-deriving it from summed durations. **A
  second, independent trim bug found via real live pointer testing** (not
  code reading): the clip-name label's `z-10` had no isolating stacking
  context, so it silently covered the resize handles' hitboxes across the
  library's own DOM, swallowing every edge-trim `pointerdown` before
  `interact.js` ever saw it — `pointer-events-none` on the label, one line,
  fixes it. `TimelineSwitcher` rebuilt as a `@apelles/ui` `Tabs` strip (tabs +
  a `+` tab) replacing the dropdown-plus-button. Timeline ruler: real
  `HH:MM:SS`/`HH:MM:SS:FF` timecode + an adaptive "nice numbers" tick
  interval (`ruler.ts`, new) instead of a hardcoded 1-tick-per-second scale.
  Real op + formatting unit tests (33, `timeline.test.ts`/`ruler.test.ts`);
  drag-and-drop and trim both additionally confirmed against the real
  running app — a real Chrome tab on the plain Vite dev server (Tauri
  mocked), real native drag events and real synthetic pointer events at the
  actual DOM coordinates, real resulting store/JSON state checked — see
  D-058 for the full method and honest caveats.

- **2026-09-03** — **Sources panel fixes: async media commands, real
  thumbnails, real "New Folder" (D-059, B-014).** Owner-reported, hands-on
  bugs D-046's own accessibility-driven verification missed.
  `chroma_media_list`/`_import`/`_move` converted to `async fn` — they were
  plain `fn`, which Tauri runs inline on the main UI thread, stalling the
  native Import file-picker behind them (`chroma_media_import` also moves
  its `ffprobe`/`ffmpeg` work into `spawn_blocking`). Every imported item now
  gets a real cached poster-frame thumbnail (`video::extract_thumb`, reused
  — not a new decode path — to `<video_dir>/.chroma/thumbs/<id>.jpg`).
  `ProjectManifest.folders: Vec<String>` + `chroma_media_create_folder` let a
  new, empty bin persist and list before anything is filed into it, via a
  "New Folder" button + right-click context menus (`@apelles/ui`'s shadcn
  `ContextMenu`, its first real consumer). `cargo test chroma::` 114/114
  (was 112 in this fresh worktree; +2 new tests), `tsc --noEmit` unchanged
  (app 64, bridge 0, editor 1 pre-existing/unrelated, ui 0). See D-059 for
  full verification detail, including an honest note on what the live
  click-to-dialog timing test could and couldn't show.

- **2026-09-03** — **Multi-track NLE Phase A: `Clip.start_frame` + gap-aware
  edit ops + track management (D-054).** `apelles-timeline::Clip` gained an
  explicit, timeline-absolute `start_frame: i64` (not a `Gap` item — see
  D-054's rationale) so clips stop being forced back-to-back.
  `reorder`/`trim_start`/`trim_end`/`split`/`remove` reworked for gaps + a
  no-overlap invariant (`remove`/`reorder`'s behavior changed — flagged in
  D-054). New `Timeline::add_track`/`remove_track`/`move_clip` ops +
  matching `chroma_timeline_add_track`/`_remove_track`/`_move_clip` Tauri
  commands in `edit.rs`. Legacy `project.json` migration
  (`backfill_legacy_positions`) verified against the real
  `~/Movies/Chroma/New.chroma/project.json`. `apelles-timeline` 23/23,
  `cargo test chroma::` 110/110 (was 107; caught and fixed one real
  compile-time bug along the way — a `chroma::audio` test helper built a
  `Clip` literal directly and needed the new field), `tsc --noEmit` 64/64
  unchanged, real boot confirmed the existing single-track Edit tab is
  unaffected. No frontend touched, no compositor/audio work (Phases B/C/D,
  still to come — see `docs/notes/multi-track-nle.md`).

- **2026-09-03** — **Interactive relight follow-ups (D-055)**, all four of
  D-048's deferred small items: a static single-frame depth-bake fallback
  ("Bake Depth", reusing the existing single-frame Depth-Anything-V2 command
  `generate_full_image_depth_map` — parity with D-024's AI-Depth mask, no
  second model); `relight_depth_layer` wired into `export.rs`'s `grade_frame`
  so a positional light survives a real export, not just live preview (+ a
  real GPU pixel-diff test, lit vs. unlit); a "Preset" tab on `RelightPanel`
  (3 starter looks: warm key + cool rim, soft ambient fill, dramatic
  single-source); MCP tool wrapping for the 4 control-server relight ops
  (`mcp/server.py`). Also fixed a pre-existing "D-046" mislabel for
  interactive relight in `docs/04-roadmap.md` and `docs/09-engine-notes.md`
  — the real decision is D-048; D-046 is "Media pool pass 3".
- **2026-09-03** — **`apelles-types` step 2: `Resolution`/`Rational` made real
  (D-053).** Audited `app/src-tauri/src/chroma/*` for real duplicates of the
  D-039-step-1 placeholders. Real find: `width`/`height` field pairs on
  `video::VideoInfo` and its DTOs (`VideoInfoDto`, `ShotDto`,
  `MediaVideoInfo`) — migrated to `apelles_types::Resolution` via
  `#[serde(flatten)]`, a verified zero-JSON-wire-change move (round-trip
  test in `apelles-types`). `Rational` gained a `Display` impl, now used by
  `export.rs`'s ffmpeg fps-arg string in place of a bare `format!`.
  **Deliberately not migrated:** `ChromaError` (no real call site in
  `app/src-tauri` — its Tauri commands correctly use `Result<T, String>`/
  `anyhow`, a different layer's convention); `ProjectSettings`/`ExportOpts`'s
  width/height (independently-optional patch/override fields, not the same
  concept as an atomic `Resolution` — this directly re-examines the task
  brief's own cited example and found it didn't hold up); `ColorSpace`/
  `TimeRange` (no real duplicate exists yet). `cargo build`: clean across
  the workspace. `cargo test -p apelles-types`: 4/4. `cargo test
  --manifest-path app/src-tauri/Cargo.toml chroma::`: 107/107, unchanged
  from the D-051 baseline. `tsc --noEmit` in `app/`: zero TS files touched
  (Rust-only change) → zero new errors; the pre-existing count read 32 in
  this fresh worktree vs. D-051's recorded 64 on `main` (dependency-version
  drift from a clean `npm install` here, not this change — see D-053).
  Booted the real app to confirm no runtime shape drift.

- **2026-09-03** — **Mature Editor timeline UI (D-051): closes the roadmap item.**
  Scoped against `@xzdarcy/react-timeline-editor`'s real API first — edge-drag trim
  and snap-to-clip-edge/playhead turned out to already be fully native (`flexible`/
  `dragLine`, both already set since D-041), zero new code for either. Built: native
  (non-passive) scroll-wheel zoom + toolbar zoom buttons on `TimelinePane.tsx`; a
  Rust-computed waveform (`chroma_audio_waveform`, `chroma::audio`, one-shot
  `symphonia` decode → mono → min/max bucket peaks) drawn as a plain `<canvas>` in
  new `Waveform.tsx`, no new dependency; ripple visual feedback (a clip-id→
  start-frame diff drives a brief `animate-pulse`); a truthful "Video 1" label
  instead of speculative multi-track colour-coding (deferred to a future
  multi-track-authoring feature). `cargo test chroma::` 107/107 (+12), plus 2 more
  real-file-gated waveform tests (real non-flat peaks from the D-050 audio fixture,
  empty `Ok` for the known-silent one). `tsc --noEmit` 64, unchanged baseline, zero
  in touched files. Booted the real app; honest gap noted in D-051 — no Screen
  Recording/Accessibility permission in this sandbox, same as D-050, so the pixel-
  level zoom/waveform/trim/ripple interactions weren't visually confirmed, only
  their backing command surface and the library's own native-support mechanism
  (read directly from its bundled source).

- **2026-09-03** — **Global undo/redo (D-052): shell-level Cmd/Ctrl+Z spanning all 3
  tabs.** New `@apelles/history` package (a generic `{tab, label, undo(), redo(), ts}`
  stack — a new leaf package, not folded into `@apelles/bridge`, see D-052). Colorist's
  existing `useEditorStore` grade history is bridged in unchanged
  (`useColoristHistoryBridge.ts`, reuses the D-032 `restoreEditorHistorySnapshot`
  helper — extracted from `AgentActivityDock.tsx` so both share one implementation).
  The Edit tab's timeline ops get real undo for the first time — `useEditorTimelineStore
  .applyOp` pushes before/after `Timeline` snapshots. `Shell.tsx` owns the only
  Cmd/Ctrl+Z / Cmd/Ctrl+Y (+ Cmd/Ctrl+Shift+Z) listener, pops the shared stack
  regardless of active tab, and **switches to the popped entry's tab** so the effect
  is always visible (the real UX call, reasoning in D-052). Colorist's own local
  Cmd/Ctrl+Z handler removed to avoid double-undo. Deferred: Motion tab (no natural
  edit-history unit), and the Colorist toolbar's Undo/Redo buttons still bypass the
  shared stack (documented, harmless). 16/16 new unit tests (`@apelles/history` +
  `labelForOp`) passing, `tsc --noEmit` 64/64 baseline unchanged, `cargo test
  chroma::` unaffected (no Rust touched).

- **2026-09-03** — **Export dialog, Colorist tab (D-049): a top-right button replaces
  the "buried `ExportPanel` toggle" roadmap item.** New `ExportDialog.tsx`
  (`@apelles/ui` `Dialog`/`Select`, D-042) in `EditorToolbar`'s top-right button group —
  codec, resolution (Project spec / Clip / Custom), frame range (full/custom), a
  `.cube` bake toggle, a native save-dialog output path, and a real progress bar
  polled from `chroma_export_progress`. Backed by the existing `chroma_export_video`/
  `chroma_bake_lut` (D-022) — the only backend change is two new optional params,
  `out_width`/`out_height`, plus a 4-test pure `resolve_export_resolution` helper
  encoding "explicit > D-038 project spec > clip-derived." `Panel.Export`/
  `ExportPanel` (RapidRAW's still-image exporter) stays routed — it's a different
  feature, not a duplicate (see D-049); the pre-existing bug where it's reachable but
  broken against a loaded video is now tracked as **B-010**. `cargo test chroma::`
  87/87 (+4). `tsc --noEmit`: 64 errors, unchanged baseline, zero in touched/new
  files. Booted the real app, opened `~/Movies/Chroma/New.chroma` (a real 4K/50fps
  clip) over the control-server bridge (no screen-recording access in this sandbox),
  and drove the exact same `chroma_export_video`/`chroma_export_progress`/
  `chroma_bake_lut` calls the dialog makes: a 16-frame H.264 export ran to completion
  with real incrementing progress (`done` climbing 1→16, `running` flipping to
  `false`), producing a genuine 3840×2160/50fps/16-frame MP4 (verified via `ffprobe`,
  not just "no error"); a `.cube` bake produced a valid 17³ LUT file with the correct
  "masks dropped" warning for the project's one mask. Not directly observed: the
  dialog's own on-screen rendering/click-through (no screen capture available) —
  covered instead by `tsc` type-checking the wiring and this identical backend path
  proven live.

- **2026-09-03** — **Editor timeline audio playback (D-050), closes the roadmap
  item.** The Edit tab's preview was completely silent (no pipeline at all); now
  Play produces real device audio via a new `chroma::audio` module: `symphonia`
  decode → `rubato` resample → `dasp_sample` bit-depth convert → `cpal` device
  output, reusing the video track's already-embedded audio stream (no separate
  audio `Track` populated this pass — see the D-050 "why not" note). Sync model:
  a persistent audio thread free-running against the device's own clock, started
  from the same playhead frame at the same moment the video `rAF` loop
  re-baselines — not tightly coupled per-frame; the real design tradeoff is
  written up in D-050. `video::VideoInfo` gained `has_audio`/`audio_sample_rate`/
  `audio_channels` (one extra small `ffprobe -select_streams a:0` call, cached).
  `PreviewPane.tsx` fires `chroma_audio_play`/`chroma_audio_stop` at the same
  `playing` transitions that drive the existing video loop. `cargo test
  -p apelles chroma::`: 95/95 passed (was 83; +12: 9 pure-logic + 2 real-file
  end-to-end + 1 extended). `tsc --noEmit` baseline in this worktree: 64
  pre-existing errors, unchanged. Verified end-to-end with real files (not just
  a clean compile): `A001_08302215_C019.MOV` (HEVC+AAC 48kHz/2ch) played through
  the actual `chroma_audio_play`/`_level`/`_stop` commands produced genuinely
  non-silent PCM (`rms=0.0013 peak=0.0080`, logged + read back via
  `chroma_audio_level`) from a real, live `cpal` output stream; this repo's own
  real `New.chroma` project's one shot (`pexels_28808272.mp4`) was confirmed via
  `ffprobe` to have **no audio stream at all**, so its silence is correct, not a
  gap. Booted the real app for real — clean build + launch, no errors.
  **Honest gap:** did not click Play in the actual GUI on an audio-bearing
  project — both `screencapture` and `osascript`/System Events were tried and
  neither had the permission this sandbox needed to observe or drive the
  window — the command-level integration tests above are the substitute
  proof; whoever next drives the UI can cross-check against the `chroma
  audio: rms=… peak=…` log line. Found + logged (not fixed,
  out of scope) a pre-existing, unrelated test-isolation bug while verifying:
  `docs/BUGS.md` B-011.

- **2026-09-02** — **Media pool, pass 3 (D-046): `shots`/`media` unified, closes the
  roadmap item.** `ProjectShot` now references a `MediaItem` by id (`resolve_shot`,
  graceful fallback for a dangling reference) instead of duplicating `sourcePath`/
  `name`; wire DTOs unchanged, so the frontend session store needed no rewrite.
  `find_or_create_media` is the one choke point every shot-constructing path goes
  through; `chroma_project_add_shot` is the new explicit "add to grading" command. A
  docked Sources/Library panel (`app/src/components/chroma/SourcesPanel.tsx`, injected
  into `@apelles/shell` by prop) with import, client-side search, and a bin tree
  (drag-to-move via `chroma_media_move`); `TimelineSwitcher` in `@apelles/editor` for
  D-045's `chroma_timeline_list`/`_create`/`_set_active`; drag-to-track via plain HTML5
  `dataTransfer` (`CHROMA_MEDIA_DRAG_MIME`), scoped to the Edit tab by construction
  (inactive tabs are `display:none`, never a drop target). `cargo test chroma::`
  73/73 (+8). Booted the real app and drove it end-to-end via accessibility scripting
  (no screen-recording access): created a project, imported a clip, added it to
  grading, created + switched timelines, confirmed an empty timeline's drop zone no
  longer crashes (`buildRow` needed its own guard — found live, fixed) and the
  timeline-switcher's `SelectValue` needed a render-children fix to show names instead
  of raw ids (found live, fixed).

- **2026-09-02** — **Interactive relight (D-048): draggable depth-driven light
  pucks, real-time, deterministic.** A new "Relight" grade layer (`RelightLight[]`
  — key/fill/rim/ambient, keyframeable via D-034's mechanism reused verbatim) with
  a ClipDrop-style puck UI (`RelightPuckLayer`, the clone/heal-marker HTML-overlay
  pattern, not the Konva mask-shape tree) and a right-panel (`RelightPanel`:
  Ambient/Light-N tabs, Color/Power/Distance, "Track Depth"). Shading is a new
  `apply_relight` WGSL pass — per-pixel normal from a depth-texture finite
  difference, `max(0,dot(N,L))·falloff(radius)·colour·intensity` — riding the
  *same* mask-texture-array `mask_bitmaps`/`textureLoad` plumbing D-024's
  depth-haze mask already established (one more array layer, no new bind group).
  Covers both live-preview paths for free (`apply_adjustments` + D-031 playback
  share one `process_preview_job`); export/thumbnail/LUT-bake paths untouched
  (ambient still renders there, positional lights are inert — deferred to
  roadmap). Depth source reuses D-036's `chroma_depth_track` job verbatim.
  Control-server ops (`add_relight_light` etc., mirroring `add_mask`) added for
  agent access + verification. `cargo test chroma::relight` 10/10 new (incl. a
  real-GPU determinism test); `cargo clippy`/`fmt` clean on touched files; `tsc`
  unchanged at 64. **Verified against the real running app**: opened the real
  `~/Movies/Chroma/New.chroma` project, added an ambient light over the control
  server, decoded the returned preview — the frame washed a uniform colour tint
  exactly matching the shading math; a positional light with no depth track
  correctly produced zero change. Photoreal diffusion bake (v3, `ai/` sidecar)
  explicitly out of scope, untouched.

- **2026-09-02** — **Docs reconciliation pass** (roadmap "Next" item 7, the `CLAUDE.md`
  hard-rule debt owed since the D-039 pivot). `03-architecture.md` fully rewritten for the
  3-tab world (crate/package tables, per-tab current state, data model, AI sidecar, the
  agent bridge) off `docs/notes/architecture-lock.md` + every `D-039`-onward decision;
  `00-vision.md`/`01-prd.md`/`02-scope.md` corrected from "grading only, not an editor" to
  the real 3-tab product, keeping what was still true (local-first, grade-as-code, the
  colour-science wedge) rather than rewriting wholesale; `02-scope.md` keeps the Colorist
  v1 scope as still-accurate and adds the Edit/Motion tabs' own scope alongside it, and
  fixes its "Anti-scope" section, which had named editing/motion-graphics as explicitly
  out-of-scope ("that's Palmier's job") — exactly backwards post-pivot. `BUGS.md`'s "Known
  engine constraints" list had three stale entries (D-014/D-018+D-034/D-036, all since
  solved) removed, one still-real item (the `max_texture_dimension_2d` 8K bypass) kept.

- **2026-09-02** — **Motion tab MVP (D-047).** `@apelles/motion`'s `MotionTab`
  is real: a `@remotion/player` preview of `@apelles/motion-engine`'s `Video`
  composition, a live-validated JSON manifest editor (`zod`, JSON-in this
  pass — visual editor still open, see `product-direction.md` §9), Save
  (project-scoped sidecar `<project>.chroma/motion/manifest.json`) and
  Render (new `apelles-motion` crate → `npx remotion render`, Rust
  orchestrates the existing Node engine rather than reimplementing it). New
  Tauri commands `chroma_motion_get_manifest`/`_save_manifest`/`_render` in
  `app/src-tauri/src/chroma/motion.rs`. Found + fixed along the way: a
  latent `@react-three/fiber` × polymorphic-`React.ElementType` typing
  collision (`@apelles/ui`'s `Text.tsx`, `app`'s `BottomBar.tsx` — see
  B-008), a react/react-dom version-duplication bug (`motion-engine` pinned
  exact versions npm couldn't hoist, so two React copies would have landed
  in one component tree), and a live runtime crash from a duplicate
  `remotion` package (`@remotion/animation-utils`/`google-fonts`/
  `motion-blur`/`noise`/`transitions`/`shapes` all caret-pinned in
  `motion-engine`, so npm floated them to a newer `4.0.520` patch each
  carrying its own nested `remotion@4.0.520` — Remotion hard-errors on a
  version mismatch at runtime, which is what actually blocked the first
  several boot-verification attempts). Both fixed via a root `package.json`
  `overrides` block (not by touching motion-engine's pins) plus a genuinely
  clean `rm -rf node_modules package-lock.json && npm install` — an
  incremental install on top of the pre-override lockfile did not reliably
  apply a newly-added override. Verified with a real `npm run tauri:dev`
  boot: dev-server stdout and the app log stayed clean for the session, no
  "Multiple versions of Remotion" error, no frontend-ready timeout.
- **2026-09-02** — **Media pool, pass 2 (D-045): bins + multiple named
  timelines.** `MediaItem.folder` (a plain path-string bin, no separate
  entity — Palmier-MCP-folder convention) + `chroma_media_move`.
  `ProjectManifest.timeline: Option<Timeline>` (D-041) → `timelines:
  Vec<Timeline>` + `active_timeline: usize`, migrated losslessly from the old
  singular key on load; `Timeline` gained an `id`; new
  `chroma_timeline_list`/`_create`/`_set_active`, existing `_get`/`_set`/
  `_frame` now target the active timeline (unchanged behaviour for a
  single-timeline project). Model + commands only, still no UI. `cargo test
  chroma::` 65/65 (+7); `apelles-timeline` 10/10 (+1); the real
  `~/Movies/Chroma/New.chroma` project migrates cleanly, checked both via a
  throwaway fixture test and a live app boot.

- **2026-09-02** — **Edit tab stuck on stale "no project open" fixed (B-007);
  tab-default persistence removed.** Opening a project from Colorist never
  told the already-mounted Edit tab to re-check — its timeline store only
  refetches on its own mount and on OS window focus, neither of which fires
  on a same-window tab open. `main.tsx` (composition root) now triggers a
  reload when `useSessionStore`'s project-open signal changes. Also:
  `@apelles/shell`'s active-tab was persisted to localStorage, silently
  overriding the "Edit opens by default" fix the moment anyone clicked another
  tab once — now session-only, every launch starts on Edit.
- **2026-09-02** — **Media pool, pass 1 (D-044).** `ProjectManifest.media:
  Vec<MediaItem>` — additive alongside `shots`, unification deferred to
  pass 2/3. New `chroma_media_import`/`chroma_media_list` Tauri commands
  (probe via the existing `video::probe`, dedup by source path, live offline
  flagging). `useMediaPoolStore` scaffolding in `@apelles/bridge` (no panel UI
  yet). `cargo test chroma::` 58/58 (+4); the real `~/Movies/Chroma/New.chroma`
  project still loads.

- **2026-09-02** — **Colorist black preview fixed for real (B-006).** Root
  cause was never the wgpu render pipeline — a temporary off-screen-texture
  dump proved the render pass, scissor math, and bound frame texture were
  already correct — it was a plain CSS regression: D-039's `@apelles/shell`
  wraps the window in a new root `<div>` with a hardcoded opaque
  `bg-bg-primary`, silently blocking the transparent "hole" the Colorist app
  already punches through itself for the native wgpu surface to show
  through. Fixed by mirroring the app's `isWgpuActive` up into a new
  `wgpuSurfaceActive` flag on `@apelles/shell`'s store, which the shell root
  now reads to drop its own background too. No screen-recording permission
  was available to verify with a literal screenshot; verified instead via
  the texture dump (pre-fix) plus a live `getComputedStyle` read of the
  shell root in the running app (post-fix, shows `rgba(0,0,0,0)` exactly
  when the surface is active) — see B-006 in `BUGS.md` for the full trail.
- **2026-09-02** — **Colorist wgpu-sync stuck-hidden loop fixed (B-005); a
  second, separate black-preview bug found and logged open (B-006).** After
  B-004 fixed the IPC corruption, the Colorist preview was still black —
  traced to a real second bug: the wgpu-position sync effect could get
  permanently stuck sending an off-screen transform after one transient 0×0
  layout read (its retry loop only reschedules on a *changed* outgoing value,
  so a bad read that matches a prior one never gets re-tried). Fixed in
  `Editor.tsx`'s `syncWgpu` — DOM-layout-not-ready now polls continuously
  instead of relying on a dependency-array item that can't see pure layout
  changes. Confirmed via a temporary debug log, removed before commit. The
  render now genuinely fires at the correct on-screen resolution — but the
  panel is still visually black, a distinct, still-open native
  window/GPU-compositing issue, logged as B-006 (not yet root-caused).
- **2026-09-02** — **Entry module double-mount fixed (B-004) — "No project open" /
  blank Colorist preview.** `app/index.html`'s `<script>` still referenced the
  pre-D-039 `main.jsx` (renamed to `main.tsx`); Vite's dev-server extension
  fallback served `main.tsx`'s content under that stale URL *and* something
  separately fetched the correct `/src/main.tsx`, executing the entry twice —
  two `createRoot()` calls on `#root` and a corrupted `@tauri-apps/api/event.js`
  listener map (confirmed via a temporary `import.meta.url` probe: two
  executions → after the one-line fix, exactly one). This is what broke
  `invoke`/`listen` round-trips app-wide, producing the Edit tab's stuck "No
  project open" and Colorist's blank main preview despite successful backend
  WGPU renders. Fixed by pointing `index.html` at `main.tsx`; both symptoms
  re-verified against the real running app. Also: `packages/shell/src/store.ts`
  `DEFAULT_TAB` → `'edit'` (owner request — Edit opens first, not Colorist).
- **2026-09-02** — **`@apelles/player` — shared preview component, Editor tab
  migrated (roadmap "Next" item 1, built).** New package: `<Player>` (viewport +
  title strip + transport bar), fully controlled and presentational — no
  `@tauri-apps/api`, no zustand, no video/decode logic, built on `@apelles/ui`'s
  `Button`/`Slider`. `fmtTimecode` moved here from `@apelles/editor`'s
  `PreviewPane.tsx` (single source of truth). `PreviewPane.tsx` rewritten to use
  it: all frame-fetch (`chroma_timeline_frame`) and rAF play-loop logic stays
  put, only the hand-rolled transport JSX moved to `<Player>`. Colorist + Motion
  adoption is follow-on, not done here.

- **2026-09-02** — **Colorist tab is the grading editor only — RapidRAW's
  DAM/welcome/library/community shell removed (D-043, built).** The "Sources"
  folder-tree panel the owner flagged is gone, along with the whole photo-library
  grid, albums, culling, the welcome/"Continue Session" home screen, and the web
  Community presets page — Colorist now shows only the editor or a
  `ColoristEmptyState` message. ~7800 LOC deleted across 51 files (`docs/09` D-043
  entry has the full list); every RapidRAW branding string fixed to say Apelles,
  including the ones baked into exported files (EXIF `Software` tag, XMP
  `x:xmptk`), across all 13 i18n locales. `cargo test chroma::` 54/54 unchanged,
  `tsc` errors 74 → 64 (baseline files deleted, zero new).
- **2026-09-02** — **`@apelles/ui` → shadcn/ui + Base UI (D-042, built).** Canonical
  shadcn structure by hand (`components.json`, `src/lib/utils.ts`,
  `src/components/ui/*`, `src/index.ts`) — the CLI can't target a workspace library
  package. 18 structural components on Base UI (`@base-ui/react` 1.7.0): button,
  dialog, dropdown-menu, context-menu, tooltip, popover, tabs, select, command,
  resizable, sheet, slider, switch, scroll-area, separator, input, label, sonner.
  The 5 hand-extracted primitives rebuilt: `Button` (superset of the old API —
  `variant="primary"` alias, `className` still wins via tailwind-merge), `Input`
  (`bgClassName` kept), `Switch` → bare shadcn switch + new `LabeledSwitch` composite
  (Base UI restores the knob animation), `CollapsibleSection` on Base UI `Collapsible`,
  `Text` unchanged. Theme: one `@theme` source (`packages/ui/src/styles.css`,
  `@import`ed by `app/src/styles.css`), every shadcn token an alias of an existing
  `--app-*` var; the `--accent` collision resolved by keeping RapidRAW's brand
  `--color-accent` and editing shadcn's hover state to `bg-muted`;
  `--color-destructive` the one pinned value. Migrated: `@apelles/shell` "‹ Projects"
  button, `@apelles/editor` timeline toolbar → `Button` + `Tooltip`. Colorist panels
  untouched (later). `tsc` app = 74 (baseline unchanged), `vite build` green, `cargo
  check` untouched. Deferred: typography unification, Colorist `Dropdown` migration.

- **2026-09-02** — **Project launcher is the app entry screen (D-039 migration
  log).** The app opens on the D-037 launcher with no tab bar — just the chrome
  bar. Opening/creating a project sets `useSessionStore.projectPath` (or
  `projectName` for a loose-clip Untitled), flipping `<Shell>` into the 3-tab
  layout; a "‹ Projects" button in the chrome bar calls a new `closeProject()`
  action (flushes a final save for a dirty named project, then resets all
  session + project state) to return. `<Shell>` gains `projectOpen` / `launcher`
  / `onCloseProject` props — it never imports `ProjectLauncher` (app → shell
  only); `app/src/main.tsx` is now a small `Root` that reads the session store
  and routes. Tab panels stay mounted under the launcher so the Colorist MCP
  control bridge keeps running. Colorist (`<App/>`) drops its `activeView:
  'projects'` branch — `useUIStore` default `'projects'` → `'editor'`, `App.tsx`
  renders `<LibraryView/>` directly as the unrouted albums/culling fallback,
  `useAppNavigation` "back" → `'library'`. No Rust change (`state::ProjectRef` is
  left set on close — harmless; the next open overwrites it and every frontend
  save path guards on `projectPath`). `tsc` 74 baseline unchanged, `vite build`
  green. Follow-ups: reopen-last-project on launch; Untitled close = discard.

- **2026-09-02** — **UI consistency pass (D-039): window chrome in the shell,
  `@apelles/ui` kit, editor icons.** (1) The window title bar moved out of the
  Colorist tab into `@apelles/shell` — new `WindowChrome.tsx` (platform logic
  ported from RapidRAW's `TitleBar`: macOS traffic lights, Win/Linux controls,
  drag region), and `Shell.tsx`'s top bar is now the title bar (left = traffic
  lights + `APELLES` wordmark, centre = tabs, right = window controls / mac
  spacer, `h-10`). `.macos-window-shell` (14px rounded corners) moved to the
  shell root. `app/src/App.tsx` stops rendering `<TitleBar/>` (import + render
  removed; the file stays unrouted for reference). `@apelles/shell` gains
  `@tauri-apps/api` + `@tauri-apps/plugin-os` + `lucide-react` — it's the app
  chrome now, so Tauri coupling is fine. (2) `@apelles/ui` is a real package:
  `Button`, `Input`, `Text`, `Switch`, `CollapsibleSection` extracted from
  `app/src/components/ui/`, the app-side files now `export { X as default } from
  '@apelles/ui'` re-export shims (all `import X from '../ui/X'` sites unchanged).
  Deps kept to react + clsx + lucide — `Switch` drops `framer-motion` (CSS
  transform transition), `CollapsibleSection` drops `react-i18next` (inlined
  strings); `typography.ts` copied into the package. `Slider` + the app-coupled
  components stay in `app/`. `@source "../../packages/ui/src"` added to
  `styles.css`. (3) `@apelles/editor` transport + toolbar rebuilt with
  `lucide-react` icons (`SkipBack` / `Play`–`Pause` / `SkipForward`, `Scissors`
  split, `Trash2` remove); empty-state action is a `@apelles/ui` `<Button>`.
  `npm install` clean, `tsc` 74 baseline unchanged, `vite build` green,
  `cargo check --no-default-features` unchanged (no Rust touched).

- **2026-09-02** — **Editor tab MVP (D-041)**. The Edit tab is a real, working
  single-video-track timeline of the open project's shots. `apelles-timeline` made
  real: `Timeline::from_shots`, `Track::clip_at` / `Timeline::duration`, and
  reorder / trim-start / trim-end / split / remove ops (each unit-tested, 9/9).
  New Rust bridge `chroma::edit` — `chroma_timeline_get` / `_set` / `_frame`
  commands; the timeline persists **in the `.chroma` project** (`ProjectManifest.timeline`,
  `#[serde(default)]`, schema major unchanged — same additive move as D-038's
  `settings`). The preview is a **standalone lightweight decode→jpeg**
  (`decode_pipe` → `image` q80 → `data:` URL), independent of the Colorist's
  wgpu / grade path. `@apelles/editor` is a real tab now: a
  `@xzdarcy/react-timeline-editor` strip (drag = reorder, edge-drag = trim,
  Split-at-playhead, select + Delete = remove) over a preview pane with a
  wall-clock rAF play loop, backed by `useEditorTimelineStore` (zustand, stays in
  `@apelles/editor` for now). Deferred: multi-track, audio, transitions,
  transcript cut, GPU compositing, grade-in-preview, OTIO export, MCP.
  `cargo build` + `apelles-timeline` 9/9 + `chroma::` 54/54 + `tsc` 74 baseline +
  `vite build` all green.

- **2026-09-02** — **3-tab shell (D-039 migration)**. `@apelles/shell` (react +
  zustand only): `<Shell tabs={registry}>` — an h-9 tab bar (Edit / Motion /
  Colorist) over the active tab, all tabs stay mounted, Cmd/Ctrl+1/2/3, active tab
  persisted to localStorage. `app/src/main.tsx` mounts it with the Colorist tab =
  the whole existing app untouched (root `h-screen` → `h-full`); Edit + Motion are
  placeholder tab components (`@apelles/editor` / `@apelles/motion`). `npm run build`
  (vite prod) green, tsc baseline 74 unchanged. The 3-tab layout is now live.

- **2026-09-02** — **Monorepo workspace skeleton (D-039 + D-040)**. The RapidRAW
  fork was de-submoduled into `app/` (D-040), then the workspace made real (D-039
  migration step 1): root `Cargo.toml [workspace]` (members `app/src-tauri` +
  `crates/*`, `Cargo.lock` moved to root, build profiles hoisted from the member);
  3 pure-leaf **stub** crates — `apelles-types` (`Resolution`/`Rational`/`ChromaError`),
  `apelles-timeline` (OTIO-shaped `Timeline`/`Track`/`Clip`), `apelles-grade-model`
  (`Grade` wrapper, mirrors `grade.json` D-025) — each `cargo check` clean with an
  `it_builds` test; root `package.json` npm workspaces + 6 stub packages
  `@apelles/{tokens,ui,bridge,editor,motion,shell}`; the Remotion motion engine moved
  in from `videoAgent/engine/motion/` as `packages/motion-engine/`
  (`@apelles/motion-engine`); `app` package renamed `rapidraw` → `@apelles/app`.
  Repo-wide `engine/…` → `app/…` path fixes (docs, `mcp/`, `ai/`, `eval/`, CLAUDE.md,
  README, sidecar comment). **No real code moved — the whole workspace builds
  (`cargo build --no-default-features` clean, `RapidRAW` crate + 3 stubs),
  `npm install` hoists, `tsc` baseline unchanged (74), `py_compile` clean.** Run the
  app: `npm run tauri:dev` from the repo root. Migration log in `D-039`
  ("### Migration log"); `crates/README.md` + `packages/README.md` carry the full
  planned lists.

- **2026-09-02** — **Per-project output spec (D-038)**. D-037's reserved,
  unused `settings` field on `project.json` gets a real typed shape:
  `ProjectSettings { width?, height?, fps?, color_space? }`, all optional. A
  multi-shot project now has **one** output spec instead of everything being
  derived from whichever clip is loaded. A fresh project seeds
  width/height/fps by probing the first shot's clip; a project with no settings
  behaves exactly as before (clip-derived, byte-identical exports). Export
  resizes the graded composite (Lanczos3) to the project resolution as the final
  step before the encoder and uses the project fps as the timebase. `color_space`
  (`rec709`/`rec2020`/`dci-p3`/`srgb`) is **stored + surfaced only** — a real
  colour-managed pipeline stays D-004. `chroma.project/1` schema major unchanged
  (additive; legacy `settings: {}` / `{fps:24}` still load). New
  `chroma_project_set_settings(path?, partial)` command (partial merge), a
  "Project settings" modal off the shot-strip gear, `get_state().project.settings`,
  MCP `set_project_settings` — **37 → 38** tools. All new logic in
  `chroma/project.rs` + `export.rs` + new frontend files; `lib.rs` +1 line.
  Verified: `cargo check` clean, `cargo test chroma::` **54/54** (49 + 5),
  `tsc --noEmit` baseline unchanged (74, none in new/touched files),
  `py_compile` + `import server` clean (38 tools). The settings modal + a
  resolution-override export + MCP round-trip are an open manual smoke test.
  Detail: `docs/notes/project-model.md`, `D-038`.

- **2026-09-02** — **Project launcher + `<name>.chroma` project model (D-037)**.
  The home screen was still RapidRAW's inherited Library view — a folder tree,
  photo grid, albums, culling. Replaced with a **project launcher**: a grid of
  saved Apelles projects, each a card with a cached thumbnail + name + relative
  timestamp, click to open. A project is a `<name>.chroma` **directory** (not a
  bundle) — `project.json` (versioned, `chroma.project/1` migration gate, shots
  referenced by **absolute source path** — media is never copied), `thumb.jpg`,
  and `grades/<shotId>.grade.json` (each shot's D-025 grade, inside the project
  so it travels with it). Default folder `~/Movies/Chroma/`, configurable. A
  missing source file → the shot shows **"media offline"** with a **relink**; its
  grade is untouched and reattaches. Completes D-033's deferred session
  persistence — D-033's in-memory `Session` is now the loaded form of a project.
  New `chroma/project.rs` (pure fs+json, like `grade.rs`; 8 tests) +
  `chroma_project_list/open/new/save/relink/current/settings_dir/set_dir`;
  `state.rs` += a `ProjectRef`. Frontend: `ProjectLauncher.tsx`,
  `useProjectAutosave.ts` (debounced save on any grade / shot / active-shot
  change), `useSessionStore` project thunks, one routing conditional in
  `App.tsx`, default `activeView` `'library'` → `'projects'`. **LibraryView /
  albums / culling not deleted** — folder navigation still routes to them, so
  upstream stays cherry-pick-able (D-003). Quick-open preserved: a loose clip via
  the picker or MCP `open(path)` → an in-memory "Untitled" session that still
  seeks / plays / exports / tracks. MCP: `list_projects` / `open_project` /
  `new_project` / `save_project`, `get_state().project` — **33 → 37** tools.
  Verified: `cargo check` clean, `cargo test chroma::` **49/49** (41 + 8),
  `tsc --noEmit` baseline unchanged (74, none in new/touched files),
  `py_compile` + `import server` clean (37 tools). Launcher / New-Project /
  autosave / reopen / relink are an open manual smoke test. Detail:
  `docs/notes/project-model.md`, `D-037`.

- **2026-09-02** — **Per-frame depth track (D-036)**. The depth-haze preset
  (D-024) baked ONE Depth Anything V2 map and reused it for every frame — it
  flickers / goes wrong on a moving camera. Replaced with a real **temporal
  video-depth track**, the same move DaVinci Resolve made: **Video Depth
  Anything — Small** (vits, **Apache-2.0** — vitb/vitl are non-commercial and
  must not be used), whose spatial-temporal head makes the depth stable
  frame-to-frame natively, not via a bolt-on filter. Runs in the `ai/` sidecar
  (new `/depth_track` job mirroring `/track`; VDA's cross-frame attention is
  exactly the "too fragile to ONNX-export" case behind D-009's sidecar
  precedent) — vendored (`ai/vendor/`, not pip-installable), checkpoint
  lazy-downloads (~112 MB), MPS fp32. Per-frame depth PNGs cache to
  `<clip>/.chroma/depth/<key>/` and are read at render time keyed by the current
  source frame via a new `chromaDepthDir` param + **one** hook in
  `mask_generation.rs::generate_ai_depth_bitmap` (mirrors D-019's tracked-matte
  read) — so scrub, playback and export all get per-frame depth for free. The
  Rust DA-V2 ONNX path is unchanged and stays the **static single-frame bake**
  for stills and for `apply_haze` before a track is run; absent `chromaDepthDir`
  → byte-identical to before. UI: a "Track depth over clip" button (mirrors the
  subject-track button). MCP: `depth_track` / `depth_track_status`, `apply_haze`
  gains `tracked` — **31 → 33** tools. Verified: `cargo test chroma::` 41/41
  (37 + 4), `cargo check` clean, `tsc` baseline unchanged (74), `py_compile` +
  `import server` clean. `ai/test_depth_track.py` on Tokyo-Walk: PNGs
  non-degenerate, VDA consec-frame |Δ| 0.0032 vs per-frame DA-V2 0.0050 (1.5×
  steadier). Detail: `docs/notes/depth-track.md`, `D-036`.

- **2026-09-02** — **Agent eval harness (D-035, round-3 tail item)**. New
  top-level `eval/` — a regression + capability test for the grading agent (does
  it *grade by the numbers* and converge on a target, or drift?). A 7-task data
  set (`eval/tasks.json`: neutralise a cast, match a shot to a reference, set
  black/white points, fix an exposure error, **don't over-grade** an
  already-correct frame, grade a masked region only, tame highlight clipping) +
  an **offline** scorer (`eval/score.mjs` — no app, no agent, no network). The
  scorer ports `computeScopes` / `computeGap` / `gapMagnitude` verbatim from
  `app/src/utils/scopes.ts` (`eval/lib/scopes.mjs`, drift-guarded by
  `scopes.check.mjs`) plus an **approximate** primary-grade operator
  (`eval/lib/apply.mjs`) that turns a `grade.json` (D-025) into a scoped result
  frame — so absolute scores are only comparable *within* the harness, and
  engine-fidelity is the `eval/run.md` closed-loop runbook's job. Score =
  normalised inverse residual scope gap to the goal, zeroed by hard-fail gates
  (clipping introduced, mask background moved, `knobEffort` over the cap).
  Committed `eval/baseline.json` = the setup grades left unfixed (mean **0.452**,
  2/7 pass); `eval/results/` (7 hand-authored good grades) score **0.975** (7/7,
  every task up vs baseline); `eval/bad_examples/` score **0.0** with gates
  firing — the scorer ranks good ≫ bad offline. Fixtures (`eval/fixtures/`,
  480×270, `_gen.mjs` to rebuild): a downscaled C019 still + synthesised wedge /
  patch frames. Dependency-free (Node `zlib` PNG codec). **Zero engine changes.**
  MCP: added the missing **adversarial** framing to the shared `SCOPE_DISCIPLINE`
  string, `inspect_color`, and `mcp/README.md` — tool count unchanged (**31**),
  `py_compile` + `import server` clean. Detail: `docs/notes/eval-harness.md`.

- **2026-09-02** — **Mask keyframes (D-034, round-3 item "mask keyframes")**. A
  shape sub-mask (radial / linear / brush) can now be **keyframed** — its
  geometry (centre / radii / rotation / feather, linear endpoints / range, brush
  points) is snapshotted at chosen source frames and **interpolated per frame**
  on scrub, playback and export, so a mask can hand-track a subject SAM can't or
  shouldn't follow (a hand, a product, a light, a reflection, a patch of sky).
  Geometry only — grade adjustments aren't keyframed. New **◆ Keyframe** button +
  a diamond track above the timeline (`components/chroma/MaskKeyframeBar.tsx`);
  the canvas overlay draws the **interpolated** shape at the current frame, and
  dragging the mask writes/updates the keyframe at that frame. Data model:
  `parameters.chromaKeyframes = [{frame, params}]`, round-trips through
  `grade.json` inline. Interpolation: linear scalars, **shortest-arc rotation**
  (350°→10° through 0°), brush points lerp when the stroke shape matches between
  keys else snap to the nearer key; clamp/hold outside the keyed range. Tracked
  (`chromaTrackDir`, D-019) and keyframed are mutually exclusive — tracked wins.
  Rust: new `chroma/keyframes.rs` (pure, 14 unit tests) + **one** hook call in
  `mask_generation.rs::generate_sub_mask_bitmap` (mirrors D-019). Frontend:
  `utils/maskKeyframes.ts` (Rust mirror), `MaskKeyframeBar.tsx`, `ImageCanvas.tsx`
  +~4, `useChromaControl.ts` +4 ops. MCP: `add_mask_keyframe` /
  `list_mask_keyframes` / `clear_mask_keyframe` / `clear_mask_keyframes`
  (27 → 31 tools). No `lib.rs` / Cargo / `AppState` change. `cargo check` clean,
  `cargo test chroma::` 37/37 (+14); `tsc --noEmit` baseline unchanged (74, none
  in a touched file); `py_compile` clean, 31 tools. Export + playback interpolate
  for free (both set `current_video().frame` before the grade). Manual app +
  canvas-drag smoke test open. Deferred: grade-adjustment keyframing (separate
  item), easing handles, a full dope sheet, brush strokes that change point
  count between keys (they snap). Detail: `docs/notes/mask-keyframes.md`.

- **2026-09-02** — **Multi-shot session model + shot strip (D-033, round-3 item 2)**.
  Apelles held one clip; now it holds a **session** — an ordered set of shots from
  one shoot, each with its own grade and its own agent-activity feed. New **shot
  strip** (`components/chroma/ShotStrip.tsx`, bottom bar): thumbnail + filename,
  an accent dot when the shot has a non-neutral grade, click to switch, `+` to
  add clips, `×` to remove, `→` to copy the active grade onto the next shot.
  Switching a shot stashes the live grade under the outgoing clip and restores
  the target's (the per-clip `grade.json` sidecar, D-025, is still the on-disk
  per-shot document). **Lightweight by decision** — no `.chroma` project bundle
  (D-033 weighs it against the project's minimal-fork / cheapest-thing bias).
  Rust: `chroma/state.rs`'s clip global becomes `Session { shots, active }`
  (`current_video()` unchanged — returns the active shot; `set_current_video`
  upserts by path); new `chroma/session.rs` (list / add / set-active / remove /
  thumbnail); `video.rs` +1 thumb helper. Upstream edits: `mod.rs` +2, `lib.rs`
  +5, `BottomBar.tsx` +4. Frontend: new `store/useSessionStore.ts`, `useAgentStore`
  per-shot feed scoping, `useChromaControl.ts` ops + `get_state.session`. MCP:
  `list_shots` / `set_active_shot` / `add_shots` (24 → 27 tools). Single-shot
  behaviour identical (one clip = a session of one shot). `cargo check` clean,
  `cargo test chroma::` 23/23 (+5); `tsc --noEmit` baseline unchanged (74, none
  in a touched file); `py_compile` clean. Deferred: `.chroma/session.json` reopen
  (path list, not a bundle), drag-drop reorder, copy-to-any-shot, per-shot
  `grade.json` auto-load. Manual app + MCP smoke test open. Detail:
  `docs/notes/multi-shot.md`.

- **2026-09-02** — **Agent activity feed + `request_human` (D-032, round-3 item 1)**.
  The GUI now shows every grade change the agent made through the MCP/control
  bridge: a fixed bottom-left "Agent activity" dock, newest-first, each entry a
  summary ("primary: exposure +0.35, temp −8" / "match to reference: 3 iters,
  gap 78→10") + an expandable per-field grade diff + a jump-to-here **Undo**.
  Recorded at the single `chroma://request` chokepoint in `useChromaControl.ts`
  (one entry per op — `debouncedSetHistory.flush()` collapses `match_reference`'s
  internal iterations; `seek`/`open` not logged). New `useAgentStore.ts` slice,
  `utils/agentActivity.ts` (`diffAdjustments` / `summarizeActivity`, pure),
  `components/chroma/AgentActivityDock.tsx` + `AgentRoiHighlight.tsx`. Undo is
  jump-to-here on RapidRAW's history stack (drops newer feed entries; documented
  fallback when the 50-slot stack has evicted the pre-op state). `request_human(
  reason, roi?)` — a new non-blocking op + MCP tool: posts a banner (+ an amber
  ROI rectangle on the canvas if `roi` given, normalized 0..1), the user clicks
  "Resume agent", the agent polls `get_state().pendingHumanRequest`. **No Rust
  change** (rides the generic `POST /op` path). Upstream edits: `App.tsx` +2,
  `ImageCanvas.tsx` +2. MCP 23 → 24 tools. `tsc --noEmit` baseline unchanged (74
  pre-existing unrelated errors, none in a touched file); `py_compile` clean.
  Manual running-app smoke test still open (bridge listener doesn't hot-reload).
  Detail: `docs/notes/agent-activity-feed.md`.

- **2026-09-02** — **Real-time playback ≥30 fps (D-031, round-2 item 5 tail)**.
  Closes the "frontend regrade + IPC per frame" ceiling D-030 named. New
  `app/src-tauri/src/chroma/playback.rs::chroma_play_frame` — one IPC call
  that decodes (scaled, via the D-030 pipe's new `-vf scale` path), swaps the
  base frame, and dispatches a single preview job at ~1280 px playback res,
  replacing per-frame `chroma_seek` + `bumpFrameNonce` + `apply_adjustments`
  (two IPC calls + a React round-trip + a full-4K grade + a ~40 ms CPU
  downscale). `ChromaTimeline.tsx` playback is now a `requestAnimationFrame`
  wall-clock loop (skips missed frames, no `setInterval` drift, no frame-drop
  mutex); pause settles full-res; scrub unchanged. `decode_pipe.rs` gained
  `scale_target` / `open_scaled` / `frame_scaled` / `playback_frame_scaled`
  (D-030's native fns are now `..._scaled(.., None)` wrappers, tests untouched);
  `chroma_seek`'s body extracted to `commands::seek_and_install`. Upstream
  edits: `chroma/mod.rs` +2, `lib.rs` +1. `cargo check --no-default-features`
  clean, `cargo test --no-default-features chroma::` 18/18. Headless timing
  harness (`playback_throughput_c019`) on C019 4K/24p, real WGSL grade via
  `render_core::render`: **27.4 ms/frame → 36.5 fps** at 1280 px (was
  68.8 ms → 14.5 fps at 4K), 19.6 ms → 50.9 fps at 960 px. Manual
  scrub/play/tracked-matte smoke test still open. Detail:
  `docs/notes/playback-30fps.md`.

- **2026-09-02** — **Smooth playback: persistent decode pipe (D-030, round-2 item 5)**.
  New `app/src-tauri/src/chroma/decode_pipe.rs` — one long-lived
  `ffmpeg -ss <(start-0.5)/fps> -i clip -f rawvideo -pix_fmt rgb24 -` per clip
  instead of a fresh spawn + keyframe seek + PNG round-trip per frame. `FramePipe`:
  a forward step is one raw `read_exact`, a ≤48-frame hop discards to target, a
  jump / backward kill+respawns. Process-global, dropped by `set_current_video` on
  a clip change, killed on `Drop`. `chroma_seek` decodes through it and falls back
  to `video::decode_frame` on any error; `load.rs` gained `install_frame` (the
  state-writing tail, so the transport doesn't re-probe). Export's `spawn_decoder`
  now seeks too — `-ss …-1s -copyts` + `select` by absolute timestamp `t` (not
  frame index `n`, which is why it stays tracked-matte-safe, the thing D-022
  avoided) — so a `from > 0` range no longer decodes from frame 0. Upstream edits:
  `chroma/mod.rs` +2 only; no `lib.rs` / Cargo change. `cargo check
  --no-default-features` clean, `cargo test chroma::` 14/14 (new pipe + seeked-
  decoder frame-alignment tests). Measured on C019 (4K/24p): 24 sequential frames
  **0.61 s (~39 fps)** vs **15.3 s (~1.6 fps)**; a mid-clip export frame **0.83 s**
  vs **2.9 s**. Open: the frontend per-frame regrade + IPC is now the fps ceiling.
  Detail: `docs/notes/smooth-playback.md`.

- **2026-09-02** — **Stripped `@clerk/react` (D-029, round-2 item 4)**. Removed the
  community-login dep RapidRAW ships for its hosted account — Apelles has no cloud
  (all AI is the local `ai/` sidecar + in-process ONNX). Gone: the `ClerkProvider`
  + hard-coded dev key in `App.tsx`, the `<TitleBar>` React error, the "loaded with
  development keys" console spam. `useUser`/`useAuth`/`useClerk` → local
  null-returning stubs at the 3 call sites; the Settings sign-in panel → a
  one-line "runs all AI locally" note. Frontend-only, no Rust change.

- **2026-09-01** — **Rust-managed AI sidecar (D-028, round-2 item 3)**. The app
  now starts and supervises the `ai/` FastAPI sidecar itself — no more `cd ai &&
  ./run.sh`. New `chroma/sidecar.rs`: resolves python (`CHROMA_AI_PYTHON` →
  `.venv/bin/python` → `python3` on PATH) + the `ai/` dir (`CHROMA_AI_DIR` →
  `CARGO_MANIFEST_DIR`-relative), spawns `uvicorn`, pipes its logs into
  `app.log` as `[sidecar] …`, polls `/health` (ready-in-Nms), restarts on crash
  with 2→30 s capped backoff (60 s slow-retry after 6 fast failures), and is
  killed on app exit via a `RunEvent::ExitRequested`/`Exit` hook. An already-
  running external sidecar is detected and only monitored, never killed or
  respawned. `CHROMA_AI_NO_SPAWN=1` opts out for manual `ai/run.sh` use.
  `chroma_ai_status` command for a future UI indicator. No new crate — the
  health check is a raw `TcpStream` HTTP GET, not blocking-`reqwest`. Known gap:
  packaged-app path resolution (`CARGO_MANIFEST_DIR` is a dev path) — flagged
  for Phase 4. Detail: `docs/notes/sidecar-lifecycle.md`.

- **2026-09-01** — **Per-mask blur (D-027, round-2 item 2)**. A `blur` field
  (0–100) on every mask's adjustments — defocus the masked region. Shader: renamed
  the dead `_pad_cg1` slot in `MaskAdjustments` → `blur` (Rust + WGSL, zero layout
  change) + a ~20-line loop in `shader.wgsl::main` that blends the masked region
  toward the shader's existing ~40 px `structure_blur` pre-pass, weighted by
  `mask · blur/100`, in linear light before tone-mapping (approach (a) — no new
  texture / pass). Frontend: a mask-only "Blur" slider in `Details.tsx`,
  `INITIAL_MASK_ADJUSTMENTS.blur = 0`, `set_mask_adjust` whitelist (`MASK_ONLY_KNOBS`,
  so `set_primary` still rejects it), a new `add_mask(type, geometry)` op for a
  plain radial/linear container, and `apply_haze` now dials in `blur` too (D-024's
  deferred background defocus — done). MCP `set_mask_adjust` gains a `blur` param.
  Verified on C019: `blur 70` under a radial mask drops masked local contrast
  ~25–35 % with unmasked patches at exactly 0, reversible at `blur 0`, blur present
  in an H.264 export, no wgsl compile error. Detail: `docs/notes/mask-blur.md`.

- **2026-09-01** — **`match_to_reference` — the automated grade-by-the-numbers loop
  (D-026, round-2 item 1)**. `match_reference` op in `useChromaControl.ts` + MCP
  `match_to_reference(reference, strength?, max_iters?, tolerance?)`. Loads a
  reference image (same neutral-preview path as `inspect_color`), measures the
  scope gap, and iterates a **damped** primary correction — exposure /
  temperature / tint / contrast / saturation — re-measuring each step until a
  combined gap magnitude drops below `tolerance` or `max_iters` (default 4) is
  hit. Gap→knob scalars: exposure ← mids-luma + common-mode black/white shift;
  temperature/tint back-derived from the app's WB-picker math; contrast ← spread
  difference; saturation ← raw HSV-sat difference (never a ratio). Machinery:
  near-constant damping (~0.78), per-knob per-step ceilings (contrast/saturation
  tight — they poison the next measurement), **roll-back any non-improving step** +
  halve strength, best-snapshot land, 2-stall / 16 s-budget stop. **Merges into
  `primary`** — a match is a balance; creative/curve/mask work is separate.
  Two-capture averaging on each measure to fight the 512-px-JPEG noise floor
  (D-021). Zero engine-Rust changes. Verified live on the 1080×1920 talking-head
  clip: a warm+bright reference vs a cool+dark subject → combined gap **78.3 → 10.0**
  over 5 iterations, monotone decreasing, `warmCool 12.7 → 56.6` (ref 58.1),
  `white 230 → 251` (ref 253), `sat 0.25 → 0.44` (ref 0.43); re-run is a no-op
  (0 accepted steps); an unrelated reference degrades gracefully (130.6 → 86.0
  then roll-back + stall-stop, all knobs finite + in range). Detail:
  `docs/notes/match-reference.md`.

- **2026-09-01** — **`grade.json` save/load + versioned schema (D-025)** — "the grade is
  code". New `app/src-tauri/src/chroma/grade.rs` (pure JSON+fs, no GPU/store):
  `chroma_save_grade` / `chroma_load_grade`. v1 `grade.json` is a **versioned wrapper**
  around RapidRAW's `adjustments` — `{schema:"chroma.grade/1", shot:{source,width,height,
  fps,frameCount,colorSpace,reference}, adjustments:{…}, notes}` — NOT `docs/06`'s ordered
  `stack` (that's the v2 node graph, D-005; `docs/06` rewritten, `stack` kept under "v2").
  Mask mattes externalized so the JSON stays diff-able: static `maskDataBase64` →
  `<name>.mattes/<subId>.png` + `{"$matte"}`, `chromaTrackDir` → `{"$trackDir"}`
  (referenced, not copied — moving a project needs `.chroma/mattes/` too). Load reverses
  it + a `chroma.grade/<major>` gate (v1 identity migration stub; rejects newer/unknown).
  Frontend `useChromaControl` ops `get_grade` / `save_grade` / `load_grade` (load →
  `setAdjustments(() => normalizeLoadedAdjustments(g.adjustments))` + `bumpFrameNonce`;
  **v1 does not auto-switch clips** — flags a `shot.source` mismatch, applies anyway).
  MCP: 3 tools. Engine edits: `chroma/mod.rs` +2, `lib.rs` +2; `cargo check` +
  `cargo test chroma::grade` (3/3) clean. Verified live against the 1080×1920 talking-head
  clip: `set_primary` + subject mask → `save_grade` → a 25 KB `grade.json` (schema tag,
  `{"$matte"}`/`{"$trackDir"}` refs, a `.mattes/` dir of 1080×1920 grayscale PNGs);
  one-knob change → one-line `git diff`; neutralize → `load_grade` → the grade + 3 masks
  (incl. a tracked one) come back, `inspect_color` deterministic across repeats; tracked
  `$trackDir` resolved to the clip's 527-frame matte folder. Detail: `docs/notes/grade-json.md`.
- **2026-09-01** — **Depth-haze preset (D-024)**. `apply_haze({amount?, protect_subject?})`
  / an "Add depth haze" button / `useAiMasking.handleAddDepthHaze` → a "Depth Haze" mask:
  a full-range `ai-depth` sub-mask **inverted** so the matte value tracks distance, graded
  with negative `dehaze` (adds haze) + `saturation -25` + `blacks +10` + `shadows +8`, all
  × `amount`. Depth is a **static** bake (per-frame / temporal smoothing deferred);
  `chroma_seek` now busts `ai_state.depth_map` so a re-apply on another frame is correct.
  No per-mask blur (no such field — deferred). Verified on the 1080×1920 talking-head clip:
  `inspect_color` blackPoint 17→33, saturation 0.33→0.24; background pixels lift ~10 luma +
  desaturate while the subject face is untouched; `amount` 0.4/1.0/1.6 scales monotonically.
  Also landed: `useChromaControl` **mounted at app level** (was `Editor`-only) + a new
  `open(path)` op/tool. Engine edit: `chroma_seek` +5 lines, `cargo check` clean. Detail:
  `docs/notes/depth-haze.md`.
- **2026-09-01** — **Video export + `.cube` bake (D-022)**. New
  `app/src-tauri/src/chroma/export.rs`: `export_video` (one `ffmpeg -f rawvideo`
  decode pipe → `render_core::render` per frame, one GPU ctx for the run → one `ffmpeg`
  encode pipe; ProRes 422 HQ / H.264) and `bake_primary_lut` (`size³` identity lattice
  through the primary grade only → `.cube`, warns on dropped masked layers). Per-frame
  tracked matte via new `chroma::state::set_current_frame` (D-019). Commands
  `chroma_export_video` (background + `chroma_export_progress`) / `chroma_bake_lut`;
  frontend `export` / `export_progress` bridge ops; MCP `export(kind, path?, from?, to?)`.
  Verified on the 1080×1920 test clip: neutral + `exposure` + tracked-subject exports
  (`ffprobe` + frame spot-checks) and a warm `.cube` that reddens a grey ramp in ffmpeg.
  Detail: `docs/notes/export.md`.
- **2026-09-01** — **Scopes + `inspect_color` (D-021)**. New `app/src/utils/scopes.ts`
  (pure JS, no deps): `computeScopes` (black/white points, luma + per-channel clip %,
  per-zone means, warm-cool + green-magenta cast, 12-bin saturation-weighted hue
  histogram, mean saturation), `renderParade` / `renderVectorscope` PNGs, `computeGap`
  (subject→reference hints that map onto knobs), `samplePoint` / `sampleRegion`.
  Wired into `useChromaControl` as read-only ops `inspect_color(frame?, reference?)` /
  `sample` / `sample_region`; every mutating op response now also carries the compact
  `scopes`. Reference images load via the existing `generate_preview_for_path` command
  — **zero engine Rust change**. `mcp/`: 3 new tools + scope-first discipline ("grade by
  the numbers; cite a scope value or a named region; defer the creative call") in the
  server instructions, the mutating tool docstrings, and `mcp/README.md`. Pure functions
  unit-checked on synthetic ImageData (grey / ramp / warm-cast / orange / clip / gap).
  Detail: `docs/notes/scopes.md`.
- **2026-09-01** — Repo scaffolded. `engine/` submodule = RapidRAW. Docs written (vision,
  PRD, scope, architecture, roadmap, research, grade-format, MCP surface, decisions).
  `CLAUDE.md` rules.
- **2026-09-01** — Engine code-read (`docs/09`). Rust 1.98, `cargo check` passes.
  Findings that shaped decisions: AI is ONNX-in-Rust not Python (**D-009**); `WgpuDisplay`
  is the native video-surface path (**D-006**); render core is Tauri-coupled → extract
  `render_core` (**D-014**). Added D-012 (SAM 1→2), D-013 (relight → v3).
- **2026-09-01** — ffmpeg → 4K Rec709 frame from the C019 test take works. Disk cleaned
  (3.6 → 38 GiB free).
- **2026-09-01** — D-003 decided (standalone hard fork; still keep changes clean for
  upstream cherry-picks), D-012 decided (SAM 2, no fallback).
- **2026-09-01** — App builds + launches (`tauri dev`, 7m18s). Phase 0 done.
  Phase 1 started: `src/chroma/video.rs` — ffmpeg probe + single-frame decode (D-015),
  first engine divergence (all under `src/chroma/`, +1 line in `lib.rs`). Tests pass
  against the real C019 4K take.

## Releases

_(none — pre-v1)_

- **2026-09-01** — Minimal video-open path built: a video loads as frame 0 through the
  existing grade pipeline (`src/chroma/{state,load}.rs` + 3 one-line hooks). Engine on
  branch `chroma`. App rebuilt + running.
- **2026-09-01** — Video transport bar + timeline view (filmstrip → 48-frame thumbnail
  strip when a video is loaded, click/drag to seek). Backend: `chroma_seek`,
  `chroma_video_info`, `chroma_frame_thumbnails` (cached).
- **2026-09-01** — SAM 2 subject mask working (D-012 → Python sidecar, `ai/`,
  `ultralytics` on MPS). Clean silhouette matte on the 4K test frame — the ellipse's
  hands problem is solved. `/segment` supports box + multi-point (+/−) prompts.
- **2026-09-01** — Matte edge refine (**D-016**): SAM 2's 256px decoder staircases at 4K;
  guided-filter finesse (the Resolve approach) failed on the low-contrast test shot; added
  a trimap → **ViTMatte** stage → clean edge. Worklog + before/after in
  `docs/notes/matte-edge-pipeline/`. `transformers` + `opencv-contrib-python` added.
- **2026-09-01** — Subject mask wired into the engine: `src/chroma/mask.rs` —
  `chroma_subject_mask` bridges the current frame → sidecar `/segment` → an `ai-subject`
  mask (RapidRAW's own type, so the grade UI + render are untouched). Box-drag on a loaded
  video now routes to SAM 2 + ViTMatte instead of ONNX SAM. `chroma_ai_health` for a UI
  hint. Engine + frontend both compile; app runs.
- **2026-09-01** — Per-frame subject **tracking**. Sidecar `/track` (background job,
  mattes cached to `<video>/.chroma/mattes/<key>/`), `/refine_track` (upgrade one frame to
  ViTMatte). Engine: `chroma_track_subject`, `chroma_track_status`,
  `chroma_subject_matte_for_frame`, `chroma_refine_tracked_frame`. Frontend: "Track subject
  across clip" + "Finalize matte" buttons + seek swaps the frame's matte. **fast/quality
  modes** — guided-filter edge on the pass, full ViTMatte on the visible frame.
- **2026-09-01** — Tracking rewritten to **SAM 2 memory propagation** (**D-018**):
  `SAM2DynamicInteractivePredictor` (in the installed ultralytics — no new dep), prompt
  once, ~180ms/frame, every frame gets a matte. Gotchas: `conf≈0`, `obj_ids` 0-indexed,
  refine the loose prompt box to a YOLO person box first.
- **2026-09-01** — **B-002 fixed**: sidecar climbed to ~12 GB after repeated Re-track
  (fresh predictor per pass never returned to the MPS pool + concurrent stacking). `_GPU`
  lock serialises model calls; one reused predictor; `_free_gpu()` after every op; `/track`
  cancels a running pass. Plateaus ~1.3 GB now.
- **2026-09-01** — **D-014 done**: `render_core.rs` seam — the render fn takes
  `RenderCaches` (the 2 GPU-cache mutexes) instead of `tauri::State<AppState>`; added
  `init_gpu_context()` (surface-free). GUI render path byte-identical. Unblocks headless
  render + the control/MCP server (next).
- **2026-09-01** — Tracking display reworked (**D-019**): matte is read from disk **at
  render time** (`params.chromaTrackDir` → `tracked_full_mask` → `<dir>/<frame>.png`) in
  `generate_ai_subject_bitmap`, not swapped into `adjustments` per seek. Fixes the
  overlay-regen storm, the frozen timeline, and the frame/matte desync (offset red blob).
  Persists with the project — no re-track on reopen. Also fixed: `ChromaTimeline` root
  capture-phase `stopPropagation` was eating strip clicks. **Mask follows the frame
  perfectly in-app now.**
- **2026-09-01** — **Control server + MCP bridge (D-020) — v1**. `src/chroma/control.rs`
  (`tiny_http`, port 19788, spawned in `.setup()`) ⇄ Tauri events ⇄ new
  `src/hooks/useChromaControl.ts` (mounted in `Editor.tsx`). One shared grade/mask state:
  every MCP op calls the same store action the GUI buttons do (`setAdjustments`, the
  `useAiMasking` handlers, `chroma_seek`) — sliders move, history/undo work, `get_state`
  reflects manual edits. New `mcp/` dir: Python stdio MCP server, 11 tools
  (`get_state, set_primary, set_curve, set_color_grade, seek, list_masks, add_subject_mask,
  track_subject, set_mask_adjust, invert_mask, delete_mask`). Mutating ops return the
  rendered frame (`generate_uncropped_preview`) + histogram + adjustments. Verified end to
  end with `curl` and an MCP client against the C019 take (exposure moves the slider + the
  canvas; subject mask created on the video). Engine edits: `Cargo.toml` +1, `mod.rs` +1,
  `lib.rs` +6. `cargo check` clean.
- **2026-09-01** — Mask refinement decided (**D-023**): use RapidRAW's existing
  Add/Subtract/Intersect composition (works with SAM Subject too), NOT a +/− point
  mechanism. No point UI built. MCP gains `add_subject_mask(mode)`,
  `add_component(mask_id, type, mode)`, `set_submask_mode` — all through the same
  `createSubMask`/`updateSubMask` a slider uses. `ai/` + engine `points` support left
  unused.
- **2026-09-03** — **Full NLE, Phase 1 (D-086): real data model for track
  lock/hide, clip transform, and rearrange.** `apelles_timeline::Track`
  gained `locked`/`hidden`; `Clip` gained `opacity`/`position_x`/
  `position_y`/`scale`/`rotation`/`chroma_keyframes` (reusing the existing
  D-034 keyframe engine, not a new one). New `Timeline::move_track` and
  `resolve_visible_video_layers_at` (the multi-layer generalization of the
  existing single-winner track resolver — the real query the Phase 2
  compositor needs). 58/58 apelles-timeline tests, 143/143 chroma:: tests
  unchanged. Phase 2 (the actual compositor) is next.
- **2026-09-03** — **Full NLE, Phase 2 (D-088): a real video track
  compositor exists now.** `chroma_timeline_frame` alpha-blends every
  visible video layer at a position (not just the top opaque winner) —
  real position/scale/rotation/opacity, keyframeable. CPU-based (real
  arbitrary-angle rotation, real alpha blending), no new dependencies. The
  single-track case is untouched, byte-identical. 7 new pure compositing
  tests, all passing on the first run.
- **2026-09-03** — **Full NLE, Phase 3 (D-089): TypeScript mirror of the
  lock/hide/rearrange/transform data model.** `packages/editor/src/
  timeline.ts` gains `Track.locked`/`hidden`, `Clip`'s transform fields, and
  new ops `set_track_locked`/`set_track_hidden`/`move_track`/
  `set_clip_transform`/`set_clip_keyframes` — `applyOp` mirrors Rust's
  `TrackLocked` refusal exactly (per-clip ops refused on a locked track,
  `move` checks both source and destination, track-list ops stay ungated).
  27 new vitest tests (68/68 across `packages/editor`), `tsc --noEmit`
  clean, `app`'s 64-error baseline unchanged. Phase 4 (UI) is next.
- **2026-09-03** — **Full NLE, Phase 4 (D-090): the UI — the P0 effort is
  done.** `TimelinePane.tsx` gains track header lock/hide toggles, up/down
  rearrange (native row-drag checked, buttons shipped instead — see D-090),
  a clip-transform popover (opacity/position/scale/rotation), and
  keyframing UI reusing `RelightPanel.tsx`'s Diamond-icon pattern via new
  `clipKeyframes.ts`. No new inline props into the timeline library's own
  render path (D-083 discipline held). 11 new tests (79/79 across
  `packages/editor`), `tsc --noEmit` clean both packages, clean app boot.
- **2026-09-03** — **React Compiler enabled (D-091).** `app/vite.config.mjs`
  now runs `babel-plugin-react-compiler` via `@rolldown/plugin-babel` +
  `reactCompilerPreset()` (the real v6 wiring, not the removed inline
  `react({ babel: {...} })` option) across every source package this build
  consumes. Verified via the compiler's own `logger.logEvent` API (bundle-
  grepping for its runtime import/function names is unreliable post-bundle/
  minify — chased that dead end first): 265 `CompileSuccess` events across
  110 unique files, 120 legitimate bailouts (mostly `try/finally`, a
  documented compiler limitation) across 45 files, no build errors. A quiet
  bailout-only `console.warn` logger stays wired in permanently for ongoing
  visibility.
- **2026-09-03** — **`app/bench` UI perf harness revived, retargeted at the
  Edit-tab timeline (D-092).** Its old `scroll`/`open`/`edit` phases
  targeted RapidRAW's library grid/editor sliders, removed by the D-043 DAM
  strip-out — replaced with `pan`/`dragover`/`move` phases against the
  multi-track timeline. `dragover` directly stress-tests the D-083 freeze
  scenario (sustained native `dragover` ticks over the timeline), the most
  relevant probe for whether the new React Compiler (D-091) helps. Also
  added `docs/notes/performance-instrumentation.md`, inventorying every
  other real timing mechanism already in the codebase (Rust
  `Instant::now()`/`log::info!`, sidecar `time.time()` + `GET /memory`).
  Honestly flagged, not faked: no tool this session can drive the native
  Tauri window, so no compiler-on/off numbers were captured — the script's
  ready, running it by hand is the next step.
