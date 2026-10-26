// @vitest-environment jsdom
/**
 * @apelles/editor — the Openverse audio ops (D-400): `editor_search_audio`,
 * `editor_import_audio`, `editor_get_credits`.
 *
 * Run through the real `chroma://request` dispatch path with a fake backend.
 * What matters here is the wiring the Rust crate's own tests cannot see: the
 * wire argument names reach the Tauri commands, an import goes download ->
 * media pool (the same `chroma_media_import` the Sources panel uses) -> optional
 * placement, and a refusal from Rust (an NC licence) comes back as the op's
 * error rather than being swallowed. No test here touches the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';

import { createInvokeStub, mount, waitFrames, type MountedComponent } from './testUtils/pointerHarness';

const backend = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> | undefined }[],
  refuse: null as string | null,
  imported: [] as Record<string, unknown>[],
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_audio_search: (args) => {
      backend.calls.push({ cmd: 'chroma_audio_search', args });
      if (backend.refuse) throw new Error(backend.refuse);
      return { total: 1, page: 1, pageCount: 1, hits: [{ id: 'abc-123', title: 'Rain' }], skipped: {} };
    },
    chroma_audio_download: (args) => {
      backend.calls.push({ cmd: 'chroma_audio_download', args });
      if (backend.refuse) throw new Error(backend.refuse);
      return {
        path: '/p/Demo.chroma/assets/audio/rain-abc12345.mp3',
        projectFile: 'assets/audio/rain-abc12345.mp3',
        title: 'Rain',
        creator: 'Ada',
        license: 'by',
        durationSecs: 12,
        credit: '"Rain" by Ada — CC BY 4.0',
        downloaded: true,
      };
    },
    chroma_audio_credits: (args) => {
      backend.calls.push({ cmd: 'chroma_audio_credits', args });
      return { count: 1, text: 'Audio credits\n"Rain" by Ada', entries: [], ledger: 'assets/audio/CREDITS.json' };
    },
    chroma_media_import: (args) => {
      backend.calls.push({ cmd: 'chroma_media_import', args });
      const paths = (args?.paths ?? []) as string[];
      backend.imported = paths.map((p) => ({
        id: 'm-rain',
        sourcePath: p,
        name: 'rain-abc12345.mp3',
        added: '2026-10-26T00:00:00Z',
        offline: false,
        folder: null,
        video: { width: 0, height: 0, fps: 0, frameCount: 0, durationSecs: 12, hasAudio: true },
      }));
      return backend.imported;
    },
    chroma_text_fonts: () => [],
  }),
}));

const bus = vi.hoisted(() => ({
  listeners: new Map<string, Set<(ev: { payload: unknown }) => unknown>>(),
  emitted: [] as { event: string; payload: unknown }[],
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, handler: (ev: { payload: unknown }) => unknown) => {
    const set = bus.listeners.get(event) ?? new Set();
    set.add(handler);
    bus.listeners.set(event, set);
    return Promise.resolve(() => {
      set.delete(handler);
    });
  },
  emit: (event: string, payload: unknown) => {
    bus.emitted.push({ event, payload });
    return Promise.resolve();
  },
}));

import { useMediaPoolStore } from '@apelles/bridge';
import { useEditorControl } from './useEditorControl';

interface OpEnvelope {
  ok: boolean;
  error: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the op payload is deliberately untyped over the wire
  result: any;
}

let requestId = 0;
let mounted: MountedComponent | null = null;

async function callOp(op: string, args: Record<string, unknown> = {}): Promise<OpEnvelope> {
  const id = `audio-${++requestId}`;
  const handlers = [...(bus.listeners.get('chroma://request') ?? [])];
  expect(handlers.length).toBeGreaterThan(0);
  await act(async () => {
    await Promise.all(handlers.map((h) => h({ payload: { id, op, args } })));
  });
  const hit = bus.emitted.find((e) => e.event === `chroma://response/${id}`);
  if (!hit) throw new Error(`no response emitted for ${op}`);
  return hit.payload as OpEnvelope;
}

function Harness(): React.ReactElement {
  useEditorControl();
  return React.createElement('div');
}

beforeEach(async () => {
  backend.calls.length = 0;
  backend.refuse = null;
  backend.imported = [];
  bus.emitted.length = 0;
  useMediaPoolStore.setState({ items: [], folders: [], openProjectKey: 'test-project' });
  mounted = mount(React.createElement(Harness), { strictMode: true });
  await waitFrames(2);
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  bus.listeners.clear();
});

describe('editor_search_audio (D-400)', () => {
  it('passes the wire arguments to the Rust command and returns its page', async () => {
    const env = await callOp('editor_search_audio', {
      query: 'rain',
      kind: 'sfx',
      minSecs: 2,
      maxSecs: 30,
      licenses: ['cc0', 'by'],
      page: 2,
      pageSize: 5,
    });
    expect(env.ok).toBe(true);
    expect(env.result.hits[0].id).toBe('abc-123');
    expect(backend.calls[0]).toEqual({
      cmd: 'chroma_audio_search',
      args: { query: 'rain', kind: 'sfx', minSecs: 2, maxSecs: 30, licenses: ['cc0', 'by'], page: 2, pageSize: 5 },
    });
  });

  it('refuses an empty query before any command runs', async () => {
    const env = await callOp('editor_search_audio', { query: '   ' });
    expect(env.ok).toBe(false);
    expect(env.error).toMatch(/query is required/);
    expect(backend.calls).toHaveLength(0);
  });

  it('returns a refusal from the backend (an NC licence) as the op error, with its reason', async () => {
    backend.refuse = 'licence `by-nc` is NonCommercial: it forbids commercial use. Refused.';
    const env = await callOp('editor_search_audio', { query: 'rain', licenses: ['by-nc'] });
    expect(env.ok).toBe(false);
    expect(env.error).toMatch(/NonCommercial/);
  });
});

describe('editor_import_audio (D-400)', () => {
  it('downloads, then imports the saved file into the media pool, without placing it', async () => {
    const env = await callOp('editor_import_audio', { openverseId: 'abc-123' });
    expect(env.ok).toBe(true);
    expect(backend.calls.map((c) => c.cmd)).toEqual(['chroma_audio_download', 'chroma_media_import']);
    expect(backend.calls[0].args).toEqual({ openverseId: 'abc-123' });
    expect(backend.calls[1].args).toMatchObject({ paths: ['/p/Demo.chroma/assets/audio/rain-abc12345.mp3'] });
    expect(env.result.saved.credit).toContain('CC BY');
    expect(env.result.media.id).toBe('m-rain');
    expect(env.result.placed).toBeUndefined();
  });

  it('needs an id and reports a backend refusal without importing anything', async () => {
    const none = await callOp('editor_import_audio', {});
    expect(none.error).toMatch(/openverse_id is required/);
    backend.refuse = 'licence `by-nd` is NoDerivatives: refused.';
    const refused = await callOp('editor_import_audio', { openverseId: 'abc-123' });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/NoDerivatives/);
    expect(backend.calls.some((c) => c.cmd === 'chroma_media_import')).toBe(false);
  });
});

describe('editor_get_credits (D-400)', () => {
  it('returns the ledger text from the Rust command', async () => {
    const env = await callOp('editor_get_credits');
    expect(env.ok).toBe(true);
    expect(env.result.text).toContain('Audio credits');
    expect(backend.calls).toEqual([{ cmd: 'chroma_audio_credits', args: undefined }]);
  });
});
