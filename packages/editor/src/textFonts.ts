/**
 * @chroma/editor — the Edit tab's font catalogue, as the frontend sees it
 * (D-209/D-210, `docs/notes/text-title-clips.md`).
 *
 * **What it is:** a tiny module-level cache of `chroma_text_fonts` — the
 * backend's own list of selectable font families, each already resolved to a
 * real absolute font-file path on THIS machine (`app/src-tauri/src/chroma/
 * text.rs`).
 *
 * **Why a module cache rather than a per-component fetch:** the same
 * catalogue is needed by two callers with two different shapes. The
 * Inspector's font picker wants it in React (`useTextFonts`), asynchronously,
 * whenever it renders. `compileEditorExportArgs` wants it **synchronously**,
 * because the export queue compiles a job's ffmpeg argv at ENQUEUE time (a
 * deliberate D-198 design: the argv is a snapshot of the timeline as it was
 * when queued) and that path is not async. One lazily-populated module cache
 * serves both, and `loadTextFonts()` is called once at Edit-tab mount
 * (`useEditorControl`) so the synchronous read is warm long before any export.
 *
 * **What it does NOT do:** no font parsing, no rendering, no fallback
 * invention. A family whose `path` is `null` is one this machine does not
 * have a file for; the picker greys it out and the export compiler refuses
 * rather than substituting a different face (which would silently make the
 * exported title disagree with the preview — the whole point of D-210 is that
 * both renderers read the SAME file).
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

/** Mirrors `chroma::text::ResolvedFont` (serde `camelCase`). */
export interface TextFont {
  /** The stable catalogue key stored in `TextLayer.font`. */
  key: string;
  /** Human label for the picker. */
  label: string;
  /** The absolute font file, or `null` if none of this family's candidate
   *  paths exist on this machine. */
  path: string | null;
}

let cache: TextFont[] | null = null;
let inflight: Promise<TextFont[]> | null = null;

/** Fetch the catalogue once and cache it.
 *
 *  Idempotent and concurrency-safe: parallel callers share one in-flight
 *  request rather than each issuing their own. A failed fetch resolves to an
 *  empty list and clears the in-flight slot, so a later call retries — the
 *  catalogue is static data, but the command can still fail during the brief
 *  window before the backend is up. */
export async function loadTextFonts(): Promise<TextFont[]> {
  if (cache) return cache;
  if (!inflight) {
    inflight = invoke<TextFont[]>('chroma_text_fonts')
      .then((fonts) => {
        cache = fonts;
        return fonts;
      })
      .catch(() => [])
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** The already-loaded catalogue, or `[]` if `loadTextFonts` has not resolved
 *  yet. Synchronous by design — see this module's own doc for why the export
 *  compiler needs it that way. */
export function textFontsSync(): TextFont[] {
  return cache ?? [];
}

/** `{ fontKey: absolutePath }` for every family this machine actually has a
 *  file for — exactly the shape `TimelineExportOptions.fontFiles` takes. */
export function textFontPaths(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of textFontsSync()) {
    if (f.path) out[f.key] = f.path;
  }
  return out;
}

/** Test seam — reset the cache so a test can control what the catalogue is.
 *  Not used by app code. */
export function __setTextFontsForTest(fonts: TextFont[] | null): void {
  cache = fonts;
  inflight = null;
}

/** The catalogue, in React. Returns `[]` on the first render and the real list
 *  once loaded; a component that has to disable its picker until then can test
 *  for `length === 0`. */
export function useTextFonts(): TextFont[] {
  const [fonts, setFonts] = useState<TextFont[]>(() => textFontsSync());
  useEffect(() => {
    let live = true;
    void loadTextFonts().then((f) => {
      if (live) setFonts(f);
    });
    return () => {
      live = false;
    };
  }, []);
  return fonts;
}
