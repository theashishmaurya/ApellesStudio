/**
 * @apelles/motion — the Motion render job's STATUS and the pure helpers around
 * it (B-202 origin, rewritten for D-398).
 *
 * **What it is.** The `MotionRenderStatus` value that says what the render is
 * doing (`idle` / `running` / `error` / `interrupted`, how many scenes are done,
 * which is in flight, which failed and why, which are left), the per-scene
 * frame windows a job is planned from, and the one pure step the shell takes
 * when the backend reports finished scenes (`deliverFinished`).
 *
 * **What it does NOT do.** No React, no Tauri, no rendering, and — since D-398 —
 * NO LOOP. The loop that renders scene after scene is the backend's job
 * (`app/src-tauri/src/chroma/motion_job.rs`, state machine in
 * `apelles_motion::job`): it holds the exact manifest the windows were computed
 * from, persists every transition, and keeps running when the webview reloads.
 * This module only plans it and reads it back. The status shape is
 * `apelles_motion::job::JobView`'s, field for field.
 *
 * **Why it changed (B-265, B-264, B-263).** The loop used to live in the page: a
 * reload killed it silently and the app then reported `idle`; its windows came
 * from one document while each scene's content was read from another file; and
 * it could only render everything. All three were consequences of the page
 * owning a process it cannot keep alive.
 */
import { sceneStartFrame, sceneDurationFrames } from '@apelles/motion-engine/src/engine/build';
import type { Manifest } from '@apelles/motion-engine/src/engine/schema';

/** Where a render is, as one word.
 *
 *  There is deliberately no `'done'`: a finished render is `idle` again, with
 *  `scenesDone === scenesTotal` and `error: null` saying how it ended.
 *  `interrupted` (D-398) is a job that was mid-flight when its worker went away
 *  (the app restarted, the worker died): it has scenes left and can be resumed. */
export type MotionRenderState = 'idle' | 'running' | 'error' | 'interrupted';

/** One finished scene's file, as the backend reports it. */
export interface SceneOutput {
  sceneId: string;
  outputPath: string;
}

/**
 * The render's own progress, mirroring `apelles_motion::job::JobView`.
 *
 * Every field is present in every state; `null` means "does not apply / not
 * known yet", never zero.
 */
export interface MotionRenderStatus {
  state: MotionRenderState;
  /** how many scenes the job has to do — `null` when none has ever run. */
  scenesTotal: number | null;
  scenesDone: number;
  /** the scene rendering RIGHT NOW, while `running`; `null` otherwise. */
  sceneId: string | null;
  /** the scene whose render FAILED, while `error`. */
  failedSceneId: string | null;
  /** the real failure message, while `error`. */
  error: string | null;
  doneSceneIds: string[];
  /** the scenes still to render — what `resume` would do. Empty when the job
   *  finished cleanly. */
  remainingSceneIds: string[];
  /** finished scenes the app has not yet taken into Sources. */
  unreconciled: SceneOutput[];
  /** every finished scene's file. */
  outputs: SceneOutput[];
  manifestHash: string | null;
}

/** The status before anything has ever been rendered for the project. */
export const IDLE_RENDER_STATUS: MotionRenderStatus = {
  state: 'idle',
  scenesTotal: null,
  scenesDone: 0,
  sceneId: null,
  failedSceneId: null,
  error: null,
  doneSceneIds: [],
  remainingSceneIds: [],
  unreconciled: [],
  outputs: [],
  manifestHash: null,
};

/** One scene's render, as the absolute frame window the backend takes.
 *  Inclusive at both ends, matching Remotion's own `--frames=a-b`. */
export interface SceneRenderJob {
  sceneId: string;
  startFrame: number;
  endFrame: number;
}

/**
 * Every scene's absolute frame window, in manifest order — `sceneStartFrame` /
 * `sceneDurationFrames` (`build.ts`), the exact math `KeyframeTimeline.tsx`
 * draws scene boundaries with, reused rather than re-derived (D-180).
 */
export function sceneRenderJobs(manifest: Manifest): SceneRenderJob[] {
  return manifest.scenes.map((scene, i) => {
    const startFrame = sceneStartFrame(manifest, i);
    return {
      sceneId: scene.id,
      startFrame,
      endFrame: startFrame + sceneDurationFrames(manifest, i) - 1,
    };
  });
}

/**
 * The windows to render for a request naming `sceneIds` (B-263), or every
 * scene when none are named. The windows are always the scene's place in the
 * WHOLE manifest, so a one-scene render writes the same frames it would inside
 * a full render. Unknown ids are an error naming them, never silently dropped:
 * a typo must not look like a successful render of nothing. Manifest order is
 * kept, so the output order never depends on the order the ids were given.
 */
export function selectSceneJobs(
  manifest: Manifest,
  sceneIds?: readonly string[] | null,
): { jobs: SceneRenderJob[] } | { error: string } {
  const all = sceneRenderJobs(manifest);
  if (!sceneIds || sceneIds.length === 0) return { jobs: all };
  const known = new Set(all.map((j) => j.sceneId));
  const unknown = [...new Set(sceneIds)].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return {
      error: `no such scene${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')} (scenes are ${all.map((j) => j.sceneId).join(', ')})`,
    };
  }
  const wanted = new Set(sceneIds);
  return { jobs: all.filter((j) => wanted.has(j.sceneId)) };
}

/**
 * Hand every finished-but-undelivered scene to the app layer, then tell the
 * backend it was delivered. Sequential and awaited, so a scene's Sources import
 * and linked-clip refresh finish before the next starts (D-260), and a scene is
 * acknowledged only after its delivery succeeded: a failed delivery stays
 * undelivered and is retried on the next status. `inFlight` makes a status that
 * arrives mid-delivery (they come fast) skip scenes already being handled.
 */
export async function deliverFinished<R>(
  status: Pick<MotionRenderStatus, 'unreconciled'>,
  inFlight: Set<string>,
  deps: {
    deliver: (output: SceneOutput) => Promise<R> | R;
    acknowledge: (sceneId: string) => Promise<void>;
  },
): Promise<string[]> {
  const delivered: string[] = [];
  for (const output of status.unreconciled) {
    if (inFlight.has(output.sceneId)) continue;
    inFlight.add(output.sceneId);
    try {
      await deps.deliver(output);
      await deps.acknowledge(output.sceneId);
      delivered.push(output.sceneId);
    } catch {
      /* the app layer reports its own Sources failure; left undelivered, so it
         is offered again with the next status */
    } finally {
      inFlight.delete(output.sceneId);
    }
  }
  return delivered;
}

/**
 * Poll the backend job until it is no longer `running`, and return that final
 * status. `getStatus` and `sleep` are injected so the wait is testable without a
 * backend or a clock. A status read that FAILS is retried rather than treated as
 * the job having ended: the job is the backend's, and a flaky read says nothing
 * about it.
 */
export async function waitForSettled(
  getStatus: () => Promise<MotionRenderStatus>,
  sleep: (ms: number) => Promise<void>,
  pollMs = 1000,
): Promise<MotionRenderStatus> {
  for (;;) {
    try {
      const status = await getStatus();
      if (status.state !== 'running') return status;
    } catch {
      /* retry on the next tick */
    }
    await sleep(pollMs);
  }
}

/** The `error` status for a failure that is not any one scene's — an
 *  unparseable manifest, an unknown scene id, or the pre-render save. */
export function renderFailedBeforeAnyScene(error: string): MotionRenderStatus {
  return { ...IDLE_RENDER_STATUS, doneSceneIds: [], state: 'error', error };
}
