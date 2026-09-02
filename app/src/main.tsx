import React from 'react';
import { createRoot } from 'react-dom/client';
import { Shell } from '@chroma/shell';
import { EditorTab } from '@chroma/editor';
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
 */
function Root() {
  const projectOpen = useSessionStore((s) => !!s.projectPath || !!s.projectName);
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
