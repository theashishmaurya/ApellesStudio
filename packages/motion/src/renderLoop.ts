/**
 * @apelles/motion — the per-scene render loop and its STATUS, as a pure
 * function (B-202, D-359).
 *
 * **What it is.** The sequential "render every scene to its own file" loop
 * D-180 specified, lifted out of `useMotionManifest`'s `render()` callback,
 * plus the `MotionRenderStatus` value that says what the loop is doing right
 * now: `idle` / `running` / `error`, how many scenes are done, which one is in
 * flight, and — the whole point of B-202 — which one FAILED and why.
 *
 * **What it does NOT do.** No React, no Tauri, no manifest mutation, no I/O of
 * its own: every side effect arrives as an injected callback
 * (`renderScene`/`onRendered`/`onStatus`), the same thin-shell/fat-core split
 * D-257 used to make `motionOps.ts` testable. `useMotionManifest` stays the
 * shell that owns the React state and the `manifestIO` calls.
 *
 * **Why it exists at all (B-202).** Before this pass the loop lived inside a
 * React `useCallback`, so a failure partway through was reachable only as
 * component state (`renderError`) — unreadable by the MCP caller whose op had
 * already timed out (`control.rs`'s 20s `BRIDGE_TIMEOUT`), unlogged anywhere,
 * and untestable in this package at all (its vitest environment is `node`;
 * there is no jsdom and no react-dom here). All three are the same root cause:
 * the loop and its progress were not a value anything outside the component
 * could hold. They are now — `motion_get_state` reports this status, the GUI's
 * Render button reads the identical one, and `runSceneRenders` is directly
 * callable from a test with a deliberately-failing `renderScene`.
 *
 * Raising `control.rs`'s timeout is deliberately NOT part of this: a long
 * render will always outlive any timeout worth having, so the answer is a
 * pollable status, not a longer wait (B-202's own "fix" note says so).
 */
import { sceneStartFrame, sceneDurationFrames } from '@apelles/motion-engine/src/engine/build';
import type { Manifest } from '@apelles/motion-engine/src/engine/schema';

/** Where a render is, as one word.
 *
 *  There is deliberately no `'done'`: a finished render is `idle` again, with
 *  `scenesDone === scenesTotal` and `error: null` saying how it ended. B-202
 *  asked for exactly these three. */
export type MotionRenderState = 'idle' | 'running' | 'error';

/**
 * B-202 — the render's own progress, the thing a timed-out caller can poll.
 *
 * Every field is present in every state (never a partial object), so a caller
 * reads the same keys whatever is happening. `null` always means "does not
 * apply / not known yet", never zero.
 */
export interface MotionRenderStatus {
  state: MotionRenderState;
  /** how many scenes this render has to do — `null` before one has ever been
   *  started in this session. */
  scenesTotal: number | null;
  /** how many have finished. With `scenesTotal` this is the real progress a
   *  caller previously had to reconstruct by counting files on disk. */
  scenesDone: number;
  /** the scene rendering RIGHT NOW, while `running`; `null` otherwise. */
  sceneId: string | null;
  /** the scene whose render FAILED, while `error`. `null` when the failure was
   *  not a scene's own (a pre-render save failure, an unparseable manifest). */
  failedSceneId: string | null;
  /** the real failure message, while `error`; `null` otherwise. */
  error: string | null;
  /** the scenes that finished, in order — of the run in flight while
   *  `running`, of the run that failed while `error`, of the last completed
   *  run while `idle`. */
  doneSceneIds: string[];
}

/** The status before anything has ever been rendered in this session. */
export const IDLE_RENDER_STATUS: MotionRenderStatus = {
  state: 'idle',
  scenesTotal: null,
  scenesDone: 0,
  sceneId: null,
  failedSceneId: null,
  error: null,
  doneSceneIds: [],
};

/** One scene's render, as the absolute frame window `chroma_motion_render`
 *  takes. Inclusive at both ends, matching Remotion's own `--frames=a-b`. */
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

export interface SceneRenderLoopDeps<R> {
  /** render one scene; rejecting is what "this scene failed" means. */
  renderScene: (job: SceneRenderJob) => Promise<R>;
  /** D-062/D-260 — hand the finished file to the app layer (Sources import +
   *  the linked-clip refresh). Awaited, so scene N+1 never starts on top of
   *  it. A throw here is SWALLOWED: reconciling Sources is the app layer's own
   *  failure to report, and it must not fail a render that already succeeded. */
  onRendered?: (result: R) => void | Promise<void>;
  /** called on every transition — start, each finished scene, and the end.
   *  The shell turns this into React state; a test just collects them. */
  onStatus: (status: MotionRenderStatus) => void;
}

/** What the loop ended up doing. `results` carries the scenes that DID finish
 *  even on failure, so a caller re-rendering after a fix does not lose them. */
export type SceneRenderLoopOutcome<R> =
  | { ok: true; results: R[] }
  | { ok: false; error: string; failedSceneId: string | null; results: R[] };

/**
 * Render `jobs` SEQUENTIALLY, reporting status at every transition.
 *
 * Never in parallel: a render is CPU/GPU-heavy and overlapping N of them is a
 * real footgun (D-180). A scene's failure STOPS the loop rather than skipping
 * it, also D-180 — "the owner needs to know exactly which scene failed and
 * why" — which is the half B-202 found was true of the loop and false of
 * everything downstream of it. The failing scene id now leaves this function
 * on both the returned outcome AND the final status, so the answer survives
 * the caller's op having already timed out.
 */
export async function runSceneRenders<R>(
  jobs: readonly SceneRenderJob[],
  deps: SceneRenderLoopDeps<R>,
): Promise<SceneRenderLoopOutcome<R>> {
  const { renderScene, onRendered, onStatus } = deps;
  const results: R[] = [];
  const doneSceneIds: string[] = [];
  const scenesTotal = jobs.length;

  const report = (patch: Partial<MotionRenderStatus> & { state: MotionRenderState }) =>
    onStatus({
      scenesTotal,
      scenesDone: doneSceneIds.length,
      sceneId: null,
      failedSceneId: null,
      error: null,
      // a fresh array per report: the caller holds these snapshots (React
      // state, a test's list) and must not see one mutate under it.
      doneSceneIds: [...doneSceneIds],
      ...patch,
    });

  for (const job of jobs) {
    report({ state: 'running', sceneId: job.sceneId });
    let result: R;
    try {
      result = await renderScene(job);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      report({ state: 'error', failedSceneId: job.sceneId, error });
      return { ok: false, error, failedSceneId: job.sceneId, results };
    }
    results.push(result);
    doneSceneIds.push(job.sceneId);
    try {
      await onRendered?.(result);
    } catch {
      /* the app layer reports its own Sources failure — see `onRendered` */
    }
    report({ state: 'running', sceneId: job.sceneId });
  }

  report({ state: 'idle' });
  return { ok: true, results };
}

/** The `error` status for a failure that is not any one scene's — an
 *  unparseable manifest, or the pre-render save. Exported so the shell reports
 *  those through the identical shape rather than a second hand-built literal. */
export function renderFailedBeforeAnyScene(error: string): MotionRenderStatus {
  // `doneSceneIds` is re-created rather than spread through: a spread is
  // shallow, and handing out the shared `IDLE_RENDER_STATUS` array would let
  // one holder's mutation reach every other status that ever came from it.
  return { ...IDLE_RENDER_STATUS, doneSceneIds: [], state: 'error', error };
}
