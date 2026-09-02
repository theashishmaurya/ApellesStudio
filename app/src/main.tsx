import React from 'react';
import { createRoot } from 'react-dom/client';
import { Shell } from '@chroma/shell';
import { EditorTab } from '@chroma/editor';
import { MotionTab } from '@chroma/motion';
import App from './App';
import { installFrontendLogBridge } from './utils/frontendLogBridge';
import './styles.css';

installFrontendLogBridge();

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <Shell
      tabs={[
        { id: 'edit', label: 'Edit', element: <EditorTab /> },
        { id: 'motion', label: 'Motion', element: <MotionTab /> },
        { id: 'colorist', label: 'Colorist', element: <App /> },
      ]}
    />
  </React.StrictMode>,
);
