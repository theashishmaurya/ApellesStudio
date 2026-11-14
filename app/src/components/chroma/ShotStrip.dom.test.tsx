// @vitest-environment jsdom
/**
 * ShotStrip's thumbnail fetch on real DOM — B-399's swallowed failure.
 *
 * Why it exists: a still's thumbnail spun forever in the Colorist's shot strip
 * and the reason was nowhere. Two faults, one on each side; this file pins the
 * FRONTEND one. The fetch ended in a bare `.catch(() => {})`, so whatever the
 * backend said was discarded, and a tile with no thumbnail renders a spinner —
 * indefinitely, silently. That exact shape (`.catch(() => [])` hiding a real
 * codec failure in the Edit tab's filmstrip) had already been diagnosed and
 * removed once, by D-121/B-037, and was written again here. A third time is
 * what a test is for.
 *
 * What it does NOT do: cover the Rust half of B-399 (the still branch in
 * `chroma_session_thumbnail`). That branch sits inside a `#[tauri::command]`
 * reading the process-global session, so a unit test would have to mutate
 * global state other tests share — see this file's note in `docs/BUGS.md`
 * under B-399. The primitive it routes to is tested
 * (`apelles_media::still::thumbnail_is_a_height_bounded_jpeg_data_url`), and
 * the sibling routing it was missing from is pinned by
 * `chroma::load::decode_shot_picture`'s tests.
 *
 * Same jsdom pragma + `@testing-library/react` pattern as
 * `AgentActivityDock.dom.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

const invoked = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: unknown }[],
  reply: null as null | ((cmd: string) => unknown),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: unknown) => {
    invoked.calls.push({ cmd, args });
    const out = invoked.reply?.(cmd);
    return out instanceof Promise ? out : Promise.resolve(out);
  },
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: () => Promise.resolve(null),
}));

vi.mock('react-toastify', () => ({
  toast: { error: () => {}, success: () => {} },
}));

import { useSessionStore, type SessionShot } from '../../store/useSessionStore';
import ShotStrip from './ShotStrip';

const SESSION_INITIAL = useSessionStore.getState();

function shot(id: string, name: string): SessionShot {
  return {
    id,
    path: `/footage/${name}`,
    clipId: id,
    name,
    width: 1920,
    height: 1080,
    fps: 25,
    frameCount: 75,
    durationSecs: 3,
    frame: 0,
    codec: 'mjpeg',
    colorSpace: '',
  };
}

beforeEach(() => {
  invoked.calls.length = 0;
  invoked.reply = null;
  useSessionStore.setState({
    ...SESSION_INITIAL,
    shots: [shot('c1', 'alexander-mosaic-6000.jpg')],
    offlineShots: [],
    activeIndex: 0,
    grades: {},
    busy: false,
    projectName: 'Launch film',
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ShotStrip thumbnails (B-399)', () => {
  it('reports a failed thumbnail instead of swallowing it — the tile is a spinner either way', async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    invoked.reply = (cmd) =>
      cmd === 'chroma_session_thumbnail'
        ? Promise.reject(new Error('still thumbnail task for alexander-mosaic-6000.jpg: no video stream'))
        : undefined;

    render(<ShotStrip />);

    await waitFor(() => {
      expect(logged.length).toBeGreaterThan(0);
    });
    const message = logged.flat().map(String).join(' ');
    // The clip it happened to, and what the backend actually said — the two
    // facts the bare `.catch` threw away.
    expect(message).toContain('alexander-mosaic-6000.jpg');
    expect(message).toContain('no video stream');
  });

  it('does not log when the thumbnail arrives', async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    invoked.reply = (cmd) =>
      cmd === 'chroma_session_thumbnail' ? 'data:image/jpeg;base64,/9j/4AAQ' : undefined;

    render(<ShotStrip />);

    await waitFor(() => {
      expect(invoked.calls.some((c) => c.cmd === 'chroma_session_thumbnail')).toBe(true);
    });
    expect(logged).toEqual([]);
  });

  it('asks the backend once per shot, at the strip height', async () => {
    invoked.reply = (cmd) =>
      cmd === 'chroma_session_thumbnail' ? 'data:image/jpeg;base64,/9j/4AAQ' : undefined;

    render(<ShotStrip />);

    await waitFor(() => {
      expect(invoked.calls.filter((c) => c.cmd === 'chroma_session_thumbnail')).toHaveLength(1);
    });
    expect(invoked.calls[0].args).toEqual({ index: 0, height: 96 });
  });
});
