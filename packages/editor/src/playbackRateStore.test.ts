/**
 * D-280 — the Edit tab's half of the playback-rate feature: the store slice and
 * the MCP surface, which must be the SAME state the human's transport control
 * writes (CLAUDE.md's human-AND-AI rule).
 *
 * The model itself — bounds, presets, formatting — is tested next to the
 * transport that renders it, in `@apelles/player`'s `playbackRate.test.ts`.
 * What this file covers is what only the tab can get wrong: the clamp on the
 * way in, the reset on a project switch, and above all that setting a PLAYBACK
 * rate never touches the project the way `editor_set_clip_speed` (D-236)
 * deliberately does.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PLAYBACK_RATE,
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
} from '@apelles/player';

vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => null }));

const { useEditorTimelineStore } = await import('./timelineStore');

beforeEach(() => {
  useEditorTimelineStore.setState({ playbackRate: DEFAULT_PLAYBACK_RATE });
});

describe('the playbackRate store slice', () => {
  it('starts at ordinary playback', () => {
    expect(useEditorTimelineStore.getState().playbackRate).toBe(DEFAULT_PLAYBACK_RATE);
  });

  it('stores a rate the transport asked for', () => {
    useEditorTimelineStore.getState().setPlaybackRate(3);
    expect(useEditorTimelineStore.getState().playbackRate).toBe(3);
  });

  it('clamps on the way in, so no surface can leave an impossible rate behind', () => {
    const { setPlaybackRate } = useEditorTimelineStore.getState();

    setPlaybackRate(99);
    expect(useEditorTimelineStore.getState().playbackRate).toBe(MAX_PLAYBACK_RATE);

    setPlaybackRate(0.001);
    expect(useEditorTimelineStore.getState().playbackRate).toBe(MIN_PLAYBACK_RATE);

    setPlaybackRate(Number.NaN);
    expect(useEditorTimelineStore.getState().playbackRate).toBe(DEFAULT_PLAYBACK_RATE);
  });

  /**
   * The invariant the whole feature rests on, and the one the roadmap entry
   * called out by name: this is TRANSPORT state. Setting it must not touch the
   * timeline and must not bump the persisted-version clock — i.e. it can never
   * reach a save, an undo entry, or an export. Contrast `editor_set_clip_speed`
   * (D-236), which does all three on purpose.
   */
  it('never touches the project — no timeline change, no save, no undo entry', () => {
    const before = useEditorTimelineStore.getState();
    const timelineBefore = before.timeline;
    const savedBefore = before.savedVersion;

    before.setPlaybackRate(4);

    const after = useEditorTimelineStore.getState();
    expect(after.playbackRate).toBe(4);
    expect(after.timeline).toBe(timelineBefore);
    expect(after.savedVersion).toBe(savedBefore);
  });

  it('returns to ordinary playback when a different project is opened', () => {
    // A shuttle rate is set to skim ONE take; carrying 4x into the next project
    // the user opens, with no memory of having asked for it, is the surprise
    // this resets away. (Deliberately unlike `previewView`, which is a viewing
    // preference and survives.)
    useEditorTimelineStore.getState().setOpenProject('project-a');
    useEditorTimelineStore.getState().setPlaybackRate(4);
    useEditorTimelineStore.getState().setOpenProject('project-b');
    expect(useEditorTimelineStore.getState().playbackRate).toBe(DEFAULT_PLAYBACK_RATE);
  });
});
