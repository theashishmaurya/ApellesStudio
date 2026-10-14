// stepHistory — the shared undo/redo-and-follow step (D-051, D-383). Pure store
// logic: which tab the shell lands on, and what the result reports, have
// correct answers.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useHistoryStore } from '@apelles/history';
import { useShellStore } from './store';
import { stepHistory } from './historyStep';

beforeEach(() => {
  useHistoryStore.setState({ undoStack: [], redoStack: [] });
  useShellStore.setState({ activeTab: 'edit' });
});

describe('stepHistory', () => {
  it('on an empty stack reports a null entry and changes nothing', () => {
    const r = stepHistory('undo');
    expect(r.entry).toBeNull();
    expect(r.activeTab).toBe('edit');
    expect(r.canUndo).toBe(false);
    expect(r.canRedo).toBe(false);
  });

  it('undoes the top entry, follows it to its tab, and offers it for redo', () => {
    const undo = vi.fn();
    useHistoryStore.getState().push({ tab: 'colorist', label: 'primary: exposure', undo, redo: vi.fn() });
    const r = stepHistory('undo');
    expect(undo).toHaveBeenCalledOnce();
    expect(r.entry).toEqual({ tab: 'colorist', label: 'primary: exposure' });
    expect(r.activeTab).toBe('colorist');
    expect(r.canUndo).toBe(false);
    expect(r.canRedo).toBe(true);
    expect(r.redoLabel).toBe('primary: exposure');
  });

  it('redo reapplies and reports the next undo label', () => {
    const redo = vi.fn();
    useHistoryStore.getState().push({ tab: 'edit', label: 'Ripple delete', undo: vi.fn(), redo });
    stepHistory('undo');
    const r = stepHistory('redo');
    expect(redo).toHaveBeenCalledOnce();
    expect(r.entry?.label).toBe('Ripple delete');
    expect(r.undoLabel).toBe('Ripple delete');
    expect(r.canRedo).toBe(false);
  });

  it('does not switch to a tab outside the caller registry, but still undoes', () => {
    const undo = vi.fn();
    useHistoryStore.getState().push({ tab: 'motion', label: 'x', undo, redo: vi.fn() });
    const r = stepHistory('undo', ['edit']);
    expect(undo).toHaveBeenCalledOnce();
    expect(r.activeTab).toBe('edit');
  });
});
