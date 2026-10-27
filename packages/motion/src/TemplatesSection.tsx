/**
 * @apelles/motion — the Catalog's Templates section (D-407): the human half
 * of `motion_list_templates`, `motion_instantiate_template`,
 * `motion_save_template` and `motion_delete_template`.
 *
 * What it is: the built-in starters and the user's library, filterable by tag;
 * per template a **Fill & insert** form generated from its slots, built from
 * the Inspector's own field controls (`FieldControl`: text, number, colour,
 * the asset picker for an image slot, the icon picker for an icon slot, a
 * select for an enum) plus a one-item-per-line box for a list, with the slot
 * checks shown live under each field and a **Preview** still rendered through
 * the real engine; and the **Save scene as template** form, opened from a
 * scene row, which lists every content/look field of the scene with an
 * "expose" checkbox and a label.
 *
 * Why the save form is a list of fields to expose, and not a "make slot"
 * toggle beside every Inspector field (the note's first proposal): the tools
 * that do this well put the choice in ONE place — After Effects' Essential
 * Graphics panel (properties are dragged into it and renamed there), Figma's
 * component Properties section (each property is created there with a name
 * and a default), Canva's "Connect data" per element — and show the filler a
 * single generated form. A per-field toggle would spread template authoring
 * across every selection of the Inspector; this keeps it in one form covering
 * the whole scene, group children included (`scratch/template-fields-reference/`,
 * D-407).
 *
 * What it does NOT do: instantiate, save or validate anything itself. Every
 * action is a callback `MotionTab.tsx` implements with the SAME pure functions
 * the ops call (`templates.ts`'s `planInstantiate`, `templateFromSource`;
 * `templateLibrary.ts`'s `versionForSave`), so a value the tool refuses is
 * refused here with the same issue.
 *
 * Not `@apelles/ui`: the same `@react-three/fiber` JSX-typing conflict as the
 * rest of this package (see `Button.tsx`).
 */
import { useMemo, useState } from 'react';
import { TrashIcon } from '@phosphor-icons/react';
import {
  resolveSlotValues,
  type MotionTemplate,
  type TemplateSlot,
} from '@apelles/motion-engine/src/templateDef';
import type { ValidationIssue } from '@apelles/motion-engine/src/engine/validate';
import { FieldControl } from './InspectorPanel';
import type { FieldSpec } from './propCatalog';
import type { ListedTemplate, TemplateLoadError } from './templateLibrary';
import { slotIdFor, type ExposableField, type SlotSource, type TemplateSpec } from './templates';
import type { MotionRefusal } from './authoring';

const label = 'text-[10px] text-text-secondary';
const input =
  'w-full h-7 rounded border border-border-color bg-transparent px-1.5 text-[11px] text-text-primary focus:outline-none focus:border-accent';
const smallButton =
  'h-6 px-2 rounded border border-border-color text-[10px] text-text-secondary hover:text-text-primary hover:border-accent disabled:opacity-40 disabled:hover:text-text-secondary disabled:hover:border-border-color transition-colors';
const errorBox = 'text-[10px] text-red-400 border border-red-500/40 rounded px-2 py-1 whitespace-pre-wrap';

/** The Inspector control a slot is edited with. */
function specForSlot(slot: TemplateSlot): FieldSpec {
  const kind: FieldSpec['kind'] =
    slot.type === 'text'
      ? 'string'
      : slot.type === 'image'
        ? 'asset'
        : slot.type === 'enum'
          ? 'select'
          : slot.type === 'list'
            ? 'json'
            : slot.type;
  return {
    key: slot.id,
    label: `${slot.label}${slot.required ? ' *' : ''}`,
    kind,
    group: 'content',
    ...(slot.constraints?.options ? { options: slot.constraints.options } : {}),
  };
}

/** A list slot: one item per line (numbers parsed for a number list). */
function ListSlotControl({ slot, value, onCommit }: { slot: TemplateSlot; value: unknown; onCommit: (v: unknown) => void }) {
  const text = Array.isArray(value) ? value.join('\n') : '';
  const numeric = slot.constraints?.itemType === 'number';
  return (
    <div className="flex flex-col gap-1">
      <span className={label}>{`${slot.label}${slot.required ? ' *' : ''} (one per line)`}</span>
      <textarea
        className={`${input} h-16 py-1 resize-y`}
        value={text}
        onChange={(e) => {
          const lines = e.target.value.split('\n');
          onCommit(numeric ? lines.filter((l) => l.trim() !== '').map((l) => Number(l)) : lines);
        }}
      />
    </div>
  );
}

/** the issues whose path is `values.<id>` or inside it */
function issuesFor(issues: readonly ValidationIssue[], id: string): ValidationIssue[] {
  return issues.filter((i) => i.path === `values.${id}` || i.path.startsWith(`values.${id}[`));
}

/** The slot values a form starts from: each slot's default. */
function initialValues(t: MotionTemplate): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of t.slots) if (s.default !== undefined) out[s.id] = s.default;
  return out;
}

function TemplateFillForm({
  template,
  targetSceneId,
  onInsert,
  onPreview,
  onDone,
}: {
  template: MotionTemplate;
  targetSceneId: string | null;
  onInsert: (values: Record<string, unknown>, applyTheme: boolean) => Promise<MotionRefusal | null>;
  onPreview: (values: Record<string, unknown>) => Promise<{ src: string } | { error: string }>;
  onDone: () => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues(template));
  const [applyTheme, setApplyTheme] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ busy: boolean; src?: string; error?: string }>({ busy: false });
  // Live checks without the icon library (the insert re-checks with it).
  const live = useMemo(() => resolveSlotValues(template, values).issues, [template, values]);

  const set = (id: string, v: unknown) =>
    // A cleared control commits `undefined`; that means "no value" here, so it
    // is sent as `null` (which also overrides a default), never dropped.
    setValues((prev) => ({ ...prev, [id]: v === undefined ? null : v }));

  const where = template.kind === 'scene' ? `as a new scene after ${targetSceneId ?? 'the last scene'}` : `into ${targetSceneId ?? '—'}`;

  return (
    <div className="flex flex-col gap-2 pt-1">
      {template.slots.map((slot) => (
        <div key={slot.id} className="flex flex-col gap-0.5">
          {slot.type === 'list' ? (
            <ListSlotControl slot={slot} value={values[slot.id]} onCommit={(v) => set(slot.id, v)} />
          ) : (
            <FieldControl spec={specForSlot(slot)} value={values[slot.id] ?? undefined} onCommit={(v) => set(slot.id, v)} />
          )}
          {slot.description && <span className="text-[9px] text-text-secondary/70">{slot.description}</span>}
          {issuesFor(live, slot.id).map((i) => (
            <span key={i.path} className="text-[10px] text-red-400">
              {i.message}
              {i.hint ? ` (${i.hint})` : ''}
            </span>
          ))}
        </div>
      ))}
      {template.themeDef && (
        <label className="flex items-center gap-2 text-[10px] text-text-secondary">
          <input type="checkbox" checked={applyTheme} onChange={(e) => setApplyTheme(e.target.checked)} className="accent-accent" />
          Also use its theme ({template.themeDef.name}) for this project
        </label>
      )}
      {preview.src && <img src={preview.src} alt={`Preview of ${template.name}`} className="w-full rounded border border-border-color" />}
      {preview.error && <p className={errorBox}>{preview.error}</p>}
      {refusal && <p className={errorBox} role="alert">{refusal}</p>}
      <div className="flex gap-1.5">
        <button
          type="button"
          className={smallButton}
          disabled={preview.busy || live.length > 0}
          title="Render one still of the result through the real engine"
          onClick={() => {
            setPreview({ busy: true });
            void onPreview(values).then((r) => setPreview('src' in r ? { busy: false, src: r.src } : { busy: false, error: r.error }));
          }}
        >
          {preview.busy ? 'Rendering…' : 'Preview'}
        </button>
        <button
          type="button"
          className={`${smallButton} flex-1`}
          disabled={live.length > 0 || targetSceneId === null}
          title={`Insert ${where}`}
          onClick={() => {
            setRefusal(null);
            void onInsert(values, applyTheme).then((r) => (r ? setRefusal(r.error) : onDone()));
          }}
        >
          Insert {where}
        </button>
        <button type="button" className={smallButton} onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** One row of the Save-as-template field list. */
interface ExposeRow {
  field: ExposableField;
  expose: boolean;
  label: string;
}

function SaveTemplateForm({
  sceneId,
  fields,
  onSave,
  onCancel,
}: {
  sceneId: string;
  fields: readonly ExposableField[];
  onSave: (spec: TemplateSpec) => Promise<MotionRefusal | null>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(sceneId);
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [rows, setRows] = useState<ExposeRow[]>(() => fields.map((field) => ({ field, expose: false, label: field.label })));
  const [result, setResult] = useState<{ error?: string; saved?: boolean }>({});

  const exposed = rows.filter((r) => r.expose);
  const save = () => {
    const taken = new Set<string>();
    const slots: SlotSource[] = exposed.map((r) => {
      const id = slotIdFor(r.label, taken);
      taken.add(id);
      return {
        id,
        type: r.field.type,
        path: r.field.path,
        label: r.label,
        ...(r.field.type === 'enum' && r.field.options ? { constraints: { options: r.field.options } } : {}),
      };
    });
    const spec: TemplateSpec = {
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      tags: tags
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
      slots,
    };
    setResult({});
    void onSave(spec).then((r) => setResult(r ? { error: r.error } : { saved: true }));
  };

  return (
    <div className="rounded border border-accent/60 p-2 flex flex-col gap-2">
      <p className="text-[11px] font-medium text-text-primary">Save scene “{sceneId}” as a template</p>
      <label className="flex flex-col gap-1">
        <span className={label}>Name</span>
        <input className={input} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        <span className={label}>Description</span>
        <input className={input} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        <span className={label}>Tags (comma separated)</span>
        <input className={input} value={tags} placeholder="brand, intro" onChange={(e) => setTags(e.target.value)} />
      </label>
      <div className="flex flex-col gap-1">
        <span className={label}>Fields to expose ({exposed.length}) — the current value becomes the default</span>
        <div className="max-h-64 overflow-y-auto flex flex-col gap-1 rounded border border-border-color p-1.5">
          {rows.length === 0 && <span className="text-[10px] text-text-secondary">This scene has no fields to expose.</span>}
          {rows.map((r, i) => (
            <div key={r.field.path} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                className="accent-accent shrink-0"
                checked={r.expose}
                aria-label={`Expose ${r.field.path}`}
                onChange={(e) => setRows((prev) => prev.map((x, k) => (k === i ? { ...x, expose: e.target.checked } : x)))}
              />
              <span className="w-20 shrink-0 truncate text-[10px] text-text-secondary" title={`${r.field.layer} · ${r.field.path}`}>
                {r.field.layer}
              </span>
              <input
                className={`${input} h-6 min-w-0 flex-1`}
                value={r.label}
                aria-label={`Label for ${r.field.path}`}
                onChange={(e) => setRows((prev) => prev.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))}
              />
              <span className="shrink-0 font-mono text-[9px] text-text-secondary/70">{r.field.type}</span>
            </div>
          ))}
        </div>
      </div>
      {result.error && <p className={errorBox} role="alert">{result.error}</p>}
      {result.saved && <p className="text-[10px] text-text-secondary">Saved to your template library.</p>}
      <div className="flex gap-1.5">
        <button type="button" className={`${smallButton} flex-1`} disabled={name.trim() === ''} onClick={save}>
          Save template
        </button>
        <button type="button" className={smallButton} onClick={onCancel}>
          {result.saved ? 'Close' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}

export interface TemplatesSectionProps {
  templates: readonly ListedTemplate[];
  tags: readonly string[];
  loadErrors: readonly TemplateLoadError[];
  libraryError: string | null;
  targetSceneId: string | null;
  onInsert: (id: string, values: Record<string, unknown>, applyTheme: boolean) => Promise<MotionRefusal | null>;
  onPreview: (id: string, values: Record<string, unknown>) => Promise<{ src: string } | { error: string }>;
  onDelete: (id: string) => void;
  /** the open Save-as-template request, from a scene row */
  saveRequest: { sceneIndex: number; sceneId: string; fields: readonly ExposableField[] } | null;
  onSave: (spec: TemplateSpec) => Promise<MotionRefusal | null>;
  onCancelSave: () => void;
}

export function TemplatesSection(p: TemplatesSectionProps) {
  const [tag, setTag] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const shown = tag ? p.templates.filter((e) => e.template.tags?.includes(tag)) : p.templates;

  return (
    <>
      <p className="text-[10px] uppercase tracking-wide text-text-secondary/60 px-0.5">Templates</p>
      {p.saveRequest && (
        <SaveTemplateForm
          key={p.saveRequest.sceneIndex}
          sceneId={p.saveRequest.sceneId}
          fields={p.saveRequest.fields}
          onSave={p.onSave}
          onCancel={p.onCancelSave}
        />
      )}
      {p.libraryError && <p className={errorBox}>Templates: {p.libraryError}</p>}
      {p.loadErrors.length > 0 && (
        <p className={errorBox}>
          {p.loadErrors.length === 1 ? 'A template file could not be loaded' : `${p.loadErrors.length} template files could not be loaded`}:
          {'\n'}
          {p.loadErrors.map((e) => `${e.file}: ${e.error}`).join('\n')}
        </p>
      )}
      {p.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 px-0.5" role="group" aria-label="Filter templates by tag">
          {p.tags.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={tag === t}
              onClick={() => setTag(tag === t ? null : t)}
              className={`h-5 px-1.5 rounded-full border text-[9px] transition-colors ${
                tag === t ? 'border-accent text-text-primary' : 'border-border-color text-text-secondary hover:text-text-primary'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      )}
      {shown.map(({ template: t, source }) => (
        <div key={t.id} className="group rounded border border-border-color p-2 flex flex-col gap-1 hover:border-accent/60 transition-colors">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1 flex flex-col gap-0.5">
              <span className="text-[11px] font-medium text-text-primary leading-tight">{t.name}</span>
              <span className="text-[10px] text-text-secondary/70 font-mono leading-tight">
                {t.kind} · {source === 'builtin' ? 'built-in' : `v${t.version}`}
                {t.tags && t.tags.length > 0 ? ` · ${t.tags.join(', ')}` : ''}
              </span>
            </div>
            {source === 'library' && (
              <button
                type="button"
                title={`Delete the "${t.name}" template`}
                aria-label={`Delete template ${t.name}`}
                onClick={() => p.onDelete(t.id)}
                className="shrink-0 h-5 px-1 flex items-center rounded text-red-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-red-500/15 transition-colors"
              >
                <TrashIcon size={11} />
              </button>
            )}
          </div>
          {t.description && <p className="text-[10px] text-text-secondary leading-snug">{t.description}</p>}
          {open === t.id ? (
            <TemplateFillForm
              template={t}
              targetSceneId={p.targetSceneId}
              onInsert={(values, applyTheme) => p.onInsert(t.id, values, applyTheme)}
              onPreview={(values) => p.onPreview(t.id, values)}
              onDone={() => setOpen(null)}
            />
          ) : (
            <button
              type="button"
              disabled={p.targetSceneId === null}
              className="h-6 rounded border border-dashed border-border-color text-[10px] text-text-secondary hover:text-text-primary hover:border-accent disabled:opacity-40 transition-colors"
              onClick={() => setOpen(t.id)}
            >
              Fill &amp; insert…
            </button>
          )}
        </div>
      ))}
      {shown.length === 0 && <p className="text-[10px] text-text-secondary px-0.5">No template has this tag.</p>}
    </>
  );
}
