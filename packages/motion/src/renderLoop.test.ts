/**
 * renderLoop.test.ts — B-202: a `motion_render` that fails partway through
 * must say so, and say WHICH scene.
 *
 * The loop this covers used to live inside `useMotionManifest`'s `render()`
 * callback, where it was unreachable from a test in this package at all (the
 * vitest environment here is `node` — no jsdom, no react-dom), which is a large
 * part of why the failure could go nowhere for as long as it did. Lifting it
 * out (D-359) is what makes these assertions possible.
 */
import { describe, it, expect, vi } from 'vitest';
import { sample } from '@apelles/motion-engine/src/engine/sample';

import {
  IDLE_RENDER_STATUS,
  renderFailedBeforeAnyScene,
  runSceneRenders,
  sceneRenderJobs,
  type MotionRenderStatus,
  type SceneRenderJob,
} from './renderLoop';

const jobs = (...ids: string[]): SceneRenderJob[] =>
  ids.map((sceneId, i) => ({ sceneId, startFrame: i * 100, endFrame: i * 100 + 99 }));

/** collect every status the loop reports, and hand back the last one — which
 *  is what `motion_get_state` would be reading after the loop settles. */
function statusRecorder() {
  const all: MotionRenderStatus[] = [];
  return {
    all,
    onStatus: (s: MotionRenderStatus) => all.push(s),
    last: () => all[all.length - 1],
  };
}

describe('sceneRenderJobs', () => {
  it('gives every scene its own absolute, inclusive frame window, back to back', () => {
    const built = sceneRenderJobs(sample);
    expect(built).toHaveLength(sample.scenes.length);
    expect(built.map((j) => j.sceneId)).toEqual(sample.scenes.map((s) => s.id));
    expect(built[0].startFrame).toBe(0);
    for (let i = 1; i < built.length; i++) {
      expect(built[i].startFrame).toBe(built[i - 1].endFrame + 1);
    }
    // inclusive at both ends, the way Remotion's own `--frames=a-b` is
    for (const job of built) expect(job.endFrame).toBeGreaterThanOrEqual(job.startFrame);
  });
});

describe('runSceneRenders — B-202', () => {
  it('THE headline: a scene that fails names itself in the final status', async () => {
    const rec = statusRecorder();
    const outcome = await runSceneRenders(jobs('hook', 'body', 'outro'), {
      renderScene: async (job) => {
        if (job.sceneId === 'body') throw new Error('remotion render exited 1: out of memory');
        return job.sceneId;
      },
      onStatus: rec.onStatus,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.failedSceneId).toBe('body');
    expect(outcome.error).toContain('out of memory');
    // and the same answer on the POLLABLE status, which is the half that
    // survives the caller's op having already timed out.
    expect(rec.last()).toEqual({
      state: 'error',
      scenesTotal: 3,
      scenesDone: 1,
      sceneId: null,
      failedSceneId: 'body',
      error: 'remotion render exited 1: out of memory',
      doneSceneIds: ['hook'],
    });
  });

  it('the loop STOPS at the failure rather than skipping past it (D-180)', async () => {
    const rendered: string[] = [];
    const rec = statusRecorder();
    const outcome = await runSceneRenders(jobs('a', 'b', 'c'), {
      renderScene: async (job) => {
        if (job.sceneId === 'b') throw new Error('nope');
        rendered.push(job.sceneId);
        return job.sceneId;
      },
      onStatus: rec.onStatus,
    });
    expect(rendered).toEqual(['a']);
    if (outcome.ok) throw new Error('unreachable');
    // the scenes that DID finish come back, so a caller re-rendering after a
    // fix does not lose them from the display
    expect(outcome.results).toEqual(['a']);
  });

  it('reports real progress while running — the thing a caller had to count files for', async () => {
    const rec = statusRecorder();
    await runSceneRenders(jobs('a', 'b'), {
      renderScene: async (job) => job.sceneId,
      onStatus: rec.onStatus,
    });
    // every status carries the total, so "2 of 4" is readable at any moment
    expect(rec.all.every((s) => s.scenesTotal === 2)).toBe(true);
    const running = rec.all.filter((s) => s.state === 'running');
    expect(running.length).toBeGreaterThan(0);
    expect(running[0]).toMatchObject({ sceneId: 'a', scenesDone: 0 });
    expect(rec.all.map((s) => s.scenesDone)).toEqual([0, 1, 1, 2, 2]);
  });

  it('a finished render is idle again, with every scene counted and no error', async () => {
    const rec = statusRecorder();
    const outcome = await runSceneRenders(jobs('a', 'b'), {
      renderScene: async (job) => job.sceneId,
      onStatus: rec.onStatus,
    });
    expect(outcome).toEqual({ ok: true, results: ['a', 'b'] });
    expect(rec.last()).toEqual({
      state: 'idle',
      scenesTotal: 2,
      scenesDone: 2,
      sceneId: null,
      failedSceneId: null,
      error: null,
      doneSceneIds: ['a', 'b'],
    });
  });

  it('awaits onRendered between scenes, and a throw there never fails the render', async () => {
    const order: string[] = [];
    const outcome = await runSceneRenders(jobs('a', 'b'), {
      renderScene: async (job) => {
        order.push(`render:${job.sceneId}`);
        return job.sceneId;
      },
      // D-260 — the app layer's Sources reconcile. Letting scene b's render
      // start on top of a's reconcile would race two manifest writes.
      onRendered: async (id) => {
        order.push(`rendered:${id}`);
        throw new Error('Sources refresh failed — the app layer reports this itself');
      },
      onStatus: () => {},
    });
    expect(order).toEqual(['render:a', 'rendered:a', 'render:b', 'rendered:b']);
    expect(outcome).toEqual({ ok: true, results: ['a', 'b'] });
  });

  it('a non-Error throw still produces a real message, not "[object Object]"', async () => {
    const outcome = await runSceneRenders(jobs('a'), {
      renderScene: async () => {
        throw 'the bridge died';
      },
      onStatus: () => {},
    });
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error).toBe('the bridge died');
  });

  it('never hands the same mutable doneSceneIds array to two reports', async () => {
    // The caller holds these snapshots (React state, this list) — one shared
    // array would make every earlier report retroactively "complete".
    const rec = statusRecorder();
    await runSceneRenders(jobs('a', 'b'), {
      renderScene: async (job) => job.sceneId,
      onStatus: rec.onStatus,
    });
    expect(rec.all[0].doneSceneIds).toEqual([]);
    expect(rec.last().doneSceneIds).toEqual(['a', 'b']);
  });

  it('an empty manifest is a no-op success, reported as idle', async () => {
    const rec = statusRecorder();
    const renderScene = vi.fn();
    const outcome = await runSceneRenders([], { renderScene, onStatus: rec.onStatus });
    expect(renderScene).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ok: true, results: [] });
    expect(rec.last()).toMatchObject({ state: 'idle', scenesTotal: 0, scenesDone: 0 });
  });
});

describe('the non-scene failures', () => {
  it('renderFailedBeforeAnyScene names no scene, because none is at fault', () => {
    // A bad manifest or a failed pre-render save is a render error with no
    // failing scene — `failedSceneId: null` is a real answer here, not a gap.
    const s = renderFailedBeforeAnyScene('fix the manifest errors above before rendering');
    expect(s).toEqual({
      ...IDLE_RENDER_STATUS,
      state: 'error',
      error: 'fix the manifest errors above before rendering',
    });
    expect(s.failedSceneId).toBeNull();
    expect(s.scenesTotal).toBeNull();
  });

  it('the idle status is not shared state a caller can mutate into everyone else', () => {
    expect(IDLE_RENDER_STATUS.doneSceneIds).toEqual([]);
    expect(renderFailedBeforeAnyScene('x').doneSceneIds).not.toBe(IDLE_RENDER_STATUS.doneSceneIds);
  });
});
