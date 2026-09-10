/**
 * @apelles/editor — this package's own live view of the project's D-038
 * `ProjectSettings` (D-274).
 *
 * Mirrors `useCompositionSize.ts`'s own pattern exactly, for the same
 * layering reason its module doc already states: `packages/editor` cannot
 * import `app/src/store/useSessionStore` (D-039's one-way `app -> packages`
 * rule) — this is a second, independent live view of the SAME backend
 * manifest field, not a forked copy of state. `chroma_project_get_settings`
 * fetches it and `chroma_project_set_settings` writes it — the same two
 * commands `CanvasSettingsPopover.tsx` already calls directly for its own
 * narrower width/height-only surface — and the `chroma://project-settings-
 * changed` broadcast (B-086) both this hook and `useCompositionSize` listen
 * for keeps every live surface (this hook, `useCompositionSize`, the
 * Colorist modal's own `useSessionStore`) in step with whichever one made
 * the last write, with no cross-store plumbing between any of them: the
 * single source of truth stays the backend manifest, not any one of these
 * caches of it.
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import type { ProjectSettingsValue } from './ProjectSettingsForm';

/** B-032/B-034/D-112's own fix, copied verbatim from `useCompositionSize.ts`
 *  (see that file's own doc for the full "why" — a dev-mode HMR teardown
 *  race can otherwise surface as an unhandled promise rejection). */
function safeUnlisten(unlistenPromise: Promise<(() => void) | undefined | void>): void {
  unlistenPromise
    .then((f) => {
      const result: unknown = f?.();
      return Promise.resolve(result);
    })
    .catch(() => {
      /* the listener is already gone either way (HMR teardown race) */
    });
}

export interface UseProjectSettingsResult {
  /** `null` while the initial fetch hasn't resolved yet (or after a failed
   *  one — `error` distinguishes the two). */
  settings: ProjectSettingsValue | null;
  error: string | null;
  saving: boolean;
  /** Merge-patch write, mirroring `chroma_project_set_settings`'s own
   *  contract: a present key is applied (`null` clears it), an absent key
   *  is left alone. Updates local state from the command's own response —
   *  the real, merged manifest — so every field on screen (including ones
   *  this call didn't touch) always reflects what was actually stored. */
  save: (patch: ProjectSettingsValue) => Promise<void>;
}

export function useProjectSettings(): UseProjectSettingsResult {
  const [settings, setSettings] = useState<ProjectSettingsValue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // One listener for the whole hook lifetime, independent of the fetch
  // effect below — a write from ANY caller (the Colorist modal, MCP's
  // `set_project_settings`, this hook's own `save`) lands here the same way.
  useEffect(() => {
    const unlistenP = listen<ProjectSettingsValue>('chroma://project-settings-changed', (e) => {
      setSettings(e.payload);
    });
    return () => safeUnlisten(unlistenP);
  }, []);

  useEffect(() => {
    let cancelled = false;
    invoke<ProjectSettingsValue>('chroma_project_get_settings', { path: null })
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (patch: ProjectSettingsValue) => {
    setSaving(true);
    setError(null);
    // D-201 — `try/catch` then the `finally` body inlined at the end of
    // `try`/`catch` alike, not a real `finally` clause: a `finally` anywhere
    // in a component/hook switches the React Compiler off for the whole
    // file (`docs/notes/react-compiler-coverage.md`), and `reactCompiler.
    // test.ts` fails on that. Same shape `CanvasSettingsPopover.tsx` uses.
    try {
      const merged = await invoke<ProjectSettingsValue>('chroma_project_set_settings', {
        path: null,
        partial: patch,
      });
      setSettings(merged);
    } catch (e) {
      setError(String(e));
    }
    setSaving(false);
  };

  return { settings, error, saving, save };
}
