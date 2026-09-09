# Crate extraction plan — D-039 steps 3–7, from the real code

**Status:** scoped 2026-09-05 (**D-141**). This is the execution map for the rest of the
D-039 migration. `docs/notes/architecture-lock.md` states the *target* shape and stays the
authority on layering; this document states what is actually in `app/src-tauri/src/chroma/`
today, which slices can move, in what order, and which can run in parallel.

Everything below was read out of the code, not inferred from module names. Where the lock
doc and the code disagree, the code is quoted and the lock doc is corrected here.

Prior step: **D-053** (`apelles-types`, partial-by-design). Its standard applies — a type or
a module moves only if it is genuinely the same concept in the new home, and what does *not*
move is named with a reason.

---

## 0. The real current state

`app/src-tauri/src/chroma/` — 22 modules, **18,908 lines**, 64 `#[tauri::command]`s.
The rest of `app/src-tauri/src/` (the RapidRAW fork proper) is 31,366 lines.

| module | LOC | `#[tauri::command]` | other `tauri::` | reaches into the fork (`crate::…`) |
|---|---:|---:|---|---|
| `project.rs` | 5012 | 20 | `State<AppState>` | `app_state::AppState` |
| `audio.rs` | 3086 | 5 | — | — |
| `export.rs` | 1727 | 3 | `async_runtime` | `adjustment_utils`, `gpu_processing`, `image_processing`, `lut_processing`, `mask_generation`, `render_core` |
| `edit.rs` | 1681 | 13 | — | — |
| `filmstrip.rs` | 1241 | 1 | — | — |
| `relight.rs` | 799 | 0 | — | `gpu_processing`, `image_processing`, `render_core` |
| `video.rs` | 773 | 0 | — | `formats` (**in a test only**) |
| `sidecar.rs` | 704 | 1 | `AppHandle` (**unused**) | — |
| `decode_pipe.rs` | 514 | 0 | — | — |
| `state.rs` | 497 | 0 | — | — |
| `keyframes.rs` | 422 | 0 | — | — |
| `grade.rs` | 376 | 2 | — | — |
| `mask.rs` | 322 | 5 | `State<AppState>` | `AppState`, `ai_processing`, `get_cached_full_warped_image` |
| `media_cache.rs` | 311 | 0 | — | — |
| `depth.rs` | 288 | 2 | — | — |
| `playback.rs` | 278 | 1 | `State<AppState>` | `app_state`, `gpu_processing`, `image_processing`, `mask_generation`, `render_core` |
| `session.rs` | 223 | 5 | `State<AppState>` | `app_state`, `image_loader` |
| `commands.rs` | 174 | 3 | `State<AppState>` | `app_state`, `image_loader` |
| `control.rs` | 164 | 0 | `AppHandle`, `Emitter`, `Listener` | — |
| `motion.rs` | 144 | 3 | `async_runtime` | — |
| `load.rs` | 119 | 0 | `State<AppState>` | `app_state`, `image_loader`, `image_processing` |
| `mod.rs` | 53 | — | — | — |

### The fork reaches *up* into `chroma` in five places

This is the constraint the lock doc does not mention, and it matters more than any of the
downward edges. These are calls from RapidRAW core (which stays in `app/`) into Apelles code
(which is supposed to move down into crates):

| caller (stays in `app/`) | callee |
|---|---|
| `mask_generation.rs:1036` | `chroma::mask::tracked_full_mask` |
| `mask_generation.rs:932`, `:1366` | `chroma::depth::tracked_depth_map` |
| `mask_generation.rs:1434`, `:1439`, `:1462` | `chroma::relight::resolve_depth_dir` / `resolve_depth_bake` / `resolve_normals_bake` |
| `mask_generation.rs` (sub-mask geometry hook) | `chroma::keyframes::interpolated_parameters` |
| `mask_generation.rs`, `state` readers | `chroma::state::current_video` |
| `image_processing.rs:1629`, `:1633` | `chroma::relight::parse_relight_lights_gpu`, `resolve_normals_bake` |
| `image_loader.rs:898`, `formats.rs:116`, `file_management.rs:1466` | `chroma::video::is_video_file`, `VIDEO_EXTENSIONS`, `chroma::load::load_video_frame` |

`app → crate` is legal in the D-039 graph, so most of these are fine once the callee is a
crate. The two that are **not** fine are `relight.rs` and `mask.rs`: they import *from* the
fork (`image_processing::RelightLightGpu`, `ai_processing::AiSubjectMaskParameters`,
`crate::get_cached_full_warped_image`) while the fork imports *from* them. Those are real
cycles and neither module can be extracted as-is (see §2.6, §2.7).

### What is already further along than the roadmap text says

- **`apelles-timeline` is not a stub** — 3,758 lines, real (D-041/045/046/082/136/137/138),
  a real dependency of `app/src-tauri`, and the model behind `edit.rs`'s 13 commands.
- **`apelles-motion` is real and is the template** (D-046): a 213-line pure crate plus a
  144-line app-side `motion.rs` holding the 3 `#[tauri::command]`s. Every slice below should
  produce exactly this shape.
- **`apelles-grade-model` is a stub and is not even a dependency of `app/src-tauri`.** The
  real `grade.json` document still lives entirely in `chroma/grade.rs`.
- **`apelles-types` is real but thin.** Still free-floating after D-053 and available for a
  later step: `VideoInfo.fps_num`/`fps_den` are still bare `u32` siblings rather than
  `Rational` (D-053 added only the `Display` impl); `TimeRange` still exists nowhere outside
  `apelles-timeline`; `Frame` is named in the crate doc but does not exist; `ColorSpace` is
  still a free `String` by design (D-038/D-004).

### The seam the code already has

`export.rs`, `project.rs`, `edit.rs`, `filmstrip.rs` and `audio.rs` are all already written
as "pure body first, a `// tauri commands` section last." That is the extraction line, and
it is a real line, not one to be invented:

| module | Tauri-free | commands | tests |
|---|---|---|---|
| `edit.rs` | L1–364 | L365–1116 | L1117+ |
| `project.rs` | L1–1678 | L1679–2488 | L2489–5012 |
| `export.rs` | L1–865 | L866–960 | L961+ |
| `filmstrip.rs` | L1–598 | L599–704 | L705+ |
| `grade.rs` | body fns `save_grade`/`load_grade` | the 2 command wrappers (L55, L158) | L298+ |

---

## 1. The rule that makes all of this tractable: commands do not move

**`#[tauri::command]` functions stay in `app/src-tauri`.** Extracted crates export plain
Rust functions; the app keeps a thin command module per tab that calls them. This is the
`apelles-motion`/`motion.rs` shape that already exists and works.

This is not a stylistic preference. Read out of `tauri-macros-2.6.3` (the pinned version, via
`tauri = "2.11"`):

1. `src/command/wrapper.rs` L162–167, L317, L326 — on a `pub fn`, the attribute emits **two**
   `macro_rules!` items, `__cmd__<name>` and `__tauri_command_name_<name>`, each carrying
   `#[macro_export]`.
2. `src/command/handler.rs` (`impl From<Handler> for TokenStream`) — `generate_handler![a::b::foo]`
   expands to `a::b::__tauri_command_name_foo!()` as the match arm and
   `a::b::__cmd__foo!(a::b::foo, invoke)` as the body. The macros are invoked **at the same
   path as the function**.
3. `#[macro_export]` puts a `macro_rules!` at the *defining crate's root*. So a command moved
   to `apelles_media::probe::foo` would have its macros at `apelles_media::__cmd__foo`, and
   `generate_handler![apelles_media::probe::foo]` would look for `apelles_media::probe::__cmd__foo`
   and not find it. Tauri's own source comment names the workaround
   (*"macros used with `pub use my_macro;` need to be exported with `#[macro_export]`"*): the
   crate must `pub use crate::__cmd__foo;` **and** `pub use crate::__tauri_command_name_foo;`
   into whatever module path the handler list names.
4. The wrapper body expands `#root::ipc::private::*`, and `root` defaults to `::tauri`
   (`wrapper.rs` L49). `root = "crate"` exists only for use inside `tauri` itself. So a crate
   hosting a command needs a **real `tauri` dependency** — which pulls Tauri into the domain
   layer and breaks both D-039 principle 2 ("dependency-light core") and principle 7
   (rebuild-time isolation).
5. Any command taking `tauri::State<'_, AppState>` is worse than awkward, it is impossible:
   `AppState` lives in `app/src-tauri/src/app_state.rs` and owns RapidRAW's GPU context and
   caches. A crate hosting such a command would have to depend on the app crate. That is a
   cycle. **8 of `project.rs`'s 20 commands, and all of `mask.rs`/`session.rs`/`commands.rs`/
   `playback.rs`/`load.rs`, are in this class.**

**ACL is a non-issue.** `handler.rs::filter_unused_commands` calls
`tauri_utils::acl::read_allowed_commands()`; `app/src-tauri/capabilities/default.json` lists
only plugin/core permissions and no application commands, so `has_app_acl` is false and the
early return keeps every app command allowed. Nothing to update — *provided command names do
not change*. Command names are the frontend contract (`packages/bridge`); a rename is a
separate, deliberate change, never a side effect of a move.

**Gap, stated honestly:** I read the macro source and traced the expansion, but did not
compile a cross-crate `#[tauri::command]` to prove the `pub use`-both-macros route works
end-to-end — this pass writes no code. If a later slice ever *wants* a command in a crate,
that route must be spiked for real first. Nothing in this plan needs it.

**Second rule, and it is what makes parallelism safe:** every extraction leaves a
`pub use chroma_<crate>::…;` shim at the old path, **in the same commit**. `chroma/video.rs`
becomes `pub use apelles_media::video::*;`, `crate::render_core` becomes a re-export of
`apelles_gpu`. Consequences: no call site outside the slice changes, `lib.rs`'s
`generate_handler!` block is never touched by any slice, and two agents working on different
slices never edit the same line. The shims are then deleted in one cheap sweep at the end
(one commit, mechanical, no behaviour).

---

## 2. The slices

### 2.1 `apelles-gpu` — `render_core` only, and it is smaller than it looks

**Status: done, partial-by-design (D-144, 2026-09-05).** The entanglement question
below was resolved by reading the real definitions: `GpuContext` *does* split.
`crates/apelles-gpu` now holds a headless `GpuContext { device, queue, limits }` +
`init_gpu_context()`, moved verbatim from `render_core.rs`. The app's own
`image_processing::GpuContext` (unchanged) is the app-side half — same three fields
plus the `display: Arc<Mutex<Option<WgpuDisplay>>>` field, because `WgpuDisplay`
(`gpu_processing.rs`) owns a `wgpu::Surface<'static>` bound to a native window plus
the on-screen present pipeline — genuinely app/GUI-side, not a domain concept.
`render_core::init_gpu_context()` stays at its old path and signature, now a
2-line wrapper around `apelles_gpu::init_gpu_context()` that adds `display: None`
back on, so the 6 `render_core::` call sites in `chroma/export.rs`,
`chroma/playback.rs`, `chroma/relight.rs` needed zero changes. `render()` did not
move, per plan. `cargo check -p apelles-gpu` is clean; the full-workspace
`cargo check -p apelles -p apelles-timeline -p apelles-gpu --all-targets` and
`cargo test -p apelles --lib -- chroma::` are the real proof and are recorded in
`docs/CHANGELOG.md`.

**Real content:** `app/src-tauri/src/render_core.rs`, 120 lines. That is genuinely all of it
that is extractable today.

`render_core::init_gpu_context()` (L80–120) is pure `wgpu` and moves cleanly. But
`render_core::render()` (L55–75) is a pass-through into
`gpu_processing::process_and_get_dynamic_image_inner`, and its signature is
`GpuContext` + `RenderCaches<'_>` + `RenderRequest<'_>` — all three defined in
`image_processing.rs` (3,528 lines), `app_state.rs` and `gpu_processing.rs` (2,027 lines)
respectively, i.e. in RapidRAW core. Moving `render()` means moving the whole grade path,
which is `apelles-grade`, not `apelles-gpu`.

**Scope it honestly:** `apelles-gpu` v1 = the headless device/queue/limits construction plus
whatever texture-pool helpers are genuinely free of `image_processing`'s types. `GpuContext`
itself has to move with it (it is the return type) — check whether that pulls
`WgpuDisplay` along; if it does, `GpuContext` splits into a Apelles-side device/queue/limits
struct and an app-side display wrapper.

**Who imports it:** `chroma/export.rs`, `chroma/playback.rs`, `chroma/relight.rs`, plus
`gpu_processing.rs` itself — 6 `crate::render_core::` references in `chroma/*` alone. With
the re-export shim, zero of them change.

**Risk:** low blast radius *if* the shim rule is followed; medium if `GpuContext` turns out
to be entangled with `WgpuDisplay`. That entanglement is the one thing to check before
committing to a size estimate.

### 2.2 `apelles-media` — the largest real win, and it splits into three commits

**Status: done (D-146, 2026-09-05).** All three commits below landed in order, as
scoped. What the plan got right and what it did not:

- **Right:** the 1,598-line core really was `tauri::`-free and fork-import-free;
  `probe_cached` really was the hard ordering constraint; `filmstrip.rs` really did
  move whole once it landed; `audio.rs` really did have to split at
  `edit::resolve_video_position`.
- **Missed one case of the same class it did name:** `decode_pipe::open_pipe_count`
  is a second `#[cfg(test)]` item the app's tests reach (from `chroma/edit.rs`),
  alongside the `media_cache::init_for_tests` this section calls out — and commit 3
  added three more for the audio session state. All are behind one `test-support`
  feature enabled from `app/src-tauri`'s `[dev-dependencies]` only, chosen over
  `#[doc(hidden)] pub` because an unconditional `pub` ships them in release builds.
- **Under-described the `audio.rs` split.** "The engine and waveform move; the
  resolution stays app-side" is right but hides a real design question: the session
  *claim* has to happen before the resolution, because `requested_at` is what D-125's
  skew compensation measures against. So it is not one function that stays and one
  that moves — `chroma_audio_play` became `begin_play(seq) -> Option<PlaySession>`
  (crate) → resolution (app) → `start(session, sources)` (crate), with
  `AudioSourceSpec` as the boundary type.
- **B-056 and B-057 both fixed in the commits this section names**, each with a
  regression test confirmed to fail against the pre-fix code. See D-146.

This is where the value is: `video.rs` + `decode_pipe.rs` + `media_cache.rs` are **1,598
lines with zero `tauri::` references and zero fork imports**. They are ready to move today.

**Commit 1 — the core (no behaviour change, no command touched).**
`video.rs` (773) + `decode_pipe.rs` (514) + `media_cache.rs` (311). Internal edges:
`decode_pipe → video::VideoInfo`; nothing else. Two real details:

- `video.rs`'s test at L653–656 asserts `crate::formats::is_supported_image_file("clip.mov")`
  — i.e. it tests *the fork's* routing hook, not `video.rs`. It cannot move into
  `apelles-media`. Leave it behind in `app/src-tauri` as the integration guard it actually is.
- `media_cache::init_for_tests` is `#[cfg(test)]`. Once the module is a separate crate, the
  app's own tests can no longer reach it — it becomes `#[doc(hidden)] pub` or a `test-support`
  feature. Small, but it will break the build if missed.

**Commit 2 — `probe_cached` must move out of `edit.rs` before anything else can.**
`edit.rs` L93–128 holds `PROBE_CACHE` + `probe_cached()` + `NS_PROBE`, and it is consumed by
`filmstrip.rs`, `audio.rs` and `project.rs`. It is a media concern that happens to live in
the Edit-tab bridge. If it is not lifted first, `apelles-media` would have to depend on
`edit.rs`, which stays in the app — a cycle. **This is the single hard ordering constraint
inside the media slice.** See also **B-056** (this cache has no invalidation at all) — fix it
in this commit, not after; the move is the natural moment.

**Commit 3 — `filmstrip.rs` and `audio.rs`, minus their command wrappers.**
`filmstrip.rs` L1–598 is pure and depends only on `probe_cached` + `media_cache` + `video`.
`audio.rs` is the bigger call: its symphonia→rubato→cpal engine, waveform peaks and disk
caching are media, but `chroma_audio_play` resolves sources through
`edit::resolve_video_position` / `edit::resolve_audio_track_positions` (L844, L885) — timeline
resolution, which sits *above* media. So `audio.rs` splits: the engine and waveform move; the
"which clip is under this timeline frame" resolution stays app-side (and is really
`apelles-compositor`'s job later). Do not move `audio.rs` whole.

**Also lands here:** `state.rs`'s `CurrentVideo`/`Session`/`ProjectRef` reference
`video::VideoInfo`, so `state.rs` gains a `apelles-media` dependency. `state.rs` itself does
**not** move in this slice — it is a process-global that `mask_generation.rs` reads directly.

### 2.3 `apelles-project` — after media, never before

**Status: done (D-148, 2026-09-05).** Landed as scoped, in one commit, after
D-146. What the plan got right and what it did not:

- **Right, and precisely so:** the L1–1678 / L1679–2488 seam is real (the exact
  line was 1638 by the time this ran); all 20 commands really do take
  `tauri::State<'_, AppState>`; the `apelles-media` edge is real
  (`video::probe`, `video::extract_thumb`, `probe::probe_cached`) and
  `architecture-lock.md`'s table really was missing it — **corrected on
  landing**, along with a `apelles-grade-model` edge the table *claimed* and the
  real code has never had (the D-070 migration renames grade files, it never
  parses one).
- **The `ensure_timeline`/`resolve_timeline` call is the one this section got
  most right, and it needed one refinement on contact.** They are project
  concerns and they moved. But `load_and_ensure_timeline`/`resolve_timeline`
  did not move *as written*: they read `chroma::state::current_project()`, the
  app-side process global this section itself says stays behind. So the crate's
  versions take the project directory as a parameter and `chroma::edit` keeps
  three-line wrappers that supply `current_project_dir()?` — the same
  "the crate takes the fact, the app looks it up" shape D-145 gave
  `tracked_depth_map`. `ensure_timeline` already took its `dir`, so at the old
  path it is a literal `pub(crate) use`, not a wrapper. All ~20 `edit.rs` call
  sites and all 4 `project.rs` ones are unchanged.
- **The test-weight warning was correct and was the bulk of the work.** 59
  tests split 48 (model → the crate) / 11 (the command surface + `chroma::state`
  → stay). The classification was done by grepping each test item for
  `super::super::edit::chroma_*`, `chroma_project_*`/`chroma_media_*`,
  `state::`, `tauri::` and `AppState` rather than by reading section headers.
  Two moved tests needed a real edit rather than a copy:
  `migration_against_the_real_owner_project` (retargeted at
  `crate::timeline::ensure_timeline`) and
  `open_manifest_flags_a_dangling_shot_offline_without_erroring`, which despite
  its name never calls `open_manifest` — it took a `PROJECT_STATE_LOCK` guard
  for process state it does not touch, and the guard is dropped with a comment
  saying so. The timeline lifecycle also gained **5 new unit tests**; it had
  none of its own in `edit.rs`.
- **Evidence the move is verbatim:** `cargo clippy` reports the *same 13
  warnings* on the moved code before and after, in the same order, at
  correspondingly shifted line numbers (7 `collapsible_if`, 1 `sort_by_key`, 5
  `clone`-to-slice, all pre-existing on `main`). The 14th, at old
  `project.rs:1926`, is in the command half and correctly stayed app-side.
- **One thing left undone deliberately:** `make_test_clip` (a `testsrc` ffmpeg
  fixture) is now duplicated between the crate's tests and the app's — see F-5
  below.

**Real content:** `project.rs` L1–1678 (the manifest model, migrations, media items, folders,
thumbnails, `load_manifest`/`save_manifest`, `migrate_shot_grades_to_clips`,
`list_projects_in`, `new_project_in`, `infer_settings_from_clip`). L1679–2488 (`open_manifest`
and the 20 commands) stays in `app/src-tauri` — every one of them takes
`tauri::State<'_, AppState>` (see §1.5).

**Its real dependency edges, which the lock doc gets wrong.** `architecture-lock.md` lists
`apelles-project` as depending on `types, grade-model, timeline`. In the code it also needs:

- `super::video` — `video::VideoInfo`, `video::extract_thumb` (L557, L602, L2xxx)
- `super::edit::probe_cached` (L434, L755) → after §2.2 this is `apelles-media`
- `super::edit::ensure_timeline` / `resolve_timeline` (L1691, L1845, L2430, L2455) — the
  timeline-lifecycle helpers currently in `edit.rs` L150–254. These are project concerns
  wearing an Edit-tab name (`build_from_shots`, `load_and_ensure_timeline`) and should move
  *into* `apelles-project` in this slice, not stay behind.
- `super::state` / `super::load` — the app-side globals; those calls stay in the command half.

So the corrected edge is **`apelles-project → apelles-media`**, which is legal in the locked
graph (`project/timeline/grade-model → media/grade/compositor`) but is not in the lock's
table. Update the table when this lands.

**Test weight:** `project.rs` is 5,012 lines of which **2,523 are tests** (L2489+), many of
which drive `edit.rs`'s commands end-to-end (`super::super::edit::chroma_timeline_*`, ~40
call sites). Those integration tests must stay in `app/src-tauri` — they exercise the command
surface, which is where they belong. The pure model tests go with the model. Budget for the
test split being the bulk of the work in this slice.

### 2.4 `apelles-grade-model` — small, self-contained, and independently landable today

**LANDED — D-143 (2026-09-05).** The zero-dependency-edge claim below held
exactly as read: the moved code imports only `std::path`, `base64`,
`serde_json`. One correction made while landing it —
`architecture-lock.md`/`crates/README.md` both listed a `apelles-types`
dependency for this crate that the real code never had; corrected in place
rather than added to match a stale doc. `cargo check -p apelles
-p apelles-timeline -p apelles-grade-model --all-targets` clean;
`cargo test -p apelles-grade-model` and `cargo test -p apelles --lib --
chroma::` both green. See D-143 for the full record.

**Real content:** `chroma/grade.rs`'s `save_grade` / `load_grade` / `migrate_v1` /
`relativize` / `resolve` / `grade_name` + `SCHEMA` + `MATTE_KEYS` + `SaveResult`, ~300
lines of the 376. The 2 command wrappers (L55, L158) are three lines each and stay.

**Dependency edges: none.** `grade.rs` imports `std::path`, `base64`, `serde_json` and
nothing else — no `super::`, no `crate::`. It is the cleanest extraction in the repo and it
is the only remaining stub crate that is a *pure* fill-in.

**Files it touches:** `chroma/grade.rs`, `chroma/mod.rs`, `crates/apelles-grade-model/*`,
`app/src-tauri/Cargo.toml`. With the shim rule, `lib.rs` is not touched.

### 2.5 `apelles-ai` — the cleanest non-trivial slice, but not the whole of `mask.rs`/`depth.rs`

**Status: done (D-145, 2026-09-05).** Landed as scoped: `sidecar.rs` moved almost whole
(704 lines, `spawn_and_supervise`'s confirmed-unused `AppHandle` param dropped);
`tracked_depth_map`/`tracked_full_mask` stay app-side as thin wrappers reading
`chroma::state::current_video()`, delegating to new crate functions that take the
frame as a plain argument — `mask_generation.rs` needed zero changes, cleaner than
this section anticipated (it described a signature change reaching the caller).

**`sidecar.rs` (704 lines) is 99% Tauri-free.** Its only two couplings are
`#[tauri::command] chroma_ai_status` (L141, 2 lines) and — worth calling out —
`spawn_and_supervise(_app: tauri::AppHandle)` at L325, whose `AppHandle` parameter is
**completely unused** (the underscore is real; `grep -n '_app\b'` finds exactly one hit, the
signature itself). Drop the parameter and the file's Tauri surface is one command wrapper.
Lifecycle supervision, health checks, content hashing, `resolve()`, `pipe_lines`,
`monitor_external` — all move.

**`depth.rs` (288 lines) moves except for two things:** `tracked_depth_map` (L189) reads
`crate::chroma::state::current_video()?.frame`, and it is called from `mask_generation.rs`.
Split it: the HTTP client (`/depth_track`, `/depth_track/<id>`, `nearest_frame_png`) moves;
the frame lookup takes the frame index as an argument and the app-side wrapper supplies it
from `state`. That is a strictly better signature anyway — `nearest_frame_png` is already
pure and unit-tested.

**`mask.rs` (322 lines) mostly does not move.** `chroma_subject_mask` needs
`crate::get_cached_full_warped_image(&state, …)` (L65) and returns
`crate::ai_processing::AiSubjectMaskParameters` — both fork types. What moves is the
`/segment`, `/track`, `/track/<id>`, `/refine_track`, `/health` request+response plumbing as
typed functions; the frame-grabbing and the `AiSubjectMaskParameters` construction stay
app-side. `tracked_full_mask` gets the same treatment as `tracked_depth_map`.

**Net:** `apelles-ai` ≈ 704 + ~200 = ~900 lines of genuinely portable sidecar client. Worth
doing, and independent of every other slice.

### 2.6 `apelles-agent` — rescope it; there is almost nothing to extract

`architecture-lock.md` slots `apelles-agent` at step 4 as "control server (D-020) + MCP op
registry + scope exposure." Reading `control.rs`:

- It is 164 lines, and its entire purpose is `tauri::AppHandle` → `app.emit("chroma://request")`
  → `app.once("chroma://response/<id>")`. It is Tauri event plumbing by definition; there is
  no Tauri-free core to lift out.
- **The op registry is not in Rust at all.** `control.rs`'s own module doc, L10–11: *"it does
  not know the op list… The op registry lives in the frontend."*
- The only genuinely portable pieces are the request-shape parsing (`POST /op {op,args}` vs
  `POST /<op>`) and `BridgeErr` — perhaps 40 lines.

**Recommendation:** do not create `apelles-agent` as part of this wave. It becomes real when
the op registry moves into Rust (which is a product decision — see `docs/notes/mcp-tool-coverage.md`
and `docs/07-mcp-surface.md`), not when the crate list says so. Record that as the reason
rather than shipping a 40-line crate to tick a box.

### 2.7 `apelles-grade` and `relight.rs` — the fork-shaped remainder

`relight.rs` (799 lines) imports `crate::image_processing::{MAX_RELIGHT_LIGHTS, RelightLightGpu}`
and is called back by `image_processing.rs` and `mask_generation.rs`. That is a genuine
two-way binding to the fork's uniform layout. It is not a `apelles-ai` or `apelles-project`
module that happens to sit in the wrong file — it is grade-renderer code, and it moves when
and only when `apelles-grade` wraps `app/`. Same for `export.rs`'s `grade_frame`/`prepare_frame`
(L405–527, six distinct fork imports) and all of `playback.rs`.

`apelles-grade` is therefore the *last* Rust slice, not step 5 of 7 — it is gated on
`apelles-gpu` having a real `GpuContext`, and on someone deciding how much of
`image_processing.rs`/`mask_generation.rs`/`gpu_processing.rs` (7,326 lines of fork) is
Apelles' to own.

### 2.8 `apelles-compositor` — light note only, as briefed

The compositor already exists in embryo: `edit.rs::composite_video_frame` (L925–988) +
`composite_layer_onto` + `crop_pixel_rect` + `resolve_clip_transform`, ~250 lines of CPU
`image::RgbaImage` blending. When `apelles-compositor` becomes real it needs, roughly:

- the layer-resolution half of `edit.rs` (`resolve_visible_video_layers_at` consumption,
  `composition_size`, `resolve_clip_transform`) and the audio-position resolution `audio.rs`
  currently borrows from `edit.rs` (§2.2) — those two belong together;
- `decode_pipe` slot management (`retain_track_slots` is already called per displayed frame
  from `timeline_frame` L744);
- the move from CPU `image` blending to `wgpu`, which is the actual new work and the reason
  it is downstream of `apelles-gpu`;
- **and a fix for the serial per-layer decode** — see flagged item F-3 below, which is the
  compositor's real performance ceiling today and should be designed for rather than
  discovered.

Nothing here should be attempted before §2.2 and §2.3 land.

---

## 3. Extraction order and what can run in parallel

Ordering falls out of exactly three hard constraints:

1. `probe_cached` must leave `edit.rs` before `filmstrip`/`audio`/`project` can compile
   against `apelles-media` (§2.2).
2. `apelles-project` needs `apelles-media` (`VideoInfo`, `extract_thumb`, `probe_cached`) —
   §2.3.
3. `apelles-grade` needs `apelles-gpu` — §2.7.

Everything else is decoupled by the `pub use` shim rule (§1).

### Wave 1 — three agents, fully parallel

| slice | files touched | conflicts with |
|---|---|---|
| **A — `apelles-grade-model`** (§2.4) — **done, D-143** | `chroma/grade.rs`, `chroma/mod.rs`, `crates/apelles-grade-model/*`, `app/src-tauri/Cargo.toml` | nothing |
| **B — `apelles-ai`** (§2.5) | `chroma/sidecar.rs`, `chroma/mask.rs`, `chroma/depth.rs`, `chroma/mod.rs`, `crates/apelles-ai/*`, `Cargo.toml` | nothing |
| **C — `apelles-gpu`** (§2.1) | `render_core.rs`, `gpu_processing.rs`, `image_processing.rs` (`GpuContext`), `crates/apelles-gpu/*`, `Cargo.toml` | nothing in `chroma/*` |

The only shared files are `chroma/mod.rs` (a one-line-per-slice module list) and
`app/src-tauri/Cargo.toml` (a one-line-per-slice dependency). Both are append-only edits at
known locations; a merge conflict there is a three-second resolve, not a rebase. `lib.rs` is
touched by **none** of them, because no command moves.

### Wave 2 — one agent, sequential within itself — **done, D-146 (2026-09-05)**

**D — `apelles-media`**, in the three commits of §2.2, in that order. This slice touches
`edit.rs`, `filmstrip.rs`, `audio.rs`, `state.rs`, `project.rs`, `export.rs`, `playback.rs`,
`load.rs`, `commands.rs`, `session.rs`, `video.rs`, `decode_pipe.rs`, `media_cache.rs`,
`formats.rs`, `image_loader.rs`, `file_management.rs`. It is the widest slice in the repo and
must not run alongside anything that touches `chroma/*`. It can run alongside Wave 1's slice
C (`apelles-gpu`) if C is still in flight, since C's edits are confined to fork core.

Fold **B-056** into commit 2. (Done — and **B-057** into commit 3, since that is the
commit that touches `filmstrip.rs`.)

### Wave 3 — one agent — **done, D-148 (2026-09-05)**

**E — `apelles-project`** (§2.3), after D. Predicted to touch `project.rs`, `edit.rs`,
`state.rs`, `load.rs`, `audio.rs`, `export.rs`, `motion.rs`; it actually touched only
**`project.rs`, `edit.rs` and `app/src-tauri/Cargo.toml`** — the shim rule (§1) meant
`state.rs`, `load.rs`, `audio.rs`, `export.rs` and `motion.rs` reach the model through
`chroma::project`'s glob re-export and needed no edit at all. That is the shim rule
paying off exactly as §1 predicted, on the widest-overlap slice in the plan.

**Waves 1–3 are complete. The sequential part of the migration is finished.**

### Wave 4 — sweep

**F — delete the shims**, retarget every call site to the crate path, remove the now-empty
`chroma/video.rs`-style re-export files, correct `crates/README.md`'s status table and
`architecture-lock.md`'s dependency table (§2.3's `project → media` edge), update
`docs/03-architecture.md`. One commit, mechanical.

### Deliberately not in this wave

- **`apelles-agent`** — rescoped, §2.6. Revisit when the op registry moves into Rust.
- **`apelles-grade`** — §2.7. Gated on `apelles-gpu` being real and on a decision about how
  much of the fork's 7.3k-line render core Apelles owns.
- **`apelles-compositor`** — §2.8, greenfield, after E.
- **`control.rs`, `relight.rs`, `playback.rs`, `commands.rs`, `session.rs`, `load.rs`** — all
  stay in `app/src-tauri` for the whole of this wave, each for a stated reason above. That is
  ~1,700 lines that are correctly app-layer code, not migration debt.

### Per-slice definition of done

Same bar D-053 set: `cargo test` green, `cargo fmt` + `cargo clippy` clean, a `README.md` on
the new crate stating its boundary, a `D-NNN`, the roadmap line ticked, `CHANGELOG.md`, and —
because these are pure moves — **a stated verification that behaviour is unchanged**: for
`apelles-media`, a filmstrip + waveform + playback round-trip on a real clip; for
`apelles-grade-model`, a `grade.json` save/load round-trip byte-compared against a file
written by the pre-move build.

---

## 4. Flagged items found while reading (not bug entries)

Logged as real `B-NNN` entries in `docs/BUGS.md`: **B-056**, **B-057** — both **fixed
2026-09-05 in D-146**, inside the commits that were already rewriting the code they sat
in, exactly as §2.2 proposed. The rest below are
real observations that do not earn a bug entry, recorded here so they are not re-derived.

**F-1 — `tracked_full_mask` / `tracked_depth_map` do a full `read_dir` + PNG decode per
render, per mask, per frame.** `chroma/mask.rs:283–306` and `chroma/depth.rs:189–220`. Not a
new finding: **D-019 already named it** (*"`tracked_full_mask` does a `read_dir` +
`image::open` per render (~2–5 ms) — cache later if it shows up"*) and accepted it. Two things
have changed since: D-036 duplicated the pattern into `depth.rs` **without** repeating the
acknowledgement, and D-048's relight now calls `tracked_depth_map` on a second path
(`mask_generation::resolve_relight_depth_bitmap`), so a frame with a tracked subject mask *and*
a relight layer pays it twice. Still an accepted cost, still not a defect — but the cache D-019
deferred now has two callers instead of one, and `apelles-ai` (§2.5) is the natural moment to
add it, since both functions are being re-signatured there anyway.

**F-2 — `media_cache::read_blob` writes to disk on every cache *hit*.** `media_cache.rs:138–139`
sets the entry's mtime so `prune_to_budget`'s LRU ordering is real. Deliberate and documented.
Worth knowing that a filmstrip scroll therefore issues one `utimensat` per chunk hit; if the
pruner ever moves to an explicit index, drop the touch.

**F-3 — the Edit-tab preview decodes composited layers serially, and the decode-pipe pool's
single global mutex prevents fixing it without restructuring.** `edit.rs::composite_video_frame`
L947–978 is a plain `for` loop over layers; `decode_pipe::playback_frame_scaled` L330 takes
`PIPES.lock()` — one process-global `std::sync::Mutex<HashMap<PipeSlot, FramePipe>>` — and
holds it across the entire blocking `ffmpeg` read (and across a respawn + keyframe seek). So
D-125's per-track slots restored *sequential-decode locality* but not concurrency: the slots
are mutually exclusive by construction. On D-125's own measured numbers (17–31 ms/frame/layer
after the fix), a three-video-track composite is ~50–90 ms per displayed frame, i.e. ~11–20
fps, against the 30 fps target D-031 set for playback. Not filed as a bug because it is a
known-architecture ceiling rather than a defect, and because the fix (per-slot locking, or
`rayon`/`spawn_blocking` over the layer loop) belongs to `apelles-compositor`'s design (§2.8),
not to a patch on `edit.rs`. It should be an explicit requirement when that crate is scoped.

**F-5 — four copies of the same `testsrc` ffmpeg test fixture.** After D-148 the
`make_test_clip`-shaped "synthesise a small probe-able clip, `None` if ffmpeg is absent"
helper exists in `crates/apelles-project`'s tests, `app/src-tauri/src/chroma/project.rs`'s
tests, `chroma/export.rs`'s tests and `apelles_media::probe`'s tests. Three of those
predate this slice, so this is pre-existing practice rather than something D-148
introduced — but the split made it a fourth, and the natural home is one
`apelles-media` test-support fixture that everything else calls. Deliberately not done
inside an extraction commit (it would widen a just-landed crate's `test-support`
surface for a test-only convenience); the wave-4 sweep is the moment.

**F-4 — `apelles-types` pickups still outstanding after D-053.** `VideoInfo.fps_num`/`fps_den`
remain bare `u32` siblings; `TimeRange` and `Frame` do not exist. `video.rs` moving into
`apelles-media` (§2.2) is the natural moment to make `VideoInfo.fps` a real `Rational` — the
`Display` impl D-053 added is already used by `export.rs`, so the type is half-adopted. Note
that `#[serde(flatten)]` will not give a zero-wire-change migration here the way it did for
`Resolution`: `fps_num`/`fps_den` are not `Rational`'s field names (`num`/`den`), so this
needs either a rename with a `serde(rename)` pair or a real migration. Decide it deliberately;
do not sleepwalk into a wire change on `project.json`.

---

## 5. Corrections owed to other docs when these land

- ~~`docs/notes/architecture-lock.md` §"Layer 2" — `apelles-project` also depends on
  `apelles-media` (§2.3). Its migration-strategy step 4 (`apelles-agent`, `apelles-ai`) should
  be split: `apelles-ai` is real and early, `apelles-agent` is rescoped (§2.6).~~ —
  **both done, D-148.** Plus two the list did not anticipate: the same table
  claimed a `apelles-grade-model` edge `apelles-project` has never had, and its
  step 3 said `apelles-project` absorbs `grade.rs` + `state.rs` — `grade.rs`'s
  model went to `apelles-grade-model` (D-143) and `state.rs` does not move at
  all. Both corrected in place.
- `crates/README.md` — the status table still says `apelles-timeline` and
  `apelles-grade-model` are stubs. `apelles-timeline` is not (3,758 lines, in production);
  `apelles-grade-model` is.
- `docs/03-architecture.md` — still stale since Phase 0, per its own banner. The wave-4
  sweep is the moment to fix it, since that is when the crate graph is finally the real one.
