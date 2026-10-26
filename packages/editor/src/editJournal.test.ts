// @apelles/editor — the Edit timeline's write-ahead journal (B-274, D-402).
//
// Two tiers. `replayJournal` is a pure fold with exact answers. The store tier
// simulates the incident itself: a page makes edits, is killed inside the
// save debounce (its module state is thrown away with `vi.resetModules`, the
// pending timer never fires), and a fresh page loads the same project from a
// fake backend that keeps `project.json` and the journal exactly the way the
// Rust side does (`chroma::edit_journal::record_save`).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyOp, type Clip, type EditOp, type Timeline } from './timeline';
import { isJournalEntry, replayJournal, type EditJournalEntry } from './editJournal';

const clip = (id: string, start: number): Clip => ({
  id,
  name: id,
  source_path: `/m/${id}.mov`,
  source_start: 0,
  duration: 24,
  source_len: 240,
  start_frame: start,
});

const base = (): Timeline => ({
  id: 'tl-1',
  name: 'Timeline 1',
  rate: { num: 24, den: 1 },
  tracks: [{ kind: 'video', clips: [clip('a', 0)] }],
});

const addOp = (id: string, startFrame: number): EditOp => ({
  kind: 'add_clip',
  track: 0,
  clip: { id, name: id, source_path: `/m/${id}.mov`, source_start: 0, duration: 24, source_len: 240 },
  startFrame,
});

const opEntry = (seq: number, op: EditOp, timelineId = 'tl-1'): EditJournalEntry => ({ seq, timelineId, kind: 'op', op });

describe('replayJournal (D-402)', () => {
  it('applies only the entries after the saved sequence, in sequence order', () => {
    const out = replayJournal(base(), {
      savedSeq: 1,
      // file order is not sequence order (appends can land out of order)
      entries: [opEntry(3, addOp('c', 48)), opEntry(1, addOp('old', 200)), opEntry(2, addOp('b', 24))],
    });
    expect(out.applied).toBe(2);
    expect(out.timeline.tracks[0].clips.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(out.lastSeq).toBe(3);
  });

  it('is exactly the edits the store made, through the same reducer', () => {
    const ops = [addOp('b', 24), addOp('c', 48), { kind: 'remove', track: 0, clip: 0 } as EditOp];
    const direct = ops.reduce((tl, op) => applyOp(tl, op), base());
    const replayed = replayJournal(base(), { savedSeq: null, entries: ops.map((op, i) => opEntry(i + 1, op)) });
    expect(replayed.timeline).toEqual(direct);
  });

  it("ignores another timeline's entries but still counts their numbers", () => {
    const out = replayJournal(base(), { savedSeq: 0, entries: [opEntry(5, addOp('x', 24), 'tl-2')] });
    expect(out.applied).toBe(0);
    expect(out.timeline).toEqual(base());
    expect(out.lastSeq).toBe(5);
  });

  it('a snapshot entry (an undo/redo) replaces the timeline', () => {
    const snap = { ...base(), tracks: [{ kind: 'video' as const, clips: [] }] };
    const out = replayJournal(base(), {
      savedSeq: null,
      entries: [opEntry(1, addOp('b', 24)), { seq: 2, timelineId: 'tl-1', kind: 'snapshot', timeline: snap }],
    });
    expect(out.timeline).toEqual(snap);
    expect(out.applied).toBe(2);
  });

  it('counts an entry the reducer refuses instead of hiding it', () => {
    // frames 0-23 are already covered by "a": refused (B-131)
    const out = replayJournal(base(), { savedSeq: null, entries: [opEntry(1, addOp('clash', 0))] });
    expect(out.applied).toBe(0);
    expect(out.skipped).toBe(1);
  });

  it('rejects malformed lines read back from disk', () => {
    expect(isJournalEntry(opEntry(1, addOp('b', 24)))).toBe(true);
    expect(isJournalEntry({ seq: 0, timelineId: 't', kind: 'op', op: {} })).toBe(false);
    expect(isJournalEntry({ seq: 1, timelineId: 't', kind: 'op' })).toBe(false);
    expect(isJournalEntry({ seq: 1, kind: 'op', op: {} })).toBe(false);
    expect(isJournalEntry(null)).toBe(false);
  });
});

// --------------------------------------------------------------------------- //
// the incident: a reload inside the save debounce
// --------------------------------------------------------------------------- //

/** The backend as the Rust side keeps it: `project.json`'s active timeline and
 *  recorded sequence, plus the journal lines. Survives a "reload" because the
 *  Rust process does. */
const disk = vi.hoisted(() => ({
  timeline: null as unknown,
  savedSeq: null as number | null,
  journal: [] as { seq: number }[],
  calls: [] as string[],
  /** a save that never comes back: the page dies with it in flight */
  saveHangs: false,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    disk.calls.push(cmd);
    switch (cmd) {
      case 'chroma_timeline_get':
        return structuredClone(disk.timeline);
      case 'chroma_timeline_list':
        return [];
      case 'chroma_edit_journal_append':
        disk.journal.push(structuredClone(args?.entry) as { seq: number });
        return null;
      case 'chroma_edit_journal_read':
        return { savedSeq: disk.savedSeq, entries: structuredClone(disk.journal) };
      case 'chroma_timeline_set': {
        if (disk.saveHangs) return new Promise(() => {});
        // `chroma::edit_journal::record_save` + `compact_after_save`.
        disk.timeline = structuredClone(args?.timeline);
        const given = typeof args?.journalSeq === 'number' ? args.journalSeq : null;
        const through = given ?? (disk.journal.length ? Math.max(...disk.journal.map((e) => e.seq)) : null);
        if (through !== null) {
          disk.savedSeq = Math.max(disk.savedSeq ?? 0, through);
          disk.journal = disk.journal.filter((e) => e.seq > (disk.savedSeq ?? 0));
        }
        return null;
      }
      default:
        throw new Error(`no stub for ${cmd}`);
    }
  },
}));

const PROJECT = '/projects/demo.chroma';

/** Drain the promise chains a fake-backend round trip is made of. Timers are
 *  faked (the debounce must never fire on its own: that is the incident), so
 *  this flushes microtasks only, never waits on a clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** A fresh page: fresh module state, the project opened, its first load done. */
async function openPage() {
  vi.resetModules();
  const { useEditorTimelineStore } = await import('./timelineStore');
  useEditorTimelineStore.getState().setOpenProject(PROJECT);
  await settle();
  expect(useEditorTimelineStore.getState().status).toBe('ready');
  return useEditorTimelineStore;
}

// Each simulated page re-evaluates the store's whole module graph
// (`vi.resetModules`), which under a full parallel run can take seconds, hence
// the longer per-test budget. The test itself never waits on a clock.
describe('a reload inside the save debounce (B-274)', { timeout: 60_000 }, () => {
  beforeEach(() => {
    disk.timeline = base();
    disk.savedSeq = null;
    disk.journal = [];
    disk.calls = [];
    disk.saveHangs = false;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('loses nothing: the next page replays every unsaved edit and saves it', async () => {
    const page1 = await openPage();
    page1.getState().applyOp(addOp('b', 24));
    page1.getState().applyOp(addOp('c', 48));
    page1.getState().applyOp({ kind: 'set_track_gain', track: 0, gain: 0.5 });
    const onScreen = page1.getState().timeline;
    // The edits are journalled, but the debounced save never ran.
    await settle();
    expect(disk.journal).toHaveLength(3);
    expect(disk.calls).not.toContain('chroma_timeline_set');
    expect(disk.timeline).toEqual(base());

    // The web content process dies: its timer never fires, its memory is gone.
    vi.clearAllTimers();

    const page2 = await openPage();
    expect(page2.getState().timeline).toEqual(onScreen);
    expect(page2.getState().recoveredEdits).toBe(3);
    // ...and the replayed edits are saved straight away, journal compacted.
    await settle();
    expect(disk.timeline).toEqual(onScreen);
    expect(disk.savedSeq).toBe(3);
    expect(disk.journal).toEqual([]);
  });

  it('never applies an edit twice: a reload after a save replays nothing', async () => {
    const page1 = await openPage();
    page1.getState().applyOp(addOp('b', 24));
    await page1.getState().flushPendingSave();
    const saved = page1.getState().timeline;
    expect(disk.savedSeq).toBe(1);

    const page2 = await openPage();
    expect(page2.getState().timeline).toEqual(saved);
    expect(page2.getState().recoveredEdits).toBe(0);
  });

  it('continues the numbering, so a second crash replays the second page too', async () => {
    const page1 = await openPage();
    page1.getState().applyOp(addOp('b', 24));
    vi.clearAllTimers();

    const page2 = await openPage();
    // page 2's own replay save has not landed yet when it edits again
    page2.getState().applyOp(addOp('c', 48));
    const onScreen = page2.getState().timeline;
    await settle();
    expect(disk.journal.map((e) => e.seq)).toContain(2);
    vi.clearAllTimers();

    const page3 = await openPage();
    expect(page3.getState().timeline).toEqual(onScreen);
  });

  it('journals an undo as the snapshot it restores, so an undo whose save was in flight survives', async () => {
    const page1 = await openPage();
    page1.getState().applyOp(addOp('b', 24));
    disk.saveHangs = true; // the undo's immediate save never lands
    page1.getState().restoreSnapshot(base());
    await settle();
    expect(disk.journal.map((e) => e.seq)).toEqual([1, 2]);
    vi.clearAllTimers();

    disk.saveHangs = false;

    const page2 = await openPage();
    expect(page2.getState().timeline).toEqual(base());
    expect(page2.getState().recoveredEdits).toBe(2);
  });
});
