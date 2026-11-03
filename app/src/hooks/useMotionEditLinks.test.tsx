// @vitest-environment jsdom
/**
 * useMotionEditLinks (B-371) — an Edit change that leaves every Motion link as
 * it was must not re-render the component holding the links (in the app that
 * component is `Root`, and a render of it re-renders the whole `Shell`). A
 * change that does move a link must still reach it.
 *
 * Real stores, a real React root: the assertion is a render COUNT, which is
 * exactly what the bug was.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useMediaPoolStore } from '@apelles/bridge';
import { useEditorTimelineStore, type Timeline } from '@apelles/editor';
import type { MotionEditLinks } from '@apelles/motion';

import { useMotionEditLinks } from './useMotionEditLinks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RENDER = '/p/motion/renders/intro.mp4';

function timeline(talkDuration: number, withScene: boolean): Timeline {
  const talk = { id: 'c2', name: 'talk', source_path: '/p/talk.mov', source_start: 0, duration: talkDuration, start_frame: 0 };
  const scene = { id: 'c1', name: 'intro', media_id: 'm1', source_path: RENDER, source_start: 0, duration: 50, start_frame: 300 };
  return {
    id: 't',
    name: 't',
    rate: { num: 30, den: 1 },
    tracks: [{ kind: 'video', clips: withScene ? [talk, scene] : [talk] }],
  } as Timeline;
}

const seen: { renders: number; links: MotionEditLinks | null } = { renders: 0, links: null };

function Probe(): null {
  seen.renders += 1;
  seen.links = useMotionEditLinks('/p');
  return null;
}

let root: Root | null = null;

beforeEach(() => {
  seen.renders = 0;
  seen.links = null;
  useMediaPoolStore.setState({ items: [{ id: 'm1', sourcePath: RENDER, motionSceneId: 'intro' }] as never });
  useEditorTimelineStore.setState({ timeline: timeline(100, true) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(React.createElement(Probe)));
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe('useMotionEditLinks (B-371)', () => {
  it('reports where a scene render sits on the timeline', () => {
    expect(seen.links?.intro?.clips.map((c) => c.clipId)).toEqual(['c1']);
  });

  it('does not re-render on an edit that leaves the links alone (a trim of an unrelated clip)', () => {
    const before = seen.renders;
    const links = seen.links;
    act(() => useEditorTimelineStore.setState({ timeline: timeline(80, true) }));
    act(() => useEditorTimelineStore.setState({ timeline: timeline(60, true) }));
    expect(seen.renders).toBe(before);
    expect(seen.links).toBe(links);
  });

  it('re-renders with the new links when the scene clip is removed', () => {
    const before = seen.renders;
    act(() => useEditorTimelineStore.setState({ timeline: timeline(100, false) }));
    expect(seen.renders).toBeGreaterThan(before);
    expect(seen.links?.intro?.clips).toEqual([]);
  });
});
