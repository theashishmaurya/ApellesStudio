/**
 * D-453 — which sources under the playhead the preview must say are still
 * converting, instead of drawing black.
 */
import { describe, expect, it } from 'vitest';
import type { MediaItem } from '@apelles/bridge';

import { conversionsAt, conversionsKey } from './conversionNotice';
import type { Timeline } from './timeline';

function clip(id: string, path: string, start: number, len: number) {
  return { id, name: id, source_path: path, source_start: 0, duration: len, source_len: 1000, source_fps: 24, start_frame: start };
}

const tl = {
  id: 't',
  name: 'T',
  rate: { num: 24, den: 1 },
  tracks: [
    { kind: 'video', clips: [clip('title', '/m/a.mov', 0, 48)] },
    { kind: 'video', clips: [clip('talk', '/m/talk.mkv', 0, 48), clip('b-roll', '/m/b.webm', 48, 24)] },
    { kind: 'video', hidden: true, clips: [clip('hidden', '/m/c.mkv', 0, 72)] },
    { kind: 'audio', clips: [clip('vo', '/m/vo.webm', 0, 72)] },
  ],
} as unknown as Timeline;

function item(id: string, path: string, conversion: MediaItem['conversion']): MediaItem {
  return { id, sourcePath: path, name: path.split('/').pop() ?? id, added: '', offline: false, conversion };
}

describe('conversionsAt', () => {
  const pool = [
    item('a', '/m/a.mov', null),
    item('talk', '/m/talk.mkv', { state: 'converting', progress: 0.42 }),
    item('b', '/m/b.webm', { state: 'ready', progress: 1 }),
    item('c', '/m/c.mkv', { state: 'queued', progress: 0 }),
    item('vo', '/m/vo.webm', { state: 'queued', progress: 0 }),
  ];

  it('names the converting source on a visible video track at the playhead', () => {
    const got = conversionsAt(tl, 10, pool);
    expect(got).toEqual([
      { mediaId: 'talk', name: 'talk.mkv', sourcePath: '/m/talk.mkv', conversion: { state: 'converting', progress: 0.42 } },
    ]);
  });

  it('ignores a ready source, a hidden track and an audio track', () => {
    // At 50 the video track shows b.webm (ready); the hidden track's c.mkv and
    // the audio track's vo.webm are never drawn, so they do not block the picture.
    expect(conversionsAt(tl, 50, pool)).toEqual([]);
  });

  it('is empty without a timeline, or when nothing in the pool awaits a conversion', () => {
    expect(conversionsAt(null, 10, pool)).toEqual([]);
    expect(conversionsAt(tl, 10, [item('a', '/m/a.mov', null)])).toEqual([]);
  });

  it('keys only on what would be shown, to the whole percent', () => {
    const a = conversionsKey(conversionsAt(tl, 10, pool));
    const b = conversionsKey(conversionsAt(tl, 11, pool));
    expect(a).toBe(b);
    const later = pool.map((p) => (p.id === 'talk' ? { ...p, conversion: { state: 'converting' as const, progress: 0.427 } } : p));
    expect(conversionsKey(conversionsAt(tl, 10, later))).toBe(a);
    const next = pool.map((p) => (p.id === 'talk' ? { ...p, conversion: { state: 'converting' as const, progress: 0.43 } } : p));
    expect(conversionsKey(conversionsAt(tl, 10, next))).not.toBe(a);
    expect(conversionsKey([])).toBe('');
  });
});
