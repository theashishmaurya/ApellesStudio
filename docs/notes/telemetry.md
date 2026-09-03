# User-action telemetry (D-093, 2026-09-03)

Owner: "where we can we should hook up the telemetry so we can check everything
as we build things... all the user actions etc." Real, ongoing ask for adoptable
infrastructure — not "instrument literally every component in one pass." This doc
is the design + a running list of what's wired vs. still a manual follow-up, same
role `docs/notes/mcp-tool-coverage.md` and `docs/notes/performance-instrumentation.md`
already play for their areas.

## The API

`trackEvent(event: string, props?: Record<string, unknown>)`, exported from
`@chroma/bridge` (`packages/bridge/src/telemetry.ts`). D-039 layer rules put it
there because `@chroma/bridge` is "the frontend↔backend seam... consumed by every
tab package" — the one place code that isn't `@chroma/shell` itself (which must
not depend on bridge, see `packages/shell/src/store.ts`'s own header) can reach a
single shared telemetry call from.

```ts
import { trackEvent } from '@chroma/bridge';

trackEvent('relight_light_add', { kind: 'key' });
```

- **Local-only, no network.** No analytics SDK, no outbound call of any kind.
- **Reuses the existing sink instead of inventing one.** Every event is forwarded
  through the `frontend_log` Tauri command (`app/src-tauri/src/lib.rs`, already
  registered, already forwarding to `log::info!`/`warn!`/`error!` with a
  `[frontend]` prefix) with a `[telemetry]` sub-prefix and a JSON payload. Events
  land in the exact same `app_log_dir()/app.log` this whole project already tails
  for debugging — no new Rust command, no new storage, no new file to remember to
  look at.
- **Fire-and-forget.** `trackEvent` never throws and never awaits anything the
  caller needs — a telemetry call must never be the reason a click handler fails
  or a UI action feels slower.
- **Payload shape**: `{"event": string, "ts": epoch-ms, "props"?: object}`. Keep
  `props` small and JSON-serializable — ids, enum-like strings, counts. Never pass
  a whole domain object (a `RelightLight`, a `Timeline`), and never anything
  sensitive (file contents, absolute paths outside the project).

## Querying events out of `app.log`

```bash
grep '\[telemetry\]' "$(app.log path)" | sed 's/.*\[telemetry\] //' | jq .
# one event type:
grep '\[telemetry\].*"event":"relight_light_add"' "$(app.log path)"
```

`app_log_dir()` is the Tauri app log directory (platform-standard location, same
one `frontendLogBridge.ts`'s console-interception already writes debug noise
into — telemetry events are interleaved with that in the same file, distinguished
by the `[telemetry]` vs `[frontend]` prefix).

## Why not `frontendLogBridge.ts`

`app/src/utils/frontendLogBridge.ts` is a different, adjacent thing: it
intercepts `console.log`/`warn`/`error`/`window.onerror`/unhandled rejections and
forwards them to the same `frontend_log` command for **debugging** ("what broke,"
serialized error objects, Vite HMR errors, deduped within a 1.5s window). Telemetry
is **what did the user do** — deliberate, small, structured events, not console
noise. Both end up in the same `app.log` via the same Tauri command, which is
exactly the point of reusing it, but they're two separate call paths on purpose:
telemetry events are never routed through `console.*` (would pick up the dedupe/
truncation/serialization logic built for error objects, not designed for this).

## What's wired up today

- **Tab switches** — `app/src/main.tsx`'s `Root()`, a `useEffect` watching
  `useActiveTab()` or a previous value (skips the initial mount). Lives at the
  composition root rather than inside `@chroma/shell`'s own store, because that
  store explicitly must not depend on `@chroma/bridge` (same layering reason the
  existing B-007/D-062 bridges in that file already document).
  `event: "tab_switch"`, `props: { from, to }`.
- **Project lifecycle** — `app/src/store/useSessionStore.ts`: `openProject`
  (`"project_open"`, `{ shotCount }`), `newProject` (`"project_new"`,
  `{ mediaCount }`), `closeProject` (`"project_close"`, `{ hadUnsavedChanges }`).
  Instrumented in the store actions themselves (one choke point for every caller:
  `ProjectLauncher.tsx`, the Shell's "‹ Projects" button, etc.) rather than at
  each call site.
- **Relight actions** — `app/src/components/chroma/RelightPanel.tsx`:
  `"relight_light_add"` (`{ kind }`, ambient or positional), `"relight_light_delete"`,
  `"relight_preset_apply"` (`{ preset }`, the preset id). `app/src/hooks/useAiMasking.ts`:
  `"relight_bake_depth"`, `"relight_bake_normals"`, `"relight_track_depth"` — fired
  on real success (after the sidecar/ONNX call actually completes), not on click,
  so a failed bake doesn't read as a completed one. Note: Bake Depth can also
  auto-fire itself (D-073, the moment a positional light exists with no depth
  source yet) — that still emits `"relight_bake_depth"`, which is correct: the
  owner asked to track the action happening, not just the button being pressed.

## Not yet instrumented (follow-up, mechanical to add)

- **NLE track/clip actions** (add/remove clip, lock/hide/mute a track, rearrange,
  clip transform edits, keyframe add/remove) — deliberately skipped this pass.
  Another fork is mid-flight on a real UI rework of
  `packages/editor/src/TimelinePane.tsx` (replacing the "Move to ▾" dropdown and
  up/down buttons with real drag-and-drop), and editing that file's interaction
  code concurrently would collide with that work. Once that lands, add
  `trackEvent` calls at the same choke-point level this doc's other entries use —
  either inside `packages/editor/src/timeline.ts`'s op-apply path (covers every
  `EditOp` in one place, same reasoning as the Relight/session hookups above) or
  at `TimelinePane.tsx`'s individual UI handlers, whichever that rework's final
  shape makes more natural. `packages/editor` is a tab package and may depend on
  `@chroma/bridge` per D-039, so no layering obstacle — this is pure "someone
  needs to sit down and add the calls."
- **Motion tab actions** (scene/layer selection, render trigger) — zero coverage.
  `packages/motion` cannot depend on `@chroma/ui` (a real `@react-three/fiber`
  JSX-typing conflict, documented in `packages/motion/src/Button.tsx`) but CAN
  depend on `@chroma/bridge` — no known obstacle, just not done yet.
- **Media/Sources pool actions** (import, move, create folder) — zero coverage;
  `useMediaPoolStore` (`@chroma/bridge`) already sits in the right package, so
  adding `trackEvent` calls to its own actions is the same one-choke-point pattern
  `useSessionStore` above uses.
- **Export/render actions** (Colorist export, Motion render) — zero coverage.
- **Masks/curves/color-grade adjustments** — deliberately out of scope even long
  term: these fire on every slider drag tick, not per discrete action; instrumenting
  them as-is would flood `app.log` for near-zero signal. Worth revisiting only if a
  coarser "grade adjusted" (debounced, not per-tick) event turns out to be wanted.

## Adopting this for a new surface

1. Import `trackEvent` from `@chroma/bridge` (any tab package or `app/src` may —
   check `docs/notes/architecture-lock.md`'s layer table if unsure).
2. Call it after the action actually succeeds (mirrors the Relight bake handlers
   above), not on click — a failed action shouldn't read as a completed one.
3. Keep `props` small and JSON-serializable.
4. Add a line to the "wired up today" list above.
