// @vitest-environment jsdom
/**
 * D-437 S7 (plan §2.9 item 6) — the filmstrip does not re-request or rebuild its
 * tiles when a clip's width changes inside the same request window (a trim, a
 * fraction of a zoom step): the `<img>` nodes are reused, only their geometry
 * changes. And B-353: a still image repeats its cached thumbnail across the strip
 * with no `chroma_clip_thumbnails` decode.
 *
 * jsdom: no layout, no image decode. What this proves is the number of backend
 * requests and the identity of the DOM nodes, not pixels.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import { actSync, mount, waitFrames, type MountedComponent } from './testUtils/pointerHarness';
import { useMediaPoolStore, type MediaItem } from '@apelles/bridge';
import { ClipBlock } from './ClipBlock';
import { Filmstrip, STILL_TILE_ASPECT, stillTileRange } from './Filmstrip';
import type { Clip } from './timeline';

let mounted: MountedComponent | null = null;
let sourceCounter = 0;

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (_cmd: string, args: { startSecs: number; durationSecs: number; stepSecs: number }) => {
    const rows = [];
    for (let t = args.startSecs, i = 0; t < args.startSecs + args.durationSecs; t += args.stepSecs, i++) {
      rows.push({ frame: i, secs: t, dataUrl: `data:image/jpeg;base64,T${i}` });
    }
    return rows;
  });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function mountStrip(width: number) {
  sourceCounter += 1;
  const host: { set: (w: number) => void } = { set: () => {} };
  function Host() {
    const [w, setW] = React.useState(width);
    host.set = setW;
    return <Filmstrip sourcePath={`/clip-${sourceCounter}.mov`} startSecs={0} durationSecs={8} width={w} height={25} />;
  }
  mounted = mount(<Host />, { strictMode: false });
  return { setWidth: (w: number) => actSync(() => host.set(w)) };
}
const imgs = () => Array.from(mounted!.container.querySelectorAll('img'));

describe('Filmstrip tiles survive a width change (D-437 S7)', () => {
  it('reuses the same <img> nodes and makes no new request for a trim-sized width change', async () => {
    const ui = mountStrip(700);
    await waitFrames(3);
    const before = imgs();
    expect(before.length).toBeGreaterThan(2);
    expect(invoke).toHaveBeenCalledTimes(1);
    // 700 -> 800 px over 8 s: the desired step (0.57 s -> 0.5 s) stays on the 0.5 s rung,
    // so the request window is unchanged.
    for (let w = 705; w <= 800; w += 5) ui.setWidth(w);
    await waitFrames(3);
    expect(invoke).toHaveBeenCalledTimes(1);
    const after = imgs();
    expect(after).toHaveLength(before.length);
    after.forEach((el, i) => expect(el).toBe(before[i])); // identity: no remount, no re-decode
  });

  it('gives each tile async decoding and an explicit size', async () => {
    mountStrip(700);
    await waitFrames(3);
    for (const el of imgs()) {
      expect(el.getAttribute('decoding')).toBe('async');
      expect(el.getAttribute('height')).toBe('25');
      expect(Number(el.getAttribute('width'))).toBeGreaterThan(0);
    }
  });
});

describe('B-353 - a still image repeats its cached thumbnail', () => {
  const STILL = '/pics/R08 Artificial Analysis.png';
  const THUMB = 'data:image/jpeg;base64,STILL';

  it('stillTileRange covers exactly the visible slice, capped', () => {
    expect(stillTileRange(0, 40, 0, 100)).toBeNull();
    expect(stillTileRange(400, 40, 0, 400)).toEqual({ first: 0, last: 9 });
    expect(stillTileRange(400, 40, 100, 210)).toEqual({ first: 2, last: 5 });
    expect(stillTileRange(400, 40, 500, 600)).toBeNull();
    expect(stillTileRange(1_000_000, 40, 0, 1_000_000)!.last).toBe(511);
  });

  it('draws the thumbnail across the whole strip, asks the backend for nothing', async () => {
    mounted = mount(<Filmstrip sourcePath={STILL} startSecs={0} durationSecs={5} width={400} height={25} still stillSrc={THUMB} />, {
      strictMode: false,
    });
    await waitFrames(3);
    const tiles = imgs();
    const tileW = 25 * STILL_TILE_ASPECT;
    expect(tiles).toHaveLength(Math.ceil(400 / tileW));
    expect(new Set(tiles.map((t) => t.getAttribute('src')))).toEqual(new Set([THUMB]));
    expect(invoke).not.toHaveBeenCalled();
  });

  it('draws nothing (and still decodes nothing) until the pool has a thumbnail', async () => {
    mounted = mount(<Filmstrip sourcePath={STILL} startSecs={0} durationSecs={5} width={400} height={25} still stillSrc={null} />, {
      strictMode: false,
    });
    await waitFrames(3);
    expect(imgs()).toHaveLength(0);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("ClipBlock feeds a still its pool item's thumbnail, and a video clip still uses the backend", async () => {
    const item = { id: 'm1', sourcePath: STILL, thumb: THUMB, offline: false } as unknown as MediaItem;
    useMediaPoolStore.setState({ items: [item] });
    const clip = {
      id: 's1',
      name: 'R08',
      source_path: STILL,
      source_start: 0,
      duration: 120,
      source_len: 120,
      start_frame: 0,
    } as unknown as Clip;
    mounted = mount(<ClipBlock clip={clip} kind="video" trackHeight={52} widthPx={400} fps={24} />, { strictMode: false });
    await waitFrames(3);
    expect(mounted.container.querySelectorAll('img[data-chroma-still-tile]').length).toBeGreaterThan(5);
    expect(invoke).not.toHaveBeenCalledWith('chroma_clip_thumbnails', expect.anything());
    expect(invoke).not.toHaveBeenCalledWith('chroma_audio_waveform', expect.anything()); // a still has no audio
    mounted.unmount();
    mounted = mount(
      <ClipBlock clip={{ ...clip, source_path: '/v/clip.mov' }} kind="video" trackHeight={52} widthPx={400} fps={24} />,
      { strictMode: false },
    );
    await waitFrames(3);
    expect(invoke).toHaveBeenCalledWith('chroma_clip_thumbnails', expect.objectContaining({ sourcePath: '/v/clip.mov' }));
    useMediaPoolStore.setState({ items: [] });
  });
});
