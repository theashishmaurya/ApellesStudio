// @vitest-environment jsdom
/**
 * D-441 — the Export sheet and the top-bar queue in a real DOM (B-367): the
 * sheet opens on the timeline shape's preset with a pre-filled "Save as", a
 * preset chip rewrites the summary line, a hand change in More settings leaves
 * no chip selected, the ProRes format renames the file to `.mov`, Save preset
 * adds a chip, Export queues one job (with the preset's argv) and closes the
 * sheet, and the top-bar pill's popover cancels a running job through the
 * queue's real `cancel` (the backend command under the job id).
 *
 * Tier: jsdom. The live look (sizes, colours) is the screenshot pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  actSync,
  createInvokeStub,
  installElementAnimationsStub,
  installResizeObserverStub,
  mount,
  waitFrames,
  type MountedComponent,
} from './testUtils/pointerHarness';

const calls: Array<[string, Record<string, unknown> | undefined]> = [];
const run = vi.hoisted(() => ({ resolve: null as null | ((v: unknown) => void) }));
vi.mock('@tauri-apps/api/core', () => {
  const stub = createInvokeStub({
    chroma_timeline_set: () => undefined,
    chroma_timeline_composition_size: () => ({ compWidth: 1920, compHeight: 1080, naturalWidth: 1, naturalHeight: 1 }),
    chroma_unused_export_path: (a) => `${(a as { dir: string }).dir}/${(a as { stem: string }).stem}.${(a as { ext: string }).ext}`,
    chroma_text_fonts: () => [],
    chroma_timeline_grade_luts: () => ({ luts: {}, warnings: [] }),
    chroma_run_editor_export: () => new Promise((resolve) => (run.resolve = resolve)),
    chroma_cancel_editor_export: () => ({ wasRunning: true }),
  });
  return {
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args]);
      return stub(cmd, args);
    },
  };
});
vi.mock('@tauri-apps/api/path', () => ({ videoDir: () => Promise.resolve('/Users/me/Movies') }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: () => Promise.resolve(null) }));

import { useEditorTimelineStore } from './timelineStore';
import { useExportQueueStore } from './exportQueueStore';
import { useExportPresetStore } from './exportPresets';
import { EditorExportDialog, EXPORT_SHEET_INSET_PX, exportSheetBox } from './EditorExportDialog';
import { useMediaPoolStore } from '@apelles/bridge';
import type { Timeline } from './timeline';

function fixture(): Timeline {
  return {
    id: 'tl',
    name: 'Voiceover v2',
    rate: { num: 30, den: 1 },
    tracks: [
      { kind: 'video', clips: [{ id: 'v', name: 'A-cam', source_path: '/a.mov', source_start: 0, duration: 900, source_len: 900, start_frame: 0 }] },
    ],
  };
}

let mounted: MountedComponent | null = null;
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const click = (sel: string) => {
  const el = $(sel);
  if (!el) throw new Error(`no element ${sel}`);
  actSync(() => (el as HTMLElement).click());
};
const settle = async () => {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
    await waitFrames(1);
  }
};

beforeEach(async () => {
  installResizeObserverStub();
  installElementAnimationsStub();
  calls.length = 0;
  useExportQueueStore.setState({ jobs: [] });
  useExportPresetStore.setState({ userPresets: [], lastPreset: {} });
  useMediaPoolStore.setState({ items: [] });
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: fixture(),
      timelines: [{ id: 'tl', name: 'Voiceover v2', duration: 900, active: true }],
      openProjectKey: '/Users/me/Projects/Five Levels.apelles',
      status: 'ready',
      error: null,
    }),
  );
  mounted = mount(React.createElement(EditorExportDialog));
  await waitFrames(1);
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const openSheet = async () => {
  click('button[aria-label="Export"]');
  await settle();
};

describe('the Export sheet (D-441)', () => {
  it('keeps a real inset from every window edge and sizes to its content (owner: "over lapping")', async () => {
    expect(EXPORT_SHEET_INSET_PX).toBeGreaterThanOrEqual(24);
    const box = exportSheetBox();
    expect(box.width).toBe(`min(880px, calc(100vw - ${2 * EXPORT_SHEET_INSET_PX}px))`);
    expect(box.maxHeight).toBe(`min(760px, calc(100vh - ${2 * EXPORT_SHEET_INSET_PX}px))`);
    await openSheet();
    const dialog = document.querySelector<HTMLElement>('[data-chroma-export-dialog]');
    // A max height, never a fixed one: short content makes a short sheet.
    expect(dialog?.className).not.toMatch(/(^|\s)h-\[/);
    expect(dialog?.className).toContain('grid-rows-[minmax(0,1fr)]');
  });

  it('opens on the shape’s preset with a pre-filled name and folder, and a chip rewrites the summary', async () => {
    await openSheet();
    expect($('[data-chroma-export-sheet]')).not.toBeNull();
    expect($('[data-chroma-export-preset="youtube-1080p"]')?.getAttribute('aria-checked')).toBe('true');
    expect($<HTMLInputElement>('[data-chroma-export-name]')?.value).toBe('Voiceover v2');
    expect(document.body.textContent).toContain('in ~/Movies/Five Levels');
    expect($('[data-chroma-export-summary]')?.textContent).toContain('1920 × 1080');
    expect($('[data-chroma-export-summary]')?.textContent).toContain('YouTube, −14 LUFS');
    // The publish destinations are drawn, dimmed, with no behaviour.
    expect($('[data-chroma-export-publish="YouTube"]')?.getAttribute('aria-disabled')).toBe('true');

    click('[data-chroma-export-preset="vertical"]');
    await settle();
    expect($('[data-chroma-export-summary]')?.textContent).toContain('1080 × 1920');
    // A 16:9 timeline into a 9:16 preset is stretched: the warning says so.
    expect($('[data-chroma-export-warning]')).not.toBeNull();

    click('[data-chroma-export-preset="master"]');
    await settle();
    expect($('[data-chroma-export-summary]')?.textContent).toContain('ProRes 422 HQ');
    expect($('[data-chroma-export-summary]')?.textContent).toContain('loudness as mixed');
    expect(document.body.textContent).toContain('.mov');
    expect($('[data-chroma-export-warning]')).toBeNull();
  });

  it('a hand change leaves no chip selected, and Save preset adds the person’s own chip', async () => {
    await openSheet();
    click('[data-chroma-export-more]');
    await settle();
    const name = $<HTMLInputElement>('[data-chroma-export-preset-name]')!;
    actSync(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(name, 'Client review');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    click('[data-chroma-export-preset-save]');
    await settle();
    expect(useExportPresetStore.getState().userPresets.map((p) => p.name)).toEqual(['Client review']);
    expect($('[data-chroma-export-preset="user:client-review"]')?.getAttribute('aria-checked')).toBe('true');
    click('[data-chroma-export-preset-delete="user:client-review"]');
    await settle();
    expect($('[data-chroma-export-preset="user:client-review"]')).toBeNull();
  });

  it('Export queues one job with the preset’s argv and closes the sheet; the pill’s Cancel stops it', async () => {
    await openSheet();
    click('[data-chroma-export-preset="master"]');
    await settle();
    click('[data-chroma-export-run]');
    await settle();
    expect($('[data-chroma-export-sheet]')).toBeNull();
    const jobs = useExportQueueStore.getState().jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ outPath: '/Users/me/Movies/Five Levels/Voiceover v2.mov', format: 'prores_hq', preset: 'Master', status: 'running' });
    expect(useExportPresetStore.getState().lastPreset).toEqual({ landscape: 'master' });

    // The top bar shows it, and its popover cancels it for real.
    expect($('[data-chroma-export-queue-pill]')?.textContent).toContain('Exporting');
    click('[data-chroma-export-queue-pill]');
    await settle();
    click(`[data-chroma-export-cancel="${jobs[0].id}"]`);
    await settle();
    expect(calls).toContainEqual(['chroma_cancel_editor_export', { token: jobs[0].id }]);
    actSync(() => run.resolve?.({ ok: false, cancelled: true, stdout_tail: '', stderr_tail: 'cancelled' }));
    await settle();
    expect(useExportQueueStore.getState().jobs[0].status).toBe('cancelled');
    expect($(`[data-chroma-export-job="${jobs[0].id}"]`)?.textContent).toContain('Cancelled');
    expect($(`[data-chroma-export-retry="${jobs[0].id}"]`)).not.toBeNull();
  });
});
