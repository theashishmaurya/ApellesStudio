// @vitest-environment jsdom
/**
 * @apelles/player — D-432 P5's viewer layout on real DOM: the header (caller
 * slots, format line, centred title, zoom, view toggles), the transport row
 * (playhead timecode left, centred buttons, rate / volume / fullscreen right)
 * and the 3 px scrub bar, which still seeks, reports a drag as one
 * start/end gesture, and steps from the keyboard.
 *
 * jsdom has no layout, so "left / centred / right" is asserted as which of the
 * row's three grid cells a control sits in, not as pixels;
 * `app/harness.html?mode=edit` is the visual check.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { Player } from './Player';

afterEach(cleanup);

function player(props: Partial<ComponentProps<typeof Player>> = {}) {
  return (
    <Player
      surface={<div data-testid="surface" />}
      frame={36}
      total={240}
      fps={24}
      playing={false}
      onPlayPause={() => {}}
      onStep={() => {}}
      {...props}
    />
  );
}

/** The three cells of a three-column grid row, as elements. */
function cells(row: Element): Element[] {
  return [...row.children];
}

describe('the viewer header', () => {
  it('holds the caller slots, the format line, the centred title and the view controls', () => {
    const { container } = render(
      player({
        title: 'Five Levels v3',
        formatLabel: '3840×2160 · 24p',
        headerStart: <button type="button" aria-label="Show the browser" />,
        headerEnd: <button type="button" aria-label="Inspector" />,
        zoom: 1,
        onZoomIn: () => {},
        viewControls: <button type="button" aria-label="Safe areas" />,
        onWaveformToggle: () => {},
      }),
    );
    const header = container.querySelector('[data-player-header]')!;
    const [left, centre, right] = cells(header);
    expect(left.querySelector('[aria-label="Show the browser"]')).not.toBeNull();
    expect(left.querySelector('[data-player-format]')!.textContent).toBe('3840×2160 · 24p');
    expect(centre.textContent).toBe('Five Levels v3');
    expect(right.querySelector('[aria-label="Zoom in"]')).not.toBeNull();
    expect(right.textContent).toContain('Fit');
    expect(right.querySelector('[aria-label="Safe areas"]')).not.toBeNull();
    expect(right.querySelector('[aria-label="Show the audio waveform"]')).not.toBeNull();
    // The Inspector toggle is the header's last control.
    const buttons = right.querySelectorAll('button');
    expect(buttons[buttons.length - 1].getAttribute('aria-label')).toBe('Inspector');
  });

  it('shows a zoom percentage off fit, as a button back to fit', () => {
    const onZoomReset = vi.fn();
    render(player({ zoom: 1.5, onZoomIn: () => {}, onZoomOut: () => {}, onZoomReset }));
    const reset = screen.getByLabelText('Reset zoom to fit');
    expect(reset.textContent).toBe('150%');
    fireEvent.click(reset);
    expect(onZoomReset).toHaveBeenCalledOnce();
  });

  it('is not drawn when nothing would go in it', () => {
    const { container } = render(player());
    expect(container.querySelector('[data-player-header]')).toBeNull();
  });
});

describe('the transport row', () => {
  it('puts the full playhead timecode left, the buttons centred, the rest right', () => {
    const { container } = render(
      player({
        onSkipStart: () => {},
        onSkipEnd: () => {},
        skipLabels: { start: 'Previous edit point', end: 'Next edit point' },
        rate: 1,
        onRateChange: () => {},
        onMuteToggle: () => {},
        onFullscreen: () => {},
      }),
    );
    const [left, centre, right] = cells(container.querySelector('[data-player-transport]')!);
    expect(left.textContent).toBe('00:00:01:12');
    expect(left.className).toContain('text-playhead');
    const centred = [...centre.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    expect(centred).toEqual(['Previous edit point', 'Step back one frame', 'Play', 'Step forward one frame', 'Next edit point']);
    const rest = [...right.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    expect(rest).toEqual(['Playback rate', 'Mute', 'Fullscreen']);
  });

  it('volume is a popover (B-354): mute, a keyboard slider and the level, the same callbacks', () => {
    const onVolumeChange = vi.fn();
    const onMuteToggle = vi.fn();
    const { container } = render(player({ volume: 0.5, muted: false, onVolumeChange, onMuteToggle }));
    const right = cells(container.querySelector('[data-player-transport]')!)[2];
    // At rest the transport shows one button and no slider (no hover slide-out).
    expect(right.querySelector('input[type="range"]')).toBeNull();
    fireEvent.click(screen.getByLabelText('Volume'));
    const pop = document.querySelector('[data-chroma-volume-popover]')!;
    expect(pop).not.toBeNull();
    expect(pop.textContent).toContain('50%');
    const slider = pop.querySelector('input[aria-label="Volume level"]') as HTMLInputElement;
    expect(slider.getAttribute('aria-valuetext')).toBe('50%');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onVolumeChange).toHaveBeenCalledWith(0.51);
    fireEvent.click(pop.querySelector('button[aria-label="Mute"]')!);
    expect(onMuteToggle).toHaveBeenCalledOnce();
  });

  it('wires each button', () => {
    const onStep = vi.fn();
    const onPlayPause = vi.fn();
    const onSkipStart = vi.fn();
    const onSkipEnd = vi.fn();
    render(player({ onStep, onPlayPause, onSkipStart, onSkipEnd }));
    fireEvent.click(screen.getByLabelText('Skip to start'));
    fireEvent.click(screen.getByLabelText('Step back one frame'));
    fireEvent.click(screen.getByLabelText('Play'));
    fireEvent.click(screen.getByLabelText('Step forward one frame'));
    fireEvent.click(screen.getByLabelText('Skip to end'));
    expect(onSkipStart).toHaveBeenCalledOnce();
    expect(onStep.mock.calls).toEqual([[-1], [1]]);
    expect(onPlayPause).toHaveBeenCalledOnce();
    expect(onSkipEnd).toHaveBeenCalledOnce();
  });

  it('shows Pause while playing', () => {
    render(player({ playing: true }));
    expect(screen.getByLabelText('Pause')).toBeTruthy();
  });
});

describe('the 3 px scrub bar', () => {
  function bar(container: HTMLElement) {
    return container.querySelector<HTMLElement>('[data-slot="scrub-bar"]')!;
  }

  it('is a 3 px track inside a 12 px hit area, filled with the playhead colour', () => {
    const { container } = render(player({ onSeek: () => {} }));
    const root = bar(container);
    expect(root.querySelector('[data-slot="scrub-bar-track"]')!.className).toContain('h-[3px]');
    expect(root.firstElementChild!.className).toContain('h-3');
    expect(root.querySelector('[data-slot="scrub-bar-range"]')!.className).toContain('bg-playhead');
  });

  it('seeks from the keyboard as one short gesture per key (start, seek, end)', () => {
    const events: string[] = [];
    const { container } = render(
      player({
        onSeek: (f) => events.push(`seek ${f}`),
        onSeekStart: (f) => events.push(`start ${f}`),
        onSeekEnd: () => events.push('end'),
      }),
    );
    const slider = bar(container).querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(slider.getAttribute('aria-valuenow')).toBe('36');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    expect(events[0]).toBe('start 37');
    expect(events).toContain('seek 37');
    expect(events[events.length - 1]).toBe('end');
  });

  it('takes ten frames with Shift and jumps to the ends with Home / End', () => {
    const seeks: number[] = [];
    const { container } = render(player({ onSeek: (f) => seeks.push(f) }));
    const slider = bar(container).querySelector<HTMLInputElement>('input[type="range"]')!;
    fireEvent.keyDown(slider, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(slider, { key: 'End' });
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(seeks).toEqual([46, 240, 0]);
  });

  it('drags with the pointer: press anywhere in the hit area, move, release — one gesture', () => {
    const events: string[] = [];
    const { container } = render(
      player({
        onSeek: (f) => events.push(`seek ${f}`),
        onSeekStart: (f) => events.push(`start ${f}`),
        onSeekEnd: () => events.push('end'),
      }),
    );
    const control = bar(container).firstElementChild as HTMLElement;
    // jsdom has no layout: give the 12 px control a real 240 px box at x 0.
    const rect = { x: 0, y: 0, left: 0, top: 0, width: 240, height: 12, right: 240, bottom: 12, toJSON: () => ({}) };
    control.getBoundingClientRect = () => rect as DOMRect;
    for (const el of control.querySelectorAll<HTMLElement>('*')) el.getBoundingClientRect = () => rect as DOMRect;
    control.setPointerCapture = () => {};
    control.releasePointerCapture = () => {};
    control.hasPointerCapture = () => true;
    const at = (type: string, x: number) =>
      fireEvent(
        type.startsWith('pointerup') ? document : control,
        new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 6, button: 0, buttons: 1, pointerId: 1, isPrimary: true, pointerType: 'mouse' }),
      );
    at('pointerdown', 120);
    at('pointermove', 180);
    at('pointerup', 180);
    expect(events[0]).toMatch(/^start /);
    const seeks = events.filter((e) => e.startsWith('seek')).map((e) => Number(e.split(' ')[1]));
    expect(seeks.length).toBeGreaterThan(0);
    expect(seeks[0]).toBe(120);
    expect(seeks).toContain(180);
    expect(events[events.length - 1]).toBe('end');
    expect(events.filter((e) => e.startsWith('start'))).toHaveLength(1);
  });

  it('ends a drag that is still running when the player unmounts', () => {
    const onSeekEnd = vi.fn();
    const { container, unmount } = render(player({ onSeek: () => {}, onSeekEnd }));
    const slider = bar(container).querySelector<HTMLInputElement>('input[type="range"]')!;
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    unmount();
    expect(onSeekEnd).toHaveBeenCalledOnce();
  });

  it('is disabled with nothing to seek through', () => {
    const { container } = render(player({ onSeek: () => {}, total: 0 }));
    expect(bar(container).hasAttribute('data-disabled')).toBe(true);
  });
});
