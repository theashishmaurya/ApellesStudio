/**
 * @apelles/motion — the theme editor, beside the Theme picker (D-399, B-268).
 *
 * What it is: the human half of `motion_define_theme` / `motion_delete_theme`.
 * A form over a theme's data — eight colours, the stroke feel, three font stacks
 * and the Google Fonts families to download — that starts from the theme the
 * document uses now, can be filled from a pasted CSS token file, and ends in
 * three actions: **Use in this project** (embeds the definition in the manifest,
 * so the render is deterministic anywhere), **Save to library** (also keeps it
 * for other projects) and **Remove from library**.
 *
 * What it does NOT do: build or validate anything itself. Every action goes
 * through `buildThemeDef` (`themeLibrary.ts`), the SAME function the MCP tool
 * calls, so a colour the tool refuses is refused here with the same sentence.
 * It holds a draft only; nothing is written until an action runs.
 */
import { useState } from 'react';
import { InspectorSection } from '@apelles/inspector';
import {
  THEME_COLOR_FIELDS,
  THEME_FONT_STACK_FIELDS,
  THEME_NUMBER_FIELDS,
  themeDefFromTokens,
  type ThemeDef,
  type ThemeFont,
} from '@apelles/motion-engine/src/themeDef';
import { buildThemeDef, themeDefOfName } from './themeLibrary';
import { DEFAULT_THEME_NAME } from '@apelles/motion-engine/src/design';

const FIELD_LABELS: Record<string, string> = {
  bg: 'Ground',
  bgDeep: 'Ground, deep',
  stroke: 'Stroke',
  strokeSoft: 'Stroke, soft',
  text: 'Text',
  textDim: 'Text, dim',
  accent: 'Accent',
  accentSignal: 'Accent, signal',
  strokeWidth: 'Stroke width',
  roughness: 'Roughness',
  bowing: 'Bowing',
  ambientDriftPx: 'Ambient drift (px)',
  fontDisplay: 'Display font',
  fontUi: 'UI font',
  fontMono: 'Mono font',
};

const input =
  'h-7 min-w-0 rounded border border-border-color bg-bg-primary px-1.5 text-xs text-text-primary';

/** `Newsreader:400,600 | Instrument Sans` ↔ the fonts list, the same notation
 *  the token file's `--apelles-theme-fonts` uses. */
function fontsToText(fonts: ThemeFont[] | undefined): string {
  return (fonts ?? [])
    .map((f) => (f.weights && f.weights.length ? `${f.family}:${f.weights.join(',')}` : f.family))
    .join(' | ');
}

function textToFonts(text: string): ThemeFont[] {
  return text
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((spec) => {
      const [family, weights] = spec.split(':');
      return {
        family: family.trim(),
        ...(weights ? { weights: weights.split(',').map((w) => w.trim()) } : {}),
      };
    });
}

type Draft = Record<string, string>;

function draftOf(def: ThemeDef): Draft {
  const d: Draft = { name: def.name, description: def.description ?? '', fonts: fontsToText(def.fonts) };
  for (const k of [...THEME_COLOR_FIELDS, ...THEME_NUMBER_FIELDS, ...THEME_FONT_STACK_FIELDS]) {
    d[k] = String((def as unknown as Record<string, unknown>)[k]);
  }
  return d;
}

function fieldsOf(draft: Draft): Record<string, unknown> {
  const out: Record<string, unknown> = { description: draft.description, fonts: textToFonts(draft.fonts) };
  for (const k of THEME_COLOR_FIELDS) out[k] = draft[k];
  for (const k of THEME_FONT_STACK_FIELDS) out[k] = draft[k];
  for (const k of THEME_NUMBER_FIELDS) out[k] = Number(draft[k]);
  return out;
}

export function ThemeEditor({
  currentName,
  embedded,
  library,
  onUse,
  onSaveToLibrary,
  onRemoveFromLibrary,
}: {
  /** the theme the document renders with now (`manifest.theme`, or the default) */
  currentName: string;
  /** the document's embedded definition, when it has one */
  embedded: ThemeDef | undefined;
  library: readonly ThemeDef[];
  onUse: (def: ThemeDef) => void;
  onSaveToLibrary: (def: ThemeDef) => Promise<boolean>;
  onRemoveFromLibrary: (name: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [tokens, setTokens] = useState('');

  const start = (): Draft => {
    const base = themeDefOfName(currentName, library, embedded) ?? themeDefOfName(DEFAULT_THEME_NAME, [], null);
    // A built-in cannot be saved under its own name; propose a copy's.
    const proposed = base && base.name === currentName && !embedded && !library.some((t) => t.name === currentName)
      ? `${base.name}-custom`
      : (base?.name ?? 'my-theme');
    return draftOf({ ...(base as ThemeDef), name: proposed });
  };

  const toggle = () => {
    if (!open) setDraft(start());
    setMessage(null);
    setOpen(!open);
  };

  const set = (key: string, value: string) => setDraft((d) => (d ? { ...d, [key]: value } : d));

  const build = (): ThemeDef | null => {
    if (!draft) return null;
    const built = buildThemeDef(
      { name: draft.name.trim(), base: currentName, fields: fieldsOf(draft) },
      library,
      embedded,
    );
    if ('error' in built) {
      setMessage({ text: built.error, error: true });
      return null;
    }
    return built.def;
  };

  const applyTokens = () => {
    if (!draft) return;
    const parsed = themeDefFromTokens(tokens);
    const next: Draft = { ...draft };
    for (const [k, v] of Object.entries(parsed)) {
      if (k === 'fonts') next.fonts = fontsToText(v as ThemeFont[]);
      else if (k !== 'name') next[k] = String(v);
    }
    setDraft(next);
    setMessage({ text: `Read ${Object.keys(parsed).length} token(s).`, error: false });
  };

  const inLibrary = draft ? library.some((t) => t.name === draft.name.trim()) : false;

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="self-start rounded border border-border-color px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary"
        data-theme-editor-toggle
      >
        {open ? 'Close theme editor' : 'Edit theme…'}
      </button>
      {open && draft && (
        <InspectorSection label="Theme editor">
          <label className="flex items-center justify-between gap-2 text-[11px] text-text-secondary">
            Name
            <input
              className={`${input} w-40`}
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
              aria-label="Theme name"
            />
          </label>
          {THEME_COLOR_FIELDS.map((k) => (
            <label key={k} className="flex items-center justify-between gap-2 text-[11px] text-text-secondary">
              {FIELD_LABELS[k]}
              <span className="flex items-center gap-1">
                <input
                  type="color"
                  aria-label={FIELD_LABELS[k]}
                  className="h-6 w-6 cursor-pointer rounded border border-border-color bg-transparent p-0"
                  value={/^#[0-9a-fA-F]{6}$/.test(draft[k]) ? draft[k].toLowerCase() : '#000000'}
                  onChange={(e) => set(k, e.target.value)}
                />
                <input className={`${input} w-20 font-mono`} value={draft[k]} onChange={(e) => set(k, e.target.value)} />
              </span>
            </label>
          ))}
          {THEME_NUMBER_FIELDS.map((k) => (
            <label key={k} className="flex items-center justify-between gap-2 text-[11px] text-text-secondary">
              {FIELD_LABELS[k]}
              <input className={`${input} w-20`} value={draft[k]} onChange={(e) => set(k, e.target.value)} />
            </label>
          ))}
          {THEME_FONT_STACK_FIELDS.map((k) => (
            <label key={k} className="flex flex-col gap-1 text-[11px] text-text-secondary">
              {FIELD_LABELS[k]}
              <input className={input} value={draft[k]} onChange={(e) => set(k, e.target.value)} />
            </label>
          ))}
          <label className="flex flex-col gap-1 text-[11px] text-text-secondary">
            Google Fonts to download
            <input
              className={input}
              value={draft.fonts}
              placeholder="Newsreader:400,600 | Instrument Sans:400,500"
              onChange={(e) => set('fonts', e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-text-secondary">
            Fill from a token file (--apelles-theme-* properties)
            <textarea
              className={`${input} h-16 py-1 font-mono`}
              value={tokens}
              onChange={(e) => setTokens(e.target.value)}
              placeholder="--apelles-theme-bg: #1c1a17;"
            />
          </label>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className="rounded border border-border-color px-2 py-1 text-[11px]" onClick={applyTokens} disabled={!tokens.trim()}>
              Read tokens
            </button>
            <button
              type="button"
              className="rounded border border-border-color px-2 py-1 text-[11px]"
              data-theme-use
              onClick={() => {
                const def = build();
                if (!def) return;
                onUse(def);
                setMessage({ text: `${def.name} is now this project's theme (embedded in the manifest).`, error: false });
              }}
            >
              Use in this project
            </button>
            <button
              type="button"
              className="rounded border border-border-color px-2 py-1 text-[11px]"
              data-theme-save
              onClick={async () => {
                const def = build();
                if (!def) return;
                const ok = await onSaveToLibrary(def);
                if (ok) onUse(def);
                setMessage(
                  ok
                    ? { text: `${def.name} saved to the library and used in this project.`, error: false }
                    : { text: 'Could not write the theme library.', error: true },
                );
              }}
            >
              Save to library
            </button>
            {inLibrary && (
              <button
                type="button"
                className="rounded border border-border-color px-2 py-1 text-[11px] text-red-400"
                onClick={async () => {
                  const ok = await onRemoveFromLibrary(draft.name.trim());
                  setMessage(
                    ok
                      ? { text: 'Removed from the library (projects that use it keep their copy).', error: false }
                      : { text: 'Could not write the theme library.', error: true },
                  );
                }}
              >
                Remove from library
              </button>
            )}
          </div>
          {message && (
            <span className={`text-[10px] ${message.error ? 'text-red-400' : 'text-text-secondary'}`}>{message.text}</span>
          )}
        </InspectorSection>
      )}
    </div>
  );
}
