// @apelles/history — unit tests for the shared undo/redo stack (D-051).
// Pure store logic, no DOM/Tauri involved: push/undo/redo/stack-limit have a
// real correct/incorrect answer, so these run for real rather than being
// eyeballed.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_HISTORY_ENTRIES, useHistoryStore } from './store';

function reset() {
  useHistoryStore.setState({ undoStack: [], redoStack: [] });
}

beforeEach(() => {
  reset();
});

describe('push', () => {
  it('adds an entry to the undo stack and clears the redo stack', () => {
    const undo = vi.fn();
    const redo = vi.fn();
    useHistoryStore.getState().push({ tab: 'edit', label: 'Trim clip', undo, redo });

    const s = useHistoryStore.getState();
    expect(s.undoStack).toHaveLength(1);
    expect(s.undoStack[0].label).toBe('Trim clip');
    expect(s.undoStack[0].tab).toBe('edit');
    expect(s.redoStack).toHaveLength(0);
  });

  it('auto-fills id and ts when not supplied', () => {
    useHistoryStore.getState().push({ tab: 'edit', label: 'a', undo: vi.fn(), redo: vi.fn() });
    useHistoryStore.getState().push({ tab: 'edit', label: 'b', undo: vi.fn(), redo: vi.fn() });
    const [a, b] = useHistoryStore.getState().undoStack;
    expect(a.id).toBeTruthy();
    expect(b.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
    expect(typeof a.ts).toBe('number');
  });

  it('clears an existing redo stack — a new edit invalidates the redo branch', () => {
    const store = useHistoryStore.getState();
    store.push({ tab: 'colorist', label: 'edit 1', undo: vi.fn(), redo: vi.fn() });
    store.undo();
    expect(useHistoryStore.getState().redoStack).toHaveLength(1);

    store.push({ tab: 'colorist', label: 'edit 2', undo: vi.fn(), redo: vi.fn() });
    expect(useHistoryStore.getState().redoStack).toHaveLength(0);
  });

  it('caps the undo stack at MAX_HISTORY_ENTRIES, dropping the oldest', () => {
    const store = useHistoryStore.getState();
    for (let i = 0; i < MAX_HISTORY_ENTRIES + 10; i++) {
      store.push({ tab: 'edit', label: `edit ${i}`, undo: vi.fn(), redo: vi.fn() });
    }
    const s = useHistoryStore.getState();
    expect(s.undoStack).toHaveLength(MAX_HISTORY_ENTRIES);
    // the oldest 10 were dropped — the stack now starts at "edit 10"
    expect(s.undoStack[0].label).toBe('edit 10');
    expect(s.undoStack[s.undoStack.length - 1].label).toBe(`edit ${MAX_HISTORY_ENTRIES + 9}`);
  });
});

describe('undo / redo', () => {
  it('undo() calls the entry\'s undo() and moves it to the redo stack', () => {
    const undo = vi.fn();
    const redo = vi.fn();
    useHistoryStore.getState().push({ tab: 'motion', label: 'x', undo, redo });

    const entry = useHistoryStore.getState().undo();

    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).not.toHaveBeenCalled();
    expect(entry?.label).toBe('x');
    expect(useHistoryStore.getState().undoStack).toHaveLength(0);
    expect(useHistoryStore.getState().redoStack).toHaveLength(1);
  });

  it('redo() calls the entry\'s redo() and moves it back to the undo stack', () => {
    const undo = vi.fn();
    const redo = vi.fn();
    useHistoryStore.getState().push({ tab: 'colorist', label: 'y', undo, redo });
    useHistoryStore.getState().undo();

    const entry = useHistoryStore.getState().redo();

    expect(redo).toHaveBeenCalledTimes(1);
    expect(entry?.label).toBe('y');
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
    expect(useHistoryStore.getState().redoStack).toHaveLength(0);
  });

  it('undo() on an empty stack is a no-op and returns null', () => {
    expect(useHistoryStore.getState().undo()).toBeNull();
  });

  it('redo() on an empty stack is a no-op and returns null', () => {
    expect(useHistoryStore.getState().redo()).toBeNull();
  });

  it('undoes/redoes across tabs in strict LIFO order regardless of which tab pushed', () => {
    const calls: string[] = [];
    const store = useHistoryStore.getState();
    store.push({ tab: 'edit', label: 'e1', undo: () => calls.push('undo e1'), redo: () => calls.push('redo e1') });
    store.push({
      tab: 'colorist',
      label: 'c1',
      undo: () => calls.push('undo c1'),
      redo: () => calls.push('redo c1'),
    });

    const first = useHistoryStore.getState().undo();
    expect(first?.tab).toBe('colorist');
    const second = useHistoryStore.getState().undo();
    expect(second?.tab).toBe('edit');
    expect(calls).toEqual(['undo c1', 'undo e1']);

    useHistoryStore.getState().redo();
    expect(calls).toEqual(['undo c1', 'undo e1', 'redo e1']);
  });
});

describe('canUndo / canRedo / peek', () => {
  it('report stack availability and top-of-stack without popping', () => {
    const store = useHistoryStore.getState();
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(false);

    store.push({ tab: 'edit', label: 'only', undo: vi.fn(), redo: vi.fn() });
    expect(useHistoryStore.getState().canUndo()).toBe(true);
    expect(useHistoryStore.getState().peekUndo()?.label).toBe('only');
    expect(useHistoryStore.getState().peekRedo()).toBeNull();

    useHistoryStore.getState().undo();
    expect(useHistoryStore.getState().canUndo()).toBe(false);
    expect(useHistoryStore.getState().canRedo()).toBe(true);
    expect(useHistoryStore.getState().peekRedo()?.label).toBe('only');
  });
});

describe('clear', () => {
  it('drops both stacks', () => {
    const store = useHistoryStore.getState();
    store.push({ tab: 'edit', label: 'a', undo: vi.fn(), redo: vi.fn() });
    store.undo();
    store.clear();
    const s = useHistoryStore.getState();
    expect(s.undoStack).toHaveLength(0);
    expect(s.redoStack).toHaveLength(0);
  });
});
