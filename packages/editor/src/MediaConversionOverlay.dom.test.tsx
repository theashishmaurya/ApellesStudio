// @vitest-environment jsdom
/**
 * @apelles/editor — D-453: the Sources tile and the preview say a source is
 * still converting, with its percentage and a Cancel, rather than drawing
 * black. Mounted and clicked, because the property is the wiring: a Cancel
 * that reaches nothing, or a notice that renders for a ready source, would
 * pass any test of the data alone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';

import { mount, type MountedComponent } from './testUtils/pointerHarness';

const invokeMock = vi.hoisted(() => vi.fn(async () => null));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }));

const { MediaConversionOverlay } = await import('./MediaConversionOverlay');
const { PreviewConversionNotice } = await import('./PreviewConversionNotice');

let mounted: MountedComponent | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  invokeMock.mockClear();
});

function click(el: Element | null) {
  expect(el).not.toBeNull();
  act(() => {
    (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('MediaConversionOverlay', () => {
  it('shows the percentage and a bar while converting, and Cancel calls back', () => {
    const onCancel = vi.fn();
    const onConvertAgain = vi.fn();
    mounted = mount(
      <MediaConversionOverlay
        conversion={{ state: 'converting', progress: 0.427 }}
        name="talk.mkv"
        onCancel={onCancel}
        onConvertAgain={onConvertAgain}
      />,
    );
    const root = mounted.container.querySelector('[data-chroma-tile-conversion="converting"]');
    expect(root?.textContent).toContain('Converting 42%');
    expect(mounted.container.querySelector('[role="progressbar"]')).not.toBeNull();
    click(mounted.container.querySelector('button[aria-label="Cancel converting talk.mkv"]'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConvertAgain).not.toHaveBeenCalled();
  });

  it('offers to convert again once failed or cancelled, and draws nothing when ready', () => {
    const onConvertAgain = vi.fn();
    mounted = mount(
      <MediaConversionOverlay
        conversion={{ state: 'failed', progress: 0, error: 'the hardware HEVC encoder refused it' }}
        name="talk.mkv"
        onCancel={() => undefined}
        onConvertAgain={onConvertAgain}
      />,
    );
    const root = mounted.container.querySelector('[data-chroma-tile-conversion="failed"]');
    expect(root?.textContent).toContain('Failed');
    expect(root?.getAttribute('title')).toContain('hardware HEVC encoder');
    click(mounted.container.querySelector('button[aria-label="Convert talk.mkv again"]'));
    expect(onConvertAgain).toHaveBeenCalledTimes(1);
    mounted.unmount();
    mounted = mount(
      <MediaConversionOverlay
        conversion={{ state: 'ready', progress: 1 }}
        name="talk.mkv"
        onCancel={() => undefined}
        onConvertAgain={() => undefined}
      />,
    );
    expect(mounted.container.querySelector('[data-chroma-tile-conversion]')).toBeNull();
  });
});

describe('PreviewConversionNotice', () => {
  it('names the file and its progress, and its Cancel is the pool’s one cancel command', () => {
    mounted = mount(
      <PreviewConversionNotice
        pending={[
          {
            mediaId: 'id-talk',
            name: 'talk.mkv',
            sourcePath: '/m/talk.mkv',
            conversion: { state: 'converting', progress: 0.5 },
          },
        ]}
      />,
    );
    const row = mounted.container.querySelector('[data-chroma-conversion-notice="converting"]');
    expect(row?.textContent).toContain('Converting talk.mkv for playback — 50%');
    const cancel = [...mounted.container.querySelectorAll('button')].find((b) => b.textContent?.includes('Cancel'));
    click(cancel ?? null);
    expect(invokeMock).toHaveBeenCalledWith('chroma_media_cancel_conversion', { ids: ['id-talk'] });
  });

  it('offers a cancelled source a way to convert again (a re-probe)', () => {
    mounted = mount(
      <PreviewConversionNotice
        pending={[
          {
            mediaId: 'id-talk',
            name: 'talk.mkv',
            sourcePath: '/m/talk.mkv',
            conversion: { state: 'cancelled', progress: 0 },
          },
        ]}
      />,
    );
    expect(mounted.container.textContent).toContain('talk.mkv was not converted');
    const again = [...mounted.container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Convert again'),
    );
    click(again ?? null);
    expect(invokeMock).toHaveBeenCalledWith('chroma_media_reprobe', { ids: ['id-talk'] });
  });
});
