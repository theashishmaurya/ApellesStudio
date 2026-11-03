// B-369 / D-439 — a project open no longer decodes the Colorist canvas's frame
// twice, and on a tab other than Colorist it leaves that decode to the first use.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@apelles/bridge', () => ({ trackEvent: () => {} }));

const { useSessionStore } = await import('./useSessionStore');
const { useShellStore } = await import('@apelles/shell');
const { useEditorStore } = await import('./useEditorStore');

const shot = {
  path: '/media/a.mp4',
  clipId: 'clip-a',
  width: 1920,
  height: 1080,
  fps: 30,
  frameCount: 300,
  durationSecs: 10,
  frame: 0,
  codec: 'h264',
  colorSpace: 'bt709',
};
const session = { shots: [shot], active: 0, count: 1 };
const loaded = { width: 1920, height: 1080, metadata: {}, exif: {}, is_raw: false };
const dto = (withLoaded: boolean) => ({
  projectPath: '/projects/p.chroma',
  name: 'p',
  gradeDir: '/projects/p.chroma/grades',
  schema: 'chroma.project/1',
  shots: [{ id: 'clip-a', sourcePath: '/media/a.mp4', name: 'a', frame: 0, offline: false }],
  activeShot: 0,
  settings: {},
  loaded: withLoaded ? loaded : null,
});

const calls = (cmd: string) => invoke.mock.calls.filter(([c]) => c === cmd);

function respond(withLoaded: boolean) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'chroma_project_open') return dto(withLoaded);
    if (cmd === 'chroma_session_list') return session;
    if (cmd === 'chroma_load_grades') return { grades: {}, errors: {} };
    if (cmd === 'chroma_session_set_active') return { session, loaded };
    return null;
  });
}

const INITIAL = useSessionStore.getState();
beforeEach(() => {
  invoke.mockReset();
  useSessionStore.setState({ ...INITIAL, shots: [], grades: {}, busy: false, lock: null, projectPath: null, projectName: null, coloristFramePending: false });
  useEditorStore.getState().setEditor({ selectedImage: null });
});

describe('the Colorist frame on open (B-369, D-439)', () => {
  it('opened on Edit: the frame is deferred, then decoded once on first use', async () => {
    useShellStore.setState({ activeTab: 'edit' });
    respond(false);
    const res = await useSessionStore.getState().openProject('/projects/p.chroma');
    expect(res.ok).toBe(true);
    expect(calls('chroma_project_open')[0][1]).toMatchObject({ deferColoristFrame: true });
    expect(useSessionStore.getState().coloristFramePending).toBe(true);
    expect(calls('chroma_session_set_active')).toHaveLength(0);
    expect(useEditorStore.getState().selectedImage).toBeNull();

    // the tab and an agent op asking together: one decode
    const [a, b] = await Promise.all([
      useSessionStore.getState().ensureColoristFrame(),
      useSessionStore.getState().ensureColoristFrame(),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(calls('chroma_session_set_active')).toHaveLength(1);
    expect(useSessionStore.getState().coloristFramePending).toBe(false);
    expect(useEditorStore.getState().selectedImage?.path).toBe('/media/a.mp4');

    await useSessionStore.getState().ensureColoristFrame();
    expect(calls('chroma_session_set_active')).toHaveLength(1);
  });

  it('opened on Colorist: the open installs the frame and it is not decoded again', async () => {
    useShellStore.setState({ activeTab: 'colorist' });
    respond(true);
    await useSessionStore.getState().openProject('/projects/p.chroma');
    expect(calls('chroma_project_open')[0][1]).toMatchObject({ deferColoristFrame: false });
    expect(calls('chroma_session_set_active')).toHaveLength(0);
    expect(useSessionStore.getState().coloristFramePending).toBe(false);
    expect(useEditorStore.getState().selectedImage?.path).toBe('/media/a.mp4');
  });

  it('closing the project forgets a pending frame', async () => {
    useShellStore.setState({ activeTab: 'edit' });
    respond(false);
    await useSessionStore.getState().openProject('/projects/p.chroma');
    await useSessionStore.getState().closeProject();
    expect(useSessionStore.getState().coloristFramePending).toBe(false);
  });
});
