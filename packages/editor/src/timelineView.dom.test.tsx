// @vitest-environment jsdom
/**
 * D-434 — the timeline's zoom as an AI-reachable setting (H2), and the harness
 * source stamp on a dispatched op (H1), both driven through the REAL
 * `chroma://request` dispatch `useEditorControl` registers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';

import { actSync, createInvokeStub, mount, type MountedComponent } from './testUtils/pointerHarness';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
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
import { useEditorControl } from './useEditorControl';
import { useTimelineViewStore } from './timelineView';
import type { Timeline } from './timeline';

const FPS = 24;
const timeline: Timeline = { id: 'tv', name: 'tv', rate: { num: FPS, den: 1 }, tracks: [{ kind: 'video', clips: [] }] };

interface Envelope {
  ok: boolean;
  error: string | null;
  // The op's own result object: an open record on the wire.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any;
}

let requestId = 0;
async function callOp(op: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<Envelope> {
  const id = `tv-${++requestId}`;
  const handlers = [...(bus.listeners.get('chroma://request') ?? [])];
  await act(async () => {
    await Promise.all(handlers.map((h) => h({ payload: { id, op, args, ...extra } })));
  });
  const hit = bus.emitted.find((e) => e.event === `chroma://response/${id}`);
  if (!hit) throw new Error(`no response for ${op}`);
  return hit.payload as Envelope;
}

function Harness(): React.ReactElement {
  useEditorControl();
  return React.createElement('div');
}

let mounted: MountedComponent | null = null;

beforeEach(() => {
  bus.listeners.clear();
  bus.emitted.length = 0;
  useTimelineViewStore.setState(useTimelineViewStore.getInitialState());
  useHistoryStore.getState().clear();
  actSync(() => useEditorTimelineStore.setState({ timeline, openProjectKey: 'p', status: 'ready', error: null, playhead: 0 }));
  mounted = mount(React.createElement(Harness));
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe('editor_set_timeline_view (H2)', () => {
  it('sets the timeline zoom as a multiplier of the default and reports it', async () => {
    const res = await callOp('editor_set_timeline_view', { zoom: 2 });
    expect(res.ok).toBe(true);
    expect(res.result.timelineView).toEqual({ zoom: 2, pct: 200, pxPerSec: 180 });
    expect(useTimelineViewStore.getState().pxPerSec).toBe(180);
  });

  it('"default" resets, and editor_get_state reports the view back', async () => {
    await callOp('editor_set_timeline_view', { zoom: 5 });
    expect(useTimelineViewStore.getState().pxPerSec).toBe(450);
    await callOp('editor_set_timeline_view', { zoom: 'default' });
    const state = await callOp('editor_get_state', {});
    expect(state.result.timelineView).toEqual({ zoom: 1, pct: 100, pxPerSec: 90 });
  });

  it('clamps to the ruler ladder and says so; refuses nonsense by name', async () => {
    const big = await callOp('editor_set_timeline_view', { zoom: 99 });
    expect(big.result.timelineView.pxPerSec).toBe(480);
    expect(big.result.note).toMatch(/clamped/);
    expect((await callOp('editor_set_timeline_view', {})).result.error).toMatch(/zoom/);
    expect((await callOp('editor_set_timeline_view', { zoom: 'huge' })).result.error).toMatch(/multiplier/);
    expect((await callOp('editor_set_timeline_view', { zoom: -1 })).result.error).toMatch(/multiplier/);
  });

  it('is display-only: it never lands on the undo stack', async () => {
    await callOp('editor_set_timeline_view', { zoom: 3 });
    expect(useHistoryStore.getState().undoStack).toHaveLength(0);
  });
});

describe('request source (H1)', () => {
  const sources = () => useHistoryStore.getState().undoStack.map((e) => e.source);

  it('an op the control server marks source:"harness" is recorded as the harness, never the agent', async () => {
    const res = await callOp('editor_add_marker', { frame: 12, name: 'm' }, { source: 'harness' });
    expect(res.ok).toBe(true);
    expect(sources()).toEqual(['harness']);
  });

  it('an ordinary MCP request is still the agent', async () => {
    await callOp('editor_add_marker', { frame: 12, name: 'm' });
    expect(sources()).toEqual(['agent']);
  });
});
