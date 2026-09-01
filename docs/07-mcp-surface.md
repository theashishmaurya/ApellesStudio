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
| `open` | `path` | loads a file, `{frame, scopes}` |
| `open_shot` | `source`, `in`, `out`, `fps?`, `reference?` | `shot_id`, `{frame, scopes}` — Phase 1 shot model |
| `list_shots` / `select_shot` | … | Phase 1 |
| `seek` | `frame` | `{frame, scopes}` |

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
| `set_mask_adjust` | `mask_id`, `adjust` (a grade-doc `adjust` fragment: primary / effect / compound) | this is how you grade *through* a mask |
| `set_mask_geometry` | `mask_id`, `geometry`, `frame?` | with `frame` ⇒ writes a keyframe |
| `track_mask` | `mask_id`, `from`, `to` | v2 — CoTracker drives shape-mask keyframes |
| `refine_matte` | `mask_id`, `feather?`, `edgeAware?`, `shrink?`, `grow?` | |
| `delete_mask` | `mask_id` | |

### AI-assisted grading
| Tool | Params | Notes |
|---|---|---|
| `match_to_reference` | `reference` (path/id), `method?` (reinhard\|mkl\|mvgd), `strength?` | measures the gap, applies a CDL/curve fragment to `primary`, returns `{frame, scopes, gap_before, gap_after}` |
| `apply_haze` | `depth_from?` (a subject mask id to anchor "near"), `amount?`, `blur?`, `cool?` | the depth atmosphere preset (desat + black-lift + dehaze + blur, depth-weighted) |
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

### Export
| Tool | Params | Returns |
|---|---|---|
| `export` | `kind` (cube\|prores\|h264\|grade_json), `path?`, `range?` | file path; `cube` warns if masked/depth layers were dropped |

## v1 subset — shipping now via the control server (D-020)

`get_state`, `set_primary`, `set_curve`, `set_color_grade`, `seek`, `list_masks`,
`add_subject_mask`, `track_subject`, `set_mask_adjust`, `invert_mask`,
`delete_mask` **[D-020, shipped]**; `inspect_color` (+ `reference`→`gap`),
`sample`, `sample_region` **[D-021, shipped 2026-09-01]** — computed in JS off the
captured preview (`engine/src/utils/scopes.ts`), not WGSL; every mutating op
response also carries the compact `scopes` summary now. `inspect` (frame with
grid + burned-in frame number) and `screenshot` (native-res crop) are still
follow-ups. The control server's op registry makes each a one-liner to add.

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
