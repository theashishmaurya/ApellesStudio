/**
 * @chroma/motion — the manifest editor (D-046).
 *
 * JSON-in, on purpose: a plain, validated `<textarea>`, not a visual editor
 * — the roadmap ("Motion tab MVP") and `product-direction.md` §9 leave the
 * visual-editor question open, so this pass scopes down to JSON-in. Every
 * edit live-parses (debounced in `useMotionManifest`) against the engine's
 * own `zod` schema and surfaces the result inline, rather than failing
 * silently. Save persists the project's manifest sidecar; Render drives a
 * real `npx remotion render` through the `chroma-motion` crate.
 *
 * D-153 — collapsed by default behind a `</>` toggle: the owner's own words,
 * "as a user i dont need that, you will need only" (`docs/notes/
 * motion-visual-builder-research.md` Part C names the trap this avoids). Only
 * the textarea + status strip collapse — the header (name/dirty state, the
 * `</>` toggle, and Save/Render) stays visible at all times, because Save,
 * Render, and a save/render *error* are real actions/facts the owner needs
 * regardless of whether they ever look at raw JSON.
 */
import { useState } from 'react';

import { Button } from './Button';

import type { MotionRenderResult } from './manifestIO';

interface Props {
  text: string;
  onChange: (text: string) => void;
  parseError: string | null;

  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  onSave: () => void;

  rendering: boolean;
  renderError: string | null;
  renderResult: MotionRenderResult | null;
  onRender: () => void;
}

export function ManifestEditor({
  text,
  onChange,
  parseError,
  dirty,
  saving,
  saveError,
  onSave,
  rendering,
  renderError,
  renderResult,
  onRender,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  // A parse error means the owner (or an agent) is mid-edit of raw JSON right
  // now — auto-reveal it rather than hiding the one thing that explains why
  // Save/Render just greyed out.
  const showBody = expanded || !!parseError;

  return (
    <div className="h-full w-full flex flex-col min-h-0">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border-color shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            title={showBody ? 'Hide scene manifest' : 'Show scene manifest (JSON)'}
            aria-label={showBody ? 'Hide scene manifest' : 'Show scene manifest'}
            aria-pressed={showBody}
            className="shrink-0 h-6 w-6 flex items-center justify-center rounded-md font-mono text-[10px] leading-none border border-border-color bg-surface/90 text-text-secondary hover:text-text-primary hover:bg-hover-color transition-colors"
          >
            {'</>'}
          </button>
          <span className="text-xs font-medium text-text-secondary truncate">
            Scene manifest{dirty ? ' · unsaved' : ''}
          </span>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button
            variant="secondary"
            disabled={!dirty || saving || !!parseError}
            onClick={onSave}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button disabled={rendering || !!parseError} onClick={onRender}>
            {rendering ? 'Rendering…' : 'Render'}
          </Button>
        </div>
      </div>

      {showBody && (
        <textarea
          className="flex-1 min-h-0 resize-none bg-bg-secondary text-text-primary font-mono text-[11px] leading-relaxed p-3 outline-none border-0"
          spellCheck={false}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {/* A save/render error is a real fact the owner needs even with the
         JSON collapsed — this strip stays outside `showBody` on purpose. */}
      {(saveError || renderError || (showBody && (parseError || renderResult))) && (
        <div className="shrink-0 border-t border-border-color px-3 py-2 text-xs space-y-1 max-h-32 overflow-auto">
          {parseError && showBody && (
            <pre className="text-red-400 whitespace-pre-wrap">{parseError}</pre>
          )}
          {saveError && <p className="text-red-400">save failed: {saveError}</p>}
          {renderError && <p className="text-red-400">render failed: {renderError}</p>}
          {renderResult && showBody && (
            // D-062: the render itself only ever writes a file — "added to
            // Sources" here describes what `onRendered` (app-level) does
            // with it, not something this package does; if a future caller
            // doesn't wire that callback the file still rendered fine, just
            // isn't in the pool automatically, so keep this honest rather
            // than always claiming it.
            <p className="text-text-secondary">rendered → {renderResult.outputPath} · added to Sources</p>
          )}
        </div>
      )}
    </div>
  );
}
