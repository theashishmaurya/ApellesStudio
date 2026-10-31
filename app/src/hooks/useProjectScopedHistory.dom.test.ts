// @vitest-environment jsdom
/**
 * B-343 — undo history is per project. Drives the hook with the project key the
 * way `Root` does, and reads the history through `stepHistory`, the one function
 * behind both Cmd+Z and the MCP `undo` / `redo` tools.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';

import { useHistoryStore } from '@apelles/history';
import { stepHistory } from '@apelles/shell';

import { useProjectScopedHistory } from './useProjectScopedHistory';

const INITIAL = useHistoryStore.getState();

beforeEach(() => {
  useHistoryStore.setState({ ...INITIAL, undoStack: [], redoStack: [] });
});
afterEach(cleanup);

const edit = (label: string) => {
  const undo = vi.fn();
  useHistoryStore.getState().push({ tab: 'edit', label, undo, redo: vi.fn() });
  return undo;
};

describe('useProjectScopedHistory (B-343)', () => {
  it('open A, edit, open B: undo in B finds nothing and touches nothing of A', () => {
    const { rerender } = renderHook(({ key }) => useProjectScopedHistory(key), { initialProps: { key: 'A' as string | null } });
    const undoInA = edit('Trim clip');
    edit('Split clip');
    rerender({ key: 'B' });

    const step = stepHistory('undo');
    expect(step.entry).toBeNull();
    expect(step.canUndo).toBe(false);
    expect(step.undoLabel).toBeNull();
    expect(undoInA).not.toHaveBeenCalled();
  });

  it('reopening A starts clean: undo does not persist across opens', () => {
    const { rerender } = renderHook(({ key }) => useProjectScopedHistory(key), { initialProps: { key: 'A' as string | null } });
    edit('Trim clip');
    rerender({ key: 'B' });
    rerender({ key: 'A' });
    expect(useHistoryStore.getState().canUndo()).toBe(false);
    expect(stepHistory('redo').entry).toBeNull();
  });

  it('also empties on close, and keeps history while the same project stays open', () => {
    const { rerender } = renderHook(({ key }) => useProjectScopedHistory(key), { initialProps: { key: 'A' as string | null } });
    edit('one');
    rerender({ key: 'A' });
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
    rerender({ key: null });
    expect(useHistoryStore.getState().undoStack).toHaveLength(0);
  });

  it('does not clear on mount: opening the app on a project is not a switch', () => {
    edit('made before the hook mounted');
    renderHook(() => useProjectScopedHistory('A'));
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
  });
});
