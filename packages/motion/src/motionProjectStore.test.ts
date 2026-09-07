// @chroma/motion — unit tests for the Motion tab's readiness state machine
// (B-058 / D-150).
//
// The live report: a real project open (breadcrumb showing, Edit and Colorist
// both working against it), switch to Motion, get "No project open".
//
// The cause these assert shut is structural, and is the same one B-034/D-112
// removed from `@chroma/editor` after five unrelated faults had all surfaced as
// that identical sentence: this tab *inferred* "no project is open" from a
// failed read. It is mounted from boot (`Shell` keeps every tab mounted), so
// its one read happened before any project existed, failed correctly, and was
// then recorded as a fact about the app rather than as a failed call — with no
// input that could ever change it (a project opened from the in-window launcher
// produces no window `focus` event, the only thing that re-read).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

const { useMotionProjectStore } = await import('./motionProjectStore');

/** The exact string `motion.rs::current_project_dir` rejects with. */
const NO_PROJECT = 'no project open — open one in the Colorist tab';

/** A promise plus the handles to settle it whenever the test chooses — the only
 *  way to interleave two in-flight reads deterministically. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Two real project paths (B-083/D-202 — this store's one input is the open
 *  project's own `.chroma` path, not a boolean). */
const PROJECT_A = '/projects/a.chroma';
const PROJECT_B = '/projects/b.chroma';

const manifest = { scenes: [{ kind: 'text', text: 'hi' }] };

beforeEach(() => {
  invokeMock.mockReset();
  // `setOpenProject(null)` is the real reset path — use it rather than poking
  // state directly.
  useMotionProjectStore.getState().setOpenProject(null);
});

describe('the boot-time read that caused B-058', () => {
  it('never runs at all while the app says no project is open', async () => {
    invokeMock.mockRejectedValue(NO_PROJECT);

    // Exactly what happened live: the tab mounts under the launcher and asks.
    await useMotionProjectStore.getState().load();

    expect(invokeMock).not.toHaveBeenCalled();
    const s = useMotionProjectStore.getState();
    expect(s.status).toBe('idle');
    expect(s.error).toBeNull();
  });

  it('opening a project loads the manifest with no window-focus event needed', async () => {
    // The regression itself. Before the fix the tab was stuck on a stale
    // no-project answer taken at boot, and only an OS `focus` event re-read —
    // which opening a project from the in-window launcher never produces.
    invokeMock.mockResolvedValue(manifest);

    useMotionProjectStore.getState().setOpenProject(PROJECT_A);
    await vi.waitFor(() => expect(useMotionProjectStore.getState().status).toBe('ready'));

    const s = useMotionProjectStore.getState();
    expect(invokeMock).toHaveBeenCalledWith('chroma_motion_get_manifest');
    expect(s.loaded?.manifest).toEqual(manifest);
    expect(s.error).toBeNull();
  });

  it('a project with no saved manifest yet is ready, not an error', async () => {
    invokeMock.mockResolvedValue(null);

    useMotionProjectStore.getState().setOpenProject(PROJECT_A);
    await vi.waitFor(() => expect(useMotionProjectStore.getState().status).toBe('ready'));

    // `null` = nothing saved; the hook falls back to the engine's sample.
    expect(useMotionProjectStore.getState().loaded?.manifest).toBeNull();
  });
});

describe('a failed read is never evidence about the project (B-034/D-112, same fault)', () => {
  it('a read that fails while a project is open reports an error, not "no project open"', async () => {
    invokeMock.mockRejectedValue('parse /p.chroma/motion/manifest.json: EOF while parsing a value');

    useMotionProjectStore.getState().setOpenProject(PROJECT_A);
    await vi.waitFor(() => expect(useMotionProjectStore.getState().status).toBe('error'));

    const s = useMotionProjectStore.getState();
    // The whole point: the read failed and the store still knows perfectly well
    // that a project is open, so `MotionTab` (which renders "No project open"
    // off `openProjectPath` alone) cannot produce that message from this.
    expect(s.openProjectPath).toBe(PROJECT_A);
    expect(s.error).toContain('EOF while parsing');
  });

  it('even the backend\'s own "no project open" text does not flip the signal', async () => {
    // A real frontend/backend desync — the one case that used to look identical
    // to the boot-time read and is now reported honestly instead of silently
    // becoming the empty state.
    invokeMock.mockRejectedValue(NO_PROJECT);

    useMotionProjectStore.getState().setOpenProject(PROJECT_A);
    await vi.waitFor(() => expect(useMotionProjectStore.getState().status).toBe('error'));

    const s = useMotionProjectStore.getState();
    expect(s.openProjectPath).toBe(PROJECT_A);
    expect(s.error).toContain('no project open');
  });

  it('closing the project is the one thing that clears the open project', async () => {
    invokeMock.mockResolvedValue(manifest);
    useMotionProjectStore.getState().setOpenProject(PROJECT_A);
    await vi.waitFor(() => expect(useMotionProjectStore.getState().status).toBe('ready'));

    useMotionProjectStore.getState().setOpenProject(null);
    const s = useMotionProjectStore.getState();
    expect(s.openProjectPath).toBeNull();
    expect(s.status).toBe('idle');
    // and the closed project's manifest is gone from the tab, rather than left
    // on screen editable against a project that is no longer open.
    expect(s.loaded).toBeNull();
  });
});

describe('concurrent load ordering', () => {
  it('a slow stale failure cannot overwrite a newer success', async () => {
    const stale = deferred<unknown>();
    const fresh = deferred<unknown>();
    invokeMock.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);

    useMotionProjectStore.setState({ openProjectPath: PROJECT_A });
    const store = useMotionProjectStore.getState();
    const staleLoad = store.load();
    const freshLoad = store.load();

    fresh.resolve(manifest);
    await freshLoad;
    expect(useMotionProjectStore.getState().status).toBe('ready');

    stale.reject(NO_PROJECT);
    await staleLoad;
    await flush();

    const s = useMotionProjectStore.getState();
    expect(s.status).toBe('ready');
    expect(s.loaded?.manifest).toEqual(manifest);
    expect(s.error).toBeNull();
  });

  it('a read from a project since closed cannot land in the newly-open one', async () => {
    const old = deferred<unknown>();
    invokeMock.mockReturnValueOnce(old.promise).mockResolvedValue(manifest);

    useMotionProjectStore.getState().setOpenProject(PROJECT_A); // project A — read hangs
    useMotionProjectStore.getState().setOpenProject(null); // "‹ Projects"
    old.resolve({ scenes: [{ kind: 'text', text: 'project A' }] });
    await flush();

    const s = useMotionProjectStore.getState();
    expect(s.openProjectPath).toBeNull();
    expect(s.loaded).toBeNull();
    expect(s.status).toBe('idle');
  });

  it('a fresh read bumps the generation so the editor re-seeds', async () => {
    invokeMock.mockResolvedValue(manifest);
    useMotionProjectStore.setState({ openProjectPath: PROJECT_A });

    await useMotionProjectStore.getState().load();
    const first = useMotionProjectStore.getState().loaded?.generation;
    await useMotionProjectStore.getState().load();
    const second = useMotionProjectStore.getState().loaded?.generation;

    expect(first).toBeDefined();
    expect(second).toBe((first as number) + 1);
  });
});

// B-083/D-202 — found on the Edit tab (its timeline store had the identical
// "one boolean input" shape), audited here and confirmed present: this store
// was told only *whether* a project was open, and `open_project`/`new_project`
// swap one project for another without ever passing through closed. The
// manifest is a per-project sidecar, so the tab kept editing the outgoing
// project's manifest — and a save would have written it into the incoming
// project's own sidecar.
describe('switching projects (B-083 / D-202)', () => {
  it('opening a DIFFERENT project re-reads THAT project’s manifest', async () => {
    const manifestA = { scenes: [{ kind: 'text', text: 'A' }] };
    const manifestB = { scenes: [{ kind: 'text', text: 'B' }] };
    invokeMock.mockResolvedValue(manifestA);

    useMotionProjectStore.getState().setOpenProject(PROJECT_A);
    await vi.waitFor(() => expect(useMotionProjectStore.getState().status).toBe('ready'));
    expect(useMotionProjectStore.getState().loaded?.manifest).toEqual(manifestA);

    invokeMock.mockResolvedValue(manifestB);
    useMotionProjectStore.getState().setOpenProject(PROJECT_B);
    await vi.waitFor(() => expect(useMotionProjectStore.getState().status).toBe('ready'));

    const s = useMotionProjectStore.getState();
    expect(s.openProjectPath).toBe(PROJECT_B);
    expect(s.loaded?.manifest).toEqual(manifestB);
  });

  it('drops the outgoing project’s manifest immediately, rather than leaving it editable', async () => {
    invokeMock.mockResolvedValue(manifest);
    useMotionProjectStore.getState().setOpenProject(PROJECT_A);
    await vi.waitFor(() => expect(useMotionProjectStore.getState().status).toBe('ready'));

    invokeMock.mockReturnValue(new Promise(() => {})); // B's read hangs
    useMotionProjectStore.getState().setOpenProject(PROJECT_B);

    const s = useMotionProjectStore.getState();
    expect(s.loaded).toBeNull();
    expect(s.status).toBe('loading');
  });
});
