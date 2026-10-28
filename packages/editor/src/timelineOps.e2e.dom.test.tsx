// @vitest-environment jsdom
/**
 * D-411 Phase 0 — timeline management end to end at the OP layer: the seven
 * `editor_*_timeline*` ops driven through the real `chroma://request`
 * dispatch `control.rs` uses, the real store actions the timeline switcher's
 * tabs and menu call, the shared undo stack, and the captions op's new
 * `scope: "timeline"`.
 *
 * **Tier and its honest limit.** jsdom, with the backend's timeline commands
 * stubbed by a small in-memory project that behaves like `chroma::edit` +
 * `apelles_project::timeline` (by-id commands, the active INDEX that
 * `chroma_timeline_set` writes to, the delete/activate rules). The Rust rules
 * themselves are pinned in `apelles-project`'s and the app's own tests; what
 * is on trial here is the op contract (arguments, refusals, results), the
 * active-vs-other routing (an op for the open timeline, a command for any
 * other), and B-283's undo across a timeline switch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';

import { createInvokeStub, mount, waitFrames, type MountedComponent } from './testUtils/pointerHarness';

type Tl = {
  id: string;
  name: string;
  rate?: { num: number; den: number } | null;
  tracks: unknown[];
  markers?: unknown[];
  output?: { width: number; height: number };
};

const fake = vi.hoisted(() => ({
  timelines: [] as Tl[],
  active: 0,
  projectSize: { width: 1920, height: 1080 },
  calls: [] as string[],
}));

function byId(id: string): Tl {
  const t = fake.timelines.find((x) => x.id === id);
  if (!t) throw new Error(`no timeline with id ${id}`);
  return t;
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_timeline_get: () => structuredClone(fake.timelines[fake.active]),
    chroma_timeline_set: (a) => {
      fake.calls.push('set');
      fake.timelines[fake.active] = structuredClone((a as { timeline: Tl }).timeline);
    },
    chroma_timeline_list: () =>
      fake.timelines.map((t, i) => ({
        id: t.id,
        name: t.name,
        duration: 0,
        active: i === fake.active,
        output: t.output ?? null,
        origin: null,
        fps: t.rate ? t.rate.num / t.rate.den : 24,
        clipCount: (t.tracks as { clips?: unknown[] }[]).reduce((n, tr) => n + (tr.clips?.length ?? 0), 0),
      })),
    chroma_timeline_create: (a) => {
      const { name, output, activate } = a as { name: string; output: Tl['output'] | null; activate: boolean };
      const tl: Tl = { id: `tl-${fake.timelines.length + 1}`, name, tracks: [], markers: [], ...(output ? { output } : {}) };
      fake.timelines.push(tl);
      if (activate) fake.active = fake.timelines.length - 1;
      return structuredClone(tl);
    },
    chroma_timeline_set_active: (a) => {
      const id = (a as { id: string }).id;
      byId(id);
      fake.active = fake.timelines.findIndex((t) => t.id === id);
    },
    chroma_timeline_get_by_id: (a) => structuredClone(byId((a as { id: string }).id)),
    chroma_timeline_rename: (a) => {
      const { id, name } = a as { id: string; name: string };
      fake.calls.push(`rename:${id}`);
      byId(id).name = name;
    },
    chroma_timeline_set_output: (a) => {
      const { id, output } = a as { id: string; output: Tl['output'] | null };
      fake.calls.push(`set_output:${id}`);
      const t = byId(id);
      if (output) t.output = output;
      else delete t.output;
    },
    chroma_timeline_set_rate: (a) => {
      const { id, fps } = a as { id: string; fps: number };
      fake.calls.push(`set_rate:${id}:${fps}`);
      byId(id).rate = { num: fps, den: 1 };
    },
    chroma_project_set_settings: (a) => {
      fake.calls.push('project_settings');
      return (a as { partial: Record<string, unknown> }).partial;
    },
    chroma_timeline_duplicate: (a) => {
      const { id, name, activate } = a as { id: string; name: string | null; activate: boolean };
      const at = fake.timelines.findIndex((t) => t.id === id);
      const src = byId(id);
      const copy: Tl = { ...structuredClone(src), id: `${id}-copy`, name: name ?? `${src.name} copy` };
      fake.timelines.splice(at + 1, 0, copy);
      if (activate) fake.active = at + 1;
      else if (fake.active > at) fake.active += 1;
      return structuredClone(copy);
    },
    chroma_timeline_delete: (a) => {
      const id = (a as { id: string }).id;
      const at = fake.timelines.findIndex((t) => t.id === id);
      if (at < 0) throw new Error(`no timeline with id ${id}`);
      if (fake.timelines.length <= 1) throw new Error("cannot delete the project's only timeline");
      fake.timelines.splice(at, 1);
      if (fake.active > at) fake.active -= 1;
      else if (fake.active === at) fake.active = Math.min(at, fake.timelines.length - 1);
    },
    chroma_timeline_composition_size: (a) => {
      const id = (a as { timelineId?: string } | undefined)?.timelineId;
      const t = id ? byId(id) : fake.timelines[fake.active];
      const size = t.output ?? fake.projectSize;
      return { compWidth: size.width, compHeight: size.height, naturalWidth: 1, naturalHeight: 1 };
    },
    chroma_edit_journal_append: () => undefined,
    chroma_text_fonts: () => [],
  }),
}));

const bus = vi.hoisted(() => ({
  listeners: new Map<string, Set<(ev: { payload: unknown }) => unknown>>(),
  emitted: [] as { event: string; payload: unknown }[],
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, handler: (ev: { payload: unknown }) => unknown) => {
    const set = bus.listeners.get(event) ?? new Set();
    set.add(handler);
    bus.listeners.set(event, set);
    return Promise.resolve(() => {
      set.delete(handler);
    });
  },
  emit: (event: string, payload: unknown) => {
    bus.emitted.push({ event, payload });
    return Promise.resolve();
  },
}));

import { useHistoryStore } from '@apelles/history';
import { useEditorTimelineStore } from './timelineStore';
import { useMediaUnderstandingStore, type Transcript } from './mediaUnderstandingStore';
import { useEditorControl } from './useEditorControl';
import { writeProjectSettings } from './projectSettingsWrite';

interface OpEnvelope {
  ok: boolean;
  error: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the op payload is deliberately untyped over the wire
  result: any;
}

let requestId = 0;
let mounted: MountedComponent | null = null;

async function callOp(op: string, args: Record<string, unknown> = {}): Promise<OpEnvelope> {
  const id = `tl-op-${++requestId}`;
  const handlers = [...(bus.listeners.get('chroma://request') ?? [])];
  await act(async () => {
    await Promise.all(handlers.map((h) => h({ payload: { id, op, args } })));
  });
  const hit = bus.emitted.find((e) => e.event === `chroma://response/${id}`);
  if (!hit) throw new Error(`no response emitted for ${op}`);
  return hit.payload as OpEnvelope;
}

/** Let promise chains the ops kicked off (a B-283 switch-then-restore) settle. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

const SOURCE = '/fixtures/talk.mov';

function longForm(): Tl {
  return {
    id: 'long',
    name: 'Long-form',
    rate: { num: 24, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [
          // Source 0–1.5 s, then source 4–6 s pulled up to timeline 1.5 s.
          { id: 'a', name: 'a', source_path: SOURCE, source_start: 0, duration: 36, source_len: 144, source_fps: 24, start_frame: 0 },
          { id: 'b', name: 'b', source_path: SOURCE, source_start: 96, duration: 48, source_len: 144, source_fps: 24, start_frame: 36 },
        ],
        gain: 1,
        sync_locked: false,
      },
    ],
    markers: [],
  };
}

function transcript(): Transcript {
  const W = 'one two three four five six seven eight nine ten eleven twelve'.split(' ');
  const words = W.map((w, i) => ({ word: ` ${w}`, start: i * 0.5, end: i * 0.5 + 0.4 }));
  return {
    text: W.join(' '),
    language: 'en',
    model: 't',
    source: SOURCE,
    segments: [{ start: 0, end: 5.9, text: W.join(' '), words }],
    words,
  };
}

function Harness(): React.ReactElement {
  useEditorControl();
  return React.createElement('div');
}

beforeEach(async () => {
  bus.emitted.length = 0;
  fake.timelines = [longForm()];
  fake.active = 0;
  fake.calls = [];
  useHistoryStore.getState().clear();
  act(() =>
    useEditorTimelineStore.setState({
      timeline: structuredClone(fake.timelines[0]) as never,
      timelines: [],
      openProjectKey: '/projects/tl.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
    }),
  );
  act(() => useMediaUnderstandingStore.setState({ transcripts: { [SOURCE]: transcript() } }));
  mounted = mount(React.createElement(Harness), { strictMode: false });
  await waitFrames(2);
});

afterEach(async () => {
  await useEditorTimelineStore.getState().flushPendingSave();
  mounted?.unmount();
  mounted = null;
  bus.listeners.clear();
  act(() => useEditorTimelineStore.setState({ timeline: null, openProjectKey: null, status: 'idle', timelines: [] }));
});

describe('timeline management ops (D-411 Phase 0)', () => {
  it('lists, creates without switching, switches, and reports the active timeline', async () => {
    const listed = await callOp('editor_list_timelines');
    expect(listed.error).toBeNull();
    expect(listed.result.timelines).toEqual([
      expect.objectContaining({ id: 'long', active: true, output: null, frameSize: { width: 1920, height: 1080 } }),
    ]);

    const created = await callOp('editor_create_timeline', { name: 'Short 1', width: 1080, height: 1920, activate: false });
    expect(created.error).toBeNull();
    expect(created.result.timeline).toMatchObject({ name: 'Short 1', output: { width: 1080, height: 1920 }, active: false });
    expect(useEditorTimelineStore.getState().timeline?.id).toBe('long'); // the view did not jump

    const refusedOdd = await callOp('editor_create_timeline', { name: 'Odd', width: 1081, height: 1920 });
    expect(refusedOdd.result.error).toMatch(/output width must be even/);
    const refusedHalf = await callOp('editor_create_timeline', { name: 'Half', width: 1080 });
    expect(refusedHalf.result.error).toMatch(/both width and height/);
    expect(fake.timelines).toHaveLength(2);

    const shortId = created.result.timeline.id as string;
    const both = await callOp('editor_list_timelines');
    expect(both.result.timelines[1]).toMatchObject({ id: shortId, frameSize: { width: 1080, height: 1920 } });

    const switched = await callOp('editor_set_active_timeline', { id: shortId });
    expect(switched.result).toMatchObject({ ok: true, activeId: shortId, name: 'Short 1' });
    const state = await callOp('editor_get_state');
    expect(state.result.activeTimeline).toEqual({ id: shortId, name: 'Short 1', output: { width: 1080, height: 1920 }, fps: 24 });
    expect(state.result.timelineCount).toBe(2);
    expect((await callOp('editor_set_active_timeline', { id: 'nope' })).result.error).toMatch(/no timeline with id nope/);
  });

  it('renames and resizes the OPEN timeline as undoable edits, and any other through the backend', async () => {
    await callOp('editor_create_timeline', { name: 'Short 1', activate: false });
    const depth = useHistoryStore.getState().undoStack.length;

    const renamed = await callOp('editor_rename_timeline', { name: '  Vertical cut ' });
    expect(renamed.result.timeline).toMatchObject({ id: 'long', name: 'Vertical cut' });
    expect(useEditorTimelineStore.getState().timeline?.name).toBe('Vertical cut');
    const resized = await callOp('editor_set_timeline_output', { width: 1080, height: 1350 });
    expect(resized.result.timeline).toMatchObject({ output: { width: 1080, height: 1350 } });
    expect(useHistoryStore.getState().undoStack.length - depth).toBe(2);
    expect(fake.calls.filter((c) => c.startsWith('rename:') || c.startsWith('set_output:'))).toEqual([]);

    act(() => useHistoryStore.getState().undo());
    expect(useEditorTimelineStore.getState().timeline?.output).toBeUndefined();
    act(() => useHistoryStore.getState().undo());
    expect(useEditorTimelineStore.getState().timeline?.name).toBe('Long-form');

    // Another timeline: a backend write, not an op on the open one.
    const other = await callOp('editor_set_timeline_output', { id: 'tl-2', width: 1080, height: 1080 });
    expect(other.result.timeline).toMatchObject({ id: 'tl-2', output: { width: 1080, height: 1080 } });
    await callOp('editor_rename_timeline', { id: 'tl-2', name: 'Square' });
    expect(fake.calls).toContain('set_output:tl-2');
    expect(fake.calls).toContain('rename:tl-2');
    expect(byId('tl-2')).toMatchObject({ name: 'Square', output: { width: 1080, height: 1080 } });
    const cleared = await callOp('editor_set_timeline_output', { id: 'tl-2', clear: true });
    expect(cleared.result.timeline.output).toBeNull();

    expect((await callOp('editor_set_timeline_output', {})).result.error).toMatch(/pass width and height/);
    expect((await callOp('editor_set_timeline_output', { clear: true, width: 1080 })).result.error).toMatch(/not both/);
    expect((await callOp('editor_rename_timeline', { name: '   ' })).result.error).toMatch(/must not be empty/);
  });

  it('B-323: sets a timeline frame rate, converting the open timeline by time and undoably', async () => {
    const depth = useHistoryStore.getState().undoStack.length;
    const done = await callOp('editor_set_timeline_output', { fps: 30 });
    expect(done.error).toBeNull();
    expect(done.result.timeline).toMatchObject({ id: 'long', fps: 30 });
    const tl = useEditorTimelineStore.getState().timeline;
    expect(tl?.rate).toEqual({ num: 30, den: 1 });
    // The clips are 24 fps recordings: source-native fields untouched, the
    // timeline start moves with the seconds (36 f at 24 = 1.5 s = 45 f at 30).
    const clips = (tl?.tracks[0].clips ?? []).map((c) => [c.start_frame, c.duration, c.source_start]);
    expect(clips).toEqual([
      [0, 36, 0],
      [45, 48, 96],
    ]);
    expect(useHistoryStore.getState().undoStack.length - depth).toBe(1);
    act(() => useHistoryStore.getState().undo());
    expect(useEditorTimelineStore.getState().timeline?.rate).toEqual({ num: 24, den: 1 });
    expect(useEditorTimelineStore.getState().timeline?.tracks[0].clips[1].start_frame).toBe(36);

    // Another timeline goes through the backend command; size and rate combine.
    await callOp('editor_create_timeline', { name: 'Short', activate: false });
    const other = await callOp('editor_set_timeline_output', { id: 'tl-2', width: 1080, height: 1920, fps: 25 });
    expect(other.result.timeline).toMatchObject({ id: 'tl-2', fps: 25, output: { width: 1080, height: 1920 } });
    expect(fake.calls).toContain('set_rate:tl-2:25');

    // Refused in words, and a bad rate leaves the size unchanged.
    for (const fps of [0, -5, 1000, 'fast']) {
      const bad = await callOp('editor_set_timeline_output', { id: 'tl-2', width: 640, height: 360, fps });
      expect(bad.result.error).toMatch(/fps must be a positive number/);
    }
    expect(byId('tl-2').output).toEqual({ width: 1080, height: 1920 });
  });

  it('B-323: the project frame rate follows empty timelines and is refused for ones holding clips', async () => {
    await callOp('editor_create_timeline', { name: 'Empty', activate: false });
    // "Long-form" holds clips at 24; the empty one is at the default.
    await expect(writeProjectSettings({ fps: 30 })).rejects.toThrow(/Long-form.*24 fps, 2 clips.*editor_set_timeline_output/);
    expect(fake.calls).not.toContain('project_settings'); // nothing was stored

    // Retimed explicitly first, the project rate goes through and the empty timeline follows.
    await callOp('editor_set_timeline_output', { fps: 30 });
    const merged = await writeProjectSettings({ fps: 30, width: 1080 });
    expect(merged).toEqual({ fps: 30, width: 1080 });
    expect(fake.calls).toContain('project_settings');
    expect(fake.calls).toContain('set_rate:tl-2:30');
    expect(useEditorTimelineStore.getState().timeline?.rate).toEqual({ num: 30, den: 1 });

    // A write that does not touch fps never looks at timelines.
    fake.calls = [];
    await writeProjectSettings({ width: 1280 });
    expect(fake.calls).toEqual(['project_settings']);
  });

  it('duplicates (flushing the open edit first) and deletes only by explicit id', async () => {
    // An edit still on its save debounce must be in the copy.
    await callOp('editor_rename_timeline', { name: 'Edited' });
    const dup = await callOp('editor_duplicate_timeline', {});
    expect(dup.error).toBeNull();
    expect(dup.result.timeline).toMatchObject({ id: 'long-copy', name: 'Edited copy', active: false });
    expect(dup.result.active).toBe(false);

    expect((await callOp('editor_delete_timeline', {})).result.error).toMatch(/id must be the id/);
    const deleted = await callOp('editor_delete_timeline', { id: 'long-copy' });
    expect(deleted.result).toMatchObject({ ok: true, deleted: 'long-copy', activeId: 'long', remaining: 1 });
    const last = await callOp('editor_delete_timeline', { id: 'long' });
    expect(last.result.error).toMatch(/only timeline/);

    // Deleting the ACTIVE one hands the view to its neighbour.
    await callOp('editor_duplicate_timeline', { name: 'Keep', activate: true });
    expect(useEditorTimelineStore.getState().timeline?.name).toBe('Keep');
    const gone = await callOp('editor_delete_timeline', { id: useEditorTimelineStore.getState().timeline?.id ?? '' });
    expect(gone.result.activeId).toBe('long');
    expect(useEditorTimelineStore.getState().timeline?.id).toBe('long');
  });

  it('B-283: an undo made after a switch lands on its own timeline, not the open one', async () => {
    await callOp('editor_rename_timeline', { name: 'Renamed long' }); // undoable, on "long"
    await callOp('editor_create_timeline', { name: 'Short' }); // switches to it
    expect(useEditorTimelineStore.getState().timeline?.name).toBe('Short');

    act(() => useHistoryStore.getState().undo());
    await settle();
    await settle();
    // The undo switched back to "long" and restored it there…
    const s = useEditorTimelineStore.getState();
    expect(s.timeline?.id).toBe('long');
    expect(s.timeline?.name).toBe('Long-form');
    await s.flushPendingSave();
    // …and the short was never overwritten with the long-form's snapshot.
    expect(byId('tl-2').name).toBe('Short');
    expect(byId('long').name).toBe('Long-form');
  });
});

describe('captions from the timeline transcript (scope="timeline")', () => {
  it('captions the edit at the frames its words play', async () => {
    const res = await callOp('editor_generate_captions_from_transcript', { scope: 'timeline' });
    expect(res.error).toBeNull();
    expect(res.result).toMatchObject({ ok: true, scope: 'timeline', track: 1 });
    const cues = useEditorTimelineStore.getState().timeline?.tracks[1].clips ?? [];
    const text = cues.map((c) => (c as { caption?: { text: string } }).caption?.text ?? '').join(' ');
    expect(text).toBe('one two three nine ten eleven twelve');
    // One source sentence, split by the cut, stays ONE cue — and it ends where
    // "twelve" PLAYS (timeline 36 + 1.9 s = frame 82), not where it sits in the
    // file (5.9 s = frame 142, past the end of this 84-frame timeline).
    expect(cues).toHaveLength(1);
    expect(cues[0].start_frame).toBe(0);
    expect(cues[0].start_frame + cues[0].duration).toBe(82);

    const refused = await callOp('editor_generate_captions_from_transcript', { scope: 'timeline', offsetFrames: 10 });
    expect(refused.result.error).toMatch(/apply only to scope="file"/);
    const bad = await callOp('editor_generate_captions_from_transcript', { scope: 'everything' });
    expect(bad.result.error).toMatch(/scope must be/);
  });
});
