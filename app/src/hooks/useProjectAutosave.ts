import { useEffect, useRef } from 'react';

import { useEditorStore } from '../store/useEditorStore';
import { useSessionStore } from '../store/useSessionStore';

/**
 * D-037 autosave. Once a real (non-Untitled) project is loaded, a debounced
 * `chroma_project_save` fires on any grade / shot-list / active-shot change —
 * it rewrites `project.json`, persists the active shot's `grade.json`, and
 * regenerates `thumb.jpg`. An in-memory "Untitled" session is skipped until the
 * user saves it explicitly (`saveUntitledAs`).
 *
 * Mounted once in App.tsx next to `useChromaControl()`.
 */
export function useProjectAutosave() {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const schedule = () => {
      const s = useSessionStore.getState();
      if (!s.projectPath || s.projectName === 'Untitled') return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void useSessionStore.getState().saveProject().catch(() => {});
      }, 1500);
    };

    const unsubEditor = useEditorStore.subscribe((st, prev) => {
      if (st.adjustments !== prev.adjustments) {
        useSessionStore.getState().markDirty();
        schedule();
      }
    });

    const unsubSession = useSessionStore.subscribe((st, prev) => {
      if (st.shots !== prev.shots || st.activeIndex !== prev.activeIndex) schedule();
    });

    return () => {
      if (timer.current) clearTimeout(timer.current);
      unsubEditor();
      unsubSession();
    };
  }, []);
}
