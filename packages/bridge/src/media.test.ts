// @chroma/bridge — unit tests for the media pool's project-identity input
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

const { useMediaPoolStore } = await import('./media');
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
