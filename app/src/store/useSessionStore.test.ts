// Regression tests for B-132 (D-268) — the session lock, driven through the
// real `useSessionStore` actions rather than the lock primitive on its own.
//
// The reported failure: on a running app, `new_project` returned
// `{"ok": false, "error": "session busy"}` for every call, for the rest of the
// process's life, with nothing visibly in flight — so a fresh install could not
// create or open a project at all. These tests reproduce the mechanism (an
// `await` inside a lock-held block that never settles) and pin the three
// behaviours that fix it.
//
// Both interfaces by construction: the GUI's project-launcher buttons and the
// MCP `new_project`/`open_project`/`add_shots` ops call these exact store
// actions (`ProjectLauncher.tsx` and `useChromaControl.ts` respectively), so
// there is one guard and these tests cover both surfaces at once.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
const trackEvent = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@apelles/bridge', () => ({ trackEvent: (...a: unknown[]) => trackEvent(...a) }));

const { useSessionStore } = await import('./useSessionStore');
const { STALE_SESSION_LOCK_MS } = await import('./sessionLock');

/** An empty-but-valid `ProjectOpenDto` — a project with no clips, which is
 *  exactly what the live `new_project` calls that hit this bug were creating
 *  (the app log's `project_new` telemetry recorded `mediaCount: 0`). */
function emptyDto(name: string) {
  return {
    projectPath: `/projects/${name}.chroma`,
    name,
    gradeDir: `/projects/${name}.chroma/grades`,
    schema: 'chroma.project/1',
    shots: [],
    activeShot: 0,
    settings: {},
  };
}

/** The happy-path Tauri surface `newProject` touches for an empty project. */
function respondNormally() {
  invoke.mockImplementation(async (cmd: string, args?: { name?: string }) => {
    if (cmd === 'chroma_project_new') return emptyDto(args?.name ?? 'unnamed');
    if (cmd === 'chroma_project_open') return emptyDto('opened');
    if (cmd === 'chroma_session_list') return { shots: [], active: 0, count: 0 };
    if (cmd === 'chroma_project_save') return { thumbRegenerated: false };
    return null;
  });
}

const INITIAL = useSessionStore.getState();

beforeEach(() => {
  invoke.mockReset();
  trackEvent.mockReset();
  vi.useRealTimers();
  // A genuinely fresh store, the state a freshly launched app boots into.
  useSessionStore.setState({
    ...INITIAL,
    shots: [],
    activeIndex: 0,
    grades: {},
    busy: false,
    lock: null,
    projectPath: null,
    projectName: null,
    gradeDir: null,
    offlineShots: [],
    dirty: false,
    projectSettings: null,
  });
});

describe('a freshly launched session', () => {
  it('starts with the lock free — nothing holds it before the user acts', () => {
    expect(useSessionStore.getState().busy).toBe(false);
    expect(useSessionStore.getState().lock).toBeNull();
  });

  it('creates two projects back to back (the exact call that failed live)', async () => {
    respondNormally();
    const first = await useSessionStore.getState().newProject('first', []);
    const second = await useSessionStore.getState().newProject('second', []);

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(useSessionStore.getState().busy).toBe(false);
  });
});

describe('the session lock', () => {
  it('holds across the nested _hydrateOpenDto instead of being released by it', async () => {
    // The real defect in the old bare flag: `_hydrateOpenDto`'s own `finally`
    // cleared `busy` while its caller was still running, so the tail of
    // `newProject` (and of openProject/addShots/removeShot/relinkShot) ran
    // completely unguarded. `trackEvent` fires in `newProject` immediately
    // after the nested call returns — the exact window that used to be open.
    respondNormally();
    let busyAfterHydrate: boolean | null = null;
    let holderAfterHydrate: string | null = null;
    trackEvent.mockImplementation(() => {
      busyAfterHydrate = useSessionStore.getState().busy;
      holderAfterHydrate = useSessionStore.getState().lock?.op ?? null;
    });

    await useSessionStore.getState().newProject('p', []);

    expect(busyAfterHydrate).toBe(true);
    expect(holderAfterHydrate).toBe('newProject');
    // …and it is properly released once the outer action really is done.
    expect(useSessionStore.getState().busy).toBe(false);
    expect(useSessionStore.getState().lock).toBeNull();
  });

  it('refuses a concurrent action with a message naming the holder', async () => {
    // `chroma_project_new` never settles — a lost Tauri IPC transport, a Rust
    // command blocking the async runtime, or simply an op still running after
    // control.rs's 20s bridge timeout already answered the HTTP caller.
    invoke.mockImplementation(
      (cmd: string) =>
        cmd === 'chroma_project_new'
          ? new Promise(() => {})
          : Promise.resolve({ shots: [], active: 0, count: 0 }),
    );

    void useSessionStore.getState().newProject('hangs', []);
    await Promise.resolve();

    const refused = await useSessionStore.getState().newProject('second', []);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('newProject');
    expect(refused.error).toContain('session lock');
    // Every other session action is gated by the same lock, so they refuse
    // the same way rather than corrupting the in-flight one.
    expect((await useSessionStore.getState().openProject('/p.chroma')).ok).toBe(false);
    expect((await useSessionStore.getState().addShots(['/a.mov'])).ok).toBe(false);
    expect((await useSessionStore.getState().relinkShot('c1', '/b.mov')).ok).toBe(false);
  });

  it('recovers on its own once a hung holder is unambiguously abandoned', async () => {
    // B-132's actual severity was not that one call failed — it was that EVERY
    // subsequent call failed forever, with no recovery short of quitting.
    invoke.mockImplementation(
      (cmd: string) =>
        cmd === 'chroma_project_new'
          ? new Promise(() => {})
          : Promise.resolve({ shots: [], active: 0, count: 0 }),
    );
    void useSessionStore.getState().newProject('hangs', []);
    await Promise.resolve();
    expect(useSessionStore.getState().busy).toBe(true);

    // A real wall-clock duration, deliberately NOT derived from
    // `STALE_SESSION_LOCK_MS`: a test that offsets by its own constant passes
    // for any threshold at all, including one that never breaks the lock,
    // which is precisely the broken behaviour under test.
    const FIVE_MINUTES_MS = 5 * 60_000;
    expect(STALE_SESSION_LOCK_MS).toBeLessThan(FIVE_MINUTES_MS);

    const wedgedAt = useSessionStore.getState().lock?.since ?? 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(wedgedAt + FIVE_MINUTES_MS);
    respondNormally();

    const recovered = await useSessionStore.getState().newProject('after-the-wedge', []);
    expect(recovered).toEqual({ ok: true });
    expect(useSessionStore.getState().projectName).toBe('after-the-wedge');
    vi.useRealTimers();
  });

  it('refuses a direct _hydrateOpenDto that races a real project open', async () => {
    // SourcesPanel's "add to grading" is the one caller that holds no lock of
    // its own. It must take one — and be refused, loudly, if another action
    // already holds it — rather than hydrating on top of an in-flight open.
    invoke.mockImplementation(
      (cmd: string) =>
        cmd === 'chroma_project_open'
          ? new Promise(() => {})
          : Promise.resolve({ shots: [], active: 0, count: 0 }),
    );
    void useSessionStore.getState().openProject('/busy.chroma');
    await Promise.resolve();

    await expect(useSessionStore.getState()._hydrateOpenDto(emptyDto('x'))).rejects.toThrow(
      /openProject/,
    );
  });

  it('is dropped by closeProject, the human-reachable recovery', async () => {
    invoke.mockImplementation(
      (cmd: string) =>
        cmd === 'chroma_project_new'
          ? new Promise(() => {})
          : Promise.resolve({ shots: [], active: 0, count: 0 }),
    );
    void useSessionStore.getState().newProject('hangs', []);
    await Promise.resolve();
    expect(useSessionStore.getState().busy).toBe(true);

    await useSessionStore.getState().closeProject();

    expect(useSessionStore.getState().busy).toBe(false);
    expect(useSessionStore.getState().lock).toBeNull();
    respondNormally();
    expect((await useSessionStore.getState().newProject('fresh', [])).ok).toBe(true);
  });
});
