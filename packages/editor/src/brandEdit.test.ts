// D-416 — a brand kit on the Edit timeline: the plan (pure), the composed op
// (journal-replayable, refusals unchanged), and ONE undo step in the store.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string): Promise<unknown> => {
    if (cmd === 'chroma_text_fonts') return [];
    return null;
  },
}));

import { starterKit, type BrandKit } from '@apelles/brand';
import { useHistoryStore } from '@apelles/history';
import { applyOp, type Clip, type Timeline } from './timeline';
import { captionPresetById } from './captionPresets';
import { applyBrandToEdit, editFontKey, planBrandText } from './brandEdit';
import { useEditorTimelineStore } from './timelineStore';

const FONT = `sha256:${'c'.repeat(64)}.ttf`;

const kit = (): BrandKit => ({
  ...starterKit('acme', 'Acme'),
  colors: { primary: '#ff5a1f', secondary: '#1b2a4a', accent: '#00b3a4', background: '#101014', text: '#fafafa' },
  typography: {
    display: { family: 'Acme Grotesk', source: 'file', file: FONT, licence: 'video licence' },
    body: { family: 'Inter', source: 'google', editFallback: 'sans' },
  },
  captions: { preset: 'plain-clean', font: 'display', color: 'primary' },
});

const caption = (id: string, start: number): Clip => ({
  id,
  name: id,
  source_path: '',
  source_start: 0,
  duration: 24,
  source_len: 24,
  start_frame: start,
  caption: { text: id },
});

const title = (id: string, start: number): Clip => ({
  id,
  name: 'Hello',
  source_path: '',
  source_start: 0,
  duration: 24,
  source_len: 24,
  start_frame: start,
  text: { content: 'Hello', font: 'serif', size: 0.1, color: '#000000' },
});

const tl = (): Timeline => ({
  id: 'tl-1',
  name: 'Timeline 1',
  rate: { num: 24, den: 1 },
  tracks: [
    { kind: 'video', clips: [title('t1', 0)] },
    { kind: 'subtitle', clips: [caption('c1', 0)] },
    { kind: 'subtitle', clips: [caption('c2', 0)], locked: true },
    { kind: 'video', clips: [title('t2', 0)], locked: true },
  ],
});

describe('planBrandText', () => {
  it('uses a .ttf/.otf file, then the editFallback, else keeps the preset font and says so', () => {
    expect(editFontKey(kit(), 'display')).toBe(FONT);
    expect(editFontKey(kit(), 'body')).toBe('sans');
    const k = kit();
    k.typography.body = { family: 'Inter', source: 'google' };
    k.captions = { preset: 'plain-subtitle' };
    const plan = planBrandText(tl(), k, { titles: false });
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.op.captionStyle?.font).toBe(captionPresetById('plain-subtitle')?.style.font);
    expect(plan.notes[0]).toMatch(/keep the preset's font/);
  });

  it('styles unlocked subtitle tracks and unlocked titles in one op', () => {
    const plan = planBrandText(tl(), kit(), { titles: true });
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.captionTracks).toEqual([1]);
    expect(plan.titles).toBe(1);
    expect(plan.op.captionStyle).toMatchObject({ font: FONT, color: '#ff5a1f', box_enabled: false });
    expect(plan.op.titlePatch).toEqual({ color: '#fafafa', font: FONT });

    const after = applyOp(tl(), plan.op);
    expect(after.tracks[1].caption_style).toMatchObject({ font: FONT, color: '#ff5a1f' });
    expect(after.tracks[2].caption_style).toBeUndefined(); // locked
    expect(after.tracks[0].clips[0].text).toMatchObject({ font: FONT, color: '#fafafa', content: 'Hello' });
    expect(after.tracks[3].clips[0].text?.font).toBe('serif'); // locked
  });

  it('refuses an unknown caption preset by name', () => {
    const k = kit();
    k.captions = { preset: 'no-such' };
    const plan = planBrandText(tl(), k, { titles: true });
    expect('error' in plan && plan.error).toMatch(/not one of/);
  });
});

describe('applyBrandToEdit', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    useHistoryStore.setState({ undoStack: [], redoStack: [] });
    useEditorTimelineStore.setState({ timeline: tl() });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('is ONE undo step, and undo puts every track back', async () => {
    const before = useEditorTimelineStore.getState().timeline;
    const out = await applyBrandToEdit({ kit: kit(), assetsDir: '/p/brand/assets', options: {} });
    expect(out).toMatchObject({ ok: true, changed: true });
    const stack = useHistoryStore.getState().undoStack;
    expect(stack).toHaveLength(1);
    expect(stack[0]).toMatchObject({ tab: 'edit', label: 'Apply brand kit "Acme"' });
    useHistoryStore.getState().undo();
    expect(useEditorTimelineStore.getState().timeline).toEqual(before);
  });
});
