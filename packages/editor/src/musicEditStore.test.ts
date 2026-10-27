/**
 * D-408 — the music-edit review list's lifecycle: replace, review, adjust,
 * add, apply-removes, and dropped on a project switch.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { useMusicEditStore } from './musicEditStore';
import { useEditorTimelineStore } from './timelineStore';
import type { MusicEditProposalSet, MusicEditRow } from './musicEdits';

const row = (id: string, start: number): MusicEditRow => ({
  id,
  kind: 'dropout',
  origin: 'ai',
  status: 'pending',
  start,
  end: start + 10,
  fadeOutFrames: 6,
  fadeInFrames: 8,
  mode: 'continuous',
});

const set = (rows: MusicEditRow[]): MusicEditProposalSet => ({ timelineId: 'tl', track: 1, receivedAt: 0, rows, nextId: 0 });
const rows = () => useMusicEditStore.getState().proposals[1]?.rows ?? [];

beforeEach(() => useMusicEditStore.getState().clear());

describe('useMusicEditStore', () => {
  it('a proposal replaces the track\'s set; an empty one clears it', () => {
    const s = useMusicEditStore.getState();
    s.setProposals(1, set([row('a0', 10), row('a1', 50)]));
    s.setProposals(1, set([row('a0', 90)]));
    expect(rows().map((r) => r.start)).toEqual([90]);
    s.setProposals(1, set([]));
    expect(useMusicEditStore.getState().proposals[1]).toBeUndefined();
  });

  it('reviews rows one by one or every pending row at once', () => {
    const s = useMusicEditStore.getState();
    s.setProposals(1, set([row('a0', 10), row('a1', 50), row('a2', 90)]));
    s.setRowStatus(1, 'a1', 'rejected');
    s.setAllPending(1, 'accepted');
    expect(rows().map((r) => r.status)).toEqual(['accepted', 'rejected', 'accepted']);
  });

  it('an adjustment keeps frames whole and the range non-empty', () => {
    const s = useMusicEditStore.getState();
    s.setProposals(1, set([row('a0', 10)]));
    s.patchRow(1, 'a0', { start: 30.4, end: 12, fadeOutFrames: -3 });
    expect(rows()[0]).toMatchObject({ start: 30, end: 31, fadeOutFrames: 0 });
  });

  it('a person\'s row creates the set when there is none, with its own id', () => {
    const s = useMusicEditStore.getState();
    const id = s.addRow(1, 'tl', { ...row('ignored', 10), origin: 'person' });
    const id2 = useMusicEditStore.getState().addRow(1, 'tl', { ...row('ignored', 40), origin: 'person' });
    expect([id, id2]).toEqual(['p0', 'p1']);
    expect(rows().map((r) => r.origin)).toEqual(['person', 'person']);
  });

  it('removing the last rows drops the set', () => {
    const s = useMusicEditStore.getState();
    s.setProposals(1, set([row('a0', 10)]));
    s.removeRows(1, ['a0']);
    expect(useMusicEditStore.getState().proposals[1]).toBeUndefined();
  });

  it('is dropped when the open project changes', () => {
    useEditorTimelineStore.setState({ openProjectKey: '/a.chroma' });
    useMusicEditStore.getState().setProposals(1, set([row('a0', 10)]));
    useEditorTimelineStore.setState({ openProjectKey: '/b.chroma' });
    expect(useMusicEditStore.getState().proposals).toEqual({});
  });
});
