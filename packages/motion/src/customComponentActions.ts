/**
 * @apelles/motion — the custom-component ACTIONS (D-409): write a draft, run
 * the certification check, certify, delete, and put a certified component into
 * a document. The one implementation both interfaces call — `motionOps.ts`'s
 * `motion_*_component` tools and the Catalog's Custom section
 * (`CustomComponentsSection.tsx`, through `MotionTab.tsx`) — so a component the
 * tool refuses is refused in the GUI with the same issues.
 *
 * What it is: async functions over a `MotionComponentAccess` (the library and
 * the backend, injected so this stays Tauri-free and testable) and the pure
 * helpers in `customComponents.ts`.
 *
 * What it does NOT do: commit a manifest (callers do, through their own commit
 * path), or run component code (the backend renders in the renderer process).
 */
import type { ComponentSpec } from '@apelles/motion-engine/src/custom/componentDef';
import { componentRefKey } from '@apelles/motion-engine/src/custom/componentDef';
import type { Manifest } from '@apelles/motion-engine/src/engine/schema';
import { resolveSlotValues } from '@apelles/motion-engine/src/slots';
import type { ValidationIssue } from '@apelles/motion-engine/src/engine/validate';
import {
  addCustomLayer,
  checkSpec,
  componentRefFrom,
  customLayerJsonSchema,
  embedComponents,
  findComponent,
  latestCertified,
  missingComponents,
  parseComponentRef,
  parseCustomUse,
  proofPlan,
  proofRefFrom,
  specRefusal,
  type ComponentLoadError,
  type ListedComponent,
  type ProofPlan,
} from './customComponents';
import type {
  ComponentInstallResult,
  ComponentProofResult,
  ComponentWriteResult,
} from './customComponentLibraryIO';
import type { ComponentRef } from '@apelles/motion-engine/src/custom/componentDef';

/** The ops' and the GUI's window onto the library and the backend. */
export interface MotionComponentAccess {
  /** the CURRENT library (built-ins and the user's), read fresh per call */
  list: () => ListedComponent[];
  loadErrors: () => ComponentLoadError[];
  /** re-read the library after a write */
  reload: () => Promise<void>;
  read: (id: string, version: number) => Promise<{ dir: string; meta: unknown; source: string }>;
  write: (spec: ComponentSpec, source: string, dryRun: boolean) => Promise<ComponentWriteResult>;
  prove: (id: string, version: number, plan: ProofPlan) => Promise<ComponentProofResult>;
  certify: (id: string, version: number) => Promise<unknown>;
  remove: (id: string, version: number | null) => Promise<number>;
  /** copy a certified version into the open project's assets */
  install: (id: string, version: number) => Promise<ComponentInstallResult>;
}

/** A refusal in the ops' shape. */
export interface ComponentRefusal {
  error: string;
  issues?: ValidationIssue[];
}

export type ActionResult<T> = ({ ok: true } & T) | ({ ok: false } & ComponentRefusal);

const refuse = (error: string, issues?: ValidationIssue[]): { ok: false } & ComponentRefusal => ({
  ok: false,
  error,
  ...(issues && issues.length > 0 ? { issues } : {}),
});

/** "no component "x"", naming the ones there are. */
function unknownComponent(id: string, entries: readonly ListedComponent[]): string {
  const ids = [...new Set(entries.map((e) => e.id))];
  return `no component "${id}"${ids.length > 0 ? ` — the library has: ${ids.join(', ')}` : ' — the library is empty'}`;
}

/** The version a call means: the one given, else the newest. */
export function resolveVersion(
  entries: readonly ListedComponent[],
  id: string,
  version?: number,
): ListedComponent | { error: string } {
  const all = entries.filter((e) => e.id === id);
  if (all.length === 0) return { error: unknownComponent(id, entries) };
  if (version === undefined) return all.reduce((a, b) => (b.version > a.version ? b : a));
  return findComponent(entries, id, version) ?? { error: `${id} has no version ${version} (versions: ${all.map((e) => e.version).join(', ')})` };
}

/** What a library entry looks like to an agent. */
export function componentSummary(versions: readonly ListedComponent[]): Record<string, unknown> {
  const latest = versions.reduce((a, b) => (b.version > a.version ? b : a));
  const certified = versions.filter((v) => v.meta.status === 'certified').sort((a, b) => b.version - a.version)[0];
  const shown = certified ?? latest;
  return {
    id: latest.id,
    name: shown.meta.name,
    description: shown.meta.description ?? '',
    tags: shown.meta.tags ?? [],
    source: latest.source,
    latestVersion: latest.version,
    latestStatus: latest.meta.status,
    certifiedVersion: certified?.version ?? null,
    use: certified ? `custom:${certified.id}@${certified.version}` : null,
    versions: versions.map((v) => ({
      version: v.version,
      status: v.meta.status,
      proof: v.meta.proof ? { ok: v.meta.proof.ok, frames: v.meta.proof.frames.length } : null,
      warnings: v.meta.warnings?.length ?? 0,
    })),
    size: shown.meta.size,
    duration: shown.meta.duration,
    props: shown.meta.props,
    propsSchema: customLayerJsonSchema(shown.meta),
  };
}

/** The library grouped by id, as `motion_list_components` reports it. */
export function listComponentSummaries(
  entries: readonly ListedComponent[],
  filter: { status?: 'draft' | 'certified' | 'all'; tag?: string } = {},
): Record<string, unknown>[] {
  const byId = new Map<string, ListedComponent[]>();
  for (const e of entries) byId.set(e.id, [...(byId.get(e.id) ?? []), e]);
  const out: Record<string, unknown>[] = [];
  for (const versions of byId.values()) {
    const status = filter.status ?? 'all';
    if (status === 'certified' && !versions.some((v) => v.meta.status === 'certified')) continue;
    if (status === 'draft' && !versions.some((v) => v.meta.status === 'draft')) continue;
    if (filter.tag && !versions.some((v) => v.meta.tags?.includes(filter.tag ?? ''))) continue;
    out.push(componentSummary(versions));
  }
  return out;
}

/** Write (or dry-run) a draft: the declaration is checked here, the source by
 *  the backend's static check; nothing is stored unless both pass. */
export async function writeDraft(
  access: MotionComponentAccess,
  spec: ComponentSpec,
  source: string,
  dryRun: boolean,
): Promise<ActionResult<{ result: ComponentWriteResult }>> {
  const specIssues = checkSpec(spec);
  if (specIssues.length > 0) return refuse(specRefusal(specIssues), specIssues);
  if (access.list().some((e) => e.id === spec.id && e.source === 'builtin')) {
    return refuse(`"${spec.id}" is a built-in component; write yours under another id`);
  }
  const result = await access.write(spec, source, dryRun);
  if (!result.check.ok) {
    return refuse(
      `the source did not pass the static check (${result.check.issues.length} issue${result.check.issues.length === 1 ? '' : 's'}); nothing was saved`,
      result.check.issues,
    );
  }
  if (!dryRun) await access.reload();
  return { ok: true, result };
}

/** Run the certification check (the proof renders) on one version. */
export async function runProof(
  access: MotionComponentAccess,
  id: string,
  version?: number,
): Promise<ActionResult<{ entry: ListedComponent; result: ComponentProofResult }>> {
  const entry = resolveVersion(access.list(), id, version);
  if ('error' in entry) return refuse(entry.error);
  const result = await access.prove(entry.id, entry.version, proofPlan(proofRefFrom(entry.meta)));
  await access.reload();
  return { ok: true, entry, result };
}

/** Certify a proven draft (an explicit step: passing the check never
 *  certifies on its own). */
export async function certifyVersion(
  access: MotionComponentAccess,
  id: string,
  version?: number,
): Promise<ActionResult<{ entry: ListedComponent }>> {
  const entry = resolveVersion(access.list(), id, version);
  if ('error' in entry) return refuse(entry.error);
  if (entry.meta.status === 'certified') return refuse(`${id}@${entry.version} is already certified (certified versions are immutable)`);
  if (!entry.meta.proof) return refuse(`${id}@${entry.version} has not been checked: run motion_check_component first`);
  if (!entry.meta.proof.ok) return refuse(`${id}@${entry.version}'s certification check failed; fix the component, write it again and re-check`);
  await access.certify(entry.id, entry.version);
  await access.reload();
  const sealed = findComponent(access.list(), entry.id, entry.version) ?? entry;
  return { ok: true, entry: sealed };
}

/** Delete one version (or every version) of a library component. */
export async function deleteVersion(
  access: MotionComponentAccess,
  id: string,
  version?: number,
): Promise<ActionResult<{ removed: number }>> {
  const all = access.list().filter((e) => e.id === id);
  if (all.length === 0) return refuse(unknownComponent(id, access.list()));
  if (all.some((e) => e.source === 'builtin')) return refuse(`"${id}" is a built-in component and cannot be deleted`);
  const removed = await access.remove(id, version ?? null);
  await access.reload();
  return { ok: true, removed };
}

/** The certified definition for a pin (`id@version`), installed into the
 *  project. */
async function installRef(access: MotionComponentAccess, id: string, version: number): Promise<ComponentRef | { error: string }> {
  const entry = findComponent(access.list(), id, version);
  if (!entry) return { error: `${id}@${version} is not in the component library` };
  if (entry.meta.status !== 'certified') return { error: `${id}@${version} is a draft; only certified components can be used (motion_certify_component)` };
  const installed = await access.install(id, version);
  return componentRefFrom(entry.meta, installed);
}

/**
 * `manifest` with every component `fragment` uses embedded: each pin the
 * document does not hold yet is looked up in the library (certified only),
 * its module installed into the project, its definition embedded. What makes a
 * custom layer usable inside `motion_insert_layers`, `motion_set_scene` and a
 * template body like any other layer.
 */
export async function ensureComponents(
  access: MotionComponentAccess | undefined,
  manifest: Manifest,
  fragment: unknown,
): Promise<{ manifest: Manifest } | { error: string }> {
  const missing = missingComponents(manifest, fragment);
  if (missing.length === 0) return { manifest };
  if (!access) return { error: `the component library is unavailable, so ${missing.join(', ')} cannot be added` };
  const refs: ComponentRef[] = [];
  for (const pin of missing) {
    const parsed = parseComponentRef(pin);
    if (!parsed) return { error: `"${pin}" is not a component pin ("<id>@<version>")` };
    const ref = await installRef(access, parsed.id, parsed.version);
    if ('error' in ref) return ref;
    refs.push(ref);
  }
  return { manifest: embedComponents(manifest, refs) };
}

/**
 * Put one certified component on top of a scene: `use` is
 * `"custom:<id>"` (the newest certified version) or `"custom:<id>@<v>"`.
 * `props` are checked against its declared props first.
 */
export async function insertCustomLayer(
  access: MotionComponentAccess | undefined,
  manifest: Manifest,
  sceneIndex: number,
  use: string,
  props?: Record<string, unknown>,
): Promise<ActionResult<{ manifest: Manifest; layerIndex: number; id: string; component: string }>> {
  const parsed = parseCustomUse(use);
  if (!parsed) return refuse(`"${use}" is not a custom component use: "custom:<id>" or "custom:<id>@<version>"`);
  if (!access) return refuse('the component library is unavailable in this context');
  const entries = access.list();
  const entry =
    parsed.version === undefined ? latestCertified(entries, parsed.id) : findComponent(entries, parsed.id, parsed.version);
  if (!entry) {
    const known = entries.some((e) => e.id === parsed.id);
    return refuse(known ? `${parsed.id} has no certified version${parsed.version ? ` ${parsed.version}` : ''} yet (certify one with motion_certify_component)` : unknownComponent(parsed.id, entries));
  }
  const key = componentRefKey(entry.id, entry.version);
  const checked = resolveSlotValues({ slots: entry.meta.props }, props ?? {}, undefined, { root: ['props'], owner: `a prop of ${key}` });
  if (checked.issues.length > 0) return refuse(`props do not fit ${key}`, checked.issues);
  const embedded = manifest.components?.[key];
  const ref = embedded ?? (await installRef(access, entry.id, entry.version));
  if ('error' in ref) return refuse(ref.error);
  const added = addCustomLayer(manifest, sceneIndex, ref, props);
  if (!added) return refuse(`no scene at index ${sceneIndex}`);
  return { ok: true, ...added, component: key };
}
