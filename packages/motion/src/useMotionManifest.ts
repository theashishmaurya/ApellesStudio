/**
 * @chroma/motion — the manifest-editing state (D-046).
 *
 * Local component state (no store — nothing outside this tab needs it,
 * unlike `@chroma/editor`'s timeline store, see its B-007 note). Loads the
 * current project's saved manifest on mount (falling back to the engine's
 * own sample manifest for a fresh project), live-validates every edit
 * (debounced) against `@chroma/motion-engine`'s `zod` schema — the schema's
 * single source of truth — and drives save/render through `manifestIO`.
 *
 * A parse/validation error never blinks the preview away: `manifest` only
 * ever holds the last value that parsed clean, so `<MotionPreview>` keeps
 * showing it while `parseError` is surfaced separately in the editor pane.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { manifestSchema, type Manifest } from '@chroma/motion-engine/src/engine/schema';
import { sample } from '@chroma/motion-engine/src/engine/sample';

import {
  getSavedManifest,
  saveManifest,
  renderManifest,
  NoProjectOpenError,
  type MotionRenderResult,
} from './manifestIO';

const DEBOUNCE_MS = 300;

export type LoadState = 'loading' | 'no-project' | 'ready' | 'error';

export function useMotionManifest() {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);

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

  const load = useCallback(async () => {
    setLoadState('loading');
    setLoadError(null);
    try {
      const saved = await getSavedManifest();
      const initial = saved ?? sample;
      const initialText = JSON.stringify(initial, null, 2);
      setText(initialText);
      setSavedText(saved ? initialText : null);
      applyParse(initialText);
      setLoadState('ready');
    } catch (e) {
      if (e instanceof NoProjectOpenError) {
        setLoadState('no-project');
      } else {
        setLoadState('error');
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    }
  }, [applyParse]);

  useEffect(() => {
    load();
  }, [load]);

  // a project may have been opened (in the Colorist tab) after this tab
  // mounted — re-check on window focus, same fix `@chroma/editor` needed
  // (B-007) for the analogous "stale no-project state" gap.
  useEffect(() => {
    const onFocus = () => {
      if (loadState === 'no-project') load();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load, loadState]);

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
    } catch (e) {
      setRenderError(e instanceof Error ? e.message : String(e));
    } finally {
      setRendering(false);
    }
  }, [manifest, parseError, dirty, save]);

  return {
    loadState,
    loadError,
    reload: load,

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
