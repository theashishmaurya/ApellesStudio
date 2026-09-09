// @vitest-environment jsdom
/**
 * @chroma/editor — permanent coverage for the media pool's read/organise MCP
 * ops (D-266): `editor_list_media`, `editor_list_media_folders`,
 * `editor_create_media_folder`, `editor_move_media`.
 *
 * **What this asserts, and where the GUI parity claim really lands.** These
 * four ops exist to be the agent's half of a capability the Sources panel
 * already has, so the thing worth testing is not "a setter was called" but
 * that an op ends up at the SAME `chroma_media_*` command, with the same
 * arguments, that a human's click reaches. Both paths go through
 * `@chroma/bridge`'s `useMediaPoolStore` — the panel's list renders off
 * `refresh()`, its "New folder" button calls `createFolder`, its drag-onto-a-
 * bin calls `moveToFolder` — so the ops run through the REAL `chroma://request`
 * dispatch path `control.rs` uses and the assertions are on what was invoked
 * and on the store the panel renders from afterwards.
 *
 * **Its honest limit.** `SourcesPanel.tsx` itself lives in the `app/` layer,
 * which has no test suite at all, so this cannot click the panel's own button
 * the way `PreviewPane.waveform.dom.test.tsx` clicks the transport's. The
 * convergence point it does assert — one store action, one Tauri command — is
 * the same one that file's DOM assertions are downstream of, and it is the
 * layer where a divergence between the two interfaces would actually appear.
 * A panel that stopped using these store actions would be a real regression
 * this tier cannot see.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';

import { createInvokeStub, mount, waitFrames, type MountedComponent } from './testUtils/pointerHarness';

/** The pool the fake backend is holding, and every media command it saw. */
const backend = vi.hoisted(() => ({
  items: [] as Record<string, unknown>[],
  folders: [] as string[],
  calls: [] as { cmd: string; args: Record<string, unknown> | undefined }[],
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_media_list: (args) => {
      backend.calls.push({ cmd: 'chroma_media_list', args });
      return backend.items;
    },
    chroma_media_folders: (args) => {
      backend.calls.push({ cmd: 'chroma_media_folders', args });
      return backend.folders;
    },
    chroma_media_create_folder: (args) => {
      backend.calls.push({ cmd: 'chroma_media_create_folder', args });
      const path = String(args?.path ?? '');
      if (!backend.folders.includes(path)) backend.folders = [...backend.folders, path].sort();
      return backend.folders;
    },
    chroma_media_move: (args) => {
      backend.calls.push({ cmd: 'chroma_media_move', args });
      const id = String(args?.id ?? '');
      const found = backend.items.find((m) => m.id === id);
      if (!found) throw new Error(`unknown media id ${id}`);
      // Mirrors `chroma_media_move`'s real contract: it returns the updated
      // item and registers a not-yet-known bin on the way (D-045/D-059).
      const folder = args?.folder == null ? null : String(args.folder);
      found.folder = folder;
      if (folder && !backend.folders.includes(folder)) {
        backend.folders = [...backend.folders, folder].sort();
      }
      return found;
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

import { useMediaPoolStore } from '@chroma/bridge';
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
  const id = `test-${++requestId}`;
  const handlers = [...(bus.listeners.get('chroma://request') ?? [])];
  expect(handlers.length).toBeGreaterThan(0);
  await act(async () => {
    await Promise.all(handlers.map((h) => h({ payload: { id, op, args } })));
  });
  const hit = bus.emitted.find((e) => e.event === `chroma://response/${id}`);
  if (!hit) throw new Error(`no response emitted for ${op}`);
  return hit.payload as OpEnvelope;
}

/** A healthy pool item — probed, online, placeable. */
function goodItem(over: Record<string, unknown> = {}) {
  return {
    id: 'good',
    sourcePath: '/footage/a.mov',
    name: 'a.mov',
    added: '2026-09-09T00:00:00Z',
    offline: false,
    folder: null,
    thumb: 'data:image/jpeg;base64,AAAA',
    video: { width: 1920, height: 1080, fps: 30, frameCount: 900, durationSecs: 30, hasAudio: true },
    ...over,
  };
}

/** B-073's item: imported, online, and stuck with no probed metadata. */
function stuckItem(over: Record<string, unknown> = {}) {
  return {
    id: 'stuck',
    sourcePath: '/footage/b.mov',
    name: 'b.mov',
    added: '2026-09-09T00:00:00Z',
    offline: false,
    folder: null,
    video: null,
    ...over,
  };
}

function Harness(): React.ReactElement {
  useEditorControl();
  return React.createElement('div');
}

async function mountHarness(): Promise<void> {
  mounted = mount(React.createElement(Harness), { strictMode: true });
  await waitFrames(2);
}

beforeEach(() => {
  backend.items = [];
  backend.folders = [];
  backend.calls.length = 0;
  bus.emitted.length = 0;
  useMediaPoolStore.setState({ items: [], folders: [], openProjectKey: 'test-project' });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  bus.listeners.clear();
});

describe('editor_list_media (D-266)', () => {
  it('lists what is really in the pool, through the same command the panel lists from', async () => {
    backend.items = [goodItem(), goodItem({ id: 'g2', sourcePath: '/footage/c.mov', folder: 'b-roll' })];
    backend.folders = ['b-roll'];
    await mountHarness();

    const env = await callOp('editor_list_media');

    expect(env.ok).toBe(true);
    expect(backend.calls.some((c) => c.cmd === 'chroma_media_list')).toBe(true);
    expect(env.result.count).toBe(2);
    expect(env.result.folders).toEqual(['b-roll']);
    expect(env.result.items[0]).toMatchObject({
      id: 'good',
      name: 'a.mov',
      sourcePath: '/footage/a.mov',
      folder: null,
      offline: false,
      usable: true,
    });
    expect(env.result.items[0].video).toMatchObject({ width: 1920, frameCount: 900, hasAudio: true });
    expect(env.result.items[1].folder).toBe('b-roll');
  });

  /** The whole reason a listing tool is worth its round trip: it must reach
   *  DISK, not report whatever this store last happened to cache. An item
   *  seeded by `new_project`'s own `media_paths` never goes through
   *  `importPaths`, so it is absent from `items` until something refreshes —
   *  and that divergence is B-073/B-082's own mechanism. */
  it('reads through to the backend rather than reporting a stale cached array', async () => {
    await mountHarness();
    expect(useMediaPoolStore.getState().items).toHaveLength(0);

    backend.items = [goodItem()];
    const env = await callOp('editor_list_media');

    expect(env.result.count).toBe(1);
    // …and the panel now renders the same refreshed pool the agent just read.
    expect(useMediaPoolStore.getState().items).toHaveLength(1);
  });

  /** **B-073, answered in the list.** A session that hit this had to read
   *  `project.json` by hand to work out WHICH item was the broken one. The
   *  test is that the bad item is identifiable from the response alone, and
   *  that the response says what to do about it. */
  it('names the stuck, unplaceable item instead of handing back an opaque array', async () => {
    backend.items = [goodItem(), stuckItem()];
    await mountHarness();

    const env = await callOp('editor_list_media');

    expect(env.result.unusable).toEqual(['stuck']);
    const stuck = env.result.items.find((m: { id: string }) => m.id === 'stuck');
    expect(stuck.usable).toBe(false);
    expect(stuck.video).toBeNull();
    // The recovery sequence, in the row itself — not left to be inferred.
    expect(stuck.problem).toMatch(/B-073/);
    expect(stuck.problem).toMatch(/editor_remove_media/);
    // …and the healthy row carries no `problem` at all.
    expect(env.result.items.find((m: { id: string }) => m.id === 'good').problem).toBeUndefined();
  });

  /** An offline item gets its own explanation: same refusal from
   *  `editor_add_clip`, entirely different cause and fix. */
  it('distinguishes a missing source file from a failed probe', async () => {
    backend.items = [stuckItem({ id: 'gone', offline: true })];
    await mountHarness();

    const env = await callOp('editor_list_media');
    expect(env.result.items[0].problem).toMatch(/missing from disk/);
    expect(env.result.items[0].problem).not.toMatch(/B-073/);
  });

  /** An item that is offline but WAS probed is still placeable — the clip
   *  carries its own copy of the source path, so a temporarily-missing file is
   *  not the same fact as an unusable pool entry. */
  it('does not call a probed-but-offline item unusable', async () => {
    backend.items = [goodItem({ offline: true })];
    await mountHarness();

    const env = await callOp('editor_list_media');
    expect(env.result.items[0].usable).toBe(true);
    expect(env.result.unusable).toEqual([]);
  });

  /** The thumbnail is a base64 JPEG data URL. Reporting it would swamp an
   *  agent's context with an unreadable blob per row, so its PRESENCE is the
   *  reported fact and the bytes stay in the GUI. */
  it('reports whether a thumbnail exists, never the data URL itself', async () => {
    backend.items = [goodItem(), stuckItem()];
    await mountHarness();

    const env = await callOp('editor_list_media');
    expect(env.result.items[0].hasThumb).toBe(true);
    expect(env.result.items[1].hasThumb).toBe(false);
    expect(JSON.stringify(env.result)).not.toContain('base64');
  });
});

describe('editor_list_media_folders (D-266)', () => {
  it('reports each bin with its item count, and the root separately', async () => {
    backend.items = [
      goodItem(),
      goodItem({ id: 'g2', folder: 'b-roll' }),
      goodItem({ id: 'g3', folder: 'b-roll' }),
    ];
    backend.folders = ['b-roll', 'interviews'];
    await mountHarness();

    const env = await callOp('editor_list_media_folders');

    expect(env.ok).toBe(true);
    expect(env.result.root).toEqual({ items: 1 });
    expect(env.result.folders).toEqual([
      { path: 'b-roll', items: 2 },
      // A registered-but-still-empty bin is a real thing (D-059) and is listed.
      { path: 'interviews', items: 0 },
    ]);
  });
});

describe('editor_create_media_folder (D-266)', () => {
  it('creates the bin through the same command the panel New-folder action calls', async () => {
    await mountHarness();

    const env = await callOp('editor_create_media_folder', { path: 'b-roll/day1' });

    expect(env.ok).toBe(true);
    const call = backend.calls.find((c) => c.cmd === 'chroma_media_create_folder');
    expect(call?.args).toMatchObject({ path: 'b-roll/day1' });
    expect(env.result.folders).toEqual(['b-roll/day1']);
    // …and the store the panel's own tree is built from now holds it too.
    expect(useMediaPoolStore.getState().folders).toEqual(['b-roll/day1']);
  });

  it('rejects an empty path rather than creating a nameless bin', async () => {
    await mountHarness();
    expect((await callOp('editor_create_media_folder', { path: '   ' })).ok).toBe(false);
    expect((await callOp('editor_create_media_folder', {})).ok).toBe(false);
    expect(backend.calls.some((c) => c.cmd === 'chroma_media_create_folder')).toBe(false);
  });
});

describe('editor_move_media (D-266)', () => {
  it('files an item into a bin and reports it back in its new place', async () => {
    backend.items = [goodItem()];
    backend.folders = ['b-roll'];
    await mountHarness();
    await callOp('editor_list_media');

    const env = await callOp('editor_move_media', { id: 'good', folder: 'b-roll' });

    expect(env.ok).toBe(true);
    expect(backend.calls.find((c) => c.cmd === 'chroma_media_move')?.args).toMatchObject({
      id: 'good',
      folder: 'b-roll',
    });
    expect(env.result.item).toMatchObject({ id: 'good', folder: 'b-roll' });
    expect(useMediaPoolStore.getState().items[0].folder).toBe('b-roll');
  });

  /** `folder: null` is the pool ROOT — a real destination, and the only way
   *  back out of a bin. */
  it('moves an item back to the pool root on an explicit null', async () => {
    backend.items = [goodItem({ folder: 'b-roll' })];
    backend.folders = ['b-roll'];
    await mountHarness();
    await callOp('editor_list_media');

    const env = await callOp('editor_move_media', { id: 'good', folder: null });

    expect(env.ok).toBe(true);
    expect(env.result.item.folder).toBeNull();
  });

  /** …which is exactly why an OMITTED folder cannot mean "leave it alone":
   *  the two would be indistinguishable, and the silent outcome would be
   *  un-filing an item the caller never asked to move. */
  it('refuses to guess when folder is omitted entirely', async () => {
    backend.items = [goodItem({ folder: 'b-roll' })];
    await mountHarness();

    const env = await callOp('editor_move_media', { id: 'good' });

    expect(env.ok).toBe(false);
    expect(env.error).toMatch(/folder/);
    expect(backend.calls.some((c) => c.cmd === 'chroma_media_move')).toBe(false);
  });

  it('surfaces the backend refusal for an unknown id rather than reporting ok', async () => {
    await mountHarness();
    const env = await callOp('editor_move_media', { id: 'nope', folder: 'b-roll' });
    expect(env.ok).toBe(false);
    expect(env.error).toMatch(/nope/);
  });

  it('rejects a missing id without a round trip', async () => {
    await mountHarness();
    expect((await callOp('editor_move_media', { folder: null })).ok).toBe(false);
    expect(backend.calls.some((c) => c.cmd === 'chroma_media_move')).toBe(false);
  });
});
