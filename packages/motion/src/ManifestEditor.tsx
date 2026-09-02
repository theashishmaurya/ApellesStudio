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
 */
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
  return (
    <div className="h-full w-full flex flex-col min-h-0">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border-color shrink-0">
        <span className="text-xs font-medium text-text-secondary">
          Scene manifest{dirty ? ' · unsaved' : ''}
        </span>
        <div className="flex gap-2">
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

      <textarea
        className="flex-1 min-h-0 resize-none bg-bg-secondary text-text-primary font-mono text-[11px] leading-relaxed p-3 outline-none border-0"
        spellCheck={false}
        value={text}
        onChange={(e) => onChange(e.target.value)}
      />

      <div className="shrink-0 border-t border-border-color px-3 py-2 text-xs space-y-1 max-h-32 overflow-auto">
        {parseError && <pre className="text-red-400 whitespace-pre-wrap">{parseError}</pre>}
        {saveError && <p className="text-red-400">save failed: {saveError}</p>}
        {renderError && <p className="text-red-400">render failed: {renderError}</p>}
        {renderResult && (
          <p className="text-text-secondary">rendered → {renderResult.outputPath}</p>
        )}
        {!parseError && !saveError && !renderError && !renderResult && (
          <p className="text-text-secondary/60">manifest valid</p>
        )}
      </div>
    </div>
  );
}
