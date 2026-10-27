// B-277/D-410 — a reloaded page reopens the project and tab the backend still
// remembers; a cold launch reopens nothing; a vanished project falls back to the
// launcher with a reason.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShellTabId } from '@apelles/shell';
import {
  reportActiveTab,
  restoreFailureMessage,
  restorePageSession,
  restorePageSessionOnce,
  type PageSession,
  type PageSessionDeps,
} from './pageSessionRestore';

const PROJECT = { name: 'Fix check (scratch)', path: '/Movies/Chroma/Fix check (scratch).chroma' };

/** The backend's page session plus a page, as plain values. */
function fakePage(session: PageSession | Error, opts: { openFails?: string; openedMeanwhile?: boolean } = {}) {
  let backend = session;
  let tab: ShellTabId = 'edit';
  let open = false;
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const deps: PageSessionDeps = {
    invoke: async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ cmd, args });
      if (backend instanceof Error) throw backend;
      if (cmd === 'chroma_page_session_get') return structuredClone(backend) as T;
      if (cmd === 'chroma_project_close') {
        backend = { ...backend, project: null };
        return null as T;
      }
      return null as T;
    },
    isProjectOpen: () => open,
    openProject: async (path) => {
      opened.push(path);
      if (opts.openedMeanwhile) open = true;
      if (opts.openFails) return { ok: false, error: opts.openFails };
      open = true;
      return { ok: true };
    },
    activeTab: () => tab,
    setActiveTab: (t) => {
      tab = t;
    },
    availableTabs: ['edit', 'motion', 'colorist'],
  };
  return {
    deps,
    calls,
    opened,
    tab: () => tab,
    backend: () => backend,
    setOpen: (v: boolean) => {
      open = v;
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('restorePageSession (B-277)', () => {
  it('a cold launch (nothing remembered) restores nothing and leaves the default tab', async () => {
    const page = fakePage({ project: null, activeTab: null });
    expect(await restorePageSession(page.deps)).toEqual({ kind: 'nothing' });
    expect(page.opened).toEqual([]);
    expect(page.tab()).toBe('edit');
  });

  it('after ‹ Projects the tab is remembered but no project, so nothing reopens', async () => {
    const page = fakePage({ project: null, activeTab: 'colorist' });
    expect((await restorePageSession(page.deps)).kind).toBe('nothing');
    expect(page.tab()).toBe('edit');
  });

  it('a reload reopens the open project on the tab it was left on', async () => {
    const page = fakePage({ project: PROJECT, activeTab: 'motion' });
    expect(await restorePageSession(page.deps)).toEqual({ kind: 'reopened', project: PROJECT, tab: 'motion' });
    expect(page.opened).toEqual([PROJECT.path]);
    expect(page.tab()).toBe('motion');
  });

  it('a remembered tab this build does not show falls back to the current one', async () => {
    const page = fakePage({ project: PROJECT, activeTab: 'motion' });
    page.deps.availableTabs = ['edit', 'colorist'];
    expect(await restorePageSession(page.deps)).toEqual({ kind: 'reopened', project: PROJECT, tab: 'edit' });
  });

  it('never replaces a project this page already opened', async () => {
    const page = fakePage({ project: PROJECT, activeTab: 'colorist' });
    page.setOpen(true);
    expect((await restorePageSession(page.deps)).kind).toBe('already-open');
    expect(page.opened).toEqual([]);
    expect(page.tab()).toBe('edit');
  });

  it('a project moved or deleted meanwhile: fails with the reason, clears the backend, keeps the tab', async () => {
    const page = fakePage(
      { project: PROJECT, activeTab: 'motion' },
      { openFails: 'no project.json in /Movies/Chroma/Fix check (scratch).chroma' },
    );
    const outcome = await restorePageSession(page.deps);
    expect(outcome).toEqual({ kind: 'failed', project: PROJECT, error: expect.stringContaining('no project.json') });
    expect(page.calls.map((c) => c.cmd)).toContain('chroma_project_close');
    expect(page.backend()).toMatchObject({ project: null });
    expect(page.tab()).toBe('edit');
    if (outcome.kind !== 'failed') throw new Error('unreachable');
    const message = restoreFailureMessage(outcome);
    expect(message).toContain('Fix check (scratch)');
    expect(message).toContain('moved or deleted');
  });

  it('a failure because another open won the race does not close that project', async () => {
    const page = fakePage({ project: PROJECT, activeTab: 'edit' }, { openFails: 'session busy', openedMeanwhile: true });
    expect((await restorePageSession(page.deps)).kind).toBe('failed');
    expect(page.calls.map((c) => c.cmd)).not.toContain('chroma_project_close');
  });

  it('a backend that cannot answer restores nothing', async () => {
    const page = fakePage(new Error('ipc down'));
    expect(await restorePageSession(page.deps)).toEqual({ kind: 'nothing' });
  });

  it('runs once per page load however many callers ask (StrictMode double mount)', async () => {
    const page = fakePage({ project: PROJECT, activeTab: 'colorist' });
    const target = {};
    const [a, b] = await Promise.all([
      restorePageSessionOnce(target, page.deps),
      restorePageSessionOnce(target, page.deps),
    ]);
    expect(a).toBe(b);
    expect(page.opened).toEqual([PROJECT.path]);
    // a new page (a new window object) restores again
    page.setOpen(false);
    await restorePageSessionOnce({}, page.deps);
    expect(page.opened).toHaveLength(2);
  });
});

describe('reportActiveTab', () => {
  it('records the tab with the backend', async () => {
    const invoke = vi.fn(async () => null);
    await reportActiveTab(invoke as PageSessionDeps['invoke'], 'colorist');
    expect(invoke).toHaveBeenCalledWith('chroma_page_session_set_tab', { tab: 'colorist' });
  });

  it('swallows a failure (it only costs the tab after a reload)', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('ipc down');
    });
    await expect(reportActiveTab(invoke as PageSessionDeps['invoke'], 'edit')).resolves.toBeUndefined();
  });
});
