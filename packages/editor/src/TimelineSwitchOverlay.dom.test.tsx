// @vitest-environment jsdom
/**
 * B-369 — a timeline switch shows the branded loader once it has taken longer
 * than SWITCH_LOADER_DELAY_MS, and never for a fast switch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

import { SWITCH_LOADER_DELAY_MS, TimelineSwitchOverlay } from './TimelineSwitchOverlay';
import { useEditorTimelineStore } from './timelineStore';

beforeEach(() => {
  vi.useFakeTimers();
  useEditorTimelineStore.setState({ switchingTimeline: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('TimelineSwitchOverlay (B-369)', () => {
  it('a slow switch shows the loader with the timeline name, and it goes when the switch ends', () => {
    render(<TimelineSwitchOverlay />);
    act(() => useEditorTimelineStore.setState({ switchingTimeline: 'Short 2' }));
    expect(screen.queryByTestId('timeline-switch-overlay')).toBeNull();
    act(() => vi.advanceTimersByTime(SWITCH_LOADER_DELAY_MS + 1));
    expect(screen.getByTestId('timeline-switch-overlay').textContent).toContain('Opening Short 2…');
    act(() => useEditorTimelineStore.setState({ switchingTimeline: null }));
    expect(screen.queryByTestId('timeline-switch-overlay')).toBeNull();
  });

  it('a fast switch never flashes it', () => {
    render(<TimelineSwitchOverlay />);
    act(() => useEditorTimelineStore.setState({ switchingTimeline: 'Short 2' }));
    act(() => vi.advanceTimersByTime(SWITCH_LOADER_DELAY_MS - 50));
    act(() => useEditorTimelineStore.setState({ switchingTimeline: null }));
    act(() => vi.advanceTimersByTime(SWITCH_LOADER_DELAY_MS));
    expect(screen.queryByTestId('timeline-switch-overlay')).toBeNull();
  });
});
