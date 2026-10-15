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
  /** B-237/D-364. `'similar'` makes the stub group only utterances that are
   *  actually alike, so a call that is handed one half of a restart finds
   *  nothing and a call handed both finds the pair — which is the ONLY
   *  property of the real detector this file is entitled to lean on. The real
   *  scoring is `apelles-speech`'s own Rust suite's subject; what is on trial
   *  here is what gets HANDED to it. */
  retakeMode: 'any' as 'any' | 'similar',
  /** D-382 — what the stubbed coverage gate answers for every group. */
  gate: { verdict: 'accepted', takeWords: [] } as Record<string, unknown>,
  /** B-249 — the stub VAD scan holds its answer until a test releases it, so
   *  the start call returns with the scan still running, the way a real
   *  multi-minute source does. Each pending scan's release is queued here. */
  darkRegions: [] as Array<Record<string, unknown>>,
  releaseScans: [] as Array<() => void>,
}));

/** Word-set overlap, the crudest possible stand-in for "the same line again".
 *  Deliberately not a reimplementation of `retake.rs` — it exists only so the
 *  fixture below can distinguish "saw both takes" from "saw one". */
function alike(a: string, b: string): boolean {
  const words = (t: string) => new Set(t.toLowerCase().split(/\W+/).filter(Boolean));
  const x = words(a);
  const y = words(b);
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / Math.max(x.size, y.size) >= 0.6;
}

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
      if (backend.retakeMode === 'similar') {
        const pair: number[] = [];
        for (let i = 0; i < utterances.length && pair.length === 0; i += 1) {
          for (let j = i + 1; j < utterances.length; j += 1) {
            if (alike(utterances[i].text, utterances[j].text)) {
              pair.push(i, j);
              break;
            }
          }
        }
        if (pair.length === 0) return { groups: [] };
        return {
          groups: [
            {
              keep: 1,
              similarity: 0.87,
              takes: [
                { first: 0, last: 0 },
                { first: 1, last: 1 },
              ],
              members: pair.map((u, index) => ({
                index,
                start_secs: utterances[u].start,
                end_secs: utterances[u].end,
                text: utterances[u].text,
              })),
            },
          ],
        };
      }
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
    chroma_detect_dark_regions: (args) => {
      backend.calls.push({ cmd: 'chroma_detect_dark_regions', args });
      const startSecs = Number(args?.startSecs ?? 0);
      const durationSecs = Number(args?.durationSecs ?? 0);
      return new Promise((resolve) => {
        backend.releaseScans.push(() =>
          resolve({
            source: args?.path,
            start_secs: startSecs,
            duration_secs: durationSecs,
            analysed_secs: durationSecs,
            min_dark_secs: 1.2,
            max_word_secs: 2.0,
            model: 'silero_vad_v6.2.1.onnx',
            regions: backend.darkRegions,
            rms_floor: 0.1,
            calibration_spans: 5,
            gated_out: 0,
            speech_secs: durationSecs,
            covered_secs: durationSecs,
          }),
        );
      });
    },
    // One recovery re-read (D-349): a job id, then a finished job on the first
    // poll, with the words the whole-file pass dropped.
    chroma_transcribe: (args) => {
      backend.calls.push({ cmd: 'chroma_transcribe', args });
      return { job_id: 'recover-1' };
    },
    chroma_transcribe_status: () => ({
      state: 'done',
      result: {
        text: 'the line it dropped',
        language: 'en',
        segments: [{ start: 4.2, end: 5.8, text: 'the line it dropped' }],
      },
    }),
    chroma_gate_detected_retakes: (args) => {
      backend.calls.push({ cmd: 'chroma_gate_detected_retakes', args });
      return { groups: ((args?.groups ?? []) as unknown[]).map(() => backend.gate) };
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
  backend.retakeMode = 'any';
  backend.gate = { verdict: 'accepted', takeWords: [] };
  backend.darkRegions = [];
  backend.releaseScans = [];
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
    dark: {},
    detectingDark: {},
    darkErrors: {},
    recoveries: {},
    recovering: {},
    recoveryErrors: {},
    retakeRequests: {},
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
   *  _transcript` follows (D-329). Twenty clips off one source is one.
   *
   *  Since D-364 it does not cost one DETECTION per clip either: these twenty
   *  clips are back-to-back cuts of one recording, so they are one run and one
   *  grouping — which is the point of B-237's fix, and also strictly less work
   *  than the twenty calls this used to make. */
  it('transcribes once per SOURCE FILE, and groups once per continuous take', async () => {
    const n = 20;
    useMediaUnderstandingStore.setState({ transcripts: { [SOURCE]: transcript(200) } });
    await mountWith(fixture(n));

    const env = await callOp('editor_detect_retakes', { track: 0 });

    expect(bus.dispatches).toHaveLength(1);
    expect(backend.calls.filter((c) => c.cmd === 'chroma_transcribe_start')).toHaveLength(0);
    expect(backend.calls.filter((c) => c.cmd === 'chroma_detect_retakes')).toHaveLength(1);
    expect(env.result.runs).toBe(1);
    expect(env.result.totals.analysable).toBe(n);
  });

  /** The other direction: clips that are NOT one continuous take are still one
   *  detection each, so the merge cannot quietly compare unrelated material. */
  it('still groups separately when the clips are not one continuous take', async () => {
    useMediaUnderstandingStore.setState({ transcripts: { [SOURCE]: transcript(400) } });
    const tl = fixture(3);
    // Push clip 2 far enough down the source that no pair of takes either side
    // of the removed stretch could ever be grouped anyway.
    tl.tracks[0].clips[2].source_start = 240 * 20;
    await mountWith(tl);

    const env = await callOp('editor_detect_retakes', { track: 0 });

    expect(env.result.runs).toBe(2);
    expect(backend.calls.filter((c) => c.cmd === 'chroma_detect_retakes')).toHaveLength(2);
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

  it('reports retake groups against the clips they land in, and never cuts anything', async () => {
    backend.retakeGroups = 1;
    useMediaUnderstandingStore.setState({ transcripts: { [SOURCE]: transcript(40) } });
    const before = useEditorTimelineStore.getState().timeline;
    await mountWith(fixture(4));

    const env = await callOp('editor_detect_retakes', { track: 0 });

    // One run, one grouping, and the group is reported ONCE — under the
    // earliest clip it touches (D-364). Repeating it under every clip it spans
    // would make one stumble look like several.
    expect(env.result.flagged).toHaveLength(1);
    expect(env.result.flagged[0].clip).toBe(0);
    expect(env.result.clean).toEqual([1, 2, 3]);
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

    const env = await callOp('editor_detect_retakes', { track: 0, clip: 0 });

    expect(env.result).toMatchObject({ ok: true, track: 0, clip: 0, clipId: 'c0', state: 'done' });
    expect(env.result.groups[0].keep).toBe(1);
    // A take inside one clip still carries the flat frame fields it always did.
    expect(env.result.groups[0].takes[0]).toHaveProperty('startFrame');
    expect(env.result.flagged).toBeUndefined();
    // D-382 — and the gate's verdict, from one gate call for the run.
    expect(env.result.groups[0].status).toBe('verified');
    expect(backend.calls.filter((c) => c.cmd === 'chroma_gate_detected_retakes')).toHaveLength(1);
  });

  /** D-382 — a group the coverage gate refuses is still reported (a person
   *  can listen and decide), but marked, with the words its cut would lose. */
  it('marks a group the coverage gate refuses, naming the words it would lose', async () => {
    backend.retakeGroups = 1;
    backend.gate = {
      verdict: 'refused',
      takeWords: [],
      reason: { kind: 'content_absent_from_kept_take' },
      reasonText: 'a deleted take has words the kept take does not',
      offending: [{ index: 3, word: 'unique' }],
      waivable: true,
    };
    useMediaUnderstandingStore.setState({ transcripts: { [SOURCE]: transcript(40) } });
    await mountWith(fixture(4));

    const single = await callOp('editor_detect_retakes', { track: 0, clip: 0 });
    expect(single.result.groups[0]).toMatchObject({
      status: 'refused',
      reason: { kind: 'content_absent_from_kept_take' },
      offending: [{ index: 3, word: 'unique' }],
    });
    expect(single.result.note).toContain('refused');

    const sweep = await callOp('editor_detect_retakes', { track: 0 });
    expect(sweep.result.flagged[0].groups[0].status).toBe('refused');
  });

  /** D-364 — asking about one clip answers about THAT clip, even though the
   *  detection is now read over the whole run it belongs to. A group sitting
   *  entirely in a neighbour is not this clip's business. */
  it('answers about the clip that was asked about, not about its whole run', async () => {
    backend.retakeGroups = 1;
    useMediaUnderstandingStore.setState({ transcripts: { [SOURCE]: transcript(40) } });
    await mountWith(fixture(4));

    const env = await callOp('editor_detect_retakes', { track: 0, clip: 2 });

    expect(env.result).toMatchObject({ ok: true, clip: 2, state: 'done' });
    expect(env.result.groups).toEqual([]);
    expect(env.result.note).toBe('no retakes found in this clip');
    // And it says plainly that it read more than clip 2 to decide that.
    expect(env.result.readAcrossClips).toEqual([0, 1, 2, 3]);
  });
});

// --------------------------------------------------------------------------- #
// B-237 / D-364 — the case the sweep was structurally blind to
// --------------------------------------------------------------------------- #

/** The restart "…the trick behind used…" → "down. And the trick being used…"
 *  at source 210-230 s, which an earlier silence cut had already split across
 *  several original clips including ones of 0.25 s and 0.58 s. Those numbers
 *  are the measured ones (`docs/notes/retake-detection.md` §4); the exact
 *  original partition is not recorded, so the clip lengths are laid out across
 *  that window in the shape a silence cut leaves behind. The second take starts
 *  inside the 0.58 s sliver, so the take itself straddles a boundary too. */
const REAL_TAKE_ONE = 'and this is the trick behind used in every one of these models';
const REAL_TAKE_TWO = 'down and the trick being used in every one of these models is the same';

function straddlingRestart() {
  const clips = [
    { id: 'r0', source_start: 5030, duration: 228, start_frame: 0 },
    { id: 'r1', source_start: 5258, duration: 6, start_frame: 228 },
    { id: 'r2', source_start: 5264, duration: 14, start_frame: 234 },
    { id: 'r3', source_start: 5278, duration: 251, start_frame: 248 },
  ].map((c) => ({
    ...c,
    name: c.id,
    source_path: SOURCE,
    source_len: 24 * 600,
    source_fps: 24,
  }));
  return {
    id: 'tl',
    name: 'B-237',
    rate: { num: 24, den: 1 },
    tracks: [
      { kind: 'video', clips, gain: 1, sync_locked: false },
      { kind: 'audio', clips: [], gain: 1, sync_locked: false },
    ],
    markers: [],
  };
}

function restartTranscript(): Transcript {
  const segments = [
    { start: 200.0, end: 209.0, text: 'so before we get to any of that there is one more thing' },
    { start: 210.4, end: 219.05, text: REAL_TAKE_ONE },
    { start: 219.5, end: 229.6, text: REAL_TAKE_TWO },
    { start: 230.0, end: 236.0, text: 'which brings us neatly to the next part' },
  ];
  return { text: segments.map((s) => s.text).join(' '), segments, language: 'en' } as Transcript;
}

describe('a restart split across clips by an earlier silence cut (B-237)', () => {
  beforeEach(() => {
    backend.retakeGroups = 1;
    backend.retakeMode = 'similar';
    useMediaUnderstandingStore.setState({ transcripts: { [SOURCE]: restartTranscript() } });
  });

  /** THE regression test. Before D-364 each of these four clips was asked
   *  about on its own, and no single one of those views held both takes — so
   *  the sweep returned nothing, which is exactly what happened on the owner's
   *  real project six times out of seven. */
  it('finds the group the per-clip sweep could never have seen', async () => {
    await mountWith(straddlingRestart());

    const env = await callOp('editor_detect_retakes', { track: 0 });

    expect(env.result.state).toBe('done');
    expect(env.result.runs).toBe(1);
    expect(env.result.totals.findings).toBe(1);
    expect(env.result.flagged).toHaveLength(1);

    const group = env.result.flagged[0].groups[0];
    expect(group.takes.map((t: { text: string }) => t.text)).toEqual([
      REAL_TAKE_ONE,
      REAL_TAKE_TWO,
    ]);
    // The detector was handed both halves in ONE call. That is the fix.
    const detect = backend.calls.filter((c) => c.cmd === 'chroma_detect_retakes');
    expect(detect).toHaveLength(1);
    const handed = (detect[0].args?.utterances ?? []) as Array<{ text: string }>;
    expect(handed.map((u) => u.text)).toContain(REAL_TAKE_ONE);
    expect(handed.map((u) => u.text)).toContain(REAL_TAKE_TWO);
  });

  /** The half of the fix that stops it being a different bug: a take that
   *  straddles clips must come back as every range it covers, or accepting it
   *  would cut one piece and leave the rest on the timeline. */
  it('reports the straddling take as one range per clip it lands in', async () => {
    await mountWith(straddlingRestart());

    const env = await callOp('editor_detect_retakes', { track: 0 });
    const takes = env.result.flagged[0].groups[0].takes;

    // Take 1 sits inside clip 0: one segment, and the flat frame fields it has
    // always carried.
    expect(takes[0].clips).toEqual([0]);
    expect(takes[0].segments).toHaveLength(1);
    expect(takes[0]).toHaveProperty('startFrame');

    // Take 2 enters in the 0.58s sliver and finishes in clip 3.
    expect(takes[1].clips).toEqual([2, 3]);
    expect(takes[1].segments.map((s: { clip: number }) => s.clip)).toEqual([2, 3]);
    for (const seg of takes[1].segments) {
      expect(seg.endFrame).toBeGreaterThan(seg.startFrame);
    }
    // And NO single flat range, because no single range describes it — a caller
    // that read one blindly would under-cut.
    expect(takes[1].startFrame).toBeUndefined();
    expect(takes[1].endFrame).toBeUndefined();
  });

  /** Asking about the clip the second take FINISHES in must surface the group
   *  it is half of — the single-clip question a human asks from the Recut panel
   *  when they can hear the stumble but only part of it is in this clip. */
  it('surfaces the straddling group from a single-clip call on either half', async () => {
    await mountWith(straddlingRestart());

    const first = await callOp('editor_detect_retakes', { track: 0, clip: 0 });
    const last = await callOp('editor_detect_retakes', { track: 0, clip: 3 });

    expect(first.result.groups).toHaveLength(1);
    expect(last.result.groups).toHaveLength(1);
    expect(last.result.readAcrossClips).toEqual([0, 1, 2, 3]);
    // Both calls asked the identical question, so the detector ran once.
    expect(backend.calls.filter((c) => c.cmd === 'chroma_detect_retakes')).toHaveLength(1);
  });

  /** Nothing is cut, by either form — D-318's contract, unchanged. */
  it('still proposes rather than cuts', async () => {
    await mountWith(straddlingRestart());

    const env = await callOp('editor_detect_retakes', { track: 0 });

    expect(env.result.note).toMatch(/nothing was cut/);
    expect(backend.calls.some((c) => c.cmd === 'chroma_timeline_set')).toBe(false);
  });
});

/** B-249 — the D-349 chain a start call asked for must be carried to its answer
 *  by POLLING, because that is what the start call's own note tells the agent
 *  to do. Before the fix the `_status` twin read the chain without advancing it,
 *  so once the scan landed nothing ever started the re-reads, and the sweep
 *  said `transcribing` for ever. */
describe('a retake job a start call asked for is finished by polling (B-249)', () => {
  /** One 10 s clip whose transcript reads 0-3 s and 7-10 s and has a hole
   *  between: the shape a dropped utterance leaves, so the scan finds it. */
  function wordedTranscript(): Transcript {
    const w = (word: string, start: number, end: number) => ({ word, start, end });
    const words = [w(' first', 0.5, 1.0), w(' line', 1.0, 1.5), w(' last', 7.5, 8.0), w(' line', 8.0, 8.5)];
    return {
      text: 'first line last line',
      language: 'en',
      segments: [
        { start: 0.5, end: 1.5, text: 'first line', words: words.slice(0, 2) },
        { start: 7.5, end: 8.5, text: 'last line', words: words.slice(2) },
      ],
      words,
    } as Transcript;
  }

  function region(): Record<string, unknown> {
    return {
      start_secs: 4.0,
      end_secs: 6.0,
      duration_secs: 2.0,
      stretch_start_secs: 1.5,
      stretch_end_secs: 7.5,
      stretch_speech_secs: 2.0,
      rms_peak: 0.2,
    };
  }

  const count = (cmd: string) => backend.calls.filter((c) => c.cmd === cmd).length;

  /** Release the held scan and let its promise chain settle into the store. */
  async function releaseScan(): Promise<void> {
    await act(async () => {
      for (const release of backend.releaseScans.splice(0)) release();
      await Promise.resolve();
    });
  }

  it.each([
    ['a whole-track sweep', { track: 0 }],
    ['a single named clip', { track: 0, clip: 0 }],
  ])('%s: polling carries scan -> re-read -> grouping to done', async (_label, args) => {
    backend.darkRegions = [region()];
    useMediaUnderstandingStore.setState({ transcripts: { [SOURCE]: wordedTranscript() } });
    await mountWith(fixture(1));

    // The start call kicks the scan and returns while it is still running.
    const started = await callOp('editor_detect_retakes', args);
    expect(started.ok).toBe(true);
    expect(count('chroma_detect_dark_regions')).toBe(1);
    expect(count('chroma_transcribe')).toBe(0);

    await releaseScan();

    // THE bug: this poll used to read the finished scan and start nothing.
    const polled = await callOp('editor_detect_retakes_status', args);
    expect(polled.ok).toBe(true);
    expect(count('chroma_transcribe')).toBe(1);
    // The re-read is the stretch plus context (D-387) — here clamped to the
    // 10 s clip — pinned to the whole-file language (D-349).
    expect(backend.calls.find((c) => c.cmd === 'chroma_transcribe')?.args).toMatchObject({
      path: SOURCE,
      language: 'en',
      startSecs: 0,
      durationSecs: 10,
    });

    // The re-read is a polled sidecar job; let it land.
    await vi.waitFor(
      () => expect(Object.keys(useMediaUnderstandingStore.getState().recoveries)).toHaveLength(1),
      { timeout: 5000 },
    );

    // The next poll starts the grouping on the spliced words and answers.
    const answered = await callOp('editor_detect_retakes_status', args);
    expect(count('chroma_detect_retakes')).toBe(1);
    const handed = (backend.calls.find((c) => c.cmd === 'chroma_detect_retakes')?.args?.utterances ??
      []) as Array<{ text: string }>;
    expect(handed.map((u) => u.text)).toContain('the line it dropped');
    expect(answered.result.state).toBe('done');
    // The re-read put words over the region, so nothing is reported unread.
    expect(answered.result.unreadDarkRegions).toEqual([]);
    // Answered, so the request is settled: a further poll is a pure read.
    expect(useMediaUnderstandingStore.getState().retakeRequests).toEqual({});
    await callOp('editor_detect_retakes_status', args);
    expect(count('chroma_detect_retakes')).toBe(1);
  }, 15000);

  /** The other half of the rule: a status read nobody asked for still starts
   *  nothing, and says so instead of claiming work is in progress. */
  it('a status read no start call asked for starts nothing and says so', async () => {
    backend.darkRegions = [region()];
    useMediaUnderstandingStore.setState({ transcripts: { [SOURCE]: wordedTranscript() } });
    await mountWith(fixture(1));

    const sweep = await callOp('editor_detect_retakes_status', { track: 0 });
    const single = await callOp('editor_detect_retakes_status', { track: 0, clip: 0 });

    expect(count('chroma_detect_dark_regions')).toBe(0);
    expect(count('chroma_detect_retakes')).toBe(0);
    expect(sweep.result.state).toBe('idle');
    expect(sweep.result.notStarted).toEqual([0]);
    expect(single.result.state).toBe('idle');
    expect(single.result.note).toMatch(/call editor_detect_retakes/);
  });
});
