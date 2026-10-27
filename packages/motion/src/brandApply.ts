/**
 * @apelles/motion — applying a brand kit to the Motion document (D-416).
 *
 * What it is: the Motion tab's applier for `@apelles/brand`'s registry
 * (`MotionTab` registers it). In ONE commit (one undo step): the kit's generated
 * theme (`themeDefFromBrandKit`) is embedded as the document's theme, the D-399
 * copy semantics, so the render never reads the kit or the library; and, only
 * when asked (`restyleExisting`), existing entrances and keyframe eases take the
 * kit's motion style. Before that commit, the kit's font files and logos are
 * imported into the project's Motion asset folder (D-404), where they keep their
 * content-hash ids, so the theme's `fontFiles` and any `image` layer an agent
 * points at a logo resolve in the player and in the render.
 *
 * What it does NOT do: change a document that is not loaded, or save it (the
 * person or `motion_save_manifest` saves, as for every other Motion edit).
 */
import { assetPath, kitAssetIds, type BrandApplyOutcome, type BrandApplyRequest } from '@apelles/brand';
import type { Manifest } from '@apelles/motion-engine/src/engine/schema';
import { setProjectThemeDef } from './manifestEdit';
import { restyleManifest, themeDefFromBrandKit, type RestyleReport } from './brandTheme';

export interface MotionBrandDeps {
  manifest: () => Manifest | null;
  commit: (next: Manifest, label: string) => void;
  /** `chroma_motion_import_asset`: copy a file into the Motion asset folder. */
  importAsset: (path: string) => Promise<{ id: string }>;
}

/** The kit's files Motion can use: its font files and its logos. */
function motionAssetIds(req: BrandApplyRequest): string[] {
  const { kit } = req;
  const wanted = new Set<string>();
  for (const role of ['display', 'body', 'mono'] as const) {
    const file = kit.typography[role]?.file;
    if (file) wanted.add(file);
  }
  for (const logo of [kit.logos?.light, kit.logos?.dark, kit.logos?.mark]) if (logo) wanted.add(logo);
  return kitAssetIds(kit).filter((id) => wanted.has(id));
}

export async function applyBrandToMotion(deps: MotionBrandDeps, req: BrandApplyRequest): Promise<BrandApplyOutcome> {
  const manifest = deps.manifest();
  if (!manifest) return { ok: false, error: 'no Motion document is loaded' };

  const imported: string[] = [];
  for (const id of motionAssetIds(req)) {
    const record = await deps.importAsset(assetPath(req.assetsDir, id));
    if (record.id !== id) {
      return { ok: false, error: `${id} imported as ${record.id}: the project's brand file changed on disk; set the kit again` };
    }
    imported.push(id);
  }

  const theme = themeDefFromBrandKit(req.kit);
  let next = setProjectThemeDef(manifest, theme);
  let restyled: RestyleReport | null = null;
  if (req.options.restyleExisting) {
    if (!req.kit.motion) return { ok: false, error: `brand kit "${req.kit.id}" has no motion style to restyle with` };
    const r = restyleManifest(next, req.kit.motion);
    next = r.manifest;
    restyled = r.report;
  }

  const changed = JSON.stringify(next) !== JSON.stringify(manifest);
  if (changed) deps.commit(next, `Apply brand kit "${req.kit.name}"`);
  return {
    ok: true,
    changed,
    summary: changed
      ? `theme ${theme.name}${restyled ? `, ${restyled.entrances} entrances and ${restyled.keys} keys restyled` : ''}`
      : `already on theme ${theme.name}`,
    details: {
      theme: theme.name,
      assets: imported,
      logos: req.kit.logos ?? {},
      ...(restyled ? { restyled } : {}),
    },
  };
}
