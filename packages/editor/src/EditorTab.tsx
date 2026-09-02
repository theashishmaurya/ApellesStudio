/**
 * @chroma/editor — the Edit tab (D-041).
 *
 * MVP: a single-video-track timeline of the open project's shots, scrub + play
 * with a live preview, and basic edits (reorder / trim / split / remove).
 * Deferred (later tracked steps): multi-track, audio, transitions, transcript
 * cut, GPU compositing, grade-in-preview, OTIO export, MCP tools.
 *
 * A project must be open (via the Colorist tab's D-037 launcher) for the
 * timeline to have shots — `chroma_timeline_get` errors otherwise and we show
 * the empty state.
 */

import { useEffect } from 'react';
import { Button } from '@chroma/ui';

import { PreviewPane } from './PreviewPane';
import { TimelinePane } from './TimelinePane';
import { useEditorTimelineStore } from './timelineStore';

export function EditorTab() {
  const load = useEditorTimelineStore((s) => s.load);
  const loaded = useEditorTimelineStore((s) => s.loaded);
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const error = useEditorTimelineStore((s) => s.error);

  useEffect(() => {
    load();
  }, [load]);

  // re-check when the window regains focus (a project may have been opened in
  // the Colorist tab meanwhile)
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  if (loaded && !timeline) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center gap-2 bg-bg-primary text-center px-6">
        <h1 className="text-lg font-semibold text-text-primary">No project open</h1>
        <p className="text-sm text-text-secondary max-w-md">
          Open a project in the Colorist tab — its shots become the Edit timeline.
        </p>
        {error && <p className="text-[11px] text-text-secondary/60 max-w-md">{error}</p>}
        <Button className="mt-2" onClick={() => load()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="h-full w-full flex flex-col min-h-0 bg-bg-primary">
      <div className="flex-1 min-h-0 flex flex-col">
        <PreviewPane />
      </div>
      <div className="h-[46%] min-h-[180px] shrink-0 border-t border-border-color">
        <TimelinePane />
      </div>
    </div>
  );
}
