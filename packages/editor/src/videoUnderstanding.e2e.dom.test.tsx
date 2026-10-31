// @vitest-environment jsdom
/**
 * D-432 — the AI-video-understanding opt-in at the OP layer: `editor_analyze_video`
 * driven through the real `chroma://request` dispatch `control.rs` uses.
 *
 * What it pins: with the setting OFF the MCP's op returns the backend's own
 * refusal ("AI video understanding is turned off ...") and never reaches the
 * sidecar command; with it ON the analysis starts exactly as before. The
 * authoritative gate is Rust's `chroma_analyze_video` (unit-tested in
 * `chroma/video_understanding.rs`); this pins that the op layer reports it, and
 * does not start a job the backend would refuse.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';

import { createInvokeStub, mount, waitFrames, type MountedComponent } from './testUtils/pointerHarness';

const REFUSAL = 'AI video understanding is turned off. Turn it on in Settings → Processing → AI video understanding.';

const backend = vi.hoisted(() => ({ enabled: false, started: [] as string[] }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_video_understanding_status: () => ({
      enabled: backend.enabled,
      totalMemoryBytes: 32 * 1024 ** 3,
      lowMemory: false,
      refusal: backend.enabled ? null : REFUSAL,
      howToEnable: 'Settings → Processing → AI video understanding',
    }),
    chroma_analyze_video: (args) => {
      backend.started.push(String(args?.path));
      return { job_id: 'job-1', state: 'running' };
    },
    chroma_analyze_video_status: () => ({ state: 'running' }),
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

import { useMediaUnderstandingStore } from './mediaUnderstandingStore';
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
  const id = `vu-${++requestId}`;
  const handlers = [...(bus.listeners.get('chroma://request') ?? [])];
  await act(async () => {
    await Promise.all(handlers.map((h) => h({ payload: { id, op, args } })));
  });
  const hit = bus.emitted.find((e) => e.event === `chroma://response/${id}`);
  if (!hit) throw new Error(`no response emitted for ${op}`);
  return hit.payload as OpEnvelope;
}

function Harness(): React.ReactElement {
  useEditorControl();
  return React.createElement('div');
}

beforeEach(async () => {
  backend.enabled = false;
  backend.started.length = 0;
  bus.emitted.length = 0;
  act(() => useMediaUnderstandingStore.setState({ analyses: {}, analysisErrors: {}, analyzing: {} }));
  mounted = mount(React.createElement(Harness), { strictMode: false });
  await waitFrames(2);
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  bus.listeners.clear();
});

describe('editor_analyze_video behind the AI video understanding setting (D-432)', () => {
  it('refuses with the backend message and never starts a job while the setting is off', async () => {
    const r = await callOp('editor_analyze_video', { path: '/fixtures/clip.mov' });
    expect(JSON.stringify(r)).toContain('AI video understanding is turned off');
    expect(r.result?.state).toBeUndefined();
    expect(backend.started).toEqual([]);
  });

  it('starts the analysis once the setting is on', async () => {
    backend.enabled = true;
    const r = await callOp('editor_analyze_video', { path: '/fixtures/clip.mov' });
    expect(r.error).toBeNull();
    expect(r.result.state).toBe('running');
    expect(backend.started).toEqual(['/fixtures/clip.mov']);
  });
});
