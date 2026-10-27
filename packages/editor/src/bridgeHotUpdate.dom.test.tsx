// @vitest-environment jsdom
/**
 * @apelles/editor — the control bridge follows a hot update of its op code
 * (B-280), and still runs each op once (B-272).
 *
 * A Vite hot update re-evaluates `useEditorControl.ts` and everything it
 * imports. `vi.resetModules()` + a fresh `import()` is that re-evaluation: a new
 * hook function, a new op table, a new timeline store. Re-rendering the same
 * mounted component with the new hook under `<React.StrictMode>` is what Fast
 * Refresh does, and (React 19) StrictMode's second render compares the effect's
 * dependencies normally, so with `[]` the old subscription would stay the only
 * one. The test plays the control server's part: it targets every request at
 * the latest `chroma://bridge-ready` announcer, as `control.rs` does.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import * as ReactDOMClient from 'react-dom/client';

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

import type { Timeline } from './timeline';

// react-dom's act() warns unless the environment opts in (see `pointerHarness`).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Each `evaluate()` re-imports the whole registry module graph, which takes
 *  seconds under vitest's transform. */
const SLOW_IMPORTS_MS = 60_000;

type Hook = () => void;
interface Evaluation {
  useEditorControl: Hook;
  store: typeof import('./timelineStore').useEditorTimelineStore;
}

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

/** A fresh evaluation of the registry module and its dependencies, the way a
 *  hot update produces one, with a timeline loaded in that evaluation's store. */
async function evaluate(): Promise<Evaluation> {
  vi.resetModules();
  const { useEditorControl } = await import('./useEditorControl');
  const { useEditorTimelineStore } = await import('./timelineStore');
  useEditorTimelineStore.setState({ timeline: timeline(), openProjectKey: 'p' });
  return { useEditorControl, store: useEditorTimelineStore };
}

function Host({ hook }: { hook: Hook }): React.ReactElement {
  hook();
  return React.createElement('div');
}

/** The instance the control server would target: the newest editor claim. */
function target(): string {
  const claims = bus.emitted
    .filter((e) => e.event === 'chroma://bridge-ready')
    .map((e) => e.payload as { prefix: string; instance: string })
    .filter((c) => c.prefix === 'editor_');
  const latest = claims.at(-1);
  if (!latest) throw new Error('no editor_ registry announced itself');
  return latest.instance;
}

let n = 0;
async function addMarker(frame: number): Promise<{ ok: boolean }> {
  const id = `hot-${++n}`;
  const payload = { id, op: 'editor_add_marker', args: { frame }, target: target() };
  await act(async () => {
    await Promise.all([...bus.listeners].map((h) => h({ payload })));
  });
  const hit = bus.emitted.find((e) => e.event === `chroma://response/${id}`);
  if (!hit) throw new Error('no response');
  return hit.payload as { ok: boolean };
}

const markers = (e: Evaluation): number => e.store.getState().timeline?.markers?.length ?? 0;

let root: ReactDOMClient.Root | null = null;
const render = (hook: Hook) =>
  act(async () => {
    root?.render(React.createElement(React.StrictMode, null, React.createElement(Host, { hook })));
  });

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  bus.listeners.clear();
  bus.emitted.length = 0;
});

describe('control bridge across a hot update (B-280)', () => {
  it('re-subscribes with the new evaluation, and an op runs once, in the new code', async () => {
    const first = await evaluate();
    root = ReactDOMClient.createRoot(document.body.appendChild(document.createElement('div')));
    await render(first.useEditorControl);
    expect(bus.listeners.size).toBe(1);

    expect((await addMarker(5)).ok).toBe(true);
    expect(markers(first)).toBe(1);

    // the hot update: same mounted component, the re-evaluated hook
    const second = await evaluate();
    const firstTarget = target();
    await render(second.useEditorControl);

    expect(target()).not.toBe(firstTarget);
    expect(bus.listeners.size).toBe(1);
    expect((await addMarker(10)).ok).toBe(true);
    expect(markers(second)).toBe(1);
    expect(markers(first)).toBe(1);

    // and again: still one subscription, still one application per op (B-272)
    const third = await evaluate();
    await render(third.useEditorControl);
    expect(bus.listeners.size).toBe(1);
    expect((await addMarker(15)).ok).toBe(true);
    expect(markers(third)).toBe(1);
    expect(markers(second)).toBe(1);
  }, SLOW_IMPORTS_MS);

  it('a re-render within one evaluation keeps the same subscription', async () => {
    const only = await evaluate();
    root = ReactDOMClient.createRoot(document.body.appendChild(document.createElement('div')));
    await render(only.useEditorControl);
    const before = target();
    const announced = bus.emitted.filter((e) => e.event === 'chroma://bridge-ready').length;
    await render(only.useEditorControl);
    expect(target()).toBe(before);
    expect(bus.emitted.filter((e) => e.event === 'chroma://bridge-ready').length).toBe(announced);
    expect((await addMarker(3)).ok).toBe(true);
    expect(markers(only)).toBe(1);
  }, SLOW_IMPORTS_MS);
});
