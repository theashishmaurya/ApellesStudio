// B-356 — the `close_project` op: the "‹ Projects" button as an MCP tool.
// Driven through the real `useSessionStore`, so it pins that the op and the
// button share one store action (and its unsaved-work behaviour).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@apelles/bridge', () => ({ trackEvent: vi.fn() }));

const { useSessionStore } = await import('../store/useSessionStore');
const { closeProjectOp } = await import('./projectOps');

const INITIAL = useSessionStore.getState();

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(null);
  useSessionStore.setState({
    ...INITIAL,
    shots: [],
    busy: false,
    lock: null,
    projectPath: null,
    projectName: null,
    dirty: false,
  });
});

describe('closeProjectOp (B-356)', () => {
  it('closes the open project, tells Rust, and reports its path', async () => {
    useSessionStore.setState({ projectPath: '/p/a.chroma', projectName: 'a', dirty: false });
    await expect(closeProjectOp()).resolves.toEqual({ closed: '/p/a.chroma' });
    expect(useSessionStore.getState().projectPath).toBeNull();
    expect(invoke).toHaveBeenCalledWith('chroma_project_close');
  });

  it('is a no-op with closed: null when nothing is open', async () => {
    await expect(closeProjectOp()).resolves.toEqual({ closed: null });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('saves a dirty, named project first, exactly as the button does', async () => {
    useSessionStore.setState({ projectPath: '/p/b.chroma', projectName: 'b', dirty: true });
    await closeProjectOp();
    const cmds = invoke.mock.calls.map((c) => c[0]);
    expect(cmds).toContain('chroma_project_save');
    expect(cmds.indexOf('chroma_project_save')).toBeLessThan(cmds.indexOf('chroma_project_close'));
  });

  it('does not save an unsaved Untitled session (the button discards it too)', async () => {
    useSessionStore.setState({ projectPath: '/p/u.chroma', projectName: 'Untitled', dirty: true });
    await closeProjectOp();
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain('chroma_project_save');
  });
});
