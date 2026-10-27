// B-277/D-410 — the whole reload path through the real stores: a new page reads
// the backend's page session, reopens the project through the real
// `useSessionStore.openProject`, hands its identity to the real Edit timeline
// store (what `Root.tsx`'s bridge does), and that store's first load replays the
// edit journal the dead page left. The backend is faked the way the Rust process
// keeps it: it outlives the page, so its open project and journal survive.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Timeline } from '@apelles/editor';

const PROJECT_PATH = '/Movies/Chroma/Fix check (scratch).chroma';

const timeline = (): Timeline => ({
  id: 't1',
  name: 'Main',
  rate: { num: 24, den: 1 },
  tracks: [
    {
      kind: 'audio',
      clips: [{ id: 'bed', name: 'bed', source_path: '/bed.wav', source_start: 0, duration: 96, source_len: 96, start_frame: 0 }],
    },
  ],
});

const rust = vi.hoisted(() => ({
  project: null as { name: string; path: string } | null,
  activeTab: null as string | null,
  projectExists: true,
  timeline: null as unknown,
  savedSeq: null as number | null,
  journal: [] as { seq: number }[],
  calls: [] as string[],
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    rust.calls.push(cmd);
    switch (cmd) {
      case 'chroma_page_session_get':
        return { project: rust.project, activeTab: rust.activeTab };
      case 'chroma_page_session_set_tab':
        rust.activeTab = String(args?.tab);
        return null;
      case 'chroma_project_open': {
        const path = String(args?.path);
        if (!rust.projectExists) throw new Error(`no project.json in ${path}`);
        rust.project = { name: 'Fix check (scratch)', path };
        return {
          projectPath: path,
          name: 'Fix check (scratch)',
          gradeDir: `${path}/grades`,
          schema: 'chroma.project/1',
          shots: [],
          activeShot: 0,
          settings: {},
        };
      }
      case 'chroma_project_close':
        rust.project = null;
        return null;
      case 'chroma_session_list':
        return { shots: [], active: 0, count: 0 };
      case 'chroma_timeline_get':
        return structuredClone(rust.timeline);
      case 'chroma_timeline_list':
        return [];
      case 'chroma_edit_journal_read':
        return { savedSeq: rust.savedSeq, entries: structuredClone(rust.journal) };
      case 'chroma_edit_journal_append':
        rust.journal.push(structuredClone(args?.entry) as { seq: number });
        return null;
      case 'chroma_timeline_set': {
        rust.timeline = structuredClone(args?.timeline);
        const through = typeof args?.journalSeq === 'number' ? args.journalSeq : null;
        if (through !== null) {
          rust.savedSeq = Math.max(rust.savedSeq ?? 0, through);
          rust.journal = rust.journal.filter((e) => e.seq > (rust.savedSeq ?? 0));
        }
        return null;
      }
      default:
        return null;
    }
  },
}));

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** A new page: fresh module state for every store, then the restore and the
 *  `Root.tsx` bridge from the session's project identity to the Edit tab. */
async function reloadPage() {
  vi.resetModules();
  const { useSessionStore, selectProjectKey } = await import('../store/useSessionStore');
  const { useEditorTimelineStore } = await import('@apelles/editor');
  const { restorePageSession } = await import('./pageSessionRestore');
  let tab: 'edit' | 'motion' | 'colorist' = 'edit';
  const outcome = await restorePageSession({
    invoke: async (cmd, args) => (await import('@tauri-apps/api/core')).invoke(cmd, args),
    isProjectOpen: () => !!useSessionStore.getState().projectPath,
    openProject: (path) => useSessionStore.getState().openProject(path),
    activeTab: () => tab,
    setActiveTab: (t) => {
      tab = t;
    },
    availableTabs: ['edit', 'motion', 'colorist'],
  });
  useEditorTimelineStore.getState().setOpenProject(selectProjectKey(useSessionStore.getState()));
  await settle();
  return { outcome, tab, session: useSessionStore, timeline: useEditorTimelineStore };
}

beforeEach(() => {
  rust.project = { name: 'Fix check (scratch)', path: PROJECT_PATH };
  rust.activeTab = 'colorist';
  rust.projectExists = true;
  rust.timeline = timeline();
  rust.savedSeq = 2;
  // two edits the dead page journalled but never saved: the bed's volume twice
  rust.journal = [
    { seq: 3, timelineId: 't1', kind: 'op', op: { kind: 'set_clip_audio', track: 0, clip: 0, volume: 0.5 } },
    { seq: 4, timelineId: 't1', kind: 'op', op: { kind: 'set_clip_audio', track: 0, clip: 0, volume: 0.3 } },
  ] as unknown as { seq: number }[];
  rust.calls = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a page reload with a project open (B-277)', { timeout: 60_000 }, () => {
  it('reopens it on the same tab and replays the journal straight away', async () => {
    const page = await reloadPage();
    expect(page.outcome).toMatchObject({ kind: 'reopened', tab: 'colorist' });
    expect(page.tab).toBe('colorist');
    expect(page.session.getState().projectPath).toBe(PROJECT_PATH);
    const t = page.timeline.getState();
    expect(t.status).toBe('ready');
    expect(t.recoveredEdits).toBe(2);
    expect(t.timeline?.tracks[0].clips[0].volume).toBe(0.3);
  });

  it('a cold launch (the backend has no project) stays on the launcher', async () => {
    rust.project = null;
    const page = await reloadPage();
    expect(page.outcome.kind).toBe('nothing');
    expect(page.session.getState().projectPath).toBeNull();
    expect(rust.calls).not.toContain('chroma_project_open');
    expect(page.timeline.getState().recoveredEdits).toBe(0);
  });

  it('a project deleted meanwhile falls back to the launcher and forgets it', async () => {
    rust.projectExists = false;
    const page = await reloadPage();
    expect(page.outcome).toMatchObject({ kind: 'failed', error: expect.stringContaining('no project.json') });
    expect(page.session.getState().projectPath).toBeNull();
    expect(page.tab).toBe('edit');
    expect(rust.project).toBeNull();
    // and the next reload does not try again
    rust.calls = [];
    const again = await reloadPage();
    expect(again.outcome.kind).toBe('nothing');
    expect(rust.calls).not.toContain('chroma_project_open');
  });
});
