# 07 — MCP tool surface

Status: **draft**. The v1 subset ships via the in-app control server (D-020,
`docs/notes/control-server/SPEC.md`); the full surface below firms up over Phase 3.

## Design rules

0. **Grade by the numbers, not the vibe.** The agent's default loop is `render →
   inspect_color → reason about the measurement → adjust → re-inspect`. Technical
   calls (balance, black/white point, casts, clipping, matte edges) are scope-driven;
   the rendered image is for *creative* judgment, which is often deferred to the human.
   Tool text forbids "looks good" without a cited scope value or a named full-res
   region. Full rationale + toolkit: `docs/notes/agent-visual-feedback.md`.
1. **Tools map to `grade.json` fields, not to GUI buttons.**
2. **Every mutating tool returns `{ rendered_frame_png, scopes, gap? }`** at the current
   playhead (or a named frame) — the agent's eyes. `apply → inspect → adjust`, proven
   in the Palmier trials.
3. **Reads are cheap and side-effect-free.** `render_still`, `inspect_color`, `get_state`.
4. **Human handoff is a tool**, not a dead end.
5. **Deterministic.** Same doc + same frame ⇒ same output.
6. Merge semantics like Palmier's `apply_color`: pass only the knobs you want to change;
   the rest are preserved. `reset: true` to start a layer from neutral. Mutating tools
   echo the resulting grade in Chroma's own vocabulary — pasteable to copy a grade.
7. **One shared state (D-020).** Every op is a real frontend action; the UI and the
   agent never diverge. Reads reflect the user's manual edits.

## Tools

### Session / inventory  — *call `get_state` once at session start; re-read after an out-of-band change (the user edited by hand). Modelled on Palmier's `get_media` + `get_timeline`.*
| Tool | Params | Returns |
|---|---|---|
| `get_state` | — | what's loaded (image\|video, path, `w×h`, fps, `frameCount`, colour space), current frame, the grade (Chroma vocabulary), mask list `[{id, name, type, subMasks, adjust-summary}]` |
| `open` ✅ (D-024) | `path` (absolute) | loads a still or video into the editor headlessly, `{path, ready, size, video}`. Sets `selectedImage`; `useImageLoader` decodes + populates the transport store |
| `open_shot` | `source`, `in`, `out`, `fps?`, `reference?` | `shot_id`, `{frame, scopes}` — Phase 1 shot model |
| `list_shots` / `select_shot` | … | Phase 1 |
| `seek` | `frame` | `{frame, scopes}` |
| `list_projects` ✅ (D-037) | — | saved `<name>.chroma` projects in the projects folder, newest first — `{projects:[{name,path,modified,shotCount}], folder}` |
| `open_project` ✅ (D-037) | `name_or_path` | load a project's shots + per-shot grades into the session, enter the editor; a missing source is flagged "media offline" |
| `new_project` ✅ (D-037) | `name`, `media_paths?` | scaffold `<name>.chroma` (media referenced in place) + open it |
| `save_project` ✅ (D-037) | — | force-write `project.json` + the active shot's grade + `thumb.jpg` (autosave does this on a debounce) |

### Render / inspect (read-only)  — *the agent's eyes. `inspect_color` is the primary one — grade by the numbers.*
| Tool | Params | Returns |
|---|---|---|
| `inspect` | `frame?`, `mask_id?` | composited frame as an image — **frame number burned in**, a 0–1 coordinate grid, and which masks are active. (= Palmier `inspect_timeline`) |
| `inspect_color` | `frame?`, `reference?` | black/white points, clip %, per-channel means, shadow/mid/highlight colour tilt, saturation, warm–cool + green–magenta balance, hue histogram — **plus the rendered frame**. With `reference` (an image id): also its scopes and the **subject − reference gap** + hints that map onto knobs. The match loop: `set_* → inspect_color(reference) → read the gap → adjust → repeat`. (= Palmier `inspect_color`) |
| `sample` / `sample_region` | `x,y` or `rect`, `frame?` | RGB readout — check a known-neutral wall is neutral |
| `screenshot` | `crop?`, `zoom?` | the app canvas at native res, croppable — for banding / noise / **matte halo** inspection at 100% |
| `render_still` / `render_range` | `frame?` / `from,to,step` | PNG(s) — motion / transition / temporal-consistency check |
| `inspect_mask` | `mask_id`, `frame?` | frame with the mask tinted (non-destructive) |

### Primary grade
| Tool | Params |
|---|---|
| `set_primary` | `exposure? contrast? whites? blacks? highlights? shadows? temperature? tint? saturation? vibrance?`, `reset?` |
| `set_curve` | `channel` (master\|r\|g\|b), `points` [[x,y]…] |
| `set_wheels` | `lift? gamma? gain?` each `{hue, amount}` |
| `apply_lut` | `path`, `strength?` |
| `set_hue_curve` | `targets: [{targetHue, hueShift?, satScale?, lumShift?}]` (qualified secondary, no mask) |

### Masks
| Tool | Params | Notes |
|---|---|---|
| `add_shape_mask` | `shape` (ellipse\|rect\|linear), `geometry {cx,cy,w,h,rot}`, `feather?`, `invert?` | free, instant |
| `add_depth_mask` | `range [near,far]` (0–1), `falloff?`, `invert?` | runs Depth Anything V2 on the shot once, caches |
| `add_subject_mask` | `prompt` ("person"), `threshold?`, `invert?` | runs SAM 2 + video propagation via the sidecar; async — poll `mask_status` |
| `mask_status` | `mask_id` | `queued\|tracking\|ready\|failed` + progress |
| `set_mask_adjust` | `mask_id`, `adjust` (a grade-doc `adjust` fragment: primary / effect / compound) | this is how you grade *through* a mask. **Shipped:** primary knobs + `blur` (0–100, mask-only — defocus the masked region, D-027) via the in-app bridge |
| `add_mask` ✅ (D-027) | `type` (radial\|linear), `geometry {cx,cy,rx,ry,feather}` / `{startX,startY,endX,endY,range}` | a new container with one plain shape sub-mask (the AI mattes are `add_subject_mask` / `apply_haze`) |
| `set_mask_geometry` | `mask_id`, `geometry`, `frame?` | with `frame` ⇒ writes a keyframe |
| `track_mask` | `mask_id`, `from`, `to` | v2 — CoTracker drives shape-mask keyframes |
| `refine_matte` | `mask_id`, `feather?`, `edgeAware?`, `shrink?`, `grow?` | |
| `delete_mask` | `mask_id` | |

### AI-assisted grading
| Tool | Params | Notes |
|---|---|---|
| `match_to_reference` ✅ (D-026) | `reference` (absolute image path), `strength?` (1.0), `max_iters?` (4), `tolerance?` (3.0) | measures the scope gap, iterates a **damped** primary correction (exposure / temperature / tint / contrast / saturation) with per-step ceilings + roll-back-on-worse + best-snapshot, re-measuring each step. Merges into `primary` (a match is a balance). Returns `{converged, iterations, gap_before, gap_after, applied, trace:[{iter,damp,gapMag_before,gapMag_after,patch,cumulative}]}` + the final frame + scopes. No colour-science `method` — it's a closed-loop slider nudge. Detail: `docs/notes/match-reference.md` |
| `apply_haze` ✅ (D-024) | `amount?` (0–3, default 1), `protect_subject?` (v1 no-op) | the depth-atmosphere preset. Adds a "Depth Haze" mask: full-range `ai-depth` sub-mask **inverted** (weight == distance) + negative `dehaze` / `-sat` / `+blacks` / `+shadows` × `amount`. Depth is a **static** bake. Returns `{maskId, subMaskId, amount}` + frame + scopes. `blur` deferred (no per-mask blur field); `cool` / `depth_from` dropped. Detail: `docs/notes/depth-haze.md` |
| `auto_balance` | `pick {x,y}` or `chart` | solve WB + levels from a neutral/grey pick |

### Consistency / batch (v2)
| Tool | Params |
|---|---|
| `copy_grade` | `from_shot`, `to_shots[]`, `include_masks?` |
| `flag_outliers` | `reference_shot`, `metric?` | returns shots outside a look tolerance |

### Human handoff
| Tool | Params | Notes |
|---|---|---|
| `request_human` | `reason`, `roi? {frame, box}`, `blocking?` | GUI surfaces it, highlights the ROI; when `blocking`, the call returns after the human marks it done; else the agent can continue and re-check |

### Export  — *shipped 2026-09-01, D-022*
| Tool | Params | Returns |
|---|---|---|
| `export` | `kind` (prores\|h264\|cube), `path?`, `from_frame?`, `to_frame?`, `quality?` | resolved path + frame count + elapsed; `cube` warns when masked/local layers were dropped (3D LUT is global-only). Video export runs in the background — the tool polls to completion. Default `path` = beside the source as `<name>.graded.mov / .mp4 / .cube`. A local file the user asked for → no confirm-before-write, but the resolved path is always returned. |

### `grade.json` — the grade is code  — *shipped 2026-09-01, D-025*
| Tool | Params | Returns |
|---|---|---|
| `get_grade` | — | the full v1 grade document: `{schema:"chroma.grade/1", shot:{source,width,height,fps,frameCount,colorSpace,reference}, adjustments:{…}, notes}`. Reflects the user's manual edits. |
| `save_grade` | `path?` | writes `grade.json` (default: beside the source clip as `<name>.grade.json`). Static mask mattes → a sibling `<name>.mattes/` dir (`{"$matte":…}` ref); a tracked-matte folder is referenced, not copied. Returns `{path, matteFiles, trackDirs}`. Diff-able — a one-knob change is a one-line diff. Local file the user asked for → no confirm. |
| `load_grade` | `path` | reads + applies a `grade.json` (mattes inlined, `$trackDir` resolved, schema migrated; a newer major is rejected). **v1 does not auto-switch clips** — a `shot.source` mismatch is returned as `sourceMismatch` and the grade is applied anyway. Returns the rendered frame + scopes + `{applied, shot, sourceMismatch}`. |

## v1 subset — shipping now via the control server (D-020)

`get_state`, `set_primary`, `set_curve`, `set_color_grade`, `seek`, `list_masks`,
`add_subject_mask`, `track_subject`, `set_mask_adjust`, `invert_mask`,
`delete_mask` **[D-020, shipped]**; `inspect_color` (+ `reference`→`gap`),
`sample`, `sample_region` **[D-021, shipped 2026-09-01]** — computed in JS off the
captured preview (`engine/src/utils/scopes.ts`), not WGSL; every mutating op
response also carries the compact `scopes` summary now; `export` /
`export_progress` **[D-022, shipped 2026-09-01]** — ProRes/H.264 clip render +
`.cube` primary bake, `engine/src-tauri/src/chroma/export.rs`. `get_grade` /
`save_grade` / `load_grade` **[D-025, shipped 2026-09-01]** — the git-committable
grade document (`engine/src-tauri/src/chroma/grade.rs`), a versioned wrapper
around `adjustments` with externalized mattes. `match_to_reference` **[D-026,
shipped 2026-09-01]** — the automated measure→adjust→re-measure loop against a
reference image (`match_reference` op in `useChromaControl.ts`; primary knobs
only). `add_mask` (radial/linear container) + `set_mask_adjust`'s `blur` knob
(0–100, mask-only defocus) **[D-027, shipped 2026-09-01]**. `inspect` (frame with grid +
burned-in frame number) and `screenshot` (native-res crop) are still follow-ups.
The control server's op registry makes each a one-liner to add.

## The loop, illustrated

```
inspect_color()                     → "flat, warm cast, subject and bg same brightness"
match_to_reference("refs/look.png")  → {frame, scopes, gap: 8.1 → 2.3}
add_subject_mask("person")           → mask_id=m1 (tracking…)
mask_status(m1)                      → ready
set_mask_adjust(m1, {primary:{exposure:+0.15, vibrance:+0.2}})   → {frame}  # subject pop
add_subject_mask("person", invert:true) → m2
set_mask_adjust(m2, {compound:[{primary:{exposure:-0.6,saturation:0.6}},{effect:"blur.gaussian",radius:14}]})
apply_haze(depth_from: m1, amount: 0.4)  → {frame}   # depth atmosphere on top
request_human("clean the matte on the left hand, f40–70", roi:{frame:55, box:[...]})
# human paints 3 strokes
read_scopes()                        → "good separation, subject reads"
export("cube")   export("prores")
```
