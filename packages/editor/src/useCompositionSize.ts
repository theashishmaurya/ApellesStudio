/**
 * @apelles/editor — the active timeline's composition (output) pixel size,
 * with no clip selection required (D-199, `docs/notes/preview-canvas-boundary.md`).
 *
 * `chroma_timeline_composition_size` (Rust, `chroma::edit::composition_size_only`)
 * is the same `composition_size` resolver `useClipGeometry`'s
 * `chroma_timeline_clip_geometry` already calls — the project's recorded
 * output spec (D-038 `ProjectSettings`), or the timeline's first video
 * clip's own probed resolution when no explicit settings exist — but without
 * needing a clip selected first. This is what the canvas-boundary overlay
 * (`CanvasBoundary.tsx`) needs: a persistent, selection-independent answer to
 * "what IS the output frame," not a per-clip fact. Originally paired with a
 * `CanvasSettingsPopover.tsx` trigger for setting that same frame; D-275
 * retired that popover once D-274's docked `ProjectSettingsPanel.tsx` covered
 * the same write, but this hook's own read-side job is unchanged — something
 * still needs to answer "what is the output frame" with no clip selected,
 * regardless of which surface currently writes it.
 *
 * Refetches whenever `timeline` changes identity (every `applyOp`/`load()`,
 * per `PreviewPane.tsx`'s own module doc) — a `set_project_settings` write
 * doesn't itself touch the timeline, so it wouldn't otherwise trigger a
 * refetch at all.
 *
 * **B-086 fix.** This used to also take an optional `extraDep` token that a
 * caller applying a settings write had to remember to bump by hand — the
 * (since-retired, D-275) `CanvasSettingsPopover.tsx`'s own "Apply" handler
 * did, correctly, for ITS OWN write. But the `set_project_settings` MCP tool
 * writes through a
 * completely different path (`useSessionStore.getState().setProjectSettings`
 * in `app/src`, which has no way to reach into this hook's component-local
 * state at all), so an MCP-driven write left the boundary overlay showing a
 * stale size until an unrelated timeline edit happened to refresh it —
 * reproducible and reported live (`docs/BUGS.md` B-086).
 *
 * The real fix: `chroma_project_set_settings` (`app/src-tauri/src/chroma/
 * project.rs`) now emits a `chroma://project-settings-changed` Tauri event on
 * every successful write, regardless of which command/store/language called
 * it, and this hook listens for that event directly instead of depending on
 * each caller to plumb a token through. That closes the gap for the MCP tool
 * AND any future caller — a caller no longer needs to know this hook exists
 * to make a write it made visible. `ProjectSettingsPanel.tsx`'s (D-274) own
 * write, via `useProjectSettings.ts`, refreshes this hook purely through that
 * same broadcast today, same as `CanvasSettingsPopover.tsx`'s write did
 * before D-275 retired it — no caller-specific plumbing either way.
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** Mirrors `chroma::edit::ClipGeometry` (`#[serde(rename_all = "camelCase")]`)
 *  — the Rust command deliberately reuses that DTO's shape (see its own doc)
 *  rather than inventing a second, near-identical one; `naturalWidth`/
 *  `naturalHeight` are always `1.0` here (no clip involved) and unused by
 *  this hook's own callers. */
interface CompositionSizeResponse {
  compWidth: number;
  compHeight: number;
}

export interface CompositionSize {
  width: number;
  height: number;
}

/** B-032/B-034/D-112's own fix, copied verbatim from `useEditorControl.ts`/
 *  `useMotionControl.ts` (same reasoning, same small helper — this
 *  codebase's own established convention is a local copy per file rather
 *  than a shared one for a helper this small) — `listen()`'s cleanup is
 *  `unlistenPromise.then((f) => f())`, and Tauri's own `_unlisten` is itself
 *  `async`, so a dev-mode HMR race can make that inner call reject as an
 *  unhandled promise rejection rather than a catchable synchronous throw.
 *  Chaining `.catch(() => {})` onto the SAME promise (not a second
 *  `try`/`catch`) is what actually silences it. */
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

/** `null` while unresolved — no timeline yet, still loading, or the
 *  resolver failed (e.g. an empty timeline with no clip to derive a size
 *  from and no explicit `ProjectSettings` either — the same "nothing to
 *  show yet" a fresh, empty Edit tab is in). */
export function useCompositionSize(hasTimeline: boolean): CompositionSize | null {
  const [size, setSize] = useState<CompositionSize | null>(null);

  // B-086 — a monotonic token bumped every time the backend broadcasts a
  // successful `chroma_project_set_settings` write, from ANY caller. This is
  // the one listener for the whole hook lifetime (mount/unmount), separate
  // from the fetch effect below so a broadcast never has to know or care
  // whether `hasTimeline` happens to be true at that exact moment — it just
  // asks for a refetch, and the fetch effect below decides what that means.
  const [refreshToken, setRefreshToken] = useState(0);
  useEffect(() => {
    const unlistenP = listen('chroma://project-settings-changed', () => {
      setRefreshToken((t) => t + 1);
    });
    return () => safeUnlisten(unlistenP);
  }, []);

  useEffect(() => {
    // `refreshToken` is a deliberate refetch trigger with no other use in
    // this body, which the `exhaustive-deps` lint rule reads as a redundant
    // dependency. Referencing it here makes the dependency array honest
    // instead of suppressing the rule — and a suppression of ANY
    // react-hooks rule switches the React Compiler off for the whole file
    // (`docs/notes/react-compiler-coverage.md`), which `reactCompiler.test.ts`
    // now fails on.
    void refreshToken;
    if (!hasTimeline) {
      setSize(null);
      return;
    }
    let cancelled = false;
    invoke<CompositionSizeResponse>('chroma_timeline_composition_size')
      .then((g) => {
        if (!cancelled) setSize({ width: g.compWidth, height: g.compHeight });
      })
      .catch(() => {
        if (!cancelled) setSize(null);
      });
    return () => {
      cancelled = true;
    };
  }, [hasTimeline, refreshToken]);

  return size;
}
