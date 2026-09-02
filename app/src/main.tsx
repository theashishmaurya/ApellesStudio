import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Shell } from '@chroma/shell';
import { EditorTab, useEditorTimelineStore } from '@chroma/editor';
import { MotionTab } from '@chroma/motion';
import App from './App';
import ProjectLauncher from './components/chroma/ProjectLauncher';
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

  useEffect(() => {
    if (projectOpen) useEditorTimelineStore.getState().load();
  }, [projectOpen]);

  return (
    <Shell
      projectOpen={projectOpen}
      launcher={<ProjectLauncher />}
      onCloseProject={() => {
        void useSessionStore.getState().closeProject();
      }}
      tabs={[
        { id: 'edit', label: 'Edit', element: <EditorTab /> },
        { id: 'motion', label: 'Motion', element: <MotionTab /> },
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
