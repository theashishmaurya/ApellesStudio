/**
 * Chroma — the isolated pointer-gesture browser harness (D-142).
 *
 * **What it is.** This exact kind of scratch entry point — mount one real
 * component standalone in a real browser tab, seed a hand-built store
 * fixture, stub Tauri's `invoke`, drive it with real `PointerEvent`s over
 * CDP — has been built from scratch and thrown away at least five times in
 * this repo (D-095, D-096, D-098, D-100, D-137), always as `app/harness.html`
 * + `app/src/harness-main.tsx`, always deleted right after use, never
 * committed. This file is that pattern made PERMANENT: the next
 * pointer-gesture feature (or bug report) gets to open a real Chromium tab
 * against this immediately, instead of re-deriving the whole setup —
 * `window.__TAURI_INTERNALS__` stubbing, sidestepping the full app's deep
 * Tauri-IPC boot chain, a seedable fixture, StrictMode — for a sixth time.
 *
 * **Why `TimelinePane` alone, not the full app.** D-095 tried loading the
 * real app in a plain Chrome tab first and it crashed immediately in
 * `<WindowControls>` reading Tauri window metadata that doesn't exist outside
 * the native shell; stubbing enough of `window.__TAURI_INTERNALS__` to reach
 * a real open project turned out to be a much deeper rabbit hole than the
 * timeline UI itself, not worth it for verifying a pointer gesture.
 * `TimelinePane` is now a real, intentional export of `@chroma/editor`
 * (alongside `EditorTab`, see that package's `index.ts`) specifically so this
 * file can mount it without reaching past the package's public API.
 *
 * **How to use this for a NEW pointer-gesture check**, without editing this
 * file's own defaults: everything below is reachable from a CDP session via
 * `window.__chromaHarness` (see the bottom of this file) — reseed the store,
 * flip StrictMode, or just read `window.__chromaHarness.timeline` to confirm
 * state. Use `packages/editor/src/testUtils/pointerHarness.ts`'s own
 * `firePointerEvent`/`dragPointer`-equivalent event construction directly via
 * **D-204 (B-085) — `'preview'` mode now covers canvas click-to-select too.**
 * `chroma_timeline_clip_geometry`'s stub resolves its real arguments instead
 * of returning one fixed answer, and `setClipNatural` lets a CDP session give
 * each layer its own footprint — without which "topmost layer wins" and
 * "fall through to the layer below" cannot be told apart on screen at all.
 *
 * `evaluate_script` (that module isn't bundled into this page — it's a
 * vitest-side utility — but its documented event-construction shape,
 * `new PointerEvent(type, {bubbles:true, cancelable:true, ...})`, is exactly
 * what to replicate in an `evaluate_script` call; real
 * `requestAnimationFrame` waits between events remain the one real,
 * non-negotiable rule — see that file's own module doc for why).
 *
 * **D-195, Task 3 — extended to mount `TimelineSwitcher` too, for real
 * multiple-timeline verification.** `installInvokeStub`'s handler map is now
 * backed by a tiny in-memory multi-timeline "project" (`fakeProject`, below)
 * rather than a single fixture object, so `chroma_timeline_list`/`_create`/
 * `_set_active` behave like the real `chroma::edit` Rust commands they mirror
 * (`chroma_timeline_create` appends+activates a fresh empty timeline;
 * `chroma_timeline_set` always writes onto whichever is CURRENTLY active,
 * exactly like the real command's own `manifest.timelines[manifest.
 * active_timeline] = timeline`, not by matching the passed timeline's own
 * `id`) — real enough to click the "+" tab, name a timeline, switch back and
 * forth, and confirm each one's own clips persist independently rather than
 * bleeding into the other. `window.__chromaHarness.project` exposes the raw
 * backing store for a CDP session to inspect directly.
 *
 * **What this file does NOT do.** It does not run in CI and does not
 * substitute for `TimelinePane.marquee.dom.test.tsx`'s own jsdom-tier
 * regression coverage (`packages/editor`, runs on every `npm test`). This is
 * the STRONGER, manual tier: real layout, real paint, real dnd-kit rect
 * measurement against real geometry — the things jsdom's own zero-layout
 * environment cannot check (see that test file's own header). It is still
 * not the real Tauri/WKWebView window (every entry since D-125 discloses
 * this the same way) — Chromium driven by real `PointerEvent`s is a
 * meaningfully stronger check than jsdom, but WKWebView is a different
 * rendering/DnD engine, and this repo's own history is "looked fine in code,
 * broke on real pointer input." Treat a clean run here as strong evidence,
 * not as the owner's own hands-on check in the real app.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  EditLibraryPanel,
  EditLibraryRail,
  EditorInspectorPanel,
  PreviewPane,
  TimelinePane,
  TimelineSwitcher,
  timelineDuration,
  useEditorTimelineStore,
  type ClipInspectorTab,
  type EditLibraryMode,
  type EditOp,
  type Timeline,
} from '@chroma/editor';
import { DEFAULT_THEME_ID, THEMES } from './utils/themes';
import '../src/styles.css';

/** D-199 — which component this page mounts, switchable at runtime via
 *  `window.__chromaHarness.setMode(...)` or the `?mode=preview` query param
 *  at load. Defaults to `'timeline'` — every existing consumer of this file
 *  (D-142's own history) expects `TimelinePane`; `'preview'` is the new,
 *  additive mode for the canvas-boundary/transform-overlay/drag checks (see
 *  `docs/notes/preview-canvas-boundary.md`).
 *
 *  **B-124 added `'inspector'`**, for the same reason `'preview'` exists: the
 *  clip Inspector's D-246 Video/Audio tab split is a pure LAYOUT question —
 *  does the deselected tab's panel still occupy a box on screen? — and jsdom
 *  answers every layout question with zero, so it is structurally incapable of
 *  seeing the bug that shipped (both panels painted, stacked, the Audio one
 *  1076px below the fold). Real Chromium measures it in one
 *  `getBoundingClientRect`.
 *
 *  **D-263 added `'library'`**, for exactly that reason again: whether the
 *  icon rail actually paints to the LEFT of the docked library column, at its
 *  own width, with the column filling the rest, is a layout question jsdom
 *  answers with zeroes. This mode mounts the rail and the docked panel in the
 *  same geometry `Shell.tsx` gives them (a horizontal row; the column at the
 *  shell's own 288px default width), so a real browser can measure and
 *  screenshot it. `window.__chromaHarness.setLibraryMode('titles' | 'effects'
 *  | 'subtitles' | 'sources')` switches what the column shows without a
 *  synthesised click, the same store action the rail's own button calls. */
type HarnessMode = 'timeline' | 'preview' | 'inspector' | 'library';

function setStatus(text: string): void {
  const el = document.getElementById('harness-status');
  if (el) el.textContent = text;
}

/** Mirrors `chroma::edit::TimelineSummary` (serde camelCase) — see
 *  `packages/editor/src/timelineStore.ts`'s own TS mirror of the same Rust
 *  type. Kept local rather than imported since only `TimelineSwitcher`'s
 *  props need the shape; the store already exports it but this file
 *  constructs raw invoke-response objects, not store state. */
interface TimelineSummary {
  id: string;
  name: string;
  duration: number;
  active: boolean;
}

/** D-195, Task 3 — the tiny in-memory "project" `chroma_timeline_list`/
 *  `_create`/`_set_active`/`_get`/`_set` all read and write, standing in for
 *  `chroma::project`'s real `ProjectManifest.timelines`/`active_timeline`
 *  (`app/src-tauri/src/chroma/edit.rs`). Real enough to exercise
 *  `TimelineSwitcher`'s actual click-through behavior end to end: creating a
 *  timeline appends+activates it (mirrors `chroma_timeline_create` exactly —
 *  fresh id, empty `tracks`, immediately active), and `chroma_timeline_set`
 *  always writes onto whichever timeline is CURRENTLY active (mirrors the
 *  real command's `manifest.timelines[manifest.active_timeline] = timeline`
 *  — by ACTIVE INDEX, never by matching the posted timeline's own `id`). */
interface FakeProject {
  timelines: Map<string, Timeline>;
  order: string[];
  activeId: string;
}

function makeFakeProject(): FakeProject {
  const seedTl = defaultFixture();
  return { timelines: new Map([[seedTl.id, seedTl]]), order: [seedTl.id], activeId: seedTl.id };
}

let fakeProject: FakeProject = makeFakeProject();

/** B-083/D-203 — the store's one input is the open project's identity key
 *  (`app/src/store/useSessionStore.ts`'s `selectProjectKey`, a `.chroma` path
 *  in the real app). The harness has exactly one fake project, so any stable
 *  non-null string is the faithful stand-in. */
const HARNESS_PROJECT_KEY = '/harness/fake.chroma';

/** A stand-in for `@tauri-apps/api/core`'s `invoke` — the real signature is
 *  `window.__TAURI_INTERNALS__.invoke(cmd, args)`, so this stubs exactly
 *  that global rather than the module (this page never runs inside Tauri,
 *  so there's no real one to conflict with). Every command `TimelinePane`/
 *  `TimelineSwitcher` (or their `Filmstrip`/`Waveform` children) can call is
 *  listed explicitly — an unlisted command rejects loudly, matching
 *  `testUtils/pointerHarness.ts`'s own `createInvokeStub` contract (kept in
 *  sync by hand; this file can't import that vitest-side module directly
 *  since it isn't part of this app's own dependency graph). */
/** A tiny (16×9, solid mid-gray) JPEG — stands in for a real
 *  `chroma_timeline_frame` server-composited frame. The harness's job is the
 *  REACT layer around that frame (does it render, does the boundary/overlay
 *  land where the geometry says it should, does a drag commit) — the actual
 *  composited PIXELS are a Rust concern, proven separately through the real
 *  `timeline_frame` code path (see `docs/notes/preview-canvas-boundary.md`),
 *  not something this browser-only page can produce without a real backend.
 *
 *  Kept as the base64 source text but handed over as raw BYTES (D-217): the
 *  real command answers with a `tauri::ipc::Response`, which reaches the
 *  frontend as an `ArrayBuffer`, and `PreviewPane` wraps that in a `Blob`
 *  object URL. A harness that still returned a `data:` URL would no longer be
 *  modelling the backend it exists to stand in for.
 *
 *  **B-099 — this is the bare base64 payload, with no `data:image/jpeg;base64,`
 *  prefix, and it has to stay that way.** D-217 rewrote the line below to
 *  `atob(...)` but left the prefix on the string, so `atob` threw
 *  `InvalidCharacterError` at module load and this whole page mounted
 *  nothing — the real-Chromium tier was silently dead from that commit until
 *  it was next opened. See B-099. */
const STUB_FRAME_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAJABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

/** `STUB_FRAME_BASE64` as the bytes the real command returns. Decoded once,
 *  at module load, and handed out as a fresh copy per call — `Blob` does not
 *  take ownership, but a shared buffer across calls would still be a
 *  needlessly surprising thing for a stub to do. */
const STUB_FRAME_BYTES = Uint8Array.from(atob(STUB_FRAME_BASE64), (c) => c.charCodeAt(0));

/** D-199 — the composition/canvas size a `CanvasSettingsPopover` save writes
 *  and `useCompositionSize` reads back; a real, if trivial, in-memory model
 *  (not a fixed constant) so the harness can actually verify a save round
 *  trips into the boundary overlay resizing. */
const harnessSettings: { width: number | null; height: number | null } = { width: 1920, height: 1080 };

/** The natural footprint `chroma_timeline_clip_geometry` reports for a clip
 *  whose source has no explicit entry in `harnessClipNatural` below — a 16:9
 *  clip at half the frame's own width. Big enough to see and drag, small
 *  enough that `TransformOverlay`'s handles clear the player chrome on a
 *  normal-size harness window. This was the ONLY answer that command gave
 *  before D-204. */
const DEFAULT_NATURAL = { naturalWidth: 0.5, naturalHeight: 0.28125 };

/** D-204 — per-source natural footprints, keyed by `Clip.source_path`.
 *
 *  Canvas click-to-select (`CanvasPickLayer`) hit-tests against EVERY visible
 *  layer's own box, so verifying "topmost wins" / "fall through to the layer
 *  below" needs different layers to actually have different boxes — which the
 *  one fixed response this stub used to give (it ignored its arguments
 *  entirely) could never produce. Empty by default, so every pre-D-204
 *  consumer of this file sees exactly the old behaviour; a CDP session sets
 *  entries via `window.__chromaHarness.setClipNatural(...)`. */
const harnessClipNatural = new Map<string, { naturalWidth: number; naturalHeight: number }>();

/** B-086 — a minimal in-page stand-in for Tauri's real event-plugin IPC, just
 *  enough for `@tauri-apps/api/event`'s `listen`/`emit` to work inside this
 *  browser-only harness: a `transformCallback` registry (the mechanism
 *  `listen()` uses to hand its handler a numeric id the "backend" can call
 *  back into) plus the `plugin:event|listen`/`unlisten`/`emit` invoke commands
 *  those functions themselves call. Needed because `useCompositionSize`
 *  (B-086) now listens for the real `chroma://project-settings-changed`
 *  broadcast directly instead of `PreviewPane` threading a hand-bumped token
 *  through `CanvasSettingsPopover`'s `onSaved` — without this, the harness
 *  could no longer prove the `CanvasSettingsPopover` -> `CanvasBoundary`
 *  round trip live, as `docs/notes/preview-canvas-boundary.md` documents doing.
 *  Deliberately NOT a general `window.__TAURI_INTERNALS__` reimplementation
 *  (this file's own module doc explains why that's out of scope, D-095) —
 *  just the one mechanism this fix now needs. */
let nextCallbackId = 1;
const eventCallbacks = new Map<number, (payload: unknown) => void>();
const eventListenerIds = new Map<string, Set<number>>();

function emitHarnessEvent(event: string, payload: unknown): void {
  for (const id of eventListenerIds.get(event) ?? []) {
    eventCallbacks.get(id)?.({ event, id, payload });
  }
}

function installInvokeStub(): void {
  const handlers: Record<string, (args: unknown) => unknown> = {
    'plugin:event|listen': (args) => {
      const { event, handler } = args as { event: string; handler: number };
      if (!eventListenerIds.has(event)) eventListenerIds.set(event, new Set());
      eventListenerIds.get(event)!.add(handler);
      return handler;
    },
    'plugin:event|unlisten': (args) => {
      const { event, eventId } = args as { event: string; eventId: number };
      eventListenerIds.get(event)?.delete(eventId);
    },
    'plugin:event|emit': (args) => {
      const { event, payload } = args as { event: string; payload: unknown };
      emitHarnessEvent(event, payload);
    },
    chroma_clip_thumbnails: () => [],
    chroma_audio_waveform: () => [],
    chroma_timeline_get: () => {
      const active = fakeProject.timelines.get(fakeProject.activeId);
      if (!active) throw new Error(`harness: no active timeline "${fakeProject.activeId}"`);
      return active;
    },
    chroma_timeline_set: (args) => {
      const { timeline } = args as { timeline: Timeline };
      // Real behavior (`chroma::edit::chroma_timeline_set`): always writes
      // onto the ACTIVE index, regardless of `timeline.id` — a caller can
      // never accidentally overwrite a different timeline by id collision.
      fakeProject.timelines.set(fakeProject.activeId, timeline);
    },
    chroma_timeline_list: (): TimelineSummary[] =>
      fakeProject.order.map((id) => {
        const t = fakeProject.timelines.get(id)!;
        return { id: t.id, name: t.name, duration: timelineDuration(t), active: id === fakeProject.activeId };
      }),
    chroma_timeline_create: (args): Timeline => {
      const { name } = args as { name: string };
      const id = `harness-tl-${Math.random().toString(36).slice(2, 8)}`;
      const tl: Timeline = { id, name, tracks: [] };
      fakeProject.timelines.set(id, tl);
      fakeProject.order.push(id);
      fakeProject.activeId = id;
      return tl;
    },
    chroma_timeline_set_active: (args) => {
      const { id } = args as { id: string };
      if (!fakeProject.timelines.has(id)) throw new Error(`harness: no timeline with id ${id}`);
      fakeProject.activeId = id;
    },
    // D-199 — PreviewPane's own decode/geometry/audio/settings commands.
    // `chroma_timeline_clip_geometry` is also `EditorExportDialog`'s (D-198)
    // composition-size default fetch — one definition, backed by the same
    // `harnessSettings` a `CanvasSettingsPopover` save round-trips through,
    // rather than two harnesses disagreeing about what this command returns.
    chroma_timeline_frame: () => STUB_FRAME_BYTES.slice().buffer,
    // D-204 — now resolves its ARGUMENTS (the real command takes track/clip
    // indices) against the active timeline, so a per-source override in
    // `harnessClipNatural` can give two layers genuinely different boxes.
    // Falls back to `DEFAULT_NATURAL` for anything unlisted, which is exactly
    // what this stub returned unconditionally before.
    chroma_timeline_clip_geometry: (args) => {
      const { track, clip } = args as { track: number; clip: number };
      const active = fakeProject.timelines.get(fakeProject.activeId);
      const sourcePath = active?.tracks?.[track]?.clips?.[clip]?.source_path ?? '';
      return {
        compWidth: harnessSettings.width ?? 1920,
        compHeight: harnessSettings.height ?? 1080,
        ...(harnessClipNatural.get(sourcePath) ?? DEFAULT_NATURAL),
      };
    },
    chroma_timeline_composition_size: () => ({
      compWidth: harnessSettings.width ?? 1920,
      compHeight: harnessSettings.height ?? 1080,
    }),
    chroma_project_get_settings: () => ({ width: harnessSettings.width, height: harnessSettings.height }),
    chroma_project_set_settings: (args) => {
      const patch = (args as { partial?: { width?: number | null; height?: number | null } })?.partial ?? {};
      if ('width' in patch) harnessSettings.width = patch.width ?? null;
      if ('height' in patch) harnessSettings.height = patch.height ?? null;
      // B-086 — the real `chroma_project_set_settings` command broadcasts
      // this event on every successful write; mirrored here so the harness
      // keeps proving `useCompositionSize`'s own refetch-on-broadcast path,
      // not just the direct invoke-stub round trip.
      emitHarnessEvent('chroma://project-settings-changed', { ...harnessSettings });
      return { ...harnessSettings };
    },
    chroma_audio_play: () => undefined,
    chroma_audio_stop: () => undefined,
    chroma_audio_set_volume: () => undefined,
    // D-232 — the scrub transport. The harness drives real playhead drags on
    // `TimelinePane`/`PreviewPane`, which now issue these; without stubs every
    // drag would reject on an unknown command.
    chroma_audio_scrub_begin: () => undefined,
    chroma_audio_scrub_update: () => undefined,
    chroma_audio_scrub_end: () => undefined,
    // D-198 — `EditorExportDialog`'s "Add to queue" -> `chroma_run_ffmpeg`
    // path, reachable from `TimelinePane`'s own toolbar. A real-looking
    // success/failure DTO — this harness never actually spawns ffmpeg, and
    // doesn't need to for a dialog/queue-state pointer-gesture check (queue
    // transitions are unit-tested for real in `exportQueueStore.test.ts`;
    // this is for SEEING the dialog/queue).
    chroma_run_ffmpeg: () => ({ ok: true, stdout_tail: '', stderr_tail: '' }),
    'plugin:dialog|save': () => '/tmp/harness-export.mp4',
  };
  (
    window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (cmd: string, args?: unknown) => Promise<unknown>;
        transformCallback: (callback: (payload: unknown) => void, once?: boolean) => number;
      };
    }
  ).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: unknown) => {
      const h = handlers[cmd];
      if (!h) {
        const msg = `harness: no invoke stub for "${cmd}"`;
        console.error(msg);
        throw new Error(msg);
      }
      return h(args);
    },
    // B-086 — backs `@tauri-apps/api/event`'s `transformCallback`, the
    // mechanism `listen()` uses to hand its handler a numeric id the
    // `plugin:event|listen` stub above registers against `eventListenerIds`.
    transformCallback: (callback) => {
      const id = nextCallbackId++;
      eventCallbacks.set(id, callback);
      return id;
    },
  };
}

/** The same 3-track fixture `TimelinePane.marquee.dom.test.tsx` (D-142) uses
 *  — kept in sync by hand for the same reason `installInvokeStub`'s handler
 *  list is: this file and that one live in different packages and can't
 *  share a fixture module without a new cross-package dependency neither
 *  needs for anything else. Reseed a different one from a CDP session via
 *  `window.__chromaHarness.seed(fixture)`. */
function defaultFixture(): Timeline {
  return {
    id: 'harness-tl',
    name: 'harness',
    rate: { num: 24, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [
          { id: 'a', name: 'A', source_path: '/a.mp4', source_start: 0, duration: 48, source_len: 480, start_frame: 0 },
          { id: 'b', name: 'B', source_path: '/b.mp4', source_start: 0, duration: 48, source_len: 480, start_frame: 240 },
        ],
      },
      {
        kind: 'video',
        clips: [{ id: 'c', name: 'C', source_path: '/c.mp4', source_start: 0, duration: 48, source_len: 480, start_frame: 24 }],
      },
      {
        kind: 'video',
        clips: [{ id: 'd', name: 'D', source_path: '/d.mp4', source_start: 0, duration: 48, source_len: 480, start_frame: 120 }],
      },
    ],
  };
}

/** Replace the CURRENT ACTIVE timeline's content — in both the fake backend
 *  (so `TimelineSwitcher`'s list/switch calls stay consistent with whatever
 *  was reseeded) and the store directly (so the change is visible with no
 *  round trip, same as before this file grew a fake backend at all). Does
 *  NOT touch `fakeProject.order`/`activeId` — reseeding the active timeline's
 *  content is orthogonal to which timeline is active or how many exist. */
function seed(timeline: Timeline): void {
  fakeProject.timelines.set(fakeProject.activeId, timeline);
  useEditorTimelineStore.setState({
    timeline,
    openProjectKey: HARNESS_PROJECT_KEY,
    status: 'ready',
    error: null,
    playhead: 0,
    playing: false,
    selection: [],
    selectedGap: null,
  });
}

/** D-199 — select clip `id` on `track` (`TransformOverlay`/`CanvasBoundary`
 *  only draw once something real is on screen to measure against; a fresh
 *  `seed()` clears selection). No-arg call clears the selection back out. */
function select(track?: number, id?: string): void {
  useEditorTimelineStore.setState({
    selection: track !== undefined && id !== undefined ? [{ track, id }] : [],
  });
}

let strict = true;
let mode: HarnessMode = ((): HarnessMode => {
  const raw = new URLSearchParams(window.location.search).get('mode');
  return raw === 'preview' || raw === 'inspector' || raw === 'library' ? raw : 'timeline';
})();
let root: ReturnType<typeof createRoot> | null = null;

function render(): void {
  const container = document.getElementById('root')!;
  if (!root) root = createRoot(container);
  // D-199 — `PreviewPane` renders inside a `flex-1` column with no
  // ambient height of its own (it expects a flex ancestor, exactly what
  // `EditorTab.tsx` gives it) — `#root` needs an explicit height for
  // `useContentBox`'s `ResizeObserver` math to have anything to measure.
  // B-124 — `'inspector'` needs the same thing `'preview'` does, and for a
  // sharper reason: the Inspector's own scroller is `flex-1 min-h-0
  // overflow-y-auto`, so it only CLIPS (and therefore only shows the bug)
  // inside an ancestor with a real bounded height. `EditorTab.tsx` gives it
  // exactly that — a fixed-width `ResizablePanel` of full height — and this
  // reproduces that box, at the Inspector's own default width, rather than
  // letting the panel grow to its content and hide the defect.
  container.style.height = mode === 'timeline' ? '' : '100vh';
  container.style.display = mode === 'timeline' ? '' : 'flex';
  container.style.width = mode === 'inspector' ? '320px' : '';
  // D-195, Task 3 — in 'timeline' mode, `TimelineSwitcher` renders above
  // `TimelinePane`, the same stacking `EditorTab.tsx` uses, so the tab
  // strip's real click-through behavior (switch/create) is exercised
  // against the same store the pane reads. 'preview' mode mounts
  // `PreviewPane` alone — the switcher isn't part of what that mode checks.
  // B-124 — the Inspector mounts inside the same `flex h-full flex-col
  // min-h-0` wrapper `EditorTab.tsx` wraps it in, so its scroller resolves
  // its height the same way it does in the real app.
  const el =
    mode === 'inspector'
      ? React.createElement(
          'div',
          { className: 'flex h-full w-full flex-col min-h-0 bg-surface' },
          React.createElement('div', { className: 'flex-1 min-h-0' }, React.createElement(EditorInspectorPanel)),
        )
      : mode === 'library'
        ? // D-263 — the shell's own left region, reproduced: the rail (fixed
          // width, its own) followed by the docked column at `Shell.tsx`'s
          // `SOURCES_PANEL_DEFAULT_WIDTH`. The real column is a
          // `ResizablePanel`; a fixed-width box is the same geometry at its
          // default size, without pulling the whole shell (and its Tauri
          // window chrome) into a page that has no Tauri behind it.
          React.createElement(
            'div',
            { className: 'flex h-full w-full min-h-0' },
            React.createElement(EditLibraryRail, {
              dockOpen: true,
              onDockOpenChange: () => {},
            }),
            React.createElement(
              'div',
              {
                className: 'h-full shrink-0 border-r border-border-color bg-surface overflow-hidden',
                style: { width: 288 },
              },
              React.createElement(EditLibraryPanel),
            ),
          )
        : mode === 'preview'
          ? React.createElement(PreviewPane)
          : React.createElement(React.Fragment, null, React.createElement(TimelineSwitcher), React.createElement(TimelinePane));
  root.render(strict ? React.createElement(React.StrictMode, null, el) : el);
  setStatus(`mounted mode=${mode} (strictMode=${strict}) — window.__chromaHarness`);
}

/** D-263 — paint the app's real theme variables onto this page.
 *
 *  Every `--color-*` token in `styles.css` is an alias for an `--app-*`
 *  variable that the real app sets at RUNTIME (`themes.ts`, applied when a
 *  theme is chosen), so a harness page that never applies one renders every
 *  panel in unstyled black-on-white — which was fine while this file only
 *  measured rects, and is not fine for a screenshot anyone looks at. Applies
 *  the same default theme the app boots with, from the same table, so the
 *  colours here are the app's own rather than a second definition. */
function applyDefaultTheme(): void {
  const theme = THEMES.find((t) => t.id === DEFAULT_THEME_ID) ?? THEMES[0];
  for (const [name, value] of Object.entries(theme.cssVariables as Record<string, string>)) {
    document.documentElement.style.setProperty(name, value);
  }
  document.body.style.background = 'var(--color-bg-primary)';
}

applyDefaultTheme();
installInvokeStub();
seed(defaultFixture());
// D-195, Task 3 — `TimelineSwitcher` fetches its own tab list via `loadList()`
// on mount, against `fakeProject` rather than the `seed()` call above alone.
// `setOpenProject(<key>)` is the same real signal `app/src/Root.tsx` sends on a
// real project open (B-083/D-203 — the project's identity, not a boolean). It
// is deliberately a **no-op here**: `seed()` has already put the store in the
// open state with real content, so the pane paints on the very first render
// with no async round trip, and this call only pins the invariant that the
// harness leaves the store in exactly the shape the real app's bridge would.
// (Switch the harness to a second fake project one day and this is the call
// that would do the real work.)
useEditorTimelineStore.getState().setOpenProject(HARNESS_PROJECT_KEY);
render();

// CDP-reachable control surface — see this file's own header for the
// `evaluate_script` recipe. Kept intentionally small: this is a mount +
// fixture + StrictMode toggle point, not a second copy of
// `testUtils/pointerHarness.ts`'s event-dispatch helpers (those construct
// plain `PointerEvent`s with no dependency on this page at all — replicate
// the same `new PointerEvent(...)` calls directly in `evaluate_script`).
(window as unknown as { __chromaHarness: unknown }).__chromaHarness = {
  seed,
  select,
  defaultFixture,
  setMode(next: HarnessMode) {
    mode = next;
    render();
  },
  get mode() {
    return mode;
  },
  /** B-124 — drive the clip Inspector's Video/Audio tab through the SAME
   *  store action `debug_set_inspector_tab` and the tab button's own click
   *  both call. Deliberately the store action and not a synthesised click,
   *  for the reason `debugOps.ts` gives: a simulated click proves the
   *  simulation works, a store action proves the app does. */
  setInspectorTab(next: ClipInspectorTab) {
    useEditorTimelineStore.getState().setInspectorTab(next);
  },
  tab(): ClipInspectorTab {
    return useEditorTimelineStore.getState().inspectorTab;
  },
  /** D-263 — switch which library the docked column shows, through the SAME
   *  store action the rail's own button calls, for the same reason
   *  `setInspectorTab` above is a store action rather than a click. */
  setLibraryMode(next: EditLibraryMode) {
    useEditorTimelineStore.getState().setLibraryMode(next);
  },
  libraryMode(): EditLibraryMode {
    return useEditorTimelineStore.getState().libraryMode;
  },
  get settings() {
    return { ...harnessSettings };
  },
  /** D-204 — give one source its own natural footprint (see
   *  `harnessClipNatural`). Pass `null` to drop back to `DEFAULT_NATURAL`. */
  setClipNatural(sourcePath: string, natural: { naturalWidth: number; naturalHeight: number } | null) {
    if (natural) harnessClipNatural.set(sourcePath, natural);
    else harnessClipNatural.delete(sourcePath);
  },
  get timeline() {
    return useEditorTimelineStore.getState().timeline;
  },
  get selection() {
    return useEditorTimelineStore.getState().selection;
  },
  get timelines() {
    return useEditorTimelineStore.getState().timelines;
  },
  /** D-195, Task 3 — the raw fake-backend state (every timeline's own full
   *  content + which id is active), for a CDP session to assert against
   *  directly rather than only through what the store currently has loaded —
   *  e.g. confirming an inactive timeline's clips are untouched after
   *  editing a different, active one. */
  get project() {
    return { activeId: fakeProject.activeId, order: [...fakeProject.order], timelines: Object.fromEntries(fakeProject.timelines) };
  },
  /** D-195, Task 3 — apply a real `EditOp` to the CURRENTLY ACTIVE timeline
   *  via the real store action (`useEditorTimelineStore.getState().applyOp`),
   *  for a CDP session to build up real content on a freshly `createTimeline`
   *  timeline (this harness mounts no Sources panel/drag source of its own)
   *  and then verify it persists independently across a timeline switch. */
  applyOp(op: EditOp) {
    useEditorTimelineStore.getState().applyOp(op);
  },
  /** D-195, Task 3 — the whole store hook, for a CDP session to call any
   *  action directly (`createTimeline`, `setActiveTimeline`, `_flushSave`,
   *  etc.) without this file growing a bespoke wrapper for every one. */
  store: useEditorTimelineStore,
  setStrictMode(next: boolean) {
    strict = next;
    render();
  },
  reset() {
    fakeProject = makeFakeProject();
    seed(fakeProject.timelines.get(fakeProject.activeId)!);
  },
};
