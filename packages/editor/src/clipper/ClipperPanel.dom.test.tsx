// @vitest-environment jsdom
/**
 * D-411 / D-443 — the redesigned Clipper in a real DOM (B-363): the list in the
 * browser and the surface in the viewer area, mounted side by side the way
 * `EditorTab` lays them out. With no run: New shorts opens the setup form in
 * the viewer area (length chips, frame shapes, More options). A run with no
 * suggestions: the list says the agent picks; the surface shows the request to
 * paste (the app never picks, D-411). A run with suggestions: one card per
 * short (title, opening line, clean-cut chip, status), the count line and a
 * Make button that says what it makes; selecting a card fills the surface with
 * the review (the check as sentences, what is in and out), and A / X / ↓ review
 * from the keyboard, moving on to the next short to review.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';

import { createInvokeStub, installResizeObserverStub, mount, waitFrames, type MountedComponent } from '../testUtils/pointerHarness';

const seeded = vi.hoisted(() => ({ runs: [] as Array<{ id: string }>, saved: [] as unknown[] }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_clip_run_list: () => ({ runs: seeded.runs.map((r) => ({ id: r.id, createdAt: '', sourceName: '', proposals: 0, built: 0 })), errors: [] }),
    chroma_clip_run_load: (args) => seeded.runs.find((r) => r.id === (args as { id: string }).id),
    chroma_clip_run_save: (args) => {
      seeded.saved.push((args as { run: unknown }).run);
      return null;
    },
    chroma_clip_thumbnails: () => [],
    chroma_clipper_analyze: () => ({
      viewId: 'v1',
      totalSentences: 4,
      totalWords: 40,
      topics: 1,
      candidates: 1,
      offset: 0,
      returned: 4,
      nextOffset: null,
      rulesVersion: 1,
      evidence: [{ path: '/a.mov', audio: { state: 'done' }, scenes: { state: 'done' } }],
      analysis: {
        sentences: [0, 1, 2, 3].map((i) => ({ index: i, firstWord: i * 10, lastWord: i * 10 + 9, piece: 0, startSecs: i * 5, endSecs: i * 5 + 4.5, text: `Sentence ${i}.`, ending: 'period', topic: 0, tags: [] })),
        topics: [{ firstSentence: 0, lastSentence: 3, keywords: ['pricing'] }],
        candidates: [{ id: 'c0-2', targetSecs: 15, firstSentence: 0, lastSentence: 2, topic: 0, rawSecs: 14.7, tightSecs: 14.2, tags: ['question'], warnings: [] }],
      },
    }),
    chroma_clipper_evidence_start: () => ({}),
  }),
}));

import { useMediaPoolStore } from '@apelles/bridge';
import { useEditorTimelineStore } from '../timelineStore';
import { useMediaUnderstandingStore } from '../mediaUnderstandingStore';
import { ClipperPanel } from './ClipperPanel';
import { ClipperSurface } from './ClipperSurface';
import { useClipperStore } from './clipperStore';
import type { ClipProposal, ClipRun } from './clipperTypes';

const run = (proposals: ClipRun['proposals']): ClipRun => ({
  schema: 1,
  id: 'run-1',
  created_at: '2026-10-30T10:00:00Z',
  source: { kind: 'media', media_id: 'm1', path: '/a.mov', name: 'Voiceover v2' },
  settings: { durations: [15, 30], count: 3, aspect: '9:16', captions: 'brand', hook_first: true, tighten: { dead_air: true, retakes: true } },
  proposals,
});

const resolved = (first: number, last: number) => ({
  ranges: [{ role: 'body' as const, piece: 0, source: 0, first_word: first * 10, last_word: last * 10 + 9, start_secs: first * 5, end_secs: last * 5 + 4.5, cuts: [{ kind: 'dead_air' as const, start_secs: 6, end_secs: 7.2 }] }],
  raw_secs: 14.7,
  tight_secs: 14.2,
  first_sentence: first,
  last_sentence: last,
});

const proposal = (id: string, extra: Partial<ClipProposal>): ClipProposal => ({
  id,
  shape: { hook: null, segments: [{ first_word: 10, last_word: 29 }] },
  title: `Short ${id}`,
  reason: 'a complete story',
  hook_line: 'Sentence 1.',
  picked_by: 'client',
  view_id: 'v1',
  rules_version: 1,
  verdict: { verdict: 'verified', resolved: resolved(1, 2) },
  gate_notes: [],
  status: 'pending',
  ...extra,
});

/** The list and the surface, side by side, as `EditorTab` lays them out. */
function Both() {
  return React.createElement(
    'div',
    null,
    React.createElement(ClipperPanel),
    React.createElement('div', { style: { position: 'relative' } }, React.createElement(ClipperSurface)),
  );
}

let mounted: MountedComponent | null = null;
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const click = (sel: string) => {
  const el = $(sel);
  if (!el) throw new Error(`no element ${sel}`);
  act(() => (el as HTMLElement).click());
};
const key = (el: Element, k: string) => act(() => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));
const settle = async () => {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFrames(1);
  }
};

beforeEach(() => {
  installResizeObserverStub();
  seeded.saved = [];
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

describe('the Clipper (D-443)', () => {
  it('with no run, New shorts opens the setup form in the viewer area', async () => {
    mounted = mount(React.createElement(Both), { strictMode: false });
    await settle();
    expect($('[data-chroma-clipper-surface]')).toBeNull();
    click('[data-chroma-clipper-new]');
    await settle();
    expect($('[data-chroma-clipper-surface="setup"]')).not.toBeNull();
    expect($('[data-chroma-clipper-duration="30"]')?.getAttribute('aria-pressed')).toBe('true');
    expect($('[data-chroma-clipper-duration="15"]')?.getAttribute('aria-pressed')).toBe('false');
    expect($('[data-chroma-clipper-aspect="9:16"]')?.getAttribute('aria-checked')).toBe('true');
    click('[data-chroma-clipper-more]');
    await settle();
    expect(document.body.textContent).toContain('Open with the strongest line, even if it comes later');
    expect(document.body.textContent).toContain('Leave out flubbed takes');
    expect($('[data-chroma-clipper-analyse]')?.textContent).toContain('Find moments');
    // Esc closes it and the viewer comes back.
    key($('[data-chroma-clipper-surface]')!, 'Escape');
    expect($('[data-chroma-clipper-surface]')).toBeNull();
  });

  it('a run with no suggestions: the agent picks, and the surface shows what to ask it', async () => {
    seeded.runs = [run([])];
    act(() => useClipperStore.setState({ runs: { 'run-1': run([]) }, activeRunId: 'run-1' }));
    mounted = mount(React.createElement(Both), { strictMode: false });
    await settle();
    expect($('[data-chroma-clipper-run]')?.textContent).toContain('Shorts from Voiceover v2');
    expect($('[data-chroma-clipper-status]')?.textContent).toContain('Waiting for your agent');
    expect($('[data-chroma-clipper-build]')).toBeNull();
    click('[data-chroma-clipper-proposals] button');
    await settle();
    const ask = $('[data-chroma-clipper-ask]');
    expect(ask?.textContent).toContain('Apelles never picks on its own');
    expect(ask?.textContent).toContain('apelles-auto-clip');
  });

  it('lists the shorts as cards, reviews the selected one in the viewer area, and A / X / ↓ review from the keyboard', async () => {
    const r = run([
      proposal('p1', {}),
      proposal('p2', { verdict: { verdict: 'warned', resolved: resolved(1, 3), warnings: [{ kind: 'spans_topics' }] }, gate_notes: ['spans 2 topics'] }),
      proposal('p3', { verdict: { verdict: 'refused', reason: { kind: 'start_not_at_sentence' }, offending: [3] }, gate_notes: ['a segment starts mid-sentence'] }),
    ]);
    seeded.runs = [r];
    act(() => useClipperStore.setState({ runs: { 'run-1': r }, activeRunId: 'run-1' }));
    mounted = mount(React.createElement(Both), { strictMode: false });
    await settle();
    const cards = document.querySelectorAll('[data-chroma-clipper-proposal]');
    expect(cards).toHaveLength(3);
    expect(cards[0].textContent).toContain('Short p1');
    expect(cards[0].textContent).toContain('“Sentence 1.”');
    expect(cards[0].textContent).toContain('Clean cut');
    expect(cards[1].textContent).toContain('1 warning');
    expect(cards[2].textContent).toContain('Needs a fix');
    expect($('[data-chroma-clipper-counts]')?.textContent).toBe('3 to review');
    expect($<HTMLButtonElement>('[data-chroma-clipper-build]')?.disabled).toBe(true);
    expect(document.body.textContent).toContain('Approve at least one short (A) to make it.');

    click('[data-chroma-clipper-proposal="p2"]');
    await settle();
    const review = $('[data-chroma-clipper-review="p2"]');
    expect(review).not.toBeNull();
    expect(review?.textContent).toContain('14 s');
    expect(review?.textContent).toContain('(target 15–30 s)');
    expect($('[data-chroma-clipper-warning]')?.textContent).toContain('Spans 2 topics. Try ending one sentence earlier');
    const lines = [...document.querySelectorAll('[data-chroma-clipper-line]')].map((l) => l.getAttribute('data-chroma-clipper-line'));
    expect(lines).toEqual(['out', 'in', 'in', 'out']);
    expect($('[data-chroma-clipper-script]')?.textContent).toContain('pause trimmed · 1.2 s');

    // A approves it and moves on to the next short still to review.
    key($('[data-chroma-clipper-surface]')!, 'a');
    await settle();
    expect(useClipperStore.getState().runs['run-1'].proposals[1].status).toBe('accepted');
    expect(useClipperStore.getState().selectedProposalId).toBe('p3');
    expect($('[data-chroma-clipper-counts]')?.textContent).toBe('1 approved · 2 to review');
    expect($('[data-chroma-clipper-build]')?.textContent).toContain('Make 1 short');

    // A short that needs a fix cannot be approved: it says why.
    key($('[data-chroma-clipper-surface]')!, 'a');
    await settle();
    expect(useClipperStore.getState().runs['run-1'].proposals[2].status).toBe('pending');
    expect($('[data-chroma-clipper-notice="error"]')?.textContent).toContain('needs a fix');

    // ↑ to the first, X skips it; X again puts it back.
    key($('[data-chroma-clipper-surface]')!, 'ArrowUp');
    key($('[data-chroma-clipper-surface]')!, 'ArrowUp');
    expect(useClipperStore.getState().selectedProposalId).toBe('p1');
    key($('[data-chroma-clipper-surface]')!, 'x');
    await settle();
    expect(useClipperStore.getState().runs['run-1'].proposals[0].status).toBe('rejected');
    click('[data-chroma-clipper-proposal="p1"]');
    await settle();
    key($('[data-chroma-clipper-proposal="p1"]')!, 'x');
    await settle();
    expect(useClipperStore.getState().runs['run-1'].proposals[0].status).toBe('pending');
    expect(seeded.saved.length).toBeGreaterThanOrEqual(3);
  });
});
