# BUGS

Real defects only — in our code or the engine. Not setup/housekeeping. Move to GitHub
Issues once public.

```
## B-NNN — title
status: open | fixed | wontfix   ·   severity: blocker | high | medium | low   ·   area: …
repro / expected / actual / cause / fix
```

## Known engine constraints (design around these — not bugs)

- Render entry points are Tauri-coupled → **D-014** (extract `render_core`).
- Masks are static per image — no keyframe/tracking model. We add it.
- Depth Anything is wired for stills; per-frame video depth needs temporal smoothing or it flickers.
- `process_and_get_dynamic_image` bypasses the GPU and returns the source unprocessed if `w|h > max_texture_dimension_2d` — watch at 8K.

## Open

_(none)_

## Fixed

## B-004 — entry module double-executes on every cold boot → corrupted Tauri IPC → "No project open" in Edit, blank Colorist preview
status: fixed (2026-09-02) · severity: blocker · area: app/index.html, frontend↔backend IPC
- **repro:** fresh `npm run tauri:dev` (verified across independent cold boots, port + processes killed first). Within ~2s of "Logger initialized successfully": `ReactDOMClient.createRoot() on a container that has already been passed to createRoot()`, then a burst of `[TAURI] Couldn't find callback id N` warnings and `Unhandled promise rejection TypeError: undefined is not an object (evaluating 'listeners[eventId].handlerId')` in `@tauri-apps/api/event.js`'s `_unlisten`, repeated several times.
- **expected:** Edit tab shows a real timeline once a project with shots is open in Colorist; Colorist's main preview viewport shows the current frame (not just the shot-strip thumbnail).
- **actual:** Edit tab stuck on "No project open" even with a project open and a shot visible in Colorist's shot strip; Colorist's own main preview viewport blank, though its shot-strip thumbnail rendered fine and the Rust backend logged successful `[apply_adjustments] … native WGPU display updated` renders. After the corruption, no further `invoke`/`listen` round-trip reached React for the rest of the session.
- **cause:** `app/index.html`'s entry `<script>` still pointed at `/src/main.jsx`, a file that hasn't existed since the D-039 TS rename (`main.tsx` is the real entry) — a dead reference `git log` shows predates `main.tsx`. Confirmed via a temporary `import.meta.url` probe at the top of `main.tsx`: on cold boot the module body runs **twice**, once for each of two distinct URLs — `http://localhost:1420/src/main.jsx` (the browser's literal fetch of the stale `<script src>`, which Vite's dev-server extension-probing fallback resolves to `main.tsx`'s real source and serves under the wrong module id) and `http://localhost:1420/src/main.tsx` (a second, genuinely separate fetch/execution of the same file under its correct canonical URL). Two independent top-level module executions call `createRoot()` on the same `#root` DOM node and independently wire up `useTauriListeners`' `listen()` calls (including `wgpu-frame-ready`, which the Colorist preview depends on) against the same shared `@tauri-apps/api/event.js` singleton, racing on `listen`/`unlisten` bookkeeping and corrupting the callback-id map — after which further `invoke`/`listen` resolutions silently stop reaching React. `chroma_timeline_get`'s real error text (`"no project open — open one in the Colorist tab"`) matches exactly what Edit tab's empty-state renders, confirming the open-project `invoke` was one of the calls that never resolved correctly.
- **fix:** `app/index.html` — `<script type="module" src="/src/main.jsx">` → `/src/main.tsx`. Re-verified with the same `import.meta.url` probe on a fresh cold boot: the module executes exactly once, no `createRoot` warning, no `unlisten` TypeError, for the whole session. Re-verified the two user symptoms directly (via `osascript`/System Events driving the real app window, since WKWebView exposes real accessibility): opened the existing `~/Movies/Chroma/New.chroma` project (a genuine saved `.chroma` project, not an Untitled/loose-clip session) — Edit tab's "No project open" state was replaced by a real Timeline pane, and Colorist's main preview `<img>` (726×516, positioned as the main viewport, distinct from the 49-thumbnail shot strip) rendered, with matching `[apply_adjustments] … WGPU display updated` log lines tied to the same action.
- **note:** unrelated to this bug — that one test project's `project.json` already had a *persisted-empty* `timeline` field (0 clips despite 1 shot) predating this session, most likely written during an earlier session while this same corruption was active. `chroma_timeline_get` returns a project's persisted timeline as-is once one exists (by design, D-041) rather than rebuilding, so that project's Edit timeline still shows 0 duration until its `timeline` field is cleared or a shot is re-added — a stale-data artifact of the bug's *effects*, not a remaining defect in the fix.

## B-002 — AI sidecar climbs to ~12 GB after repeated "Re-track"
status: fixed (2026-09-01) · severity: high · area: ai/server.py
- **repro:** load a video, track a subject, hit "Re-track subject across clip" several times (or scrub a lot during a track).
- **expected:** sidecar RSS bounded — one predictor + models ≈ 1–1.5 GB.
- **actual:** ~12 GB (mostly compressed under memory pressure; `ps` RSS showed ~330 MB resident, Activity Monitor "Memory" 12 GB). Machine hit 20 GB swap.
- **cause:** each `/track` built a *fresh* `SAM2DynamicInteractivePredictor` (~1 GB into the MPS pool, which never returns to the OS); track + on-seek `/refine_track` + ViTMatte warm-up ran concurrently, stacking their MPS working sets. The propagation loop itself is flat (verified — `memory_bank` stays at 1).
- **fix:** `_GPU` lock serialises every model call (per-frame in the track loop so refine interleaves); `_get_video_predictor` reuses one instance with per-track state reset; `_free_gpu()` (`empty_cache` + `gc`) after every `/segment`, `/refine_track`, and track pass; `/track` cancels any still-running track. Measured after: plateaus ~1.3 GB across repeated tracks, refines pull it back toward ~800 MB (577 MB after an hour of heavy testing).

## B-003 — tracking seek: render storm, frozen timeline, offset overlay
status: fixed (2026-09-01) · severity: high · area: engine + frontend
- **repro:** track a subject, click/scrub the timeline.
- **actual:** timeline playhead frozen; canvas re-rendering continuously (`apply_adjustments` ~30×/s); red overlay a person-shaped blob offset from the actual subject.
- **cause:** (1) `useAiMasking` (with the per-seek matte-swap effect) is mounted in 3 components → 3× work per seek, and it fired on every intermediate drag frame — each a `setAdjustments` + full re-render. (2) frame vs matte desync: `frameNonce` bumps faster than `setAdjustments` settles → frame-N matte on frame-M image. (3) `ChromaTimeline` root `onPointerDownCapture={e=>e.stopPropagation()}` ate the strip's own `onPointerDown` — clicks did nothing.
- **fix:** **D-019** — matte read from disk at render time (`generate_ai_subject_bitmap` → `tracked_full_mask`), no per-seek `setAdjustments`; a seek just bumps `frameNonce`. Root capture-phase `stopPropagation` moved onto the strip handler.
