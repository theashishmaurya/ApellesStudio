// @vitest-environment jsdom
/**
 * @apelles/editor — real-DOM coverage for D-208's per-property keyframing:
 * the Inspector's per-row diamond / `<`-`>` nav / reset.
 *
 * **Why a DOM test and not more unit tests.** `clipKeyframes.test.ts` already
 * proves the pure helpers, and `chroma::keyframes`'s own Rust tests prove the
 * resolver. Neither proves the thing the owner actually asked for and the
 * thing that would silently break: that turning ON one property's keyframing,
 * moving the playhead, and typing a new value produces a key for THAT
 * property alone, leaving every other property's keyframe state untouched —
 * end to end through the real `EditorInspectorPanel`, the real
 * `ClipInspectorPanel` rows, and the real `timelineStore.applyOp`. That
 * sequence spans three modules and a store, so it can only be asserted here.
 *
 * **Tier and its honest limits.** jsdom, the real React components and the
 * real store, a stubbed Tauri `invoke`. It proves the AUTHORING contract —
 * what ends up in `Clip.chroma_keyframes` — and deliberately proves nothing
 * about rendered pixels: that the live preview then animates each property
 * independently is `chroma::edit::composite_tests::
 * each_param_interpolates_across_only_its_own_keyframes`'s job (B-094), and
 * that the export does is `timelineExport.test.ts`'s.
 *
 * **D-223 extends the same coverage to the per-clip AUDIO rows** (`volume`/
 * `pan`), which share every one of those components and now the same
 * `paramStates` record — with the one thing that differs asserted directly:
 * a static edit routes through the `set_clip_audio` op, not
 * `set_clip_transform`, so a volume nudge cannot restate (or reset) a clip's
 * geometry. Same authoring-contract scope: what the mixer and the exporter
 * then DO with those keys is `apelles-media`'s and
 * `timelineExport.ffmpeg.test.ts`'s.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';

import {
  actSync,
  installResizeObserverStub,
  mount,
  waitFrames,
  type MountedComponent,
} from './testUtils/pointerHarness';

/** `applyOp` persists on a debounce and `useClipGeometry` probes on mount;
 *  neither result matters here (the assertions read the store's own
 *  optimistic timeline, which is also what the panel renders), but both must
 *  resolve rather than reject or the effect logs a real error. */
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    if (cmd === 'chroma_timeline_set') return null;
    if (cmd === 'chroma_timeline_clip_geometry') {
      return { compWidth: 1920, compHeight: 1080, naturalWidth: 1, naturalHeight: 1 };
    }
    return null;
  },
}));

const { useEditorTimelineStore } = await import('./timelineStore');
const { EditorInspectorPanel } = await import('./EditorInspectorPanel');
import type { Clip, Timeline } from './timeline';

const CLIP_ID = 'clip-1';

/** One 24fps video track holding one un-keyframed, un-transformed clip
 *  starting at timeline frame 0 — so a timeline frame IS the clip's own
 *  source frame and the assertions can talk about plain numbers. */
function fixture(): Timeline {
  const clip: Clip = {
    id: CLIP_ID,
    name: 'shot.mp4',
    source_path: '/media/shot.mp4',
    source_start: 0,
    duration: 240,
    source_len: 240,
    source_fps: 24,
    start_frame: 0,
  };
  return { id: 'tl', name: 'Timeline', rate: 24, tracks: [{ kind: 'video', clips: [clip] }] } as unknown as Timeline;
}

function currentClip(): Clip {
  const tl = useEditorTimelineStore.getState().timeline;
  if (!tl) throw new Error('no timeline');
  return tl.tracks[0].clips[0];
}

function keys(): Array<{ frame: number; params: Record<string, unknown> }> {
  return currentClip().chroma_keyframes ?? [];
}

/** Which properties have a keyframe of their own, per the same
 *  `hasOwnProperty` test every renderer uses. */
function animatedParams(): string[] {
  const names = new Set<string>();
  for (const k of keys()) for (const n of Object.keys(k.params)) names.add(n);
  return [...names].sort();
}

let mounted: MountedComponent | null = null;
let restoreResizeObserver: (() => void) | null = null;

beforeEach(() => {
  restoreResizeObserver = installResizeObserverStub();
  useEditorTimelineStore.setState({
    timeline: fixture(),
    status: 'ready',
    error: null,
    playhead: 0,
    playing: false,
    selection: [{ track: 0, id: CLIP_ID }],
    selectedGap: null,
    // D-246 — every test in this file starts on the Inspector's Video tab
    // (its default), so the transform/crop rows below are the ones on screen.
    // The audio block at the bottom switches to Audio for itself.
    inspectorTab: 'video',
  });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  restoreResizeObserver?.();
  restoreResizeObserver = null;
});

/** A button by its `aria-label` — the same accessible name a real user's
 *  screen reader (and a real click) would find. */
function button(label: string): HTMLButtonElement {
  const el = mounted?.container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!el) throw new Error(`no button labelled "${label}"`);
  return el;
}

/** The number field on the row whose visible label is `label`. */
function field(label: string): HTMLInputElement {
  const spans = [...(mounted?.container.querySelectorAll('span') ?? [])];
  const span = spans.find((s) => s.textContent === label);
  const input = span?.parentElement?.querySelector('input');
  if (!input) throw new Error(`no field labelled "${label}"`);
  return input as HTMLInputElement;
}

function click(el: HTMLElement) {
  actSync(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

/** Type `value` into a controlled React number input. Setting `.value`
 *  directly bypasses React's value tracker, so the native setter is used and
 *  a bubbling `input` event fired — React's own documented interop path, and
 *  the only one that works without a testing-library dependency this package
 *  does not have. */
function type(input: HTMLInputElement, value: number) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  actSync(() => {
    setter?.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function render() {
  mounted = mount(React.createElement(EditorInspectorPanel), { strictMode: true });
  await waitFrames(2);
}

describe('per-property keyframing (D-208)', () => {
  it('the diamond starts hollow for every property on an un-keyframed clip', async () => {
    await render();
    for (const label of ['Opacity', 'Position X', 'Position Y', 'Scale', 'Rotation', 'Left', 'Top']) {
      expect(button(`Toggle ${label} keyframes`).getAttribute('aria-pressed')).toBe('false');
    }
    expect(keys()).toEqual([]);
  });

  /** The owner's own verification script, exactly. */
  it('keyframing Scale, moving the playhead and editing Scale keys ONLY Scale', async () => {
    await render();

    // 1. Turn on keyframing for Scale alone.
    click(button('Toggle Scale keyframes'));
    await waitFrames(1);

    // One key, at the playhead, holding Scale's CURRENT value — so nothing
    // visually jumps (a single key holds flat everywhere in both renderers).
    expect(keys()).toEqual([{ frame: 0, params: { scale: 1 } }]);
    expect(animatedParams()).toEqual(['scale']);
    expect(button('Toggle Scale keyframes').getAttribute('aria-pressed')).toBe('true');
    // …and no other property became animated as a side effect.
    for (const label of ['Opacity', 'Position X', 'Position Y', 'Rotation', 'Left']) {
      expect(button(`Toggle ${label} keyframes`).getAttribute('aria-pressed')).toBe('false');
    }

    // 2. Move the playhead, 3. change Scale's value.
    actSync(() => useEditorTimelineStore.getState().setPlayhead(60));
    await waitFrames(1);
    type(field('Scale'), 1.8);
    await waitFrames(1);

    // A NEW key at frame 60 — and it names `scale` and nothing else, which is
    // the entire point: `resolve_clip_transform`/`keyframeExprAt` both read
    // per-param, so a key naming only `scale` leaves every other property
    // static (B-094/D-208).
    expect(keys()).toEqual([
      { frame: 0, params: { scale: 1 } },
      { frame: 60, params: { scale: 1.8 } },
    ]);
    expect(animatedParams()).toEqual(['scale']);
    // The clip's own static transform fields are untouched — the edit landed
    // on the keyframe, not on them.
    expect(currentClip().opacity).toBeUndefined();
    expect(currentClip().position_x).toBeUndefined();
  });

  it('a second property keyframes independently, without disturbing the first', async () => {
    await render();
    click(button('Toggle Scale keyframes'));
    await waitFrames(1);
    actSync(() => useEditorTimelineStore.getState().setPlayhead(60));
    await waitFrames(1);
    type(field('Scale'), 2);
    await waitFrames(1);

    // Opacity's diamond, at frame 60, where Scale already has a key: the two
    // must SHARE that key entry (merge), not replace each other.
    click(button('Toggle Opacity keyframes'));
    await waitFrames(1);

    expect(keys()).toEqual([
      { frame: 0, params: { scale: 1 } },
      { frame: 60, params: { scale: 2, opacity: 1 } },
    ]);
    expect(animatedParams()).toEqual(['opacity', 'scale']);
  });

  it('the field shows the INTERPOLATED value at the playhead, not the static one', async () => {
    await render();
    click(button('Toggle Scale keyframes'));
    await waitFrames(1);
    actSync(() => useEditorTimelineStore.getState().setPlayhead(100));
    await waitFrames(1);
    type(field('Scale'), 3);
    await waitFrames(1);

    // Halfway between the frame-0 key (1) and the frame-100 key (3).
    actSync(() => useEditorTimelineStore.getState().setPlayhead(50));
    await waitFrames(1);
    expect(field('Scale').value).toBe('2');
  });

  it('turning keyframing off removes only that property\'s keys and holds its current value', async () => {
    await render();
    click(button('Toggle Scale keyframes'));
    await waitFrames(1);
    actSync(() => useEditorTimelineStore.getState().setPlayhead(100));
    await waitFrames(1);
    type(field('Scale'), 3);
    await waitFrames(1);
    click(button('Toggle Opacity keyframes'));
    await waitFrames(1);

    // Off, at frame 50, where Scale interpolates to 2.
    actSync(() => useEditorTimelineStore.getState().setPlayhead(50));
    await waitFrames(1);
    click(button('Toggle Scale keyframes'));
    await waitFrames(1);

    expect(animatedParams()).toEqual(['opacity']);
    // The value it had on screen is baked into the static field — no snap
    // back to the stale 1 (After Effects' stopwatch-off semantics).
    expect(currentClip().scale).toBe(2);
    expect(field('Scale').value).toBe('2');
  });
});

describe('per-property keyframe navigation (D-208)', () => {
  it('the `<`/`>` buttons are disabled until that property has a key in that direction', async () => {
    await render();
    expect(button('Previous Scale keyframe').disabled).toBe(true);
    expect(button('Next Scale keyframe').disabled).toBe(true);

    click(button('Toggle Scale keyframes'));
    await waitFrames(1);
    actSync(() => useEditorTimelineStore.getState().setPlayhead(60));
    await waitFrames(1);
    type(field('Scale'), 2);
    await waitFrames(1);

    // At frame 60 (on Scale's later key): one behind, none ahead.
    expect(button('Previous Scale keyframe').disabled).toBe(false);
    expect(button('Next Scale keyframe').disabled).toBe(true);
    // Rotation was never keyed — its own nav stays dead either way.
    expect(button('Previous Rotation keyframe').disabled).toBe(true);
    expect(button('Next Rotation keyframe').disabled).toBe(true);
  });

  it('the diamond distinguishes "keyed right here" from "animated, but between keys"', async () => {
    await render();
    click(button('Toggle Scale keyframes'));
    await waitFrames(1);
    actSync(() => useEditorTimelineStore.getState().setPlayhead(60));
    await waitFrames(1);
    type(field('Scale'), 2);
    await waitFrames(1);

    // On a key.
    expect(button('Toggle Scale keyframes').title).toContain('keyframed at the playhead');
    // Between the frame-0 and frame-60 keys.
    actSync(() => useEditorTimelineStore.getState().setPlayhead(30));
    await waitFrames(1);
    expect(button('Toggle Scale keyframes').title).toContain('no keyframe at the playhead');
  });

  it('walks the playhead over that property\'s OWN keys, skipping another property\'s', async () => {
    await render();
    click(button('Toggle Scale keyframes'));
    await waitFrames(1);
    // A key for Opacity alone, at frame 30, between Scale's two.
    actSync(() => useEditorTimelineStore.getState().setPlayhead(30));
    await waitFrames(1);
    click(button('Toggle Opacity keyframes'));
    await waitFrames(1);
    actSync(() => useEditorTimelineStore.getState().setPlayhead(60));
    await waitFrames(1);
    type(field('Scale'), 2);
    await waitFrames(1);

    // From frame 60, Scale's previous key is frame 0 — NOT frame 30, which
    // belongs to Opacity.
    click(button('Previous Scale keyframe'));
    await waitFrames(1);
    expect(useEditorTimelineStore.getState().playhead).toBe(0);

    click(button('Next Scale keyframe'));
    await waitFrames(1);
    expect(useEditorTimelineStore.getState().playhead).toBe(60);
  });
});

describe('per-property reset (D-208)', () => {
  it('reverts only its own field, leaving every other one alone', async () => {
    await render();
    type(field('Opacity'), 0.4);
    await waitFrames(1);
    type(field('Rotation'), 30);
    await waitFrames(1);
    expect(currentClip().opacity).toBe(0.4);
    expect(currentClip().rotation).toBe(30);

    click(button('Reset Opacity'));
    await waitFrames(1);

    expect(currentClip().opacity).toBe(1);
    expect(currentClip().rotation).toBe(30);
  });

  it('resets each field to the documented default, including the crop insets', async () => {
    await render();
    type(field('Scale'), 2.5);
    await waitFrames(1);
    type(field('Left'), 0.3);
    await waitFrames(1);

    click(button('Reset Scale'));
    await waitFrames(1);
    click(button('Reset Left'));
    await waitFrames(1);

    expect(currentClip().scale).toBe(1);
    expect(currentClip().crop_left).toBe(0);
  });

  it('keys the default at the playhead for an ANIMATED property, rather than silently doing nothing', async () => {
    await render();
    click(button('Toggle Scale keyframes'));
    await waitFrames(1);
    actSync(() => useEditorTimelineStore.getState().setPlayhead(60));
    await waitFrames(1);
    type(field('Scale'), 2);
    await waitFrames(1);
    expect(field('Scale').value).toBe('2');

    click(button('Reset Scale'));
    await waitFrames(1);

    // The animation survives (reset is not a destructive "delete my keys"),
    // and the value at the playhead really is the default now.
    expect(animatedParams()).toEqual(['scale']);
    expect(field('Scale').value).toBe('1');
    expect(keys()).toEqual([
      { frame: 0, params: { scale: 1 } },
      { frame: 60, params: { scale: 1 } },
    ]);
  });
});

describe('the whole-clip Keyframes section (D-208 — kept, and now merging)', () => {
  it('"Key all properties" lights up every diamond at once', async () => {
    await render();
    const keyAll = [...(mounted?.container.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.includes('Key all properties'),
    );
    if (!keyAll) throw new Error('no "Key all properties" button');
    click(keyAll);
    await waitFrames(1);

    expect(animatedParams()).toEqual([
      'crop_bottom',
      'crop_left',
      'crop_right',
      'crop_top',
      'opacity',
      'position_x',
      'position_y',
      'rotation',
      'scale',
    ]);
    for (const label of ['Opacity', 'Position X', 'Scale', 'Rotation', 'Left', 'Bottom']) {
      expect(button(`Toggle ${label} keyframes`).getAttribute('aria-pressed')).toBe('true');
    }
  });

  /** The destructive case the pre-D-208 wholesale upsert had: a single
   *  property's key at this frame must survive "Key all properties", with its
   *  own value, not be replaced by the static one. */
  it('MERGES into a key a single property already put at this frame', async () => {
    await render();
    click(button('Toggle Scale keyframes'));
    await waitFrames(1);
    type(field('Scale'), 2.5);
    await waitFrames(1);
    expect(keys()).toEqual([{ frame: 0, params: { scale: 2.5 } }]);

    const keyAll = [...(mounted?.container.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.includes('Key all properties'),
    );
    click(keyAll as HTMLElement);
    await waitFrames(1);

    expect(keys()).toHaveLength(1);
    expect(keys()[0].params.scale).toBe(2.5);
    expect(keys()[0].params.opacity).toBe(1);
  });
});

describe('per-clip audio rows (D-223)', () => {
  // D-246 — Volume and Pan moved onto the Inspector's Audio tab, which is
  // where a user now finds them; the store field is the same one the tab
  // button writes (see `ClipInspectorPanel.tabs.dom.test.tsx` for the click
  // path itself). The rows' own behaviour below is unchanged by that move,
  // which is exactly what these assertions still prove.
  beforeEach(() => {
    useEditorTimelineStore.setState({ inspectorTab: 'audio' });
  });

  it('renders a Volume and a Pan row, at unity and centre, both un-keyframed', async () => {
    await render();
    expect(field('Volume').value).toBe('1');
    expect(field('Pan').value).toBe('0');
    expect(button('Toggle Volume keyframes').getAttribute('aria-pressed')).toBe('false');
    expect(button('Toggle Pan keyframes').getAttribute('aria-pressed')).toBe('false');
  });

  it('typing a Volume writes the clip’s OWN volume — not the track gain, not a transform', async () => {
    await render();
    type(field('Volume'), 0.5);
    await waitFrames(1);

    expect(currentClip().volume).toBe(0.5);
    // The track's own fader is untouched — the two are independent stages that
    // multiply, which is the whole reason this field exists (D-223).
    const tl = useEditorTimelineStore.getState().timeline;
    expect(tl?.tracks[0].gain).toBeUndefined();
    // …and nothing about the clip's geometry moved.
    expect(currentClip().opacity).toBeUndefined();
    expect(currentClip().scale).toBeUndefined();
  });

  it('a pan past hard left is clamped on the way into the model, not stored raw', async () => {
    await render();
    type(field('Pan'), -3);
    await waitFrames(1);
    expect(currentClip().pan).toBe(-1);
  });

  it('the reset button puts Volume back to unity', async () => {
    await render();
    type(field('Volume'), 0.2);
    await waitFrames(1);
    click(button('Reset Volume'));
    await waitFrames(1);
    expect(currentClip().volume).toBe(1);
  });

  it('the diamond keys `volume` by that exact name — the name both renderers read', async () => {
    await render();
    click(button('Toggle Volume keyframes'));
    await waitFrames(1);
    // Keyed at its CURRENT value, so turning animation on changes no sample —
    // the same guarantee every transform property's diamond gives.
    expect(keys()).toEqual([{ frame: 0, params: { volume: 1 } }]);

    actSync(() => useEditorTimelineStore.getState().setPlayhead(60));
    await waitFrames(1);
    type(field('Volume'), 0.25);
    await waitFrames(1);

    // A real automation ramp: two keys, naming `volume` alone. `volume` is the
    // name `chroma::audio::level_for_clip` (live) and `clipAudioParam`
    // (export) both look for, so a typo here would silently animate nothing.
    expect(keys()).toEqual([
      { frame: 0, params: { volume: 1 } },
      { frame: 60, params: { volume: 0.25 } },
    ]);
    expect(animatedParams()).toEqual(['volume']);
    // The static field is deliberately NOT rewritten while animated — the key
    // is what the mixer reads.
    expect(currentClip().volume).toBeUndefined();
  });

  it('"Key all properties" deliberately does NOT key volume/pan', async () => {
    await render();
    click(button('Toggle Volume keyframes')); // one real audio key first
    await waitFrames(1);
    const before = keys();
    expect(before).toEqual([{ frame: 0, params: { volume: 1 } }]);

    // D-246 — the whole-clip Keyframes section is on the VIDEO tab (it keys
    // transform and crop; see `clipInspectorTabs.ts`), so this gesture is a
    // real cross-tab one: key the volume on Audio, then batch-key the geometry
    // on Video. That the two do not interfere is exactly what this asserts.
    actSync(() => {
      useEditorTimelineStore.setState({ inspectorTab: 'video' });
    });
    await waitFrames(1);
    const keyAll = [...(mounted?.container.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.includes('Key all properties'),
    );
    click(keyAll as HTMLElement);
    await waitFrames(1);

    // The batch merged the nine transform/crop properties into the SAME frame
    // entry and left the volume key it found there intact — but it added no
    // `pan`, because that button is about the clip's geometry (see
    // `doUpsertKeyframe`'s own comment).
    const params = keys()[0].params;
    expect(params.volume).toBe(1); // not clobbered
    expect('pan' in params).toBe(false);
    expect(params.scale).toBe(1);
  });
});
