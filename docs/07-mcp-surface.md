# 07 — MCP tool surface

Status: **draft**. Names/params will firm up in Phase 3.

## Design rules

1. **Tools map to `grade.json` fields, not to GUI buttons.**
2. **Every mutating tool returns `{ rendered_frame_png, scopes }`** at the current
   playhead (or a named frame) — the agent's eyes. This is the `apply → inspect → adjust`
   loop proven in the Palmier trials.
3. **Reads are cheap and side-effect-free.** `render_still`, `read_scopes`, `get_grade`.
4. **Human handoff is a tool**, not a dead end.
5. **Deterministic.** Same doc + same frame ⇒ same output.
6. Merge semantics like Palmier's `apply_color`: pass only the knobs you want to change;
   the rest are preserved. `reset: true` to start a layer from neutral.

## Tools

### Session / shots
| Tool | Params | Returns |
|---|---|---|
| `open_shot` | `source`, `in`, `out`, `fps?`, `reference?` | `shot_id`, `{frame, scopes}` |
| `list_shots` | — | shots + grade summary each |
| `select_shot` | `shot_id` | `{frame, scopes}` |
| `set_playhead` | `frame` | `{frame, scopes}` |
| `get_grade` | `shot_id?` | the `grade.json` |

### Render / inspect (read-only)
| Tool | Params | Returns |
|---|---|---|
| `render_still` | `frame?`, `res?` (proxy\|full) | PNG |
| `render_range` | `from`, `to`, `step` | PNG frames (for a transition/motion check) |
| `read_scopes` | `frame?` | waveform, RGB parade, vectorscope, histogram, clip %, mean/per-channel, hue histogram |
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

## The loop, illustrated

```
read_scopes()                       → "flat, warm cast, subject and bg same brightness"
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
