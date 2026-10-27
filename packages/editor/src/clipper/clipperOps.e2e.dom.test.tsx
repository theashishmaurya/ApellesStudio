// @vitest-environment jsdom
/**
 * D-411 Phases 1-2 — the Automatic Clipper end to end at the OP layer: the
 * seven `editor_*clip*` ops driven through the real `chroma://request`
 * dispatch, the clipper store the panel reads, the real build
 * (`clipBuild.ts`: clips, ripple-delete tightening, captions from the
 * timeline transcript, provenance) and the real rebuild protection.
 *
 * The story: analyse a media file (`editor_auto_clip` — nothing is picked),
 * read the moment view, the client proposes three shorts and one that is too
 * short — three 9:16 timelines are built and the fourth is refused by name —
 * the person rejects and nudges, a rebuild over a person's edit is refused
 * until they choose a new version, and a stale view is refused.
 *
 * **Tier and its honest limit.** jsdom, with the Rust commands stubbed by
 * small stand-ins: sentences are the transcript's segments, the gate checks
 * only the length band, a content hash is the JSON. The real analysis and
 * clean-cut gate are `apelles-clipper`'s, pinned by its own suites and the
 * eval (`crates/apelles-clipper/tests/`); the view-id and paging rules by
 * `chroma::clipper`'s tests. What is on trial here: the op contracts, the run
 * lifecycle, persistence calls, and the build.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';

import { createInvokeStub, mount, waitFrames, type MountedComponent } from '../testUtils/pointerHarness';

const SOURCE = '/fixtures/podcast.mov';

type Seg = { start: number; end: number; words: Array<{ word: string; start: number; end: number }> };
type Req = {
  sources: Array<{ path: string; segments: Seg[] }>;
  pieces: Array<{ source: number; startSecs: number; endSecs: number }>;
  durations: number[];
};

const disk = vi.hoisted(() => ({
  runs: new Map<string, unknown>(),
  timelines: new Map<string, Record<string, unknown>>(),
  created: 0,
  replaced: [] as Array<Record<string, unknown>>,
}));

/** The stand-in analysis: one sentence per transcript segment. */
function sentencesOf(req: Req) {
  const out: Array<{ first: number; last: number; start: number; end: number; text: string; source: number; piece: number }> = [];
  let w = 0;
  req.pieces.forEach((p, piece) => {
    for (const seg of req.sources[p.source].segments) {
      const words = seg.words.filter((x) => (x.start + x.end) / 2 >= p.startSecs && (x.start + x.end) / 2 < p.endSecs);
      if (words.length === 0) continue;
      out.push({ first: w, last: w + words.length - 1, start: words[0].start, end: words[words.length - 1].end, text: words.map((x) => x.word.trim()).join(' '), source: p.source, piece });
      w += words.length;
    }
  });
  return out;
}
const viewIdOf = (req: Req) => `v${sentencesOf(req).map((s) => s.text).join('|').length}-${sentencesOf(req).length}`;
const hashOf = (tl: Record<string, unknown>) => JSON.stringify({ r: tl.rate, o: tl.output, t: tl.tracks, m: tl.markers ?? [] });

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_clipper_analyze: (args) => {
      const r = (args as { request: Req & { offset: number; render: boolean; includeAnalysis: boolean } }).request;
      const ss = sentencesOf(r);
      return {
        viewId: viewIdOf(r),
        totalSentences: ss.length,
        totalWords: ss.length ? ss[ss.length - 1].last + 1 : 0,
        topics: 1,
        candidates: 0,
        offset: r.offset,
        returned: ss.length - r.offset,
        nextOffset: null,
        rulesVersion: 1,
        evidence: [],
        ...(r.render ? { text: ss.map((s, i) => `S${i}  ${s.text}`).join('\n'), ...(r.offset === 0 ? { rules: 'RULES' } : {}) } : {}),
        ...(r.includeAnalysis
          ? {
              analysis: {
                sentences: ss.map((s, i) => ({ index: i, firstWord: s.first, lastWord: s.last, piece: s.piece, startSecs: s.start, endSecs: s.end, text: s.text, ending: 'period', topic: 0, tags: [] })),
                topics: [{ firstSentence: 0, lastSentence: ss.length - 1, keywords: [] }],
                candidates: [],
              },
            }
          : {}),
      };
    },
    chroma_clipper_check: (args) => {
      const r = (args as { request: Req & { viewId: string; proposals: Array<{ segments: Array<{ first: number; last: number }>; unit?: string }> } }).request;
      if (r.viewId !== viewIdOf(r)) return { stale: true, viewId: viewIdOf(r) };
      const ss = sentencesOf(r);
      return {
        stale: false,
        viewId: viewIdOf(r),
        verdicts: r.proposals.map((p) => {
          const segs = p.segments.map((s) =>
            p.unit === 'word'
              ? { first_word: s.first, last_word: s.last }
              : { first_word: ss[s.first].first, last_word: ss[s.last].last },
          );
          const sentenceOfWord = (w: number) => ss.findIndex((s) => s.first <= w && w <= s.last);
          const ranges = segs.map((s) => {
            const a = ss[sentenceOfWord(s.first_word)];
            const b = ss[sentenceOfWord(s.last_word)];
            return { role: 'body', piece: 0, source: a.source, first_word: s.first_word, last_word: s.last_word, start_secs: a.start, end_secs: b.end + 0.2, cuts: [] };
          });
          const secs = ranges.reduce((n, x) => n + x.end_secs - x.start_secs, 0);
          const ok = r.durations.some((t) => secs >= t * 0.7 && secs <= t * 1.25);
          const shape = { hook: null, segments: segs };
          if (!ok) {
            return { shape, verdict: { verdict: 'refused', reason: { kind: 'duration_out_of_range' }, offending: [segs[0].first_word] }, status: 'refused', reasonText: `the clip runs ${secs.toFixed(1)} s`, warnings: [], offendingSentences: [] };
          }
          const resolved = { ranges, raw_secs: secs, tight_secs: secs, first_sentence: sentenceOfWord(segs[0].first_word), last_sentence: sentenceOfWord(segs[segs.length - 1].last_word) };
          return { shape, verdict: { verdict: 'verified', resolved }, status: 'verified', reasonText: null, warnings: [] };
        }),
      };
    },
    chroma_clipper_evidence_start: () => ({ audio: { state: 'done' }, scenes: { state: 'done' } }),
    chroma_clip_run_save: (args) => {
      const run = (args as { run: { id: string } }).run;
      disk.runs.set(run.id, JSON.parse(JSON.stringify(run)));
    },
    chroma_clip_run_list: () => ({ runs: [...disk.runs.keys()].map((id) => ({ id, createdAt: '', sourceName: '', proposals: 0, built: 0 })), errors: [] }),
    chroma_clip_run_load: (args) => disk.runs.get((args as { id: string }).id),
    chroma_timeline_create: (args) => {
      const a = args as { name: string; output: unknown };
      const tl = { id: `short-${++disk.created}-0000`, name: a.name, rate: { num: 24, den: 1 }, tracks: [], output: a.output };
      disk.timelines.set(tl.id, tl);
      return tl;
    },
    chroma_timeline_list: () => [...disk.timelines.values()].map((t) => ({ id: t.id, name: t.name, duration: 0, active: false, output: t.output, origin: t.origin })),
    chroma_timeline_get_by_id: (args) => {
      const tl = disk.timelines.get((args as { id: string }).id);
      if (!tl) throw new Error('no timeline');
      return tl;
    },
    chroma_timeline_replace: (args) => {
      const a = args as { id: string; timeline: Record<string, unknown> };
      disk.timelines.set(a.id, JSON.parse(JSON.stringify(a.timeline)));
      disk.replaced.push(a.timeline);
    },
    chroma_clipper_content_hash: (args) => hashOf((args as { timeline: Record<string, unknown> }).timeline),
    chroma_clipper_copy_grades: () => 0,
    chroma_brand_project_get: () => null,
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

import { useMediaPoolStore } from '@apelles/bridge';
import { useEditorTimelineStore } from '../timelineStore';
import { useMediaUnderstandingStore, type Transcript } from '../mediaUnderstandingStore';
import { useEditorControl } from '../useEditorControl';
import { useClipperStore } from './clipperStore';

interface OpEnvelope {
  ok: boolean;
  error: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the op payload is deliberately untyped over the wire
  result: any;
}

let requestId = 0;
let mounted: MountedComponent | null = null;

async function callOp(op: string, args: Record<string, unknown> = {}): Promise<OpEnvelope> {
  const id = `clip-${++requestId}`;
  const handlers = [...(bus.listeners.get('chroma://request') ?? [])];
  await act(async () => {
    await Promise.all(handlers.map((h) => h({ payload: { id, op, args } })));
  });
  const hit = bus.emitted.find((e) => e.event === `chroma://response/${id}`);
  if (!hit) throw new Error(`no response emitted for ${op}`);
  return hit.payload as OpEnvelope;
}

/** 24 sentences of 5 s each (10 words, 0.5 s apart) — two minutes. */
function transcript(): Transcript {
  const segments = Array.from({ length: 24 }, (_, s) => {
    const words = Array.from({ length: 10 }, (_, k) => ({ word: ` s${s}w${k}${k === 9 ? '.' : ''}`, start: s * 5 + k * 0.5, end: s * 5 + k * 0.5 + 0.4 }));
    return { start: words[0].start, end: words[9].end, text: words.map((w) => w.word).join(''), words };
  });
  return { text: '', language: 'en', model: 't', source: SOURCE, segments, words: segments.flatMap((s) => s.words) };
}

function Harness(): React.ReactElement {
  useEditorControl();
  return React.createElement('div');
}

beforeEach(async () => {
  bus.emitted.length = 0;
  disk.runs.clear();
  disk.timelines.clear();
  disk.replaced.length = 0;
  disk.created = 0;
  useClipperStore.getState().clear();
  act(() => {
    useEditorTimelineStore.setState({
      timeline: { id: 'long', name: 'Episode', rate: { num: 24, den: 1 }, tracks: [], markers: [] } as never,
      openProjectKey: '/projects/clip.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
    });
    useMediaPoolStore.setState({
      items: [
        {
          id: 'm1',
          sourcePath: SOURCE,
          name: 'podcast.mov',
          added: '',
          offline: false,
          video: { width: 1920, height: 1080, fps: 24, frameCount: 24 * 125, durationSecs: 125, hasAudio: true },
        },
      ],
    } as never);
    useMediaUnderstandingStore.setState({ transcripts: { [SOURCE]: transcript() }, partialTranscripts: {} });
  });
  mounted = mount(React.createElement(Harness), { strictMode: false });
  await waitFrames(2);
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  bus.listeners.clear();
  act(() => useEditorTimelineStore.setState({ timeline: null, openProjectKey: null, status: 'idle' }));
});

async function analysed(durations = [15]): Promise<{ runId: string; viewId: string }> {
  const r = await callOp('editor_auto_clip', { mediaId: 'm1', durations, count: 3 });
  expect(r.ok, String(r.error)).toBe(true);
  return { runId: r.result.runId, viewId: r.result.view.viewId };
}

const clip = (first: number, last: number, title: string) => ({ segments: [{ first, last }], title, reason: `${title} — a complete thought`, hook_line: 'a line' });

describe('editor_auto_clip (D-411: analyse, never pick)', () => {
  it('creates and persists a run, and serves page 0 of the moment view with the rules', async () => {
    const r = await callOp('editor_auto_clip', { mediaId: 'm1', durations: [15, 30], count: 3, focus: 'pricing' });
    expect(r.ok, String(r.error)).toBe(true);
    const res = r.result;
    expect(res.state).toBe('ready');
    expect(res.proposals).toBe(0);
    expect(res.view.instructions).toBe('RULES');
    expect(res.view.text).toContain('S0');
    expect(res.view.provisional).toBe(false);
    expect(res.settings).toMatchObject({ durations: [15, 30], count: 3, aspect: '9:16', captions: 'brand', focus: 'pricing' });
    expect(disk.runs.has(res.runId)).toBe(true);
    expect(useClipperStore.getState().activeRunId).toBe(res.runId);
  });

  it('refuses a bad target length, an unknown source and the unbuilt trailer by name', async () => {
    expect((await callOp('editor_auto_clip', { mediaId: 'm1', durations: [45] })).result.error).toContain('45 s is not a target length');
    expect((await callOp('editor_auto_clip', { mediaId: 'nope' })).result.error).toContain('no media-pool item');
    expect((await callOp('editor_auto_clip', { mediaId: 'm1', outputs: 'trailer' })).result.error).toContain('Phase 6');
  });

  it('reports a cold source as transcribing with no view', async () => {
    act(() => useMediaUnderstandingStore.setState({ transcripts: {}, transcribing: { [SOURCE]: true } }));
    const r = await callOp('editor_auto_clip', { mediaId: 'm1' });
    expect(r.result.state).toBe('transcribing');
    expect(r.result.view).toBeUndefined();
    const status = await callOp('editor_auto_clip_status', { runId: r.result.runId });
    expect(status.result.state).toBe('transcribing');
  });
});

describe('the client proposes 3 shorts → 3 timelines are built', () => {
  it('gates every clip, builds the passing ones as 9:16 timelines with provenance and captions', async () => {
    const { runId, viewId } = await analysed();
    const page = await callOp('editor_get_moment_view', { runId, offset: 0 });
    expect(page.result.viewId).toBe(viewId);

    const r = await callOp('editor_propose_clips', {
      runId,
      viewId,
      clips: [clip(0, 2, 'Why churn follows price'), clip(5, 7, 'The 80% rule'), clip(10, 12, 'Hire slowly'), clip(20, 20, 'Too short')],
    });
    expect(r.ok, String(r.error)).toBe(true);
    const res = r.result;
    expect(res.verified).toBe(3);
    expect(res.refused).toBe(1);
    expect(res.proposals[3].gate).toBe('refused');
    expect(res.proposals[3].notes[0]).toContain('the clip runs');
    expect(res.build.results).toHaveLength(3);
    expect(res.build.results.every((x: { ok: boolean }) => x.ok)).toBe(true);

    expect(disk.replaced).toHaveLength(3);
    for (const tl of disk.replaced as Array<{ output: unknown; origin: Record<string, unknown>; tracks: Array<{ kind: string; clips: unknown[] }>; name: string }>) {
      expect(tl.output).toEqual({ width: 1080, height: 1920 });
      expect(tl.origin.kind).toBe('clip_short');
      expect(tl.origin.run_id).toBe(runId);
      expect(tl.origin.built_at_view).toBe(viewId);
      expect(tl.origin.built_content_hash).toBeTruthy();
      expect(tl.tracks.map((t) => t.kind)).toEqual(['video', 'audio', 'subtitle']);
      expect(tl.tracks[2].clips.length).toBeGreaterThan(0);
    }
    expect((disk.replaced[0] as { name: string }).name).toBe('Why churn follows price');
    const run = disk.runs.get(runId) as { proposals: Array<{ id: string; status: string; timeline_id: string | null }> };
    expect(run.proposals.filter((p) => p.status === 'built')).toHaveLength(3);
    expect(run.proposals[3].status).toBe('pending');

    const listed = await callOp('editor_list_clip_proposals', { runId });
    expect(listed.result.proposals.map((p: { status: string }) => p.status)).toEqual(['built', 'built', 'built', 'pending']);
    const runs = await callOp('editor_list_clip_proposals', {});
    expect(runs.result.runs[0]).toMatchObject({ id: runId, built: 3 });
  });

  it('refuses a stale view and a proposal while transcribing', async () => {
    const { runId } = await analysed();
    const stale = await callOp('editor_propose_clips', { runId, viewId: 'old', clips: [clip(0, 2, 'x')] });
    expect(stale.result.error).toContain('stale view_id');
    expect(disk.replaced).toHaveLength(0);
  });
});

describe('review: reject, nudge, rebuild', () => {
  it('re-gates a nudge by sentence and refuses a rebuild over a person’s edit until they choose', async () => {
    const { runId, viewId } = await analysed([15, 30]);
    await callOp('editor_propose_clips', { runId, viewId, clips: [clip(0, 2, 'One'), clip(5, 7, 'Two')], build: false });
    expect(disk.replaced).toHaveLength(0);

    const rejected = await callOp('editor_set_clip_proposal', { runId, id: 'p2', status: 'rejected' });
    expect(rejected.result.proposal.status).toBe('rejected');

    // Two more sentences at the end: 3 → 5 sentences, ~25 s, in the 30 s band.
    const nudged = await callOp('editor_set_clip_proposal', { runId, id: 'p1', extendEnd: 2 });
    expect(nudged.ok, String(nudged.error)).toBe(true);
    expect(nudged.result.proposal.sentences).toEqual({ first: 0, last: 4 });
    expect(nudged.result.proposal.gate).toBe('verified');
    // Four more: ~45 s, outside every band — re-gated and refused.
    const tooLong = await callOp('editor_set_clip_proposal', { runId, id: 'p1', extendEnd: 4 });
    expect(tooLong.result.proposal.gate).toBe('refused');
    const back = await callOp('editor_set_clip_proposal', { runId, id: 'p1', extendEnd: -4 });
    expect(back.result.proposal.gate).toBe('verified');

    const built = await callOp('editor_build_clips', { runId });
    expect(built.result.results).toHaveLength(1);
    expect(built.result.results[0].ok).toBe(true);
    const id = built.result.results[0].timelineId as string;

    // A person trims the short.
    const tl = disk.timelines.get(id) as { tracks: Array<{ clips: Array<{ duration: number }> }> };
    tl.tracks[0].clips[0].duration -= 10;

    const refused = await callOp('editor_build_clips', { runId, ids: ['p1'], rebuild: true });
    expect(refused.result.results[0].ok).toBe(false);
    expect(refused.result.results[0].error).toContain('edited since it was built');
    const again = await callOp('editor_build_clips', { runId, ids: ['p1'], mode: 'new_version' });
    expect(again.result.results[0].ok).toBe(true);
    expect(again.result.results[0].timelineId).not.toBe(id);
    expect((disk.timelines.get(id) as { tracks: Array<{ clips: Array<{ duration: number }> }> }).tracks[0].clips[0].duration).toBe(tl.tracks[0].clips[0].duration);
    const replaced = await callOp('editor_build_clips', { runId, ids: ['p1'], mode: 'replace' });
    expect(replaced.result.results[0].ok).toBe(true);
  });
});
