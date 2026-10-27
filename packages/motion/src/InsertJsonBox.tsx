/**
 * @apelles/motion — "Insert as JSON" (D-403), the human half of
 * `motion_validate` / `motion_insert_layers` / `motion_set_scene`.
 *
 * What it is: a collapsible box at the foot of the Catalog panel. Paste one
 * layer, an array of layers, or a whole scene; **Check** runs the same
 * validator `motion_validate` runs and lists each issue with its path and
 * hint; **Insert** / **Replace scene** lands the fragment through the same plan
 * the MCP ops use (`authoring.ts`, called by `MotionTab.tsx`), as one undoable
 * edit. So a graphic someone authored as data (in a doc, from an agent's
 * reply, from another project's manifest) can be pasted in with exactly the
 * checks an agent's call gets.
 *
 * What it does NOT do: edit the fragment for you, or insert anything that does
 * not validate. Not `@apelles/ui` — the same `@react-three/fiber` JSX-typing
 * conflict every file in this package works around (see `Button.tsx`).
 */
import { useState } from 'react';
import {
  iconIssues,
  validateLayers,
  validateScene,
  withIssues,
  type ValidationIssue,
} from '@apelles/motion-engine/src/engine/validate';
import { iconNamesFor, type MotionRefusal } from './authoring';

export type InsertJsonMode = 'layers' | 'scene';

type Status = { kind: 'idle' } | { kind: 'ok'; message: string } | { kind: 'error'; message: string; issues: ValidationIssue[] };

export function InsertJsonBox({
  disabled,
  onInsert,
}: {
  disabled: boolean;
  onInsert: (mode: InsertJsonMode, value: unknown) => Promise<MotionRefusal | null>;
}) {
  const [mode, setMode] = useState<InsertJsonMode>('layers');
  const [text, setText] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const parse = (): { ok: true; value: unknown } | { ok: false } => {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (e) {
      setStatus({ kind: 'error', message: `not JSON: ${e instanceof Error ? e.message : String(e)}`, issues: [] });
      return { ok: false };
    }
  };

  const check = async () => {
    const parsed = parse();
    if (!parsed.ok) return;
    const value = mode === 'layers' && !Array.isArray(parsed.value) ? [parsed.value] : parsed.value;
    const base =
      mode === 'layers'
        ? validateLayers(value)
        : validateScene({ id: 'scene', ...(value as Record<string, unknown>) });
    // D-405 — the same icon-name pass `motion_validate` runs.
    const icons = await iconNamesFor(value);
    const result = icons ? withIssues(base, iconIssues(value, icons, mode === 'layers' ? ['layers'] : ['scene'])) : base;
    setStatus(
      result.ok
        ? { kind: 'ok', message: 'valid' }
        : { kind: 'error', message: `${result.issues.length} issue(s)`, issues: result.issues },
    );
  };

  const insert = async () => {
    const parsed = parse();
    if (!parsed.ok) return;
    const refusal = await onInsert(mode, parsed.value);
    if (refusal) {
      setStatus({ kind: 'error', message: refusal.issues.length > 0 ? `${refusal.issues.length} issue(s)` : refusal.error, issues: refusal.issues });
      return;
    }
    setStatus({ kind: 'ok', message: mode === 'layers' ? 'inserted' : 'scene replaced' });
    setText('');
  };

  return (
    <details className="shrink-0 border-t border-border-color px-2 py-2 group">
      <summary className="text-[10px] uppercase tracking-wide text-text-secondary/70 cursor-pointer select-none">
        Insert as JSON
      </summary>
      <div className="mt-2 flex flex-col gap-1.5">
        <div className="flex gap-1" role="radiogroup" aria-label="What the JSON is">
          {(['layers', 'scene'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => {
                setMode(m);
                setStatus({ kind: 'idle' });
              }}
              className={`h-5 px-2 rounded text-[10px] border transition-colors ${
                mode === m ? 'border-accent text-text-primary' : 'border-border-color text-text-secondary hover:text-text-primary'
              }`}
            >
              {m === 'layers' ? 'Layer(s)' : 'Whole scene'}
            </button>
          ))}
        </div>
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setStatus({ kind: 'idle' });
          }}
          spellCheck={false}
          rows={6}
          placeholder={
            mode === 'layers'
              ? '[{"use":"text","text":"Hello","x":200,"y":300}]'
              : '{"dur":4,"layers":[{"use":"text","text":"Hello"}]}'
          }
          className="w-full resize-y rounded border border-border-color bg-transparent p-1.5 font-mono text-[10px] text-text-primary focus:outline-none focus:border-accent"
        />
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => void check()}
            disabled={text.trim() === ''}
            className="h-6 flex-1 rounded border border-border-color text-[10px] text-text-secondary hover:text-text-primary disabled:opacity-40"
          >
            Check
          </button>
          <button
            type="button"
            onClick={() => void insert()}
            disabled={disabled || text.trim() === ''}
            className="h-6 flex-1 rounded border border-dashed border-border-color text-[10px] text-text-secondary hover:text-text-primary hover:border-accent disabled:opacity-40"
          >
            {mode === 'layers' ? '+ Insert' : 'Replace scene'}
          </button>
        </div>
        {status.kind === 'ok' && <p className="text-[10px] text-text-secondary">{status.message}</p>}
        {status.kind === 'error' && (
          <div className="text-[10px] text-red-400 flex flex-col gap-0.5" role="alert">
            <p>{status.message}</p>
            {status.issues.map((i, n) => (
              <p key={n} className="font-mono break-words">
                {i.path || '(root)'}: {i.message}
                {i.hint ? ` — ${i.hint}` : ''}
              </p>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}
