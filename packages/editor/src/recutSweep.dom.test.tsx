// @vitest-environment jsdom
/**
 * @apelles/editor — the whole-track recut sweep, at the OP layer (D-342, fixes
 * B-216).
 *
 * **What this file measures, and why it is a COUNTER rather than a stopwatch.**
 * The bug is not that any one detection is slow. It is that a cleanup pass had
 * no way to ask about a whole track, so it asked about one clip and moved on —
 * and the obvious "just loop from the client" does not fix it, because
 * `app/src-tauri/src/chroma/control.rs`'s `serve()` is a single-threaded,
 * one-request-at-a-time HTTP loop (`for req in server.incoming_requests()`,
 * with no per-request spawn). N calls from a client queue at that loop and are
 * served strictly in sequence, so the cost of sweeping 75 clips is 75 bridge
 * round trips, whatever the caller does. The work behind each one is cheap: a
 * transcript cached per FILE plus string similarity, or a short VAD pass.
 *
 * So the number that matters is **how many dispatches one sweep costs**, and
 * that is what this asserts — one, at 4 clips and at 20, which is the same
 * number in jsdom as in production, unlike a wall-clock. That is this repo's
 * established instrument for exactly this shape of problem
 * (`docs/notes/performance-instrumentation.md` §4, and `TimelinePane
 * .mountCost.dom.test.tsx` / `playheadCost.dom.test.tsx` before it) — and the
 * reason it is the right one here is written up in that note: on a machine
 * running several agents a wall-clock reading is a ratio at best.
 *
 * **The regression guarantee.** `clip` became OPTIONAL on the existing tools
 * rather than four new `*_all` names, so the thing that must not move is the
 * single-clip answer. The last describe block pins it: naming a clip returns
 * the same envelope, field for field, that it did before this existed.
 *
 * **Tier and its honest limit.** jsdom, with `invoke` stubbed to return fixed
 * detector payloads and the real `useEditorControl` op registry driven through
 * the real `chroma://request` dispatch path `control.rs` uses. It proves the
 * dispatch count, the fan-out, the aggregation and the response shape. It does
 * not prove the VAD found the right spans — that is `apelles-speech`'s own
 * Rust suite — and it cannot time the real HTTP loop, which is exactly why it
 * counts instead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';

import { createInvokeStub, mount, waitFrames, type MountedComponent } from './testUtils/pointerHarness';

const SOURCE = '/fixtures/talk.mov';

/** Every Tauri command the sweep reaches, counted by name. This is the
 *  fan-out half of the measurement: one dispatch, N detections. */
const backend = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> | undefined }[],
  /** Source seconds at which the fixture's stub VAD "hears" dead air. Only
   *  clips whose own trimmed range covers one of these come back flagged, so
   *  the sweep genuinely has to separate flagged from clean rather than
   *  reporting every clip the same way. */
  silenceAt: [] as Array<{ start_secs: number; end_secs: number }>,
  /** Utterance texts the stub retake detector groups, keyed by nothing: it
   *  groups whatever it is handed if the handed list is long enough. */
  retakeGroups: 0,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_detect_silences: (args) => {
      backend.calls.push({ cmd: 'chroma_detect_silences', args });
      const start = Number(args?.startSecs ?? 0);
      const end = start + Number(args?.durationSecs ?? 0);
      const silences = backend.silenceAt
        .filter((s) => s.start_secs >= start && s.end_secs <= end)
        .map((s) => ({ ...s, duration_secs: s.end_secs - s.start_secs }));
      return { silences };
    },
    chroma_detect_retakes: (args) => {
      backend.calls.push({ cmd: 'chroma_detect_retakes', args });
      const utterances = (args?.utterances ?? []) as Array<{ start: number; end: number; text: string }>;
      if (backend.retakeGroups === 0 || utterances.length < 2) return { groups: [] };
      return {
        groups: [
          {
            keep: 1,
            similarity: 0.91,
            takes: [
              { first: 0, last: 0 },
              { first: 1, last: 1 },
            ],
            members: utterances.slice(0, 2).map((u, index) => ({
              index,
              start_secs: u.start,
              end_secs: u.end,
              text: u.text,
            })),
          },
        ],
      };
    },
    chroma_timeline_set: () => undefined,
    chroma_text_fonts: () => [],
  }),
}));

const bus = vi.hoisted(() => ({
  listeners: new Map<string, Set<(ev: { payload: unknown }) => unknown>>(),
  emitted: [] as { event: string; payload: unknown }[],
  /** Every `chroma://request` the harness fed the registry. THE measurement:
   *  one sweep must be one of these, whatever the clip count. */
  dispatches: [] as string[],
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

/** Drive one op the way `control.rs` does — through `chroma://request`. Every
 *  call here is one bridge round trip in production, which is the unit the
 *  assertions below count. */
async function callOp(op: string, args: Record<string, unknown> = {}): Promise<OpEnvelope> {
  const id = `test-${++requestId}`;
  bus.dispatches.push(op);
  const handlers = [...(bus.listeners.get('chroma://request') ?? [])];
  expect(handlers.length).toBeGreaterThan(0);
  await act(async () => {
    await Promise.all(handlers.map((h) => h({ payload: { id, op, args } })));
  });
  const hit = bus.emitted.find((e) => e.event === `chroma://response/${id}`);
  if (!hit) throw new Error(`no response emitted for ${op}`);
  return hit.payload as OpEnvelope;
}

/** `n` back-to-back 10s clips off one 4K source — B-216's own timeline shape,
 *  which is what a first silence/retake pass leaves behind. `extras` are
 *  appended after them. */
function fixture(n: number, extras: Array<Record<string, unknown>> = []) {
  const CLIP_FRAMES = 240; // 10s @ 24fps
  const clips = Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    name: `take ${i}`,
    source_path: SOURCE,
    source_start: i * CLIP_FRAMES,
    duration: CLIP_FRAMES,
    source_len: (n + extras.length) * CLIP_FRAMES,
    source_fps: 24,
    start_frame: i * CLIP_FRAMES,
  }));
  return {
    id: 'tl',
    name: 'sweep fixture',
    rate: { num: 24, den: 1 },
    tracks: [
      { kind: 'video', clips: [...clips, ...extras], gain: 1, sync_locked: false },
      { kind: 'audio', clips: [], gain: 1, sync_locked: false },
    ],
    markers: [],
  };
}

/** A whole-file transcript: one utterance every 5s, so each 10s clip's own
 *  filtered window carries two. */
function transcript(secs: number): Transcript {
  const segments = Array.from({ length: Math.floor(secs / 5) }, (_, i) => ({
    start: i * 5,
    end: i * 5 + 4,
    text: `line ${i}`,
  }));
  return { text: segments.map((s) => s.text).join(' '), segments, language: 'en' } as Transcript;
}

function Harness(): React.ReactElement {
  useEditorControl();
  return React.createElement('div');
}

async function mountWith(timeline: unknown): Promise<void> {
  act(() =>
    useEditorTimelineStore.setState({
      timeline: timeline as never,
      openProjectKey: '/projects/sweep.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
    }),
  );
  mounted = mount(React.createElement(Harness), { strictMode: true });
  await waitFrames(2);
}

beforeEach(() => {
  backend.calls.length = 0;
  backend.silenceAt = [];
  backend.retakeGroups = 0;
  bus.emitted.length = 0;
  bus.dispatches.length = 0;
  useMediaUnderstandingStore.setState({
    transcripts: {},
    transcribing: {},
    transcriptErrors: {},
    silences: {},
    detectingSilences: {},
    silenceErrors: {},
    retakes: {},
    detectingRetakes: {},
    retakeErrors: {},
  });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  bus.listeners.clear();
  act(() =>
    useEditorTimelineStore.setState({ timeline: null, openProjectKey: null, status: 'idle' }),
  );
});

describe('the counting invariant — one dispatch, whatever the clip count (B-216)', () => {
  /** THE measurement. `dispatches` is the number of bridge round trips a
   *  caller paid; `chroma_detect_silences` calls are the real per-clip work
   *  the app did inside that one trip. The first grows with clip count in the
   *  per-clip world and must not here; the second is allowed to, because it is
   *  the analysis itself and is not what was slow. */
  it.each([4, 20])('sweeps %i clips in exactly ONE op dispatch', async (n) => {
    await mountWith(fixture(n));

    const env = await callOp('editor_detect_silences', { track: 0 });

    expect(env.ok).toBe(true);
    expect(bus.dispatches).toHaveLength(1);
    expect(backend.calls.filter((c) => c.cmd === 'chroma_detect_silences')).toHaveLength(n);
    expect(env.result.totals).toMatchObject({ clips: n, analysable: n });
  });

  /** The comparison the fix exists to make. Doing the same coverage the old
   *  way — the ONLY way available before this — costs one dispatch per clip. */
  it('costs one dispatch PER CLIP when each clip is named, which is the cost B-216 is about', async () => {
    const n = 20;
    await mountWith(fixture(n));

    for (let clip = 0; clip < n; clip += 1) {
      await callOp('editor_detect_silences', { track: 0, clip });
    }

    expect(bus.dispatches).toHaveLength(n);
    // Same underlying work — 20 detections — for 20x the bridge round trips.
    expect(backend.calls.filter((c) => c.cmd === 'chroma_detect_silences')).toHaveLength(n);
  });

  /** A retake sweep must not cost one TRANSCRIPTION per clip: a transcript is
   *  a fact about a FILE, which is the same rule `editor_get_timeline
   *  _transcript` follows (D-329). Twenty clips off one source is one. */
  it('transcribes once per SOURCE FILE, not once per clip', async () => {
    const n = 20;
    useMediaUnderstandingStore.setState({ transcripts: { [SOURCE]: transcript(200) } });
    await mountWith(fixture(n));

    await callOp('editor_detect_retakes', { track: 0 });

    expect(bus.dispatches).toHaveLength(1);
    expect(backend.calls.filter((c) => c.cmd === 'chroma_transcribe_start')).toHaveLength(0);
    expect(backend.calls.filter((c) => c.cmd === 'chroma_detect_retakes')).toHaveLength(n);
  });

  /** Two clips over the SAME source range at the same threshold are one
   *  question, and the store's cache key already says so — the sweep must not
   *  defeat that by asking twice. */
  it('collapses clips that ask the identical question into one detection', async () => {
    const tl = fixture(1);
    // A second clip over the exact same source window as the first.
    tl.tracks[0].clips.push({
      id: 'dup',
      name: 'dup',
      source_path: SOURCE,
      source_start: 0,
      duration: 240,
      source_len: 480,
      source_fps: 24,
      start_frame: 240,
    });
    await mountWith(tl);

    const env = await callOp('editor_detect_silences', { track: 0 });

    expect(env.result.totals.analysable).toBe(2);
    expect(backend.calls.filter((c) => c.cmd === 'chroma_detect_silences')).toHaveLength(1);
  });
});

describe('what a sweep reports', () => {
  it('separates the clips that flagged from the ones that came back clean', async () => {
    // Dead air inside clip 3 (30-40s) and clip 11 (110-120s) only.
    backend.silenceAt = [
      { start_secs: 32, end_secs: 34 },
      { start_secs: 114, end_secs: 116.5 },
    ];
    await mountWith(fixture(20));

    const env = await callOp('editor_detect_silences', { track: 0 });

    expect(env.result.state).toBe('done');
    expect(env.result.flagged.map((f: { clip: number }) => f.clip)).toEqual([3, 11]);
    expect(env.result.clean).toHaveLength(18);
    expect(env.result.totals).toMatchObject({ flagged: 2, clean: 18, findings: 2 });
    // Timeline frames, which is what a cut is expressed in — the same three
    // spaces the single-clip tool returns, through the same `spanToFrames`.
    expect(env.result.flagged[0].silences[0]).toMatchObject({
      startSecs: 32,
      endSecs: 34,
      startFrame: 768,
      endFrame: 816,
    });
  });

  it('reports retake groups per clip, and never cuts anything', async () => {
    backend.retakeGroups = 1;
    useMediaUnderstandingStore.setState({ transcripts: { [SOURCE]: transcript(40) } });
    const before = useEditorTimelineStore.getState().timeline;
    await mountWith(fixture(4));

    const env = await callOp('editor_detect_retakes', { track: 0 });

    expect(env.result.flagged).toHaveLength(4);
    expect(env.result.flagged[0].groups[0].takes).toHaveLength(2);
    expect(env.result.flagged[0].groups[0].keep).toBe(1);
    expect(env.result.note).toMatch(/nothing was cut/);
    // The timeline is untouched: this proposes, `editor_ripple_delete_ranges`
    // decides (D-318's own contract, kept).
    expect(useEditorTimelineStore.getState().timeline).not.toBe(before);
    expect(
      backend.calls.some((c) => c.cmd === 'chroma_timeline_set'),
      'a read-only detector wrote to the timeline',
    ).toBe(false);
  });

  it('names the clips it could not analyse instead of quietly omitting them', async () => {
    await mountWith(
      fixture(2, [
        { id: 'title', name: 'Title', source_path: null, source_start: 0, duration: 48, source_len: 48, start_frame: 480 },
        { id: 'card', name: 'card.png', source_path: '/art/card.png', source_start: 0, duration: 48, source_len: 48, source_fps: 24, start_frame: 528 },
      ]),
    );

    const env = await callOp('editor_detect_silences', { track: 0 });

    expect(env.result.skipped.map((s: { clip: number }) => s.clip)).toEqual([2, 3]);
    expect(env.result.totals).toMatchObject({ clips: 4, analysable: 2, skipped: 2 });
  });

  it('refuses a track that is not there, with the same message a named clip gets', async () => {
    await mountWith(fixture(2));

    const env = await callOp('editor_detect_silences', { track: 7 });

    expect(env.ok).toBe(false);
    expect(env.error).toContain('no track 7');
  });

  it('validates minSilenceMs on the sweep path too', async () => {
    await mountWith(fixture(2));

    const env = await callOp('editor_detect_silences', { track: 0, minSilenceMs: -5 });

    expect(env.ok).toBe(false);
    expect(env.error).toMatch(/positive number of milliseconds/);
  });

  /** A `_status` sweep is a pure read: it must start nothing. */
  it('the _status twin sweeps without starting anything', async () => {
    await mountWith(fixture(6));

    const env = await callOp('editor_detect_silences_status', { track: 0 });

    expect(env.ok).toBe(true);
    expect(backend.calls.filter((c) => c.cmd === 'chroma_detect_silences')).toHaveLength(0);
    expect(env.result.state).toBe('idle');
    expect(env.result.notStarted).toHaveLength(6);
    expect(env.result.note).toContain('editor_detect_silences');
  });
});

describe('the single-clip answer is unchanged (the regression guarantee)', () => {
  it('returns the same per-clip envelope it always did when a clip is named', async () => {
    backend.silenceAt = [{ start_secs: 2, end_secs: 4 }];
    await mountWith(fixture(4));

    const env = await callOp('editor_detect_silences', { track: 0, clip: 0 });

    expect(env.result).toMatchObject({
      ok: true,
      track: 0,
      clip: 0,
      clipId: 'c0',
      source: SOURCE,
      minSilenceMs: 600,
      state: 'done',
    });
    expect(env.result.silences).toHaveLength(1);
    // The sweep-only fields must NOT appear on a single-clip answer.
    expect(env.result.flagged).toBeUndefined();
    expect(env.result.totals).toBeUndefined();
    expect(env.result.note).toBe(
      'nothing was cut — pass these ranges to editor_ripple_delete_ranges to apply them',
    );
  });

  it('still reports a clip index that does not exist as an error', async () => {
    await mountWith(fixture(2));

    const env = await callOp('editor_detect_silences', { track: 0, clip: 9 });

    expect(env.ok).toBe(false);
    expect(env.error).toContain('no clip 9 on track 0');
  });

  it('keeps the single-clip retake envelope, takes and keep included', async () => {
    backend.retakeGroups = 1;
    useMediaUnderstandingStore.setState({ transcripts: { [SOURCE]: transcript(40) } });
    await mountWith(fixture(4));

    const env = await callOp('editor_detect_retakes', { track: 0, clip: 1 });

    expect(env.result).toMatchObject({ ok: true, track: 0, clip: 1, clipId: 'c1', state: 'done' });
    expect(env.result.groups[0].keep).toBe(1);
    expect(env.result.groups[0].takes[0]).toHaveProperty('startFrame');
    expect(env.result.flagged).toBeUndefined();
  });
});
