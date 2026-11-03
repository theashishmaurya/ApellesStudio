/**
 * @apelles/editor — the clip Inspector's tab model (D-246).
 *
 * The DOM half lives in `ClipInspectorPanel.tabs.dom.test.tsx`; this file
 * pins the pure decisions underneath it, which are the ones that would
 * silently mis-file a whole section if they ever changed: which tabs a clip
 * type has at all, and how a remembered tab resolves against a clip that does
 * not have it.
 */
import { describe, expect, it } from 'vitest';

import {
  CLIP_INSPECTOR_TABS,
  CLIP_INSPECTOR_TAB_LABELS,
  DEFAULT_CLIP_INSPECTOR_TAB,
  clipInspectorTabs,
  parseClipInspectorTab,
  resolveClipInspectorTab,
} from './clipInspectorTabs';
import { DEFAULT_TEXT_FONT, type Clip } from './timeline';

function mediaClip(): Clip {
  return {
    id: 'clip-1',
    name: 'shot.mp4',
    source_path: '/media/shot.mp4',
    source_start: 0,
    duration: 240,
    source_len: 240,
    source_fps: 24,
    start_frame: 0,
  } as unknown as Clip;
}

function textClip(): Clip {
  return {
    ...mediaClip(),
    id: 'title-1',
    name: 'AFTER',
    source_path: '',
    text: { content: 'AFTER', font: DEFAULT_TEXT_FONT, size: 0.12, color: '#FFFFFF' },
  } as unknown as Clip;
}

describe('which tabs a clip has (D-246)', () => {
  it('a media clip has all four — picture, sound, a retime and its facts (v0.3.0)', () => {
    expect(clipInspectorTabs(mediaClip())).toEqual(['video', 'audio', 'speed', 'info']);
  });

  it('a title has Video and Info: no audio stream, and no footage to retime', () => {
    // The same predicate the Audio and EQ sections used to carry individually
    // (`!clip.text`), stated once here so the tab and the sections it holds
    // can never disagree about whether a clip has audio.
    expect(clipInspectorTabs(textClip())).toEqual(['video', 'info']);
  });

  it('an adjustment clip keeps Video and Audio, matching what its sections still render, but has no Speed', () => {
    const adjustment = { ...mediaClip(), adjustment: { exposure: 0.2 } } as unknown as Clip;
    expect(clipInspectorTabs(adjustment)).toEqual(['video', 'audio', 'info']);
  });

  it('a linked picture whose audio half is gone has no Audio tab (B-334)', () => {
    expect(clipInspectorTabs(mediaClip(), null)).toEqual(['video', 'speed', 'info']);
  });

  it('every tab has a label — a tab that renders its own id would be a bug', () => {
    for (const id of CLIP_INSPECTOR_TABS) {
      expect(CLIP_INSPECTOR_TAB_LABELS[id]).toBeTruthy();
      expect(CLIP_INSPECTOR_TAB_LABELS[id]).not.toBe(id);
    }
  });
});

describe('resolving the remembered tab against the selected clip', () => {
  it('shows the remembered tab when the clip has it', () => {
    expect(resolveClipInspectorTab('audio', ['video', 'audio'])).toBe('audio');
    expect(resolveClipInspectorTab('video', ['video', 'audio'])).toBe('video');
  });

  it('falls back to the first available tab when it does not', () => {
    // Selecting a title while the Audio tab is open must not render an empty
    // panel — and must not write, so the choice survives (see the DOM test's
    // stickiness case, which is the user-visible half of this).
    expect(resolveClipInspectorTab('audio', ['video'])).toBe('video');
  });

  it('never returns something the caller cannot render, even given nothing', () => {
    expect(resolveClipInspectorTab('audio', [])).toBe(DEFAULT_CLIP_INSPECTOR_TAB);
  });
});

describe('parsing a tab id off an untyped op argument', () => {
  it('accepts the real ids, case- and whitespace-insensitively', () => {
    expect(parseClipInspectorTab('audio')).toBe('audio');
    expect(parseClipInspectorTab(' Video ')).toBe('video');
  });

  it('refuses anything else rather than silently doing nothing (D-216)', () => {
    for (const bad of ['audi', 'effects', '', 1, null, undefined, {}]) {
      expect(parseClipInspectorTab(bad)).toBeNull();
    }
  });
});
