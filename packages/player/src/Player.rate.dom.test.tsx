// @vitest-environment jsdom
/**
 * @apelles/player — the transport's playback-rate control, on real DOM (D-280).
 *
 * `playbackRate.test.ts` proves the model's arithmetic. What it cannot catch is
 * the wiring: a preset that renders but reports the wrong rate, a control that
 * appears when no caller asked for one, or a "read-only" readout that is
 * secretly a button. Those are only visible by mounting the bar and clicking
 * it, which is what this file does.
 *
 * The presets live behind a real Base UI popover, so every assertion that
 * reaches one opens it first — the same two clicks a human makes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { Player } from './Player';
import { formatPlaybackRate, PLAYBACK_RATE_PRESETS } from './playbackRate';

afterEach(cleanup);

/** Everything `Player` genuinely requires, with the rate bits left to callers. */
function transport(props: Partial<ComponentProps<typeof Player>> = {}) {
  return (
    <Player
      surface={<div data-testid="surface" />}
      frame={0}
      total={100}
      fps={24}
      playing={false}
      onPlayPause={() => {}}
      onStep={() => {}}
      {...props}
    />
  );
}

/** Open the rate popover and hand back its preset group. */
function openPresets(): HTMLElement {
  fireEvent.click(screen.getByLabelText('Playback rate'));
  return screen.getByRole('group', { name: 'Playback rate presets' });
}

describe('the playback-rate control', () => {
  it('is not rendered at all when the caller passes no rate', () => {
    render(transport());
    expect(screen.queryByLabelText('Playback rate')).toBeNull();
  });

  it('shows the current rate in the transport bar', () => {
    render(transport({ rate: 3, onRateChange: () => {} }));
    expect(screen.getByLabelText('Playback rate').textContent).toContain('3×');
  });

  it('renders a read-only readout — not a button — with no onRateChange', () => {
    render(transport({ rate: 2 }));
    const readout = screen.getByLabelText('Playback rate');
    expect(readout.tagName).toBe('SPAN');
    expect(readout.textContent).toContain('2×');
  });

  it('offers every preset, and reports the one that is clicked', () => {
    const onRateChange = vi.fn();
    render(transport({ rate: 1, onRateChange }));

    const presets = openPresets();
    for (const preset of PLAYBACK_RATE_PRESETS) {
      expect(within(presets).getByText(formatPlaybackRate(preset))).toBeTruthy();
    }

    fireEvent.click(within(presets).getByText('3×'));
    expect(onRateChange).toHaveBeenCalledTimes(1);
    expect(onRateChange).toHaveBeenCalledWith(3);
  });

  it('marks the active preset as pressed so the current rate is visible in the list', () => {
    render(transport({ rate: 2, onRateChange: () => {} }));

    const presets = openPresets();
    expect(within(presets).getByText('2×').getAttribute('aria-pressed')).toBe('true');
    expect(within(presets).getByText('4×').getAttribute('aria-pressed')).toBe('false');
  });

  it('offers a custom field seeded with the current rate, for anything not in the list', () => {
    render(transport({ rate: 2.5, onRateChange: () => {} }));

    openPresets();
    const custom = screen.getByLabelText('Custom playback rate') as HTMLInputElement;
    expect(Number(custom.value)).toBe(2.5);
  });

  it('reports a typed custom rate', () => {
    const onRateChange = vi.fn();
    render(transport({ rate: 1, onRateChange }));

    openPresets();
    const custom = screen.getByLabelText('Custom playback rate');
    fireEvent.change(custom, { target: { value: '1.75' } });
    expect(onRateChange).toHaveBeenCalledWith(1.75);
  });

  /**
   * The one thing a user could plausibly get wrong about this control — that it
   * is the Inspector's per-clip Speed field (D-236) — is answered in the
   * popover itself. Asserted because it is the whole reason that copy is there.
   */
  it('says in the popover that it changes nothing about the cut', () => {
    render(transport({ rate: 1, onRateChange: () => {} }));

    openPresets();
    expect(screen.getByText(/does not change any clip's speed or the export/i)).toBeTruthy();
  });

  it('leaves the rest of the transport alone — play/pause and stepping still work', () => {
    const onPlayPause = vi.fn();
    const onStep = vi.fn();
    render(transport({ rate: 4, onRateChange: () => {}, onPlayPause, onStep }));

    fireEvent.click(screen.getByLabelText('Play'));
    fireEvent.click(screen.getByLabelText('Step forward one frame'));
    expect(onPlayPause).toHaveBeenCalledTimes(1);
    expect(onStep).toHaveBeenCalledWith(1);
  });
});
