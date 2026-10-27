/**
 * @apelles/brand — the kit library's pure half (D-416).
 *
 * What it is: what came off disk (`chroma_brand_load_kits`: parsed files plus
 * per-file read errors from `apelles_brand::library`) → the kits that are valid
 * and one named error per file that is not (`sanitizeLoadedKits`, the D-407
 * template-library rule: a bad file drops itself and says why; the rest load),
 * plus the update rule (`mergeKitPatch`) both the panel and `brand_update_kit`
 * use.
 *
 * What it does NOT do: I/O (`io.ts`), versions (`kit.ts`'s `versionForSave`).
 */
import { parseBrandKit, type BrandKit } from './kit';

/** One file `chroma_brand_load_kits` read. */
export interface LoadedKitFile {
  file: string;
  kit: unknown;
}

/** One file that is not usable, and why. */
export interface KitLoadError {
  file: string;
  error: string;
}

/** The backend's answer, mirroring `apelles_brand::library::Library`. */
export interface LoadedKitLibrary {
  kits: LoadedKitFile[];
  errors: KitLoadError[];
}

export function sanitizeLoadedKits(raw: LoadedKitLibrary): { kits: BrandKit[]; loadErrors: KitLoadError[] } {
  const kits: BrandKit[] = [];
  const loadErrors: KitLoadError[] = [...raw.errors];
  for (const entry of raw.kits) {
    const parsed = parseBrandKit(entry.kit);
    if ('kit' in parsed) kits.push(parsed.kit);
    else loadErrors.push({ file: entry.file, error: parsed.error });
  }
  kits.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { kits, loadErrors };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A kit with `patch` laid over it: objects merge key by key (so
 * `{colors: {accent: "#f00"}}` changes one colour), arrays and scalars replace,
 * and `null` removes an optional field (`{look: null}`). `id`, `schemaVersion`
 * and `version` are not the caller's to change. The result is unvalidated; the
 * caller parses it.
 */
export function mergeKitPatch(kit: BrandKit, patch: Record<string, unknown>): unknown {
  const merge = (base: unknown, over: unknown): unknown => {
    if (!isPlainObject(base) || !isPlainObject(over)) return over;
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(over)) {
      if (v === null) delete out[k];
      else out[k] = merge(out[k], v);
    }
    return out;
  };
  const rest: Record<string, unknown> = { ...patch };
  delete rest.id;
  delete rest.schemaVersion;
  delete rest.version;
  return merge(kit, rest);
}
