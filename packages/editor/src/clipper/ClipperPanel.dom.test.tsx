// @vitest-environment jsdom
/**
 * D-411 — the Clipper panel's states: the setup for a new run, the "ask your
 * agent" card when a run has no proposals (the panel never picks), and a
 * proposal list with its verdicts, reasons and actions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';

import { createInvokeStub, installResizeObserverStub, mount, waitFrames, type MountedComponent } from '../testUtils/pointerHarness';

const seeded = vi.hoisted(() => ({ runs: [] as Array<{ id: string }> }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_clip_run_list: () => ({ runs: seeded.runs.map((r) => ({ id: r.id, createdAt: '', sourceName: '', proposals: 0, built: 0 })), errors: [] }),
    chroma_clip_run_load: (args) => seeded.runs.find((r) => r.id === (args as { id: string }).id),
    chroma_clipper_analyze: () => ({
      viewId: 'v1',
      totalSentences: 3,
      totalWords: 30,
      topics: 1,
      candidates: 1,
      offset: 0,
      returned: 3,
      nextOffset: null,
      rulesVersion: 1,
      evidence: [{ path: '/a.mov', audio: { state: 'done' }, scenes: { state: 'done' } }],
      analysis: {
        sentences: [0, 1, 2].map((i) => ({ index: i, firstWord: i * 10, lastWord: i * 10 + 9, piece: 0, startSecs: i * 5, endSecs: i * 5 + 4.5, text: `Sentence ${i}.`, ending: 'period', topic: 0, tags: [] })),
        topics: [{ firstSentence: 0, lastSentence: 2, keywords: ['pricing'] }],
        candidates: [{ id: 'c0-2', targetSecs: 15, firstSentence: 0, lastSentence: 2, topic: 0, rawSecs: 14.7, tightSecs: 14.2, tags: ['question', 'lands (1.2s pause)'], warnings: [] }],
      },
    }),
    chroma_clipper_evidence_start: () => ({}),
  }),
}));

import { useMediaPoolStore } from '@apelles/bridge';
import { useEditorTimelineStore } from '../timelineStore';
import { useMediaUnderstandingStore } from '../mediaUnderstandingStore';
import { ClipperPanel } from './ClipperPanel';
import { useClipperStore } from './clipperStore';
import type { ClipRun } from './clipperTypes';

const run = (proposals: ClipRun['proposals']): ClipRun => ({
  schema: 1,
  id: 'run-1',
  created_at: '2026-10-27T10:00:00Z',
  source: { kind: 'media', media_id: 'm1', path: '/a.mov', name: 'a.mov' },
  settings: { durations: [15], count: 3, aspect: '9:16', captions: 'brand', hook_first: true, tighten: { dead_air: true, retakes: true } },
  proposals,
});

let mounted: MountedComponent | null = null;

beforeEach(() => {
  installResizeObserverStub();
  act(() => {
    useEditorTimelineStore.setState({ openProjectKey: '/p.chroma', timelines: [] } as never);
    useMediaPoolStore.setState({
      items: [{ id: 'm1', sourcePath: '/a.mov', name: 'a.mov', added: '', offline: false, video: { width: 1920, height: 1080, fps: 24, frameCount: 360, durationSecs: 15, hasAudio: true } }],
    } as never);
    useMediaUnderstandingStore.setState({ transcripts: { '/a.mov': { text: '', language: 'en', model: 't', source: '/a.mov', segments: [] } }, partialTranscripts: {} });
  });
});

afterEach(() => {
  seeded.runs = [];
  mounted?.unmount();
  mounted = null;
  act(() => useClipperStore.getState().clear());
});

describe('ClipperPanel', () => {
  it('offers a new run’s setup with target-length chips and Analyse', async () => {
    mounted = mount(React.createElement(ClipperPanel), { strictMode: false });
    await waitFrames(2);
    const root = mounted.container;
    expect(root.querySelector('[data-chroma-clipper-setup]')).not.toBeNull();
    expect(root.querySelector('[data-chroma-clipper-duration="30"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('[data-chroma-clipper-analyse]')).not.toBeNull();
  });

  it('says how to ask the agent when a run has no proposals, and shows the evidence', async () => {
    seeded.runs = [run([])];
    act(() => useClipperStore.setState({ runs: { 'run-1': run([]) }, activeRunId: 'run-1' }));
    mounted = mount(React.createElement(ClipperPanel), { strictMode: false });
    await waitFrames(4);
    const root = mounted.container;
    const ask = root.querySelector('[data-chroma-clipper-ask]');
    expect(ask?.textContent).toContain('Your AI agent picks the moments');
    expect(ask?.textContent).toContain('apelles-auto-clip');
    expect(root.querySelector('[data-chroma-clipper-build]')).toBeNull();
    expect(root.querySelector('[data-chroma-clipper-candidates]')?.textContent).toContain('question · lands');
  });

  it('lists proposals with the gate’s verdict and reasons', async () => {
    const resolved = { ranges: [], raw_secs: 14.7, tight_secs: 14.2, first_sentence: 0, last_sentence: 2 };
    const r = run([
            { id: 'p1', shape: { hook: null, segments: [{ first_word: 0, last_word: 29 }] }, title: 'Why churn follows price', reason: 'a complete story', picked_by: 'client', view_id: 'v1', rules_version: 1, verdict: { verdict: 'verified', resolved }, gate_notes: [], status: 'pending' },
            { id: 'p2', shape: { hook: null, segments: [{ first_word: 3, last_word: 29 }] }, title: 'Cut mid-sentence', reason: 'r', picked_by: 'client', view_id: 'v1', rules_version: 1, verdict: { verdict: 'refused', reason: { kind: 'start_not_at_sentence' }, offending: [3] }, gate_notes: ['a segment starts mid-sentence'], status: 'pending' },
    ]);
    seeded.runs = [r];
    act(() => useClipperStore.setState({ runs: { 'run-1': r }, activeRunId: 'run-1' }));
    mounted = mount(React.createElement(ClipperPanel), { strictMode: false });
    await waitFrames(4);
    const root = mounted.container;
    const rows = root.querySelectorAll('[data-chroma-clipper-proposal]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('S0–S2 · 14.2 s');
    expect(rows[1].textContent).toContain('starts mid-sentence');
    expect(root.querySelector('[data-chroma-clipper-build]')?.textContent).toContain('Build 1');
  });
});
