/**
 * @apelles/motion — the Catalog's Custom section (D-409): the human half of
 * `motion_write_component`, `motion_check_component`,
 * `motion_certify_component`, `motion_delete_component`, `motion_get_component`
 * and inserting a certified component (`motion_add_layer(use: "custom:<id>")`).
 *
 * What it is: one card per component id — drafts and certified versions, each
 * version's static-check warnings and certification result, its contact sheet,
 * a READ-ONLY source view, **Run check** (the proof renders), **Certify** (an
 * explicit step, enabled only once the check passed for the current source),
 * **Edit as new draft**, delete, and for a certified version an **Insert**
 * form generated from its declared props out of the Inspector's own field
 * controls. A **New component** form writes a draft (declaration + source).
 *
 * The shape follows the tools that do this (`scratch/custom-component-reference/`,
 * D-409): Framer's property controls and Remotion's schemas (one typed
 * declaration beside the code, a generated form for the user), After Effects'
 * Essential Graphics (a separate, explicit export/seal step with a poster frame:
 * our Certify and contact sheet), and a sealed template being edited back at its
 * source, never in place (our read-only certified source and "Edit as new draft").
 *
 * What it does NOT do: check, prove, certify or insert by itself. Every action
 * is `customComponentActions.ts`, the same functions the MCP ops call.
 *
 * Not `@apelles/ui`: the same `@react-three/fiber` JSX-typing conflict as the
 * rest of this package (see `Button.tsx`).
 */
import { useMemo, useState } from 'react';
import { CheckCircleIcon, PencilSimpleIcon, PlusIcon, PuzzlePieceIcon, SealCheckIcon, TrashIcon, WarningIcon } from '@phosphor-icons/react';
import type { ComponentSpec } from '@apelles/motion-engine/src/custom/componentDef';
import { resolveSlotValues, type TemplateSlot } from '@apelles/motion-engine/src/slots';
import type { ValidationIssue } from '@apelles/motion-engine/src/engine/validate';
import { FieldControl } from './InspectorPanel';
import { ListSlotControl, specForSlot } from './TemplatesSection';
import {
  certifyVersion,
  deleteVersion,
  runProof,
  writeDraft,
  type MotionComponentAccess,
} from './customComponentActions';
import type { ComponentLoadError, ListedComponent } from './customComponents';
import type { MotionRefusal } from './authoring';

const label = 'text-[10px] text-text-secondary';
const input =
  'w-full h-7 rounded border border-border-color bg-transparent px-1.5 text-[11px] text-text-primary focus:outline-none focus:border-accent';
const smallButton =
  'h-6 px-2 rounded border border-border-color text-[10px] text-text-secondary hover:text-text-primary hover:border-accent disabled:opacity-40 disabled:hover:text-text-secondary disabled:hover:border-border-color transition-colors flex items-center gap-1';
const errorBox = 'text-[10px] text-red-400 border border-red-500/40 rounded px-2 py-1 whitespace-pre-wrap';
const code = 'w-full rounded border border-border-color bg-transparent p-1.5 font-mono text-[10px] text-text-primary focus:outline-none focus:border-accent resize-y';

const STARTER_SOURCE = `import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import type { ComponentProps } from "@apelles/component";

type Props = { label: string; color?: string };

export default function MyComponent({ props, theme }: ComponentProps<Props>) {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity }}>
      <span style={{ color: props.color ?? theme.accent, fontFamily: theme.fontDisplay, fontSize: 96 }}>
        {props.label}
      </span>
    </AbsoluteFill>
  );
}
`;

const STARTER_PROPS = JSON.stringify(
  [
    { id: 'label', type: 'text', label: 'Label', default: 'Hello' },
    { id: 'color', type: 'color', label: 'Colour' },
  ],
  null,
  2,
);

function IssueList({ issues, tone = 'error' }: { issues: readonly ValidationIssue[]; tone?: 'error' | 'warning' }) {
  if (issues.length === 0) return null;
  return (
    <ul className={`flex flex-col gap-0.5 text-[10px] ${tone === 'error' ? 'text-red-400' : 'text-amber-400'}`}>
      {issues.map((i, k) => (
        <li key={`${i.path}-${k}`} className="font-mono break-words">
          {i.path ? `${i.path}: ` : ''}
          {i.message}
          {i.hint ? ` — ${i.hint}` : ''}
        </li>
      ))}
    </ul>
  );
}

/** The New-component / Edit-as-new-draft form. */
function AuthorForm({
  access,
  initial,
  onDone,
}: {
  access: MotionComponentAccess;
  initial: { spec: ComponentSpec; source: string } | null;
  onDone: () => void;
}) {
  const [id, setId] = useState(initial?.spec.id ?? '');
  const [name, setName] = useState(initial?.spec.name ?? '');
  const [description, setDescription] = useState(initial?.spec.description ?? '');
  const [tags, setTags] = useState((initial?.spec.tags ?? []).join(', '));
  const [w, setW] = useState(String(initial?.spec.size.w ?? 1920));
  const [h, setH] = useState(String(initial?.spec.size.h ?? 1080));
  const [duration, setDuration] = useState(String(initial?.spec.duration ?? 3));
  const [props, setProps] = useState(initial ? JSON.stringify(initial.spec.props, null, 2) : STARTER_PROPS);
  const [source, setSource] = useState(initial?.source ?? STARTER_SOURCE);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ error?: string; issues?: ValidationIssue[]; warnings?: ValidationIssue[]; saved?: string }>({});

  const submit = async (dryRun: boolean) => {
    let parsedProps: unknown;
    try {
      parsedProps = JSON.parse(props);
    } catch (e) {
      setResult({ error: `Props is not valid JSON: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    const spec = {
      id: id.trim(),
      name: name.trim() || id.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      tags: tags
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
      props: parsedProps,
      size: { w: Number(w), h: Number(h) },
      duration: Number(duration),
    } as ComponentSpec;
    setBusy(true);
    setResult({});
    try {
      const out = await writeDraft(access, spec, source, dryRun);
      if (!out.ok) setResult({ error: out.error, issues: out.issues });
      else if (dryRun) setResult({ warnings: out.result.check.warnings, saved: 'The source passes the static check.' });
      else
        setResult({
          warnings: out.result.check.warnings,
          saved: `Saved ${out.result.draft?.id}@${out.result.draft?.version} as a draft${out.result.draft?.replaced ? ' (replacing the open draft)' : ''}. Run its check next.`,
        });
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded border border-accent/60 p-2 flex flex-col gap-2">
      <p className="text-[11px] font-medium text-text-primary">{initial ? `New draft of ${initial.spec.id}` : 'New custom component'}</p>
      <div className="grid grid-cols-2 gap-1.5">
        <label className="flex flex-col gap-1">
          <span className={label}>Id</span>
          <input className={input} value={id} placeholder="particle-burst" disabled={initial !== null} onChange={(e) => setId(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={label}>Name</span>
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className={label}>Description</span>
        <input className={input} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="grid grid-cols-4 gap-1.5">
        <label className="flex flex-col gap-1 col-span-1">
          <span className={label}>Width</span>
          <input className={input} inputMode="numeric" value={w} onChange={(e) => setW(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 col-span-1">
          <span className={label}>Height</span>
          <input className={input} inputMode="numeric" value={h} onChange={(e) => setH(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 col-span-1">
          <span className={label}>Seconds</span>
          <input className={input} inputMode="decimal" value={duration} onChange={(e) => setDuration(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 col-span-1">
          <span className={label}>Tags</span>
          <input className={input} value={tags} placeholder="data, intro" onChange={(e) => setTags(e.target.value)} />
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className={label}>Props (slots: text, number, color, enum, list — a colour prop has no default, it reads the theme)</span>
        <textarea className={`${code} h-28`} spellCheck={false} value={props} onChange={(e) => setProps(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        <span className={label}>Source (TSX; default export receives {'{ props, theme, width, height, durationInFrames }'})</span>
        <textarea className={`${code} h-64`} spellCheck={false} value={source} onChange={(e) => setSource(e.target.value)} />
      </label>
      {result.error && <p className={errorBox} role="alert">{result.error}</p>}
      {result.issues && <IssueList issues={result.issues} />}
      {result.saved && <p className="text-[10px] text-text-secondary">{result.saved}</p>}
      {result.warnings && <IssueList issues={result.warnings} tone="warning" />}
      <div className="flex gap-1.5">
        <button type="button" className={smallButton} disabled={busy} onClick={() => void submit(true)}>
          {busy ? 'Checking…' : 'Check'}
        </button>
        <button type="button" className={`${smallButton} flex-1 justify-center`} disabled={busy || id.trim() === ''} onClick={() => void submit(false)}>
          Save draft
        </button>
        <button type="button" className={smallButton} onClick={onDone}>
          Close
        </button>
      </div>
    </div>
  );
}

/** The Insert form of a certified version, generated from its props. */
function InsertForm({
  entry,
  targetSceneId,
  onInsert,
  onDone,
}: {
  entry: ListedComponent;
  targetSceneId: string | null;
  onInsert: (use: string, props: Record<string, unknown>) => Promise<MotionRefusal | null>;
  onDone: () => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const live = useMemo(
    () => resolveSlotValues({ slots: entry.meta.props }, values, undefined, { root: ['props'], owner: 'a prop' }).issues,
    [entry, values],
  );
  const set = (pid: string, v: unknown) =>
    setValues((prev) => {
      const next = { ...prev };
      if (v === undefined || v === null || v === '') delete next[pid];
      else next[pid] = v;
      return next;
    });
  return (
    <div className="flex flex-col gap-2 pt-1">
      {entry.meta.props.map((slot: TemplateSlot) => (
        <div key={slot.id} className="flex flex-col gap-0.5">
          {slot.type === 'list' ? (
            <ListSlotControl slot={slot} value={values[slot.id] ?? slot.default} onCommit={(v) => set(slot.id, v)} />
          ) : (
            <FieldControl spec={specForSlot(slot)} value={values[slot.id] ?? slot.default} onCommit={(v) => set(slot.id, v)} />
          )}
          {slot.type === 'color' && values[slot.id] === undefined && (
            <span className="text-[9px] text-text-secondary/70">unset: follows the theme</span>
          )}
          {live
            .filter((i) => i.path === `props.${slot.id}` || i.path.startsWith(`props.${slot.id}[`))
            .map((i) => (
              <span key={i.path} className="text-[10px] text-red-400">
                {i.message}
              </span>
            ))}
        </div>
      ))}
      {refusal && <p className={errorBox} role="alert">{refusal}</p>}
      <div className="flex gap-1.5">
        <button
          type="button"
          className={`${smallButton} flex-1 justify-center`}
          disabled={live.length > 0 || targetSceneId === null}
          onClick={() => {
            setRefusal(null);
            void onInsert(`custom:${entry.id}@${entry.version}`, values).then((r) => (r ? setRefusal(r.error) : onDone()));
          }}
        >
          Insert into {targetSceneId ?? '—'}
        </button>
        <button type="button" className={smallButton} onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** One version's details and actions. */
function VersionPanel({
  entry,
  access,
  toSrc,
  targetSceneId,
  onInsert,
  onEdit,
}: {
  entry: ListedComponent;
  access: MotionComponentAccess;
  toSrc: (path: string) => string;
  targetSceneId: string | null;
  onInsert: (use: string, props: Record<string, unknown>) => Promise<MotionRefusal | null>;
  onEdit: (spec: ComponentSpec, source: string) => void;
}) {
  const [busy, setBusy] = useState<'check' | 'certify' | 'source' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [inserting, setInserting] = useState(false);
  const meta = entry.meta;
  const proof = meta.proof;
  const certifiable =
    meta.status === 'draft' && proof?.ok === true && proof.sourceHash === meta.sourceHash && proof.codeHash === meta.codeHash;

  const loadSource = async (): Promise<string | null> => {
    if (source !== null) return source;
    setBusy('source');
    try {
      const files = await access.read(entry.id, entry.version);
      setSource(files.source);
      return files.source;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      {meta.description && <p className="text-[10px] text-text-secondary leading-snug">{meta.description}</p>}
      <p className="text-[9px] font-mono text-text-secondary/70 break-all">
        {meta.size.w}×{meta.size.h} · {meta.duration}s · source {meta.sourceHash.slice(0, 12)}… · module {meta.codeHash.slice(0, 12)}…
      </p>
      {meta.warnings && meta.warnings.length > 0 && <IssueList issues={meta.warnings} tone="warning" />}
      {proof ? (
        <div className={`text-[10px] flex items-center gap-1 ${proof.ok ? 'text-text-secondary' : 'text-red-400'}`}>
          {proof.ok ? <CheckCircleIcon size={12} /> : <WarningIcon size={12} />}
          {proof.ok
            ? `Check passed: ${proof.frames.length} frames identical across ${proof.passes.length} passes (in order, backwards, scrambled).`
            : proof.error ?? `Check failed: ${proof.frames.filter((f) => !f.same).length} frame(s) differ between passes.`}
        </div>
      ) : (
        <p className="text-[10px] text-text-secondary">Not checked yet.</p>
      )}
      {proof?.contactSheet && (
        <img
          src={toSrc(`${entry.dir}/${proof.contactSheet}`)}
          alt={`Certification contact sheet of ${entry.id}@${entry.version}`}
          className="w-full rounded border border-border-color"
        />
      )}
      {error && <p className={errorBox} role="alert">{error}</p>}
      {source !== null && (
        <textarea className={`${code} h-48`} readOnly spellCheck={false} value={source} aria-label="Component source (read-only)" />
      )}
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          className={smallButton}
          disabled={busy !== null}
          title="Render the sample frames three ways and require identical pixels"
          onClick={() => {
            setBusy('check');
            setError(null);
            void runProof(access, entry.id, entry.version)
              .then((r) => {
                if (!r.ok) setError(r.error);
              })
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
              .finally(() => setBusy(null));
          }}
        >
          {busy === 'check' ? 'Rendering check…' : 'Run check'}
        </button>
        {meta.status === 'draft' && (
          <button
            type="button"
            className={smallButton}
            disabled={!certifiable || busy !== null}
            title={certifiable ? 'Seal this version: immutable, usable as data' : 'Run the check first; it must pass for this exact source'}
            onClick={() => {
              setBusy('certify');
              setError(null);
              void certifyVersion(access, entry.id, entry.version)
                .then((r) => {
                  if (!r.ok) setError(r.error);
                })
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                .finally(() => setBusy(null));
            }}
          >
            <SealCheckIcon size={11} /> Certify
          </button>
        )}
        <button type="button" className={smallButton} disabled={busy !== null} onClick={() => (source === null ? void loadSource() : setSource(null))}>
          {source === null ? 'View source' : 'Hide source'}
        </button>
        {entry.source === 'library' && (
          <button
            type="button"
            className={smallButton}
            disabled={busy !== null}
            onClick={() =>
              void loadSource().then((s) => {
                if (s !== null)
                  onEdit(
                    { id: meta.id, name: meta.name, description: meta.description, tags: meta.tags, props: meta.props, size: meta.size, duration: meta.duration },
                    s,
                  );
              })
            }
          >
            <PencilSimpleIcon size={11} /> Edit as new draft
          </button>
        )}
      </div>
      {meta.status === 'certified' &&
        (inserting ? (
          <InsertForm entry={entry} targetSceneId={targetSceneId} onInsert={onInsert} onDone={() => setInserting(false)} />
        ) : (
          <button
            type="button"
            disabled={targetSceneId === null}
            className="h-6 rounded border border-dashed border-border-color text-[10px] text-text-secondary hover:text-text-primary hover:border-accent disabled:opacity-40 transition-colors"
            onClick={() => setInserting(true)}
          >
            Insert…
          </button>
        ))}
    </div>
  );
}

export interface CustomComponentsSectionProps {
  entries: readonly ListedComponent[];
  loadErrors: readonly ComponentLoadError[];
  libraryError: string | null;
  targetSceneId: string | null;
  access: MotionComponentAccess;
  /** a library file path → a webview URL (contact sheets) */
  toSrc: (path: string) => string;
  onInsert: (use: string, props: Record<string, unknown>) => Promise<MotionRefusal | null>;
}

export function CustomComponentsSection(p: CustomComponentsSectionProps) {
  const [author, setAuthor] = useState<{ spec: ComponentSpec; source: string } | null | 'new'>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const byId = useMemo(() => {
    const m = new Map<string, ListedComponent[]>();
    for (const e of p.entries) m.set(e.id, [...(m.get(e.id) ?? []), e]);
    return [...m.entries()];
  }, [p.entries]);

  return (
    <>
      <div className="flex items-center justify-between px-0.5">
        <p className="text-[10px] uppercase tracking-wide text-text-secondary/60">Custom</p>
        <button type="button" className={smallButton} onClick={() => setAuthor('new')} title="Write a custom Remotion component">
          <PlusIcon size={11} /> New component
        </button>
      </div>
      {author !== null && (
        <AuthorForm key={author === 'new' ? 'new' : author.spec.id} access={p.access} initial={author === 'new' ? null : author} onDone={() => setAuthor(null)} />
      )}
      {p.libraryError && <p className={errorBox}>Components: {p.libraryError}</p>}
      {error && <p className={errorBox}>{error}</p>}
      {p.loadErrors.length > 0 && (
        <p className={errorBox}>
          {p.loadErrors.length === 1 ? 'A component could not be loaded' : `${p.loadErrors.length} components could not be loaded`}:
          {'\n'}
          {p.loadErrors.map((e) => `${e.path}: ${e.error}`).join('\n')}
        </p>
      )}
      {byId.length === 0 && <p className="text-[10px] text-text-secondary px-0.5">No custom components yet.</p>}
      {byId.map(([id, versions]) => {
        const latest = versions[versions.length - 1];
        const certified = versions.filter((v) => v.meta.status === 'certified');
        const shownVersion = picked[id] ?? latest.version;
        const shown = versions.find((v) => v.version === shownVersion) ?? latest;
        return (
          <div key={id} className="group rounded border border-border-color p-2 flex flex-col gap-1 hover:border-accent/60 transition-colors">
            <div className="flex items-start gap-2">
              <span className="shrink-0 text-text-secondary group-hover:text-accent transition-colors">
                <PuzzlePieceIcon size={20} />
              </span>
              <button type="button" className="min-w-0 flex-1 flex flex-col gap-0.5 text-left" onClick={() => setOpen(open === id ? null : id)}>
                <span className="text-[11px] font-medium text-text-primary leading-tight">{latest.meta.name}</span>
                <span className="text-[10px] text-text-secondary/70 font-mono leading-tight">
                  {id} · {latest.source === 'builtin' ? 'built-in · ' : ''}
                  {certified.length > 0 ? `v${certified[certified.length - 1].version} certified` : 'no certified version'}
                  {latest.meta.status === 'draft' ? ` · v${latest.version} draft` : ''}
                </span>
              </button>
              {latest.source === 'library' && (
                <button
                  type="button"
                  title={`Delete ${id}@${shown.version}`}
                  aria-label={`Delete component ${id} version ${shown.version}`}
                  onClick={() =>
                    void deleteVersion(p.access, id, shown.version).then((r) => setError(r.ok ? null : r.error))
                  }
                  className="shrink-0 h-5 px-1 flex items-center rounded text-red-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-red-500/15 transition-colors"
                >
                  <TrashIcon size={11} />
                </button>
              )}
            </div>
            {open === id && (
              <>
                {versions.length > 1 && (
                  <div className="flex flex-wrap gap-1" role="group" aria-label={`Versions of ${id}`}>
                    {versions.map((v) => (
                      <button
                        key={v.version}
                        type="button"
                        aria-pressed={v.version === shown.version}
                        onClick={() => setPicked((prev) => ({ ...prev, [id]: v.version }))}
                        className={`h-5 px-1.5 rounded-full border text-[9px] transition-colors ${
                          v.version === shown.version ? 'border-accent text-text-primary' : 'border-border-color text-text-secondary hover:text-text-primary'
                        }`}
                      >
                        v{v.version} {v.meta.status}
                      </button>
                    ))}
                  </div>
                )}
                <VersionPanel
                  key={`${id}@${shown.version}`}
                  entry={shown}
                  access={p.access}
                  toSrc={p.toSrc}
                  targetSceneId={p.targetSceneId}
                  onInsert={p.onInsert}
                  onEdit={(spec, source) => setAuthor({ spec, source })}
                />
              </>
            )}
          </div>
        );
      })}
    </>
  );
}
