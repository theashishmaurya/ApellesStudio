# Chroma control server + MCP — build spec (D-020)

Goal: **Claude (via MCP) and the running Chroma app share one grade state.** An MCP
edit moves the app's sliders and re-renders the canvas; `get_grade` reflects the
user's manual edits. Pull-based, like Palmier's `inspect_color` / `get_timeline`.

Architecture: `MCP server (Python) --HTTP--> control server (Rust, in-app) --Tauri events--> frontend (owns the grade)`.

---

## Part 1 — Rust control server  ·  `engine/src-tauri/src/chroma/control.rs` (new)

- Add dep to `engine/src-tauri/Cargo.toml`: `tiny_http = "0.12"`.
- `pub mod control;` in `engine/src-tauri/src/chroma/mod.rs`.
- Spawn in `engine/src-tauri/src/lib.rs` `.setup()` (near the other `std::thread::spawn`
  blocks, ~line 1971): `let h = app_handle.clone(); std::thread::spawn(move || chroma::control::serve(h));`
- `pub fn serve(app: tauri::AppHandle)`:
  - bind `127.0.0.1:${CHROMA_CONTROL_PORT:-19788}` (log the port; if bind fails, log + return, don't panic)
  - loop over requests. Each: parse `op` (from path, e.g. `POST /adjust`) + JSON body.
  - **Bridge:** generate a request id (`uuid`), `app.emit("chroma://request", json!({ "id": id, "op": op, "args": body }))`.
    Register a `app.once(format!("chroma://response/{id}"), move |ev| { tx.send(ev.payload) })`
    with a `std::sync::mpsc` channel; `rx.recv_timeout(Duration::from_secs(20))`.
    Respond 200 with the payload JSON, or 504 on timeout, 400 on bad op.
  - Endpoints (all thin — the frontend does the work):
    | method path | args | frontend op |
    |---|---|---|
    | `GET /health` | — | returns `{ok, hasImage, isVideo, frame, frameCount}` |
    | `GET /state` | — | current `adjustments` + `{width,height,path}` |
    | `POST /adjust` | `{patch: {exposure?, contrast?, highlights?, shadows?, whites?, blacks?, temperature?, tint?, saturation?, vibrance?, dehaze?, clarity?, structure?, sharpness?, vignetteAmount?}}` | deep-merge into `adjustments` |
    | `POST /curve` | `{channel: "master"|"red"|"green"|"blue", points: [[x,y],…]}` | set `adjustments.curves[channel]` |
    | `POST /color-grade` | `{shadows?:{h,s,l}, midtones?:{…}, highlights?:{…}, blending?, balance?}` | merge `adjustments.colorGrading` |
    | `POST /seek` | `{frame}` | invoke `chroma_seek` + bumpFrameNonce |
    | `GET /render` | `?res=preview|full` | just return current `{image_b64, histogram}` |
    | `GET /scopes` | — | `{histogram, waveform}` |
  - Every response body carries `{ ok, image_b64, histogram, adjustments }` where sensible
    (mutating ops return the post-render frame — the agent's eyes).

Keep it small (~200 lines). All heavy logic is in the frontend.

## Part 2 — Frontend bridge  ·  `engine/src/hooks/useChromaControl.ts` (new)

- Mount once in `engine/src/components/panel/Editor.tsx` (next to `useChromaSubjectTracking()`).
- `import { listen, emit } from '@tauri-apps/api/event'`.
- `listen('chroma://request', async (ev) => { const {id, op, args} = ev.payload; ... emit('chroma://response/'+id, result) })`.
- Ops use the **existing** state paths so the UI stays in sync:
  - grade edits: `useEditorActions().setAdjustments(prev => deepMerge(prev, patch))` — this is
    the same call a slider uses → sliders move, history + save fire, canvas re-renders.
  - `get_grade` / `/state`: read `useEditorStore.getState().adjustments` live.
  - the rendered frame: after applying, wait ~1 frame for `useEditorStore.getState().finalPreviewUrl`
    to update (or poll it briefly), return it as the image. histogram: `useEditorStore.getState().histogram`.
  - `/seek`: `invoke('chroma_seek', {frame})` then `useChromaStore.getState().bumpFrameNonce()`.
- `deepMerge`: shallow-ish merge — top-level number keys replace; nested objects
  (`colorGrading`, `curves`) merge one level. Small helper, don't pull a lib.

## Part 3 — MCP server  ·  `mcp/`  (new dir at repo root)

- `mcp/server.py` — Python, the `mcp` SDK (`pip install "mcp[cli]"`) or FastMCP. Stdio transport.
- `mcp/.venv`, `mcp/requirements.txt`, `mcp/README.md`.
- Base URL `http://127.0.0.1:${CHROMA_CONTROL_PORT:-19788}`.
- Tools (each mutating one returns the rendered frame + histogram as text/JSON; image as an
  MCP image content block if the SDK supports it, else base64 in the text):
  | tool | -> HTTP |
  |---|---|
  | `get_grade()` | `GET /state` |
  | `set_primary(exposure?, contrast?, highlights?, shadows?, whites?, blacks?, temperature?, tint?, saturation?, vibrance?, dehaze?, clarity?)` | `POST /adjust {patch}` |
  | `set_curve(channel, points)` | `POST /curve` |
  | `set_color_grade(shadows?, midtones?, highlights?, blending?, balance?)` | `POST /color-grade` |
  | `seek(frame)` | `POST /seek` |
  | `render()` | `GET /render` |
  | `read_scopes()` | `GET /scopes` |
- `mcp/README.md`: how to add to Claude Code — `claude mcp add chroma -- <abs path>/mcp/.venv/bin/python <abs path>/mcp/server.py` (stdio). Note the app must be running.

## Done =

1. `cargo check` on `engine/src-tauri` clean; app still launches (watch `npm run tauri dev`).
2. With the app open: `curl 127.0.0.1:19788/health` returns real state; `curl -XPOST .../adjust -d '{"patch":{"exposure":0.5}}'` visibly brightens the canvas AND moves the Exposure slider.
3. `mcp/server.py` connects; `set_primary` from an MCP client does the same.
4. Commit: engine submodule on branch `chroma` first, then bump the parent pointer.
   Divergence note in `docs/09-engine-notes.md`. Tick D-020 / roadmap. Commit-message
   format per repo `CLAUDE.md` (Co-Authored-By + Claude-Session trailers).

## Gotchas
- Fork hygiene (repo `CLAUDE.md` / D-003): new code under `src/chroma/`, minimal edits to
  upstream files (`lib.rs` +2 lines, `mod.rs` +1), log them in doc 09.
- `tauri::AppHandle` is `Send + Sync + Clone` — fine to move into the server thread.
- `app.emit` needs `use tauri::Emitter;`. `app.once` needs `use tauri::Listener;`.
- The event payload from JS arrives as a JSON string — parse it.
- If `finalPreviewUrl` capture is racy, it's OK to return the histogram + `ok:true` without
  the image for v1 and note it; the image is a nice-to-have, sync is the requirement.
