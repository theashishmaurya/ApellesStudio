// @vitest-environment jsdom
/**
 * D-420 — edit by text, end to end at the OP layer: the `editor_*` ops this
 * pass built or changed, driven through the real `chroma://request` dispatch
 * `control.rs` uses, the real timeline store and the shared undo stack.
 *
 * - `editor_get_word_transcript` — `include_timeline` rows (each word's clip and
 *   timeline frames), the `fillers` suggestions, and B-287's `unreadSpeech`;
 * - `editor_cut_words` — the fragment case on an A/V-linked pair (both tracks
 *   cut, ONE undo step, undo restores), a range spanning two clips, pause
 *   tightening, a dry run, a stale view;
 * - `editor_get_timeline_transcript` — an audio-only (voice-over) timeline now
 *   has rows;
 * - `editor_detect_silences` — word-aware with a transcript, VAD-only without,
 *   said in the answer (B-289);
 * - `editor_ripple_delete_ranges` — B-288's neighbouring ranges in one batch.
 *
 * **Tier and its honest limit.** jsdom; the Rust word view is a small stand-in
 * (words by midpoint, the `index_pieces` rule) and the Silero VAD is a canned
 * answer. On trial: the planner → frames → the real `ripple_delete_ranges`
 * reducer, the word-aware silence rule, the stitched transcript, the history.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';

import { createInvokeStub, mount, waitFrames, type MountedComponent } from './testUtils/pointerHarness';

const TALK = '/fixtures/talk.mov';
const VO = '/fixtures/vo.m4a';
const NO_WORDS = '/fixtures/untranscribed.mov';

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
const idOf = (ws: Array<{ text: string; start: number; piece: number }>, pieces: unknown) =>
  `v-${JSON.stringify(pieces)}-${ws.map((w) => `${w.text}@${w.start}`).join(',')}`;

const silenceAnswer = vi.hoisted(() => ({ silences: [] as Array<{ start_secs: number; end_secs: number; duration_secs: number }> }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_retake_word_view: (args) => {
      const words = viewWords(args);
      const offset = Number(args?.offset ?? 0);
      const max = args?.maxWords === null || args?.maxWords === undefined ? words.length : Number(args.maxWords);
      const page = words.slice(offset, offset + max);
      return {
        viewId: idOf(words, args?.pieces),
        totalWords: words.length,
        offset,
        returned: page.length,
        nextOffset: offset + page.length < words.length ? offset + page.length : null,
        text: page.map((w, i) => `${offset + i}\t${w.text}`).join('\n'),
        ...(offset === 0 ? { rules: 'RULES' } : {}),
        ...(args?.includeWords ? { words } : {}),
      };
    },
    chroma_detect_silences: (args) => ({
      source: args?.path,
      start_secs: args?.startSecs,
      duration_secs: args?.durationSecs,
      analysed_secs: args?.durationSecs,
      min_silence_ms: args?.minSilenceMs ?? 350,
      model: 'silero-stub',
      silences: silenceAnswer.silences,
    }),
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
import { useEditorControl } from './useEditorControl';
import { endFrame, type Timeline } from './timeline';

interface OpEnvelope {
  ok: boolean;
  error: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the op payload is deliberately untyped over the wire
  result: any;
}

let requestId = 0;
let mounted: MountedComponent | null = null;

async function callOp(op: string, args: Record<string, unknown> = {}): Promise<OpEnvelope> {
  const id = `ebt-${++requestId}`;
  const handlers = [...(bus.listeners.get('chroma://request') ?? [])];
  await act(async () => {
    await Promise.all(handlers.map((h) => h({ payload: { id, op, args } })));
  });
  const hit = bus.emitted.find((e) => e.event === `chroma://response/${id}`);
  if (!hit) throw new Error(`no response emitted for ${op}`);
  return hit.payload as OpEnvelope;
}

/** A transcript from `[word, start, end]` triples, one segment. */
function transcript(source: string, spec: Array<[string, number, number]>, extra: Partial<Transcript> = {}): Transcript {
  const words = spec.map(([w, start, end]) => ({ word: ` ${w}`, start, end }));
  return {
    text: spec.map(([w]) => w).join(' '),
    language: 'en',
    model: 't',
    source,
    segments: [{ start: words[0].start, end: words[words.length - 1].end, text: spec.map(([w]) => w).join(' '), words }],
    words,
    ...extra,
  };
}

// "So um the idea is simple, the the point is uh clear" — 10 s of talking head.
const TALK_WORDS: Array<[string, number, number]> = [
  ['So', 0.5, 0.8],
  ['um', 1.0, 1.3],
  ['the', 1.4, 1.6],
  ['idea', 1.7, 2.2],
  ['is', 2.3, 2.45],
  ['simple,', 2.5, 3.0],
  ['the', 4.6, 4.8],
  ['the', 4.9, 5.1],
  ['point', 5.2, 5.6],
  ['is', 5.7, 5.85],
  ['uh', 6.0, 6.3],
  ['clear.', 6.5, 7.1],
];

const clipOf = (id: string, source: string, startFrame: number, sourceStart: number, duration: number, link?: string) => ({
  id,
  name: id,
  source_path: source,
  source_start: sourceStart,
  duration,
  source_len: 100_000,
  source_fps: 24,
  start_frame: startFrame,
  ...(link ? { link_group: link } : {}),
});

/** One A/V-linked talking-head pair, 240 frames (10 s @ 24 fps). */
function talkTimeline() {
  return {
    id: 'tl',
    name: 'edit by text',
    rate: { num: 24, den: 1 },
    tracks: [
      { kind: 'video', clips: [clipOf('v', TALK, 0, 0, 240, 'g')], gain: 1, sync_locked: true },
      { kind: 'audio', clips: [clipOf('a', TALK, 0, 0, 240, 'g')], gain: 1, sync_locked: true },
    ],
    markers: [],
  };
}

/** A voice-over-only timeline: two clips of one file (source 0-3 s and 10-13 s). */
function voTimeline() {
  return {
    id: 'vo',
    name: 'voice-over',
    rate: { num: 24, den: 1 },
    tracks: [{ kind: 'audio', clips: [clipOf('vo1', VO, 0, 0, 72), clipOf('vo2', VO, 72, 240, 72)], gain: 1, sync_locked: true }],
    markers: [],
  };
}

const VO_WORDS: Array<[string, number, number]> = [
  ['First', 0.3, 0.7],
  ['part', 0.8, 1.2],
  ['ends', 2.0, 2.5],
  ['here', 10.3, 10.7],
  ['second', 11.5, 12.0],
];

function Harness(): React.ReactElement {
  useEditorControl();
  return React.createElement('div');
}

async function mountWith(tl: unknown, transcripts: Record<string, Transcript>): Promise<void> {
  act(() =>
    useEditorTimelineStore.setState({
      timeline: tl as never,
      openProjectKey: '/projects/ebt.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
    }),
  );
  act(() => useMediaUnderstandingStore.setState({ transcripts, silences: {}, silenceErrors: {}, detectingSilences: {} }));
  mounted = mount(React.createElement(Harness), { strictMode: false });
  await waitFrames(2);
}

const tl = (): Timeline => useEditorTimelineStore.getState().timeline as Timeline;
const spans = (track: number) => tl().tracks[track].clips.map((c) => [c.start_frame, endFrame(c, 24)]);
const undoDepth = (): number => useHistoryStore.getState().undoStack.length;

beforeEach(() => {
  bus.emitted.length = 0;
  silenceAnswer.silences = [];
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  bus.listeners.clear();
  act(() => useEditorTimelineStore.setState({ timeline: null, openProjectKey: null, status: 'idle' }));
});

describe('editor_get_word_transcript — timeline rows, fillers, unread speech', () => {
  it('gives each word its clip and timeline frames, lists fillers, and flags unread speech', async () => {
    await mountWith(talkTimeline(), {
      [TALK]: transcript(TALK, TALK_WORDS, { coverage: { checked: true, recovered: [], unread: [{ start: 3.2, end: 4.4 }] } }),
    });
    const r = await callOp('editor_get_word_transcript', { track: 0, includeTimeline: true });
    expect(r.error).toBeNull();
    expect(r.result.words[1]).toEqual({ index: 1, word: 'um', startSecs: 1.0, endSecs: 1.3, clip: 0, clipId: 'v', startFrame: 24, endFrame: 31 });
    expect(r.result.fillers).toEqual([
      { index: 1, word: 'um', kind: 'filler' },
      { index: 6, word: 'the', kind: 'repeat' },
      { index: 10, word: 'uh', kind: 'filler' },
    ]);
    expect(r.result.unreadSpeech).toEqual([
      { source: TALK, startSecs: 3.2, endSecs: 4.4, clip: 0, clipId: 'v', startFrame: 77, endFrame: 106 },
    ]);
    // Without include_timeline the page stays the compact text view.
    const plain = await callOp('editor_get_word_transcript', { track: 0 });
    expect(plain.result.words).toBeUndefined();
  });
});

describe('editor_cut_words', () => {
  it('cuts a filler between kept words on BOTH linked tracks, as one undo step, and undo restores it', async () => {
    await mountWith(talkTimeline(), { [TALK]: transcript(TALK, TALK_WORDS) });
    const view = await callOp('editor_get_word_transcript', { track: 0 });
    const depth = undoDepth();

    const cut = await callOp('editor_cut_words', { track: 0, viewId: view.result.viewId, ranges: [{ first: 1, last: 1 }] });
    expect(cut.error).toBeNull();
    expect(cut.result).toMatchObject({ ok: true, deletedWords: 1, cutFrames: 10, applied: 1 });
    expect(cut.result.cuts).toEqual([
      expect.objectContaining({ startFrame: 22, endFrame: 32, kind: 'words', words: [{ index: 1, word: 'um' }], text: 'um' }),
    ]);
    expect(cut.result.viewId).not.toBe(view.result.viewId);
    // Both halves of the pair lost the same 10 frames, and the pair stays linked.
    expect(spans(0)).toEqual([[0, 22], [22, 230]]);
    expect(spans(1)).toEqual([[0, 22], [22, 230]]);
    expect(undoDepth()).toBe(depth + 1);

    // The words after the cut read as they should: "So the idea…".
    const after = await callOp('editor_get_word_transcript', { track: 0, includeTimeline: true });
    expect(after.result.words.slice(0, 3).map((w: { word: string }) => w.word)).toEqual(['So', 'the', 'idea']);

    act(() => useHistoryStore.getState().undo());
    expect(spans(0)).toEqual([[0, 240]]);
    expect(spans(1)).toEqual([[0, 240]]);
  });

  it('cuts every filler the view suggests in one call — two ranges, one undo step', async () => {
    await mountWith(talkTimeline(), { [TALK]: transcript(TALK, TALK_WORDS) });
    const view = await callOp('editor_get_word_transcript', { track: 0 });
    const ranges = view.result.fillers.map((f: { index: number }) => ({ first: f.index, last: f.index }));
    const depth = undoDepth();
    const cut = await callOp('editor_cut_words', { track: 0, viewId: view.result.viewId, ranges });
    expect(cut.result).toMatchObject({ ok: true, deletedWords: 3 });
    expect(undoDepth()).toBe(depth + 1);
    const words = (await callOp('editor_get_word_transcript', { track: 0, includeTimeline: true })).result.words.map(
      (w: { word: string }) => w.word,
    );
    expect(words).toEqual(['So', 'the', 'idea', 'is', 'simple,', 'the', 'point', 'is', 'clear.']);
  });

  it('cuts a range spanning two clips to the boundary in both, leaving nothing of the deleted words', async () => {
    await mountWith(voTimeline(), { [VO]: transcript(VO, VO_WORDS) });
    const view = await callOp('editor_get_word_transcript', { track: 0 });
    // "ends" (end of clip 1) + "here" (start of clip 2).
    const cut = await callOp('editor_cut_words', { track: 0, viewId: view.result.viewId, ranges: [{ first: 2, last: 3 }] });
    expect(cut.error).toBeNull();
    expect(cut.result.cuts.map((c: { clip: number; startFrame: number; endFrame: number }) => [c.clip, c.startFrame, c.endFrame])).toEqual([
      [0, 40, 72], // 2.0 s - 0.32 s pad = 1.68 s -> frame 40, to the end of clip 1
      [1, 72, 96], // from the start of clip 2 to 10.7 s + 0.32 s = 11.02 s -> source frame 264 = timeline 96
    ]);
    const words = (await callOp('editor_get_word_transcript', { track: 0, includeTimeline: true })).result.words.map(
      (w: { word: string }) => w.word,
    );
    expect(words).toEqual(['First', 'part', 'second']);
  });

  it('tightens long pauses to a breath, and a dry run changes nothing', async () => {
    await mountWith(talkTimeline(), { [TALK]: transcript(TALK, TALK_WORDS) });
    const view = await callOp('editor_get_word_transcript', { track: 0 });
    const dry = await callOp('editor_cut_words', {
      track: 0,
      viewId: view.result.viewId,
      ranges: [],
      tightenGapsMs: 500,
      keepBreathMs: 300,
      dryRun: true,
    });
    expect(dry.result).toMatchObject({ ok: true, dryRun: true, tightenedGaps: 1, deletedWords: 0 });
    // "simple," ends 3.0 s, "the" starts 4.6 s: cut 3.15 s .. 4.45 s.
    expect(dry.result.cuts).toEqual([expect.objectContaining({ startFrame: 76, endFrame: 107, kind: 'gap' })]);
    expect(spans(0)).toEqual([[0, 240]]);

    const real = await callOp('editor_cut_words', { track: 0, viewId: view.result.viewId, ranges: [], tightenGapsMs: 500, keepBreathMs: 300 });
    expect(real.result).toMatchObject({ ok: true, cutFrames: 31 });
    expect(spans(0)).toEqual([[0, 76], [76, 209]]);
  });

  it('refuses a stale view and cuts nothing', async () => {
    await mountWith(talkTimeline(), { [TALK]: transcript(TALK, TALK_WORDS) });
    const r = await callOp('editor_cut_words', { track: 0, viewId: 'v-old', ranges: [{ first: 1, last: 1 }] });
    expect(r.result.error).toMatch(/stale view_id/);
    expect(spans(0)).toEqual([[0, 240]]);
  });
});

describe('editor_get_timeline_transcript — a voice-over timeline', () => {
  it('reads an audio-only timeline (D-329 read video tracks only, so this returned nothing)', async () => {
    await mountWith(voTimeline(), { [VO]: transcript(VO, VO_WORDS) });
    const r = await callOp('editor_get_timeline_transcript', {});
    expect(r.error).toBeNull();
    expect(r.result.sources).toEqual([{ path: VO, clipCount: 2, state: 'done' }]);
    expect(r.result.rows.map((row: { clipId: string; track: number }) => [row.clipId, row.track])).toEqual([
      ['vo1', 0],
      ['vo2', 0],
    ]);
  });
});

describe('editor_detect_silences — word-aware (B-289)', () => {
  it('never returns a range over a word when the source has a transcript, and says so', async () => {
    await mountWith(talkTimeline(), { [TALK]: transcript(TALK, TALK_WORDS) });
    // The VAD's silence starts INSIDE "simple," (2.5-3.0 s) and ends inside "the" (4.6 s).
    silenceAnswer.silences = [{ start_secs: 2.8, end_secs: 4.7, duration_secs: 1.9 }];
    const r = await callOp('editor_detect_silences', { track: 0, clip: 0, minSilenceMs: 350 });
    expect(r.result).toMatchObject({ state: 'done', wordAware: true, basis: 'vad+words', vadSilences: 1, trimmedForWords: 1 });
    // 3.0 + 0.125 = 3.125 s -> frame 75; 4.6 - 0.125 = 4.475 s -> frame 107.
    expect(r.result.silences.map((s: { startFrame: number; endFrame: number }) => [s.startFrame, s.endFrame])).toEqual([[75, 107]]);
  });

  it('answers VAD-only, and says so, when the source has no transcript', async () => {
    const t = talkTimeline();
    t.tracks[0].clips[0].source_path = NO_WORDS;
    await mountWith(t, {});
    silenceAnswer.silences = [{ start_secs: 2.8, end_secs: 4.7, duration_secs: 1.9 }];
    const r = await callOp('editor_detect_silences', { track: 0, clip: 0 });
    expect(r.result).toMatchObject({ wordAware: false, basis: 'vad' });
    expect(r.result.wordAwareNote).toMatch(/VAD-only/);
    expect(r.result.silences.map((s: { startFrame: number; endFrame: number }) => [s.startFrame, s.endFrame])).toEqual([[67, 113]]);
  });
});

describe('editor_ripple_delete_ranges — B-288', () => {
  it('cuts every valid range of a batch on a mixed-rate clip, neighbours in the same clip included', async () => {
    const rate = { num: 493480, den: 20563 };
    const src = (frames: number) => Math.round((frames * 25 * rate.den) / rate.num);
    await mountWith(
      {
        id: 'b288',
        name: 'b288',
        rate,
        tracks: [
          {
            kind: 'audio',
            clips: [
              { ...clipOf('a', VO, 0, 0, src(9000)), source_fps: 25 },
              { ...clipOf('b', VO, 9000, src(9000), src(8219)), source_fps: 25 },
            ],
            gain: 1,
            sync_locked: true,
          },
        ],
        markers: [],
      },
      {},
    );
    const r = await callOp('editor_ripple_delete_ranges', {
      track: 0,
      ranges: [
        { startFrame: 8958, endFrame: 9011 },
        { startFrame: 9100, endFrame: 9470 },
        { startFrame: 9723, endFrame: 9742 },
      ],
    });
    expect(r.error).toBeNull();
    expect(r.result).toMatchObject({ ok: true, ranges: 3, applied: 3 });
  });
});
