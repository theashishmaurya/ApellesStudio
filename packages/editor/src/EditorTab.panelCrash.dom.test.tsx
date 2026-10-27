// @vitest-environment jsdom
/**
 * @apelles/editor — B-292: one pane's render crash stays in that pane.
 *
 * Live on 2026-10-28 a throw inside the timeline (B-291) blanked the whole
 * window and every control-bridge op then timed out, because nothing caught
 * it: React unmounted the entire root, op registries included. This mounts the
 * real `EditorTab` (and so the real `useEditorControl` registry and the real
 * `PanelErrorBoundary`s around its panes) with the timeline pane replaced by
 * one that throws on demand, and checks what a person and an agent each see:
 *
 * - the timeline pane shows "The Timeline panel crashed" with the error, and
 *   the preview pane next to it keeps rendering;
 * - the crash is logged (`console.error`, which the app forwards to its log)
 *   and recorded in the registry `debug_get_ui_state` reports;
 * - `editor_*` ops keep answering while the pane is down;
 * - **Reload panel** remounts the pane and clears the crash.
 *
 * Heavy children (the real preview, timeline and inspectors) are stubbed: this
 * is about the boundaries and the registry's placement, not about them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string) => Promise.resolve(cmd === 'chroma_text_fonts' ? [] : null),
}));

const bus = vi.hoisted(() => ({
  listeners: new Set<(ev: { payload: unknown }) => unknown>(),
  emitted: [] as { event: string; payload: unknown }[],
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, handler: (ev: { payload: unknown }) => unknown) => {
    if (event === 'chroma://request') bus.listeners.add(handler);
    return Promise.resolve(() => {
      bus.listeners.delete(handler);
    });
  },
  emit: (event: string, payload: unknown) => {
    bus.emitted.push({ event, payload });
    return Promise.resolve();
  },
}));

const crash = vi.hoisted(() => ({ timeline: false }));

vi.mock('./TimelinePane', () => ({
  TimelinePane: () => {
    if (crash.timeline) throw new Error('timeline exploded (test)');
    return React.createElement('div', { 'data-testid': 'timeline-pane' }, 'timeline');
  },
}));
vi.mock('./PreviewPane', () => ({
  PreviewPane: () => React.createElement('div', { 'data-testid': 'preview-pane' }, 'preview'),
}));
vi.mock('./TimelineSwitcher', () => ({ TimelineSwitcher: () => null }));
vi.mock('./EditorInspectorPanel', () => ({ EditorInspectorPanel: () => null }));
vi.mock('./TextClipInspectorPanel', () => ({ TextClipInspectorPanel: () => null }));
vi.mock('./CaptionInspectorPanel', () => ({ CaptionInspectorPanel: () => null }));
vi.mock('./AdjustmentClipInspectorPanel', () => ({ AdjustmentClipInspectorPanel: () => null }));

import { getPanelCrashes } from '@apelles/ui';
import { installResizeObserverStub, stubOffsetMetrics } from './testUtils/pointerHarness';
import { EditorTab } from './EditorTab';
import { useEditorTimelineStore } from './timelineStore';
import type { Timeline } from './timeline';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const timeline = (): Timeline => ({
  id: 't',
  name: 't',
  rate: { num: 24, den: 1 },
  tracks: [
    {
      kind: 'video',
      clips: [{ id: 'a', name: 'a', source_path: '/a.mov', source_start: 0, duration: 48, source_len: 48, start_frame: 0 }],
    },
  ],
});

/** The instance the control server would target: the newest `editor_` claim. */
function editorTarget(): string {
  const claim = bus.emitted
    .filter((e) => e.event === 'chroma://bridge-ready')
    .map((e) => e.payload as { prefix: string; instance: string })
    .filter((c) => c.prefix === 'editor_')
    .at(-1);
  if (!claim) throw new Error('no editor_ registry announced itself');
  return claim.instance;
}

let seq = 0;
async function op(name: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; result?: unknown }> {
  const id = `crash-${++seq}`;
  const payload = { id, op: name, args, target: editorTarget() };
  await act(async () => {
    await Promise.all([...bus.listeners].map((h) => h({ payload })));
  });
  const hit = bus.emitted.find((e) => e.event === `chroma://response/${id}`);
  if (!hit) throw new Error(`no response to ${name}`);
  return hit.payload as { ok: boolean; result?: unknown };
}

const q = (selector: string) => document.querySelector<HTMLElement>(selector);

let root: Root | null = null;
let consoleError: ReturnType<typeof vi.spyOn>;
let restores: Array<() => void> = [];

beforeEach(() => {
  // The resizable panel layout measures its group with a ResizeObserver.
  restores = [installResizeObserverStub(), stubOffsetMetrics()];
  crash.timeline = false;
  bus.listeners.clear();
  bus.emitted.length = 0;
  // React itself also reports a caught error to console.error; keep the run
  // quiet and let the assertions read what was logged.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  useEditorTimelineStore.setState({
    timeline: timeline(),
    openProjectKey: '/projects/crash.chroma',
    status: 'ready',
    error: null,
    selection: [],
    selectedGap: null,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  consoleError.mockRestore();
  restores.forEach((restore) => restore());
  useEditorTimelineStore.setState({ timeline: null, openProjectKey: null, status: 'idle' });
});

async function mountTab(): Promise<void> {
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => {
    root!.render(<EditorTab />);
  });
}

describe('B-292 — a crashed Edit pane stays contained', () => {
  it('shows the fallback in the crashed pane only, logs it and records it', async () => {
    crash.timeline = true;
    await mountTab();

    const fallback = q('[data-panel-crash="Timeline"]');
    expect(fallback, 'the timeline pane shows its crash fallback').not.toBeNull();
    expect(fallback!.textContent).toContain('The Timeline panel crashed');
    expect(fallback!.textContent).toContain('timeline exploded (test)');
    expect(q('[data-testid="preview-pane"]'), 'the preview pane next to it still renders').not.toBeNull();

    const logged = consoleError.mock.calls.some((args) => String(args[0]).startsWith('[panel-crash] the Timeline panel crashed'));
    expect(logged, 'the crash is logged with console.error').toBe(true);

    const crashes = getPanelCrashes();
    expect(crashes.map((c) => c.panel)).toEqual(['Timeline']);
    expect(crashes[0].message).toBe('timeline exploded (test)');
    expect(crashes[0].componentStack).toBeTruthy();
    expect(crashes[0].count).toBe(1);
  });

  it('keeps the editor_ op registry answering while a pane is down', async () => {
    crash.timeline = true;
    await mountTab();
    expect(q('[data-panel-crash="Timeline"]')).not.toBeNull();

    const read = await op('editor_get_state');
    expect(read.ok).toBe(true);
    const marker = await op('editor_add_marker', { frame: 12 });
    expect(marker.ok, 'a write lands too').toBe(true);
    expect(useEditorTimelineStore.getState().timeline?.markers?.map((m) => m.frame)).toEqual([12]);
  });

  it('Reload panel remounts the pane and clears the crash', async () => {
    crash.timeline = true;
    await mountTab();
    const reload = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Reload panel'),
    );
    expect(reload, 'the fallback offers Reload panel').toBeTruthy();

    crash.timeline = false; // whatever broke it is gone
    await act(async () => {
      reload!.click();
    });

    expect(q('[data-panel-crash="Timeline"]')).toBeNull();
    expect(q('[data-testid="timeline-pane"]'), 'the pane renders again').not.toBeNull();
    expect(getPanelCrashes()).toEqual([]);
  });

  it('a pane that crashes again after a reload is reported again, with its count', async () => {
    crash.timeline = true;
    await mountTab();
    const reload = () =>
      [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Reload panel'))!;
    await act(async () => {
      reload().click();
    });
    expect(q('[data-panel-crash="Timeline"]'), 'still broken, so the fallback is back').not.toBeNull();
    expect(getPanelCrashes()[0].count).toBe(1);
  });
});
