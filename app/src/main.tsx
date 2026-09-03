import React, { useCallback, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { toast } from 'react-toastify';
import { Shell, useActiveTab } from '@chroma/shell';
import { EditorTab, useEditorTimelineStore } from '@chroma/editor';
import { MotionTab } from '@chroma/motion';
import { useMediaPoolStore, trackEvent } from '@chroma/bridge';
import App from './App';
import ProjectLauncher from './components/chroma/ProjectLauncher';
import { SourcesPanel } from './components/chroma/SourcesPanel';
import { useSessionStore } from './store/useSessionStore';
import { installFrontendLogBridge } from './utils/frontendLogBridge';
import './styles.css';

installFrontendLogBridge();

/**
 * The composition root (D-039). The app opens on the project launcher with no
 * tab bar; opening/creating a project sets `useSessionStore.projectPath` (or,
 * for a loose-clip quick-open, `projectName` = 'Untitled'), which flips the
 * shell into the 3-tab layout. "‹ Projects" calls `closeProject()` to come back.
 *
 * B-007: the Edit tab's timeline store only re-fetches on its own mount + on
 * the OS window regaining focus (see `@chroma/editor`'s `EditorTab`) — neither
 * fires when a project is opened from the Colorist tab in the same window
 * (all 3 tabs stay mounted, D-039), so Edit was stuck on a stale "no project"
 * read until an unrelated focus event happened to fire. This is the one place
 * that legitimately spans both `app` (owns `useSessionStore`, the real
 * "project is open" signal) and `@chroma/editor` (owns the timeline fetch) —
 * main.tsx is the composition root, so it's the right place to bridge them,
 * not a cross-package import in either direction.
 */
function Root() {
  const projectOpen = useSessionStore((s) => !!s.projectPath || !!s.projectName);
  const activeTab = useActiveTab();

  // D-093: tab switches are the cheapest, highest-signal "what is the owner
  // actually doing right now" event, and `useShellStore` (`@chroma/shell`)
  // must not depend on `@chroma/bridge` (see that store's own file-header
  // note) — so this is tracked here, at the composition root, same layering
  // reasoning as the B-007/D-062 bridges just above/below. Skips the very
  // first render (mounting on `edit` isn't a "switch").
  const previousTab = useRef<string | null>(null);
  useEffect(() => {
    if (previousTab.current !== null && previousTab.current !== activeTab) {
      trackEvent('tab_switch', { from: previousTab.current, to: activeTab });
    }
    previousTab.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    if (!projectOpen) return;
    // D-085: retry once, short delay, if the load lands on an error state —
    // a defensive guard against a transient race between "frontend has set
    // `projectPath`" and "backend's project-ref state is fully settled for
    // *every* command to read," not just the one `openProject` itself
    // awaited. Owner, live, screenshot: opened a project (Colorist rendered
    // it successfully — confirmed via `app.log`), Edit tab stuck on "No
    // project open" regardless. A single unconditional `load()` here
    // couldn't explain that if the backend state really was ready by the
    // time this effect ran; a real but narrow timing race is the most
    // defensible explanation given nothing else in this bridge looks wrong
    // on inspection — this makes that race harmless without pretending to
    // have proven its exact mechanism.
    useEditorTimelineStore.getState().load();
    const retry = window.setTimeout(() => {
      const s = useEditorTimelineStore.getState();
      if (s.loaded && !s.timeline) s.load();
    }, 500);
    return () => window.clearTimeout(retry);
  }, [projectOpen]);

  // D-071: `chroma_timeline_set` (the Edit tab's own save path, fired on
  // every drag/trim/split) never runs `open_manifest`, so nothing else
  // tells Colorist a clip was added or removed on the timeline — confirmed
  // live: a clip dragged onto the Edit tab never showed up in the Colorist
  // shot strip, and a removed clip lingered there forever as a "ghost."
  // Same bridge shape as the B-007 fix above (app owns the tab-switch
  // signal, `useSessionStore` owns the resync) — re-syncs every time the
  // owner switches *to* Colorist, not on every keystroke on the Edit tab,
  // since `chroma_project_resync_clips` is specifically built to leave the
  // currently-active clip untouched when nothing relevant changed, making
  // a slightly-stale-until-the-next-tab-switch window an acceptable
  // trade-off against re-syncing on every single timeline edit.
  useEffect(() => {
    if (projectOpen && activeTab === 'colorist') {
      void useSessionStore.getState().resyncClips();
    }
  }, [projectOpen, activeTab]);

  // D-062: a Motion render used to just write a file and print its path as
  // plain text — nothing put it anywhere usable. `MotionTab` can't import
  // it into the pool itself (`@chroma/bridge` is app/domain-layer, D-039
  // layer direction: a tab package must not depend on it), so this is the
  // composition root's job, same reasoning as the `useEditorTimelineStore`
  // bridge above. Imports at the pool root (no folder) — a rendered motion
  // graphic isn't naturally "in" whatever folder happens to be active in
  // the Sources panel right now. Deliberately does NOT also splice it onto
  // the Edit tab's active timeline: the owner may not want it there yet, or
  // may want a specific track/position — dragging it in from Sources (like
  // any other clip) stays the one explicit action that actually places it.
  const onMotionRendered = useCallback((outputPath: string) => {
    void useMediaPoolStore
      .getState()
      .importPaths([outputPath])
      .then((res) => {
        if (!res.ok) toast.error(`Rendered, but couldn't add to Sources: ${res.error}`);
        else if (res.added && res.added.length === 0) {
          // already in the pool from an earlier render at the same path
          // (the default output path is fixed per-project, D-062) — refresh
          // so its thumbnail/video info reflect the new render, not silently
          // leave a stale entry.
          void useMediaPoolStore.getState().refresh();
        } else {
          toast.success('Rendered — added to Sources');
        }
      });
  }, []);

  return (
    <Shell
      projectOpen={projectOpen}
      launcher={<ProjectLauncher />}
      sourcesPanel={<SourcesPanel />}
      onCloseProject={() => {
        void useSessionStore.getState().closeProject();
      }}
      tabs={[
        { id: 'edit', label: 'Edit', element: <EditorTab /> },
        { id: 'motion', label: 'Motion', element: <MotionTab onRendered={onMotionRendered} /> },
        { id: 'colorist', label: 'Colorist', element: <App /> },
      ]}
    />
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
