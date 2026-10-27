// @vitest-environment jsdom
/**
 * D-408 — music edits by story beat, end to end at the OP layer: the four
 * `editor_*music_edit*` ops driven through the real `chroma://request`
 * dispatch `control.rs` uses, the store the Music edits panel reads, and the
 * shared undo stack.
 *
 * The story: read the voice track's words (`editor_get_word_transcript`),
 * propose a dry punchline (a word range), a stop-time breath before the
 * product name (`before_word`) and one edit that cannot land, see them in the
 * review store, have the person accept two and reject one, apply — one undo
 * step — and undo it. Plus the direct one-shot tool and the refusals an agent
 * meets (a stale view, a missing word track, no music under the range).
 *
 * **Tier and its honest limit.** jsdom with the Rust word-view command stubbed
 * by a small stand-in (words by midpoint); the real view rendering is
 * `apelles-speech`'s, pinned in its own suite. What is on trial: anchors →
 * frames through the real `wordSpanSegments`, the real `music_edits` reducer,
 * the proposal lifecycle and the one-undo contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';

import { createInvokeStub, mount, waitFrames, type MountedComponent } from './testUtils/pointerHarness';

const SOURCE = '/fixtures/talk.mov';

type Seg = { start: number; end: number; words: Array<{ word: string; start: number; end: number }> };

function viewWords(args: Record<string, unknown> | undefined) {
  const sources = (args?.sources ?? []) as Array<{ path: string; segments: Seg[] }>;
  const pieces = (args?.pieces ?? []) as Array<{ source: number; startSecs: number; endSecs: number }>;
  const out: Array<{ text: string; start: number; end: number; piece: number }> = [];
  pieces.forEach((p, piece) => {
    for (const w of sources[p.source].segments.flatMap((s) => s.words)) {
      const mid = (w.start + w.end) / 2;
      if (mid >= p.startSecs && mid < p.endSecs) out.push({ text: w.word.trim(), start: w.start, end: w.end, piece });
    }
  });
  return out;
}
const idOf = (ws: Array<{ text: string; start: number }>) => `v-${ws.map((w) => `${w.text}@${w.start}`).join(',')}`;

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_retake_word_view: (args) => {
      const words = viewWords(args);
      return {
        viewId: idOf(words),
        totalWords: words.length,
        offset: 0,
        returned: words.length,
        nextOffset: null,
        text: words.map((w, i) => `${i}\t${w.text}`).join('\n'),
        rules: 'RULES',
        ...(args?.includeWords ? { words } : {}),
      };
    },
    chroma_timeline_set: () => undefined,
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
import { useMusicEditStore } from './musicEditStore';
import { useEditorControl } from './useEditorControl';
import { DEFAULT_MUSIC_FADE_IN_FRAMES, DEFAULT_MUSIC_FADE_OUT_FRAMES, endFrame } from './timeline';

interface OpEnvelope {
  ok: boolean;
  error: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the op payload is deliberately untyped over the wire
  result: any;
}

let requestId = 0;
let mounted: MountedComponent | null = null;

async function callOp(op: string, args: Record<string, unknown> = {}): Promise<OpEnvelope> {
  const id = `music-${++requestId}`;
  const handlers = [...(bus.listeners.get('chroma://request') ?? [])];
  await act(async () => {
    await Promise.all(handlers.map((h) => h({ payload: { id, op, args } })));
  });
  const hit = bus.emitted.find((e) => e.event === `chroma://response/${id}`);
  if (!hit) throw new Error(`no response emitted for ${op}`);
  return hit.payload as OpEnvelope;
}

// One word every half second: word i spans [i*0.5, i*0.5+0.4) s = frames [12i, 12i+9.6).
const WORDS = 'it was entirely skill and that is why you should try Bot XRay today'.split(' ');

function transcript(): Transcript {
  const words = WORDS.map((w, i) => ({ word: ` ${w}`, start: i * 0.5, end: i * 0.5 + 0.4 }));
  return {
    text: WORDS.join(' '),
    language: 'en',
    model: 't',
    source: SOURCE,
    segments: [{ start: 0, end: words[words.length - 1].end, text: WORDS.join(' '), words }],
    words,
  };
}

function timeline() {
  return {
    id: 'tl',
    name: 'music fixture',
    rate: { num: 24, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [{ id: 'v', name: 'talk', source_path: SOURCE, source_start: 0, duration: 240, source_len: 240, source_fps: 24, start_frame: 0 }],
        gain: 1,
        sync_locked: false,
      },
      {
        kind: 'audio',
        clips: [{ id: 'bed', name: 'bed', source_path: '/music/bed.mp3', source_start: 0, duration: 400, source_len: 4000, start_frame: 0 }],
        gain: 1,
        sync_locked: false,
      },
    ],
    markers: [],
  };
}

function Harness(): React.ReactElement {
  useEditorControl();
  return React.createElement('div');
}

async function mountIt(): Promise<void> {
  act(() =>
    useEditorTimelineStore.setState({
      timeline: timeline() as never,
      openProjectKey: '/projects/music.chroma',
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
}

const bedClips = () => useEditorTimelineStore.getState().timeline?.tracks[1].clips ?? [];
const undoDepth = (): number => useHistoryStore.getState().undoStack.length;

beforeEach(async () => {
  bus.emitted.length = 0;
  useMusicEditStore.getState().clear();
  await mountIt();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  bus.listeners.clear();
  act(() => useEditorTimelineStore.setState({ timeline: null, openProjectKey: null, status: 'idle' }));
});

describe('propose → review → apply (D-408)', () => {
  it('stores the proposals, applies only what the person accepted as one undo step, and undoes it', async () => {
    const view = await callOp('editor_get_word_transcript', { track: 0 });
    const viewId = view.result.viewId as string;

    const proposed = await callOp('editor_propose_music_edits', {
      track: 1,
      wordTrack: 0,
      viewId,
      edits: [
        // "entirely skill" plays dry: words 2-3.
        { kind: 'dropout', first_word: 2, last_word: 3, reason: 'the big reveal lands dry' },
        // A 12-frame breath before "Bot" (word 11, at 5.5 s = frame 132).
        { kind: 'breath', before_word: 11, length_frames: 12, reason: 'stop-time before the product name' },
        // Past the bed (it ends at frame 400): stored, flagged.
        { kind: 'dry_cta', start_frame: 500, end_frame: 600 },
      ],
    });
    expect(proposed.error).toBeNull();
    expect(proposed.result).toMatchObject({ proposed: 3, problems: 1 });
    const [reveal, breath, cta] = proposed.result.edits;
    expect(reveal).toMatchObject({ kind: 'dropout', status: 'pending', text: 'entirely skill', startFrame: 24, endFrame: 46 });
    expect(breath).toMatchObject({ kind: 'breath', text: 'Bot', startFrame: 120, endFrame: 132 });
    expect(cta.problem).toMatch(/no music clip/);
    // Nothing was cut by proposing.
    expect(bedClips()).toHaveLength(1);

    // The person reviews: accept the two that can land, reject the third, and
    // nudge the reveal's re-entry two frames later.
    const store = useMusicEditStore.getState();
    act(() => {
      store.setRowStatus(1, reveal.id, 'accepted');
      store.setRowStatus(1, breath.id, 'accepted');
      store.setRowStatus(1, cta.id, 'rejected');
      store.patchRow(1, reveal.id, { end: 48 });
    });
    const listed = await callOp('editor_list_music_edits', { track: 1 });
    expect(listed.result.sets[0].counts).toEqual({ pending: 0, accepted: 2, rejected: 1 });
    expect(listed.result.sets[0].edits[0]).toMatchObject({ status: 'accepted', endFrame: 48 });

    const depth = undoDepth();
    const applied = await callOp('editor_apply_music_edits', { track: 1 });
    expect(applied.error).toBeNull();
    expect(applied.result.applied).toBe(2);
    expect(undoDepth() - depth).toBe(1);

    const clips = bedClips();
    expect(clips.map((c) => [c.start_frame, endFrame(c, 24)])).toEqual([
      [0, 24],
      [48, 120],
      [132, 400],
    ]);
    expect(clips[0].fade_out_frames).toBe(DEFAULT_MUSIC_FADE_OUT_FRAMES);
    expect(clips[1].fade_in_frames).toBe(DEFAULT_MUSIC_FADE_IN_FRAMES);
    expect(clips[1].fade_out_frames).toBe(DEFAULT_MUSIC_FADE_OUT_FRAMES);
    expect(clips[2].fade_in_frames).toBe(DEFAULT_MUSIC_FADE_IN_FRAMES);
    // The voice never moved.
    expect(useEditorTimelineStore.getState().timeline?.tracks[0].clips[0].start_frame).toBe(0);

    // Applied rows leave the list; the rejected one stays.
    const left = useMusicEditStore.getState().proposals[1].rows;
    expect(left.map((r) => r.status)).toEqual(['rejected']);

    // One Undo takes the whole batch back.
    act(() => useHistoryStore.getState().undo());
    expect(bedClips()).toHaveLength(1);
    expect(bedClips()[0].duration).toBe(400);
  });

  it('an agent the person asked may include pending rows; rejected never land', async () => {
    await callOp('editor_propose_music_edits', {
      track: 1,
      edits: [
        { start_frame: 50, end_frame: 60 },
        { start_frame: 100, end_frame: 110 },
      ],
    });
    const refused = await callOp('editor_apply_music_edits', { track: 1 });
    expect(refused.error).toMatch(/no row is accepted yet/);
    const rows = useMusicEditStore.getState().proposals[1].rows;
    act(() => useMusicEditStore.getState().setRowStatus(1, rows[1].id, 'rejected'));
    const applied = await callOp('editor_apply_music_edits', { track: 1, includePending: true });
    expect(applied.result.applied).toBe(1);
    expect(bedClips().map((c) => c.start_frame)).toEqual([0, 60]);
  });

  it('an empty proposal clears the set', async () => {
    await callOp('editor_propose_music_edits', { track: 1, edits: [{ start_frame: 50, end_frame: 60 }] });
    expect(useMusicEditStore.getState().proposals[1]).toBeDefined();
    const cleared = await callOp('editor_propose_music_edits', { track: 1, edits: [] });
    expect(cleared.result.cleared).toBe(true);
    expect(useMusicEditStore.getState().proposals[1]).toBeUndefined();
  });
});

describe('editor_music_edit — one edit now', () => {
  it('applies a word-anchored dropout as one undo step', async () => {
    const view = await callOp('editor_get_word_transcript', { track: 0 });
    const depth = undoDepth();
    const env = await callOp('editor_music_edit', {
      track: 1,
      kind: 'dry_cta',
      firstWord: 9,
      lastWord: 12,
      wordTrack: 0,
      viewId: view.result.viewId,
      fadeOutFrames: 4,
      fadeInFrames: 10,
    });
    expect(env.error).toBeNull();
    expect(env.result).toMatchObject({ applied: true, words: 'should try Bot XRay', startFrame: 108, fadeOutFrames: 4, fadeInFrames: 10 });
    expect(undoDepth() - depth).toBe(1);
    const clips = bedClips();
    expect(clips[0].fade_out_frames).toBe(4);
    expect(clips[1].fade_in_frames).toBe(10);
  });

  it('refuses a stale view, a missing word track, and a range with no music', async () => {
    const stale = await callOp('editor_music_edit', { track: 1, firstWord: 0, lastWord: 1, wordTrack: 0, viewId: 'old' });
    expect(stale.error).toMatch(/stale view_id/);
    const noTrack = await callOp('editor_music_edit', { track: 1, beforeWord: 3, viewId: 'x' });
    expect(noTrack.error).toMatch(/word_track/);
    const silent = await callOp('editor_music_edit', { track: 1, startFrame: 500, endFrame: 520 });
    expect(silent.error).toMatch(/no music clip under frames 500..520/);
    const video = await callOp('editor_music_edit', { track: 0, startFrame: 5, endFrame: 20 });
    expect(video.error).toMatch(/video track/);
    const ownWords = await callOp('editor_music_edit', { track: 1, firstWord: 0, lastWord: 1, wordTrack: 1, viewId: 'x' });
    expect(ownWords.error).toMatch(/track 1 is the voice the words come from/);
    expect(bedClips()).toHaveLength(1);
  });
});
