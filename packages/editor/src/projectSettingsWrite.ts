/**
 * @apelles/editor — the one way the project's output spec (D-038) is written
 * from the front end, so a frame-rate change reaches the timelines (B-323).
 *
 * **What it is.** `chroma_project_set_settings` is a plain merge-patch of
 * `project.json`'s `settings`; the Edit tab's timelines each carry their own
 * `rate`, and the open one is held (and saved) by the timeline store. A bare
 * settings write therefore left every existing timeline at its old rate:
 * `set_project_settings(fps=30)` on a fresh project still gave a 24 fps
 * timeline. This wraps the command so the rate follows:
 *
 * - **An empty timeline follows the project.** Every timeline with no clips is
 *   retimed to the new rate (nothing to convert).
 * - **A timeline with clips is never retimed silently.** If one runs at a
 *   different rate the write is REFUSED, before anything is stored, with a
 *   reason that names the explicit way (`editor_set_timeline_output` with
 *   `fps`, or the "This timeline" rate in the panel), which converts the clips
 *   by time. See D-413.
 *
 * Callers: the Edit tab's `useProjectSettings.save`, the Colorist modal's
 * session store and the `set_project_settings` MCP op — one path, one rule.
 *
 * **What it does NOT do.** It does not touch width/height/colour space (a
 * patch without `fps`, or with the same fps, is the plain command), and it
 * does not retime clips; that is `setTimelineRate`.
 */
import { invoke } from '@tauri-apps/api/core';

import type { ProjectSettingsValue } from './ProjectSettingsForm';
import { useEditorTimelineStore } from './timelineStore';

/** Two frame rates this close are the same rate (29.97 stored as a float). */
const SAME_FPS_EPSILON = 1e-3;

const sameFps = (a: number, b: number): boolean => Math.abs(a - b) < SAME_FPS_EPSILON;

interface TimelineRateRow {
  id: string;
  name: string;
  fps: number;
  clipCount: number;
}

/** Each timeline's rate and clip count, the open one from the live store (it
 *  may hold edits not saved yet) and the rest from the saved list. `null`
 *  when no project is open. */
async function timelineRateRows(): Promise<TimelineRateRow[] | null> {
  const store = useEditorTimelineStore.getState();
  if (store.openProjectKey === null) return null;
  await store.loadList();
  const live = useEditorTimelineStore.getState();
  return live.timelines.map((t) => {
    if (live.timeline && live.timeline.id === t.id) {
      const r = live.timeline.rate;
      return {
        id: t.id,
        name: t.name,
        fps: r && r.num > 0 && r.den > 0 ? r.num / r.den : (t.fps ?? 0),
        clipCount: live.timeline.tracks.reduce((n, tr) => n + tr.clips.length, 0),
      };
    }
    return { id: t.id, name: t.name, fps: t.fps ?? 0, clipCount: t.clipCount ?? 0 };
  });
}

/** Why `fps` may not become the project's rate, or `null` when it may. */
export function projectFpsRefusal(rows: readonly TimelineRateRow[], fps: number): string | null {
  const clipped = rows.filter((r) => r.clipCount > 0 && !sameFps(r.fps, fps));
  if (clipped.length === 0) return null;
  const names = clipped.map((r) => `"${r.name}" (${+r.fps.toFixed(3)} fps, ${r.clipCount} clips)`).join(', ');
  return (
    `the project's frame rate was not changed to ${fps}: ${names} already hold clips at a different rate, ` +
    `and a settings change never retimes clips. Retime a timeline explicitly first ` +
    `(editor_set_timeline_output with fps converts its clips by time, seconds preserved), then set the project rate.`
  );
}

/**
 * Merge-patch the project's settings (the `chroma_project_set_settings`
 * contract) and carry a changed `fps` to the empty timelines. Rejects with the
 * reason in words when the rate may not change (see the module doc) or the
 * write fails; the merged settings otherwise.
 */
export async function writeProjectSettings(
  partial: ProjectSettingsValue,
  path: string | null = null,
): Promise<ProjectSettingsValue> {
  const fps = typeof partial.fps === 'number' && partial.fps > 0 ? partial.fps : null;
  const rows = fps !== null ? await timelineRateRows() : null;
  if (fps !== null && rows) {
    const refusal = projectFpsRefusal(rows, fps);
    if (refusal) throw new Error(refusal);
  }
  const merged = await invoke<ProjectSettingsValue>('chroma_project_set_settings', { path, partial });
  if (fps !== null && rows) {
    const store = useEditorTimelineStore.getState();
    for (const r of rows) {
      if (r.clipCount === 0 && !sameFps(r.fps, fps)) {
        const res = await store.setTimelineRate(r.id, fps);
        if (!res.ok) throw new Error(res.error ?? 'the timeline rate could not be set');
      }
    }
  }
  return merged;
}
