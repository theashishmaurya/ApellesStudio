/**
 * The app's bootstrap entry — mount `<Root>` and nothing else.
 *
 * **Deliberately holds no React component of its own** (D-197/B-081). It used
 * to declare `Root` inline, which made `@vitejs/plugin-react` treat this file
 * as a React Fast Refresh boundary candidate while it has *zero* exports —
 * a combination the refresh runtime rejects
 * (`Could not Fast Refresh ("true" export is incompatible)`), so Vite
 * answered every HMR update that reached this module with a **full page
 * reload of the whole app**. Since no `@chroma/*` barrel is a refresh
 * boundary either (they re-export stores and plain functions next to
 * components), *every* edit behind one propagated here and full-reloaded the
 * app: state lost, project re-opened, every module re-fetched — and, because
 * a reload cancels every in-flight `ipc://` fetch, the B-081 IPC-transport
 * fallback warning burst. `Root` now lives in `./Root.tsx`, which exports
 * only components and therefore stops that propagation.
 *
 * Keep it that way: put new components in their own module, not here.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './Root';
import { installFrontendLogBridge } from './utils/frontendLogBridge';
import './styles.css';

installFrontendLogBridge();

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
