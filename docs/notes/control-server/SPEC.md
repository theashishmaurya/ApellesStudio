# Chroma control server + MCP — build spec (D-020)

Goal: **Claude (via MCP) and the running Chroma app share ONE state — for every
action.** Not just primary grade: creating a mask, editing a mask, per-mask grades,
tracking, transport — all of it. An MCP call moves the app's UI and re-renders the
canvas; a read reflects the user's manual edits. Pull-based, like Palmier.

Architecture: `MCP server (Python) --HTTP--> control server (Rust, in-app) --Tauri events--> frontend (owns all state)`.

**Cardinal rule:** every op is dispatched to a **real frontend action** — the same
`setAdjustments` / `useAiMasking` handler / `updateSubMask` the GUI buttons call. Never
a parallel code path. That's what keeps MCP and the UI from ever diverging. Adding a
new MCP capability = add one entry to the op registry in `useChromaControl`.

---

## Part 1 — Rust control server  ·  `app/src-tauri/src/chroma/control.rs` (new)

- Add dep to `app/src-tauri/Cargo.toml`: `tiny_http = "0.12"`.
- `pub mod control;` in `app/src-tauri/src/chroma/mod.rs`.
- Spawn in `app/src-tauri/src/lib.rs` `.setup()` (near the other `std::thread::spawn`
  blocks, ~line 1971): `let h = app_handle.clone(); std::thread::spawn(move || chroma::control::serve(h));`
- `pub fn serve(app: tauri::AppHandle)`:
  - bind `127.0.0.1:${CHROMA_CONTROL_PORT:-19788}` (log the port; if bind fails, log + return, don't panic)
  - loop over requests. Each: parse `op` (from path, e.g. `POST /adjust`) + JSON body.
  - **Bridge:** generate a request id (`uuid`), `app.emit("chroma://request", json!({ "id": id, "op": op, "args": body }))`.
    Register a `app.once(format!("chroma://response/{id}"), move |ev| { tx.send(ev.payload) })`
    with a `std::sync::mpsc` channel; `rx.recv_timeout(Duration::from_secs(20))`.
    Respond 200 with the payload JSON, or 504 on timeout, 400 on bad op.
  - **One generic endpoint:** `POST /op` with body `{op: "<name>", args: {...}}`. (Plus
    `GET /health` for a liveness check that doesn't need the bridge.) The control server
    doesn't know the op list — it just forwards. The op registry lives in the frontend.
  - Every `/op` response body: `{ ok, error?, result, adjustments, image_b64?, histogram? }`
    — mutating ops include the post-render frame + histogram (the agent's eyes).

Keep it small (~150 lines). Zero grade/mask logic here.

## Part 2 — Frontend bridge  ·  `app/src/hooks/useChromaControl.ts` (new)

- Mount once in `app/src/components/panel/Editor.tsx` (next to `useChromaSubjectTracking()`).
  It needs `useEditorActions()`, `useAiMasking()`, store getters.
- `import { listen, emit } from '@tauri-apps/api/event'`.
- `listen('chroma://request', async (ev) => { const {id, op, args} = ev.payload; const result = await OPS[op]?.(args) ?? {error:'unknown op'}; emit('chroma://response/'+id, withFrame(result)) })`.
- `withFrame(r)` = merge in `{ adjustments: store.adjustments, image_b64: <finalPreviewUrl→b64>, histogram: store.histogram }` after waiting briefly for the render to settle.
- **`OPS` registry** — each entry is a real frontend action:

  | op | impl (existing frontend action) |
  |---|---|
  | `get_state` | read `useEditorStore` — adjustments, masks summary, `{w,h,path,frame,frameCount}` |
  | `set_primary` | `setAdjustments(prev => deepMerge(prev, args.patch))` (exposure, contrast, highlights, shadows, whites, blacks, temperature, tint, saturation, vibrance, dehaze, clarity, structure, sharpness, vignetteAmount) |
  | `set_curve` | `setAdjustments(p => ({...p, curves: {...p.curves, [args.channel]: args.points}}))` |
  | `set_color_grade` | merge `adjustments.colorGrading` (lift/gamma/gain wheels + blending/balance) |
  | `seek` | `invoke('chroma_seek', {frame}); useChromaStore.getState().bumpFrameNonce()` |
  | `list_masks` | map `adjustments.masks` → `{id, name, type, subMasks:[{id,type}], adjustments-summary}` |
  | `add_mask` | append a `MaskContainer` (`INITIAL_MASK_CONTAINER`) via `setAdjustments`; return its id |
  | `add_subject_mask` | add container + an `ai-subject` sub-mask, set its box from `args.bbox` (or full-frame), then call `useAiMasking().handleGenerateAiMask(subId, start, end)` (routes to `chroma_subject_mask` on video). return ids |
  | `track_subject` | `useAiMasking().handleTrackSubject(subMaskId, args.mode ?? 'fast')` |
  | `add_shape_mask` | add container + `radial`/`linear` sub-mask with `args.geometry` |
  | `add_depth_mask` | add container + `ai-depth` sub-mask, call `handleGenerateAiDepthMask` |
  | `set_mask_adjust` | `updateContainer(args.maskId, { adjustments: deepMerge(cur, args.patch) })` — grade *through* the mask (same fields as `set_primary`) |
  | `set_mask_geometry` | `updateSubMask(args.subMaskId, { parameters: deepMerge(cur, args.geometry) })` |
  | `set_mask_visible` / `invert_mask` | toggle `container.visible` / `subMask.invert` |
  | `delete_mask` | `useAiMasking().handleDeleteMaskContainer(args.maskId)` |

  Start with: `get_state, set_primary, set_curve, set_color_grade, seek, list_masks,
  add_subject_mask, track_subject, set_mask_adjust, invert_mask, delete_mask`. The rest
  are one-liners to add later — the point is the pattern.
- `deepMerge`: top-level keys replace; nested plain objects merge one level. ~15 lines, no lib.
- The mask handlers in `useAiMasking` are already written and already keep the UI in
  sync (they use `setAdjustments`) — the op just calls them. **Do not reimplement mask logic.**

## Part 3 — MCP server  ·  `mcp/`  (new dir at repo root)

- `mcp/server.py` — Python, the `mcp` SDK (`pip install "mcp[cli]"`) or FastMCP. Stdio transport.
- `mcp/.venv`, `mcp/requirements.txt`, `mcp/README.md`.
- Base URL `http://127.0.0.1:${CHROMA_CONTROL_PORT:-19788}`. Every tool = `POST /op {op,args}`.
- Tools (thin wrappers; each mutating one returns the rendered frame as an MCP image block
  if the SDK supports it, else base64 in text, plus the histogram + adjustments):
  `get_state`, `set_primary(**knobs)`, `set_curve(channel, points)`,
  `set_color_grade(shadows?, midtones?, highlights?, blending?, balance?)`, `seek(frame)`,
  `list_masks()`, `add_subject_mask(bbox?)`, `track_subject(sub_mask_id, mode="fast")`,
  `set_mask_adjust(mask_id, **knobs)`, `invert_mask(sub_mask_id)`, `delete_mask(mask_id)`.
- `mcp/README.md`: how to add to Claude Code — `claude mcp add chroma -- <abs>/mcp/.venv/bin/python <abs>/mcp/server.py` (stdio). Note: the Chroma app must be running.

## Done =

1. `cargo check` on `app/src-tauri` clean; app still launches (watch `/tmp/chroma_tauri.log`
   — `npm run tauri dev` is already running).
2. With the app open + an image/video loaded:
   `curl 127.0.0.1:19788/health` → real state.
   `curl -XPOST 127.0.0.1:19788/op -d '{"op":"set_primary","args":{"patch":{"exposure":0.5}}}'`
   → canvas visibly brightens AND the Exposure slider moves. Response has `image_b64` + `histogram`.
   `curl -XPOST .../op -d '{"op":"add_subject_mask","args":{}}'` on a video → a Subject mask appears in the panel.
3. `mcp/server.py` connects from an MCP client; `set_primary` / `add_subject_mask` do the same.
4. Now drag a slider in the app by hand, then `curl .../op -d '{"op":"get_state"}'` → the change is there.
5. Commit: engine submodule on branch `chroma` first, then bump the parent pointer.
   Divergence note in `docs/09-engine-notes.md` (control.rs, +lib.rs/mod.rs lines, Cargo dep).
   Tick D-020 / roadmap. Commit-message format per repo `CLAUDE.md` (Co-Authored-By +
   Claude-Session trailers, both engine and parent).

## Gotchas
- Fork hygiene (repo `CLAUDE.md` / D-003): new code under `src/chroma/`, minimal edits to
  upstream files (`lib.rs` +2 lines, `mod.rs` +1), log them in doc 09.
- `tauri::AppHandle` is `Send + Sync + Clone` — fine to move into the server thread.
- `app.emit` needs `use tauri::Emitter;`. `app.once` needs `use tauri::Listener;`.
- The event payload from JS arrives as a JSON string — parse it.
- If `finalPreviewUrl` capture is racy, it's OK to return the histogram + `ok:true` without
  the image for v1 and note it; the image is a nice-to-have, sync is the requirement.
