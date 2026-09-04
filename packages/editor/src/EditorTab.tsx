/**
 * @chroma/editor — the Edit tab (D-041).
 *
 * MVP: a single-video-track timeline of the open project's shots, scrub + play
 * with a live preview, and basic edits (reorder / trim / split / remove).
 * Deferred (later tracked steps): multi-track, audio, transitions, transcript
 * cut, GPU compositing, grade-in-preview, OTIO export, MCP tools.
 *
 * A project must be open (via the Colorist tab's D-037 launcher) for the
 * timeline to have shots.
 *
 * B-034/D-112 — **this screen used to lie, and that is why the same bug kept
 * "coming back."** It rendered "No project open" for *any* failed
 * `chroma_timeline_get`, because the only state it had was `loaded && !
 * timeline`. So four genuinely different underlying faults (B-004's IPC
 * corruption on cold boot, B-025's double-click/refetch gap, B-031's silently
 * aborted `open_manifest`, B-032's HMR-broken listener teardown) plus this
 * one all produced the identical, confidently-wrong sentence — while the
 * shell right above it was simultaneously showing the tab bar, which only
 * appears *because a project is open*. Whether a project is open is now
 * `projectOpen`, pushed down from the app's own source of truth, and it is
 * the only thing that can produce that message; a fetch that fails while a
 * project is genuinely open says so instead, with the real backend error and
 * a Retry. Recovery from a transient failure is automatic (the store's retry
 * ladder), so Retry is a last resort rather than the only way out.
 */

import { useEffect } from 'react';
import { Button } from '@chroma/ui';

import { PreviewPane } from './PreviewPane';
import { TimelinePane } from './TimelinePane';
import { TimelineSwitcher } from './TimelineSwitcher';
import { useEditorTimelineStore } from './timelineStore';

export function EditorTab() {
  const load = useEditorTimelineStore((s) => s.load);
  const projectOpen = useEditorTimelineStore((s) => s.projectOpen);
  const status = useEditorTimelineStore((s) => s.status);
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const error = useEditorTimelineStore((s) => s.error);

  // Re-check when the window regains focus — the project may have changed
  // out from under us. Safe to fire freely now: `load()` is token-guarded, so
  // a focus-triggered refetch that fails can no longer clobber good state.
  useEffect(() => {
    const onFocus = () => {
      if (useEditorTimelineStore.getState().projectOpen) void load();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  if (!projectOpen) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center gap-2 bg-bg-primary text-center px-6">
        <h1 className="text-lg font-semibold text-text-primary">No project open</h1>
        <p className="text-sm text-text-secondary max-w-md">
          Open a project in the Colorist tab — its shots become the Edit timeline.
        </p>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center gap-2 bg-bg-primary text-center px-6">
        <h1 className="text-lg font-semibold text-text-primary">Couldn’t load the timeline</h1>
        <p className="text-sm text-text-secondary max-w-md">
          The project is open, but reading its timeline failed. Retrying didn’t help either.
        </p>
        {error && <p className="text-[11px] text-text-secondary/60 max-w-md break-words">{error}</p>}
        <Button className="mt-2" onClick={() => load()}>
          Retry
        </Button>
      </div>
    );
  }

  if (!timeline) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center gap-2 bg-bg-primary text-center px-6">
        <p className="text-sm text-text-secondary">Loading timeline…</p>
      </div>
    );
  }

  return (
    <div className="h-full w-full flex flex-col min-h-0 bg-bg-primary">
      <div className="flex-1 min-h-0 flex flex-col">
        <PreviewPane />
      </div>
      <div className="h-[46%] min-h-[180px] shrink-0 border-t border-border-color flex flex-col min-h-0">
        <TimelineSwitcher />
        <div className="flex-1 min-h-0">
          <TimelinePane />
        </div>
      </div>
    </div>
  );
}
