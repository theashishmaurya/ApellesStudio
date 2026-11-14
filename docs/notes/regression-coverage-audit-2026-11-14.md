# Regression-coverage audit — the bugs fixed in the fortnight to 2026-11-14

**What this is.** A bug-by-bug audit of whether the defects fixed between
2026-11-03 and 2026-11-10 (B-380 … B-402) have a test that would **fail if the
fix were reverted** — and the tests added where they did not. Written because
of two things that happened in that same fortnight:

- **B-402.** v0.3.0 shipped unlaunchable. It compiled, 520 lib tests passed, the
  bundle verified and the DMG checksummed. Nothing ran the app.
- **B-391 → B-399 → B-400.** One still-image decode bug had to be found three
  times, because each site was fixed and verified by hand in the running app and
  nothing pinned the shared behaviour.

The owner's instruction was "have test for all". This is the pass that checked
rather than assumed: every entry that NAMES a test had that test's existence and
its content verified, not taken on the entry's word.

**Method.** For each fixed entry: locate the named test (or search for any), read
it, and where a gap was filled, *revert the fix and watch the new test fail*.
Every claim of "would catch it" below was checked that way, and the revert
undone. Nothing in the product changed.

## Covered — the fix is pinned, verified

| Bug | Test | Verified |
|---|---|---|
| B-400 still unopenable after reopen | `chroma::load::decode_shot_picture`'s 4 tests | exists, covers the routing at the one function all three sites now call |
| B-398 letterbox darker than the pane | `viewer_space::a_ui_colour_shows_as_itself_in_a_rec709_layer` | exists |
| B-397 / B-255 intermittent `--lib` failure | `audio::audio_keeps_playing_across_ripple_cut_boundaries` (rewritten to poll for the device) | exists; 5 clean full runs on the fixing session, 1 here |
| B-395 one unplayable clip aborts playback | `preview_surface::player`'s 3 tests | all three exist |
| B-394 Cmd+D does not duplicate | `duplicateClip.test.ts` (6) | exists, covers placement, ripple, carried work, identity, lock refusal, A/V pair |
| B-393 gap refusal never reaches the person | `TimelinePane.gap.dom.test.tsx` (6) | exists, real pane + real store |
| B-392 swap leaves the old name | `audioOnlyClip.test.ts` (2 of its cases) | exists — auto-derived name follows, chosen name kept |
| B-389 audio-only source on a video track | `audioOnlyClip.test.ts` (4) | exists |
| B-388 harness overlay guard raced a sheet | `runner.test.ts` | exists |
| B-387 pinch convention | `timelineZoom.test.ts` + `TimelinePane.zoom.dom.test.tsx` 9–11 | exists; jsdom, which the entry already states |
| B-386 lost control-bridge replies | `control::a_reply_reaches_its_waiter_by_id` | exists |
| B-385 export sound short of the picture | `edit_render::parity_tests::a_prores_master_s_sound_runs_the_picture_s_whole_length` | exists; renders for real |
| B-384 empty edit decoded black | `vt_decode::tests::an_empty_edit_at_the_start_holds_the_first_frame_not_black` | exists |
| B-383 out-of-range title size | `textClip.test.ts` + `text::an_out_of_range_title_size_is_clamped_to_the_frame` | both exist |
| B-382 mixed-rate clip showed the next frame | `apelles-timeline::a_mixed_rate_clip_shows_the_frame_on_screen_not_the_next_one`; the TS twin in `speedRamp.test.ts` | both exist — the TS half was not named in the entry and is covered anyway |
| B-379 Inspector re-mounts after a release | `EditorInspectorPanel.noRemount.dom.test.tsx` (3) | exists |

## Weakly covered — real coverage with a caveat now written down

- **B-381** (spatial effects baked into the LUT). `spatial_effects_are_named_and_kept_out_of_the_lattice` exists and is the right test, but it opens with `gpu_or_skip`, which **returns early and reports pass** when no GPU adapter is available — only an `eprintln!("skip: …")` distinguishes the two. Real coverage on a dev Mac, none on a GPU-less runner, and the summary never says which. Noted in the entry; making the skip visible is a worthwhile fix for whoever is next in `grade_lut.rs`/`export.rs`.
- **B-391 half 2** (`list_shots` reported the composition size as the source's). Now pinned at the **wire-contract** level only — see below for what that does and does not catch.

## Not unit-testable, said so rather than inventing a weak test

- **B-380** (4K export slower than real time). The closing condition is a wall-clock ratio on real footage. The instrument is `measure_export_benchmark`, `#[ignore]`d on purpose — it renders a 60 s timeline and needs the app closed, since every segment shares the one hardware encoder. A unit test asserting a timing would be precisely the load-sensitive shape that cost two sessions on B-397/B-255. The guard is the benchmark at each perf pass, numbers in `docs/perf/`.
- **B-399's Rust half** (the still branch in `chroma_session_thumbnail`). The branch sits inside a `#[tauri::command]` that reads the process-global session, so a test would have to mutate global state the rest of the suite shares. Covered instead: the primitive it routes to (`still::thumbnail_is_a_height_bounded_jpeg_data_url`) and the sibling routing it was missing from (`decode_shot_picture`). The real fix is to lift the branch out of the command the way `decode_shot_picture` was lifted — a change to make when someone is next in `session.rs`, not a test-only refactor.
- **B-387's end-to-end half.** A pinch cannot be delivered from outside the app on this platform (the entry proves it against the ObjC runtime). The maths and the wiring are tested in jsdom; the end-to-end fact came from the owner's own trackpad and can only come from there.

## Uncovered — tests added, 2026-11-14

| Bug | Added | What it catches | Revert-checked |
|---|---|---|---|
| **B-402** critical | `chroma::startup_contract` (3) | a plugin registered without the `plugins.*` block it cannot start without — the exact v0.3.0 panic, caught in milliseconds instead of at a user's launch. Includes a test of the rule against the failing shape, so the guard is not vacuous while the plugin stays unregistered | yes — re-adding `.plugin(tauri_plugin_updater::…)` fails it with the B-402 message |
| **B-390** | `packages/editor/src/addClipSecs.dom.test.tsx` (7) | `durationSecs`/`sourceStartSecs` converting from the SOURCE's rate, on this entry's own 17.2 and 59.94 fps sources; the frame forms untouched; seconds winning over frames; refusal wording; no sub-frame zero | yes — 5 of 7 fail with the conversion removed |
| **B-396** | `packages/keymap/src/shortcuts.test.ts` (7), `packages/shell/src/Shell.settingsAction.dom.test.tsx` (3), `app/src/components/chroma/SettingsButton.dom.test.tsx` (2) | ⌘, resolving in all four scopes (the half that was broken), the chrome-bar slot on all three tabs, a labelled gear that sets the one shared flag | yes — restoring the `colorist`/`library` registry row fails 2 |
| **B-399** frontend half | `app/src/components/chroma/ShotStrip.dom.test.tsx` (3) | a failed thumbnail reported with the clip name and the backend's words, rather than swallowed — the third time this `.catch(() => {})` shape has been written (D-121/B-037 removed it once) | yes — restoring the bare catch fails 1 |
| **B-391** half 2 | `chroma::session::a_shot_reports_its_sources_own_pixels_beside_the_composed_frames` | `sourceWidth`/`sourceHeight` staying on the wire beside `width`/`height`. **Limit, stated in the test:** it pins the contract, not the project-resolved path (`display_info` needs a real open project for `resolve_for` to read), so a dropped or renamed field fails and a field wired to the wrong source would not | n/a — the revert is "delete the fields", which fails to compile |

## Found while writing the tests, not fixed

**B-403** — the shot strip's Save-project button reads "FloppyDiskIcon project".
D-294's lucide→Phosphor rename took the word "Save" in the label with the
component name. Logged with evidence; left alone, because this was a
test-coverage pass.

## The one structural lesson

Three of the five gaps were on the GUI side of a both-interfaces feature
(B-396 twice, B-399's frontend). The op/store layer is well tested in this repo;
the thing that keeps shipping untested is the affordance that makes a capability
reachable — a button, a slot, a scope, an error that reaches a person. A missing
button is invisible to every other test in the suite, which is exactly why it
needs its own.
