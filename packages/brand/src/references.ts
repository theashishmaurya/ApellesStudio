/**
 * @apelles/brand — references, as an agent reads them (D-416).
 *
 * What it is: a kit's references (images and videos a person dropped in, each
 * with a note: "use my work for materials and framing; use the reference for
 * type and hierarchy") resolved to absolute files an agent can open with the
 * tools it already has (an image viewer, `debug_screenshot`-style reads, ffprobe),
 * plus `addReference`, the one place a reference is appended (panel and
 * `brand_add_reference`).
 *
 * What it does NOT do: describe what is IN an image (the agent looks), or copy
 * files (the asset store does).
 */
import {
  BRAND_VIDEO_EXTENSIONS,
  assetExtension,
  assetFileName,
  referenceIdFor,
  type BrandKit,
  type BrandReference,
} from './kit';

export interface AgentReference {
  id: string;
  kind: BrandReference['kind'];
  note: string;
  name: string | null;
  media: 'image' | 'video';
  /** the absolute file to open */
  path: string;
}

const join = (dir: string, file: string) => `${dir.replace(/[\\/]+$/, '')}/${file}`;

/** Every reference with its absolute file under `assetsDir`. */
export function referencesForAgent(kit: BrandKit, assetsDir: string): AgentReference[] {
  return (kit.references ?? []).map((r) => ({
    id: r.id,
    kind: r.kind,
    note: r.note,
    name: r.name ?? null,
    media: (BRAND_VIDEO_EXTENSIONS as readonly string[]).includes(assetExtension(r.asset)) ? 'video' : 'image',
    path: join(assetsDir, assetFileName(r.asset)),
  }));
}

/** The absolute file of any asset id under `assetsDir`. */
export function assetPath(assetsDir: string, id: string): string {
  return join(assetsDir, assetFileName(id));
}

/** `kit` with one more reference (unvalidated; the caller parses). */
export function addReference(
  kit: BrandKit,
  ref: { asset: string; note: string; kind: BrandReference['kind']; name?: string },
): BrandKit {
  const taken = (kit.references ?? []).map((r) => r.id);
  const id = referenceIdFor(ref.name ?? 'reference', taken);
  const next: BrandReference = { id, asset: ref.asset, note: ref.note, kind: ref.kind, ...(ref.name ? { name: ref.name } : {}) };
  return { ...kit, references: [...(kit.references ?? []), next] };
}
