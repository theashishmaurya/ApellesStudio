/**
 * renderLoop.test.ts — the render job's plan and read-back helpers (B-202
 * origin, D-398).
 *
 * The loop itself is the backend's now (`apelles_motion::job`, tested in Rust);
 * what stays here, and is testable in this package's `node` environment, is
 * everything the page does around it: planning the frame windows, choosing a
 * subset of scenes (B-263), delivering finished scenes exactly once (B-265),
 * and waiting for a job to settle.
 */
import { describe, it, expect, vi } from 'vitest';
import { sample } from '@apelles/motion-engine/src/engine/sample';

import {
  IDLE_RENDER_STATUS,
  deliverFinished,
  renderFailedBeforeAnyScene,
  sceneRenderJobs,
  selectSceneJobs,
  waitForSettled,
  type MotionRenderStatus,
  type SceneOutput,
} from './renderLoop';

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

describe('selectSceneJobs — B-263', () => {
  const ids = sample.scenes.map((s) => s.id);

  it('no ids means every scene', () => {
    expect(selectSceneJobs(sample)).toEqual({ jobs: sceneRenderJobs(sample) });
    expect(selectSceneJobs(sample, [])).toEqual({ jobs: sceneRenderJobs(sample) });
  });

  it('a chosen scene keeps its place in the WHOLE manifest, so its frames are the same as in a full render', () => {
    const all = sceneRenderJobs(sample);
    const out = selectSceneJobs(sample, [ids[1]]);
    expect(out).toEqual({ jobs: [all[1]] });
    // not re-based to frame 0
    if ('jobs' in out) expect(out.jobs[0].startFrame).toBeGreaterThan(0);
  });

  it('keeps manifest order whatever order the ids were given in, and ignores duplicates', () => {
    const out = selectSceneJobs(sample, [ids[2], ids[0], ids[2]]);
    expect('jobs' in out && out.jobs.map((j) => j.sceneId)).toEqual([ids[0], ids[2]]);
  });

  it('names an unknown scene instead of dropping it', () => {
    const out = selectSceneJobs(sample, [ids[0], 'typo']);
    expect(out).toEqual({ error: expect.stringContaining('no such scene: typo') });
    expect('error' in out && out.error).toContain(ids.join(', '));
  });
});

describe('deliverFinished — B-265', () => {
  const out = (id: string): SceneOutput => ({ sceneId: id, outputPath: `/r/${id}.mp4` });

  it('delivers each finished scene in order, then acknowledges it', async () => {
    const calls: string[] = [];
    const delivered = await deliverFinished(
      { unreconciled: [out('a'), out('b')] },
      new Set(),
      {
        deliver: async (o) => {
          calls.push(`deliver ${o.sceneId}`);
        },
        acknowledge: async (id) => {
          calls.push(`ack ${id}`);
        },
      },
    );
    expect(delivered).toEqual(['a', 'b']);
    // sequential: a is fully handled before b starts
    expect(calls).toEqual(['deliver a', 'ack a', 'deliver b', 'ack b']);
  });

  it('does not acknowledge a scene whose delivery failed, so it is offered again', async () => {
    const acknowledge = vi.fn(async () => {});
    const delivered = await deliverFinished({ unreconciled: [out('a'), out('b')] }, new Set(), {
      deliver: async (o) => {
        if (o.sceneId === 'a') throw new Error('sources import failed');
      },
      acknowledge,
    });
    expect(delivered).toEqual(['b']);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledWith('b');
  });

  it('skips a scene already being delivered (statuses arrive faster than deliveries finish)', async () => {
    const inFlight = new Set<string>();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deliver = vi.fn(async () => {
      await gate;
    });
    const deps = { deliver, acknowledge: async () => {} };
    const first = deliverFinished({ unreconciled: [out('a')] }, inFlight, deps);
    const second = await deliverFinished({ unreconciled: [out('a')] }, inFlight, deps);
    expect(second).toEqual([]);
    release();
    expect(await first).toEqual(['a']);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(inFlight.size).toBe(0);
  });
});

describe('waitForSettled', () => {
  const status = (state: MotionRenderStatus['state']): MotionRenderStatus => ({ ...IDLE_RENDER_STATUS, state });

  it('polls until the job is no longer running and returns that status', async () => {
    const seq = [status('running'), status('running'), status('idle')];
    const sleeps: number[] = [];
    const final = await waitForSettled(
      async () => seq.shift() as MotionRenderStatus,
      async (ms) => {
        sleeps.push(ms);
      },
      250,
    );
    expect(final.state).toBe('idle');
    expect(sleeps).toEqual([250, 250]);
  });

  it('treats an error or an interrupted job as settled', async () => {
    expect((await waitForSettled(async () => status('error'), async () => {})).state).toBe('error');
    expect((await waitForSettled(async () => status('interrupted'), async () => {})).state).toBe('interrupted');
  });

  it('retries a failed status read instead of mistaking it for the job ending', async () => {
    let n = 0;
    const final = await waitForSettled(
      async () => {
        n += 1;
        if (n < 3) throw new Error('bridge hiccup');
        return status('idle');
      },
      async () => {},
    );
    expect(final.state).toBe('idle');
    expect(n).toBe(3);
  });
});

describe('renderFailedBeforeAnyScene', () => {
  it('is an error status that names no scene', () => {
    const s = renderFailedBeforeAnyScene('fix the manifest errors above before rendering');
    expect(s.state).toBe('error');
    expect(s.failedSceneId).toBeNull();
    expect(s.error).toContain('fix the manifest');
    expect(s.doneSceneIds).toEqual([]);
  });

  it('does not share its arrays with the idle singleton', () => {
    const s = renderFailedBeforeAnyScene('x');
    s.doneSceneIds.push('leak');
    expect(IDLE_RENDER_STATUS.doneSceneIds).toEqual([]);
  });
});
