/**
 * @apelles/brand/ui — the Brand panel (D-416): the human half of the `brand_*`
 * tools.
 *
 * What it is: a dialog opened from the chrome bar (every tab), in two resizable
 * panes. Left: the project's active kit (its own copy, with "library has a newer
 * version" and Update), the user's library of kits, files that failed to load,
 * New kit. Right: the selected kit, section by section in the order the research
 * settled on (`scratch/brand-kit-reference/NOTES.md`): Identity, Colours (with
 * the WCAG contrast of every pair inline), Type (display/body/mono: Google,
 * system or a font file with its licence), Logos, Motion, Captions, Look, Sound,
 * References (image/video + a note on what to take from it). Footer: Save to
 * library, Use in this project, and Apply to the tabs (one undo step per tab).
 *
 * Every action calls the same function the matching op calls (`useBrandStore`,
 * `applyBrandKit`, `addReference`, `parseBrandKit`), so this panel and an agent
 * cannot do different things.
 *
 * What it does NOT do: hold any state beyond the draft being edited.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import {
  ArrowsClockwiseIcon,
  FilmStripIcon,
  PaletteIcon,
  PlusIcon,
  TrashIcon,
  UploadSimpleIcon,
  WarningIcon,
} from '@phosphor-icons/react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  Switch,
  Textarea,
} from '@apelles/ui';
import {
  BRAND_AUDIO_EXTENSIONS,
  BRAND_FONT_EXTENSIONS,
  BRAND_IMAGE_EXTENSIONS,
  BRAND_LUT_EXTENSIONS,
  BRAND_VIDEO_EXTENSIONS,
  COLOR_ROLES,
  EASE_PRESETS,
  ENTRANCES,
  assetExtension,
  parseBrandKit,
  starterKit,
  type BrandKit,
  type ColorRole,
  type FontRef,
} from '../kit';
import { checkKitContrast } from '../contrast';
import { addReference, assetPath } from '../references';
import { applyBrandKit, availableBrandTabs, BRAND_TABS, type BrandApplyOutcome, type BrandTab } from '../appliers';
import { brandAssetsDir, importBrandAsset, projectBrandAssetsDir, useBrandStore, type BrandAsset } from '../io';

/** The left (kit list) pane's sizes, px. */
const LIST_DEFAULT = 260;
const LIST_MIN = 200;
const LIST_MAX = 420;

const TAB_LABELS: Record<BrandTab, string> = { edit: 'Edit', motion: 'Motion', colorist: 'Colorist' };

type FileKind = 'image' | 'font' | 'lut' | 'audio' | 'reference';

const FILTERS: Record<FileKind, { name: string; extensions: string[] }> = {
  image: { name: 'Images', extensions: [...BRAND_IMAGE_EXTENSIONS] },
  font: { name: 'Fonts', extensions: [...BRAND_FONT_EXTENSIONS] },
  lut: { name: '3D LUTs', extensions: [...BRAND_LUT_EXTENSIONS] },
  audio: { name: 'Audio', extensions: [...BRAND_AUDIO_EXTENSIONS] },
  reference: { name: 'Images and videos', extensions: [...BRAND_IMAGE_EXTENSIONS, ...BRAND_VIDEO_EXTENSIONS] },
};

/** A native file dialog, then the import into the brand asset store. */
async function pickAsset(kind: FileKind): Promise<BrandAsset | null> {
  const picked = await open({ multiple: false, directory: false, filters: [FILTERS[kind]] });
  if (typeof picked !== 'string') return null;
  return importBrandAsset(picked);
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-t border-border-color pt-3 first:border-t-0 first:pt-0">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] items-center gap-2">
      <Label className="text-xs text-text-secondary">{label}</Label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A native `<select>` styled as the app's inputs: the option lists here are
 *  short, fixed enums. */
function Choice<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T | undefined;
  options: readonly T[];
  onChange: (v: T | undefined) => void;
  label: string;
}) {
  return (
    <select
      aria-label={label}
      className="h-7 w-full rounded-md border border-border-color bg-bg-primary px-2 text-xs text-text-primary"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? undefined : (e.target.value as T))}
    >
      <option value="">—</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

function ColorField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        aria-label={`${label} colour`}
        className="h-7 w-9 cursor-pointer rounded border border-border-color bg-transparent"
        value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000'}
        onChange={(e) => onChange(e.target.value)}
      />
      <Input className="h-7 font-mono text-xs" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function NumberField({
  value,
  onChange,
  label,
  step = 0.05,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  label: string;
  step?: number;
}) {
  return (
    <Input
      aria-label={label}
      type="number"
      step={step}
      className="h-7 text-xs"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
    />
  );
}

/** A thumbnail for an image asset in the library store. */
function AssetThumb({ dir, id }: { dir: string | null; id: string }) {
  if (!dir) return null;
  const ext = assetExtension(id);
  if ((BRAND_VIDEO_EXTENSIONS as readonly string[]).includes(ext)) {
    return (
      <div className="flex size-12 items-center justify-center rounded border border-border-color bg-bg-primary">
        <FilmStripIcon className="size-5 text-text-secondary" />
      </div>
    );
  }
  return (
    <img
      alt=""
      src={convertFileSrc(assetPath(dir, id))}
      className="size-12 rounded border border-border-color bg-bg-primary object-contain"
    />
  );
}

function FontEditor({
  font,
  optional,
  onChange,
  onError,
}: {
  font: FontRef | undefined;
  optional: boolean;
  onChange: (f: FontRef | undefined) => void;
  onError: (e: string) => void;
}) {
  if (!font) {
    return optional ? (
      <Button size="xs" variant="ghost" onClick={() => onChange({ family: 'IBM Plex Mono', source: 'google' })}>
        <PlusIcon className="size-3" /> Add
      </Button>
    ) : null;
  }
  const set = (patch: Partial<FontRef>) => onChange({ ...font, ...patch });
  return (
    <div className="space-y-1.5 rounded-md border border-border-color p-2">
      <div className="grid grid-cols-[1fr_96px] gap-2">
        <Input aria-label="family" className="h-7 text-xs" value={font.family} onChange={(e) => set({ family: e.target.value })} />
        <Choice
          label="source"
          value={font.source}
          options={['google', 'system', 'file'] as const}
          onChange={(v) => {
            if (!v) return;
            const next: FontRef = { ...font, source: v };
            if (v !== 'file') {
              delete next.file;
              delete next.licence;
            }
            onChange(next);
          }}
        />
      </div>
      {font.source === 'file' && (
        <>
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void pickAsset('font').then(
                  (a) => a && set({ file: a.id }),
                  (e: unknown) => onError(message(e)),
                )
              }
            >
              <UploadSimpleIcon className="size-3" /> {font.file ? 'Replace file' : 'Choose font file…'}
            </Button>
            {font.file && <span className="truncate font-mono text-[10px] text-text-secondary">{font.file.slice(7, 19)}….{assetExtension(font.file)}</span>}
          </div>
          <Input
            aria-label="licence"
            className="h-7 text-xs"
            placeholder="Licence: what it allows (required for a file you supply)"
            value={font.licence ?? ''}
            onChange={(e) => set({ licence: e.target.value || undefined })}
          />
        </>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Input
          aria-label="weights"
          className="h-7 text-xs"
          placeholder="Weights: 400, 700"
          value={(font.weights ?? []).join(', ')}
          onChange={(e) => {
            const weights = e.target.value.split(',').map((w) => w.trim()).filter(Boolean);
            set({ weights: weights.length ? weights : undefined });
          }}
        />
        <Input
          aria-label="Edit fallback"
          className="h-7 text-xs"
          placeholder="Edit font key (sans-bold)"
          title="The Edit tab draws text from one font file; for a Google or system face, the Edit catalogue key to use instead."
          value={font.editFallback ?? ''}
          onChange={(e) => set({ editFallback: e.target.value || undefined })}
        />
      </div>
      {optional && (
        <Button size="xs" variant="ghost" onClick={() => onChange(undefined)}>
          <TrashIcon className="size-3" /> Remove
        </Button>
      )}
    </div>
  );
}

export interface BrandKitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BrandKitDialog({ open: isOpen, onOpenChange }: BrandKitDialogProps) {
  const kits = useBrandStore((s) => s.kits);
  const loadErrors = useBrandStore((s) => s.loadErrors);
  const project = useBrandStore((s) => s.project);
  const storeError = useBrandStore((s) => s.error);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<BrandKit | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [libraryDir, setLibraryDir] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tabs, setTabs] = useState<BrandTab[]>([...BRAND_TABS]);
  const [restyle, setRestyle] = useState(false);
  const [results, setResults] = useState<Partial<Record<BrandTab, BrandApplyOutcome | undefined>> | null>(null);
  const [newRefNote, setNewRefNote] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    void useBrandStore.getState().reload();
    void useBrandStore
      .getState()
      .loadProject()
      .catch(() => undefined);
    brandAssetsDir().then(setLibraryDir, (e: unknown) => setError(message(e)));
  }, [isOpen]);

  const select = useCallback((kit: BrandKit) => {
    setSelectedId(kit.id);
    setDraft(structuredClone(kit));
    setIsNew(false);
    setStatus(null);
    setError(null);
    setResults(null);
  }, []);

  // Open on the project's kit (or the first one) when nothing is selected.
  useEffect(() => {
    if (!isOpen || selectedId || isNew) return;
    const first = (project && kits.find((k) => k.id === project.id)) ?? kits[0];
    if (first) select(first);
  }, [isOpen, kits, project, selectedId, isNew, select]);

  const parsed = useMemo(() => (draft ? parseBrandKit(draft) : null), [draft]);
  const contrast = useMemo(() => (draft ? checkKitContrast(draft.colors) : []), [draft]);
  const libraryVersion = project ? kits.find((k) => k.id === project.id)?.version : undefined;
  const available = availableBrandTabs();

  const update = (patch: (k: BrandKit) => BrandKit) => setDraft((d) => (d ? patch(d) : d));

  const newKit = () => {
    const taken = new Set(kits.map((k) => k.id));
    let id = 'my-brand';
    for (let n = 2; taken.has(id); n += 1) id = `my-brand-${n}`;
    setDraft(starterKit(id, 'My brand'));
    setSelectedId(null);
    setIsNew(true);
    setStatus(null);
    setResults(null);
  };

  const run = async (label: string, fn: () => Promise<string | void>) => {
    setError(null);
    setStatus(`${label}…`);
    try {
      const done = await fn();
      setStatus(done ?? `${label}: done`);
    } catch (e) {
      setStatus(null);
      setError(message(e));
    }
  };

  const save = () =>
    run('Saving', async () => {
      if (!parsed || 'error' in parsed) throw new Error(parsed && 'error' in parsed ? parsed.error : 'nothing to save');
      if (isNew && kits.some((k) => k.id === parsed.kit.id)) throw new Error(`a kit "${parsed.kit.id}" already exists`);
      const saved = await useBrandStore.getState().saveKit(parsed.kit);
      select(saved);
      return `Saved ${saved.name} v${saved.version}`;
    });

  const useInProject = (kit: BrandKit) =>
    run('Copying into the project', async () => {
      const report = await useBrandStore.getState().setProjectKit(kit);
      return `This project now uses ${kit.name} v${kit.version}${report ? ` (${report.copied} file(s) copied)` : ''}`;
    });

  const apply = () =>
    run('Applying', async () => {
      if (!project) throw new Error('set a kit for this project first');
      const assetsDir = await projectBrandAssetsDir();
      const out = await applyBrandKit(tabs, { kit: project, assetsDir, options: { restyleExisting: restyle, titles: true } });
      setResults(out);
      return `Applied ${project.name} v${project.version}`;
    });

  const kitRows = kits.map((k) => (
    <button
      key={k.id}
      type="button"
      onClick={() => select(k)}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${
        k.id === selectedId ? 'bg-bg-tertiary text-text-primary' : 'text-text-secondary hover:bg-bg-secondary'
      }`}
    >
      <span className="flex shrink-0 overflow-hidden rounded border border-border-color">
        {COLOR_ROLES.map((r) => (
          <span key={r} className="block h-4 w-2" style={{ background: k.colors[r] }} />
        ))}
      </span>
      <span className="min-w-0 flex-1 truncate">{k.name}</span>
      <span className="text-[10px]">v{k.version}</span>
    </button>
  ));

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] max-w-5xl flex-col sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PaletteIcon className="size-4" />
            Brand kit
          </DialogTitle>
        </DialogHeader>

        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1 rounded-md border border-border-color">
          <ResizablePanel defaultSize={LIST_DEFAULT} minSize={LIST_MIN} maxSize={LIST_MAX} className="flex min-h-0 flex-col">
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2">
              <div className="space-y-1">
                <div className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">This project</div>
                {project ? (
                  <div className="space-y-1 rounded-md border border-border-color p-2 text-xs">
                    <div className="text-text-primary">
                      {project.name} <span className="text-text-secondary">v{project.version}</span>
                    </div>
                    {libraryVersion !== undefined && libraryVersion > project.version && (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => {
                          const lib = kits.find((k) => k.id === project.id);
                          if (lib) void useInProject(lib);
                        }}
                      >
                        <ArrowsClockwiseIcon className="size-3" /> Update to v{libraryVersion}
                      </Button>
                    )}
                    <Button size="xs" variant="ghost" onClick={() => void run('Clearing', async () => { await useBrandStore.getState().setProjectKit(null); return 'This project has no brand kit'; })}>
                      Clear
                    </Button>
                  </div>
                ) : (
                  <div className="text-[11px] text-text-secondary">No brand kit. Pick one below and choose “Use in this project”.</div>
                )}
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">Library</span>
                  <Button size="xs" variant="ghost" onClick={newKit}>
                    <PlusIcon className="size-3" /> New kit
                  </Button>
                </div>
                {kitRows}
                {kits.length === 0 && <div className="text-[11px] text-text-secondary">No kits yet.</div>}
                {loadErrors.map((e) => (
                  <div key={e.file} className="flex gap-1 text-[11px] text-yellow-400" title={e.error}>
                    <WarningIcon className="size-3 shrink-0" />
                    <span className="truncate">
                      {e.file}: {e.error}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel className="flex min-h-0 flex-col">
            {draft ? (
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
                <Section title="Identity">
                  <Row label="Id">
                    <Input className="h-7 font-mono text-xs" value={draft.id} disabled={!isNew} onChange={(e) => update((k) => ({ ...k, id: e.target.value }))} />
                  </Row>
                  <Row label="Name">
                    <Input className="h-7 text-xs" value={draft.name} onChange={(e) => update((k) => ({ ...k, name: e.target.value }))} />
                  </Row>
                  <Row label="Description">
                    <Input className="h-7 text-xs" value={draft.description ?? ''} onChange={(e) => update((k) => ({ ...k, description: e.target.value || undefined }))} />
                  </Row>
                </Section>

                <Section title="Colours">
                  {COLOR_ROLES.map((role: ColorRole) => (
                    <Row key={role} label={role}>
                      <ColorField label={role} value={draft.colors[role]} onChange={(v) => update((k) => ({ ...k, colors: { ...k.colors, [role]: v } }))} />
                    </Row>
                  ))}
                  <div className="space-y-1">
                    {(draft.colors.palette ?? []).map((p, i) => (
                      <div key={i} className="grid grid-cols-[110px_1fr_auto] items-center gap-2">
                        <Input aria-label="palette name" className="h-7 text-xs" value={p.name} onChange={(e) => update((k) => ({ ...k, colors: { ...k.colors, palette: (k.colors.palette ?? []).map((q, j) => (j === i ? { ...q, name: e.target.value } : q)) } }))} />
                        <ColorField label={p.name} value={p.hex} onChange={(v) => update((k) => ({ ...k, colors: { ...k.colors, palette: (k.colors.palette ?? []).map((q, j) => (j === i ? { ...q, hex: v } : q)) } }))} />
                        <Button size="xs" variant="ghost" aria-label="Remove colour" onClick={() => update((k) => ({ ...k, colors: { ...k.colors, palette: (k.colors.palette ?? []).filter((_, j) => j !== i) } }))}>
                          <TrashIcon className="size-3" />
                        </Button>
                      </div>
                    ))}
                    <Button size="xs" variant="ghost" onClick={() => update((k) => ({ ...k, colors: { ...k.colors, palette: [...(k.colors.palette ?? []), { name: `colour ${(k.colors.palette ?? []).length + 1}`, hex: k.colors.accent }] } }))}>
                      <PlusIcon className="size-3" /> Palette colour
                    </Button>
                  </div>
                  <table className="w-full text-[11px]">
                    <tbody>
                      {contrast.map((c) => (
                        <tr key={c.pair} className="border-t border-border-color" title={c.use}>
                          <td className="py-1">
                            <span className="rounded px-1.5 py-0.5" style={{ color: c.foreground, background: c.background }}>
                              Aa
                            </span>{' '}
                            {c.pair}
                          </td>
                          <td className="text-right font-mono">{c.ratio}:1</td>
                          <td className={`w-20 text-right ${c.ok ? 'text-green-400' : 'text-yellow-400'}`}>{c.level}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Section>

                <Section title="Type">
                  {(['display', 'body', 'mono'] as const).map((role) => (
                    <Row key={role} label={role}>
                      <FontEditor
                        font={draft.typography[role]}
                        optional={role === 'mono'}
                        onError={setError}
                        onChange={(f) =>
                          update((k) => {
                            const typography = { ...k.typography };
                            if (role === 'mono') {
                              if (f) typography.mono = f;
                              else delete typography.mono;
                            } else if (f) typography[role] = f;
                            return { ...k, typography };
                          })
                        }
                      />
                    </Row>
                  ))}
                  <Row label="Scale">
                    <div className="grid grid-cols-4 gap-2">
                      <NumberField label="base px" step={1} value={draft.typography.scale?.base} onChange={(v) => update((k) => ({ ...k, typography: { ...k.typography, scale: { base: v ?? 32, ratio: k.typography.scale?.ratio ?? 1.25, displayWeight: k.typography.scale?.displayWeight ?? '700', bodyWeight: k.typography.scale?.bodyWeight ?? '400' } } }))} />
                      <NumberField label="ratio" value={draft.typography.scale?.ratio} onChange={(v) => update((k) => ({ ...k, typography: { ...k.typography, scale: { base: k.typography.scale?.base ?? 32, ratio: v ?? 1.25, displayWeight: k.typography.scale?.displayWeight ?? '700', bodyWeight: k.typography.scale?.bodyWeight ?? '400' } } }))} />
                      <Input aria-label="display weight" className="h-7 text-xs" placeholder="700" value={draft.typography.scale?.displayWeight ?? ''} onChange={(e) => update((k) => ({ ...k, typography: { ...k.typography, scale: { base: k.typography.scale?.base ?? 32, ratio: k.typography.scale?.ratio ?? 1.25, displayWeight: e.target.value, bodyWeight: k.typography.scale?.bodyWeight ?? '400' } } }))} />
                      <Input aria-label="body weight" className="h-7 text-xs" placeholder="400" value={draft.typography.scale?.bodyWeight ?? ''} onChange={(e) => update((k) => ({ ...k, typography: { ...k.typography, scale: { base: k.typography.scale?.base ?? 32, ratio: k.typography.scale?.ratio ?? 1.25, displayWeight: k.typography.scale?.displayWeight ?? '700', bodyWeight: e.target.value } } }))} />
                    </div>
                  </Row>
                </Section>

                <Section title="Logos">
                  {(['light', 'dark', 'mark'] as const).map((slot) => {
                    const id = draft.logos?.[slot];
                    return (
                      <Row key={slot} label={slot === 'light' ? 'On light' : slot === 'dark' ? 'On dark' : 'Mark'}>
                        <div className="flex items-center gap-2">
                          {id && <AssetThumb dir={libraryDir} id={id} />}
                          <Button size="xs" variant="outline" onClick={() => void pickAsset('image').then((a) => a && update((k) => ({ ...k, logos: { ...k.logos, [slot]: a.id } })), (e: unknown) => setError(message(e)))}>
                            <UploadSimpleIcon className="size-3" /> {id ? 'Replace' : 'Choose…'}
                          </Button>
                          {id && (
                            <Button size="xs" variant="ghost" aria-label="Remove logo" onClick={() => update((k) => { const logos = { ...k.logos }; delete logos[slot]; return { ...k, logos }; })}>
                              <TrashIcon className="size-3" />
                            </Button>
                          )}
                        </div>
                      </Row>
                    );
                  })}
                </Section>

                <Section title="Motion">
                  {draft.motion ? (
                    <>
                      <Row label="Ease">
                        <Choice label="ease" value={typeof draft.motion.ease === 'string' ? draft.motion.ease : undefined} options={EASE_PRESETS} onChange={(v) => v && update((k) => (k.motion ? { ...k, motion: { ...k.motion, ease: v } } : k))} />
                      </Row>
                      <Row label="Speed">
                        <NumberField label="speed" value={draft.motion.speed} onChange={(v) => update((k) => (k.motion ? { ...k, motion: { ...k.motion, speed: v ?? 1 } } : k))} />
                      </Row>
                      <Row label="Stagger (s)">
                        <NumberField label="stagger" step={0.01} value={draft.motion.stagger} onChange={(v) => update((k) => (k.motion ? { ...k, motion: { ...k.motion, stagger: v ?? 0 } } : k))} />
                      </Row>
                      <Row label="Entrance">
                        <Choice label="entrance" value={draft.motion.entrance} options={ENTRANCES} onChange={(v) => v && update((k) => (k.motion ? { ...k, motion: { ...k.motion, entrance: v } } : k))} />
                      </Row>
                      <p className="text-[11px] text-text-secondary">Defaults for new Motion layers and keyframes. Existing work changes only when you apply with “Restyle existing”.</p>
                    </>
                  ) : (
                    <Button size="xs" variant="ghost" onClick={() => update((k) => ({ ...k, motion: { ease: 'out', speed: 1, stagger: 0.08, entrance: 'rise' } }))}>
                      <PlusIcon className="size-3" /> Add motion style
                    </Button>
                  )}
                </Section>

                <Section title="Captions">
                  <Row label="Preset">
                    <Input className="h-7 font-mono text-xs" placeholder="plain-subtitle" value={draft.captions?.preset ?? ''} onChange={(e) => update((k) => (e.target.value ? { ...k, captions: { ...k.captions, preset: e.target.value } } : (() => { const n = { ...k }; delete n.captions; return n; })()))} />
                  </Row>
                  {draft.captions && (
                    <div className="grid grid-cols-3 gap-2">
                      <Choice label="caption font" value={draft.captions.font} options={['display', 'body'] as const} onChange={(v) => update((k) => (k.captions ? { ...k, captions: { ...k.captions, font: v } } : k))} />
                      <Choice label="caption colour" value={draft.captions.color} options={COLOR_ROLES} onChange={(v) => update((k) => (k.captions ? { ...k, captions: { ...k.captions, color: v } } : k))} />
                      <Choice label="caption box colour" value={draft.captions.boxColor} options={COLOR_ROLES} onChange={(v) => update((k) => (k.captions ? { ...k, captions: { ...k.captions, boxColor: v } } : k))} />
                    </div>
                  )}
                </Section>

                <Section title="Look (Colorist)">
                  {draft.look ? (
                    <>
                      <Row label="LUT">
                        <span className="font-mono text-[11px] text-text-secondary">{draft.look.lut.slice(7, 19)}….cube</span>
                      </Row>
                      <Row label="Name">
                        <Input className="h-7 text-xs" value={draft.look.name ?? ''} onChange={(e) => update((k) => (k.look ? { ...k, look: { ...k.look, name: e.target.value || undefined } } : k))} />
                      </Row>
                      <Row label="Intensity %">
                        <NumberField label="intensity" step={1} value={draft.look.intensity} onChange={(v) => update((k) => (k.look ? { ...k, look: { ...k.look, intensity: v ?? 100 } } : k))} />
                      </Row>
                      <Button size="xs" variant="ghost" onClick={() => update((k) => { const n = { ...k }; delete n.look; return n; })}>
                        <TrashIcon className="size-3" /> Remove look
                      </Button>
                    </>
                  ) : (
                    <Button size="xs" variant="outline" onClick={() => void pickAsset('lut').then((a) => a && update((k) => ({ ...k, look: { lut: a.id, intensity: 100, name: a.sourceName.replace(/\.cube$/i, '') } })), (e: unknown) => setError(message(e)))}>
                      <UploadSimpleIcon className="size-3" /> Choose a .cube LUT…
                    </Button>
                  )}
                </Section>

                <Section title="Sound">
                  <Row label="Sonic logo">
                    <div className="flex items-center gap-2">
                      <Button size="xs" variant="outline" onClick={() => void pickAsset('audio').then((a) => a && update((k) => ({ ...k, sound: { ...k.sound, sonicLogo: a.id } })), (e: unknown) => setError(message(e)))}>
                        <UploadSimpleIcon className="size-3" /> {draft.sound?.sonicLogo ? 'Replace' : 'Choose…'}
                      </Button>
                      {draft.sound?.sonicLogo && <span className="font-mono text-[10px] text-text-secondary">{draft.sound.sonicLogo.slice(7, 19)}…</span>}
                    </div>
                  </Row>
                  <Row label="Music mood">
                    <Input className="h-7 text-xs" placeholder="warm, unhurried, acoustic" value={draft.sound?.music?.mood ?? ''} onChange={(e) => update((k) => ({ ...k, sound: { ...k.sound, music: { ...k.sound?.music, mood: e.target.value || undefined } } }))} />
                  </Row>
                </Section>

                <Section title="References">
                  <p className="text-[11px] text-text-secondary">Your own work and other people’s, each with what to take from it. Agents read these before they design.</p>
                  {(draft.references ?? []).map((r, i) => (
                    <div key={r.id} className="flex gap-2 rounded-md border border-border-color p-2">
                      <AssetThumb dir={libraryDir} id={r.asset} />
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-xs text-text-primary">{r.name ?? r.id}</span>
                          <Choice label="kind" value={r.kind} options={['own-work', 'reference'] as const} onChange={(v) => v && update((k) => ({ ...k, references: (k.references ?? []).map((q, j) => (j === i ? { ...q, kind: v } : q)) }))} />
                        </div>
                        <Textarea aria-label="note" className="min-h-12 text-xs" value={r.note} onChange={(e) => update((k) => ({ ...k, references: (k.references ?? []).map((q, j) => (j === i ? { ...q, note: e.target.value } : q)) }))} />
                      </div>
                      <Button size="xs" variant="ghost" aria-label="Remove reference" onClick={() => update((k) => ({ ...k, references: (k.references ?? []).filter((_, j) => j !== i) }))}>
                        <TrashIcon className="size-3" />
                      </Button>
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <Input className="h-7 flex-1 text-xs" placeholder="Note: e.g. use the reference for type and hierarchy" value={newRefNote} onChange={(e) => setNewRefNote(e.target.value)} />
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!newRefNote.trim()}
                      onClick={() =>
                        void pickAsset('reference').then(
                          (a) => {
                            if (!a) return;
                            update((k) => addReference(k, { asset: a.id, note: newRefNote.trim(), kind: 'reference', name: a.sourceName }));
                            setNewRefNote('');
                          },
                          (e: unknown) => setError(message(e)),
                        )
                      }
                    >
                      <PlusIcon className="size-3" /> Add reference…
                    </Button>
                  </div>
                </Section>
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center text-xs text-text-secondary">Choose a kit, or make a new one.</div>
            )}
          </ResizablePanel>
        </ResizablePanelGroup>

        <div className="space-y-2">
          {parsed && 'error' in parsed && (
            <div className="max-h-16 overflow-y-auto text-[11px] text-yellow-400">
              {parsed.issues.map((i) => (
                <div key={`${i.path}:${i.message}`}>
                  {i.path}: {i.message}
                </div>
              ))}
            </div>
          )}
          {(error || storeError) && <div className="text-[11px] text-red-400">{error ?? storeError}</div>}
          {status && <div className="text-[11px] text-text-secondary">{status}</div>}
          {results && (
            <div className="text-[11px] text-text-secondary">
              {BRAND_TABS.filter((t) => results[t]).map((t) => {
                const r = results[t];
                return (
                  <div key={t}>
                    {TAB_LABELS[t]}: {r && r.ok ? r.summary : r ? r.error : ''}
                  </div>
                );
              })}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 border-t border-border-color pt-3">
            <Button size="sm" disabled={!parsed || 'error' in parsed} onClick={() => void save()}>
              Save to library
            </Button>
            {draft && !isNew && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const saved = kits.find((k) => k.id === draft.id);
                    if (saved) void useInProject(saved);
                  }}
                >
                  Use in this project
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void run('Deleting', async () => {
                      await useBrandStore.getState().deleteKit(draft.id);
                      setDraft(null);
                      setSelectedId(null);
                      return `Deleted ${draft.name} from the library (projects keep their copy)`;
                    })
                  }
                >
                  <TrashIcon className="size-3" /> Delete
                </Button>
              </>
            )}
            <div className="ml-auto flex items-center gap-3">
              {BRAND_TABS.map((t) => (
                <label key={t} className="flex items-center gap-1 text-xs text-text-secondary">
                  <input
                    type="checkbox"
                    disabled={!available.includes(t)}
                    checked={tabs.includes(t) && available.includes(t)}
                    onChange={(e) => setTabs((cur) => (e.target.checked ? [...cur, t] : cur.filter((x) => x !== t)))}
                  />
                  {TAB_LABELS[t]}
                </label>
              ))}
              <label className="flex items-center gap-1 text-xs text-text-secondary" title="Also give existing Motion layers the kit's entrance and existing keyframes its ease">
                <Switch checked={restyle} onCheckedChange={setRestyle} />
                Restyle existing
              </label>
              <Button size="sm" disabled={!project} onClick={() => void apply()}>
                Apply {project ? project.name : ''}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The chrome-bar opener plus its dialog. */
export function BrandKitButton() {
  const [isOpen, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        onClick={() => setOpen(true)}
        title="Brand kit"
        aria-label="Brand kit"
        className="h-6 w-6 p-0 text-text-secondary hover:text-text-primary"
      >
        <PaletteIcon className="size-3.5" />
      </Button>
      <BrandKitDialog open={isOpen} onOpenChange={setOpen} />
    </>
  );
}
