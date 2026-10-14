// @vitest-environment jsdom
/**
 * @apelles/editor — the client-judged retake ops, at the OP layer (D-380 step
 * 2): `editor_get_word_transcript`, `editor_propose_retakes`,
 * `editor_retranscribe_words`, driven through the real `chroma://request`
 * dispatch `control.rs` uses.
 *
 * **Tier and its honest limit.** jsdom, with the two Rust commands stubbed by
 * a deliberately small stand-in (words by midpoint, a view id that changes
 * with the words, canned verdicts) and the sidecar's windowed transcription
 * stubbed. What is on trial is the op layer: paging and the served
 * instructions, the stale-view refusal, what is stored for the Recut panel,
 * that confirmations reach the gate as waivers, and that a re-read is a
 * preview until applied and then changes the view. The gate itself is
 * `apelles-speech`'s Rust suite; the real view rendering is pinned there
 * against the POC's own input.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';

import { createInvokeStub, mount, waitFrames, type MountedComponent } from './testUtils/pointerHarness';

const SOURCE = '/fixtures/talk.mov';

type Seg = { start: number; end: number; words: Array<{ word: string; start: number; end: number }> };

const backend = vi.hoisted(() => ({
  checks: [] as Array<Record<string, unknown>>,
  verdicts: [] as unknown[],
  reread: [] as Array<{ word: string; start: number; end: number }>,
  transcribeCalls: [] as Array<Record<string, unknown>>,
}));

/** The stand-in for `index_pieces`: words whose midpoint is in a piece, in
 *  piece order. */
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
const idOf = (ws: Array<{ text: string; start: number }>) => `v-${ws.map((w) => `${w.text}@${w.start}`).join(',').length}-${ws.map((w) => w.text).join('')}`;

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_retake_word_view: (args) => {
      const words = viewWords(args);
      const offset = Number(args?.offset ?? 0);
      const per = Number(args?.maxWords ?? 2500);
      const to = Math.min(words.length, offset + per);
      return {
        viewId: idOf(words),
        totalWords: words.length,
        offset,
        returned: to - offset,
        nextOffset: to < words.length ? to : null,
        text: words.slice(offset, to).map((w, i) => `${offset + i}\t${w.text}`).join('\n'),
        ...(offset === 0 ? { rules: 'THE POC RULES' } : {}),
        ...(args?.includeWords ? { words } : {}),
      };
    },
    chroma_check_retake_proposals: (args) => {
      backend.checks.push(args ?? {});
      const words = viewWords(args);
      if (args?.viewId !== idOf(words)) return { stale: true, viewId: idOf(words) };
      return { stale: false, viewId: idOf(words), verdicts: backend.verdicts, words };
    },
    chroma_transcribe: (args) => {
      backend.transcribeCalls.push(args ?? {});
      return { job_id: 'j1' };
    },
    chroma_transcribe_status: () => ({
      state: 'done',
      result: { text: '', language: 'en', model: 't', source: SOURCE, segments: [{ start: 1, end: 2, text: 'x', words: backend.reread }] },
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

import { useEditorTimelineStore } from './timelineStore';
import { useMediaUnderstandingStore, type Transcript } from './mediaUnderstandingStore';
import { useEditorControl } from './useEditorControl';

interface OpEnvelope {
  ok: boolean;
  error: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the op payload is deliberately untyped over the wire
  result: any;
}

let requestId = 0;
let mounted: MountedComponent | null = null;

async function callOp(op: string, args: Record<string, unknown> = {}): Promise<OpEnvelope> {
  const id = `test-${++requestId}`;
  const handlers = [...(bus.listeners.get('chroma://request') ?? [])];
  await act(async () => {
    await Promise.all(handlers.map((h) => h({ payload: { id, op, args } })));
  });
  const hit = bus.emitted.find((e) => e.event === `chroma://response/${id}`);
  if (!hit) throw new Error(`no response emitted for ${op}`);
  return hit.payload as OpEnvelope;
}

const WORDS = 'the cat sat the cat sat on the mat and then it left the room quietly'.split(' ');

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
    name: 'ops fixture',
    rate: { num: 24, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [
          { id: 'a', name: 'talk', source_path: SOURCE, source_start: 0, duration: 240, source_len: 240, source_fps: 24, start_frame: 0 },
        ],
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

async function mountWith(withTranscript = true): Promise<void> {
  act(() =>
    useEditorTimelineStore.setState({
      timeline: timeline() as never,
      openProjectKey: '/projects/ops.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
    }),
  );
  if (withTranscript) act(() => useMediaUnderstandingStore.setState({ transcripts: { [SOURCE]: transcript() } }));
  // Not StrictMode: its double-mounted effect leaves two `chroma://request`
  // listeners alive in this harness (the unlisten is async), so every op would
  // run twice — harmless for the idempotent reads elsewhere, but an `apply`
  // run twice is a second, stale answer racing the first. Production mounts
  // the registry once.
  mounted = mount(React.createElement(Harness), { strictMode: false });
  await waitFrames(2);
}

beforeEach(() => {
  backend.checks.length = 0;
  backend.verdicts = [];
  backend.reread = [];
  backend.transcribeCalls.length = 0;
  bus.emitted.length = 0;
  useMediaUnderstandingStore.getState().clear();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  bus.listeners.clear();
  act(() => useEditorTimelineStore.setState({ timeline: null, openProjectKey: null, status: 'idle' }));
});

describe('editor_get_word_transcript', () => {
  it('serves the view in pages of global indices, with the instructions on the first', async () => {
    await mountWith();
    const p0 = await callOp('editor_get_word_transcript', { track: 0, maxWords: 10 });
    expect(p0.ok).toBe(true);
    expect(p0.result).toMatchObject({ offset: 0, returned: 10, nextOffset: 10, totalWords: WORDS.length });
    expect(p0.result.instructions).toContain('THE POC RULES');
    expect(p0.result.instructions).toContain('editor_propose_retakes');

    const p1 = await callOp('editor_get_word_transcript', { track: 0, offset: 10, maxWords: 10 });
    expect(p1.result.instructions).toBeUndefined();
    expect(p1.result.nextOffset).toBeNull();
    expect(p1.result.text.split('\n')[0]).toMatch(/^10\t/);
    expect(p1.result.viewId).toBe(p0.result.viewId);
  });

  it('waits for a missing transcript rather than serving a view that would renumber', async () => {
    await mountWith(false);
    const env = await callOp('editor_get_word_transcript', { track: 0 });
    expect(env.result).toMatchObject({ state: 'transcribing', pending: [SOURCE] });
    expect(backend.transcribeCalls).toHaveLength(0);
    await callOp('editor_get_word_transcript', { track: 0, start: true });
    expect(backend.transcribeCalls).toHaveLength(1);
    // Let the started job land here, not inside the next test's store.
    await act(async () => {
      for (let i = 0; i < 100 && useMediaUnderstandingStore.getState().transcribing[SOURCE]; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
    });
  });

  /** B-250 — a transcription another caller already started is running, so the
   *  note must say so, not tell the agent to start one. */
  it('says transcription is running when another caller started it', async () => {
    await mountWith(false);
    const before = await callOp('editor_get_word_transcript', { track: 0 });
    expect(before.result.note).toMatch(/with start: true to transcribe them/);

    // Started by someone else — not by an `editor_get_word_transcript` call.
    act(() => {
      useMediaUnderstandingStore.getState().startTranscript(SOURCE, { wordTimestamps: true });
    });
    const during = await callOp('editor_get_word_transcript', { track: 0 });
    expect(during.result).toMatchObject({ state: 'transcribing', pending: [SOURCE] });
    expect(during.result.note).toMatch(/Transcription is running; call this again/);
    expect(during.result.note).not.toMatch(/start: true/);

    await act(async () => {
      for (let i = 0; i < 100 && useMediaUnderstandingStore.getState().transcribing[SOURCE]; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
    });
  });
});

describe('editor_propose_retakes', () => {
  const groups = [
    { line: 'the cat sat', takes: [{ first: 0, last: 2 }, { first: 3, last: 5 }], keep: 1 },
    { line: 'mat', takes: [{ first: 6, last: 8 }, { first: 9, last: 10 }], keep: 0, confirm: { '9': 'and is a stopword-ish lead-in' } },
  ];

  it('refuses a stale view id and changes nothing', async () => {
    await mountWith();
    const env = await callOp('editor_propose_retakes', { track: 0, viewId: 'old', groups });
    expect(env.ok).toBe(false);
    expect(env.error).toContain('stale view_id');
    expect(useMediaUnderstandingStore.getState().retakeProposals[0]).toBeUndefined();
  });

  it('runs the gate with the confirmations as waivers, stores the result, and answers per group', async () => {
    await mountWith();
    const { result: view } = await callOp('editor_get_word_transcript', { track: 0 });
    const cut = (first: number, last: number) => ({ first, last, startSecs: first * 0.5, endSecs: last * 0.5 + 0.4, piece: 0 });
    backend.verdicts = [
      { verdict: 'accepted', cuts: [cut(0, 2)] },
      { verdict: 'confirmed', cuts: [cut(9, 10)], waived: [9] },
    ];
    const env = await callOp('editor_propose_retakes', { track: 0, viewId: view.viewId, groups });

    expect(env.ok).toBe(true);
    expect(backend.checks[0].groups).toEqual([
      { takes: groups[0].takes, keep: 1, waive: [] },
      { takes: groups[1].takes, keep: 0, waive: [9] },
    ]);
    expect(env.result).toMatchObject({ verified: 1, aiConfirmed: 1, refused: 0 });
    // The deleted take's segments are frames editor_ripple_delete_ranges takes as-is.
    const seg = env.result.groups[0].takes[0].segments[0];
    expect(seg).toMatchObject({ clip: 0, clipId: 'a', startFrame: 0 });
    expect(env.result.groups[1].confirmed[0]).toMatchObject({ index: 9, justification: 'and is a stopword-ish lead-in' });

    const stored = useMediaUnderstandingStore.getState().retakeProposals[0];
    expect(stored.viewId).toBe(view.viewId);
    expect(stored.groups.map((g) => g.status)).toEqual(['verified', 'ai_confirmed']);
    expect(env.result.note).toContain('Nothing was cut');
  });

  it('an empty list clears the track', async () => {
    await mountWith();
    useMediaUnderstandingStore.getState().setRetakeProposals(0, { track: 0, viewId: 'v', basisKey: 'k', receivedAt: 0, groups: [] });
    const env = await callOp('editor_propose_retakes', { track: 0, groups: [] });
    expect(env.result.cleared).toBe(true);
    expect(useMediaUnderstandingStore.getState().retakeProposals[0]).toBeUndefined();
  });

  it('rejects a malformed group before anything is judged', async () => {
    await mountWith();
    const env = await callOp('editor_propose_retakes', { track: 0, viewId: 'x', groups: [{ takes: [[0, 1]], keep: 0 }] });
    expect(env.ok).toBe(false);
    expect(backend.checks).toHaveLength(0);
  });
});

describe('editor_retranscribe_words', () => {
  it('returns a preview beside the current words, and applies it only when asked — which changes the view', async () => {
    await mountWith();
    const { result: view } = await callOp('editor_get_word_transcript', { track: 0 });
    // The re-read hears word 7 ("the", 3.5-3.9 s) as "a".
    backend.reread = WORDS.map((w, i) => ({ word: ` ${i === 7 ? 'a' : w}`, start: i * 0.5, end: i * 0.5 + 0.4 })).filter(
      (w) => w.start >= 1.5 && w.end <= 6.5,
    );

    const preview = await callOp('editor_retranscribe_words', { track: 0, viewId: view.viewId, first: 7, last: 8 });
    const again = await callOp('editor_get_word_transcript', { track: 0 });
    expect(again.result.viewId, 'a preview changes nothing').toBe(view.viewId);
    expect(preview.ok).toBe(true);
    expect(preview.result).toMatchObject({ state: 'done', applied: false, identical: false });
    expect(preview.result.current.map((w: { index: number }) => w.index)).toContain(7);
    expect(preview.result.reread.map((w: { word: string }) => w.word)).toContain('a');
    expect(backend.transcribeCalls[0]).toMatchObject({ path: SOURCE, language: 'en', wordTimestamps: true });
    expect(useMediaUnderstandingStore.getState().appliedRereadsFor(SOURCE)).toEqual([]);

    const applied = await callOp('editor_retranscribe_words', { track: 0, viewId: view.viewId, first: 7, last: 8, apply: true });
    expect(applied.result.applied).toBe(true);
    expect(applied.result.previousViewId).toBe(view.viewId);
    expect(applied.result.viewId).not.toBe(view.viewId);
    expect(applied.result.indexShift).toBe(0);
    expect(useMediaUnderstandingStore.getState().appliedRereadsFor(SOURCE)).toHaveLength(1);

    // The old view id is now stale everywhere.
    const stale = await callOp('editor_retranscribe_words', { track: 0, viewId: view.viewId, first: 7, last: 8 });
    expect(stale.error).toContain('stale view_id');
  }, 20_000);
});
