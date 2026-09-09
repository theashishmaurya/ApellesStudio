/**
 * @apelles/motion — the manifest-editing state (D-046; readiness split out to
 * `motionProjectStore` in B-058/D-150).
 *
 * The *editing* state is component-local (text, parse errors, dirty, save,
 * render) — nothing outside this tab needs it. **Readiness is not**: whether a
 * project is open — and, since B-083/D-203, *which* one — comes from the app
 * (`app/src/Root.tsx` → `useMotionProjectStore.setOpenProject`) and the tab is
 * mounted from boot, so it lives in the
 * store. This hook seeds its editor text from whatever that store last read
 * (falling back to the engine's own sample manifest for a project with no
 * saved manifest yet), live-validates every edit (debounced) against
 * `@apelles/motion-engine`'s `zod` schema — the schema's single source of truth
 * — and drives save/render through `manifestIO`.
 *
 * B-058: `loadState` is *derived* — `'no-project'` comes from the store's
 * `openProjectPath` alone, never from a failed read. A read that fails while a
 * project is genuinely open is `'error'`, with the real backend message.
 *
 * A parse/validation error never blinks the preview away: `manifest` only
 * ever holds the last value that parsed clean, so `<MotionPreview>` keeps
 * showing it while `parseError` is surfaced separately in the editor pane.
 *
 * D-155 (Phase 0c of `docs/notes/motion-visual-builder-research.md`) adds
 * `commit` — the ONE path that both an Inspector field edit and a Phase 1
 * canvas drag write a whole-manifest change through, so both get undo/redo
 * "for free" from `@apelles/history` (D-051) with no per-mutation-site
 * wiring. It mirrors `@apelles/editor`'s own `timelineStore.applyOp`
 * (`before`/`after` snapshots closed over by `undo`/`redo`, pushed to the
 * SAME shared `useHistoryStore`) — adapted to this tab's "the JSON text is
 * the one serialized source of truth" contract (`setText`) rather than a
 * `restoreSnapshot` call. `setText` is `setTextLive`, i.e. still debounced,
 * so `commit` ALSO calls `applyParse` synchronously on the same string —
 * without that, a Phase 1 drag's pointer-up would clear its transient
 * preview override before the debounce re-parses `text`, and the picture
 * would visibly flash back to the pre-drag position for up to `DEBOUNCE_MS`.
 * The debounced call still fires a moment later on the identical string —
 * a harmless redundant parse, not a race, since `after`/`before` are fixed
 * strings closed over at push time, not read again later.
 *
 * **`save`/`render`'s return values, extended for D-170 (Motion tab MCP
 * surface, Phase 4).** Before this pass, both were `Promise<boolean>` /
 * `Promise<void>` — real failures only ever surfaced as a SIDE EFFECT
 * (`saveError`/`renderError` React state), which is fine for the GUI (the
 * next render just shows it) but not for `useMotionControl.ts`'s
 * `motion_save_manifest`/`motion_render` ops: a Tauri-event handler awaiting
 * `cur.save()`/`cur.render()` has no reliable way to observe a LATER
 * re-render of this same component from outside it — reading `mRef.current
 * .saveError` right after the `await` resolves would be racing this
 * component's own re-render (state updates here are not part of any React
 * *event* the bridge's caller participates in, so there's no batching
 * guarantee they've committed yet). Rather than accept that race, `save` now
 * resolves to a real `SaveOutcome` (`{ok, error?, path?}`) and `render` to a
 * real `RenderOutcome` (`{ok, error?, result?}`) — the definitive answer,
 * carried on the SAME promise the caller already awaits, no state re-read
 * required. Every existing side effect (`saveError`/`renderError`/
 * `renderResult`/`onRendered`) is unchanged — this only ADDS a return value
 * neither the GUI's `<Button onClick={m.save}>` / `<Button onClick={m.render}>`
 * (typed `() => void` in `ManifestEditor.tsx`, so a resolved-but-ignored
 * return value is exactly as before) nor any other existing caller reads.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { manifestSchema, type Manifest } from '@apelles/motion-engine/src/engine/schema';
import { sample } from '@apelles/motion-engine/src/engine/sample';
import { sceneStartFrame, sceneDurationFrames } from '@apelles/motion-engine/src/engine/build';
import { useHistoryStore } from '@apelles/history';

import { saveManifest, renderManifest, type MotionRenderResult } from './manifestIO';
import { useMotionProjectStore } from './motionProjectStore';

const DEBOUNCE_MS = 300;

export type LoadState = 'loading' | 'no-project' | 'ready' | 'error';

/** See this file's own module doc comment ("save/render's return values,
 *  extended for D-170") for why these carry the definitive outcome on the
 *  promise itself rather than leaving it to a later state read. */
export interface SaveOutcome {
  ok: boolean;
  error?: string;
  /** the sidecar path `chroma_motion_save_manifest` wrote to, on success. */
  path?: string;
}

/** D-180 — one scene's own render result, `MotionRenderResult` (the raw
 *  Rust-facing shape) plus the `sceneId` it belongs to (attached client-side;
 *  the backend command itself is manifest-shape agnostic and never knows
 *  scene identity, per `motion.rs`'s own module doc comment). */
export interface SceneRenderResult extends MotionRenderResult {
  sceneId: string;
}

export interface RenderOutcome {
  ok: boolean;
  error?: string;
  /** D-180 — every scene now renders to its OWN separate file (Render no
   *  longer produces one combined video), so this is an array even for a
   *  single-scene manifest, not a single `MotionRenderResult` any more. */
  result?: SceneRenderResult[];
}

export function useMotionManifest(onRendered?: (r: SceneRenderResult) => void | Promise<void>) {
  const projectOpen = useMotionProjectStore((s) => s.openProjectPath !== null);
  const status = useMotionProjectStore((s) => s.status);
  const loadError = useMotionProjectStore((s) => s.error);
  const loaded = useMotionProjectStore((s) => s.loaded);
  const reload = useMotionProjectStore((s) => s.load);

  const [text, setText] = useState('');
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  // the text as last written to disk — `null` before the first successful save
  const [savedText, setSavedText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [rendering, setRendering] = useState(false);
  const [renderResult, setRenderResult] = useState<SceneRenderResult[] | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  const debounceRef = useRef<number | null>(null);

  const applyParse = useCallback((raw: string) => {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e));
      return;
    }
    const result = manifestSchema.safeParse(json);
    if (result.success) {
      setManifest(result.data);
      setParseError(null);
    } else {
      setParseError(
        result.error.issues
          .map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
          .join('\n'),
      );
    }
  }, []);

  // Seed the editor from the store's last successful read. Keyed on the read's
  // *generation*, not on the value: re-running this for the same read would
  // discard whatever the owner has typed since it landed.
  const seededGeneration = useRef<number | null>(null);
  useEffect(() => {
    if (!loaded) {
      seededGeneration.current = null;
      setText('');
      setSavedText(null);
      setManifest(null);
      setParseError(null);
      return;
    }
    if (seededGeneration.current === loaded.generation) return;
    seededGeneration.current = loaded.generation;
    const initialText = JSON.stringify(loaded.manifest ?? sample, null, 2);
    setText(initialText);
    // a project with no saved manifest starts on the engine's sample, which is
    // by definition not "what's on disk" — so it starts dirty, as before.
    setSavedText(loaded.manifest ? initialText : null);
    applyParse(initialText);
  }, [loaded, applyParse]);

  // B-058: re-check on window focus only when the last read actually *failed*.
  // The old version re-read whenever it believed no project was open, which was
  // this tab's only escape from that (wrong) state and never fired for the real
  // case — a project opened from the in-window launcher blurs nothing. It is
  // deliberately NOT a refetch-on-every-focus like `@apelles/editor`'s: this tab
  // holds unsaved editor text, and re-seeding it from disk on an alt-tab would
  // silently throw the owner's work away.
  useEffect(() => {
    const onFocus = () => {
      const s = useMotionProjectStore.getState();
      if (s.openProjectPath !== null && s.status === 'error') void s.load();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // B-058: derived, never inferred from a failed call. 'ready' additionally
  // waits for the seeding effect above to have run, so the tab never renders
  // its editor against an empty string for one frame.
  const loadState: LoadState = !projectOpen
    ? 'no-project'
    : status === 'error'
      ? 'error'
      : status === 'ready' && text !== ''
        ? 'ready'
        : 'loading';

  const setTextLive = useCallback(
    (raw: string) => {
      setText(raw);
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => applyParse(raw), DEBOUNCE_MS);
    },
    [applyParse],
  );

  const dirty = savedText !== text;

  // D-155 — the one commit path for a whole-manifest change that should be
  // undoable: an Inspector field edit (first customer, per the research
  // doc's own Phase 0c) and a Phase 1 canvas-drag commit both call this
  // instead of `setText(JSON.stringify(...))` directly. `label` is a short,
  // human-readable one-liner for a future "Undo <label>" affordance, same
  // spirit as `@apelles/editor`'s `labelForOp`.
  const commit = useCallback(
    (next: Manifest, label: string) => {
      const after = JSON.stringify(next, null, 2);
      if (after === text) return; // no real change — don't push a no-op undo entry
      const before = text;
      const apply = (raw: string) => {
        setTextLive(raw);
        applyParse(raw);
      };
      apply(after);
      useHistoryStore.getState().push({
        tab: 'motion',
        label,
        undo: () => apply(before),
        redo: () => apply(after),
      });
    },
    [text, setTextLive, applyParse],
  );

  const save = useCallback(async (): Promise<SaveOutcome> => {
    if (!manifest || parseError) {
      return { ok: false, error: parseError ?? 'no manifest to save' };
    }
    setSaving(true);
    setSaveError(null);
    try {
      const path = await saveManifest(manifest);
      setSavedText(text);
      return { ok: true, path };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setSaveError(message);
      return { ok: false, error: message };
    } finally {
      setSaving(false);
    }
  }, [manifest, parseError, text]);

  const render = useCallback(async (): Promise<RenderOutcome> => {
    setRenderError(null);
    setRenderResult(null);
    if (!manifest || parseError) {
      const error = 'fix the manifest errors above before rendering';
      setRenderError(error);
      return { ok: false, error };
    }
    setRendering(true);
    // Hoisted above the `try` so a failure partway through the per-scene
    // loop below can still surface which scenes DID finish before the
    // error, via the `catch` block's own `setRenderResult(results)` call.
    const results: SceneRenderResult[] = [];
    try {
      if (dirty) {
        const saveOutcome = await save();
        if (!saveOutcome.ok) {
          // `save()` itself already set `saveError` — mirrors the pre-D-170
          // behaviour exactly (a failed pre-render save surfaced only via
          // the editor's own save-error display, never `renderError`), now
          // additionally reported on this promise for a caller with no
          // component state to read (`motion_render`).
          return { ok: false, error: saveOutcome.error ?? 'save failed' };
        }
      }
      // D-180 — "scene should be a separate composition… exported as
      // separate video, not on top of it": Render no longer produces one
      // combined video. Every scene renders SEQUENTIALLY (never parallel —
      // a render is CPU/GPU-heavy; overlapping N of them is a real
      // footgun) to its own file, via the SAME `chroma_motion_render`
      // command scoped to that scene's own absolute frame window
      // (`sceneStartFrame`/`sceneDurationFrames`, `build.ts` — the exact
      // math `KeyframeTimeline.tsx` already uses for scene boundaries,
      // reused here rather than re-derived). A scene's render failing
      // STOPS the loop rather than silently skipping it — unlike a
      // geometry clamp, a failed video render is not something to paper
      // over; the owner needs to know exactly which scene failed and why.
      for (let i = 0; i < manifest.scenes.length; i++) {
        const scene = manifest.scenes[i];
        const start = sceneStartFrame(manifest, i);
        const end = start + sceneDurationFrames(manifest, i) - 1;
        const result = await renderManifest(undefined, [start, end], scene.id);
        results.push({ ...result, sceneId: scene.id });
        // D-062: rendering used to just write the file and print its path
        // as plain text — nothing put it anywhere the owner could actually
        // use it, so "does render create a video I can drag into my own
        // video?" was a real "no" until this callback. `onRendered` is
        // owned by the app layer (D-039: a tab package like this one must
        // not reach into `@apelles/bridge`'s media pool store directly),
        // which imports it into Sources — called once per scene now, so
        // every scene's own file lands there individually.
        //
        // D-260 — it is handed the whole `SceneRenderResult`, not just the
        // path. The app layer needs the `sceneId` to stamp provenance on the
        // pool item, and deriving it back from the path would mean a second
        // copy of `motion.rs`'s `default_output_path` math in TypeScript —
        // which would then be wrong for any render that named its own output
        // path. Awaited, unlike the fire-and-forget call it replaces: the
        // app layer's reconcile re-probes the file and refreshes linked Edit
        // clips, and letting scene N+1's render start on top of that would
        // race two manifest writes against each other. A failure there is
        // reported by the app layer's own toast and must not fail the render
        // that already succeeded.
        try {
          await onRendered?.({ ...result, sceneId: scene.id });
        } catch {
          /* reconciling Sources is the app layer's to report — see above */
        }
      }
      setRenderResult(results);
      return { ok: true, result: results };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setRenderError(message);
      // Surface whichever scenes DID finish before the failure, rather than
      // discarding them — a caller re-rendering after fixing scene 3 of 3
      // shouldn't lose the already-succeeded 1/2 from the display.
      if (results.length > 0) setRenderResult(results);
      return { ok: false, error: message };
    } finally {
      setRendering(false);
    }
  }, [manifest, parseError, dirty, save, onRendered]);

  return {
    loadState,
    loadError,
    reload,

    text,
    setText: setTextLive,
    manifest,
    parseError,
    commit,

    dirty,
    saving,
    saveError,
    save,

    rendering,
    renderResult,
    renderError,
    render,
  };
}
