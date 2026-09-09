# Colorist → Edit: making the grade actually render (D-256)

Built 2026-09-09. Read `docs/08-decisions.md` **D-256** for the decision itself;
this note is the worked-out detail — the investigation that preceded it, the
exact plumbing, the measurements, and what is deliberately still missing.

---

## 1. The gap, as it actually was

Apelles had two independent render paths:

| | Colorist | Edit |
|---|---|---|
| engine | RapidRAW's **wgpu** shader (`gpu_processing`, via `render_core::render`) | a **CPU** compositor (`chroma::edit::composite_video_frame`) |
| input | `grade.json`'s `adjustments` blob | `apelles_timeline::Timeline` |
| export | `chroma::export::export_video` (GPU per frame) | an **ffmpeg filtergraph** compiled in TypeScript (`packages/editor/src/timelineExport.ts`) |

They shared a project and, since D-070, a clip identity — and nothing else. A
grade set in the Colorist tab had **literally no effect** on that same footage
used as a clip on the Edit timeline, in the preview or in the export.

### What the investigation actually found (and corrected)

Four questions were asked up front. Two of the answers were not what the
question assumed:

1. **Where does the grade pipeline live?** `app/src-tauri`: the shader plus
   `image_processing::get_all_adjustments_from_json` (untyped JSON → uniforms),
   reached headlessly through `render_core::render` (D-014's Tauri-free seam,
   whose device init moved to `apelles-gpu` in D-144). It takes a `grade.json`
   `adjustments` object and produces **pixels**. There is no
   `apelles-grade` crate yet — it is still "future" in `crates/README.md`.

2. **Where would a grade plug into Edit?** Preview: per decoded layer in
   `composite_video_frame`, before geometry. Export: as a filter node inside
   `buildClipFilterChain`, which is where every other per-clip effect already
   goes. Both were straightforward; the hard part was never *where*.

3. **What links a `Clip` to a graded shot?** ⚠️ **Not `shot_id`.** The task
   framing (and a `grep` for `shot_id` returning nothing in `edit.rs`) pointed
   at `Clip::shot_id` as the missing link. It is not: **D-070 already made the
   link `Clip::id` itself.** Grades persist at
   `<project>/grades/<clip.id>.grade.json` (`useSessionStore.persistShotGrade`),
   and `shot_id` is a *legacy back-link* whose only live consumer is
   `migrate_shot_grades_to_clips`' one-time rename of pre-D-070 grade files.
   So the producer side was already complete and correct — **the entire missing
   half was "consume it."** Chasing `shot_id` would have built a second,
   redundant linkage next to a working one.

4. **Is there a reusable way to invoke the grade maths from Edit?** ⚠️ **No —
   and `apelles_types::adjustment`'s own header had already written down why, as
   a structural impossibility:** the `adjustments` blob is deliberately untyped
   in Rust (D-020/D-025), it is applied *only* by the wgpu shader, "there is no
   CPU implementation of it anywhere in the workspace", the Edit compositor is
   GPU-free by design, and "the ffmpeg export compiler could not reproduce a
   wgpu shader at all." That paragraph is why **D-230's adjustment clip invented
   a five-parameter correction of its own** instead of reaching for the real
   grade.

Question 4's answer is the whole reason this needed a decision rather than a
patch.

---

## 2. The idea: move the grade as **data**, not as code

Every option that tried to move the *computation* runs into question 4. The one
that works moves the **result**: run an identity RGB lattice through the real
shader, once, and carry the 3×33³ numbers that come back.

```
grade.json ──► [ the Colorist's own wgpu shader ] ──► Lut3d (33³)
                        ▲ identity lattice              │
                        │                               ├──► Edit preview: CPU trilinear, per clip
                  (once per grade change)                └──► Edit export:  ffmpeg lut3d, per clip
```

Three properties fall out of this, and they are the argument:

- **The grade still has exactly one implementation.** The shader. Nothing was
  reimplemented, on CPU or in ffmpeg — so nothing can drift out of step with it.
  This is the "shared logic → extract, never copy-paste" rule satisfied at the
  level of *results* rather than source, which is the only level available here.
- **Preview and export agree by construction.** They consume the same lattice
  with the same interpolation, rather than two implementations happening to
  match. (Both are pinned to **trilinear** — see §4.)
- **The bake is not per frame.** It is per grade *change*, memoised. The
  per-frame cost is an interpolation, not a GPU round trip.

The precedent already in the repo is D-022's `.cube` bake (`bake_primary_lut`),
which did exactly this render-an-identity-lattice trick to export a grade as a
LUT file. D-256 factored that function's body out and gave it a second consumer
rather than writing a second baker.

### What a 3D LUT cannot carry

A 3D LUT is a pure per-pixel `RGB → RGB` function, so the **spatial** half of a
grade is outside it *by definition*, not by omission:

- mask layers / local adjustments,
- the Colorist crop,
- depth-driven relight.

These are stripped before baking (they would also corrupt the lattice image
itself — a crop applied to a 33×1089 lattice is meaningless) and every drop is
reported: as a `warnings` entry on the bake, in the app log, in the Export
dialog, and from `editor_get_grade_status`. **Never silently.** Carrying them
would require a real shared compositor — `apelles-grade` + `apelles-compositor`,
still "future" in `crates/README.md` — and the ffmpeg exporter could not
reproduce it anyway, which would reintroduce exactly the preview-vs-export
divergence this design exists to avoid.

---

## 3. The plumbing, end to end

| layer | what | file |
|---|---|---|
| L0 | `Lut3d` — lattice, trilinear sampler, `.cube` writer, identity test. Pure, no GPU/fs/`image`. | `crates/apelles-types/src/lut3d.rs` |
| L1 | `grade_dir(project_dir)` — the one `join("grades")` | `crates/apelles-project/src/manifest.rs` |
| app | `BakeSession` (GPU device + caches), `bake_lut3d`, `resolve_clip_lut` (memoised), `bake_luts_for_clips` (→ `.cube` files), `apply_to_rgba`, `chroma_timeline_grade_luts` | `app/src-tauri/src/chroma/grade_lut.rs` |
| app | the preview: apply per decoded layer; fast path declines itself when graded | `app/src-tauri/src/chroma/edit.rs` |
| app | `bake_primary_lut` now delegates (one baker, two callers) | `app/src-tauri/src/chroma/export.rs` |
| ts | the warm-then-read-synchronously cache | `packages/editor/src/gradeLuts.ts` |
| ts | `gradeLutPaths` option + the `lut3d` node | `packages/editor/src/timelineExport.ts` |
| ts | warm before compiling; **refuse** if cold | `packages/editor/src/editorExport.ts` |
| ui | warm before enqueue; show the dropped-half warnings | `packages/editor/src/EditorExportDialog.tsx` |
| mcp | `editor_get_grade_status` + the `colorist_grade` capability block | `packages/editor/src/useEditorControl.ts`, `mcp/server.py` |

### Caching

`resolve_clip_lut` memoises on the grade file's own **(mtime, len)**. That is a
staleness check only — never an input to the maths — so a cache hit and a cold
bake of the same file produce the same lattice, and determinism holds.

The cached value is a **three**-state `Result<ClipGrade, String>`, and the third
state is load-bearing:

- `Ok(lut: Some(..))` — graded.
- `Ok(lut: None)` — nothing to apply: no project, no grade file, **or a grade
  that bakes to the identity**.
- `Err(..)` — there *is* a grade here and it could not be baked.

The preview shows the ungraded picture for both of the last two (a broken bake
must not blank the Edit tab). The **export refuses** on `Err`. Collapsing those
two into `Option` is exactly what would make a dropped grade silent.

### An identity grade resolves to *no lattice at all*

Deliberately. A clip that was never graded — or was graded and then reset —
gets no LUT applied, rather than an identity LUT whose 8-bit round trip could
still shift a value. So its preview frames and its exported argv are
**byte-identical** to a build without this feature. Same "an untouched effect
emits nothing" property D-230's adjustment clip already has in both engines.

### The export's `.cube` files

Written to `<project>/cache/grade-luts/<clip id>-<hash>.cube`.

- **Inside the project**, not a temp dir: the export queue freezes a job's argv
  at enqueue time (D-198) and that argv names these files by path, so a cleaner
  emptying `/tmp` between enqueue and run would break the export.
- **Content-addressed**: a queued job keeps pointing at the lattice that was
  current when it was queued even if the user re-grades while it waits, and two
  clips carrying the same grade share one file. The hash is a hand-written
  FNV-1a, not `DefaultHasher`, which is explicitly not stable across Rust
  releases.

---

## 4. Trilinear, not tetrahedral — on purpose

ffmpeg's `lut3d` defaults to `interp=tetrahedral`, which is the *more accurate*
interpolation. The exporter overrides it to `trilinear` because the preview's
own sampler is trilinear, and **matching the other engine beats being marginally
better than it**. Same call D-230 made when it quantised the preview's
intermediate value to 8 bits purely because ffmpeg's two filters do.

## 5. Order in the chain

Both engines apply the grade to the clip's **own pixels, before geometry**:

- preview: decode → **grade** → crop → resize → composite;
- export: `setpts` → **`lut3d`** → `crop` → `scale` → `overlay`.

A 3D LUT is per-pixel, so it commutes with `crop` exactly; only the resample is
order-sensitive, and both engines resample after. `setpts` touches timestamps
and no pixels, so its position is irrelevant.

The preview's single-layer **plain-decode fast path** had to learn to decline
itself for a graded clip — precisely the guard D-132/B-053 added for a clip with
a real transform, for the same reason: a fast path that ignores a real
transformation shows a picture the document disagrees with.

---

## 6. Measurements

| what | number |
|---|---|
| preview centre pixel, flat grey clip, ungraded | `[126,126,126]` |
| same clip, `+1.5 EV` Colorist grade, **preview** | `[227,227,227]` |
| same clip, same baked `.cube`, **ffmpeg `lut3d`** | `[227,227,227]` — **exact match, zero difference** |
| applying a 33³ lattice to one 960×540 preview frame, serial | **22 ms** |
| the same, parallel over rows (`rayon`) | **3 ms** |

The 22 ms figure is why `apply_to_rgba` is parallel: a trilinear sample is eight
scattered reads into a 431 kB `f32` lattice (past L1), and over half of a 24 fps
frame's 41 ms budget spent on one graded layer is a visible stutter by
CLAUDE.md's performance-first rule, not a rounding error. `rayon` stays in
`app/src-tauri` (where it was already a dependency) rather than in `apelles-types`,
so that L0 crate keeps its zero-heavy-deps rule; only the walk over the buffer is
parallel, the per-pixel maths is the same `Lut3d::apply_rgb8`.

An ungraded clip pays **none** of this: `lut_for_clip` returns `None` after one
`metadata()` stat, before any pixel is touched.

## 7. Tests, and what each one is for

- `crates/apelles-types/src/lut3d.rs` — 9 unit tests: exhaustive 8-bit identity
  round trip, exact sampling at lattice points, linearity between them, the
  `.cube` byte shape, clamping, determinism.
- `chroma::grade_lut::tests` — an empty grade bakes to the identity; a real
  grade moves pixels in the direction it names; the same grade bakes twice to
  the same lattice; masks/crop warn; the per-frame budget.
- `chroma::edit::grade_bridge_tests` — the pixel claims, through the real
  `timeline_frame` command: a grade visibly changes the preview; **an identity
  grade changes nothing byte-for-byte** (the control that proves the first is
  measuring the grade rather than the compositor path switching); determinism;
  reversibility; a grade does not leak across clip ids; the export bake writes a
  real parseable `.cube` only for graded clips; and **the preview/export parity
  measurement** in §6.
- `packages/editor/src/timelineExportGrade.ffmpeg.test.ts` — real ffmpeg,
  real decoded pixels: control, a grade reaching the output, a channel swap
  surviving the chain, per-clip (not per-file) application, and a `.cube` path
  containing a space and a colon.
- `packages/editor/src/timelineExport.test.ts` — argv shape: nothing emitted for
  an ungraded clip, one node per graded clip, `interp=trilinear` pinned,
  filtergraph escaping, and the node's position before `crop`/`scale`.

**The negative control was run**: with the one `apply_to_rgba` call disabled,
`a_colorist_grade_visibly_changes_the_edit_preview` fails at exactly its
headline assertion. The test measures the wiring, not itself.

---

## 8. Deliberately not done

- **The spatial half of a grade** (masks/local layers, Colorist crop, relight) —
  see §2. Warned about, never silent. Needs `apelles-grade` + `apelles-compositor`.
- **A per-clip "bypass grade" toggle.** Resolve has one; this pass does not add
  it, because the capability being delivered is "the grade you set is the grade
  you see", and a toggle is a *different* feature (a viewer state, arguably
  belonging next to the preview's other view toggles rather than on the clip).
  Adding it would mean a new `Clip` field, an Inspector control, an MCP
  parameter and an export branch — a real feature to scope on its own, not a
  rider on this one. Nothing here forecloses it.
- **Grade-follows-split.** Splitting a graded clip gives the new half a new clip
  id and therefore no grade. That is D-070's per-instance grading model working
  as designed (and Resolve's default), but "copy the grade to both halves on
  split" is a reasonable future affordance. `editor_get_grade_status` is how you
  see the current state.
- **A `apelles-grade` crate.** The bake lives in `app/src-tauri` because it links
  the RapidRAW shader, which is precisely what `crates/README.md` says
  `apelles-grade` will own when it exists. `grade_lut.rs` is written to move
  there whole.
