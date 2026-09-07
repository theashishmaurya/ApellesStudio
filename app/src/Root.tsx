import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'react-toastify';
import { Shell, useActiveTab } from '@chroma/shell';
import { EditorTab, useEditorTimelineStore } from '@chroma/editor';
import { MotionTab, useMotionProjectStore } from '@chroma/motion';
import { useMediaPoolStore, trackEvent } from '@chroma/bridge';
import App from './App';
import ProjectLauncher from './components/chroma/ProjectLauncher';
import { SourcesPanel } from './components/chroma/SourcesPanel';
import { useSessionStore } from './store/useSessionStore';

/**
 * `Root` — the app's composition root component (D-039), and *only* that.
 *
 * **This module must export nothing but React components** (D-197/B-081).
 * `@vitejs/plugin-react` makes a module a React Fast Refresh boundary only
 * when every one of its exports is a component; a module that fails that test
 * (including one with *no* exports at all, which is what `main.tsx` was while
 * it also held this component) invalidates instead, and Vite answers an
 * invalidated boundary with a **full page reload of the whole app**. Because
 * every `@chroma/*` barrel (`packages/editor/src/index.ts` &c.) re-exports
 * stores and plain functions alongside components, it is not a boundary
 * either, so an HMR update to any module behind a barrel propagates straight
 * up to whatever imports the barrel — this file. Keeping this file a valid
 * boundary is what stops that propagation and turns those edits into a
 * sub-second hot update instead of a full reload. See D-197 for the whole
 * chain, including the Tauri IPC-transport fallback (B-081) a reload caused.
 *
 * The app opens on the project launcher with no tab bar; opening/creating a
 * project sets `useSessionStore.projectPath` (or, for a loose-clip quick-open,
 * `projectName` = 'Untitled'), which flips the shell into the 3-tab layout.
 * "‹ Projects" calls `closeProject()` to come back.
 *
 * B-007: every tab stays mounted from boot (D-039), including underneath the
 * launcher, so the Edit tab's own mount never coincides with a project
 * actually opening — it would otherwise sit on the stale "no project" read it
 * took at startup until some unrelated window-focus event happened to fire.
 * This is the one place that legitimately spans both `app` (owns
 * `useSessionStore`, the real "project is open" signal) and `@chroma/editor`
 * (owns the timeline fetch); this is the composition root, so it's the
 * right place to bridge them, not a cross-package import in either direction.
 * B-034/D-112 turned that bridge from "fire a fetch and hope" into handing the
 * store the signal itself — see the effect's own comment below.
 */
export function Root() {
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

  // B-034/D-112 — the single bridge between the app's real "a project is
  // open" signal and the Edit tab. Supersedes D-085's version, which called
  // `load()` here and then re-called it once, 500ms later, if the first
  // attempt had landed on an error — a heuristic whose own comment admitted
  // it never proved the race it was guarding, and which by construction could
  // only ever paper over one failure at one fixed delay.
  //
  // `projectOpen` is now handed to the store as state, not used as a trigger
  // to fire a fetch and hope. The store owns everything downstream of that:
  // when to fetch, how many times to retry, what to show while it's trying,
  // and — the part that actually mattered — the fact that a *failed fetch is
  // not evidence that no project is open*. `setProjectOpen` is idempotent, so
  // this effect re-running with an unchanged value costs nothing.
  useEffect(() => {
    useEditorTimelineStore.getState().setProjectOpen(projectOpen);
  }, [projectOpen]);

  // B-058/D-150 — the same bridge for the Motion tab, which never had one: it
  // mounts at boot like every other tab (see this file's B-007 note), read its
  // manifest once right there with no project open, and — because it *inferred*
  // "no project" from that failure — sat on that answer for the rest of the
  // session. Its only escape was a window `focus` event, which opening a
  // project from the in-window launcher never produces.
  //
  // The signal is deliberately narrower than `projectOpen` above: Motion's
  // manifest is a sidecar inside the project directory
  // (`<project>.chroma/motion/manifest.json`), so an in-memory "Untitled"
  // loose-clip session — `projectName` set, `projectPath` null — genuinely has
  // nowhere to read or write, and the tab should say so rather than fail a call
  // it was never able to make.
  const motionProjectOpen = useSessionStore((s) => !!s.projectPath);
  useEffect(() => {
    useMotionProjectStore.getState().setProjectOpen(motionProjectOpen);
  }, [motionProjectOpen]);

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
