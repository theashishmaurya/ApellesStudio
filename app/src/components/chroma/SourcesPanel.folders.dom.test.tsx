// @vitest-environment jsdom
/**
 * SourcesPanel's collapsible folder list on real DOM (D-436): the caret
 * toggles the whole list, the "All media" / folder labels still select, the
 * tree-view arrow keys work, the open flag is the shell-store flag the debug
 * ops drive, the collapsed header names the selected folder, and the list /
 * grid split is a real resizable handle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { useMediaPoolStore } from '@apelles/bridge';
import { useShellStore } from '@apelles/shell';

import { useSessionStore } from '../../store/useSessionStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock('./ProjectLauncher', () => ({ pickClips: vi.fn() }));

import { SourcesPanel } from './SourcesPanel';

const SHELL_INITIAL = useShellStore.getState();
const POOL_INITIAL = useMediaPoolStore.getState();
const SESSION_INITIAL = useSessionStore.getState();

let restoreRO: () => void;

beforeEach(() => {
  const g = globalThis as unknown as { ResizeObserver?: unknown };
  const had = 'ResizeObserver' in g;
  const original = g.ResizeObserver;
  g.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  restoreRO = () => {
    if (had) g.ResizeObserver = original;
    else delete g.ResizeObserver;
  };
  useShellStore.setState({ ...SHELL_INITIAL, sourcesFoldersOpen: true });
  useSessionStore.setState({ ...SESSION_INITIAL, projectName: 'p', projectPath: '/p.chroma' });
  useMediaPoolStore.setState({
    ...POOL_INITIAL,
    items: [],
    folders: ['Music', 'Music/Loops', 'SFX'],
    loading: false,
    openProjectKey: 'k',
  });
});

afterEach(() => {
  cleanup();
  restoreRO();
});

const caret = () => screen.getByRole('button', { name: /(Collapse|Expand) folders/ });
const folderRow = (name: string) => screen.getByText(name).closest('[role="button"]') as HTMLElement;
const pane = () => document.querySelector('[data-chroma-folders-pane]');

describe('SourcesPanel folder list (D-436)', () => {
  it('the caret collapses and re-expands the whole folder list', () => {
    render(<SourcesPanel />);
    expect(pane()).toBeTruthy();
    expect(screen.getByText('Music')).toBeTruthy();
    expect(caret().getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(caret());
    expect(pane()).toBeNull();
    expect(screen.queryByText('SFX')).toBeNull();
    expect(caret().getAttribute('aria-expanded')).toBe('false');
    expect(useShellStore.getState().sourcesFoldersOpen).toBe(false);

    fireEvent.click(caret());
    expect(screen.getByText('SFX')).toBeTruthy();
  });

  it('clicking a label still selects the folder, and does not collapse the list', () => {
    render(<SourcesPanel />);
    fireEvent.click(folderRow('SFX'));
    expect(folderRow('SFX').className).toContain('bg-accent/15');
    expect(pane()).toBeTruthy();
    fireEvent.click(screen.getByText('All media'));
    expect(folderRow('SFX').className).not.toContain('bg-accent/15');
  });

  it('the collapsed header shows the selected folder, and nothing for All media', () => {
    render(<SourcesPanel />);
    fireEvent.click(folderRow('SFX'));
    fireEvent.click(caret());
    expect(document.querySelector('[data-chroma-active-folder]')?.textContent).toBe('SFX');
    fireEvent.click(caret());
    expect(document.querySelector('[data-chroma-active-folder]')).toBeNull();
  });

  it('ArrowLeft / ArrowRight collapse and expand a nested folder row', () => {
    render(<SourcesPanel />);
    expect(screen.getByText('Loops')).toBeTruthy();
    fireEvent.keyDown(folderRow('Music'), { key: 'ArrowLeft' });
    expect(screen.queryByText('Loops')).toBeNull();
    fireEvent.keyDown(folderRow('Music'), { key: 'ArrowRight' });
    expect(screen.getByText('Loops')).toBeTruthy();
  });

  it('ArrowLeft / ArrowRight on All media collapse and expand the whole list', () => {
    render(<SourcesPanel />);
    fireEvent.keyDown(screen.getByText('All media'), { key: 'ArrowLeft' });
    expect(pane()).toBeNull();
    fireEvent.keyDown(screen.getByText('All media'), { key: 'ArrowRight' });
    expect(pane()).toBeTruthy();
  });

  it('a collapsed nested folder stays collapsed across collapsing the whole list', () => {
    render(<SourcesPanel />);
    fireEvent.keyDown(folderRow('Music'), { key: 'ArrowLeft' });
    fireEvent.click(caret());
    fireEvent.click(caret());
    expect(screen.queryByText('Loops')).toBeNull();
  });

  it('follows the shell-store flag the debug ops drive (op proven in @apelles/debug)', () => {
    render(<SourcesPanel />);
    act(() => useShellStore.getState().setSourcesFoldersOpen(false));
    expect(pane()).toBeNull();
    act(() => useShellStore.getState().setSourcesFoldersOpen(true));
    expect(pane()).toBeTruthy();
  });

  it('the list / grid split is a real resize handle, present only while expanded', () => {
    render(<SourcesPanel />);
    expect(document.querySelector('[data-slot="resizable-handle"]')).toBeTruthy();
    fireEvent.click(caret());
    expect(document.querySelector('[data-slot="resizable-handle"]')).toBeNull();
  });
});
