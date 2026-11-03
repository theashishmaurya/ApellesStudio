// @vitest-environment jsdom
/**
 * v0.3.0 (B-359 item 3) — the Sources panel inside the Edit browser: no
 * "SOURCES · Select · Import" row of its own (Import is on the browser's tab
 * row), the "All media" row carries the item count and the Select toggle, and
 * the tab-row Import imports into the bin the grid is showing — the same bin
 * the panel's own Import (the Motion / Colorist column) uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { useMediaPoolStore, type MediaItem } from '@apelles/bridge';
import { useShellStore } from '@apelles/shell';
import { TooltipProvider } from '@apelles/ui';

import { useSessionStore } from '../../store/useSessionStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));
const picker = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('./ProjectLauncher', () => ({ pickClips: vi.fn(async () => picker.paths) }));

import { SourcesPanel } from './SourcesPanel';
import { SourcesImportButton } from './SourcesImportButton';

const SHELL_INITIAL = useShellStore.getState();
const POOL_INITIAL = useMediaPoolStore.getState();
const SESSION_INITIAL = useSessionStore.getState();

const item = (id: string, folder: string | null = null): MediaItem => ({
  id,
  sourcePath: `/m/${id}.mp4`,
  name: `${id}.mp4`,
  added: '2026-11-03T00:00:00Z',
  offline: false,
  folder,
  video: { width: 1920, height: 1080, fps: 24, frameCount: 48, durationSecs: 2 },
});

let restoreRO: () => void;
let importCalls: Array<{ paths: string[]; folder?: string }>;

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
  importCalls = [];
  useShellStore.setState({ ...SHELL_INITIAL, sourcesFoldersOpen: true, sourcesActiveFolder: null });
  useSessionStore.setState({ ...SESSION_INITIAL, projectName: 'p', projectPath: '/p.chroma' });
  useMediaPoolStore.setState({
    ...POOL_INITIAL,
    items: [item('a'), item('b'), item('c', 'Music')],
    folders: ['Music'],
    loading: false,
    openProjectKey: 'k',
    importPaths: async (paths: string[], folder?: string) => {
      importCalls.push({ paths, folder });
      return { ok: true, added: paths.map((p) => item(p)) };
    },
  });
});

afterEach(() => {
  cleanup();
  restoreRO();
});

describe('SourcesPanel in the Edit browser (v0.3.0)', () => {
  it('has no header row of its own; the panel variant keeps it', () => {
    const { unmount } = render(<SourcesPanel variant="browser" />);
    expect(screen.queryByText('SOURCES')).toBeNull();
    expect(document.querySelector('[data-chroma-sources-variant="browser"]')).toBeTruthy();
    unmount();
    render(<SourcesPanel />);
    expect(screen.getByText('SOURCES')).toBeTruthy();
  });

  it('the All media row shows the item count, following the bin', () => {
    render(<SourcesPanel variant="browser" />);
    const count = () => document.querySelector('[data-chroma-media-count]')?.textContent;
    expect(count()).toBe('3 items');
    fireEvent.click(screen.getByText('Music'));
    expect(useShellStore.getState().sourcesActiveFolder).toBe('Music');
    expect(count()).toBe('1 item');
  });

  it('Select is a toggle on the All media row and opens the bulk bar', () => {
    render(<SourcesPanel variant="browser" />);
    const toggle = screen.getByTestId('sources-select-toggle');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByTestId('sources-select-toggle').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Select all')).toBeTruthy();
  });

  it('an empty pool is the import target (§4.13): a dashed zone that opens the picker', async () => {
    picker.paths = ['/new/y.mp4'];
    useMediaPoolStore.setState({ items: [] });
    render(<SourcesPanel variant="browser" />);
    const zone = document.querySelector('[data-chroma-empty-state="media"]') as HTMLElement;
    expect(zone.className).toContain('border-dashed');
    expect(zone.textContent).toContain('Import media');
    expect(zone.querySelector('svg')).toBeTruthy();
    await act(async () => {
      fireEvent.click(zone);
    });
    expect(importCalls).toEqual([{ paths: ['/new/y.mp4'], folder: undefined }]);
  });

  it('the tab-row Import imports into the bin the grid is showing', async () => {
    picker.paths = ['/new/x.mp4'];
    render(
      <TooltipProvider>
        <SourcesPanel variant="browser" />
        <SourcesImportButton />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByText('Music'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('browser-import'));
    });
    expect(importCalls).toEqual([{ paths: ['/new/x.mp4'], folder: 'Music' }]);
  });
});
