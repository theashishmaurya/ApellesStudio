// @vitest-environment jsdom
/**
 * @apelles/editor — the designed empty states (D-432 §4.13, v0.3.0): a
 * timeline with no tracks draws placeholder V1 / A1 lanes and one line with the
 * injected Import action (no dashed box); tracks without clips show the line
 * over the lanes; the Inspector's message carries a glyph; no project open is
 * the restyled message. Phosphor glyphs only, no hand-drawn SVG.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, render } from '@testing-library/react';

import {
  actSync,
  createInvokeStub,
  installPointerCaptureStub,
  installResizeObserverStub,
  mount,
  stubOffsetMetrics,
  waitFrames,
  type MountedComponent,
} from './testUtils/pointerHarness';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_clip_thumbnails: () => [],
    chroma_audio_waveform: () => [],
    chroma_timeline_set: () => undefined,
  }),
}));

import { InspectorEmptyState } from '@apelles/inspector';
import { NoProjectState, TIMELINE_EMPTY_LINE, TimelineEmptyState } from './EditEmptyStates';
import { useEditorTimelineStore } from './timelineStore';
import { TimelinePane } from './TimelinePane';
import type { Timeline } from './timeline';

let ui: MountedComponent | null = null;
let restore: Array<() => void> = [];

afterEach(() => {
  ui?.unmount();
  ui = null;
  for (const r of restore) r();
  restore = [];
  cleanup();
  actSync(() => useEditorTimelineStore.setState({ timeline: null, openProjectKey: null, status: 'idle' }));
});

async function mountPane(tracks: Timeline['tracks']) {
  restore = [stubOffsetMetrics(1200, 600), installResizeObserverStub(), installPointerCaptureStub()];
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: { id: 'e', name: 'e', rate: { num: 24, den: 1 }, tracks } as unknown as Timeline,
      openProjectKey: '/p.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      selection: [],
      selectedGap: null,
    }),
  );
  ui = mount(
    React.createElement(TimelinePane, {
      emptyAction: React.createElement('button', { 'data-testid': 'import' }, 'Import'),
    }),
  );
  await waitFrames(2);
}

describe('empty states (§4.13)', () => {
  it('a timeline with no tracks: placeholder V1 / A1 lanes and the line with the Import action, no dashed box', async () => {
    await mountPane([]);
    const root = document.querySelector('[data-chroma-empty-state="timeline"]') as HTMLElement;
    expect(root).toBeTruthy();
    expect(root.textContent).toContain('V1');
    expect(root.textContent).toContain('A1');
    expect(root.textContent).toContain(TIMELINE_EMPTY_LINE);
    expect(root.querySelector('[data-testid="import"]')).toBeTruthy();
    expect(document.querySelector('.border-dashed')).toBeNull();
    expect(root.querySelector('.bg-lane-alt')).toBeTruthy();
  });

  it('tracks with no clips: the line over the lanes, passing clicks through', async () => {
    await mountPane([
      { kind: 'video', clips: [] },
      { kind: 'audio', clips: [] },
    ] as unknown as Timeline['tracks']);
    const hint = document.querySelector('[data-chroma-empty-state="no-clips"]') as HTMLElement;
    expect(hint).toBeTruthy();
    expect(hint.className).toContain('pointer-events-none');
    expect(hint.textContent).toContain(TIMELINE_EMPTY_LINE);
  });

  it('a timeline with clips shows no hint', async () => {
    await mountPane([
      {
        kind: 'video',
        clips: [{ id: 'v', name: 'V', source_path: '/v.mp4', source_start: 0, duration: 24, source_len: 24, start_frame: 0 }],
      },
    ] as unknown as Timeline['tracks']);
    expect(document.querySelector('[data-chroma-empty-state="no-clips"]')).toBeNull();
  });

  it('the placeholder lanes reflect a drag over them', () => {
    const { container, rerender } = render(<TimelineEmptyState dragOver={false} />);
    const root = () => container.querySelector('[data-chroma-empty-state="timeline"]') as HTMLElement;
    expect(root().className).not.toContain('ring-accent');
    rerender(<TimelineEmptyState dragOver />);
    expect(root().className).toContain('ring-accent');
  });

  it('the Inspector message carries its glyph; no project open is the restyled message', () => {
    const { container } = render(
      <>
        <InspectorEmptyState icon={<svg data-testid="glyph" />}>Select one clip.</InspectorEmptyState>
        <NoProjectState />
      </>,
    );
    const insp = container.querySelector('[data-chroma-empty-state="inspector"]') as HTMLElement;
    expect(insp.querySelector('[data-testid="glyph"]')).toBeTruthy();
    expect(insp.className).toContain('text-xs');
    const none = container.querySelector('[data-chroma-empty-state="no-project"]') as HTMLElement;
    expect(none.querySelector('h1')?.textContent).toBe('No project open');
    expect(none.querySelector('svg')).toBeTruthy();
  });
});
