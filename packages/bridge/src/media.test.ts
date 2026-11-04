// @apelles/bridge — unit tests for the media pool's project-identity input
// (B-083 / D-203).
//
// The pool is per-project state that nothing ever invalidated on a project
// *switch*: `SourcesPanel` fired the only `refresh()` from its own effect,
// keyed on a bare "a project is open" boolean, which stays `true` when
// `open_project`/`new_project` swap one project for another. So `items` — the
// array `editor_add_clip` resolves a `mediaId`/`sourcePath` against (B-084) —
// stayed on the outgoing project's media for the rest of the session.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

/** D-453 — the conversion progress event: the handler the store registers, so a
 *  test can deliver an event the way the backend would. */
const events = vi.hoisted(() => ({
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  unlistened: 0,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, handler: (e: { payload: unknown }) => void) => {
    events.handlers.set(name, handler);
    return Promise.resolve(() => {
      events.unlistened += 1;
      events.handlers.delete(name);
    });
  },
}));

const { useMediaPoolStore, MEDIA_CONVERSION_EVENT, awaitsConversion } = await import('./media');
import type { MediaItem } from './media';

const PROJECT_A = '/projects/a.chroma';
const PROJECT_B = '/projects/b.chroma';

function itemNamed(name: string): MediaItem {
  return {
    id: `id-${name}`,
    sourcePath: `/media/${name}.mov`,
    name,
    added: '2026-09-07T00:00:00Z',
    offline: false,
  };
}

/** `chroma_media_list`/`_folders` answering for whichever project the Rust
 *  side has open — neither command takes an argument, exactly like the real
 *  ones. */
let backendProject = 'A';
function installBackend() {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === 'chroma_media_list') return Promise.resolve([itemNamed(backendProject)]);
    if (cmd === 'chroma_media_folders') return Promise.resolve([`bin-${backendProject}`]);
    return Promise.resolve(undefined);
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  invokeMock.mockReset();
  useMediaPoolStore.getState().setOpenProject(null);
  backendProject = 'A';
  installBackend();
});

describe('the open project is the pool’s one input (B-083 / D-203)', () => {
  it('opening a project reads that project’s pool', async () => {
    useMediaPoolStore.getState().setOpenProject(PROJECT_A);
    await vi.waitFor(() => expect(useMediaPoolStore.getState().items).toHaveLength(1));

    const s = useMediaPoolStore.getState();
    expect(s.items[0]?.name).toBe('A');
    expect(s.folders).toEqual(['bin-A']);
    expect(s.openProjectKey).toBe(PROJECT_A);
  });

  it('switching to a DIFFERENT project replaces the pool instead of keeping the old one', async () => {
    useMediaPoolStore.getState().setOpenProject(PROJECT_A);
    await vi.waitFor(() => expect(useMediaPoolStore.getState().items).toHaveLength(1));

    backendProject = 'B';
    useMediaPoolStore.getState().setOpenProject(PROJECT_B);
    // synchronously: the outgoing project's media is already gone, not left
    // resolvable by `editor_add_clip` under the new project's name
    expect(useMediaPoolStore.getState().items).toEqual([]);
    expect(useMediaPoolStore.getState().loading).toBe(true);

    await vi.waitFor(() => expect(useMediaPoolStore.getState().items).toHaveLength(1));
    expect(useMediaPoolStore.getState().items[0]?.name).toBe('B');
    expect(useMediaPoolStore.getState().folders).toEqual(['bin-B']);
  });

  it('closing the project empties the pool and asks the backend nothing', async () => {
    useMediaPoolStore.getState().setOpenProject(PROJECT_A);
    await vi.waitFor(() => expect(useMediaPoolStore.getState().items).toHaveLength(1));

    invokeMock.mockClear();
    useMediaPoolStore.getState().setOpenProject(null);
    await flush();

    expect(useMediaPoolStore.getState().items).toEqual([]);
    expect(useMediaPoolStore.getState().openProjectKey).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('re-declaring the SAME project is a no-op, not a refetch', async () => {
    useMediaPoolStore.getState().setOpenProject(PROJECT_A);
    await vi.waitFor(() => expect(useMediaPoolStore.getState().items).toHaveLength(1));

    invokeMock.mockClear();
    useMediaPoolStore.getState().setOpenProject(PROJECT_A);
    await flush();

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('a slow read from the previous project cannot land on the new one', async () => {
    // The ordering guarantee the switch above needs: `SourcesPanel`'s own
    // refresh (or an import's) may still be in flight when the project
    // changes, and the slower call must not win by writing last.
    let resolveStale!: (v: MediaItem[]) => void;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'chroma_media_list') return new Promise<MediaItem[]>((r) => (resolveStale = r));
      return Promise.resolve([]);
    });
    useMediaPoolStore.getState().setOpenProject(PROJECT_A);
    await flush();

    backendProject = 'B';
    installBackend();
    useMediaPoolStore.getState().setOpenProject(PROJECT_B);
    await vi.waitFor(() => expect(useMediaPoolStore.getState().items).toHaveLength(1));

    resolveStale([itemNamed('A')]);
    await flush();

    expect(useMediaPoolStore.getState().items[0]?.name).toBe('B');
  });
});

// ---------------------------------------------------------------------------
// D-260 — refreshPaths: reconcile the pool with what is on disk
// ---------------------------------------------------------------------------

describe('refreshPaths (D-260)', () => {
  /** `chroma_media_refresh` echoing back whatever items it was asked about. */
  function installRefreshBackend(reply: MediaItem[]) {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'chroma_media_list') return Promise.resolve([itemNamed('A')]);
      if (cmd === 'chroma_media_folders') return Promise.resolve([]);
      if (cmd === 'chroma_media_refresh') return Promise.resolve(reply);
      return Promise.resolve(undefined);
    });
  }

  it('MERGES a refreshed item by id rather than appending it', async () => {
    // The bug this exists to prevent: `importPaths` appends, and a Motion
    // re-render refreshes an item that is ALREADY in `items` — appending it
    // would show the same render twice in the Sources panel, and give
    // `editor_add_clip` two rows to resolve one media id against.
    const refreshed: MediaItem = { ...itemNamed('A'), name: 'A (re-rendered)', motionSceneId: 'hook' };
    installRefreshBackend([refreshed]);
    useMediaPoolStore.getState().setOpenProject(PROJECT_A);
    await vi.waitFor(() => expect(useMediaPoolStore.getState().items).toHaveLength(1));

    const res = await useMediaPoolStore.getState().refreshPaths(['/media/A.mov'], 'hook');
    expect(res.ok).toBe(true);
    const items = useMediaPoolStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('A (re-rendered)');
    expect(items[0].motionSceneId).toBe('hook');
  });

  it('appends an item the pool did not have yet (a first render)', async () => {
    const added: MediaItem = { ...itemNamed('hook'), motionSceneId: 'hook' };
    installRefreshBackend([added]);
    useMediaPoolStore.getState().setOpenProject(PROJECT_A);
    await vi.waitFor(() => expect(useMediaPoolStore.getState().items).toHaveLength(1));

    await useMediaPoolStore.getState().refreshPaths(['/media/hook.mov'], 'hook');
    const items = useMediaPoolStore.getState().items;
    expect(items.map((i) => i.id)).toEqual(['id-A', 'id-hook']);
  });

  it('passes the scene id through, and null when there is none', async () => {
    installRefreshBackend([]);
    useMediaPoolStore.getState().setOpenProject(PROJECT_A);
    await flush();
    await useMediaPoolStore.getState().refreshPaths(['/x.mp4'], 'hook');
    expect(invokeMock).toHaveBeenCalledWith('chroma_media_refresh', {
      paths: ['/x.mp4'],
      motionSceneId: 'hook',
    });
    await useMediaPoolStore.getState().refreshPaths(['/x.mp4']);
    expect(invokeMock).toHaveBeenLastCalledWith('chroma_media_refresh', {
      paths: ['/x.mp4'],
      motionSceneId: null,
    });
  });

  it('never calls the backend for an empty path list', async () => {
    installRefreshBackend([]);
    useMediaPoolStore.getState().setOpenProject(PROJECT_A);
    await flush();
    invokeMock.mockClear();
    await expect(useMediaPoolStore.getState().refreshPaths([])).resolves.toEqual({ ok: true, items: [] });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('reports a backend failure without touching the pool', async () => {
    useMediaPoolStore.getState().setOpenProject(PROJECT_A);
    await vi.waitFor(() => expect(useMediaPoolStore.getState().items).toHaveLength(1));
    const before = useMediaPoolStore.getState().items;
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'chroma_media_refresh' ? Promise.reject(new Error('no project open')) : Promise.resolve([]),
    );
    const res = await useMediaPoolStore.getState().refreshPaths(['/x.mp4']);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('no project open');
    expect(useMediaPoolStore.getState().items).toBe(before);
  });
});

describe('conversion to optimized media (D-453)', () => {
  const MKV: MediaItem = {
    id: 'id-mkv',
    sourcePath: '/media/talk.mkv',
    name: 'talk.mkv',
    added: '2026-11-04T00:00:00Z',
    offline: false,
    conversion: { state: 'queued', progress: 0 },
  };

  function installPool(items: MediaItem[]) {
    invokeMock.mockImplementation((cmd: string, args?: { ids?: string[] }) => {
      if (cmd === 'chroma_media_list') return Promise.resolve(items);
      if (cmd === 'chroma_media_folders') return Promise.resolve([]);
      if (cmd === 'chroma_media_cancel_conversion') {
        const ids = args?.ids ?? [];
        return Promise.resolve({
          items: ids
            .filter((id) => items.some((m) => m.id === id))
            .map((id) => ({
              id,
              sourcePath: items.find((m) => m.id === id)?.sourcePath ?? '',
              wasConverting: true,
              conversion: { state: 'cancelled', progress: 0 },
            })),
          unknownIds: ids.filter((id) => !items.some((m) => m.id === id)),
        });
      }
      return Promise.resolve(undefined);
    });
  }

  it('applies the backend’s progress events to the item with that source while a project is open', async () => {
    installPool([MKV, itemNamed('A')]);
    useMediaPoolStore.getState().setOpenProject(PROJECT_A);
    await vi.waitFor(() => expect(useMediaPoolStore.getState().items).toHaveLength(2));
    const emit = events.handlers.get(MEDIA_CONVERSION_EVENT);
    expect(emit).toBeDefined();
    emit?.({ payload: { sourcePath: MKV.sourcePath, conversion: { state: 'converting', progress: 0.42 } } });
    const mkv = useMediaPoolStore.getState().items.find((m) => m.id === MKV.id);
    expect(mkv?.conversion).toEqual({ state: 'converting', progress: 0.42 });
    expect(mkv && awaitsConversion(mkv)).toBe(true);
    // An event for a source not in the pool changes nothing.
    const unchanged = useMediaPoolStore.getState().items;
    emit?.({ payload: { sourcePath: '/elsewhere.mkv', conversion: { state: 'ready', progress: 1 } } });
    expect(useMediaPoolStore.getState().items).toBe(unchanged);
    emit?.({ payload: { sourcePath: MKV.sourcePath, conversion: { state: 'ready', progress: 1 } } });
    const ready = useMediaPoolStore.getState().items.find((m) => m.id === MKV.id);
    expect(ready && awaitsConversion(ready)).toBe(false);
  });

  it('stops listening when the project closes', async () => {
    installPool([MKV]);
    useMediaPoolStore.getState().setOpenProject(PROJECT_A);
    await vi.waitFor(() => expect(useMediaPoolStore.getState().items).toHaveLength(1));
    const unlistenedBefore = events.unlistened;
    useMediaPoolStore.getState().setOpenProject(null);
    await flush();
    expect(events.unlistened).toBe(unlistenedBefore + 1);
    expect(events.handlers.has(MEDIA_CONVERSION_EVENT)).toBe(false);
  });

  it('cancels through the one command and writes the answer back onto the items', async () => {
    installPool([MKV]);
    useMediaPoolStore.getState().setOpenProject(PROJECT_A);
    await vi.waitFor(() => expect(useMediaPoolStore.getState().items).toHaveLength(1));
    const res = await useMediaPoolStore.getState().cancelConversion([MKV.id, 'nope']);
    expect(invokeMock).toHaveBeenLastCalledWith('chroma_media_cancel_conversion', { ids: [MKV.id, 'nope'] });
    expect(res.ok).toBe(true);
    expect(res.unknownIds).toEqual(['nope']);
    expect(res.items?.[0]?.wasConverting).toBe(true);
    expect(useMediaPoolStore.getState().items[0]?.conversion?.state).toBe('cancelled');
  });

  it('a source that needs no conversion, or is ready, does not await one', () => {
    expect(awaitsConversion({ conversion: null })).toBe(false);
    expect(awaitsConversion({})).toBe(false);
    expect(awaitsConversion({ conversion: { state: 'ready', progress: 1 } })).toBe(false);
    expect(awaitsConversion({ conversion: { state: 'failed', progress: 0, error: 'x' } })).toBe(true);
  });
});
