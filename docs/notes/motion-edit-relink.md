# Motion → Edit: "auto re-render, auto-replace" (D-260)

Worked design detail behind **D-260**. The decision entry has the options and the
reasoning; this is the mechanism, the code-read findings it rests on, and the
things a future reader will want checked rather than restated.

Related: **D-062** (a render auto-imports into Sources), **D-180** (one file per
scene, at a fixed per-scene path), **D-243** (why a Remotion renderer inside Edit
was rejected), **D-256** (the Colorist→Edit bridge, the precedent for
"invalidated by mtime, consumed by both engines"), **D-257** (the Motion MCP
surface), **B-127**, **B-128**.

---

## 1. What was actually there, before

```
motion_render / the Render button
   └─ chroma_motion_render          writes <project>.chroma/motion/renders/<sceneId>.mp4
        └─ onRendered(outputPath)   app/src/Root.tsx  (D-062)
             └─ importPaths([path]) → the file appears in Sources
                  … and that is the end of it.
```

Placing it on the Edit timeline was manual (a drag, or `editor_add_clip`), and
once placed there was no link of any kind: editing the manifest and re-rendering
changed the file on disk, and the clip kept showing the old picture.

## 2. The four investigation questions, answered

### Q1 — how a clip references media; is there provenance?

`chroma_timeline::Clip` carries `source_path` (ground truth) and a nullable
`media_id` back-link into the pool. `chroma_project::MediaItem` carries the file
and its probed `video` facts. **Nothing anywhere records where a file came
from.**

Provenance is net-new, and it went on `MediaItem`, not `Clip`:

| | on `Clip` | on `MediaItem` ← chosen |
|---|---|---|
| copies of the fact | one per placement | exactly one |
| survives re-placing the clip | no | yes |
| cost to a non-Motion clip | a field on every clip | none — absent key |

`motion_scene_id: Option<String>`, `#[serde(default, skip_serializing_if =
"Option::is_none")]`. A pre-D-260 `project.json` deserializes unchanged; a
non-Motion item re-serializes byte-identically. No migration.

Which project's manifest is *implied*, not stored — the manifest is a sidecar of
the same project the pool belongs to (D-046), so there is exactly one, and a
second field naming it could only go stale.

### Q2 — did `onMotionRendered` carry enough?

No: `(outputPath: string)`. It now takes `SceneRenderResult`, which already
carried `sceneId` for the render-result display (D-180).

The alternative — recover the scene id from the path — was rejected because
`motion.rs`'s `default_output_path` doc names itself the one place
project-relative render paths are computed, and because it is wrong by
construction for a render that passed an explicit `output_path`.

### Q3 — how a changed file reaches the Edit preview

**The important finding: most of this already worked, and D-256's mechanism did
not need mirroring because its equivalent already exists one layer down.**

| consumer | keyed on | stale after a same-path replace? |
|---|---|---|
| `probe_cached` (duration, fps, frame count) | `blake3(path‖mtime‖len)`, both layers (B-056) | no |
| filmstrip chunks (memory + disk) | `source_key` | no |
| waveform peaks | `source_key` | no |
| the preview frame itself | nothing — `chroma_timeline_frame` per frame | no |
| the ffmpeg export | reads the file at run time | no |
| **`decode_pipe` playback pipes** | **a slot; respawns on path/scale/seek only** | **YES** |
| **`MediaItem.video` + its thumbnail** | **the manifest / the item id** | **YES** (B-128) |
| **`Clip.source_len` / `source_fps`** | **frozen at drop time** | **YES** |
| `filmstrip::KEYFRAME_MEM` | the path alone | **YES** (B-127) |

The three "YES" rows in bold are what D-260 builds. The last is a pre-existing
defect the audit surfaced.

**Why a pipe is the hard one.** It is not a cache — it is a live `ffmpeg`
process with the file already open. `FramePipe::frame_scaled` restarts on a
change of path, of scale, or a seek outside `MAX_FORWARD_SKIP`; content is not
one of those. After the file is replaced it keeps reading the old, now-unlinked
inode, and serves the previous render indefinitely and without error.

### Q4 — the trigger

Explicit, reusing the existing Render action. See D-260's finding 4 for the
argument (a save is debounced and constant; a render is `npx remotion render`;
D-046 allows only one at a time). The cost is that a clip can be out of date
until the next render — made visible by the badge and by
`motion_get_edit_links`, rather than left implicit.

## 3. The mechanism, end to end

```
Render (GUI button, or motion_render)
 │
 ├─ Rust: chroma_motion_render
 │    1. remotion render → <sceneId>.rendering.mp4      (a sibling, not a temp dir)
 │    2. fs::rename onto  <sceneId>.mp4                 ATOMIC — no torn read, ever
 │    3. decode_pipe::drop_pipes_for_path(out)          the only cache that needs telling
 │
 ├─ TS: useMotionManifest.render()  →  await onRendered({sceneId, outputPath})
 │
 └─ app: Root.tsx onMotionRendered
      4. useMediaPoolStore.refreshPaths([path], sceneId)
           → chroma_media_refresh → refresh_media(): add | re-probe,
             regenerate the thumbnail iff older than the source, stamp provenance
      5. count linked clips (clipReadsItem) and, if any,
         useEditorTimelineStore.applyOp({kind:'refresh_media', …})
           → every clip reading that file re-reads source_len/source_fps,
             re-clamped by D-195's policy; a NO-OP when nothing changed
      6. toast: "Rendered — refreshed N Edit clips"
```

### Why `rename` and not an in-place overwrite

Two readers can hold the file when a render lands:

- the preview's `ffmpeg` decode pipe, mid-stream;
- an export job, whose argv was frozen at enqueue time (D-198) and which may be
  part-way through reading the file.

An in-place rewrite gives both a torn file. `rename(2)` within one directory is
atomic: a reader either keeps the complete old inode (alive until it closes) or
opens the complete new one. Both hazards close with one call, and no
cross-package coordination — no "is an export running?" check reaching from the
Motion tab into the export queue.

The staging name is a pure function of the destination
(`hook.mp4` → `hook.rendering.mp4`), never timestamped or random: CLAUDE.md's
render-path invariant forbids wall-clock inputs, and D-046 already excludes
concurrent renders. A crashed render leaves the staged file behind for the next
render of that scene to overwrite — deliberately a legible name, not a dotfile.

### Why drop pipes by path, not `reset()`

`reset()` drops the whole pool, respawning an `ffmpeg` process for every visible
layer and for the Colorist's own `PipeSlot::Current` — a stall charged to clips
that did not change, which is B-040's measured failure mode. `Current` *is*
dropped when it is the pipe on this path: unlike `retain_pipe_slots`, whose
caller (the Edit tab's per-frame release) has no business judging the Colorist's
session, here the file it is reading has genuinely been replaced.

### Why `refresh_media` is one op, not N `swap_media`s

`swap_media` addresses one clip by `(track, clip)`; a replaced file can be on any
number of clips, and the caller — the composition root, reacting to a render —
knows only which media changed. N ops would also be N undo entries for one
action (`import_subtitles` already makes that argument). And nothing is being
*swapped*: `media_id` and `source_path` are unchanged.

What the two share is only the re-clamp, and that is shared as code
(`reclampToSource`), not repeated as a rule.

### Refusing an unprobed length

`refresh_media` returns the timeline unchanged for `source_len <= 0`. A pool item
that failed to probe carries no `video` at all, so its length is *unknown*, not
zero — and clamping every affected clip to one frame is far worse than leaving a
stale trim ceiling, since the picture updates from the file either way. The
composition root declines to send one and the reducer refuses it as well, so a
future caller cannot make that mistake silently. Same "an absent value is not the
value" discipline `MediaItem::has_audio` and `Clip::source_fps` already keep.

### The no-op property

A same-length re-render — the common case — makes `refresh_media` return the
original timeline object. `applyOp` short-circuits on `after === before`, so
nothing is written and no undo entry appears. The picture still updates, because
the file changed and both engines read the file. The reducer tests this by
running the real `reclampToSource` on a throwaway copy and comparing: the honest
test for "would this change anything", and the only one that cannot drift from
what the write actually does.

## 4. Layering

`@chroma/motion` may not import `@chroma/bridge` or `@chroma/editor` (D-039:
app → tabs → services → domain). So:

- the composition root computes the link map and passes it down, exactly as
  D-062 made `onRendered` a prop;
- the link *types* live in `@chroma/motion` (it is the consumer and defines the
  shape), and `computeEditLinks`' parameters are **structural** — the minimum
  fields it reads — so it imports nothing across a layer while remaining fully
  type-checked at the call site;
- the same one value feeds the GUI badge and the MCP op, so a human and an agent
  cannot be told different things.

## 5. What this is not

- **Not a live embed.** Nothing re-renders on a manifest edit. A clip shows the
  last render until the next one. D-243's rejection of an in-Edit Remotion
  renderer stands and was not reopened.
- **Not automatic placement.** A rendered scene still does not put itself on the
  timeline (D-062's reasoning: the app cannot know the track or position).
  `motion_get_edit_links` makes "rendered, never placed" visible instead.
- **Not a claim about Remotion's determinism.** The render is unchanged by this
  pass; its internals were not re-verified here.
