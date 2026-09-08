/**
 * @chroma/editor — the Edit tab's font catalogue, as the frontend sees it
 * (D-211/D-212, `docs/notes/text-title-clips.md`).
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
 * exported title disagree with the preview — the whole point of D-212 is that
 * both renderers read the SAME file).
 *
 * **D-240 — [`composeFontStyleKey`].** Bold/Italic are exposed as TOGGLES in
 * the Inspector and as `bold`/`italic` MCP parameters, but neither `TextLayer`
 * nor `CaptionStyle` grew a new stored field for them: `font` remains the
 * ONE flat catalogue key both structs have always stored (D-212), and a
 * toggle is sugar that composes a NEW flat key from the catalogue's own
 * `group`/`bold`/`italic` metadata (`chroma::text::TEXT_FONTS`) before the
 * write happens. This is the single place that composition is implemented —
 * the Inspector's own button handlers and `useEditorControl.ts`'s MCP op
 * handlers both call it, so there is one rule for "what does Bold mean",
 * never two (CLAUDE.md: "the same op/store action underneath both").
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
  /** D-240 — the style-axis group this entry belongs to (e.g. `"sans"`), or
   *  `null` for a standalone design with no bold/italic siblings in the
   *  catalogue (`impact`, `sans-black`). See [`composeFontStyleKey`]. */
  group: string | null;
  /** D-240 — whether this entry IS its group's bold face. */
  bold: boolean;
  /** D-240 — whether this entry IS its group's italic (or bold-italic) face. */
  italic: boolean;
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

// ---- D-240: the Bold/Italic style axis --------------------------------- //
//
// A `TextLayer`/`CaptionStyle` still stores exactly one flat `font` key
// (D-212) — nothing below adds a stored field. What Bold/Italic toggle is
// which flat key a FAMILY + two booleans compose to, entirely from the
// catalogue's own `group`/`bold`/`italic` metadata, so this file (not a
// second copy in Rust, not a third in the MCP layer) is the one place that
// composition rule lives.

/** The catalogue entries a Family picker should list: one per `group` (its
 *  regular, non-bold non-italic member) plus every standalone entry
 *  (`group: null`) — `sans`, `condensed`, `serif`, `mono`, `sans-black`,
 *  `impact` today. The Bold/Italic buttons are what reach the other members
 *  of a group; they are not separate rows in this list. */
export function baseFontFamilies(fonts: TextFont[]): TextFont[] {
  return fonts.filter((f) => !f.bold && !f.italic);
}

/** `font`'s own `{ group, bold, italic }`, from the catalogue — what a Bold/
 *  Italic button reads to decide whether it should render pressed. An
 *  unrecognised key (a project saved with a family this build no longer
 *  ships) degrades to "no group, not bold, not italic" — the same "the model
 *  stores what was written, the consumer decides what it means" rule
 *  `TextLayer::rgb` follows on the Rust side, rather than throwing. */
export function fontStyleOf(
  fonts: TextFont[],
  font: string,
): { group: string | null; bold: boolean; italic: boolean } {
  const entry = fonts.find((f) => f.key === font);
  return { group: entry?.group ?? null, bold: entry?.bold ?? false, italic: entry?.italic ?? false };
}

/** Compose the flat catalogue key for `(the group `font` belongs to, bold,
 *  italic)` — what a Bold/Italic toggle or a family change actually writes
 *  into `TextLayer.font`/`CaptionStyle.font`.
 *
 *  **Degrades rather than failing** when the exact combination is not in the
 *  catalogue or this machine has no file for it (a family with no italic
 *  face, e.g. `impact`/`sans-black`; a `Some(group)` member whose file is
 *  simply missing on this box): drops italic first, then bold, then falls
 *  back to `font` unchanged. That order is deliberate — a caller who asked
 *  for "bold italic" and can get only "bold" is closer to what they wanted
 *  than falling all the way back to plain regular. Returns `font` unchanged
 *  (a true no-op) for a key with no `group` at all, since there is no sibling
 *  to compose to. */
export function composeFontStyleKey(
  fonts: TextFont[],
  font: string,
  bold: boolean,
  italic: boolean,
): string {
  const current = fonts.find((f) => f.key === font);
  const group = current?.group ?? null;
  if (group === null) return font;
  const find = (wantBold: boolean, wantItalic: boolean): TextFont | undefined =>
    fonts.find((f) => f.group === group && f.bold === wantBold && f.italic === wantItalic && f.path);
  return (find(bold, italic) ?? find(bold, false) ?? find(false, false) ?? current)?.key ?? font;
}
