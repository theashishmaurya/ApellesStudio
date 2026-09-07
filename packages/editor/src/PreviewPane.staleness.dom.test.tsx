// @vitest-environment jsdom
/**
 * @chroma/editor — permanent real-DOM regression coverage for B-088: the live
 * preview must show a clip's CURRENT transform, not the one that happened to
 * be on disk before the edit.
 *
 * **Why this file exists, and why it models the backend the way it does.**
 * `chroma_timeline_frame` (the live-preview compositor, `chroma::edit`) does
 * not receive a timeline — it resolves the open project's **persisted**
 * manifest off disk (`chroma_project::timeline::resolve_timeline_and_settings`)
 * and composites from that. `timelineStore`'s `applyOp`, meanwhile, updates
 * `timeline` optimistically and persists it via `chroma_timeline_set` on a
 * 400 ms debounce. B-088 is the ordering bug between those two facts: the
 * refetch used to be keyed on the OPTIMISTIC `timeline` object, so every edit
 * fetched a frame ~400 ms BEFORE the state it was meant to show existed on
 * the backend, and nothing ever fetched again afterwards. The picture sat one
 * edit behind, permanently, while `TransformOverlay`'s box (computed from the
 * live store, never from the rendered frame) moved correctly — the exact
 * "the box moves but the clip doesn't" symptom B-088 was filed for.
 *
 * So the invoke stub below is not an arbitrary fake: it reproduces the ONE
 * property of the real backend this bug turns on — `chroma_timeline_frame`
 * renders the last thing `chroma_timeline_set` persisted, never the store's
 * in-memory timeline. The assertion is the user-visible outcome (what the
 * preview `<img>` actually ends up showing), not "some command was called".
 *
 * **Tier and its honest limits.** jsdom, not real Chromium and not the real
 * Rust compositor: this proves the FETCH ORDERING contract end to end through
 * the real `PreviewPane` + real `timelineStore`, and deliberately proves
 * nothing about the composited pixels themselves — those are covered by
 * `chroma::edit`'s own `composite_tests` (which B-088's investigation
 * re-confirmed correct, and which D-199 had already verified against real
 * decoded frames).
 */

import { describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  actSync,
  installObjectUrlStub,
  installResizeObserverStub,
  mount,
  waitFrames,
  waitMs,
  type MountedComponent,
  type ObjectUrlStub,
} from './testUtils/pointerHarness';

/**
 * The fake backend, in `vi.hoisted` so the `vi.mock` factory below may close
 * over it — vitest hoists `vi.mock` above every import, so a factory that
 * referenced ordinary module-scope bindings would be reaching into their
 * temporal dead zone. This is vitest's own documented way to share state
 * between a mock factory and the test body, and the test body genuinely
 * needs it: `persistedPositionY` IS the assertion.
 *
 * `createInvokeStub` (the harness's own helper) is deliberately not used
 * here — it maps a command to a canned answer, and the whole point of this
 * stub is that two commands share mutable state: what `chroma_timeline_set`
 * writes is what `chroma_timeline_frame` reads. That relationship is the
 * backend property B-088 turns on, so it has to be modelled, not stubbed
 * away.
 */
const backend = vi.hoisted(() => {
  /** The composition size `useCompositionSize` fetches — arbitrary, unused
   *  by the assertions here, but the stub must answer something rather than
   *  reject. */
  const COMP = { compWidth: 1080, compHeight: 1920, naturalWidth: 1, naturalHeight: 1 };
  const state = {
    /** The backend's persisted timeline, reduced to the one field this test
     *  is about: the `position_y` of the fixture's single clip.
     *  `chroma_timeline_set` writes it, `chroma_timeline_frame` renders it —
     *  exactly the real disk round trip. */
    persistedPositionY: 0,
    /** Every `pos` `chroma_timeline_frame` was asked for, in order — so a
     *  test can assert a refetch happened at all, separately from what it
     *  returned. */
    framesFetched: [] as number[],
    /** The frame payload for a given persisted state. A real backend returns
     *  the raw JPEG bytes of composited pixels (D-216); this returns bytes
     *  spelling out the persisted `position_y`, which is the same thing for
     *  this test's purpose: "does the picture on screen reflect the edit."
     *  `PreviewPane` wraps whatever comes back in a `Blob` object URL, so the
     *  test reads it back through `installObjectUrlStub`. */
    frameBytesFor: (positionY: number): ArrayBuffer =>
      new TextEncoder().encode(`POSITION_Y=${positionY}`).buffer as ArrayBuffer,
    reset(): void {
      state.persistedPositionY = 0;
      state.framesFetched.length = 0;
    },
    async invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
      switch (cmd) {
        case 'chroma_timeline_frame':
          state.framesFetched.push(Number(args?.pos ?? 0));
          return state.frameBytesFor(state.persistedPositionY);
        case 'chroma_timeline_set': {
          // The real command "stores whatever is sent verbatim" (its own
          // Rust doc). Mirror that: the sent timeline's clip transform
          // becomes the new persisted state.
          const tracks = (args?.timeline as { tracks?: { clips?: { position_y?: number }[] }[] } | undefined)?.tracks;
          state.persistedPositionY = tracks?.[0]?.clips?.[0]?.position_y ?? 0;
          return undefined;
        }
        case 'chroma_timeline_composition_size':
        case 'chroma_timeline_clip_geometry':
          return COMP;
        case 'chroma_audio_set_volume':
        case 'chroma_audio_play':
        case 'chroma_audio_stop':
          return undefined;
        default:
          throw new Error(`PreviewPane.staleness.dom.test: no invoke stub for "${cmd}"`);
      }
    },
  };
  return state;
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: backend.invoke }));

// B-086 — `useCompositionSize` (used by `PreviewPane`) now calls the real
// `@tauri-apps/api/event` `listen()`, which reaches for
// `window.__TAURI_INTERNALS__` outside jsdom's provided globals. This suite
// doesn't test that broadcast (see `useCompositionSize`'s own doc/live
// verification for that) — just needs it to not throw.
vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
}));

// Imported after the mock is declared (vi.mock is hoisted, so order does not
// actually matter — keeping it textually first documents the requirement).
import { useEditorTimelineStore } from './timelineStore';
import { PreviewPane } from './PreviewPane';
import type { Timeline } from './timeline';

const FPS = 24;
/** `timelineStore`'s own `SAVE_DEBOUNCE_MS`, plus real headroom for the
 *  promise turns the persist + refetch take after it fires. Stated here
 *  rather than imported because that constant is module-private — the same
 *  call `TimelinePane.marquee.dom.test.tsx` makes for `TimelinePane`'s own
 *  private layout constants. */
const PAST_SAVE_DEBOUNCE_MS = 400 + 250;

function buildFixture(): Timeline {
  return {
    id: 'b088-tl',
    name: 'b088',
    rate: { num: FPS, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [
          {
            id: 'a',
            name: 'A',
            source_path: '/a.mp4',
            source_start: 0,
            duration: 48,
            source_len: 480,
            start_frame: 0,
          },
        ],
      },
    ],
  };
}

/** The one op B-088 was reported against — reposition a clip vertically. */
function setPositionY(positionY: number): void {
  useEditorTimelineStore.getState().applyOp({
    kind: 'set_clip_transform',
    track: 0,
    clip: 0,
    opacity: 1,
    position_x: 0,
    position_y: positionY,
    scale: 1,
    box_width: null,
    box_height: null,
    rotation: 0,
    crop_left: 0,
    crop_top: 0,
    crop_right: 0,
    crop_bottom: 0,
  });
}

/** What the preview `<img>` is actually showing, as the bytes the backend
 *  handed over — resolved through the object-URL stub, since since D-216 the
 *  `src` itself is an opaque `blob:` URL rather than the payload inline. */
async function previewFrameContent(
  objectUrls: ObjectUrlStub,
  container: HTMLElement,
): Promise<string | null> {
  const src = container.querySelector('img')?.getAttribute('src');
  if (!src) return null;
  const blob = objectUrls.blobFor(src);
  if (!blob) throw new Error(`the preview <img> points at an unknown or revoked URL: ${src}`);
  return blob.text();
}

async function settle(ms: number): Promise<void> {
  await waitMs(ms);
  await waitFrames(2);
}

describe('B-088 — the live preview reflects a clip transform edit', () => {
  /** Seed the store with the fixture and mount the real `PreviewPane` over
   *  the fake backend, both freshly reset. Returns the mounted view plus its
   *  own teardown, so each test states only what it is actually about. */
  async function openPreview(): Promise<{
    view: MountedComponent;
    objectUrls: ObjectUrlStub;
    close: () => void;
  }> {
    const restoreResizeObserver = installResizeObserverStub();
    // D-216 — jsdom has no `URL.createObjectURL`, and `PreviewPane` now shows
    // every frame through one.
    const objectUrls = installObjectUrlStub();
    backend.reset();

    actSync(() => {
      useEditorTimelineStore.setState({
        timeline: buildFixture(),
        openProjectKey: 'test-project',
        status: 'ready',
        error: null,
        playhead: 0,
        playing: false,
        selection: [],
        selectedGap: null,
      });
    });

    const view = mount(React.createElement(PreviewPane));
    await settle(50);
    return {
      view,
      objectUrls,
      close: () => {
        view.unmount();
        objectUrls.restore();
        restoreResizeObserver();
      },
    };
  }

  it('repaints with the edited transform once the edit has actually been persisted', async () => {
    const { view, objectUrls, close } = await openPreview();
    try {
      // Baseline: the untouched clip, straight from the (empty) persisted state.
      expect(await previewFrameContent(objectUrls, view.container)).toBe('POSITION_Y=0');
      const framesBeforeEdit = backend.framesFetched.length;

      actSync(() => setPositionY(0.25));
      await settle(PAST_SAVE_DEBOUNCE_MS);

      // The regression itself. Pre-fix, the only refetch this edit triggered
      // fired on the OPTIMISTIC store update — ~400 ms before
      // `chroma_timeline_set` had written anything — so the preview kept
      // showing `position_y = 0`, forever, with no error of any kind.
      //
      // Note the middle assertion passing either way: a frame WAS always
      // fetched. "Did we refetch?" was never the right question, and a test
      // that only asked it would have shipped green over this bug — which is
      // exactly why the assertion that matters is the rendered `src`.
      expect(backend.persistedPositionY).toBe(0.25);
      expect(backend.framesFetched.length).toBeGreaterThan(framesBeforeEdit);
      expect(await previewFrameContent(objectUrls, view.container)).toBe('POSITION_Y=0.25');

      // D-216 — one object URL per displayed frame would be a real leak if
      // the previous one were not revoked. Only the frame on screen is live.
      expect(objectUrls.live()).toHaveLength(1);
    } finally {
      close();
    }
  });

  it('repaints again on a SECOND consecutive edit — the preview never lags one edit behind', async () => {
    const { view, objectUrls, close } = await openPreview();
    try {
      actSync(() => setPositionY(0.25));
      await settle(PAST_SAVE_DEBOUNCE_MS);
      expect(await previewFrameContent(objectUrls, view.container)).toBe('POSITION_Y=0.25');

      // Pre-fix, this second edit is what made the bug look like "the preview
      // is one edit behind" rather than "the preview is dead": the stale
      // fetch it triggered would finally have picked up edit #1.
      actSync(() => setPositionY(-0.4));
      await settle(PAST_SAVE_DEBOUNCE_MS);
      expect(await previewFrameContent(objectUrls, view.container)).toBe('POSITION_Y=-0.4');
    } finally {
      close();
    }
  });
});
