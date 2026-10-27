/**
 * @apelles/brand — the `brand_*` ops behind the MCP tools (D-416).
 *
 * What it is: `createBrandOps(ctx)`, a pure factory (the `createMotionOps`
 * shape, D-257) of the nine ops an agent drives brand kits with: list, get,
 * create, update, delete, import an asset, set the project's active kit, apply
 * it, add a reference, and read the references. Every write goes through the
 * same store actions the Brand panel calls (`useBrandStore`, `applyBrandKit`),
 * so the person and the agent cannot drift apart. `useBrandControl.ts` mounts
 * these on the control bridge under the `brand_` prefix.
 *
 * What it does NOT do: own any state, or touch a tab's document except through
 * `applyBrandKit` (one undo step per tab).
 */
import { checkKitContrast, contrastWarnings } from './contrast';
import {
  BRAND_KIT_SCHEMA_VERSION,
  kitAssetIds,
  parseBrandKit,
  starterKit,
  type BrandKit,
  type BrandReference,
  type KitIssue,
} from './kit';
import { mergeKitPatch, type KitLoadError } from './library';
import { addReference, assetPath, referencesForAgent } from './references';
import { BRAND_TABS, type BrandApplyOptions, type BrandApplyOutcome, type BrandTab } from './appliers';
import type { BrandAsset, InstallReport } from './io';

/** Everything the ops reach, injected (tests pass fakes). */
export interface BrandOpsContext {
  library: () => { kits: BrandKit[]; loadErrors: KitLoadError[] };
  reload: () => Promise<void>;
  saveKit: (kit: BrandKit) => Promise<BrandKit>;
  deleteKit: (id: string) => Promise<boolean>;
  readProjectKit: () => Promise<BrandKit | null>;
  setProjectKit: (kit: BrandKit | null) => Promise<InstallReport | null>;
  importAsset: (path: string) => Promise<BrandAsset>;
  libraryAssetsDir: () => Promise<string>;
  projectAssetsDir: () => Promise<string>;
  availableTabs: () => BrandTab[];
  apply: (
    tabs: readonly BrandTab[],
    kit: BrandKit,
    assetsDir: string,
    options: BrandApplyOptions,
  ) => Promise<Record<BrandTab, BrandApplyOutcome | undefined>>;
}

type OpResult = Record<string, unknown>;
export type BrandOp = (args: Record<string, unknown>) => Promise<OpResult>;

const refusal = (error: string, issues?: KitIssue[]): OpResult => ({ error, ...(issues ? { issues } : {}) });

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What a kit looks like in a listing. */
function kitSummary(kit: BrandKit) {
  return {
    id: kit.id,
    name: kit.name,
    version: kit.version,
    description: kit.description ?? null,
    colors: kit.colors,
    fonts: { display: kit.typography.display.family, body: kit.typography.body.family },
    logos: Object.keys(kit.logos ?? {}),
    hasMotionStyle: kit.motion !== undefined,
    captionPreset: kit.captions?.preset ?? null,
    hasLook: kit.look !== undefined,
    references: (kit.references ?? []).length,
  };
}

/** Absolute files for every asset the kit names. */
function kitFiles(kit: BrandKit, dir: string): Record<string, string> {
  return Object.fromEntries(kitAssetIds(kit).map((id) => [id, assetPath(dir, id)]));
}

export function createBrandOps(ctx: BrandOpsContext): Record<string, BrandOp> {
  const libraryKit = async (id: string): Promise<BrandKit | null> => {
    await ctx.reload();
    return ctx.library().kits.find((k) => k.id === id) ?? null;
  };

  /** The kit an op addresses: `id` in the library, or the project's own copy. */
  const addressed = async (
    id: unknown,
  ): Promise<{ kit: BrandKit; source: 'library' | 'project'; dir: string } | { error: string }> => {
    if (id !== undefined && id !== null) {
      if (typeof id !== 'string') return { error: 'id must be a kit id string' };
      const kit = await libraryKit(id);
      if (!kit) return { error: `no brand kit "${id}" in the library (brand_list_kits)` };
      return { kit, source: 'library', dir: await ctx.libraryAssetsDir() };
    }
    const kit = await ctx.readProjectKit();
    if (!kit) return { error: 'this project has no active brand kit; pass id, or set one with brand_set_active_kit' };
    return { kit, source: 'project', dir: await ctx.projectAssetsDir() };
  };

  /** Validate, then save (or only report, for a dry run). */
  const checkAndSave = async (raw: unknown, dryRun: boolean): Promise<OpResult> => {
    const parsed = parseBrandKit(raw);
    if ('error' in parsed) return refusal(`the kit is not valid: ${parsed.error}`, parsed.issues);
    const contrast = checkKitContrast(parsed.kit.colors);
    const warnings = contrastWarnings(parsed.kit.colors);
    if (dryRun) return { ok: true, dryRun: true, kit: parsed.kit, contrast, warnings };
    const saved = await ctx.saveKit(parsed.kit);
    return { ok: true, kit: saved, contrast, warnings };
  };

  /** After a library kit changes: is the project's copy of it now older? */
  const projectNote = async (saved: BrandKit): Promise<OpResult> => {
    const project = await ctx.readProjectKit().catch(() => null);
    if (!project || project.id !== saved.id || project.version >= saved.version) return {};
    return {
      projectOutOfDate: true,
      note: `this project uses ${saved.id} v${project.version}; call brand_set_active_kit("${saved.id}") to copy v${saved.version} into it`,
    };
  };

  return {
    brand_list_kits: async () => {
      await ctx.reload();
      const { kits, loadErrors } = ctx.library();
      const project = await ctx.readProjectKit();
      const inLibrary = project ? kits.find((k) => k.id === project.id) : undefined;
      return {
        kits: kits.map(kitSummary),
        loadErrors,
        project: project
          ? {
              ...kitSummary(project),
              libraryVersion: inLibrary?.version ?? null,
              newerInLibrary: inLibrary !== undefined && inLibrary.version > project.version,
            }
          : null,
        tabs: ctx.availableTabs(),
      };
    },

    brand_get_kit: async (a) => {
      const found = await addressed(a.id);
      if ('error' in found) return refusal(found.error);
      return {
        source: found.source,
        kit: found.kit,
        contrast: checkKitContrast(found.kit.colors),
        warnings: contrastWarnings(found.kit.colors),
        files: kitFiles(found.kit, found.dir),
      };
    },

    brand_create_kit: async (a) => {
      if (!isObject(a.kit)) return refusal('kit must be an object with at least id and name');
      const id = a.kit.id;
      const name = a.kit.name;
      if (typeof id !== 'string' || typeof name !== 'string') return refusal('kit.id and kit.name are required strings');
      if (await libraryKit(id)) return refusal(`a brand kit "${id}" already exists; change it with brand_update_kit`);
      // Anything the caller leaves out comes from the starter kit, so a kit is
      // always complete; what they give is merged over it.
      const raw = mergeKitPatch(starterKit(id, name), a.kit);
      const out = isObject(raw) ? { ...raw, schemaVersion: BRAND_KIT_SCHEMA_VERSION, id, version: 1 } : raw;
      return checkAndSave(out, a.dry_run === true);
    },

    brand_update_kit: async (a) => {
      if (typeof a.id !== 'string') return refusal('id (the kit to change) is required');
      if (!isObject(a.patch)) return refusal('patch must be an object of kit fields; null removes an optional one');
      const kit = await libraryKit(a.id);
      if (!kit) return refusal(`no brand kit "${a.id}" in the library`);
      const result = await checkAndSave(mergeKitPatch(kit, a.patch), a.dry_run === true);
      if (result.error || a.dry_run === true) return result;
      return { ...result, ...(await projectNote(result.kit as BrandKit)) };
    },

    brand_delete_kit: async (a) => {
      if (typeof a.id !== 'string') return refusal('id is required');
      const removed = await ctx.deleteKit(a.id);
      if (!removed) return refusal(`no brand kit "${a.id}" in the library`);
      return { deleted: a.id, note: 'projects that use it keep their own copy' };
    },

    brand_import_asset: async (a) => {
      if (typeof a.path !== 'string' || !a.path) return refusal('path (an absolute file path) is required');
      const asset = await ctx.importAsset(a.path);
      return { asset, use: 'put asset.id in a kit field (logos.light, typography.display.file, look.lut, …) with brand_update_kit' };
    },

    brand_set_active_kit: async (a) => {
      if (a.id === null) {
        await ctx.setProjectKit(null);
        return { active: null, note: 'looks already applied to the tabs stay; undo them there' };
      }
      if (typeof a.id !== 'string') return refusal('id must be a kit id, or null to clear the project\'s kit');
      const kit = await libraryKit(a.id);
      if (!kit) return refusal(`no brand kit "${a.id}" in the library`);
      const report = await ctx.setProjectKit(kit);
      return {
        active: kitSummary(kit),
        copied: report,
        next: 'brand_apply_kit applies it to the tabs (one undo step per tab)',
      };
    },

    brand_apply_kit: async (a) => {
      let tabs: BrandTab[] = [...BRAND_TABS];
      if (a.tabs !== undefined && a.tabs !== null) {
        if (!Array.isArray(a.tabs) || a.tabs.some((t) => !(BRAND_TABS as readonly unknown[]).includes(t))) {
          return refusal(`tabs must be a list of ${BRAND_TABS.join(', ')}`);
        }
        tabs = a.tabs as BrandTab[];
      }
      const kit = await ctx.readProjectKit();
      if (!kit) return refusal('this project has no active brand kit; set one with brand_set_active_kit first');
      const assetsDir = await ctx.projectAssetsDir();
      const options: BrandApplyOptions = {
        restyleExisting: a.restyle_existing === true,
        titles: a.titles !== false,
      };
      const results = await ctx.apply(tabs, kit, assetsDir, options);
      const failed = tabs.filter((t) => results[t] && results[t]?.ok === false);
      return {
        kit: { id: kit.id, version: kit.version },
        results,
        ...(failed.length === tabs.length ? { error: `nothing applied: ${failed.map((t) => `${t}: ${(results[t] as { error: string }).error}`).join('; ')}` } : {}),
      };
    },

    brand_add_reference: async (a) => {
      if (typeof a.path !== 'string' || !a.path) return refusal('path (an image or video file) is required');
      if (typeof a.note !== 'string' || !a.note.trim()) {
        return refusal('note is required: say what to take from it ("use my work for materials and framing")');
      }
      const kind = a.kind ?? 'reference';
      if (kind !== 'own-work' && kind !== 'reference') return refusal('kind is "own-work" or "reference"');
      let kitId = a.kit_id;
      if (kitId === undefined || kitId === null) {
        const project = await ctx.readProjectKit();
        if (!project) return refusal('pass kit_id, or set the project\'s brand kit first');
        kitId = project.id;
      }
      if (typeof kitId !== 'string') return refusal('kit_id must be a kit id');
      const kit = await libraryKit(kitId);
      if (!kit) return refusal(`no brand kit "${kitId}" in the library`);
      const asset = await ctx.importAsset(a.path);
      if (asset.kind !== 'image' && asset.kind !== 'video') return refusal(`a reference is an image or a video, not a ${asset.kind}`);
      const next = addReference(kit, { asset: asset.id, note: a.note.trim(), kind: kind as BrandReference['kind'], name: asset.sourceName });
      const result = await checkAndSave(next, false);
      if (result.error) return result;
      const saved = result.kit as BrandKit;
      // The project's copy follows when it is this kit, so an agent can read the
      // reference straight away.
      const project = await ctx.readProjectKit().catch(() => null);
      const projectUpdated = project?.id === saved.id;
      if (projectUpdated) await ctx.setProjectKit(saved);
      const added = saved.references?.[saved.references.length - 1];
      return { kit: { id: saved.id, version: saved.version }, reference: added, projectUpdated };
    },

    brand_get_references: async (a) => {
      const found = await addressed(a.kit_id);
      if ('error' in found) return refusal(found.error);
      const { kit, dir } = found;
      return {
        kit: { id: kit.id, name: kit.name, version: kit.version, source: found.source },
        direction: {
          colors: kit.colors,
          typography: kit.typography,
          motion: kit.motion ?? null,
          captions: kit.captions ?? null,
          logos: Object.fromEntries(Object.entries(kit.logos ?? {}).map(([k, id]) => [k, assetPath(dir, id)])),
          sound: kit.sound ?? null,
        },
        references: referencesForAgent(kit, dir),
        howTo: 'open each path to look at it before designing; follow each note (what to take from it)',
      };
    },
  };
}
