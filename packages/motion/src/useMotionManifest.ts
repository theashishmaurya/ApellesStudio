/**
 * @chroma/motion — the manifest-editing state (D-046; readiness split out to
 * `motionProjectStore` in B-058/D-150).
 *
 * The *editing* state is component-local (text, parse errors, dirty, save,
 * render) — nothing outside this tab needs it. **Readiness is not**: whether a
 * project is open comes from the app (`app/src/main.tsx` → `useMotionProject
 * Store.setProjectOpen`) and the tab is mounted from boot, so it lives in the
 * store. This hook seeds its editor text from whatever that store last read
 * (falling back to the engine's own sample manifest for a project with no
 * saved manifest yet), live-validates every edit (debounced) against
 * `@chroma/motion-engine`'s `zod` schema — the schema's single source of truth
 * — and drives save/render through `manifestIO`.
 *
 * B-058: `loadState` is *derived* — `'no-project'` comes from the store's
 * `projectOpen` flag alone, never from a failed read. A read that fails while a
 * project is genuinely open is `'error'`, with the real backend message.
 *
 * A parse/validation error never blinks the preview away: `manifest` only
 * ever holds the last value that parsed clean, so `<MotionPreview>` keeps
 * showing it while `parseError` is surfaced separately in the editor pane.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { manifestSchema, type Manifest } from '@chroma/motion-engine/src/engine/schema';
import { sample } from '@chroma/motion-engine/src/engine/sample';

import { saveManifest, renderManifest, type MotionRenderResult } from './manifestIO';
import { useMotionProjectStore } from './motionProjectStore';

const DEBOUNCE_MS = 300;

export type LoadState = 'loading' | 'no-project' | 'ready' | 'error';

export function useMotionManifest(onRendered?: (outputPath: string) => void) {
  const projectOpen = useMotionProjectStore((s) => s.projectOpen);
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
  const [renderResult, setRenderResult] = useState<MotionRenderResult | null>(null);
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
  // deliberately NOT a refetch-on-every-focus like `@chroma/editor`'s: this tab
  // holds unsaved editor text, and re-seeding it from disk on an alt-tab would
  // silently throw the owner's work away.
  useEffect(() => {
    const onFocus = () => {
      const s = useMotionProjectStore.getState();
      if (s.projectOpen && s.status === 'error') void s.load();
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

  const save = useCallback(async (): Promise<boolean> => {
    if (!manifest || parseError) return false;
    setSaving(true);
    setSaveError(null);
    try {
      await saveManifest(manifest);
      setSavedText(text);
      return true;
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setSaving(false);
    }
  }, [manifest, parseError, text]);

  const render = useCallback(async () => {
    setRenderError(null);
    setRenderResult(null);
    if (!manifest || parseError) {
      setRenderError('fix the manifest errors above before rendering');
      return;
    }
    setRendering(true);
    try {
      if (dirty) {
        const ok = await save();
        if (!ok) return;
      }
      const result = await renderManifest();
      setRenderResult(result);
      // D-062: rendering used to just write the file and print its path as
      // plain text — nothing put it anywhere the owner could actually use
      // it (not the Sources pool, not the Edit timeline), so "does render
      // create a video I can drag into my own video?" was a real "no" until
      // this callback. `onRendered` is owned by the app layer (D-039: a tab
      // package like this one must not reach into `@chroma/bridge`'s media
      // pool store directly), which imports it into Sources — from there
      // it's a normal draggable clip like anything else, not spliced onto a
      // timeline automatically (the owner may not want it there yet, or may
      // want it on a different timeline/track than whatever's active).
      onRendered?.(result.outputPath);
    } catch (e) {
      setRenderError(e instanceof Error ? e.message : String(e));
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
